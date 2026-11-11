import { describe, expect, it } from "vitest";
import {
  KENYA_STATUTORY_SEED,
  type StatutoryParameters,
  type StatutoryRuleKind,
} from "@pm-buddy/types";
import type { RateCandidate } from "../labour.js";
import {
  allowanceEarnings,
  batchStatutory,
  computeBatch,
  dayEarnings,
  defaultPayCalendar,
  emptyPriorMonth,
  minimumWageComparison,
  monthlyStatutory,
  outputAmountMinor,
  payeBeforeRelief,
  payPeriodFor,
  payPeriodsBetween,
  percentMinor,
  planRecoveries,
  selectRuleSet,
  splitEqually,
  statutoryMonthOf,
  statutoryParameterIssues,
  type AllowanceRef,
  type BatchInput,
  type BatchLabourer,
  type PriorMonth,
  type StatutoryRuleSet,
  type StatutoryRuleVersion,
  type TimesheetDayInput,
  type TimesheetRuleRef,
} from "./index.js";

/** Seed versions as rule rows (ids are the kind and date). */
const seedVersions: StatutoryRuleVersion[] = KENYA_STATUTORY_SEED.map(
  (seed) =>
    ({
      id: `${seed.kind}-${seed.effectiveFrom}`,
      kind: seed.kind,
      effectiveFrom: seed.effectiveFrom,
      status: "unverified",
      parameters: seed.parameters,
    }) as StatutoryRuleVersion,
);
const rulesOn = (date: string, versions = seedVersions): StatutoryRuleSet => {
  const { rules, missing } = selectRuleSet(versions, date);
  if (!rules) throw new Error(`missing ${missing.join(",")}`);
  return rules;
};
const year4 = rulesOn("2026-11-13");
const year3 = rulesOn("2026-01-30");
const KES = (shillings: number) => Math.round(shillings * 100);

describe("PAYE bands (CR-PAY-01)", () => {
  const bands = year4.paye.parameters.bands;
  const edges = [
    { edge: 2_400_000, taxAtEdge: 240_000, below: "10", above: "25" },
    { edge: 3_233_300, taxAtEdge: 448_325, below: "25", above: "30" },
    { edge: 50_000_000, taxAtEdge: 14_478_335, below: "30", above: "32.5" },
    { edge: 80_000_000, taxAtEdge: 24_228_335, below: "32.5", above: "35" },
  ];

  it.each(edges)("taxes exactly up to the $edge edge", ({ edge, taxAtEdge }) => {
    expect(payeBeforeRelief(edge, bands)).toBe(taxAtEdge);
  });

  it.each(edges)(
    "changes the marginal rate at $edge (±1 cent rounds half-up, ±KES 1 shows the rates)",
    ({ edge, taxAtEdge, below, above }) => {
      // One cent either side: the band's rate on 1 cent is below half a cent, so the tax rounds back.
      expect(payeBeforeRelief(edge - 1, bands)).toBe(taxAtEdge);
      expect(payeBeforeRelief(edge + 1, bands)).toBe(taxAtEdge);
      // One shilling either side: exactly the lower and upper band rates (half-up on 32.5 cents).
      expect(taxAtEdge - payeBeforeRelief(edge - 100, bands)).toBe(
        Math.round(Number(below)) === Number(below) ? Number(below) : Math.floor(Number(below)),
      );
      expect(payeBeforeRelief(edge + 100, bands) - taxAtEdge).toBe(Math.round(Number(above)));
    },
  );

  it("returns zero tax for no taxable pay and taxes above 800,000 at 35%", () => {
    expect(payeBeforeRelief(0, bands)).toBe(0);
    expect(payeBeforeRelief(-500, bands)).toBe(0);
    expect(payeBeforeRelief(100_000_000, bands)).toBe(24_228_335 + 7_000_000);
  });

  it("deducts NSSF, SHIF and AHL before PAYE and then the personal relief (KES 30,000)", () => {
    const month = monthlyStatutory(KES(30_000), year4, "casual");
    expect(month.nssf.tier1Minor).toBe(KES(540));
    expect(month.nssf.tier2Minor).toBe(KES(1_260));
    expect(month.employee).toEqual({
      nssf: KES(1_800),
      shif: KES(825),
      ahl: KES(450),
      paye: KES(731.25),
    });
    expect(month.taxablePayMinor).toBe(KES(26_925));
    expect(month.payeBeforeReliefMinor).toBe(KES(3_131.25));
    expect(month.personalReliefMinor).toBe(KES(2_400));
    expect(month.employer).toEqual({
      nssf_employer: KES(1_800),
      ahl_employer: KES(450),
      nita: KES(50),
    });
  });

  it("gives zero PAYE (never a refund) when the relief exceeds the tax", () => {
    const month = monthlyStatutory(KES(15_000), year4, "casual");
    expect(month.payeBeforeReliefMinor).toBeLessThan(KES(2_400));
    expect(month.personalReliefMinor).toBe(month.payeBeforeReliefMinor);
    expect(month.employee.paye).toBe(0);
  });

  it("does not subtract a contribution that the rule does not list as pre-tax", () => {
    const paye = {
      ...year4.paye,
      parameters: { ...year4.paye.parameters, deductibleBeforeTax: [] },
    } as StatutoryRuleSet["paye"];
    const month = monthlyStatutory(KES(30_000), { ...year4, paye }, "casual");
    expect(month.taxablePayMinor).toBe(KES(30_000));
    expect(month.employee.paye).toBe(KES(2_400 + 1_500) - KES(2_400));
  });
});

