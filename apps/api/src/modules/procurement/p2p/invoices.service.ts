import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import {
  documentTotals,
  invoiceNumberKey,
  isVatable,
  lineNetAmountMinor,
  perBaseMinor,
  Ratio,
  settlementReferenceKey,
  threeWayMatch,
  type ThreeWayMatchResult,
} from "@pm-buddy/domain";
import {
  BQ_VAT_RULE,
  type EtimsNumberFormat,
  type InvoiceStatus,
  type MatchStaleReason,
  type VatTreatment,
} from "@pm-buddy/types";
import {
  invoiceDetailResponseSchema,
  invoicesResponseSchema,
  type ApproveInvoiceRequest,
  type ParsedCreateInvoiceRequest,
  type ParsedUpdateInvoiceRequest,
  type RecordSettlementRequest,
} from "@pm-buddy/validation";
import { isCheckViolation, isUniqueViolation } from "../../../common/database-errors.js";
import { AppConfig } from "../../../config/app-config.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { Scope } from "../../identity/access-policy.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { assertUsableUnit } from "../catalogue.service.js";
import { businessToday, CatalogueStore, nextId } from "../catalogue-store.js";
import {
  fromCalendarDate,
  peopleOf,
  personOf,
  supplierRef,
  toCalendarDate,
  type People,
} from "../procurement-mappers.js";
import { LposService } from "./lpos.service.js";
import { toDocument } from "./p2p-documents.service.js";
import {
  grnSet,
  invalidTransition,
  iso,
  isoOrNull,
  makerChecker,
  materialWire,
  p2pBadRequest,
  p2pConflict,
  P2pAccess,
  p2pSettings,
  p2pVersionConflict,
  personOrNull,
  pricePerBase,
  priorInvoiceSet,
  projectRef,
  qtyText,
  requestDigest,
  sameMembers,
  storedNetPerBase,
  toBaseQuantity,
  type P2pSettings,
  type ProjectAccess,
} from "./p2p-common.js";

