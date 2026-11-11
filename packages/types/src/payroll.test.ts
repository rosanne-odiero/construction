import { describe, expect, it } from "vitest";
import {
  DEFAULT_MINIMUM_WAGE_OCCUPATION,
  ENGAGEMENT_TYPES,
  KENYA_MINIMUM_WAGES_2026,
  KENYA_STATUTORY_SEED,
  MFA_REQUIRED_PERMISSIONS,
  MINIMUM_WAGE_AREAS,
  MINIMUM_WAGE_OCCUPATIONS,
  NCA_CATEGORIES,
  PROJECT_ASSIGNABLE_PERMISSIONS,
  STATUTORY_ITEMS,
  STATUTORY_RULE_KINDS,
  SYSTEM_ROLE_PERMISSIONS,
  TENANT_LEVEL_PERMISSIONS,
} from "./index.js";

describe("payroll seed rules (COMPLIANCE-REVIEW)", () => {
  it("seeds every rule kind with a source and notes", () => {
    for (const kind of STATUTORY_RULE_KINDS)
      expect(
        KENYA_STATUTORY_SEED.some((rule) => rule.kind === kind),
        kind,
      ).toBe(true);
    for (const rule of KENYA_STATUTORY_SEED) {
      expect(rule.sourceReference.length, rule.kind).toBeGreaterThan(40);
      expect(rule.notes.length, rule.kind).toBeGreaterThan(20);
      expect(rule.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("keeps the researched PAYE bands, relief and pre-tax deductions", () => {
    const paye = KENYA_STATUTORY_SEED.find((rule) => rule.kind === "paye");
    if (paye?.kind !== "paye") throw new Error("paye missing");
    expect(paye.parameters.bands).toEqual([
      { upToMinor: 2_400_000, ratePercent: "10" },
      { upToMinor: 3_233_300, ratePercent: "25" },
      { upToMinor: 50_000_000, ratePercent: "30" },
      { upToMinor: 80_000_000, ratePercent: "32.5" },
      { upToMinor: null, ratePercent: "35" },
    ]);
    expect(paye.parameters.personalReliefMinor).toBe(240_000);
    expect(paye.parameters.deductibleBeforeTax).toEqual(["nssf", "shif", "ahl"]);
    expect(paye.effectiveFrom).toBe("2024-12-27");
  });

  it("seeds NSSF Year 3 and Year 4 so effective dating is exercised", () => {
    const nssf = KENYA_STATUTORY_SEED.filter((rule) => rule.kind === "nssf");
    expect(nssf.map((rule) => [rule.effectiveFrom, rule.parameters])).toEqual([
      [
        "2025-02-01",
        {
          employeeRatePercent: "6",
          employerRatePercent: "6",
          lowerEarningsLimitMinor: 800_000,
          upperEarningsLimitMinor: 7_200_000,
        },
      ],
      [
        "2026-02-01",
        {
          employeeRatePercent: "6",
          employerRatePercent: "6",
          lowerEarningsLimitMinor: 900_000,
          upperEarningsLimitMinor: 10_800_000,
        },
      ],
    ]);
  });

  it("applies every statutory item to every engagement type until the adviser decides (Q-C2)", () => {
    const rule = KENYA_STATUTORY_SEED.find((entry) => entry.kind === "applicability");
    if (rule?.kind !== "applicability") throw new Error("applicability missing");
    for (const type of ENGAGEMENT_TYPES)
      for (const item of STATUTORY_ITEMS) expect(rule.parameters[type][item]).toBe(true);
  });

  it("seeds the 2026 General Order table for every area and occupation", () => {
    expect(KENYA_MINIMUM_WAGES_2026).toHaveLength(
      MINIMUM_WAGE_AREAS.length * MINIMUM_WAGE_OCCUPATIONS.length,
    );
    const general = KENYA_MINIMUM_WAGES_2026.find(
      (row) => row.occupation === "general_labourer" && row.area === "cities",
    );
    expect(general?.monthlyMinor).toBe(1_804_740);
    for (const row of KENYA_MINIMUM_WAGES_2026) {
      expect(row.effectiveFrom).toBe("2026-05-01");
      expect(row.source).toContain("Legal Notice 95 of 2026");
    }
    for (const category of NCA_CATEGORIES)
      expect(MINIMUM_WAGE_OCCUPATIONS).toContain(DEFAULT_MINIMUM_WAGE_OCCUPATION[category]);
  });
});

describe("payroll permissions", () => {
  it("keeps rule management, verification and exports company-level", () => {
    for (const permission of ["payroll.manage_rules", "payroll.verify_rules", "payroll.export"])
      expect(TENANT_LEVEL_PERMISSIONS).toContain(permission);
    for (const permission of ["payroll.view", "advances.request", "advances.approve"])
      expect(PROJECT_ASSIGNABLE_PERMISSIONS).toContain(permission);
  });

  it("requires MFA for rule verification and exports", () => {
    expect(MFA_REQUIRED_PERMISSIONS).toContain("payroll.verify_rules");
    expect(MFA_REQUIRED_PERMISSIONS).toContain("payroll.export");
  });

  it("gives preparers, finance and site roles sensible defaults", () => {
    expect(SYSTEM_ROLE_PERMISSIONS.project_manager).toEqual(
      expect.arrayContaining(["payroll.view", "payroll.prepare", "advances.request"]),
    );
    expect(SYSTEM_ROLE_PERMISSIONS.project_manager).not.toContain("payroll.verify_rules");
    expect(SYSTEM_ROLE_PERMISSIONS.finance).toEqual(
      expect.arrayContaining([
        "payroll.view",
        "payroll.manage_rules",
        "payroll.verify_rules",
        "payroll.export",
        "advances.approve",
      ]),
    );
    expect(SYSTEM_ROLE_PERMISSIONS.finance).not.toContain("payroll.prepare");
    expect(SYSTEM_ROLE_PERMISSIONS.foreman).toContain("advances.request");
    expect(SYSTEM_ROLE_PERMISSIONS.foreman).not.toContain("payroll.view");
    expect(SYSTEM_ROLE_PERMISSIONS.site_agent).not.toContain("payroll.prepare");
  });
});
