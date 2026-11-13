import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  classifySubmission,
  interpretStkQuery,
  interpretTransactionStatus,
  isFinalOutcome,
  verifyCallback,
  verifySettlement,
  type CallbackIdentifiers,
  type ParsedCallback,
  type SubmissionTransport,
} from "@pm-buddy/domain";
import type {
  CallbackKind,
  PaymentAttemptKind,
  PaymentAttemptStatus,
  PaymentDirection,
  QuarantineReason,
} from "@pm-buddy/types";
import type { PaymentAttempt, PaymentCallbackInbox, Prisma } from "../../generated/prisma/client.js";
import { TenantDatabase } from "../identity/tenant-database.service.js";
import { PaymentAccounts } from "./payment-accounts.js";
import { PaymentLedger, type OutboxTopic } from "./payment-ledger.js";
import { PaymentsCrypto } from "./payments-crypto.js";
import { PaymentsRuntime } from "./payments-runtime.js";
import { minor, PAYMENTS_SYSTEM_ACTOR } from "./payments-support.js";
import {
  PAYMENT_PROVIDER,
  ProviderNotReady,
  type AttemptInstruction,
  type OutgoingCall,
  type PaymentProvider,
  type ProviderAccount,
} from "./provider/payment-provider.js";

type Tx = Prisma.TransactionClient;
const SYSTEM = null;

/** Work that cannot run yet; the outbox row is rescheduled (`counts` toward dead-lettering). */
export class RetryLater extends Error {
  constructor(
    readonly code: string,
    readonly delayMs: number | null = null,
    readonly counts = true,
  ) {
    super(code);
    this.name = "RetryLater";
  }
}

const CALLBACK_FOR_KIND: Record<PaymentAttemptKind, readonly CallbackKind[]> = {
  stk_push: ["stk"],
  b2c: ["b2c_result", "timeout"],
  b2b_paybill: ["b2b_result", "timeout"],
  b2b_buygoods: ["b2b_result", "timeout"],
  reversal: ["reversal_result", "timeout"],
};
const TOKEN_ERRORS = new Set(["400.003.01", "404.001.03", "401.002.01"]);

/**
 * Executes payment work (ARCHITECTURE §4.5): submissions, status queries, callback processing,
 * float checks, C2B URL registration and the watchdog. Every step runs as the payments system
 * actor inside one company's transaction; provider calls happen between transactions, after the
 * call intent is committed. Each handler is idempotent with respect to database state, so a
 * re-delivered job or a drain after an outage repeats nothing that already happened, and no
 * provider call whose acceptance is uncertain is ever sent again.
 */
