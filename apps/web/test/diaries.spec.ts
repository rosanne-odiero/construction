import { expect, test } from "@playwright/test";
import { axeViolations, preferences, RUIRU_ID, signInAs } from "./live-helpers";

test("records and edits a manual diary, submits and independently locks a submitted record", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/diary");
  await expect(page.getByRole("heading", { name: "Site diary", level: 1 })).toBeVisible();
  await expect(page.getByText(/Prototype: screens show mock data/)).toHaveCount(0);
  await page.locator(`a[href="/projects/${RUIRU_ID}?tab=diary"]`).click();
  await page
    .getByRole("navigation", { name: "Project sections" })
    .getByRole("link", { name: "Site diary", exact: true })
    .click();
  await expect(page.getByText(/Workforce comes from attendance/)).toBeVisible();
  await page.getByRole("button", { name: "New diary", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Date (DD/MM/YYYY, Nairobi)", { exact: true }).fill("01/10/2026");
  await dialog.getByLabel("Work performed").fill("Browser fixture: trench excavation");
  await dialog.getByRole("radio", { name: "Typed in" }).check();
  await dialog.getByRole("button", { name: "Save draft" }).click();
  await expect(dialog).toHaveCount(0);
  const entry = page.getByRole("article").filter({ hasText: "Browser fixture: trench excavation" });
  await expect(entry).toContainText("Not recorded");
  await entry.getByRole("button", { name: "Edit draft" }).click();
  await dialog.getByLabel("Workforce count", { exact: true }).fill(" 0 ");
  await dialog.getByRole("button", { name: "Save draft" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(entry.getByText("0 (typed in)", { exact: true })).toBeVisible();
  await entry.getByRole("button", { name: "Submit for review" }).click();
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(entry).toContainText("Awaiting review");
  await expect(entry.getByRole("button")).toHaveCount(0);
  const submitted = page.getByRole("article").filter({ hasText: "Synthetic submitted: walling" });
  await submitted.getByRole("button", { name: "Approve and lock" }).click();
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(submitted).toContainText("Approved · locked");
  await expect(submitted.getByRole("button")).toHaveCount(0);
  await page.reload();
  await expect(submitted).toContainText("Approved · locked");
  expect(await axeViolations(page)).toEqual([]);
});

test("shows rejection reasons, handles conflicts, and refuses malformed successes", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto(`/projects/${RUIRU_ID}?tab=diary`);
  const submitted = page.getByRole("article").filter({ hasText: "Synthetic submitted: walling" });
  await submitted.getByRole("button", { name: "Reject", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Rejection reason (3–500 characters)", { exact: true })
    .fill("Include the inspection result");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(submitted).toContainText("Reviewer: Include the inspection result");

  const draft = page.getByRole("article").filter({ hasText: "Synthetic draft: slab curing" });
  await draft.getByRole("button", { name: "Edit draft" }).click();
  await page.route("**/api/v1/projects/*/diaries/*", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "version-conflict" }),
    }),
  );
  await dialog.getByRole("button", { name: "Save draft" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.unroute("**/api/v1/projects/*/diaries/*");
  await page.route("**/api/v1/projects/*/diaries/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ diary: { status: "approved" } }),
    }),
  );
  await dialog.getByRole("button", { name: "Save draft" }).click();
  await expect(dialog.getByRole("alert")).toContainText(/unexpected|invalid|response/i);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(draft).toContainText("Draft");
});

test("diary supports Kiswahili and a narrow viewport without horizontal scrolling", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await preferences(context, page, "sw", "dark");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/projects/${RUIRU_ID}?tab=diary`);
  await expect(page.getByRole("heading", { name: "Shajara ya eneo" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Shajara mpya" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("takes the workforce from attendance by trade, with its provenance, and refreshes it on submission", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto(`/projects/${RUIRU_ID}?tab=diary`);
  await page.getByRole("button", { name: "New diary", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Date (DD/MM/YYYY, Nairobi)", { exact: true }).fill("02/10/2026");
  await dialog.getByLabel("Work performed").fill("Browser fixture: blockwork to gridline C");
  await expect(dialog.getByRole("radio", { name: "From attendance" })).toBeChecked();
  await dialog.getByRole("button", { name: "Show attendance for this day" }).click();
  const offer = dialog.getByRole("status");
  await expect(offer).toContainText("9 people on site from attendance (muster submitted).");
  await expect(offer).toContainText("Mason: 5 (1 half day)");
  await expect(offer).toContainText("General labourer: 4");
  await dialog.getByRole("button", { name: "Save draft" }).click();
  await expect(dialog).toHaveCount(0);
  const entry = page.getByRole("article").filter({ hasText: "Browser fixture: blockwork" });
  await expect(entry).toContainText("9 from attendance");
  await expect(entry).toContainText("Mason: 5 (1 half day)");
  await expect(entry).toContainText(/Snapshot: muster submitted, \d{2}\/\d{2}\/\d{4}/);
  await entry.getByRole("button", { name: "Submit for review" }).click();
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(entry).toContainText("Awaiting review");
  await expect(entry).toContainText("9 from attendance");
  expect(await axeViolations(page)).toEqual([]);
});