describe("NSSF tiers (CR-PAY-02)", () => {
  const lel = 900_000;
  const uel = 10_800_000;
  it.each([
    [lel - 1, 54_000, 0],
    [lel, 54_000, 0],
    [lel + 1, 54_000, 0],
    [lel + 9, 54_000, 1],
    [uel - 1, 54_000, 594_000],
    [uel, 54_000, 594_000],
    [uel + 1, 54_000, 594_000],
    [50_000_000, 54_000, 594_000],
  ])("Year 4 base %i → Tier I %i, Tier II %i", (base, tier1, tier2) => {
    const month = monthlyStatutory(base, year4, "casual");
    expect(month.nssf.tier1Minor).toBe(tier1);
    expect(month.nssf.tier2Minor).toBe(tier2);
    expect(month.employee.nssf).toBe(tier1 + tier2);
    expect(month.employer.nssf_employer).toBe(tier1 + tier2);
    expect(month.nssf.pensionableMinor).toBe(Math.min(base, uel));
  });

  it("takes 6% of pay below the LEL as Tier I", () => {
    expect(monthlyStatutory(KES(5_000), year4, "casual").employee.nssf).toBe(KES(300));
  });

  it("caps Year 3 at KES 4,320 and Year 4 at KES 6,480 each side", () => {
    expect(monthlyStatutory(KES(200_000), year3, "term").employee.nssf).toBe(KES(4_320));
    expect(monthlyStatutory(KES(200_000), year4, "term").employee.nssf).toBe(KES(6_480));
  });

  it("switches from Year 3 to Year 4 on 01/02/2026", () => {
    expect(selectRuleSet(seedVersions, "2026-01-31").rules?.nssf.id).toBe("nssf-2025-02-01");
    expect(selectRuleSet(seedVersions, "2026-02-01").rules?.nssf.id).toBe("nssf-2026-02-01");
    expect(selectRuleSet(seedVersions, "2025-01-31").missing).toEqual(["nssf"]);
  });

  it("trues up the whole month on the new limits when a version starts mid-month", () => {
    // A version taking effect on the 15th: the batch paid after it recomputes the month on the new
    // UEL, so the month's total follows the version in force on the last pay date.
    const midMonth: StatutoryRuleVersion = {
      id: "nssf-mid",
      kind: "nssf",
      effectiveFrom: "2026-03-15",
      status: "unverified",
      parameters: { ...year4.nssf.parameters, upperEarningsLimitMinor: KES(150_000) },
    };
    const versions = [...seedVersions, midMonth];
    const early = rulesOn("2026-03-13", versions);
    const late = rulesOn("2026-03-20", versions);
    expect(early.nssf.id).toBe("nssf-2026-02-01");
    expect(late.nssf.id).toBe("nssf-mid");
    const first = batchStatutory(KES(80_000), KES(80_000), emptyPriorMonth(), early, "term");
    expect(first.withheld.nssf).toBe(KES(4_800));
    const prior = priorFrom([first]);
    const second = batchStatutory(KES(80_000), KES(80_000), prior, late, "term");
    // Month base 160,000: old UEL caps at 6,480; the new UEL 150,000 gives 9,000.
    expect(first.withheld.nssf + second.withheld.nssf).toBe(KES(9_000));
    expect(second.withheld.nssf).toBe(KES(4_200));
  });
});

