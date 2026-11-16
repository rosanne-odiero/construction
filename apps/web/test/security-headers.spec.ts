import { expect, test, type Page } from "@playwright/test";
import { RUIRU_ID, signInAs } from "./live-helpers";
import { PAYMENT_REQUEST_ID } from "./mock-payments.mts";
import { PAYROLL_BATCH_ID } from "./mock-payroll.mts";

/**
 * D9.1 browser security (ASVS 5.0.0 V3.4): every page is served with the nonce-based CSP and the
 * other security headers, and the key pages render without a single CSP violation.
 */

/** Collects CSP violations reported to the page and Content-Security-Policy console errors. */
async function watchCsp(page: Page) {
  const console: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /Content.Security.Policy|Permissions.Policy/i.test(message.text())
    )
      console.push(message.text());
  });
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener("securitypolicyviolation", (event) =>
      seen.push(`${event.violatedDirective} ${event.blockedURI || "inline"}`),
    );
  });
  return {
    async violations() {
      const reported = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
      return [...reported, ...console];
    },
  };
}

test("sends the CSP and security headers on pages and static files", async ({ page }) => {
  const response = await page.goto("/sign-in");
  const headers = response!.headers();
  const csp = headers["content-security-policy"]!;
  const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
  expect(nonce).toBeTruthy();
  expect(csp).toContain("'strict-dynamic'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["permissions-policy"]).toContain("camera=(self)");
  expect(headers["permissions-policy"]).toContain("geolocation=(self)");
  expect(headers["x-powered-by"]).toBeUndefined();
  // Next.js puts the nonce on its own scripts; the theme script gets it from the root layout.
  expect(await page.locator(`script[nonce]`).count()).toBeGreaterThan(0);
  await expect(page.locator("html")).toHaveClass(/\b(light|dark)\b/);

  const second = (await page.goto("/sign-in"))!.headers()["content-security-policy"]!;
  expect(second).not.toContain(nonce!);

  const icon = await page.request.get("/icon.svg");
  expect(icon.headers()["x-content-type-options"]).toBe("nosniff");
  expect(icon.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
});

test("blocks injected inline handlers, javascript: URLs and foreign resources", async ({
  page,
}) => {
  const csp = await watchCsp(page);
  await page.goto("/sign-in");
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<img src="/icon.svg" onload="window.__pwned = true">' +
        '<a id="xss-link" href="javascript:window.__pwned = true">x</a>' +
        '<img src="https://example.com/beacon.gif" alt="">',
    );
    document.getElementById("xss-link")!.click();
  });
  await expect.poll(async () => (await csp.violations()).length).toBeGreaterThanOrEqual(3);
  const violations = (await csp.violations()).join("\n");
  expect(violations).toMatch(/script-src/);
  expect(violations).toMatch(/img-src https:\/\/example\.com/);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBe(
    undefined,
  );
});

const pages: { name: string; persona?: "owner" | "client" | "supplier"; path: string }[] = [
  { name: "sign-in", path: "/sign-in" },
  { name: "dashboard", persona: "owner", path: "/dashboard" },
  { name: "project", persona: "owner", path: `/projects/${RUIRU_ID}` },
  { name: "project photos (upload)", persona: "owner", path: `/projects/${RUIRU_ID}?tab=photos` },
  { name: "payroll batch", persona: "owner", path: `/payroll/batches/${PAYROLL_BATCH_ID}` },
  {
    name: "payroll exports (CSV download)",
    persona: "owner",
    path: "/payroll/exports?month=2026-11",
  },
  { name: "payments console", persona: "owner", path: "/payments" },
  {
    name: "payment request (timeline)",
    persona: "owner",
    path: `/payments/requests/${PAYMENT_REQUEST_ID}`,
  },
  { name: "biometrics (DPIA gate)", persona: "owner", path: "/attendance/biometrics" },
  { name: "client portal", persona: "client", path: "/portal" },
  { name: "supplier portal", persona: "supplier", path: "/supplier" },
];

for (const { name, persona, path } of pages) {
  test(`renders ${name} without CSP violations`, async ({ page, context }) => {
    if (persona) await signInAs(context, persona);
    const csp = await watchCsp(page);
    const response = await page.goto(path);
    expect(response!.status()).toBe(200);
    expect(response!.headers()["content-security-policy"]).toContain("'strict-dynamic'");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("main").first()).toBeVisible();
    expect(await csp.violations()).toEqual([]);
  });
}
