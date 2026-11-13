import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { axeViolations, BASE_URL, preferences, TENANT_ID } from "./live-helpers";

/**
 * The real sign-in flow against mocked API answers (browser requests are intercepted, as in
 * foundation.spec.ts). Once a company is selected the mocked API sets the session cookie, so the
 * live pages that follow are rendered by the server from test/mock-api.mts.
 */
const userId = "40000000-0000-4000-8000-000000000001";
const sessionId = "40000000-0000-4000-8000-000000000002";
const otherTenant = "40000000-0000-4000-8000-000000000003";
const expiresAt = "2026-11-11T07:45:00.000Z";

type Flags = { signedIn: boolean; mfa: boolean; verified: boolean; tenantId: string | null };
const account = (flags: Flags) => ({
  user: {
    id: userId,
    identifier: "owner@jenga-bora.example.test",
    displayName: "Wanjiru Kamau",
    verified: true,
    mfaEnabled: flags.mfa,
    totpEnabled: flags.mfa,
    passkeys: flags.mfa ? 1 : 0,
  },
  session: { id: sessionId, tenantId: flags.tenantId, mfaVerified: flags.verified, expiresAt },
  mfaRequired: flags.mfa && !flags.verified,
});
const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  route.fulfill({
    status,
    contentType: status >= 400 ? "application/problem+json" : "application/json",
    headers,
    body: JSON.stringify(body),
  });
const sessionCookie = (token: string) => ({
  "Set-Cookie": `pmb_at=${token}; Path=/; HttpOnly; SameSite=Lax`,
});

/** The form's error message (Next.js also renders an empty route-announcer alert). */
const formAlert = (page: Page) => page.locator("form").getByRole("alert");

/** Intercepts the auth and company endpoints; everything else reaches the mock API. */
async function mockAuth(
  page: Page,
  handlers: Partial<Record<string, (route: Route) => Promise<void> | void>>,
) {
  const calls: string[] = [];
  await page.route(/\/api\/v1\/(auth|tenants)(\/|$|\?)/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    calls.push(`${request.method()} ${path}`);
    if (request.method() !== "GET")
      expect(request.headers()["x-csrf-token"]).toBe("csrf-from-mock");
    if (path === "/auth/csrf") return json(route, { csrfToken: "csrf-from-mock" });
    const key = Object.keys(handlers).find((pattern) => new RegExp(`^${pattern}$`).test(path));
    if (key) return handlers[key]!(route);
    if (path === "/auth/me" || path === "/auth/refresh")
      return json(route, { code: "unauthorized" }, 401);
    return route.continue();
  });
  return calls;
}

