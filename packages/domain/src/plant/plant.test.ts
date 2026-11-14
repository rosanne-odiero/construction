import { describe, expect, it } from "vitest";
import {
  breakdownBlocks,
  breakdownResolutionAllowed,
  checkMeterReading,
  checkUsageReadings,
  expectedPlantStatus,
  formatHundredths,
  formatTenths,
  fuelWindows,
  hireCharge,
  idleDays,
  isPlantClosed,
  judgeFuel,
  latestReading,
  meterAdvance,
  meterBounds,
  operatorCertificateState,
  parseHundredths,
  parseTenths,
  plantAlerts,
  plantBusinessDate,
  plantDayEnd,
  plantDayStart,
  roundRatio,
  serviceStatus,
  truncateRatio,
  type FuelPoint,
  type MeterReading,
  type MeterReset,
  type PlantAlertInput,
} from "../index.js";

const at = (date: string, time: string) => Date.parse(`${date}T${time}:00.000+03:00`);
const rules = { tolerancePercent: 15, minSampleTenths: 100 };

describe("plant quantities", () => {
  it("parses and prints tenths and hundredths exactly", () => {
    expect(parseTenths("1234.5")).toBe(12345);
    expect(parseTenths(" 1234 ")).toBe(12340);
    expect(parseTenths("0.7")).toBe(7);
    expect(parseTenths("1.25")).toBeNull();
    expect(parseTenths("-1")).toBeNull();
    expect(parseTenths("abc")).toBeNull();
    expect(parseTenths("100.0", 999)).toBeNull();
    expect(formatTenths(12345)).toBe("1234.5");
    expect(formatTenths(7)).toBe("0.7");
    expect(formatTenths(-15)).toBe("-1.5");
    expect(parseHundredths("14")).toBe(1400);
    expect(parseHundredths("14.5")).toBe(1450);
    expect(parseHundredths("0.35")).toBe(35);
    expect(parseHundredths("0.355")).toBeNull();
    expect(formatHundredths(1425)).toBe("14.25");
    expect(formatHundredths(5)).toBe("0.05");
  });

  it("rounds half away from zero and truncates toward zero", () => {
    expect(roundRatio(5n, 10n)).toBe(1);
    expect(roundRatio(4n, 10n)).toBe(0);
    expect(roundRatio(-5n, 10n)).toBe(-1);
    expect(roundRatio(20n, 3n)).toBe(7);
    expect(truncateRatio(19n, 10n)).toBe(1);
    expect(truncateRatio(-19n, 10n)).toBe(-1);
    expect(() => roundRatio(1n, 0n)).toThrow(RangeError);
    expect(() => truncateRatio(1n, -1n)).toThrow(RangeError);
  });
});

