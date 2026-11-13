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
 * D5.2 procure-to-pay against test/mock-api.mts (test/mock-p2p.mts): requisition → approval →
 * RFQ with three quotations and the comparison matrix → award → LPO approval (step-up) → a GRN
 * captured at 360 px (position, photos, an idempotent retry) → a supplier invoice the
 * three-way match blocks → a corrected invoice that matches → approval bound to the verified
 * payee (step-up) → settlements by someone other than the approver. Figures are worked out by
 * hand (VAT 16 %, every line rounded half-up once, VAT once on the subtotal):
 * - sand 21 t: the quarry's KES 28,000 per 7 t lorry trip = KES 4,000 per t → 8,400,000 minor;
 * - cement 5,000 kg = 100 bags at KES 900 VAT-inclusive = 77,586.206897 net per bag →
 *   7,758,620.69 → 7,758,621; subtotal 16,158,621; VAT 2,585,379; total 18,744,000
 *   (= 21 × 4,640 + 100 × 900 = KES 187,440);
 * - corrected invoice for what was accepted (14 t, 98 bags): 5,600,000 + 7,603,448 =
 *   13,203,448; VAT 2,112,552; total 15,316,000 (= KES 153,160).
 */
const expect = baseExpect.configure({ timeout: 20_000 });
test.describe.configure({ timeout: 360_000 });

const QUARRY_ID = "60000000-0000-4000-8000-000000000001";
const AGENT_ID = "21000000-0000-4000-8000-000000000003";
/** A 1×1 PNG (a delivery-note or goods "photo"). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
/** Inside the Main plot geofence of Ruiru Heights (mock-api.mts). */
const ON_SITE = { latitude: -1.14872, longitude: 36.96147, accuracy: 8 };

async function api(page: Page, method: string, path: string, data?: object) {
  const res = await page.request.fetch(`/api/v1${path}`, {
    method,
    headers: { "X-CSRF-Token": MOCK_CSRF, "Content-Type": "application/json" },
    data,
  });
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

/** Completes the step-up dialog when the API asks for one. */
async function stepUpIfAsked(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  const asked = await dialog.waitFor({ state: "visible", timeout: 4_000 }).then(
    () => true,
    () => false,
  );
  if (!asked) return;
  await dialog.getByLabel("Authenticator code").fill(MOCK_STEP_UP_CODE);
  await dialog.getByRole("button", { name: "Verify and continue" }).click();
  await expect(dialog).toBeHidden();
}

/** Opens a record command's confirmation, fills a reason when given and confirms it. */
async function command(page: Page, button: string, confirm: string, reason?: string) {
  await page.getByRole("button", { name: button, exact: true }).first().click();
  const dialog = page.getByRole("dialog").last();
  if (reason) await dialog.getByLabel("Reason").fill(reason);
  await dialog.getByRole("button", { name: confirm, exact: true }).click();
}

async function expectNoHorizontalScroll(page: Page, label: string) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    label,
  ).toBe(true);
}

async function as(context: BrowserContext, page: Page, persona: Persona, token: string) {
  await switchPersona(context, persona, token);
  await page.reload();
}

const idOf = (page: Page) => page.url().split("/").filter(Boolean).at(-1)!;

