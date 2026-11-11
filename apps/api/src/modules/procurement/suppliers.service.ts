import { ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { maskKraPin, maskPhone } from "@pm-buddy/domain";
import { PROCUREMENT_LIMITS } from "@pm-buddy/types";
import {
  supplierDetailResponseSchema,
  supplierRevealResponseSchema,
  suppliersResponseSchema,
  type CreateSupplierRequest,
  type SupplierListQuery,
  type SupplierRevealRequest,
  type UpdateSupplierRequest,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../common/database-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import { AuthSecurity } from "../identity/auth-security.service.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { FieldCipherError } from "../labour/field-cipher.js";
import { CatalogueStore, nextSupplierCode, nextId } from "./catalogue-store.js";
import { procurementConflict, ProcurementAccess } from "./procurement-access.js";
import {
  changedFields,
  fromCalendarDate,
  materialRef,
  peopleOf,
  supplierRef,
  toContact,
  toPayout,
  toPrice,
  toSupplier,
  type SupplierRow,
} from "./procurement-mappers.js";
import {
  ACCOUNT_NUMBER_COLUMN,
  CONTACT_PHONE_COLUMN,
  KRA_PIN_COLUMN,
  SupplierCrypto,
} from "./supplier-crypto.js";

const CURRENT = ["pending", "verified"];

/**
 * Suppliers (D5.1, brief §5.3): KRA PIN (encrypted, blind-indexed, unique per company, masked),
 * eTIMS status as recorded, contacts (phones encrypted and blind-indexed), credit terms and
 * status. Revealing a sensitive value is a separate, rate-limited and audited action. Balances,
 * statements and ratings need supplier invoices (D5.2).
 */
@Injectable()
export class SuppliersService {
  private readonly logger = new Logger(SuppliersService.name);

  constructor(
    private readonly scope: TenantScope,
    private readonly access: ProcurementAccess,
    private readonly store: CatalogueStore,
    private readonly crypto: SupplierCrypto,
    private readonly security: AuthSecurity,
  ) {}

  private async summaries(scope: Scope, rows: SupplierRow[]) {
    const { tx, access } = scope;
    const ids = rows.map((row) => row.id);
    if (!ids.length) return [];
    const [primaries, current] = await Promise.all([
      tx.supplierContact.findMany({
        where: { tenantId: access.tenantId, supplierId: { in: ids }, isPrimary: true },
      }),
      tx.supplierPayoutVersion.findMany({
        where: { tenantId: access.tenantId, supplierId: { in: ids }, status: { in: CURRENT } },
      }),
    ]);
    const primaryBy = new Map(primaries.map((contact) => [contact.supplierId, contact]));
    const currentBy = new Map(current.map((version) => [version.supplierId, version]));
    return rows.map((row) =>
      toSupplier(row, {
        primary: primaryBy.get(row.id) ?? null,
        current: currentBy.get(row.id) ?? null,
      }),
    );
  }

  list(principal: Principal, query: SupplierListQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      await this.access.viewer(scope);
      const filters: Prisma.SupplierWhereInput[] = [{ tenantId: access.tenantId }];
      if (query.status) filters.push({ status: query.status });
      if (query.etims) filters.push({ etimsStatus: query.etims });
      if (query.search) {
        const contains = { contains: query.search, mode: "insensitive" as const };
        filters.push({
          OR: [{ code: contains }, { legalName: contains }, { tradingName: contains }],
        });
      }
      if (query.kraPin || query.phone) {
        // Exact-match lookups partly reveal identifiers: reveal permission, a rate limit, audit.
        if (!this.access.canRevealIdentifiers(scope))
          throw new ForbiddenException("Exact-match lookups need permission to reveal identifiers");
        await this.security.limit(
          `supplier-lookup:${access.userId}`,
          PROCUREMENT_LIMITS.lookupsPerWindow,
          PROCUREMENT_LIMITS.revealWindowSeconds,
        );
        if (query.kraPin)
          filters.push({ kraPinBidx: this.crypto.kraPinIndex(access.tenantId, query.kraPin) });
        if (query.phone)
          filters.push({
            contacts: { some: { phoneBidx: this.crypto.phoneIndex(access.tenantId, query.phone) } },
          });
        await this.scope.audit(tx, "supplier.lookup", access.tenantId, {
          by: [query.kraPin ? "kraPin" : null, query.phone ? "phone" : null].filter(Boolean),
        });
      }
      if (query.cursor) filters.push({ id: { gt: query.cursor } });
      const rows = await tx.supplier.findMany({
        where: { AND: filters },
        orderBy: { id: "asc" },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      return suppliersResponseSchema.parse({
        suppliers: await this.summaries(scope, page),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
        },
        permissions: { canManage: this.access.canManage(scope) },
      });
    });
  }

  private kraPinColumns(tenantId: string, supplierId: string, pin: string | null) {
    if (pin === null) return { kraPinEnc: null, kraPinBidx: null, kraPinMasked: null };
    return {
      kraPinEnc: this.crypto.seal(tenantId, supplierId, KRA_PIN_COLUMN, pin),
      kraPinBidx: this.crypto.kraPinIndex(tenantId, pin),
      kraPinMasked: maskKraPin(pin),
    };
  }

  private phoneColumns(tenantId: string, contactId: string, phone: string | null) {
    if (phone === null) return { phoneEnc: null, phoneBidx: null, phoneMasked: null };
    return {
      phoneEnc: this.crypto.seal(tenantId, contactId, CONTACT_PHONE_COLUMN, phone),
      phoneBidx: this.crypto.phoneIndex(tenantId, phone),
      phoneMasked: maskPhone(phone),
    };
  }

  private pinTaken = (error: unknown) => {
    if (isUniqueViolation(error))
      throw procurementConflict(
        "kra-pin-taken",
        "Another supplier in this company has this KRA PIN",
      );
    throw error;
  };

  create(principal: Principal, input: CreateSupplierRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          await this.access.manager(scope);
          return this.detail(scope, await this.createInScope(scope, input));
        },
        true,
      )
      .catch(this.pinTaken);
  }

  /** Creates a supplier and its contacts (permission checked by the caller); returns its ID. */
  async createInScope(scope: Scope, input: CreateSupplierRequest): Promise<string> {
    const { tx, access } = scope;
    const id = nextId();
    const code = await nextSupplierCode(tx, access.tenantId);
    await tx.supplier.create({
      data: {
        id,
        tenantId: access.tenantId,
        code,
        legalName: input.legalName,
        tradingName: input.tradingName ?? null,
        ...this.kraPinColumns(access.tenantId, id, input.kraPin ?? null),
        etimsStatus: input.etimsStatus,
        etimsCheckedOn: input.etimsCheckedOn ? fromCalendarDate(input.etimsCheckedOn) : null,
        creditDays: input.creditDays,
        creditLimitMinor:
          input.creditLimitMinor === undefined || input.creditLimitMinor === null
            ? null
            : BigInt(input.creditLimitMinor),
        notes: input.notes ?? null,
        createdBy: access.userId,
        updatedBy: access.userId,
      },
    });
    for (const [index, contact] of input.contacts.entries()) {
      const contactId = nextId();
      await tx.supplierContact.create({
        data: {
          id: contactId,
          tenantId: access.tenantId,
          supplierId: id,
          name: contact.name,
          role: contact.role ?? null,
          email: contact.email ?? null,
          isPrimary: contact.primary,
          sortOrder: index,
          ...this.phoneColumns(access.tenantId, contactId, contact.phone ?? null),
        },
      });
    }
    const { contacts, kraPin, ...fields } = input;
    await this.scope.audit(tx, "supplier.created", id, {
      code,
      fields: changedFields(fields),
      kraPin: kraPin !== undefined && kraPin !== null,
      contacts: contacts.length,
    });
    return id;
  }

  get(principal: Principal, supplierId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.viewer(scope);
      return this.detail(scope, supplierId);
    });
  }

  async detail(scope: Scope, supplierId: string) {
    const { tx, access } = scope;
    const row = await this.store.supplier(scope, supplierId);
    const [contacts, versions, prices] = await Promise.all([
      tx.supplierContact.findMany({
        where: { tenantId: access.tenantId, supplierId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
      tx.supplierPayoutVersion.findMany({
        where: { tenantId: access.tenantId, supplierId },
        orderBy: { versionNo: "desc" },
        take: 20,
      }),
      tx.materialPrice.findMany({
        where: { tenantId: access.tenantId, supplierId },
        orderBy: [{ effectiveOn: "desc" }, { recordedAt: "desc" }, { id: "desc" }],
        take: 20,
        include: {
          material: { select: { id: true, code: true, name: true } },
          correctedBy: { select: { id: true } },
        },
      }),
    ]);
    const people = await peopleOf(tx, [
      ...versions.flatMap((version) => [
        version.proposedBy,
        version.verifiedBy,
        version.rejectedBy,
        ...version.contributors,
      ]),
      ...prices.map((price) => price.recordedBy),
    ]);
    const current = versions.find((version) => CURRENT.includes(version.status)) ?? null;
    const canVerify = this.access.canVerifyPayout(scope);
    const payout = (version: (typeof versions)[number]) =>
      toPayout(version, { people, callerId: access.userId, callerCanVerify: canVerify });
    const [summary] = await this.summaries(scope, [row]);
    return supplierDetailResponseSchema.parse({
      supplier: { ...summary, notes: row.notes },
      contacts: contacts.map(toContact),
      payout: {
        current: current ? payout(current) : null,
        history: versions.filter((version) => version !== current).map(payout),
      },
      prices: prices.map((price) =>
        toPrice(price, {
          people,
          material: materialRef(price.material),
          supplier: supplierRef(row),
          correctedById: price.correctedBy[0]?.id ?? null,
        }),
      ),
      permissions: {
        canManage: this.access.canManage(scope),
        canRevealIdentifiers: this.access.canRevealIdentifiers(scope),
        canRevealBank: this.access.canRevealBank(scope),
        canVerifyPayout: canVerify,
      },
    });
  }

  update(principal: Principal, supplierId: string, input: UpdateSupplierRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          await this.access.manager(scope);
          const row = await this.store.supplier(scope, supplierId);
          if (row.version !== input.version) throw versionConflictError();
          const { version, contacts, kraPin, ...fields } = input;
          const status = fields.status ?? row.status;
          const data: Prisma.SupplierUpdateManyMutationInput = {
            ...(fields.legalName !== undefined ? { legalName: fields.legalName } : {}),
            ...(fields.tradingName !== undefined ? { tradingName: fields.tradingName } : {}),
            ...(fields.etimsStatus !== undefined ? { etimsStatus: fields.etimsStatus } : {}),
            ...(fields.etimsCheckedOn !== undefined
              ? {
                  etimsCheckedOn: fields.etimsCheckedOn
                    ? fromCalendarDate(fields.etimsCheckedOn)
                    : null,
                }
              : {}),
            ...(fields.creditDays !== undefined ? { creditDays: fields.creditDays } : {}),
            ...(fields.creditLimitMinor !== undefined
              ? {
                  creditLimitMinor:
                    fields.creditLimitMinor === null ? null : BigInt(fields.creditLimitMinor),
                }
              : {}),
            ...(fields.notes !== undefined ? { notes: fields.notes } : {}),
            ...(fields.status !== undefined ? { status: fields.status } : {}),
            ...(fields.status !== undefined || fields.statusReason !== undefined
              ? {
                  statusReason:
                    status === "active" ? null : (fields.statusReason ?? row.statusReason),
                }
              : {}),
            ...(kraPin !== undefined
              ? this.kraPinColumns(access.tenantId, supplierId, kraPin)
              : {}),
            version: { increment: 1 },
            updatedBy: access.userId,
            updatedAt: new Date(),
          };
          const updated = await tx.supplier.updateMany({
            where: { tenantId: access.tenantId, id: supplierId, version },
            data,
          });
          if (!updated.count) throw versionConflictError();
          const contactChanges = contacts
            ? await this.syncContacts(scope, supplierId, contacts)
            : null;
          await this.scope.audit(tx, "supplier.updated", supplierId, {
            fields: changedFields(fields),
            kraPinChanged: kraPin !== undefined,
            contacts: contactChanges,
            version: version + 1,
          });
          return this.detail(scope, supplierId);
        },
        true,
      )
      .catch(this.pinTaken);
  }

  /** Replaces the contact list: keeps listed IDs, adds new ones, removes the rest. */
  private async syncContacts(
    scope: Scope,
    supplierId: string,
    contacts: NonNullable<UpdateSupplierRequest["contacts"]>,
  ) {
    const { tx, access } = scope;
    const existing = await tx.supplierContact.findMany({
      where: { tenantId: access.tenantId, supplierId },
    });
    const known = new Set(existing.map((contact) => contact.id));
    for (const contact of contacts)
      if (contact.id && !known.has(contact.id))
        throw new NotFoundException({ message: "Contact not found", code: "contact-not-found" });
    const keep = new Set(contacts.map((contact) => contact.id).filter(Boolean));
    const removed = existing.filter((contact) => !keep.has(contact.id));
    if (removed.length)
      await tx.supplierContact.deleteMany({
        where: { tenantId: access.tenantId, id: { in: removed.map((contact) => contact.id) } },
      });
    // Clear the primary flag first so the one-primary index never sees two at once.
    await tx.supplierContact.updateMany({
      where: { tenantId: access.tenantId, supplierId, isPrimary: true },
      data: { isPrimary: false },
    });
    let phonesChanged = 0;
    let added = 0;
    for (const [index, contact] of contacts.entries()) {
      const base = {
        name: contact.name,
        role: contact.role ?? null,
        email: contact.email ?? null,
        isPrimary: contact.primary,
        sortOrder: index,
      };
      if (contact.id) {
        const phone =
          contact.phone === undefined
            ? {}
            : this.phoneColumns(access.tenantId, contact.id, contact.phone);
        if (contact.phone !== undefined) phonesChanged += 1;
        await tx.supplierContact.update({
          where: { tenantId_id: { tenantId: access.tenantId, id: contact.id } },
          data: { ...base, ...phone, updatedAt: new Date() },
        });
      } else {
        const contactId = nextId();
        if (contact.phone) phonesChanged += 1;
        added += 1;
        await tx.supplierContact.create({
          data: {
            id: contactId,
            tenantId: access.tenantId,
            supplierId,
            ...base,
            ...this.phoneColumns(access.tenantId, contactId, contact.phone ?? null),
          },
        });
      }
    }
    return { added, removed: removed.length, phonesChanged };
  }

  /**
   * Reveals one sensitive value: KRA PIN or contact phone (manage suppliers, or company-wide
   * finance.view_sensitive) or bank account number (company-wide finance.view_sensitive only).
   * Rate-limited per user and audited (the value never enters the audit log).
   */
  reveal(principal: Principal, supplierId: string, input: SupplierRevealRequest, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const allowed =
        input.field === "accountNumber"
          ? this.access.canRevealBank(scope)
          : this.access.canRevealIdentifiers(scope);
      if (!allowed) throw new ForbiddenException("Permission required to reveal this value");
      await this.security.limit(
        `supplier-reveal:${access.userId}`,
        PROCUREMENT_LIMITS.revealsPerWindow,
        PROCUREMENT_LIMITS.revealWindowSeconds,
      );
      const supplier = await this.store.supplier(scope, supplierId);
      let value: string;
      try {
        if (input.field === "kraPin") {
          if (!supplier.kraPinEnc) throw nothingToReveal();
          value = this.crypto.open(access.tenantId, supplierId, KRA_PIN_COLUMN, supplier.kraPinEnc);
        } else if (input.field === "contactPhone") {
          const contact = await tx.supplierContact.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: input.contactId! } },
          });
          if (!contact || contact.supplierId !== supplierId)
            throw new NotFoundException({
              message: "Contact not found",
              code: "contact-not-found",
            });
          if (!contact.phoneEnc) throw nothingToReveal();
          value = this.crypto.open(
            access.tenantId,
            contact.id,
            CONTACT_PHONE_COLUMN,
            contact.phoneEnc,
          );
        } else {
          const version = await tx.supplierPayoutVersion.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: input.payoutId! } },
          });
          if (!version || version.supplierId !== supplierId)
            throw new NotFoundException({
              message: "Payout details not found",
              code: "payout-not-found",
            });
          if (!version.accountNumberEnc) throw nothingToReveal();
          value = this.crypto.open(
            access.tenantId,
            version.id,
            ACCOUNT_NUMBER_COLUMN,
            version.accountNumberEnc,
          );
        }
      } catch (error) {
        if (!(error instanceof FieldCipherError)) throw error;
        // A ciphertext that does not open for this row was moved or tampered with.
        this.logger.warn(`Supplier ${supplierId}: ${input.field} could not be decrypted`);
        throw procurementConflict(
          "sensitive-value-unreadable",
          "This value cannot be read; re-enter it",
        );
      }
      await this.scope.audit(tx, "supplier.revealed", supplierId, {
        field: input.field,
        contactId: input.contactId ?? null,
        payoutId: input.payoutId ?? null,
      });
      return supplierRevealResponseSchema.parse({ field: input.field, value });
    });
  }
}

const nothingToReveal = () =>
  procurementConflict("nothing-to-reveal", "There is no value to reveal");
const versionConflictError = () =>
  procurementConflict(
    "version-conflict",
    "This record was changed by someone else. Reload and try again.",
  );
