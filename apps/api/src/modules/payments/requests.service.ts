import { Injectable } from "@nestjs/common";
import { checkPaymentLimits } from "@pm-buddy/domain";
import { directionOfKind, type PaymentAttemptStatus } from "@pm-buddy/types";
import type { CreateTestPaymentRequest, PaymentRequestDetailResponse } from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import type { PaymentAttempt, PaymentSettings, Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import { AuthService, type Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { PaymentCommands } from "./payment-commands.js";
import { PaymentLedger } from "./payment-ledger.js";
import { PaymentsCrypto } from "./payments-crypto.js";
import {
  attemptToWire,
  balanceToWire,
  callbackToWire,
  caseToWire,
  eventToWire,
  maskedMsisdn,
  queryToWire,
  requestToWire,
  transactionToWire,
} from "./payments-mappers.js";
import { PaymentsRelay } from "./payments-relay.js";
import {
  holds,
  minor,
  notFound,
  paymentConflict,
  paymentReference,
  requireStepUp,
  versionConflict,
} from "./payments-support.js";

type Tx = Prisma.TransactionClient;

/** Midnight in Africa/Nairobi (UTC+3, no daylight saving) at or before `now`. */
export function nairobiDayStart(now = new Date()): Date {
  const shifted = new Date(now.getTime() + 3 * 3_600_000);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 3 * 3_600_000,
  );
}

/**
 * Payment requests and their attempts (D4.2). The console creates `test` requests only (mock or
 * sandbox, payments.initiate_test); D4.3 and D5/D7 create business requests through
 * `createRequest` with their own purpose. Creation checks limits under the company lock and
 * commits the request, its first attempt (created → queued), timeline, audit and outbox work in one
 * transaction. Nothing is sent to the provider here.
 */
@Injectable()
export class PaymentRequestsService {
  constructor(
    private readonly commands: PaymentCommands,
    private readonly policy: AccessPolicy,
    private readonly auth: AuthService,
    private readonly ledger: PaymentLedger,
    private readonly crypto: PaymentsCrypto,
    private readonly relay: PaymentsRelay,
  ) {}

  /** Sum of today's (Africa/Nairobi) payout attempts that are not failed (read under the lock). */
  async payoutsToday(tx: Tx, tenantId: string): Promise<number> {
    const result = await tx.paymentAttempt.aggregate({
      where: {
        tenantId,
        status: { not: "failed" },
        OR: [{ direction: "out" }, { kind: "reversal" }],
        createdAt: { gte: nairobiDayStart() },
      },
      _sum: { amountMinor: true },
    });
    return minor(result._sum.amountMinor ?? 0n);
  }

  private limits(settings: PaymentSettings) {
    return {
      stkMaxMinor: minor(settings.stkMaxMinor),
      b2cMinMinor: minor(settings.b2cMinMinor),
      b2cMaxMinor: minor(settings.b2cMaxMinor),
      b2bMaxMinor: minor(settings.b2bMaxMinor),
      dailyPayoutMaxMinor: minor(settings.dailyPayoutMaxMinor),
    };
  }

  async checkLimits(
    tx: Tx,
    settings: PaymentSettings,
    kind: Parameters<typeof checkPaymentLimits>[0],
    amountMinor: number,
  ) {
    const outbound = kind !== "stk_push";
    const problem = checkPaymentLimits(
      kind,
      amountMinor,
      this.limits(settings),
      outbound ? await this.payoutsToday(tx, settings.tenantId) : 0,
    );
    if (problem)
      throw paymentConflict(
        problem.code,
        "This payment is outside the company's configured limits.",
      );
  }

  /**
   * Creates a request and its first attempt. Public for D4.3/D5 (purpose ≠ test) inside their own
   * command transaction, which must hold the company lock (TenantScope mutation).
   */
  async createRequest(
    tx: Tx,
    tenantId: string,
    userId: string,
    input: {
      kind: CreateTestPaymentRequest["kind"];
      purpose: "test" | "payroll_obligation" | "client_invoice" | "supplier_invoice";
      purposeRef: string | null;
      amountMinor: number;
      msisdn: string | null;
      partyB: string | null;
      accountReference: string | null;
      command: string | null;
      description: string | null;
      occasion: string | null;
      projectId: string | null;
      idempotencyKey: string;
      fingerprint: string;
    },
  ) {
    const settings = await tx.paymentSettings.findUnique({ where: { tenantId } });
    if (!settings) throw paymentConflict("payments-not-configured", "Configure payments first.");
    if ((settings.environment as string) === "production")
      throw paymentConflict("production-not-enabled", "Production M-Pesa is not enabled.");
    const route = await tx.paymentCallbackRoute.findFirst({
      where: { tenantId, status: "active" },
    });
    if (!route) throw paymentConflict("payments-not-configured", "No callback route is active.");
    if (input.projectId) {
      const project = await tx.project.findUnique({
        where: { tenantId_id: { tenantId, id: input.projectId } },
      });
      if (!project) throw notFound("Project");
    }
    await this.checkLimits(tx, settings, input.kind, input.amountMinor);
    const requestId = uuidv7();
    const direction = directionOfKind(input.kind);
    const shortcode =
      input.kind === "stk_push"
        ? settings.stkShortcode
        : input.kind === "b2c"
          ? settings.b2cShortcode
          : settings.b2bShortcode;
    const request = await tx.paymentRequest.create({
      data: {
        id: requestId,
        tenantId,
        reference: paymentReference(requestId),
        kind: input.kind,
        direction,
        purpose: input.purpose,
        purposeRef: input.purposeRef,
        amountMinor: input.amountMinor,
        msisdnEnc: input.msisdn ? this.crypto.sealMsisdn(tenantId, requestId, input.msisdn) : null,
        msisdnMasked: input.msisdn ? maskedMsisdn(input.msisdn) : null,
        partyB: input.partyB,
        accountReference: input.accountReference,
        command: input.command,
        description: input.description,
        occasion: input.occasion,
        projectId: input.projectId,
        environment: settings.environment,
        idempotencyKey: input.idempotencyKey,
        fingerprint: input.fingerprint,
        createdBy: userId,
      },
    });
    const attemptId = uuidv7();
    const created = await tx.paymentAttempt.create({
      data: {
        id: attemptId,
        tenantId,
        requestId,
        sequence: 1,
        kind: input.kind,
        direction,
        amountMinor: input.amountMinor,
        environment: settings.environment,
        shortcode,
        routeId: route.id,
        // B2C: PM-Buddy's OriginatorConversationID, persisted before any call (Daraja refuses a
        // duplicate and Transaction Status can find the payment by it even if the response is lost).
        originatorConversationId: input.kind === "b2c" ? attemptId : null,
        createdBy: userId,
      },
    });
    await this.ledger.event(tx, tenantId, {
      subjectType: "request",
      subjectId: requestId,
      requestId,
      event: "request.created",
      actorId: userId,
      detail: { kind: input.kind, purpose: input.purpose, amountMinor: input.amountMinor },
    });
    await this.ledger.event(tx, tenantId, {
      subjectType: "attempt",
      subjectId: attemptId,
      requestId,
      event: "attempt.created",
      toStatus: "created",
      reason: "created",
      actorId: userId,
    });
    await this.ledger.audit(tx, "payments.request_created", requestId, {
      kind: input.kind,
      purpose: input.purpose,
      amountMinor: input.amountMinor,
      environment: settings.environment,
    });
    await this.ledger.transition(tx, created, "queued", "queued", userId);
    await this.ledger.enqueue(tx, tenantId, "attempt.submit", attemptId);
    return { request, settings };
  }

  createTest(principal: Principal, req: Request, input: CreateTestPaymentRequest) {
    return this.commands.run(
      principal,
      req,
      "payments.request.create",
      input,
      async (scope, key, fingerprint) => {
        await this.policy.require(scope, "payments.initiate_test");
        const { tx, access } = scope;
        const { request } = await this.createRequest(tx, access.tenantId, access.userId, {
          kind: input.kind,
          purpose: "test",
          purposeRef: null,
          amountMinor: input.amountMinor,
          msisdn: "phone" in input ? input.phone : null,
          partyB: "partyB" in input ? input.partyB : null,
          accountReference: "accountReference" in input ? input.accountReference : null,
          command: input.kind === "b2c" ? input.command : null,
          description:
            input.kind === "stk_push"
              ? (input.description ?? null)
              : "remarks" in input
                ? input.remarks
                : null,
          occasion: input.kind === "b2c" ? (input.occasion ?? null) : null,
          projectId: input.projectId ?? null,
          idempotencyKey: key!,
          fingerprint: fingerprint!,
        });
        this.relay.kick();
        const latest = await tx.paymentAttempt.findFirst({
          where: { tenantId: access.tenantId, requestId: request.id },
          orderBy: { sequence: "desc" },
        });
        const fresh = await tx.paymentRequest.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: access.tenantId, id: request.id } },
        });
        const names = await displayNames(tx, [fresh.createdBy]);
        return { request: requestToWire(fresh, latest, names) };
      },
      true,
    );
  }

  private async latestAttempts(tx: Tx, tenantId: string, requestIds: string[]) {
    const attempts = await tx.paymentAttempt.findMany({
      where: { tenantId, requestId: { in: requestIds }, kind: { not: "reversal" } },
      orderBy: { sequence: "desc" },
    });
    const latest = new Map<string, PaymentAttempt>();
    for (const attempt of attempts)
      if (!latest.has(attempt.requestId)) latest.set(attempt.requestId, attempt);
    return latest;
  }

  list(
    principal: Principal,
    req: Request,
    query: {
      status?: string | undefined;
      kind?: string | undefined;
      limit: number;
      offset: number;
    },
  ) {
    return this.commands.read(principal, req, async (scope) => {
      await this.policy.require(scope, "payments.view");
      const { tx, access } = scope;
      const where: Prisma.PaymentRequestWhereInput = {
        tenantId: access.tenantId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.paymentRequest.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: query.limit,
          skip: query.offset,
        }),
        tx.paymentRequest.count({ where }),
      ]);
      const latest = await this.latestAttempts(
        tx,
        access.tenantId,
        rows.map((row) => row.id),
      );
      const names = await displayNames(
        tx,
        rows.map((row) => row.createdBy),
      );
      return {
        requests: rows.map((row) => requestToWire(row, latest.get(row.id) ?? null, names)),
        total,
      };
    });
  }

  async detailOf(scope: Scope, requestId: string): Promise<PaymentRequestDetailResponse> {
    const { tx, access } = scope;
    const request = await tx.paymentRequest.findUnique({
      where: { tenantId_id: { tenantId: access.tenantId, id: requestId } },
    });
    if (!request) throw notFound("Payment request");
    const attempts = await tx.paymentAttempt.findMany({
      where: { tenantId: access.tenantId, requestId },
      orderBy: { sequence: "asc" },
    });
    const attemptIds = attempts.map((attempt) => attempt.id);
    const [events, callbacks, cases, queries, transactions] = await Promise.all([
      tx.paymentEvent.findMany({
        where: { tenantId: access.tenantId, requestId },
        orderBy: { createdAt: "asc" },
        take: 500,
      }),
      tx.paymentCallbackInbox.findMany({
        where: { tenantId: access.tenantId, attemptId: { in: attemptIds } },
        orderBy: { receivedAt: "asc" },
      }),
      tx.paymentCase.findMany({
        where: {
          tenantId: access.tenantId,
          OR: [{ requestId }, { attemptId: { in: attemptIds } }],
        },
        orderBy: { openedAt: "asc" },
      }),
      tx.providerQuery.findMany({
        where: { tenantId: access.tenantId, attemptId: { in: attemptIds } },
        orderBy: { createdAt: "asc" },
      }),
      tx.providerTransaction.findMany({
        where: { tenantId: access.tenantId, attemptId: { in: attemptIds } },
        orderBy: { recordedAt: "asc" },
      }),
    ]);
    const names = await displayNames(tx, [
      request.createdBy,
      ...events.map((event) => event.actorId),
      ...callbacks.map((callback) => callback.reviewedBy),
      ...cases.map((item) => item.resolvedBy),
    ]);
    const main = attempts.filter((attempt) => attempt.kind !== "reversal");
    const latest = main.at(-1) ?? null;
    const canReview = await holds(this.policy, scope, "payments.review");
    const canReverse =
      (await holds(this.policy, scope, "payments.reverse")) &&
      latest?.status === "confirmed" &&
      request.createdBy !== access.userId;
    const byId = new Map(attempts.map((attempt) => [attempt.id, attempt]));
    return {
      request: requestToWire(request, latest, names),
      attempts: attempts.map(attemptToWire),
      timeline: events.map((event) => eventToWire(event, names)),
      callbacks: callbacks.map((callback) => callbackToWire(callback, requestId, names)),
      cases: cases.map((item) =>
        caseToWire(
          item,
          item.attemptId ? (byId.get(item.attemptId) ?? null) : null,
          names,
          canReview && request.createdBy !== access.userId,
        ),
      ),
      queries: queries.map(queryToWire),
      transactions: transactions.map(transactionToWire),
      canReverse,
      canQueryStatus:
        canReview &&
        Boolean(latest && (latest.status === "unknown" || latest.status === "pending")),
    };
  }

  detail(principal: Principal, req: Request, requestId: string) {
    return this.commands.read(principal, req, async (scope) => {
      await this.policy.require(scope, "payments.view");
      return this.detailOf(scope, requestId);
    });
  }

  private async attempt(tx: Tx, tenantId: string, attemptId: string) {
    const attempt = await tx.paymentAttempt.findUnique({
      where: { tenantId_id: { tenantId, id: attemptId } },
    });
    if (!attempt) throw notFound("Payment attempt");
    return attempt;
  }

  /**
   * confirmed → reversal_pending with a separate reversal attempt (WORKFLOWS): payments.reverse,
   * a fresh step-up, a reason and someone other than the request's creator. The reversal call is
   * gated by the payout switch like any outbound call.
   */
  requestReversal(
    principal: Principal,
    req: Request,
    attemptId: string,
    input: { version: number; reason: string },
  ) {
    return this.commands.run(
      principal,
      req,
      "payments.attempt.reverse",
      { attemptId, ...input },
      async (scope, key) => {
        await this.policy.require(scope, "payments.reverse");
        requireStepUp(this.auth, scope.principal);
        const { tx, access } = scope;
        const original = await this.attempt(tx, access.tenantId, attemptId);
        const request = await tx.paymentRequest.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: access.tenantId, id: original.requestId } },
        });
        if (request.createdBy === access.userId)
          throw paymentConflict(
            "same-person",
            "Someone other than the person who created the payment must reverse it.",
          );
        if (original.version !== input.version) throw versionConflict();
        if (original.kind === "reversal" || original.status !== "confirmed")
          throw paymentConflict(
            "attempt-not-confirmed",
            "Only a confirmed payment can be reversed.",
          );
        const settings = await tx.paymentSettings.findUniqueOrThrow({
          where: { tenantId: access.tenantId },
        });
        await this.checkLimits(tx, settings, "reversal", minor(original.amountMinor));
        const route = await tx.paymentCallbackRoute.findFirst({
          where: { tenantId: access.tenantId, status: "active" },
        });
        if (!route)
          throw paymentConflict("payments-not-configured", "No callback route is active.");
        const pending = await this.ledger.transition(
          tx,
          original,
          "reversal_pending",
          "reversal_requested",
          access.userId,
        );
        if (!pending) throw versionConflict();
        const last = await tx.paymentAttempt.findFirst({
          where: { tenantId: access.tenantId, requestId: original.requestId },
          orderBy: { sequence: "desc" },
        });
        const reversal = await tx.paymentAttempt.create({
          data: {
            tenantId: access.tenantId,
            requestId: original.requestId,
            sequence: (last?.sequence ?? 1) + 1,
            kind: "reversal",
            direction: original.direction === "in" ? "out" : "in",
            amountMinor: original.amountMinor,
            reversesAttemptId: original.id,
            environment: original.environment,
            shortcode: original.shortcode,
            routeId: route.id,
            createdBy: access.userId,
          },
        });
        await this.ledger.event(tx, access.tenantId, {
          subjectType: "attempt",
          subjectId: reversal.id,
          requestId: original.requestId,
          event: "attempt.created",
          toStatus: "created",
          reason: "reversal_requested",
          actorId: access.userId,
          detail: { reverses: original.id, idempotencyKey: key ? "set" : "none" },
        });
        await this.ledger.audit(tx, "payments.reversal_requested", reversal.id, {
          reversesAttemptId: original.id,
          requestId: original.requestId,
        });
        await this.ledger.transition(tx, reversal, "queued", "queued", access.userId);
        await this.ledger.enqueue(tx, access.tenantId, "attempt.submit", reversal.id);
        this.relay.kick();
        return this.detailOf(scope, original.requestId);
      },
      true,
    );
  }

  /** A reviewer asks for another status query now (bounded per attempt by the worker). */
  queryStatus(principal: Principal, req: Request, attemptId: string) {
    return this.commands.run(
      principal,
      req,
      "payments.attempt.status_query",
      { attemptId },
      async (scope) => {
        await this.policy.require(scope, "payments.review");
        const { tx, access } = scope;
        const attempt = await this.attempt(tx, access.tenantId, attemptId);
        const status = attempt.status as PaymentAttemptStatus;
        if (status !== "unknown" && status !== "pending")
          throw paymentConflict(
            "invalid-transition",
            "Only pending or unknown payments are queried.",
          );
        if (!this.ledger.statusQuerySupported(attempt))
          throw paymentConflict(
            "status-query-unavailable",
            "The provider gave no identifier to query; reconcile against the M-Pesa statement.",
          );
        await this.ledger.enqueue(tx, access.tenantId, "attempt.status_query", attempt.id);
        await this.ledger.audit(tx, "payments.status_query_requested", attempt.id, { status });
        this.relay.kick();
        return this.detailOf(scope, attempt.requestId);
      },
    );
  }

  /** Advisory float check (Account Balance); it races with other payouts and reserves nothing. */
  requestBalance(
    principal: Principal,
    req: Request,
    assertAccess: (scope: Scope) => Promise<void>,
  ) {
    return this.commands.run(principal, req, "payments.balance.check", {}, async (scope) => {
      await assertAccess(scope);
      const { tx, access } = scope;
      const settings = await tx.paymentSettings.findUnique({
        where: { tenantId: access.tenantId },
      });
      if (!settings) throw paymentConflict("payments-not-configured", "Configure payments first.");
      const recent = await tx.providerQuery.findFirst({
        where: {
          tenantId: access.tenantId,
          kind: "account_balance",
          status: "sent",
          createdAt: { gte: new Date(Date.now() - 60_000) },
        },
      });
      const query =
        recent ??
        (await tx.providerQuery.create({
          data: {
            tenantId: access.tenantId,
            kind: "account_balance",
            status: "sent",
            requestedBy: access.userId,
          },
        }));
      if (!recent) {
        await this.ledger.enqueue(tx, access.tenantId, "balance.query", query.id);
        await this.ledger.audit(tx, "payments.balance_check_requested", query.id, {});
        this.relay.kick();
      }
      return { check: balanceToWire(query) };
    });
  }
}