describe("SHIF, AHL and NITA (CR-PAY-03, CR-PAY-04, CR-PAY-05)", () => {
  it.each([
    [1, 30_000],
    [1_090_909, 30_000],
    [1_090_928, 30_001],
    [KES(30_000), KES(825)],
    [KES(1_000_000), KES(27_500)],
  ])("SHIF on %i is %i (minimum KES 300, no cap)", (base, shif) => {
    expect(monthlyStatutory(base, year4, "casual").employee.shif).toBe(shif);
  });

  it("charges no SHIF (nor anything else) on a month without pay", () => {
    const month = monthlyStatutory(0, year4, "casual");
    expect(month.employee).toEqual({ nssf: 0, shif: 0, ahl: 0, paye: 0 });
    expect(month.employer).toEqual({ nssf_employer: 0, ahl_employer: 0, nita: 0 });
  });

  it.each([
    [100, 2],
    [33, 0],
    [3_333, 50],
    [KES(30_000), KES(450)],
  ])("AHL on %i cents is %i cents each side (half-up)", (base, ahl) => {
    const month = monthlyStatutory(base, year4, "casual");
    expect(month.employee.ahl).toBe(ahl);
    expect(month.employer.ahl_employer).toBe(ahl);
  });

  it("respects the per-engagement applicability rule (Q-C2)", () => {
    const applicability = {
      ...year4.applicability,
      parameters: {
        ...year4.applicability.parameters,
        casual: { paye: true, nssf: false, shif: true, ahl: true, nita: false },
      },
    } as StatutoryRuleSet["applicability"];
    const month = monthlyStatutory(KES(30_000), { ...year4, applicability }, "casual");
    expect(month.employee.nssf).toBe(0);
    expect(month.employer.nita).toBe(0);
    expect(month.taxablePayMinor).toBe(KES(30_000 - 825 - 450));
  });
});

/** Folds batch results into what later batches of the month see. */
function priorFrom(batches: ReturnType<typeof batchStatutory>[], base?: number[]): PriorMonth {
  const prior = emptyPriorMonth();
  batches.forEach((batch, index) => {
    prior.baseMinor += base?.[index] ?? batch.cumulativeBaseMinor - prior.baseMinor;
    for (const item of ["nssf", "shif", "ahl", "paye"] as const)
      prior.withheld[item] += batch.withheld[item];
    for (const item of ["nssf_employer", "ahl_employer", "nita"] as const)
      prior.employer[item] += batch.employer[item];
    prior.batchIds.push(`b${index}`);
  });
  return prior;
}

describe("cumulative month-to-date method", () => {
  const weeks = [KES(7_500), KES(9_000), KES(6_000), KES(12_000), KES(3_500)];

  it.each([4, 5])("matches the monthly computation across %i weekly batches", (count) => {
    const results: ReturnType<typeof batchStatutory>[] = [];
    for (const gross of weeks.slice(0, count))
      results.push(batchStatutory(gross, gross, priorFrom(results), year4, "casual"));
    const total = weeks.slice(0, count).reduce((a, b) => a + b, 0);
    const month = monthlyStatutory(total, year4, "casual");
    for (const item of ["nssf", "shif", "ahl", "paye"] as const)
      expect(
        results.reduce((sum, result) => sum + result.withheld[item], 0),
        item,
      ).toBe(month.employee[item]);
    for (const item of ["nssf_employer", "ahl_employer", "nita"] as const)
      expect(
        results.reduce((sum, result) => sum + result.employer[item], 0),
        item,
      ).toBe(month.employer[item]);
  });

  it("charges NITA once per employee per month across weekly batches", () => {
    const results: ReturnType<typeof batchStatutory>[] = [];
    for (const gross of weeks)
      results.push(batchStatutory(gross, gross, priorFrom(results), year4, "casual"));
    expect(results.map((result) => result.employer.nita)).toEqual([KES(50), 0, 0, 0, 0]);
  });

  it("applies the SHIF minimum to the month, not to every week", () => {
    const first = batchStatutory(KES(5_000), KES(5_000), emptyPriorMonth(), year4, "casual");
    expect(first.withheld.shif).toBe(KES(300));
    const second = batchStatutory(KES(5_000), KES(5_000), priorFrom([first]), year4, "casual");
    expect(second.withheld.shif).toBe(0);
    const third = batchStatutory(
      KES(10_000),
      KES(10_000),
      priorFrom([first, second]),
      year4,
      "casual",
    );
    expect(third.withheld.shif).toBe(KES(550 - 300));
  });

  it("never withholds more than the pay: statutory first, the rest stays due in the month", () => {
    const first = batchStatutory(KES(200), KES(200), emptyPriorMonth(), year4, "casual");
    expect(first.withheld).toEqual({ nssf: KES(12), shif: KES(188), ahl: 0, paye: 0 });
    expect(first.shortfall).toEqual({ nssf: 0, shif: KES(112), ahl: KES(3), paye: 0 });
    expect(first.availableAfterMinor).toBe(0);
    // The next batch of the month withholds the shortfall as well as its own share.
    const second = batchStatutory(KES(5_000), KES(5_000), priorFrom([first]), year4, "casual");
    expect(second.withheld.shif).toBe(KES(112));
    expect(first.withheld.ahl + second.withheld.ahl).toBe(KES(78));
  });

  it("refunds within the month when a negative adjustment lowers the month's base", () => {
    const first = batchStatutory(KES(30_000), KES(30_000), emptyPriorMonth(), year4, "casual");
    const second = batchStatutory(KES(1_000), -KES(5_000), priorFrom([first]), year4, "casual");
    expect(second.due.paye).toBeLessThan(0);
    expect(second.withheld.paye).toBe(second.due.paye);
    expect(second.availableAfterMinor).toBeGreaterThan(KES(1_000));
  });
});