describe("plant meter", () => {
  // Opening 1,000.0 h on 1 Nov; 1 Nov 1,000.0 → 1,008.0 with a fuelling at 1,004.0 at noon;
  // 2 Nov 1,010.0 → 1,018.5.
  const readings: MeterReading[] = [
    { at: plantDayStart("2026-11-01"), tenths: 10_000, sourceId: null },
    { at: plantDayStart("2026-11-01"), tenths: 10_000, sourceId: "u1" },
    { at: plantDayEnd("2026-11-01"), tenths: 10_080, sourceId: "u1" },
    { at: at("2026-11-01", "12:00"), tenths: 10_040, sourceId: "f1" },
    { at: plantDayStart("2026-11-02"), tenths: 10_100, sourceId: "u2" },
    { at: plantDayEnd("2026-11-02"), tenths: 10_185, sourceId: "u2" },
  ];

  it("works on Nairobi business days", () => {
    expect(new Date(plantDayStart("2026-11-01")).toISOString()).toBe("2026-10-31T21:00:00.000Z");
    expect(plantDayEnd("2026-11-01") - plantDayStart("2026-11-01")).toBe(86_399_999);
    expect(plantBusinessDate(at("2026-11-01", "23:30"))).toBe("2026-11-01");
    expect(plantBusinessDate(at("2026-11-02", "00:10"))).toBe("2026-11-02");
  });

  it("refuses a reading lower than an earlier one or higher than a later one", () => {
    expect(meterBounds(readings, [], at("2026-11-02", "10:00"))).toEqual({
      previous: 10_100,
      next: 10_185,
    });
    expect(checkMeterReading(readings, [], at("2026-11-02", "10:00"), 10_090).ok).toBe(false);
    expect(checkMeterReading(readings, [], at("2026-11-02", "10:00"), 10_120)).toEqual({
      ok: true,
      previous: 10_100,
      next: 10_185,
    });
    expect(checkMeterReading(readings, [], at("2026-11-01", "18:00"), 10_200).ok).toBe(false);
    // A day after the last: at least the last end reading; a back-dated day fits between.
    expect(checkUsageReadings(readings, [], "2026-11-03", 10_180, 10_200).ok).toBe(false);
    expect(checkUsageReadings(readings, [], "2026-11-03", 10_185, 10_200)).toEqual({
      ok: true,
      previous: 10_185,
      next: null,
    });
    expect(checkUsageReadings(readings, [], "2026-11-03", 10_200, 10_190).ok).toBe(false);
    // Correcting day 1 leaves its own readings out (and the noon fuelling still binds it).
    expect(checkUsageReadings(readings, [], "2026-11-01", 10_000, 10_090, "u1").ok).toBe(true);
    expect(checkUsageReadings(readings, [], "2026-11-01", 10_000, 10_030, "u1").ok).toBe(false);
    expect(checkUsageReadings(readings, [], "2026-11-01", 10_000, 10_070).ok).toBe(false);
    expect(checkUsageReadings(readings, [], "2026-11-01", 10_000, 10_070, "u1").ok).toBe(true);
  });

  it("starts a new epoch at a recorded meter reset", () => {
    const resets: MeterReset[] = [
      { id: "r1", at: at("2026-11-03", "08:00"), oldTenths: 10_200, newTenths: 0 },
    ];
    expect(checkMeterReading(readings, resets, at("2026-11-03", "09:00"), 30).ok).toBe(true);
    expect(checkMeterReading(readings, resets, at("2026-11-03", "07:00"), 10_190).ok).toBe(true);
    expect(checkMeterReading(readings, resets, at("2026-11-03", "07:00"), 10_210)).toEqual({
      ok: false,
      previous: 10_185,
      next: 10_200,
    });
    // Across the reset: (1,020.0 − 1,018.5) + (3.0 − 0.0) = 4.5 hours.
    expect(
      meterAdvance(
        { at: plantDayEnd("2026-11-02"), tenths: 10_185 },
        { at: at("2026-11-03", "09:00"), tenths: 30 },
        resets,
      ),
    ).toBe(45);
    const twice: MeterReset[] = [
      ...resets,
      { id: "r2", at: at("2026-11-04", "08:00"), oldTenths: 100, newTenths: 50 },
    ];
    // (1,020.0 − 1,018.5) + (10.0 − 0.0) + (7.0 − 5.0) = 13.5
    expect(
      meterAdvance(
        { at: plantDayEnd("2026-11-02"), tenths: 10_185 },
        { at: at("2026-11-04", "09:00"), tenths: 70 },
        twice,
      ),
    ).toBe(135);
    expect(latestReading(readings, resets)).toEqual({ at: resets[0]!.at, tenths: 0 });
    expect(latestReading([], [])).toBeNull();
  });
});

