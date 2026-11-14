import { expect as baseExpect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  axeViolations,
  MOCK_CSRF,
  MOCK_STEP_UP_CODE,
  preferences,
  RUIRU_ID,
  signInAs,
  switchPersona,
  type Persona,
} from "./live-helpers";

/**
 * D6.3 part B subcontracts and piece-rate jobs against test/mock-api.mts
 * (test/mock-subcontracts.mts), at 360 px. Ruiru Heights: SC-0001 labour-only plastering
 * (D 450 m² @ 280 = 126,000; SCC-0001 certified: work 56,000, retention 2,800, recovery 11,200,
 * due 42,000, WHT 1,260, payable 40,740, 20,000 paid); SC-0002 supply-and-fix windows
 * (E 36 m² @ 8,200 = 295,200, VAT 16 %, retention 10 % limited to 5 %) with a draft certificate.
 * Worked by hand for SC-0002 at 12 m² measured: work 98,400; retention 9,840; due 88,560;
 * VAT 14,169.60; payable 102,729.60. PRJ-0001: Gang B walling @ 150/m², 100 m² agreed, 96 m²
 * approved against 80 m² measured → flagged as paid above measured.
 * Synthetic data only.
 */
const expect = baseExpect.configure({ timeout: 20_000 });
test.describe.configure({ timeout: 300_000 });

const SC1_ID = "88200000-0000-4000-8000-000000000001";
const SCV2_ID = "88300000-0000-4000-8000-000000000002";
const JOB1_ID = "88400000-0000-4000-8000-000000000001";
const ITEM_C = "88100000-0000-4000-8000-000000000003";

