import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  axeViolations,
  MAIN_PLOT_ID,
  MOCK_CSRF,
  MOCK_STEP_UP_CODE,
  preferences,
  signInAs,
  switchPersona,
} from "./live-helpers";

/**
 * D3.4 consent per modality, enrolment and template deletion against test/mock-api.mts
 * (mock-biometrics.mts applies the shared domain rules and returns the shared response schemas).
 * A test plays the kiosk by posting an enrolment: the office app never collects templates.
 */
const AMINA = "42000000-0000-4000-8000-000000000001";
const JOSEPH = "42000000-0000-4000-8000-000000000002";
const DPO_PHONE = "+254 700 000 444";
const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const isoDay = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** Same-origin API calls (through the Next.js rewrite) to set up state quickly. */
async function api<T = unknown>(page: Page, method: string, path: string, data?: object) {
  const res = await page.request.fetch(`/api/v1${path}`, {
    method,
    headers: { "X-CSRF-Token": MOCK_CSRF, "Content-Type": "application/json" },
    data,
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

/** An approved DPIA covering face at the main plot, switched on there. */
async function faceInForce(page: Page) {
  type Dpia = { dpia: { id: string; version: number; document: { sha256: string } | null } };
  const { dpia: draft } = await api<Dpia>(page, "POST", "/biometrics/dpias", {
    methods: ["face"],
    siteIds: [MAIN_PLOT_ID],
    dpoName: "Achieng Otieno (synthetic DPO)",
    dpoPhone: DPO_PHONE,
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
    multipart: {
      file: {
        name: "DPIA.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\ntrailer << >>\n%%EOF\n", "latin1"),
      },
    },
  });
  expect(uploaded.ok()).toBe(true);
  const { dpia: signed } = (await uploaded.json()) as Dpia;
  await api(page, "POST", "/auth/mfa/step-up", { code: MOCK_STEP_UP_CODE });
  await api(page, "POST", `/biometrics/dpias/${draft.id}/approve`, {
    version: signed.version,
    documentSha256: signed.document!.sha256,
    reviewDue: isoDay(90),
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
}

const consent = (page: Page, labourerId: string) =>
  api(page, "POST", `/biometrics/labourers/${labourerId}/consents`, {
    modality: "face",
    noticeVersion: "biometric-face-2026-11-v1",
    language: "en",
    method: "signed",
    granted: true,
  });

/** The kiosk's enrolment: a synthetic minutiae-style template, never an image. */
const enrol = (page: Page, labourerId: string) =>
  api(page, "POST", "/biometrics/enrolments", {
    id: randomUUID(),
    labourerId,
    siteId: MAIN_PLOT_ID,
    method: "face",
    modality: "face",
    templates: [
      {
        data: Buffer.concat([Buffer.from("FMR\0", "latin1"), Buffer.alloc(64, 7)]).toString(
          "base64",
        ),
        algorithm: "Synthetic Minutiae",
        algorithmVersion: "1.0",
        qualityScore: 81,
      },
    ],
  });

test("consent is recorded per method from the notice, and withdrawal deletes the templates at once", async ({
  page,
  context,
}) => {
  test.slow();
  await signInAs(context, "owner");
  await page.goto("/attendance/biometrics");
  await faceInForce(page);

  // From the worker's panel in the labour registry.
  await page.goto(`/labour?worker=${AMINA}`);
  const panel = page.getByRole("dialog", { name: "Amina Wekesa Njoroge" });
  await panel.getByRole("link", { name: "Biometric consent" }).click();
  await expect(
    page.getByRole("heading", { name: "Biometrics: Amina Wekesa Njoroge", level: 1 }),
  ).toBeVisible();
  await expect(page.getByTestId("worker-dpia")).toContainText(
    `DPIA version 1: DPO Achieng Otieno (synthetic DPO), ${DPO_PHONE}`,
  );
  const fingerprint = page.getByTestId("modality-fingerprint");
  await expect(fingerprint).toContainText("The DPIA in force does not cover this method.");
  await expect(fingerprint.getByRole("button", { name: "Record yes" })).toHaveCount(0);

  // The notice names the company, the retention period and the DPO's phone, in either language.
  const face = page.getByTestId("modality-face");
  await expect(face).toContainText("No decision");
  const notice = face.getByRole("article");
  await expect(notice).toContainText("Using your face to record your attendance");
  await expect(notice).toContainText(
    "We delete the code 30 days after your work with Jenga Bora Builders Ltd ends",
  );
  await expect(notice).toContainText(`Contact Achieng Otieno (synthetic DPO) on ${DPO_PHONE}.`);
  await face.getByRole("radio", { name: "Kiswahili" }).check();
  await expect(notice).toContainText("Kutumia uso wako kurekodi mahudhurio yako");
  await expect(notice).toHaveAttribute("lang", "sw");
  expect(await axeViolations(page)).toEqual([]);

  // Read aloud: a witness is needed before the answer is recorded.
  await face.getByRole("radio", { name: "Read aloud, with a witness" }).check();
  const yes = face.getByRole("button", { name: "Record yes" });
  await expect(yes).toBeDisabled();
  await face.getByLabel("Witness's name").fill("Shahidi Majaribio");
  await yes.click();
  await expect(face.getByText("Agreed", { exact: true })).toBeVisible();
  await expect(face.getByText("Agreed to the current notice.")).toBeVisible();
  const decisions = face.getByRole("table");
  await expect(decisions).toContainText("biometric-face-2026-11-v1");
  await expect(decisions).toContainText("Kiswahili · DPIA version 1");
  await expect(decisions).toContainText("Witness: Shahidi Majaribio");
  await expect(face.getByRole("button", { name: "Record yes" })).toHaveCount(0);
  // The form has gone; its confirmation stays in the section's status region.
  await expect(face.getByRole("status")).toHaveText(
    "Decision recorded. The worker gets an SMS confirmation.",
  );

  // The kiosk enrols the worker; the page shows the enrolment, never the template.
  await enrol(page, AMINA);
  await page.goto(`/attendance/biometrics/workers/${AMINA}`);
  await expect(face).toContainText("In use");
  await expect(face).toContainText(
    "Face kiosk at RUI-HTS · Main plot · 1 template · Synthetic Minutiae 1.0",
  );
  await expect(face).toContainText("Kept while the worker is engaged.");
  expect(await axeViolations(page)).toEqual([]);

  // The worker stops: the templates are deleted with the withdrawal.
  await face.getByRole("button", { name: "Record withdrawal" }).click();
  const withdraw = page.getByRole("dialog", { name: "The worker stops using their face" });
  await expect(withdraw).toContainText("Their face templates are deleted now");
  await withdraw.getByRole("button", { name: "Record withdrawal and delete templates" }).click();
  await expect(withdraw).toBeHidden();
  await expect(face.getByText("Withdrawn", { exact: true })).toBeVisible();
  await expect(face).toContainText("Not enrolled.");
  await expect(face).toContainText("Consent withdrawn · Wanjiru Kamau");
  await expect(face.getByRole("status")).toHaveText("Withdrawal recorded and templates deleted.");

  // The overview counts the decisions; the deletion log records who deleted what and why.
  await page.getByRole("link", { name: "DPIA and sites" }).click();
  const counts = page.getByTestId("template-counts");
  await expect(counts).toContainText("Face enrolments0");
  const monitoring = page.getByRole("table", { name: /Consent decisions this month/ });
  await expect(monitoring.getByRole("row", { name: /^Face/ })).toHaveText(/Face\s*1\s*0\s*1/);
  await page.getByRole("link", { name: "Deletion log", exact: true }).click();
  const log = page.getByRole("table", { name: "Template deletion log" });
  await expect(log).toContainText("Amina Wekesa Njoroge");
  await expect(log).toContainText("Consent withdrawn");
  await expect(log).toContainText("Wanjiru Kamau");
  expect(await axeViolations(page)).toEqual([]);
});

test("enrolments, the retention run and deletion on request (Kiswahili, dark, 360 px)", async ({
  page,
  context,
}) => {
  test.slow();
  await signInAs(context, "owner");
  await preferences(context, page, "sw", "dark");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/attendance/biometrics");
  await faceInForce(page);
  for (const worker of [AMINA, JOSEPH]) {
    await consent(page, worker);
    await enrol(page, worker);
  }

  await page.goto("/attendance/biometrics/enrolments");
  await expect(
    page.getByRole("heading", { name: "Usajili wa kibayometriki", level: 1 }),
  ).toBeVisible();
  const table = page.getByRole("table", { name: "Usajili wa kibayometriki" });
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table).toContainText("Inatumika");
  await expect(table).toContainText("Akiwa kazini");
  // Everyone is still engaged: the retention run deletes nothing.
  await page.getByRole("button", { name: "Endesha ufutaji wa muda wa kuhifadhi sasa" }).click();
  await expect(page.getByText("Violezo vya usajili 0 vimefutwa.")).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  // Joseph asks for his templates to be deleted.
  await table.getByRole("link", { name: "Joseph Mwangi Kariuki" }).click();
  const face = page.getByTestId("modality-face");
  await face.getByRole("button", { name: "Futa violezo" }).click();
  const remove = page.getByRole("dialog", { name: "Futa violezo vya uso kwa ombi la mfanyakazi" });
  await remove.getByRole("button", { name: "Futa violezo" }).click();
  await expect(remove).toBeHidden();
  await expect(face).toContainText("Hajasajiliwa.");
  await expect(face).toContainText("Ombi la mfanyakazi");
  await expect(face.getByRole("status")).toHaveText(
    "Violezo vimefutwa. Mfanyakazi anaweza kusajiliwa tena baadaye kwa ridhaa yake.",
  );
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("link", { name: "Kumbukumbu ya ufutaji" }).click();
  await expect(page.getByRole("table", { name: "Kumbukumbu ya ufutaji wa violezo" })).toContainText(
    "Joseph Mwangi Kariuki",
  );
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
});

test("a site agent records a withdrawal but cannot take biometric consent", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "owner");
  await page.goto("/attendance/biometrics");
  await faceInForce(page);
  await consent(page, AMINA);
  await switchPersona(context, "agent", token);

  await page.goto(`/attendance/biometrics/workers/${JOSEPH}`);
  const joseph = page.getByTestId("modality-face");
  await expect(joseph).toContainText(
    "You can see these records. Taking consent needs the biometric enrolment permission.",
  );
  await expect(joseph.getByRole("button", { name: "Record yes" })).toHaveCount(0);

  await page.goto(`/attendance/biometrics/workers/${AMINA}`);
  const amina = page.getByTestId("modality-face");
  await amina.getByRole("button", { name: "Record withdrawal" }).click();
  const withdraw = page.getByRole("dialog", { name: "The worker stops using their face" });
  await withdraw.getByRole("button", { name: "Record withdrawal and delete templates" }).click();
  await expect(withdraw).toBeHidden();
  await expect(amina.getByText("Withdrawn", { exact: true })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // The company's enrolment list and deletion log stay with the DPIA holders.
  await page.goto("/attendance/biometrics/enrolments");
  await expect(page.getByRole("heading", { name: "You do not have access" })).toBeVisible();
});
