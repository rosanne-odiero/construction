import { createHash } from "node:crypto";
import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  PayloadTooLargeException,
} from "@nestjs/common";
import {
  addCalendarDays,
  checkCashCap,
  manualPaymentProblem,
  nairobiDate,
} from "@pm-buddy/domain";
import { MANUAL_PAYMENT_LIMITS, P2P_LIMITS } from "@pm-buddy/types";
import {
  manualPaymentResponseSchema,
  paymentEvidenceResponseSchema,
  type ConfirmManualPaymentRequest,
  type ManualPaymentResponse,
  type PaymentEvidenceResponse,
  type RecordManualPaymentRequest,
  type RejectManualPaymentRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { describeError } from "../../common/errors.js";
import { uuidv7 } from "../../common/uuid.js";
import type { PayrollPayout, Prisma } from "../../generated/prisma/client.js";
import { MalwareDetected, MalwareScanner } from "../../infra/malware-scanner.js";
import { StorageService } from "../../infra/storage.service.js";
import type { Scope } from "../identity/access-policy.js";
import { AuthSecurity } from "../identity/auth-security.service.js";
import { AuthService, type Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { LabourCrypto } from "../labour/labour-support.js";
import { PayrollCommands } from "../payroll/payroll-support.js";
import { sniffDocument } from "../procurement/p2p/p2p-documents.service.js";
import { loadObligationContext, obligationView } from "./obligation-views.js";
import { loadPayouts, refreshBatchStatus } from "./payout-facts.js";
import { loadPayoutSettings } from "./payout-settings.service.js";
import { toEvidence, toPayout } from "./payouts-mappers.js";
import { batchOf, isSettling, obligationOf } from "./payouts.service.js";
import {
  lockBatch,
  makerChecker,
  minor,
  notFound,
  payoutConflict,
  payoutProblem,
  PayoutAccess,
  payoutVersionConflict,
  rethrowPayoutDbError,
} from "./payouts-support.js";
import { settlePayout } from "./settlement.js";

type Tx = Prisma.TransactionClient;
export type UploadedEvidence = { buffer: Buffer; originalname: string; size: number };

/**
 * Before a multipart body is read: refuse an oversized declared length (413), require a session
 * (401) and rate-limit uploads per user (429), as for petty-cash receipts.
 */
@Injectable()
export class EvidenceUploadGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly security: AuthSecurity,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (
      Number(req.headers["content-length"] ?? 0) >
      MANUAL_PAYMENT_LIMITS.evidenceMaxBytes + 64 * 1024
    )
      throw new PayloadTooLargeException({
        message: "Evidence photos may be at most 5 MB",
        code: "payload-too-large",
      });
    const principal = await this.auth.principal(req);
    await this.security.limit(
      `payout-evidence-upload:${principal.user.id}`,
      P2P_LIMITS.uploadsPerHour,
      3_600,
    );
    return true;
  }
}

/**
 * Cash and bank payments (record-only, §15, owner decisions 2 and 7): recorded with a fresh step-up
 * against an obligation's outstanding amount (whole shillings), cash within the per-worker period
 * cap and with photo or signature evidence, then confirmed or rejected by a second person with a
 * fresh step-up. Confirmation allocates, posts the paid cost and may settle the obligation (and
 * queue the payslip SMS).
 */
@Injectable()
export class ManualPaymentsService {
  private readonly logger = new Logger(ManualPaymentsService.name);

  constructor(
    private readonly commands: PayrollCommands,
    private readonly access: PayoutAccess,
    private readonly labourCrypto: LabourCrypto,
    private readonly storage: StorageService,
    private readonly scanner: MalwareScanner,
  ) {}

