import { expect, test, type Page } from "@playwright/test";
import {
  axeViolations,
  MAIN_PLOT_ID,
  MOCK_STEP_UP_CODE,
  preferences,
  RUIRU_ID,
  signInAs,
} from "./live-helpers";

/**
 * Live attendance and timesheet pages (D3.3 web slice) rendered from test/mock-api.mts and
 * test/mock-attendance.mts. The mock clock is Tuesday 10/11/2026: the week of 23/10 is approved,
 * the week of 30/10 is submitted by the project manager, and today's Main plot roll is submitted
 * by the site agent.
 */

const AMINA = "42000000-0000-4000-8000-000000000001";
const SAME_PERSON = "The same person cannot record and confirm (or ask for and approve) this.";
const muster = (date: string) =>
  `/attendance/muster?project=${RUIRU_ID}&site=${MAIN_PLOT_ID}&date=${date}`;

async function stepUp(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Authenticator code").fill(MOCK_STEP_UP_CODE);
  await dialog.getByRole("button", { name: "Verify and continue" }).click();
}

async function openPeriod(page: Page, label: string) {
  await page.goto(`/attendance/periods?project=${RUIRU_ID}`);
  await page.getByRole("link", { name: label }).click();
  await expect(page.getByRole("heading", { name: `Timesheet ${label}`, level: 1 })).toBeVisible();
}

