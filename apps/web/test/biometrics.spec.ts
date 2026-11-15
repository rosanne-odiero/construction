import { expect, test, type Page } from "@playwright/test";
import {
  axeViolations,
  MAIN_PLOT_ID,
  MOCK_CSRF,
  MOCK_STEP_UP_CODE,
  preferences,
  signInAs,
} from "./live-helpers";

/**
 * D3.4 DPIA gate against test/mock-api.mts (mock-biometrics.mts applies the shared domain rules
 * and returns the shared response schemas). The done-when for this slice: biometric capture cannot
 * be switched on until the company's signed DPIA is approved in the app, and then only for the
 * sites and methods it covers; withdrawing it stops every site at once. Axe-clean in EN/SW and
 * light/dark, no sideways scrolling at 360 px.
 */
const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const pad = (value: number) => String(value).padStart(2, "0");
const typed = (days: number) => {
  const date = new Date(Date.now() + days * 86_400_000);
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
};
const isoDay = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const pdf = (label: string) =>
  Buffer.from(`%PDF-1.4\n1 0 obj << /Title (${label}) >> endobj\ntrailer << >>\n%%EOF\n`, "latin1");

async function stepUp(page: Page, title = "Confirm it is you", verify = "Verify and continue") {
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox").fill(MOCK_STEP_UP_CODE);
  await dialog.getByRole("button", { name: verify }).click();
}

