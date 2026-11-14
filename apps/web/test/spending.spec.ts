import { expect as baseExpect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  axeViolations,
  MOCK_CSRF,
  MOCK_STEP_UP_CODE,
  preferences,
  RUIRU_ID,
  signInAs,
  switchPersona,
  type Persona,
} from "./live-helpers";

/**
 * D5.4 spending against test/mock-api.mts (test/mock-spending.mts). Ruiru Heights has an approved
 * budget v1: three BQ items (KES 1,138,800), MAT-01 materials KES 120,000 and PC-01 petty cash
 * KES 5,000. The ledger holds MQ-INV-1001 (KES 78,000 accrued and paid) and five approved
 * petty-cash expenses; LPOs not yet invoiced commit KES 94,800 of materials. Worked by hand:
 * - materials: 78,000 + 850 actual + 94,800 committed = 173,650 against 120,000 → 144.7 %, over;
 * - petty cash: 600 + 900 + 2,400 = 3,900 against 5,000 → 78.0 %, within the 80 % threshold;
 * - plant has no budget line: its percentage is unavailable, never zero;
 * - the main plot float holds 30,000 − 6,334 = KES 23,666 before the tests.
 * Synthetic data only.
 */
const expect = baseExpect.configure({ timeout: 20_000 });
test.describe.configure({ timeout: 300_000 });

const FLOAT_ID = "75000000-0000-4000-8000-000000000001";
const AGENT_ID = "21000000-0000-4000-8000-000000000003";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