test("procure to pay: requisition to settlement, with the three-way match blocking a bad invoice", async ({
  page,
  context,
}) => {
  await preferences(context, page);
  const token = await signInAs(context, "owner");
  // The owner lets the site agent raise requisitions and receive goods on Ruiru Heights.
  await page.goto("/procurement");
  await api(page, "POST", "/auth/mfa/step-up", { code: MOCK_STEP_UP_CODE });
  const granted = await api(page, "PUT", `/projects/${RUIRU_ID}/members/${AGENT_ID}`, {
    permissions: ["projects.view", "site.diary", "bq.view", "procurement.requisition"],
  });
  expect(granted.status).toBe(200);
  await switchPersona(context, "agent", token);

  // 1. The site agent raises a requisition: 21 t of sand and 5,000 kg of cement (= 100 bags).
  await page.goto("/procurement/requisitions/new");
  await expect(page.getByRole("heading", { level: 1, name: "New requisition" })).toBeVisible();
  await page.getByLabel("Delivery site (optional)").selectOption({ label: "Main plot" });
  const first = page.getByRole("group", { name: "Material 1" });
  await first.getByLabel("Material").selectOption({ label: "MAT-0002 · River sand" });
  await first.getByLabel("Quantity").fill("21");
  await page.getByRole("button", { name: "Add a material" }).click();
  const second = page.getByRole("group", { name: "Material 2" });
  await second
    .getByLabel("Material")
    .selectOption({ label: "MAT-0001 · Cement 42.5N (50 kg bag)" });
  await second.getByLabel("Quantity").fill("5000");
  await second.getByLabel("Unit").selectOption("kg");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "REQ-0002" })).toBeVisible();
  await expect(page.getByRole("table")).toContainText("= 100 bag (50 kg)");
  await command(page, "Submit", "Submit for approval");
  await expect(page.getByText("Awaiting approval").first()).toBeVisible();
  await expect(page.getByTestId("maker-checker")).toContainText(
    "You prepared or edited this record",
  );
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  const requisitionUrl = page.url();
  expect(await axeViolations(page)).toEqual([]);

  // 2. The project manager approves it (they did not raise it); it is in their inbox first.
  await switchPersona(context, "pm", token);
  await page.goto("/procurement");
  await expect(page.getByTestId("inbox")).toContainText("Approve or reject a requisition");
  await expect(page.getByTestId("inbox").getByRole("link", { name: "REQ-0002" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.goto(requisitionUrl);
  await command(page, "Approve", "Approve");
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();

  // 3. The owner asks three suppliers to quote and records their quotations.
  await as(context, page, "owner", token);
  await page.getByRole("link", { name: "Ask suppliers to quote (RFQ)" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "New request for quotation" }),
  ).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /REQ-0002/ })).toBeChecked();
  for (const supplier of [
    "SUP-0001 · Mlolongo Quarry (synthetic)",
    "SUP-0002 · Athi River Steel (synthetic)",
    "SUP-0003 · Kitengela Hardware (synthetic)",
  ])
    await page.getByRole("checkbox", { name: supplier }).check();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Create RFQ" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "RFQ-0002" })).toBeVisible();
  await expect(page.getByTestId("min-quotes")).toContainText("0 of 3 complete, valid quotations");
  const quote = async (
    supplier: string,
    sand: [string, string],
    cement: string,
    reference: string,
  ) => {
    await page.getByRole("button", { name: "Record a quotation" }).click();
    const dialog = page.getByRole("dialog", { name: "Record a quotation" });
    await dialog.getByLabel("Supplier", { exact: true }).selectOption({ label: supplier });
    await dialog.getByLabel("Supplier's reference (optional)").fill(reference);
    const sandLine = dialog.getByRole("group", { name: /River sand/ });
    await sandLine.getByLabel("Unit price (KES)").fill(sand[0]);
    await sandLine.getByLabel("Price per").selectOption(sand[1]);
    await sandLine.getByLabel("VAT").selectOption("exclusive");
    const cementLine = dialog.getByRole("group", { name: /Cement/ });
    await cementLine.getByLabel("Unit price (KES)").fill(cement);
    await cementLine.getByLabel("Price per").selectOption("bag_50kg");
    await cementLine.getByLabel("VAT").selectOption("inclusive");
    await dialog.getByRole("button", { name: "Record quotation" }).click();
    await expect(dialog).toBeHidden();
  };
  await quote("SUP-0001 · Mlolongo Quarry (synthetic)", ["28000", "trip"], "900", "MQ-Q-77");
  await quote("SUP-0002 · Athi River Steel (synthetic)", ["4300", "t"], "880", "ARS-310");
  await quote("SUP-0003 · Kitengela Hardware (synthetic)", ["4200", "t"], "920", "KH-12");
  await expect(page.getByTestId("min-quotes")).toContainText("3 of 3 complete, valid quotations");
  await expect(page.getByTestId("min-quotes")).toContainText("Enough quotations to award");
  // Net of VAT per base unit: sand lowest at the quarry (KES 4,000 per t from KES 28,000 per
  // trip), cement lowest at the steel yard (88,000 × 100/116 = KES 758.62 per bag).
  const matrix = page.getByTestId("comparison-matrix");
  const sandRow = matrix.getByRole("row", { name: /River sand/ });
  await expect(sandRow.getByRole("cell").nth(0)).toContainText("KES 4,000.00 per tonne");
  await expect(sandRow.getByRole("cell").nth(0)).toContainText("Lowest");
  await expect(sandRow.getByRole("cell").nth(0)).toContainText("KES 84,000 for the line");
  const cementRow = matrix.getByRole("row", { name: /Cement/ });
  await expect(cementRow.getByRole("cell").nth(1)).toContainText("KES 758.62 per bag (50 kg)");
  await expect(cementRow.getByRole("cell").nth(1)).toContainText("Lowest");
  const totals = matrix.getByRole("row", { name: /Net total/ });
  await expect(totals.getByRole("cell").nth(0)).toContainText("KES 161,586.21");
  await expect(totals.getByRole("cell").nth(0)).toContainText("Lowest");
  await expect(totals.getByRole("cell").nth(1)).toContainText("KES 166,162.07");
  await expect(totals.getByRole("cell").nth(2)).toContainText("KES 167,510.34");
  expect(await axeViolations(page)).toEqual([]);

  // 4. Award the quarry: a draft LPO with the supplier snapshot and totals.
  await page.getByRole("button", { name: "Award" }).click();
  const award = page.getByRole("dialog", { name: "Award RFQ-0002" });
  await expect(award.getByLabel("Winning quotation")).toHaveValue(/.+/);
  await award
    .getByLabel("Winning quotation")
    .selectOption({ label: "Mlolongo Quarry (synthetic): KES 161,586.21" });
  await award.getByLabel("Terms (optional)").fill("Deliver to the site gate (synthetic).");
  await award.getByRole("button", { name: "Create the LPO" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "LPO-0002" })).toBeVisible();
  const supplierCard = page.getByTestId("lpo-supplier");
  await expect(supplierCard).toContainText("P•••••••01Z");
  await expect(supplierCard).toContainText("Registered");
  await expect(page.locator("tfoot")).toContainText("KES 161,586.21");
  await expect(page.locator("tfoot")).toContainText("KES 25,853.79");
  await expect(page.locator("tfoot")).toContainText("KES 187,440");
  await command(page, "Submit", "Submit for approval");
  await expect(page.getByText("Awaiting approval").first()).toBeVisible();
  // The owner prepared it: no approval for them (the API refuses too).
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("maker-checker")).toContainText("You prepared or edited");
  const lpoId = idOf(page);
  expect(await axeViolations(page)).toEqual([]);
  await page.goto(`/procurement/lpos/${lpoId}/print`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Local purchase order LPO-0002" }),
  ).toBeVisible();
  await expect(page.getByText("Not approved: this is not a valid order.")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // 5. The project manager approves the LPO with a fresh step-up.
  await switchPersona(context, "pm", token);
  await page.goto(`/procurement/lpos/${lpoId}`);
  await command(page, "Approve", "Approve");
  await stepUpIfAsked(page);
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Nothing received", { exact: true })).toBeVisible();

  // 6. The site agent records the delivery on a phone (360 px): 14 t of sand and 100 bags, two
  // torn; position, vehicle and photos. The first response is lost; the retry replays it.
  await switchPersona(context, "agent", token);
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation(ON_SITE);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(`/procurement/grns/new?lpo=${lpoId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Record a delivery" })).toBeVisible();
  await expect(page.getByLabel("LPO")).toHaveValue(lpoId);
  const sandGroup = page.getByRole("group", { name: "River sand" });
  await sandGroup.getByLabel("Quantity counted").fill("14");
  const cementGroup = page.getByRole("group", { name: "Cement 42.5N (50 kg bag)" });
  await cementGroup.getByLabel("Unit").selectOption("bag_50kg");
  await cementGroup.getByLabel("Quantity counted").fill("100");
  await cementGroup.getByLabel("Rejected").fill("2");
  await cementGroup.getByLabel("Why rejected").fill("Torn bags (synthetic)");
  await page.getByLabel("Vehicle registration").fill("kda 123a");
  await expect(page.getByText("Kenyan plate KDA 123A")).toBeVisible();
  await page.getByLabel("Delivery note number (optional)").fill("DN-7781");
  await page.getByRole("button", { name: "Use my position" }).click();
  await expect(page.getByText("±8 m at -1.14872, 36.96147")).toBeVisible();
  await page
    .getByLabel("Photo of the delivery note")
    .setInputFiles({ name: "note.png", mimeType: "image/png", buffer: PNG });
  await page
    .getByLabel("Photo of the goods")
    .setInputFiles({ name: "goods.png", mimeType: "image/png", buffer: PNG });
  await expectNoHorizontalScroll(page, "GRN capture (360 px)");
  expect(await axeViolations(page)).toEqual([]);
  let lost = false;
  await page.route("**/api/v1/procurement/grns", async (route) => {
    if (route.request().method() !== "POST" || lost) return route.continue();
    lost = true;
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Record the delivery" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "could not be reached" })).toBeVisible();
  await page.getByRole("button", { name: "Record the delivery" }).click();
  const result = page.getByTestId("grn-result");
  await expect(result).toContainText(
    "GRN-0002 was already recorded: this repeat was not counted twice.",
  );
  await expect(result).toContainText("Inside the site geofence");
  await expect(result).not.toContainText("Photos still uploading");
  await page.unroute("**/api/v1/procurement/grns");
  await result.getByRole("link", { name: "Open GRN-0002" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "GRN-0002" })).toBeVisible();
  await expect(page.getByText("Evidence complete")).toBeVisible();
  await expect(page.getByRole("img", { name: /Delivery note photo/ })).toBeVisible();
  await expectNoHorizontalScroll(page, "GRN detail (360 px)");
  expect(await axeViolations(page)).toEqual([]);
  expect((await api(page, "GET", "/procurement/grns")).body["grns"]).toHaveLength(2);
  await page.setViewportSize({ width: 1280, height: 900 });

  // 7. Finance records the supplier's invoice for the whole order: the match blocks it.
  await switchPersona(context, "finance", token);
  await page.goto(`/procurement/invoices/new?lpo=${lpoId}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Record a supplier invoice" }),
  ).toBeVisible();
  await page.getByLabel("Supplier's invoice number").fill("MQ-INV-2001");
  await expect(page.getByTestId("etims-check")).toContainText("No eTIMS number");
  await page.getByLabel("KRA eTIMS invoice number").fill("kracu0400000078/2231");
  await expect(page.getByTestId("etims-check")).toContainText("eTIMS format recognised.");
  const sandBill = page.getByRole("group", { name: "River sand" });
  await sandBill.getByLabel("Quantity billed").fill("21");
  await expect(sandBill.getByLabel("Unit price (KES)")).toHaveValue("4000");
  const cementBill = page.getByRole("group", { name: "Cement 42.5N (50 kg bag)" });
  await cementBill.getByLabel("Unit", { exact: true }).selectOption("bag_50kg");
  await cementBill.getByLabel("Quantity billed").fill("100");
  await cementBill.getByLabel("Unit price (KES)").fill("900");
  await expect(page.getByTestId("invoice-computed")).toContainText(
    "subtotal KES 161,586.21, VAT KES 25,853.79, total KES 187,440",
  );
  await expect(page.getByLabel("Total (KES)", { exact: true })).toHaveValue("187440");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: /MQ-INV-2001 · Mlolongo Quarry/ }),
  ).toBeVisible();
  const invoiceId = idOf(page);
  await command(page, "Submit for matching", "Submit for matching");
  const verdict = page.getByTestId("match-verdict");
  await expect(verdict).toContainText("Blocked: payment cannot be approved");
  await expect(verdict).toContainText(
    "More is billed (with earlier invoices) than was accepted on site.",
  );
  const lines = page.getByTestId("match-lines");
  await expect(lines.getByRole("row", { name: /River sand/ })).toContainText("Fail");
  await expect(lines.getByRole("row", { name: /River sand/ })).toContainText("21");
  await expect(lines.getByRole("row", { name: /Cement/ })).toContainText("98");
  await expect(page.getByTestId("approval-blocked")).toContainText(
    "Approval is blocked while the three-way match does not pass.",
  );
  await expect(page.getByTestId("approval-blocked").getByRole("button")).toBeDisabled();
  await expect(page.getByTestId("exception")).toContainText("You recorded or edited this invoice");
  expect(await axeViolations(page)).toEqual([]);
  // The API refuses approval of the blocked invoice, whoever asks.
  const detail = (await api(page, "GET", `/procurement/invoices/${invoiceId}`)).body as {
    invoice: { version: number };
    match: { id: string };
    payee: { id: string };
  };
  const approval = {
    version: detail.invoice.version,
    matchId: detail.match.id,
    payoutVersionId: detail.payee.id,
  };
  await switchPersona(context, "owner", token);
  await api(page, "POST", "/auth/mfa/step-up", { code: MOCK_STEP_UP_CODE });
  const blocked = await api(page, "POST", `/procurement/invoices/${invoiceId}/approve`, approval);
  expect([blocked.status, blocked.body["code"]]).toEqual([409, "invalid-transition"]);

  // 8. Finance corrects the invoice to what was accepted: it matches.
  await switchPersona(context, "finance", token);
  await page.reload();
  await command(page, "Correct the invoice", "Correct the invoice");
  await page.getByRole("link", { name: "Edit" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Edit invoice MQ-INV-2001" }),
  ).toBeVisible();
  await page.getByRole("group", { name: "River sand" }).getByLabel("Quantity billed").fill("14");
  await page
    .getByRole("group", { name: "Cement 42.5N (50 kg bag)" })
    .getByLabel("Quantity billed")
    .fill("98");
  await expect(page.getByTestId("invoice-computed")).toContainText(
    "subtotal KES 132,034.48, VAT KES 21,125.52, total KES 153,160",
  );
  await page.getByLabel("Subtotal (KES)").fill("132034.48");
  await page.getByLabel("VAT (KES)").fill("21125.52");
  await page.getByLabel("Total (KES)", { exact: true }).fill("153160");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /MQ-INV-2001/ })).toBeVisible();
  await command(page, "Submit for matching", "Submit for matching");
  await expect(verdict).toContainText("Matched: payment can be approved.");
  await expect(page.getByTestId("match-checks")).not.toContainText("Fail");
  // Finance recorded it, so finance cannot approve it.
  await expect(page.getByTestId("approval")).toContainText(
    "You recorded or edited this invoice, so a different person must approve it.",
  );

  // 9. The owner approves for payment: bound to the verified Paybill and the amount.
  await switchPersona(context, "owner", token);
  await page.reload();
  await expect(page.getByTestId("approval-payee")).toContainText(
    "M-Pesa Paybill 600000, account JENGA-BORA",
  );
  await expect(page.getByTestId("approval-payee")).toContainText("Amount: KES 153,160");
  await page.getByRole("button", { name: "Approve for payment" }).click();
  await page
    .getByRole("dialog", { name: "Approve MQ-INV-2001 for payment" })
    .getByRole("button", { name: "Approve KES 153,160" })
    .click();
  await stepUpIfAsked(page);
  await expect(page.getByTestId("approved-by")).toContainText("Approved by Wanjiru Kamau");
  await expect(page.getByTestId("settle-refusal")).toContainText(
    "You approved this invoice, so someone else must record its payment.",
  );
  const ownSettlement = await page.request.fetch(
    `/api/v1/procurement/invoices/${invoiceId}/settlements`,
    {
      method: "POST",
      headers: {
        "X-CSRF-Token": MOCK_CSRF,
        "Content-Type": "application/json",
        "Idempotency-Key": "owner-settle-0001",
      },
      data: {
        method: "bank_transfer",
        externalReference: "FT-OWNER-1",
        amountMinor: 100,
        paidOn: new Date().toISOString().slice(0, 10),
      },
    },
  );
  expect(ownSettlement.status()).toBe(403);

  // 10. Finance records the payment in two parts; never above what is outstanding.
  await switchPersona(context, "finance", token);
  await page.reload();
  const settlements = page.getByTestId("settlements");
  await expect(settlements).toContainText("Outstanding KES 153,160 of KES 153,160");
  await settlements.getByLabel("Payment reference").fill("FT26111500001");
  await settlements.getByLabel("Amount (KES)").fill("999999");
  await expect(settlements).toContainText("The amount is more than the outstanding KES 153,160.");
  await expect(settlements.getByRole("button", { name: "Record payment" })).toBeDisabled();
  await settlements.getByLabel("Amount (KES)").fill("100000");
  expect(await axeViolations(page)).toEqual([]);
  await settlements.getByRole("button", { name: "Record payment" }).click();
  await stepUpIfAsked(page);
  await expect(settlements).toContainText("Outstanding KES 53,160 of KES 153,160");
  await expect(page.getByText("Partly paid").first()).toBeVisible();
  await settlements.getByLabel("Method").selectOption("cheque");
  await settlements.getByLabel("Payment reference").fill("CHQ-000123");
  await settlements.getByLabel("Amount (KES)").fill("53160");
  await settlements.getByRole("button", { name: "Record payment" }).click();
  await stepUpIfAsked(page);
  await expect(settlements).toContainText("Paid in full.");
  await expect(settlements.getByRole("table")).toContainText("CHQ-000123");

  // Committed, accrued and paid per project: LPO-0001 + LPO-0002; both invoices; both paid.
  await switchPersona(context, "owner", token);
  await page.goto("/procurement");
  const commitments = page.getByTestId("commitments");
  await expect(commitments).toContainText("KES 295,172.42");
  await expect(commitments).toContainText("KES 226,827.58");
  await expect(commitments).toContainText("KES 263,120");
});

