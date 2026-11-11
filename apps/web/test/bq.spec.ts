import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { axeViolations, preferences, RUIRU_ID, signInAs, SYOKIMAU_ID } from "./live-helpers";

/** Live BQ viewer and import wizard against test/mock-api.mts (synthetic workbooks). */
const fixture = (name: string) => path.join(__dirname, "../../api/test/fixtures/bq", name);

async function expectNoHorizontalScroll(page: Page, label: string) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    label,
  ).toBe(true);
}

test("shows the live BQ: summary, source and validation, tree and search", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto(`/projects/${RUIRU_ID}?tab=sites`);
  await page.getByRole("link", { name: "BQ", exact: true }).click();
  await expect(page).toHaveURL(`/projects/${RUIRU_ID}/bq`);
  await expect(page.getByRole("heading", { name: "Bill of Quantities", level: 1 })).toBeVisible();
  await expect(page.getByText(/Prototype: screens show mock data/)).toHaveCount(0);
  await expect(page.getByText("Version 1 · Draft · 39 items")).toBeVisible();

  const summary = page.getByRole("table", { name: "Summary" });
  await expect(summary.getByRole("row", { name: /Grand total/ })).toContainText(
    "KES 38,647,188.75",
  );
  await expect(summary.getByRole("row", { name: /VAT at 16%/ })).toContainText("KES 5,330,646.72");
  await expect(summary.getByRole("row", { name: /Bill 2: SUBSTRUCTURE/ })).toContainText(
    "KES 8,595,002.13",
  );
  await expect(page.getByText("Contingencies").first()).toBeVisible();
  await expect(page.getByText("kenyan-multi-bill.xlsx")).toBeVisible();
  await expect(page.getByText(/Grand total differs from the contract sum/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Export Excel" })).toHaveAttribute(
    "href",
    `/api/v1/projects/${RUIRU_ID}/bq/export/xlsx?locale=en`,
  );
  await expect(page.getByRole("link", { name: "Export PDF" })).toHaveAttribute(
    "href",
    `/api/v1/projects/${RUIRU_ID}/bq/export/pdf?locale=en`,
  );
  await expect(page.getByRole("link", { name: "Import BQ" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  const billTwo = page.getByRole("button", { name: /Bill 2: SUBSTRUCTURE/ });
  await expect(billTwo).toHaveAttribute("aria-expanded", "false");
  await billTwo.click();
  await expect(billTwo).toHaveAttribute("aria-expanded", "true");
  const table = page.getByRole("table", { name: "Bill 2: SUBSTRUCTURE" });
  const wire = table.getByRole("row", { name: /Galvanised binding wire/ });
  await expect(wire).toContainText("KES 7.13");
  await expect(wire).toContainText("1.5");
  await expect(table.getByRole("row", { name: /ground beams/ })).toContainText("KES 974,400");
  await expect(table.getByRole("row", { name: /Total for Bill 2/ })).toContainText(
    "KES 8,595,002.13",
  );
  const concrete = table.getByRole("button", { name: /CONCRETE WORK/ });
  await concrete.click();
  await expect(concrete).toHaveAttribute("aria-expanded", "false");
  await expect(table.getByRole("row", { name: /ground beams/ })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);

  await page.getByLabel("Search the BQ by description or reference").fill("binding");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("1 item matches.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Search results" })).toContainText(
    "Galvanised binding wire",
  );
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByRole("button", { name: /Bill 4: PC AND PROVISIONAL SUMS/ })).toBeVisible();
});

