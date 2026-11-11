import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { axeViolations, preferences, RUIRU_ID, signInAs, TENANT_ID } from "./live-helpers";

/** Client, labourer and staff portals against test/mock-api.mts (synthetic data). */
const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  route.fulfill({
    status,
    contentType: status >= 400 ? "application/problem+json" : "application/json",
    headers,
    body: JSON.stringify(body),
  });
const account = (identifier: string, displayName: string) => ({
  user: {
    id: "21000000-0000-4000-8000-000000000012",
    identifier,
    displayName,
    verified: true,
    mfaEnabled: false,
    totpEnabled: false,
    passkeys: 0,
  },
  session: {
    id: "22000000-0000-4000-8000-000000000009",
    tenantId: TENANT_ID,
    mfaVerified: false,
    expiresAt: "2026-11-11T07:45:00.000Z",
  },
  mfaRequired: false,
});
const signedInAs = (persona: string) => ({
  "Set-Cookie": `pmb_at=${persona}.${randomUUID()}; Path=/; HttpOnly; SameSite=Lax`,
});
const formAlert = (page: Page) =>
  page.locator("main form, main [data-slot=card]").getByRole("alert");
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("clients get their own portal: projects, milestones and approved site updates", async ({
  page,
  context,
}) => {
  await signInAs(context, "client");
  await page.goto("/projects");
  await expect(page).toHaveURL("/portal");
  await expect(page.getByRole("heading", { name: "Your projects", level: 1 })).toBeVisible();
  await expect(page.getByText("Client portal").first()).toBeVisible();
  await expect(page.getByText(/Prototype: screens show mock data/)).toHaveCount(0);
  await expect(page.getByText("1 of 3 milestones achieved")).toBeVisible();
  await expect(page.getByText("Contract sum KES 86,400,000")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("link", { name: "View progress" }).click();
  await expect(page).toHaveURL(`/portal/projects/${RUIRU_ID}`);
  await expect(
    page.getByRole("heading", { name: "Ruiru Heights Apartments", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Foundations complete")).toBeVisible();
  const update = page.getByRole("article", { name: /Main plot/ });
  await expect(update).toContainText("first-floor columns cast");
  await expect(update).toContainText("18");
  expect(await axeViolations(page)).toEqual([]);

  for (const path of ["/worker", "/dashboard", `/projects/${RUIRU_ID}`])
    await page.goto(path).then(() => expect(page).toHaveURL("/portal"));
  await page.goto("/portal/projects/30000000-0000-4000-8000-000000000002");
  await expect(page.getByText(/could not be found|404/i).first()).toBeVisible();
});

test("labourers get the worker portal in Kiswahili on a small phone, never the office", async ({
  page,
  context,
}) => {
  await signInAs(context, "labourer");
  await preferences(context, page, "sw");
  await page.setViewportSize({ width: 360, height: 760 });
  await page.goto("/worker");
  await expect(page.getByRole("heading", { name: "Habari, Otieno Ouma", level: 1 })).toBeVisible();
  await expect(page.getByText("Main plot")).toBeVisible();
  await expect(page.getByText("Off Thika Road, Ruiru")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Malipo" })).toBeVisible();
  await expect(page.getByText(/USSD/)).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  for (const path of ["/projects", "/portal", "/diary"])
    await page.goto(path).then(() => expect(page).toHaveURL("/worker"));
});

test("staff stay in the office app", async ({ page, context }) => {
  await signInAs(context, "owner");
  for (const path of ["/portal", "/worker"])
    await page.goto(path).then(() => expect(page).toHaveURL("/projects"));
});

test("a labourer joins from the SMS link with a PIN and lands in their portal", async ({
  page,
}) => {
  await page.goto("/worker/join");
  await expect(page.getByText("Open the link from your invitation SMS")).toBeVisible();

  const token = "a".repeat(43);
  let joined: unknown = null;
  await page.route("**/api/v1/auth/pin/join", async (route) => {
    joined = route.request().postDataJSON();
    expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
    await json(route, account("254712345678", "Otieno Ouma"), 200, signedInAs("labourer"));
  });
  await page.goto(`/worker/join?token=${token}`);
  await expect(page.getByRole("heading", { name: "Join as a labourer" })).toBeVisible();
  await page.getByLabel("Phone number").fill("0712 345 678");
  await expect(page.getByText("Your account will use 254712345678.")).toBeVisible();
  await page.getByLabel("Your full name").fill("Otieno Ouma");
  await page.getByLabel("Choose a 6-digit PIN").fill("123456");
  await page.getByLabel("Type the PIN again").fill("123456");
  await page.getByRole("button", { name: "Create my account" }).click();
  await expect(formAlert(page)).toContainText("run of digits");
  await page.getByLabel("Choose a 6-digit PIN").fill("274915");
  await page.getByLabel("Type the PIN again").fill("274916");
  await page.getByRole("button", { name: "Create my account" }).click();
  await expect(formAlert(page)).toContainText("different");
  expect(joined).toBeNull();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByLabel("Type the PIN again").fill("274915");
  await page.getByRole("button", { name: "Create my account" }).click();
  await expect(page).toHaveURL("/worker");
  await expect(page.getByRole("heading", { name: "Habari, Otieno Ouma" })).toBeVisible();
  expect(joined).toEqual({
    identifier: "254712345678",
    token,
    displayName: "Otieno Ouma",
    pin: "274915",
  });
});

test("the join page explains an existing account and a spent link", async ({ page }) => {
  const token = "b".repeat(43);
  let attempts = 0;
  await page.route("**/api/v1/auth/pin/join", (route) => {
    attempts++;
    return attempts === 1
      ? json(route, { code: "account-exists" }, 409)
      : json(route, { code: "unauthorized" }, 401);
  });
  await page.goto(`/worker/join?token=${token}`);
  await page.getByLabel("Phone number").fill("0712 345 678");
  await page.getByLabel("Your full name").fill("Otieno Ouma");
  await page.getByLabel("Choose a 6-digit PIN").fill("274915");
  await page.getByLabel("Type the PIN again").fill("274915");
  await page.getByRole("button", { name: "Create my account" }).click();
  await expect(formAlert(page)).toContainText("already has a PM-Buddy account");
  await expect(formAlert(page).getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    `/sign-in?next=${encodeURIComponent(`/worker/join?token=${token}`)}`,
  );
  await page.getByRole("button", { name: "Create my account" }).click();
  await expect(formAlert(page)).toContainText("not valid, has expired");
  await expect(page).toHaveURL(`/worker/join?token=${token}`);
});

test("sign-in routes labourers (PIN) and clients (password) to their portals", async ({ page }) => {
  let pinAttempts = 0;
  await page.route("**/api/v1/auth/pin/login", async (route) => {
    pinAttempts++;
    expect(route.request().postDataJSON()).toMatchObject({ identifier: "254712345678" });
    if (pinAttempts === 1) return json(route, { code: "unauthorized" }, 401);
    await json(route, account("254712345678", "Otieno Ouma"), 200, signedInAs("labourer"));
  });
  await page.goto("/sign-in");
  await page.getByRole("tab", { name: "Labourer PIN" }).click();
  await expect(page.locator("#password")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Continue with Google" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Forgot PIN?" })).toHaveAttribute(
    "href",
    "/worker/pin",
  );
  await page.locator("#pin-phone").fill("0712 345 678");
  await page.locator("#pin").fill("802461");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toContainText(
    "phone number and PIN did not match",
  );
  expect(await axeViolations(page)).toEqual([]);
  await page.locator("#pin").fill("274915");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/worker");

  await page.context().clearCookies();
  await page.route("**/api/v1/auth/login", (route) =>
    json(route, account("grace.wambui@example.test", "Grace Wambui"), 200, signedInAs("client")),
  );
  await page.goto("/sign-in?next=%2Fprojects");
  await page.locator("#email").fill("grace.wambui@example.test");
  await page.locator("#password").fill("synthetic-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/portal");
});

test("a forgotten PIN is reset through the SMS link", async ({ page }) => {
  await page.route("**/api/v1/auth/password/forgot", (route) => {
    expect(route.request().postDataJSON()).toEqual({ identifier: "254712345678" });
    return json(route, { message: "If the account is eligible, instructions have been sent." });
  });
  await page.goto("/worker/pin");
  await page.getByLabel("Phone number").fill("0712345678");
  await page.getByRole("button", { name: "Send SMS link" }).click();
  await expect(page.getByRole("status")).toContainText("If the number has an account");

  const token = "c".repeat(43);
  await page.route("**/api/v1/auth/pin/reset", (route) => {
    expect(route.request().postDataJSON()).toEqual({ token, pin: "530718" });
    return json(route, { message: "PIN changed. Sign in again." });
  });
  await page.goto(`/worker/pin?token=${token}`);
  await page.getByLabel("New 6-digit PIN").fill("111111");
  await page.getByLabel("Type the PIN again").fill("111111");
  await page.getByRole("button", { name: "Save PIN" }).click();
  await expect(formAlert(page)).toContainText("repeats digits");
  await page.getByLabel("New 6-digit PIN").fill("530718");
  await page.getByLabel("Type the PIN again").fill("530718");
  await page.getByRole("button", { name: "Save PIN" }).click();
  await expect(page.getByRole("status")).toContainText("PIN changed");
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/sign-in?next=%2Fworker",
  );
  expect(await axeViolations(page)).toEqual([]);
});

test("a project manager invites a labourer from the project team", async ({ page, context }) => {
  await signInAs(context, "owner");
  await page.goto(`/projects/${RUIRU_ID}?tab=team`);
  const card = page.locator("[data-slot=card]").filter({ hasText: "Invite a labourer" });
  await card.getByLabel("Labourer's phone number").fill("0712 345 678");
  await expect(card.getByText("Will invite 254712345678.")).toBeVisible();
  await card.getByRole("button", { name: "Send invitation" }).click();
  await expect(card.getByRole("status")).toContainText("Invitation sent to 254712345678");
  await card.getByLabel("Labourer's phone number").fill("not a phone");
  await card.getByRole("button", { name: "Send invitation" }).click();
  await expect(card.getByRole("alert")).toContainText("Enter a Kenyan mobile number");
  // axe at the top of the page: scrolled content sits under the sticky header otherwise.
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await axeViolations(page)).toEqual([]);
});