describe("fuel variance (the D8.3 done-when)", () => {
  // An excavator with a standard of 14.00 L/h; tolerance 15 %; minimum sample 10 hours.
  const point = (
    id: string,
    time: string,
    meter: number,
    litres: number,
    tankFilled = true,
  ): FuelPoint => ({
    id,
    at: at("2026-11-02", time),
    meterTenths: meter,
    litresTenths: litres,
    tankFilled,
    standardHundredths: 1400,
  });

  it("flags 182.0 L over 10.0 h against 140.0 L expected (+30.0 %), and not 150.0 L (+7.1 %)", () => {
    const analysis = fuelWindows(
      [
        point("f1", "07:00", 12_000, 500),
        point("f2", "17:00", 12_100, 1820),
        point("f3", "18:00", 12_200, 1500),
      ],
      [],
      rules,
    );
    expect(analysis.windows).toEqual([
      expect.objectContaining({
        fromId: "f1",
        toId: "f2",
        issueIds: ["f2"],
        litresTenths: 1820,
        advanceTenths: 100,
        expectedTenths: 1400,
        actualRateHundredths: 1820,
        variancePercentTenths: 300,
        state: "over_standard",
      }),
      expect.objectContaining({
        fromId: "f2",
        toId: "f3",
        litresTenths: 1500,
        expectedTenths: 1400,
        variancePercentTenths: 71,
        state: "within_standard",
      }),
    ]);
    expect(analysis.staticIssueIds).toEqual([]);
  });

  it("is not over at exactly the tolerance (161.0 L for 140.0 L at 15 %)", () => {
    expect(judgeFuel(1610, 100, 1400, rules)).toEqual({
      expectedTenths: 1400,
      actualRateHundredths: 1610,
      variancePercentTenths: 150,
      state: "within_standard",
    });
    expect(judgeFuel(1611, 100, 1400, rules).state).toBe("over_standard");
  });

  it("extends a window below the minimum sample to the next full filling, adding part fillings", () => {
    const analysis = fuelWindows(
      [
        point("f1", "07:00", 12_200, 500),
        // 5.0 h only: too short to judge, even with 120.0 L.
        point("f2", "09:00", 12_250, 1200),
        point("f3", "10:00", 12_280, 200, false),
        point("f4", "12:00", 12_320, 300),
      ],
      [],
      rules,
    );
    // 1,220.0 → 1,232.0 = 12.0 h; 120.0 + 20.0 + 30.0 = 170.0 L against 168.0 L (+1.1 %).
    expect(analysis.windows).toEqual([
      expect.objectContaining({
        fromId: "f1",
        toId: "f4",
        issueIds: ["f2", "f3", "f4"],
        litresTenths: 1700,
        advanceTenths: 120,
        expectedTenths: 1680,
        variancePercentTenths: 11,
        state: "within_standard",
      }),
    ]);
    const short = fuelWindows(
      [point("a", "07:00", 12_200, 500), point("b", "09:00", 12_250, 9000)],
      [],
      rules,
    );
    expect(short.windows).toEqual([]);
    expect(short.pending).toEqual({
      fromId: "a",
      issueIds: ["b"],
      litresTenths: 9000,
      advanceTenths: 50,
    });
    expect(judgeFuel(9000, 50, 1400, rules).state).toBe("short_sample");
  });

  it("ignores fuel before the first full filling and plant without a meter", () => {
    const analysis = fuelWindows(
      [
        point("p", "06:00", 11_900, 300, false),
        { ...point("n", "06:30", 0, 100), meterTenths: null },
      ],
      [],
      rules,
    );
    expect(analysis).toEqual({
      windows: [],
      pending: { fromId: null, issueIds: [], litresTenths: 0, advanceTenths: 0 },
      staticIssueIds: [],
    });
  });

  it("flags fuel issued while the meter has not moved", () => {
    const analysis = fuelWindows(
      [point("f1", "07:00", 12_320, 500), point("f2", "15:00", 12_320, 150)],
      [],
      rules,
    );
    expect(analysis.staticIssueIds).toEqual(["f2"]);
    expect(analysis.windows).toEqual([]);
  });

  it("measures across a meter reset and judges without a standard as unavailable", () => {
    const resets: MeterReset[] = [
      { id: "r", at: at("2026-11-02", "12:00"), oldTenths: 12_060, newTenths: 0 },
    ];
    const analysis = fuelWindows(
      [point("f1", "07:00", 12_000, 500), point("f2", "17:00", 40, 1400)],
      resets,
      rules,
    );
    // (1,206.0 − 1,200.0) + (4.0 − 0.0) = 10.0 h; 140.0 L = the standard exactly.
    expect(analysis.windows[0]).toMatchObject({ advanceTenths: 100, variancePercentTenths: 0 });
    expect(judgeFuel(1400, 100, null, rules)).toEqual({
      expectedTenths: null,
      actualRateHundredths: 1400,
      variancePercentTenths: null,
      state: "within_standard",
    });
  });
});

