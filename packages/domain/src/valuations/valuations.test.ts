import { describe, expect, it } from "vitest";
import { workingCalendar } from "../schedule/calendar.js";
import {
  divideHalfUp,
  percentageOf,
  percentText,
  ratioText,
  safeMinor,
  scaled,
  unscaled,
} from "./arithmetic.js";
import {
  adjustmentSignOk,
  computeCertificate,
  recoveryWithinAdvances,
  releaseCertificate,
  retentionFigures,
  retentionStageAfter,
  type ContractTerms,
} from "./certificate.js";
import {
  costToComplete,
  earnedValueFigures,
  PlannedValue,
  runningTotal,
  sCurve,
  stepValueAt,
  weekEndOf,
  weekEnds,
  WorkingDayCounter,
} from "./evm.js";
import { VALUATION_TRANSITIONS, valuationCode } from "./lifecycle.js";
import {
  checkMeasuredQuantity,
  measuredPercent,
  measuredValueMinor,
  measurementBasis,
  measurementState,
  measurementsInForce,
  type MeasurableItem,
} from "./measurement.js";

/**
 * Golden cases for KE-VAL-1 (worked by hand; the API e2e test certifies the same figures). BQ:
 * P1 site establishment lump sum 500,000.00; A concrete 24 m³ @ 16,500 = 396,000.00; B blockwork
 * 120 m² @ 1,450 = 174,000.00; PS1 provisional sum 300,000.00; D1 dayworks 100 hr @ 450 =
 * 45,000.00. Original contract sum 1,415,000.00. Terms: retention 10 % limited to 5 % of the
 * original contract sum (70,750.00), VAT 16 %, materials on site at 80 %, half released at
 * practical completion.
 */
const P1: MeasurableItem = {
  kind: "preliminary",
  amountSource: "lump_sum",
  quantity: null,
  rate: null,
  amountMinor: 50_000_000,
};
const A: MeasurableItem = {
  kind: "measured",
  amountSource: "computed",
  quantity: "24",
  rate: "16500",
  amountMinor: 39_600_000,
};
const B: MeasurableItem = {
  kind: "measured",
  amountSource: "computed",
  quantity: "120",
  rate: "1450",
  amountMinor: 17_400_000,
};
const PS1: MeasurableItem = {
  kind: "provisional_sum",
  amountSource: "lump_sum",
  quantity: null,
  rate: null,
  amountMinor: 30_000_000,
};
const D1: MeasurableItem = {
  kind: "daywork",
  amountSource: "computed",
  quantity: "100",
  rate: "450",
  amountMinor: 4_500_000,
};
const TERMS: ContractTerms = {
  retentionPercent: "10",
  retentionCapPercent: "5",
  vatPercent: "16",
  materialsPercent: "80",
  practicalReleasePercent: "50",
};
const ORIGINAL = 141_500_000;

