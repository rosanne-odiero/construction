import { expect as baseExpect, test, type Locator, type Page } from "@playwright/test";
import {
  axeViolations,
  MOCK_CSRF,
  MOCK_STEP_UP_CODE,
  preferences,
  RUIRU_ID,
  signInAs,
  switchPersona,
} from "./live-helpers";

/**
 * D7.1 client portal against test/mock-api.mts (synthetic data): a client on a 360 px phone
 * follows progress, verified photos, site updates, certificates and the statement, sees how to
 * pay by Paybill (Pay with M-Pesa is not offered until D4.2) and decides on a variation; the
 * display currency in Kiswahili; and the staff side (client payments, sending a variation to
 * the client, Paybill instructions and FX rates).
 */
const PORTAL = `/portal/projects/${RUIRU_ID}`;
const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 180_000 });

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** Clicks until the page has hydrated and the navigation or action took effect. */
async function clickUntil(locator: Locator, done: () => Promise<void>) {
  await expect(async () => {
    await locator.click();
    await done();
  }).toPass({ timeout: 30_000 });
}

async function openSection(page: Page, name: string, path: string) {
  const link = page.getByRole("navigation", { name: "Project pages" }).getByRole("link", { name });
  await clickUntil(link, () => expect(page).toHaveURL(path, { timeout: 5_000 }));
}

