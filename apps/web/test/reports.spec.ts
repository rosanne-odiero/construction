import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  axeViolations,
  MAIN_PLOT_ID,
  MOCK_STEP_UP_CODE,
  preferences,
  RUIRU_ID,
  signInAs,
  switchPersona,
} from "./live-helpers";

/**
 * D8.1 reports centre against test/mock-api.mts (mock-reports.mts applies the API's rule:
 * reports.view plus the source screen's permission on the same project, and returns the shared
 * report model): the list by group with "not available yet", a report's form, preview and PDF and
 * Excel downloads, the muster roll's site choice, the audit log's MFA check and PDF row limit,
 * role limits, Kiswahili at 360 px, and email subscriptions with "send due emails now".
 */
const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const BATCH_ID = "61000000-0000-4000-8000-000000000001";

async function download(page: Page, name: string) {
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name }).click(),
  ]);
  return { name: file.suggestedFilename(), bytes: await readFile((await file.path())!) };
}

test("the owner runs the cost ledger and downloads it as PDF and Excel", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports", level: 1 })).toBeVisible();
  for (const group of ["Labour", "Finance and reconciliation", "Materials and procurement"])
    await expect(page.getByRole("heading", { name: group, level: 2 })).toBeVisible();
  // A report whose data is not built yet is listed as such, never as an empty report.
  const others = page.getByRole("region", { name: "Other reports" });
  await expect(others.getByRole("listitem").filter({ hasText: "M-Pesa payout" })).toContainText(
    "Not available yet · arrives with D4.3",
  );
  expect(await axeViolations(page)).toEqual([]);

  await expect(async () => {
    await page.getByRole("link", { name: /^Cost ledger/ }).click();
    await expect(page).toHaveURL(/\/reports\/cost-ledger$/, { timeout: 2_000 });
  }).toPass();
  await expect(page.getByRole("heading", { name: "Cost ledger", level: 1 })).toBeVisible();
  const form = page.getByRole("form", { name: "Report choices" });
  await expect(form.getByLabel("Project")).toHaveValue("");
  await expect(form.getByLabel("From")).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(async () => {
    await form.getByLabel("Project").selectOption(RUIRU_ID);
    await form.getByRole("button", { name: "Show report" }).click();
    await expect(page).toHaveURL(/projectId=/, { timeout: 2_000 });
  }).toPass();

  const report = page.getByRole("article", { name: "Cost ledger" });
  await expect(report).toContainText("Jenga Bora Builders Ltd");
  await expect(report).toContainText("RUI-HTS · Ruiru Heights Apartments");
  await expect(report).toContainText(/Generated .* \(Nairobi time\) by Wanjiru Kamau/);
  const entries = report.getByRole("region", { name: "Entries" });
  await expect(entries.getByRole("row").filter({ hasText: "INV-0042" })).toContainText(
    "KES 232,000",
  );
  await expect(entries.getByRole("row").filter({ hasText: "Total" })).toContainText("KES 291,500");
  expect(await axeViolations(page)).toEqual([]);

  const pdf = await download(page, "Download PDF");
  expect(pdf.name).toBe("cost-ledger.pdf");
  expect(pdf.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  const xlsx = await download(page, "Download Excel");
  expect(xlsx.name).toBe("cost-ledger.xlsx");
  expect(xlsx.bytes.subarray(0, 2).toString("latin1")).toBe("PK");
});

test("the muster roll needs a site; the form offers the chosen project's sites", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/reports/muster-roll");
  await expect(page.getByRole("heading", { name: "Muster roll", level: 1 })).toBeVisible();
  const form = page.getByRole("form", { name: "Report choices" });
  await expect(form.getByLabel("Site")).toBeDisabled();
  await expect(async () => {
    await form.getByLabel("Project").selectOption(RUIRU_ID);
    await expect(form.getByLabel("Site").locator("option", { hasText: "Main plot" })).toHaveCount(
      1,
      { timeout: 2_000 },
    );
  }).toPass();
  await form.getByLabel("Site").selectOption(MAIN_PLOT_ID);
  await form.getByRole("button", { name: "Show report" }).click();
  const muster = page.getByRole("article", { name: "Muster roll" });
  await expect(muster).toContainText("Main plot");
  const table = muster.getByRole("region", { name: "Muster roll" }).first();
  await expect(table.getByRole("columnheader", { name: "Days present" })).toBeVisible();
  await expect(muster).toContainText("P present · H half day · A absent");
  expect(await axeViolations(page)).toEqual([]);

  // Without a site the API refuses with a problem the page explains.
  await page.goto(`/reports/muster-roll?projectId=${RUIRU_ID}`);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Choose a site.");
});

