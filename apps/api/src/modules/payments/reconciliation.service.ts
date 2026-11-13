import { Injectable } from "@nestjs/common";
import { verifySettlement } from "@pm-buddy/domain";
import type {
  PaymentsOverviewResponse,
  ResolveCaseRequest,
  ReviewCallbackRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import type { PaymentCallbackInbox, PaymentCase, Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import { AuthService, type Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { PaymentCommands } from "./payment-commands.js";
import { PaymentLedger } from "./payment-ledger.js";
import {
  balanceToWire,
  callbackToWire,
  caseToWire,
  eventToWire,
  transactionToWire,
} from "./payments-mappers.js";
import {
  holds,
  minor,
  notFound,
  paymentConflict,
  requireStepUp,
  versionConflict,
} from "./payments-support.js";

type Tx = Prisma.TransactionClient;

/**
 * Reconciliation (brief §15 D, OPERATIONS "Payment reconciliation"): unknown outcomes, quarantined
 * callbacks, conflicting evidence and unverified successes, each with an owner, age, evidence and
 * append-only history. Reviewers (payments.review, fresh step-up) must not be the person who
 * created the payment. A manual confirmation needs the M-Pesa receipt and the exact amount from the
 * statement; nothing here can regress a final outcome.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly commands: PaymentCommands,
    private readonly policy: AccessPolicy,
    private readonly auth: AuthService,
    private readonly ledger: PaymentLedger,
  ) {}

  overview(principal: Principal, req: Request): Promise<PaymentsOverviewResponse> {
    return this.commands.read(principal, req, async (scope) => {
      await this.policy.require(scope, "payments.view");
      const { tx, access } = scope;
      const tenantId = access.tenantId;
      const settings = await tx.paymentSettings.findUnique({ where: { tenantId } });
      const count = (status: string) => tx.paymentRequest.count({ where: { tenantId, status } });
      const [inProgress, uncertain, confirmed, failed, openCases, quarantined, received, pendingOutbox] =
        await Promise.all([
          count("in_progress"),
          count("uncertain"),
          count("confirmed"),
          count("failed"),
          tx.paymentCase.count({ where: { tenantId, status: "open" } }),
          tx.paymentCallbackInbox.count({ where: { tenantId, status: "quarantined" } }),
          tx.paymentCallbackInbox.count({ where: { tenantId, status: "received" } }),
          tx.paymentOutbox.count({ where: { tenantId, processedAt: null, deadAt: null } }),
        ]);
      const oldest = await tx.paymentAttempt.findFirst({
        where: { tenantId, status: { in: ["unknown", "submitting"] } },
        orderBy: { updatedAt: "asc" },
      });
      const balance = await tx.providerQuery.findFirst({
        where: { tenantId, kind: "account_balance" },
        orderBy: { createdAt: "desc" },
      });
      const receipts = await tx.providerTransaction.findMany({
        where: { tenantId },
        orderBy: { recordedAt: "desc" },
        take: 10,
      });
      return {
        configured: Boolean(settings),
        environment: (settings?.environment as PaymentsOverviewResponse["environment"]) ?? null,
        payoutsEnabled: settings?.payoutsEnabled ?? false,
        counts: {
          inProgress,
          uncertain,
          confirmed,
          failed,
          openCases,
          quarantinedCallbacks: quarantined,
          receivedCallbacks: received,
          pendingOutbox,
        },
        oldestUncertainAt: oldest?.updatedAt.toISOString() ?? null,
        latestBalance: balance ? balanceToWire(balance) : null,
        receipts: receipts.map(transactionToWire),
        permissions: {
          view: true,
          review: await holds(this.policy, scope, "payments.review"),
          manageCredentials: await holds(this.policy, scope, "payments.manage_credentials"),
          initiateTest: await holds(this.policy, scope, "payments.initiate_test"),
          reverse: await holds(this.policy, scope, "payments.reverse"),
        },
      };
    });
  }

  /** The person who created the payment cannot review its reconciliation (maker-checker). */
  private async creatorOf(tx: Tx, tenantId: string, item: { requestId: string | null; attemptId: string | null }) {
    let requestId = item.requestId;
    if (!requestId && item.attemptId) {
      const attempt = await tx.paymentAttempt.findUnique({ where: { tenantId_id: { tenantId, id: item.attemptId } } });
      requestId = attempt?.requestId ?? null;
    }
    if (!requestId) return null;
    const request = await tx.paymentRequest.findUnique({ where: { tenantId_id: { tenantId, id: requestId } } });
    return request?.createdBy ?? null;
  }

  private async casesToWire(scope: Scope, rows: PaymentCase[]) {
    const { tx, access } = scope;
    const attemptIds = rows.map((row) => row.attemptId).filter((id): id is string => Boolean(id));
    const attempts = await tx.paymentAttempt.findMany({ where: { tenantId: access.tenantId, id: { in: attemptIds } } });
    const requests = await tx.paymentRequest.findMany({
      where: { tenantId: access.tenantId, id: { in: attempts.map((attempt) => attempt.requestId) } },
      select: { id: true, createdBy: true },
    });
    const creators = new Map(requests.map((request) => [request.id, request.createdBy]));
    const byId = new Map(attempts.map((attempt) => [attempt.id, attempt]));
    const names = await displayNames(tx, rows.map((row) => row.resolvedBy));
    const canReview = await holds(this.policy, scope, "payments.review");
    return rows.map((row) => {
      const attempt = row.attemptId ? (byId.get(row.attemptId) ?? null) : null;
      const creator = attempt ? creators.get(attempt.requestId) : null;
      return caseToWire(row, attempt, names, canReview && creator !== access.userId);
    });
  }

  listCases(principal: Principal, req: Request, query: { status?: string | undefined; limit: number; offset: number }) {
    return this.commands.read(principal, req, async (scope) => {
      await this.policy.require(scope, "payments.view");
      const { tx, access } = scope;
      const where: Prisma.PaymentCaseWhereInput = {
        tenantId: access.tenantId,
        ...(query.status ? { status: query.status } : {}),
      };
      const [rows, total, open] = await Promise.all([
        tx.paymentCase.findMany({ where, orderBy: { openedAt: "desc" }, take: query.limit, skip: query.offset }),
        tx.paymentCase.count({ where }),
        tx.paymentCase.count({ where: { tenantId: access.tenantId, status: "open" } }),
      ]);
      return { cases: await this.casesToWire(scope, rows), total, open };
    });
  }

  private async caseDetail(scope: Scope, caseId: string) {
    const { tx, access } = scope;
    const row = await tx.paymentCase.findUnique({ where: { tenantId_id: { tenantId: access.tenantId, id: caseId } } });
    if (!row) throw notFound("Reconciliation case");
    const events = await tx.paymentEvent.findMany({
      where: {
        tenantId: access.tenantId,
        subjectId: { in: [row.id, ...(row.attemptId ? [row.attemptId] : []), ...(row.callbackId ? [row.callbackId] : [])] },
      },
      orderBy: { createdAt: "asc" },
      take: 300,
    });
    const names = await displayNames(tx, events.map((event) => event.actorId));
    const [wire] = await this.casesToWire(scope, [row]);
    return { case: wire!, timeline: events.map((event) => eventToWire(event, names)) };
  }

  getCase(principal: Principal, req: Request, caseId: string) {
    return this.commands.read(principal, req, async (scope) => {
      await this.policy.require(scope, "payments.view");
      return this.caseDetail(scope, caseId);
    });
  }

  private async review(scope: Scope, item: { requestId: string | null; attemptId: string | null }) {
    await this.policy.require(scope, "payments.review");
    requireStepUp(this.auth, scope.principal);
    const creator = await this.creatorOf(scope.tx, scope.access.tenantId, item);
    if (creator && creator === scope.access.userId)
      throw paymentConflict("same-person", "Someone other than the person who created the payment must review it.");
  }

  private async closeCallback(tx: Tx, callback: PaymentCallbackInbox, decision: "resolved" | "dismissed", reason: string, userId: string) {
    if (callback.status !== "quarantined") return;
    await tx.paymentCallbackInbox.update({
      where: { tenantId_id: { tenantId: callback.tenantId, id: callback.id } },
      data: { status: decision, reviewDecision: decision, reviewReason: reason, reviewedBy: userId, version: callback.version + 1 },
    });
    await this.ledger.event(tx, callback.tenantId, {
      subjectType: "callback",
      subjectId: callback.id,
      event: `callback.${decision}`,
      fromStatus: "quarantined",
      toStatus: decision,
      actorId: userId,
    });
    await this.ledger.audit(tx, `payments.callback_${decision}`, callback.id, { kind: callback.kind });
  }

  resolveCase(principal: Principal, req: Request, caseId: string, input: ResolveCaseRequest) {
    return this.commands.run(principal, req, "payments.case.resolve", { caseId, ...input }, async (scope) => {
      const { tx, access } = scope;
      const row = await tx.paymentCase.findUnique({ where: { tenantId_id: { tenantId: access.tenantId, id: caseId } } });
      if (!row) throw notFound("Reconciliation case");
      await this.review(scope, row);
      if (row.status !== "open") throw paymentConflict("case-closed", "This case is already closed.");
      if (row.version !== input.version) throw versionConflict();
      const userId = access.userId;
      if (row.kind === "unknown_outcome" || row.kind === "unverified_success") {
        const attempt = row.attemptId
          ? await tx.paymentAttempt.findUnique({ where: { tenantId_id: { tenantId: access.tenantId, id: row.attemptId } } })
          : null;
        if (!attempt) throw notFound("Payment attempt");
        const uncertain = attempt.status === "unknown" || attempt.status === "pending";
        if (input.resolution === "confirmed" || input.resolution === "failed") {
          if (!uncertain)
            throw paymentConflict("invalid-transition", "The payment's outcome is already final.");
          if (input.resolution === "confirmed") {
            const verified = verifySettlement(
              { amountMinor: input.amountMinor ?? null, currency: null, receipt: input.receipt ?? null, shortcode: null },
              { amountMinor: minor(attempt.amountMinor), currency: "KES", shortcode: null },
            );
            const taken = await tx.providerTransaction.findUnique({
              where: { tenantId_receipt: { tenantId: access.tenantId, receipt: input.receipt! } },
            });
            if (!verified.ok || taken)
              throw paymentConflict(
                "evidence-mismatch",
                "The receipt and amount must match this payment exactly and not belong to another one.",
              );
          }
          await this.ledger.closeCase(tx, access.tenantId, row.id, row.version, input.resolution, input.reason, userId);
          const moved =
            input.resolution === "confirmed"
              ? await this.ledger.confirm(
                  tx,
                  attempt,
                  { receipt: input.receipt!, resultCode: null, resultDesc: "Confirmed from statement evidence", callbackId: null, completedAtRaw: null },
                  "manual_confirmation",
                  userId,
                )
              : await this.ledger.fail(tx, attempt, { resultCode: null, resultDesc: "Failed after evidence review" }, "manual_failure", userId);
          if (!moved) throw versionConflict();
        } else {
          if (uncertain)
            throw paymentConflict(
              "uncertain-attempt",
              "An uncertain payment needs a confirmed or failed outcome, not a dismissal.",
            );
          await this.ledger.closeCase(tx, access.tenantId, row.id, row.version, input.resolution, input.reason, userId);
        }
      } else {
        if (input.resolution !== "no_payment_effect" && input.resolution !== "dismissed")
          throw paymentConflict(
            "invalid-transition",
            "A callback or dispute case is closed with a finding; it never changes the payment's outcome.",
          );
        await this.ledger.closeCase(tx, access.tenantId, row.id, row.version, input.resolution, input.reason, userId);
        if (row.callbackId) {
          const callback = await tx.paymentCallbackInbox.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: row.callbackId } },
          });
          if (callback)
            await this.closeCallback(tx, callback, input.resolution === "dismissed" ? "dismissed" : "resolved", input.reason, userId);
        }
      }
      return this.caseDetail(scope, caseId);
    });
  }

  listCallbacks(
    principal: Principal,
    req: Request,
    query: { status?: string | undefined; kind?: string | undefined; limit: number; offset: number },
  ) {
    return this.commands.read(principal, req, async (scope) => {
      await this.policy.require(scope, "payments.view");
      const { tx, access } = scope;
      const where: Prisma.PaymentCallbackInboxWhereInput = {
        tenantId: access.tenantId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
      };
      const [rows, total, openAlerts] = await Promise.all([
        tx.paymentCallbackInbox.findMany({ where, orderBy: { receivedAt: "desc" }, take: query.limit, skip: query.offset }),
        tx.paymentCallbackInbox.count({ where }),
        tx.paymentCallbackInbox.count({ where: { tenantId: access.tenantId, status: "quarantined" } }),
      ]);
      const requests = await this.requestsOf(tx, access.tenantId, rows);
      const names = await displayNames(tx, rows.map((row) => row.reviewedBy));
      return {
        callbacks: rows.map((row) => callbackToWire(row, row.attemptId ? (requests.get(row.attemptId) ?? null) : null, names)),
        total,
        openAlerts,
      };
    });
  }

  private async requestsOf(tx: Tx, tenantId: string, rows: PaymentCallbackInbox[]) {
    const ids = rows.map((row) => row.attemptId).filter((id): id is string => Boolean(id));
    const attempts = await tx.paymentAttempt.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, requestId: true } });
    return new Map(attempts.map((attempt) => [attempt.id, attempt.requestId]));
  }

  private async callbackDetail(scope: Scope, callbackId: string) {
    const { tx, access } = scope;
    const row = await tx.paymentCallbackInbox.findUnique({ where: { tenantId_id: { tenantId: access.tenantId, id: callbackId } } });
    if (!row) throw notFound("Callback");
    const requests = await this.requestsOf(tx, access.tenantId, [row]);
    const names = await displayNames(tx, [row.reviewedBy]);
    const requestId = row.attemptId ? (requests.get(row.attemptId) ?? null) : null;
    const creator = await this.creatorOf(tx, access.tenantId, { requestId, attemptId: row.attemptId });
    const canReview =
      row.status === "quarantined" &&
      (await holds(this.policy, scope, "payments.review")) &&
      creator !== access.userId;
    return { callback: callbackToWire(row, requestId, names), canReview };
  }

  getCallback(principal: Principal, req: Request, callbackId: string) {
    return this.commands.read(principal, req, async (scope) => {
      await this.policy.require(scope, "payments.view");
      return this.callbackDetail(scope, callbackId);
    });
  }

  /** Resolve or dismiss a quarantined callback with a reason; its open case closes with it. */
  reviewCallback(principal: Principal, req: Request, callbackId: string, input: ReviewCallbackRequest) {
    return this.commands.run(principal, req, "payments.callback.review", { callbackId, ...input }, async (scope) => {
      const { tx, access } = scope;
      const row = await tx.paymentCallbackInbox.findUnique({ where: { tenantId_id: { tenantId: access.tenantId, id: callbackId } } });
      if (!row) throw notFound("Callback");
      await this.review(scope, { requestId: null, attemptId: row.attemptId });
      if (row.status !== "quarantined")
        throw paymentConflict("callback-not-reviewable", "Only quarantined callbacks are reviewed.");
      if (row.version !== input.version) throw versionConflict();
      await this.closeCallback(tx, row, input.decision, input.reason, access.userId);
      const open = await tx.paymentCase.findMany({ where: { tenantId: access.tenantId, callbackId, status: "open" } });
      for (const item of open)
        await this.ledger.closeCase(
          tx,
          access.tenantId,
          item.id,
          item.version,
          input.decision === "dismissed" ? "dismissed" : "no_payment_effect",
          input.reason,
          access.userId,
        );
      return this.callbackDetail(scope, callbackId);
    });
  }
}