test("imports a messy workbook: errors resolved per row, warnings accepted, atomic commit", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto(`/projects/${SYOKIMAU_ID}/bq`);
  await expect(page.getByRole("heading", { name: "No BQ yet" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Import BQ" })).toHaveCount(2);
  await page.getByRole("link", { name: "Import BQ" }).last().click();
  await expect(
    page.getByRole("heading", { name: "Import a BQ from Excel", level: 1 }),
  ).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.getByLabel("Choose an Excel workbook").setInputFiles(fixture("messy.xlsx"));
  await page.getByRole("button", { name: "Upload and read" }).click();
  await expect(page.getByRole("heading", { name: "Sheets", level: 2 })).toBeVisible();
  await expect(page).toHaveURL(/\?import=/);
  const sheets = page.getByRole("table", { name: "Sheets in the workbook" });
  await expect(sheets.getByLabel("Bill number for BILL 2")).toHaveValue("2");
  await expect(sheets.getByLabel("Bill name for BILL 2")).toHaveValue("SUBSTRUCTURE");
  await expect(sheets.getByLabel("Header row of BILL 2")).toHaveValue("5");
  expect(await axeViolations(page)).toEqual([]);

  // Keyboard: the step list moves with the arrow keys; Next is a button.
  const steps = page.getByRole("list", { name: /Import steps/ });
  await steps.getByRole("button", { name: "Sheets (current step)" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(steps.getByRole("button", { name: "Upload", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(steps.getByRole("button", { name: "Sheets (current step)" })).toBeFocused();
  await page.getByRole("button", { name: "Next", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Columns", level: 2 })).toBeVisible();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue("1");
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("5");
  await expect(page.getByRole("region", { name: "Rows of the sheet as uploaded" })).toContainText(
    "Reinforced concrete class 25 in column bases",
  );
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("button", { name: "Save mapping" }).click();
  await expect(page.getByRole("heading", { name: "Validate", level: 2 })).toBeVisible();
  await page.getByRole("button", { name: "Run validation" }).click();
  await expect(page.getByText("Not ready: resolve every error")).toBeVisible();
  await expect(
    page.getByText("The sheet says KES 947,400 but quantity × rate is KES 974,400."),
  ).toBeVisible();
  await expect(
    page.getByText("This reference is already used in the same section and page."),
  ).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.getByLabel("Decision for BILL 2, row 10").selectOption("exclude");
  await page.getByLabel("Decision for BILL 2, row 23").selectOption("computed");
  for (const [title, reason] of [
    ["Missing unit", "The QS will add the unit in a revision"],
    ["Formula in the sheet", "Amounts are recomputed from quantity × rate"],
    ["Page total differs", "Page totals on the sheet are not used"],
  ] as const) {
    await page.getByLabel(`Accept: ${title}`).check();
    await page.getByLabel(`Reason for accepting: ${title}`).fill(reason);
  }
  await page.getByRole("button", { name: "Save decisions" }).click();

  await expect(page.getByRole("heading", { name: "Review and commit", level: 2 })).toBeVisible();
  await expect(
    page.getByText("This creates the project's original contract BQ as version 1 (draft)."),
  ).toBeVisible();
  await expect(page.getByRole("table", { name: "Bills to create" })).toContainText("KES 3,933,700");
  await expect(page.getByText("KES 4,563,092")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Commit the BQ" }).click();
  await expect(page.getByText("Imported. The BQ is version 1 (draft).").first()).toBeVisible();
  await page.getByRole("link", { name: "Open the BQ" }).click();

  await expect(page).toHaveURL(`/projects/${SYOKIMAU_ID}/bq`);
  await expect(
    page.getByRole("table", { name: "Summary" }).getByRole("row", { name: /Grand total/ }),
  ).toContainText("KES 4,563,092");
  await expect(page.getByText("BILL 2, row 23 · C")).toBeVisible();
  await expect(page.getByText("Used quantity × rate")).toBeVisible();
  await expect(page.getByText("BILL 2, row 10 · B")).toBeVisible();
  await expect(page.getByText(/Formula in the sheet/).first()).toBeVisible();
});

test("refuses a file that is not an Excel workbook", async ({ page, context }) => {
  await signInAs(context, "owner");
  await page.goto(`/projects/${SYOKIMAU_ID}/bq/import`);
  await page.getByLabel("Choose an Excel workbook").setInputFiles(fixture("not-excel.xlsx"));
  await page.getByRole("button", { name: "Upload and read" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Only Excel workbooks (.xlsx or .xls) are accepted" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Upload", level: 2 })).toBeVisible();
});

test("shows the BQ read-only to a site agent and refuses the wizard", async ({ page, context }) => {
  await signInAs(context, "agent");
  await page.goto(`/projects/${RUIRU_ID}/bq`);
  await expect(page.getByRole("heading", { name: "Bill of Quantities", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Import BQ" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Export Excel" })).toBeVisible();
  await page.goto(`/projects/${RUIRU_ID}/bq/import`);
  await expect(page.getByRole("heading", { name: "You do not have access" })).toBeVisible();
});

for (const locale of ["en", "sw"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`BQ pages are accessible in ${locale}, ${theme}`, async ({ page, context }) => {
      await signInAs(context, "owner");
      await preferences(context, page, locale, theme);
      for (const target of [
        `/projects/${RUIRU_ID}/bq`,
        `/projects/${SYOKIMAU_ID}/bq`,
        `/projects/${RUIRU_ID}/bq/import`,
      ]) {
        await page.goto(target);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await axeViolations(page), target).toEqual([]);
      }
      await page.goto(`/projects/${RUIRU_ID}/bq`);
      await page.getByRole("button", { name: /Bill 1:/ }).click();
      await expect(page.getByRole("table", { name: /Bill 1:/ })).toBeVisible();
      if (locale === "sw") await expect(page.getByText("Jumla kuu").first()).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
    });
  }
}

test("BQ pages fit a 360 px Android viewport", async ({ page, context }) => {
  await signInAs(context, "owner");
  await page.setViewportSize({ width: 360, height: 740 });
  for (const target of [
    `/projects/${RUIRU_ID}/bq`,
    `/projects/${SYOKIMAU_ID}/bq`,
    `/projects/${SYOKIMAU_ID}/bq/import`,
  ]) {
    await page.goto(target);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page, target);
  }
  await page.goto(`/projects/${RUIRU_ID}/bq`);
  await page.getByRole("button", { name: /Bill 2:/ }).click();
  await expect(page.getByRole("table", { name: /Bill 2:/ })).toBeVisible();
  await expectNoHorizontalScroll(page, "bill 2 open");
});
