/** Synthetic D4.2 console fixtures. This handler never contacts a payment provider. */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { DEMO_PAYMENT_LIMITS, PAYMENT_SECRET_FIELDS } from "@pm-buddy/types";
import * as wire from "@pm-buddy/validation";

export const PAYMENT_REQUEST_ID = "90000000-0000-4000-8000-000000000001";
export const PAYMENT_CALLBACK_ID = "90000000-0000-4000-8000-000000000002";
export const PAYMENT_CASE_ID = "90000000-0000-4000-8000-000000000003";
const at = "2026-11-15T10:00:00.000Z";
const actor = { id: "10000000-0000-4000-8000-000000000001", displayName: "Synthetic creator" };
const fixtures = new WeakMap<object, ReturnType<typeof initial>>();

function initial() {
  const attempt: wire.PaymentAttempt = {
    id: randomUUID(),
    sequence: 1,
    kind: "stk_push",
    direction: "in",
    status: "unknown",
    version: 1,
    amountMinor: 10000,
    currency: "KES",
    environment: "mock",
    shortcode: "174379",
    providerIds: {
      merchantRequestId: null,
      checkoutRequestId: "mock-checkout",
      originatorConversationId: null,
      conversationId: null,
    },
    receipt: null,
    resultCode: null,
    resultDesc: null,
    reason: "lost_response",
    reversesAttemptId: null,
    statusQueries: 0,
    createdAt: at,
    submittedAt: at,
    acceptedAt: null,
    finalizedAt: null,
  };
  const request: wire.PaymentRequestSummary = {
    id: PAYMENT_REQUEST_ID,
    reference: "PAY-TEST-001",
    kind: "stk_push",
    direction: "in",
    purpose: "test",
    status: "uncertain",
    amountMinor: 10000,
    currency: "KES",
    counterparty: "2547•••••123",
    accountReference: "TEST001",
    description: "Synthetic",
    environment: "mock",
    projectId: null,
    createdAt: at,
    createdBy: actor,
    latestAttempt: attempt,
    version: 1,
  };
  const callback: wire.PaymentCallback = {
    id: PAYMENT_CALLBACK_ID,
    kind: "stk",
    status: "quarantined",
    receivedAt: at,
    processedAt: at,
    quarantineReason: "unknown_request",
    requestId: null,
    attemptId: null,
    bodySha256: "a".repeat(64),
    bodyBytes: 120,
    duplicates: 2,
    redactedBody: { CheckoutRequestID: "unmatched-mock-id", PhoneNumber: "2547•••••123" },
    review: null,
    version: 1,
  };
  const reconciliation: wire.ReconciliationCase = {
    id: PAYMENT_CASE_ID,
    kind: "unknown_outcome",
    status: "open",
    openedAt: at,
    reason: "lost_response",
    requestId: request.id,
    attemptId: attempt.id,
    callbackId: null,
    attemptStatus: "unknown",
    amountMinor: 10000,
    owner: "Finance",
    resolution: null,
    resolutionNote: null,
    resolvedAt: null,
    resolvedBy: null,
    canResolve: true,
    version: 1,
  };
  const settings: wire.PaymentSettings = {
    environment: "mock",
    availableEnvironments: ["mock", "sandbox"],
    productionEnabled: false,
    payoutsEnabled: false,
    payoutsChangedAt: null,
    payoutsChangedBy: null,
    shortcodes: {
      stkShortcode: "174379",
      stkPartyB: "174379",
      stkTransactionType: "CustomerPayBillOnline",
      c2bShortcode: null,
      b2cShortcode: null,
      b2bShortcode: null,
    },
    limits: { ...DEMO_PAYMENT_LIMITS },
    limitsStatus: "demo",
    secrets: Object.fromEntries(
      PAYMENT_SECRET_FIELDS.map((k) => [k, { configured: false, updatedAt: null }]),
    ) as wire.PaymentSettings["secrets"],
    credentialsUpdatedAt: null,
    credentialsUpdatedBy: null,
    callbackUrls: [{ kind: "stk", url: "https://example.test/hooks/synthetic/stk" }],
    callbackUrlWarnings: [],
    callbackTokenRotatedAt: null,
    ipAllowlistEnabled: false,
    certificateConfigured: true,
    version: 1,
    updatedAt: at,
  };
  const timeline: wire.PaymentEvent[] = ["created", "queued", "submitting", "unknown"].map(
    (status, i, statuses) => ({
      id: randomUUID(),
      at,
      subjectType: "attempt",
      subjectId: attempt.id,
      event: "state_changed",
      fromStatus: statuses[i - 1] ?? null,
      toStatus: status,
      reason: i === 3 ? "lost_response" : status,
      actor: null,
      detail: {},
    }),
  );
  return {
    requests: [request],
    callback,
    reconciliation,
    /** D4.3: cases opened for uncertain payroll payouts (see registerPayoutRequest). */
    extraCases: [] as wire.ReconciliationCase[],
    settings,
    timeline,
    queries: [] as wire.ProviderQuery[],
    keys: new Map<string, wire.PaymentRequestSummary>(),
  };
}

