import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  axeViolations,
  MOCK_CSRF,
  MOCK_STEP_UP_CODE,
  preferences,
  signInAs,
  switchPersona,
} from "./live-helpers";
import { HISTORY_BATCH_ID, PAYOUT_BATCH_ID } from "./mock-payouts.mts";

/** D4.3 approval flow, live payouts, cash, flags and the payout side of worker records. */

const JOSEPH = "42000000-0000-4000-8000-000000000002";
const AMINA = "42000000-0000-4000-8000-000000000001";
const batchPath = `/payroll/batches/${PAYOUT_BATCH_ID}`;
const payoutsPath = `${batchPath}/payouts`;
const UUID = /^[0-9a-f-]{36}$/;

async function stepUp(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Authenticator code").fill(MOCK_STEP_UP_CODE);
  await dialog.getByRole("button", { name: "Verify and continue" }).click();
  await expect(dialog).toHaveCount(0);
}

/** A same-origin API call with the caller's cookies, as the browser would make it. */
async function call<T = Record<string, unknown>>(
  page: Page,
  method: "GET" | "POST",
  path: string,
  data?: unknown,
): Promise<T> {
  const response = await page.request.fetch(`/api/v1${path}`, {
    method,
    headers: {
      "X-CSRF-Token": MOCK_CSRF,
      "Idempotency-Key": randomUUID(),
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    ...(data ? { data } : {}),
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

type Readiness = { batch: { version: number; digest: string }; approvalDigest: string };

/** Review (finance), verify Joseph's number and approve (owner) without the screens. */
async function approveViaApi(page: Page, context: BrowserContext, token: string) {
  await switchPersona(context, "finance", token);
  const approval = await call<Readiness>(page, "GET", `${batchPath}/approval`);
  await call(page, "POST", `${batchPath}/review`, {
    version: approval.batch.version,
    digest: approval.batch.digest,
  });
  await switchPersona(context, "owner", token);
  await call(page, "POST", "/auth/mfa/step-up", { code: MOCK_STEP_UP_CODE });
  const status = await call<{ labourer: { version: number } }>(
    page,
    "GET",
    `/labour/labourers/${JOSEPH}/payout-status`,
  );
  await call(page, "POST", `/labour/labourers/${JOSEPH}/payout-verifications`, {
    version: status.labourer.version,
    method: "in_person_id_check",
  });
  const ready = await call<Readiness>(page, "GET", `${batchPath}/approval`);
  await call(page, "POST", `${batchPath}/approve`, {
    version: ready.batch.version,
    digest: ready.batch.digest,
    approvalDigest: ready.approvalDigest,
  });
}

const problem = (status: number, code: string, facts?: Record<string, unknown>) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({ status, code, ...(facts ? { facts } : {}) }),
});

test("reviews and approves a batch: maker-checker, in-person verification, digests and step-up", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "pm");
  await page.goto(batchPath);
  const approval = page.getByRole("region", { name: "Review and approval" });
  const timeline = page.getByRole("list", { name: "Status timeline" });
  await expect(timeline.locator('[aria-current="step"]')).toContainText("Submitted");
  await expect(approval).toContainText(
    "You prepared, calculated, submitted or reopened this batch, so a different person must review it.",
  );
  await expect(approval.getByRole("button", { name: "Review", exact: true })).toBeDisabled();

  await switchPersona(context, "finance", token);
  await page.reload();
  await approval.getByRole("button", { name: "Review", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review this batch" });
  await expect(review).toContainText("Snapshot digest you are confirming");
  await expect(review.getByRole("button", { name: "Record review" })).toBeDisabled();
  await review
    .getByLabel("I checked the register and its totals; this is the snapshot I reviewed.")
    .check();
  const reviewed = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith(`${batchPath}/review`),
  );
  await review.getByRole("button", { name: "Record review" }).click();
  const sent = await reviewed;
  expect(sent.headers()["idempotency-key"]).toMatch(UUID);
  expect(sent.postDataJSON()).toEqual({ version: 2, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
  await expect(timeline.locator('[aria-current="step"]')).toContainText("Reviewed");
  await expect(timeline).toContainText("Daniel Mwangi");
  await expect(page.getByRole("region", { name: "Approve for payment" })).toHaveCount(0);

  await switchPersona(context, "owner", token);
  await page.reload();
  const approve = page.getByRole("region", { name: "Approve for payment" });
  await expect(approve).toContainText("1 M-Pesa number is not verified in person yet.");
  await expect(approve.getByRole("button", { name: "Approve with step-up" })).toBeDisabled();
  await expect(page.getByRole("table", { name: "Recipients" })).toContainText(
    "Joseph Mwangi Kariuki · WRK-0002",
  );
  await expect(approval).toContainText(
    "New recipient, large amount (KES 52,000, threshold KES 50,000)",
  );
  await expect(approval).toContainText("Oscar Mutai Kirui · WRK-0006: KES 0.40");
  await expect(approval).toContainText("Carried forward (cents)KES 1.65");
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("link", { name: "Verify Joseph Mwangi Kariuki · WRK-0002" }).click();
  await expect(page).toHaveURL(new RegExp(`/labour\\?worker=${JOSEPH}`));
  const payouts = page
    .getByRole("dialog", { name: "Joseph Mwangi Kariuki" })
    .getByRole("region", { name: "M-Pesa payouts" });
  await expect(payouts).toContainText("Not verified");
  await payouts.getByRole("button", { name: "Verify in person" }).click();
  const verify = page.getByRole("dialog", {
    name: "Verify the M-Pesa number of Joseph Mwangi Kariuki",
  });
  await expect(verify.getByRole("button", { name: "Record verification" })).toBeDisabled();
  await verify.getByLabel(/I checked the original ID document of Joseph Mwangi Kariuki/).check();
  await verify.getByRole("button", { name: "Record verification" }).click();
  await stepUp(page);
  await expect(payouts).toContainText("Verified in person (ID checked) by Wanjiru Kamau");

  await page.goto(batchPath);
  await expect(approve).not.toContainText("not verified in person");
  await approve.getByLabel(/I approve paying exactly these recipients and amounts/).check();
  const route = `**/api/v1/payroll/batches/${PAYOUT_BATCH_ID}/approve`;
  await page.route(route, (request) => request.fulfill(problem(409, "snapshot-changed")));
  await approve.getByRole("button", { name: "Approve with step-up" }).click();
  await expect(approve.getByRole("alert")).toContainText(
    "The batch or its recipients changed since you opened it.",
  );
  await expect(approve.getByRole("button", { name: "Reload the latest batch" })).toBeVisible();
  await page.unroute(route);
  await page.route(route, (request) =>
    request.fulfill(
      problem(403, "approval-limit-exceeded", { limitMinor: 5_000_000, netMinor: 6_485_165 }),
    ),
  );
  await approve.getByRole("button", { name: "Approve with step-up" }).click();
  await expect(approve.getByRole("alert")).toContainText(
    "The batch net pay KES 64,851.65 is above your approval limit of KES 50,000.",
  );
  await page.unroute(route);
  const approved = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith(`${batchPath}/approve`),
  );
  await approve.getByRole("button", { name: "Approve with step-up" }).click();
  expect((await approved).postDataJSON()).toEqual({
    version: 3,
    digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    approvalDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  await expect(timeline.locator('[aria-current="step"]')).toContainText("Approved");
  await expect(page.getByRole("region", { name: "Decision history" })).toContainText(
    "Approved · Wanjiru Kamau",
  );
  await page.getByRole("link", { name: "Open payouts and payment status" }).click();
  await expect(page).toHaveURL(new RegExp(`${payoutsPath}$`));
  await expect(page.getByRole("heading", { name: "Payouts", level: 1 })).toBeVisible();
});

test("starts payouts after a fresh float check and follows live statuses with auto-refresh", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "owner");
  await approveViaApi(page, context, token);
  await switchPersona(context, "finance", token);
  await page.goto(payoutsPath);
  const float = page.getByRole("region", { name: "Float check" });
  const start = page.getByRole("region", { name: "Start payout" });
  await expect(float).toContainText("Too old: check again");
  await expect(start).toContainText("3 workers ready: KES 10,350 + estimated charges KES 25.");
  await float.getByRole("button", { name: "Request float check" }).click();
  await expect(float.getByRole("status")).toContainText("waiting for M-Pesa to answer");
  await expect(float).toContainText("Fresh", { timeout: 20_000 });
  await expect(float).toContainText("KES 100,000");

  await start.getByRole("button", { name: "Start payout…" }).click();
  const dialog = page.getByRole("dialog", { name: "Start M-Pesa payouts" });
  await expect(dialog.getByRole("checkbox")).toHaveCount(3);
  await expect(dialog).toContainText("3 payments: KES 10,350 + estimated charges KES 25");
  const started = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith(payoutsPath),
  );
  await dialog.getByRole("button", { name: "Start payouts" }).click();
  await stepUp(page);
  const sent = await started;
  expect(sent.postDataJSON()).toEqual({});
  expect(sent.headers()["idempotency-key"]).toMatch(UUID);
  await expect(start.getByRole("status")).toContainText(
    "3 payments started: KES 10,350 + charges KES 25.",
  );

  const table = page.getByRole("table", { name: "Workers and payment status" });
  const row = (name: RegExp) => table.getByRole("row", { name });
  await expect(page.getByText(/Live: updating every 5 seconds/)).toBeVisible();
  await expect(row(/Amina/)).toContainText("Paid", { timeout: 25_000 });
  await expect(row(/Amina/)).toContainText("Name matches");
  await expect(row(/Amina/)).toContainText(/TK[0-9A-F]{8}/);
  await expect(row(/Grace/)).toContainText("M-Pesa: Failed");
  await expect(row(/Mercy/)).toContainText("Outcome uncertain");
  await expect(row(/Mercy/)).toContainText("Reconcile the uncertain payment; never pay again first");
  await expect(row(/Peter/)).toContainText("Record a cash or bank payment");
  await expect(page.getByText("Nothing in progress")).toBeVisible({ timeout: 25_000 });

  await row(/Amina/).getByRole("button", { name: /Amina Wekesa Njoroge/ }).click();
  let sheet = page.getByRole("dialog", { name: "Amina Wekesa Njoroge" });
  await expect(sheet).toContainText("The SMS provider was unavailable.");
  await sheet.getByRole("button", { name: "Resend SMS" }).click();
  await expect(sheet.getByRole("region", { name: "Payslip SMS" })).toContainText("Queued");
  await expect(sheet.getByRole("region", { name: "Payslip SMS" })).toContainText("Sent", {
    timeout: 20_000,
  });
  await page.keyboard.press("Escape");

  await row(/Mercy/).getByRole("button", { name: /Mercy Chebet Rotich/ }).click();
  sheet = page.getByRole("dialog", { name: "Mercy Chebet Rotich" });
  await expect(sheet).toContainText(
    "Outcome uncertain: do not pay again or mark it as paid.",
  );
  await sheet.getByRole("link", { name: "Open the payment case" }).click();
  // The first visit to the payments console compiles it in the dev server.
  await expect(page).toHaveURL(/\/payments\/requests\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(page.getByRole("region", { name: "Reconciliation cases" })).toContainText(
    "Unknown payment outcome",
  );
  expect(await axeViolations(page)).toEqual([]);
});

test("clears a flag under maker-checker; a name mismatch then holds the worker", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "owner");
  await approveViaApi(page, context, token);
  await page.goto(payoutsPath);
  const flags = page.getByRole("region", { name: "Unusual payouts" });
  await expect(flags).toContainText("Joseph Mwangi Kariuki · WRK-0002");
  await flags.getByRole("button", { name: "Clear flag" }).click();
  let dialog = page.getByRole("dialog", { name: "Clear this flag" });
  await dialog.getByLabel("Reason (10–500 characters)").fill("Arrears for October agreed in writing");
  await dialog.getByRole("button", { name: "Clear flag" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "You prepared or approved this batch, or tried to start this payout, so another person must clear the flag.",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await switchPersona(context, "finance", token);
  await call(page, "POST", "/auth/mfa/step-up", { code: MOCK_STEP_UP_CODE });
  await call(page, "POST", `${batchPath}/float-check`, {});
  await page.reload();
  await flags.getByRole("button", { name: "Clear flag" }).click();
  dialog = page.getByRole("dialog", { name: "Clear this flag" });
  await dialog.getByLabel("Reason (10–500 characters)").fill("Arrears for October agreed in writing");
  await dialog.getByRole("button", { name: "Clear flag" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(flags).toContainText("Cleared by Daniel Mwangi");

  const start = page.getByRole("region", { name: "Start payout" });
  await start.getByRole("button", { name: "Start payout…" }).click();
  const choose = page.getByRole("dialog", { name: "Start M-Pesa payouts" });
  for (const name of [/Amina/, /Grace/, /Mercy/]) await choose.getByLabel(name).uncheck();
  await expect(choose).toContainText("1 payment: KES 52,000 (charges are estimated when sent)");
  const started = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith(payoutsPath),
  );
  await choose.getByRole("button", { name: "Start payouts" }).click();
  expect((await started).postDataJSON()).toEqual({ obligationIds: [expect.stringMatching(UUID)] });
  const table = page.getByRole("table", { name: "Workers and payment status" });
  const joseph = table.getByRole("row", { name: /Joseph/ });
  for (let poll = 0; poll < 2; poll++)
    await page.getByRole("button", { name: "Refresh now" }).click();
  await expect(joseph).toContainText("Name mismatch");
  await joseph.getByRole("button", { name: /Joseph Mwangi Kariuki/ }).click();
  await expect(page.getByRole("dialog", { name: "Joseph Mwangi Kariuki" })).toContainText(
    "M-Pesa name: PETER OMONDI",
  );

  await switchPersona(context, "owner", token);
  await page.goto(`/labour?worker=${JOSEPH}`);
  const record = page
    .getByRole("dialog", { name: "Joseph Mwangi Kariuki" })
    .getByRole("region", { name: "M-Pesa payouts" });
  await expect(record).toContainText("Name mismatch hold");
  await expect(record).toContainText("On hold");
  await record.getByRole("button", { name: "Release hold" }).click();
  const release = page.getByRole("dialog", { name: "Release this hold" });
  await release.getByLabel("Reason (10–500 characters)").fill("Worker showed the M-Pesa registration");
  await release.getByRole("button", { name: "Release hold" }).click();
  await expect(record).toContainText("Released by Wanjiru Kamau");
});

test("records cash with evidence and has another person confirm it", async ({ page, context }) => {
  const token = await signInAs(context, "owner");
  await approveViaApi(page, context, token);
  await switchPersona(context, "finance", token);
  await page.goto(payoutsPath);
  const table = page.getByRole("table", { name: "Workers and payment status" });
  await table.getByRole("button", { name: /Peter Kiprotich Langat/ }).click();
  const sheet = page.getByRole("dialog", { name: "Peter Kiprotich Langat" });
  await expect(sheet).toContainText("Cash or bank · no M-Pesa number");
  const form = sheet.getByRole("region", { name: "Record a cash or bank payment" });
  await expect(form.getByLabel("Amount (KES, whole shillings)")).toHaveValue("2500");
  await form.getByLabel("Amount (KES, whole shillings)").fill("2600");
  await expect(form.getByRole("button", { name: "Record payment" })).toBeDisabled();
  await form.getByLabel("Amount (KES, whole shillings)").fill("2500");
  await form.getByLabel("Why cash (10–500 characters)").fill("Worker has no M-Pesa number on record");
  const recorded = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith("/manual-payments"),
  );
  await form.getByRole("button", { name: "Record payment" }).click();
  await stepUp(page);
  expect((await recorded).postDataJSON()).toMatchObject({
    method: "cash",
    amountMinor: 250_000,
    reason: "Worker has no M-Pesa number on record",
  });
  await expect(sheet).toContainText("Awaiting second person");
  await expect(sheet).toContainText("You recorded this payment: another person must confirm or reject it.");
  await sheet.getByLabel("Photo or signature image").setInputFiles({
    name: "signature.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await sheet.getByRole("button", { name: "Upload evidence" }).click();
  await expect(sheet.getByText("Evidence uploaded.")).toBeVisible();
  await expect(sheet).toContainText("PNG image");

  await switchPersona(context, "owner", token);
  await page.reload();
  await table.getByRole("button", { name: /Peter Kiprotich Langat/ }).click();
  await sheet.getByRole("button", { name: "Confirm payment" }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm the payment of KES 2,500" });
  await confirm.getByRole("button", { name: "Confirm payment" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(sheet).toContainText("Confirmed by");
  await expect(sheet.getByRole("region", { name: "Payslip SMS" })).toContainText("No number: no SMS");
  await page.keyboard.press("Escape");
  await expect(table.getByRole("row", { name: /Peter/ })).toContainText("Paid");
  expect(await axeViolations(page)).toEqual([]);
});

test("the owner's waiver, payout settings and limits need step-up and show where approvals happen", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "owner");
  await page.goto("/payroll/settings");
  const waiver = page.getByRole("region", { name: "Segregation waiver (owner only)" });
  await waiver.getByLabel("Reason (10–500 characters)").fill("Small office: the finance lead is away");
  await waiver.getByRole("button", { name: "Enable waiver" }).click();
  await stepUp(page);
  await expect(waiver.getByRole("note", { name: "Segregation waiver" })).toContainText(
    "Segregation waiver is ON",
  );

  const settings = page.getByRole("region", { name: "Payout settings" });
  await settings.getByLabel("Cash cap per worker per pay period (KES)").fill("15000");
  const saved = page.waitForRequest(
    (request) => request.method() === "PUT" && request.url().endsWith("/payroll/payout-settings"),
  );
  await settings.getByRole("button", { name: "Save payout settings" }).click();
  expect((await saved).postDataJSON()).toMatchObject({
    cashMaxPerWorkerPeriodMinor: 1_500_000,
    businessHoursStart: "00:00",
  });
  await expect(settings.getByRole("status")).toContainText("Saved.");
  const limits = page.getByRole("region", { name: "Batch approval limits" });
  await limits.getByLabel("Owner (KES net per batch)").fill("50000");
  await limits.getByRole("button", { name: "Save approval limits" }).click();
  await expect(limits).toContainText("Owner: KES 50,000");

  await page.goto(batchPath);
  await expect(page.getByRole("note", { name: "Segregation waiver" })).toContainText(
    "Approvals under the waiver are limited to KES 500,000 net pay per batch",
  );
  const approval = page.getByRole("region", { name: "Review and approval" });
  await approval.getByRole("button", { name: "Review", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review this batch" });
  await review.getByLabel(/this is the snapshot I reviewed/).check();
  await review.getByRole("button", { name: "Record review" }).click();
  const approve = page.getByRole("region", { name: "Approve for payment" });
  await expect(approve).toContainText(
    "You reviewed this batch: you may approve it only under the owner’s waiver, up to KES 500,000.",
  );
  await expect(approve).toContainText(
    "The batch net pay KES 64,851.65 is above your approval limit of KES 50,000.",
  );

  await page.goto("/payroll/settings");
  await limits.getByLabel("Owner (KES net per batch)").fill("");
  await limits.getByRole("button", { name: "Save approval limits" }).click();
  await expect(limits).toContainText("No limits set: the owner default applies.");
  const status = await call<{ labourer: { version: number } }>(
    page,
    "GET",
    `/labour/labourers/${JOSEPH}/payout-status`,
  );
  await call(page, "POST", `/labour/labourers/${JOSEPH}/payout-verifications`, {
    version: status.labourer.version,
    method: "in_person_id_check",
  });
  await page.goto(batchPath);
  await approve.getByLabel(/I approve paying exactly these recipients and amounts/).check();
  await approve.getByRole("button", { name: "Approve with step-up" }).click();
  await expect(page.getByRole("note", { name: "Segregation waiver" })).toContainText(
    "This batch was approved under the segregation waiver: its reviewer also approved it.",
  );
  await expect(page.getByRole("list", { name: "Status timeline" })).toContainText(
    "Under the waiver",
  );

  await switchPersona(context, "finance", token);
  await page.goto("/payroll/settings");
  await expect(waiver).toContainText("Only the company owner can change the waiver.");
  await expect(settings.getByRole("button", { name: "Save payout settings" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Batch approval limits" })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
});

test("a changed number loses its verification: maker-checker, change hold override and holds", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto(`/labour?worker=${AMINA}`);
  const panel = page.getByRole("dialog", { name: "Amina Wekesa Njoroge" });
  const record = panel.getByRole("region", { name: "M-Pesa payouts" });
  await expect(record).toContainText("Verified in person (ID checked) by Brian Otieno");
  await expect(panel).toContainText("SMS languageKiswahili");
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit worker" });
  await edit.getByLabel("New phone number").fill("0712 345 678");
  await edit.getByLabel("SMS language").selectOption("en");
  const patched = page.waitForRequest((request) => request.method() === "PATCH");
  await edit.getByRole("button", { name: "Save changes" }).click();
  expect((await patched).postDataJSON()).toMatchObject({ preferredLanguage: "en" });
  await expect(panel).toContainText("SMS languageEnglish");
  await expect(record).toContainText("Not verified");
  await expect(record).toContainText("No M-Pesa payout before");

  await record.getByRole("button", { name: "Verify in person" }).click();
  const verify = page.getByRole("dialog", { name: "Verify the M-Pesa number of Amina Wekesa Njoroge" });
  await verify.getByLabel(/I checked the original ID document/).check();
  await verify.getByRole("button", { name: "Record verification" }).click();
  await stepUp(page);
  await expect(verify.getByRole("alert")).toContainText(
    "You changed or registered this number, so another person must verify it in person.",
  );
  await verify.getByRole("button", { name: "Cancel" }).click();

  await record.getByRole("button", { name: "Override hold" }).click();
  const override = page.getByRole("dialog", { name: "Override the number change hold" });
  await override.getByLabel("Reason (10–500 characters)").fill("Worker came to the office with the new SIM");
  await override.getByRole("button", { name: "Override hold" }).click();
  await expect(record).toContainText("Overridden by Wanjiru Kamau");

  await record.getByRole("button", { name: "Place hold" }).click();
  const hold = page.getByRole("dialog", { name: "Hold M-Pesa payouts to this worker" });
  await hold.getByLabel("Reason (10–500 characters)").fill("Worker reported a lost phone");
  await hold.getByRole("button", { name: "Place hold" }).click();
  await expect(record).toContainText("Payout holds (1 active)");
  await record.getByRole("button", { name: "Release hold" }).click();
  const release = page.getByRole("dialog", { name: "Release this hold" });
  await release.getByLabel("Reason (10–500 characters)").fill("Phone recovered and checked in person");
  await release.getByRole("button", { name: "Release hold" }).click();
  await expect(record).toContainText("Payout holds (0 active)");
  expect(await axeViolations(page)).toEqual([]);
});

test("shows brought-forward and carried-forward cents on the payslip once approved", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "owner");
  const line = `${batchPath}/lines/49100000-0000-4000-8000-000000000011`;
  await page.goto(line);
  await expect(page.getByText("Brought forward: KES 0.25")).toBeVisible();
  await expect(page.getByText(/Calculation preview only/)).toBeVisible();
  await approveViaApi(page, context, token);
  await page.reload();
  await expect(page.getByText("Net pay: KES 5,050.50", { exact: true })).toBeVisible();
  await expect(page.getByText(/Paid in whole shillings: KES 5,050 · Carried forward/)).toContainText(
    "Carried forward to the next payroll: KES 0.50",
  );
  await expect(page.getByRole("link", { name: "See payout status" })).toHaveAttribute(
    "href",
    payoutsPath,
  );
});

test("Kiswahili payouts and approval screens fit a phone and pass axe in dark mode", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await preferences(context, page, "sw", "dark");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/payroll/batches/${HISTORY_BATCH_ID}/payouts`);
  await expect(page.getByRole("heading", { name: "Malipo ya mishahara", level: 1 })).toBeVisible();
  await expect(page.getByRole("table", { name: "Wafanyakazi na hali ya malipo" })).toContainText(
    "Imelipwa",
  );
  const noScroll = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await noScroll()).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page
    .getByRole("table", { name: "Wafanyakazi na hali ya malipo" })
    .getByRole("button", { name: /Mercy Chebet Rotich/ })
    .click();
  await expect(page.getByRole("dialog", { name: "Mercy Chebet Rotich" })).toContainText(
    "Matokeo hayana uhakika",
  );
  expect(await axeViolations(page)).toEqual([]);
  await page.goto(batchPath);
  await expect(page.getByRole("heading", { name: "Ukaguzi na uidhinishaji" })).toBeVisible();
  expect(await noScroll()).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
});