type InvoiceRow = Prisma.SupplierInvoiceGetPayload<object>;
type MatchRow = Prisma.ThreeWayMatchGetPayload<object>;
const RECORDERS = ["finance.manage", "procurement.manage_suppliers"] as const;
const ACCRUED: InvoiceStatus[] = ["approved", "partly_settled", "settled"];

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Supplier invoices, the three-way match, approval and recorded settlements (D5.2, brief §5.3,
 * §5.7, §15 C/D/G). Finance (finance.manage) or procurement records an invoice against one
 * approved LPO with its KRA eTIMS number; submission runs the three-way match (packages/domain
 * threeWayMatch) and stores its evidence; a non-matched invoice is never approvable or payable
 * (here and in the database). Approval (payments.approve + step-up, not a contributor) binds a
 * payable: the invoice's content version, the passing match and the supplier's verified payout
 * version. Settlements done outside PM-Buddy are recorded (payments.disburse + step-up, not the
 * approver) against the active payable while its payee is still verified.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: P2pAccess,
    private readonly store: CatalogueStore,
    private readonly config: AppConfig,
    private readonly lpos: LposService,
  ) {}

  list(
    principal: Principal,
    query: {
      projectId?: string;
      lpoId?: string;
      supplierId?: string;
      status?: InvoiceStatus;
      cursor?: string;
      limit: number;
    },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const projectIds = await this.access.visibleProjectIds(scope, query.projectId);
      const rows = await scope.tx.supplierInvoice.findMany({
        where: {
          tenantId: scope.access.tenantId,
          projectId: { in: projectIds },
          ...(query.lpoId ? { lpoId: query.lpoId } : {}),
          ...(query.supplierId ? { supplierId: query.supplierId } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        orderBy: { id: "desc" },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const canRecord =
        RECORDERS.some((permission) => scope.access.permissions.has(permission)) &&
        projectIds.length > 0;
      return invoicesResponseSchema.parse({
        invoices: await Promise.all(page.map((row) => this.summary(scope, row))),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
        },
        permissions: { canRecord },
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

  create(principal: Principal, input: ParsedCreateInvoiceRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const lpo = await this.lpos.row(scope, input.lpoId);
          await this.access.require(scope, lpo.projectId, RECORDERS);
          if (lpo.status !== "approved")
            throw p2pConflict("lpo-not-approved", "Invoices are recorded against approved LPOs");
          const key = invoiceNumberKey(input.invoiceNumber);
          await this.assertNumberFree(scope, lpo.supplierId, key, null);
          const rate = this.config.get("BQ_VAT_RATE_PERCENT");
          const priced = await this.priceLines(scope, lpo, input.invoiceDate, input.lines, rate);
          const totals = documentTotals(priced, rate);
          const id = nextId();
          await tx.supplierInvoice.create({
            data: {
              id,
              tenantId: access.tenantId,
              projectId: lpo.projectId,
              lpoId: lpo.id,
              supplierId: lpo.supplierId,
              invoiceNumber: input.invoiceNumber,
              invoiceNumberKey: key,
              invoiceDate: fromCalendarDate(input.invoiceDate),
              dueDate: dueDate(input.invoiceDate, lpo.creditDays),
              etimsInvoiceNumber: input.etimsInvoiceNumber?.value ?? null,
              etimsFormat: input.etimsInvoiceNumber?.format ?? null,
              vatRatePercent: rate,
              vatRuleStatus: BQ_VAT_RULE.status,
              subtotalMinor: BigInt(input.subtotalMinor),
              vatMinor: BigInt(input.vatMinor),
              totalMinor: BigInt(input.totalMinor),
              computedSubtotalMinor: BigInt(totals.subtotalMinor),
              computedVatMinor: BigInt(totals.vatMinor),
              notes: input.notes ?? null,
              createdBy: access.userId,
              updatedBy: access.userId,
            },
          });
          await this.writeLines(scope, id, lpo.id, priced);
          await this.scope.audit(tx, "invoice.recorded", id, {
            projectId: lpo.projectId,
            lpoId: lpo.id,
            supplierId: lpo.supplierId,
            lines: priced.length,
            etims: input.etimsInvoiceNumber?.format ?? "missing",
          });
          return this.detail(scope, id);
        },
        true,
      )
      .catch(numberTaken);
  }

  update(principal: Principal, id: string, input: ParsedUpdateInvoiceRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.row(scope, id);
          await this.access.require(scope, row.projectId, RECORDERS);
          if (row.status !== "draft") throw invalidTransition(row.status);
          if (row.version !== input.version) throw p2pVersionConflict();
          const lpo = await this.lpos.row(scope, row.lpoId);
          const key = input.invoiceNumber
            ? invoiceNumberKey(input.invoiceNumber)
            : row.invoiceNumberKey;
          if (input.invoiceNumber) await this.assertNumberFree(scope, row.supplierId, key, row.id);
          const invoiceDate = input.invoiceDate ?? toCalendarDate(row.invoiceDate);
          const rate = row.vatRatePercent.toFixed();
          const data: Prisma.SupplierInvoiceUpdateManyMutationInput = {
            ...(input.invoiceNumber
              ? { invoiceNumber: input.invoiceNumber, invoiceNumberKey: key }
              : {}),
            ...(input.invoiceDate
              ? {
                  invoiceDate: fromCalendarDate(input.invoiceDate),
                  dueDate: dueDate(input.invoiceDate, lpo.creditDays),
                }
              : {}),
            ...(input.etimsInvoiceNumber !== undefined
              ? {
                  etimsInvoiceNumber: input.etimsInvoiceNumber?.value ?? null,
                  etimsFormat: input.etimsInvoiceNumber?.format ?? null,
                }
              : {}),
            ...(input.subtotalMinor !== undefined
              ? { subtotalMinor: BigInt(input.subtotalMinor) }
              : {}),
            ...(input.vatMinor !== undefined ? { vatMinor: BigInt(input.vatMinor) } : {}),
            ...(input.totalMinor !== undefined ? { totalMinor: BigInt(input.totalMinor) } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
          };
          const lines = input.lines
            ? await this.priceLines(scope, lpo, invoiceDate, input.lines, rate)
            : null;
          if (lines) {
            const totals = documentTotals(lines, rate);
            data.computedSubtotalMinor = BigInt(totals.subtotalMinor);
            data.computedVatMinor = BigInt(totals.vatMinor);
          }
          const total = Number(input.totalMinor ?? row.totalMinor);
          if (
            Number(input.subtotalMinor ?? row.subtotalMinor) +
              Number(input.vatMinor ?? row.vatMinor) !==
            total
          )
            throw p2pBadRequest(
              "invoice-total-arithmetic",
              "The total must equal the subtotal plus VAT",
            );
          const updated = await tx.supplierInvoice.updateMany({
            where: { tenantId: access.tenantId, id, version: input.version },
            data: {
              ...data,
              contentVersion: { increment: 1 },
              version: { increment: 1 },
              updatedBy: access.userId,
              updatedAt: new Date(),
            },
          });
          if (!updated.count) throw p2pVersionConflict();
          if (lines) {
            await tx.supplierInvoiceLine.deleteMany({
              where: { tenantId: access.tenantId, invoiceId: id },
            });
            await this.writeLines(scope, id, row.lpoId, lines);
          }
          await this.scope.audit(tx, "invoice.updated", id, {
            fields: Object.keys(input).filter((field) => field !== "version"),
          });
          return this.detail(scope, id);
        },
        true,
      )
      .catch(numberTaken);
  }

  /** Submits a draft and runs the three-way match: matched or disputed. */
  submit(principal: Principal, id: string, input: { version: number }, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const row = await this.row(scope, id);
        await this.access.require(scope, row.projectId, RECORDERS);
        if (row.status !== "draft") throw invalidTransition(row.status);
        if (row.version !== input.version) throw p2pVersionConflict();
        const now = new Date();
        await this.bump(scope, row, {
          status: "submitted",
          submittedBy: scope.access.userId,
          submittedAt: now,
        });
        await this.scope.audit(scope.tx, "invoice.submitted", id, { projectId: row.projectId });
        await this.matchAndMove(scope, await this.row(scope, id));
        return this.detail(scope, id);
      },
      true,
    );
  }

  /** Runs the match again (e.g. after another delivery); matched ↔ disputed follows it. */
  rematch(principal: Principal, id: string, input: { version: number }, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const row = await this.row(scope, id);
        await this.access.require(scope, row.projectId, [...RECORDERS, "payments.approve"]);
        if (!["submitted", "disputed", "matched"].includes(row.status))
          throw invalidTransition(row.status);
        if (row.version !== input.version) throw p2pVersionConflict();
        await this.matchAndMove(scope, row);
        return this.detail(scope, id);
      },
      true,
    );
  }

  reopen(principal: Principal, id: string, input: { version: number }, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const row = await this.row(scope, id);
        await this.access.require(scope, row.projectId, RECORDERS);
        if (!["disputed", "matched"].includes(row.status)) throw invalidTransition(row.status);
        if (row.version !== input.version) throw p2pVersionConflict();
        await this.bump(scope, row, { status: "draft", submittedBy: null, submittedAt: null });
        await this.scope.audit(scope.tx, "invoice.reopened", id, { from: row.status });
        return this.detail(scope, id);
      },
      true,
    );
  }

  cancel(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const row = await this.row(scope, id);
        await this.access.require(scope, row.projectId, RECORDERS);
        if (!["draft", "submitted", "disputed", "matched"].includes(row.status))
          throw invalidTransition(row.status);
        if (row.version !== input.version) throw p2pVersionConflict();
        await this.bump(scope, row, {
          status: "cancelled",
          cancelledBy: scope.access.userId,
          cancelledAt: new Date(),
          cancelReason: input.reason,
        });
        await this.scope.audit(scope.tx, "invoice.cancelled", id, {
          from: row.status,
          reasonGiven: true,
        });
        return this.detail(scope, id);
      },
      true,
    );
  }

  /**
   * An independent approved exception for a disputed invoice (payments.approve + step-up, not a
   * contributor): the current mismatched match is accepted with a reason. Never for a missing
   * eTIMS number, inconsistent totals or lines that are not on the LPO.
   */
  except(
    principal: Principal,
    id: string,
    input: { version: number; matchId: string; reason: string },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.row(scope, id);
          await this.access.require(scope, row.projectId, ["payments.approve"], { stepUp: true });
          if (row.status !== "disputed") throw invalidTransition(row.status);
          if (row.version !== input.version) throw p2pVersionConflict();
          if (row.contributors.includes(access.userId))
            throw makerChecker(
              "Someone who recorded or edited this invoice cannot approve an exception",
            );
          const match = await this.latestMatch(scope, id);
          if (!match || match.id !== input.matchId)
            throw p2pConflict("match-stale", "The match you saw is no longer the latest; reload");
          const settings = await p2pSettings(scope);
          if ((await this.staleReasons(scope, row, match, settings)).length)
            throw p2pConflict("match-stale", "The match is out of date; run it again");
          const evidence = match.evidence as unknown as ThreeWayMatchResult;
          if (match.outcome !== "mismatch" || !evidence.exceptable)
            throw p2pConflict(
              "match-not-exceptable",
              "This mismatch cannot be overridden by an exception",
            );
          await tx.threeWayMatch.update({
            where: { tenantId_id: { tenantId: access.tenantId, id: match.id } },
            data: {
              exceptionReason: input.reason,
              exceptionBy: access.userId,
              exceptionAt: new Date(),
            },
          });
          await this.bump(scope, row, { status: "matched" });
          await this.scope.audit(tx, "invoice.match_excepted", id, {
            matchId: match.id,
            reasons: evidence.reasons,
            reasonGiven: true,
          });
          return this.detail(scope, id);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isCheckViolation(error)) {
          if (messageOf(error).includes("independent person"))
            throw makerChecker(
              "Someone who recorded or edited this invoice cannot approve an exception",
            );
          throw p2pConflict(
            "match-not-exceptable",
            "This mismatch cannot be overridden by an exception",
          );
        }
        throw error;
      });
  }

  /**
   * Approval: payments.approve + step-up, not a contributor, quoting the match and payee version
   * seen. First approval needs a passing, current match; a re-approval (the payee's details changed
   * since) keeps the approved match. The database repeats every rule (app.guard_invoice_payable).
   */
  approve(principal: Principal, id: string, input: ApproveInvoiceRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.row(scope, id);
          await this.access.require(scope, row.projectId, ["payments.approve"], { stepUp: true });
          if (row.version !== input.version) throw p2pVersionConflict();
          if (row.contributors.includes(access.userId))
            throw makerChecker("Someone who recorded or edited this invoice cannot approve it");
          const previous = await this.activePayable(scope, id);
          const reapproval = row.status === "approved" || row.status === "partly_settled";
          if (!reapproval && row.status !== "matched") throw invalidTransition(row.status);
          if (reapproval) {
            if (previous && previous.payeeStatus === "verified")
              throw p2pConflict("approval-current", "This invoice's approval is still current");
            const latest = await tx.invoicePayable.findFirst({
              where: { tenantId: access.tenantId, invoiceId: id },
              orderBy: [{ approvedAt: "desc" }, { id: "desc" }],
            });
            if (!latest || latest.matchId !== input.matchId)
              throw p2pConflict("match-stale", "A re-approval keeps the approved match");
          } else {
            const match = await this.latestMatch(scope, id);
            if (!match || match.id !== input.matchId)
              throw p2pConflict("match-stale", "The match you saw is no longer the latest; reload");
            const settings = await p2pSettings(scope);
            if ((await this.staleReasons(scope, row, match, settings)).length)
              throw p2pConflict("match-stale", "The match is out of date; run it again");
            const evaluated = await this.evaluate(scope, row, settings);
            if (evaluated.result.outcome !== "matched" && !match.exceptionAt)
              throw p2pConflict("match-not-passing", "The three-way match does not pass");
            if (match.outcome !== "matched" && !match.exceptionAt)
              throw p2pConflict("match-not-passing", "The three-way match does not pass");
          }
          const payee = await tx.supplierPayoutVersion.findFirst({
            where: { tenantId: access.tenantId, supplierId: row.supplierId, status: "verified" },
          });
          if (!payee)
            throw p2pConflict(
              "payee-not-verified",
              "The supplier has no verified payout details; verify them first",
            );
          if (payee.id !== input.payoutVersionId)
            throw p2pConflict("payee-changed", "The supplier's payout details changed; reload");
          const settled = await this.settledMinor(scope, id);
          const payableId = nextId();
          await tx.invoicePayable.create({
            data: {
              id: payableId,
              tenantId: access.tenantId,
              invoiceId: id,
              invoiceContentVersion: row.contentVersion,
              matchId: input.matchId,
              payoutVersionId: payee.id,
              authorisedMinor: row.totalMinor - BigInt(settled),
              approvedBy: access.userId,
            },
          });
          await this.bump(scope, row, reapproval ? {} : { status: "approved" });
          await this.scope.audit(tx, reapproval ? "invoice.reapproved" : "invoice.approved", id, {
            projectId: row.projectId,
            payableId,
            matchId: input.matchId,
            payoutVersionId: payee.id,
          });
          return this.detail(scope, id);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isCheckViolation(error)) {
          if (messageOf(error).includes("did not prepare it"))
            throw makerChecker("Someone who recorded or edited this invoice cannot approve it");
          throw p2pConflict(
            "match-not-passing",
            "The database refused the approval: the invoice is not payable as matched",
          );
        }
        if (isUniqueViolation(error))
          throw p2pConflict("approval-current", "This invoice was approved at the same time");
        throw error;
      });
  }

  /** Records a settlement made outside PM-Buddy (idempotent; never above what is outstanding). */
  settle(
    principal: Principal,
    id: string,
    input: RecordSettlementRequest,
    key: string,
    req: Request,
  ) {
    const digest = requestDigest(`invoice.settle:${id}`, input);
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.row(scope, id);
          await this.access.require(scope, row.projectId, ["payments.disburse"], { stepUp: true });
          const replay = await tx.invoiceSettlement.findUnique({
            where: { tenantId_idempotencyKey: { tenantId: access.tenantId, idempotencyKey: key } },
          });
          if (replay) {
            if (replay.requestDigest !== digest)
              throw p2pConflict(
                "idempotency-key-reused",
                "This idempotency key was used for a different settlement",
              );
            return this.detail(scope, id);
          }
          if (!["approved", "partly_settled"].includes(row.status))
            throw p2pConflict("invoice-not-payable", "Only an approved invoice can be settled");
          const payable = await this.activePayable(scope, id);
          if (!payable || payable.payeeStatus !== "verified")
            throw p2pConflict(
              "payee-changed",
              "The supplier's payout details changed after approval; it must be approved again",
            );
          if (payable.approvedBy === access.userId)
            throw makerChecker("The approver of an invoice cannot record its settlement");
          const outstanding = Number(row.totalMinor) - (await this.settledMinor(scope, id));
          if (input.amountMinor > outstanding)
            throw p2pConflict(
              "settlement-exceeds-outstanding",
              "The amount is more than the outstanding balance",
            );
          if (input.paidOn > businessToday() || input.paidOn < toCalendarDate(row.invoiceDate))
            throw p2pBadRequest(
              "settlement-date-invalid",
              "The payment date is between the invoice date and today",
            );
          const referenceKey = settlementReferenceKey(input.externalReference);
          const taken = await tx.invoiceSettlement.count({
            where: { tenantId: access.tenantId, method: input.method, referenceKey },
          });
          if (taken)
            throw p2pConflict(
              "settlement-reference-taken",
              "This payment reference was already recorded",
            );
          const settlementId = nextId();
          await tx.invoiceSettlement.create({
            data: {
              id: settlementId,
              tenantId: access.tenantId,
              invoiceId: id,
              payableId: payable.id,
              method: input.method,
              externalReference: input.externalReference,
              referenceKey,
              amountMinor: BigInt(input.amountMinor),
              paidOn: fromCalendarDate(input.paidOn),
              note: input.note ?? null,
              idempotencyKey: key,
              requestDigest: digest,
              recordedBy: access.userId,
            },
          });
          const status = input.amountMinor === outstanding ? "settled" : "partly_settled";
          await this.bump(scope, row, { status });
          // The amount and the reference stay out of the audit log.
          await this.scope.audit(tx, "invoice.settlement_recorded", id, {
            projectId: row.projectId,
            settlementId,
            payableId: payable.id,
            method: input.method,
            status,
          });
          return this.detail(scope, id);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw p2pConflict(
            "settlement-reference-taken",
            "This payment reference was already recorded",
          );
        if (isCheckViolation(error)) {
          const message = messageOf(error);
          if (message.includes("other than the approver"))
            throw makerChecker("The approver of an invoice cannot record its settlement");
          if (message.includes("outstanding"))
            throw p2pConflict(
              "settlement-exceeds-outstanding",
              "The amount is more than the outstanding balance",
            );
          throw p2pConflict("invoice-not-payable", "The database refused the settlement");
        }
        throw error;
      });
  }

  // Matching --------------------------------------------------------------------------------

  /** The domain match on the invoice as stored now, with the sets and settings it used. */
  async evaluate(scope: Scope, invoice: InvoiceRow, settings: P2pSettings) {
    const { tx, access } = scope;
    const grnIds = await grnSet(tx, access.tenantId, invoice.lpoId);
    const priorIds = await priorInvoiceSet(tx, access.tenantId, invoice.lpoId, invoice.id);
    const [lpo, lpoLines, grnLines, priorLines, priorInvoices, lines] = await Promise.all([
      this.lpos.row(scope, invoice.lpoId),
      tx.lpoLine.findMany({ where: { tenantId: access.tenantId, lpoId: invoice.lpoId } }),
      tx.grnLine.findMany({ where: { tenantId: access.tenantId, grnId: { in: grnIds } } }),
      tx.supplierInvoiceLine.findMany({
        where: { tenantId: access.tenantId, invoiceId: { in: priorIds } },
      }),
      tx.supplierInvoice.findMany({
        where: { tenantId: access.tenantId, id: { in: priorIds } },
        select: { computedSubtotalMinor: true },
      }),
      tx.supplierInvoiceLine.findMany({
        where: { tenantId: access.tenantId, invoiceId: invoice.id },
      }),
    ]);
    const sumBy = (rows: { lpoLineId: string; quantity: { toFixed(): string } }[]) => {
      const totals = new Map<string, Ratio>();
      for (const row of rows)
        totals.set(
          row.lpoLineId,
          (totals.get(row.lpoLineId) ?? Ratio.of(0)).plus(
            Ratio.fromDecimal(row.quantity.toFixed()),
          ),
        );
      return new Map([...totals].map(([lineId, total]) => [lineId, qtyText(total)]));
    };
    const lpoRate = lpo.vatRatePercent.toFixed();
    const invoiceRate = invoice.vatRatePercent.toFixed();
    const result = threeWayMatch({
      quantityTolerancePercent: settings.qtyTolerancePercent,
      priceTolerancePercent: settings.priceTolerancePercent,
      blockWithoutEtims: settings.blockPaymentWithoutEtims,
      etims: {
        number: invoice.etimsInvoiceNumber,
        format: invoice.etimsFormat as EtimsNumberFormat | null,
      },
      vatRatePercent: invoiceRate,
      order: {
        lines: lpoLines.map((line) => ({
          lpoLineId: line.id,
          lineNo: line.lineNo,
          orderedBaseQuantity: line.baseQuantity.toFixed(),
          netPerBase: storedNetPerBase(line, lpoRate),
        })),
        subtotalMinor: Number(lpo.subtotalMinor),
      },
      received: sumBy(
        grnLines.map((line) => ({
          lpoLineId: line.lpoLineId,
          quantity: line.acceptedBaseQuantity,
        })),
      ),
      previouslyInvoiced: sumBy(
        priorLines.map((line) => ({ lpoLineId: line.lpoLineId, quantity: line.baseQuantity })),
      ),
      previouslyInvoicedSubtotalMinor: priorInvoices.reduce(
        (sum, entry) => sum + Number(entry.computedSubtotalMinor),
        0,
      ),
      invoice: {
        lines: lines.map((line) => ({
          lpoLineId: line.lpoLineId,
          baseQuantity: line.baseQuantity.toFixed(),
          netPerBase: storedNetPerBase(line, invoiceRate),
          netAmountMinor: Number(line.netAmountMinor),
          vatable: isVatable(line.vatTreatment as VatTreatment),
        })),
        subtotalMinor: Number(invoice.subtotalMinor),
        vatMinor: Number(invoice.vatMinor),
        totalMinor: Number(invoice.totalMinor),
      },
    });
    return { result, grnIds, priorIds };
  }

  /** Stores a match run and moves a submitted, matched or disputed invoice to its outcome. */
  private async matchAndMove(scope: Scope, invoice: InvoiceRow) {
    const { tx, access } = scope;
    const settings = await p2pSettings(scope);
    const { result, grnIds, priorIds } = await this.evaluate(scope, invoice, settings);
    const matchId = nextId();
    await tx.threeWayMatch.create({
      data: {
        id: matchId,
        tenantId: access.tenantId,
        invoiceId: invoice.id,
        lpoId: invoice.lpoId,
        invoiceContentVersion: invoice.contentVersion,
        grnIds,
        priorInvoiceIds: priorIds,
        qtyTolerancePercent: settings.qtyTolerancePercent,
        priceTolerancePercent: settings.priceTolerancePercent,
        blockWithoutEtims: settings.blockPaymentWithoutEtims,
        outcome: result.outcome,
        reasons: result.reasons,
        evidence: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
        computedBy: access.userId,
      },
    });
    const status = result.outcome === "matched" ? "matched" : "disputed";
    await this.bump(scope, invoice, { status });
    await this.scope.audit(tx, `invoice.${status}`, invoice.id, {
      matchId,
      reasons: result.reasons,
      grns: grnIds.length,
      priorInvoices: priorIds.length,
    });
    return matchId;
  }

  private latestMatch(scope: Scope, invoiceId: string) {
    return scope.tx.threeWayMatch.findFirst({
      where: { tenantId: scope.access.tenantId, invoiceId },
      orderBy: [{ computedAt: "desc" }, { id: "desc" }],
    });
  }

  private async staleReasons(
    scope: Scope,
    invoice: InvoiceRow,
    match: MatchRow,
    settings: P2pSettings,
  ): Promise<MatchStaleReason[]> {
    const { tx, access } = scope;
    const reasons: MatchStaleReason[] = [];
    if (match.invoiceContentVersion !== invoice.contentVersion) reasons.push("invoice-changed");
    if (!sameMembers(match.grnIds, await grnSet(tx, access.tenantId, invoice.lpoId)))
      reasons.push("grns-changed");
    if (
      !sameMembers(
        match.priorInvoiceIds,
        await priorInvoiceSet(tx, access.tenantId, invoice.lpoId, invoice.id),
      )
    )
      reasons.push("invoices-changed");
    if (
      !Ratio.fromDecimal(match.qtyTolerancePercent.toFixed()).equals(
        Ratio.fromDecimal(settings.qtyTolerancePercent),
      ) ||
      !Ratio.fromDecimal(match.priceTolerancePercent.toFixed()).equals(
        Ratio.fromDecimal(settings.priceTolerancePercent),
      ) ||
      match.blockWithoutEtims !== settings.blockPaymentWithoutEtims
    )
      reasons.push("settings-changed");
    return reasons;
  }

  // Helpers ---------------------------------------------------------------------------------

  async row(scope: Scope, id: string): Promise<InvoiceRow> {
    const row = await scope.tx.supplierInvoice.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("Invoice not found");
    return row;
  }

  private async bump(
    scope: Scope,
    row: InvoiceRow,
    data: Prisma.SupplierInvoiceUpdateManyMutationInput,
  ) {
    const fresh = await this.row(scope, row.id);
    const updated = await scope.tx.supplierInvoice.updateMany({
      where: { tenantId: scope.access.tenantId, id: row.id, version: fresh.version },
      data: {
        ...data,
        version: { increment: 1 },
        updatedBy: scope.access.userId,
        updatedAt: new Date(),
      },
    });
    if (!updated.count) throw p2pVersionConflict();
  }

  private async assertNumberFree(
    scope: Scope,
    supplierId: string,
    key: string,
    self: string | null,
  ) {
    const taken = await scope.tx.supplierInvoice.count({
      where: {
        tenantId: scope.access.tenantId,
        supplierId,
        invoiceNumberKey: key,
        status: { not: "cancelled" },
        ...(self ? { id: { not: self } } : {}),
      },
    });
    if (taken)
      throw p2pConflict(
        "invoice-number-taken",
        "This supplier's invoice number is already recorded",
      );
  }

  private async priceLines(
    scope: Scope,
    lpo: { id: string; supplierId: string },
    invoiceDate: string,
    lines: ParsedCreateInvoiceRequest["lines"],
    rate: string,
  ) {
    const lpoLines = await scope.tx.lpoLine.findMany({
      where: { tenantId: scope.access.tenantId, lpoId: lpo.id },
      include: { material: true },
    });
    const byId = new Map(lpoLines.map((line) => [line.id, line]));
    const units = await this.store.customUnits(scope);
    const priced = [];
    for (const [index, line] of lines.entries()) {
      const ordered = byId.get(line.lpoLineId);
      if (!ordered) throw p2pBadRequest("line-not-on-order", "A line is not on this LPO");
      const unit = line.unit ?? ordered.unit;
      assertUsableUnit(unit, units);
      const base = await toBaseQuantity(
        this.store,
        scope,
        ordered.material,
        lpo.supplierId,
        invoiceDate,
        line.quantity,
        unit,
        units,
      );
      const price = await pricePerBase(
        this.store,
        scope,
        ordered.material,
        lpo.supplierId,
        invoiceDate,
        { priceUnit: unit, unitPriceMinor: line.unitPriceMinor, vatTreatment: line.vatTreatment },
        rate,
        units,
      );
      priced.push({
        lineNo: index + 1,
        lpoLineId: ordered.id,
        quantity: line.quantity,
        unit,
        baseQuantity: base.baseQuantity,
        conversion: { ratio: base.ratio, steps: base.steps },
        unitPriceMinor: line.unitPriceMinor,
        vatTreatment: line.vatTreatment,
        priceRatio: price.ratio.toString(),
        netUnitPriceBaseMinor: perBaseMinor(price.netPerBase),
        netAmountMinor: lineNetAmountMinor(base.baseQuantity, price.netPerBase),
        vatable: isVatable(line.vatTreatment),
      });
    }
    return priced;
  }

  private async writeLines(
    scope: Scope,
    invoiceId: string,
    lpoId: string,
    lines: Awaited<ReturnType<InvoicesService["priceLines"]>>,
  ) {
    for (const line of lines)
      await scope.tx.supplierInvoiceLine.create({
        data: {
          id: nextId(),
          tenantId: scope.access.tenantId,
          invoiceId,
          lpoId,
          lpoLineId: line.lpoLineId,
          lineNo: line.lineNo,
          quantity: line.quantity,
          unit: line.unit,
          baseQuantity: line.baseQuantity,
          unitPriceMinor: BigInt(line.unitPriceMinor),
          vatTreatment: line.vatTreatment,
          priceRatio: line.priceRatio,
          netUnitPriceBaseMinor: line.netUnitPriceBaseMinor,
          netAmountMinor: BigInt(line.netAmountMinor),
          conversion: JSON.parse(JSON.stringify(line.conversion)) as Prisma.InputJsonValue,
        },
      });
  }

  private async settledMinor(scope: Scope, invoiceId: string): Promise<number> {
    const total = await scope.tx.invoiceSettlement.aggregate({
      where: { tenantId: scope.access.tenantId, invoiceId },
      _sum: { amountMinor: true },
    });
    return Number(total._sum.amountMinor ?? 0n);
  }

  private async activePayable(scope: Scope, invoiceId: string) {
    const payable = await scope.tx.invoicePayable.findFirst({
      where: { tenantId: scope.access.tenantId, invoiceId, supersededAt: null },
      include: { payoutVersion: { select: { status: true } } },
    });
    return payable ? { ...payable, payeeStatus: payable.payoutVersion.status } : null;
  }

  async summary(scope: Scope, row: InvoiceRow) {
    const { tx, access } = scope;
    const [project, lpo, supplier, people, settled] = await Promise.all([
      tx.project.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: access.tenantId, id: row.projectId } },
        select: { id: true, code: true, name: true },
      }),
      tx.lpo.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: access.tenantId, id: row.lpoId } },
        select: { id: true, number: true },
      }),
      this.store.supplier(scope, row.supplierId),
      peopleOf(tx, [row.createdBy, row.submittedBy]),
      this.settledMinor(scope, row.id),
    ]);
    return {
      id: row.id,
      project: projectRef(project),
      lpo,
      supplier: {
        ...supplierRef(supplier),
        etimsStatus: supplier.etimsStatus as "registered" | "unknown" | "not_registered",
      },
      invoiceNumber: row.invoiceNumber,
      invoiceDate: toCalendarDate(row.invoiceDate),
      dueDate: toCalendarDate(row.dueDate),
      etimsInvoiceNumber: row.etimsInvoiceNumber,
      etimsFormat: row.etimsFormat as EtimsNumberFormat | null,
      status: row.status as InvoiceStatus,
      contentVersion: row.contentVersion,
      vatRatePercent: row.vatRatePercent.toFixed(),
      subtotalMinor: Number(row.subtotalMinor),
      vatMinor: Number(row.vatMinor),
      totalMinor: Number(row.totalMinor),
      computedSubtotalMinor: Number(row.computedSubtotalMinor),
      computedVatMinor: Number(row.computedVatMinor),
      settledMinor: settled,
      outstandingMinor: ACCRUED.includes(row.status as InvoiceStatus)
        ? Number(row.totalMinor) - settled
        : 0,
      notes: row.notes,
      version: row.version,
      createdAt: iso(row.createdAt),
      createdBy: personOf(people, row.createdBy),
      submittedAt: isoOrNull(row.submittedAt),
      submittedBy: personOrNull(people, row.submittedBy),
      cancelledAt: isoOrNull(row.cancelledAt),
      cancelReason: row.cancelReason,
    };
  }

  private payoutWire(payout: Prisma.SupplierPayoutVersionGetPayload<object>) {
    return {
      id: payout.id,
      versionNo: payout.versionNo,
      status: payout.status as "pending" | "verified" | "rejected" | "superseded",
      mpesaKind: payout.mpesaKind as "paybill" | "till" | "none",
      paybillNumber: payout.paybillNumber,
      accountReference: payout.accountReference,
      tillNumber: payout.tillNumber,
      bank:
        payout.bankName && payout.accountNumberMasked
          ? { bankName: payout.bankName, accountNumberMasked: payout.accountNumberMasked }
          : null,
    };
  }

  private matchWire(
    match: MatchRow,
    stale: MatchStaleReason[],
    materials: ReadonlyMap<string, ReturnType<typeof materialWire>>,
    people: People,
  ) {
    const evidence = match.evidence as unknown as ThreeWayMatchResult;
    return {
      id: match.id,
      outcome: match.outcome as "matched" | "mismatch",
      passing: match.outcome === "matched" || match.exceptionAt !== null,
      current: stale.length === 0,
      staleReasons: stale,
      reasons: evidence.reasons,
      headerReasons: evidence.headerReasons,
      warnings: evidence.warnings,
      exceptable: evidence.exceptable && match.exceptionAt === null,
      lines: evidence.lines.map((line) => ({
        ...line,
        material: materials.get(line.lpoLineId) ?? null,
      })),
      totals: evidence.totals,
      tolerances: {
        qtyPercent: match.qtyTolerancePercent.toFixed(),
        pricePercent: match.priceTolerancePercent.toFixed(),
        blockWithoutEtims: match.blockWithoutEtims,
      },
      invoiceContentVersion: match.invoiceContentVersion,
      grnCount: match.grnIds.length,
      computedAt: iso(match.computedAt),
      computedBy: personOf(people, match.computedBy),
      exception:
        match.exceptionAt && match.exceptionBy && match.exceptionReason
          ? {
              reason: match.exceptionReason,
              approvedAt: iso(match.exceptionAt),
              approvedBy: personOf(people, match.exceptionBy),
            }
          : null,
    };
  }

  async detail(scope: Scope, id: string) {
    const { tx, access } = scope;
    const row = await this.row(scope, id);
    const [summary, lines, match, payables, settlements, payee, project, documents, settings] =
      await Promise.all([
        this.summary(scope, row),
        tx.supplierInvoiceLine.findMany({
          where: { tenantId: access.tenantId, invoiceId: id },
          include: { lpoLine: { include: { material: true } } },
          orderBy: { lineNo: "asc" },
        }),
        this.latestMatch(scope, id),
        tx.invoicePayable.findMany({
          where: { tenantId: access.tenantId, invoiceId: id },
          include: { payoutVersion: true, settlements: { select: { amountMinor: true } } },
          orderBy: [{ approvedAt: "desc" }, { id: "desc" }],
        }),
        tx.invoiceSettlement.findMany({
          where: { tenantId: access.tenantId, invoiceId: id },
          orderBy: { recordedAt: "asc" },
        }),
        tx.supplierPayoutVersion.findFirst({
          where: { tenantId: access.tenantId, supplierId: row.supplierId, status: "verified" },
        }),
        this.access.on(scope, row.projectId),
        tx.procurementDocument.findMany({
          where: { tenantId: access.tenantId, invoiceId: id },
          orderBy: { uploadedAt: "desc" },
        }),
        p2pSettings(scope),
      ]);
    const lpoLines = await tx.lpoLine.findMany({
      where: { tenantId: access.tenantId, lpoId: row.lpoId },
      include: { material: true },
    });
    const materials = new Map(lpoLines.map((line) => [line.id, materialWire(line.material)]));
    const people = await peopleOf(tx, [
      ...row.contributors,
      match?.computedBy,
      match?.exceptionBy,
      ...payables.map((payable) => payable.approvedBy),
      ...settlements.map((settlement) => settlement.recordedBy),
      ...documents.map((document) => document.uploadedBy),
    ]);
    const stale = match ? await this.staleReasons(scope, row, match, settings) : [];
    const payableWire = (payable: (typeof payables)[number]) => {
      const settledOn = payable.settlements.reduce(
        (sum, entry) => sum + Number(entry.amountMinor),
        0,
      );
      return {
        id: payable.id,
        status: payable.supersededAt ? ("superseded" as const) : ("active" as const),
        current: !payable.supersededAt && payable.payoutVersion.status === "verified",
        authorisedMinor: Number(payable.authorisedMinor),
        settledMinor: settledOn,
        outstandingMinor: Math.max(0, Number(payable.authorisedMinor) - settledOn),
        invoiceContentVersion: payable.invoiceContentVersion,
        matchId: payable.matchId,
        payout: this.payoutWire(payable.payoutVersion),
        approvedAt: iso(payable.approvedAt),
        approvedBy: personOf(people, payable.approvedBy),
      };
    };
    const active = payables.find((payable) => !payable.supersededAt) ?? null;
    const activeWire = active ? payableWire(active) : null;
    const has = (permission: Parameters<ProjectAccess["permissions"]["has"]>[0]) =>
      project.permissions.has(permission);
    const contributor = row.contributors.includes(access.userId);
    const needsApproval =
      row.status === "matched" ||
      (["approved", "partly_settled"].includes(row.status) && !activeWire?.current);
    return invoiceDetailResponseSchema.parse({
      invoice: summary,
      lines: lines.map((line) => ({
        id: line.id,
        lineNo: line.lineNo,
        lpoLineId: line.lpoLineId,
        material: materialWire(line.lpoLine.material),
        quantity: line.quantity.toFixed(),
        unit: line.unit,
        baseQuantity: line.baseQuantity.toFixed(),
        unitPriceMinor: Number(line.unitPriceMinor),
        vatTreatment: line.vatTreatment,
        netUnitPriceBaseMinor: line.netUnitPriceBaseMinor.toFixed(),
        netAmountMinor: Number(line.netAmountMinor),
      })),
      match: match ? this.matchWire(match, stale, materials, people) : null,
      payable: activeWire,
      payables: payables.map(payableWire),
      settlements: settlements.map((settlement) => ({
        id: settlement.id,
        payableId: settlement.payableId,
        method: settlement.method,
        externalReference: settlement.externalReference,
        amountMinor: Number(settlement.amountMinor),
        paidOn: toCalendarDate(settlement.paidOn),
        note: settlement.note,
        recordedAt: iso(settlement.recordedAt),
        recordedBy: personOf(people, settlement.recordedBy),
      })),
      payee: payee ? this.payoutWire(payee) : null,
      contributors: row.contributors.map((person) => personOf(people, person)),
      documents: documents.map((document) => toDocument(document, people)),
      permissions: {
        canEdit: RECORDERS.some(has) && row.status === "draft",
        canApprove: has("payments.approve") && needsApproval && !contributor,
        canApproveException:
          has("payments.approve") &&
          row.status === "disputed" &&
          !contributor &&
          match !== null &&
          match.exceptionAt === null &&
          (match.evidence as unknown as ThreeWayMatchResult).exceptable,
        canSettle:
          has("payments.disburse") &&
          ["approved", "partly_settled"].includes(row.status) &&
          Boolean(activeWire?.current) &&
          active?.approvedBy !== access.userId,
      },
    });
  }
}

const dueDate = (invoiceDate: string, creditDays: number) => {
  const date = fromCalendarDate(invoiceDate);
  date.setUTCDate(date.getUTCDate() + creditDays);
  return date;
};

function numberTaken(error: unknown): never {
  if (isUniqueViolation(error))
    throw p2pConflict("invoice-number-taken", "This supplier's invoice number is already recorded");
  throw error;
}
