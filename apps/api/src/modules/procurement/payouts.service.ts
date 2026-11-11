import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { maskAccountNumber } from "@pm-buddy/domain";
import type { ProposePayoutRequest } from "@pm-buddy/validation";
import { isCheckViolation, isUniqueViolation } from "../../common/database-errors.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { CatalogueStore, nextId } from "./catalogue-store.js";
import {
  procurementConflict,
  procurementProblem,
  ProcurementAccess,
} from "./procurement-access.js";
import { ACCOUNT_NUMBER_COLUMN, SupplierCrypto } from "./supplier-crypto.js";
import { SuppliersService } from "./suppliers.service.js";

/**
 * Supplier payout details with maker-checker (D5.1; brief §5.7 "recipient verification" and §15 D
 * "changed payment details require independent verification and invalidate affected approvals").
 *
 * - Proposing (manage suppliers + step-up) appends an immutable version, `pending`, and
 *   supersedes the current one, so changed details are never usable until verified again.
 * - Verifying (company-wide payments.approve + step-up) records the method, note, verifier and
 *   time; the verifier must not be a contributor (the proposer, or anyone who changed a contact
 *   phone in the 30 days before the proposal or while it is pending). Rejecting needs a reason.
 * - Only the verified current version is usable for payment; D5.2 payments bind to its ID.
 * The database repeats every rule (app.guard_payout_version, state CHECK, one-current index).
 */
@Injectable()
export class PayoutsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: ProcurementAccess,
    private readonly store: CatalogueStore,
    private readonly crypto: SupplierCrypto,
    private readonly suppliers: SuppliersService,
  ) {}

  /** Locks the supplier row: payout changes for one supplier happen one at a time. */
  private async lock(scope: Scope, supplierId: string) {
    await this.store.supplier(scope, supplierId);
    await scope.tx
      .$queryRaw`SELECT id FROM suppliers WHERE tenant_id = ${scope.access.tenantId}::uuid
      AND id = ${supplierId}::uuid FOR UPDATE`;
  }

  propose(principal: Principal, supplierId: string, input: ProposePayoutRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          await this.access.manager(scope, true);
          await this.proposeInScope(scope, supplierId, input);
          return this.suppliers.detail(scope, supplierId);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw procurementConflict("payout-stale", "Another proposal was made at the same time");
        throw error;
      });
  }

  /** Appends a pending version, superseding the current one (permission checked by the caller). */
  async proposeInScope(scope: Scope, supplierId: string, input: ProposePayoutRequest) {
    const { tx, access } = scope;
    await this.lock(scope, supplierId);
    const versions = await tx.supplierPayoutVersion.findMany({
      where: { tenantId: access.tenantId, supplierId },
      orderBy: { versionNo: "desc" },
    });
    const current =
      versions.find((version) => ["pending", "verified"].includes(version.status)) ?? null;
    if ((current?.id ?? null) !== input.replaces)
      throw procurementConflict(
        "payout-stale",
        "The payout details changed since you loaded them. Reload and try again.",
      );
    if (current)
      await tx.supplierPayoutVersion.update({
        where: { tenantId_id: { tenantId: access.tenantId, id: current.id } },
        data: { status: "superseded", supersededBy: access.userId, supersededAt: new Date() },
      });
    const id = nextId();
    const versionNo = (versions[0]?.versionNo ?? 0) + 1;
    const bank = input.bank;
    await tx.supplierPayoutVersion.create({
      data: {
        id,
        tenantId: access.tenantId,
        supplierId,
        versionNo,
        mpesaKind: input.mpesaKind,
        paybillNumber: input.paybillNumber,
        accountReference: input.accountReference,
        tillNumber: input.tillNumber,
        bankName: bank?.bankName ?? null,
        bankBranch: bank?.branch ?? null,
        accountName: bank?.accountName ?? null,
        accountNumberEnc: bank
          ? this.crypto.seal(access.tenantId, id, ACCOUNT_NUMBER_COLUMN, bank.accountNumber)
          : null,
        accountNumberMasked: bank ? maskAccountNumber(bank.accountNumber) : null,
        proposedBy: access.userId,
        contributors: [access.userId],
      },
    });
    await this.scope.audit(tx, "supplier.payout_proposed", supplierId, {
      payoutId: id,
      versionNo,
      mpesaKind: input.mpesaKind,
      bank: bank !== null,
      replaced: current?.id ?? null,
      invalidatedVerification: current?.status === "verified",
    });
    return id;
  }

  private async pending(scope: Scope, supplierId: string, payoutId: string) {
    const row = await scope.tx.supplierPayoutVersion.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: payoutId } },
    });
    if (!row || row.supplierId !== supplierId)
      throw new NotFoundException({
        message: "Payout details not found",
        code: "payout-not-found",
      });
    if (row.status !== "pending")
      throw procurementConflict("payout-not-pending", `These payout details are ${row.status}`);
    if (row.contributors.includes(scope.access.userId))
      throw procurementProblem(
        403,
        "maker-checker",
        "Someone who made or contributed to these details cannot verify or reject them",
      );
    return row;
  }

  verify(
    principal: Principal,
    supplierId: string,
    payoutId: string,
    input: { method: string; note: string },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          this.access.verifier(scope);
          await this.verifyInScope(scope, supplierId, payoutId, input);
          return this.suppliers.detail(scope, supplierId);
        },
        true,
      )
      .catch(makerCheckerFromDatabase);
  }

  /** Records an independent verification (permission and step-up checked by the caller). */
  async verifyInScope(
    scope: Scope,
    supplierId: string,
    payoutId: string,
    input: { method: string; note: string },
  ) {
    const { tx, access } = scope;
    await this.lock(scope, supplierId);
    const row = await this.pending(scope, supplierId, payoutId);
    await tx.supplierPayoutVersion.update({
      where: { tenantId_id: { tenantId: access.tenantId, id: payoutId } },
      data: {
        status: "verified",
        verifiedBy: access.userId,
        verifiedAt: new Date(),
        verificationMethod: input.method,
        verificationNote: input.note,
      },
    });
    // The note may name people or numbers: it stays on the version, not in the audit log.
    await this.scope.audit(tx, "supplier.payout_verified", supplierId, {
      payoutId,
      versionNo: row.versionNo,
      method: input.method,
    });
  }

  reject(
    principal: Principal,
    supplierId: string,
    payoutId: string,
    input: { reason: string },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          if (!this.access.canVerifyPayout(scope))
            throw new ForbiddenException("Company-wide permission required: payments.approve");
          await this.lock(scope, supplierId);
          const row = await this.pending(scope, supplierId, payoutId);
          await tx.supplierPayoutVersion.update({
            where: { tenantId_id: { tenantId: access.tenantId, id: payoutId } },
            data: {
              status: "rejected",
              rejectedBy: access.userId,
              rejectedAt: new Date(),
              rejectionReason: input.reason,
            },
          });
          await this.scope.audit(tx, "supplier.payout_rejected", supplierId, {
            payoutId,
            versionNo: row.versionNo,
            reasonGiven: true,
          });
          return this.suppliers.detail(scope, supplierId);
        },
        true,
      )
      .catch(makerCheckerFromDatabase);
  }
}

/** The database's maker-checker CHECK is the backstop for the API rule. */
function makerCheckerFromDatabase(error: unknown): never {
  if (isCheckViolation(error))
    throw procurementProblem(
      403,
      "maker-checker",
      "Someone who made or contributed to these details cannot verify or reject them",
    );
  throw error;
}
