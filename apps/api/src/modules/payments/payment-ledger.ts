import { Injectable } from "@nestjs/common";
import { assertAttemptTransition } from "@pm-buddy/domain";
import type {
  PaymentAttemptStatus,
  PaymentPurpose,
  PaymentReasonCode,
  ProviderTransactionKind,
  ReconciliationCaseKind,
  ReconciliationResolution,
} from "@pm-buddy/types";
import { uuidv7 } from "../../common/uuid.js";
import type { PaymentAttempt, Prisma } from "../../generated/prisma/client.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { PaymentOutcomeHandlers } from "./outcome-handlers.js";
import { PaymentsRuntime } from "./payments-runtime.js";
import { minor } from "./payments-support.js";

type Tx = Prisma.TransactionClient;
export type OutboxTopic =
  | "attempt.submit"
  | "attempt.status_query"
  | "callback.process"
  | "balance.query"
  | "c2b.register";

/** Settlement evidence from a verified callback, a status answer or a reviewed statement entry. */
export type SettlementEvidence = {
  receipt: string;
  resultCode: string | null;
  resultDesc: string | null;
  callbackId: string | null;
  completedAtRaw: string | null;
};

const TRANSACTION_KIND: Record<string, ProviderTransactionKind> = {
  stk_push: "stk",
  b2c: "b2c",
  b2b_paybill: "b2b",
  b2b_buygoods: "b2b",
  reversal: "reversal",
};

/**
 * The single place attempts change state (WORKFLOWS "Payment attempts"): compare-and-swap on the
 * expected status and version, the timeline event, the redacted audit event, reconciliation cases,
 * provider receipts, outbox work and the purpose's outcome handler, all in the caller's company
 * transaction. The database guard enforces the same edges and write-once evidence.
 */
@Injectable()
export class PaymentLedger {
  constructor(
    private readonly scope: TenantScope,
    private readonly runtime: PaymentsRuntime,
    private readonly outcomes: PaymentOutcomeHandlers,
  ) {}

  audit(tx: Tx, action: string, resourceId: string, metadata: Prisma.InputJsonValue = {}) {
    return this.scope.audit(tx, action, resourceId, metadata);
  }

  event(
    tx: Tx,
    tenantId: string,
    entry: {
      subjectType: "request" | "attempt" | "callback" | "case" | "settings" | "query";
      subjectId: string;
      requestId?: string | null;
      event: string;
      fromStatus?: string | null;
      toStatus?: string | null;
      reason?: string | null;
      actorId: string | null;
      detail?: Record<string, string | number | boolean | null>;
    },
  ) {
    return tx.paymentEvent.create({
      data: {
        id: uuidv7(),
        tenantId,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        requestId: entry.requestId ?? null,
        event: entry.event,
        fromStatus: entry.fromStatus ?? null,
        toStatus: entry.toStatus ?? null,
        reason: entry.reason ?? null,
        actorId: entry.actorId,
        detail: entry.detail ?? {},
      },
    });
  }

  /** Durable work for the relay; at most one pending row per topic and subject. */
  async enqueue(tx: Tx, tenantId: string, topic: OutboxTopic, refId: string, availableAt = new Date()) {
    await tx.paymentOutbox.createMany({
      data: [{ id: uuidv7(), tenantId, topic, refId, availableAt }],
      skipDuplicates: true,
    });
  }

