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

test("shows each photo's checks and imports files, which are never verified", async ({
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
  await expect(
    page.getByText(/treat “verified” as strong evidence for review, not proof/),
  ).toBeVisible();

  const verified = page.getByRole("article", { name: "Synthetic: first-floor columns" });
  await expect(verified.getByText("Verified", { exact: true })).toBeVisible();
  await expect(verified).toContainText("Taken with the PM-Buddy camera");
  await expect(verified).toContainText("Taken inside Main plot (geofence version 1)");
  await expect(
    verified.getByRole("img", { name: "Synthetic: first-floor columns" }),
  ).toHaveAttribute("src", new RegExp(`/api/v1/projects/${RUIRU_ID}/photos/[0-9a-f-]+/thumbnail$`));
  const outside = page.getByRole("article", { name: "Synthetic: delivery at the gate" });
  await expect(outside.getByText("Not verified")).toBeVisible();
  await expect(outside).toContainText("Imported from a file");
  await expect(outside).toContainText("Taken 176 m outside Main plot");
  await expect(outside).toContainText("(time zone assumed: Nairobi)");
  const reused = page.getByRole("article", { name: "Synthetic: slab formwork" });
  await expect(reused.getByText("Not verified")).toBeVisible();
  await expect(reused).toContainText("Looks like an earlier photo from another project");
  expect(await axeViolations(page)).toEqual([]);

  await expect(page.getByLabel("Attach to my draft diary")).toContainText("25/10/2026");
  await expect(page.getByLabel("Photo file (JPEG or HEIC)")).toHaveAttribute(
    "accept",
    /image\/heic/,
  );
  await page.getByRole("button", { name: "Import photo" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Choose a photo to import" }),
  ).toBeVisible();
  await page.getByLabel("Photo file (JPEG or HEIC)").setInputFiles({
    name: "IMG_2041.jpg",
    mimeType: "image/jpeg",
    buffer: THUMBNAIL,
  });
  await page.getByLabel("Caption (optional)").fill("Browser test: ring beam");
  await page.getByRole("button", { name: "Import photo" }).click();
  await expect(page.getByRole("status").filter({ hasText: "could not be verified" })).toBeVisible();
  const imported = page.getByRole("article", { name: "Browser test: ring beam" });
  await expect(imported).toContainText("Imported from a file");

  await page.getByLabel("Photo file (JPEG or HEIC)").setInputFiles({
    name: "IMG_2042.HEIC",
    mimeType: "image/heic",
    buffer: THUMBNAIL,
  });
  await page.getByLabel("Caption (optional)").fill("Browser test: iPhone photo");
  await page.getByRole("button", { name: "Import photo" }).click();
  await expect(
    page
      .getByRole("article", { name: "Browser test: iPhone photo" })
      .getByRole("link", { name: /Download original \(HEIC\)/ }),
  ).toBeVisible();

  await page.getByLabel("Photo file (JPEG or HEIC)").setInputFiles({
    name: "duplicate.jpg",
    mimeType: "image/jpeg",
    buffer: THUMBNAIL,
  });
  await page.getByRole("button", { name: "Import photo" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already been uploaded" })).toBeVisible();
});

test.describe("the in-app camera", () => {
  // Chromium's synthetic camera (playwright.config.ts) and a GPS fix on the main plot.
  test.use({
    permissions: ["camera", "geolocation"],
    geolocation: { latitude: -1.14881, longitude: 36.96137, accuracy: 8 },
  });

  test("takes a verified photo on site; a coarse location is not verified", async ({
    page,
    context,
  }) => {
    await signInAs(context, "owner");
    await stubThumbnails(page);
    await page.goto(`/projects/${RUIRU_ID}?tab=photos`);
    await page.getByLabel("Caption (optional)").fill("Browser test: camera capture");
    await page.getByRole("button", { name: "Take a photo" }).click();
    const camera = page.getByRole("dialog", { name: "Take a site photo" });
    await expect(camera.getByRole("status")).toHaveText("Location found (within 8 m).");
    const shutter = camera.getByRole("button", { name: "Take photo" });
    await expect(shutter).toBeEnabled();
    expect(await axeViolations(page)).toEqual([]);
    await shutter.click();
    await expect(camera.getByRole("img", { name: "The photo you just took" })).toBeVisible();
    await camera.getByRole("button", { name: "Use photo" }).click();
    await expect(camera).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Photo uploaded and verified." }),
    ).toBeVisible();
    const captured = page.getByRole("article", { name: "Browser test: camera capture" });
    await expect(captured.getByText("Verified", { exact: true })).toBeVisible();
    await expect(captured).toContainText("Taken with the PM-Buddy camera");

    await context.setGeolocation({ latitude: -1.14881, longitude: 36.96137, accuracy: 200 });
    await page.getByLabel("Caption (optional)").fill("Browser test: coarse fix");
    await page.getByRole("button", { name: "Take a photo" }).click();
    await expect(camera.getByRole("status")).toContainText(
      "Location is approximate (within 200 m)",
    );
    await camera.getByRole("button", { name: "Take photo" }).click();
    await camera.getByRole("button", { name: "Use photo" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "could not be verified" }),
    ).toBeVisible();
    await expect(page.getByRole("article", { name: "Browser test: coarse fix" })).toContainText(
      "The phone's location was too approximate (within 200 m)",
    );
  });
});

test("photos work in Kiswahili on a small phone without horizontal scrolling", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await stubThumbnails(page);
  await preferences(context, page, "sw", "dark");
  // No camera on this device: the camera screen says so and points to importing a file.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: () => Promise.reject(new DOMException("No camera", "NotFoundError")),
      },
    });
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/projects/${RUIRU_ID}?tab=photos`);
  await expect(page.getByRole("heading", { name: "Picha za eneo" })).toBeVisible();
  await expect(page.getByText("Imethibitishwa", { exact: true })).toBeVisible();
  await expect(page.getByText("Haijathibitishwa").first()).toBeVisible();
  await expect(page.getByText("Imeingizwa kutoka kwenye faili").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Piga picha" }).click();
  const camera = page.getByRole("dialog", { name: "Piga picha ya eneo" });
  await expect(camera.getByRole("alert")).toContainText("Kamera haikuweza kufunguliwa");
  await expect(camera.getByRole("button", { name: "Piga picha" })).toBeDisabled();
  expect(await axeViolations(page)).toEqual([]);
  await camera.getByRole("button", { name: "Funga" }).click();
  await expect(camera).toHaveCount(0);
});