test("shows today's muster rolls, the current period and the review queues", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/attendance");
  await expect(
    page.getByRole("heading", { name: "Attendance and timesheets", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(/Prototype: screens show mock data/)).toHaveCount(0);
  const ruiru = page.getByRole("region", { name: /Ruiru Heights Apartments/ });
  await expect(ruiru.getByRole("row", { name: /Main plot/ })).toContainText("Submitted");
  await expect(ruiru.getByRole("row", { name: /Materials yard/ })).toContainText("Not started");
  await expect(ruiru).toContainText("06/11/2026 – 12/11/2026");
  await expect(page.getByRole("region", { name: /Syokimau/ })).toContainText(
    "This project has no sites yet.",
  );
  expect(await axeViolations(page)).toEqual([]);

  await ruiru.getByRole("link", { name: "Record attendance at Main plot" }).click();
  await expect(page).toHaveURL(/\/attendance\/muster\?project=.*&date=2026-11-10/);
  await expect(page.getByRole("heading", { name: "Muster roll", level: 1 })).toBeVisible();
});

test("records a day with keyboard-friendly bulk entry, then refuses self-confirmation", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto(muster("2026-11-09"));
  const table = page.getByRole("table", { name: "Muster roll entries" });
  await expect(table.getByRole("row")).toHaveCount(6);
  await expect(table.getByRole("row", { name: /Oscar Mutai/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Mark 5 unrecorded workers present" }).click();
  await expect(table.getByLabel("In: Amina Wekesa Njoroge")).toHaveValue("07:00");
  await expect(table.getByLabel("Out: Amina Wekesa Njoroge")).toHaveValue("16:00");

  // Check-out before check-in without the overnight flag is refused before anything is sent.
  await table.getByLabel("Out: Joseph Mwangi Kariuki").fill("06:00");
  await page.getByRole("button", { name: "Save 5 changes" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Check the times for Joseph Mwangi Kariuki" }),
  ).toBeVisible();
  await table.getByLabel("Out: Joseph Mwangi Kariuki").fill("17:30");
  await table.getByLabel("Status: Peter Kiprotich Langat").selectOption("absent");
  const saved = page.waitForRequest(
    (request) => request.method() === "PUT" && request.url().includes("/muster"),
  );
  await table.getByLabel("Notes: Peter Kiprotich Langat").press("Enter");
  expect((await saved).headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByText("Saved 5 entries.")).toBeVisible();
  await expect(table.getByRole("row", { name: /Amina Wekesa/ })).toContainText("8:00");
  const joseph = table.getByRole("row", { name: /Joseph Mwangi/ });
  await expect(joseph).toContainText("9:30");
  await expect(joseph).toContainText("OT 1:30");
  await expect(table.getByRole("row", { name: /Mercy Chebet/ })).toContainText("Worker not active");
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("button", { name: "Submit the day" }).click();
  await expect(page.getByText("Day submitted for confirmation.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Day summary" })).toContainText("Submitted");
  await page.getByRole("button", { name: "Confirm the day" }).click();
  await expect(page.getByRole("alert").filter({ hasText: SAME_PERSON })).toBeVisible();
});

test("confirms another recorder's day and sends a correction for a distinct approver", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto(muster("2026-11-10"));
  await expect(page.getByText(/This day is submitted and waiting for confirmation/)).toBeVisible();
  await expect(page.getByText(/Submitted by Kevin Kiprono/)).toBeVisible();
  await page.getByRole("button", { name: "Confirm the day" }).click();
  await expect(page.getByText("Day confirmed.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Day summary" })).toContainText("Confirmed");

  await page
    .getByRole("button", { name: "Correct the attendance of Peter Kiprotich Langat" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Correct the attendance of Peter Kiprotich Langat",
  });
  await dialog.getByLabel("Status").selectOption("absent");
  const submit = dialog.getByRole("button", { name: "Ask for approval" });
  await dialog.getByLabel("Reason").fill("Too short");
  await expect(submit).toBeDisabled();
  await dialog.getByLabel("Reason").fill("Left at 08:00 after a family emergency (synthetic).");
  expect(await axeViolations(page)).toEqual([]);
  await submit.click();
  await stepUp(page);
  await expect(page.getByText("Correction sent for approval.")).toBeVisible();
  const corrections = page.getByRole("region", { name: "Corrections" });
  await expect(corrections).toContainText("Present 07:20–16:00 → Absent");
  await expect(corrections).toContainText("Asked by Wanjiru Kamau");
  await corrections.getByRole("button", { name: "Approve correction" }).click();
  await expect(page.getByRole("alert").filter({ hasText: SAME_PERSON })).toBeVisible();
});

test("approves a submitted period into an immutable snapshot", async ({ page, context }) => {
  await signInAs(context, "owner");
  await page.goto(`/attendance/periods?project=${RUIRU_ID}`);
  const periods = page.getByRole("table", {
    name: "Timesheet periods of Ruiru Heights Apartments",
  });
  await expect(periods.getByRole("row", { name: /30\/10\/2026/ })).toContainText("Submitted");
  await expect(periods.getByRole("row", { name: /23\/10\/2026/ })).toContainText("Approved");
  expect(await axeViolations(page)).toEqual([]);

  await openPeriod(page, "30/10/2026 – 05/11/2026");
  await expect(page.getByText("Live totals")).toBeVisible();
  const lines = page.getByRole("table", { name: "Timesheet totals per worker" });
  const joseph = lines.getByRole("row", { name: /Joseph Mwangi/ });
  // 06:50–17:30 less the 1 h default break = 9:40 a day: 8:00 normal and 1:40 overtime.
  await expect(joseph.getByRole("cell").nth(1)).toHaveText("2");
  await expect(joseph.getByRole("cell").nth(2)).toHaveText("19:20");
  await expect(joseph.getByRole("cell").nth(4)).toHaveText("3:20");
  await expect(
    lines
      .getByRole("row", { name: /Peter Kiprotich/ })
      .getByRole("cell")
      .nth(8),
  ).toHaveText("2");
  await expect(page.getByText(/not compliance-approved yet/)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("button", { name: "Approve and lock" }).click();
  await expect(page.getByText("Period approved and locked.")).toBeVisible();
  await expect(page.getByText("Approved snapshot")).toBeVisible();
  await expect(page.getByText(/Approved by Wanjiru Kamau/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Request an adjustment" })).toBeVisible();
});

test("rejects a submitted period with a reason and reopens it", async ({ page, context }) => {
  await signInAs(context, "owner");
  await openPeriod(page, "30/10/2026 – 05/11/2026");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reject the period" });
  await dialog
    .getByLabel("Reason")
    .fill("Joseph's Wednesday hours need the gate book (synthetic).");
  await dialog.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("Period rejected.")).toBeVisible();
  await expect(page.getByText(/Rejected by Wanjiru Kamau: Joseph/)).toBeVisible();
  await page.getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByText("Period reopened.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Period status" })).toContainText("Open");
});

test("decides adjustments to an approved period with distinct people", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await openPeriod(page, "23/10/2026 – 29/10/2026");
  await expect(page.getByText("Approved snapshot")).toBeVisible();
  const adjustments = page.getByRole("region", { name: "Adjustments" });
  const peter = adjustments.getByRole("listitem").filter({ hasText: "Peter Kiprotich Langat" });
  await expect(peter).toContainText("Pending");
  await expect(peter).toContainText("Asked by Brian Otieno");
  await peter.getByRole("button", { name: "Approve adjustment" }).click();
  await expect(page.getByText("Adjustment approved.")).toBeVisible();
  await expect(peter).toContainText("Approved");
  await expect(peter).toContainText("Change: 1 days, 8:00 h worked");

  await page.getByRole("button", { name: "Request an adjustment" }).click();
  const dialog = page.getByRole("dialog", { name: "Request an adjustment" });
  await dialog.getByLabel("Worker").selectOption({ label: "Amina Wekesa Njoroge (WRK-0001)" });
  await dialog.getByLabel("Date").selectOption({ label: "28/10/2026" });
  await dialog.getByLabel("Out").fill("18:00");
  await dialog.getByLabel("Reason").fill("Stayed to cure the slab; supervisor's note (synthetic).");
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Ask for approval" }).click();
  await stepUp(page);
  await expect(page.getByText("Adjustment sent for approval.")).toBeVisible();
  const amina = adjustments.getByRole("listitem").filter({ hasText: "Amina Wekesa Njoroge" });
  await expect(amina).toContainText("Asked by Wanjiru Kamau");
  await amina.getByRole("button", { name: "Approve adjustment" }).click();
  await expect(page.getByRole("alert").filter({ hasText: SAME_PERSON })).toBeVisible();

  // The approved adjustment lands in the open period as a separate line.
  await peter.getByRole("link", { name: "Lands in a later period" }).click();
  await expect(
    page.getByRole("heading", { name: "Timesheet 06/11/2026 – 12/11/2026", level: 1 }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "Timesheet totals per worker" })
      .getByRole("row", { name: /Peter Kiprotich Langat.*adjustment/ }),
  ).toContainText("8:00");
});

