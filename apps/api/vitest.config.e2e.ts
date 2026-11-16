import { defineConfig } from "vitest/config";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { testDatabaseUrls } from "./test/test-database.js";

// One biometric template key pair per run (raw X25519 keys are the last 32 bytes of the DER).
const biometric = generateKeyPairSync("x25519");
const rawKey = (der: Buffer) => der.subarray(-32).toString("hex");

// End-to-end tests boot the whole app against the docker compose services (pnpm services:up),
// using the separate pmb_test database, which global-setup migrates first.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    root: "./",
    include: ["test/**/*.e2e-spec.ts"],
    globalSetup: ["./test/global-setup.ts"],
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      WEB_ORIGIN: "http://localhost:3000",
      AUTH_MFA_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      FIELD_ENCRYPTION_KEYS: `1:${randomBytes(32).toString("hex")}`,
      FIELD_BLIND_INDEX_KEY: randomBytes(32).toString("hex"),
      AUTH_PIN_PEPPER_KEYS: `1:${randomBytes(32).toString("hex")}`,
      // Pinned so a developer's rotated apps/api/.env (keys:rotate drill) cannot leak in.
      AUTH_MFA_ENCRYPTION_ACTIVE_KEY_VERSION: "1",
      FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: "1",
      AUTH_PIN_PEPPER_ACTIVE_VERSION: "1",
      // The API holds the public half only; the enrolment spec opens templates with the private
      // half, under a name the API ignores (it refuses BIOMETRIC_TEMPLATE_PRIVATE_KEYS).
      BIOMETRIC_TEMPLATE_PUBLIC_KEYS: `1:${rawKey(biometric.publicKey.export({ format: "der", type: "spki" }))}`,
      BIOMETRIC_TEMPLATE_ACTIVE_KEY_VERSION: "1",
      E2E_BIOMETRIC_TEMPLATE_PRIVATE_KEY: rawKey(
        biometric.privateKey.export({ format: "der", type: "pkcs8" }),
      ),
      DATABASE_URL: testDatabaseUrls().appUrl,
      // Payment workers run only where a suite starts them against its own mock Daraja server.
      PAYMENTS_WORKERS_ENABLED: "false",
      // Tests run due report subscriptions themselves (ReportSchedulerService.runDue).
      REPORT_SCHEDULER: "off",
    },
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