@Injectable()
export class PaymentProcessor {
  private readonly logger = new Logger(PaymentProcessor.name);
  readonly workerId = `${hostname().slice(0, 40)}:${process.pid}:${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly db: TenantDatabase,
    private readonly ledger: PaymentLedger,
    private readonly accounts: PaymentAccounts,
    private readonly crypto: PaymentsCrypto,
    private readonly runtime: PaymentsRuntime,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  run<T>(tenantId: string, label: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.run(
      { userId: PAYMENTS_SYSTEM_ACTOR, tenantId, requestId: `payments-${label}-${randomUUID().slice(0, 8)}` },
      work,
      20_000,
    );
  }

  // Entry points ---------------------------------------------------------------------------------

  /** Runs one due item (from BullMQ or a direct drain). */
  async process(tenantId: string, work: "outbox" | "watchdog", refId: string): Promise<void> {
    if (work === "watchdog") return this.watchdog(tenantId, refId);
    const row = await this.run(tenantId, "outbox", (tx) =>
      tx.paymentOutbox.findUnique({ where: { tenantId_id: { tenantId, id: refId } } }),
    );
    if (!row || row.processedAt || row.deadAt) return;
    try {
      await this.handle(tenantId, row.topic as OutboxTopic, row.refId);
      await this.run(tenantId, "outbox-done", (tx) =>
        tx.paymentOutbox.updateMany({
          where: { tenantId, id: row.id, processedAt: null, deadAt: null },
          data: { processedAt: new Date(), lastError: null },
        }),
      );
    } catch (error) {
      const retry =
        error instanceof RetryLater ? error : new RetryLater(error instanceof Error ? error.name : "error");
      if (!(error instanceof RetryLater))
        this.logger.warn(`Payment work ${row.topic} failed (${retry.code}); it will be retried`);
      await this.reschedule(tenantId, row.id, row.topic, row.refId, row.attempts, retry);
    }
  }

  private async reschedule(
    tenantId: string,
    id: string,
    topic: string,
    refId: string,
    attempts: number,
    retry: RetryLater,
  ) {
    const count = retry.counts ? attempts + 1 : attempts;
    const dead = retry.counts && count >= this.runtime.outboxMaxAttempts;
    const delay = retry.delayMs ?? Math.min(5_000 * 2 ** Math.max(count - 1, 0), 600_000);
    await this.run(tenantId, "outbox-retry", async (tx) => {
      await tx.paymentOutbox.updateMany({
        where: { tenantId, id, processedAt: null, deadAt: null },
        data: {
          attempts: count,
          lastError: retry.code.slice(0, 80),
          dispatchedAt: null,
          availableAt: new Date(Date.now() + delay),
          ...(dead ? { deadAt: new Date() } : {}),
        },
      });
      if (dead) {
        // Dead-lettered for review: an alert, never a silent drop. A queued attempt stays queued.
        await this.ledger.event(tx, tenantId, {
          subjectType: topic.startsWith("callback") ? "callback" : topic.startsWith("attempt") ? "attempt" : "query",
          subjectId: refId,
          event: "outbox.dead_lettered",
          reason: retry.code.slice(0, 40),
          actorId: SYSTEM,
          detail: { topic, attempts: count },
        });
        await this.ledger.audit(tx, "payments.outbox_dead_lettered", id, { topic, code: retry.code });
        this.logger.error(`ALERT payments outbox ${topic} dead-lettered after ${count} attempts (${retry.code})`);
      }
    });
  }

  private handle(tenantId: string, topic: OutboxTopic, refId: string): Promise<void> {
    switch (topic) {
      case "attempt.submit":
        return this.submit(tenantId, refId);
      case "attempt.status_query":
        return this.statusQuery(tenantId, refId);
      case "callback.process":
        return this.processCallback(tenantId, refId);
      case "balance.query":
      case "c2b.register":
        return this.providerQuery(tenantId, refId);
    }
  }

  // Submission -----------------------------------------------------------------------------------

  private async instruction(tx: Tx, attempt: PaymentAttempt): Promise<AttemptInstruction> {
    const request = await tx.paymentRequest.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: attempt.tenantId, id: attempt.requestId } },
    });
    let reversal: AttemptInstruction["reversal"] = null;
    if (attempt.kind === "reversal" && attempt.reversesAttemptId) {
      const original = await tx.paymentAttempt.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: attempt.tenantId, id: attempt.reversesAttemptId } },
      });
      reversal = { receipt: original.receipt ?? "", shortcode: original.shortcode ?? "" };
    }
    return {
      kind: attempt.kind as PaymentAttemptKind,
      amountMinor: minor(attempt.amountMinor),
      msisdn: request.msisdnEnc ? this.crypto.openMsisdn(attempt.tenantId, request.id, request.msisdnEnc) : null,
      partyB: request.partyB,
      accountReference: request.accountReference,
      command: request.command,
      description: attempt.kind === "reversal" ? `Reversal ${request.reference}` : request.description,
      occasion: request.occasion,
      originatorConversationId: attempt.originatorConversationId,
      reversal,
    };
  }

  private payoutGated(attempt: PaymentAttempt) {
    return attempt.direction === "out" || attempt.kind === "reversal";
  }

  /**
   * queued → submitting → pending/unknown/failed. Pre-flight (switch, environment, credentials,
   * certificate, token, body) changes nothing; the CAS to `submitting` commits the call intent and a
   * lease before the single HTTP call; the classification is recorded afterwards. A crash between
   * the two leaves `submitting` with an expiring lease for the watchdog: never a second call.
   */
  async submit(tenantId: string, attemptId: string): Promise<void> {
    const prepared = await this.run(tenantId, "submit-prepare", async (tx) => {
      const attempt = await tx.paymentAttempt.findUnique({ where: { tenantId_id: { tenantId, id: attemptId } } });
      if (!attempt || attempt.status !== "queued") return null;
      const loaded = await this.accounts.load(tx, tenantId, attempt.routeId);
      if (!loaded) throw new RetryLater("payments-not-configured");
      if (this.payoutGated(attempt) && !loaded.settings.payoutsEnabled)
        throw new RetryLater("payouts-disabled", 30_000, false);
      if (loaded.settings.environment !== attempt.environment)
        throw new RetryLater("environment-changed", 60_000, false);
      return { attempt, account: loaded.account, instruction: await this.instruction(tx, attempt) };
    });
    if (!prepared) return;
    let call: OutgoingCall;
    try {
      call = await this.provider.prepareAttempt(prepared.account, prepared.instruction);
    } catch (error) {
      if (error instanceof ProviderNotReady) throw new RetryLater(error.code);
      throw error;
    }

    const leased = await this.run(tenantId, "submit-lease", async (tx) => {
      await tx.$queryRaw`SELECT tenant_id FROM payment_settings WHERE tenant_id = ${tenantId}::uuid FOR SHARE`;
      const settings = await tx.paymentSettings.findUniqueOrThrow({ where: { tenantId } });
      if (this.payoutGated(prepared.attempt) && !settings.payoutsEnabled) return null;
      const now = new Date();
      return this.ledger.transition(tx, prepared.attempt, "submitting", "submission_started", SYSTEM, {
        leaseOwner: this.workerId,
        leaseExpiresAt: new Date(now.getTime() + this.runtime.leaseSeconds * 1000),
        submittedAt: now,
        requestDigest: call.digest,
      });
    });
    if (!leased) {
      if (this.payoutGated(prepared.attempt)) throw new RetryLater("payouts-disabled", 30_000, false);
      return;
    }

    const transport = await this.provider.send(call);
    await this.recordSubmission(tenantId, leased, transport, call, prepared.account);
  }

  private async recordSubmission(
    tenantId: string,
    leased: PaymentAttempt,
    transport: SubmissionTransport,
    call: OutgoingCall,
    account: ProviderAccount,
  ) {
    const outcome = classifySubmission(
      leased.kind as PaymentAttemptKind,
      transport,
      leased.kind === "b2c" ? leased.originatorConversationId : null,
    );
    if (outcome.outcome === "failed" && outcome.providerCode && TOKEN_ERRORS.has(outcome.providerCode))
      await this.provider.invalidateToken(account);
    await this.run(tenantId, "submit-record", async (tx) => {
      const attempt = await this.lockAttempt(tx, tenantId, leased.id);
      const identifiers = outcome.outcome === "pending" ? outcome.identifiers : {};
      const ids = {
        ...(identifiers.merchantRequestId && !attempt.merchantRequestId
          ? { merchantRequestId: identifiers.merchantRequestId }
          : {}),
        ...(identifiers.checkoutRequestId && !attempt.checkoutRequestId
          ? { checkoutRequestId: identifiers.checkoutRequestId }
          : {}),
        ...(identifiers.originatorConversationId && !attempt.originatorConversationId
          ? { originatorConversationId: identifiers.originatorConversationId }
          : {}),
        ...(identifiers.conversationId && !attempt.conversationId
          ? { conversationId: identifiers.conversationId }
          : {}),
      };
      const ours = attempt.status === "submitting" && attempt.leaseOwner === this.workerId;
      if (!ours) {
        // The watchdog or a callback got there first: keep the acknowledgement's identifiers as
        // evidence (written once), never move the state back.
        if (Object.keys(ids).length > 0) {
          await tx.paymentAttempt.update({
            where: { tenantId_id: { tenantId, id: attempt.id } },
            data: { ...ids, version: attempt.version + 1 },
          });
          await this.rematchQuarantined(tx, { ...attempt, ...ids });
        }
        await this.ledger.event(tx, tenantId, {
          subjectType: "attempt",
          subjectId: attempt.id,
          requestId: attempt.requestId,
          event: "attempt.late_acknowledgement",
          reason: outcome.reason,
          actorId: SYSTEM,
          detail: { outcome: outcome.outcome, status: attempt.status },
        });
        return;
      }
      if (outcome.outcome === "pending") {
        const pending = await this.ledger.transition(
          tx,
          attempt,
          "pending",
          "accepted",
          SYSTEM,
          {
            ...ids,
            acceptedAt: new Date(),
            resultDueAt: new Date(Date.now() + this.runtime.resultTimeoutSeconds * 1000),
            leaseOwner: null,
            leaseExpiresAt: null,
          },
          { operation: call.operation },
        );
        if (pending) await this.rematchQuarantined(tx, pending);
        return;
      }
      if (outcome.outcome === "failed") {
        await this.ledger.fail(tx, attempt, { resultCode: null, resultDesc: null, providerCode: outcome.providerCode }, outcome.reason, SYSTEM);
        return;
      }
      await this.ledger.markUnknown(tx, attempt, outcome.reason, SYSTEM, { providerCode: outcome.providerCode });
    });
  }

  private async lockAttempt(tx: Tx, tenantId: string, attemptId: string) {
    await tx.$queryRaw`SELECT id FROM payment_attempts WHERE tenant_id = ${tenantId}::uuid AND id = ${attemptId}::uuid FOR UPDATE`;
    return tx.paymentAttempt.findUniqueOrThrow({ where: { tenantId_id: { tenantId, id: attemptId } } });
  }

  /**
   * A result can beat the acknowledgement that tells us its identifiers (STK, B2B, reversals): it
   * is quarantined as unknown. Once the identifiers are stored, recent quarantined callbacks of the
   * matching kind are re-examined (they are matched on stored identifiers like any other).
   */
  private async rematchQuarantined(tx: Tx, attempt: PaymentAttempt) {
    const candidates = await tx.paymentCallbackInbox.findMany({
      where: {
        tenantId: attempt.tenantId,
        status: "quarantined",
        quarantineReason: "unknown_request",
        kind: { in: [...CALLBACK_FOR_KIND[attempt.kind as PaymentAttemptKind]] },
        receivedAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
      },
      orderBy: { receivedAt: "asc" },
      take: 50,
    });
    for (const candidate of candidates) {
      const parsed = this.parseStored(candidate);
      if (parsed && this.identifiersMatch(attempt, parsed.identifiers))
        await this.ledger.enqueue(tx, attempt.tenantId, "callback.process", candidate.id);
    }
  }

  // Watchdog --------------------------------------------------------------------------------------

  /** Expired submission leases and overdue results become unknown (never resubmitted). */
  async watchdog(tenantId: string, attemptId: string): Promise<void> {
    await this.run(tenantId, "watchdog", async (tx) => {
      const attempt = await this.lockAttempt(tx, tenantId, attemptId);
      const now = Date.now();
      if (attempt.status === "submitting" && attempt.leaseExpiresAt && attempt.leaseExpiresAt.getTime() < now)
        await this.ledger.markUnknown(tx, attempt, "lease_expired", SYSTEM);
      else if (attempt.status === "pending" && attempt.resultDueAt && attempt.resultDueAt.getTime() < now)
        await this.ledger.markUnknown(tx, attempt, "result_overdue", SYSTEM);
    });
  }

  // Status queries --------------------------------------------------------------------------------

  /**
   * Reconciliation (brief §15 D): STK Query for STK pushes (synchronous), Transaction Status for
   * the others (answered on the status-result callback). Only reads; never a new payment.
   */
  async statusQuery(tenantId: string, attemptId: string): Promise<void> {
    const prepared = await this.run(tenantId, "status-prepare", async (tx) => {
      const attempt = await tx.paymentAttempt.findUnique({ where: { tenantId_id: { tenantId, id: attemptId } } });
      if (!attempt || (attempt.status !== "unknown" && attempt.status !== "pending")) return null;
      if (!this.ledger.statusQuerySupported(attempt)) return null;
      const loaded = await this.accounts.load(tx, tenantId, attempt.routeId);
      if (!loaded) throw new RetryLater("payments-not-configured");
      return { attempt, account: loaded.account };
    });
    if (!prepared) return;
    const { attempt, account } = prepared;
    let call: OutgoingCall;
    try {
      call =
        attempt.kind === "stk_push"
          ? await this.provider.prepareStkQuery(account, attempt.checkoutRequestId!)
          : await this.provider.prepareTransactionStatus(account, {
              originatorConversationId: attempt.originatorConversationId,
              receipt: attempt.receipt,
              shortcode: attempt.shortcode,
            });
    } catch (error) {
      if (error instanceof ProviderNotReady) throw new RetryLater(error.code);
      throw error;
    }
    const query = await this.run(tenantId, "status-sent", async (tx) => {
      const current = await this.lockAttempt(tx, tenantId, attempt.id);
      if (current.status !== "unknown" && current.status !== "pending") return null;
      const count = current.statusQueries + 1;
      await tx.paymentAttempt.update({
        where: { tenantId_id: { tenantId, id: current.id } },
        data: {
          statusQueries: count,
          nextStatusQueryAt: null,
          version: current.version + 1,
        },
      });
      const created = await tx.providerQuery.create({
        data: {
          tenantId,
          kind: attempt.kind === "stk_push" ? "stk_query" : "transaction_status",
          status: "sent",
          attemptId: current.id,
        },
      });
      await this.ledger.event(tx, tenantId, {
        subjectType: "attempt",
        subjectId: current.id,
        requestId: current.requestId,
        event: "attempt.status_query_sent",
        actorId: SYSTEM,
        detail: { query: created.kind, count },
      });
      return created;
    });
    if (!query) return;
    const transport = await this.provider.send(call);
    await this.run(tenantId, "status-record", async (tx) => {
      const current = await this.lockAttempt(tx, tenantId, attempt.id);
      const body =
        transport.type === "response" && transport.body && typeof transport.body === "object"
          ? (transport.body as Record<string, unknown>)
          : null;
      const ok = transport.type === "response" && transport.httpStatus === 200 && body && String(body["ResponseCode"]) === "0";
      if (query.kind === "stk_query") {
        const resultCode = ok && body?.["ResultCode"] !== undefined ? String(body?.["ResultCode"]) : null;
        const answer = interpretStkQuery(resultCode);
        await this.answerQuery(tx, query.id, query.version, answer === "undetermined" ? "unknown" : "answered", resultCode, `STK query: ${answer}`);
        if (answer === "failed" && (current.status === "unknown" || current.status === "pending")) {
          await this.ledger.fail(tx, current, { resultCode, resultDesc: typeof body?.["ResultDesc"] === "string" ? String(body["ResultDesc"]).slice(0, 300) : null }, "status_query_failure", SYSTEM);
        } else if (answer === "completed") {
          // No amount or receipt in the answer: success is reported, not proven (manual review).
          await this.ledger.openCase(tx, tenantId, "unverified_success", "stk_query_success", { requestId: current.requestId, attemptId: current.id }, SYSTEM);
        } else {
          await this.scheduleNextQuery(tx, current);
        }
        return;
      }
      if (ok && body && (body["ConversationID"] || body["OriginatorConversationID"])) {
        await tx.providerQuery.update({
          where: { tenantId_id: { tenantId, id: query.id } },
          data: {
            conversationId: typeof body["ConversationID"] === "string" ? body["ConversationID"] : null,
            originatorConversationId:
              typeof body["OriginatorConversationID"] === "string" ? body["OriginatorConversationID"] : null,
            version: query.version + 1,
          },
        });
        return;
      }
      await this.answerQuery(tx, query.id, query.version, transport.type === "response" ? "failed" : "unknown", body ? String(body["errorCode"] ?? body["ResponseCode"] ?? "") || null : null, "Transaction Status request not accepted");
      await this.scheduleNextQuery(tx, current);
    });
  }

  private async answerQuery(
    tx: Tx,
    queryId: string,
    version: number,
    status: "answered" | "failed" | "unknown",
    resultCode: string | null,
    summary: string | null,
    balances?: Prisma.InputJsonValue,
  ) {
    const query = await tx.providerQuery.findFirstOrThrow({ where: { id: queryId } });
    await tx.providerQuery.update({
      where: { tenantId_id: { tenantId: query.tenantId, id: queryId } },
      data: {
        status,
        resultCode: resultCode?.slice(0, 20) ?? null,
        summary: summary?.slice(0, 300) ?? null,
        ...(balances !== undefined ? { balances } : {}),
        version: Math.max(version, query.version) + 1,
      },
    });
  }

  /** Bounded automatic status queries; afterwards the case waits for a reviewer. */
  private async scheduleNextQuery(tx: Tx, attempt: PaymentAttempt) {
    if (attempt.statusQueries >= this.runtime.statusQueryMax) return;
    const next = new Date(Date.now() + this.runtime.statusQueryIntervalSeconds * 1000);
    await tx.paymentAttempt.update({
      where: { tenantId_id: { tenantId: attempt.tenantId, id: attempt.id } },
      data: { nextStatusQueryAt: next, version: attempt.version + 1 },
    });
    await this.ledger.enqueue(tx, attempt.tenantId, "attempt.status_query", attempt.id, next);
  }

  // Float checks and C2B registration --------------------------------------------------------------

  async providerQuery(tenantId: string, queryId: string): Promise<void> {
    const prepared = await this.run(tenantId, "query-prepare", async (tx) => {
      const query = await tx.providerQuery.findUnique({ where: { tenantId_id: { tenantId, id: queryId } } });
      if (!query || query.status !== "sent" || query.conversationId || query.resultCode) return null;
      const loaded = await this.accounts.load(tx, tenantId);
      if (!loaded) throw new RetryLater("payments-not-configured");
      return { query, account: loaded.account };
    });
    if (!prepared) return;
    let call: OutgoingCall;
    try {
      call =
        prepared.query.kind === "account_balance"
          ? await this.provider.prepareAccountBalance(prepared.account)
          : await this.provider.prepareC2bRegistration(prepared.account, "Completed");
    } catch (error) {
      if (error instanceof ProviderNotReady) {
        await this.run(tenantId, "query-failed", (tx) =>
          this.answerQuery(tx, queryId, prepared.query.version, "failed", error.code, error.message),
        );
        return;
      }
      throw error;
    }
    const transport = await this.provider.send(call);
    await this.run(tenantId, "query-record", async (tx) => {
      const query = await tx.providerQuery.findUniqueOrThrow({ where: { tenantId_id: { tenantId, id: queryId } } });
      const body =
        transport.type === "response" && transport.body && typeof transport.body === "object"
          ? (transport.body as Record<string, unknown>)
          : null;
      const accepted = transport.type === "response" && transport.httpStatus === 200 && body && String(body["ResponseCode"]) === "0";
      if (query.kind === "c2b_register") {
        await this.answerQuery(tx, query.id, query.version, accepted ? "answered" : transport.type === "response" ? "failed" : "unknown", body ? String(body["ResponseCode"] ?? body["errorCode"] ?? "") || null : null, accepted ? "C2B URLs registered" : "C2B URL registration refused");
        await this.ledger.audit(tx, "payments.c2b_registration_answered", query.id, { accepted: Boolean(accepted) });
        return;
      }
      if (accepted && body && (body["ConversationID"] || body["OriginatorConversationID"])) {
        await tx.providerQuery.update({
          where: { tenantId_id: { tenantId, id: query.id } },
          data: {
            conversationId: typeof body["ConversationID"] === "string" ? body["ConversationID"] : null,
            originatorConversationId:
              typeof body["OriginatorConversationID"] === "string" ? body["OriginatorConversationID"] : null,
            version: query.version + 1,
          },
        });
        return;
      }
      await this.answerQuery(tx, query.id, query.version, transport.type === "response" ? "failed" : "unknown", body ? String(body["errorCode"] ?? "") || null : null, "Account balance request not accepted");
    });
  }

  // Callback processing --------------------------------------------------------------------------

  private parseStored(row: PaymentCallbackInbox): ParsedCallback | null {
    try {
      const body: unknown = JSON.parse(this.crypto.openBody(row.tenantId, row.id, row.bodyEnc));
      const parsed = this.provider.parseCallback(row.kind as CallbackKind, body);
      return parsed.ok ? parsed.value : null;
    } catch {
      return null;
    }
  }

  /** Matching is on stored request identifiers only; every identifier both sides have must agree. */
  private identifiersMatch(attempt: PaymentAttempt, ids: CallbackIdentifiers): boolean {
    const pairs: [string | null, string | undefined][] = [
      [attempt.checkoutRequestId, ids.checkoutRequestId],
      [attempt.merchantRequestId, ids.merchantRequestId],
      [attempt.originatorConversationId, ids.originatorConversationId],
      [attempt.conversationId, ids.conversationId],
    ];
    let matched = false;
    for (const [stored, received] of pairs) {
      if (!stored || !received) continue;
      if (stored !== received) return false;
      matched = true;
    }
    return matched;
  }

  private async findAttempt(tx: Tx, tenantId: string, parsed: ParsedCallback): Promise<PaymentAttempt | null> {
    const ids = parsed.identifiers;
    const or: Prisma.PaymentAttemptWhereInput[] = [];
    if (parsed.kind === "stk") {
      if (ids.checkoutRequestId) or.push({ checkoutRequestId: ids.checkoutRequestId });
    } else {
      if (ids.originatorConversationId) or.push({ originatorConversationId: ids.originatorConversationId });
      if (ids.conversationId) or.push({ conversationId: ids.conversationId });
    }
    if (or.length === 0) return null;
    const candidates = await tx.paymentAttempt.findMany({ where: { tenantId, OR: or }, take: 2 });
    const matches = candidates.filter((candidate) => this.identifiersMatch(candidate, ids));
    return matches.length === 1 ? matches[0]! : null;
  }

  private async quarantine(
    tx: Tx,
    row: PaymentCallbackInbox,
    reason: QuarantineReason,
    link: { attemptId?: string | null; requestId?: string | null; queryId?: string | null } = {},
  ) {
    if (row.status === "received" || row.quarantineReason !== reason || row.attemptId !== (link.attemptId ?? row.attemptId)) {
      await tx.paymentCallbackInbox.update({
        where: { tenantId_id: { tenantId: row.tenantId, id: row.id } },
        data: {
          status: "quarantined",
          quarantineReason: reason,
          attemptId: link.attemptId ?? row.attemptId,
          queryId: link.queryId ?? row.queryId,
          version: row.version + 1,
        },
      });
    }
    const caseKind =
      reason === "conflicting_result" || reason === "duplicate_receipt"
        ? "conflicting_evidence"
        : "quarantined_callback";
    await this.ledger.openCase(
      tx,
      row.tenantId,
      caseKind,
      reason,
      { requestId: link.requestId ?? null, attemptId: caseKind === "conflicting_evidence" ? (link.attemptId ?? null) : null, callbackId: row.id },
      SYSTEM,
    );
    if (row.status === "received") {
      await this.ledger.event(tx, row.tenantId, {
        subjectType: "callback",
        subjectId: row.id,
        requestId: link.requestId ?? null,
        event: "callback.quarantined",
        fromStatus: row.status,
        toStatus: "quarantined",
        reason,
        actorId: SYSTEM,
        detail: { kind: row.kind },
      });
      await this.ledger.audit(tx, "payments.callback_quarantined", row.id, { kind: row.kind, reason });
      // An alert for the reconciliation owner; identifiers only (no personal data).
      this.logger.warn(`ALERT payment callback ${row.id} (${row.kind}) quarantined: ${reason}`);
    }
  }

  private async processed(
    tx: Tx,
    row: PaymentCallbackInbox,
    link: { attemptId?: string | null; queryId?: string | null; requestId?: string | null },
    note: string,
  ) {
    await tx.paymentCallbackInbox.update({
      where: { tenantId_id: { tenantId: row.tenantId, id: row.id } },
      data: {
        status: "processed",
        processedAt: new Date(),
        attemptId: link.attemptId ?? row.attemptId,
        queryId: link.queryId ?? row.queryId,
        version: row.version + 1,
      },
    });
    await this.ledger.event(tx, row.tenantId, {
      subjectType: "callback",
      subjectId: row.id,
      requestId: link.requestId ?? null,
      event: "callback.processed",
      fromStatus: row.status,
      toStatus: "processed",
      reason: note.slice(0, 40),
      actorId: SYSTEM,
      detail: { kind: row.kind },
    });
    if (row.status === "quarantined") {
      // A previously unmatched callback now matched: its review case is settled by the evidence.
      const open = await tx.paymentCase.findMany({
        where: { tenantId: row.tenantId, callbackId: row.id, status: "open", kind: "quarantined_callback" },
      });
      for (const item of open)
        await this.ledger.closeCase(tx, row.tenantId, item.id, item.version, "no_payment_effect", "Matched after the acknowledgement arrived", SYSTEM);
    }
  }

  /** Processes one inbox row idempotently: duplicates and late results change nothing. */
  async processCallback(tenantId: string, callbackId: string): Promise<void> {
    await this.run(tenantId, "callback", async (tx) => {
      await tx.$queryRaw`SELECT id FROM payment_callback_inbox WHERE tenant_id = ${tenantId}::uuid AND id = ${callbackId}::uuid FOR UPDATE`;
      const row = await tx.paymentCallbackInbox.findUnique({ where: { tenantId_id: { tenantId, id: callbackId } } });
      if (!row || (row.status !== "received" && row.status !== "quarantined")) return;
      let body: unknown;
      try {
        body = JSON.parse(this.crypto.openBody(tenantId, row.id, row.bodyEnc));
      } catch {
        return this.quarantine(tx, row, "malformed");
      }
      const result = this.provider.parseCallback(row.kind as CallbackKind, body);
      if (!result.ok) return this.quarantine(tx, row, result.reason);
      const parsed = result.value;
      switch (parsed.kind) {
        case "c2b_validation":
          return this.processed(tx, row, {}, "c2b_validation");
        case "c2b_confirmation":
          return this.c2bConfirmation(tx, row, parsed);
        case "balance_result":
        case "status_result":
          return this.queryAnswer(tx, row, parsed);
        default:
          return this.attemptResult(tx, row, parsed);
      }
    });
  }

  private async c2bConfirmation(tx: Tx, row: PaymentCallbackInbox, parsed: ParsedCallback) {
    const settings = await tx.paymentSettings.findUnique({ where: { tenantId: row.tenantId } });
    if (!settings?.c2bShortcode || parsed.shortcode !== settings.c2bShortcode)
      return this.quarantine(tx, row, "shortcode_mismatch");
    const existing = await tx.providerTransaction.findUnique({
      where: { tenantId_receipt: { tenantId: row.tenantId, receipt: parsed.receipt! } },
    });
    if (existing) {
      if (minor(existing.amountMinor) === parsed.amountMinor && existing.kind === "c2b")
        return this.processed(tx, row, {}, "duplicate_receipt_same_evidence");
      return this.quarantine(tx, row, "duplicate_receipt", { attemptId: existing.attemptId });
    }
    const receipt = await tx.providerTransaction.create({
      data: {
        tenantId: row.tenantId,
        kind: "c2b",
        direction: "in",
        status: "unallocated",
        receipt: parsed.receipt!,
        amountMinor: parsed.amountMinor!,
        shortcode: parsed.shortcode,
        accountReference: parsed.billReference,
        callbackId: row.id,
        completedAtRaw: parsed.completedAt,
      },
    });
    await this.ledger.audit(tx, "payments.c2b_receipt_recorded", receipt.id, { callbackId: row.id });
    return this.processed(tx, row, {}, "c2b_receipt");
  }

  private async queryAnswer(tx: Tx, row: PaymentCallbackInbox, parsed: ParsedCallback) {
    const ids = parsed.identifiers;
    const or: Prisma.ProviderQueryWhereInput[] = [];
    if (ids.originatorConversationId) or.push({ originatorConversationId: ids.originatorConversationId });
    if (ids.conversationId) or.push({ conversationId: ids.conversationId });
    const query = or.length
      ? await tx.providerQuery.findFirst({
          where: {
            tenantId: row.tenantId,
            OR: or,
            kind: parsed.kind === "balance_result" ? "account_balance" : "transaction_status",
          },
        })
      : null;
    if (!query) return this.quarantine(tx, row, "unknown_request");
    if (query.status === "answered") return this.processed(tx, row, { queryId: query.id }, "duplicate_answer");
    if (parsed.kind === "balance_result") {
      const kes = parsed.balances?.every((balance) => balance.currency === "KES") ?? true;
      if (!kes) return this.quarantine(tx, row, "currency_mismatch", { queryId: query.id });
      await this.answerQuery(
        tx,
        query.id,
        query.version,
        parsed.outcome === "failure" ? "failed" : "answered",
        parsed.resultCode,
        parsed.resultDesc,
        parsed.balances ?? undefined,
      );
      return this.processed(tx, row, { queryId: query.id }, "balance_answer");
    }
    if (!query.attemptId) return this.quarantine(tx, row, "unknown_request");
    const attempt = await this.lockAttempt(tx, row.tenantId, query.attemptId);
    const link = { queryId: query.id, attemptId: attempt.id, requestId: attempt.requestId };
    const original = parsed.original;
    if (
      original?.originatorConversationId &&
      attempt.originatorConversationId &&
      original.originatorConversationId !== attempt.originatorConversationId
    )
      return this.quarantine(tx, row, "kind_mismatch", link);
    const answer = parsed.outcome === "failure" ? "undetermined" : interpretTransactionStatus(original?.status ?? null);
    await this.answerQuery(tx, query.id, query.version, "answered", parsed.resultCode, `Transaction status: ${original?.status ?? parsed.resultDesc ?? "unknown"}`.slice(0, 300));
    if (isFinalOutcome(attempt.status as PaymentAttemptStatus)) {
      const conflict =
        (answer === "completed" && attempt.status === "failed") ||
        (answer === "failed" && (attempt.status === "confirmed" || attempt.status === "reversal_pending"));
      if (conflict) return this.quarantine(tx, row, "conflicting_result", link);
      return this.processed(tx, row, link, "late_status_answer");
    }
    if (answer === "completed") {
      const expected = this.expected(attempt);
      const verified = verifySettlement(
        { amountMinor: original?.amountMinor ?? null, currency: null, receipt: original?.receipt ?? null, shortcode: null },
        expected,
      );
      if (!verified.ok) return this.quarantine(tx, row, verified.reason, link);
      if (await this.receiptTaken(tx, attempt, original!.receipt!)) return this.quarantine(tx, row, "duplicate_receipt", link);
      const confirmed = await this.ledger.confirm(
        tx,
        attempt,
        { receipt: original!.receipt!, resultCode: "0", resultDesc: "Confirmed by Transaction Status", callbackId: row.id, completedAtRaw: null },
        "status_query_success",
        SYSTEM,
      );
      if (!confirmed) throw new RetryLater("contention", 500, false);
      return this.processed(tx, row, link, "status_confirmed");
    }
    if (answer === "failed") {
      const failed = await this.ledger.fail(tx, attempt, { resultCode: parsed.resultCode, resultDesc: original?.status ?? null }, "status_query_failure", SYSTEM);
      if (!failed) throw new RetryLater("contention", 500, false);
      return this.processed(tx, row, link, "status_failed");
    }
    await this.scheduleNextQuery(tx, attempt);
    return this.processed(tx, row, link, "status_undetermined");
  }

  private expected(attempt: PaymentAttempt) {
    return {
      kind: attempt.kind as PaymentAttemptKind,
      direction: attempt.direction as PaymentDirection,
      amountMinor: minor(attempt.amountMinor),
      currency: attempt.currency,
      shortcode: attempt.shortcode,
    };
  }

  private async receiptTaken(tx: Tx, attempt: PaymentAttempt, receipt: string) {
    const existing = await tx.providerTransaction.findUnique({
      where: { tenantId_receipt: { tenantId: attempt.tenantId, receipt } },
    });
    return Boolean(existing && existing.attemptId !== attempt.id);
  }

  private async attemptResult(tx: Tx, row: PaymentCallbackInbox, parsed: ParsedCallback) {
    let attempt = await this.findAttempt(tx, row.tenantId, parsed);
    if (!attempt && parsed.kind === "timeout") {
      // A queue timeout for a status or balance query: the query's outcome is unknown.
      const ids = parsed.identifiers;
      const query = ids.originatorConversationId || ids.conversationId
        ? await tx.providerQuery.findFirst({
            where: {
              tenantId: row.tenantId,
              OR: [
                ...(ids.originatorConversationId ? [{ originatorConversationId: ids.originatorConversationId }] : []),
                ...(ids.conversationId ? [{ conversationId: ids.conversationId }] : []),
              ],
            },
          })
        : null;
      if (query) {
        if (query.status === "sent") await this.answerQuery(tx, query.id, query.version, "unknown", parsed.resultCode, "Queue timeout");
        return this.processed(tx, row, { queryId: query.id }, "query_timeout");
      }
    }
    if (!attempt) return this.quarantine(tx, row, "unknown_request");
    attempt = await this.lockAttempt(tx, row.tenantId, attempt.id);
    const link = { attemptId: attempt.id, requestId: attempt.requestId };
    const verification = verifyCallback(parsed, this.expected(attempt));
    if (!verification.ok) return this.quarantine(tx, row, verification.reason, link);
    const status = attempt.status;

    if (parsed.outcome === "in_progress" || parsed.outcome === "information")
      return this.processed(tx, row, link, "interim_result");
    if (parsed.outcome === "timeout") {
      if (status === "submitting" || status === "pending") {
        const moved = await this.ledger.markUnknown(tx, attempt, "queue_timeout", SYSTEM);
        if (!moved) throw new RetryLater("contention", 500, false);
      }
      return this.processed(tx, row, link, "queue_timeout");
    }
    if (parsed.outcome === "success") {
      if (status === "confirmed" || status === "reversal_pending" || status === "reversed") {
        if (attempt.receipt === parsed.receipt) return this.processed(tx, row, link, "duplicate_result");
        return this.quarantine(tx, row, "conflicting_result", link);
      }
      if (status === "failed") return this.quarantine(tx, row, "conflicting_result", link);
      if (status !== "submitting" && status !== "pending" && status !== "unknown")
        return this.quarantine(tx, row, "conflicting_result", link);
      if (await this.receiptTaken(tx, attempt, parsed.receipt!)) return this.quarantine(tx, row, "duplicate_receipt", link);
      const confirmed = await this.ledger.confirm(
        tx,
        attempt,
        { receipt: parsed.receipt!, resultCode: parsed.resultCode, resultDesc: parsed.resultDesc, callbackId: row.id, completedAtRaw: parsed.completedAt },
        "provider_success",
        SYSTEM,
      );
      if (!confirmed) throw new RetryLater("contention", 500, false);
      return this.processed(tx, row, link, "confirmed");
    }
    // Definitive failure.
    if (status === "failed") return this.processed(tx, row, link, "duplicate_failure");
    if (status === "confirmed" || status === "reversal_pending" || status === "reversed")
      return this.quarantine(tx, row, "conflicting_result", link);
    if (status !== "submitting" && status !== "pending" && status !== "unknown")
      return this.quarantine(tx, row, "conflicting_result", link);
    const failed = await this.ledger.fail(tx, attempt, { resultCode: parsed.resultCode, resultDesc: parsed.resultDesc }, "provider_failure", SYSTEM);
    if (!failed) throw new RetryLater("contention", 500, false);
    return this.processed(tx, row, link, "failed");
  }
}
