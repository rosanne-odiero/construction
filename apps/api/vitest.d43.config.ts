import { defineConfig } from "vitest/config";
import { randomBytes } from "node:crypto";
import { testDatabaseUrls } from "./test/test-database.js";

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
      LOG_LEVEL: "error",
      WEB_ORIGIN: "http://localhost:3000",
      AUTH_MFA_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      FIELD_ENCRYPTION_KEYS: `1:${randomBytes(32).toString("hex")}`,
      FIELD_BLIND_INDEX_KEY: randomBytes(32).toString("hex"),
      AUTH_PIN_PEPPER_KEYS: `1:${randomBytes(32).toString("hex")}`,
      // Pinned so a developer's rotated apps/api/.env (keys:rotate drill) cannot leak in.
      AUTH_MFA_ENCRYPTION_ACTIVE_KEY_VERSION: "1",
      FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: "1",
      AUTH_PIN_PEPPER_ACTIVE_VERSION: "1",
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