async function api(page: Page, method: string, path: string, data?: object) {
  const res = await page.request.fetch(`/api/v1${path}`, {
    method,
    headers: { "X-CSRF-Token": MOCK_CSRF, "Content-Type": "application/json" },
    data,
  });
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

async function as(context: BrowserContext, page: Page, persona: Persona, token: string) {
  await switchPersona(context, persona, token);
  if (persona !== "agent") {
    const stepped = await api(page, "POST", "/auth/mfa/step-up", { code: MOCK_STEP_UP_CODE });
    expect(stepped.status).toBe(200);
  }
  await page.reload();
}

/** Opens a command's confirmation, fills its inputs and confirms it. */
async function command(
  page: Page,
  button: string,
  confirm: string,
  fill: Record<string, string> = {},
) {
  await page.getByRole("button", { name: button, exact: true }).first().click();
  const dialog = page.getByRole("dialog").last();
  for (const [label, value] of Object.entries(fill)) await dialog.getByLabel(label).fill(value);
  await dialog.getByRole("button", { name: confirm, exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function expectNoHorizontalScroll(page: Page, label: string) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    label,
  ).toBe(true);
}

/** The owner lets the site agent hold petty cash on Ruiru Heights. */
async function grantPettyCash(page: Page) {
  await page.goto("/spending");
  await api(page, "POST", "/auth/mfa/step-up", { code: MOCK_STEP_UP_CODE });
  const granted = await api(page, "PUT", `/projects/${RUIRU_ID}/members/${AGENT_ID}`, {
    permissions: ["projects.view", "site.diary", "bq.view", "finance.petty_cash"],
  });
  expect(granted.status).toBe(200);
}

const smsDate = () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" }).format(new Date());
  return `${today.slice(8, 10)}/${today.slice(5, 7)}/${today.slice(2, 4)}`;
};

test("spending: budget against committed, actual and paid with drill-down, the ledger, forecast and alerts", async ({
  page,
  context,
}) => {
  await preferences(context, page);
  await signInAs(context, "finance");

  await page.goto("/spending");
  await expect(
    page.getByRole("heading", { level: 1, name: "Spending and cash flow" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /RUI-HTS · / })).toBeVisible();
  await expect(page.getByText("Budget v1 in force")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // The project: materials over budget, petty cash within, plant without a budget.
  await page.getByRole("link", { name: /RUI-HTS · / }).click();
  await expect(page.getByRole("heading", { level: 1, name: /RUI-HTS · / })).toBeVisible();
  const categories = page.getByRole("region", { name: "By category" });
  await expect(categories.getByRole("row", { name: /^Materials/ })).toContainText("KES 120,000");
  await expect(categories.getByRole("row", { name: /^Materials/ })).toContainText(
    "144.7% — over budget",
  );
  await expect(categories.getByRole("row", { name: /^Petty cash/ })).toContainText("78.0% used");
  await expect(categories.getByRole("row", { name: /^Plant/ })).toContainText("No budget");
  await expect(categories.getByRole("row", { name: /^Plant/ })).toContainText("Unavailable");
  await expect(page.getByText("Bought (approved invoices, net)")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // Drill down to the bill's items: column bases carry the binding wire bought from petty cash.
  await page.getByRole("link", { name: "Bill 2 · Substructure (synthetic)" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Bill 2 · Substructure (synthetic)" }),
  ).toBeVisible();
  await expect(page.getByRole("row", { name: /column bases/ })).toContainText("KES 850");
  expect(await axeViolations(page)).toEqual([]);

  // The cost ledger, filtered to petty cash.
  await page.goto("/spending/ledger");
  await expect(page.getByRole("heading", { level: 1, name: "Cost ledger" })).toBeVisible();
  await expect(page.getByRole("link", { name: "MQ-INV-1001" }).first()).toBeVisible();
  await page.getByLabel("Category").selectOption("petty_cash");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("status").filter({ hasText: "entries" })).toContainText(
    "6 entries: accrued KES 3,900, paid KES 3,900",
  );
  expect(await axeViolations(page)).toEqual([]);

  // The forecast: a table and a chart, the client instalment and the estimated LPO payment.
  await page.goto("/spending/forecast");
  await expect(page.getByRole("heading", { level: 1, name: "Cash-flow forecast" })).toBeVisible();
  await expect(
    page.getByRole("img", { name: /Money in, money out and the closing balance/ }),
  ).toBeVisible();
  await expect(page.getByText(/Opening KES 2,370,000/)).toBeVisible();
  await expect(page.getByText("Client instalment 3 (synthetic)").first()).toBeVisible();
  await expect(page.getByText("LPOs not yet invoiced").first()).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // Alerts: materials over budget, a likely duplicate at the same shop and an expense without a receipt.
  await page.goto("/spending/alerts");
  await expect(page.getByRole("heading", { level: 1, name: "Spend alerts" })).toBeVisible();
  await expect(
    page.getByText(/Materials: KES 173,650 used and committed against a budget of KES 120,000/),
  ).toBeVisible();
  await expect(page.getByText(/The same payee was paid KES 850 twice/)).toBeVisible();
  await expect(page.getByText(/KES 850 paid without a receipt/)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // 360 px: no horizontal scroll on the main screens.
  await page.setViewportSize({ width: 360, height: 800 });
  for (const path of [
    "/spending",
    `/spending/projects/${RUIRU_ID}`,
    "/spending/ledger",
    "/spending/forecast",
    "/spending/alerts",
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page, path);
  }
});

test("petty cash: an expense filled from a pasted SMS at 360 px with a receipt, approved by someone else; duplicates named", async ({
  page,
  context,
}) => {
  await preferences(context, page);
  const token = await signInAs(context, "owner");
  await grantPettyCash(page);
  await switchPersona(context, "agent", token);
  await page.setViewportSize({ width: 360, height: 800 });

  // The custodian sees petty cash but no budgets.
  await page.goto("/spending");
  await expect(page.getByText("No project budgets to show")).toBeVisible();
  await page.goto(`/spending/petty-cash/${FLOAT_ID}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Main plot float (synthetic)" }),
  ).toBeVisible();
  await expect(page.getByText("KES 23,666").first()).toBeVisible();
  await page.getByRole("link", { name: "Record an expense" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Record an expense" })).toBeVisible();

  const sms = `SKG1H2J3K4 Confirmed. Ksh1,250.00 paid to MAMA MBOGA KIOSK (SYNTHETIC). on ${smsDate()} at 9:05 AM.New M-PESA balance is Ksh3,210.00. Transaction cost, Ksh0.00.`;
  await page.getByLabel("M-Pesa confirmation message").fill(sms);
  await page.getByRole("button", { name: "Fill from SMS" }).click();
  await expect(page.getByText("Draft from an SMS: it does not confirm the payment.")).toBeVisible();
  await expect(page.getByLabel("Amount (KES)")).toHaveValue("1250");
  await expect(page.getByLabel("M-Pesa code")).toHaveValue("SKG1H2J3K4");
  await expect(page.getByLabel("Paid to")).toHaveValue("MAMA MBOGA KIOSK (SYNTHETIC)");
  // A padded amount is trimmed, a tag is required, and the tag comes from a server-side search.
  await page.getByLabel("Amount (KES)").fill(" 1,250 ");
  await page.getByLabel("What it was for").fill("Sukuma and tea for the slab crew (synthetic)");
  await page.getByRole("button", { name: "Record expense" }).click();
  await expect(page.getByText("Tag the expense with a BQ item or a cost code.")).toBeVisible();
  await page.getByLabel("Find a cost code").fill("PC");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "PC-01 · Petty-cash sundries" }).click();
  await page
    .getByLabel("Receipt photo")
    .setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await expectNoHorizontalScroll(page, "expense form at 360 px");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Record expense" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Expense EXP-0007" })).toBeVisible();
  await expect(page.getByText(/Filled from an M-Pesa SMS \(Buy goods \(till\)\)/)).toBeVisible();
  await expect(
    page.getByText("Waiting for an independent approval. The cash has already left the float."),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Receipt photo added by Kevin Kiprono" }),
  ).toBeVisible();
  // The custodian cannot approve their own expense.
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expectNoHorizontalScroll(page, "expense at 360 px");
  expect(await axeViolations(page)).toEqual([]);
  const expenseUrl = page.url();

  // The same SMS again: the parser names the expense already holding that M-Pesa code.
  await page.goto(`/spending/petty-cash/${FLOAT_ID}/expense`);
  await page.getByLabel("M-Pesa confirmation message").fill(sms);
  await page.getByRole("button", { name: "Fill from SMS" }).click();
  await expect(page.getByText(/Already recorded: EXP-0007/)).toBeVisible();

  // The project manager approves it: it posts to the cost ledger.
  await page.goto(expenseUrl);
  await as(context, page, "pm", token);
  await command(page, "Approve", "Approve");
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  await page.goto(`/spending/ledger?project=${RUIRU_ID}&source=petty_cash_expense`);
  await expect(page.getByRole("link", { name: "EXP-0007" }).first()).toBeVisible();
});

test("petty cash: top-up asked, approved and paid by three people; a count with a shortage approved independently", async ({
  page,
  context,
}) => {
  await preferences(context, page);
  const token = await signInAs(context, "owner");
  await grantPettyCash(page);
  await switchPersona(context, "agent", token);

  await page.goto(`/spending/petty-cash/${FLOAT_ID}`);
  await command(page, "Ask for a top-up", "Ask for a top-up", {
    Amount: "10000",
    "Why the float needs it": "Next week's sundries (synthetic)",
  });
  await expect(page.getByText("TOP-0002").first()).toBeVisible();

  // Finance approves but cannot also pay; the owner pays.
  await as(context, page, "finance", token);
  await command(page, "Approve", "Approve");
  await expect(page.getByText("Approved, not paid")).toBeVisible();
  await expect(page.getByRole("button", { name: "Record payment" })).toHaveCount(0);
  await as(context, page, "owner", token);
  await command(page, "Record payment", "Record payment", { "Payment reference": "SKH2J3K4L5" });
  await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("KES 33,666").first()).toBeVisible();

  // The custodian counts KES 33,500: KES 166 short; the project manager approves the count.
  await as(context, page, "agent", token);
  await command(page, "Count the cash", "Count the cash", { "Counted cash": "33,500" });
  await expect(page.getByText("Shortage")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve count" })).toHaveCount(0);
  await as(context, page, "pm", token);
  await command(page, "Approve count", "Approve count");
  await expect(page.getByText("KES 33,500").first()).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("budgets and journals: prepared, submitted and approved by different people; a ledger reversal is maker-checked", async ({
  page,
  context,
}) => {
  await preferences(context, page);
  const token = await signInAs(context, "pm");

  await page.goto(`/spending/budgets?project=${RUIRU_ID}`);
  await expect(page.getByRole("heading", { level: 1, name: "Budgets" })).toBeVisible();
  await page.getByRole("button", { name: "New version" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Ruiru Heights budget, revised (synthetic)");
  await dialog.getByLabel("Start from").selectOption("copy");
  await dialog.getByRole("button", { name: "New version" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Budget v2 · / })).toBeVisible();
  const addLine = page
    .locator("form")
    .filter({ has: page.getByRole("heading", { name: "Add a line" }) });
  await addLine.getByLabel("Find a cost code").fill("TRN");
  await addLine.getByRole("button", { name: "Search", exact: true }).click();
  await addLine.getByRole("button", { name: "TRN-01 · Transport and deliveries" }).click();
  await addLine.getByLabel("Amount (KES)").fill("20,000");
  await addLine.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByRole("row", { name: /TRN-01/ })).toContainText("KES 20,000");
  expect(await axeViolations(page)).toEqual([]);
  await command(page, "Submit for approval", "Submit for approval");
  await expect(
    page.getByText("Submitted: waiting for an independent finance manager."),
  ).toBeVisible();
  // The preparer holds no finance.manage: no approval for them.
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);

  await as(context, page, "finance", token);
  await command(page, "Approve", "Approve");
  await expect(page.getByText("In force").first()).toBeVisible();

  // Finance proposes a reversal from the ledger; only someone else can post it.
  await page.goto(`/spending/ledger?project=${RUIRU_ID}&source=supplier_invoice`);
  await page.getByRole("button", { name: "Reverse" }).first().click();
  const reverse = page.getByRole("dialog");
  await reverse.getByLabel("Reason").fill("Invoice entered against the wrong project (synthetic)");
  await reverse.getByRole("button", { name: "Propose reversal" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "JNL-0001 · Reversal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and post" })).toHaveCount(0);
  await as(context, page, "owner", token);
  await command(page, "Approve and post", "Approve and post");
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  await page.goto(`/spending/ledger?project=${RUIRU_ID}&source=supplier_invoice`);
  await expect(page.getByText("Reversed").first()).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("spending in Kiswahili and dark mode stays accessible at 360 px", async ({
  page,
  context,
}) => {
  await preferences(context, page, "sw", "dark");
  await signInAs(context, "finance");
  for (const [path, heading] of [
    ["/spending", "Matumizi na mtiririko wa pesa"],
    ["/spending/petty-cash", "Pesa ndogo"],
    [`/spending/petty-cash/${FLOAT_ID}`, "Main plot float (synthetic)"],
    ["/spending/forecast", "Utabiri wa mtiririko wa pesa"],
    ["/spending/alerts", "Tahadhari za matumizi"],
    ["/spending/settings", "Mipangilio ya matumizi"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    expect(await axeViolations(page), path).toEqual([]);
  }
  await page.setViewportSize({ width: 360, height: 800 });
  for (const path of [
    "/spending",
    "/spending/petty-cash",
    `/spending/petty-cash/${FLOAT_ID}`,
    "/spending/settings",
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page, path);
  }
});
