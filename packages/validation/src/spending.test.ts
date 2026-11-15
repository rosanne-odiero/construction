import { describe, expect, it } from "vitest";
import {
  createExpenseRequestSchema,
  createJournalRequestSchema,
  smsParseRequestSchema,
  updateSpendingSettingsRequestSchema,
} from "./spending.js";

const expense = {
  id: "0195f0a0-0000-7000-8000-000000000001",
  floatId: "0195f0a0-0000-7000-8000-000000000002",
  capturedAt: "2026-11-14T08:00:00.000+03:00",
  spentOn: "2026-11-14",
  amountMinor: 85_000,
  category: "materials",
  costCodeId: "0195f0a0-0000-7000-8000-000000000003",
  counterpartyKind: "other",
  payeeName: "Mwangi Hardware (synthetic)",
  paymentMethod: "mpesa",
  mpesaCode: " skc3d4e5f6 ",
  parsedFromSms: true,
  smsKind: "till",
  description: "Binding wire and nails",
};

describe("spending contracts", () => {
  it("accepts an SMS-drafted expense and normalises the M-Pesa code", () => {
    const parsed = createExpenseRequestSchema.parse(expense);
    expect([parsed.mpesaCode, parsed.chargeMinor, parsed.source]).toEqual(["SKC3D4E5F6", 0, "web"]);
  });

  it("refuses an expense without a BQ item or cost code, or with inconsistent payment fields", () => {
    const issues = (input: object) =>
      createExpenseRequestSchema
        .safeParse({ ...expense, ...input })
        .error?.issues.map((issue) => issue.message);
    expect(issues({ costCodeId: null })).toEqual(["item_or_cost_code"]);
    expect(issues({ mpesaCode: null })).toContain("mpesa_code_required");
    expect(issues({ paymentMethod: "cash", mpesaCode: null, chargeMinor: 100 })).toContain(
      "cash_has_no_charge",
    );
    expect(issues({ counterpartyKind: "supplier" })).toEqual(["supplier_mismatch"]);
    expect(issues({ smsKind: "received" })).toBeDefined();
    expect(issues({ spentOn: "2100-01-01" })).toEqual(["date_out_of_range"]);
    expect(issues({ mpesaCode: "1234567890" })).toContain("invalid_mpesa_code");
  });

  it("counts characters, not UTF-16 units, in text limits", () => {
    expect(smsParseRequestSchema.safeParse({ text: "😀".repeat(1_000) }).success).toBe(true);
    expect(smsParseRequestSchema.safeParse({ text: "😀".repeat(1_001) }).success).toBe(false);
    const name = "😀".repeat(200);
    expect(createExpenseRequestSchema.safeParse({ ...expense, payeeName: name }).success).toBe(
      true,
    );
    expect(
      createExpenseRequestSchema.safeParse({ ...expense, payeeName: `${name}x` }).success,
    ).toBe(false);
  });

  it("needs the opening cash amount and date together, and no zero journal lines", () => {
    const settings = {
      version: 0,
      budgetAlertPercent: 80,
      unusualSpendMultiplier: "3",
      unusualSpendMinSamples: 5,
      duplicateWindowDays: 3,
      forecastWeeks: 13,
      openingCashMinor: 100_000,
      openingCashOn: null,
    };
    expect(updateSpendingSettingsRequestSchema.safeParse(settings).success).toBe(false);
    expect(
      updateSpendingSettingsRequestSchema.safeParse({ ...settings, openingCashOn: "2026-11-01" })
        .success,
    ).toBe(true);
    expect(
      updateSpendingSettingsRequestSchema.safeParse({ ...settings, unusualSpendMultiplier: "0.5" })
        .success,
    ).toBe(false);
    const line = {
      measure: "accrued",
      category: "plant",
      costCodeId: expense.costCodeId,
      counterpartyKind: "none",
      occurredOn: "2026-11-10",
      amountMinor: 0,
    };
    expect(
      createJournalRequestSchema.safeParse({
        projectId: expense.floatId,
        reason: "Plant hire paid by bank",
        lines: [line],
      }).success,
    ).toBe(false);
  });
});
