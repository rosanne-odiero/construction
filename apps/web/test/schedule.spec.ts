import { expect, test, type Page } from "@playwright/test";
import { axeViolations, preferences, RUIRU_ID, signInAs } from "./live-helpers";

/**
 * D6.2 schedule against test/mock-api.mts (mock-schedule.mts computes with the shared CPM engine
 * and a fixed data date of 10/11/2026): the Gantt chart and its keyboard-operable item list, the
 * activity editor and dependencies, a frozen baseline with variance, and the delay log.
 */
const scheduleUrl = (view?: "baselines" | "delays") =>
  `/projects/${RUIRU_ID}?tab=schedule${view ? `&view=${view}` : ""}`;

const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("shows the Gantt chart with the critical path, baseline and keyboard-operable items", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto(`/projects/${RUIRU_ID}`);
  await page
    .getByRole("navigation", { name: "Project sections" })
    .getByRole("link", { name: "Schedule", exact: true })
    .click();
  await expect(page).toHaveURL(scheduleUrl());
  await expect(page.getByRole("heading", { name: "Schedule", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Gantt chart" })).toBeVisible();
  // The project's finish is 130 working days behind the contract programme.
  await expect(page.getByText("130 working days late").first()).toBeVisible();
  await expect(page.getByText("Baseline 1: Contract programme")).toBeVisible();

  const chart = page.getByRole("region", { name: "Gantt chart, scrolls sideways" });
  await expect(chart).toHaveAttribute("tabindex", "0");
  await expect(chart.locator("svg")).toHaveAttribute("aria-hidden", "true");
  // Eight activities and two milestones; the critical path and milestones are drawn.
  const items = page.getByRole("list", { name: "Schedule items" }).getByRole("button");
  await expect(items).toHaveCount(10);
  await expect(chart.locator('svg [data-kind="bar"]')).toHaveCount(8);
  await expect(chart.locator('svg [data-kind="bar"][data-critical="true"]')).toHaveCount(3);
  await expect(chart.locator('svg [data-kind="milestone"]')).toHaveCount(2);
  await expect(chart.locator('svg [data-kind="baseline"]')).toHaveCount(10);
  await expect(chart.locator('svg [data-kind="link"]')).toHaveCount(9);
  await expect(chart.locator('svg [data-kind="link"][data-critical="true"]')).toHaveCount(2);
  await expect(chart.locator('svg [data-kind="today"]')).toHaveCount(1);

  await items.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await expect(page.getByText("Planned 16/03/2026 – 08/04/2026")).toBeVisible();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await expect(items.last()).toHaveAttribute("aria-current", "true");

  const table = page.getByRole("region", { name: "Schedule table, scrolls sideways" });
  const excavation = table.getByRole("row", { name: /A20 Excavation/ });
  await expect(excavation).toContainText("16/03/2026 – 08/04/2026");
  await expect(excavation).toContainText("6 working days late");
  const columns = table.getByRole("row", { name: /A50 Ground floor columns/ });
  await expect(columns).toContainText("Critical");
  await expect(columns).toContainText("80% (physical estimate)");
  await page.getByRole("button", { name: "Months" }).click();
  await expect(page.getByRole("button", { name: "Months" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await axeViolations(page)).toEqual([]);
});

test("adds an activity and links, refuses a loop, records progress and keeps a conflicted form", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto(scheduleUrl());
  await page.getByRole("button", { name: "Add activity" }).click();
  let dialog = page.getByRole("dialog", { name: "New activity" });
  await dialog.getByLabel("Code").fill("A90");
  await dialog.getByLabel("Name").fill("Snagging and handover");
  await dialog.getByLabel("Duration (working days)").fill("6");
  await dialog.getByRole("button", { name: "Save activity" }).click();
  await expect(dialog).toHaveCount(0);
  const table = page.getByRole("region", { name: "Schedule table, scrolls sideways" });
  await expect(table.getByRole("row", { name: /A90 Snagging and handover/ })).toBeVisible();

  const links = page.locator("form").filter({ hasText: "Add a dependency" });
  await links.getByLabel("Predecessor").selectOption({ label: "A80 Finishes" });
  await links.getByLabel("Successor").selectOption({ label: "A90 Snagging and handover" });
  await links.getByRole("button", { name: "Add dependency" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Dependency added." })).toBeVisible();
  await expect(table.getByRole("row", { name: /A90 Snagging/ })).toContainText("Critical");

  await links.getByLabel("Predecessor").selectOption({ label: "A90 Snagging and handover" });
  await links.getByLabel("Successor").selectOption({ label: "A10 Site establishment" });
  await links.getByRole("button", { name: "Add dependency" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "This dependency would make a loop" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Record progress for Snagging and handover" }).click();
  dialog = page.getByRole("dialog", { name: "Progress: Snagging and handover" });
  await dialog.getByLabel("Actual start").fill("09/11/2026");
  await dialog.getByLabel("Percent complete").fill("100");
  await dialog.getByRole("button", { name: "Save progress" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "complete exactly when it has an actual finish",
  );
  await dialog.getByLabel("Percent complete").fill("50");
  await dialog.getByRole("button", { name: "Save progress" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(table.getByRole("row", { name: /A90 Snagging/ })).toContainText(
    "50% (physical estimate)",
  );

  await page.getByRole("button", { name: "Edit Finishes" }).click();
  dialog = page.getByRole("dialog", { name: "Edit Finishes" });
  await page.route("**/api/v1/projects/*/schedule/activities/*", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 409,
          contentType: "application/problem+json",
          body: JSON.stringify({ code: "version-conflict" }),
        })
      : route.fallback(),
  );
  await dialog.getByLabel("Duration (working days)").fill("45");
  await dialog.getByRole("button", { name: "Save activity" }).click();
  await expect(dialog.getByRole("alert")).toContainText("changed this record");
  await expect(dialog.getByLabel("Duration (working days)")).toHaveValue("45");
  expect(await axeViolations(page)).toEqual([]);
});

test("re-baselines with a reason and shows variance against any baseline", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto(scheduleUrl("baselines"));
  const list = page.getByRole("region", { name: "Baselines, scrolls sideways" });
  const first = list.getByRole("row", { name: /1\. Contract programme/ });
  await expect(first).toContainText("Current");
  await expect(first).toContainText("Agreed with the client at the site handover meeting");
  const variance = page.getByRole("region", { name: "Variance table, scrolls sideways" });
  await expect(variance.getByRole("row", { name: /A20 Excavation/ })).toContainText(
    "6 working days late",
  );
  expect(await axeViolations(page)).toEqual([]);

  await page.getByLabel("Name").fill("Revised programme");
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Extension of time agreed after the long rains");
  await page.getByRole("button", { name: "Re-baseline" }).click();
  const confirm = page.getByRole("dialog", { name: "Freeze this baseline?" });
  await expect(confirm).toContainText("cannot be undone or edited");
  await confirm.getByRole("button", { name: "Freeze" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Baseline frozen. It is now the current baseline." }),
  ).toBeVisible();
  await expect(list.getByRole("row", { name: /2\. Revised programme/ })).toContainText("Current");
  await expect(first).not.toContainText("Current");
  await expect(variance.getByRole("row", { name: /A20 Excavation/ })).toContainText("On baseline");

  await first.getByRole("link", { name: "Compare with baseline 1" }).click();
  await expect(page).toHaveURL(/view=baselines&baseline=/);
  await expect(variance.getByRole("row", { name: /A20 Excavation/ })).toContainText(
    "6 working days late",
  );
  await expect(list.getByRole("row", { name: /1\. Contract programme/ })).toContainText(
    "Compared below",
  );
});

test("records, amends and withdraws delays with their history", async ({ page, context }) => {
  await signInAs(context, "owner");
  await page.goto(scheduleUrl("delays"));
  await expect(page.getByRole("heading", { name: "Delay log" })).toBeVisible();
  await expect(page.getByRole("article", { name: "DLY-001 Weather" })).toContainText(
    "4.5 of 6 working days in the period",
  );

  await page.getByRole("button", { name: "Record delay" }).click();
  let dialog = page.getByRole("dialog", { name: "Record a delay" });
  await dialog.getByLabel("Cause").selectOption({ label: "Supplier or material" });
  await dialog.getByLabel("Start date").fill("02/11/2026");
  await dialog.getByLabel("End date").fill("04/11/2026");
  await dialog.getByLabel("Working days lost").fill("9");
  await dialog.getByLabel("What happened").fill("Browser test: Y12 steel delivered late");
  await dialog.getByLabel("A50 Ground floor columns and walls").check();
  await dialog
    .getByLabel("Claim position")
    .selectOption({ label: "Excusable: may support an extension of time" });
  await dialog.getByRole("button", { name: "Save delay" }).click();
  await expect(dialog.getByRole("alert")).toContainText("exceed the working days in the period");
  await dialog.getByLabel("Working days lost").fill("2.5");
  await dialog.getByRole("button", { name: "Save delay" }).click();
  await expect(dialog).toHaveCount(0);
  const delay = page.getByRole("article", { name: "DLY-002 Supplier or material" });
  await expect(delay).toContainText("2.5 of 3 working days in the period");
  await expect(delay).toContainText("A50");
  await expect(delay).toContainText("Excusable: may support an extension of time");

  await delay.getByRole("button", { name: "Amend" }).click();
  dialog = page.getByRole("dialog", { name: "Amend DLY-002" });
  await dialog.getByLabel("Working days lost").fill("2");
  await dialog.getByLabel("Reason for the change").fill("Site agent confirmed half a day worked");
  await dialog.getByRole("button", { name: "Save delay" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(delay).toContainText(
    "Reason for this version: Site agent confirmed half a day worked",
  );
  await delay.getByRole("button", { name: "History" }).click();
  dialog = page.getByRole("dialog", { name: "History of DLY-002" });
  await expect(dialog.getByRole("listitem")).toHaveCount(2);
  await expect(dialog.getByRole("listitem").first()).toContainText("Version 2 · Recorded");
  await page.keyboard.press("Escape");

  const weather = page.getByRole("article", { name: "DLY-001 Weather" });
  await weather.getByRole("button", { name: "Withdraw" }).click();
  dialog = page.getByRole("dialog", { name: "Withdraw DLY-001?" });
  await dialog.getByLabel("Reason for the change").fill("Recorded against the wrong project");
  await dialog.getByRole("button", { name: "Withdraw" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(weather).toContainText("Withdrawn");
  await expect(weather.getByRole("button", { name: "Amend" })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
});

test("is read-only without the project-manage permission", async ({ page, context }) => {
  await signInAs(context, "agent");
  await page.goto(scheduleUrl());
  await expect(page.getByText(/You can view the schedule\./)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add activity" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Edit / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add dependency" })).toHaveCount(0);
  await page.goto(scheduleUrl("baselines"));
  await expect(page.getByRole("button", { name: "Re-baseline" })).toHaveCount(0);
  await page.goto(scheduleUrl("delays"));
  await expect(page.getByRole("button", { name: "Record delay" })).toHaveCount(0);
});

test("works in Kiswahili, dark, at 360 px without sideways page scrolling", async ({
  page,
  context,
}) => {
  test.slow();
  await signInAs(context, "owner");
  await preferences(context, page, "sw", "dark");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(scheduleUrl());
  await expect(page.getByRole("heading", { name: "Ratiba", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chati ya Gantt" })).toBeVisible();
  const chart = page.getByRole("region", { name: "Chati ya Gantt, husogea kando" });
  // The chart is wider than the phone and scrolls inside its own region, not the page.
  expect(await chart.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  await page.goto(scheduleUrl("baselines"));
  await expect(page.getByRole("heading", { name: "Tofauti dhidi ya msingi" })).toBeVisible();
  await expect(page.getByText("Imechelewa siku 6 za kazi").first()).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  await page.goto(scheduleUrl("delays"));
  await expect(page.getByRole("heading", { name: "Daftari la ucheleweshaji" })).toBeVisible();
  await page.getByRole("button", { name: "Rekodi ucheleweshaji" }).click();
  await expect(page.getByRole("dialog", { name: "Rekodi ucheleweshaji" })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
});
