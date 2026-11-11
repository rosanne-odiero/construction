import { expect, test, type Page } from "@playwright/test";
import { axeViolations, preferences, RUIRU_ID, signInAs } from "./live-helpers";

/** The project Photos tab against test/mock-api.mts; thumbnails are served by a route stub. */
const THUMBNAIL = Buffer.from(
  "/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAGAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgT/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCgClf/2Q==",
  "base64",
);

async function stubThumbnails(page: Page) {
  await page.route("**/api/v1/projects/*/photos/*/thumbnail", (route) =>
    route.fulfill({ status: 200, contentType: "image/jpeg", body: THUMBNAIL }),
  );
}

test("shows verified and unverified photos with their reasons, and uploads a new one", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await stubThumbnails(page);
  await page.goto(`/projects/${RUIRU_ID}`);
  await page
    .getByRole("navigation", { name: "Project sections" })
    .getByRole("link", { name: "Photos", exact: true })
    .click();
  await expect(page).toHaveURL(`/projects/${RUIRU_ID}?tab=photos`);
  await expect(page.getByRole("heading", { name: "Site photos" })).toBeVisible();
  await expect(page.getByText(/treat it as evidence for review, not proof/)).toBeVisible();

  const verified = page.getByRole("article", { name: "Synthetic: first-floor columns" });
  await expect(verified.getByText("Verified", { exact: true })).toBeVisible();
  await expect(verified).toContainText("Taken inside Main plot (geofence version 1)");
  await expect(
    verified.getByRole("img", { name: "Synthetic: first-floor columns" }),
  ).toHaveAttribute("src", new RegExp(`/api/v1/projects/${RUIRU_ID}/photos/[0-9a-f-]+/thumbnail$`));
  const outside = page.getByRole("article", { name: "Synthetic: delivery at the gate" });
  await expect(outside.getByText("Not verified")).toBeVisible();
  await expect(outside).toContainText("Taken 176 m outside Main plot");
  await expect(outside).toContainText("(time zone assumed: Nairobi)");
  expect(await axeViolations(page)).toEqual([]);

  await expect(page.getByLabel("Attach to my draft diary")).toContainText("25/10/2026");
  await page.getByRole("button", { name: "Upload photo" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Choose a photo" })).toBeVisible();
  await page.getByLabel("Photo (JPEG)").setInputFiles({
    name: "IMG_2041.jpg",
    mimeType: "image/jpeg",
    buffer: THUMBNAIL,
  });
  await page.getByLabel("Caption (optional)").fill("Browser test: ring beam");
  await page.getByRole("button", { name: "Upload photo" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Photo uploaded and verified." }),
  ).toBeVisible();
  await expect(page.getByRole("article", { name: "Browser test: ring beam" })).toBeVisible();

  await page.getByLabel("Photo (JPEG)").setInputFiles({
    name: "duplicate.jpg",
    mimeType: "image/jpeg",
    buffer: THUMBNAIL,
  });
  await page.getByRole("button", { name: "Upload photo" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already been uploaded" })).toBeVisible();

  await page.getByLabel("Photo (JPEG)").setInputFiles({
    name: "outside.jpg",
    mimeType: "image/jpeg",
    buffer: THUMBNAIL,
  });
  await page.getByRole("button", { name: "Upload photo" }).click();
  await expect(page.getByRole("status").filter({ hasText: "could not be verified" })).toBeVisible();
});

test("photos work in Kiswahili on a small phone without horizontal scrolling", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await stubThumbnails(page);
  await preferences(context, page, "sw", "dark");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/projects/${RUIRU_ID}?tab=photos`);
  await expect(page.getByRole("heading", { name: "Picha za eneo" })).toBeVisible();
  await expect(page.getByText("Imethibitishwa", { exact: true })).toBeVisible();
  await expect(page.getByText("Haijathibitishwa")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(await axeViolations(page)).toEqual([]);
});
