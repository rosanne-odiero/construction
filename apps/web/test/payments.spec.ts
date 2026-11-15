import { expect, test } from "@playwright/test";
import { axeViolations, MOCK_STEP_UP_CODE, preferences, signInAs } from "./live-helpers";
import { PAYMENT_CALLBACK_ID, PAYMENT_CASE_ID, PAYMENT_REQUEST_ID } from "./mock-payments.mts";

test("unknown request stays uncertain through timeline and a read-only status query", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/payments/requests");
  await page.getByRole("link", { name: "PAY-TEST-001" }).click();
  await expect(page.getByRole("region", { name: "Attempts", exact: true })).toContainText(
    "Unknown outcome",
  );
  const timeline = page.getByRole("region", { name: "State timeline" });
  await expect(timeline).toContainText("Lost response");
  await expect(page.locator("#main").getByRole("alert")).toContainText(
    "Do not mark as paid or resubmit",
  );
  await page.getByRole("button", { name: "Query provider status" }).click();
  await expect(page.getByRole("region", { name: "Provider queries" })).toContainText("Sent");
  await expect(page.getByRole("region", { name: "Attempts", exact: true })).toContainText(
    "Unknown outcome",
  );
  await expect(page.locator("#main").getByText("Confirmed", { exact: true })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
});

test("unknown callback is quarantined, redacted and reviewed through step-up without confirming payment", async ({
  page,
  context,
}) => {
  await signInAs(context, "finance");
  await page.goto("/payments/callbacks");
  await expect(page.locator("#main")).toContainText("1 open callback alerts");
  await expect(page.locator("#main")).toContainText("Unknown request: callback quarantined");
  await page.getByRole("link", { name: /STK callback/ }).click();
  await expect(page.getByRole("heading", { name: "Redacted callback body" })).toBeVisible();
  await expect(page.locator("#main")).toContainText("2547•••••123");
  await page.getByLabel("Reason (10–500 characters)").fill("Unknown synthetic callback reviewed");
  await page.getByRole("button", { name: "Submit review" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/code/i).fill(MOCK_STEP_UP_CODE);
  await dialog.getByRole("button", { name: /verify/i }).click();
  await expect(page.locator("#main").getByText("Resolved", { exact: true })).toBeVisible();
  await page.goto(`/payments/requests/${PAYMENT_REQUEST_ID}`);
  await expect(page.getByRole("region", { name: "Attempts", exact: true })).toContainText(
    "Unknown outcome",
  );
});

test("Kiswahili callback inbox and detail fit a phone and do not claim payment", async ({
  page,
  context,
}) => {
  await preferences(context, page, "sw", "dark");
  await signInAs(context, "owner");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/payments/callbacks/${PAYMENT_CALLBACK_ID}`);
  await expect(
    page.getByRole("heading", { name: "Dashibodi ya malipo", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#main")).toContainText("Hakuna malipo yaliyothibitishwa na jibu hili");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
});

test("test request creation queues rather than claims paid; project staff cannot access the console", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/payments/new");
  await page.getByLabel("Amount (KES, whole shillings)").fill("100");
  await page.getByLabel("Kenyan phone number").fill("0712345678");
  await page.getByLabel("Account reference").fill("TEST001");
  await page.getByRole("button", { name: "Queue test transaction" }).click();
  await expect(page).toHaveURL(/\/payments\/requests\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("region", { name: "Attempts", exact: true })).toContainText("Queued");
  await expect(page.locator("#main").getByText("Confirmed", { exact: true })).toHaveCount(0);
  await signInAs(context, "agent");
  await page.goto("/payments");
  await expect(
    page.locator("#main").getByText("Queue test transaction", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("#main")).not.toContainText("PAY-TEST");
});

test("uncertain cases cannot be dismissed and confirmation asks for exact evidence", async ({
  page,
  context,
}) => {
  await signInAs(context, "finance");
  await page.goto(`/payments/cases/${PAYMENT_CASE_ID}`);
  await expect(
    page.getByLabel("Decision").getByRole("option", { name: "Dismissed", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Decision").selectOption("confirmed");
  await expect(page.getByLabel("M-Pesa receipt")).toBeVisible();
  await expect(page.getByLabel("Amount (KES, whole shillings)")).toBeVisible();
});

test("credentials are blank and write-only, cleared before MFA and never echoed", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/payments/settings");
  await expect(
    page.getByLabel("Environment", { exact: true }).getByRole("option", { name: /production/i }),
  ).toHaveCount(0);
  const secret = page.getByLabel("Consumer secret", { exact: true });
  await expect(secret).toHaveValue("");
  await expect(secret).toHaveAttribute("type", "password");
  await secret.fill("synthetic-browser-only-not-a-credential");
  await page.getByRole("button", { name: "Replace supplied credentials" }).click();
  await expect(secret).toHaveValue("");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/code/i).fill(MOCK_STEP_UP_CODE);
  await dialog.getByRole("button", { name: /verify/i }).click();
  await expect(page.getByRole("status")).toContainText("Request recorded");
  await expect(secret).toHaveValue("");
  await expect(page.locator("#main")).not.toContainText("synthetic-browser-only-not-a-credential");
});

test("a lost creation response locks the payload and retries with the same idempotency key", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  const bodies: string[] = [];
  const keys: string[] = [];
  await page.route("**/api/v1/payments/requests", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    keys.push(route.request().headers()["idempotency-key"]);
    bodies.push(route.request().postData() ?? "");
    if (keys.length === 1) {
      await route.fetch();
      await route.abort("connectionreset");
    } else await route.continue();
  });
  await page.goto("/payments/new");
  await page.getByLabel("Amount (KES, whole shillings)").fill("100");
  await page.getByLabel("Kenyan phone number").fill("0712345678");
  await page.getByLabel("Account reference").fill("TEST001");
  await page.getByRole("button", { name: "Queue test transaction" }).click();
  await expect(page.getByLabel("Amount (KES, whole shillings)")).toBeDisabled();
  await page.getByRole("button", { name: "Retry same request" }).click();
  await expect(page).toHaveURL(/\/payments\/requests\/[0-9a-f-]{36}$/);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(bodies[1]).toBe(bodies[0]);
  await expect(page.getByRole("region", { name: "Attempts", exact: true })).toContainText("Queued");
});
