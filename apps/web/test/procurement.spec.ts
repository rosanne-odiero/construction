import { expect as baseExpect, test, type Page } from "@playwright/test";
import {
  axeViolations,
  MOCK_CSRF,
  MOCK_STEP_UP_CODE,
  preferences,
  signInAs,
  switchPersona,
} from "./live-helpers";

/**
 * D5.1 against test/mock-api.mts (test/mock-procurement.mts): the materials catalogue with unit
 * conversions, price history and alerts, the unit calculator, company units, and suppliers with
 * masked identifiers, reveal and maker-checker payout details. Figures are worked out by hand:
 * Y12 = 12²/162 = 8/9 kg/m and 12 m bars. Prices compare on the exact net of 16% VAT, rounded
 * once: cement 800 → 900 VAT-inclusive is +12.5% (above the 10% default).
 */
const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 180_000 });

const QUARRY_ID = "60000000-0000-4000-8000-000000000001";
const STEEL_ID = "60000000-0000-4000-8000-000000000002";

async function expectNoHorizontalScroll(page: Page, label: string) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    label,
  ).toBe(true);
}

async function stepUp(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Authenticator code").fill(MOCK_STEP_UP_CODE);
  await dialog.getByRole("button", { name: "Verify and continue" }).click();
}

async function api(page: Page, method: string, path: string, data?: object) {
  const res = await page.request.fetch(`/api/v1${path}`, {
    method,
    headers: { "X-CSRF-Token": MOCK_CSRF, "Content-Type": "application/json" },
    data,
  });
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

async function openMaterial(page: Page, code: string, name: string) {
  await page.goto("/catalogue");
  await page.getByRole("link", { name: code, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

test("catalogue: search, price history with an alert, a new price and a supplier trip factor", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/catalogue");
  await expect(page.getByRole("heading", { level: 1, name: "Materials catalogue" })).toBeVisible();
  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(5);
  await expect(table.getByRole("row", { name: /MAT-0001/ })).toContainText("1 alert");
  await expect(table.getByRole("row", { name: /MAT-0001/ })).toContainText(
    "KES 900 per bag (50 kg)",
  );
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("textbox", { name: "Search" }).fill("steel");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/search=steel/);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table).toContainText("Steel bar Y12 (high yield, 12 m)");

  // The material: standard factors from the bar diameter, then the price history.
  await table.getByRole("link", { name: "MAT-0003", exact: true }).click();
  const standard = page.getByTestId("standard-conversions");
  await expect(standard).toContainText("1 m = 0.888889 kg");
  await expect(standard).toContainText("1 piece = 12 m");

  await openMaterial(page, "MAT-0001", "Cement 42.5N (50 kg bag)");
  await expect(
    page.getByRole("figure", { name: /Net price per bag \(50 kg\) by supplier/ }),
  ).toBeVisible();
  const history = page.getByRole("table").filter({ hasText: "Effective" }).last();
  await expect(history.getByRole("row", { name: /\+12\.5%/ })).toContainText("Above threshold");
  await expect(history.getByRole("row", { name: /\+2\.5641%/ })).toContainText("Within threshold");
  expect(await axeViolations(page)).toEqual([]);

  // A new price 905 (VAT inclusive): net = 90,500 × 100/116 = 78,017 minor (shown); the change on
  // the exact nets is 905 / 900 − 1 = +0.5556% (half-up).
  await page.getByRole("button", { name: "Record price" }).click();
  const dialog = page.getByRole("dialog", { name: "Record a price" });
  await dialog
    .getByLabel("Supplier")
    .selectOption({ label: "SUP-0002 · Athi River Steel (synthetic)" });
  await dialog.getByLabel("Unit price (KES)").fill("905");
  await expect(dialog.getByRole("status")).toContainText("KES 780.17");
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Record price" }).click();
  await expect(dialog).toBeHidden();
  await expect(history.getByRole("row", { name: /\+0\.5556%/ })).toContainText("Within threshold");

  // River sand: the quarry's lorry now carries 10 t from today; the 7 t factor ends.
  await openMaterial(page, "MAT-0002", "River sand");
  const conversions = page.getByRole("table").filter({ hasText: "Applies to" });
  await expect(conversions.getByRole("row", { name: /1 lorry trip = 7 tonne/ })).toContainText(
    "In force",
  );
  await page.getByRole("button", { name: "Add conversion" }).click();
  const add = page.getByRole("dialog", { name: "Add a conversion" });
  await add.locator("#conversion-from-quantity").fill("1");
  await add.locator("#conversion-from-unit").selectOption("trip");
  await add.locator("#conversion-to-quantity").fill("10");
  await add.locator("#conversion-to-unit").selectOption("t");
  await add
    .getByLabel("Applies to")
    .selectOption({ label: "SUP-0001 · Mlolongo Quarry (synthetic)" });
  await add.getByLabel("Source or assumption (optional)").fill("10-tonne lorry (synthetic)");
  await expect(add.getByRole("status")).toContainText("1 lorry trip = 10 tonne");
  await add.getByRole("button", { name: "Add conversion" }).click();
  await expect(add).toBeHidden();
  await expect(conversions.getByRole("row", { name: /1 lorry trip = 10 tonne/ })).toContainText(
    "In force",
  );
  await expect(conversions.getByRole("row", { name: /1 lorry trip = 7 tonne/ })).toContainText(
    "Ended",
  );

  // Same-dimension factors are refused: tonnes and kilograms already convert exactly.
  await page.getByRole("button", { name: "Add conversion" }).click();
  await add.locator("#conversion-from-unit").selectOption("t");
  await add.locator("#conversion-to-quantity").fill("990");
  await add.locator("#conversion-to-unit").selectOption("kg");
  await expect(add).toContainText("These units already convert by a standard factor.");
  await expect(add.getByRole("button", { name: "Add conversion" })).toBeDisabled();
});

test("unit calculator: exact steel and supplier trips, refusals explained", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/catalogue/convert");
  await expect(page.getByRole("heading", { level: 1, name: "Unit calculator" })).toBeVisible();
  const result = page.getByRole("region", { name: "Result" });

  // A lorry trip has no universal size.
  await page.getByLabel("Quantity", { exact: true }).fill("2");
  await page.getByLabel("From", { exact: true }).selectOption("trip");
  await page.getByLabel("To", { exact: true }).selectOption("t");
  await page.getByRole("button", { name: "Convert" }).click();
  await expect(result.getByRole("alert")).toContainText(
    "These units cannot be converted without a material or supplier factor.",
  );

  // With the quarry's factor for river sand: 2 × 7 = 14 t exactly.
  await page.getByLabel("Material (optional)").selectOption({ label: "MAT-0002 · River sand" });
  await page.getByLabel("Supplier (optional)").selectOption({
    label: "SUP-0001 · Mlolongo Quarry (synthetic)",
  });
  await page.getByLabel("From", { exact: true }).selectOption("trip");
  await page.getByLabel("To", { exact: true }).selectOption("t");
  await page.getByRole("button", { name: "Convert" }).click();
  await expect(result.getByTestId("conversion-result")).toHaveText("2 lorry trip = 14 tonne");
  await expect(result.getByRole("status")).toContainText("Exact");
  await expect(result.getByRole("status")).toContainText("Supplier factor");

  // Ten Y12 bars: 10 × 12 m × 8/9 kg/m = 106.666… kg, rounded half-up to six places.
  await page.getByLabel("Material (optional)").selectOption({
    label: "MAT-0003 · Steel bar Y12 (high yield, 12 m)",
  });
  await page.getByLabel("Supplier (optional)").selectOption({ label: "No specific supplier" });
  await page.getByLabel("Quantity", { exact: true }).fill("10");
  await page.getByLabel("From", { exact: true }).selectOption("nr");
  await page.getByLabel("To", { exact: true }).selectOption("kg");
  await page.getByRole("button", { name: "Convert" }).click();
  await expect(result.getByTestId("conversion-result")).toHaveText("10 piece = 106.666667 kg");
  await expect(result.getByRole("status")).toContainText("Rounded half-up to six decimal places");
  await expect(result.getByRole("status")).toContainText("Standard formula");

  // Negative quantities are refused, not converted.
  await page.getByLabel("Quantity", { exact: true }).fill("-5");
  await page.getByRole("button", { name: "Convert" }).click();
  await expect(result.getByRole("alert")).toContainText("Quantities cannot be negative.");
  expect(await axeViolations(page)).toEqual([]);
});

