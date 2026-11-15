import { expect, test, type Page } from "@playwright/test";
import { axeViolations, preferences, RUIRU_ID, signInAs, switchPersona } from "./live-helpers";

/**
 * D6.1 quality against test/mock-api.mts (mock-quality.mts uses the shared domain rules and
 * response schemas): inspections with a phone checklist and an independent sign-off, snags with an
 * independent verifier, cube and slump tests with corrections, practical completion refused with an
 * open critical snag and the defects liability period, company templates and settings, Kiswahili,
 * dark mode, 360 px and axe.
 */
const quality = (view?: "tests" | "snags" | "completion") =>
  `/projects/${RUIRU_ID}?tab=quality${view ? `&view=${view}` : ""}`;
const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);

test("starts an inspection, fills the checklist on a phone and has it signed off independently", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "agent");
  await page.goto(`/projects/${RUIRU_ID}`);
  await page
    .getByRole("navigation", { name: "Project sections" })
    .getByRole("link", { name: "Quality", exact: true })
    .click();
  await expect(page).toHaveURL(quality());
  await expect(page.getByRole("heading", { name: "Quality", level: 2 })).toBeVisible();
  await expect(page.getByRole("link", { name: /INS-0002/ })).toContainText("Awaiting sign-off");
  await expect(page.getByRole("link", { name: /INS-0001/ })).toContainText("Signed off · locked");

  await page.getByRole("button", { name: "New inspection" }).click();
  const dialog = page.getByRole("dialog", { name: "New inspection" });
  await dialog
    .getByLabel("Checklist template")
    .selectOption({ label: "Setting out (v1, 5 items)" });
  await dialog.getByLabel("Location").fill("Block B building lines");
  await dialog.getByRole("button", { name: "Start inspection" }).click();
  await expect(page).toHaveURL(/\/quality\/inspections\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Setting out", level: 1 })).toBeVisible();

  await page.setViewportSize({ width: 360, height: 800 });
  const item = (position: number) =>
    page.getByRole("group", { name: new RegExp(`^${position}\\. `) });
  await page.getByRole("button", { name: "Save and submit for sign-off" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "5 items not answered yet" }),
  ).toBeVisible();
  for (const position of [1, 2, 4, 5])
    await item(position).getByText("Pass", { exact: true }).click();
  await item(3).getByText("Fail", { exact: true }).click();
  await page.getByRole("button", { name: "Save and submit for sign-off" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Explain every failed item" }),
  ).toBeVisible();
  await item(3).getByLabel("What failed (required)").fill("Diagonals differ by 25 mm");
  await item(3).locator('input[type="file"]').setInputFiles({
    name: "diagonals.jpg",
    mimeType: "image/jpeg",
    buffer: JPEG,
  });
  await expect(
    item(3).getByRole("list", { name: "Photos for item 3" }).getByRole("listitem"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Save checklist" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Checklist saved." })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Save and submit for sign-off" }).click();
  await expect(page.getByText("Awaiting sign-off").first()).toBeVisible();
  await expect(page.getByText("Failed", { exact: true }).first()).toBeVisible();
  // The author cannot sign off their own inspection.
  await expect(page.getByRole("button", { name: "Sign off and lock" })).toHaveCount(0);

  await switchPersona(context, "pm", token);
  await page.reload();
  await page.getByRole("button", { name: "Sign off and lock" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(
    page.getByText("Signed off and locked. This inspection cannot be changed."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save checklist" })).toHaveCount(0);
  await expect(item(3).getByRole("radio", { name: "Fail" })).toBeDisabled();
  expect(await axeViolations(page)).toEqual([]);
});

test("raises a snag from a failed item and verifies fixes independently", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "pm");
  await page.goto(quality());
  await page.getByRole("link", { name: /INS-0002/ }).click();
  await page.getByRole("button", { name: "Raise a snag from item 4" }).click();
  const dialog = page.getByRole("dialog", { name: "Raise a snag" });
  await dialog.getByLabel("Severity").selectOption("major");
  await dialog.getByLabel("Name of the gang, subcontractor or supplier").fill("Gang B masons");
  await dialog.getByRole("button", { name: "Raise a snag" }).click();
  await expect(dialog).toHaveCount(0);
  const raised = page.getByRole("article", { name: /^Snag SNG-0004/ });
  await expect(raised).toContainText("Major");
  await expect(page.getByText("2 snags raised")).toBeVisible();

  await page.goto(quality("snags"));
  await expect(page.getByRole("list", { name: "Snag counts" })).toContainText(
    "1 critical not closed",
  );
  // SNG-0002 was fixed by the site agent: the PM verifies and closes it.
  const fixed = page.getByRole("article", { name: /^Snag SNG-0002/ });
  await fixed.getByRole("button", { name: "Verify and close SNG-0002" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(fixed).toContainText("Verified and closed");
  // A fix the PM records must be verified by someone else.
  const hoarding = page.getByRole("article", { name: /^Snag SNG-0003/ });
  await expect(hoarding).toContainText("Overdue");
  await hoarding.getByRole("button", { name: "Mark fixed: SNG-0003" }).click();
  await page.getByRole("dialog").getByLabel("What was done (optional)").fill("Panel re-fixed");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(hoarding).toContainText("Fixed, awaiting verification");
  await expect(hoarding.getByRole("button", { name: "Verify and close SNG-0003" })).toHaveCount(0);
  await expect(hoarding).toContainText("Awaiting verification by someone other than");
  await switchPersona(context, "owner", token);
  await page.reload();
  await hoarding.getByRole("button", { name: "Reopen SNG-0003" }).click();
  const reopen = page.getByRole("dialog");
  await reopen.getByRole("button", { name: "Confirm" }).click();
  await expect(reopen.getByRole("alert")).toContainText("3–500 characters");
  await reopen.getByLabel("Reason (3–500 characters)").fill("Panel still loose at the top");
  await reopen.getByRole("button", { name: "Confirm" }).click();
  await expect(hoarding).toContainText("Reopened once. Last reason: Panel still loose at the top");

  await page.getByLabel("Status", { exact: true }).selectOption("open");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/view=snags&status=open/);
  await expect(page.getByRole("article", { name: /^Snag SNG-0002/ })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
});

test("records cube results, flags overdue and failed sets, and corrects by reference", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto(quality("tests"));
  await expect(page.getByText(/Rule KE-CUBE-1 \(awaiting engineer review\)/)).toBeVisible();
  await page.getByRole("link", { name: "Overdue (1)" }).click();
  await expect(page).toHaveURL(/view=tests&filter=overdue/);
  const roof = page.getByRole("article", { name: /^CUBE-0003/ });
  await expect(roof).toContainText("Overdue");
  await roof.getByRole("button", { name: "Record 7-day results for CUBE-0003" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Crushing strengths (N/mm²)").fill("17.55, 18");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toContainText("at most one decimal place");
  await dialog.getByLabel("Crushing strengths (N/mm²)").fill(" 17.5, 18 18.2 ");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await page.goto(quality("tests"));
  await expect(page.getByRole("article", { name: /^CUBE-0003/ })).toContainText(
    "Mean 17.90 N/mm² (71.6% of class), lowest cube 17.5",
  );

  await page.getByRole("link", { name: "Failed (1)" }).click();
  const failed = page.getByRole("article", { name: /^CUBE-0002/ });
  await expect(failed).toContainText("Fail at 28 days");
  await failed.getByRole("button", { name: "Correct the 28-day result of CUBE-0002" }).click();
  await dialog.getByLabel("Crushing strengths (N/mm²)").fill("25.4, 26.1, 25.0");
  await dialog.getByLabel("Reason (3–500 characters)").fill("Lab sheet transcribed wrongly");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await page.goto(quality("tests"));
  const corrected = page.getByRole("article", { name: /^CUBE-0002/ });
  await expect(corrected).toContainText("Pass at 28 days");
  await expect(corrected).toContainText("Correction: Lab sheet transcribed wrongly");

  await page.getByRole("button", { name: "Record a slump test" }).click();
  await dialog.getByLabel("Element or pour").fill("Roof beam pour 2");
  await dialog.getByLabel("Target slump (mm)").fill("40");
  await expect(dialog.getByText("Suggested for this target: ± 10 mm.")).toBeVisible();
  await dialog.getByLabel("Target slump (mm)").fill("75");
  await dialog.getByLabel("Measured slump (mm)").fill(" 110 ");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  const slump = page.getByRole("article", { name: /^SLP-0002/ });
  await expect(slump).toContainText("Outside tolerance");
  await expect(slump).toContainText("Measured 110 mm against 75 ± 20 mm (difference 35 mm)");
  expect(await axeViolations(page)).toEqual([]);
});

test("refuses practical completion with an open critical snag unless excepted, then certifies it independently", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "pm");
  await page.goto(quality("completion"));
  await expect(page.getByText("Snags not closed: 3, of which critical: 1.")).toBeVisible();
  await page.getByRole("button", { name: "Propose practical completion" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Critical snags are open: record an exception reason");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Critical snags are open. Close them or record an exception reason.",
  );
  await dialog
    .getByLabel("Exception reason (only if snags block completion)")
    .fill("Client accepts the lintel repair after handover");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Proposed, awaiting independent certification")).toBeVisible();
  await expect(
    page.getByText("Awaiting certification by someone other than the proposer."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Certify practical completion" })).toHaveCount(0);

  await switchPersona(context, "owner", token);
  await page.reload();
  await page.getByRole("button", { name: "Certify practical completion" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Certified · locked")).toBeVisible();
  await expect(
    page.getByText("Exception: Client accepts the lintel repair after handover"),
  ).toBeVisible();
  await expect(page.getByText(/Running: \d+ days left/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Propose final completion" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("loads starter templates, creates and revises a template, and changes the settings", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/quality");
  await page.getByRole("link", { name: "Checklist templates" }).click();
  await expect(page.getByRole("heading", { name: "Checklist templates", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Load the starter templates" }).click();
  await expect(page.getByRole("status").filter({ hasText: "3 templates added." })).toBeVisible();
  await page.getByRole("button", { name: "New template" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Formwork striking");
  await dialog.getByLabel("Covers").selectOption("columns_beams");
  await dialog
    .getByLabel("Checklist items")
    .fill("Cube results reviewed\n\nEngineer's approval on file");
  await dialog.getByRole("button", { name: "Create template" }).click();
  await expect(page.getByRole("heading", { name: "Formwork striking", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Revise" }).click();
  await dialog
    .getByLabel("Checklist items")
    .fill("Cube results reviewed\nEngineer's approval on file\nProps left under long spans");
  await dialog.getByRole("button", { name: "Save version 2" }).click();
  await expect(page.getByText(/^Version 2, by Wanjiru Kamau/)).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Version 1: Formwork striking (2 items)" }),
  ).toBeVisible();

  await page.goto("/quality/templates");
  await page.getByLabel("Default defects liability period (months, 1–24)").fill("25");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Enter 1–24 months and 0–14 days." }),
  ).toBeVisible();
  await page.getByLabel("Default defects liability period (months, 1–24)").fill(" 12 ");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Settings saved." })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("quality views work in Kiswahili, dark mode and at 360 px without sideways scrolling", async ({
  page,
  context,
}) => {
  test.slow();
  await signInAs(context, "owner");
  await preferences(context, page, "sw", "dark");
  await page.setViewportSize({ width: 360, height: 800 });
  for (const view of [undefined, "tests", "snags", "completion"] as const) {
    await page.goto(quality(view));
    await expect(page.getByRole("heading", { name: "Ubora", level: 2 })).toBeVisible();
    expect(await noSideScroll(page), view ?? "inspections").toBe(true);
    expect(await axeViolations(page), view ?? "inspections").toEqual([]);
  }
  await page.goto(quality());
  await page.getByRole("link", { name: /INS-0002/ }).click();
  await expect(page.getByRole("heading", { name: "Walling", level: 1 })).toBeVisible();
  await expect(page.getByText("Inasubiri kuidhinishwa").first()).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.goto("/quality/templates");
  await expect(page.getByRole("heading", { name: "Violezo vya orodha", level: 1 })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
});
