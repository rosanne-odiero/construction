import { expect, test, type Page } from "@playwright/test";
import { axeViolations, MOCK_STEP_UP_CODE, preferences, RUIRU_ID, signInAs } from "./live-helpers";
import { PAYROLL_BATCH_ID, PAYROLL_LINE_ID } from "./mock-payroll.mts";

const projectPath = `/payroll/projects/${RUIRU_ID}`;
const batchPath = `/payroll/batches/${PAYROLL_BATCH_ID}`;

async function build(page: Page) {
  await page.goto(projectPath);
  await page
    .getByRole("table", { name: "Pay periods", exact: true })
    .getByRole("button", { name: "Build draft batch" })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${batchPath}$`));
  await expect(page.getByRole("table", { name: "Payroll register" })).toContainText("Amina Wekesa");
}

test("builds from the live menu, previews a payslip and freezes a submitted snapshot", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/payroll");
  await expect(page.getByRole("heading", { name: "Payroll", exact: true })).toBeVisible();
  await expect(page.getByText(/Prototype: screens show mock data/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Payroll", exact: true })).toHaveAttribute(
    "href",
    "/payroll",
  );
  await build(page);
  await expect(page.getByText(/· Missing pay rate$/)).toBeVisible();
  await expect(page.getByText("Unverified rules", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: /W-0001 · Amina/ }).click();
  await expect(page).toHaveURL(new RegExp(`${batchPath}/lines/${PAYROLL_LINE_ID}$`));
  await expect(page.getByRole("heading", { name: "Payslip preview" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Earnings" })).toContainText("KES 6,000");
  await expect(page.getByText("Net pay: KES 5,050", { exact: true })).toBeVisible();
  await expect(page.getByText(/Calculation preview only/)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("link", { name: "Payroll batch", exact: true }).click();
  await page.getByRole("button", { name: "Submit and freeze" }).click();
  const request = page.waitForRequest(
    (req) => req.method() === "POST" && req.url().endsWith("/submit"),
  );
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  const sent = await request;
  expect(sent.headers()["idempotency-key"]).toMatch(/^[a-f0-9-]{36}$/);
  expect(sent.postDataJSON()).toEqual({ version: 1 });
  await expect(page.getByText("Submitted snapshot integrity verified.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Recalculate draft" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Submitted snapshot integrity verified.")).toBeVisible();
});

test("keeps stale and malformed command failures explicit and never navigates on false success", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await build(page);
  await page.route("**/api/v1/payroll/batches/*/recalculate", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/problem+json",
      body: JSON.stringify({ code: "version-conflict" }),
    }),
  );
  await page.getByRole("button", { name: "Recalculate draft" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.unroute("**/api/v1/payroll/batches/*/recalculate");
  await page.route("**/api/v1/payroll/batches/*/recalculate", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ batch: { id: PAYROLL_BATCH_ID } }),
    }),
  );
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(/answered unexpectedly/i);
  await expect(page).toHaveURL(new RegExp(`${batchPath}$`));
});

test("edits calendars and records validated allowances, gang output and a worker advance", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/payroll/settings");
  await page.getByRole("button", { name: "Edit pay calendar" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Pay frequency", { exact: true }).selectOption("fortnightly");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText(/Fortnightly ·/)).toBeVisible();
  await page.goto(`${projectPath}/inputs`);
  await page.getByRole("button", { name: "Add allowance", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Code", { exact: false }).fill("travel");
  await dialog.getByLabel("English name").fill("Travel allowance");
  await dialog.getByLabel("Swahili name").fill("Posho ya usafiri");
  await dialog.getByLabel("Amount (KES)", { exact: true }).fill("250.50");
  await dialog.getByLabel("Taxable", { exact: true }).selectOption("false");
  const allowance = page.waitForRequest(
    (req) => req.method() === "POST" && req.url().endsWith("/allowances"),
  );
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  expect((await allowance).postDataJSON()).toMatchObject({ amountMinor: 25050, taxable: false });
  await expect(page.getByText(/Travel allowance · KES 250.50/)).toBeVisible();
  await page.getByRole("button", { name: "Record output", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Gang (instead").selectOption("43000000-0000-4000-8000-000000000001");
  await dialog.getByLabel("Work description").fill("Blockwork for west wall");
  await dialog.getByLabel("Unit", { exact: true }).fill("m2");
  await dialog.getByLabel("Quantity", { exact: true }).fill("10");
  await dialog.getByLabel("Rate per unit (KES)").fill("100");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText(/Blockwork for west wall/)).toBeVisible();
  await page.goto("/payroll/advances");
  await page.getByRole("button", { name: /Request advance ·/ }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Worker", { exact: true })).toBeEnabled();
  await dialog
    .getByLabel("Worker", { exact: true })
    .selectOption("42000000-0000-4000-8000-000000000001");
  await dialog.getByLabel("Amount (KES)", { exact: true }).fill("500");
  await dialog.getByLabel("Reason", { exact: false }).fill("Synthetic travel emergency advance");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText(/Requested · KES 500/)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("verifies rules and downloads an audited export only after MFA, displaying template warnings", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/payroll/rules");
  await page.getByRole("button", { name: "Verify rule independently" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Review note")
    .fill("Synthetic independent professional review");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  let mfa = page.getByRole("dialog", { name: "Confirm it is you" });
  await mfa.getByLabel("Authenticator code").fill(MOCK_STEP_UP_CODE);
  await mfa.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByText("Verified · In force today", { exact: true })).toBeVisible();
  await build(page);
  await page.getByRole("button", { name: "Submit and freeze" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Submitted snapshot integrity verified.")).toBeVisible();
  await page.goto("/payroll/exports?month=2026-11");
  await expect(page.getByText(/CSVs are templates/)).toBeVisible();
  let calls = 0;
  await page.route("**/api/v1/payroll/exports", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ month: "2026-11", kind: "paye" });
    expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
    calls++;
    await route.fulfill(
      calls === 1
        ? {
            status: 403,
            contentType: "application/problem+json",
            body: JSON.stringify({ code: "step-up-required" }),
          }
        : { contentType: "text/csv", body: "# COMPLIANCE-REVIEW\nEmployee,Gross\nAmina,6000.00\n" },
    );
  });
  await page.getByRole("button", { name: "Download PAYE CSV" }).click();
  mfa = page.getByRole("dialog", { name: "Confirm it is you" });
  await mfa.getByLabel("Authenticator code").fill(MOCK_STEP_UP_CODE);
  const downloaded = page.waitForEvent("download");
  await mfa.getByRole("button", { name: "Verify and continue" }).click();
  expect((await downloaded).suggestedFilename()).toBe("pm-buddy-paye-2026-11.csv");
  expect(calls).toBe(2);
});

test("hides preparation controls from readers, handles forbidden access, and works in Swahili on mobile", async ({
  page,
  context,
}) => {
  await signInAs(context, "finance");
  await page.goto(projectPath);
  await expect(page.getByRole("button", { name: "Build draft batch" })).toHaveCount(0);
  await signInAs(context, "agent");
  await page.goto("/payroll");
  await expect(page.getByRole("heading", { name: /access|permission/i })).toBeVisible();
  await page.goto(`${projectPath}/inputs`);
  await expect(page.getByRole("button", { name: "Record output", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add allowance", exact: true })).toHaveCount(0);
  await signInAs(context, "owner");
  await preferences(context, page, "sw", "dark");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/payroll");
  await expect(page.getByRole("heading", { name: "Mishahara", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(await axeViolations(page)).toEqual([]);
});