function fixtureFor(state: object) {
  let s = fixtures.get(state);
  if (!s) {
    s = initial();
    fixtures.set(state, s);
  }
  return s;
}

/**
 * D4.3: a payroll payout's B2C payment request, so the payments console shows it. The payouts mock
 * moves it with `updatePayoutRequest`; an uncertain outcome opens a case like D4.2 does.
 */
export function registerPayoutRequest(
  state: object,
  input: {
    id: string;
    reference: string;
    amountMinor: number;
    counterparty: string;
    projectId: string;
    createdBy: { id: string; displayName: string };
    createdAt: string;
  },
): void {
  const s = fixtureFor(state);
  s.requests.push({
    id: input.id,
    reference: input.reference,
    kind: "b2c",
    direction: "out",
    purpose: "payroll_obligation",
    status: "in_progress",
    amountMinor: input.amountMinor,
    currency: "KES",
    counterparty: input.counterparty,
    accountReference: null,
    description: "Payroll",
    environment: "mock",
    projectId: input.projectId,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    latestAttempt: {
      ...s.requests[0]!.latestAttempt!,
      id: randomUUID(),
      kind: "b2c",
      direction: "out",
      status: "queued",
      reason: "queued",
      amountMinor: input.amountMinor,
      shortcode: "600000",
      providerIds: {
        merchantRequestId: null,
        checkoutRequestId: null,
        originatorConversationId: null,
        conversationId: null,
      },
      createdAt: input.createdAt,
      submittedAt: null,
      finalizedAt: null,
    },
    version: 1,
  });
}

/** Moves a registered payroll request; returns the case opened for an uncertain outcome. */
export function updatePayoutRequest(
  state: object,
  id: string,
  update: {
    request: wire.PaymentRequestSummary["status"];
    attempt: wire.PaymentAttempt["status"];
    receipt?: string | null;
    resultCode?: string | null;
    resultDesc?: string | null;
  },
): string | null {
  const s = fixtureFor(state);
  const request = s.requests.find((entry) => entry.id === id);
  const attempt = request?.latestAttempt;
  if (!request || !attempt) return null;
  const now = new Date().toISOString();
  request.status = update.request;
  request.version += 1;
  const reasons: Partial<Record<wire.PaymentAttempt["status"], wire.PaymentAttempt["reason"]>> = {
    unknown: "lost_response",
    confirmed: "provider_success",
    failed: "provider_failure",
    pending: "accepted",
    submitting: "submission_started",
  };
  request.latestAttempt = {
    ...attempt,
    status: update.attempt,
    reason: reasons[update.attempt] ?? "queued",
    receipt: update.receipt ?? attempt.receipt,
    resultCode: update.resultCode ?? attempt.resultCode,
    resultDesc: update.resultDesc ?? attempt.resultDesc,
    submittedAt: attempt.submittedAt ?? now,
    finalizedAt: ["confirmed", "failed"].includes(update.attempt) ? now : null,
  };
  if (update.request !== "uncertain") return null;
  const existing = s.extraCases.find((entry) => entry.requestId === id);
  if (existing) return existing.id;
  const opened: wire.ReconciliationCase = {
    ...s.reconciliation,
    id: randomUUID(),
    openedAt: now,
    requestId: id,
    attemptId: attempt.id,
    amountMinor: request.amountMinor,
    status: "open",
    resolution: null,
    resolutionNote: null,
    resolvedAt: null,
    resolvedBy: null,
    version: 1,
  };
  s.extraCases.push(opened);
  return opened.id;
}

type Deps = {
  permissions: readonly string[];
  tenantWide: boolean;
  stepUp: () => void;
  key: string | undefined;
  fail: (status: number, code: string) => Error;
  parse: <T>(schema: z.ZodType<T>, body: unknown) => T;
};
type Reply = { body: unknown; schema: z.ZodType; status?: number };