/** Same-origin API calls (through the Next.js rewrite) to set up state quickly. */
async function api(page: Page, method: string, path: string, data?: object) {
  const res = await page.request.fetch(`/api/v1${path}`, {
    method,
    headers: { "X-CSRF-Token": MOCK_CSRF, "Content-Type": "application/json" },
    data,
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return (await res.json()) as {
    dpia: { id: string; version: number; document: { sha256: string } | null };
  };
}

test("biometric capture stays off until the signed DPIA is approved, then runs only where switched on", async ({
  page,
  context,
}) => {
  test.slow();
  await signInAs(context, "owner");
  await page.goto("/attendance/biometrics");
  await expect(page.getByRole("heading", { name: "Biometric attendance", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Biometrics" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("dpia-current")).toContainText(
    "No DPIA has been approved. Biometric capture is off on every site.",
  );
  const face = page.getByTestId(`gate-${MAIN_PLOT_ID}-face`);
  await expect(face).toContainText("No approved DPIA");
  await expect(face.getByRole("button", { name: /Switch on/ })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);

  // The owner starts the DPIA and records the sign-offs.
  await page.getByRole("button", { name: "Start a DPIA" }).click();
  await expect(page).toHaveURL(/\/attendance\/biometrics\/dpias\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "DPIA v1", level: 1 })).toBeVisible();
  const gaps = page.getByTestId("approval-gaps");
  await expect(gaps).toContainText("Upload the signed DPIA (PDF).");
  await expect(gaps).toContainText("Record the DPO's name, opinion and date.");
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  const form = page.getByRole("form", { name: "Edit the draft" });
  await form.getByRole("checkbox", { name: "Face kiosk" }).check();
  await form.getByRole("checkbox", { name: "Main plot" }).check();
  await form.locator("#dpia-dpo-name").fill("Achieng Otieno (synthetic DPO)");
  await form.locator("#dpia-dpo-opinion").selectOption("approve");
  await form.locator("#dpia-dpo-date").fill(typed(-3));
  await form.locator("#dpia-controller-name").fill("Wanjiru Kamau");
  await form.locator("#dpia-controller-role").fill("Director");
  await form.locator("#dpia-controller-decision").selectOption("proceed");
  await form.locator("#dpia-controller-date").fill(typed(-1));
  await form.locator("#dpia-residual-risk").selectOption("medium");
  await form.getByRole("button", { name: "Save draft" }).click();
  await expect(gaps).toHaveText("Upload the signed DPIA (PDF).");

  // Only a PDF is accepted as the signed DPIA.
  await page.getByRole("button", { name: "Upload the signed DPIA" }).click();
  const upload = page.getByRole("dialog", { name: "Upload the signed DPIA" });
  await upload.getByLabel("PDF file").setInputFiles({
    name: "scan.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  });
  await upload.getByRole("button", { name: "Upload" }).click();
  await expect(upload.getByRole("alert")).toHaveText("Upload the signed DPIA as a PDF.");
  await upload.getByLabel("PDF file").setInputFiles({
    name: "DPIA signed.pdf",
    mimeType: "application/pdf",
    buffer: pdf("signed DPIA"),
  });
  await upload.getByRole("button", { name: "Upload" }).click();
  await expect(upload).toBeHidden();
  await expect(page.getByTestId("dpia-document")).toContainText("DPIA signed.pdf");
  await expect(page.getByText("Ready to approve.")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // Approval needs every go-live condition and a fresh step-up.
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const approve = page.getByRole("dialog", { name: "Approve DPIA v1" });
  await expect(approve).toContainText("DPIA signed.pdf");
  const submit = approve.getByRole("button", { name: "Approve DPIA" });
  const conditions = approve.getByRole("checkbox");
  await expect(conditions).toHaveCount(8);
  for (const condition of (await conditions.all()).slice(0, 7)) await condition.check();
  await expect(submit).toBeDisabled();
  await conditions.last().check();
  await submit.click();
  await stepUp(page);
  await expect(approve).toBeHidden();
  await expect(page.getByText("In force", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Approval" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Edit the draft" })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);

  // Back on the overview: in force, covered methods can be switched on, others cannot.
  await page.getByRole("link", { name: "Biometric attendance" }).click();
  await expect(page.getByTestId("dpia-current")).toContainText(
    /In force until .* Covers Face kiosk on 1 site\./,
  );
  await expect(face).toContainText("Switched off");
  await expect(page.getByTestId(`gate-${MAIN_PLOT_ID}-fingerprint`)).toContainText(
    "Not covered by the DPIA",
  );
  await page.getByRole("button", { name: "Switch on Face kiosk at Main plot" }).click();
  await expect(face).toContainText("On");
  await expect(face).toContainText("Switched on by Wanjiru Kamau");
  await expect(
    page.getByRole("button", { name: "Switch off Face kiosk at Main plot" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "DPIA v1" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("a project manager has no access to the DPIA gate", async ({ page, context }) => {
  await signInAs(context, "pm");
  await page.goto("/attendance/biometrics");
  await expect(page.getByRole("heading", { name: "You do not have access" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("withdrawing the DPIA stops every site at once (Kiswahili, dark, 360 px)", async ({
  page,
  context,
}) => {
  test.slow();
  await signInAs(context, "owner");
  await preferences(context, page, "sw", "dark");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/attendance/biometrics");
  // An approved DPIA covering the main plot, switched on (set up through the API).
  const { dpia: draft } = await api(page, "POST", "/biometrics/dpias", {
    methods: ["face"],
    siteIds: [MAIN_PLOT_ID],
    dpoName: "Achieng Otieno (synthetic DPO)",
    dpoOpinion: "approve",
    dpoOpinionOn: isoDay(-3),
    dpoNote: null,
    controllerName: "Wanjiru Kamau",
    controllerRole: "Director",
    controllerDecision: "proceed",
    controllerDecisionOn: isoDay(-2),
    controllerNote: null,
    residualRisk: "low",
    odpcReference: null,
  });
  const uploaded = await page.request.post(`/api/v1/biometrics/dpias/${draft.id}/document`, {
    headers: { "X-CSRF-Token": MOCK_CSRF },
    multipart: { file: { name: "DPIA.pdf", mimeType: "application/pdf", buffer: pdf("sw") } },
  });
  expect(uploaded.ok()).toBe(true);
  const { dpia: signed } = (await uploaded.json()) as Awaited<ReturnType<typeof api>>;
  await api(page, "POST", "/auth/mfa/step-up", { code: MOCK_STEP_UP_CODE });
  const reviewDue = isoDay(90);
  await api(page, "POST", `/biometrics/dpias/${draft.id}/approve`, {
    version: signed.version,
    documentSha256: signed.document!.sha256,
    reviewDue,
    confirmations: [
      "fallback_ready",
      "accuracy_tested",
      "vendor_assessed",
      "notices_reviewed",
      "staff_trained",
      "retention_set",
      "hosting_recorded",
      "odpc_registered",
    ],
  });
  await api(page, "PUT", `/biometrics/sites/${MAIN_PLOT_ID}/methods/face`, { enabled: true });

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Mahudhurio ya kibayometriki", level: 1 }),
  ).toBeVisible();
  const face = page.getByTestId(`gate-${MAIN_PLOT_ID}-face`);
  await expect(face).toContainText("Imewashwa");
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("link", { name: "Fungua toleo 1" }).click();
  await expect(page.getByRole("heading", { name: "DPIA toleo 1", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Ondoa", exact: true }).click();
  const withdraw = page.getByRole("dialog", { name: "Ondoa DPIA toleo 1" });
  await withdraw.getByLabel("Sababu").fill("SDK ya msambazaji inatuma data nje (mfano)");
  await withdraw.getByRole("button", { name: "Ondoa DPIA" }).click();
  await expect(withdraw).toBeHidden();
  await expect(page.getByText("Imeondolewa na Wanjiru Kamau", { exact: false })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("link", { name: "Mahudhurio ya kibayometriki" }).click();
  await expect(face).toContainText("Hakuna DPIA iliyoidhinishwa");
  await expect(face.getByRole("button", { name: /^Washa/ })).toHaveCount(0);
  expect(await noSideScroll(page)).toBe(true);
});
