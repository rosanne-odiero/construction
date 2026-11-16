import { expect, test, type Page } from "@playwright/test";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import {
  axeViolations,
  MOCK_STEP_UP_CODE,
  preferences,
  signInAs,
  switchPersona,
} from "./live-helpers";
import { HISTORY_RECEIPTS } from "./mock-payouts.mts";

/** D4.3 M-Pesa reconciliation: the day, items, statements, resolution and the charges tariff. */

const ddmmyyyy = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

async function stepUp(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Authenticator code").fill(MOCK_STEP_UP_CODE);
  await dialog.getByRole("button", { name: "Verify and continue" }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * An organisation-portal style export for today (synthetic): the earlier batch's two payouts with
 * their charges (one charge differs from the DEMO tariff), a withdrawal PM-Buddy never made and a
 * row without a receipt.
 */
function statement() {
  const day = nairobiDate();
  const at = (time: string) => `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)} ${time}`;
  return Buffer.from(
    [
      '"Account Name:","JENGA BORA BUILDERS LTD"',
      '"Short Code:","600000"',
      "",
      '"Receipt No.","Completion Time","Initiation Time","Details","Transaction Status","Paid In","Withdrawn","Balance","Reason Type","Other Party Info","Linked Transaction ID","A/C No."',
      `"${HISTORY_RECEIPTS.amina}","${at("09:15:02")}","","Salary Payment to 254700000101 - AMINA WEKESA","Completed","","-4,200.00","95,800.00","Salary Payment","254700000101 - AMINA WEKESA","",""`,
      `"TKH7AB0003","${at("09:15:02")}","","Salary Payment Charge","Completed","","-9.00","95,791.00","Business Payment Charge","","${HISTORY_RECEIPTS.amina}",""`,
      `"${HISTORY_RECEIPTS.grace}","${at("09:16:10")}","","Salary Payment to 254700000103 - GRACE ATIENO","Completed","","-3,500.00","92,291.00","Salary Payment","254700000103 - GRACE ATIENO","",""`,
      `"TKH7AB0004","${at("09:16:10")}","","Salary Payment Charge","Completed","","-13.00","92,278.00","Business Payment Charge","","${HISTORY_RECEIPTS.grace}",""`,
      `"TKX9ZZ0005","${at("11:00:00")}","","Business Payment to 254799999999 - UNKNOWN","Completed","","-50,000.00","42,278.00","Business Payment","254799999999 - UNKNOWN","",""`,
      `"","${at("12:00:00")}","","Broken row","Completed","","-10.00","","","","",""`,
    ].join("\r\n"),
  );
}

async function upload(page: Page) {
  const box = page.getByRole("region", { name: "Upload an M-Pesa statement" });
  await box.getByLabel("Statement file (CSV or XLSX, up to 5 MB)").setInputFiles({
    name: "mpesa-statement.csv",
    mimeType: "text/csv",
    buffer: statement(),
  });
  await box.getByLabel("Note (optional)").fill("Synthetic organisation portal export");
  await box.getByRole("button", { name: "Upload statement" }).click();
  return box;
}

test("shows the day by category and severity, filters items and links an uncertain payout to its case", async ({
  page,
  context,
}) => {
  await signInAs(context, "finance");
  await page.goto("/dashboard");
  await page.getByRole("link", { name: "M-Pesa reconciliation" }).click();
  await expect(page).toHaveURL(/\/payments\/reconciliation$/);
  await expect(page.getByRole("heading", { name: "M-Pesa reconciliation", level: 1 })).toBeVisible();
  const day = page.getByRole("region", { name: `Reconciliation for ${ddmmyyyy(nairobiDate())}` });
  await expect(day).toContainText("No statement for this day yet");
  await expect(day).toContainText("Unmatched3");
  await expect(day).toContainText("Awaiting a statement2");
  await expect(
    page.getByText(/Confirm it against a real M-Pesa export at the sandbox gate/),
  ).toBeVisible();
  const items = page.getByRole("table", { name: "Reconciliation items" });
  await expect(items.getByRole("row", { name: /Payout not on a statement/ })).toHaveCount(2);
  await expect(items).toContainText("awaiting statement");
  expect(await axeViolations(page)).toEqual([]);

  await page.getByLabel("Kind").selectOption("uncertain");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page).toHaveURL(/kind=uncertain/);
  await expect(items.getByRole("row")).toHaveCount(2);
  await items.getByRole("link", { name: "Uncertain payout" }).click();
  await expect(page.getByRole("heading", { name: "Uncertain payout", level: 2 })).toBeVisible();
  await expect(page.locator("#main")).toContainText("never resend it");
  await page.getByRole("link", { name: "Payments console case" }).click();
  await expect(page).toHaveURL(/\/payments\/cases\/[0-9a-f-]{36}$/);
  await expect(page.locator("#main")).toContainText("Unknown payment outcome");
});

test("uploads a statement with an unread row, re-reconciles and resolves items under maker-checker", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "finance");
  await page.goto("/payments/reconciliation");
  const box = await upload(page);
  const result = box.getByRole("status");
  await expect(result).toContainText(
    "mpesa-statement.csv: 5 lines read, 1 rows could not be read.",
  );
  await expect(result).toContainText("Row 10: No receipt (Receipt)");
  await expect(result).toContainText(`Re-reconciled: ${ddmmyyyy(nairobiDate())}`);
  await expect(page.getByRole("alert").filter({ hasText: "critical item" })).toContainText(
    "1 critical item needs attention",
  );
  const items = page.getByRole("table", { name: "Reconciliation items" });
  await expect(items).toContainText("Withdrawal PM-Buddy did not make");
  await expect(items).toContainText("Charge mismatch");
  await expect(items).toContainText("Matched automatically");

  await items.getByRole("link", { name: "Charge mismatch" }).click();
  const item = page.getByRole("region", { name: "Charge mismatch" });
  await expect(item).toContainText("Charge (booked / statement)KES 9 / KES 13");
  await expect(item).toContainText("Statement row");
  await page.getByRole("button", { name: "Assign to me" }).click();
  await expect(item).toContainText("OwnerDaniel Mwangi");
  await page.getByLabel("Note (3–1,000 characters)").fill("Asked Safaricom for the tariff letter");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByText("Note added.")).toBeVisible();
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Resolve this item" });
  await dialog.getByLabel("Outcome").selectOption("explained");
  await dialog.getByLabel("Reason (10–500 characters)").fill("Tariff band changed on the statement date");
  await dialog.getByRole("button", { name: "Resolve" }).click();
  await stepUp(page);
  await expect(dialog.getByRole("alert")).toContainText(
    "You started or recorded this payout, so another reviewer must resolve this item.",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await switchPersona(context, "owner", token);
  await page.reload();
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Resolve this item" });
  await dialog.getByLabel("Outcome").selectOption("charge_journal");
  await expect(dialog.getByLabel("Cost journal ID")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Resolve" })).toBeDisabled();
  await dialog.getByLabel("Outcome").selectOption("explained");
  await dialog.getByLabel("Reason (10–500 characters)").fill("Tariff band changed on the statement date");
  await dialog.getByRole("button", { name: "Resolve" }).click();
  await stepUp(page);
  await expect(item).toContainText("Resolved: Explained");
  const history = page.getByRole("region", { name: "History" });
  for (const event of ["Opened", "Assigned", "Note", "Resolved"])
    await expect(history).toContainText(event);
  await expect(history).toContainText("Asked Safaricom for the tariff letter");
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("link", { name: `Back to ${ddmmyyyy(nairobiDate())}` }).click();
  await page.getByRole("link", { name: "mpesa-statement.csv" }).click();
  await expect(page.getByRole("heading", { name: "M-Pesa statement", level: 1 })).toBeVisible();
  await expect(page.locator("#main")).toContainText("Rows that could not be read (1)");
  const lines = page.getByRole("table", { name: "Statement lines" });
  await expect(lines.getByRole("row")).toHaveCount(6);
  await expect(lines).toContainText("2547•••••101 - A. W.");
  await expect(lines).not.toContainText("254700000101");
  await expect(lines).not.toContainText("AMINA WEKESA");
  await page.getByLabel("Line type").selectOption("charge");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(lines.getByRole("row")).toHaveCount(3);
  await page.goto("/payments/reconciliation");
  await upload(page);
  await expect(
    page.getByRole("region", { name: "Upload an M-Pesa statement" }).getByRole("alert"),
  ).toContainText("This statement file was already uploaded.");
});

