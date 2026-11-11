import { describe, expect, it } from "vitest";
import { DEMO_TIMESHEET_RULE } from "@pm-buddy/types";
import {
  computeLabourerDay,
  dayTransition,
  dayTypeOf,
  detectDayAnomalies,
  emptyTotals,
  entryIssues,
  formatClock,
  formatDuration,
  formatHalfDays,
  isoWeekday,
  isPeriodDue,
  isPeriodEditable,
  isZeroTotals,
  multiplierHundredths,
  parseClock,
  periodTransition,
  resolveTimesheetRule,
  ruleIssues,
  shareProportionally,
  subtractTotals,
  sumDays,
  timesheetDays,
  weeklyPeriodFor,
  zonedDateTime,
  type AnomalyLabourer,
  type AnomalyRecord,
  type DayRecord,
  type DayRule,
} from "./index.js";

const rule: DayRule = { id: "rule-1", ...DEMO_TIMESHEET_RULE, restDays: [7] };
const clock = (text: string) => parseClock(text)!;
const record = (overrides: Partial<DayRecord> & { id: string }): DayRecord => ({
  projectId: "p1",
  siteId: "s1",
  status: "present",
  checkIn: clock("07:00"),
  checkOut: clock("16:00"),
  overnight: false,
  breakMinutes: null,
  ...overrides,
});
const day = (
  records: DayRecord[],
  date = "2026-11-11",
  holidays: string[] = [],
  ruleFor: (projectId: string) => DayRule | null = () => rule,
) => computeLabourerDay({ date, records, ruleFor, holidays: new Set(holidays) });

describe("attendance time helpers", () => {
  it("parses and formats 24-hour times", () => {
    expect(parseClock("07:30")).toBe(450);
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("23:59")).toBe(1439);
    for (const invalid of ["24:00", "7:30", "07:60", "", "0730", "07:30:00"])
      expect(parseClock(invalid), invalid).toBeNull();
    expect(formatClock(450)).toBe("07:30");
    expect(formatClock(1500)).toBe("01:00");
    expect(formatDuration(485)).toBe("8:05");
    expect(formatDuration(-90)).toBe("-1:30");
    expect(formatHalfDays(9)).toBe("4.5");
    expect(formatHalfDays(8)).toBe("4");
    expect(formatHalfDays(-1)).toBe("-0.5");
  });

  it("finds ISO weekdays and Nairobi wall-clock instants", () => {
    expect(isoWeekday("2026-11-12")).toBe(4);
    expect(isoWeekday("2026-11-15")).toBe(7);
    expect(isoWeekday("2026-11-16")).toBe(1);
    // Africa/Nairobi is UTC+3: Thursday 18:00 in Nairobi is 15:00 UTC.
    expect(zonedDateTime("2026-11-12", 18 * 60).toISOString()).toBe("2026-11-12T15:00:00.000Z");
    expect(zonedDateTime("2026-12-31", 23 * 60 + 30).toISOString()).toBe(
      "2026-12-31T20:30:00.000Z",
    );
    expect(zonedDateTime("2026-01-01", 60, "UTC").toISOString()).toBe("2026-01-01T01:00:00.000Z");
  });
});