  record(
    principal: Principal,
    req: Request,
    obligationId: string,
    input: RecordManualPaymentRequest,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.manual_payment.record",
      { obligationId, input },
      async (scope): Promise<ManualPaymentResponse> => {
        const { tx, access } = scope;
        const head = await obligationOf(tx, access.tenantId, obligationId);
        await this.access.require(scope, "recordManualPayment", head.projectId);
        await lockBatch(tx, access.tenantId, head.batchId);
        const obligation = await obligationOf(tx, access.tenantId, obligationId);
        const batch = await batchOf(tx, access.tenantId, obligation.batchId);
        if (!isSettling(batch.status))
          throw payoutConflict("invalid-transition", "Only an approved batch is paid.");
        const payouts = await loadPayouts(tx, access.tenantId, [obligation.id]);
        const outstandingMinor = minor(obligation.amountMinor) - minor(obligation.paidMinor);
        const problem = manualPaymentProblem({
          status: obligation.status as "open" | "settled",
          outstandingMinor,
          livePayout: payouts.some((entry) =>
            ["active", "pending_confirmation"].includes(entry.payout.status),
          ),
          uncertainPayout: payouts.some(
            (entry) =>
              entry.request !== null &&
              ["uncertain", "reversal_pending"].includes(entry.request.status),
          ),
          amountMinor: input.amountMinor,
        });
        if (problem === "obligation-settled")
          throw payoutConflict("obligation-settled", "This obligation is already paid.");
        if (problem === "payout-in-flight")
          throw payoutConflict(
            "payout-in-flight",
            "A payment towards this obligation is in progress or uncertain.",
          );
        if (problem === "amount-above-outstanding")
          throw payoutConflict(
            "amount-above-outstanding",
            "The amount is more than what is still owed.",
            { outstandingMinor },
          );
        const today = nairobiDate();
        if (
          input.paidOn > today ||
          input.paidOn < addCalendarDays(today, -MANUAL_PAYMENT_LIMITS.paidOnMaxAgeDays)
        )
          throw payoutConflict(
            "payout-rule",
            `The payment date must be today or within the last ${MANUAL_PAYMENT_LIMITS.paidOnMaxAgeDays} days.`,
          );
        if (input.method === "cash") {
          const settings = await loadPayoutSettings(tx, access.tenantId);
          const usedMinor = await this.cashUsed(tx, access.tenantId, obligation.labourerId, {
            periodStart: batch.periodStart,
            periodEnd: batch.periodEnd,
          });
          const cap = checkCashCap({
            capMinor: settings.cashMaxPerWorkerPeriodMinor,
            usedMinor,
            amountMinor: input.amountMinor,
          });
          if (!cap.ok && cap.code === "cash-disabled")
            throw payoutConflict("cash-disabled", "Cash payments are turned off for the company.");
          if (!cap.ok)
            throw payoutConflict(
              "cash-cap-exceeded",
              "This is more cash than one worker may be paid in a pay period.",
              { capMinor: cap.capMinor, usedMinor: cap.usedMinor },
            );
        }
        const payoutId = uuidv7();
        await tx.payrollPayout.create({
          data: {
            id: payoutId,
            tenantId: access.tenantId,
            projectId: obligation.projectId,
            batchId: obligation.batchId,
            obligationId,
            labourerId: obligation.labourerId,
            method: input.method,
            amountMinor: BigInt(input.amountMinor),
            status: "pending_confirmation",
            paidOn: new Date(`${input.paidOn}T00:00:00.000Z`),
            reason: input.reason?.trim() || null,
            reference: input.reference?.trim() || null,
            createdBy: access.userId,
            stepUpAt: scope.principal.session.mfaVerifiedAt ?? null,
          },
        });
        await refreshBatchStatus(tx, access.tenantId, obligation.batchId);
        await this.commands.audit(scope, "payroll.manual_payment_recorded", payoutId, {
          batchId: obligation.batchId,
          obligationId,
          method: input.method,
        });
        return this.response(scope, payoutId);
      },
      { requireKey: true, mapError: rethrowPayoutDbError },
    );
  }

  confirm(
    principal: Principal,
    req: Request,
    payoutId: string,
    input: ConfirmManualPaymentRequest,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.manual_payment.confirm",
      { payoutId, input },
      async (scope): Promise<ManualPaymentResponse> => {
        const { tx, access } = scope;
        const payout = await this.pending(scope, payoutId, "confirmManualPayment", input.version);
        if (payout.method === "cash") {
          const evidence = await tx.payrollPayoutEvidence.count({
            where: { tenantId: access.tenantId, payoutId },
          });
          if (!evidence)
            throw payoutConflict(
              "evidence-required",
              "Add a photo or signature of the cash payment before confirming it.",
            );
        }
        const updated = await tx.payrollPayout.updateMany({
          where: {
            tenantId: access.tenantId,
            id: payoutId,
            version: payout.version,
            status: "pending_confirmation",
          },
          data: {
            status: "confirmed",
            confirmedBy: access.userId,
            stepUpAt: scope.principal.session.mfaVerifiedAt ?? null,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw payoutVersionConflict();
        const confirmed = await tx.payrollPayout.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: access.tenantId, id: payoutId } },
        });
        const settled = await settlePayout(tx, this.labourCrypto, confirmed, access.userId);
        await this.commands.audit(scope, "payroll.manual_payment_confirmed", payoutId, {
          batchId: payout.batchId,
          obligationId: payout.obligationId,
          method: payout.method,
          settled,
        });
        return this.response(scope, payoutId);
      },
      { mapError: rethrowPayoutDbError },
    );
  }

  reject(principal: Principal, req: Request, payoutId: string, input: RejectManualPaymentRequest) {
    return this.commands.run(
      principal,
      req,
      "payroll.manual_payment.reject",
      { payoutId, input },
      async (scope): Promise<ManualPaymentResponse> => {
        const { tx, access } = scope;
        const payout = await this.pending(scope, payoutId, "rejectManualPayment", input.version);
        const updated = await tx.payrollPayout.updateMany({
          where: {
            tenantId: access.tenantId,
            id: payoutId,
            version: payout.version,
            status: "pending_confirmation",
          },
          data: {
            status: "rejected",
            rejectedBy: access.userId,
            rejectionReason: input.reason,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw payoutVersionConflict();
        await refreshBatchStatus(tx, access.tenantId, payout.batchId);
        await this.commands.audit(scope, "payroll.manual_payment_rejected", payoutId, {
          batchId: payout.batchId,
          obligationId: payout.obligationId,
          method: payout.method,
          reasonGiven: true,
        });
        return this.response(scope, payoutId);
      },
      { mapError: rethrowPayoutDbError },
    );
  }

  // Evidence -------------------------------------------------------------------------------------

  /**
   * Adds a photo or signature image to a cash or bank payment awaiting confirmation (JPEG, PNG or
   * WebP, content sniffed, malware hook, private storage; at most three).
   */
  async addEvidence(
    principal: Principal,
    req: Request,
    payoutId: string,
    file: UploadedEvidence | undefined,
  ): Promise<PaymentEvidenceResponse> {
    if (!file?.buffer?.length)
      throw new BadRequestException({ code: "file-required", message: "Attach the photo as `file`" });
    const authorise = async (scope: Scope) => {
      const payout = await this.payout(scope.tx, scope.access.tenantId, payoutId);
      await this.access.require(scope, "addPaymentEvidence", payout.projectId);
      if (payout.method === "mpesa" || payout.status !== "pending_confirmation")
        throw payoutConflict(
          "invalid-transition",
          "Evidence is added to a cash or bank payment awaiting confirmation.",
        );
      const count = await scope.tx.payrollPayoutEvidence.count({
        where: { tenantId: scope.access.tenantId, payoutId },
      });
      if (count >= MANUAL_PAYMENT_LIMITS.evidencePerPayment)
        throw payoutConflict("evidence-limit", "A payment keeps at most three evidence images.");
      return payout.projectId;
    };
    const projectId = await this.commands.read(principal, req, authorise);
    const contentType = sniffDocument(file.buffer);
    if (
      !contentType ||
      !(MANUAL_PAYMENT_LIMITS.evidenceContentTypes as readonly string[]).includes(contentType)
    )
      throw payoutProblem(415, "payout-rule", "Evidence must be a JPEG, PNG or WebP image");
    if (file.buffer.length > MANUAL_PAYMENT_LIMITS.evidenceMaxBytes)
      throw new PayloadTooLargeException({
        message: "The photo is too large",
        code: "payload-too-large",
      });
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    let scan;
    try {
      scan = await this.scanner.scan(file.buffer, { sha256 });
    } catch (error) {
      if (error instanceof MalwareDetected)
        throw payoutProblem(422, "payout-rule", "The file was refused by the malware scanner");
      throw error;
    }
    const evidenceId = uuidv7();
    const tenantId = principal.session.activeTenantId!;
    const objectKey = `tenants/${tenantId}/projects/${projectId}/payroll/payout-evidence/${evidenceId}`;
    await this.storage.put(objectKey, file.buffer, contentType, sha256);
    try {
      return await this.commands.run(
        principal,
        req,
        "payroll.manual_payment.evidence",
        { payoutId, evidenceId },
        async (scope) => {
          await authorise(scope);
          const row = await scope.tx.payrollPayoutEvidence.create({
            data: {
              id: evidenceId,
              tenantId: scope.access.tenantId,
              projectId,
              payoutId,
              objectKey,
              contentType,
              sizeBytes: file.buffer.length,
              sha256,
              scanStatus: scan.status,
              scanEngine: scan.engine,
              scannedAt: scan.scannedAt,
              uploadedBy: scope.access.userId,
            },
          });
          await this.commands.audit(scope, "payroll.payment_evidence_added", payoutId, {
            evidenceId,
            contentType,
            sizeBytes: file.buffer.length,
            scan: scan.status,
          });
          return paymentEvidenceResponseSchema.parse({
            evidence: toEvidence(row, await displayNames(scope.tx, [row.uploadedBy])),
          });
        },
        { mapError: rethrowPayoutDbError },
      );
    } catch (error) {
      await this.storage
        .delete(objectKey)
        .catch((cleanup: unknown) =>
          this.logger.warn(`Could not remove orphaned payment evidence: ${describeError(cleanup)}`),
        );
      throw error;
    }
  }

  /** Downloads an evidence image (whoever may view the batch's payouts). */
  async evidence(principal: Principal, req: Request, evidenceId: string) {
    const row = await this.commands.read(principal, req, async (scope) => {
      const evidence = await scope.tx.payrollPayoutEvidence.findUnique({
        where: { tenantId_id: { tenantId: scope.access.tenantId, id: evidenceId } },
      });
      if (!evidence) throw notFound("Evidence");
      await this.access.require(scope, "viewPayouts", evidence.projectId);
      return evidence;
    });
    const content = await this.storage.get(row.objectKey, MANUAL_PAYMENT_LIMITS.evidenceMaxBytes);
    if (createHash("sha256").update(content).digest("hex") !== row.sha256)
      throw payoutConflict("payout-rule", "The stored file does not match its checksum");
    return {
      content,
      contentType: row.contentType,
      fileName: `payment-evidence-${row.id}.${row.contentType.split("/")[1]}`,
    };
  }

  // Helpers --------------------------------------------------------------------------------------

  private async payout(tx: Tx, tenantId: string, payoutId: string): Promise<PayrollPayout> {
    const row = await tx.payrollPayout.findUnique({
      where: { tenantId_id: { tenantId, id: payoutId } },
    });
    if (!row) throw notFound("Payment");
    return row;
  }

  /** A cash or bank payment awaiting confirmation, decided by someone other than its recorder. */
  private async pending(
    scope: Scope,
    payoutId: string,
    action: "confirmManualPayment" | "rejectManualPayment",
    version: number,
  ): Promise<PayrollPayout> {
    const { tx, access } = scope;
    const head = await this.payout(tx, access.tenantId, payoutId);
    await this.access.require(scope, action, head.projectId);
    await lockBatch(tx, access.tenantId, head.batchId);
    const payout = await this.payout(tx, access.tenantId, payoutId);
    if (payout.method === "mpesa")
      throw payoutConflict("invalid-transition", "M-Pesa payouts are confirmed by M-Pesa.");
    if (payout.version !== version) throw payoutVersionConflict();
    if (payout.status !== "pending_confirmation")
      throw payoutConflict("invalid-transition", "This payment was already decided.");
    if (payout.createdBy === access.userId)
      throw makerChecker("Someone other than the person who recorded the payment decides it.");
    return payout;
  }

  /** Cash recorded to the worker (pending and confirmed) for batches of the same pay period. */
  private async cashUsed(
    tx: Tx,
    tenantId: string,
    labourerId: string,
    period: { periodStart: Date; periodEnd: Date },
  ): Promise<number> {
    const batches = await tx.payrollBatch.findMany({
      where: { tenantId, periodStart: period.periodStart, periodEnd: period.periodEnd },
      select: { id: true },
    });
    const sum = await tx.payrollPayout.aggregate({
      where: {
        tenantId,
        labourerId,
        method: "cash",
        status: { in: ["pending_confirmation", "confirmed"] },
        batchId: { in: batches.map((row) => row.id) },
      },
      _sum: { amountMinor: true },
    });
    return minor(sum._sum.amountMinor ?? 0n);
  }

  private async response(scope: Scope, payoutId: string): Promise<ManualPaymentResponse> {
    const { tx, access } = scope;
    const payout = await this.payout(tx, access.tenantId, payoutId);
    const obligation = await obligationOf(tx, access.tenantId, payout.obligationId);
    const ctx = await loadObligationContext(tx, access.tenantId, [obligation]);
    const entry = ctx.payouts.find((row) => row.payout.id === payoutId)!;
    const receiverNames = await this.access.allows(scope, "viewReceiverName", payout.projectId);
    return manualPaymentResponseSchema.parse({
      payout: toPayout(entry, ctx.evidence, ctx.names, null),
      obligation: obligationView(ctx, obligation, this.labourCrypto, receiverNames),
    });
  }
}