test("reviews anomalies with a note and keeps the history", async ({ page, context }) => {
  await signInAs(context, "owner");
  await page.goto("/attendance/anomalies");
  await expect(page.getByRole("heading", { name: "Anomaly review", level: 1 })).toBeVisible();
  const table = page.getByRole("table", { name: "Anomaly review" });
  await expect(table.getByRole("row", { name: /Two sites the same day/ }).first()).toContainText(
    "Recorded at 2 sites that day",
  );
  const excess = table.getByRole("row", { name: /Hours above the maximum/ });
  await expect(excess).toContainText("14:00 h worked; maximum 12:00 h");
  expect(await axeViolations(page)).toEqual([]);

  await excess.getByRole("button", { name: /^Review Hours above the maximum for Joseph/ }).click();
  const dialog = page.getByRole("dialog", { name: "Review the anomaly of Joseph Mwangi Kariuki" });
  await dialog.getByLabel("Decision").selectOption("resolve");
  await dialog.getByLabel("Reason").fill("Slab pour confirmed with the site diary (synthetic).");
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Resolve" }).click();
  await expect(table.getByRole("row", { name: /Hours above the maximum/ })).toHaveCount(0);

  await page.getByLabel("Status").selectOption("all");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page).toHaveURL(/status=all/);
  const resolved = table.getByRole("row", { name: /Hours above the maximum/ });
  await expect(resolved).toContainText("Resolved");
  await expect(resolved).toContainText("Slab pour confirmed with the site diary (synthetic).");
});