describe("timesheet rules", () => {
  const versions = [
    { id: "company-1", projectId: null, effectiveFrom: "2026-01-01" },
    { id: "company-2", projectId: null, effectiveFrom: "2026-11-01" },
    { id: "project-1", projectId: "p1", effectiveFrom: "2026-10-01" },
    { id: "project-2", projectId: "p1", effectiveFrom: "2026-12-01" },
  ];

  it("prefers a project override in force, then the latest company version", () => {
    expect(resolveTimesheetRule(versions, "p1", "2026-09-30")?.id).toBe("company-1");
    expect(resolveTimesheetRule(versions, "p1", "2026-10-01")?.id).toBe("project-1");
    expect(resolveTimesheetRule(versions, "p1", "2026-11-15")?.id).toBe("project-1");
    expect(resolveTimesheetRule(versions, "p1", "2026-12-01")?.id).toBe("project-2");
    expect(resolveTimesheetRule(versions, "p2", "2026-10-31")?.id).toBe("company-1");
    expect(resolveTimesheetRule(versions, "p2", "2026-11-01")?.id).toBe("company-2");
    expect(resolveTimesheetRule(versions, "p2", "2025-12-31")).toBeNull();
  });

  it("puts public holidays before rest days", () => {
    expect(dayTypeOf("2026-11-11", [7], new Set())).toBe("weekday");
    expect(dayTypeOf("2026-11-15", [7], new Set())).toBe("rest_day");
    expect(dayTypeOf("2026-11-15", [7], new Set(["2026-11-15"]))).toBe("public_holiday");
    expect(dayTypeOf("2026-12-12", [6, 7], new Set(["2026-12-12"]))).toBe("public_holiday");
    expect(dayTypeOf("2026-11-14", [6, 7], new Set())).toBe("rest_day");
  });

  it("checks rule consistency", () => {
    expect(ruleIssues(DEMO_TIMESHEET_RULE)).toEqual([]);
    expect(ruleIssues({ ...DEMO_TIMESHEET_RULE, halfDayThresholdMinutes: 500 })).toContain(
      "half_day_above_normal",
    );
    expect(ruleIssues({ ...DEMO_TIMESHEET_RULE, maxPlausibleMinutes: 300 })).toContain(
      "max_below_normal",
    );
    expect(ruleIssues({ ...DEMO_TIMESHEET_RULE, restDays: [7, 7] })).toContain("rest_days_invalid");
    expect(ruleIssues({ ...DEMO_TIMESHEET_RULE, restDays: [1, 2, 3, 4, 5, 6, 7] })).toContain(
      "rest_days_invalid",
    );
    expect(ruleIssues({ ...DEMO_TIMESHEET_RULE, otWeekdayMultiplier: "1.5" })).toContain(
      "multiplier_invalid",
    );
    expect(ruleIssues({ ...DEMO_TIMESHEET_RULE, otHolidayMultiplier: "0.99" })).toContain(
      "multiplier_invalid",
    );
    expect(ruleIssues({ ...DEMO_TIMESHEET_RULE, otHolidayMultiplier: "5.01" })).toContain(
      "multiplier_invalid",
    );
    expect(ruleIssues({ ...DEMO_TIMESHEET_RULE, normalMinutes: 59 })).toContain("out_of_range");
    expect(multiplierHundredths("1.50")).toBe(150);
    expect(multiplierHundredths("1.5")).toBeNull();
  });

  it("refuses inconsistent entries explicitly", () => {
    const entry = { status: "present" as const, checkIn: 420, checkOut: 960, overnight: false };
    expect(entryIssues({ ...entry, breakMinutes: null })).toEqual([]);
    expect(entryIssues({ ...entry, checkOut: 420, breakMinutes: null })).toEqual([
      "check_out_not_after_check_in",
    ]);
    expect(entryIssues({ ...entry, checkOut: 300, breakMinutes: null })).toEqual([
      "check_out_not_after_check_in",
    ]);
    // An overnight shift ends the next morning; it may not reach 24 hours.
    expect(
      entryIssues({ ...entry, checkIn: 1080, checkOut: 360, overnight: true, breakMinutes: 60 }),
    ).toEqual([]);
    expect(
      entryIssues({ ...entry, checkIn: 1080, checkOut: 1080, overnight: true, breakMinutes: null }),
    ).toEqual(["overnight_too_long"]);
    expect(entryIssues({ ...entry, breakMinutes: 540 })).toEqual(["break_too_long"]);
    expect(entryIssues({ ...entry, breakMinutes: 539 })).toEqual([]);
    expect(entryIssues({ ...entry, checkIn: null, breakMinutes: null })).toEqual([
      "times_required",
    ]);
    expect(entryIssues({ ...entry, checkIn: 1440, breakMinutes: null })).toEqual([
      "time_out_of_range",
    ]);
    expect(
      entryIssues({
        status: "absent",
        checkIn: 420,
        checkOut: null,
        overnight: false,
        breakMinutes: null,
      }),
    ).toEqual(["times_not_allowed"]);
    expect(
      entryIssues({
        status: "leave",
        checkIn: null,
        checkOut: null,
        overnight: false,
        breakMinutes: null,
      }),
    ).toEqual([]);
  });
});

