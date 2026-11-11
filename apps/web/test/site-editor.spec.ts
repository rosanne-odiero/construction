import { expect, test, type Page } from "@playwright/test";
import { axeViolations, blockTiles, MAIN_PLOT_ID, RUIRU_ID, signInAs } from "./live-helpers";

/** The site geofence editor against test/mock-api.mts: drawing on the map and the keyboard list. */

test.beforeEach(async ({ page, context }) => {
  await blockTiles(page);
  await signInAs(context, "owner");
});

const vertexInputs = (page: Page) => page.getByLabel(/^Vertex \d+ latitude$/);
const area = (page: Page) => page.getByTestId("geofence-area");
const perimeter = (page: Page) => page.getByTestId("geofence-perimeter");

test("draws a polygon by clicking the map, edits its vertices and saves a new site", async ({
  page,
}) => {
  await page.goto(`/projects/${RUIRU_ID}/sites/new`);
  await expect(page.getByRole("heading", { name: "Add a site", level: 1 })).toBeVisible();
  const map = page.getByRole("region", { name: "Geofence map" });
  await expect(map.locator(".leaflet-container")).toBeVisible();
  await expect(page.getByText("No vertices yet.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save site" })).toBeDisabled();

  for (const [x, y] of [
    [80, 80],
    [240, 80],
    [240, 240],
    [80, 240],
    [160, 320],
  ] as const)
    await map.click({ position: { x, y } });
  await expect(vertexInputs(page)).toHaveCount(5);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(vertexInputs(page)).toHaveCount(4);
  await expect(page.getByText("The geofence is valid.")).toBeVisible();
  await expect(area(page)).toHaveText(/^[\d.,]+ (m²|ha)$/);
  await expect(perimeter(page)).toHaveText(/^[\d.,]+ (m|km)$/);
  const squareArea = await area(page).textContent();

  await page.getByTitle("Vertex 2", { exact: true }).click();
  await expect(page.getByText("Vertex 2 selected.")).toBeVisible();
  await page.getByRole("button", { name: "Delete selected vertex" }).click();
  await expect(vertexInputs(page)).toHaveCount(3);
  await expect(area(page)).not.toHaveText(squareArea!);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(vertexInputs(page)).toHaveCount(4);
  await expect(area(page)).toHaveText(squareArea!);

  await page.getByLabel("Site name").fill("Block B");
  await page.getByLabel("Address or landmark").fill("Behind the water tank");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Save site" }).click();

  await expect(page).toHaveURL(`/projects/${RUIRU_ID}?tab=sites`);
  const card = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "Block B" }) });
  await expect(card).toContainText("Polygon with 4 vertices");
  await expect(card).toContainText("Behind the water tank");
  await expect(card).toContainText("Version 1");
});