test("runs a day again, opens a worker dispute on a payout and lists statements", async ({
  page,
  context,
}) => {
  await signInAs(context, "finance");
  await page.goto("/payments/reconciliation");
  const run = page.getByRole("region", { name: "Run reconciliation now" });
  await run.getByRole("button", { name: "Run now" }).click();
  await expect(run.getByRole("status")).toContainText(
    `Reconciled ${ddmmyyyy(nairobiDate())}: 0 new, 0 updated, 0 superseded.`,
  );
  await expect(page.locator("#main")).toContainText("(run by hand)");
  const items = page.getByRole("table", { name: "Reconciliation items" });
  await items.getByRole("link", { name: "Payout not on a statement" }).first().click();
  await page.getByRole("button", { name: "Open worker dispute" }).click();
  const dialog = page.getByRole("dialog", { name: "Open a worker dispute" });
  await dialog.getByLabel("Reason (10–500 characters)").fill("Worker says the money never arrived");
  await dialog.getByRole("button", { name: "Open worker dispute" }).click();
  await expect(page.getByRole("heading", { name: "Worker dispute", level: 2 })).toBeVisible();
  await expect(page.getByRole("region", { name: "History" })).toContainText(
    "Worker says the money never arrived",
  );
  const outcomes = page.getByRole("button", { name: "Resolve", exact: true });
  await outcomes.click();
  await expect(
    page.getByRole("dialog", { name: "Resolve this item" }).getByLabel("Outcome").getByRole("option"),
  ).toHaveText(["Dispute upheld", "Dispute rejected", "Escalated to the owner"]);
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Statements", exact: true }).click();
  await expect(page.getByRole("heading", { name: "M-Pesa statements", level: 1 })).toBeVisible();
  await expect(page.locator("#main")).toContainText("No statements uploaded yet.");
  const yesterday = addCalendarDays(nairobiDate(), -1);
  await page.goto(`/payments/reconciliation?date=${yesterday}`);
  await expect(
    page.getByRole("region", { name: `Reconciliation for ${ddmmyyyy(yesterday)}` }),
  ).toContainText("Not run yet for this day.");
});

