import { expect, test, type Page } from "@playwright/test";
import { axeViolations, preferences, RUIRU_ID, signInAs, switchPersona } from "./live-helpers";

/**
 * D8.3 plant and equipment against test/mock-api.mts (mock-plant.mts computes with the shared
 * domain rules and returns the shared response schemas): the done-when (a fuel variance flagged,
 * as an estimate), site staff logging usage and fuel on a phone in Kiswahili and dark mode with the
 * meter kept monotonic, a project manager registering hired plant and handling a breakdown, and
 * the company settings. Axe-clean, no sideways scrolling at 360 px.
 */
const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("flags the fuel variance on the register and the item page, as an estimate", async ({
  page,
  context,
}) => {
  await signInAs(context, "pm");
  await page.goto("/plant");
  await expect(page.getByRole("heading", { name: "Plant and equipment", level: 1 })).toBeVisible();
  const attention = page.getByRole("region", { name: "Needs attention" });
  await expect(attention.getByRole("listitem").filter({ hasText: "EX-01" })).toContainText(
    "Fuel above the standard (estimate, not proof of theft)",
  );
  await expect(attention.getByRole("listitem").filter({ hasText: "MX-01" })).toContainText(
    "Service due",
  );
  await expect(attention).toContainText("never proof of theft");
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("article", { name: "EX-01 Excavator 20 t" }).getByRole("link").click();
  await expect(
    page.getByRole("heading", { name: "EX-01 · Excavator 20 t", level: 1 }),
  ).toBeVisible();
  const windows = page.getByRole("region", { name: "Fuel windows" });
  const over = windows.getByRole("row").filter({ hasText: "+30.0 %" });
  await expect(over).toContainText("182.0");
  await expect(over).toContainText("140.0");
  await expect(over).toContainText("Above the standard (estimate)");
  await expect(windows.getByRole("row").filter({ hasText: "+0.7 %" })).toContainText(
    "Within the standard",
  );
  // The project manager holds a cost permission: the hire estimate shows, labelled as one.
  await expect(page.getByText("Estimated hire charge so far")).toBeVisible();
  await expect(page.getByText("(an estimate; the supplier's invoice is the charge)")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("a site agent logs usage and fuel on a phone in Kiswahili and dark mode", async ({
  page,
  context,
}) => {
  test.slow();
  await preferences(context, page, "sw", "dark");
  await signInAs(context, "agent");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/projects/${RUIRU_ID}?tab=plant`);
  await expect(page.getByRole("heading", { name: "Mitambo", level: 2 })).toBeVisible();
  // A site agent sees no hire rates or estimates.
  await expect(page.getByText(/makadirio KES/)).toHaveCount(0);
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  await expect(async () => {
    await page.getByRole("link", { name: "Rekodi matumizi" }).first().click();
    await expect(page).toHaveURL(/\/plant\/usage/, { timeout: 2_000 });
  }).toPass();
  await expect(page.getByRole("heading", { name: "Rekodi matumizi", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Mtambo")).toHaveValue(/.+/);
  await expect(page.getByLabel("Saa mwanzoni")).toHaveValue("2478.0");
  // Below the last reading: refused by the API (the meter never goes backwards).
  await page.getByLabel("Saa mwanzoni").fill("2470");
  await page.getByLabel("Saa mwishoni").fill("2479");
  await expect(page.getByText("Saa 9.0 leo")).toBeVisible();
  await page.getByRole("button", { name: "Hifadhi matumizi" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Kipimo hakiwezi kuwa chini ya kipimo cha awali",
  );
  await page.getByLabel("Saa mwanzoni").fill("2478");
  await page.getByLabel("Saa mwishoni").fill("2486.5");
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Hifadhi matumizi" }).click();
  await expect(page.getByText("Matumizi yamehifadhiwa.")).toBeVisible();
  await expect(page.getByRole("article", { name: "EX-01 Excavator 20 t" })).toContainText(
    "Matumizi ya leo yamerekodiwa",
  );

  await page.getByRole("link", { name: "Rekodi mafuta" }).first().click();
  await expect(page.getByRole("heading", { name: "Rekodi mafuta", level: 1 })).toBeVisible();
  // 16.5 h since the last full tank at 14.00 L/h = 231.0 L expected; 280.0 L is +21.2 %.
  await page.getByLabel("Lita").fill("280");
  await page.getByLabel("Kipimo cha kipima saa").fill("2486.5");
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Hifadhi utoaji wa mafuta" }).click();
  const result = page.getByRole("region", { name: "Mafuta yamerekodiwa kwa EX-01" });
  await expect(result).toContainText("Juu ya kiwango (makadirio)");
  await expect(result).toContainText(
    "Lita 280.0 kwa 16.5 h dhidi ya lita 231.0 zilizotarajiwa (+21.2 %).",
  );
  await expect(result).toContainText("kamwe si ushahidi wa wizi");
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
});

test("a project manager registers hired plant, handles an unsafe breakdown and moves it", async ({
  page,
  context,
}) => {
  test.slow();
  await signInAs(context, "pm");
  await page.goto("/plant/new");
  await expect(page.getByRole("heading", { name: "Register plant", level: 1 })).toBeVisible();
  await page.getByLabel("Code").fill("rl-01");
  await page.getByLabel("Name").fill("Vibrating roller 3 t");
  await page.getByLabel("Category").selectOption("roller");
  await page.getByText("Hired", { exact: true }).click();
  await page.getByLabel("Supplier").selectOption({ index: 1 });
  await page.getByLabel("Hire rate (KES)").fill("12,000");
  await page.getByLabel("Standard consumption (litres per hour)").fill("4");
  await page.getByLabel("Meter reading then").fill("860");
  await page.getByLabel("Starts at").selectOption({ label: "RUI-HTS · Main plot" });
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Register" }).click();
  await expect(
    page.getByRole("heading", { name: "RL-01 · Vibrating roller 3 t", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("On site", { exact: true }).first()).toBeVisible();

  await expect(async () => {
    await page.getByRole("button", { name: "Report a breakdown" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2_000 });
  }).toPass();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Severity").selectOption("unsafe");
  await dialog.getByLabel("What happened").fill("Brake line leaking on the drum roller");
  await dialog.getByRole("button", { name: "Report a breakdown" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Unsafe: must not be used")).toBeVisible();
  await expect(page.getByText("Under repair", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /^Record the repair\s*: BRK-0001$/ }).click();
  await dialog.getByLabel("Repaired by (optional)").fill("Dealer mechanic (synthetic)");
  await dialog.getByRole("button", { name: "Record the repair" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Repaired", { exact: true })).toBeVisible();
  await expect(page.getByText("On site", { exact: true }).first()).toBeVisible();

  // An operator without a certificate where rollers need one is flagged, not blocked.
  await page.getByRole("button", { name: "Assign an operator" }).click();
  await dialog.getByRole("radio", { name: "Staff member" }).check();
  await dialog
    .getByRole("combobox", { name: "Staff member" })
    .selectOption({ label: "Kevin Kiprono" });
  await dialog.getByRole("button", { name: "Assign an operator" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Operators" }).getByText("No certificate recorded"),
  ).toBeVisible();
  await expect(page.getByText("Operator certificate missing or expiring")).toBeVisible();

  await page.getByRole("button", { name: "Move", exact: true }).click();
  await dialog.getByLabel("To").selectOption({ label: "Yard (not on a site)" });
  await dialog.getByRole("button", { name: "Move" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("In the yard", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Site history" })).toContainText(
    "RUI-HTS · Main plot → Yard (not on a site)",
  );
  expect(await axeViolations(page)).toEqual([]);
});

test("the owner tunes the fuel tolerance; a site agent only reads the settings", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "owner");
  await page.goto("/plant/settings");
  await expect(page.getByRole("heading", { name: "Plant settings", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Fuel tolerance above the standard (%)")).toHaveValue("15");
  await page.getByLabel("Fuel tolerance above the standard (%)").fill("35");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  // +30.0 % is within a 35 % tolerance: the alert clears (the rule decides, not a person).
  await page.goto("/plant");
  await expect(
    page
      .getByRole("region", { name: "Needs attention" })
      .getByRole("listitem")
      .filter({ hasText: "EX-01" }),
  ).toHaveCount(0);

  await switchPersona(context, "agent", token);
  await page.goto("/plant/settings");
  await expect(page.getByLabel("Fuel tolerance above the standard (%)")).toBeDisabled();
  await expect(
    page.getByText("Only people who manage company settings can change these."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save settings" })).toHaveCount(0);
});
