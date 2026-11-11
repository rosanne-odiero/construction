import { expect, test } from "@playwright/test";
import {
  axeViolations,
  blockTiles,
  MAIN_PLOT_ID,
  MOCK_STEP_UP_CODE,
  preferences,
  RUIRU_ID,
  signInAs,
  SYOKIMAU_ID,
} from "./live-helpers";

/** Live project pages rendered from test/mock-api.mts (see playwright.config.ts). */

test.beforeEach(async ({ page }) => {
  await blockTiles(page);
});

test("lists live projects, filters them and opens every detail tab", async ({ page, context }) => {
  await signInAs(context, "owner");
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
  await expect(page.getByText("2 projects")).toBeVisible();
  await expect(page.getByText(/Prototype: screens show mock data/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New project" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.getByLabel("Search").fill("syok");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/search=syok/);
  await expect(page.getByText("1 project", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Syokimau Townhouses", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page.getByLabel("Search")).toHaveValue("");
  await page.getByLabel("Status").selectOption("active");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("1 project", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Ruiru Heights Apartments", exact: true }).click();

  await expect(page).toHaveURL(`/projects/${RUIRU_ID}`);
  await expect(
    page.getByRole("heading", { name: "Ruiru Heights Apartments", level: 1 }),
  ).toBeVisible();
  // Undefined ratios are unavailable, never 0 % or a made-up number (brief §15 G).
  await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(5);
  await expect(page.getByText(/^0%$/)).toHaveCount(0);
  await expect(page.getByText("KES 86,400,000")).toBeVisible();
  await expect(page.getByText("02/03/2026 – 30/04/2027")).toBeVisible();
  await expect(page.getByText("Contract signed and site handed over")).toBeVisible();
  await expect(page.getByRole("link", { name: "BQ", exact: true })).toHaveAttribute(
    "href",
    `/projects/${RUIRU_ID}/bq`,
  );
  await expect(page.getByText("Prototype", { exact: true })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("link", { name: "Sites", exact: true }).click();
  await expect(page.getByRole("region", { name: "Map of site geofences" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Main plot" })).toBeVisible();
  await expect(page.getByText("Polygon with 5 vertices")).toBeVisible();
  await expect(page.getByText("Radius of 40 m")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("link", { name: "Team", exact: true }).click();
  const team = page.getByRole("table", { name: "Project members" });
  await expect(team.getByRole("row")).toHaveCount(4);
  await expect(team.getByRole("row", { name: /Wanjiru Kamau/ })).toContainText("Company-wide");
  await expect(team.getByRole("row", { name: /Kevin Kiprono/ })).toContainText("3 permissions");
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("link", { name: "WBS & milestones", exact: true }).click();
  await expect(page.getByText("Every group adds up to 100%")).toBeVisible();
  await expect(page.getByText("(progress measurements arrive in D6.3)")).toBeVisible();
  await expect(page.getByRole("table", { name: "Milestones" }).getByRole("row")).toHaveCount(3);
  expect(await axeViolations(page)).toEqual([]);
});

test("creates a project after step-up MFA and moves it through its lifecycle", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/projects");
  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project name").fill("Kisumu Warehouse");
  await dialog.getByLabel("Project code").fill("ksm-whs");
  await dialog.getByLabel("Contract sum (KES)").fill("12,500,000");
  await dialog.getByLabel("Start date").fill("01/12/2026");
  await dialog.getByLabel("End date").fill("01/11/2026");
  await dialog.getByLabel("County").selectOption("kisumu");
  await dialog.getByLabel("Town").fill("Kisumu");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog.getByText("The end date must be on or after the start date.")).toBeVisible();
  await dialog.getByLabel("End date").fill("30/06/2027");
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Create project" }).click();

  const stepUp = page.getByRole("dialog", { name: "Confirm it is you" });
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel("Authenticator code").fill(MOCK_STEP_UP_CODE);
  await stepUp.getByRole("button", { name: "Verify and continue" }).click();

  await expect(page.getByRole("heading", { name: "Kisumu Warehouse", level: 1 })).toBeVisible();
  await expect(page.getByText("KSM-WHS").first()).toBeVisible();
  const checklist = page.getByRole("heading", { name: "Before this project can become active" });
  await expect(checklist).toBeVisible();
  await expect(page.getByText("At least one site with a geofence")).toBeVisible();
  await expect(page.getByText("KES 12,500,000")).toBeVisible();

  await page.getByRole("button", { name: "Change status" }).click();
  const statusDialog = page.getByRole("dialog", { name: "Change the project status" });
  await statusDialog.getByLabel("Activate (Active)").check();
  await statusDialog.getByRole("button", { name: "Change status" }).click();
  await expect(statusDialog.getByRole("alert")).toContainText(
    "add a site with a geofence before activating",
  );
  await statusDialog.getByLabel("Cancel the project (Cancelled)").check();
  const submit = statusDialog.getByRole("button", { name: "Change status" });
  await expect(submit).toBeDisabled();
  await statusDialog.getByLabel("Reason").fill("Client withdrew the tender");
  await submit.click();
  await expect(
    page.getByText("This project is closed or cancelled, so it is read-only."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit details" })).toHaveCount(0);
  await expect(page.getByText("Planning → Cancelled")).toBeVisible();
});

test("shows an assigned project read-only to a site agent", async ({ page, context }) => {
  await signInAs(context, "agent");
  await page.goto("/projects");
  await expect(page.getByText("1 project", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New project" })).toHaveCount(0);
  await expect(page.locator("header").getByText("Site agent")).toBeVisible();
  await page.getByRole("link", { name: "Ruiru Heights Apartments", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ruiru Heights Apartments", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit details" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Change status" })).toHaveCount(0);
  await page.getByRole("link", { name: "Sites", exact: true }).click();
  await expect(page.getByRole("link", { name: "Add site" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^View site\s*:\s*Main plot$/ })).toBeVisible();
  await page.getByRole("link", { name: "WBS & milestones", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add top-level item" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Mark achieved/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Team", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await page.goto(`/projects/${SYOKIMAU_ID}`);
  await expect(page.getByRole("heading", { name: "You do not have access" })).toBeVisible();
  await page.goto(`/projects/${RUIRU_ID}/sites/new`);
  await expect(page.getByRole("heading", { name: "You do not have access" })).toBeVisible();
});

test("assigns project permissions with step-up and edits the WBS and milestones", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto(`/projects/${RUIRU_ID}?tab=team`);
  await page.getByRole("button", { name: "Edit Brian Otieno's project permissions" }).click();
  await page.getByRole("checkbox", { name: /Record attendance/ }).check();
  await expect(page.getByText("Not in this member's role: no effect").first()).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Save permissions" }).click();
  const stepUp = page.getByRole("dialog", { name: "Confirm it is you" });
  await stepUp.getByLabel("Authenticator code").fill(MOCK_STEP_UP_CODE);
  await stepUp.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByText("Project permissions for Brian Otieno saved.")).toBeVisible();

  await page
    .getByLabel("Add a company member")
    .selectOption({ label: "Faith Achieng (Quantity surveyor)" });
  await page.getByRole("button", { name: "Choose permissions" }).click();
  await expect(page.getByRole("checkbox", { name: "Edit the BQ" })).toBeChecked();
  await page.getByRole("button", { name: "Save permissions" }).click();
  await expect(page.getByText("Project permissions for Faith Achieng saved.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Project members" }).getByRole("row")).toHaveCount(
    5,
  );

  await page.getByRole("link", { name: "WBS & milestones", exact: true }).click();
  await page.getByRole("button", { name: "Add top-level item" }).click();
  await page.getByLabel("Code").fill("5");
  await page.getByLabel("Name", { exact: true }).fill("Services");
  await page.getByLabel("Weight (%)").fill("10");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("1 group does not add up to 100%")).toBeVisible();
  await expect(page.getByText("These items add up to 110%, not 100%.")).toBeVisible();
  await page.getByRole("button", { name: "Move 5 up" }).click();
  await expect(page.getByText("Order saved.")).toBeVisible();

  await page.getByRole("button", { name: "Mark achieved: Roof covered" }).click();
  const achieve = page.getByRole("dialog", { name: "Mark achieved" });
  await expect(achieve.getByLabel("Date achieved")).not.toHaveValue("");
  await achieve.getByRole("button", { name: "Confirm" }).click();
  await expect(
    page.getByRole("table", { name: "Milestones" }).getByRole("row", { name: /Roof covered/ }),
  ).toContainText("Achieved");
});

for (const locale of ["en", "sw"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`live project pages are accessible in ${locale}, ${theme}`, async ({ page, context }) => {
      await signInAs(context, "owner");
      await preferences(context, page, locale, theme);
      for (const path of [
        "/projects",
        `/projects/${RUIRU_ID}`,
        `/projects/${RUIRU_ID}?tab=sites`,
        `/projects/${RUIRU_ID}?tab=team`,
        `/projects/${RUIRU_ID}?tab=wbs`,
        `/projects/${RUIRU_ID}/sites/new`,
        `/projects/${RUIRU_ID}/sites/${MAIN_PLOT_ID}`,
      ]) {
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await axeViolations(page), path).toEqual([]);
      }
    });
  }
}

test("live project pages fit a 360 px Android viewport", async ({ page, context }) => {
  await signInAs(context, "owner");
  await page.setViewportSize({ width: 360, height: 740 });
  for (const path of [
    "/projects",
    `/projects/${RUIRU_ID}`,
    `/projects/${RUIRU_ID}?tab=sites`,
    `/projects/${RUIRU_ID}?tab=team`,
    `/projects/${RUIRU_ID}?tab=wbs`,
    `/projects/${RUIRU_ID}/sites/new`,
    "/sign-in",
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading").first()).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      path,
    ).toBe(true);
  }
});
