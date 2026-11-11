import { expect as baseExpect, test, type Page } from "@playwright/test";
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
 * D2.3 against test/mock-api.mts: baseline approval, instructions, a variation from draft to
 * approval (maker-checker and step-up), version comparison, contract sums and the rate build-up
 * library with an item link. Amounts are worked out by hand from the synthetic multi-bill BQ.
 */
const BQ = `/projects/${RUIRU_ID}/bq`;
// These flows render many freshly compiled dev-server routes, so they get more time per step.
const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 180_000 });

async function expectNoHorizontalScroll(page: Page, label: string) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    label,
  ).toBe(true);
}

async function stepUp(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Authenticator code").fill(MOCK_STEP_UP_CODE);
  await dialog.getByRole("button", { name: "Verify and continue" }).click();
}

async function approveBaseline(page: Page) {
  await page.goto(BQ);
  await page.getByRole("button", { name: "Approve as contract baseline" }).click();
  const dialog = page.getByRole("dialog", { name: "Approve the contract baseline" });
  await expect(dialog).toContainText("KES 38,647,188.75");
  await dialog.getByRole("button", { name: "Approve baseline" }).click();
  await stepUp(page);
  await expect(page.getByText(/Version 1 was approved as the contract baseline on/)).toBeVisible();
}

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

/** Owner approves the baseline and raises a submitted VO-001 (one changed item) by API. */
async function seedSubmittedVariation(page: Page) {
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
  return variation.id;
}