describe("labourer-day computation", () => {
  it("deducts the default break and splits normal time and weekday overtime", () => {
    const result = day([record({ id: "a" })]);
    expect(result).toMatchObject({
      dayType: "weekday",
      totalWorkedMinutes: 480,
      normalMinutes: 480,
      overtimeMinutes: 0,
      halfDays: 2,
      lateMinutes: 0,
      ruleId: "rule-1",
    });
    expect(result.records[0]).toMatchObject({ breakMinutes: 60, workedMinutes: 480 });
    const long = day([record({ id: "a", checkOut: clock("18:00") })]);
    expect(long.records[0]).toMatchObject({
      normalMinutes: 480,
      overtimeMinutes: 120,
      dayType: "weekday",
    });
  });

  it("applies the default break only above breakAfterMinutes and honours an entered break", () => {
    // 07:00–12:00 is exactly 300 minutes: no default break.
    expect(day([record({ id: "a", checkOut: clock("12:00") })]).totalWorkedMinutes).toBe(300);
    expect(day([record({ id: "a", checkOut: clock("12:01") })]).totalWorkedMinutes).toBe(241);
    expect(day([record({ id: "a", breakMinutes: 30 })]).totalWorkedMinutes).toBe(510);
    expect(day([record({ id: "a", breakMinutes: 0 })]).normalMinutes).toBe(480);
    expect(day([record({ id: "a", breakMinutes: 0 })]).overtimeMinutes).toBe(60);
  });

  it("counts a half day below the threshold and a full day at it", () => {
    expect(day([record({ id: "a", checkOut: clock("11:00") })]).halfDays).toBe(2);
    expect(day([record({ id: "a", checkOut: clock("10:59") })]).halfDays).toBe(1);
    // A recorded half day stays a half day however long it was.
    expect(day([record({ id: "a", status: "half_day" })]).halfDays).toBe(1);
    expect(day([record({ id: "a", status: "half_day" })]).totalWorkedMinutes).toBe(480);
  });

  it("measures lateness from the start time once past the grace period (weekdays only)", () => {
    expect(day([record({ id: "a", checkIn: clock("07:15") })]).lateMinutes).toBe(0);
    expect(day([record({ id: "a", checkIn: clock("07:16") })]).lateMinutes).toBe(16);
    expect(day([record({ id: "a", checkIn: clock("09:00") })], "2026-11-15").lateMinutes).toBe(0);
  });

  it("pays rest days and public holidays as overtime of their category", () => {
    const sunday = day([record({ id: "a" })], "2026-11-15");
    expect(sunday).toMatchObject({ dayType: "rest_day", normalMinutes: 0, overtimeMinutes: 480 });
    const holiday = day([record({ id: "a" })], "2026-12-25", ["2026-12-25"]);
    expect(holiday.records[0]).toMatchObject({ dayType: "public_holiday", overtimeMinutes: 480 });
    // A public holiday on a rest day is paid as a public holiday.
    const both = day([record({ id: "a" })], "2026-11-15", ["2026-11-15"]);
    expect(both.dayType).toBe("public_holiday");
  });

  it("supports overnight shifts dated on the start day", () => {
    const night = day([
      record({ id: "a", checkIn: clock("18:00"), checkOut: clock("06:00"), overnight: true }),
    ]);
    expect(night).toMatchObject({
      totalWorkedMinutes: 660,
      normalMinutes: 480,
      overtimeMinutes: 180,
      lateMinutes: 0,
    });
  });

  it("counts a day on two sites once and shares it by minutes", () => {
    const result = day([
      record({ id: "a", siteId: "s1", checkOut: clock("12:00") }),
      record({
        id: "b",
        siteId: "s2",
        projectId: "p2",
        checkIn: clock("13:00"),
        checkOut: clock("17:00"),
      }),
    ]);
    expect(result).toMatchObject({ totalWorkedMinutes: 540, halfDays: 2, siteCount: 2 });
    const [a, b] = result.records;
    expect(a).toMatchObject({ normalMinutes: 300, overtimeMinutes: 0, halfDays: 1 });
    expect(b).toMatchObject({ normalMinutes: 180, overtimeMinutes: 60, halfDays: 1 });
    expect(a!.halfDays + b!.halfDays).toBe(2);
  });

  it("never counts overlapping minutes twice", () => {
    const result = day([
      record({ id: "a" }),
      record({ id: "b", siteId: "s2", checkIn: clock("08:00"), checkOut: clock("12:00") }),
    ]);
    expect(result.totalWorkedMinutes).toBe(480);
    expect(result.overlapMinutes).toBe(240);
    expect(result.records.map((entry) => entry.workedMinutes)).toEqual([480, 0]);
    expect(result.records.map((entry) => entry.halfDays)).toEqual([2, 0]);
  });

  it("keeps locked allocations and shares only what remains", () => {
    const result = day([
      record({
        id: "a",
        locked: {
          halfDays: 2,
          workedMinutes: 480,
          normalMinutes: 480,
          overtimeMinutes: 0,
          lateMinutes: 0,
        },
      }),
      record({
        id: "b",
        siteId: "s2",
        projectId: "p2",
        checkIn: clock("17:00"),
        checkOut: clock("19:00"),
      }),
    ]);
    expect(result.records[0]).toMatchObject({ locked: true, halfDays: 2, normalMinutes: 480 });
    expect(result.records[1]).toMatchObject({
      locked: false,
      halfDays: 0,
      normalMinutes: 0,
      overtimeMinutes: 120,
    });
    // Even an earlier record cannot take the normal time a locked record was paid for.
    const earlier = day([
      record({
        id: "a",
        locked: {
          halfDays: 2,
          workedMinutes: 480,
          normalMinutes: 480,
          overtimeMinutes: 0,
          lateMinutes: 0,
        },
      }),
      record({ id: "b", siteId: "s2", checkIn: clock("05:00"), checkOut: clock("06:30") }),
    ]);
    const free = earlier.records.find((entry) => entry.recordId === "b")!;
    expect(free.normalMinutes).toBe(0);
    expect(free.halfDays).toBe(0);
  });

  it("reports a missing rule instead of guessing", () => {
    const result = day([record({ id: "a" })], "2026-11-11", [], () => null);
    expect(result).toMatchObject({ missingRule: true, dayType: null, totalWorkedMinutes: 0 });
    expect(result.records[0]!.halfDays).toBe(0);
  });

  it("records absences, leave and sick days without time", () => {
    const result = day([
      record({ id: "a", status: "absent", checkIn: null, checkOut: null }),
      record({ id: "b", status: "sick", siteId: "s2", checkIn: null, checkOut: null }),
    ]);
    expect(result).toMatchObject({ halfDays: 0, totalWorkedMinutes: 0 });
    const days = timesheetDays([result], "p1");
    expect(days[0]!.totals.statusCounts).toMatchObject({ absent: 1, sick: 1, present: 0 });
  });

  it("shares units by largest remainder without losing any", () => {
    expect(shareProportionally(2, [300, 240])).toEqual([1, 1]);
    expect(shareProportionally(1, [100, 100])).toEqual([1, 0]);
    expect(shareProportionally(2, [0, 0])).toEqual([2, 0]);
    expect(shareProportionally(0, [5])).toEqual([0]);
    expect(shareProportionally(1, [1, 2])).toEqual([0, 1]);
  });
});