  /**
   * Moves an attempt with compare-and-swap; returns the updated row, or null when another worker
   * or callback changed it first (the caller re-reads and decides again).
   */
  async transition(
    tx: Tx,
    attempt: PaymentAttempt,
    to: PaymentAttemptStatus,
    reason: PaymentReasonCode,
    actorId: string | null,
    patch: Prisma.PaymentAttemptUpdateManyMutationInput = {},
    detail: Record<string, string | number | boolean | null> = {},
  ): Promise<PaymentAttempt | null> {
    const from = attempt.status as PaymentAttemptStatus;
    assertAttemptTransition(from, to);
    const updated = await tx.paymentAttempt.updateMany({
      where: { tenantId: attempt.tenantId, id: attempt.id, status: from, version: attempt.version },
      data: { ...patch, status: to, reason, version: attempt.version + 1 },
    });
    if (updated.count === 0) return null;
    await this.event(tx, attempt.tenantId, {
      subjectType: "attempt",
      subjectId: attempt.id,
      requestId: attempt.requestId,
      event: `attempt.${to}`,
      fromStatus: from,
      toStatus: to,
      reason,
      actorId,
      detail,
    });
    await this.audit(tx, `payments.attempt_${to}`, attempt.id, {
      requestId: attempt.requestId,
      kind: attempt.kind,
      from,
      to,
      reason,
    });
    return tx.paymentAttempt.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: attempt.tenantId, id: attempt.id } },
    });
  }

  /** Opens a reconciliation case unless the same one is already open. */
  async openCase(
    tx: Tx,
    tenantId: string,
    kind: ReconciliationCaseKind,
    reason: string,
    link: { requestId?: string | null; attemptId?: string | null; callbackId?: string | null },
    actorId: string | null,
  ) {
    const existing = link.attemptId
      ? await tx.paymentCase.findFirst({
          where: { tenantId, status: "open", attemptId: link.attemptId, kind },
        })
      : link.callbackId
        ? await tx.paymentCase.findFirst({
            where: { tenantId, status: "open", callbackId: link.callbackId },
          })
        : null;
    if (existing) return existing;
    const created = await tx.paymentCase.create({
      data: {
        id: uuidv7(),
        tenantId,
        kind,
        reason,
        requestId: link.requestId ?? null,
        attemptId: link.attemptId ?? null,
        callbackId: link.callbackId ?? null,
      },
    });
    await this.event(tx, tenantId, {
      subjectType: "case",
      subjectId: created.id,
      requestId: link.requestId ?? null,
      event: "case.opened",
      toStatus: "open",
      reason,
      actorId,
      detail: { kind },
    });
    await this.audit(tx, "payments.case_opened", created.id, {
      kind,
      reason,
      attemptId: link.attemptId ?? null,
      callbackId: link.callbackId ?? null,
    });
    return created;
  }

  /** Closes a case (system or reviewer); the case guard allows exactly one close. */
  async closeCase(
    tx: Tx,
    tenantId: string,
    caseId: string,
    version: number,
    resolution: ReconciliationResolution,
    note: string | null,
    actorId: string | null,
  ) {
    const updated = await tx.paymentCase.updateMany({
      where: { tenantId, id: caseId, status: "open", version },
      data: {
        status: resolution === "dismissed" ? "dismissed" : "resolved",
        resolution,
        resolutionNote: note,
        resolvedBy: actorId,
        version: version + 1,
      },
    });
    if (updated.count === 0) return false;
    const row = await tx.paymentCase.findUniqueOrThrow({ where: { tenantId_id: { tenantId, id: caseId } } });
    await this.event(tx, tenantId, {
      subjectType: "case",
      subjectId: caseId,
      requestId: row.requestId,
      event: "case.closed",
      fromStatus: "open",
      toStatus: row.status,
      reason: resolution,
      actorId,
    });
    await this.audit(tx, "payments.case_closed", caseId, { kind: row.kind, resolution });
    return true;
  }

  /** Closes the attempt's open outcome cases once its outcome is known. */
  async resolveAttemptCases(
    tx: Tx,
    attempt: PaymentAttempt,
    resolution: ReconciliationResolution,
    actorId: string | null,
    note: string | null = null,
  ) {
    const open = await tx.paymentCase.findMany({
      where: {
        tenantId: attempt.tenantId,
        attemptId: attempt.id,
        status: "open",
        kind: { in: ["unknown_outcome", "unverified_success"] },
      },
    });
    for (const row of open)
      await this.closeCase(tx, attempt.tenantId, row.id, row.version, resolution, note, actorId);
  }

  /** Marks an uncertain outcome, opens its case and schedules the first status query. */
  async markUnknown(
    tx: Tx,
    attempt: PaymentAttempt,
    reason: PaymentReasonCode,
    actorId: string | null,
    patch: Prisma.PaymentAttemptUpdateManyMutationInput = {},
  ): Promise<PaymentAttempt | null> {
    const nextQuery = new Date(Date.now() + this.runtime.statusQueryIntervalSeconds * 1000);
    const moved = await this.transition(tx, attempt, "unknown", reason, actorId, {
      ...patch,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextStatusQueryAt: this.statusQuerySupported(attempt) ? nextQuery : null,
    });
    if (!moved) return null;
    await this.openCase(
      tx,
      moved.tenantId,
      "unknown_outcome",
      reason,
      { requestId: moved.requestId, attemptId: moved.id },
      actorId,
    );
    if (this.statusQuerySupported(moved) && this.runtime.statusQueryMax > 0)
      await this.enqueue(tx, moved.tenantId, "attempt.status_query", moved.id, nextQuery);
    return moved;
  }

  /**
   * Whether a status query can identify the attempt: B2C always (PM-Buddy chose the
   * OriginatorConversationID before the call); STK, B2B and reversals only once the provider's
   * acknowledgement gave their identifiers. Otherwise reconciliation needs the M-Pesa statement.
   */
  statusQuerySupported(attempt: PaymentAttempt): boolean {
    if (attempt.kind === "stk_push") return Boolean(attempt.checkoutRequestId);
    return Boolean(attempt.originatorConversationId || attempt.receipt);
  }

  private async request(tx: Tx, attempt: PaymentAttempt) {
    return tx.paymentRequest.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: attempt.tenantId, id: attempt.requestId } },
    });
  }

  /**
   * pending/unknown → confirmed on verified evidence (an attempt still `submitting` first becomes
   * unknown: a result before the acknowledgement goes through reconciliation). Records the
   * receipt (unique per company), closes the outcome cases, completes a reversal and runs the
   * purpose's outcome handler, all in this transaction.
   */
  async confirm(
    tx: Tx,
    attempt: PaymentAttempt,
    evidence: SettlementEvidence,
    reason: PaymentReasonCode,
    actorId: string | null,
  ): Promise<PaymentAttempt | null> {
    let current: PaymentAttempt | null = attempt;
    if (current.status === "submitting") {
      current = await this.markUnknown(tx, current, "result_before_acceptance", actorId);
      if (!current) return null;
    }
    const confirmed = await this.transition(
      tx,
      current,
      "confirmed",
      reason,
      actorId,
      {
        receipt: evidence.receipt,
        resultCode: evidence.resultCode,
        resultDesc: evidence.resultDesc,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextStatusQueryAt: null,
      },
      { receipt: evidence.receipt },
    );
    if (!confirmed) return null;
    const request = await this.request(tx, confirmed);
    await tx.providerTransaction.create({
      data: {
        id: uuidv7(),
        tenantId: confirmed.tenantId,
        kind: TRANSACTION_KIND[confirmed.kind]!,
        direction: confirmed.direction,
        status: "matched",
        receipt: evidence.receipt,
        amountMinor: confirmed.amountMinor,
        shortcode: confirmed.shortcode,
        accountReference: request.accountReference,
        attemptId: confirmed.id,
        callbackId: evidence.callbackId,
        completedAtRaw: evidence.completedAtRaw,
      },
    });
    await this.resolveAttemptCases(tx, confirmed, "confirmed", actorId);
    if (confirmed.kind === "reversal" && confirmed.reversesAttemptId) {
      const original = await tx.paymentAttempt.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: confirmed.tenantId, id: confirmed.reversesAttemptId } },
      });
      if (original.status === "reversal_pending") {
        await this.transition(tx, original, "reversed", "reversal_confirmed", actorId, {}, {
          reversalAttemptId: confirmed.id,
        });
        await this.dispatch(tx, original, request.purpose, request.purposeRef, "reversed", original.receipt);
      }
    } else {
      await this.dispatch(tx, confirmed, request.purpose, request.purposeRef, "confirmed", evidence.receipt);
    }
    return confirmed;
  }

  /** submitting/pending/unknown → failed on definitive non-settlement evidence (never a timeout). */
  async fail(
    tx: Tx,
    attempt: PaymentAttempt,
    evidence: { resultCode: string | null; resultDesc: string | null; providerCode?: string | null },
    reason: PaymentReasonCode,
    actorId: string | null,
  ): Promise<PaymentAttempt | null> {
    const failed = await this.transition(tx, attempt, "failed", reason, actorId, {
      resultCode: evidence.resultCode,
      resultDesc: evidence.resultDesc,
      providerCode: evidence.providerCode ?? null,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextStatusQueryAt: null,
    });
    if (!failed) return null;
    await this.resolveAttemptCases(tx, failed, "failed", actorId);
    const request = await this.request(tx, failed);
    if (failed.kind === "reversal" && failed.reversesAttemptId) {
      const original = await tx.paymentAttempt.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: failed.tenantId, id: failed.reversesAttemptId } },
      });
      if (original.status === "reversal_pending")
        await this.transition(tx, original, "confirmed", "reversal_rejected", actorId, {}, {
          reversalAttemptId: failed.id,
        });
    } else {
      await this.dispatch(tx, failed, request.purpose, request.purposeRef, "failed", null);
    }
    return failed;
  }

  private dispatch(
    tx: Tx,
    attempt: PaymentAttempt,
    purpose: string,
    purposeRef: string | null,
    outcome: "confirmed" | "failed" | "reversed",
    receipt: string | null,
  ) {
    return this.outcomes.dispatch(tx, {
      tenantId: attempt.tenantId,
      requestId: attempt.requestId,
      attemptId: attempt.id,
      purpose: purpose as PaymentPurpose,
      purposeRef,
      outcome,
      amountMinor: minor(attempt.amountMinor),
      receipt,
    });
  }
}