describe("plant maintenance and hire", () => {
  const base = {
    everyTenths: 2500,
    everyDays: null,
    lastOn: "2026-08-01",
    today: "2026-10-20",
    dueSoonPercent: 10,
  };

  it("is due within the last 10 % of the interval and overdue after it", () => {
    expect(serviceStatus({ ...base, runSinceTenths: 2249 })).toEqual({
      state: "ok",
      remainingTenths: 251,
      dueOn: null,
    });
    expect(serviceStatus({ ...base, runSinceTenths: 2250 }).state).toBe("due");
    expect(serviceStatus({ ...base, runSinceTenths: 2500 }).state).toBe("due");
    expect(serviceStatus({ ...base, runSinceTenths: 2501 })).toEqual({
      state: "overdue",
      remainingTenths: -1,
      dueOn: null,
    });
    expect(serviceStatus({ ...base, everyTenths: null, runSinceTenths: null })).toEqual({
      state: "not_scheduled",
      remainingTenths: null,
      dueOn: null,
    });
  });

  it("counts calendar intervals and keeps the worse of the two", () => {
    const days = { ...base, everyTenths: null, everyDays: 90, runSinceTenths: null };
    expect(serviceStatus(days)).toEqual({
      state: "ok",
      remainingTenths: null,
      dueOn: "2026-10-30",
    });
    expect(serviceStatus({ ...days, today: "2026-10-21" }).state).toBe("due");
    expect(serviceStatus({ ...days, today: "2026-10-30" }).state).toBe("due");
    expect(serviceStatus({ ...days, today: "2026-10-31" }).state).toBe("overdue");
    expect(
      serviceStatus({ ...days, everyTenths: 2500, runSinceTenths: 2600, today: "2026-10-01" }),
    ).toMatchObject({ state: "overdue", remainingTenths: -100, dueOn: "2026-10-30" });
  });

  it("estimates hire charges per day, month and hour, rounded half up", () => {
    expect(
      hireCharge({
        rateMinor: 1_500_000,
        unit: "day",
        startOn: "2026-11-01",
        endOn: "2026-11-10",
        hoursTenths: 0,
      }),
    ).toEqual({ days: 10, estimateMinor: 15_000_000 });
    const month = {
      rateMinor: 9_000_000,
      unit: "month" as const,
      startOn: "2026-11-01",
      hoursTenths: 0,
    };
    expect(hireCharge({ ...month, endOn: "2026-11-07" })).toEqual({
      days: 7,
      estimateMinor: 2_100_000,
    });
    expect(hireCharge({ ...month, rateMinor: 15, endOn: "2026-11-01" }).estimateMinor).toBe(1);
    expect(hireCharge({ ...month, rateMinor: 100, endOn: "2026-11-02" }).estimateMinor).toBe(7);
    expect(
      hireCharge({
        rateMinor: 450_000,
        unit: "hour",
        startOn: "2026-11-01",
        endOn: "2026-11-03",
        hoursTenths: 125,
      }),
    ).toEqual({ days: 3, estimateMinor: 5_625_000 });
    expect(hireCharge({ ...month, endOn: "2026-10-31" })).toEqual({ days: 0, estimateMinor: 0 });
  });

  it("counts idle days without today", () => {
    expect(idleDays("2026-11-13", "2026-11-01", "2026-11-14")).toBe(0);
    expect(idleDays("2026-11-14", "2026-11-01", "2026-11-14")).toBe(0);
    expect(idleDays("2026-11-10", "2026-11-01", "2026-11-14")).toBe(3);
    expect(idleDays(null, "2026-11-11", "2026-11-14")).toBe(3);
    expect(idleDays(null, "2026-11-14", "2026-11-14")).toBe(0);
  });
});

