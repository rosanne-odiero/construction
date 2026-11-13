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
      LOG_LEVEL: "silent",
      WEB_ORIGIN: "http://localhost:3000",
      AUTH_MFA_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      FIELD_ENCRYPTION_KEYS: `1:${randomBytes(32).toString("hex")}`,
      FIELD_BLIND_INDEX_KEY: randomBytes(32).toString("hex"),
      AUTH_PIN_PEPPER_KEYS: `1:${randomBytes(32).toString("hex")}`,
      DATABASE_URL: testDatabaseUrls().appUrl,
    },
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
