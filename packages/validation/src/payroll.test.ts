import { describe, expect, it } from "vitest";
import { KENYA_STATUTORY_SEED } from "@pm-buddy/types";
import {
  createAdvanceRequestSchema,
  createAllowanceRequestSchema,
  createOutputRequestSchema,
  createStatutoryRuleRequestSchema,
  exportRequestSchema,
  updatePayrollSettingsRequestSchema,
} from "./index.js";

const uuid = "0193a4c2-7d1e-7b2a-9c3d-4e5f60718293";

describe("payroll request schemas", () => {
  it("accepts every seeded statutory rule version as a new-version request", () => {
    for (const seed of KENYA_STATUTORY_SEED)
      expect(
        createStatutoryRuleRequestSchema.safeParse({
          kind: seed.kind,
          effectiveFrom: seed.effectiveFrom,
          parameters: seed.parameters,
          sourceReference: seed.sourceReference.slice(0, 2000),
          notes: seed.notes,
        }).success,
        seed.kind,
      ).toBe(true);
  });

  it("refuses out-of-order PAYE bands, mismatched kinds and unknown methods", () => {
    const base = { effectiveFrom: "2027-01-01", sourceReference: "Adviser letter 2027", notes: "" };
    const bands = createStatutoryRuleRequestSchema.safeParse({
      ...base,
      kind: "paye",
      parameters: {
        bands: [
          { upToMinor: 500, ratePercent: "10" },
          { upToMinor: 100, ratePercent: "20" },
          { upToMinor: null, ratePercent: "30" },
        ],
        personalReliefMinor: 0,
        deductibleBeforeTax: [],
      },
    });
    expect(bands.success).toBe(false);
    expect(
      createStatutoryRuleRequestSchema.safeParse({
        ...base,
        kind: "nita",
        parameters: { employeeRatePercent: "1", employerRatePercent: "1" },
      }).success,
    ).toBe(false);
    expect(
      createStatutoryRuleRequestSchema.safeParse({
        ...base,
        kind: "method",
        parameters: { method: "period_equivalent" },
      }).success,
    ).toBe(false);
  });

  it("checks advances, outputs and allowances", () => {
    expect(
      createAdvanceRequestSchema.safeParse({
        labourerId: uuid,
        amountMinor: 100_000,
        reason: "School fees for the term",
        instalmentMinor: 200_000,
      }).success,
    ).toBe(false);
    expect(
      createOutputRequestSchema.safeParse({
        workDate: "2026-11-10",
        labourerId: uuid,
        gangId: uuid,
        description: "Blockwork",
        unit: "m2",
        quantity: "12.5",
        rateMinor: 15_000,
      }).success,
    ).toBe(false);
    expect(
      createOutputRequestSchema.safeParse({
        workDate: "2026-11-10",
        gangId: uuid,
        description: "Blockwork",
        unit: "m2",
        quantity: "12.5",
        rateMinor: 15_000,
      }).success,
    ).toBe(true);
    expect(
      createAllowanceRequestSchema.safeParse({
        code: "transport",
        nameEn: "Transport",
        nameSw: "Usafiri",
        basis: "per_day_worked",
        amountMinor: 10_000,
        taxable: true,
        tradeId: uuid,
        labourerId: uuid,
        effectiveFrom: "2026-11-01",
      }).success,
    ).toBe(false);
  });

  it("bounds settings and export months", () => {
    expect(
      updatePayrollSettingsRequestSchema.safeParse({
        advanceMaxMinor: 500_000,
        advanceMaxOutstandingMinor: 100_000,
        recoveryMaxPercent: "50",
        version: 0,
      }).success,
    ).toBe(false);
    expect(
      updatePayrollSettingsRequestSchema.safeParse({
        advanceMaxMinor: 500_000,
        advanceMaxOutstandingMinor: 1_000_000,
        recoveryMaxPercent: "101",
        version: 0,
      }).success,
    ).toBe(false);
    expect(exportRequestSchema.safeParse({ month: "2026-13", kind: "paye" }).success).toBe(false);
    expect(exportRequestSchema.safeParse({ month: "2026-11", kind: "nssf" }).success).toBe(true);
  });
});