test("maker-checker: nobody approves what they prepared, in the API and on screen", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "pm");
  await page.goto("/procurement");
  // The project manager raises and submits their own requisition…
  const material = (
    (await api(page, "GET", "/materials?limit=200")).body["materials"] as {
      id: string;
      code: string;
    }[]
  ).find((entry) => entry.code === "MAT-0002")!.id;
  const created = await api(page, "POST", "/procurement/requisitions", {
    projectId: RUIRU_ID,
    neededBy: new Date().toISOString().slice(0, 10),
    lines: [{ materialId: material, quantity: "7", unit: "t" }],
  });
  expect(created.status).toBe(201);
  const requisition = (created.body as { requisition: { id: string; version: number } })
    .requisition;
  const submitted = await api(page, "POST", `/procurement/requisitions/${requisition.id}/submit`, {
    version: requisition.version,
  });
  expect(submitted.status).toBe(200);
  // …and cannot approve it (403 maker-checker); the screen explains why and offers no button.
  const own = await api(page, "POST", `/procurement/requisitions/${requisition.id}/approve`, {
    version: requisition.version + 1,
  });
  expect([own.status, own.body["code"]]).toEqual([403, "maker-checker"]);
  await page.goto(`/procurement/requisitions/${requisition.id}`);
  await expect(page.getByTestId("maker-checker")).toContainText("You prepared or edited");
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await page.goto("/procurement");
  await expect(page.getByTestId("inbox")).not.toContainText("REQ-0002");

  // The site agent has no approval right at all; the owner may approve it and sees it waiting.
  await switchPersona(context, "agent", token);
  const agent = await api(page, "POST", `/procurement/requisitions/${requisition.id}/approve`, {
    version: requisition.version + 1,
  });
  expect(agent.status).toBe(403);
  await switchPersona(context, "owner", token);
  await page.goto("/procurement");
  await expect(page.getByTestId("inbox").getByRole("link", { name: "REQ-0002" })).toBeVisible();

  // Finance recorded the blocked fixture invoice MQ-INV-1002: no exception from finance.
  const invoices = (await api(page, "GET", "/procurement/invoices")).body["invoices"] as {
    id: string;
    invoiceNumber: string;
  }[];
  const blockedId = invoices.find((entry) => entry.invoiceNumber === "MQ-INV-1002")!.id;
  await switchPersona(context, "finance", token);
  await api(page, "POST", "/auth/mfa/step-up", { code: MOCK_STEP_UP_CODE });
  const blocked = (await api(page, "GET", `/procurement/invoices/${blockedId}`)).body as {
    invoice: { version: number };
    match: { id: string };
    permissions: { canApproveException: boolean };
  };
  expect(blocked.permissions.canApproveException).toBe(false);
  const exception = await api(page, "POST", `/procurement/invoices/${blockedId}/exception`, {
    version: blocked.invoice.version,
    matchId: blocked.match.id,
    reason: "Delivered, GRN pending (synthetic)",
  });
  expect([exception.status, exception.body["code"]]).toEqual([403, "maker-checker"]);
});