test("a client follows progress, photos and money and sees how to pay on a 360 px phone", async ({
  page,
  context,
}) => {
  await signInAs(context, "client");
  await preferences(context, page, "en");
  await page.setViewportSize({ width: 360, height: 760 });
  await page.goto("/portal");
  await expect(page.getByRole("heading", { name: "Your projects", level: 1 })).toBeVisible();
  await expect(page.getByText("1 variation awaits your decision")).toBeVisible();
  // KES first, with an indicative conversion in the client's chosen currency (GBP).
  await expect(
    page.getByText(/^≈ GBP [\d,.]+ at 170\.1 KES\/GBP on .+ \(indicative\)$/).first(),
  ).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  await clickUntil(page.getByRole("link", { name: "View progress" }), () =>
    expect(page).toHaveURL(PORTAL, { timeout: 5_000 }),
  );
  await expect(
    page.getByRole("heading", { name: "Ruiru Heights Apartments", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("2.4 percentage points behind plan")).toBeVisible();
  await expect(page.getByText(/IPC-0001 is due on/)).toBeVisible();
  await expect(
    page.getByText("A payment shows here only after the contractor has recorded it", {
      exact: false,
    }),
  ).toBeVisible();
  const update = page.getByRole("article", { name: /Main plot/ });
  await expect(update).toContainText("first-floor columns cast");
  await expect(update).toContainText("Mason 6 · General labour 12");
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  await openSection(page, "Progress", `${PORTAL}/progress`);
  await expect(page.getByRole("heading", { name: "Progress and S-curve", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("img", { name: "S-curve of planned and earned value" }),
  ).toBeVisible();
  await expect(page.getByText(/The contractor's costs are not shown/)).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  await openSection(page, "Photos", `${PORTAL}/photos`);
  await expect(page.getByText("Location and time verified", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Not verified", { exact: true })).toHaveCount(1);
  await expect(page.getByText("No GPS position in the photo")).toBeVisible();
  await expect(page.getByRole("img", { name: "Synthetic: first-floor columns" })).toHaveAttribute(
    "src",
    new RegExp(`/api/v1/portal/client/projects/${RUIRU_ID}/photos/[0-9a-f-]+/image$`),
  );
  await page.getByText("What “verified” means").click();
  await expect(page.getByText(/treat a verified photo as evidence, not proof/)).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  await openSection(page, "Statement", `${PORTAL}/statement`);
  await expect(page.getByText("Overdue by 31 days").first()).toBeVisible();
  await expect(page.getByText("Unpaid").first()).toBeVisible();
  await expect(page.getByText(/Payment for IPC-0001 · M-Pesa Paybill/).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Statement (Excel)" })).toHaveAttribute(
    "href",
    `/api/v1${PORTAL.replace("/portal/", "/portal/client/")}/statement/export/xlsx?locale=en`,
  );
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  await openSection(page, "Pay", `${PORTAL}/pay`);
  await expect(page.getByText("174379").first()).toBeVisible();
  await expect(page.getByText("RUI-HTS-0001")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pay with M-Pesa" })).toBeDisabled();
  await expect(
    page.getByText("Pay with M-Pesa will be available soon; use the Paybill instructions above."),
  ).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  // A project the client is not assigned to does not exist for them.
  await page.goto("/portal/projects/30000000-0000-4000-8000-000000000002/statement");
  await expect(page.getByText(/could not be found|404/i).first()).toBeVisible();
});

test("a client approves a variation once, on the figures shown", async ({ page, context }) => {
  await signInAs(context, "client");
  await preferences(context, page, "en");
  await page.setViewportSize({ width: 360, height: 760 });
  await page.goto(`${PORTAL}/variations`);
  await expect(page.getByText("Awaiting your decision")).toBeVisible();
  await clickUntil(page.getByRole("link", { name: /VO-001/ }), () =>
    expect(page).toHaveURL(new RegExp(`${PORTAL}/variations/[0-9a-f-]+$`), { timeout: 5_000 }),
  );
  await expect(page.getByText("Instruction AI-004: Floor finishes to living rooms")).toBeVisible();
  await expect(page.getByText("Omitted")).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  // A rejection needs a comment; nothing is sent without one.
  await clickUntil(page.getByRole("button", { name: "Reject" }), () =>
    expect(page.getByText("Say why you reject the variation.")).toBeVisible({ timeout: 5_000 }),
  );
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/^Approved by Grace Wambui/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
});

test("the display currency in Kiswahili, and a currency link for one page", async ({
  page,
  context,
}) => {
  await signInAs(context, "client");
  await preferences(context, page, "sw");
  await page.goto("/portal/settings");
  await expect(page.getByRole("heading", { name: "Sarafu ya kuonyesha", level: 1 })).toBeVisible();
  await expect(page.getByText("USD 1 = KES 129.45", { exact: false })).toBeVisible();
  await clickUntil(page.getByLabel("Dola za Marekani (USD)"), () =>
    expect(page.getByLabel("Dola za Marekani (USD)")).toBeChecked({ timeout: 2_000 }),
  );
  await page.getByRole("button", { name: "Hifadhi" }).click();
  await expect(page.getByText("Sarafu ya kuonyesha imehifadhiwa.")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.goto("/portal");
  await expect(
    page.getByText(/^≈ USD [\d,.]+ kwa 129\.45 KES\/USD tarehe .+ \(makadirio\)$/).first(),
  ).toBeVisible();
  await page.goto(`${PORTAL}/statement?currency=EUR`);
  await expect(page.getByText(/^≈ EUR [\d,.]+ kwa 150\.3 KES\/EUR/).first()).toBeVisible();
  await expect(page.getByText("Imepitwa kwa siku 31").first()).toBeVisible();
  await page.goto(`${PORTAL}/statement?currency=KES`);
  await expect(page.getByText(/^≈ /)).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
});

/** Same-origin API calls (through the Next.js rewrite) to set up state quickly. */
async function api(page: Page, method: string, path: string, data?: object) {
  const res = await page.request.fetch(`/api/v1${path}`, {
    method,
    headers: { "X-CSRF-Token": MOCK_CSRF, "Content-Type": "application/json" },
    data,
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

test("finance records and reverses a client payment", async ({ page, context }) => {
  await signInAs(context, "finance");
  await page.goto(`/valuations/projects/${RUIRU_ID}/client`);
  await expect(page.getByRole("heading", { name: "Client payments", level: 1 })).toBeVisible();
  await expect(page.getByText("Paybill account RUI-HTS-0002")).toBeVisible();
  const second = await page
    .locator("#receipt-certificate option", { hasText: "IPC-0002" })
    .getAttribute("value");
  await expect(async () => {
    await page.getByLabel("Certificate", { exact: true }).selectOption(second!);
    await expect(page.getByText(/^At most KES 3,480,000\.$/)).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await page.getByLabel("Amount (KES)").fill("1000000");
  await page.getByLabel("Reference", { exact: true }).fill("SLM9Q2W4ER");
  await page.getByRole("button", { name: "Record payment" }).click();
  const receipts = page.locator("section, [data-slot=card]").filter({
    has: page.getByRole("heading", { name: "Payments recorded" }),
  });
  await expect(receipts.getByText(/SLM9Q2W4ER/)).toBeVisible();
  await expect(page.getByText("Part paid").first()).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await receipts
    .getByRole("listitem")
    .filter({ hasText: "SLM9Q2W4ER" })
    .getByRole("button", { name: "Reverse" })
    .click();
  await page.getByRole("button", { name: "Reverse payment" }).click();
  await expect(page.getByText("Give a reason for the reversal.")).toBeVisible();
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Recorded against the wrong certificate (synthetic)");
  await page.getByRole("button", { name: "Reverse payment" }).click();
  await expect(
    receipts.getByText("Reason: Recorded against the wrong certificate (synthetic)"),
  ).toBeVisible();
  await expect(receipts.getByText("Reversed", { exact: true })).toHaveCount(1);
  expect(await axeViolations(page)).toEqual([]);
});

test("a PM sends a submitted variation to the client; the owner keeps Paybill and FX settings", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "owner");
  const BQ = `/projects/${RUIRU_ID}/bq`;
  await api(page, "POST", "/auth/mfa/step-up", { code: MOCK_STEP_UP_CODE });
  const { versions } = (await api(page, "GET", `${BQ}/versions`)) as {
    versions: { id: string; version: number }[];
  };
  await api(page, "POST", `${BQ}/versions/${versions[0]!.id}/approve`, {
    version: versions[0]!.version,
  });
  const { instruction } = (await api(page, "POST", `${BQ}/instructions`, {
    number: "AI-001",
    issuedOn: "2026-11-02",
    issuerName: "Arch. Achieng Otieno",
    issuerRole: "architect",
    subject: "Deeper column bases (synthetic)",
  })) as { instruction: { id: string } };
  const view = (await api(page, "GET", BQ)) as { bq: { bills: { id: string }[] } };
  const bill = (await api(page, "GET", `${BQ}/bills/${view.bq.bills[1]!.id}`)) as {
    items: { lineageId: string }[];
  };
  let { variation } = (await api(page, "POST", `${BQ}/variations`, {
    instructionId: instruction.id,
    title: "Deeper column bases (synthetic)",
  })) as { variation: { id: string; version: number } };
  ({ variation } = (await api(page, "PUT", `${BQ}/variations/${variation.id}/lines`, {
    lines: [{ action: "adjust", itemLineageId: bill.items[1]!.lineageId, quantity: "342.75" }],
    version: variation.version,
  })) as { variation: { id: string; version: number } });
  await api(page, "POST", `${BQ}/variations/${variation.id}/submit`, {
    version: variation.version,
  });

  await switchPersona(context, "pm", token);
  await page.goto(`${BQ}/variations/${variation.id}`);
  const panel = page.locator("[data-slot=card]").filter({
    has: page.getByRole("heading", { name: "Client approval" }),
  });
  await expect(panel.getByText("Not sent to the client.")).toBeVisible();
  await panel.getByLabel("Message to the client (optional)").fill("Please confirm (synthetic).");
  await clickUntil(panel.getByRole("button", { name: "Send to client" }), () =>
    expect(panel.getByText(/^Sent by Brian Otieno/)).toBeVisible({ timeout: 5_000 }),
  );
  await expect(panel.getByText("Awaiting your decision")).toBeVisible();
  await expect(
    panel.getByText("This submission has already been sent to the client."),
  ).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await switchPersona(context, "owner", token);
  await page.goto("/valuations/client-portal");
  await expect(
    page.getByRole("heading", { name: "Client portal settings", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(/Pay with M-Pesa \(STK Push\) is not available yet/)).toBeVisible();
  await page.getByLabel("KES per 1 USD").fill("130.2");
  await page.getByLabel("Source").fill("CBK indicative rate (synthetic)");
  await page.getByRole("button", { name: "Add rate" }).click();
  await expect(page.getByText(/Current: 1 USD = 130\.2 KES on/)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});
