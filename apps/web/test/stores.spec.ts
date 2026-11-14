import { randomUUID } from "node:crypto";
import { expect as baseExpect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  axeViolations,
  MOCK_CSRF,
  preferences,
  signInAs,
  switchPersona,
  type Persona,
} from "./live-helpers";

/**
 * D5.3 stores against test/mock-api.mts (test/mock-stores.mts). The main plot store of Ruiru
 * Heights starts with GRN-0001: 120 bags of cement at KES 800 a bag and 20 t of river sand at
 * KES 4,000 a tonne (KES 176,000), and a reorder level of 50 bags of cement. BQ item B2/1 (the
 * ground floor slab) is linked to the CONC-C25-SYN build-up (6.5 bags of cement per m³, 5 %
 * waste) and measured at 10 m³, so it needs 10 × 6.5 × 1.05 = 68.25 bags; with the default 10 %
 * threshold an alert fires above 75.075 bags. Worked by hand:
 * - issuing 80 bags: variance 11.75 bags = 17.2 % → alert; the store keeps 40 bags (≤ 50: low);
 * - returning 5 bags: actual 75 ≤ 75.075 → within the threshold, no alert;
 * - a count of 118 bags against 120 expected → an adjustment of −2 bags at KES 800 (−KES 1,600);
 * - a transfer of 10 bags received as 9.5 → disputed, KES 400 lost in transit.
 */
const expect = baseExpect.configure({ timeout: 20_000 });
test.describe.configure({ timeout: 300_000 });

const MAIN_STORE_ID = "73000000-0000-4000-8000-000000000001";
const SLAB_LINEAGE_ID = "72000000-0000-4000-8000-000000000001";
const CONCRETE_BUILDUP_ID = "50000000-0000-4000-8000-000000000001";
const MINUS = "\u2212";