test("keeps the DEMO tariff visible and adds a validated version with step-up", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/payments/tariffs");
  await expect(page.getByRole("heading", { name: "M-Pesa charges tariff", level: 1 })).toBeVisible();
  await expect(page.locator("#main")).toContainText("DEMO: these bands are placeholders");
  const current = page.getByRole("article", { name: "Tariff from 01/01/2024" });
  await expect(current.getByText("DEMO", { exact: true })).toBeVisible();
  await expect(current).toContainText("In force today");
  await expect(current).toContainText("KES 1 – KES 100: charge KES 0");
  const form = page.getByRole("region", { name: "Add a tariff version" });
  const tomorrow = addCalendarDays(nairobiDate(), 1);
  await form.getByLabel("Effective from").fill(tomorrow);
  await form.getByLabel("Band 2: up to (KES)").fill("50");
  await expect(form).toContainText("Each band must end above the one before.");
  await expect(form.getByRole("button", { name: "Save tariff version" })).toBeDisabled();
  await form.getByLabel("Band 2: up to (KES)").fill("1500");
  await form.getByLabel("Band 5: charge (KES)").fill("15");
  await form.getByLabel("Source").fill("Synthetic tariff letter dated today, page 2");
  const saved = page.waitForRequest(
    (request) => request.method() === "PUT" && request.url().endsWith("/payments/tariffs"),
  );
  await form.getByRole("button", { name: "Save tariff version" }).click();
  await stepUp(page);
  expect((await saved).postDataJSON()).toMatchObject({
    kind: "b2c",
    effectiveFrom: tomorrow,
    status: "demo",
    bands: expect.arrayContaining([{ upToMinor: 25_000_000, chargeMinor: 1_500 }]),
  });
  await expect(page.getByRole("article", { name: `Tariff from ${ddmmyyyy(tomorrow)}` })).toContainText(
    "Wanjiru Kamau",
  );
  await expect(current).toContainText(`01/01/2024 – ${ddmmyyyy(nairobiDate())}`);
  expect(await axeViolations(page)).toEqual([]);
});

test("is hidden from staff without payments.view and works in Kiswahili on a phone", async ({
  page,
  context,
}) => {
  await signInAs(context, "agent");
  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: "M-Pesa reconciliation" })).toHaveCount(0);
  await page.goto("/payments/reconciliation");
  await expect(page.getByRole("heading", { name: /access|permission/i })).toBeVisible();

  await signInAs(context, "finance");
  await preferences(context, page, "sw", "dark");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/payments/reconciliation");
  await expect(page.getByRole("heading", { name: "Upatanisho wa M-Pesa", level: 1 })).toBeVisible();
  await expect(page.locator("#main")).toContainText("Malipo hayapo kwenye taarifa");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.goto("/payments/tariffs");
  await expect(page.getByRole("heading", { name: "Jedwali la ada za M-Pesa", level: 1 })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
});
