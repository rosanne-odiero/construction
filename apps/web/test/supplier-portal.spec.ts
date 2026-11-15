import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { axeViolations, BASE_URL, MOCK_STEP_UP_CODE, preferences, signInAs } from "./live-helpers";

/** D7.2 supplier portal and its staff screens against test/mock-api.mts (synthetic data). */
const QUARRY_ID = "60000000-0000-4000-8000-000000000001";
const OPEN_LPO = "73000000-0000-4000-8000-000000000007";
const ACKNOWLEDGED_LPO = "73000000-0000-4000-8000-000000000005";
const PARTLY_PAID = "75000000-0000-4000-8000-000000000001";
const DISPUTED = "75000000-0000-4000-8000-000000000002";

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const rawKeys = (page: Page) =>
  page.evaluate(() =>
    /\b(supplierPortal|suppliers\.portalUsers|apiErrors)\.[a-zA-Z]/.test(document.body.innerText),
  );
/** A small, valid PDF, unique per call (uploads are content-addressed). */
const pdf = () => ({
  name: "invoice.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from(`%PDF-1.4\n% ${randomUUID()}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`),
});
const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  route.fulfill({
    status,
    contentType: status >= 400 ? "application/problem+json" : "application/json",
    headers,
    body: JSON.stringify(body),
  });

async function stepUp(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Authenticator code").fill(MOCK_STEP_UP_CODE);
  await dialog.getByRole("button", { name: "Verify and continue" }).click();
}