test("redirects to sign-in, verifies TOTP, chooses a company and returns to the page", async ({
  page,
}) => {
  const token = `owner.${randomUUID()}`;
  const flags: Flags = { signedIn: false, mfa: true, verified: false, tenantId: null };
  await mockAuth(page, {
    "/auth/me": (route) =>
      flags.signedIn ? json(route, account(flags)) : json(route, { code: "unauthorized" }, 401),
    "/auth/login": (route) => {
      expect(route.request().postDataJSON()).toEqual({
        identifier: "owner@jenga-bora.example.test",
        password: "synthetic-test-password",
      });
      flags.signedIn = true;
      return json(route, account(flags));
    },
    "/auth/mfa/step-up": (route) => {
      expect(route.request().postDataJSON()).toEqual({ code: "135790" });
      flags.verified = true;
      return json(route, account(flags));
    },
    "/tenants": (route) =>
      json(route, {
        tenants: [TENANT_ID, otherTenant].map((id, index) => ({
          id,
          name: index ? "Kilima Contractors Ltd" : "Jenga Bora Builders Ltd",
          role: "owner",
          roleName: null,
          tenantWide: true,
          permissions: ["projects.view", "projects.create", "projects.manage"],
        })),
      }),
    [`/tenants/${TENANT_ID}/select`]: (route) => {
      flags.tenantId = TENANT_ID;
      return json(route, account(flags), 200, sessionCookie(token));
    },
    "/auth/logout": (route) => {
      flags.signedIn = false;
      return json(route, { message: "Signed out." }, 200, {
        "Set-Cookie": "pmb_at=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
      });
    },
  });

  await page.goto("/projects?status=active");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fprojects%3Fstatus%3Dactive$/);
  await expect(page.getByRole("heading", { name: "Sign in", level: 2 })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.locator("#email").fill("owner@jenga-bora.example.test");
  await page.locator("#password").fill("synthetic-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Two-step verification" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use a passkey" })).toBeVisible();
  await expect(page.locator("#password")).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Use a recovery code instead" }).click();
  await expect(page.getByLabel("Recovery code")).toBeVisible();
  await page.getByRole("button", { name: "Use an authenticator code instead" }).click();
  await page.locator("#otp").fill("135790");
  await page.getByRole("button", { name: "Verify", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Choose a company" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Jenga Bora Builders Ltd" }).click();

  await expect(page).toHaveURL("/projects?status=active");
  await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Ruiru Heights Apartments", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Syokimau Townhouses", exact: true })).toHaveCount(0);
  await expect(page.locator("header").getByText("Wanjiru Kamau")).toBeVisible();

  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(page.getByRole("menu").getByText("Jenga Bora Builders Ltd · Owner")).toBeVisible();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/projects");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fprojects$/);
});

test("refuses an off-site next target and shows a Kiswahili error for wrong details", async ({
  page,
  context,
}) => {
  await preferences(context, page, "sw", "dark");
  const token = `owner.${randomUUID()}`;
  const flags: Flags = { signedIn: false, mfa: false, verified: false, tenantId: TENANT_ID };
  let attempts = 0;
  await mockAuth(page, {
    "/auth/me": (route) =>
      flags.signedIn ? json(route, account(flags)) : json(route, { code: "unauthorized" }, 401),
    "/auth/login": (route) => {
      attempts++;
      if (attempts === 1) return json(route, { code: "unauthorized" }, 401);
      flags.signedIn = true;
      return json(route, account(flags), 200, sessionCookie(token));
    },
    "/tenants": (route) =>
      json(route, {
        tenants: [
          {
            id: TENANT_ID,
            name: "Jenga Bora Builders Ltd",
            role: "owner",
            roleName: null,
            tenantWide: true,
            permissions: ["projects.view"],
          },
        ],
      }),
  });
  await page.goto("/sign-in?next=//evil.example/steal");
  await expect(page.locator("html")).toHaveAttribute("lang", "sw");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("tab", { name: "Simu" }).click();
  await page.locator("#phone").fill("0712 345 678");
  await expect(page.getByText("Utaingia kama 254712345678.")).toBeVisible();
  await page.getByRole("tab", { name: "Barua pepe" }).click();
  await page.locator("#email").fill("owner@jenga-bora.example.test");
  await page.locator("#password").fill("wrong-password-attempt");
  await page.getByRole("button", { name: "Ingia", exact: true }).click();
  await expect(formAlert(page)).toContainText(
    "Barua pepe au nambari ya simu na nenosiri havikulingana",
  );
  expect(await axeViolations(page)).toEqual([]);
  await page.locator("#password").fill("synthetic-test-password");
  await page.getByRole("button", { name: "Ingia", exact: true }).click();
  await expect(page).toHaveURL("/projects");
  await expect(page.getByRole("heading", { name: "Miradi", level: 1 })).toBeVisible();
});

