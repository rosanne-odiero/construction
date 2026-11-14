import { expect, test, type Page } from "@playwright/test";
import { axeViolations, preferences, RUIRU_ID, signInAs, switchPersona } from "./live-helpers";

/**
 * D8.2 health and safety against test/mock-api.mts (mock-safety.mts uses the shared domain rules
 * and response schemas): the done-when flow (incident → investigation → corrective action → done by
 * its owner → verified by someone else → incident closed and locked), restricted personal data,
 * toolbox talks on a phone, induction flags from attendance, the PPE register, first aid, company
 * settings, Kiswahili, dark mode, 360 px and axe.
 */
type View = "actions" | "inductions" | "talks" | "ppe" | "first-aid";
const safety = (view?: View) => `/projects/${RUIRU_ID}?tab=safety${view ? `&view=${view}` : ""}`;
const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
/** A Nairobi calendar date `offset` days from today, as the forms take it (DD/MM/YYYY). */
const nairobiDay = (offset = 0) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(Date.now() + offset * 86_400_000));

test("reports an injury on a phone, then investigates, verifies the action independently and closes the incident", async ({
  page,
  context,
}) => {
  test.slow();
  const token = await signInAs(context, "agent");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(safety());
  await page.getByRole("link", { name: "Report an incident" }).click();
  await expect(
    page.getByRole("heading", { name: "Report an incident or near miss", level: 1 }),
  ).toBeVisible();
  await page.getByLabel("What happened").selectOption("injury");
  await page.getByLabel("Severity").selectOption("serious");
  await page.getByLabel("Where on site").fill("Stair core, block A");
  await page.getByLabel("Description").fill("Short");
  await page.getByRole("button", { name: "Report incident" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "10–2,000 characters" })).toBeVisible();
  await page
    .getByLabel("Description")
    .fill("A labourer missed a step on the unlit stair core and fell.");
  await page.getByLabel("Immediate actions taken").fill("Area lit with a work lamp");
  await page.getByText("First aid was given", { exact: true }).click();
  await page.getByRole("button", { name: "Report incident" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "An injury needs at least one injured person." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add a person" }).click();
  const person = page.getByRole("group", { name: "Person 1" });
  await person.getByRole("searchbox", { name: "Labourer" }).fill("Grace");
  await person.getByRole("button", { name: /^Choose .*Grace Atieno Odhiambo$/ }).click();
  await expect(person).toContainText("Chosen: Grace Atieno Odhiambo (WRK-0003)");
  await person.getByLabel("Injury").selectOption("bruise");
  await person.getByLabel("Part of the body").selectOption("leg");
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Report incident" }).click();
  await expect(page).toHaveURL(/\/safety\/incidents\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole("heading", { name: "Injury: Stair core, block A", level: 1 }),
  ).toBeVisible();
  // The reporter has no safety.manage: names and injuries are restricted to safety managers.
  const people = page.getByRole("region", { name: "People" });
  await expect(people).toContainText(
    "1 injured, 0 involved, 0 witnesses. Names and injuries are visible to safety managers only.",
  );
  await expect(people).not.toContainText("Grace");
  await expect(page.getByRole("button", { name: "Record investigation" })).toHaveCount(0);
  const blockers = page.getByRole("region", { name: "Before closing" });
  await expect(blockers).toContainText("Record the investigation (root cause) first.");
  await expect(blockers).toContainText("Record the regulator decision first.");
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  await switchPersona(context, "pm", token);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await expect(people).toContainText("Injured: Grace Atieno Odhiambo (WRK-0003) — Bruise, Leg");
  await expect(page.getByRole("region", { name: "Regulator (DOSH) notification" })).toContainText(
    "Regulator decision needed (COMPLIANCE-REVIEW)",
  );
  await page.getByRole("button", { name: "Record investigation" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Root cause category").selectOption("unsafe_condition");
  await dialog.getByLabel("Root cause (what made it happen)").fill("Dark");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toContainText("10–2,000 characters");
  await dialog
    .getByLabel("Root cause (what made it happen)")
    .fill("The stair core had no temporary lighting after 5 pm.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Investigated", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Raise a corrective action" }).click();
  await dialog.getByLabel("What must be done").fill("Fit temporary lights in every stair core");
  await dialog.getByLabel("Owner").selectOption({ label: "Kevin Kiprono" });
  await dialog.getByLabel("Due date (DD/MM/YYYY)").fill(` ${nairobiDay(7)} `);
  await dialog.getByRole("button", { name: "Raise a corrective action" }).click();
  await expect(dialog).toHaveCount(0);
  const action = page.getByRole("article", { name: "Corrective action CA-0004" });
  await expect(action).toContainText("Open");
  await expect(action).toContainText("Owner: Kevin Kiprono");
  // Only the owner records the action as done.
  await expect(action.getByRole("button", { name: "Mark done: CA-0004" })).toHaveCount(0);

  await page.getByRole("button", { name: "Record the decision" }).click();
  await dialog.getByText("Notified", { exact: true }).click();
  await dialog.getByLabel("Notified on (DD/MM/YYYY)").fill(nairobiDay(1));
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toContainText("no later than today");
  await dialog.getByLabel("Notified on (DD/MM/YYYY)").fill(nairobiDay());
  await dialog.getByLabel("Reference (optional)").fill("DOSH/KBU/0042");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Regulator (DOSH) notification" })).toContainText(
    "Regulator notified",
  );
  await expect(blockers).toContainText("Every corrective action must be verified or cancelled.");
  await expect(blockers).not.toContainText("Record the regulator decision first.");

  await switchPersona(context, "agent", token);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.reload();
  await action.getByRole("button", { name: "Mark done: CA-0004" }).click();
  await dialog.getByLabel("What was done (optional)").fill("Six lamps fitted on a timer");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(action).toContainText("Done, awaiting verification");
  await expect(action.getByRole("button", { name: "Verify: CA-0004" })).toHaveCount(0);
  expect(await noSideScroll(page)).toBe(true);

  await switchPersona(context, "pm", token);
  await page.reload();
  await action.getByRole("button", { name: "Verify: CA-0004" }).click();
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(action).toContainText("Verified by Brian Otieno");
  await page.getByRole("button", { name: "Close incident" }).click();
  await dialog
    .getByLabel("Closing note (optional)")
    .fill("Lighting checked at the next walk-round");
  await dialog.getByRole("button", { name: "Close incident" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText(
      "Closed and locked. This incident cannot be changed; report anything new as a follow-up.",
    ),
  ).toBeVisible();
  for (const name of [
    "Correct details",
    "Void",
    "Revise investigation",
    "Raise a corrective action",
    "Record the decision",
    "Add a photo",
  ])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Report a follow-up" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.goto(safety());
  await expect(page.getByRole("link", { name: /^INC-0003/ })).toContainText("Closed · locked");
});

test("lists overdue corrective actions first and keeps the owner from verifying their own action", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "pm");
  await page.goto(safety("actions"));
  await expect(page.getByRole("list", { name: "Corrective action counts" })).toContainText(
    "1 overdue",
  );
  const cards = page.getByRole("article", { name: /^Corrective action CA-/ });
  await expect(cards.first()).toHaveAccessibleName("Corrective action CA-0003");
  await expect(cards.first()).toContainText("2 days overdue");

  await page.getByRole("button", { name: "Raise a corrective action" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("What must be done").fill("Tie ladders at the top before use");
  await dialog.getByLabel("Owner").selectOption({ label: "Brian Otieno" });
  await dialog.getByLabel("Due date (DD/MM/YYYY)").fill("31/02/2027");
  await dialog.getByRole("button", { name: "Raise a corrective action" }).click();
  await expect(dialog.getByRole("alert")).toContainText("DD/MM/YYYY");
  await dialog.getByLabel("Due date (DD/MM/YYYY)").fill(nairobiDay(3));
  await dialog.getByRole("button", { name: "Raise a corrective action" }).click();
  await expect(dialog).toHaveCount(0);
  const ladder = page.getByRole("article", { name: "Corrective action CA-0004" });
  await expect(ladder).toContainText("Raised directly");
  await ladder.getByRole("button", { name: "Mark done: CA-0004" }).click();
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(ladder).toContainText("Done, awaiting verification");
  // The PM owns and completed it: someone else must verify it.
  await expect(ladder.getByRole("button", { name: "Verify: CA-0004" })).toHaveCount(0);
  await expect(ladder).toContainText("Awaiting verification by someone other than the owner.");

  await switchPersona(context, "owner", token);
  await page.reload();
  await ladder.getByRole("button", { name: "Send back: CA-0004" }).click();
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Give a reason of 3–500 characters.");
  await dialog.getByLabel("Reason (required)").fill("Two ladders were still untied");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(ladder).toContainText("Sent back once. Last reason: Two ladders were still untied");

  await page.getByLabel("Status", { exact: true }).selectOption("overdue");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/view=actions&status=overdue/);
  await expect(cards).toHaveCount(1);
  expect(await axeViolations(page)).toEqual([]);
});

test("records a toolbox talk with a gang on a phone and locks it once confirmed", async ({
  page,
  context,
}) => {
  await signInAs(context, "agent");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(safety("talks"));
  await page.getByRole("link", { name: "Record a toolbox talk" }).click();
  await expect(
    page.getByRole("heading", { name: "Record a toolbox talk", level: 1 }),
  ).toBeVisible();
  await page.getByLabel("Topic").fill("Ladder safety and three points of contact");
  await page.getByLabel("Minutes (optional)").fill(" 15 ");
  await page.getByRole("button", { name: "Save and confirm" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Choose at least one gang or labourer" }),
  ).toBeVisible();
  await page.getByText("Masonry gang A (2 members)", { exact: true }).click();
  const others = page.getByRole("group", { name: "Other labourers who attended" });
  await others.getByRole("searchbox", { name: "Add a labourer" }).fill("Mercy");
  await others.getByRole("button", { name: /^Choose .*Mercy Chebet Rotich$/ }).click();
  await page.getByLabel("Others not in the registry (visitors, staff)").fill("2");
  await page.getByRole("button", { name: "Take or add a photo" }).waitFor();
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page).toHaveURL(/\/safety\/talks\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Save and confirm" }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm this toolbox talk" });
  await expect(confirm).toContainText(
    "Once confirmed, the talk and its attendance cannot be changed.",
  );
  await confirm.getByRole("button", { name: "Confirm and lock" }).click();
  await expect(page.getByText(/^Confirmed and locked by Kevin Kiprono on /)).toBeVisible();
  const attendees = page.getByRole("region", { name: "Attendees" });
  await expect(attendees).toContainText("Amina Wekesa Njoroge");
  await expect(attendees).toContainText("Mercy Chebet Rotich");
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel talk" })).toHaveCount(0);
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
});

test("flags labourers who worked without an induction and records inductions", async ({
  page,
  context,
}) => {
  await signInAs(context, "pm");
  await page.goto(safety("inductions"));
  const counts = page.getByRole("list", { name: "Induction counts" });
  await expect(counts).toContainText("2 flagged");
  await page.getByLabel("Status", { exact: true }).selectOption("flagged");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/view=inductions.*filter=flagged/);
  await expect(page.getByText(/^Worked here without a valid induction on /)).toHaveCount(2);
  await page.getByRole("button", { name: "Record an induction for Grace Atieno Odhiambo" }).click();
  const dialog = page.getByRole("dialog", { name: "Record an induction" });
  await expect(dialog).toContainText("Chosen: Grace Atieno Odhiambo (WRK-0003)");
  await dialog.getByText("Electrical safety", { exact: true }).click();
  await dialog.getByLabel("Acknowledged by").selectOption("thumbprint");
  await dialog.getByRole("button", { name: "Record an induction" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(counts).toContainText("3 inducted");
  // The flag stays for the day worked before the induction (D-71); the action is no longer offered.
  await expect(counts).toContainText("2 flagged");
  await expect(
    page.getByRole("button", { name: "Record an induction for Grace Atieno Odhiambo" }),
  ).toHaveCount(0);
  const recorded = page.getByRole("region", { name: "Recorded inductions" });
  await expect(recorded).toContainText("IND-0003");
  await expect(recorded).toContainText("Thumbprint · 9 of 10 topics");

  await page.getByRole("button", { name: "Record an induction", exact: true }).click();
  await dialog.getByLabel("Who was inducted").selectOption("visitor");
  await dialog.getByLabel("Visitor's name").fill("Eng. Mutua (county inspector)");
  await dialog.getByRole("button", { name: "Record an induction" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(recorded).toContainText("Eng. Mutua (county inspector)");
  expect(await axeViolations(page)).toEqual([]);
});

test("issues PPE, replaces an item that is due and returns another", async ({ page, context }) => {
  await signInAs(context, "pm");
  await page.goto(safety("ppe"));
  const counts = page.getByRole("list", { name: "PPE counts" });
  await expect(counts).toContainText("1 due");
  const gloves = page.getByRole("listitem", { name: "Gloves for Joseph Mwangi Kariuki" });
  await expect(gloves).toContainText("Replacement due");
  await gloves.getByRole("button", { name: "Replace: Gloves for Joseph Mwangi Kariuki" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Quantity").fill("0");
  await dialog.getByRole("button", { name: "Issue PPE" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByLabel("Quantity").fill(" 2 ");
  await dialog.getByRole("button", { name: "Issue PPE" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(counts).toContainText("0 due");

  await page.getByRole("button", { name: "Issue PPE" }).click();
  await dialog.getByRole("searchbox", { name: "Labourer" }).fill("WRK-0005");
  await dialog.getByRole("button", { name: /^Choose .*Mercy Chebet Rotich$/ }).click();
  await dialog.getByLabel("Item").selectOption("safety_boots");
  await dialog.getByLabel("Size (optional)").fill("42");
  await dialog.getByRole("button", { name: "Issue PPE" }).click();
  await expect(dialog).toHaveCount(0);
  const boots = page.getByRole("listitem", { name: "Safety boots for Mercy Chebet Rotich" });
  await expect(boots).toContainText(/Safety boots\s*\(42\)\s*× 1/);
  await expect(boots).toContainText(/Replace by \d{2}\/\d{2}\/\d{4}/);
  const helmet = page.getByRole("listitem", { name: "Helmet for Amina Wekesa Njoroge" });
  await helmet.getByRole("button", { name: "Return: Helmet for Amina Wekesa Njoroge" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(helmet).toContainText("Returned");
  expect(await axeViolations(page)).toEqual([]);
});

test("checks a first-aid kit and keeps treatment details to safety managers", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "agent");
  await page.goto(safety("first-aid"));
  const treatments = page.getByRole("region", { name: "First-aid treatments" });
  await expect(treatments).toContainText("FA-0001");
  await expect(treatments).toContainText("Details restricted");
  await expect(treatments).not.toContainText("Amina");
  await page.getByRole("button", { name: "Record a check: Scaffold kit" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Outcome").selectOption("restocked");
  await dialog
    .getByLabel("Earliest expiry of the contents (DD/MM/YYYY, optional)")
    .fill(nairobiDay(200));
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("list", { name: "First-aid counts" })).toContainText(
    "0 kits need attention",
  );

  await page.getByRole("button", { name: "Record a treatment" }).click();
  await dialog.getByRole("searchbox", { name: "Labourer" }).fill("Peter");
  await dialog.getByRole("button", { name: /^Choose .*Peter Kiprotich Langat$/ }).click();
  await dialog.getByLabel("Injury").selectOption("cut");
  await dialog.getByLabel("Treatment").selectOption("cleaned_dressed");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(treatments).toContainText("FA-0002");
  await expect(treatments).not.toContainText("Peter");

  await switchPersona(context, "pm", token);
  await page.goto(safety("first-aid"));
  await expect(treatments).toContainText("Peter Kiprotich Langat — Cut, Cleaned and dressed");
  expect(await axeViolations(page)).toEqual([]);
});

test("shows the company overview and validates the safety settings", async ({ page, context }) => {
  await signInAs(context, "owner");
  await page.goto("/projects");
  await page.getByRole("link", { name: "Health and safety", exact: true }).first().click();
  await expect(page).toHaveURL(/\/safety$/);
  await expect(page.getByRole("heading", { name: "Health and safety", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /RUI-HTS/ }).first()).toBeVisible();
  await page.getByRole("link", { name: "Safety settings" }).click();
  await expect(page).toHaveURL(/\/safety\/settings$/);
  const lookback = page.getByLabel("Check attendance for the last (days)");
  await lookback.fill("200");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "look-back 1–90" })).toBeVisible();
  await lookback.fill(" 21 ");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Settings saved." })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("safety views work in Kiswahili, dark mode and at 360 px without sideways scrolling", async ({
  page,
  context,
}) => {
  test.slow();
  await signInAs(context, "pm");
  await preferences(context, page, "sw", "dark");
  await page.setViewportSize({ width: 360, height: 800 });
  for (const view of [undefined, "actions", "inductions", "talks", "ppe", "first-aid"] as const) {
    await page.goto(safety(view));
    await expect(page.getByRole("heading", { name: "Afya na usalama", level: 2 })).toBeVisible();
    expect(await noSideScroll(page), view ?? "incidents").toBe(true);
    expect(await axeViolations(page), view ?? "incidents").toEqual([]);
  }
  await page.goto(safety());
  await page.getByRole("link", { name: /INC-0002/ }).click();
  await expect(page).toHaveURL(/\/safety\/incidents\/[0-9a-f-]{36}$/);
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.goto(`/projects/${RUIRU_ID}/safety/talks/new`);
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.goto(`/projects/${RUIRU_ID}/safety/incidents/new`);
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.goto("/safety");
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
});