test("a blocked invoice: an independent exception, approval, then a payee change needs re-approval", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "owner");
  await page.goto("/procurement");
  await expect(page.getByTestId("inbox")).toContainText(
    "Blocked invoice: an exception may be decided",
  );
  await page.getByTestId("inbox").getByRole("link", { name: "MQ-INV-1002" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /MQ-INV-1002/ })).toBeVisible();
  const verdict = page.getByTestId("match-verdict");
  await expect(verdict).toContainText("Blocked");
  // Cement: 100 bags ordered, 50 received, 50 billed before, 50 billed now → 100 > 50.
  const cement = page.getByTestId("match-lines").getByRole("row", { name: /Cement/ });
  await expect(cement).toContainText("Fail");
  await expect(cement).toContainText(
    "More is billed (with earlier invoices) than was accepted on site.",
  );
  await expect(page.getByTestId("match-checks")).toContainText("KRA eTIMS number given");
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("button", { name: "Approve an exception" }).click();
  const dialog = page.getByRole("dialog", { name: "Approve an exception for MQ-INV-1002" });
  await dialog.getByLabel("Reason").fill("Second load seen on site; GRN follows (synthetic).");
  await dialog.getByRole("button", { name: "Approve exception" }).click();
  await stepUpIfAsked(page);
  await expect(verdict).toContainText("Mismatch accepted by an approved exception");
  await expect(page.getByTestId("match-exception")).toContainText("Second load seen on site");
  await page.getByRole("button", { name: "Approve for payment" }).click();
  await page
    .getByRole("dialog", { name: "Approve MQ-INV-1002 for payment" })
    .getByRole("button", { name: "Approve KES 45,000" })
    .click();
  await stepUpIfAsked(page);
  await expect(page.getByTestId("approved-by")).toContainText("KES 45,000");
  const invoiceUrl = page.url();

  // The quarry's Paybill changes: nothing can be paid until someone approves the new payee.
  await page.goto(`/suppliers/${QUARRY_ID}`);
  await page.getByRole("button", { name: "Change payout details" }).click();
  const propose = page.getByRole("dialog", { name: "Propose payout details" });
  await propose.getByLabel("Paybill number").fill("400200");
  await propose.getByLabel("Account number at the Paybill").fill("JENGA-BORA-2");
  await propose.getByRole("button", { name: "Propose details" }).click();
  await stepUpIfAsked(page);
  await expect(page.getByTestId("payout-current")).toContainText("Awaiting verification");
  await page.goto(invoiceUrl);
  await expect(page.getByTestId("reapproval-needed")).toContainText("Re-approval needed");
  await switchPersona(context, "finance", token);
  await page.reload();
  await expect(page.getByTestId("settle-refusal")).toContainText(
    "The payee changed after approval",
  );
  expect(await axeViolations(page)).toEqual([]);
});