export function handlePayments(
  d: Deps,
  state: object,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): Reply | null {
  if (!path.startsWith("/payments")) return null;
  const allow = (permission: string) => {
    if (!d.tenantWide || !d.permissions.includes(permission)) throw d.fail(403, "forbidden");
  };
  allow(
    path.startsWith("/payments/settings") && d.permissions.includes("payments.manage_credentials")
      ? "payments.manage_credentials"
      : "payments.view",
  );
  const s = fixtureFor(state);
  const reply = (schema: z.ZodType, result: unknown): Reply => ({ schema, body: result });
  const detail = (request: wire.PaymentRequestSummary): wire.PaymentRequestDetailResponse => ({
    request,
    attempts: request.latestAttempt ? [request.latestAttempt] : [],
    timeline: s.timeline,
    callbacks: [],
    cases: [
      ...(request.id === PAYMENT_REQUEST_ID ? [s.reconciliation] : []),
      ...s.extraCases.filter((entry) => entry.requestId === request.id),
    ],
    queries: s.queries,
    transactions: [],
    canReverse: false,
    canQueryStatus: d.permissions.includes("payments.review"),
  });
  const settings = () =>
    reply(wire.paymentSettingsResponseSchema, {
      configured: true,
      settings: s.settings,
      canManage: d.permissions.includes("payments.manage_credentials"),
      canPause: d.permissions.includes("payments.review"),
    });
  const page = <T,>(items: T[], status: (item: T) => string) =>
    items
      .filter((i) => !query.get("status") || status(i) === query.get("status"))
      .slice(
        Number(query.get("offset") ?? 0),
        Number(query.get("offset") ?? 0) + Number(query.get("limit") ?? 25),
      );
  if (path === "/payments/overview")
    return reply(wire.paymentsOverviewResponseSchema, {
      configured: true,
      environment: s.settings.environment,
      payoutsEnabled: s.settings.payoutsEnabled,
      counts: {
        inProgress: s.requests.length - 1,
        uncertain: 1,
        confirmed: 0,
        failed: 0,
        openCases: 1,
        quarantinedCallbacks: s.callback.status === "quarantined" ? 1 : 0,
        receivedCallbacks: 0,
        pendingOutbox: 0,
      },
      oldestUncertainAt: at,
      latestBalance: null,
      receipts: [],
      permissions: {
        view: true,
        review: d.permissions.includes("payments.review"),
        manageCredentials: d.permissions.includes("payments.manage_credentials"),
        initiateTest: d.permissions.includes("payments.initiate_test"),
        reverse: d.permissions.includes("payments.reverse"),
      },
    });
  if (path === "/payments/settings" && method === "GET") return settings();
  if (path === "/payments/settings" && method === "PUT") {
    allow("payments.manage_credentials");
    d.stepUp();
    const input = d.parse(wire.updatePaymentSettingsRequestSchema, body);
    if (input.version !== s.settings.version) throw d.fail(409, "version-conflict");
    if (input.environment === "production") throw d.fail(409, "production-not-enabled");
    Object.assign(s.settings, input, { version: s.settings.version + 1 });
    return settings();
  }
  if (path === "/payments/settings/credentials") {
    allow("payments.manage_credentials");
    d.stepUp();
    const input = d.parse(wire.updatePaymentCredentialsRequestSchema, body);
    if (input.version !== s.settings.version) throw d.fail(409, "version-conflict");
    // Keep only field status, never secret values.
    for (const k of PAYMENT_SECRET_FIELDS)
      if (input[k]) s.settings.secrets[k] = { configured: true, updatedAt: at };
    s.settings.version++;
    return settings();
  }
  if (path === "/payments/requests" && method === "GET")
    return reply(wire.paymentRequestsResponseSchema, {
      requests: page(s.requests, (r) => r.status),
      total: s.requests.filter((r) => !query.get("status") || r.status === query.get("status"))
        .length,
    });
  if (path === "/payments/requests" && method === "POST") {
    allow("payments.initiate_test");
    if (!d.key) throw d.fail(400, "idempotency-key-required");
    const old = s.keys.get(d.key);
    if (old) return reply(wire.paymentRequestResponseSchema, { request: old });
    const input = d.parse(wire.createTestPaymentRequestSchema, body);
    const request: wire.PaymentRequestSummary = {
      ...s.requests[0]!,
      id: randomUUID(),
      reference: `PAY-TEST-${s.requests.length + 1}`,
      kind: input.kind,
      amountMinor: input.amountMinor,
      status: "in_progress",
      latestAttempt: {
        ...s.requests[0]!.latestAttempt!,
        id: randomUUID(),
        kind: input.kind,
        status: "queued",
        reason: "queued",
        amountMinor: input.amountMinor,
      },
    };
    s.requests.push(request);
    s.keys.set(d.key, request);
    return reply(wire.paymentRequestResponseSchema, { request });
  }
  const request = /^\/payments\/requests\/([^/]+)$/.exec(path);
  if (request) {
    const found = s.requests.find((r) => r.id === request[1]);
    if (!found) throw d.fail(404, "not-found");
    return reply(wire.paymentRequestDetailResponseSchema, detail(found));
  }
  if (/\/attempts\/[^/]+\/status-query$/.test(path)) {
    allow("payments.review");
    s.queries.push({
      id: randomUUID(),
      kind: "stk_query",
      status: "sent",
      attemptId: s.requests[0]!.latestAttempt!.id,
      resultCode: null,
      summary: null,
      createdAt: at,
      answeredAt: null,
    });
    return reply(wire.paymentRequestDetailResponseSchema, detail(s.requests[0]!));
  }
  if (path === "/payments/callbacks")
    return reply(wire.paymentCallbacksResponseSchema, {
      callbacks: page([s.callback], (c) => c.status),
      total: 1,
      openAlerts: s.callback.status === "quarantined" ? 1 : 0,
    });
  if (path === `/payments/callbacks/${PAYMENT_CALLBACK_ID}/review`) {
    allow("payments.review");
    d.stepUp();
    const input = d.parse(wire.reviewCallbackRequestSchema, body);
    if (input.version !== s.callback.version) throw d.fail(409, "version-conflict");
    s.callback.status = input.decision;
    s.callback.version++;
    s.callback.review = { decision: input.decision, reason: input.reason, at, by: actor };
    return reply(wire.paymentCallbackResponseSchema, { callback: s.callback, canReview: false });
  }
  if (path === `/payments/callbacks/${PAYMENT_CALLBACK_ID}`)
    return reply(wire.paymentCallbackResponseSchema, {
      callback: s.callback,
      canReview: d.permissions.includes("payments.review") && s.callback.status === "quarantined",
    });
  if (path === "/payments/cases") {
    const cases = [s.reconciliation, ...s.extraCases];
    return reply(wire.reconciliationCasesResponseSchema, {
      cases: page(cases, (c) => c.status),
      total: cases.filter((c) => !query.get("status") || c.status === query.get("status")).length,
      open: cases.filter((c) => c.status === "open").length,
    });
  }
  const extraCase = /^\/payments\/cases\/([^/]+)$/.exec(path);
  const opened = extraCase ? s.extraCases.find((entry) => entry.id === extraCase[1]) : undefined;
  if (opened && method === "GET")
    return reply(wire.reconciliationCaseResponseSchema, {
      case: { ...opened, canResolve: false },
      timeline: [],
    });
  if (path === `/payments/cases/${PAYMENT_CASE_ID}/resolve`) {
    allow("payments.review");
    d.stepUp();
    const input = d.parse(wire.resolveCaseRequestSchema, body);
    if (input.version !== s.reconciliation.version) throw d.fail(409, "version-conflict");
    if (
      input.resolution === "confirmed" &&
      (input.receipt !== "MOCKRECEIPT1" || input.amountMinor !== 10000)
    )
      throw d.fail(409, "evidence-mismatch");
    s.reconciliation.resolution = input.resolution;
    s.reconciliation.resolutionNote = input.reason;
    s.reconciliation.status = "resolved";
    s.reconciliation.canResolve = false;
    s.reconciliation.version++;
    return reply(wire.reconciliationCaseResponseSchema, {
      case: s.reconciliation,
      timeline: s.timeline,
    });
  }
  if (path === `/payments/cases/${PAYMENT_CASE_ID}`)
    return reply(wire.reconciliationCaseResponseSchema, {
      case: {
        ...s.reconciliation,
        canResolve: d.permissions.includes("payments.review") && s.reconciliation.status === "open",
      },
      timeline: s.timeline,
    });
  throw d.fail(404, "not-found");
}