const ruleRef: TimesheetRuleRef = {
  id: "rule-1",
  normalMinutes: 480,
  multipliers: { weekday: "1.50", rest_day: "2.00", public_holiday: "2.00" },
  verified: false,
};
const day = (overrides: Partial<TimesheetDayInput> = {}): TimesheetDayInput => ({
  date: "2026-11-09",
  dayType: "weekday",
  ruleVersionId: "rule-1",
  halfDays: 2,
  normalMinutes: 480,
  overtimeMinutes: { weekday: 0, rest_day: 0, public_holiday: 0 },
  ...overrides,
});
const daily = { id: "rate-d", basis: "daily" as const, rateMinor: KES(1_000) };

describe("attendance and overtime earnings (CR-PAY-08)", () => {
  it("pays half-day units on weekdays, including negative adjustment deltas", () => {
    const amount = (halfDays: number) =>
      dayEarnings(day({ halfDays }), daily, ruleRef, "line").reduce(
        (sum, row) => sum + row.amountMinor,
        0,
      );
    expect(amount(2)).toBe(KES(1_000));
    expect(amount(1)).toBe(KES(500));
    expect(amount(-1)).toBe(-KES(500));
    const [row] = dayEarnings(day({ halfDays: 3 }), daily, ruleRef, "line");
    expect(row).toMatchObject({ quantity: "1.5", unit: "day", labourRateId: "rate-d" });
  });

  it("converts a daily rate to an hourly equivalent with the rule's normal minutes", () => {
    const rows = dayEarnings(
      day({ overtimeMinutes: { weekday: 60, rest_day: 0, public_holiday: 0 } }),
      daily,
      ruleRef,
      "line",
    );
    const overtime = rows.find((row) => row.kind === "overtime");
    // KES 1,000 ÷ 8 h = 125/h × 1.50 × 1 h.
    expect(overtime).toMatchObject({ amountMinor: KES(187.5), multiplier: "1.50", quantity: "60" });
  });

  it("pays rest-day and holiday work as overtime only (two day rates for a full rest day)", () => {
    const rest = dayEarnings(
      day({
        dayType: "rest_day",
        normalMinutes: 0,
        overtimeMinutes: { weekday: 0, rest_day: 480, public_holiday: 0 },
      }),
      daily,
      ruleRef,
      "line",
    );
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({
      kind: "overtime",
      category: "rest_day",
      amountMinor: KES(2_000),
    });
  });

  it("applies multipliers as exact decimals and rounds each row half-up", () => {
    const custom = {
      ...ruleRef,
      multipliers: { weekday: "1.333", rest_day: "2.00", public_holiday: "2.25" },
    };
    const rows = dayEarnings(
      day({
        dayType: "public_holiday",
        normalMinutes: 0,
        halfDays: 2,
        overtimeMinutes: { weekday: 1, rest_day: 0, public_holiday: 120 },
      }),
      daily,
      custom,
      "line",
    );
    expect(rows.map((row) => [row.category, row.amountMinor])).toEqual([
      ["weekday", 278], // 100,000 × 1 × 1.333 ÷ 480 = 277.708…
      ["public_holiday", 56_250], // 100,000 × 120 × 2.25 ÷ 480
    ]);
  });

  it("pays hourly rates by the minute", () => {
    const hourly = { id: "rate-h", basis: "hourly" as const, rateMinor: KES(150) };
    const rows = dayEarnings(
      day({ normalMinutes: 450, overtimeMinutes: { weekday: 90, rest_day: 0, public_holiday: 0 } }),
      hourly,
      ruleRef,
      "line",
    );
    expect(rows.map((row) => row.amountMinor)).toEqual([KES(1_125), KES(337.5)]);
  });
});