test("an RFQ with too few quotations needs a single-source exception from someone else", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "owner");
  await page.goto("/procurement");
  const material = (
    (await api(page, "GET", "/materials?limit=200")).body["materials"] as {
      id: string;
      code: string;
    }[]
  ).find((entry) => entry.code === "MAT-0002")!.id;
  const requisition = (
    (
      await api(page, "POST", "/procurement/requisitions", {
        projectId: RUIRU_ID,
        neededBy: new Date().toISOString().slice(0, 10),
        lines: [{ materialId: material, quantity: "7", unit: "t" }],
      })
    ).body as { requisition: { id: string; version: number } }
  ).requisition;
  await api(page, "POST", `/procurement/requisitions/${requisition.id}/submit`, {
    version: requisition.version,
  });
  await switchPersona(context, "pm", token);
  expect(
    (
      await api(page, "POST", `/procurement/requisitions/${requisition.id}/approve`, {
        version: requisition.version + 1,
      })
    ).status,
  ).toBe(200);
  await switchPersona(context, "owner", token);
  const rfq = (
    await api(page, "POST", "/procurement/rfqs", {
      requisitionIds: [requisition.id],
      supplierIds: [QUARRY_ID],
    })
  ).body as { rfq: { id: string }; lines: { requisitionLineId: string }[] };
  const today = new Date().toISOString().slice(0, 10);
  expect(
    (
      await api(page, "POST", `/procurement/rfqs/${rfq.rfq.id}/quotations`, {
        supplierId: QUARRY_ID,
        quotedOn: today,
        validUntil: today,
        deliveryDays: 1,
        lines: [
          {
            requisitionLineId: rfq.lines[0]!.requisitionLineId,
            priceUnit: "trip",
            unitPriceMinor: 2_800_000,
            vatTreatment: "exclusive",
          },
        ],
      })
    ).status,
  ).toBe(201);
  await page.goto(`/procurement/rfqs/${rfq.rfq.id}`);
  await expect(page.getByTestId("min-quotes")).toContainText("1 of 3 complete, valid quotations");
  await expect(page.getByTestId("min-quotes")).toContainText("Not enough quotations to award");
  await expect(page.getByRole("button", { name: "Award" })).toHaveCount(0);
  await command(
    page,
    "Request an exception",
    "Request exception",
    "Only the quarry delivers this week (synthetic).",
  );
  await expect(page.getByTestId("min-quotes")).toContainText("Requested by Wanjiru Kamau");
  // The owner prepared the RFQ: the approval is for someone else.
  await expect(page.getByRole("button", { name: "Approve the exception" })).toHaveCount(0);
  await expect(page.getByTestId("maker-checker")).toContainText("You prepared or edited");
  await switchPersona(context, "pm", token);
  await page.goto("/procurement");
  await expect(page.getByTestId("inbox")).toContainText("Decide on a single-source exception");
  await page.goto(`/procurement/rfqs/${rfq.rfq.id}`);
  await command(page, "Approve the exception", "Approve exception");
  await expect(page.getByTestId("min-quotes")).toContainText("Single-source exception approved");
  await switchPersona(context, "owner", token);
  await page.reload();
  await expect(page.getByRole("button", { name: "Award" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("procurement settings: minimum quotes, tolerances and the eTIMS block make a match stale", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "owner");
  await page.goto("/catalogue/alerts");
  await expect(page.getByRole("heading", { level: 2, name: "Procurement settings" })).toBeVisible();
  await expect(page.getByLabel("Minimum complete quotations before an award")).toHaveValue("3");
  await page.getByLabel("Minimum complete quotations before an award").fill("2");
  await page.getByLabel("Quantity tolerance (%)").fill("5");
  await page.getByLabel("Price tolerance (%)").fill("2.5");
  await page.getByLabel("Block payment of invoices without a KRA eTIMS number").uncheck();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Settings saved." })).toBeVisible();
  const settings = (await api(page, "GET", "/procurement/settings")).body["settings"];
  expect(settings).toMatchObject({
    minQuotes: 2,
    qtyTolerancePercent: "5",
    priceTolerancePercent: "2.5",
    blockPaymentWithoutEtims: false,
  });

  // The blocked fixture invoice was matched with the old settings: out of date until re-run.
  const invoices = (await api(page, "GET", "/procurement/invoices")).body["invoices"] as {
    id: string;
    invoiceNumber: string;
  }[];
  await page.goto(
    `/procurement/invoices/${invoices.find((entry) => entry.invoiceNumber === "MQ-INV-1002")!.id}`,
  );
  const stale = page.getByTestId("match-stale");
  await expect(stale).toContainText("the tolerances or the eTIMS setting changed");
  await expect(page.getByRole("button", { name: "Approve for payment" })).toBeDisabled();
  await stale.getByRole("button", { name: "Run the match again" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Run the match again" }).click();
  await expect(stale).toBeHidden();
  await expect(page.getByText("Tolerances: quantity 5%, price 2.5%.")).toBeVisible();
  // 100 billed in total against 50 received × 1.05 = 52.5 allowed: still blocked.
  await expect(page.getByTestId("match-verdict")).toContainText("Blocked");

  // Someone without configuration rights (the project manager) sees the settings read-only.
  await switchPersona(context, "pm", token);
  await page.goto("/catalogue/alerts");
  await expect(
    page.getByText("Only someone with configuration rights can change these settings."),
  ).toBeVisible();
  await expect(page.getByLabel("Quantity tolerance (%)")).toBeDisabled();
});

test("Kiswahili, dark theme and reduced motion on every procurement screen; GRN capture at 360 px", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await preferences(context, page, "sw", "dark");
  await signInAs(context, "owner");
  const ids = async (path: string, key: string) =>
    ((await api(page, "GET", path)).body[key] as { id: string }[]).map((entry) => entry.id);
  await page.goto("/procurement");
  await expect(page.locator("html")).toHaveAttribute("lang", "sw");
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
    true,
  );
  await expect(page.getByRole("heading", { level: 1, name: "Ununuzi" })).toBeVisible();
  const [requisition] = await ids("/procurement/requisitions", "requisitions");
  const [rfq] = await ids("/procurement/rfqs", "rfqs");
  const [lpo] = await ids("/procurement/lpos", "lpos");
  const [grn] = await ids("/procurement/grns", "grns");
  const [blocked] = await ids("/procurement/invoices", "invoices");
  for (const [path, heading] of [
    ["/procurement", "Ununuzi"],
    ["/procurement/requisitions", "Maombi ya vifaa"],
    ["/procurement/requisitions/new", "Ombi jipya la vifaa"],
    [`/procurement/requisitions/${requisition}`, "REQ-0001"],
    ["/procurement/rfqs", "Maombi ya bei"],
    ["/procurement/rfqs/new", "Ombi jipya la bei"],
    [`/procurement/rfqs/${rfq}`, "RFQ-0001"],
    ["/procurement/lpos", "Maagizo ya ununuzi (LPO)"],
    [`/procurement/lpos/${lpo}`, "LPO-0001"],
    [`/procurement/lpos/${lpo}/print`, "Agizo la ununuzi LPO-0001"],
    ["/procurement/grns", "Mapokezi"],
    [`/procurement/grns/${grn}`, "GRN-0001"],
    ["/procurement/invoices", "Ankara za wasambazaji"],
    [`/procurement/invoices/new?lpo=${lpo}`, "Rekodi ankara ya msambazaji"],
    [`/procurement/invoices/${blocked}`, "MQ-INV-1002 · Mlolongo Quarry (synthetic)"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading }), path).toBeVisible();
    expect(await axeViolations(page), path).toEqual([]);
  }
  await expect(page.getByTestId("three-way-match")).toContainText("Ulinganisho wa njia tatu");
  await expect(page.getByTestId("match-verdict")).toContainText("Imezuiwa");

  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(`/procurement/grns/new?lpo=${lpo}`);
  await expect(page.getByRole("heading", { level: 1, name: "Rekodi mapokezi" })).toBeVisible();
  await page.getByLabel("Nambari ya usajili wa gari").fill("T 123 ABC");
  await expect(page.getByText("Si muundo wa Kenya: T 123 ABC itawekwa alama")).toBeVisible();
  await expectNoHorizontalScroll(page, "GRN capture (sw, 360 px)");
  expect(await axeViolations(page)).toEqual([]);
  // More cement than the LPO still expects: recorded and flagged, and the result fits 360 px.
  await page
    .getByRole("group", { name: "Cement 42.5N (50 kg bag)" })
    .getByLabel("Kiasi kilichohesabiwa")
    .fill("52");
  await page.getByRole("button", { name: "Rekodi mapokezi" }).click();
  const recorded = page.getByTestId("grn-result");
  await expect(recorded).toContainText("GRN-0002 imerekodiwa.");
  await expectNoHorizontalScroll(page, "GRN result (sw, 360 px)");
  await expect(recorded).toContainText("Imezidi kiasi kilichoagizwa");
  await expect(recorded).toContainText("Muundo mwingine (umewekwa alama)");
  expect(await axeViolations(page)).toEqual([]);
  // Its detail page, with the long "evidence incomplete" notice (no photos), also fits 360 px.
  const grns = (await api(page, "GET", "/procurement/grns")).body["grns"] as {
    id: string;
    number: string;
  }[];
  await page.goto(`/procurement/grns/${grns.find((entry) => entry.number === "GRN-0002")!.id}`);
  await expect(page.getByText(/^Ushahidi haujakamilika/)).toBeVisible();
  await expectNoHorizontalScroll(page, "GRN detail, evidence incomplete (sw, 360 px)");
  await page.goto("/procurement");
  await expectNoHorizontalScroll(page, "procurement home (sw, 360 px)");
  expect(await axeViolations(page)).toEqual([]);
});