test("configures effective-dated rules, the cut-off and the holiday calendar", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/attendance/settings");
  await expect(
    page.getByRole("heading", { name: "Timesheet rules and holidays", level: 1 }),
  ).toBeVisible();
  const rules = page.getByRole("table", { name: "Timesheet rules" });
  const company = rules.getByRole("row", { name: /Company default/ });
  await expect(company).toContainText("In force");
  await expect(company).toContainText("Unverified (compliance review)");
  await expect(company).toContainText("×1.50 weekday · ×2.00 rest day · ×2.00 holiday");
  await expect(page.getByRole("table", { name: "2026" })).toContainText("Mazingira Day");
  await expect(page.getByRole("table", { name: "2027" })).toContainText("General election day");
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("button", { name: "Add a rule version" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a timesheet rule version" });
  await dialog
    .getByLabel("Applies to")
    .selectOption({ label: "RUI-HTS · Ruiru Heights Apartments" });
  await dialog.getByLabel("Effective from (DD/MM/YYYY)").fill("01/12/2026");
  await dialog.getByLabel("Normal day (minutes)").fill("540");
  await dialog.getByLabel("Source").fill("Synthetic site agreement, clause 4");
  await dialog.getByRole("button", { name: "Add rule version" }).click();
  const override = rules.getByRole("row", { name: /RUI-HTS/ });
  await expect(override).toContainText("Scheduled");
  await expect(override).toContainText("Normal 9:00 h");
  await override.getByRole("button", { name: "Cancel version" }).click();
  await page
    .getByRole("dialog", { name: "Cancel this scheduled rule version?" })
    .getByRole("button", { name: "Cancel version" })
    .click();
  await expect(rules.getByRole("row", { name: /RUI-HTS/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Add a holiday" }).click();
  const holiday = page.getByRole("dialog", { name: "Add a public holiday" });
  await holiday.getByLabel("Date").fill("10/03/2027");
  await holiday.getByLabel("Name in English").fill("Idd-ul-Fitr");
  await holiday.getByLabel("Name in Kiswahili").fill("Idd-ul-Fitr");
  await holiday.getByLabel("Source").fill("Kenya Gazette notice (synthetic test)");
  await holiday.getByRole("button", { name: "Add holiday" }).click();
  await expect(page.getByRole("table", { name: "2027" })).toContainText("10/03/2027");

  await page.getByLabel("Cut-off time").fill("17:00");
  await page.getByRole("button", { name: "Save periods" }).click();
  await expect(page.getByText("Saved. Existing periods keep their dates.")).toBeVisible();
  await expect(page.getByText(/Periods end on Thursday with a 17:00 cut-off/)).toBeVisible();
});

test("shows a worker's attendance totals in the labour panel", async ({ page, context }) => {
  await signInAs(context, "owner");
  await page.goto(`/labour?worker=${AMINA}`);
  const panel = page.getByRole("dialog", { name: "Amina Wekesa Njoroge" });
  const attendance = panel.getByRole("region", { name: "Attendance" });
  await expect(attendance).toContainText("RUI-HTS");
  await expect(attendance).toContainText("2 days · 16:00 h · OT 0:00 h");
  await expect(attendance).toContainText("4 days · 32:05 h · OT 0:05 h");
  await expect(attendance).toContainText("10/11/2026");
  expect(await axeViolations(page)).toEqual([]);
});

test("keeps site agents to recording and confirming other people's days", async ({
  page,
  context,
}) => {
  await signInAs(context, "agent");
  await page.goto("/attendance");
  await expect(page.getByRole("region", { name: /Ruiru Heights/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /Syokimau/ })).toHaveCount(0);

  await page.goto(muster("2026-11-10"));
  await page.getByRole("button", { name: "Confirm the day" }).click();
  await expect(page.getByRole("alert").filter({ hasText: SAME_PERSON })).toBeVisible();
  await expect(page.getByRole("button", { name: /Correct the attendance/ })).toHaveCount(0);

  await page.goto("/attendance/anomalies");
  await expect(page.getByRole("table", { name: "Anomaly review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review" })).toHaveCount(0);

  await page.goto("/attendance/settings");
  await expect(page.getByRole("table", { name: "Timesheet rules" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a rule version" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add a holiday" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save periods" })).toHaveCount(0);
});

const pages = [
  "/attendance",
  muster("2026-11-10"),
  muster("2026-11-09"),
  `/attendance/periods?project=${RUIRU_ID}`,
  "period",
  "/attendance/anomalies",
  "/attendance/settings",
];

async function visit(page: Page, path: string) {
  if (path !== "period") return page.goto(path);
  await page.goto(`/attendance/periods?project=${RUIRU_ID}`);
  await page.getByRole("link", { name: "23/10/2026 – 29/10/2026" }).click();
  await expect(page).toHaveURL(/\/attendance\/periods\/[0-9a-f-]{36}$/);
}

for (const locale of ["en", "sw"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`attendance pages are accessible in ${locale}, ${theme}`, async ({ page, context }) => {
      await signInAs(context, "owner");
      await preferences(context, page, locale, theme);
      for (const path of pages) {
        await visit(page, path);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await axeViolations(page), path).toEqual([]);
      }
    });
  }
}

test("attendance pages fit a 360 px Android viewport", async ({ page, context }) => {
  await signInAs(context, "owner");
  await page.setViewportSize({ width: 360, height: 740 });
  for (const path of pages) {
    await visit(page, path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      path,
    ).toBe(true);
  }
});