describe("arithmetic", () => {
  it("rounds half away from zero, like PostgreSQL round()", () => {
    expect(divideHalfUp(5n, 2n)).toBe(3n);
    expect(divideHalfUp(-5n, 2n)).toBe(-3n);
    expect(divideHalfUp(4n, 3n)).toBe(1n);
    expect(divideHalfUp(-4n, 3n)).toBe(-1n);
    expect(() => divideHalfUp(1n, 0n)).toThrow(RangeError);
    expect(percentageOf(5, "10")).toBe(1); // 0.5 → 1
    expect(percentageOf(-5, "10")).toBe(-1);
    expect(percentageOf(12_345, "12.5")).toBe(1_543); // 1543.125
  });

  it("scales decimals exactly and refuses extra precision", () => {
    expect(scaled("12.345", 4)).toBe(123_450n);
    expect(scaled("-0.5", 2)).toBe(-50n);
    expect(scaled("7.100", 2)).toBe(710n);
    expect(() => scaled("1.23456", 4)).toThrow(RangeError);
    expect(() => scaled("1e3", 4)).toThrow(TypeError);
    // Long runs of zeros are trimmed in linear time (a regex trim was quadratic: CodeQL).
    const started = Date.now();
    expect(scaled(`2.${"0".repeat(200_000)}`, 4)).toBe(20_000n);
    expect(() => scaled(`1.${"0".repeat(200_000)}1`, 4)).toThrow(RangeError);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(unscaled(123_450n, 4)).toBe("12.345");
    expect(unscaled(-50n, 2)).toBe("-0.5");
    expect(unscaled(1_000n, 2)).toBe("10");
    expect(() => safeMinor(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(RangeError);
  });

  it("truncates percentages and leaves undefined ratios unavailable", () => {
    expect(percentText(7_996n, 10_000n)).toBe("79.9");
    expect(percentText(1n, 3n, 2)).toBe("33.33");
    expect(percentText(-1n, 3n)).toBe("-33.4");
    expect(percentText(5n, 0n)).toBeNull();
    expect(percentText(5n, -1n)).toBeNull();
    expect(ratioText(2n, 3n)).toBe("0.67");
    expect(ratioText(-2n, 3n)).toBe("-0.67");
    expect(ratioText(1n, 0n)).toBeNull();
    expect(ratioText(10n, 4n, 0)).toBe("3");
  });
});

describe("measurement", () => {
  it("measures by quantity, by percent, or not at all", () => {
    expect(measurementBasis(A)).toBe("quantity");
    expect(measurementBasis(D1)).toBe("quantity");
    expect(measurementBasis(P1)).toBe("percent");
    expect(measurementBasis(PS1)).toBeNull();
    expect(measurementBasis({ ...PS1, kind: "pc_sum" })).toBeNull();
    expect(measurementBasis({ ...PS1, kind: "contingency" })).toBeNull();
    expect(measurementBasis({ ...A, amountMinor: 0, amountSource: "omitted" })).toBeNull();
    expect(measurementBasis({ ...A, quantity: "0" })).toBe("percent");
  });

  it("values work done: quantity × rate, pro rata, or percent of a lump sum", () => {
    expect(measuredValueMinor(A, "10")).toBe(16_500_000);
    expect(measuredValueMinor(B, "30.5")).toBe(4_422_500);
    expect(measuredValueMinor(D1, "12.5")).toBe(562_500);
    expect(measuredValueMinor(P1, "40")).toBe(20_000_000);
    expect(measuredValueMinor(P1, "33.33")).toBe(16_665_000);
    // 0.0001 m³ × 16,500 = 1.65 → 165 minor; 0.00003 would be refused upstream (4 places).
    expect(measuredValueMinor(A, "0.0001")).toBe(165);
    // 0.0003 m² × 1,450.0050 = 0.435 → 0.44 (half away from zero, once).
    expect(measuredValueMinor({ ...B, rate: "1450.005" }, "0.0003")).toBe(44);
    // A sheet override is valued pro rata, so 100 % is exactly its amount.
    const override = { ...B, amountSource: "sheet_override" as const, amountMinor: 17_400_001 };
    expect(measuredValueMinor(override, "120")).toBe(17_400_001);
    expect(measuredValueMinor(override, "60")).toBe(8_700_001); // 8,700,000.5 → up
    expect(measuredValueMinor(PS1, "50")).toBe(0);
    // Over-measured work is valued in full at the BQ rate.
    expect(measuredValueMinor(B, "126")).toBe(18_270_000);
  });

  it("refuses over 100 % of a lump sum and over-measure without a reason", () => {
    expect(checkMeasuredQuantity("percent", null, "100", null)).toEqual({
      ok: true,
      overMeasured: false,
    });
    expect(checkMeasuredQuantity("percent", null, "100.01", "more")).toEqual({
      ok: false,
      problem: "percent-over-100",
    });
    expect(checkMeasuredQuantity("quantity", "120", "120", null)).toEqual({
      ok: true,
      overMeasured: false,
    });
    expect(checkMeasuredQuantity("quantity", "120", "120.0001", " ")).toEqual({
      ok: false,
      problem: "over-measure-reason-required",
    });
    expect(checkMeasuredQuantity("quantity", "120", "126", "Remeasured on site")).toEqual({
      ok: true,
      overMeasured: true,
    });
    expect(checkMeasuredQuantity(null, null, "1", null)).toEqual({
      ok: false,
      problem: "not-measured",
    });
  });

  it("shows physical percent complete, unavailable without a basis", () => {
    expect(measuredPercent(B, "30.5")).toBe("25.4");
    expect(measuredPercent(B, "126")).toBe("105.0");
    expect(measuredPercent(P1, "40")).toBe("40.0");
    expect(measuredPercent(PS1, "40")).toBeNull();
  });

  it("derives the state from the review and the correction", () => {
    expect(measurementState({ decision: null, correctedBy: null })).toBe("pending");
    expect(measurementState({ decision: null, correctedBy: { decision: null } })).toBe("withdrawn");
    expect(measurementState({ decision: "rejected", correctedBy: null })).toBe("rejected");
    expect(measurementState({ decision: "approved", correctedBy: null })).toBe("approved");
    expect(measurementState({ decision: "approved", correctedBy: { decision: null } })).toBe(
      "approved",
    );
    expect(measurementState({ decision: "approved", correctedBy: { decision: "rejected" } })).toBe(
      "approved",
    );
    expect(measurementState({ decision: "approved", correctedBy: { decision: "approved" } })).toBe(
      "superseded",
    );
  });

  it("keeps the newest approved measurement per item on a date", () => {
    const rows = [
      { id: "1", lineageId: "a", measuredOn: "2026-08-01", recordedAt: "t1", state: "approved" },
      { id: "2", lineageId: "a", measuredOn: "2026-09-01", recordedAt: "t2", state: "approved" },
      { id: "3", lineageId: "a", measuredOn: "2026-09-01", recordedAt: "t3", state: "pending" },
      { id: "4", lineageId: "b", measuredOn: "2026-08-15", recordedAt: "t1", state: "superseded" },
      { id: "5", lineageId: "b", measuredOn: "2026-08-15", recordedAt: "t2", state: "approved" },
      { id: "6", lineageId: "b", measuredOn: "2026-08-15", recordedAt: "t2", state: "approved" },
      { id: "7", lineageId: "c", measuredOn: "2026-10-01", recordedAt: "t1", state: "approved" },
    ] as const;
    const august = measurementsInForce(rows, "2026-08-31");
    expect(august.get("a")?.id).toBe("1");
    expect(august.get("b")?.id).toBe("6");
    expect(august.has("c")).toBe(false);
    expect(measurementsInForce(rows, "2026-09-30").get("a")?.id).toBe("2");
  });
});

describe("certificates (KE-VAL-1)", () => {
  const first = computeCertificate({
    // P1 40 % 200,000 + A 10 m³ 165,000 + B 30.5 m² 44,225 + D1 12.5 hr 5,625.
    workDoneMinor: 20_000_000 + 16_500_000 + 4_422_500 + 562_500,
    materialsGrossMinor: 4_000_000,
    adjustmentsMinor: 10_000_000,
    adjustmentsBeforeMinor: 0,
    previousCertifiedMinor: 0,
    stage: "none",
    originalContractSumMinor: ORIGINAL,
    terms: TERMS,
  });

  it("certifies IPC-0001 from measured work, materials at 80 %, retention and an advance", () => {
    expect(first).toEqual({
      workDoneMinor: 41_485_000,
      materialsGrossMinor: 4_000_000,
      materialsMinor: 3_200_000,
      grossMinor: 44_685_000,
      retentionStage: "none",
      retentionCapMinor: 7_075_000,
      retentionComputedMinor: 4_468_500,
      retentionHeldMinor: 4_468_500,
      adjustmentsMinor: 10_000_000,
      adjustmentsToDateMinor: 10_000_000,
      netToDateMinor: 50_216_500,
      previousCertifiedMinor: 0,
      amountDueMinor: 50_216_500,
      vatMinor: 8_034_640,
      totalMinor: 58_251_140,
    });
  });

  const second = computeCertificate({
    // P1 70 % 350,000 + A 24 m³ 396,000 + B 126 m² 182,700 (over-measured) + D1 5,625.
    workDoneMinor: 35_000_000 + 39_600_000 + 18_270_000 + 562_500,
    materialsGrossMinor: 0,
    adjustmentsMinor: -5_000_000,
    adjustmentsBeforeMinor: first.adjustmentsToDateMinor,
    previousCertifiedMinor: first.amountDueMinor,
    stage: "none",
    originalContractSumMinor: ORIGINAL,
    terms: TERMS,
  });

  it("nets IPC-0002 off IPC-0001, with the limit of retention and an advance recovery", () => {
    expect(second).toMatchObject({
      workDoneMinor: 93_432_500,
      grossMinor: 93_432_500,
      retentionCapMinor: 7_075_000,
      // 10 % would be 9,343,250: the limit applies.
      retentionComputedMinor: 7_075_000,
      retentionHeldMinor: 7_075_000,
      adjustmentsToDateMinor: 5_000_000,
      netToDateMinor: 91_357_500,
      previousCertifiedMinor: 50_216_500,
      amountDueMinor: 41_141_000,
      vatMinor: 6_582_560,
      totalMinor: 47_723_560,
    });
  });

  it("releases half the retention at practical completion and the rest at final completion", () => {
    const practical = releaseCertificate({
      previous: second,
      previousCertifiedMinor: first.amountDueMinor + second.amountDueMinor,
      stage: "practical",
      originalContractSumMinor: ORIGINAL,
      terms: TERMS,
    });
    expect(practical).toMatchObject({ ok: true, releasedMinor: 3_537_500 });
    if (!practical.ok) throw new Error("expected a release");
    expect(practical.figures).toMatchObject({
      retentionHeldMinor: 3_537_500,
      adjustmentsMinor: 0,
      adjustmentsToDateMinor: 5_000_000,
      amountDueMinor: 3_537_500,
      vatMinor: 566_000,
      totalMinor: 4_103_500,
    });
    const final = releaseCertificate({
      previous: practical.figures,
      previousCertifiedMinor: 91_357_500 + 3_537_500,
      stage: "final",
      originalContractSumMinor: ORIGINAL,
      terms: TERMS,
    });
    expect(final).toMatchObject({ ok: true, releasedMinor: 3_537_500 });
    if (!final.ok) throw new Error("expected a release");
    expect(final.figures.retentionHeldMinor).toBe(0);
    expect(
      releaseCertificate({
        previous: final.figures,
        previousCertifiedMinor: 0,
        stage: "final",
        originalContractSumMinor: ORIGINAL,
        terms: TERMS,
      }),
    ).toEqual({ ok: false, problem: "nothing-to-release" });
  });

  it("never releases more than is held, nor a negative amount", () => {
    // Retention raised to 20 % after IPC-0002: the practical "release" would hold more.
    expect(
      releaseCertificate({
        previous: { ...second, retentionHeldMinor: 1_000 },
        previousCertifiedMinor: 91_357_500,
        stage: "practical",
        originalContractSumMinor: ORIGINAL,
        terms: { ...TERMS, retentionCapPercent: null, retentionPercent: "20" },
      }),
    ).toEqual({ ok: false, problem: "release-exceeds-held" });
  });

  it("applies no limit when none is set and never holds negative retention", () => {
    expect(
      retentionFigures({
        grossMinor: 93_432_500,
        originalContractSumMinor: ORIGINAL,
        stage: "none",
        terms: { ...TERMS, retentionCapPercent: null },
      }),
    ).toEqual({ capMinor: null, computedMinor: 9_343_250, heldMinor: 9_343_250 });
    expect(
      retentionFigures({
        grossMinor: 0,
        originalContractSumMinor: ORIGINAL,
        stage: "final",
        terms: TERMS,
      }),
    ).toEqual({ capMinor: 7_075_000, computedMinor: 0, heldMinor: 0 });
  });

  it("corrects an over-certified certificate with a negative one", () => {
    const corrected = computeCertificate({
      workDoneMinor: 30_000_000,
      materialsGrossMinor: 0,
      adjustmentsMinor: 0,
      adjustmentsBeforeMinor: first.adjustmentsToDateMinor,
      previousCertifiedMinor: first.amountDueMinor,
      stage: "none",
      originalContractSumMinor: ORIGINAL,
      terms: { ...TERMS, materialsPercent: "100" },
    });
    // 300,000 − 30,000 + 100,000 − 502,165 = −132,165; VAT −21,146.40.
    expect(corrected.amountDueMinor).toBe(-13_216_500);
    expect(corrected.vatMinor).toBe(-2_114_640);
    expect(corrected.totalMinor).toBe(-15_331_140);
  });

  it("refuses unsafe or negative inputs", () => {
    const base = {
      workDoneMinor: 1,
      materialsGrossMinor: 0,
      adjustmentsMinor: 0,
      adjustmentsBeforeMinor: 0,
      previousCertifiedMinor: 0,
      stage: "none" as const,
      originalContractSumMinor: 0,
      terms: TERMS,
    };
    expect(() => computeCertificate({ ...base, workDoneMinor: 1.5 })).toThrow(RangeError);
    expect(() => computeCertificate({ ...base, materialsGrossMinor: -1 })).toThrow(RangeError);
  });

  it("checks adjustment signs and that recoveries never outweigh advances", () => {
    expect(adjustmentSignOk("advance", 100)).toBe(true);
    expect(adjustmentSignOk("advance", -100)).toBe(false);
    expect(adjustmentSignOk("advance_recovery", -100)).toBe(true);
    expect(adjustmentSignOk("advance_recovery", 100)).toBe(false);
    expect(adjustmentSignOk("contra_charge", -1)).toBe(true);
    expect(adjustmentSignOk("contra_charge", 1)).toBe(false);
    expect(adjustmentSignOk("other", -1)).toBe(true);
    expect(adjustmentSignOk("other", 0)).toBe(false);
    expect(adjustmentSignOk("other", 0.5)).toBe(false);
    expect(
      recoveryWithinAdvances([
        { kind: "advance", amountMinor: 10_000_000 },
        { kind: "advance_recovery", amountMinor: -5_000_000 },
        { kind: "contra_charge", amountMinor: -99_000_000 },
        { kind: "advance_recovery", amountMinor: -5_000_000 },
      ]),
    ).toBe(true);
    expect(
      recoveryWithinAdvances([
        { kind: "advance", amountMinor: 10_000_000 },
        { kind: "advance_recovery", amountMinor: -10_000_001 },
      ]),
    ).toBe(false);
  });

  it("holds the remaining retention on interims after a release", () => {
    expect(retentionStageAfter([])).toBe("none");
    expect(retentionStageAfter(["practical"])).toBe("practical");
    expect(retentionStageAfter(["practical", "final"])).toBe("final");
  });
});

describe("earned value", () => {
  it("states CPI, SPI, EAC, ETC and VAC, unavailable when undefined", () => {
    expect(
      earnedValueFigures({ bacMinor: 100_000, pvMinor: 50_000, evMinor: 40_000, acMinor: 32_000 }),
    ).toEqual({
      bacMinor: 100_000,
      pvMinor: 50_000,
      evMinor: 40_000,
      acMinor: 32_000,
      cvMinor: 8_000,
      svMinor: -10_000,
      cpi: "1.25",
      spi: "0.80",
      eacMinor: 80_000,
      etcMinor: 48_000,
      vacMinor: 20_000,
      percentComplete: "40.0",
      percentPlanned: "50.0",
    });
    const early = earnedValueFigures({ bacMinor: 0, pvMinor: null, evMinor: 0, acMinor: 0 });
    expect(early).toMatchObject({
      cpi: null,
      spi: null,
      svMinor: null,
      eacMinor: null,
      etcMinor: null,
      vacMinor: null,
      percentComplete: null,
      percentPlanned: null,
    });
    // Cost but nothing earned: CPI 0.00, EAC unavailable rather than infinite.
    expect(earnedValueFigures({ bacMinor: 10, pvMinor: 0, evMinor: 0, acMinor: 5 })).toMatchObject({
      cpi: "0.00",
      spi: null,
      eacMinor: null,
      percentPlanned: "0.0",
    });
  });

  const calendar = workingCalendar([1, 2, 3, 4, 5, 6], ["2026-03-06"]);

  it("counts working days in O(1) within its range", () => {
    // Mon 2 March – Sun 15 March 2026, Saturdays worked, Fri 6 March a holiday: 11 days.
    const counter = new WorkingDayCounter(calendar, "2026-03-02", "2026-03-15");
    expect(counter.count("2026-03-02", "2026-03-15")).toBe(11);
    expect(counter.count("2026-03-01", "2026-03-04")).toBe(3);
    expect(counter.count("2026-03-08", "2026-03-08")).toBe(0);
    expect(counter.count("2026-03-10", "2026-03-09")).toBe(0);
    expect(counter.count("2026-03-14", "2026-03-30")).toBe(1);
  });

  it("spreads planned value over the linked baseline tasks' working days", () => {
    const pv = new PlannedValue(calendar, { start: "2026-03-02", finish: "2026-03-14" }, [
      // 600 over Mon–Wed (3 days) and Mon–Wed next week (3 days): 100 a day.
      {
        amountMinor: 600,
        windows: [
          { start: "2026-03-02", finish: "2026-03-04" },
          { start: "2026-03-09", finish: "2026-03-11" },
        ],
      },
      // Unlinked: over the whole baseline (11 working days), 1,100.
      { amountMinor: 1_100, windows: [] },
      // A milestone-like window with no working day: a step on its date.
      { amountMinor: 50, windows: [{ start: "2026-03-08", finish: "2026-03-08" }] },
    ]);
    expect(pv.at("2026-03-01")).toBe(0);
    expect(pv.at("2026-03-02")).toBe(100 + 100);
    expect(pv.at("2026-03-07")).toBe(300 + 500);
    expect(pv.at("2026-03-08")).toBe(300 + 500 + 50);
    expect(pv.at("2026-03-14")).toBe(600 + 1_100 + 50);
    expect(pv.at("2026-12-31")).toBe(1_750);
    // 1,000 over three days rounds per item: 333.33 → 333, 666.67 → 667, then exactly 1,000.
    const thirds = new PlannedValue(calendar, { start: "2026-03-02", finish: "2026-03-04" }, [
      { amountMinor: 1_000, windows: [] },
    ]);
    expect([thirds.at("2026-03-02"), thirds.at("2026-03-03"), thirds.at("2026-03-04")]).toEqual([
      333, 667, 1_000,
    ]);
  });

  it("builds weekly Sunday week ends, keeping the latest when there are too many", () => {
    expect(weekEndOf("2026-03-02")).toBe("2026-03-08");
    expect(weekEndOf("2026-03-08")).toBe("2026-03-08");
    expect(weekEnds("2026-03-02", "2026-03-20", 10)).toEqual([
      "2026-03-08",
      "2026-03-15",
      "2026-03-22",
    ]);
    expect(weekEnds("2026-03-02", "2026-03-20", 2)).toEqual(["2026-03-15", "2026-03-22"]);
    expect(weekEnds("2026-03-20", "2026-03-02", 10)).toEqual([]);
  });

  it("evaluates step and running series and the S-curve up to the data date", () => {
    const steps = [
      { date: "2026-03-03", valueMinor: 100 },
      { date: "2026-03-10", valueMinor: 80 },
    ];
    expect(stepValueAt(steps, "2026-03-02")).toBe(0);
    expect(stepValueAt(steps, "2026-03-09")).toBe(100);
    expect(stepValueAt(steps, "2026-03-31")).toBe(80);
    const ac = runningTotal([
      { date: "2026-03-10", valueMinor: 30 },
      { date: "2026-03-03", valueMinor: 20 },
      { date: "2026-03-10", valueMinor: -5 },
    ]);
    expect([ac("2026-03-01"), ac("2026-03-03"), ac("2026-03-10"), ac("2026-04-01")]).toEqual([
      0, 20, 45, 45,
    ]);
    const curve = sCurve({
      weekEnds: ["2026-03-08", "2026-03-15", "2026-03-22"],
      dataDate: "2026-03-11",
      pv: (date) => (date >= "2026-03-15" ? 200 : 100),
      ev: (date) => stepValueAt(steps, date),
      ac,
    });
    expect(curve).toEqual([
      { weekEnd: "2026-03-08", pvMinor: 100, evMinor: 100, acMinor: 20 },
      { weekEnd: "2026-03-15", pvMinor: 200, evMinor: 80, acMinor: 45 },
      { weekEnd: "2026-03-22", pvMinor: 200, evMinor: null, acMinor: null },
    ]);
    expect(
      sCurve({ weekEnds: ["2026-03-08"], dataDate: "2026-03-08", pv: null, ev: () => 1, ac }),
    ).toEqual([{ weekEnd: "2026-03-08", pvMinor: null, evMinor: 1, acMinor: 20 }]);
  });

  it("estimates the cost to complete at cost performance, at budget, or not at all", () => {
    // Contract 396,000; EV 165,000 (41.7 %); budget 300,000 → earned 125,000; actual 150,000:
    // CPI 0.83, ETC 175,000 × 150,000 ÷ 125,000 = 210,000; EAC 360,000; VAC −60,000.
    expect(
      costToComplete({
        contractMinor: 39_600_000,
        evMinor: 16_500_000,
        budgetMinor: 30_000_000,
        actualMinor: 15_000_000,
      }),
    ).toEqual({
      earnedBudgetMinor: 12_500_000,
      cpi: "0.83",
      etcMinor: 21_000_000,
      eacMinor: 36_000_000,
      vacMinor: -6_000_000,
      basis: "cpi",
    });
    expect(
      costToComplete({ contractMinor: 1_000, evMinor: 0, budgetMinor: 800, actualMinor: 100 }),
    ).toEqual({
      earnedBudgetMinor: 0,
      cpi: "0.00",
      etcMinor: 800,
      eacMinor: 900,
      vacMinor: -100,
      basis: "budget",
    });
    // Over-measured: nothing remains to spend.
    expect(
      costToComplete({ contractMinor: 1_000, evMinor: 1_200, budgetMinor: 800, actualMinor: 900 }),
    ).toMatchObject({ earnedBudgetMinor: 960, etcMinor: 0, eacMinor: 900, basis: "cpi" });
    expect(
      costToComplete({ contractMinor: 0, evMinor: 0, budgetMinor: 500, actualMinor: 0 }),
    ).toMatchObject({ earnedBudgetMinor: 0, cpi: null, etcMinor: 500, basis: "budget" });
    expect(
      costToComplete({ contractMinor: 1_000, evMinor: 10, budgetMinor: null, actualMinor: 5 }),
    ).toEqual({
      earnedBudgetMinor: null,
      cpi: null,
      etcMinor: null,
      eacMinor: null,
      vacMinor: null,
      basis: "unavailable",
    });
  });
});

describe("valuation lifecycle", () => {
  it("submits, certifies, returns and cancels, never from certified", () => {
    expect(VALUATION_TRANSITIONS.certify).toEqual({
      from: ["submitted"],
      to: "certified",
      reason: false,
    });
    for (const transition of Object.values(VALUATION_TRANSITIONS))
      expect(transition.from).not.toContain("certified");
    expect(VALUATION_TRANSITIONS.return.reason).toBe(true);
    expect(valuationCode("IPC", 3)).toBe("IPC-0003");
    expect(valuationCode("VAL", 12_345)).toBe("VAL-12345");
  });
});