test("approves the baseline, raises a variation and approves it into version 2", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "owner");
  await approveBaseline(page);
  await expect(page.getByTestId("contract-sum-original")).toContainText("KES 38,647,188.75");
  await expect(page.getByTestId("contract-sum-revised")).toContainText("KES 38,647,188.75");
  expect(await axeViolations(page)).toEqual([]);

  // Register the Architect's Instruction.
  await page
    .getByRole("navigation", { name: "BQ pages" })
    .getByRole("link", { name: "Instructions" })
    .click();
  await expect(page).toHaveURL(`${BQ}/instructions`);
  await page.getByRole("button", { name: "Register instruction" }).click();
  const register = page.getByRole("dialog", { name: "Register an instruction" });
  await register.getByLabel("Number (e.g. AI-007)").fill("AI-001");
  await register.getByLabel("Date issued").fill("2026-11-02");
  await register.getByLabel("Issued by").fill("Arch. Achieng Otieno");
  await register.getByLabel("Subject").fill("Deeper column bases; omit ground beams");
  await register.getByLabel("Attachment (optional)").fill("Drawing S-12 rev B");
  await register.getByRole("button", { name: "Register" }).click();
  await expect(page.getByRole("table", { name: "Instructions" })).toContainText("AI-001");
  expect(await axeViolations(page)).toEqual([]);

  // Raise VO-001 and build its lines from the BQ tree.
  await page
    .getByRole("navigation", { name: "BQ pages" })
    .getByRole("link", { name: "Variations" })
    .click();
  await page.getByRole("button", { name: "New variation" }).click();
  const create = page.getByRole("dialog", { name: "New variation" });
  await create.getByLabel("Title", { exact: true }).fill("Foundations revised by AI-001");
  await create.getByRole("button", { name: "Create draft" }).click();
  await expect(
    page.getByRole("heading", { name: "VO-001 · Foundations revised by AI-001" }),
  ).toBeVisible();
  await page.getByLabel("Bill", { exact: true }).selectOption({ label: "Bill 2: SUBSTRUCTURE" });
  await page.getByRole("button", { name: /^Change B · Excavate for column bases/ }).click();
  const change = page.getByRole("dialog", { name: "Change quantity or rate" });
  await change.getByLabel("New quantity (m³)").fill("342.75");
  await change.getByRole("button", { name: "Add line" }).click();
  await page
    .getByRole("button", { name: /^Omit C · Reinforced concrete class 25 in ground/ })
    .click();
  await page.getByRole("button", { name: "Add a new item" }).click();
  const add = page.getByRole("dialog", { name: "Add a new item" });
  await add.getByLabel("Section", { exact: true }).selectOption({ label: "New section…" });
  await add.getByLabel("New section title").fill("EXTRA WORKS (VO-001)");
  await add.getByLabel("Description").fill("Precast lintels over new openings");
  await add.getByLabel("Unit").selectOption({ label: "m" });
  await add.getByLabel("Quantity", { exact: true }).fill("24.5");
  await add.getByLabel("Rate (KES)").fill("1850.3333");
  await add.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Save lines" }).click();
  const lines = page.getByRole("table", { name: "Lines" });
  await expect(lines.getByRole("row", { name: /Excavate for column bases/ })).toContainText(
    "KES 21,287.50",
  );
  await expect(lines.getByRole("row", { name: /ground beams/ })).toContainText("−KES 974,400");
  await expect(lines.getByRole("row", { name: /Precast lintels/ })).toContainText("KES 45,333.17");
  // Additions 66,620.67; omissions 974,400; net −907,779.33; VAT recomputed on the new subtotal.
  await expect(page.getByText("KES 66,620.67")).toBeVisible();
  await expect(page.getByText("−KES 907,779.33")).toBeVisible();
  await expect(page.getByText("KES 37,594,164.73")).toBeVisible();
  await expect(page.getByText("−KES 1,053,024.02").first()).toBeVisible();

  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Submit VO-001" })
    .getByRole("button", { name: "Submit for approval" })
    .click();
  await expect(page.getByText("Submitted").first()).toBeVisible();
  // The owner raised it, so the owner cannot approve it (maker-checker by identity).
  await expect(
    page.getByText(
      "You raised or submitted this variation, so someone else must approve or reject it.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  const variationUrl = page.url();
  await page.goto(BQ);
  await expect(page.getByTestId("contract-sum-pending")).toContainText("−KES 1,053,024.02");
  await expect(page.getByTestId("contract-sum-revised")).toContainText("KES 38,647,188.75");

  // The project manager approves it after a fresh step-up.
  await switchPersona(context, "pm", token);
  await page.goto(variationUrl);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const approve = page.getByRole("dialog", { name: "Approve VO-001" });
  await expect(approve).toContainText("−KES 1,053,024.02");
  await expect(approve.getByText(/^Snapshot [0-9a-f]{12}…/)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await approve.getByRole("button", { name: "Approve and create version 2" }).click();
  await stepUp(page);
  await expect(page.getByText("Approved").first()).toBeVisible();
  await expect(page.getByText("Version 1 → Version 2")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // Version history and comparison.
  await page.goto(`${BQ}/versions`);
  const history = page.getByRole("table", { name: "BQ versions" });
  await expect(history.getByRole("row", { name: /Version 2/ })).toContainText("Variation VO-001");
  await expect(history.getByRole("row", { name: /Version 2/ })).toContainText("Current");
  await expect(page.getByRole("table", { name: "1 item added" })).toContainText("Precast lintels");
  await expect(page.getByRole("table", { name: "2 items changed" })).toContainText(
    "Excavate for column bases",
  );
  await expect(page.getByRole("table", { name: "No items removed" })).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Bill subtotals" }).getByRole("row", { name: /Bill 2/ }),
  ).toContainText("−KES 907,779.33");
  expect(await axeViolations(page)).toEqual([]);

  // Original vs revised on the project overview.
  await page.goto(`/projects/${RUIRU_ID}`);
  await expect(page.getByTestId("contract-sum-original")).toContainText("KES 38,647,188.75");
  await expect(page.getByTestId("contract-sum-approved")).toContainText("−KES 1,053,024.02");
  await expect(page.getByTestId("contract-sum-revised")).toContainText("KES 37,594,164.73");
  await expect(page.getByTestId("contract-sum-pending")).toContainText("KES 0");
  expect(await axeViolations(page)).toEqual([]);
});

test("rejects with a reason, reopens, and refuses a stale variation until it is rebased", async ({
  page,
  context,
}) => {
  const token = await signInAs(context, "owner");
  const first = await seedSubmittedVariation(page);
  // A second variation on the same base version, also submitted.
  const view = (await api(page, "GET", BQ)) as { bq: { bills: { id: string }[] } };
  const bill = (await api(page, "GET", `${BQ}/bills/${view.bq.bills[1]!.id}`)) as {
    items: { lineageId: string }[];
  };
  const { instructions } = (await api(page, "GET", `${BQ}/instructions`)) as {
    instructions: { id: string }[];
  };
  let { variation } = (await api(page, "POST", `${BQ}/variations`, {
    instructionId: instructions[0]!.id,
    title: "Hardcore thickness (synthetic)",
  })) as { variation: { id: string; version: number } };
  ({ variation } = (await api(page, "PUT", `${BQ}/variations/${variation.id}/lines`, {
    lines: [{ action: "adjust", itemLineageId: bill.items[4]!.lineageId, rate: "1200" }],
    version: variation.version,
  })) as { variation: { id: string; version: number } });
  await api(page, "POST", `${BQ}/variations/${variation.id}/submit`, {
    version: variation.version,
  });

  await switchPersona(context, "pm", token);
  await page.goto(`${BQ}/variations/${variation.id}`);
  await page.getByRole("button", { name: "Reject" }).click();
  const reject = page.getByRole("dialog", { name: "Reject VO-002" });
  await expect(reject.getByRole("button", { name: "Reject" })).toBeDisabled();
  await reject.getByLabel("Reason").fill("Rate needs a supplier quotation");
  await reject.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText(/Rejected by Brian Otieno/)).toBeVisible();
  await expect(page.getByText("Rate needs a supplier quotation").first()).toBeVisible();

  // Approving VO-001 makes version 2; the rejected VO-002 is now stale too.
  await page.goto(`${BQ}/variations/${first}`);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Approve VO-001" })
    .getByRole("button", { name: "Approve and create version 2" })
    .click();
  await stepUp(page);
  await expect(page.getByText("Version 1 → Version 2")).toBeVisible();

  await switchPersona(context, "owner", token);
  await page.goto(`${BQ}/variations/${variation.id}`);
  await expect(
    page.getByText(/This variation is based on version 1, but version 2 has since been approved/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Rebase" }).click();
  await page
    .getByRole("dialog", { name: "Rebase VO-002" })
    .getByRole("button", { name: "Rebase onto version 2" })
    .click();
  await expect(page.getByText("Draft").first()).toBeVisible();
  await expect(page.getByText(/This variation is based on version 1/)).toHaveCount(0);
  const history = page.getByRole("list").filter({ hasText: "Rebased onto the newest version" });
  await expect(history).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.goto(`${BQ}/variations?status=draft`);
  await expect(page.getByRole("table", { name: "Variation orders" })).toContainText("VO-002");
  await expect(page.getByRole("table", { name: "Variation orders" })).not.toContainText("VO-001");
});

test("keeps a versioned rate build-up library and links a BQ item to it", async ({
  page,
  context,
}) => {
  await signInAs(context, "owner");
  await page.goto("/rate-buildups");
  await expect(page.getByRole("heading", { name: "Rate build-ups", level: 1 })).toBeVisible();
  await expect(page.getByText(/A lorry trip is not a universal mass or volume/)).toBeVisible();
  await expect(page.getByRole("row", { name: /CONC-C25-SYN/ })).toContainText("KES 13,285.25 / m³");
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("link", { name: "New build-up" }).click();
  await page.getByLabel("Code").fill("block-200");
  await page.getByLabel("Name").fill("Machine-cut stone walling 200 mm (synthetic)");
  await page.getByLabel("Rate per").selectOption({ label: "m²" });
  await page.getByLabel("Line 1: kind").selectOption({ label: "Material" });
  await page.getByLabel("Resource").first().fill("Machine-cut stone 200 mm");
  await page.getByLabel("Unit", { exact: true }).first().fill("No.");
  await page.getByLabel("Quantity").first().fill("12.5");
  await page.getByLabel("Waste %").first().fill("5");
  await page.getByLabel("Unit cost (KES)").first().fill("65");
  await page.getByLabel("Line 2: kind").selectOption({ label: "Labour" });
  await page.getByLabel("Resource").nth(1).fill("Mason");
  await page.getByLabel("Unit", { exact: true }).nth(1).fill("hr");
  await page.getByLabel("Quantity").nth(1).fill("0.8");
  // 12.5 × 1.05 × 65 = 853.125 → 853.13; 0.8 × 350 = 280
  await expect(page.getByTestId("buildup-rate-preview")).toContainText(
    "Unavailable (1 line without a unit cost)",
  );
  await page.getByLabel("Unit cost (KES)").nth(1).fill("350");
  await expect(page.getByTestId("buildup-rate-preview")).toContainText("KES 1,133.13");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Create build-up" }).click();
  await expect(
    page.getByRole("heading", { name: /BLOCK-200 · Machine-cut stone walling/ }),
  ).toBeVisible();
  await expect(page.getByTestId("buildup-rate")).toContainText("KES 1,133.13");

  // Editing saves version 2; version 1 keeps its rate.
  await page.getByLabel("Unit cost (KES)").nth(1).fill("400");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByTestId("buildup-rate")).toContainText("KES 1,173.13");
  await page.getByRole("link", { name: "Version 1" }).click();
  await expect(page.getByTestId("buildup-rate")).toContainText("KES 1,133.13");
  expect(await axeViolations(page)).toEqual([]);

  // Link a m³ item of the approved BQ to the concrete build-up (only m³ build-ups are offered).
  await approveBaseline(page);
  await page.getByRole("button", { name: /Bill 2: SUBSTRUCTURE/ }).click();
  await page
    .getByRole("button", { name: /^Link build-up: B · Reinforced concrete class 25 in column/ })
    .click();
  const link = page.getByRole("dialog", { name: "Link to a rate build-up" });
  const select = link.getByLabel("Build-up");
  await expect(select.getByRole("option")).toHaveCount(2);
  await select.selectOption({ index: 1 });
  await link.getByRole("button", { name: "Link", exact: true }).click();
  await expect(
    page.getByRole("row", { name: /Reinforced concrete class 25 in column bases/ }),
  ).toContainText("Build-up CONC-C25-SYN v1: KES 13,285.25");
  expect(await axeViolations(page)).toEqual([]);
});

const pagesFor = (variationId: string) => [
  BQ,
  `${BQ}/variations`,
  `${BQ}/variations/${variationId}`,
  `${BQ}/instructions`,
  `${BQ}/versions`,
  "/rate-buildups",
  "/rate-buildups/50000000-0000-4000-8000-000000000001",
  "/bq",
  `/projects/${RUIRU_ID}`,
];

// One test walks every combination, so the pages are compiled and scanned one at a time.
test("D2.3 pages are accessible in EN/SW and light/dark", async ({ page, context }) => {
  test.setTimeout(300_000);
  await signInAs(context, "owner");
  const variationId = await seedSubmittedVariation(page);
  for (const locale of ["en", "sw"] as const)
    for (const theme of ["light", "dark"] as const) {
      await preferences(context, page, locale, theme);
      for (const path of pagesFor(variationId)) {
        await page.goto(path);
        await expect(page.locator("main h1").first()).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        expect(await axeViolations(page), `${path} (${locale}, ${theme})`).toEqual([]);
      }
    }
});

test("D2.3 pages fit a 360 px Android viewport", async ({ page, context }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await signInAs(context, "owner");
  const variationId = await seedSubmittedVariation(page);
  for (const path of pagesFor(variationId)) {
    await page.goto(path);
    await expect(page.locator("main h1").first()).toBeVisible();
    await expectNoHorizontalScroll(page, path);
  }
});
