import { expect, test } from "@playwright/test";
import { axeViolations, preferences, RUIRU_ID, signInAs, switchPersona } from "./live-helpers";

/** Worker ratings (D3.5) rendered from test/mock-api.mts and test/mock-ratings.mts (today 10/11/2026). */

const AMINA = "42000000-0000-4000-8000-000000000001";
const sheet = (date: string) => `/labour/ratings?project=${RUIRU_ID}&date=${date}`;

test("a site agent rates the day's workers and corrects their own rating that day", async ({
  page,
  context,
}) => {
  await signInAs(context, "agent");
  await page.goto("/labour/ratings");
  await expect(page).toHaveURL(sheet("2026-11-10"));
  await expect(page.getByRole("heading", { name: "Worker ratings", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ratings", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page.getByText("You can rate today and the six days before (04/11/2026 to 10/11/2026)."),
  ).toBeVisible();
  const table = page.getByRole("table", {
    name: "Workers who worked on RUI-HTS Ruiru Heights Apartments on 10/11/2026",
  });
  await expect(table.getByRole("row")).toHaveCount(5);
  // Someone else rated Joseph today: the agent sees it but cannot change it.
  const joseph = table.getByRole("row", { name: /Joseph Mwangi Kariuki/ });
  await expect(joseph).toContainText("Brian Otieno");
  await expect(joseph).toContainText("4.5");
  await expect(joseph.getByRole("button")).toHaveCount(0);
  const amina = table.getByRole("row", { name: /Amina Wekesa Njoroge/ });
  await expect(amina).toContainText("Not rated");
  await expect(amina).toContainText("Main plot");
  expect(await axeViolations(page)).toEqual([]);

  await amina.getByRole("button", { name: "Rate Amina Wekesa Njoroge" }).click();
  const dialog = page.getByRole("dialog", { name: "Rate Amina Wekesa Njoroge" });
  await expect(dialog).toContainText("10/11/2026 on RUI-HTS Ruiru Heights Apartments");
  await expect(dialog.getByText("Score all four before saving.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save rating" })).toBeDisabled();
  await dialog
    .getByRole("radiogroup", { name: "Punctuality" })
    .getByRole("radio", { name: "5 – Excellent" })
    .click();
  // The stars are a radio group: arrow keys move between scores (a key held briefly, as people do).
  const quality = dialog.getByRole("radiogroup", { name: "Work quality" });
  await quality.getByRole("radio", { name: "3 – Good" }).click();
  await page.keyboard.press("ArrowRight", { delay: 100 });
  await expect(quality.getByRole("radio", { name: "4 – Very good" })).toBeChecked();
  await dialog
    .getByRole("radiogroup", { name: "Safety" })
    .getByRole("radio", { name: "4 – Very good" })
    .click();
  await dialog
    .getByRole("radiogroup", { name: "Teamwork" })
    .getByRole("radio", { name: "5 – Excellent" })
    .click();
  await expect(dialog.getByText("They do not see your name.", { exact: false })).toBeVisible();
  await dialog.getByLabel("Comment (optional)").fill("  Alisaidia wenzake leo.  ");
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Save rating" }).click();
  await expect(dialog).toBeHidden();
  await expect(amina).toContainText("4.5");
  await expect(amina).toContainText("“Alisaidia wenzake leo.”");
  await expect(amina).toContainText("Kevin Kiprono");

  await amina.getByRole("button", { name: "Change the rating for Amina Wekesa Njoroge" }).click();
  const change = page.getByRole("dialog", { name: "Change the rating for Amina Wekesa Njoroge" });
  const punctuality = change.getByRole("radiogroup", { name: "Punctuality" });
  await expect(punctuality.getByRole("radio", { name: "5 – Excellent" })).toBeChecked();
  await punctuality.getByRole("radio", { name: "3 – Good" }).click();
  await change.getByLabel("Comment (optional)").fill("");
  await change.getByRole("button", { name: "Save changes" }).click();
  await expect(change).toBeHidden();
  await expect(amina).toContainText("4.0");
  await expect(amina).toContainText("changed");
  await expect(amina).not.toContainText("Alisaidia");
});

test("on a phone each worker is a card with its Rate button in reach (Kiswahili, dark)", async ({
  page,
  context,
}) => {
  await signInAs(context, "agent");
  await preferences(context, page, "sw", "dark");
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(sheet("2026-11-10"));
  const cards = page.getByRole("list", { name: /RUI-HTS Ruiru Heights Apartments/ });
  const joseph = cards.getByRole("listitem").filter({ hasText: "Joseph Mwangi Kariuki" });
  await expect(joseph).toContainText("Brian Otieno");
  await expect(joseph).toContainText("4.5");
  await expect(joseph.getByRole("button")).toHaveCount(0);
  const rate = cards.getByRole("button", { name: "Tathmini Amina Wekesa Njoroge" });
  const box = (await rate.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await fits()).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await rate.click();
  await expect(page.getByRole("dialog", { name: "Tathmini Amina Wekesa Njoroge" })).toBeVisible();
  expect(await fits()).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
});

test("past days: the seven-day window, two sites in a day and other people's ratings", async ({
  page,
  context,
}) => {
  await signInAs(context, "agent");
  await page.goto(sheet("2026-11-06"));
  const table = page.getByRole("table", { name: /on 06\/11\/2026$/ });
  await expect(table.getByRole("row", { name: /Joseph Mwangi Kariuki/ })).toContainText(
    "Main plot, Materials yard",
  );
  const amina = table.getByRole("row", { name: /Amina Wekesa Njoroge/ });
  await expect(amina).toContainText("Brian Otieno");
  await expect(amina).toContainText("“Kazi nzuri kwenye ukuta.”");
  await expect(amina.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Rate Joseph Mwangi Kariuki" })).toBeVisible();

  // A day typed as DD/MM/YYYY becomes the canonical address.
  await page.getByLabel("Day", { exact: true }).fill("03/11/2026");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page).toHaveURL(sheet("2026-11-03"));
  await expect(
    page.getByRole("status").filter({ hasText: "This day can no longer be rated" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Rate / })).toHaveCount(0);
  await page.getByRole("link", { name: "04/11/2026" }).click();
  await expect(page).toHaveURL(sheet("2026-11-04"));
  await expect(page.getByRole("button", { name: "Rate Joseph Mwangi Kariuki" })).toBeVisible();
});

test("the worker panel shows a worker's ratings; finance cannot rate", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "owner");
  await page.goto(`/labour?worker=${AMINA}`);
  const ratings = page.getByRole("dialog").getByRole("region", { name: "Ratings" });
  await expect(ratings).toContainText("4.1 out of 5 from 2 ratings");
  const averages = ratings.locator("dl");
  for (const [criterion, value] of [
    ["Punctuality", "3.5"],
    ["Work quality", "4.5"],
    ["Safety", "4.5"],
    ["Teamwork", "4.0"],
  ] as const)
    await expect(averages.locator("div").filter({ hasText: criterion })).toContainText(value);
  await expect(ratings.getByRole("listitem").first()).toContainText("06/11/2026");
  await expect(ratings).toContainText("“Kazi nzuri kwenye ukuta.”");
  await expect(ratings.getByRole("link", { name: "Rate workers" })).toHaveAttribute(
    "href",
    "/labour/ratings",
  );
  expect(await axeViolations(page)).toEqual([]);

  // Finance views workers company-wide but holds no labour.rate (the API e2e covers its reads).
  await switchPersona(context, "finance", token);
  await page.goto("/labour/ratings");
  await expect(page.getByRole("heading", { name: "You do not have access" })).toBeVisible();
});

for (const locale of ["en", "sw"] as const)
  test(`labourers see their own ratings without who gave them (${locale})`, async ({
    page,
    context,
  }) => {
    await signInAs(context, "labourer");
    await preferences(context, page, locale);
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/worker");
    const title = locale === "en" ? "My ratings" : "Tathmini zangu";
    const card = page.locator("[data-slot=card]").filter({
      has: page.getByRole("heading", { name: title, level: 2 }),
    });
    await expect(card).toContainText(
      locale === "en" ? "4.1 out of 5 from 2 ratings" : "4.1 kati ya 5 kutoka tathmini 2",
    );
    await expect(card).toContainText("“Ulifanya kazi nzuri kwenye ngazi.”");
    await expect(card).toContainText(
      locale === "en"
        ? "Punctuality 5 · Work quality 4 · Safety 5 · Teamwork 4"
        : "Kufika kwa wakati 5 · Ubora wa kazi 4 · Usalama 5 · Ushirikiano 4",
    );
    await expect(card).not.toContainText(/Brian|Kevin|Wanjiru/);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(await axeViolations(page)).toEqual([]);
  });
