import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { documentTotals, isVatable, lineNetAmountMinor, perBaseMinor, Ratio } from "@pm-buddy/domain";
import { BQ_VAT_RULE, type RfqStatus, type VatTreatment } from "@pm-buddy/types";
import {
  rfqDetailResponseSchema,
  rfqsResponseSchema,
  type AwardRfqRequest,
  type CreateRfqRequest,
  type RecordQuotationRequest,
  type UpdateRfqRequest,
} from "@pm-buddy/validation";
import { isCheckViolation, isUniqueViolation } from "../../../common/database-errors.js";
import { AppConfig } from "../../../config/app-config.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { Scope } from "../../identity/access-policy.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { assertUsableUnit } from "../catalogue.service.js";
import { businessToday, CatalogueStore, nextId } from "../catalogue-store.js";
import { PricesService } from "../prices.service.js";
import {
  fromCalendarDate,
  peopleOf,
  personOf,
  supplierRef,
  toCalendarDate,
} from "../procurement-mappers.js";
import { LposService } from "./lpos.service.js";
import { toDocument } from "./p2p-documents.service.js";
import {
  invalidTransition,
  iso,
  isoOrNull,
  makerChecker,
  materialWire,
  nextNumber,
  p2pBadRequest,
  p2pConflict,
  P2pAccess,
  p2pSettings,
  p2pVersionConflict,
  personOrNull,
  pricePerBase,
  projectRef,
} from "./p2p-common.js";

type RfqRow = Prisma.RfqGetPayload<object>;

/**
 * RFQs, quotations, the comparison matrix and the award (D5.2, brief §5.3): procurement
 * (procurement.manage_suppliers) asks N suppliers to price approved requisitions of one project,
 * records each quotation (prices also go to the D5.1 price history as `quotation`), compares them
 * net of VAT per base unit and awards a complete, valid quotation as a draft LPO, when the RFQ has
 * `procurement.min_quotes` such quotations or a single-source exception approved by a different
 * person with procurement.approve.
 */