test("never treats a malformed login answer as a successful sign-in", async ({ page }) => {
  await mockAuth(page, { "/auth/login": (route) => json(route, { fakeSuccess: true }) });
  await page.goto("/sign-in");
  await page.locator("#email").fill("owner@jenga-bora.example.test");
  await page.locator("#password").fill("synthetic-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(formAlert(page)).toContainText("PM-Buddy answered unexpectedly");
  await expect(page.locator("#password")).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("resumes an expired access token through one refresh, then continues", async ({ page }) => {
  const token = `owner.${randomUUID()}`;
  const flags: Flags = { signedIn: false, mfa: false, verified: false, tenantId: TENANT_ID };
  let refreshes = 0;
  const calls = await mockAuth(page, {
    "/auth/me": (route) =>
      flags.signedIn ? json(route, account(flags)) : json(route, { code: "unauthorized" }, 401),
    "/auth/refresh": (route) => {
      refreshes++;
      flags.signedIn = true;
      return json(route, account(flags), 200, sessionCookie(token));
    },
    "/tenants": (route) =>
      json(route, {
        tenants: [
          {
            id: TENANT_ID,
            name: "Jenga Bora Builders Ltd",
            role: "owner",
            roleName: null,
            tenantWide: true,
            permissions: ["projects.view"],
          },
        ],
      }),
  });
  await page.goto(`/sign-in?next=${encodeURIComponent("/projects?search=ruiru")}`);
  await expect(page).toHaveURL("/projects?search=ruiru");
  expect(refreshes).toBe(1);
  expect(calls.filter((call) => call === "POST /auth/login")).toEqual([]);
});

test("offers Google with the safe next path, explains refusals and still asks for MFA after Google", async ({
  page,
}) => {
  const flags: Flags = { signedIn: false, mfa: true, verified: false, tenantId: null };
  await mockAuth(page, {
    "/auth/me": (route) =>
      flags.signedIn ? json(route, account(flags)) : json(route, { code: "unauthorized" }, 401),
  });
  await page.goto("/sign-in?next=%2Fdiary&google=email-unsupported");
  const google = page.getByRole("link", { name: "Continue with Google" });
  await expect(google).toHaveAttribute("href", "/api/v1/auth/google/start?next=%2Fdiary");
  await expect(formAlert(page)).toContainText("That Google account cannot be used");
  expect(await axeViolations(page)).toEqual([]);

  await page.goto("/sign-in?next=//evil.example/steal&google=unknown-outcome");
  await expect(google).toHaveAttribute("href", "/api/v1/auth/google/start?next=%2Fprojects");
  await expect(formAlert(page)).toHaveCount(0);

  // The API's callback set a session and returned here: the form resumes it, and MFA still applies.
  flags.signedIn = true;
  await page.goto("/sign-in?next=%2Fdiary");
  await expect(page.getByRole("heading", { name: "Two-step verification" })).toBeVisible();
  await expect(page.locator("#password")).toHaveCount(0);
});

test("hides Google when the API does not offer it, and explains cancellation in Kiswahili", async ({
  page,
  context,
}) => {
  await preferences(context, page, "sw");
  await mockAuth(page, {});
  await page.goto("/sign-in?google=cancelled");
  await expect(page.getByRole("link", { name: "Endelea na Google" })).toBeVisible();
  await expect(formAlert(page)).toContainText("Kuingia kwa Google kumeghairiwa");
  expect(await axeViolations(page)).toEqual([]);

  await context.addCookies([{ name: "mock_google", value: "off", url: BASE_URL }]);
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Ingia", level: 2 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Endelea na Google" })).toHaveCount(0);
});

test("offers Google on the create-account card, and hides it when the API does not", async ({
  page,
  context,
}) => {
  await mockAuth(page, {});
  await page.goto("/foundation");
  const register = page.locator("form").filter({ has: page.locator("#register-displayName") });
  await expect(register).toBeVisible();
  const card = page.locator("[data-slot=card]").filter({ has: register });
  await expect(card.getByRole("link", { name: "Continue with Google" })).toHaveAttribute(
    "href",
    "/api/v1/auth/google/start?next=%2Ffoundation",
  );
  expect(await axeViolations(page)).toEqual([]);

  await context.addCookies([{ name: "mock_google", value: "off", url: BASE_URL }]);
  await page.goto("/foundation");
  await expect(register).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with Google" })).toHaveCount(0);
});
