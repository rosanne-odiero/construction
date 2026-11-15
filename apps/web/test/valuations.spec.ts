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
 * D6.3 measurement and valuations against test/mock-api.mts (test/mock-valuations.mts). Ruiru
 * Heights' BQ: P1 preliminaries 500,000 (lump sum), A excavation 24 m³ @ 16,500, B blockwork
 * 120 m² @ 1,450, PS1 provisional sum 300,000 (not measured), D1 dayworks 100 hr @ 450; original
 * contract sum 1,415,000. Terms: retention 10 % limited to 5 % of 1,415,000 = 70,750, VAT 16 %,
 * materials on site 80 %. IPC-0001 (certified) valued P1 40 % + A 12 m³ = 398,000 and certified
 * 358,200 due. B at 60 m² (87,000) waits for approval. Worked by hand for IPC-0002 (today):
 * - work done 200,000 + 198,000 + 87,000 = 485,000; materials 40,000 at cost × 80 % = 32,000;
 * - gross 517,000; retention 51,700 (below the limit); advance +100,000; net 565,300;
 * - amount due 565,300 − 358,200 = 207,100; VAT 33,136; total 240,236.
 * Earned value today: BAC 1,115,000 (P1 + A + B + D1), EV 485,000, AC 350,000 → CPI 1.39;
 * PV half of BAC (557,500, linear over the baseline) → SPI 0.87; EAC 804,639.18.
 * Synthetic data only.
 */
const expect = baseExpect.configure({ timeout: 20_000 });
test.describe.configure({ timeout: 300_000 });

const IPC1_ID = "77200000-0000-4000-8000-000000000001";
const PENDING_ID = "77300000-0000-4000-8000-000000000003";
const ITEM_A = "77100000-0000-4000-8000-000000000002";
const ITEM_B = "77100000-0000-4000-8000-000000000003";
const ITEM_D1 = "77100000-0000-4000-8000-000000000005";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);

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

async function expectClean(page: Page, label: string) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `${label}: no horizontal scroll`,
  ).toBe(true);
  await expect(page.locator("#main")).not.toContainText(/valuations\.[a-zA-Z]/);
  expect(await axeViolations(page), `${label}: axe`).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/projects/*/photos/*/thumbnail", (route) =>
    route.fulfill({ status: 200, contentType: "image/jpeg", body: JPEG }),
  );
});

