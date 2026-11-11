import { describe, expect, it } from "vitest";
import { digestOf, snapshotOf, type BatchRows, type BatchTarget } from "./batch-builder.js";
import { csvText } from "./exports.service.js";

const target: BatchTarget = {
  id: "0193a4c2-7d1e-7b2a-9c3d-4e5f60718293",
  projectId: "0193a4c2-7d1e-7b2a-9c3d-4e5f60718294",
  periodStart: "2026-11-06",
  periodEnd: "2026-11-12",
  payDate: "2026-11-13",
  frequency: "weekly",
};

const rows = (lineId: string, earningId: string): BatchRows => ({
  lines: [
    {
      id: lineId,
      tenantId: "t",
      projectId: target.projectId,
      batchId: target.id,
      labourerId: "w1",
      workerNo: "WRK-0001",
      fullName: "Mfanyakazi Mmoja",
      tradeNameEn: "Mason",
      tradeNameSw: "Fundi mwashi",
      engagementType: "casual",
      rateBasis: "daily",
      halfDays: 2,
      normalMinutes: 480,
      otWeekdayMinutes: 0,
      otRestDayMinutes: 0,
      otHolidayMinutes: 0,
      daysWorked: 1,
      grossMinor: 100_000n,
      statutoryBaseMinor: 100_000n,
      statutoryWithheldMinor: 31_500n,
      advanceRecoveryMinor: 0n,
      otherDeductionsMinor: 0n,
      netMinor: 68_500n,
      employerCostMinor: 12_500n,
      statutoryMonth: "2026-11",
      monthToDate: { statutoryMonth: "2026-11" },
      warnings: [],
      payeePhoneBidx: null,
    },
  ],
  earnings: [
    {
      id: earningId,
      tenantId: "t",
      batchId: target.id,
      lineId,
      position: 0,
      kind: "attendance",
      category: "weekday",
      workDate: new Date("2026-11-09T00:00:00.000Z"),
      quantity: "1.000",
      unit: "day",
      rateMinor: 100_000n,
      multiplier: null,
      description: "attendance",
      amountMinor: 100_000n,
      taxable: true,
      labourRateId: "rate",
      timesheetRuleId: "rule",
      timesheetLineId: "tl",
      shareId: null,
      allowanceId: null,
    },
  ],
  deductions: [],
  recoveries: [],
  consumptions: [
    {
      id: `${lineId}-c`,
      tenantId: "t",
      projectId: target.projectId,
      batchId: target.id,
      sourceKind: "timesheet_line",
      timesheetLineId: "tl",
    },
  ],
  claims: [],
});

const snapshot = (lineId: string, earningId: string, quantity = "1.000") => {
  const data = rows(lineId, earningId);
  data.earnings[0]!.quantity = quantity;
  return snapshotOf({
    target,
    statutoryMonth: "2026-11",
    unverifiedRules: true,
    rules: [],
    timesheetRules: [],
    mtdBatchIds: [],
    rows: data,
    exclusions: [],
    totals: { grossMinor: 100_000 },
  });
};

describe("payroll snapshot digest", () => {
  it("ignores row IDs and decimal formatting, so an unchanged recalculation keeps its digest", () => {
    expect(digestOf(snapshot("line-a", "earning-a"))).toBe(
      digestOf(snapshot("line-b", "earning-b", "1")),
    );
  });

  it("changes when a paid value changes", () => {
    expect(digestOf(snapshot("line-a", "earning-a"))).not.toBe(
      digestOf(snapshot("line-a", "earning-a", "1.5")),
    );
  });
});

describe("statutory export cells", () => {
  it("neutralises spreadsheet formulas and quotes separators", () => {
    expect(csvText('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvText("+254700000001")).toBe("'+254700000001");
    expect(csvText("@cmd")).toBe("'@cmd");
    expect(csvText("-1")).toBe("'-1");
    expect(csvText("Wanjiku, Mary")).toBe('"Wanjiku, Mary"');
    expect(csvText("A000000001Z")).toBe("A000000001Z");
  });
});