describe("timesheet totals", () => {
  it("sums a project's days and computes adjustment deltas", () => {
    const monday = day([record({ id: "a", checkOut: clock("18:00") })], "2026-11-09");
    const sunday = day([record({ id: "b" })], "2026-11-15");
    const other = day([record({ id: "c", projectId: "p2" })], "2026-11-10");
    const days = timesheetDays([sunday, monday, other], "p1");
    expect(days.map((entry) => entry.date)).toEqual(["2026-11-09", "2026-11-15"]);
    const totals = sumDays(days);
    expect(totals).toMatchObject({
      halfDays: 4,
      workedMinutes: 1080,
      normalMinutes: 480,
      overtimeMinutes: { weekday: 120, rest_day: 480, public_holiday: 0 },
    });
    expect(totals.statusCounts.present).toBe(2);
    const delta = subtractTotals(days[0]!.totals, sumDays([]));
    expect(delta.overtimeMinutes.weekday).toBe(120);
    expect(isZeroTotals(subtractTotals(totals, totals))).toBe(true);
    expect(isZeroTotals(emptyTotals())).toBe(true);
  });
});

describe("anomaly rules", () => {
  const labourer: AnomalyLabourer = {
    status: "active",
    doNotRehire: false,
    accreditationExpected: false,
    cards: [],
  };
  const anomalies = (records: AnomalyRecord[], who = labourer, date = "2026-11-11") =>
    detectDayAnomalies({ records, result: day(records, date), labourer: who, date });
  const engaged = (overrides: Partial<AnomalyRecord> & { id: string }): AnomalyRecord => ({
    ...record(overrides),
    engaged: true,
    ...overrides,
  });

  it("finds nothing on an ordinary day", () => {
    expect(anomalies([engaged({ id: "a" })])).toEqual([]);
  });

  it("flags the same labourer present on two sites, and overlapping times", () => {
    const found = anomalies([
      engaged({ id: "a", siteId: "s1" }),
      engaged({
        id: "b",
        siteId: "s2",
        projectId: "p2",
        checkIn: clock("10:00"),
        checkOut: clock("12:00"),
      }),
    ]);
    expect(
      found.filter((entry) => entry.kind === "two_sites").map((entry) => entry.recordId),
    ).toEqual(["a", "b"]);
    expect(
      found.find((entry) => entry.kind === "overlapping_times" && entry.recordId === "b")?.details,
    ).toEqual({ overlapMinutes: 120 });
    // Absent on the other site is not a second worked day.
    expect(
      anomalies([
        engaged({ id: "a" }),
        engaged({ id: "b", siteId: "s2", status: "absent", checkIn: null, checkOut: null }),
      ]),
    ).toEqual([]);
  });

  it("flags hours above the plausible maximum", () => {
    const found = anomalies([
      engaged({ id: "a", checkIn: clock("05:00"), checkOut: clock("20:00") }),
    ]);
    expect(found).toEqual([
      {
        recordId: "a",
        kind: "excess_hours",
        details: { workedMinutes: 840, maxPlausibleMinutes: 720 },
      },
    ]);
    expect(
      anomalies([engaged({ id: "a", checkIn: clock("06:00"), checkOut: clock("19:00") })]),
    ).toEqual([]);
  });

  it("flags records outside an engagement, inactive and do-not-rehire labourers", () => {
    expect(anomalies([engaged({ id: "a", engaged: false })]).map((entry) => entry.kind)).toEqual([
      "not_engaged",
    ]);
    expect(
      anomalies([engaged({ id: "a" })], { ...labourer, status: "inactive" }).map(
        (entry) => entry.kind,
      ),
    ).toEqual(["labourer_inactive"]);
    expect(
      anomalies([engaged({ id: "a" })], { ...labourer, doNotRehire: true }).map(
        (entry) => entry.kind,
      ),
    ).toEqual(["do_not_rehire"]);
  });

  it("flags skilled work without an NCA card valid that day", () => {
    const skilled = { ...labourer, accreditationExpected: true };
    expect(anomalies([engaged({ id: "a" })], skilled).map((entry) => entry.kind)).toEqual([
      "accreditation_invalid",
    ]);
    const valid = { ...skilled, cards: [{ issuedOn: "2026-01-01", expiresOn: "2026-11-11" }] };
    expect(anomalies([engaged({ id: "a" })], valid)).toEqual([]);
    const expired = { ...skilled, cards: [{ issuedOn: null, expiresOn: "2026-11-10" }] };
    expect(anomalies([engaged({ id: "a" })], expired)).toHaveLength(1);
  });
});