test("units and the alert threshold: a company unit and a stricter threshold", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/catalogue/units");
  await expect(page.getByRole("heading", { level: 1, name: "Units" })).toBeVisible();
  await page.getByRole("button", { name: "Add unit" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a company unit" });
  await dialog.getByLabel("Code (e.g. debe)").fill("debe");
  await dialog.getByLabel("Name", { exact: true }).fill("Debe (20 litres)");
  await dialog.getByLabel("Dimension").selectOption("volume");
  await dialog.getByLabel("One unit equals").fill("20");
  await dialog.getByLabel("Standard unit").selectOption("l");
  await dialog.getByRole("button", { name: "Add unit" }).click();
  await expect(dialog).toBeHidden();
  const company = page.getByRole("region", { name: "Company units" });
  await expect(company.getByRole("row", { name: /debe/ })).toContainText("0.02");
  expect(await axeViolations(page)).toEqual([]);

  await page.goto("/catalogue/alerts");
  await expect(page.getByRole("heading", { level: 1, name: "Price alerts" })).toBeVisible();
  await expect(page.getByRole("table").getByRole("row", { name: /Cement 42\.5N/ })).toContainText(
    "+12.5%",
  );
  await page.getByLabel("Alert when a price changes by more than (%)").fill("5");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Settings saved." })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("suppliers: add one, reveal the KRA PIN, and verify changed payout details as someone else", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "owner");
  await page.goto("/suppliers");
  await expect(page.getByRole("heading", { level: 1, name: "Suppliers" })).toBeVisible();
  const list = page.getByRole("table");
  await expect(list.getByRole("row", { name: /SUP-0001/ })).toContainText("Verified");
  await expect(list.getByRole("row", { name: /SUP-0002/ })).toContainText("Awaiting verification");
  await expect(list).not.toContainText("P000000001Z");
  expect(await axeViolations(page)).toEqual([]);

  // A new supplier: the KRA PIN is normalised, stored encrypted and shown masked.
  await page.getByRole("link", { name: "Add supplier" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Add a supplier" })).toBeVisible();
  await page.getByLabel("Legal name").fill("Kitengela Timber Yard Ltd (synthetic)");
  await page.getByLabel("KRA PIN (optional)").fill("p 000000003 z");
  await page.getByLabel("eTIMS status").selectOption("registered");
  await page.getByLabel("Credit terms (days)").fill("30");
  await page.getByRole("button", { name: "Add contact" }).click();
  const contact = page.getByRole("group", { name: "Contact 1" });
  await contact.getByLabel("Name").fill("Mutua Kioko (synthetic)");
  await contact.getByLabel("Mobile (optional)").fill("0708 374 149");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Add supplier" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: /Kitengela Timber Yard Ltd \(synthetic\)/ }),
  ).toBeVisible();
  await expect(page.getByTestId("value-kraPin")).toHaveText("P•••••••03Z");
  await page.getByRole("button", { name: "Reveal the KRA PIN" }).click();
  await expect(page.getByTestId("value-kraPin")).toHaveText("P000000003Z");
  await expect(page.getByTestId("value-contactPhone")).toHaveText("2547•••••149");

  // Payout details: the owner proposes (step-up); the owner then cannot verify them.
  await page.getByRole("button", { name: "Add payout details" }).click();
  const propose = page.getByRole("dialog", { name: "Propose payout details" });
  await propose.getByLabel("Paybill number").fill("400200");
  await propose.getByLabel("Account number at the Paybill").fill("KTY-001");
  await propose.getByRole("button", { name: "Propose details" }).click();
  await stepUp(page);
  const current = page.getByTestId("payout-current");
  await expect(current).toContainText("Awaiting verification");
  await expect(current).toContainText("Not usable for payment until verified");
  await expect(current).toContainText("M-Pesa Paybill 400200, account KTY-001");
  await expect(current).toContainText(
    "You made or contributed to these details, so someone else must verify them.",
  );
  await expect(current.getByRole("button", { name: "Verify" })).toHaveCount(0);
  const supplierUrl = page.url();
  const payoutId = (
    (await api(page, "GET", new URL(supplierUrl).pathname)).body as {
      payout: { current: { id: string } };
    }
  ).payout.current.id;
  await api(page, "POST", "/auth/mfa/step-up", { code: MOCK_STEP_UP_CODE });
  const own = await api(
    page,
    "POST",
    `${new URL(supplierUrl).pathname}/payout-details/${payoutId}/verify`,
    { method: "call_back_known_number", note: "Approving my own change" },
  );
  expect(own.status).toBe(403);
  expect(own.body["code"]).toBe("maker-checker");

  // Finance verifies by calling back a number already on file.
  await switchPersona(context, "finance", token);
  await page.goto(supplierUrl);
  await current.getByRole("button", { name: "Verify" }).click();
  const verify = page.getByRole("dialog", { name: "Verify payout details" });
  await verify.getByLabel("How you verified").selectOption("call_back_known_number");
  await verify
    .getByLabel("What you checked")
    .fill("Called Mutua on the number on file (synthetic).");
  expect(await axeViolations(page)).toEqual([]);
  await verify.getByRole("button", { name: "Mark as verified" }).click();
  await stepUp(page);
  await expect(current).toContainText("Usable for payment");
  await expect(current).toContainText(
    /Verified by Daniel Mwangi on .+ \(Call-back to a known number\)/,
  );
});

test("suppliers: finance reveals a bank account; a pending change is not usable and a site agent is refused", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "finance");
  await page.goto(`/suppliers/${STEEL_ID}`);
  const current = page.getByTestId("payout-current");
  await expect(current).toContainText("Not usable for payment until verified");
  await expect(page.getByTestId("value-accountNumber")).toHaveText("••••0002");
  await page.getByRole("button", { name: "Reveal the account number" }).click();
  await expect(page.getByTestId("value-accountNumber")).toHaveText("0000000000002");
  // Finance cannot manage suppliers, so it cannot propose details.
  await expect(page.getByRole("button", { name: "Change payout details" })).toHaveCount(0);

  await page.goto(`/suppliers/${QUARRY_ID}`);
  await expect(current).toContainText("Usable for payment");

  await switchPersona(context, "agent", token);
  await page.goto("/suppliers");
  await expect(
    page.getByRole("heading", { level: 1, name: "You do not have access" }),
  ).toBeVisible();
  expect((await api(page, "GET", "/materials")).status).toBe(403);
});

test("Kiswahili, dark theme, 360 px and reduced motion: catalogue, material and supplier", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await preferences(context, page, "sw", "dark");
  await signInAs(context, "owner");
  await page.goto("/catalogue");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "sw");
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
    true,
  );
  await expectNoHorizontalScroll(page, "catalogue (sw, 360 px)");
  expect(await axeViolations(page)).toEqual([]);

  await expect(page.getByRole("table")).toContainText("Saruji 42.5N (mfuko wa kilo 50)");
  await page.getByRole("link", { name: "MAT-0001", exact: true }).click();
  await expect(page.getByRole("figure")).toBeVisible();
  await expectNoHorizontalScroll(page, "material (sw, 360 px)");
  expect(await axeViolations(page)).toEqual([]);

  await page.goto(`/suppliers/${STEEL_ID}`);
  await expect(page.getByTestId("payout-current")).toBeVisible();
  await expectNoHorizontalScroll(page, "supplier (sw, 360 px)");
  expect(await axeViolations(page)).toEqual([]);

  await page.goto("/catalogue/convert");
  await expectNoHorizontalScroll(page, "calculator (sw, 360 px)");
  expect(await axeViolations(page)).toEqual([]);
});
