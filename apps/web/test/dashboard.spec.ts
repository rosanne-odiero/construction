import { expect, test, type Page } from "@playwright/test";
import { axeViolations, preferences, signInAs } from "./live-helpers";

/**
 * D8.1 owner dashboard against test/mock-api.mts (mock-reports.mts gates each section with the
 * API's permission sets): live sections with table alternatives, sections a role may not see
 * omitted rather than zeroed, undefined ratios shown as unavailable, Kiswahili and 360 px.
 */
const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("the owner sees live company figures with table alternatives", async ({ page, context }) => {
  await signInAs(context, "owner");
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Good day, Wanjiru", level: 1 })).toBeVisible();

  const attention = page.getByRole("region", { name: "Needs attention" });
  await expect(attention).toContainText("2 supplier invoices overdue (KES 812,000)");
  await expect(attention).toContainText("1 open incident");
  await expect(attention).toContainText("1 material below the reorder level");

  const projects = page.getByRole("region", { name: "Projects", exact: true }).first();
  await expect(projects.getByRole("row").filter({ hasText: "RUI-HTS" })).toContainText("21.4 %");
  // No contract sum: the certified share is undefined, not zero.
  await expect(projects.getByRole("row").filter({ hasText: "SYO-TWN" })).toContainText("—");

  const spending = page.getByRole("region", { name: "Budget, committed and actual" }).first();
  await expect(spending.getByRole("row").filter({ hasText: "SYO-TWN" })).toContainText(
    "Unavailable",
  );
  await expect(spending.getByRole("row").filter({ hasText: "RUI-HTS" })).toContainText("85.4 %");
  // The forecast chart has a table alternative.
  await expect(page.getByRole("heading", { name: "Cash-flow forecast (company)" })).toBeVisible();
  await expect(page.getByText("Present today")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await expect(async () => {
    await page.getByRole("main").getByRole("link", { name: "Reports" }).click();
    await expect(page).toHaveURL(/\/reports$/, { timeout: 2_000 });
  }).toPass();
});

test("a site agent sees only their sections: money is omitted, not zeroed", async ({
  page,
  context,
}) => {
  await signInAs(context, "agent");
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Good day, Kevin", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Projects", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Needs attention" })).toContainText(
    "1 overdue corrective action",
  );
  for (const hidden of [
    "Budget, committed and actual",
    "Cash-flow forecast (company)",
    "Attendance today",
  ])
    await expect(page.getByRole("heading", { name: hidden })).toHaveCount(0);
  await expect(page.getByText("Certified to date")).toHaveCount(0);
  await expect(page.getByText(/supplier invoices? overdue/)).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
});

test("a project manager sees the assigned project's figures but no company forecast", async ({
  page,
  context,
}) => {
  await signInAs(context, "pm");
  await page.goto("/dashboard");
  const spending = page.getByRole("region", { name: "Budget, committed and actual" }).first();
  await expect(spending.getByRole("row").filter({ hasText: "RUI-HTS" })).toBeVisible();
  await expect(spending.getByRole("row").filter({ hasText: "SYO-TWN" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Cash-flow forecast (company)" })).toHaveCount(0);
});

test("works in Kiswahili and dark mode on a 360 px phone", async ({ page, context }) => {
  await preferences(context, page, "sw", "dark");
  await signInAs(context, "owner");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Habari, Wanjiru", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Yanahitaji umakini" })).toBeVisible();
  await expect(page.getByText("Haipatikani").first()).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
});