describe("timesheet periods", () => {
  const settings = { weekEndsOn: 4 as const, cutoffMinutes: 18 * 60 };

  it("runs Friday to Thursday with a Thursday 18:00 Nairobi cut-off", () => {
    for (const date of ["2026-11-06", "2026-11-09", "2026-11-12"]) {
      const period = weeklyPeriodFor(date, settings);
      expect(period.startDate, date).toBe("2026-11-06");
      expect(period.endDate, date).toBe("2026-11-12");
      expect(period.cutoffAt.toISOString()).toBe("2026-11-12T15:00:00.000Z");
    }
    expect(weeklyPeriodFor("2026-11-13", settings).startDate).toBe("2026-11-13");
    // Across a month and a year boundary.
    expect(weeklyPeriodFor("2026-12-31", settings)).toMatchObject({
      startDate: "2026-12-25",
      endDate: "2026-12-31",
    });
    expect(weeklyPeriodFor("2027-01-01", settings).endDate).toBe("2027-01-07");
    // Another configuration: weeks ending on Sunday.
    expect(weeklyPeriodFor("2026-11-11", { weekEndsOn: 7, cutoffMinutes: 0 }).startDate).toBe(
      "2026-11-09",
    );
  });

  it("is due exactly at the cut-off, not a millisecond earlier", () => {
    const { cutoffAt } = weeklyPeriodFor("2026-11-12", settings);
    expect(isPeriodDue(cutoffAt, new Date("2026-11-12T15:00:00.000Z"))).toBe(true);
    expect(isPeriodDue(cutoffAt, new Date("2026-11-12T14:59:59.999Z"))).toBe(false);
  });

  it("allows only the documented transitions", () => {
    expect(dayTransition("draft", "submit")).toBe("submitted");
    expect(dayTransition("submitted", "confirm")).toBe("confirmed");
    expect(dayTransition("submitted", "return")).toBe("draft");
    expect(dayTransition("confirmed", "return")).toBeNull();
    expect(dayTransition("draft", "confirm")).toBeNull();
    expect(periodTransition("open", "submit")).toBe("submitted");
    expect(periodTransition("submitted", "approve")).toBe("approved");
    expect(periodTransition("submitted", "reject")).toBe("rejected");
    expect(periodTransition("rejected", "reopen")).toBe("open");
    expect(periodTransition("rejected", "submit")).toBeNull();
    expect(periodTransition("approved", "reject")).toBeNull();
    expect(periodTransition("open", "approve")).toBeNull();
    expect(isPeriodEditable("open")).toBe(true);
    expect(isPeriodEditable("rejected")).toBe(true);
    expect(isPeriodEditable("submitted")).toBe(false);
    expect(isPeriodEditable("approved")).toBe(false);
  });
});