test("a supplier sees its orders and deliveries and acknowledges an LPO", async ({
  page,
  context,
}) => {
  await signInAs(context, "supplier");
  await page.goto("/projects");
  await expect(page).toHaveURL("/supplier");
  await expect(
    page.getByRole("heading", { name: "Karibu, Achieng Otieno (synthetic)", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Supplier portal").first()).toBeVisible();
  await expect(page.getByTestId("outstanding")).toHaveText("KES 47,000");
  await expect(page.getByRole("link", { name: /Orders to acknowledge\s*1/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Invoices disputed\s*1/ })).toBeVisible();
  await expect(page.getByText(/never sends or confirms a payment/)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page
    .getByRole("navigation", { name: "Supplier portal pages" })
    .getByRole("link", { name: "Orders" })
    .click();
  await expect(page).toHaveURL("/supplier/lpos");
  await expect(page.getByText("LPO-0003")).toBeVisible();
  await expect(page.getByText("Cancelled").first()).toBeVisible();
  await page.getByRole("link", { name: "LPO-0007" }).click();
  await expect(page).toHaveURL(`/supplier/lpos/${OPEN_LPO}`);
  await expect(page.getByRole("heading", { name: /LPO-0007/, level: 1 })).toBeVisible();
  await expect(page.getByText("Ballast 20 mm").first()).toBeVisible();
  await expect(page.getByText("GRN-0011")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await expect(async () => {
    await page.getByRole("button", { name: "Acknowledge this order" }).click({ timeout: 2_000 });
    await expect(page.getByText(/Acknowledged by Achieng Otieno \(synthetic\) on/)).toBeVisible({
      timeout: 2_000,
    });
  }).toPass();
  await expect(page.getByRole("button", { name: "Acknowledge this order" })).toHaveCount(0);

  await page.goto("/supplier/deliveries");
  const delivery = page.getByRole("listitem").filter({ hasText: "GRN-0011" });
  await expect(delivery).toContainText("Wet and silty");
  await expect(delivery).toContainText("DN-4471");
  expect(await axeViolations(page)).toEqual([]);

  // Another supplier's or an unknown ID is a 404, like the API.
  await page.goto(`/supplier/lpos/${randomUUID()}`);
  await expect(page.getByText(/could not be found|not found/i).first()).toBeVisible();
});

test("a supplier submits an invoice with its eTIMS number and PDF on a phone", async ({
  page,
  context,
}) => {
  await signInAs(context, "supplier");
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(`/supplier/lpos/${OPEN_LPO}`);
  await page.getByRole("link", { name: "Submit an invoice" }).click();
  await expect(page).toHaveURL(`/supplier/lpos/${OPEN_LPO}/invoice`);
  await expect(page.getByRole("heading", { name: "Submit an invoice", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Total (KES)", { exact: true })).toHaveValue("53592");

  await page.getByLabel("Your invoice number").fill("MQ-INV-1001");
  await page.getByLabel("KRA eTIMS invoice number").fill("not etims!");
  await expect(page.getByText("This cannot be an eTIMS number.")).toBeVisible();
  await page.getByLabel("KRA eTIMS invoice number").fill("KRACU0400000078/2301");
  await expect(page.getByText("Looks like an eTIMS number.")).toBeVisible();
  await page.getByRole("button", { name: "Submit invoice" }).click();
  await expect(page.getByText("Attach your invoice document.")).toBeVisible();
  await page.getByLabel("Your invoice (PDF or photo)").setInputFiles(pdf());
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  // The invoice number is already this supplier's: refused, nothing created.
  await page.getByRole("button", { name: "Submit invoice" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already recorded" })).toBeVisible();

  await page.getByLabel("Your invoice number").fill("MQ-INV-1003");
  await page.getByRole("button", { name: "Submit invoice" }).click();
  await expect(page).toHaveURL(/\/supplier\/invoices\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "MQ-INV-1003", level: 1 })).toBeVisible();
  await expect(page.getByText("Under review").first()).toBeVisible();
  await expect(page.getByText("KRACU0400000078/2301")).toBeVisible();
  await expect(page.getByText(/uploaded by you/)).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  await page.goto("/supplier");
  await expect(page.getByRole("link", { name: /Invoices under review\s*1/ })).toBeVisible();
  await page.goto("/supplier/invoices");
  await expect(page.getByRole("link", { name: "MQ-INV-1003" })).toBeVisible();
});

test("an invoice shows the dispute reasons and the payments the company recorded", async ({
  page,
  context,
}) => {
  await signInAs(context, "supplier");
  await page.goto(`/supplier/invoices/${DISPUTED}`);
  await expect(page.getByRole("heading", { name: "Why this invoice is disputed" })).toBeVisible();
  await expect(page.getByText(/Line 1:/)).toBeVisible();
  expect(await rawKeys(page)).toBe(false);

  await page.goto(`/supplier/invoices/${PARTLY_PAID}`);
  await expect(page.getByText("Partly paid").first()).toBeVisible();
  await expect(page.getByText(/KES 40,000 on .* Bank transfer · ref\. FT-0001/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Why this invoice is disputed" })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
});

test("the statement adds approved invoices and takes off recorded payments", async ({
  page,
  context,
}) => {
  await signInAs(context, "supplier");
  await page.goto("/supplier/statement");
  const totals = page.getByTestId("statement-totals");
  await expect(totals).toContainText("Opening balanceKES 0");
  await expect(totals).toContainText("InvoicedKES 87,000");
  await expect(totals).toContainText("PaidKES 40,000");
  await expect(totals).toContainText("Closing balanceKES 47,000");
  await expect(page.getByText("Invoice MQ-INV-1001")).toBeVisible();
  await expect(
    page.getByText(/Payment for MQ-INV-1001 · Bank transfer · ref\. FT-0001/),
  ).toBeVisible();
  // The disputed invoice is listed apart, not on the balance.
  await expect(page.getByRole("heading", { name: /Not yet approved/ })).toBeVisible();
  await expect(page.getByText("MQ-INV-0998")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download PDF" })).toHaveAttribute(
    "href",
    /\/api\/v1\/portal\/supplier\/statement\/export\/pdf\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}&locale=en$/,
  );
  expect(await axeViolations(page)).toEqual([]);

  // One project only: the Ruiru order has nothing approved yet.
  await page.getByLabel("Project").selectOption({ label: "RUI-HTS · Ruiru Heights Apartments" });
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page).toHaveURL(/projectId=30000000-0000-4000-8000-000000000001/);
  await expect(totals).toContainText("Closing balanceKES 0");
  await expect(page.getByText("No invoices or payments in this period.")).toBeVisible();

  await page.goto("/supplier/statement?from=2026-12-01&to=2026-11-01");
  await expect(page.getByText(/Choose a start date on or before the end date/)).toBeVisible();
});

test("the supplier portal works in Kiswahili, dark mode, at 360 px", async ({ page, context }) => {
  test.slow();
  await signInAs(context, "supplier");
  await preferences(context, page, "sw", "dark");
  await page.setViewportSize({ width: 360, height: 760 });
  for (const path of [
    "/supplier",
    "/supplier/lpos",
    `/supplier/lpos/${ACKNOWLEDGED_LPO}`,
    `/supplier/lpos/${OPEN_LPO}`,
    `/supplier/lpos/${OPEN_LPO}/invoice`,
    "/supplier/deliveries",
    "/supplier/invoices",
    `/supplier/invoices/${PARTLY_PAID}`,
    `/supplier/invoices/${DISPUTED}`,
    "/supplier/statement",
  ]) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "sw");
    expect(await noHorizontalScroll(page), path).toBe(true);
    expect(await rawKeys(page), path).toBe(false);
    expect(await axeViolations(page), path).toEqual([]);
  }
  await page.goto("/supplier");
  await expect(page.getByText("Lango la msambazaji").first()).toBeVisible();
});

test("suppliers stay in their portal and staff stay out of it", async ({ page, context }) => {
  await signInAs(context, "supplier");
  for (const path of ["/projects", "/procurement/invoices", "/suppliers", "/portal", "/worker"])
    await page.goto(path).then(() => expect(page).toHaveURL("/supplier"));
  await context.clearCookies();
  await signInAs(context, "owner");
  for (const path of ["/supplier", "/supplier/statement"])
    await page.goto(path).then(() => expect(page).toHaveURL("/projects"));
});

test("a supplier contact joins from the invitation link", async ({ page }) => {
  await page.goto("/supplier/join");
  await expect(page.getByText("Open the link from your invitation email or SMS.")).toBeVisible();

  const token = "c".repeat(43);
  const calls: string[] = [];
  await page.route("**/api/v1/auth/register", async (route) => {
    calls.push("register");
    expect(route.request().postDataJSON()).toEqual({
      identifier: "accounts@mlolongo-quarry.example.test",
      displayName: "Achieng Otieno",
      password: "kokoto-ya-mlolongo-2026",
    });
    await json(route, { message: "Check your email for a code." });
  });
  await page.route("**/api/v1/auth/verify", async (route) => {
    calls.push("verify");
    const body = route.request().postDataJSON() as { code: string };
    if (body.code !== "424242") return json(route, { code: "unauthorized" }, 401);
    await json(route, { message: "Account verified." });
  });
  await page.route("**/api/v1/auth/login", async (route) => {
    calls.push("login");
    await json(
      route,
      {
        user: {
          id: "21000000-0000-4000-8000-000000000013",
          identifier: "accounts@mlolongo-quarry.example.test",
          displayName: "Achieng Otieno",
          verified: true,
          mfaEnabled: false,
          totpEnabled: false,
          passkeys: 0,
        },
        session: {
          id: "22000000-0000-4000-8000-000000000013",
          tenantId: null,
          mfaVerified: false,
          expiresAt: "2026-11-11T07:45:00.000Z",
        },
        mfaRequired: false,
      },
      200,
      { "Set-Cookie": `pmb_at=supplier.${randomUUID()}; Path=/; HttpOnly; SameSite=Lax` },
    );
  });
  await page.route("**/api/v1/tenants/invitations/accept", async (route) => {
    calls.push("accept");
    expect(route.request().postDataJSON()).toEqual({ token });
    await json(route, { message: "Invitation accepted." });
  });

  await page.goto(`/supplier/join?token=${token}`);
  await expect(page.getByRole("heading", { name: "Join the supplier portal" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    `/sign-in?next=${encodeURIComponent(`/supplier/join?token=${token}`)}`,
  );
  expect(await axeViolations(page)).toEqual([]);
  await page
    .getByLabel("Email or Kenyan mobile number")
    .fill(" Accounts@Mlolongo-Quarry.example.test ");
  await page.getByLabel("Your full name").fill("Achieng Otieno");
  await page.getByLabel("Choose a password").fill("kokoto-ya-mlolongo-2026");
  await page.getByRole("button", { name: "Create my account" }).click();
  await page.getByLabel("Verification code").fill("111111");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.locator("main [data-slot=card]").getByRole("alert")).toContainText(
    "That code is not right",
  );
  await page.getByLabel("Verification code").fill("424242");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page).toHaveURL("/supplier");
  expect(calls).toEqual(["register", "verify", "verify", "login", "accept"]);
});

test("staff invite and revoke a supplier's portal users and see supplier invoices", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto(`/suppliers/${QUARRY_ID}`);
  const panel = page.locator("[data-slot=card]").filter({
    has: page.getByRole("heading", { name: "Supplier portal users" }),
  });
  await expect(panel).toContainText("Achieng Otieno (synthetic)");
  await expect(panel).toContainText("Active");
  await expect(panel).toContainText("2 invoices submitted");

  await expect(async () => {
    await panel.getByRole("button", { name: "Invite a contact" }).click({ timeout: 2_000 });
    await expect(page.getByRole("dialog", { name: "Invite to the supplier portal" })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass();
  const invite = page.getByRole("dialog", { name: "Invite to the supplier portal" });
  await invite.getByLabel("Contact name").fill("Mwangi Njoroge");
  await invite.getByLabel("Email or Kenyan mobile number").fill("not-a-phone");
  await invite.getByRole("button", { name: "Send invitation" }).click();
  await expect(invite.getByText(/Enter an email address or a Kenyan mobile number/)).toBeVisible();
  await invite.getByLabel("Email or Kenyan mobile number").fill("0712 000 111");
  expect(await axeViolations(page)).toEqual([]);
  await invite.getByRole("button", { name: "Send invitation" }).click();
  await stepUp(page);
  await expect(panel.getByRole("status")).toHaveText("Invitation sent.");
  const invited = panel.getByRole("listitem").filter({ hasText: "Mwangi Njoroge" });
  await expect(invited).toContainText("Invited");
  await expect(invited).toContainText("254712000111");

  const active = panel.getByRole("listitem").filter({ hasText: "Achieng Otieno (synthetic)" });
  await active.getByRole("button", { name: "Revoke access" }).click();
  const revoke = page.getByRole("dialog", { name: "Revoke Achieng Otieno (synthetic)'s access" });
  await expect(revoke.getByRole("button", { name: "Revoke access" })).toBeDisabled();
  await revoke.getByLabel("Reason").fill("Left the quarry's accounts team");
  await revoke.getByRole("button", { name: "Revoke access" }).click();
  await expect(panel.getByRole("status")).toHaveText("Access revoked.");
  await expect(active).toContainText("Revoked");
  await expect(active).toContainText("Left the quarry's accounts team");
  await expect(active.getByRole("button", { name: "Revoke access" })).toHaveCount(0);

  // Invoices the supplier submitted are marked; the source filter finds them.
  await page.goto("/procurement/invoices?source=supplier_portal");
  const rows = page.getByRole("region", { name: "Supplier invoices" }).getByRole("row");
  await expect(page.getByRole("link", { name: "MQ-INV-1002" })).toBeVisible();
  await expect(page.getByRole("link", { name: "MQ-INV-1001" })).toHaveCount(0);
  await expect(rows.filter({ hasText: "MQ-INV-1002" })).toContainText("Submitted by the supplier");
  await page.getByRole("link", { name: "MQ-INV-1002" }).click();
  await expect(page.getByTestId("invoice-source")).toContainText("cannot be reopened");
  await expect(page.getByRole("button", { name: "Correct the invoice" })).toHaveCount(0);
});

test("a supplier whose access was revoked sees that, not the company's data", async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: "pmb_at", value: `supplier.revoked-${randomUUID()}`, url: BASE_URL, httpOnly: true },
  ]);
  for (const path of ["/supplier", "/supplier/invoices", "/supplier/statement"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "No supplier access" })).toBeVisible();
    await expect(page.getByText("MQ-INV-1001")).toHaveCount(0);
  }
  expect(await axeViolations(page)).toEqual([]);
});
