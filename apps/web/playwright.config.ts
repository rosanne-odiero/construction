import { defineConfig, devices } from "@playwright/test";

/** test/mock-api.mts answers the server-side (API_INTERNAL_URL) and rewritten /api calls. */
// Overridable so a second checkout (git worktree) can run the browser tests at the same time.
const MOCK_API_PORT = Number(process.env["PLAYWRIGHT_MOCK_API_PORT"] ?? 3199);
const WEB_PORT = Number(process.env["PLAYWRIGHT_WEB_PORT"] ?? 3100);

export default defineConfig({
  testDir: "./test",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    // Transitions finish instantly (see globals.css), so axe never scans a half-faded button.
    contextOptions: { reducedMotion: "reduce" },
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
      command: `pnpm exec next dev --hostname 127.0.0.1 --port ${WEB_PORT}`,
      url: `http://127.0.0.1:${WEB_PORT}/design-system`,
      env: { API_INTERNAL_URL: `http://127.0.0.1:${MOCK_API_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