async function api(page: Page, method: string, path: string, data?: object, key?: string) {
  const res = await page.request.fetch(`/api/v1${path}`, {
    method,
    headers: {
      "X-CSRF-Token": MOCK_CSRF,
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    data,
  });
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

/** Opens a command's confirmation, fills a reason when given and confirms it. */
async function command(page: Page, button: string, confirm: string, reason?: string) {
  await page.getByRole("button", { name: button, exact: true }).first().click();
  const dialog = page.getByRole("dialog").last();
  if (reason) await dialog.getByLabel("Reason").fill(reason);
  await dialog.getByRole("button", { name: confirm, exact: true }).click();
  await expect(dialog).toBeHidden();
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

const idOf = (page: Page) => new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)!;

async function onHand(page: Page, storeId: string, code: string) {
  const detail = await api(page, "GET", `/stores/${storeId}`);
  const balances = detail.body["balances"] as { material: { code: string }; quantity: string }[];
  return balances.find((row) => row.material.code === code)?.quantity ?? "0";
}

async function materialId(page: Page, storeId: string, code: string) {
  const options = await api(page, "GET", `/stores/${storeId}/issue-options`);
  const stock = options.body["stock"] as { material: { id: string; code: string } }[];
  return stock.find((entry) => entry.material.code === code)!.material.id;
}

test("stores: an issue above what the measured slab needs fires a variance alert; a return clears it", async ({
  page,
  context,
}) => {
  await preferences(context, page);
  await signInAs(context, "owner");

  // Stores home: one store with KES 176,000 of stock, nothing low, no alerts yet.
  await page.goto("/stores");
  await expect(page.getByRole("heading", { level: 1, name: "Stores" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Main plot store" })).toBeVisible();
  await expect(page.getByText("KES 176,000").first()).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // A store for the materials yard, created on demand from the sites without one.
  await command(page, "Create store", "Create store");
  await expect(page.getByRole("heading", { level: 1, name: "Materials yard store" })).toBeVisible();
  await expect(page.getByText("Nothing in this store yet.")).toBeVisible();

  // The variance report before any issue: within the threshold or unavailable, never zero.
  await page.goto("/stores/variance");
  await expect(page.getByRole("heading", { level: 1, name: "Consumption variance" })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("not proof of theft");
  await expect(page.locator('tr[data-state="alert"]')).toHaveCount(0);
  await expect(page.locator('tr[data-state="no_measurement"]').first()).toContainText(
    "Not measured",
  );
  await expect(page.locator('tr[data-state="not_mapped"]').first()).toContainText("Ballast 20 mm");
  expect(await axeViolations(page)).toEqual([]);

  // The owner (keeping the stores) issues 80 bags of cement to the slab.
  await page.goto(`/stores/${MAIN_STORE_ID}`);
  await page.getByRole("link", { name: "Issue", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Issue material" })).toBeVisible();
  await page.getByLabel("Find a BQ item").fill("slab");
  await page.getByLabel("BQ item", { exact: true }).selectOption(SLAB_LINEAGE_ID);
  await page.getByLabel("Issued to (name)").fill("Otieno, concrete gang");
  const line = page.getByRole("group", { name: "Material 1" });
  await expect(line.getByLabel("Material")).toHaveValue(
    await materialId(page, MAIN_STORE_ID, "MAT-0001"),
  );
  await expect(line.getByText("120 bag (50 kg) on hand")).toBeVisible();
  // More than is on hand is stopped before it is sent; a padded entry is trimmed.
  await line.getByLabel("Quantity (bag (50 kg))").fill("121");
  await expect(line.getByText("More than is on hand.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Issue", exact: true })).toBeDisabled();
  await line.getByLabel("Quantity (bag (50 kg))").fill(" 80 ");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Issue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ISS-0001 recorded" })).toBeVisible();
  await page.getByRole("link", { name: "Open ISS-0001" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Issue ISS-0001" })).toBeVisible();
  await expect(page.getByText("B2/1 · Concrete class 25").first()).toBeVisible();
  await expect(page.getByText("KES 64,000").first()).toBeVisible();
  const issueUrl = page.url();

  // The alert fires, with every input of the estimate shown.
  await page.goto("/stores/variance");
  const alert = page.locator('tr[data-state="alert"]');
  await expect(alert).toHaveCount(1);
  for (const text of [
    "B2/1",
    "Cement 42.5N (50 kg bag)",
    "CONC-C25-SYN v1, line 1",
    "10 m3",
    "6.5 bag (50 kg)",
    "5 %",
    "68.25 bag (50 kg)",
    "Limit 75.075",
    "80 bag (50 kg)",
    "11.75",
    "17.2 %",
    "Above threshold",
  ])
    await expect(alert, text).toContainText(text);
  await expect(page.getByRole("status").filter({ hasText: "1 alert" })).toBeVisible();
  // The home page counts it and lists cement as low stock (40 bags ≤ 50).
  await page.goto("/stores");
  await expect(page.getByText("1 variance alert").first()).toBeVisible();
  await expect(page.getByText("40 bag (50 kg) on hand, reorder at 50")).toBeVisible();

  // Five bags come back: 75 bags is within 75.075, so the alert clears.
  await page.goto(issueUrl);
  await page.getByRole("link", { name: "Record a return" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Record a return" })).toBeVisible();
  await expect(page.getByText("Up to 80 bag (50 kg)")).toBeVisible();
  await page.getByLabel("Cement 42.5N (50 kg bag) (bag (50 kg))").fill("81");
  await expect(page.getByText("More than is outstanding on the issue.")).toBeVisible();
  await page.getByLabel("Cement 42.5N (50 kg bag) (bag (50 kg))").fill("5");
  await page.getByRole("button", { name: "Record return" }).click();
  await expect(page.getByRole("heading", { name: "RTN-0001 recorded" })).toBeVisible();
  await page.goto("/stores/variance");
  await expect(page.locator('tr[data-state="alert"]')).toHaveCount(0);
  const slabCement = page
    .locator('tr[data-state="within"]')
    .filter({ hasText: "Cement 42.5N (50 kg bag)" })
    .filter({ hasText: "B2/1" });
  await expect(slabCement).toContainText("75 bag (50 kg)");
  await expect(slabCement).toContainText("Within threshold");
  expect(await onHand(page, MAIN_STORE_ID, "MAT-0001")).toBe("45");

  // The ledger shows every movement in base units with the running balance.
  await page.goto(`/stores/${MAIN_STORE_ID}/ledger`);
  await expect(page.getByRole("heading", { level: 1, name: "Stock ledger" })).toBeVisible();
  const ledger = page.getByRole("region", { name: "Stock ledger" });
  await expect(ledger.getByRole("row").filter({ hasText: "RTN-0001" })).toContainText("45");
  await expect(ledger.getByRole("row").filter({ hasText: "ISS-0001" })).toContainText(`${MINUS}80`);
  expect(await axeViolations(page)).toEqual([]);

  // A measurement of the columns turns their "unavailable" rows into estimates.
  await page.goto("/stores/variance?state=no_measurement");
  const columns = page.locator('tr[data-state="no_measurement"]').filter({ hasText: "B2/4" });
  await columns.first().getByRole("button", { name: "Record measurement" }).click();
  const measure = page.getByRole("dialog", { name: "Record a measurement" });
  await measure.getByLabel("Quantity completed to date (m3)").fill("2.5 ");
  await measure.getByRole("button", { name: "Save measurement" }).click();
  await expect(measure).toBeHidden();
  await page.goto("/stores/variance");
  await expect(
    page.locator('tr[data-state="within"]').filter({ hasText: "B2/4" }).first(),
  ).toContainText("2.5 m3");
});

test("stock take: counts compare with the stock when counted; someone else approves and the variance is posted", async ({
  page,
  context,
}) => {
  await preferences(context, page);
  const token = await signInAs(context, "owner");
  await page.goto(`/stores/${MAIN_STORE_ID}`);
  await command(page, "Start stock take", "Start stock take");
  await expect(page.getByRole("heading", { level: 1, name: "Stock take STK-0001" })).toBeVisible();
  const takeId = idOf(page);
  await expect(page.getByText("0 of 2 counted")).toBeVisible();

  // Cement is counted at 118 against 120; then 10 bags are issued while counting continues.
  await page.getByLabel("Count (bag (50 kg))").fill("118");
  await page.getByRole("button", { name: "Save counts" }).click();
  await expect(page.getByText("1 of 2 counted")).toBeVisible();
  await expect(page.getByText(`${MINUS}2 bag (50 kg)`).first()).toBeVisible();
  const cement = await materialId(page, MAIN_STORE_ID, "MAT-0001");
  const during = await api(
    page,
    "POST",
    "/stock-movements/issues",
    {
      id: randomUUID(),
      storeId: MAIN_STORE_ID,
      bqItemLineageId: SLAB_LINEAGE_ID,
      issuedToName: "Concrete gang",
      capturedAt: new Date().toISOString(),
      lines: [{ materialId: cement, quantity: "10", unit: "bag_50kg" }],
    },
    `issue-${randomUUID()}`,
  );
  expect(during.status).toBe(201);
  await page.getByLabel("Count (tonne)").fill("20");
  await page.getByRole("button", { name: "Save counts" }).click();
  await expect(page.getByText("2 of 2 counted")).toBeVisible();
  // The issue during the count is not mistaken for a loss: still −2 bags.
  await expect(page.getByText(`${MINUS}2 bag (50 kg)`).first()).toBeVisible();
  await expect(page.getByText("Matches")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // The owner counted and submits, so cannot approve (in the API and on screen).
  await command(page, "Submit for approval", "Submit");
  await expect(page.getByText("Waiting for approval")).toBeVisible();
  await expect(
    page.getByText("You counted or submitted this stock take, so someone else approves it."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  const detail = await api(page, "GET", `/stock-takes/${takeId}`);
  const version = (detail.body["stockTake"] as { version: number }).version;
  const refused = await api(page, "POST", `/stock-takes/${takeId}/approve`, { version });
  expect(refused.status).toBe(403);
  expect(refused.body["code"]).toBe("maker-checker");

  // The project manager (procurement.approve on Ruiru Heights) approves.
  await as(context, page, "pm", token);
  await expect(page.getByRole("button", { name: "Save counts" })).toHaveCount(0);
  await command(page, "Approve", "Approve");
  await expect(page.getByText(/^Approved by Brian Otieno/)).toBeVisible();
  // 120 − 10 issued − 2 short = 108 bags; the ledger has the adjustment at KES 800 a bag.
  expect(await onHand(page, MAIN_STORE_ID, "MAT-0001")).toBe("108");
  await page.goto(`/stores/${MAIN_STORE_ID}/ledger?kind=adjustment`);
  const adjustment = page.getByRole("region", { name: "Stock ledger" }).getByRole("row");
  await expect(adjustment.filter({ hasText: "STK-0001" })).toContainText(`${MINUS}2`);
  await expect(adjustment.filter({ hasText: "STK-0001" })).toContainText("1,600");
});

test("transfer: dispatched, received short and disputed, resolved by someone else; replays never double", async ({
  page,
  context,
}) => {
  await preferences(context, page);
  const token = await signInAs(context, "owner");
  await page.goto("/stores");
  const home = await api(page, "GET", "/stores");
  const yardSite = (
    home.body["sitesWithoutStore"] as { site: { id: string; name: string } }[]
  ).find((entry) => entry.site.name === "Materials yard")!.site.id;
  const created = await api(page, "POST", "/stores", { siteId: yardSite });
  expect(created.status).toBe(201);
  const yardId = (created.body["store"] as { id: string }).id;

  // Offline-ready issue: the same ID and key sent twice is one movement; a changed body is refused.
  const cement = await materialId(page, MAIN_STORE_ID, "MAT-0001");
  const issue = {
    id: randomUUID(),
    storeId: MAIN_STORE_ID,
    bqItemLineageId: SLAB_LINEAGE_ID,
    issuedToName: "Concrete gang",
    capturedAt: new Date().toISOString(),
    source: "site_app",
    lines: [{ materialId: cement, quantity: "4", unit: "bag_50kg" }],
  };
  const key = `issue-${randomUUID()}`;
  const first = await api(page, "POST", "/stock-movements/issues", issue, key);
  const again = await api(page, "POST", "/stock-movements/issues", issue, key);
  expect(first.status).toBe(201);
  expect(again.body["replayed"]).toBe(true);
  expect((again.body["movement"] as { number: string }).number).toBe(
    (first.body["movement"] as { number: string }).number,
  );
  expect(await onHand(page, MAIN_STORE_ID, "MAT-0001")).toBe("116");
  const changed = await api(
    page,
    "POST",
    "/stock-movements/issues",
    { ...issue, lines: [{ materialId: cement, quantity: "5", unit: "bag_50kg" }] },
    key,
  );
  expect(changed.status).toBe(409);
  expect(changed.body["code"]).toBe("idempotency-key-reused");
  // Stock never goes negative: more than is on hand is refused, not clipped.
  const tooMuch = await api(
    page,
    "POST",
    "/stock-movements/issues",
    {
      ...issue,
      id: randomUUID(),
      lines: [{ materialId: cement, quantity: "117", unit: "bag_50kg" }],
    },
    `issue-${randomUUID()}`,
  );
  expect(tooMuch.status).toBe(409);
  expect(tooMuch.body["code"]).toBe("insufficient-stock");

  // Dispatch 10 bags to the materials yard.
  await page.goto(`/stores/${MAIN_STORE_ID}/transfer`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Transfer to another site" }),
  ).toBeVisible();
  await page.getByLabel("To store").selectOption(yardId);
  await page.getByLabel("Quantity (bag (50 kg))").fill("10");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Dispatch" }).click();
  await expect(page.getByRole("heading", { name: "TRF-0001 dispatched" })).toBeVisible();
  await page.getByRole("link", { name: "Open TRF-0001" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Transfer TRF-0001" })).toBeVisible();
  await expect(page.getByText("In transit").first()).toBeVisible();
  const transferUrl = page.url();
  await page.goto(`/stores/${yardId}`);
  await expect(page.getByText("arriving from Main plot store")).toBeVisible();

  // 9.5 bags arrive: the difference needs a reason and the transfer is disputed.
  await page.goto(transferUrl);
  const receive = page.getByRole("form", { name: "Receive" });
  await receive.getByLabel("Cement 42.5N (50 kg bag) (bag (50 kg))").fill("9.5");
  await expect(receive.getByRole("button", { name: "Receive" })).toBeDisabled();
  await receive.getByLabel("Why is it different?").fill("One bag split on the road");
  await receive.getByRole("button", { name: "Receive" }).click();
  await expect(page.getByText("Disputed").first()).toBeVisible();
  await expect(page.getByText("Lost in transit: KES 400")).toBeVisible();
  expect(await onHand(page, yardId, "MAT-0001")).toBe("9.5");
  // The owner dispatched and received, so the project manager resolves.
  await expect(page.getByRole("button", { name: "Resolve dispute" })).toHaveCount(0);
  await as(context, page, "pm", token);
  await command(page, "Resolve dispute", "Resolve", "Written off as transit damage");
  await expect(page.getByText("Resolved").first()).toBeVisible();
  await expect(page.getByText("Written off as transit damage")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("stores settings and the build-up mapping: the threshold moves the alert; unmapped lines are reported", async ({
  page,
  context,
}) => {
  await preferences(context, page);
  await signInAs(context, "owner");
  await page.goto("/stores");
  const cement = await materialId(page, MAIN_STORE_ID, "MAT-0001");
  const issued = await api(
    page,
    "POST",
    "/stock-movements/issues",
    {
      id: randomUUID(),
      storeId: MAIN_STORE_ID,
      bqItemLineageId: SLAB_LINEAGE_ID,
      issuedToName: "Concrete gang",
      capturedAt: new Date().toISOString(),
      lines: [{ materialId: cement, quantity: "80", unit: "bag_50kg" }],
    },
    `issue-${randomUUID()}`,
  );
  expect(issued.status).toBe(201);

  // 17.2 % over: an alert at 10 %, none at 20 %.
  await page.goto("/stores/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Stores settings" })).toBeVisible();
  await expect(page.getByText(/^Negative stock is never allowed/)).toBeVisible();
  await page.getByLabel("Variance alert threshold (%)").fill("20 ");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.goto("/stores/variance");
  await expect(page.getByText("Alerts above 20 %.")).toBeVisible();
  await expect(page.locator('tr[data-state="alert"]')).toHaveCount(0);

  // The build-up's sand line is unmapped, then mapped again (the build-up itself never changes).
  await page.goto(`/rate-buildups/${CONCRETE_BUILDUP_ID}`);
  const mappings = page.getByRole("region", { name: "Materials for stores" });
  await expect(mappings).toContainText("Cement 42.5N (50 kg bag): 1 bag (50 kg) = 1 bag (50 kg)");
  const sand = mappings.getByRole("listitem").filter({ hasText: "2. River sand" });
  await sand.getByRole("button", { name: "Remove mapping" }).click();
  await expect(sand.getByText("Not mapped")).toBeVisible();
  await page.goto("/stores/variance?state=not_mapped");
  await expect(
    page.locator('tr[data-state="not_mapped"]').filter({ hasText: "River sand" }).first(),
  ).toContainText("Build-up line not mapped");
  await page.goto(`/rate-buildups/${CONCRETE_BUILDUP_ID}`);
  await sand.getByRole("button", { name: "Map" }).click();
  const dialog = page.getByRole("dialog", { name: "Map “River sand”" });
  await dialog.getByLabel("Material").selectOption({ label: "River sand" });
  await dialog.getByLabel("Unit of the line's quantity").selectOption("t");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(sand).toContainText("River sand: 1 tonne = 1 tonne");
  expect(await axeViolations(page)).toEqual([]);
});

test("Kiswahili, dark theme and reduced motion on every stores screen; forms fit 360 px", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await preferences(context, page, "sw", "dark");
  await signInAs(context, "owner");
  await page.goto("/stores");
  await expect(page.locator("html")).toHaveAttribute("lang", "sw");
  const cement = await materialId(page, MAIN_STORE_ID, "MAT-0001");
  const issued = await api(
    page,
    "POST",
    "/stock-movements/issues",
    {
      id: randomUUID(),
      storeId: MAIN_STORE_ID,
      bqItemLineageId: SLAB_LINEAGE_ID,
      issuedToName: "Concrete gang",
      capturedAt: new Date().toISOString(),
      lines: [{ materialId: cement, quantity: "80", unit: "bag_50kg" }],
    },
    `issue-${randomUUID()}`,
  );
  const issueId = (issued.body["movement"] as { id: string }).id;
  const take = await api(page, "POST", "/stock-takes", { storeId: MAIN_STORE_ID });
  const takeId = (take.body["stockTake"] as { id: string }).id;
  const home = await api(page, "GET", "/stores");
  const yardSite = (
    home.body["sitesWithoutStore"] as { site: { id: string; name: string } }[]
  ).find((entry) => entry.site.name === "Materials yard")!.site.id;
  const yard = await api(page, "POST", "/stores", { siteId: yardSite });
  const yardId = (yard.body["store"] as { id: string }).id;
  const transfer = await api(
    page,
    "POST",
    "/stock-transfers",
    {
      id: randomUUID(),
      fromStoreId: MAIN_STORE_ID,
      toStoreId: yardId,
      capturedAt: new Date().toISOString(),
      lines: [{ materialId: cement, quantity: "5", unit: "bag_50kg" }],
    },
    `transfer-${randomUUID()}`,
  );
  const transferId = (transfer.body["transfer"] as { id: string }).id;

  const screens = [
    ["/stores", "Stoo"],
    [`/stores/${MAIN_STORE_ID}`, "Main plot store"],
    [`/stores/${MAIN_STORE_ID}/ledger`, "Leja ya akiba"],
    [`/stores/${MAIN_STORE_ID}/issue`, "Toa vifaa"],
    [`/stores/${MAIN_STORE_ID}/wastage`, "Rekodi upotevu"],
    [`/stores/${MAIN_STORE_ID}/transfer`, "Hamisha kwenda eneo jingine"],
    [`/stores/${MAIN_STORE_ID}/reorder-levels`, "Viwango vya kuagiza tena"],
    [`/stores/movements/${issueId}`, "Utoaji ISS-0001"],
    [`/stores/movements/${issueId}/return`, "Rekodi urejeshaji"],
    ["/stores/transfers", "Uhamisho"],
    [`/stores/transfers/${transferId}`, "Uhamisho TRF-0001"],
    ["/stores/stock-takes", "Kuhesabu stoo"],
    [`/stores/stock-takes/${takeId}`, "Hesabu ya stoo STK-0001"],
    ["/stores/variance", "Tofauti ya matumizi"],
    ["/stores/settings", "Mipangilio ya stoo"],
  ] as const;
  for (const [path, heading] of screens) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading }), path).toBeVisible();
    expect(await axeViolations(page), path).toEqual([]);
  }
  await page.goto("/stores/variance");
  await expect(page.locator('tr[data-state="alert"]')).toContainText("Juu ya kiwango");

  // Mobile-first: every stores screen fits 360 px without horizontal scrolling.
  await page.setViewportSize({ width: 360, height: 780 });
  for (const [path] of screens) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    await expectNoHorizontalScroll(page, `${path} (sw, 360 px)`);
  }
  // A wastage record at 360 px, with a long Kiswahili reason in the badge-free result.
  await page.goto(`/stores/${MAIN_STORE_ID}/wastage`);
  await page.getByLabel("Sababu").selectOption("theft_suspected");
  await page.getByLabel("Kiasi (mfuko (kg 50))").fill("1");
  await page.getByLabel("Kilichotokea").fill("Mfuko mmoja haukupatikana asubuhi");
  await page.getByRole("button", { name: "Rekodi upotevu" }).click();
  await expect(page.getByRole("heading", { name: "WST-0001 imerekodiwa" })).toBeVisible();
  await expectNoHorizontalScroll(page, "wastage result (sw, 360 px)");
  expect(await axeViolations(page)).toEqual([]);
});