describe("half days across sites and projects", () => {
  const halfA = (overrides: Partial<DayRecord> = {}) =>
    record({
      id: "a",
      status: "half_day",
      checkIn: clock("07:00"),
      checkOut: clock("11:00"),
      ...overrides,
    });
  const halfB = (overrides: Partial<DayRecord> = {}) =>
    record({
      id: "b",
      projectId: "p2",
      siteId: "s2",
      status: "half_day",
      checkIn: clock("12:00"),
      checkOut: clock("16:00"),
      ...overrides,
    });
  const shares = (records: DayRecord[]) =>
    Object.fromEntries(day(records).records.map((entry) => [entry.recordId, entry.halfDays]));

  it("counts each half-day record as one half, on any site or project", () => {
    expect(day([halfA(), halfB()]).halfDays).toBe(2);
    expect(shares([halfA(), halfB()])).toEqual({ a: 1, b: 1 });
    // The same result whichever record comes first or is on which project.
    expect(shares([halfB(), halfA()])).toEqual({ a: 1, b: 1 });
    expect(shares([halfA({ projectId: "p2" }), halfB({ projectId: "p1" })])).toEqual({
      a: 1,
      b: 1,
    });
  });

  it("gives half day + present the same two halves as two half days", () => {
    expect(day([halfA(), halfB({ status: "present" })]).halfDays).toBe(2);
    expect(shares([halfA(), halfB({ status: "present" })])).toEqual({ a: 1, b: 1 });
    expect(shares([halfA({ status: "present" }), halfB()])).toEqual({ a: 1, b: 1 });
  });

  it("never gives a half-day record more than one half and caps the day at two", () => {
    // A long half day with a short present record: the present record takes the second half.
    const long = [
      halfA({ checkIn: clock("06:00"), checkOut: clock("14:00") }),
      halfB({ status: "present", checkIn: clock("15:00"), checkOut: clock("16:00") }),
    ];
    expect(day(long).halfDays).toBe(2);
    expect(shares(long)).toEqual({ a: 1, b: 1 });
    // Three half-day records are still one day.
    const three = [
      halfA({ checkOut: clock("09:00") }),
      halfB({ checkIn: clock("10:00"), checkOut: clock("12:00") }),
      record({
        id: "c",
        projectId: "p3",
        siteId: "s3",
        status: "half_day",
        checkIn: clock("13:00"),
        checkOut: clock("14:00"),
      }),
    ];
    expect(day(three).halfDays).toBe(2);
    expect(Object.values(shares(three)).every((value) => value <= 1)).toBe(true);
    // One half-day record alone stays one half however long it was.
    expect(day([halfA({ checkOut: clock("18:00") })]).halfDays).toBe(1);
  });

  it("applies the threshold only when a present record is involved", () => {
    // Short present work alone is a half; a short present record cannot lower two half days.
    expect(day([halfA({ status: "present", checkOut: clock("09:00") })]).halfDays).toBe(1);
    const mixed = [
      halfA({ checkOut: clock("08:00") }),
      halfB({ checkIn: clock("09:00"), checkOut: clock("10:00") }),
      record({
        id: "c",
        projectId: "p3",
        siteId: "s3",
        checkIn: clock("11:00"),
        checkOut: clock("12:00"),
      }),
    ];
    expect(day(mixed).halfDays).toBe(2);
    // Present work reaching the threshold is a full day with or without half-day labels.
    expect(day([halfA({ status: "present" }), halfB({ status: "present" })]).halfDays).toBe(2);
  });
});

