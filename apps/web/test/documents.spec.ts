import { expect, test, type Page } from "@playwright/test";
import { axeViolations, preferences, RUIRU_ID, signInAs, switchPersona } from "./live-helpers";

/**
 * D8.4 documents, compliance register, instructions and approval requests against
 * test/mock-api.mts (mock-documents.mts applies the shared domain rules and returns the shared
 * response schemas). The done-when: (a) an expiring item raises a reminder and an expired one
 * shows expired, (b) a superseded drawing is never shown as current. Also: a site agent records
 * an instruction on a phone in Kiswahili and dark mode without seeing commercial documents, and a
 * project manager records a consultant's paper response to their own request. Axe-clean, no
 * sideways scrolling at 360 px.
 */
const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const nairobiToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" }).format(new Date());
const plusDays = (date: string, days: number) => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
};
const pdf = (label: string) =>
  Buffer.from(`%PDF-1.4\n1 0 obj << /Title (${label}) >> endobj\ntrailer << >>\n%%EOF\n`, "latin1");

test("a superseded drawing is never shown as current; a new revision supersedes it", async ({
  page,
  context,
}) => {
  test.slow();
  await signInAs(context, "pm");
  await page.goto(`/projects/${RUIRU_ID}?tab=documents&view=drawings`);
  await expect(page.getByRole("heading", { name: "Documents", level: 2 })).toBeVisible();
  const register = page.getByRole("table", { name: "Drawing register" });
  const a101 = register.getByRole("row").filter({ hasText: "A-101" });
  await expect(a101).toContainText("Ground floor plan");
  await expect(a101).toContainText("Current");
  await expect(a101).not.toContainText("P2");
  await expect(register).not.toContainText("Superseded");
  await expect(register.getByRole("row").filter({ hasText: "S-201" })).toContainText(
    "Download rev. B",
  );
  expect(await axeViolations(page)).toEqual([]);

  await expect(async () => {
    await register.getByRole("link", { name: "A-101" }).click();
    await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}$/, { timeout: 2_000 });
  }).toPass();
  await expect(
    page.getByRole("heading", { name: "A-101 · Ground floor plan", level: 1 }),
  ).toBeVisible();
  const current = page.getByTestId("current-version");
  await expect(current).toContainText("Rev. A");
  await expect(current).toContainText("Current");
  const superseded = page.getByTestId("version-list").locator('tr[data-state="superseded"]');
  await expect(superseded).toHaveCount(2);
  for (const row of await superseded.all()) {
    await expect(row).toContainText("Superseded");
    await expect(row).toContainText("Do not use this version.");
  }
  expect(await axeViolations(page)).toEqual([]);

  // A CAD file is refused by content; the issued PDF is accepted and becomes current.
  await page.getByRole("button", { name: "Upload a new version" }).click();
  const dialog = page.getByRole("dialog", { name: "Upload a new version" });
  await expect(dialog.getByLabel("Revision")).toHaveValue("B");
  await dialog.getByLabel("What changed").fill("Kitchen window widened to 1.5 m");
  await dialog.getByLabel("File").setInputFiles({
    name: "A-101.dwg",
    mimeType: "application/acad",
    buffer: Buffer.from("AC1032 synthetic drawing"),
  });
  await dialog.getByRole("button", { name: "Upload" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "CAD files (DWG, DXF) must be uploaded as the issued PDF.",
  );
  await dialog.getByLabel("File").setInputFiles({
    name: "A-101_B.pdf",
    mimeType: "application/pdf",
    buffer: pdf("A-101 B"),
  });
  await dialog.getByRole("button", { name: "Upload" }).click();
  await expect(dialog).toBeHidden();
  await expect(current).toContainText("Rev. B");
  await expect(superseded).toHaveCount(3);
  await expect(
    page.getByTestId("version-list").getByRole("row").filter({ hasText: "Version 3" }),
  ).toContainText("Superseded by rev. B");

  await page.goto(`/projects/${RUIRU_ID}?tab=documents&view=drawings`);
  const row = page
    .getByRole("table", { name: "Drawing register" })
    .getByRole("row")
    .filter({ hasText: "A-101" });
  await expect(row).toContainText("Download rev. B");
  await expect(row).not.toContainText("rev. A");
});