describe("piece rate, allowances and minimum wage", () => {
  it("splits gang output equally with the leftover cents to the first members", () => {
    expect(splitEqually(1_000, 3)).toEqual([334, 333, 333]);
    expect(splitEqually(1_001, 1)).toEqual([1_001]);
    expect(splitEqually(0, 2)).toEqual([0, 0]);
    expect(splitEqually(99_999, 7).reduce((a, b) => a + b, 0)).toBe(99_999);
    expect(() => splitEqually(10, 0)).toThrow();
  });

  it("prices output as quantity × rate, rounded half-up", () => {
    expect(outputAmountMinor("12.345", 35_000)).toBe(432_075);
    expect(outputAmountMinor("0.001", 500)).toBe(1);
    expect(() => outputAmountMinor("1.2345", 100)).toThrow();
  });

  const allowance = (overrides: Partial<AllowanceRef>): AllowanceRef => ({
    id: "a",
    code: "transport",
    nameEn: "Transport",
    basis: "per_day_worked",
    amountMinor: KES(100),
    taxable: true,
    tradeId: null,
    labourerId: null,
    effectiveFrom: "2026-01-01",
    endedOn: null,
    ...overrides,
  });

  it("uses the most specific allowance per code and counts worked days", () => {
    const rows = allowanceEarnings(
      [
        allowance({ id: "project" }),
        allowance({ id: "trade", tradeId: "mason", amountMinor: KES(150) }),
        allowance({
          id: "own",
          labourerId: "w1",
          amountMinor: KES(200),
          effectiveFrom: "2026-11-10",
        }),
        allowance({
          id: "tools",
          code: "tools",
          basis: "per_period",
          amountMinor: KES(300),
          taxable: false,
        }),
      ],
      { id: "w1", tradeId: "mason" },
      ["2026-11-09", "2026-11-10", "2026-11-10", "2026-11-11"],
      "2026-11-12",
    );
    expect(rows.map((row) => [row.sourceId, row.quantity, row.amountMinor, row.taxable])).toEqual([
      ["trade", "1", KES(150), true],
      ["own", "2", KES(400), true],
      ["tools", "1", KES(300), false],
    ]);
  });

  it("pays no allowance without worked days", () => {
    expect(
      allowanceEarnings(
        [allowance({ basis: "per_period" })],
        { id: "w", tradeId: "t" },
        [],
        "2026-11-12",
      ),
    ).toEqual([]);
  });

  it("compares rates with the gazetted figure or a marked monthly derivation", () => {
    const minimum = { monthlyMinor: 1_804_740, dailyMinor: null, hourlyMinor: null };
    expect(minimumWageComparison({ basis: "daily", rateMinor: 69_413 }, minimum)).toEqual({
      minimumMinor: 69_413,
      derived: true,
      below: true,
    });
    expect(minimumWageComparison({ basis: "daily", rateMinor: 69_414 }, minimum).below).toBe(false);
    expect(minimumWageComparison({ basis: "hourly", rateMinor: 8_021 }, minimum).below).toBe(true);
    expect(minimumWageComparison({ basis: "hourly", rateMinor: 8_022 }, minimum).below).toBe(false);
    expect(
      minimumWageComparison(
        { basis: "daily", rateMinor: 80_000 },
        { ...minimum, dailyMinor: 90_000 },
      ),
    ).toEqual({ minimumMinor: 90_000, derived: false, below: true });
  });
});

describe("advance recovery (CR-PAY-15, CR-PAY-16)", () => {
  const advance = (overrides: Partial<Parameters<typeof planRecoveries>[1][number]> = {}) => ({
    id: "adv-1",
    outstandingMinor: KES(8_000),
    instalmentMinor: null,
    maxRecoveryPercent: null,
    disbursedOn: "2026-11-01",
    ...overrides,
  });

  it("caps recovery at the percentage of pay after statutory deductions and carries the rest", () => {
    const plan = planRecoveries(KES(10_000), [advance()], "50");
    expect(plan.recoveries).toEqual([
      { advanceId: "adv-1", amountMinor: KES(5_000), outstandingAfterMinor: KES(3_000) },
    ]);
    expect(plan.capped).toBe(true);
  });

  it("takes the instalment when it fits and never more than is outstanding", () => {
    expect(planRecoveries(KES(10_000), [advance({ instalmentMinor: KES(2_000) })], "50")).toEqual({
      recoveries: [
        { advanceId: "adv-1", amountMinor: KES(2_000), outstandingAfterMinor: KES(6_000) },
      ],
      capMinor: KES(5_000),
      capped: false,
    });
    const last = planRecoveries(KES(10_000), [advance({ outstandingMinor: KES(1_000) })], "50");
    expect(last.recoveries[0]?.outstandingAfterMinor).toBe(0);
  });

  it("recovers oldest first, honours an advance's own lower cap and rounds the cap down", () => {
    const plan = planRecoveries(
      999,
      [
        advance({ id: "new", disbursedOn: "2026-11-05" }),
        advance({ id: "old", disbursedOn: "2026-10-01", maxRecoveryPercent: "10" }),
      ],
      "50",
    );
    expect(plan.capMinor).toBe(499);
    expect(plan.recoveries).toEqual([
      { advanceId: "old", amountMinor: 99, outstandingAfterMinor: KES(8_000) - 99 },
      { advanceId: "new", amountMinor: 400, outstandingAfterMinor: KES(8_000) - 400 },
    ]);
  });

  it("recovers nothing from no pay", () => {
    expect(planRecoveries(0, [advance()], "50").recoveries).toEqual([]);
    expect(planRecoveries(-100, [advance()], "100").recoveries).toEqual([]);
  });
});