test("measurement: the site agent records quantities with a site photo at 360 px in Kiswahili and dark mode; it waits for someone else", async ({
  page,
  context,
}) => {
  await preferences(context, page, "sw", "dark");
  await signInAs(context, "agent");
  await page.setViewportSize({ width: 360, height: 800 });

  await page.goto("/valuations");
  await expect(page.getByRole("heading", { level: 1, name: "Vipimo na tathmini" })).toBeVisible();
  await expect(page.getByText("Kipimo 1 kinasubiri idhini")).toBeVisible();
  await expectClean(page, "/valuations");

  // Dayworks: 30 hr done to date with a photo taken now.
  await page.goto(`/valuations/projects/${RUIRU_ID}/measure?item=${ITEM_D1}`);
  await expect(page.getByRole("heading", { level: 1, name: "Rekodi kipimo" })).toBeVisible();
  await expect(page.getByLabel("Kipengele cha BQ")).toHaveValue(ITEM_D1);
  await expectClean(page, "measure");
  await page.getByLabel("Kiasi kilichofanywa hadi sasa (hr)").fill(" 30 ");
  await page.locator('input[type="file"]').setInputFiles({
    name: "dayworks.jpg",
    mimeType: "image/jpeg",
    buffer: JPEG,
  });
  await expect(
    page.getByRole("list", { name: "Picha zilizochaguliwa" }).getByRole("listitem"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Wasilisha kwa idhini" }).click();
  await expect(page.getByText(/^Kimerekodiwa\./)).toBeVisible();
  await expect(page.getByText("Kinasubiri idhini").first()).toBeVisible();
  await expect(page.getByText("KES 13,500").first()).toBeVisible();
  // The measurer cannot approve their own measurement (and holds no bq.edit).
  await expect(page.getByRole("button", { name: "Idhinisha" })).toHaveCount(0);
  await expectClean(page, "measurement detail");

  // Above the BQ quantity needs a reason before it can be submitted.
  await page.goto(`/valuations/projects/${RUIRU_ID}/measure?item=${ITEM_A}`);
  await page.getByLabel("Kiasi kilichofanywa hadi sasa (m3)").fill("30");
  await expect(page.getByLabel("Sababu ya kupima zaidi ya kiasi cha BQ")).toBeVisible();
  await expect(page.getByRole("button", { name: "Wasilisha kwa idhini" })).toBeDisabled();
  await page
    .getByLabel("Sababu ya kupima zaidi ya kiasi cha BQ")
    .fill("Mchanga laini: kina cha ziada (synthetic)");
  await expect(page.getByRole("button", { name: "Wasilisha kwa idhini" })).toBeEnabled();

  // The site agent sees measurements only: no certificates or earned value.
  await page.goto(`/valuations/projects/${RUIRU_ID}`);
  const tabs = page.getByRole("navigation", { name: "Sehemu za vipimo na tathmini" });
  await expect(tabs.getByRole("link", { name: "Vipimo" })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Vyeti" })).toHaveCount(0);
  await expectClean(page, "measurement sheet");
});

test("valuation: an approved measurement flows into an interim certificate certified by someone else on the digest; retention and earned value follow", async ({
  page,
  context,
}) => {
  await preferences(context, page);
  const token = await signInAs(context, "pm");

  // The project manager approves the site agent's blockwork measurement against its photo.
  await page.goto("/valuations");
  await page.getByRole("link", { name: "1 measurement to approve" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Measurements to approve" }),
  ).toBeVisible();
  await expect(page.getByText("60 m2 of 120 in the BQ")).toBeVisible();
  await expectClean(page, "approvals");
  await page.getByRole("button", { name: "Approve", exact: true }).first().click();
  const approve = page.getByRole("dialog").last();
  await expect(approve).toContainText("KES 87,000");
  await approve.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(approve).toBeHidden();
  await expect(page.getByText("Nothing is waiting for approval.")).toBeVisible();

  // The certificates tab and a new interim valuation.
  await page.goto(`/valuations/projects/${RUIRU_ID}?tab=certificates`);
  await expect(page.getByText("KES 1,415,000").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "IPC-0001" })).toBeVisible();
  await expectClean(page, "certificates");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Valuation VAL-0002" })).toBeVisible();
  const summary = page.getByRole("region", { name: "Certificate" });
  await expect(summary.getByRole("row", { name: /Gross value of work done/ })).toContainText(
    "KES 485,000",
  );

  // Materials on site cannot exceed what is left of the item (no double billing).
  await page.getByLabel("BQ item").selectOption(ITEM_B);
  await page.getByLabel("Description", { exact: true }).first().fill("Blocks on site (synthetic)");
  await page.getByLabel("Quantity", { exact: true }).fill("800");
  await page.getByLabel("Amount at cost (KES)").fill("90000");
  await page.getByRole("button", { name: "Add materials" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "they would be paid twice" }),
  ).toBeVisible();
  await page.getByLabel("Amount at cost (KES)").fill("40000");
  await page.getByRole("button", { name: "Add materials" }).click();
  await expect(summary.getByRole("row", { name: /Materials on site at cost/ })).toContainText(
    "KES 40,000",
  );

  await page.getByLabel("Kind", { exact: true }).selectOption("advance");
  await page
    .getByRole("region", { name: "Edit the draft" })
    .getByLabel("Description")
    .last()
    .fill("Mobilisation advance (synthetic)");
  await page.getByLabel("Amount (KES)", { exact: true }).fill("100000");
  await page.getByRole("button", { name: "Add adjustment" }).click();
  await expect(summary.getByRole("row", { name: /Agreed adjustments to date/ })).toContainText(
    "KES 100,000",
  );
  for (const [row, amount] of [
    [/Materials on site certified \(80%\)/, "KES 32,000"],
    [/^Gross valuation/, "KES 517,000"],
    [/Less retention \(10%, limited to KES 70,750\)/, "KES 51,700"],
    [/Net valuation to date/, "KES 565,300"],
    [/Less previous certificates/, "KES 358,200"],
    [/Amount due \(excluding VAT\)/, "KES 207,100"],
    [/VAT at 16%/, "KES 33,136"],
    [/Total payable including VAT/, "KES 240,236"],
  ] as const)
    await expect(summary.getByRole("row", { name: row })).toContainText(amount);
  await expectClean(page, "draft valuation");

  await command(page, "Submit for certification", "Submit for certification");
  await expect(page.getByText("Submitted", { exact: true }).first()).toBeVisible();
  // The preparer holds no finance.manage: no certify button.
  await expect(page.getByRole("button", { name: "Certify" })).toHaveCount(0);

  // Finance certifies on the digest it saw, after a step-up.
  await as(context, page, "finance", token);
  await command(page, "Certify", "Certify");
  await expect(
    page.getByRole("heading", { level: 1, name: "Interim payment certificate IPC-0002" }),
  ).toBeVisible();
  await expect(page.getByText(/Certified by Daniel Mwangi/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Certify" })).toHaveCount(0);
  const pdf = await page.getByRole("link", { name: "PDF (English)" }).getAttribute("href");
  const download = await page.request.get(pdf!);
  expect(download.status()).toBe(200);
  expect(download.headers()["content-type"]).toContain("application/pdf");
  await expectClean(page, "certified certificate");

  // The retention ledger: IPC-0001 held 39,800, IPC-0002 adds 11,900.
  await page.goto(`/valuations/projects/${RUIRU_ID}?tab=retention`);
  const ledger = page.getByRole("region", { name: "Retention ledger" });
  await expect(ledger.getByRole("row", { name: /IPC-0002/ })).toContainText("KES 11,900");
  await expect(ledger.getByRole("row", { name: /IPC-0002/ })).toContainText("KES 51,700");
  await expectClean(page, "retention");

  // Earned value: ratios, the S-curve with its table and cost to complete.
  await page.goto(`/valuations/projects/${RUIRU_ID}?tab=earned-value`);
  await expect(page.getByText("KES 1,115,000").first()).toBeVisible();
  await expect(page.getByText("1.39", { exact: true })).toBeVisible();
  await expect(page.getByText("0.87", { exact: true })).toBeVisible();
  await expect(page.getByText("KES 804,639.18").first()).toBeVisible();
  await expect(
    page.getByRole("img", { name: /S-curve of planned, earned and actual cumulative value/ }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "S-curve figures by week" })).toBeVisible();
  const bills = page.getByRole("region", { name: "Cost to complete by bill" });
  await expect(bills.getByRole("row", { name: /Substructure/ })).toContainText("KES 420,000");
  await expectClean(page, "earned value");
});

test("valuation: whoever prepared a valuation cannot certify it (maker-checker); a stale digest is refused; a return reopens the draft", async ({
  page,
  context,
}) => {
  await preferences(context, page);
  const token = await signInAs(context, "owner");
  await page.goto("/valuations");
  const stepped = await api(page, "POST", "/auth/mfa/step-up", { code: MOCK_STEP_UP_CODE });
  expect(stepped.status).toBe(200);

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" }).format(new Date());
  const created = await api(page, "POST", `/projects/${RUIRU_ID}/valuations`, {
    kind: "interim",
    valuationDate: today,
  });
  expect(created.status).toBe(201);
  const draft = created.body["valuation"] as { id: string; version: number };
  const submitted = await api(page, "POST", `/valuations/${draft.id}/submit`, {
    version: draft.version,
  });
  expect(submitted.status).toBe(200);
  const valuation = submitted.body["valuation"] as { version: number; digest: string };

  // The owner prepared it: no certify button, and the API refuses with maker-checker.
  await page.goto(`/valuations/${draft.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Valuation VAL-0002" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Certify" })).toHaveCount(0);
  const own = await api(page, "POST", `/valuations/${draft.id}/certify`, {
    version: valuation.version,
    digest: valuation.digest,
  });
  expect(own).toMatchObject({ status: 403, body: { code: "maker-checker" } });

  // Finance may certify, but only on the digest of the figures submitted.
  await as(context, page, "finance", token);
  await expect(page.getByRole("button", { name: "Certify" })).toBeVisible();
  const stale = await api(page, "POST", `/valuations/${draft.id}/certify`, {
    version: valuation.version,
    digest: "0".repeat(64),
  });
  expect(stale).toMatchObject({ status: 409, body: { code: "valuation-stale" } });

  // Returned with a reason, the draft is editable again (by someone with bq.edit).
  await command(page, "Return", "Return", { Reason: "Recheck the blockwork (synthetic)" });
  await as(context, page, "owner", token);
  await expect(page.getByText("Returned: Recheck the blockwork (synthetic)")).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit for certification" })).toBeVisible();
  await expectClean(page, "returned draft");
});

test("valuations: every screen in Kiswahili and dark mode at 360 px for finance — no overflow, axe-clean", async ({
  page,
  context,
}) => {
  await preferences(context, page, "sw", "dark");
  await signInAs(context, "finance");
  await page.setViewportSize({ width: 360, height: 800 });
  for (const [path, heading] of [
    ["/valuations", "Vipimo na tathmini"],
    ["/valuations/approvals", "Vipimo vya kuidhinisha"],
    [`/valuations/projects/${RUIRU_ID}?tab=measurements`, /RUI-HTS/],
    [`/valuations/projects/${RUIRU_ID}?tab=certificates`, /RUI-HTS/],
    [`/valuations/projects/${RUIRU_ID}?tab=retention`, /RUI-HTS/],
    [`/valuations/projects/${RUIRU_ID}?tab=earned-value`, /RUI-HTS/],
    [`/valuations/projects/${RUIRU_ID}/measurements/${PENDING_ID}`, /B · 200 mm blockwork/],
    [`/valuations/${IPC1_ID}`, "Cheti cha malipo ya muda IPC-0001"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expectClean(page, path);
  }
});