async function api(page: Page, method: string, path: string, data?: object) {
  const res = await page.request.fetch(`/api/v1${path}`, {
    method,
    headers: { "X-CSRF-Token": MOCK_CSRF, "Content-Type": "application/json" },
    data,
  });
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

async function as(context: BrowserContext, page: Page, persona: Persona, token: string) {
  await switchPersona(context, persona, token);
  if (persona !== "agent") {
    const stepped = await api(page, "POST", "/auth/mfa/step-up", { code: MOCK_STEP_UP_CODE });
    expect(stepped.status).toBe(200);
  }
  await page.reload();
}

/** Opens a command's confirmation (once hydrated), fills its inputs and confirms it. */
async function command(page: Page, button: string, confirm: string, reason?: string) {
  const dialog = page.getByRole("dialog").last();
  await expect(async () => {
    await page.getByRole("button", { name: button, exact: true }).first().click();
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }).toPass();
  if (reason) await dialog.getByRole("textbox").fill(reason);
  await dialog.getByRole("button", { name: confirm, exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function expectClean(page: Page, label: string) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `${label}: no horizontal scroll`,
  ).toBe(true);
  await expect(page.locator("#main")).not.toContainText(/subcontracts\.[a-zA-Z]/);
  expect(await axeViolations(page), `${label}: axe`).toEqual([]);
}

test("subcontracts: a certificate generates from measured progress and is certified by finance on the digest, then paid by someone else", async ({
  page,
  context,
}) => {
  await preferences(context, page);
  const token = await signInAs(context, "pm");
  await page.setViewportSize({ width: 360, height: 800 });

  await page.goto("/subcontracts");
  await expect(page.getByRole("heading", { level: 1, name: "Subcontracts" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "RUI-HTS · Ruiru Heights Apartments" }).first(),
  ).toBeVisible();
  await expect(page.getByText("Kamau Plastering").first()).toBeVisible();
  await expectClean(page, "/subcontracts");

  await page.goto(`/subcontracts/projects/${RUIRU_ID}`);
  const table = page.getByRole("region", { name: "Subcontracts on this project" });
  await expect(table.getByRole("row", { name: /SC-0001/ })).toContainText("KES 126,000");
  await expect(table.getByRole("row", { name: /SC-0002/ })).toContainText("KES 295,200");
  await expectClean(page, "project subcontracts");

  await page.goto(`/subcontracts/${SC1_ID}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "SC-0001 · Internal plastering (labour only)" }),
  ).toBeVisible();
  const statement = page.getByRole("region", { name: "Statement" });
  for (const [label, amount] of [
    ["Work certified", "KES 56,000"],
    ["Payable", "KES 40,740"],
    ["Paid", "KES 20,000"],
    ["Retention held", "KES 2,800"],
    ["Advances outstanding", "KES 8,800"],
  ] as const)
    await expect(statement).toContainText(`${label}${amount}`);
  await expect(page.getByRole("link", { name: "Statement PDF (English)" })).toBeVisible();
  await expectClean(page, "subcontract");

  // The windows certificate: claim the 12 m² measured; a claim above the line is refused.
  await page.goto(`/subcontracts/certificates/${SCV2_ID}`);
  await expect(
    page.getByRole("heading", { level: 1, name: /SCV-0001 \(not certified\)/ }),
  ).toBeVisible();
  const claim = page.getByLabel(/^1\. E /);
  await expect(async () => {
    await claim.fill("37");
    await page.getByRole("button", { name: "Save quantities" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "above the line's quantity" }),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await claim.fill("12");
  await page.getByRole("button", { name: "Save quantities" }).click();
  const summary = page.getByRole("region", { name: "Certificate" });
  for (const [row, amount] of [
    [/^Work done to date/, "KES 98,400"],
    [/^Retention 10 %/, "KES 9,840"],
    [/^Amount due/, "KES 88,560"],
    [/^VAT 16 %/, "KES 14,169.60"],
    [/^Payable/, "KES 102,729.60"],
  ] as const)
    await expect(summary.getByRole("row", { name: row })).toContainText(amount);
  await expectClean(page, "draft certificate");
  await command(page, "Submit", "Submit");
  await expect(page.getByText("Submitted", { exact: true }).first()).toBeVisible();
  // The preparer holds no finance.manage: no certify button.
  await expect(page.getByRole("button", { name: "Certify" })).toHaveCount(0);

  // Finance certifies on the digest it saw, after a step-up; it never records the payment.
  await as(context, page, "finance", token);
  await command(page, "Certify", "Certify");
  await expect(page.getByRole("heading", { level: 1, name: /^SCC-0001 ·/ })).toBeVisible();
  await expect(page.getByText(/Certified by Daniel Mwangi/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Record a payment" })).toHaveCount(0);
  const pdf = await page.getByRole("link", { name: "PDF (English)" }).getAttribute("href");
  const download = await page.request.get(pdf!);
  expect(download.status()).toBe(200);
  expect(download.headers()["content-type"]).toContain("application/pdf");

  // Someone else records the payment made outside PM-Buddy.
  await as(context, page, "owner", token);
  await expect(async () => {
    await page.getByLabel("Amount (KES)").fill("50000");
    await expect(page.getByLabel("Amount (KES)")).toHaveValue("50000", { timeout: 1_000 });
  }).toPass();
  await page.getByLabel("Reference").fill("EFT-0077");
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText(/KES 50,000 on .* \(EFT-0077\)/)).toBeVisible();
  await expectClean(page, "certified certificate");
});

test("subcontracts: a project manager drafts a subcontract on a BQ item at 360 px; the owner approves it with step-up", async ({
  page,
  context,
}) => {
  await preferences(context, page);
  const token = await signInAs(context, "pm");
  await page.setViewportSize({ width: 360, height: 800 });

  await page.goto(`/subcontracts/projects/${RUIRU_ID}`);
  await expect(page.getByRole("heading", { name: "New subcontract" })).toBeVisible();
  await expect(async () => {
    await page.getByLabel("Title").fill("Walling to the boundary (synthetic)");
    await expect(page.getByLabel("Title")).toHaveValue("Walling to the boundary (synthetic)", {
      timeout: 1_000,
    });
  }).toPass();
  await page.getByLabel("Kind").selectOption("labour_only");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^SC-0003 ·/ })).toBeVisible();
  await expect(page.getByText("Add at least one line before submitting.")).toBeVisible();
  await expectClean(page, "draft subcontract");

  // Item C (walling, 120 m²): above the BQ without a reason is refused, then let at 100 m².
  const form = page.getByRole("heading", { name: "Add a line" }).locator("..");
  await expect(async () => {
    await form.getByLabel("BQ item").selectOption(ITEM_C);
    await form.getByLabel("Quantity").fill("130");
    await form.getByLabel("Rate per unit (KES)").fill("380");
    await form.getByRole("button", { name: "Add line" }).click();
    await expect(form.getByRole("alert").filter({ hasText: "BQ quantity" })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass();
  await form.getByLabel("Quantity").fill("100");
  await form.getByRole("button", { name: "Add line" }).click();
  const lines = page.getByRole("region", { name: "Lines" });
  await expect(lines.getByRole("row").filter({ hasText: "Machine-cut" })).toContainText(
    "KES 38,000",
  );
  await command(page, "Submit for approval", "Submit for approval");
  await expect(
    page.getByText(/waiting for approval by someone who did not prepare it/),
  ).toBeVisible();

  await as(context, page, "owner", token);
  await command(page, "Approve", "Approve");
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  await expectClean(page, "approved subcontract");
});

test("piece-rate: output is recorded against a job at its rate (Kiswahili, 360 px), capped at the agreed quantity; pay above measured is flagged", async ({
  page,
  context,
}) => {
  await preferences(context, page, "sw", "dark");
  const token = await signInAs(context, "pm");
  await page.setViewportSize({ width: 360, height: 800 });

  await page.goto(`/subcontracts/projects/${RUIRU_ID}/piece-rate/output`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Rekodi kazi · RUI-HTS" }),
  ).toBeVisible();
  await expect(page.getByLabel("Kazi", { exact: true })).toHaveValue(JOB1_ID);
  await expect(page.getByText("KES 150 kwa m2")).toBeVisible();
  await expect(page.getByText("Kiwango ni cha kazi; hakiwezi kuandikwa.")).toBeVisible();
  await expectClean(page, "output form");
  // 96 of 100 m² are approved: 5 more is refused, 4 is recorded.
  await expect(async () => {
    await page.getByLabel("Kiasi (m2)").fill("5");
    await page.getByRole("button", { name: "Rekodi kazi" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "nyongeza iliyoidhinishwa" }),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await page.getByLabel("Kiasi (m2)").fill("4");
  await page.getByRole("button", { name: "Rekodi kazi" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Imerekodiwa 4 m2 kwenye PRJ-0001." }),
  ).toBeVisible();

  // Finance sees the reconciliation flag and approves the output (not the recorder).
  await as(context, page, "finance", token);
  await page.goto(`/subcontracts/projects/${RUIRU_ID}/piece-rate`);
  await expect(page.getByText(/Kipengele 1 cha BQ kimelipwa zaidi ya kilichopimwa/)).toBeVisible();
  const reconciliation = page.getByRole("region", { name: "Ulinganisho na vipimo" });
  const walling = reconciliation.getByRole("row").filter({ hasText: "Machine-cut" });
  await expect(walling).toContainText("Imelipwa zaidi ya iliyopimwa");
  await expect(walling).toContainText("16");
  await expectClean(page, "piece-rate jobs");
  await page.goto(`/subcontracts/piece-rate-jobs/${JOB1_ID}`);
  await command(page, "Idhinisha", "Idhinisha");
  await expect(page.getByRole("table", { name: "Kazi iliyofanyika" })).not.toContainText(
    "Inasubiri",
  );
  await expectClean(page, "job");
});
