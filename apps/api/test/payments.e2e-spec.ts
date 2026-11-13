import { createHash } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMockDaraja, type MockDaraja } from "@pm-buddy/mock-daraja";
import { PAYMENT_ATTEMPT_STATUSES, PAYMENT_ATTEMPT_TRANSITIONS } from "@pm-buddy/types";
import {
  paymentCallbackResponseSchema,
  paymentCallbacksResponseSchema,
  paymentRequestDetailResponseSchema,
  paymentRequestResponseSchema,
  paymentSettingsResponseSchema,
  paymentsOverviewResponseSchema,
  reconciliationCaseResponseSchema,
  reconciliationCasesResponseSchema,
  balanceCheckResponseSchema,
  type PaymentRequestDetailResponse,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import type { Prisma } from "../src/generated/prisma/client.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { CallbackIntake } from "../src/modules/payments/callback-intake.js";
import { PaymentsRelay } from "../src/modules/payments/payments-relay.js";
import { PaymentsRuntime } from "../src/modules/payments/payments-runtime.js";
import { CertificateStore } from "../src/modules/payments/provider/security-credential.js";
import { Browser, notifications } from "./support.js";

/**
 * D4.2 integration suite: the real API, its outbox relay and BullMQ workers (Valkey), PostgreSQL
 * under the restricted runtime role, and the local mock Daraja server on an ephemeral port that
 * calls the API back over HTTP. Every scenario selects its behaviour with a magic amount
 * (apps/mock-daraja/README.md). No Safaricom endpoint is ever contacted.
 */
const SECRETS = {
  consumerKey: "mock-consumer-key-e2e-7d1a",
  consumerSecret: "mock-consumer-secret-e2e-91f3",
  initiatorName: "mockinitiator",
  initiatorPassword: "Mock#Initiator$2026",
  passkey: "mock-passkey-e2e-bfb279f9aa9bdbcf158e97dd71a467cd",
};
const SHORTCODES = {
  stkShortcode: "174379",
  stkPartyB: null,
  stkTransactionType: "CustomerPayBillOnline",
  c2bShortcode: "600966",
  b2cShortcode: "600992",
  b2bShortcode: "600993",
};
const LIMITS = {
  stkMaxMinor: 25_000_000,
  b2cMinMinor: 1_000,
  b2cMaxMinor: 25_000_000,
  b2bMaxMinor: 25_000_000,
  dailyPayoutMaxMinor: 2_000_000_000,
};
const PHONE = "0708374149";

describe("Payments and the Daraja integration (real runtime role, workers and mock server)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let runtime: PaymentsRuntime;
  let relay: PaymentsRelay;
  let mock: MockDaraja;
  let owner: Browser;
  let ownerB: Browser;
  let finance: Browser;
  let manager: Browser;
  let tenantA: string;
  let tenantB: string;
  let callbackBase = "";
  let keySeq = 0;

  const key = () => `e2e-pay-${Date.now()}-${(keySeq += 1)}`;
  const problem = (res: request.Response) => (res.body as { code?: string }).code;
  const fresh = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
  const stale = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) },
    });
  const as = (browser: Browser, tenantId: string) => ({
    userId: browser.auth.user.id,
    tenantId,
    requestId: `e2e-${Date.now()}`,
  });
  const readA = <T>(query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    db.run(as(owner, tenantA), query);
  const settingsVersion = async (browser: Browser) =>
    paymentSettingsResponseSchema.parse((await browser.call("get", "payments/settings")).body)
      .settings!.version;
  const detail = async (browser: Browser, requestId: string) => {
    const res = await browser.call("get", `payments/requests/${requestId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return paymentRequestDetailResponseSchema.parse(res.body);
  };
  /** Polls the request until `done` holds (the workers and callbacks are asynchronous). */
  const waitFor = async (
    browser: Browser,
    requestId: string,
    done: (view: PaymentRequestDetailResponse) => boolean,
    timeoutMs = 15_000,
  ) => {
    const start = Date.now();
    let view = await detail(browser, requestId);
    while (!done(view)) {
      if (Date.now() - start > timeoutMs)
        throw new Error(
          `Timed out; request ${requestId} is ${JSON.stringify({ status: view.request.status, attempts: view.attempts.map((a) => [a.kind, a.status, a.reason]) })}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 150));
      view = await detail(browser, requestId);
    }
    return view;
  };
  const latest = (view: PaymentRequestDetailResponse) =>
    view.attempts.filter((attempt) => attempt.kind !== "reversal").at(-1)!;
  const create = async (browser: Browser, body: Record<string, unknown>, idempotencyKey = key()) =>
    browser.call("post", "payments/requests", body, true, { "Idempotency-Key": idempotencyKey });
  const stk = (amountShillings: number, extra: Record<string, unknown> = {}) => ({
    kind: "stk_push",
    amountMinor: amountShillings * 100,
    phone: PHONE,
    accountReference: "TEST-INV",
    ...extra,
  });
  const b2c = (amountShillings: number) => ({
    kind: "b2c",
    amountMinor: amountShillings * 100,
    phone: PHONE,
    command: "BusinessPayment",
    remarks: "Test payout",
  });
  const createdId = (res: request.Response) => {
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return paymentRequestResponseSchema.parse(res.body).request.id;
  };
  const callbackUrl = async (kind: string) => {
    const token = await readA(async (tx) => {
      const route = await tx.paymentCallbackRoute.findFirstOrThrow({
        where: { tenantId: tenantA, status: "active" },
      });
      return route.id;
    });
    const settings = paymentSettingsResponseSchema.parse(
      (await owner.call("get", "payments/settings")).body,
    );
    const url = settings.settings!.callbackUrls.find((entry) => entry.kind === kind)!.url;
    expect(token).toBeTruthy();
    return url.replace(callbackBase, "");
  };
  const postCallback = (path: string, body: string, type = "application/json") =>
    request(app.getHttpServer()).post(path).set("Content-Type", type).send(body);
  const auditEvents = () =>
    readA((tx) =>
      tx.auditEvent.findMany({
        where: { tenantId: tenantA },
        select: { action: true, metadata: true },
      }),
    );

  const join = async (member: Browser, role: string) => {
    await fresh(owner);
    const invited = await owner.call("post", "tenants/current/invitations", {
      identifier: member.identifier,
      role,
      projectIds: [],
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    const token = notifications
      .get(member.identifier)
      ?.at(-1)
      ?.text.match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
    expect((await member.call("post", "tenants/invitations/accept", { token })).status).toBe(200);
    expect((await member.call("post", `tenants/${tenantA}/select`, {})).status).toBe(200);
  };

  beforeAll(async () => {
    mock = await startMockDaraja({
      callbackDelayMs: 60,
      responseDelayMs: 2_400,
      callbackRetries: 3,
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    runtime = app.get(PaymentsRuntime);
    runtime.mockBaseUrl = mock.url;
    runtime.httpTimeoutMs = 1_200;
    runtime.leaseSeconds = 8;
    runtime.resultTimeoutSeconds = 2;
    runtime.statusQueryIntervalSeconds = 1;
    runtime.statusQueryMax = 3;
    runtime.relayIntervalMs = 150;
    runtime.workersEnabled = true;
    await app.listen(0, "127.0.0.1");
    callbackBase = `http://127.0.0.1:${((app.getHttpServer() as unknown as Server).address() as AddressInfo).port}`;
    runtime.callbackBaseUrl = callbackBase;
    prisma = app.get(PrismaService);
    db = app.get(TenantDatabase);
    relay = app.get(PaymentsRelay);
    vi.spyOn(app.get(AuthSecurity), "notify").mockImplementation(
      async (identifier, subject, text) => {
        notifications.set(identifier, [
          ...(notifications.get(identifier) ?? []),
          { subject, text },
        ]);
      },
    );
    owner = new Browser(app);
    ownerB = new Browser(app);
    finance = new Browser(app);
    manager = new Browser(app);
    for (const browser of [owner, ownerB, finance]) {
      await browser.register();
      await browser.enroll();
    }
    await manager.register();
    const a = await owner.call("post", "tenants", { name: "Payments company A" });
    const b = await ownerB.call("post", "tenants", { name: "Payments company B" });
    expect([a.status, b.status]).toEqual([201, 201]);
    tenantA = (a.body as { tenant: { id: string } }).tenant.id;
    tenantB = (b.body as { tenant: { id: string } }).tenant.id;
    await join(finance, "finance");
    await join(manager, "project_manager");
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await mock?.close();
  });

  it("documents every payments operation in OpenAPI and keeps the callback endpoint out", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const paths = (
      openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }
    ).paths;
    const operations = Object.values(paths).flatMap((path) =>
      Object.values(path).map((operation) => operation.operationId),
    );
    for (const id of [
      "getPaymentsOverview",
      "getPaymentSettings",
      "initialisePaymentSettings",
      "updatePaymentSettings",
      "updatePaymentCredentials",
      "setPayoutSwitch",
      "rotatePaymentCallbackToken",
      "registerC2bUrls",
      "requestBalanceCheck",
      "listPaymentRequests",
      "createTestPaymentRequest",
      "getPaymentRequest",
      "requestPaymentReversal",
      "queryPaymentStatus",
      "listPaymentCallbacks",
      "getPaymentCallback",
      "reviewPaymentCallback",
      "listReconciliationCases",
      "getReconciliationCase",
      "resolveReconciliationCase",
    ])
      expect(operations, id).toContain(id);
    expect(Object.keys(paths).some((path) => path.includes("hooks"))).toBe(false);
  });

  it("guards the settings: permissions, fresh step-up, production refused, write-only secrets", async () => {
    // Finance can read but not configure; a project manager is not company-wide.
    const unconfigured = paymentSettingsResponseSchema.parse(
      (await finance.call("get", "payments/settings")).body,
    );
    expect(unconfigured).toMatchObject({ configured: false, canManage: false, canPause: true });
    expect((await finance.call("post", "payments/settings", {})).status).toBe(403);
    expect((await manager.call("get", "payments/overview")).status).toBe(403);
    await stale(owner);
    const staleRes = await owner.call("post", "payments/settings", {});
    expect([staleRes.status, problem(staleRes)]).toEqual([403, "step-up-required"]);
    await fresh(owner);
    const initialised = await owner.call("post", "payments/settings", {});
    expect(initialised.status, JSON.stringify(initialised.body)).toBe(201);
    const settings = paymentSettingsResponseSchema.parse(initialised.body).settings!;
    expect(settings).toMatchObject({
      environment: "mock",
      payoutsEnabled: false,
      limitsStatus: "demo",
      productionEnabled: false,
    });
    expect(settings.callbackUrls).toHaveLength(9);
    expect(settings.callbackUrls[0]!.url).toMatch(/\/api\/v1\/payments\/hooks\/[0-9a-f]{64}\/stk$/);
    expect(Object.values(settings.secrets).every((secret) => !secret.configured)).toBe(true);

    const production = await owner.call("put", "payments/settings", {
      version: settings.version,
      environment: "production",
      shortcodes: SHORTCODES,
      limits: LIMITS,
    });
    expect([production.status, problem(production)]).toEqual([409, "production-not-enabled"]);
    const updated = await owner.call("put", "payments/settings", {
      version: settings.version,
      environment: "mock",
      shortcodes: SHORTCODES,
      limits: LIMITS,
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const version = paymentSettingsResponseSchema.parse(updated.body).settings!.version;
    expect(
      (
        await owner.call("put", "payments/settings", {
          version: settings.version,
          environment: "mock",
          shortcodes: SHORTCODES,
          limits: LIMITS,
        })
      ).status,
    ).toBe(409);

    // Credentials: manage permission and a fresh step-up; never echoed.
    expect(
      (await finance.call("put", "payments/settings/credentials", { version, ...SECRETS })).status,
    ).toBe(403);
    await stale(owner);
    expect(
      problem(await owner.call("put", "payments/settings/credentials", { version, ...SECRETS })),
    ).toBe("step-up-required");
    await fresh(owner);
    const credentials = await owner.call("put", "payments/settings/credentials", {
      version,
      ...SECRETS,
    });
    expect(credentials.status, JSON.stringify(credentials.body)).toBe(200);
    const text = JSON.stringify(credentials.body);
    for (const value of Object.values(SECRETS)) expect(text).not.toContain(value);
    expect(
      Object.values(paymentSettingsResponseSchema.parse(credentials.body).settings!.secrets).every(
        (secret) => secret.configured,
      ),
    ).toBe(true);

    // Finance sees masked callback URLs; the stored values are ciphertext.
    const financeView = paymentSettingsResponseSchema.parse(
      (await finance.call("get", "payments/settings")).body,
    );
    expect(
      financeView.settings!.callbackUrls.every((entry) => entry.url.includes("hooks/••••")),
    ).toBe(true);
    const row = await readA((tx) =>
      tx.paymentSettings.findUniqueOrThrow({ where: { tenantId: tenantA } }),
    );
    for (const [field, value] of Object.entries(SECRETS)) {
      const stored = Buffer.from(row[`${field}Enc` as "consumerKeyEnc"]!).toString("latin1");
      expect(stored, field).not.toContain(value);
    }
    const audit = await auditEvents();
    const changed = audit.find((event) => event.action === "payments.credentials_changed");
    expect(changed?.metadata).toEqual({
      fields: ["consumerKey", "consumerSecret", "initiatorName", "initiatorPassword", "passkey"],
    });
    const allAudit = JSON.stringify(audit);
    for (const value of Object.values(SECRETS)) expect(allAudit).not.toContain(value);
  });

  it("collects with STK Push end to end: queued → submitting → pending → confirmed only on the verified callback", async () => {
    const idempotencyKey = key();
    const res = await create(finance, stk(250), idempotencyKey);
    const id = createdId(res);
    const created = paymentRequestResponseSchema.parse(res.body).request;
    expect(created.status).toBe("in_progress");
    expect(created.latestAttempt?.status).toBe("queued");
    expect(created.counterparty).toBe("2547•••••149");
    // Same key and payload: the stored response; another payload: refused; no key: refused.
    const replay = await create(finance, stk(250), idempotencyKey);
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(paymentRequestResponseSchema.parse(replay.body).request.id).toBe(id);
    expect(problem(await create(finance, stk(251), idempotencyKey))).toBe("idempotency-key-reused");
    const noKey = await finance.call("post", "payments/requests", stk(250));
    expect([noKey.status, problem(noKey)]).toEqual([400, "idempotency-key-required"]);

    const view = await waitFor(finance, id, (current) => current.request.status === "confirmed");
    const attempt = latest(view);
    expect(attempt.receipt).toMatch(/^T[A-Z0-9]{9}$/);
    expect(attempt.providerIds.checkoutRequestId).toMatch(/^ws_CO_/);
    const transitions = view.timeline
      .filter((event) => event.subjectType === "attempt" && event.toStatus)
      .map((event) => event.toStatus);
    expect(transitions).toEqual(["created", "queued", "submitting", "pending", "confirmed"]);
    expect(view.callbacks).toHaveLength(1);
    expect(view.callbacks[0]).toMatchObject({ kind: "stk", status: "processed" });
    expect(JSON.stringify(view.callbacks[0]!.redactedBody)).not.toContain("254708374149");
    expect(view.transactions).toHaveLength(1);
    expect(view.transactions[0]).toMatchObject({
      kind: "stk",
      direction: "in",
      status: "matched",
      amountMinor: 25_000,
    });
    expect(
      mock.requests.filter((entry) => entry.path === "/mpesa/stkpush/v1/processrequest"),
    ).toHaveLength(1);
  });

  it("holds payouts while the master switch is off, then pays; failures and insufficient balance fail definitively", async () => {
    const id = createdId(await create(finance, b2c(250)));
    await new Promise((resolve) => setTimeout(resolve, 900));
    let view = await detail(finance, id);
    expect(latest(view).status).toBe("queued");
    expect(
      mock.requests.some(
        (entry) =>
          (entry.body as { OriginatorConversationID?: string })?.OriginatorConversationID ===
          latest(view).id,
      ),
    ).toBe(false);
    // Pausing needs no step-up; enabling needs manage_credentials and a fresh step-up.
    expect(
      (
        await finance.call("put", "payments/settings/payouts", {
          version: await settingsVersion(owner),
          enabled: true,
          reason: "Finance cannot enable payouts",
        })
      ).status,
    ).toBe(403);
    await stale(owner);
    expect(
      problem(
        await owner.call("put", "payments/settings/payouts", {
          version: await settingsVersion(owner),
          enabled: true,
          reason: "Turning on payouts for the mock run",
        }),
      ),
    ).toBe("step-up-required");
    await fresh(owner);
    const enabled = await owner.call("put", "payments/settings/payouts", {
      version: await settingsVersion(owner),
      enabled: true,
      reason: "Turning on payouts for the mock run",
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    view = await waitFor(finance, id, (current) => current.request.status === "confirmed");
    expect(latest(view).providerIds.originatorConversationId).toBe(latest(view).id);
    expect(view.transactions[0]).toMatchObject({
      kind: "b2c",
      direction: "out",
      amountMinor: 25_000,
    });

    const failed = await waitFor(
      finance,
      createdId(await create(finance, b2c(1001))),
      (current) => current.request.status === "failed",
    );
    expect(latest(failed)).toMatchObject({
      status: "failed",
      reason: "provider_failure",
      resultCode: "2040",
    });
    const broke = await waitFor(
      finance,
      createdId(await create(finance, b2c(1002))),
      (current) => current.request.status === "failed",
    );
    expect(latest(broke).resultCode).toBe("1");
    expect(broke.transactions).toHaveLength(0);
  });

  it("reconciles a lost result: pending → unknown → Transaction Status → confirmed or failed, never resubmitted", async () => {
    const completed = await waitFor(
      finance,
      createdId(await create(finance, b2c(1003))),
      (current) => current.request.status === "confirmed",
      20_000,
    );
    const attempt = latest(completed);
    expect(attempt.reason).toBe("status_query_success");
    const steps = completed.timeline
      .filter((event) => event.subjectType === "attempt" && event.toStatus)
      .map((event) => [event.toStatus, event.reason]);
    expect(steps).toEqual([
      ["created", "created"],
      ["queued", "queued"],
      ["submitting", "submission_started"],
      ["pending", "accepted"],
      ["unknown", "result_overdue"],
      ["confirmed", "status_query_success"],
    ]);
    expect(completed.cases).toHaveLength(1);
    expect(completed.cases[0]).toMatchObject({
      kind: "unknown_outcome",
      status: "resolved",
      resolution: "confirmed",
    });
    expect(
      completed.queries.some(
        (query) => query.kind === "transaction_status" && query.status === "answered",
      ),
    ).toBe(true);
    const submitted = mock.requests.filter(
      (entry) =>
        (entry.body as { OriginatorConversationID?: string })?.OriginatorConversationID ===
        attempt.id,
    );
    expect(submitted).toHaveLength(1);

    const failed = await waitFor(
      finance,
      createdId(await create(finance, b2c(1004))),
      (current) => current.request.status === "failed",
      20_000,
    );
    expect(latest(failed).reason).toBe("status_query_failure");
    expect(failed.cases[0]).toMatchObject({ kind: "unknown_outcome", resolution: "failed" });
  });

  it("treats a timeout or a result before the acknowledgement as uncertain, then confirms on the verified result", async () => {
    // The HTTP response never arrives in time: unknown (timeout), then the late callback confirms.
    const lost = await waitFor(
      finance,
      createdId(await create(finance, b2c(1005))),
      (current) => current.request.status === "confirmed",
      20_000,
    );
    const lostSteps = lost.timeline
      .filter((event) => event.subjectType === "attempt" && event.toStatus)
      .map((event) => event.reason);
    expect(lostSteps.slice(0, 4)).toEqual(["created", "queued", "submission_started", "timeout"]);
    // Whichever evidence arrives first (the late callback or the status answer) confirms; the other
    // is then processed as the same evidence.
    expect(["provider_success", "status_query_success"]).toContain(lostSteps[4]);
    expect(lostSteps).toHaveLength(5);
    const settled = await waitFor(
      finance,
      lost.request.id,
      (current) =>
        current.callbacks.some(
          (callback) => callback.kind === "b2c_result" && callback.status === "processed",
        ),
      10_000,
    );
    expect(settled.transactions).toHaveLength(1);
    // The callback beats the (delayed) acknowledgement: routed through unknown, then confirmed.
    const early = await waitFor(
      finance,
      createdId(await create(finance, b2c(1014))),
      (current) => current.request.status === "confirmed",
      20_000,
    );
    const earlySteps = early.timeline
      .filter((event) => event.subjectType === "attempt" && event.toStatus)
      .map((event) => event.reason);
    expect(earlySteps).toEqual([
      "created",
      "queued",
      "submission_started",
      "result_before_acceptance",
      "provider_success",
    ]);
    await waitFor(
      finance,
      early.request.id,
      (current) => current.timeline.some((event) => event.event === "attempt.late_acknowledgement"),
      10_000,
    );
    for (const view of [lost, early])
      expect(
        mock.requests.filter(
          (entry) =>
            (entry.body as { OriginatorConversationID?: string })?.OriginatorConversationID ===
            latest(view).id,
        ),
      ).toHaveLength(1);
  });

  it("processes duplicate and out-of-order callbacks once and never regresses a confirmed payment", async () => {
    const duplicate = await waitFor(
      finance,
      createdId(await create(finance, b2c(1006))),
      (current) => current.request.status === "confirmed" && current.callbacks[0]?.duplicates === 1,
      15_000,
    );
    expect(duplicate.callbacks).toHaveLength(1);
    expect(duplicate.transactions).toHaveLength(1);
    // Success, then a late queue-timeout notification: no change.
    const late = await waitFor(
      finance,
      createdId(await create(finance, b2c(1007))),
      (current) =>
        current.callbacks.length === 2 &&
        current.callbacks.every((callback) => callback.status === "processed"),
      15_000,
    );
    expect(latest(late).status).toBe("confirmed");
    expect(late.callbacks.map((callback) => callback.kind).sort()).toEqual([
      "b2c_result",
      "timeout",
    ]);
    // Success, then a definitive failure for the same request: a dispute, the payment stays confirmed.
    const conflict = await waitFor(
      finance,
      createdId(await create(finance, b2c(1008))),
      (current) => current.callbacks.some((callback) => callback.status === "quarantined"),
      15_000,
    );
    expect(latest(conflict).status).toBe("confirmed");
    expect(
      conflict.callbacks.find((callback) => callback.status === "quarantined")?.quarantineReason,
    ).toBe("conflicting_result");
    expect(
      conflict.cases.some((item) => item.kind === "conflicting_evidence" && item.status === "open"),
    ).toBe(true);
    // A ResultType 1 interim message, then the final result.
    const interim = await waitFor(
      finance,
      createdId(await create(finance, b2c(1013))),
      (current) => current.request.status === "confirmed" && current.callbacks.length === 2,
      15_000,
    );
    expect(interim.callbacks.every((callback) => callback.status === "processed")).toBe(true);
    // An STK result delivered twice with different bytes: same evidence, no second receipt.
    const stkLate = await waitFor(
      finance,
      createdId(await create(finance, stk(1007))),
      (current) =>
        current.callbacks.length === 2 &&
        current.callbacks.every((callback) => callback.status === "processed"),
      15_000,
    );
    expect(stkLate.transactions).toHaveLength(1);
  });

  it("quarantines unknown and mismatched callbacks, raises an alert and lets a distinct reviewer close them", async () => {
    const before = paymentsOverviewResponseSchema.parse(
      (await finance.call("get", "payments/overview")).body,
    ).counts.quarantinedCallbacks;
    const view = await waitFor(
      finance,
      createdId(await create(owner, b2c(1009))),
      (current) => current.request.status === "confirmed",
      15_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    const callbacks = paymentCallbacksResponseSchema.parse(
      (await finance.call("get", "payments/callbacks?status=quarantined")).body,
    );
    const stranger = callbacks.callbacks.find(
      (callback) => callback.quarantineReason === "unknown_request" && callback.attemptId === null,
    );
    expect(
      stranger,
      JSON.stringify(callbacks.callbacks.map((c) => c.quarantineReason)),
    ).toBeDefined();
    expect(callbacks.openAlerts).toBeGreaterThan(before);
    expect(view.callbacks).toHaveLength(1);
    // A hand-made callback for identifiers nobody stored is quarantined too.
    const forged = await postCallback(
      await callbackUrl("b2c_result"),
      JSON.stringify({
        Result: {
          ResultType: 0,
          ResultCode: 0,
          OriginatorConversationID: "forged-1",
          ConversationID: "AG_forged",
          TransactionID: "FORGED0001",
          ResultParameters: {
            ResultParameter: [
              { Key: "TransactionAmount", Value: 999999 },
              { Key: "TransactionReceipt", Value: "FORGED0001" },
            ],
          },
        },
      }),
    );
    expect(forged.status).toBe(200);
    // Review: step-up required; the reason is kept, the audit does not carry it.
    const detailRes = paymentCallbackResponseSchema.parse(
      (await finance.call("get", `payments/callbacks/${stranger!.id}`)).body,
    );
    expect(detailRes.canReview).toBe(true);
    await stale(finance);
    expect(
      problem(
        await finance.call("post", `payments/callbacks/${stranger!.id}/review`, {
          version: stranger!.version,
          decision: "dismissed",
          reason: "Provider test noise, no payment",
        }),
      ),
    ).toBe("step-up-required");
    await fresh(finance);
    const reviewed = await finance.call("post", `payments/callbacks/${stranger!.id}/review`, {
      version: stranger!.version,
      decision: "dismissed",
      reason: "Provider test noise, no payment",
    });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    expect(paymentCallbackResponseSchema.parse(reviewed.body).callback).toMatchObject({
      status: "dismissed",
      review: { decision: "dismissed" },
    });
    const cases = reconciliationCasesResponseSchema.parse(
      (await finance.call("get", "payments/cases")).body,
    ).cases;
    expect(cases.find((item) => item.callbackId === stranger!.id)).toMatchObject({
      status: "dismissed",
      resolution: "dismissed",
    });
    expect(JSON.stringify(await auditEvents())).not.toContain("Provider test noise");

    // An amount that disagrees: quarantined; the status query later confirms the true amount.
    const mismatch = await waitFor(
      finance,
      createdId(await create(finance, b2c(1010))),
      (current) => current.request.status === "confirmed",
      25_000,
    );
    expect(mismatch.callbacks.find((callback) => callback.kind === "b2c_result")).toMatchObject({
      status: "quarantined",
      quarantineReason: "amount_mismatch",
    });
    expect(latest(mismatch).reason).toBe("status_query_success");
  });

  it("hardens the callback endpoint: unknown tokens, types, sizes, malformed bodies and failed persistence", async () => {
    const stkPath = await callbackUrl("stk");
    expect(
      (await postCallback(stkPath.replace(/hooks\/[0-9a-f]{64}/, `hooks/${"a".repeat(64)}`), "{}"))
        .status,
    ).toBe(404);
    expect((await postCallback(stkPath.replace(/\/stk$/, "/steal"), "{}")).status).toBe(404);
    expect((await postCallback(stkPath, "{}", "text/plain")).status).toBe(415);
    expect((await postCallback(stkPath, JSON.stringify({ pad: "x".repeat(40_000) }))).status).toBe(
      413,
    );
    // No cookie, Origin or CSRF token is needed (server to server) and none is used.
    const malformed = await postCallback(stkPath, "{not json");
    expect(malformed.status).toBe(200);
    expect(malformed.body).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
    // Persistence fails: non-success, nothing stored; the redelivery is accepted.
    const intake = app.get(CallbackIntake) as unknown as { persist: () => Promise<unknown> };
    const spy = vi
      .spyOn(intake, "persist")
      .mockRejectedValueOnce(new Error("database unavailable"));
    const body = JSON.stringify({
      Body: {
        stkCallback: {
          MerchantRequestID: "m-down",
          CheckoutRequestID: "ws_CO_down",
          ResultCode: 1032,
          ResultDesc: "Request cancelled by user",
        },
      },
    });
    const down = await postCallback(stkPath, body);
    expect(down.status).toBe(503);
    spy.mockRestore();
    const stored = await readA((tx) =>
      tx.paymentCallbackInbox.count({
        where: { tenantId: tenantA, bodySha256: createHash("sha256").update(body).digest("hex") },
      }),
    );
    expect(stored).toBe(0);
    expect((await postCallback(stkPath, body)).status).toBe(200);
    const again = await postCallback(stkPath, body);
    expect(again.status).toBe(200);
    const row = await readA((tx) =>
      tx.paymentCallbackInbox.findFirstOrThrow({
        where: { tenantId: tenantA, bodySha256: createHash("sha256").update(body).digest("hex") },
      }),
    );
    expect(row.duplicates).toBe(1);
    expect(Buffer.from(row.bodyEnc).toString("latin1")).not.toContain("ws_CO_down");
    await new Promise((resolve) => setTimeout(resolve, 800));
    const quarantined = paymentCallbacksResponseSchema.parse(
      (await finance.call("get", "payments/callbacks?status=quarantined&kind=stk")).body,
    ).callbacks;
    expect(quarantined.map((callback) => callback.quarantineReason)).toEqual(
      expect.arrayContaining(["malformed", "unknown_request"]),
    );
  });

  it("fails refused submissions and keeps server errors uncertain", async () => {
    const rejected = await waitFor(
      finance,
      createdId(await create(finance, b2c(1011))),
      (current) => current.request.status === "failed",
    );
    expect(latest(rejected)).toMatchObject({ reason: "rejected_by_provider" });
    expect(rejected.cases).toHaveLength(0);
    const serverError = await waitFor(
      finance,
      createdId(await create(finance, stk(1012))),
      (current) => latest(current).status === "unknown",
    );
    expect(latest(serverError).reason).toBe("lost_response");
    expect(serverError.cases[0]).toMatchObject({ kind: "unknown_outcome", status: "open" });
  });

  it("asks for a manual review when STK Query reports success without a receipt, with a distinct reviewer and exact evidence", async () => {
    const id = createdId(await create(owner, stk(1003)));
    const view = await waitFor(
      finance,
      id,
      (current) => current.cases.some((item) => item.kind === "unverified_success"),
      20_000,
    );
    expect(latest(view).status).toBe("unknown");
    const unknownCase = view.cases.find((item) => item.kind === "unknown_outcome")!;
    // The creator may not review; the receipt and amount must match exactly.
    await fresh(owner);
    expect(
      problem(
        await owner.call("post", `payments/cases/${unknownCase.id}/resolve`, {
          version: unknownCase.version,
          resolution: "confirmed",
          reason: "Seen on the M-Pesa statement",
          receipt: "TABCDE1234",
          amountMinor: 100_300,
        }),
      ),
    ).toBe("same-person");
    await fresh(finance);
    expect(
      problem(
        await finance.call("post", `payments/cases/${unknownCase.id}/resolve`, {
          version: unknownCase.version,
          resolution: "dismissed",
          reason: "Trying to dismiss an uncertain payment",
        }),
      ),
    ).toBe("uncertain-attempt");
    expect(
      problem(
        await finance.call("post", `payments/cases/${unknownCase.id}/resolve`, {
          version: unknownCase.version,
          resolution: "confirmed",
          reason: "Seen on the M-Pesa statement",
          receipt: "TABCDE1234",
          amountMinor: 100_200,
        }),
      ),
    ).toBe("evidence-mismatch");
    const resolved = await finance.call("post", `payments/cases/${unknownCase.id}/resolve`, {
      version: unknownCase.version,
      resolution: "confirmed",
      reason: "Seen on the M-Pesa statement",
      receipt: "TABCDE1234",
      amountMinor: 100_300,
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(reconciliationCaseResponseSchema.parse(resolved.body).case).toMatchObject({
      status: "resolved",
      resolution: "confirmed",
    });
    const after = await detail(finance, id);
    expect(latest(after)).toMatchObject({
      status: "confirmed",
      reason: "manual_confirmation",
      receipt: "TABCDE1234",
    });
    expect(after.cases.every((item) => item.status !== "open")).toBe(true);
  });

  it("reverses a confirmed payment through a separate attempt, by someone other than its creator", async () => {
    const confirmed = await waitFor(
      owner,
      createdId(await create(owner, stk(300))),
      (current) => current.request.status === "confirmed",
    );
    const attempt = latest(confirmed);
    await fresh(owner);
    expect(
      problem(
        await owner.call(
          "post",
          `payments/attempts/${attempt.id}/reversal`,
          { version: attempt.version, reason: "Customer paid twice by mistake" },
          true,
          { "Idempotency-Key": key() },
        ),
      ),
    ).toBe("same-person");
    await stale(finance);
    expect(
      problem(
        await finance.call(
          "post",
          `payments/attempts/${attempt.id}/reversal`,
          { version: attempt.version, reason: "Customer paid twice by mistake" },
          true,
          { "Idempotency-Key": key() },
        ),
      ),
    ).toBe("step-up-required");
    await fresh(finance);
    const requested = await finance.call(
      "post",
      `payments/attempts/${attempt.id}/reversal`,
      { version: attempt.version, reason: "Customer paid twice by mistake" },
      true,
      { "Idempotency-Key": key() },
    );
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    expect(latest(paymentRequestDetailResponseSchema.parse(requested.body)).status).toBe(
      "reversal_pending",
    );
    const reversed = await waitFor(
      finance,
      confirmed.request.id,
      (current) => current.request.status === "reversed",
    );
    const reversal = reversed.attempts.find((entry) => entry.kind === "reversal")!;
    expect(reversal).toMatchObject({
      status: "confirmed",
      direction: "out",
      amountMinor: 30_000,
      reversesAttemptId: attempt.id,
    });
    expect(reversed.transactions.map((entry) => entry.kind).sort()).toEqual(["reversal", "stk"]);
    // Nothing can be reversed twice.
    expect(
      problem(
        await finance.call(
          "post",
          `payments/attempts/${attempt.id}/reversal`,
          { version: latest(reversed).version, reason: "Second reversal attempt" },
          true,
          { "Idempotency-Key": key() },
        ),
      ),
    ).toBe("attempt-not-confirmed");
  });

  it("enforces the configured limits and whole shillings", async () => {
    expect(problem(await create(finance, stk(250_001)))).toBe("amount-above-limit");
    expect(problem(await create(finance, { ...b2c(9), amountMinor: 900 }))).toBe(
      "amount-below-minimum",
    );
    expect(problem(await create(finance, { ...stk(10), amountMinor: 1_050 }))).toBe(
      "amount-not-whole-shillings",
    );
    await fresh(owner);
    const version = await settingsVersion(owner);
    const tight = await owner.call("put", "payments/settings", {
      version,
      environment: "mock",
      shortcodes: SHORTCODES,
      limits: { ...LIMITS, dailyPayoutMaxMinor: 100_000 },
    });
    expect(tight.status, JSON.stringify(tight.body)).toBe(200);
    expect(problem(await create(finance, b2c(500)))).toBe("daily-limit-exceeded");
    await fresh(owner);
    expect(
      (
        await owner.call("put", "payments/settings", {
          version: version + 1,
          environment: "mock",
          shortcodes: SHORTCODES,
          limits: LIMITS,
        })
      ).status,
    ).toBe(200);
    // A project manager cannot fire test transactions; finance can.
    expect((await create(manager, stk(250))).status).toBe(403);
  });

  it("registers C2B URLs, records confirmations as unallocated receipts and refuses other shortcodes", async () => {
    await fresh(owner);
    expect((await owner.call("post", "payments/settings/c2b-registration", {})).status).toBe(200);
    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      !mock.requests.some(
        (entry) => entry.path === "/mpesa/c2b/v2/registerurl" && entry.status === 200,
      )
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    const before = mock.callbacks.length;
    const { transId } = await mock.simulateC2b({
      shortCode: "600966",
      amount: 1500,
      billRefNumber: "INV-2026-01",
    });
    await mock.waitForCallbacks(before + 1);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const overview = paymentsOverviewResponseSchema.parse(
      (await finance.call("get", "payments/overview")).body,
    );
    expect(overview.receipts.find((entry) => entry.receipt === transId)).toMatchObject({
      kind: "c2b",
      direction: "in",
      status: "unallocated",
      amountMinor: 150_000,
      accountReference: "INV-2026-01",
    });
    const confirmation = await callbackUrl("c2b_confirmation");
    const foreign = await postCallback(
      confirmation,
      JSON.stringify({
        TransactionType: "Pay Bill",
        TransID: "TFOREIGN01",
        TransTime: "20261111120000",
        TransAmount: "10.00",
        BusinessShortCode: "123456",
        BillRefNumber: "X",
        MSISDN: "2547 ***** 126",
      }),
    );
    expect(foreign.status).toBe(200);
    const validation = await callbackUrl("c2b_validation");
    const accepted = await postCallback(
      validation,
      JSON.stringify({
        TransactionType: "Pay Bill",
        TransID: "TVALID0001",
        TransTime: "20261111120000",
        TransAmount: "10.00",
        BusinessShortCode: "600966",
        BillRefNumber: "INV-1",
        MSISDN: "2547 ***** 126",
      }),
    );
    expect(accepted.body).toEqual({ ResultCode: "0", ResultDesc: "Accepted" });
    const refused = await postCallback(
      validation,
      JSON.stringify({
        TransactionType: "Pay Bill",
        TransID: "TVALID0002",
        TransTime: "20261111120000",
        TransAmount: "10.00",
        BusinessShortCode: "999999",
        BillRefNumber: "INV-1",
        MSISDN: "2547 ***** 126",
      }),
    );
    expect(refused.body).toEqual({ ResultCode: "C2B00015", ResultDesc: "Rejected" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const quarantined = paymentCallbacksResponseSchema.parse(
      (await finance.call("get", "payments/callbacks?status=quarantined&kind=c2b_confirmation"))
        .body,
    );
    expect(quarantined.callbacks[0]).toMatchObject({ quarantineReason: "shortcode_mismatch" });
  });

  it("answers an advisory float check with KES balances", async () => {
    const res = await finance.call("post", "payments/balance-checks", {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const deadline = Date.now() + 10_000;
    let balance = paymentsOverviewResponseSchema.parse(
      (await finance.call("get", "payments/overview")).body,
    ).latestBalance;
    while (balance?.status !== "answered" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      balance = paymentsOverviewResponseSchema.parse(
        (await finance.call("get", "payments/overview")).body,
      ).latestBalance;
    }
    expect(balance?.status).toBe("answered");
    expect(balance?.balances?.find((entry) => entry.account === "Utility Account")).toMatchObject({
      currency: "KES",
    });
    expect((await manager.call("post", "payments/balance-checks", {})).status).toBe(403);
  });

  it("keeps callbacks durable during a queue outage and drains them repeatably afterwards", async () => {
    await relay.onModuleDestroy();
    const id = createdId(await create(finance, stk(260)));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(latest(await detail(finance, id)).status).toBe("queued");
    // Drain: the submission is made directly, the callback is persisted but not processed yet.
    const before = mock.callbacks.length;
    await relay.drain();
    await mock.waitForCallbacks(before + 1);
    const waiting = await readA((tx) =>
      tx.paymentCallbackInbox.count({ where: { tenantId: tenantA, status: "received" } }),
    );
    expect(waiting).toBeGreaterThan(0);
    expect(latest(await detail(finance, id)).status).toBe("pending");
    await relay.drain();
    const done = await detail(finance, id);
    expect(done.request.status).toBe("confirmed");
    // Draining again changes nothing.
    await relay.drain();
    expect((await detail(finance, id)).timeline.length).toBe(done.timeline.length);
    relay.start();
  });

  it("isolates every payments table by company (API and runtime role)", async () => {
    const requests = await readA((tx) =>
      tx.paymentRequest.findFirstOrThrow({ where: { tenantId: tenantA } }),
    );
    const callbacks = await readA((tx) =>
      tx.paymentCallbackInbox.findFirstOrThrow({ where: { tenantId: tenantA } }),
    );
    const cases = await readA((tx) =>
      tx.paymentCase.findFirstOrThrow({ where: { tenantId: tenantA } }),
    );
    expect((await ownerB.call("get", `payments/requests/${requests.id}`)).status).toBe(404);
    expect((await ownerB.call("get", `payments/callbacks/${callbacks.id}`)).status).toBe(404);
    expect((await ownerB.call("get", `payments/cases/${cases.id}`)).status).toBe(404);
    const counts = await db.run(as(ownerB, tenantB), async (tx) => ({
      settings: await tx.paymentSettings.count(),
      routes: await tx.paymentCallbackRoute.count(),
      requests: await tx.paymentRequest.count(),
      attempts: await tx.paymentAttempt.count(),
      events: await tx.paymentEvent.count(),
      inbox: await tx.paymentCallbackInbox.count(),
      cases: await tx.paymentCase.count(),
      queries: await tx.providerQuery.count(),
      receipts: await tx.providerTransaction.count(),
      outbox: await tx.paymentOutbox.count(),
    }));
    expect(
      Object.values(counts).every((value) => value === 0),
      JSON.stringify(counts),
    ).toBe(true);
    const counted = await readA(async (tx) => ({
      requests: await tx.paymentRequest.count(),
      attempts: await tx.paymentAttempt.count(),
      events: await tx.paymentEvent.count(),
    }));
    expect(counted.requests).toBeGreaterThan(0);
    await expect(
      db.run(as(ownerB, tenantB), (tx) =>
        tx.paymentEvent.create({
          data: {
            tenantId: tenantA,
            subjectType: "request",
            subjectId: requests.id,
            event: "attempt.forged",
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(as(ownerB, tenantB), (tx) =>
        tx.paymentOutbox.create({
          data: { tenantId: tenantA, topic: "attempt.submit", refId: requests.id },
        }),
      ),
    ).rejects.toThrow();
    // Without a company context nothing is visible at all.
    const none = await db.run(
      { userId: owner.auth.user.id, tenantId: null, requestId: "e2e-none" },
      (tx) => tx.paymentRequest.count(),
    );
    expect(none).toBe(0);
  });

  it("enforces the state machine, write-once evidence and append-only history in the database", async () => {
    const pairs = await readA(
      (tx) =>
        tx.$queryRaw<{ f: string; t: string; ok: boolean }[]>`
        SELECT f, t, app.payment_attempt_transition_allowed(f, t) AS ok
        FROM unnest(${[...PAYMENT_ATTEMPT_STATUSES]}::text[]) f, unnest(${[...PAYMENT_ATTEMPT_STATUSES]}::text[]) t`,
    );
    expect(pairs).toHaveLength(81);
    for (const pair of pairs)
      expect(pair.ok, `${pair.f}->${pair.t}`).toBe(
        (PAYMENT_ATTEMPT_TRANSITIONS as Record<string, readonly string[]>)[pair.f]!.includes(
          pair.t,
        ),
      );
    const confirmed = await readA((tx) =>
      tx.paymentAttempt.findFirstOrThrow({
        where: { tenantId: tenantA, status: "confirmed", kind: "b2c" },
      }),
    );
    const update = (data: Prisma.PaymentAttemptUpdateInput) =>
      readA((tx) =>
        tx.paymentAttempt.update({
          where: { tenantId_id: { tenantId: tenantA, id: confirmed.id } },
          data: { ...data, version: confirmed.version + 1 },
        }),
      );
    await expect(update({ status: "pending" })).rejects.toThrow();
    await expect(update({ status: "failed" })).rejects.toThrow();
    await expect(update({ amountMinor: 99_900n })).rejects.toThrow();
    await expect(update({ receipt: "TOTHER0001" })).rejects.toThrow();
    await expect(
      readA((tx) =>
        tx.paymentAttempt.update({
          where: { tenantId_id: { tenantId: tenantA, id: confirmed.id } },
          data: { resultDesc: "no version" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      readA(
        (tx) =>
          tx.$executeRaw`UPDATE payment_events SET event = 'tampered' WHERE tenant_id = ${tenantA}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      readA((tx) => tx.$executeRaw`DELETE FROM payment_events WHERE tenant_id = ${tenantA}::uuid`),
    ).rejects.toThrow();
    await expect(
      readA(
        (tx) =>
          tx.$executeRaw`UPDATE payment_provider_transactions SET amount_minor = 1 WHERE tenant_id = ${tenantA}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      readA(
        (tx) => tx.$executeRaw`DELETE FROM payment_attempts WHERE tenant_id = ${tenantA}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      readA(
        (tx) =>
          tx.$executeRaw`UPDATE payment_settings SET environment = 'production', version = version + 1 WHERE tenant_id = ${tenantA}::uuid`,
      ),
    ).rejects.toThrow();
    // A second live attempt for the same request is refused.
    const request = await readA((tx) =>
      tx.paymentRequest.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: tenantA, id: confirmed.requestId } },
      }),
    );
    await expect(
      readA((tx) =>
        tx.paymentAttempt.create({
          data: {
            tenantId: tenantA,
            requestId: request.id,
            sequence: 9,
            kind: "b2c",
            direction: "out",
            amountMinor: request.amountMinor,
            environment: "mock",
            routeId: confirmed.routeId,
            createdBy: owner.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