describe("pay calendars", () => {
  const weekly = defaultPayCalendar({ weekEndsOn: 4, paydayWeekday: 5 });

  it("defaults to the timesheet weeks (Friday–Thursday) paid on Friday", () => {
    expect(weekly.frequency).toBe("weekly");
    expect(weekly.paydayOffsetDays).toBe(1);
    expect(payPeriodFor("2026-11-11", weekly)).toEqual({
      startDate: "2026-11-06",
      endDate: "2026-11-12",
      payDate: "2026-11-13",
    });
    expect(payPeriodFor("2026-11-06", weekly).startDate).toBe("2026-11-06");
    expect(payPeriodFor("2026-11-05", weekly).endDate).toBe("2026-11-05");
  });

  it("supports daily, fortnightly and monthly calendars", () => {
    expect(
      payPeriodFor("2026-11-11", { ...weekly, frequency: "daily", paydayOffsetDays: 0 }),
    ).toEqual({ startDate: "2026-11-11", endDate: "2026-11-11", payDate: "2026-11-11" });
    const fortnight = {
      frequency: "fortnightly" as const,
      anchorDate: "2026-11-06",
      paydayOffsetDays: 1,
    };
    expect(payPeriodFor("2026-11-19", fortnight)).toEqual({
      startDate: "2026-11-06",
      endDate: "2026-11-19",
      payDate: "2026-11-20",
    });
    expect(payPeriodFor("2026-11-05", fortnight).startDate).toBe("2026-10-23");
    expect(
      payPeriodFor("2028-02-10", {
        frequency: "monthly",
        anchorDate: "2026-01-01",
        paydayOffsetDays: 0,
      }),
    ).toEqual({ startDate: "2028-02-01", endDate: "2028-02-29", payDate: "2028-02-29" });
    expect(payPeriodsBetween("2026-10-30", "2026-11-12", weekly).map((p) => p.startDate)).toEqual([
      "2026-10-30",
      "2026-11-06",
    ]);
  });

  it("assigns a batch to the statutory month of its pay date", () => {
    const period = payPeriodFor("2026-04-30", weekly);
    expect(period.endDate).toBe("2026-04-30");
    expect(statutoryMonthOf(period.payDate)).toBe("2026-05");
  });
});

describe("rule parameter validation", () => {
  const issues = <K extends StatutoryRuleKind>(kind: K, parameters: StatutoryParameters[K]) =>
    statutoryParameterIssues(kind, parameters);
  it("accepts every seed version", () => {
    for (const seed of KENYA_STATUTORY_SEED)
      expect(statutoryParameterIssues(seed.kind, seed.parameters), seed.kind).toEqual([]);
  });
  it("refuses unordered bands, inverted limits, bad rates and unknown methods", () => {
    expect(
      issues("paye", {
        bands: [
          { upToMinor: 10, ratePercent: "10" },
          { upToMinor: 5, ratePercent: "20" },
          { upToMinor: null, ratePercent: "30" },
        ],
        personalReliefMinor: 0,
        deductibleBeforeTax: [],
      }),
    ).toContain("bands");
    expect(
      issues("nssf", {
        employeeRatePercent: "6",
        employerRatePercent: "600",
        lowerEarningsLimitMinor: 10,
        upperEarningsLimitMinor: 5,
      }),
    ).toEqual(["rate", "limits"]);
    expect(issues("method", { method: "guess" as never })).toEqual(["method"]);
    expect(percentMinor(1, "50")).toBe(1);
  });
});

// Batch scenarios ---------------------------------------------------------------------------------