describe("locked shares when another record of the day changes", () => {
  it("reports overpaid overtime when an earlier record on another project goes away (case a)", () => {
    const p1 = record({ id: "p1-rec", checkIn: clock("07:00"), checkOut: clock("16:00") });
    const p2 = record({
      id: "p2-rec",
      projectId: "p2",
      siteId: "s2",
      checkIn: clock("05:00"),
      checkOut: clock("07:00"),
    });
    // Week 1: both free. p2 comes first, so p1 gets 360 normal + 120 overtime.
    const original = day([p1, p2]);
    const p1Share = original.records.find((entry) => entry.recordId === "p1-rec")!;
    expect(p1Share).toMatchObject({ normalMinutes: 360, overtimeMinutes: 120 });
    expect(original.lockedDrift).toEqual([]);
    const lockedP1 = {
      ...p1,
      locked: {
        halfDays: p1Share.halfDays,
        workedMinutes: p1Share.workedMinutes,
        normalMinutes: p1Share.normalMinutes,
        overtimeMinutes: p1Share.overtimeMinutes,
        lateMinutes: p1Share.lateMinutes,
      },
    };
    // Nothing changed: the snapshot is still the ideal share.
    expect(day([lockedP1, p2]).lockedDrift).toEqual([]);
    // p2 is corrected to absent: p1 alone should be 480 normal, 0 overtime.
    const corrected = day([
      lockedP1,
      { ...p2, status: "absent", checkIn: null, checkOut: null, breakMinutes: null },
    ]);
    expect(corrected.records.find((entry) => entry.recordId === "p1-rec")).toMatchObject({
      locked: true,
      overtimeMinutes: 120,
    });
    expect(corrected.lockedDrift).toEqual([
      {
        recordId: "p1-rec",
        projectId: "p1",
        siteId: "s1",
        locked: {
          halfDays: 2,
          workedMinutes: 480,
          normalMinutes: 360,
          overtimeMinutes: 120,
          lateMinutes: 0,
        },
        ideal: {
          halfDays: 2,
          workedMinutes: 480,
          normalMinutes: 480,
          overtimeMinutes: 0,
          lateMinutes: 0,
        },
      },
    ]);
  });

  it("reports an underpaid half day when the other half goes away (case b)", () => {
    const a = record({ id: "a", checkIn: clock("07:00"), checkOut: clock("11:00") });
    const b = record({
      id: "b",
      projectId: "p2",
      siteId: "s2",
      checkIn: clock("12:00"),
      checkOut: clock("16:00"),
    });
    const original = day([a, b]);
    expect(original.records.map((entry) => entry.halfDays)).toEqual([1, 1]);
    const lockedA = {
      ...a,
      locked: {
        halfDays: 1,
        workedMinutes: 240,
        normalMinutes: 240,
        overtimeMinutes: 0,
        lateMinutes: 0,
      },
    };
    expect(day([lockedA, b]).lockedDrift).toEqual([]);
    const result = day([
      lockedA,
      { ...b, status: "absent", checkIn: null, checkOut: null, breakMinutes: null },
    ]);
    expect(result.halfDays).toBe(2);
    expect(result.records.find((entry) => entry.recordId === "a")!.halfDays).toBe(1);
    expect(result.lockedDrift).toHaveLength(1);
    expect(result.lockedDrift[0]).toMatchObject({
      recordId: "a",
      locked: { halfDays: 1 },
      ideal: { halfDays: 2, normalMinutes: 240 },
    });
  });

  it("reports nothing without locks or without a rule", () => {
    expect(day([record({ id: "a" })]).lockedDrift).toEqual([]);
    const locked = record({
      id: "a",
      locked: {
        halfDays: 0,
        workedMinutes: 0,
        normalMinutes: 0,
        overtimeMinutes: 0,
        lateMinutes: 0,
      },
    });
    expect(day([locked], "2026-11-11", [], () => null).lockedDrift).toEqual([]);
  });
});