test("the audit log asks for a recent verification and is too long for a PDF", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/reports/audit-log?run=1");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "This report needs a recent two-step verification.",
  );
  await expect(async () => {
    await page.getByRole("button", { name: "Verify and show the report" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await page.getByRole("dialog").getByLabel("Authenticator code").fill(MOCK_STEP_UP_CODE);
  await page.getByRole("dialog").getByRole("button", { name: "Verify and continue" }).click();
  const log = page.getByRole("article", { name: "Audit log" });
  await expect(log).toContainText(/Showing the first 200 of 5,?120 rows\./);
  // Above the PDF limit the page offers Excel only.
  await expect(page.getByText(/5,?120 rows is too many for a PDF; download Excel\./)).toBeVisible();
  await expect(page.getByRole("link", { name: "Download PDF" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Download Excel" })).toBeVisible();
});

test("a project manager reports on assigned projects only; a site agent has no reports", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "pm");
  await page.goto("/reports");
  // The audit log needs audit.view: listed with its rule, not runnable.
  await expect(
    page
      .getByRole("region", { name: "Other reports" })
      .getByRole("listitem")
      .filter({ hasText: "Audit log" }),
  ).toContainText("audit.view");
  await page.goto("/reports/cost-ledger");
  const project = page.getByRole("form", { name: "Report choices" }).getByLabel("Project");
  await expect(project.locator("option")).toHaveText([
    "All my projects",
    "RUI-HTS · Ruiru Heights Apartments",
  ]);
  // Another project by URL: refused, as on the source screen.
  await page.goto("/reports/cost-ledger?projectId=30000000-0000-4000-8000-000000000002");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "You may not run this report for these choices.",
  );

  await switchPersona(context, "agent", token);
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "You do not have access" })).toBeVisible();
});

test("the payroll register in Kiswahili on a 360 px phone", async ({ page, context }) => {
  await preferences(context, page, "sw");
  await signInAs(context, "owner");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/reports/payroll-register?projectId=${RUIRU_ID}&batchId=${BATCH_ID}`);
  await expect(page.getByRole("heading", { name: "Daftari la mishahara", level: 1 })).toBeVisible();
  const register = page.getByRole("article", { name: "Daftari la mishahara" });
  await expect(register.getByRole("columnheader", { name: "Mshahara halisi" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Pakua PDF" })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
});

test("subscribe to a report, pause, resume and delete it; admins send due emails", async ({
  page,
  context,
}) => {
  test.slow();
  await signInAs(context, "owner");
  await page.goto("/reports/stock?run=1");
  await expect(page.getByRole("article", { name: "Stock" })).toBeVisible();
  await expect(async () => {
    await page.getByRole("button", { name: "Email me this report" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2_000 });
  }).toPass();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("The email carries no figures");
  await dialog.getByLabel("Every month").check();
  await dialog.getByLabel("Day of the month").fill("31");
  await dialog.getByRole("button", { name: "Subscribe" }).click();
  await expect(dialog.getByRole("status")).toContainText("Subscribed.");
  await dialog.getByRole("link", { name: "Scheduled emails" }).click();

  await expect(page.getByRole("heading", { name: "Scheduled emails", level: 1 })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Every month on day 31" });
  await expect(row).toContainText("Stock");
  await expect(row).toContainText("Active");
  expect(await axeViolations(page)).toEqual([]);
  await row.getByRole("button", { name: "Pause" }).click();
  await expect(row).toContainText("Paused");
  await row.getByRole("button", { name: "Resume" }).click();
  await expect(row).toContainText("Active");
  page.once("dialog", (confirm) => void confirm.accept());
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Every month on day 31" })).toHaveCount(0);

  // The company view: the seeded weekly cost ledger is due; "send due emails now" sends it.
  await page.getByRole("link", { name: "Company", exact: true }).click();
  await expect(page).toHaveURL(/scope=company/);
  await page.getByRole("button", { name: "Send due emails now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "sent" })).toContainText(
    "1 sent, 0 skipped, 0 failed.",
  );
  const runs = page.getByRole("region", { name: "Recent runs" }).first();
  await expect(runs.getByRole("row").filter({ hasText: "Cost ledger" })).toContainText("Sent");
});
