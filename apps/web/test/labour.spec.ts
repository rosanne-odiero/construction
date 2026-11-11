import { expect, test, type Page } from "@playwright/test";
import { addCalendarDays, latestAllowedBirthDate, nairobiDate } from "@pm-buddy/domain";
import { axeViolations, MOCK_STEP_UP_CODE, preferences, signInAs } from "./live-helpers";

/** Live labour registry pages (D3.1) rendered from test/mock-api.mts and test/mock-labour.mts. */

const AMINA = "42000000-0000-4000-8000-000000000001";
const GANG = "43000000-0000-4000-8000-000000000001";
const DUPLICATE_ID = "23456781";
const FLAGGED_PHONE = "0700000106";
const ddmmyyyy = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

async function stepUp(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Authenticator code").fill(MOCK_STEP_UP_CODE);
  await dialog.getByRole("button", { name: "Verify and continue" }).click();
}

test("lists workers with masked identifiers, built-in and saved views", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/labour");
  await expect(page.getByRole("heading", { name: "Labour registry", level: 1 })).toBeVisible();
  await expect(page.getByText(/Prototype: screens show mock data/)).toHaveCount(0);
  await expect(page.getByText("6 workers")).toBeVisible();
  const table = page.getByRole("table", { name: "Registered workers with masked identifiers" });
  const amina = table.getByRole("row", { name: /Amina Wekesa Njoroge/ });
  await expect(amina).toContainText("•••••678");
  await expect(amina).toContainText("2547•••••101");
  await expect(page.getByText("12345678")).toHaveCount(0);
  await expect(table.getByRole("row", { name: /Joseph Mwangi/ })).toContainText("NCA expiring");
  await expect(table.getByRole("row", { name: /Grace Atieno/ })).toContainText("NCA expired");
  await expect(table.getByRole("row", { name: /Peter Kiprotich/ })).toContainText(
    "NCA card missing",
  );
  await expect(table.getByRole("row", { name: /Oscar Mutai/ })).toContainText("Do not rehire");
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("link", { name: "Expiring NCA" }).click();
  await expect(page).toHaveURL(/accreditation=attention/);
  await expect(page.getByText("2 workers")).toBeVisible();
  await expect(page.getByRole("link", { name: "Expiring NCA" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("link", { name: "Do not rehire" }).click();
  await expect(page.getByText("1 worker", { exact: true })).toBeVisible();

  // A full ID number finds the worker (blind index in the real API); names match partially.
  await page.getByRole("link", { name: "All workers" }).click();
  await expect(page).toHaveURL(/\/labour$/);
  await expect(page.getByText("6 workers")).toBeVisible();
  await page.getByLabel("Search").fill("34567812");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("1 worker", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Grace Atieno Odhiambo" })).toBeVisible();

  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/labour$/);
  await page.getByLabel("Trade", { exact: true }).selectOption({ label: "Carpenter" });
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("2 workers")).toBeVisible();
  await page.getByRole("button", { name: "Save view" }).click();
  const save = page.getByRole("dialog", { name: "Save these filters as a view" });
  await save.getByLabel("View name").fill("Carpenters");
  expect(await axeViolations(page)).toEqual([]);
  await save.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("link", { name: "Carpenters" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("button", { name: "Delete view Carpenters" }).click();
  await expect(page.getByRole("link", { name: "Carpenters" })).toHaveCount(0);
});

test("reveals an identifier only after step-up and flags do-not-rehire", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto(`/labour?worker=${AMINA}`);
  const panel = page.getByRole("dialog", { name: "Amina Wekesa Njoroge" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("•••••678")).toBeVisible();
  await expect(panel.getByText("12345678")).toHaveCount(0);
  await expect(panel.getByText("Not flagged.")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await panel.getByRole("button", { name: /^Show full\s*: ID number$/ }).click();
  const reveal = page.getByRole("dialog", { name: "Show the full ID number" });
  await reveal.getByLabel("Purpose").selectOption("payroll_setup");
  await reveal.getByRole("button", { name: "Show full" }).click();
  await stepUp(page);
  await expect(panel.getByText("12345678")).toBeVisible();
  await panel.getByRole("button", { name: /^Hide\s*: ID number$/ }).click();
  await expect(panel.getByText("12345678")).toHaveCount(0);

  await panel.getByRole("button", { name: "Flag do not rehire" }).click();
  const flag = page.getByRole("dialog", { name: "Flag do not rehire" });
  const submit = flag.getByRole("button", { name: "Flag do not rehire" });
  await flag.getByLabel("Reason").fill("Too short");
  await expect(submit).toBeDisabled();
  await flag.getByLabel("Reason").fill("Synthetic test: left site with tools on 02/11/2026.");
  await submit.click();
  const flagged = page.getByRole("dialog", { name: "Amina Wekesa Njoroge" });
  await expect(flagged.getByText(/Flagged by Wanjiru Kamau on/)).toBeVisible();
  await expect(
    flagged.getByText("Synthetic test: left site with tools on 02/11/2026."),
  ).toBeVisible();
  await expect(flagged.getByRole("button", { name: "Clear the flag" })).toBeVisible();
});

test("registration needs consent, refuses under-18s and explains duplicates", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  const today = nairobiDate();
  const eighteenToday = latestAllowedBirthDate(today);
  const oneDayShort = addCalendarDays(eighteenToday, 1);
  await page.goto("/labour");
  await page.getByRole("link", { name: "Register worker" }).click();
  await expect(page).toHaveURL("/labour/register");
  await expect(page.getByRole("heading", { name: "Register a worker", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Who we are" })).toBeVisible();
  const consentStep = page.getByRole("region", { name: "Consent to record personal data" });
  await consentStep.getByRole("radio", { name: "Kiswahili" }).check();
  await expect(
    page.getByRole("heading", { name: "Taarifa zako binafsi katika Jenga Bora Builders Ltd" }),
  ).toBeVisible();
  await expect(page.locator("article[lang=sw]")).toBeVisible();
  const proceed = page.getByRole("button", { name: "Continue to details" });
  await expect(proceed).toBeDisabled();
  await page.getByLabel(/Read aloud, agreed verbally/).check();
  await page.getByLabel(/was shown this notice in Kiswahili and agreed/).check();
  await expect(proceed).toBeDisabled();
  await page.getByLabel("Witness name").fill("Kevin Kiprono");
  expect(await axeViolations(page)).toEqual([]);
  await proceed.click();

  await expect(page.getByText("Consent: Kiswahili, Read aloud")).toBeVisible();
  await page.getByLabel("Full name").fill("Zawadi Synthetic Wanjiru");
  await page.getByLabel("Date of birth").fill(ddmmyyyy(oneDayShort));
  await page.getByLabel("Gender").selectOption("female");
  await page.getByLabel("ID or passport number").fill(DUPLICATE_ID);
  await page.getByRole("combobox", { name: "Trade", exact: true }).selectOption({ label: "Mason" });
  await page
    .getByRole("combobox", { name: "Skill level", exact: true })
    .selectOption({ label: "Semi-skilled" });
  await page.getByRole("button", { name: "Register worker" }).click();
  await expect(
    page.getByText(
      `Workers must be 18 or older. Only people born on or before ${ddmmyyyy(eighteenToday)} can be registered today.`,
    ),
  ).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // The 18th birthday today is old enough; the ID belongs to an existing worker.
  await page.getByLabel("Date of birth").fill(ddmmyyyy(eighteenToday));
  await page.getByRole("button", { name: "Register worker" }).click();
  const duplicate = page.getByRole("alert").filter({ hasText: "already registered as WRK-0002" });
  await expect(duplicate).toBeVisible();
  await expect(duplicate.getByRole("link", { name: "Open WRK-0002" })).toHaveAttribute(
    "href",
    "/labour?worker=42000000-0000-4000-8000-000000000002",
  );
  await expect(duplicate.getByRole("button", { name: /Engage WRK-0002 on RUI-HTS/ })).toBeVisible();

  // A new ID with the phone of a flagged worker needs a recorded override.
  await page.getByLabel("ID or passport number").fill("87654321");
  await page.getByLabel("Phone (M-Pesa)").fill(FLAGGED_PHONE);
  await page.getByRole("button", { name: "Register worker" }).click();
  const flagged = page.getByRole("alert").filter({ hasText: "flagged do not rehire" });
  await expect(flagged).toContainText("The phone number matches WRK-0006");
  const anyway = flagged.getByRole("button", { name: "Register with override" });
  await expect(anyway).toBeDisabled();
  await flagged.getByLabel("Override reason").fill("Synthetic test: shared family phone.");
  await anyway.click();
  await expect(
    page.getByRole("heading", { name: "Zawadi Synthetic Wanjiru is registered as WRK-0007" }),
  ).toBeVisible();
  await expect(page.getByText("A do-not-rehire match was overridden and recorded.")).toBeVisible();
  await page.getByRole("link", { name: "Open worker" }).click();
  await expect(page.getByRole("dialog", { name: "Zawadi Synthetic Wanjiru" })).toBeVisible();
});

test("records a consent withdrawal and a new consent", async ({ page, context }) => {
  await signInAs(context, "owner");
  await page.goto(`/labour/${AMINA}/consent`);
  await expect(
    page.getByRole("heading", { name: "Consent: Amina Wekesa Njoroge", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Consent given")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Record withdrawal" }).click();
  const withdraw = page.getByRole("dialog", { name: "Record a withdrawal" });
  await withdraw.getByRole("button", { name: "Record withdrawal" }).click();
  await expect(page.getByText("Withdrawal recorded.")).toBeVisible();
  await expect(page.getByText("Consent withdrawn").first()).toBeVisible();
  await expect(page.getByText(/cannot be engaged on new projects/)).toBeVisible();

  await expect(
    page.getByRole("heading", { name: "Record consent to the current notice" }),
  ).toBeVisible();
  await page.getByLabel(/was shown this notice in English and agreed/).check();
  await page.getByRole("button", { name: "Record consent" }).click();
  await expect(page.getByText("Consent recorded.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Consent history" }).getByRole("row")).toHaveCount(
    3,
  );
  expect(await axeViolations(page)).toEqual([]);
});

test("creates a gang, adds a member and keeps the leader until replaced", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto(`/labour/gangs/${GANG}`);
  await expect(page.getByRole("heading", { name: "Masonry gang A", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Current members" }).getByRole("row", { name: /Amina/ }),
  ).toContainText("Leader");
  await page.getByRole("link", { name: "All gangs" }).click();
  await expect(page.getByRole("link", { name: "Masonry gang A" })).toBeVisible();
  await page.getByRole("button", { name: "New gang" }).click();
  const create = page.getByRole("dialog", { name: "Create a gang" });
  await create.getByLabel("Gang name").fill("Carpentry gang");
  await create.getByRole("button", { name: "New gang" }).click();
  await expect(page.getByRole("heading", { name: "Carpentry gang", level: 1 })).toBeVisible();
  await expect(page.getByText("No members.")).toBeVisible();

  await page.getByRole("button", { name: "Add member" }).click();
  const add = page.getByRole("dialog", { name: "Add member" });
  await add.getByLabel("Worker").selectOption({ label: "WRK-0003 · Grace Atieno Odhiambo" });
  await add.getByRole("button", { name: "Add member" }).click();
  const members = page.getByRole("table", { name: "Current members" });
  await expect(members.getByRole("row", { name: /Grace Atieno Odhiambo/ })).toBeVisible();
  await members.getByRole("button", { name: /^Make leader\s*: Grace Atieno Odhiambo$/ }).click();
  await expect(members.getByRole("row", { name: /Grace Atieno Odhiambo/ })).toContainText("Leader");
  expect(await axeViolations(page)).toEqual([]);

  await members.getByRole("button", { name: /^Record leaving\s*: Grace Atieno Odhiambo$/ }).click();
  const leave = page.getByRole("dialog", { name: "Grace Atieno Odhiambo leaves the gang" });
  await leave.getByRole("button", { name: "Record leaving" }).click();
  await expect(leave.getByRole("alert")).toHaveText(
    "Choose another leader before the leader leaves.",
  );
});

test("configures trades, the NCA lead time and effective-dated rates", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  const today = nairobiDate();
  await page.goto("/labour/setup");
  await expect(page.getByRole("heading", { name: "Trades & rates", level: 1 })).toBeVisible();
  await expect(page.getByText(/COMPLIANCE-REVIEW \(CR-PAY-09\)/)).toBeVisible();
  await expect(page.getByRole("table", { name: "Trades" }).getByRole("row")).toHaveCount(4);
  await page.getByRole("button", { name: "Add trade" }).click();
  const trade = page.getByRole("dialog", { name: "Add trade" });
  await trade.getByLabel("Key").fill("plumber");
  await trade.getByLabel("Name in English").fill("Plumber");
  await trade.getByLabel("Name in Kiswahili").fill("Fundi bomba");
  await trade.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("table", { name: "Trades" }).getByRole("row")).toHaveCount(5);

  await page.getByLabel("Alert lead time (days)").fill("45");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  const rates = page.getByRole("table", { name: "Pay rates" });
  await expect(rates.getByRole("row", { name: /KES 1,500/ })).toContainText("In force");
  await expect(rates.getByRole("row", { name: /KES 1,650/ })).toContainText("Scheduled");
  await page.getByRole("button", { name: "Add rate" }).click();
  const rate = page.getByRole("dialog", { name: "Add rate" });
  await rate.getByLabel("Amount (KES)").fill("1,800");
  await rate.getByLabel("Effective from").fill(ddmmyyyy(addCalendarDays(today, -1)));
  await rate.getByRole("button", { name: "Save rate" }).click();
  await expect(rate.getByRole("alert")).toHaveText(
    "A new rate starts today or later; past days keep the rate they had.",
  );
  await rate.getByLabel("Effective from").fill(ddmmyyyy(addCalendarDays(today, 14)));
  await rate.getByRole("button", { name: "Save rate" }).click();
  await expect(rates.getByRole("row", { name: /KES 1,800/ })).toContainText("Scheduled");
  expect(await axeViolations(page)).toEqual([]);

  await rates.getByRole("button", { name: /^Cancel rate\s*: Mason · KES 1,650/ }).click();
  await page
    .getByRole("dialog", { name: "Cancel a scheduled rate" })
    .getByRole("button", { name: "Cancel rate" })
    .click();
  await expect(rates.getByRole("row", { name: /KES 1,650/ })).toHaveCount(0);
});

test("lists expired, expiring and missing NCA accreditation", async ({ page, context }) => {
  await signInAs(context, "owner");
  await page.goto("/labour/alerts");
  await expect(page.getByText("3 alerts")).toBeVisible();
  const alerts = page.getByRole("table", { name: "NCA accreditation alerts" });
  await expect(alerts.getByRole("row", { name: /Joseph Mwangi/ })).toContainText("in 12 days");
  await expect(alerts.getByRole("row", { name: /Grace Atieno/ })).toContainText("6 days ago");
  await expect(alerts.getByRole("row", { name: /Peter Kiprotich/ })).toContainText(
    "NCA card missing",
  );
  await alerts.getByRole("link", { name: "Joseph Mwangi Kariuki" }).click();
  await expect(page.getByRole("dialog", { name: "Joseph Mwangi Kariuki" })).toBeVisible();
});

test("keeps the registry from a site agent without labour permissions", async ({
  page,
  context,
}) => {
  await signInAs(context, "agent");
  for (const path of ["/labour", "/labour/register", "/labour/gangs", "/labour/setup"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "You do not have access" }), path).toBeVisible();
  }
});

const pages = [
  "/labour",
  `/labour?worker=${AMINA}`,
  "/labour/register",
  `/labour/${AMINA}/consent`,
  "/labour/gangs",
  `/labour/gangs/${GANG}`,
  "/labour/setup",
  "/labour/alerts",
];

for (const locale of ["en", "sw"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`labour pages are accessible in ${locale}, ${theme}`, async ({ page, context }) => {
      await signInAs(context, "owner");
      await preferences(context, page, locale, theme);
      for (const path of pages) {
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
        // The worker panel is modal, so the page behind it is hidden from assistive technology.
        if (path.includes("worker=")) await expect(page.getByRole("dialog")).toBeVisible();
        else await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await axeViolations(page), path).toEqual([]);
      }
    });
  }
}

test("labour pages fit a 360 px Android viewport", async ({ page, context }) => {
  await signInAs(context, "owner");
  await page.setViewportSize({ width: 360, height: 740 });
  for (const path of pages.filter((entry) => !entry.includes("worker="))) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      path,
    ).toBe(true);
  }
});