const labourer = (overrides: Partial<BatchLabourer> = {}): BatchLabourer => ({
  id: "w1",
  workerNo: "WRK-0001",
  fullName: "Mfanyakazi Mmoja",
  engagementType: "casual",
  rateBasis: "daily",
  tradeId: "general",
  skillLevelId: "unskilled",
  occupation: "general_labourer",
  ...overrides,
});
const rate = (overrides: Partial<RateCandidate> = {}): RateCandidate => ({
  id: "rate-1",
  projectId: "p1",
  labourerId: null,
  tradeId: "general",
  skillLevelId: null,
  basis: "daily",
  rateMinor: KES(1_000),
  effectiveFrom: "2026-01-01",
  ...overrides,
});
const week = ["2026-11-06", "2026-11-07", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"];
const line = (
  id: string,
  labourerId: string,
  dates = week,
  kind: "attendance" | "adjustment" = "attendance",
) => ({
  id,
  labourerId,
  kind,
  periodId: "tp-1",
  periodEndDate: "2026-11-12",
  days: dates.map((date) => day({ date })),
});
const input = (overrides: Partial<BatchInput> = {}): BatchInput => ({
  projectId: "p1",
  periodStart: "2026-11-06",
  periodEnd: "2026-11-12",
  payDate: "2026-11-13",
  rules: year4,
  labourers: [labourer(), labourer({ id: "w2", workerNo: "WRK-0002" })],
  rates: [rate()],
  timesheetRules: new Map([["rule-1", ruleRef]]),
  lines: [line("l1", "w1"), line("l2", "w2")],
  shares: [],
  allowances: [],
  prior: new Map(),
  advances: new Map(),
  claims: [],
  recoveryMaxPercent: "50",
  allowUnverifiedTimesheetRules: true,
  minimumWageArea: "municipalities",
  minimumWages: [
    {
      id: "mw",
      area: "municipalities",
      occupation: "general_labourer",
      effectiveFrom: "2026-05-01",
      monthlyMinor: 1_665_095,
      dailyMinor: null,
      hourlyMinor: null,
    },
  ],
  ...overrides,
});

describe("batch builder", () => {
  it("reconciles totals to the sum of rounded line amounts", () => {
    const result = computeBatch(input());
    expect(result.lines).toHaveLength(2);
    for (const entry of result.lines) {
      expect(entry.grossMinor).toBe(entry.earnings.reduce((sum, row) => sum + row.amountMinor, 0));
      expect(entry.netMinor).toBe(entry.grossMinor - entry.totalDeductionsMinor);
      expect(entry.netMinor).toBeGreaterThanOrEqual(0);
    }
    expect(result.totals.grossMinor).toBe(KES(12_000));
    expect(result.totals.netMinor).toBe(
      result.lines.reduce((sum, entry) => sum + entry.netMinor, 0),
    );
    expect(result.totals.grossMinor - result.totals.totalDeductionsMinor).toBe(
      result.totals.netMinor,
    );
    expect(result.unverified).toBe(true);
    expect(result.timesheetRuleIds).toEqual(["rule-1"]);
    expect(result.lines[0]?.claims.map((claim) => claim.basis)).toEqual(
      Array(6).fill("attendance"),
    );
  });

  it("never pays attendance and piece rate for the same labourer-day", () => {
    const result = computeBatch(
      input({
        lines: [line("l1", "w1")],
        shares: [
          {
            id: "s1",
            outputId: "o1",
            labourerId: "w1",
            workDate: "2026-11-10",
            amountMinor: KES(1_800),
            description: "Blockwork",
            quantity: "12",
            unit: "m2",
            rateMinor: KES(150),
          },
          {
            id: "s2",
            outputId: "o2",
            labourerId: "w1",
            workDate: "2026-11-05",
            amountMinor: KES(900),
            description: "Blockwork",
            quantity: "6",
            unit: "m2",
            rateMinor: KES(150),
          },
        ],
        claims: [
          { labourerId: "w1", date: "2026-11-05", basis: "attendance" },
          { labourerId: "w1", date: "2026-11-12", basis: "piece_rate" },
        ],
      }),
    );
    const entry = result.lines[0]!;
    expect(entry.summary.replacedDays).toEqual(["2026-11-10", "2026-11-12"]);
    expect(
      entry.earnings.filter((row) => row.date === "2026-11-10").map((row) => row.kind),
    ).toEqual(["piece_rate"]);
    expect(entry.earnings.some((row) => row.date === "2026-11-12")).toBe(false);
    expect(result.exclusions).toEqual([
      {
        sourceKind: "piece_rate_share",
        sourceId: "s2",
        labourerId: "w1",
        reason: "day-paid-by-attendance",
        date: "2026-11-05",
      },
    ]);
    expect(entry.grossMinor).toBe(KES(4_000 + 1_800));
    expect(entry.claims).toContainEqual({
      labourerId: "w1",
      date: "2026-11-10",
      basis: "piece_rate",
    });
    expect(entry.claims.filter((claim) => claim.date === "2026-11-10")).toHaveLength(1);
    expect(entry.warnings.map((warning) => warning.code)).toContain(
      "attendance-replaced-by-piece-rate",
    );
  });

  it("pays piece-rate labourers from output only", () => {
    const result = computeBatch(
      input({
        labourers: [labourer({ engagementType: "piece_rate" })],
        lines: [line("l1", "w1")],
        rates: [],
      }),
    );
    expect(result.lines[0]?.grossMinor).toBe(0);
    expect(result.lines[0]?.warnings.map((warning) => warning.code)).toEqual([
      "piece-rate-engagement",
      "zero-pay",
    ]);
    expect(result.lines[0]?.timesheetLineIds).toEqual(["l1"]);
  });

  it("leaves out lines without a rate, without a rule or with unverified rules in production", () => {
    const missingRate = computeBatch(input({ rates: [rate({ effectiveFrom: "2026-11-09" })] }));
    expect(missingRate.lines).toHaveLength(0);
    expect(missingRate.exclusions.map((entry) => [entry.reason, entry.date])).toEqual([
      ["missing-rate", "2026-11-06"],
      ["missing-rate", "2026-11-06"],
    ]);
    const production = computeBatch(input({ allowUnverifiedTimesheetRules: false }));
    expect(production.exclusions.map((entry) => entry.reason)).toEqual([
      "timesheet-rule-unverified",
      "timesheet-rule-unverified",
    ]);
    const noRule = computeBatch(
      input({ lines: [{ ...line("l1", "w1"), days: [day({ ruleVersionId: null })] }] }),
    );
    expect(noRule.exclusions[0]?.reason).toBe("rule-missing");
  });

  it("leaves a labourer out when an adjustment makes gross negative", () => {
    const result = computeBatch(
      input({
        lines: [
          line("l1", "w1", ["2026-11-09"]),
          {
            ...line("adj", "w1", ["2026-10-29"], "adjustment"),
            days: [day({ date: "2026-10-29", halfDays: -4 })],
          },
        ],
      }),
    );
    expect(result.lines).toHaveLength(0);
    expect(result.exclusions.map((entry) => [entry.sourceId, entry.reason])).toEqual([
      ["l1", "negative-gross"],
      ["adj", "negative-gross"],
    ]);
  });

  it("recovers disbursed advances after statutory deductions and keeps net non-negative", () => {
    const result = computeBatch(
      input({
        advances: new Map([
          [
            "w1",
            [
              {
                id: "adv",
                outstandingMinor: KES(50_000),
                instalmentMinor: null,
                maxRecoveryPercent: null,
                disbursedOn: "2026-11-01",
              },
            ],
          ],
        ]),
      }),
    );
    const entry = result.lines[0]!;
    const statutory =
      entry.statutory.withheld.nssf +
      entry.statutory.withheld.shif +
      entry.statutory.withheld.ahl +
      entry.statutory.withheld.paye;
    expect(entry.recoveries[0]?.amountMinor).toBe(Math.floor((entry.grossMinor - statutory) / 2));
    expect(entry.netMinor).toBe(entry.grossMinor - statutory - entry.recoveries[0]!.amountMinor);
    expect(entry.warnings.map((warning) => warning.code)).toContain("advance-recovery-capped");
  });

  it("warns (never blocks) when a rate is below the configured minimum wage", () => {
    const low = computeBatch(input({ rates: [rate({ rateMinor: KES(600) })] }));
    const warning = low.lines[0]?.warnings.find((entry) => entry.code === "below-minimum-wage");
    expect(warning?.details).toMatchObject({
      derived: true,
      minimumMinor: 64_042,
      rateMinor: KES(600),
    });
    expect(low.lines[0]?.grossMinor).toBe(KES(3_600));
    const none = computeBatch(input({ minimumWageArea: null }));
    expect(none.lines[0]?.warnings.map((entry) => entry.code)).toContain(
      "minimum-wage-not-configured",
    );
  });

  it("marks earlier timesheet periods as brought forward and adds allowances to the base", () => {
    const result = computeBatch(
      input({
        lines: [{ ...line("old", "w1", ["2026-11-02"]), periodEndDate: "2026-11-05" }],
        allowances: [
          {
            id: "tools",
            code: "tools",
            nameEn: "Tools",
            basis: "per_period",
            amountMinor: KES(250),
            taxable: false,
            tradeId: null,
            labourerId: null,
            effectiveFrom: "2026-01-01",
            endedOn: null,
          },
        ],
      }),
    );
    const entry = result.lines[0]!;
    expect(entry.warnings[0]).toMatchObject({ code: "brought-forward" });
    expect(entry.grossMinor).toBe(KES(1_250));
    expect(entry.statutoryBaseMinor).toBe(KES(1_000));
  });
});