@Injectable()
export class RfqsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: P2pAccess,
    private readonly store: CatalogueStore,
    private readonly prices: PricesService,
    private readonly config: AppConfig,
    private readonly lpos: LposService,
  ) {}

  private manager(scope: Scope) {
    if (!scope.access.permissions.has("procurement.manage_suppliers"))
      throw new ForbiddenException("Permission required: procurement.manage_suppliers");
  }

  list(
    principal: Principal,
    query: { projectId?: string; status?: RfqStatus; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const projectIds = await this.access.visibleProjectIds(scope, query.projectId);
      const rows = await scope.tx.rfq.findMany({
        where: {
          tenantId: scope.access.tenantId,
          projectId: { in: projectIds },
          ...(query.status ? { status: query.status } : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        orderBy: { id: "desc" },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      return rfqsResponseSchema.parse({
        rfqs: await Promise.all(page.map((row) => this.summary(scope, row))),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
        },
        permissions: { canCreate: scope.access.permissions.has("procurement.manage_suppliers") },
      });
    });
  }

  get(principal: Principal, id: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const row = await this.row(scope, id);
      await this.access.viewer(scope, row.projectId);
      return this.detail(scope, id);
    });
  }

  create(principal: Principal, input: CreateRfqRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        this.manager(scope);
        const requisitions = await tx.requisition.findMany({
          where: { tenantId: access.tenantId, id: { in: input.requisitionIds } },
        });
        if (requisitions.length !== new Set(input.requisitionIds).size)
          throw new NotFoundException("Requisition not found");
        const projectId = requisitions[0]!.projectId;
        if (requisitions.some((row) => row.projectId !== projectId))
          throw p2pBadRequest(
            "requisitions-other-project",
            "An RFQ covers requisitions of one project",
          );
        await this.access.require(scope, projectId, ["procurement.manage_suppliers"], {
          writable: true,
        });
        if (requisitions.some((row) => row.status !== "approved"))
          throw p2pConflict("requisition-not-approved", "Only approved requisitions go to an RFQ");
        const busy = await tx.rfqRequisition.count({
          where: { tenantId: access.tenantId, requisitionId: { in: input.requisitionIds }, releasedAt: null },
        });
        if (busy)
          throw p2pConflict("requisition-on-rfq", "A requisition is already on an RFQ");
        await this.assertSuppliers(scope, input.supplierIds);
        const id = nextId();
        await tx.rfq.create({
          data: {
            id,
            tenantId: access.tenantId,
            projectId,
            number: await nextNumber(tx, access.tenantId, "rfq"),
            respondBy: input.respondBy ? fromCalendarDate(input.respondBy) : null,
            notes: input.notes ?? null,
            createdBy: access.userId,
            updatedBy: access.userId,
          },
        });
        await tx.rfqRequisition.createMany({
          data: [...new Set(input.requisitionIds)].map((requisitionId) => ({
            tenantId: access.tenantId,
            rfqId: id,
            requisitionId,
            projectId,
          })),
        });
        await tx.rfqSupplier.createMany({
          data: [...new Set(input.supplierIds)].map((supplierId) => ({
            tenantId: access.tenantId,
            rfqId: id,
            supplierId,
          })),
        });
        await this.scope.audit(tx, "rfq.created", id, {
          projectId,
          requisitions: input.requisitionIds.length,
          suppliers: input.supplierIds.length,
        });
        return this.detail(scope, id);
      },
      true,
    );
  }

  update(principal: Principal, id: string, input: UpdateRfqRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        this.manager(scope);
        const row = await this.open(scope, id, input.version);
        if (input.supplierIds) {
          await this.assertSuppliers(scope, input.supplierIds);
          const current = await tx.rfqSupplier.findMany({
            where: { tenantId: access.tenantId, rfqId: id },
            include: { quotations: { where: { status: "received" }, select: { id: true } } },
          });
          const wanted = new Set(input.supplierIds);
          const removed = current.filter((entry) => !wanted.has(entry.supplierId));
          if (removed.some((entry) => entry.quotations.length))
            throw p2pConflict(
              "supplier-has-quotation",
              "Withdraw a supplier's quotation before removing them",
            );
          await tx.rfqSupplier.deleteMany({
            where: {
              tenantId: access.tenantId,
              rfqId: id,
              supplierId: { in: removed.map((entry) => entry.supplierId) },
              quotations: { none: {} },
            },
          });
          const known = new Set(current.map((entry) => entry.supplierId));
          await tx.rfqSupplier.createMany({
            data: input.supplierIds
              .filter((supplierId) => !known.has(supplierId))
              .map((supplierId) => ({ tenantId: access.tenantId, rfqId: id, supplierId })),
            skipDuplicates: true,
          });
        }
        await this.bump(scope, row, {
          ...(input.respondBy !== undefined
            ? { respondBy: input.respondBy ? fromCalendarDate(input.respondBy) : null }
            : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        });
        await this.scope.audit(tx, "rfq.updated", id, {
          fields: Object.keys(input).filter((key) => key !== "version"),
        });
        return this.detail(scope, id);
      },
      true,
    );
  }

  recordQuotation(principal: Principal, rfqId: string, input: RecordQuotationRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          this.manager(scope);
          const rfq = await this.row(scope, rfqId);
          if (rfq.status !== "open") throw p2pConflict("rfq-not-open", "This RFQ is not open");
          await this.access.require(scope, rfq.projectId, ["procurement.manage_suppliers"], {
            writable: true,
          });
          const invited = await tx.rfqSupplier.findUnique({
            where: {
              tenantId_rfqId_supplierId: { tenantId: access.tenantId, rfqId, supplierId: input.supplierId },
            },
          });
          if (!invited) throw p2pConflict("supplier-not-invited", "This supplier was not asked to quote");
          const live = await tx.quotation.count({
            where: { tenantId: access.tenantId, rfqId, supplierId: input.supplierId, status: "received" },
          });
          if (live)
            throw p2pConflict(
              "quotation-exists",
              "This supplier's quotation is recorded; withdraw it to record another",
            );
          const lines = await this.rfqLines(scope, rfqId);
          const byId = new Map(lines.map((line) => [line.id, line]));
          if (
            input.lines.length !== lines.length ||
            input.lines.some((line) => !byId.has(line.requisitionLineId))
          )
            throw p2pBadRequest(
              "quotation-lines-mismatch",
              "A quotation answers every line of the RFQ exactly once",
            );
          const rate = this.config.get("BQ_VAT_RATE_PERCENT");
          const units = await this.store.customUnits(scope);
          const priced = [];
          for (const line of input.lines) {
            const wanted = byId.get(line.requisitionLineId)!;
            if (line.noBid) {
              priced.push({ line, wanted, ratio: null, netPerBase: null, amount: null });
              continue;
            }
            assertUsableUnit(line.priceUnit!, units);
            const { ratio, netPerBase } = await pricePerBase(
              this.store,
              scope,
              wanted.material,
              input.supplierId,
              input.quotedOn,
              {
                priceUnit: line.priceUnit!,
                unitPriceMinor: line.unitPriceMinor!,
                vatTreatment: line.vatTreatment!,
              },
              rate,
              units,
            );
            priced.push({
              line,
              wanted,
              ratio,
              netPerBase,
              amount: lineNetAmountMinor(wanted.baseQuantity.toFixed(), netPerBase),
            });
          }
          const id = nextId();
          const complete = priced.every((entry) => entry.amount !== null);
          await tx.quotation.create({
            data: {
              id,
              tenantId: access.tenantId,
              rfqId,
              supplierId: input.supplierId,
              reference: input.reference ?? null,
              quotedOn: fromCalendarDate(input.quotedOn),
              validUntil: fromCalendarDate(input.validUntil),
              deliveryDays: input.deliveryDays,
              complete,
              netTotalMinor: BigInt(priced.reduce((sum, entry) => sum + (entry.amount ?? 0), 0)),
              vatRatePercent: rate,
              vatRuleStatus: BQ_VAT_RULE.status,
              recordedBy: access.userId,
            },
          });
          for (const entry of priced) {
            let priceId: string | null = null;
            if (entry.amount !== null) {
              const recorded = await this.prices.recordInScope(
                scope,
                entry.wanted.materialId,
                {
                  supplierId: input.supplierId,
                  unit: entry.line.priceUnit!,
                  unitPriceMinor: entry.line.unitPriceMinor!,
                  vatTreatment: entry.line.vatTreatment!,
                  effectiveOn: input.quotedOn,
                  sourceReference: `${rfq.number}${input.reference ? ` ${input.reference}` : ""}`.slice(
                    0,
                    100,
                  ),
                },
                null,
                "quotation",
              );
              priceId = recorded.price.id;
            }
            await tx.quotationLine.create({
              data: {
                id: nextId(),
                tenantId: access.tenantId,
                quotationId: id,
                requisitionLineId: entry.wanted.id,
                status: entry.amount === null ? "no_bid" : "quoted",
                priceUnit: entry.line.priceUnit,
                unitPriceMinor:
                  entry.line.unitPriceMinor === null ? null : BigInt(entry.line.unitPriceMinor),
                vatTreatment: entry.line.vatTreatment,
                priceRatio: entry.ratio?.toString() ?? null,
                netUnitPriceBaseMinor: entry.netPerBase ? perBaseMinor(entry.netPerBase) : null,
                netAmountMinor: entry.amount === null ? null : BigInt(entry.amount),
                priceId,
              },
            });
          }
          await this.bump(scope, rfq, {});
          await this.scope.audit(tx, "quotation.recorded", id, {
            rfqId,
            supplierId: input.supplierId,
            lines: input.lines.length,
            complete,
          });
          return this.detail(scope, rfqId);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw p2pConflict("quotation-exists", "This supplier's quotation is already recorded");
        throw error;
      });
  }

  withdrawQuotation(
    principal: Principal,
    rfqId: string,
    quotationId: string,
    input: { reason: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        this.manager(scope);
        const rfq = await this.row(scope, rfqId);
        if (rfq.status !== "open") throw p2pConflict("rfq-not-open", "This RFQ is not open");
        const quotation = await tx.quotation.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: quotationId } },
        });
        if (!quotation || quotation.rfqId !== rfqId) throw new NotFoundException("Quotation not found");
        if (quotation.status !== "received") throw invalidTransition(quotation.status);
        await tx.quotation.update({
          where: { tenantId_id: { tenantId: access.tenantId, id: quotationId } },
          data: {
            status: "withdrawn",
            withdrawnBy: access.userId,
            withdrawnAt: new Date(),
            withdrawnReason: input.reason,
          },
        });
        await this.bump(scope, rfq, {});
        await this.scope.audit(tx, "quotation.withdrawn", quotationId, { rfqId, reasonGiven: true });
        return this.detail(scope, rfqId);
      },
      true,
    );
  }

  /** Requests the single-source (fewer than the minimum quotes) exception, with a reason. */
  requestException(
    principal: Principal,
    rfqId: string,
    input: { version: number; reason: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        this.manager(scope);
        const row = await this.open(scope, rfqId, input.version);
        if (row.exceptionRequestedAt)
          throw p2pConflict("exception-exists", "A single-source exception was already requested");
        await this.bump(scope, row, {
          exceptionReason: input.reason,
          exceptionRequestedBy: scope.access.userId,
          exceptionRequestedAt: new Date(),
        });
        await this.scope.audit(scope.tx, "rfq.exception_requested", rfqId, { reasonGiven: true });
        return this.detail(scope, rfqId);
      },
      true,
    );
  }

  /** A different person with procurement.approve on the project approves the exception. */
  approveException(principal: Principal, rfqId: string, input: { version: number }, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const row = await this.row(scope, rfqId);
          await this.access.require(scope, row.projectId, ["procurement.approve"], { writable: true });
          if (row.status !== "open") throw p2pConflict("rfq-not-open", "This RFQ is not open");
          if (row.version !== input.version) throw p2pVersionConflict();
          if (!row.exceptionRequestedAt)
            throw p2pConflict("exception-not-requested", "No single-source exception was requested");
          if (row.exceptionApprovedAt)
            throw p2pConflict("exception-exists", "The exception is already approved");
          if (row.contributors.includes(scope.access.userId))
            throw makerChecker("Someone who prepared this RFQ cannot approve its exception");
          await this.bump(scope, row, {
            exceptionApprovedBy: scope.access.userId,
            exceptionApprovedAt: new Date(),
          });
          await this.scope.audit(scope.tx, "rfq.exception_approved", rfqId, {});
          return this.detail(scope, rfqId);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isCheckViolation(error))
          throw makerChecker("Someone who prepared this RFQ cannot approve its exception");
        throw error;
      });
  }

  /** Awards a quotation: a draft LPO from its lines (cancelled LPOs of the RFQ are replaced). */
  award(principal: Principal, rfqId: string, input: AwardRfqRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        this.manager(scope);
        const rfq = await this.open(scope, rfqId, input.version);
        const project = await this.access.require(scope, rfq.projectId, ["procurement.manage_suppliers"], {
          writable: true,
        });
        const quotation = await tx.quotation.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: input.quotationId } },
          include: { lines: true },
        });
        if (!quotation || quotation.rfqId !== rfqId) throw new NotFoundException("Quotation not found");
        if (quotation.status !== "received")
          throw p2pConflict("quotation-not-received", "This quotation was withdrawn");
        if (!quotation.complete)
          throw p2pConflict("quotation-incomplete", "Only a quotation that prices every line can win");
        const today = businessToday();
        if (toCalendarDate(quotation.validUntil) < today)
          throw p2pConflict("quotation-expired", "This quotation is no longer valid");
        const supplier = await this.store.supplier(scope, quotation.supplierId);
        if (supplier.status !== "active")
          throw p2pConflict("supplier-not-active", "LPOs go only to active suppliers");
        const settings = await p2pSettings(scope);
        const valid = await tx.quotation.count({
          where: {
            tenantId: access.tenantId,
            rfqId,
            status: "received",
            complete: true,
            validUntil: { gte: fromCalendarDate(today) },
          },
        });
        if (valid < settings.minQuotes && !rfq.exceptionApprovedAt)
          throw p2pConflict(
            "not-enough-quotes",
            `At least ${settings.minQuotes} complete quotations, or an approved single-source exception, are needed`,
          );
        if (input.deliverySiteId) {
          const site = await tx.site.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: input.deliverySiteId } },
          });
          if (!site || site.projectId !== project.project.id)
            throw p2pBadRequest("site-not-in-project", "The site is not part of this project");
        }
        const requisitionLines = await tx.requisitionLine.findMany({
          where: { tenantId: access.tenantId, id: { in: quotation.lines.map((line) => line.requisitionLineId) } },
        });
        const wanted = new Map(requisitionLines.map((line) => [line.id, line]));
        const order = await this.rfqLines(scope, rfqId);
        const rate = quotation.vatRatePercent.toFixed();
        const lines = order.map((requested, index) => {
          const quoted = quotation.lines.find((line) => line.requisitionLineId === requested.id)!;
          const source = wanted.get(requested.id)!;
          return {
            id: nextId(),
            tenantId: access.tenantId,
            lineNo: index + 1,
            requisitionLineId: source.id,
            materialId: source.materialId,
            quantity: source.quantity,
            unit: source.unit,
            baseQuantity: source.baseQuantity,
            baseUnit: source.baseUnit,
            priceUnit: quoted.priceUnit!,
            unitPriceMinor: quoted.unitPriceMinor!,
            vatTreatment: quoted.vatTreatment!,
            priceRatio: quoted.priceRatio!,
            netUnitPriceBaseMinor: quoted.netUnitPriceBaseMinor!,
            netAmountMinor: quoted.netAmountMinor!,
          };
        });
        const totals = documentTotals(
          lines.map((line) => ({
            netAmountMinor: Number(line.netAmountMinor),
            vatable: isVatable(line.vatTreatment as VatTreatment),
          })),
          rate,
        );
        const replaced = await tx.lpo.findFirst({
          where: { tenantId: access.tenantId, rfqId, status: "cancelled" },
          orderBy: { cancelledAt: "desc" },
          select: { id: true },
        });
        const lpoId = nextId();
        await tx.lpo.create({
          data: {
            id: lpoId,
            tenantId: access.tenantId,
            projectId: rfq.projectId,
            number: await nextNumber(tx, access.tenantId, "lpo"),
            rfqId,
            quotationId: quotation.id,
            supplierId: supplier.id,
            replacesLpoId: replaced?.id ?? null,
            deliverySiteId: input.deliverySiteId,
            deliveryDate: input.deliveryDate ? fromCalendarDate(input.deliveryDate) : null,
            terms: input.terms ?? null,
            creditDays: supplier.creditDays,
            supplierName: supplier.tradingName ?? supplier.legalName,
            supplierKraPinMasked: supplier.kraPinMasked,
            supplierEtimsStatus: supplier.etimsStatus,
            vatRatePercent: rate,
            vatRuleStatus: quotation.vatRuleStatus,
            subtotalMinor: BigInt(totals.subtotalMinor),
            vatMinor: BigInt(totals.vatMinor),
            totalMinor: BigInt(totals.totalMinor),
            createdBy: access.userId,
            updatedBy: access.userId,
          },
        });
        await tx.lpoLine.createMany({ data: lines.map((line) => ({ ...line, lpoId })) });
        await this.bump(scope, rfq, { status: "awarded", minQuotesApplied: settings.minQuotes });
        await this.scope.audit(tx, "lpo.created", lpoId, {
          rfqId,
          quotationId: quotation.id,
          supplierId: supplier.id,
          lines: lines.length,
          replacesLpoId: replaced?.id ?? null,
        });
        await this.scope.audit(tx, "rfq.awarded", rfqId, {
          quotationId: quotation.id,
          basis: valid >= settings.minQuotes ? "enough-quotes" : "exception-approved",
        });
        return this.lpos.detail(scope, lpoId);
      },
      true,
    );
  }

  cancel(principal: Principal, rfqId: string, input: { version: number; reason: string }, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        this.manager(scope);
        const row = await this.open(scope, rfqId, input.version);
        await this.bump(scope, row, {
          status: "cancelled",
          cancelledBy: scope.access.userId,
          cancelledAt: new Date(),
          cancelReason: input.reason,
        });
        await scope.tx.rfqRequisition.updateMany({
          where: { tenantId: scope.access.tenantId, rfqId, releasedAt: null },
          data: { releasedAt: new Date() },
        });
        await this.scope.audit(scope.tx, "rfq.cancelled", rfqId, { reasonGiven: true });
        return this.detail(scope, rfqId);
      },
      true,
    );
  }

  // Helpers ---------------------------------------------------------------------------------

  async row(scope: Scope, id: string): Promise<RfqRow> {
    const row = await scope.tx.rfq.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("RFQ not found");
    return row;
  }

  private async open(scope: Scope, id: string, version: number) {
    const row = await this.row(scope, id);
    if (row.status !== "open") throw p2pConflict("rfq-not-open", "This RFQ is not open");
    if (row.version !== version) throw p2pVersionConflict();
    return row;
  }

  private async bump(scope: Scope, row: RfqRow, data: Prisma.RfqUpdateManyMutationInput) {
    const updated = await scope.tx.rfq.updateMany({
      where: { tenantId: scope.access.tenantId, id: row.id, version: row.version },
      data: { ...data, version: { increment: 1 }, updatedBy: scope.access.userId, updatedAt: new Date() },
    });
    if (!updated.count) throw p2pVersionConflict();
  }

  private async assertSuppliers(scope: Scope, ids: readonly string[]) {
    for (const supplierId of new Set(ids)) {
      const supplier = await this.store.supplier(scope, supplierId);
      if (supplier.status === "blocked")
        throw p2pConflict("supplier-blocked", `${supplier.code} is blocked`);
    }
  }

  /** The RFQ's lines: its requisitions' lines, by requisition number then line number. */
  private async rfqLines(scope: Scope, rfqId: string, includeReleased = false) {
    const links = await scope.tx.rfqRequisition.findMany({
      where: {
        tenantId: scope.access.tenantId,
        rfqId,
        ...(includeReleased ? {} : { releasedAt: null }),
      },
      select: { requisitionId: true },
    });
    const lines = await scope.tx.requisitionLine.findMany({
      where: {
        tenantId: scope.access.tenantId,
        requisitionId: { in: links.map((link) => link.requisitionId) },
      },
      include: { material: true, requisition: { select: { id: true, number: true } } },
    });
    return lines.sort((left, right) =>
      left.requisition.number === right.requisition.number
        ? left.lineNo - right.lineNo
        : left.requisition.number < right.requisition.number
          ? -1
          : 1,
    );
  }

  private async summary(scope: Scope, row: RfqRow) {
    const { tx, access } = scope;
    const [project, links, suppliers, quotationCount, lpo, people] = await Promise.all([
      tx.project.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: access.tenantId, id: row.projectId } },
        select: { id: true, code: true, name: true },
      }),
      tx.rfqRequisition.findMany({
        where: { tenantId: access.tenantId, rfqId: row.id },
        include: { requisition: { select: { id: true, number: true } } },
      }),
      tx.rfqSupplier.findMany({
        where: { tenantId: access.tenantId, rfqId: row.id },
        include: { supplier: true },
      }),
      tx.quotation.count({ where: { tenantId: access.tenantId, rfqId: row.id, status: "received" } }),
      tx.lpo.findFirst({
        where: { tenantId: access.tenantId, rfqId: row.id, status: { not: "cancelled" } },
        select: { id: true, number: true, status: true, quotationId: true },
      }),
      peopleOf(tx, [row.createdBy, row.exceptionRequestedBy, row.exceptionApprovedBy]),
    ]);
    return {
      id: row.id,
      number: row.number,
      project: projectRef(project),
      status: row.status as RfqStatus,
      respondBy: row.respondBy ? toCalendarDate(row.respondBy) : null,
      notes: row.notes,
      requisitions: links
        .map((link) => link.requisition)
        .sort((left, right) => (left.number < right.number ? -1 : 1)),
      suppliers: suppliers
        .map((entry) => supplierRef(entry.supplier))
        .sort((left, right) => (left.code < right.code ? -1 : 1)),
      quotationCount,
      exception: {
        status: row.exceptionApprovedAt ? "approved" : row.exceptionRequestedAt ? "requested" : "none",
        reason: row.exceptionReason,
        requestedAt: isoOrNull(row.exceptionRequestedAt),
        requestedBy: personOrNull(people, row.exceptionRequestedBy),
        approvedAt: isoOrNull(row.exceptionApprovedAt),
        approvedBy: personOrNull(people, row.exceptionApprovedBy),
      },
      awardedQuotationId: lpo?.quotationId ?? null,
      lpo: lpo ? { id: lpo.id, number: lpo.number, status: lpo.status } : null,
      version: row.version,
      createdAt: iso(row.createdAt),
      createdBy: personOf(people, row.createdBy),
      cancelledAt: isoOrNull(row.cancelledAt),
      cancelReason: row.cancelReason,
    } as const;
  }

  async detail(scope: Scope, id: string) {
    const { tx, access } = scope;
    const row = await this.row(scope, id);
    const summary = await this.summary(scope, row);
    const lines = await this.rfqLines(scope, id, row.status === "cancelled");
    const quotations = await tx.quotation.findMany({
      where: { tenantId: access.tenantId, rfqId: id },
      include: {
        lines: true,
        invitation: { include: { supplier: true } },
        documents: { orderBy: { uploadedAt: "desc" }, take: 1 },
      },
      orderBy: { recordedAt: "asc" },
    });
    const people = await peopleOf(tx, [
      ...quotations.flatMap((quote) => [quote.recordedBy, ...quote.documents.map((doc) => doc.uploadedBy)]),
      ...row.contributors,
    ]);
    const today = businessToday();
    const settings = await p2pSettings(scope);
    const live = quotations.filter((quote) => quote.status === "received");
    const expired = (quote: (typeof quotations)[number]) => toCalendarDate(quote.validUntil) < today;
    const comparisonLines = lines.map((line) => {
      const cells = live.map((quote) => {
        const cell = quote.lines.find((entry) => entry.requisitionLineId === line.id);
        return {
          quotationId: quote.id,
          netUnitPriceBaseMinor: cell?.netUnitPriceBaseMinor?.toFixed() ?? null,
          netAmountMinor: cell?.netAmountMinor === null || !cell ? null : Number(cell.netAmountMinor),
        };
      });
      const prices = cells
        .map((cell) => cell.netUnitPriceBaseMinor)
        .filter((value): value is string => value !== null)
        .map((value) => Ratio.fromDecimal(value));
      const lowest = prices.reduce<Ratio | null>(
        (min, value) => (!min || value.compare(min) < 0 ? value : min),
        null,
      );
      return {
        requisitionLineId: line.id,
        cells: cells.map((cell) => ({
          ...cell,
          lowest:
            lowest !== null &&
            cell.netUnitPriceBaseMinor !== null &&
            Ratio.fromDecimal(cell.netUnitPriceBaseMinor).equals(lowest),
        })),
      };
    });
    const eligible = live.filter((quote) => quote.complete && !expired(quote));
    const lowestTotal = eligible.reduce<number | null>(
      (min, quote) => (min === null || Number(quote.netTotalMinor) < min ? Number(quote.netTotalMinor) : min),
      null,
    );
    const project = await this.access.on(scope, row.projectId);
    return rfqDetailResponseSchema.parse({
      rfq: summary,
      lines: lines.map((line) => ({
        requisitionLineId: line.id,
        requisition: line.requisition,
        material: materialWire(line.material),
        quantity: line.quantity.toFixed(),
        unit: line.unit,
        baseQuantity: line.baseQuantity.toFixed(),
      })),
      quotations: quotations.map((quote) => ({
        id: quote.id,
        supplier: supplierRef(quote.invitation.supplier),
        reference: quote.reference,
        quotedOn: toCalendarDate(quote.quotedOn),
        validUntil: toCalendarDate(quote.validUntil),
        deliveryDays: quote.deliveryDays,
        status: quote.status,
        withdrawnReason: quote.withdrawnReason,
        complete: quote.complete,
        expired: expired(quote),
        netTotalMinor: Number(quote.netTotalMinor),
        recordedAt: iso(quote.recordedAt),
        recordedBy: personOf(people, quote.recordedBy),
        document: quote.documents[0] ? toDocument(quote.documents[0], people) : null,
        lines: lines
          .map((line) => quote.lines.find((entry) => entry.requisitionLineId === line.id))
          .filter((entry) => entry !== undefined)
          .map((entry) => ({
            requisitionLineId: entry.requisitionLineId,
            status: entry.status,
            priceUnit: entry.priceUnit,
            unitPriceMinor: entry.unitPriceMinor === null ? null : Number(entry.unitPriceMinor),
            vatTreatment: entry.vatTreatment,
            netUnitPriceBaseMinor: entry.netUnitPriceBaseMinor?.toFixed() ?? null,
            netAmountMinor: entry.netAmountMinor === null ? null : Number(entry.netAmountMinor),
            priceId: entry.priceId,
          })),
      })),
      comparison: {
        lines: comparisonLines,
        totals: live.map((quote) => ({
          quotationId: quote.id,
          netTotalMinor: Number(quote.netTotalMinor),
          complete: quote.complete,
          lowest:
            quote.complete && !expired(quote) && lowestTotal === Number(quote.netTotalMinor),
        })),
      },
      award: {
        minQuotes: settings.minQuotes,
        completeQuotes: eligible.length,
        basis:
          eligible.length >= settings.minQuotes
            ? "enough-quotes"
            : row.exceptionApprovedAt
              ? "exception-approved"
              : "not-enough-quotes",
      },
      contributors: row.contributors.map((person) => personOf(people, person)),
      permissions: {
        canManage: access.permissions.has("procurement.manage_suppliers") && row.status === "open",
        canApproveException:
          project.permissions.has("procurement.approve") &&
          row.status === "open" &&
          row.exceptionRequestedAt !== null &&
          row.exceptionApprovedAt === null &&
          !row.contributors.includes(access.userId),
      },
    });
  }
}
