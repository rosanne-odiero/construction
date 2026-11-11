import { defineConfig, devices } from "@playwright/test";

/** test/mock-api.mts answers the server-side (API_INTERNAL_URL) and rewritten /api calls. */
const MOCK_API_PORT = 3199;

export default defineConfig({
  testDir: "./test",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chromium" } }],
  webServer: [
    {
      command: "node test/mock-api.mts",
      url: `http://127.0.0.1:${MOCK_API_PORT}/health`,
      env: { MOCK_API_PORT: String(MOCK_API_PORT) },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "pnpm exec next dev --hostname 127.0.0.1 --port 3100",
      url: "http://127.0.0.1:3100/design-system",
      env: { API_INTERNAL_URL: `http://127.0.0.1:${MOCK_API_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