test("an expiring item raises a reminder, an expired one shows expired, and a renewal clears it", async ({
  page,
  context,
}) => {
  test.slow();
  const token = await signInAs(context, "pm");
  await page.goto(`/projects/${RUIRU_ID}?tab=compliance`);
  await expect(page.getByRole("heading", { name: "Compliance register", level: 2 })).toBeVisible();
  const register = page.getByRole("table", { name: "Compliance register" });
  const car = register.getByRole("row").filter({ hasText: "Contractor's All Risk insurance" });
  await expect(car).toContainText("Expiring");
  await expect(car).toContainText("12 days left");
  const osh = register.getByRole("row").filter({ hasText: "OSH workplace registration (DOSHS)" });
  await expect(osh).toContainText("Expired");
  await expect(osh).toContainText("Expired 5 days ago");
  await expect(register.getByRole("row").filter({ hasText: "Site signboard" })).toContainText(
    "Missing",
  );
  await expect(register.getByRole("row").filter({ hasText: "NEMA licence / EIA" })).toContainText(
    "Not applicable",
  );
  const reminders = page.getByTestId("document-reminders");
  await expect(
    reminders.getByRole("listitem").filter({ hasText: "Contractor's All Risk insurance" }),
  ).toContainText("Expiring");
  await expect(
    reminders.getByRole("listitem").filter({ hasText: "OSH workplace registration" }),
  ).toContainText("Expired");
  await expect(page.getByRole("link", { name: "PDF", exact: true })).toHaveAttribute(
    "href",
    `/api/v1/projects/${RUIRU_ID}/compliance/export/pdf?locale=en`,
  );
  await expect(page.getByRole("link", { name: "Excel", exact: true })).toHaveAttribute(
    "href",
    `/api/v1/projects/${RUIRU_ID}/compliance/export/xlsx?locale=en`,
  );
  expect(await axeViolations(page)).toEqual([]);

  // The project overview and the company-wide list show the same reminders.
  await page.goto(`/projects/${RUIRU_ID}`);
  await expect(page.getByTestId("documents-summary")).toContainText(
    "1 expired · 2 expiring · 1 missing",
  );
  await page.goto("/documents");
  await expect(
    page.getByRole("heading", { name: "Documents and compliance", level: 1 }),
  ).toBeVisible();
  const overview = page.getByTestId("document-reminders");
  await expect(overview.getByRole("listitem").filter({ hasText: "WIBA insurance" })).toContainText(
    "Company",
  );
  await expect(
    overview.getByRole("listitem").filter({ hasText: "OSH workplace registration" }),
  ).toContainText("RUI-HTS");
  await expect(overview.getByRole("listitem").filter({ hasText: "APR-0001" })).toContainText(
    "Approval overdue",
  );
  expect(await axeViolations(page)).toEqual([]);

  // Renewing the expired item supersedes the old record and the status becomes valid.
  await page.goto(`/projects/${RUIRU_ID}?tab=compliance`);
  await expect(async () => {
    await page.getByRole("link", { name: /^Renew · OSH workplace registration/ }).click();
    await expect(page).toHaveURL(/\/compliance\/[0-9a-f-]{36}$/, { timeout: 2_000 });
  }).toPass();
  await expect(
    page.getByRole("heading", { name: "OSH workplace registration (DOSHS)", level: 1 }),
  ).toBeVisible();
  await expect(page.getByTestId("compliance-status")).toContainText("Expired");
  const today = nairobiToday();
  await page.getByLabel("Reference number").fill("DOSHS/WP/2026/1204");
  await page.getByLabel("Issued by").fill("DOSHS");
  await page.getByLabel("Issue date").fill(today);
  await page.getByLabel("Expiry date").fill(plusDays(today, 365));
  await page.getByRole("button", { name: "Save record" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Recorded." })).toBeVisible();
  await expect(page.getByTestId("compliance-status")).toContainText("Valid");
  await expect(page.locator('[data-state="superseded"]')).toContainText("DOSHS/WP/2025/0931");
  expect(await axeViolations(page)).toEqual([]);

  // Item types: the owner adds one; a project manager only reads them.
  await page.goto("/documents/compliance-types");
  await expect(page.getByText("Only someone who manages company settings")).toBeVisible();
  await switchPersona(context, "owner", token);
  await page.goto("/documents/compliance-types");
  await expect(async () => {
    await page.getByRole("button", { name: "Add an item type" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await page.getByRole("dialog").getByLabel("Name").fill("Hoarding licence");
  await page
    .getByRole("dialog")
    .getByLabel(/Remind this many days/)
    .fill("14");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("table", { name: "Compliance item types" }).getByRole("row", {
      name: /Hoarding licence/,
    }),
  ).toContainText("14 days before");
  expect(await axeViolations(page)).toEqual([]);
});

test("a site agent records and acknowledges an instruction on a phone in Kiswahili", async ({
  page,
  context,
}) => {
  test.slow();
  await preferences(context, page, "sw", "dark");
  await signInAs(context, "agent");
  await page.setViewportSize({ width: 360, height: 800 });
  // No commercial terms: contracts and insurance policies are not listed, and no upload.
  await page.goto(`/projects/${RUIRU_ID}?tab=documents`);
  await expect(page.getByRole("heading", { name: "Nyaraka", level: 2 })).toBeVisible();
  await expect(page.getByText(/Mikataba, BQ na hati za bima zinaonyeshwa tu/)).toBeVisible();
  await expect(page.getByText("Main contract (JBC 2017)")).toHaveCount(0);
  await expect(page.getByText("Contractor's All Risk policy")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Pakia hati" })).toHaveCount(0);
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  // The register's last column (with screen-reader text) scrolls inside its table, not the page.
  await page.goto(`/projects/${RUIRU_ID}?tab=compliance`);
  await expect(
    page.getByRole("heading", { name: "Rejista ya utii wa sheria", level: 2 }),
  ).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  await page.goto(`/projects/${RUIRU_ID}?tab=instructions`);
  await expect(async () => {
    await page.getByRole("link", { name: "Rekodi agizo" }).click();
    await expect(page).toHaveURL(/\/instructions\/new$/, { timeout: 2_000 });
  }).toPass();
  await expect(page.getByRole("heading", { name: "Rekodi agizo", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Namba")).toHaveValue("AI-002");
  await page.getByLabel("Limetolewa na (jina)").fill("Arch. Njeri Mwangi");
  await page.getByLabel("Mada", { exact: true }).fill("Raise the parapet to 1.1 m");
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Rekodi agizo" }).click();
  await expect(
    page.getByRole("heading", { name: "AI-002 · Raise the parapet to 1.1 m", level: 1 }),
  ).toBeVisible();
  await expect(page.locator("#main")).toContainText("Limepokelewa");

  await page.getByRole("button", { name: "Kiri", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Maelezo (si lazima)").fill("Tutaanza Jumatatu.");
  await dialog.getByRole("button", { name: "Hifadhi" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("instruction-responses")).toContainText("Tutaanza Jumatatu.");
  await expect(page.locator("#main")).toContainText("Limekiriwa");
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
});

test("a raiser cannot answer their own request but records the consultant's paper response", async ({
  page,
  context,
}) => {
  test.slow();
  await signInAs(context, "pm");
  await page.goto(`/projects/${RUIRU_ID}?tab=instructions&view=approvals`);
  const list = page.getByRole("table", { name: "Approval requests" });
  await expect(list.getByRole("row").filter({ hasText: "APR-0001" })).toContainText(
    "3 days overdue",
  );
  expect(await axeViolations(page)).toEqual([]);

  await expect(async () => {
    await page.getByRole("link", { name: "Ask for approval" }).click();
    await expect(page).toHaveURL(/\/approvals\/new$/, { timeout: 2_000 });
  }).toPass();
  await page
    .getByLabel("Document (current version)")
    .selectOption({ label: "A-101 · Ground floor plan · Rev. A" });
  await page.getByLabel("Subject").fill("Ground floor plan for approval");
  await page
    .getByLabel("Sent to (consultant and firm)")
    .fill("Arch. Njeri Mwangi, Mwangi Associates");
  await page.getByRole("button", { name: "Record request" }).click();
  await expect(
    page.getByRole("heading", { name: "APR-0002 · Ground floor plan for approval", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText("You raised this request, so someone else must answer it."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Answer this request" })).toHaveCount(0);
  const digest = (await page.getByTestId("approval-digest").textContent())!.trim();
  expect(digest).toMatch(/^[0-9a-f]{64}$/);

  // The consultant's signed answer is scanned and uploaded after the request (D-117): older files
  // are not offered as its evidence.
  const approvalUrl = page.url();
  const scanChoice = page.getByLabel("Scan of the signed response");
  await expect(scanChoice.locator("option", { hasText: "County building approval" })).toHaveCount(
    0,
  );
  await page.goto(`/projects/${RUIRU_ID}/documents/new`);
  await expect(async () => {
    await page.getByLabel("Category").selectOption("correspondence");
    await expect(page.getByLabel("Category")).toHaveValue("correspondence", { timeout: 2_000 });
  }).toPass();
  await page.getByLabel("Title").fill("Signed response to APR-0002 (scan)");
  await page.getByLabel("Revision").fill("1");
  await page.getByLabel("File").setInputFiles({
    name: "apr-0002-signed.pdf",
    mimeType: "application/pdf",
    buffer: pdf("APR-0002 signed"),
  });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}$/);
  await page.goto(approvalUrl);

  await page.getByLabel("Decision").selectOption("approved_with_comments");
  await page.getByLabel("Consultant's name").fill("Arch. Njeri Mwangi");
  await page
    .getByLabel("Scan of the signed response")
    .selectOption({ label: "Signed response to APR-0002 (scan) · Rev. 1" });
  await page.getByLabel("Comments").fill("Approved; show the stair nosing detail.");
  await page.getByRole("button", { name: "Record the answer" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "I reviewed the file with this fingerprint.",
  );
  await page.getByLabel(/I reviewed the file with this fingerprint/).check();
  await page.getByRole("button", { name: "Record the answer" }).click();
  const response = page.getByTestId("approval-response");
  await expect(response).toContainText("Approved with comments");
  await expect(response).toContainText(
    "Paper response from Arch. Njeri Mwangi, recorded by Brian Otieno",
  );
  await expect(response).toContainText(digest);
  expect(await axeViolations(page)).toEqual([]);
});