test("sets a radius and a polygon with the keyboard-accessible coordinate list", async ({
  page,
}) => {
  await page.goto(`/projects/${RUIRU_ID}/sites/new`);
  const save = page.getByRole("button", { name: "Save site" });
  await page.getByLabel("Site name").fill("Site office");

  // Radius: arrow keys move between the native shape radios.
  await page.getByRole("radio", { name: "Polygon" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Radius" })).toBeChecked();
  await expect(page.getByLabel("Centre latitude")).toHaveValue("-1.1489");
  const radius = page.getByLabel("Radius (metres)");
  await radius.fill("10");
  await expect(
    page.getByText("The radius must be a whole number from 20 to 5,000 metres."),
  ).toBeVisible();
  await expect(save).toBeDisabled();
  const slider = page.getByRole("slider", { name: "Radius slider" });
  await slider.focus();
  await page.keyboard.press("End");
  await expect(radius).toHaveValue("5000");
  await page.keyboard.press("ArrowLeft");
  await expect(radius).toHaveValue("4995");
  await radius.fill("150");
  await expect(page.getByText("The geofence is valid.")).toBeVisible();
  await expect(area(page)).toHaveText("7.07 ha");
  await page.getByLabel("Centre latitude").fill("6.2");
  await expect(page.getByText("Every point must be inside Kenya.")).toBeVisible();
  await expect(save).toBeDisabled();
  await page.getByLabel("Centre latitude").fill("-1.1489");
  await expect(page.getByText("The geofence is valid.")).toBeVisible();

  // Polygon: add vertices with the button and type exact coordinates.
  await page.getByRole("radio", { name: "Radius" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("radio", { name: "Polygon" })).toBeChecked();
  await expect(page.getByText("A polygon needs at least 3 vertices.")).toBeVisible();
  const addVertex = page.getByRole("button", { name: "Add vertex" });
  for (let i = 0; i < 4; i += 1) {
    await addVertex.focus();
    await page.keyboard.press("Enter");
  }
  const corners = [
    ["-1.1489", "36.9612"],
    ["-1.1489", "36.9618"],
    ["-1.1484", "36.9618"],
    ["-1.1484", "36.9612"],
  ];
  for (const [index, [lat, lng]] of corners.entries()) {
    await page.getByLabel(`Vertex ${index + 1} latitude`).fill(lat!);
    await page.getByLabel(`Vertex ${index + 1} longitude`).fill(lng!);
  }
  await expect(page.getByText("The geofence is valid.")).toBeVisible();

  await page.getByRole("button", { name: "Move vertex 3 down" }).click();
  await expect(page.getByLabel("Vertex 3 latitude")).toHaveValue("-1.1484");
  await expect(page.getByLabel("Vertex 3 longitude")).toHaveValue("36.9612");
  await expect(
    page.getByText("The edges cross each other. Move or reorder the vertices."),
  ).toBeVisible();
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("The geofence is valid.")).toBeVisible();

  await addVertex.click();
  await page.getByLabel("Vertex 5 latitude").fill("-1.1489");
  await page.getByLabel("Vertex 5 longitude").fill("36.9612");
  await expect(
    page.getByText("Do not repeat the first vertex at the end. The polygon closes itself."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove vertex 5" }).click();

  await page.getByLabel("Vertex 2 longitude").fill("45");
  await expect(page.getByText("Every point must be inside Kenya.")).toBeVisible();
  await page.getByLabel("Vertex 2 longitude").fill("36.9618");
  await expect(page.getByText("The geofence is valid.")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await save.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/projects/${RUIRU_ID}?tab=sites`);
  const card = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "Site office" }) });
  await expect(card).toContainText("Polygon with 4 vertices");
});

test("a geofence edit adds a version and leaves the earlier versions unchanged", async ({
  page,
}) => {
  await page.goto(`/projects/${RUIRU_ID}/sites/${MAIN_PLOT_ID}`);
  await expect(page.getByRole("heading", { name: "Edit Main plot", level: 1 })).toBeVisible();
  const history = page.getByRole("list").filter({ hasText: "Version 1" });
  await expect(history.getByRole("listitem")).toHaveCount(2);
  const before = await history.getByRole("listitem").allTextContents();
  const saveVersion = page.getByRole("button", { name: "Save new geofence version" });
  await expect(saveVersion).toBeDisabled();
  await expect(page.getByText("Saving creates version 3.", { exact: false })).toBeVisible();

  await page
    .getByLabel("Vertex 3 longitude")
    .fill(String(Number(await page.getByLabel("Vertex 3 longitude").inputValue()) + 0.0002));
  await expect(page.getByText("The geofence is valid.")).toBeVisible();
  await saveVersion.click();
  await expect(page).toHaveURL(`/projects/${RUIRU_ID}?tab=sites`);
  await expect(
    page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Main plot" }) }),
  ).toContainText("Version 3");

  await page.goto(`/projects/${RUIRU_ID}/sites/${MAIN_PLOT_ID}`);
  await expect(history.getByRole("listitem")).toHaveCount(3);
  const after = await history.getByRole("listitem").allTextContents();
  expect(after[0]).toContain("Version 3");
  expect(after.slice(1)).toEqual(before);

  await page.getByLabel("Site name").fill("Main plot (Block A)");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText("Site details saved.")).toBeVisible();
});
