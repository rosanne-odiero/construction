import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { BrowserContext, Page } from "@playwright/test";

/** Shared helpers for the live (API-backed) page tests. IDs match test/mock-api.mts. */
// PLAYWRIGHT_WEB_PORT matches playwright.config.ts (overridable for a parallel checkout).
export const WEB_PORT = Number(process.env["PLAYWRIGHT_WEB_PORT"] ?? 3100);
export const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
export const RUIRU_ID = "30000000-0000-4000-8000-000000000001";
export const SYOKIMAU_ID = "30000000-0000-4000-8000-000000000002";
export const MAIN_PLOT_ID = "31000000-0000-4000-8000-000000000001";
export const TENANT_ID = "20000000-0000-4000-8000-000000000001";
export const MOCK_CSRF = "mock-csrf-token";
export const MOCK_STEP_UP_CODE = "246810";
const axeTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
/** A transparent 1×1 PNG: map tiles are never fetched from OpenStreetMap during tests. */
const BLANK_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

export type Persona = "owner" | "agent" | "pm" | "finance";

/** A session cookie the mock API recognises; each call gets a fresh copy of the fixture data. */
export async function signInAs(context: BrowserContext, persona: Persona | "client" | "labourer") {
  const token = `${persona}.${randomUUID()}`;
  await context.addCookies([{ name: "pmb_at", value: token, url: BASE_URL, httpOnly: true }]);
  return token;
}

/** Signs in as another persona on the same fixture data (the token's session part is shared). */
export async function switchPersona(context: BrowserContext, persona: Persona, token: string) {
  const session = token.split(".")[1]!;
  await context.clearCookies({ name: "pmb_at" });
  await context.addCookies([
    { name: "pmb_at", value: `${persona}.${session}`, url: BASE_URL, httpOnly: true },
  ]);
}

export async function preferences(
  context: BrowserContext,
  page: Page,
  locale: "en" | "sw" = "en",
  theme: "light" | "dark" = "light",
) {
  await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: BASE_URL }]);
  await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
}

export async function blockTiles(page: Page) {
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: BLANK_TILE }),
  );
}

/** axe at rest: pointer away from controls and CSS transitions finished. */
export async function axeViolations(page: Page) {
  await page.mouse.move(0, 0);
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );
  // A refresh after an action streams the page's metadata again: wait for the title to settle.
  await page.waitForFunction(() => document.title.trim().length > 0);
  return (await new AxeBuilder({ page }).withTags(axeTags).analyze()).violations;
}
