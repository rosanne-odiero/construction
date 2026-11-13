import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { paymentRequestDetailResponseSchema, paymentRequestResponseSchema, paymentSettingsResponseSchema } from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { PaymentsRuntime } from "../src/modules/payments/payments-runtime.js";
import { Browser, notifications } from "./support.js";

/**
 * Optional Daraja SANDBOX suite (never production). Skipped unless every DARAJA_SANDBOX_* variable
 * is set; it needs Safaricom sandbox test credentials, the public sandbox certificate and a public
 * HTTPS callback base URL that reaches this API (for example a tunnel to a reviewed host):
 *   DARAJA_SANDBOX_CONSUMER_KEY, DARAJA_SANDBOX_CONSUMER_SECRET, DARAJA_SANDBOX_PASSKEY,
 *   DARAJA_SANDBOX_INITIATOR_NAME, DARAJA_SANDBOX_INITIATOR_PASSWORD, DARAJA_SANDBOX_SHORTCODE
 *   (STK, e.g. 174379), DARAJA_SANDBOX_B2C_SHORTCODE, DARAJA_SANDBOX_PHONE (a sandbox test MSISDN),
 *   DARAJA_SANDBOX_CERTIFICATE_PATH and DARAJA_SANDBOX_CALLBACK_BASE_URL.
 * The sandbox moves no real money. Results are asserted as "accepted then any verified outcome":
 * sandbox behaviour (and whether callbacks arrive) is outside PM-Buddy's control.
 */
const env = (name: string) => process.env[`DARAJA_SANDBOX_${name}`];
const REQUIRED = [
  "CONSUMER_KEY",
  "CONSUMER_SECRET",
  "PASSKEY",
  "INITIATOR_NAME",
  "INITIATOR_PASSWORD",
  "SHORTCODE",
  "B2C_SHORTCODE",
  "PHONE",
  "CERTIFICATE_PATH",
  "CALLBACK_BASE_URL",
] as const;
const configured = REQUIRED.every((name) => Boolean(env(name)));

describe.skipIf(!configured)("Daraja sandbox (optional; needs DARAJA_SANDBOX_* credentials)", () => {
  let app: INestApplication<App>;
  let owner: Browser;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    const runtime = app.get(PaymentsRuntime);
    runtime.sandboxCertificatePath = env("CERTIFICATE_PATH");
    runtime.callbackBaseUrl = env("CALLBACK_BASE_URL")!;
    runtime.workersEnabled = true;
    await app.listen(Number(process.env["DARAJA_SANDBOX_LISTEN_PORT"] ?? 0));
    vi.spyOn(app.get(AuthSecurity), "notify").mockImplementation(async (identifier, subject, text) => {
      notifications.set(identifier, [...(notifications.get(identifier) ?? []), { subject, text }]);
    });
    owner = new Browser(app);
    await owner.register();
    await owner.enroll();
    expect((await owner.call("post", "tenants", { name: "Sandbox company" })).status).toBe(201);
    const fresh = () =>
      app.get(PrismaService).session.update({ where: { id: owner.auth.session.id }, data: { mfaVerifiedAt: new Date() } });
    await fresh();
    let res = await owner.call("post", "payments/settings", {});
    let version = paymentSettingsResponseSchema.parse(res.body).settings!.version;
    res = await owner.call("put", "payments/settings", {
      version,
      environment: "sandbox",
      shortcodes: {
        stkShortcode: env("SHORTCODE"),
        stkPartyB: null,
        stkTransactionType: "CustomerPayBillOnline",
        c2bShortcode: null,
        b2cShortcode: env("B2C_SHORTCODE"),
        b2bShortcode: null,
      },
      limits: { stkMaxMinor: 100_000, b2cMinMinor: 1_000, b2cMaxMinor: 100_000, b2bMaxMinor: 100_000, dailyPayoutMaxMinor: 500_000 },
    });
    version = paymentSettingsResponseSchema.parse(res.body).settings!.version;
    res = await owner.call("put", "payments/settings/credentials", {
      version,
      consumerKey: env("CONSUMER_KEY"),
      consumerSecret: env("CONSUMER_SECRET"),
      initiatorName: env("INITIATOR_NAME"),
      initiatorPassword: env("INITIATOR_PASSWORD"),
      passkey: env("PASSKEY"),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it("gets an STK Push accepted by the sandbox and never reports it paid from the response", async () => {
    const res = await owner.call(
      "post",
      "payments/requests",
      { kind: "stk_push", amountMinor: 100, phone: env("PHONE"), accountReference: "PMB-SANDBOX" },
      true,
      { "Idempotency-Key": `sandbox-${Date.now()}` },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = paymentRequestResponseSchema.parse(res.body).request.id;
    const deadline = Date.now() + 60_000;
    let status = "queued";
    while (Date.now() < deadline && ["created", "queued", "submitting"].includes(status)) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const view = paymentRequestDetailResponseSchema.parse((await owner.call("get", `payments/requests/${id}`)).body);
      status = view.attempts.at(-1)!.status;
    }
    expect(["pending", "unknown", "confirmed", "failed"]).toContain(status);
  });
});