describe("plant register rules", () => {
  it("derives the status from location, breakdowns and closure", () => {
    expect(expectedPlantStatus({ closed: null, siteId: null, openSeverities: [] })).toBe(
      "available",
    );
    expect(expectedPlantStatus({ closed: null, siteId: "s", openSeverities: ["minor"] })).toBe(
      "on_site",
    );
    expect(expectedPlantStatus({ closed: null, siteId: "s", openSeverities: ["major"] })).toBe(
      "under_repair",
    );
    expect(expectedPlantStatus({ closed: "off_hire", siteId: null, openSeverities: [] })).toBe(
      "off_hire",
    );
    expect(breakdownBlocks("unsafe")).toBe(true);
    expect(breakdownBlocks("minor")).toBe(false);
    expect(isPlantClosed("disposed")).toBe(true);
    expect(isPlantClosed("under_repair")).toBe(false);
    expect(breakdownResolutionAllowed("owned", "off_hire")).toBe(false);
    expect(breakdownResolutionAllowed("hired", "off_hire")).toBe(true);
    expect(breakdownResolutionAllowed("hired", "written_off")).toBe(false);
    expect(breakdownResolutionAllowed("owned", "written_off")).toBe(true);
    expect(breakdownResolutionAllowed("owned", "repaired")).toBe(true);
  });

  it("flags operators without the certificate their plant's category needs", () => {
    const base = {
      category: "excavator" as const,
      requiredCategories: ["excavator" as const],
      certificateRef: "NITA/OP/001",
      expiresOn: null,
      today: "2026-11-14",
      warningDays: 30,
    };
    expect(operatorCertificateState({ ...base, category: "concrete_mixer" })).toBe("not_required");
    expect(operatorCertificateState({ ...base, certificateRef: null })).toBe("missing");
    expect(operatorCertificateState(base)).toBe("valid");
    expect(operatorCertificateState({ ...base, expiresOn: "2026-11-13" })).toBe("expired");
    expect(operatorCertificateState({ ...base, expiresOn: "2026-12-14" })).toBe("expiring");
    expect(operatorCertificateState({ ...base, expiresOn: "2026-12-15" })).toBe("valid");
  });

  it("lists what needs attention, critical first, and nothing for closed items", () => {
    const quiet: PlantAlertInput = {
      ownership: "hired",
      status: "on_site",
      today: "2026-11-14",
      hireEndOn: null,
      hireEndingDays: 7,
      idleDays: 0,
      idleHireDays: 3,
      service: "ok",
      openBreakdowns: [],
      fuelOverStandard: false,
      fuelMeterStatic: false,
      operatorCertificates: ["valid"],
    };
    expect(plantAlerts(quiet)).toEqual([]);
    expect(
      plantAlerts({
        ...quiet,
        idleDays: 3,
        hireEndOn: "2026-11-13",
        service: "overdue",
        openBreakdowns: ["unsafe", "minor"],
        fuelOverStandard: true,
        fuelMeterStatic: true,
        operatorCertificates: ["missing"],
      }).map((alert) => `${alert.kind}:${alert.severity}`),
    ).toEqual([
      "unsafe_breakdown:critical",
      "service_overdue:critical",
      "operator_certificate:critical",
      "hire_overrun:critical",
      "fuel_over_standard:warning",
      "fuel_meter_static:warning",
      "idle_on_hire:warning",
    ]);
    expect(
      plantAlerts({
        ...quiet,
        hireEndOn: "2026-11-21",
        service: "due",
        openBreakdowns: ["minor"],
        operatorCertificates: ["expiring"],
      }).map((alert) => alert.kind),
    ).toEqual(["operator_certificate", "breakdown_open", "service_due", "hire_ending"]);
    expect(plantAlerts({ ...quiet, hireEndOn: "2026-11-22" })).toEqual([]);
    // Owned plant has no hire alerts; closed plant raises nothing.
    expect(
      plantAlerts({ ...quiet, ownership: "owned", idleDays: 30, hireEndOn: "2026-01-01" }),
    ).toEqual([]);
    expect(plantAlerts({ ...quiet, status: "off_hire", service: "overdue" })).toEqual([]);
  });
});
