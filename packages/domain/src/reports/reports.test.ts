import { describe, expect, it } from "vitest";
import {
  ageInvoices,
  ageingBucket,
  datesBetween,
  daysInMonth,
  excelSerialDate,
  excelSerialNairobi,
  floatPeriod,
  halfDaysAsDays,
  minorToShillings,
  minutesAsHours,
  monthlyRunDate,
  musterCell,
  musterTotals,
  nextReportRun,
  paymentState,
  reportPeriod,
  safeAuditMetadata,
  scheduledPeriod,
} from "./index.js";

const range = { maxPeriodDays: 366, defaultPeriodDays: 30 };

describe("report periods", () => {
  it("defaults to the report's days ending today and needs both dates otherwise", () => {
    expect(reportPeriod(range, {}, "2026-11-14")).toEqual({
      ok: true,
      period: { from: "2026-10-16", to: "2026-11-14", days: 30 },
    });
    expect(reportPeriod(range, { from: "2026-11-01" }, "2026-11-14")).toEqual({
      ok: false,
      problem: "period-required",
    });
  });

  it("counts both ends, allows exactly the maximum in a leap year and refuses one more day", () => {
    expect(reportPeriod(range, { from: "2028-01-01", to: "2028-12-31" }, "2029-01-05")).toEqual({
      ok: true,
      period: { from: "2028-01-01", to: "2028-12-31", days: 366 },
    });
    expect(reportPeriod(range, { from: "2027-12-31", to: "2028-12-31" }, "2029-01-05")).toEqual({
      ok: false,
      problem: "period-too-long",
    });
    const muster = { maxPeriodDays: 31, defaultPeriodDays: 7 };
    expect(reportPeriod(muster, { from: "2028-02-01", to: "2028-03-02" }, "2028-03-02").ok).toBe(
      true,
    );
    expect(reportPeriod(muster, { from: "2028-02-01", to: "2028-03-03" }, "2028-03-03")).toEqual({
      ok: false,
      problem: "period-too-long",
    });
  });

  it("refuses reversed, future and impossible dates (29 February only in leap years)", () => {
    const today = "2027-03-10";
    const check = (from: string, to: string) => reportPeriod(range, { from, to }, today);
    expect(check("2027-03-05", "2027-03-01")).toEqual({ ok: false, problem: "period-invalid" });
    expect(check("2027-03-01", "2027-03-11")).toEqual({ ok: false, problem: "period-invalid" });
    expect(check("2027-02-29", "2027-03-01")).toEqual({ ok: false, problem: "period-invalid" });
    expect(check("2027-03-10", "2027-03-10")).toEqual({
      ok: true,
      period: { from: "2027-03-10", to: "2027-03-10", days: 1 },
    });
    expect(reportPeriod(range, { from: "2028-02-29", to: "2028-02-29" }, "2028-03-01").ok).toBe(
      true,
    );
  });

  it("lists every date across a month end and a leap day", () => {
    expect(datesBetween("2028-02-27", "2028-03-01")).toEqual([
      "2028-02-27",
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
    expect(datesBetween("2026-12-31", "2027-01-01")).toEqual(["2026-12-31", "2027-01-01"]);
  });
});

describe("invoice ageing", () => {
  it("puts each day after the due date in the right bucket, edges included", () => {
    const asAt = "2026-11-14";
    const bucket = (due: string) => ageingBucket(due, asAt);
    expect(bucket("2026-11-20")).toBe("current");
    expect(bucket("2026-11-14")).toBe("current");
    expect(bucket("2026-11-13")).toBe("1-30");
    expect(bucket("2026-10-15")).toBe("1-30"); // 30 days
    expect(bucket("2026-10-14")).toBe("31-60"); // 31 days
    expect(bucket("2026-09-15")).toBe("31-60"); // 60 days
    expect(bucket("2026-09-14")).toBe("61-90"); // 61 days
    expect(bucket("2026-08-16")).toBe("61-90"); // 90 days
    expect(bucket("2026-08-15")).toBe("over-90"); // 91 days
    // Across a leap day: 28 February to 1 March 2028 is two days.
    expect(ageingBucket("2028-02-28", "2028-03-01")).toBe("1-30");
  });

  it("ages outstanding amounts and keeps fully paid invoices out of the buckets", () => {
    const { rows, totals, outstandingMinor } = ageInvoices(
      [
        { ref: "A", dueDate: "2026-11-30", totalMinor: 116_000_00, paidMinor: 0 },
        { ref: "B", dueDate: "2026-10-01", totalMinor: 50_000_00, paidMinor: 20_000_00 },
        { ref: "C", dueDate: "2026-07-01", totalMinor: 10_000_00, paidMinor: 10_000_00 },
        { ref: "D", dueDate: "2026-07-01", totalMinor: 7_500_00, paidMinor: 0 },
      ],
      "2026-11-14",
    );
    expect(rows.map((row) => [row.ref, row.bucket, row.daysOverdue, row.outstandingMinor])).toEqual(
      [
        ["A", "current", 0, 116_000_00],
        ["B", "31-60", 44, 30_000_00],
        ["C", "paid", 0, 0],
        ["D", "over-90", 136, 7_500_00],
      ],
    );
    expect(totals).toEqual({
      current: 116_000_00,
      "1-30": 0,
      "31-60": 30_000_00,
      "61-90": 0,
      "over-90": 7_500_00,
    });
    expect(outstandingMinor).toBe(153_500_00);
  });

  it("compares recorded payments with the approved amount", () => {
    expect(paymentState(100, 0)).toBe("unpaid");
    expect(paymentState(100, 40)).toBe("part-paid");
    expect(paymentState(100, 100)).toBe("paid");
    expect(paymentState(100, 101)).toBe("over-paid");
  });
});

describe("muster roll", () => {
  it("counts present as two halves, half days as one and keeps unknown hours unknown", () => {
    const present = musterCell({
      status: "present",
      checkInMinutes: 7 * 60,
      checkOutMinutes: 17 * 60 + 5,
      overnight: false,
      breakMinutes: 60,
    });
    expect(present).toEqual({ status: "present", halfDays: 2, minutes: 545 });
    const night = musterCell({
      status: "half_day",
      checkInMinutes: 22 * 60,
      checkOutMinutes: 2 * 60,
      overnight: true,
      breakMinutes: null,
    });
    expect(night).toEqual({ status: "half_day", halfDays: 1, minutes: 240 });
    const noTimes = musterCell({
      status: "present",
      checkInMinutes: 7 * 60,
      checkOutMinutes: null,
      overnight: false,
      breakMinutes: null,
    });
    const absent = musterCell({
      status: "absent",
      checkInMinutes: null,
      checkOutMinutes: null,
      overnight: false,
      breakMinutes: null,
    });
    const sick = { ...absent, status: "sick" as const };
    expect(musterTotals([present, night, noTimes, absent, sick, null])).toEqual({
      presentHalfDays: 5,
      absent: 1,
      leave: 0,
      sick: 1,
      minutes: 785,
      missingTimes: 1,
    });
    expect(minutesAsHours(785)).toBe("13.08");
    expect(minutesAsHours(90)).toBe("1.50");
    expect(halfDaysAsDays(5)).toBe("2.5");
    expect(halfDaysAsDays(4)).toBe("2");
  });
});

describe("subscription schedules", () => {
  const nairobi = (iso: string) => new Date(`${iso}+03:00`);

  it("sends weekly at 07:00 Nairobi on the weekday, after the Nairobi midnight", () => {
    // Monday 16 November 2026, 00:30 in Nairobi is still Sunday in UTC.
    const monday = { frequency: "weekly" as const, weekday: 1 as const };
    expect(nextReportRun(monday, nairobi("2026-11-16T00:30:00"), 7).toISOString()).toBe(
      "2026-11-16T04:00:00.000Z",
    );
    expect(nextReportRun(monday, nairobi("2026-11-16T06:59:59"), 7).toISOString()).toBe(
      "2026-11-16T04:00:00.000Z",
    );
    expect(nextReportRun(monday, nairobi("2026-11-16T07:00:00"), 7).toISOString()).toBe(
      "2026-11-23T04:00:00.000Z",
    );
    const sunday = { frequency: "weekly" as const, weekday: 7 as const };
    expect(nextReportRun(sunday, nairobi("2026-11-14T23:59:00"), 7).toISOString()).toBe(
      "2026-11-15T04:00:00.000Z",
    );
  });

  it("clamps monthly days to short months and leap years and rolls over the year", () => {
    const last = { frequency: "monthly" as const, dayOfMonth: 31 };
    expect(nextReportRun(last, nairobi("2028-02-01T08:00:00"), 7).toISOString()).toBe(
      "2028-02-29T04:00:00.000Z",
    );
    expect(nextReportRun(last, nairobi("2027-02-28T07:00:00"), 7).toISOString()).toBe(
      "2027-03-31T04:00:00.000Z",
    );
    expect(nextReportRun(last, nairobi("2026-12-31T07:30:00"), 7).toISOString()).toBe(
      "2027-01-31T04:00:00.000Z",
    );
    const first = { frequency: "monthly" as const, dayOfMonth: 1 };
    expect(nextReportRun(first, nairobi("2026-12-01T06:00:00"), 7).toISOString()).toBe(
      "2026-12-01T04:00:00.000Z",
    );
    expect(monthlyRunDate(2027, 4, 31)).toBe("2027-04-30");
    expect([daysInMonth(2028, 2), daysInMonth(2100, 2), daysInMonth(2000, 2)]).toEqual([
      29, 28, 29,
    ]);
  });

  it("reports on the last whole week or the previous calendar month", () => {
    expect(scheduledPeriod("weekly", "2026-11-16")).toEqual({
      from: "2026-11-09",
      to: "2026-11-15",
    });
    expect(scheduledPeriod("weekly", "2026-11-15")).toEqual({
      from: "2026-11-02",
      to: "2026-11-08",
    });
    expect(scheduledPeriod("weekly", "2026-11-18")).toEqual({
      from: "2026-11-09",
      to: "2026-11-15",
    });
    expect(scheduledPeriod("monthly", "2027-01-05")).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(scheduledPeriod("monthly", "2028-03-01")).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });
});

describe("petty-cash floats over a period", () => {
  it("opens with everything before the period and closes with opening + movements", () => {
    const period = floatPeriod(
      [
        { kind: "top_up", amountMinor: 20_000_00, businessDate: "2026-10-30" },
        { kind: "expense", amountMinor: -3_000_00, businessDate: "2026-10-31" },
        { kind: "top_up", amountMinor: 5_000_00, businessDate: "2026-11-01" },
        { kind: "expense", amountMinor: -1_250_00, businessDate: "2026-11-03" },
        { kind: "expense_rejected", amountMinor: 1_250_00, businessDate: "2026-11-04" },
        { kind: "count_adjustment", amountMinor: -150_00, businessDate: "2026-11-30" },
        { kind: "expense", amountMinor: -999_00, businessDate: "2026-12-01" },
      ],
      "2026-11-01",
      "2026-11-30",
    );
    expect(period).toEqual({
      openingMinor: 17_000_00,
      topUpsMinor: 5_000_00,
      expensesMinor: -1_250_00,
      rejectedMinor: 1_250_00,
      countAdjustmentsMinor: -150_00,
      closingMinor: 21_850_00,
    });
  });
});

describe("safe audit metadata", () => {
  it("shows IDs, codes and numbers and hides free text and nested values", () => {
    expect(
      safeAuditMetadata({
        report: "cost-ledger",
        format: "pdf",
        rows: 12,
        projectId: "0194f0a2-7c1e-7d4b-9f00-1234567890ab",
        reason: "Paid the wrong supplier = fraud?",
        nested: { amount: 5 },
        ids: ["a1", "b2", "c3", "d4"],
        "bad key": "x",
        stepUp: true,
      }),
    ).toBe(
      "format=pdf; ids=a1,b2,c3,…(4); nested=[…]; projectId=0194f0a2-7c1e-7d4b-9f00-1234567890ab; reason=[text]; report=cost-ledger; rows=12; stepUp=true",
    );
    expect(safeAuditMetadata(null)).toBe("");
    expect(safeAuditMetadata(["x"])).toBe("");
  });
});

describe("spreadsheet values", () => {
  it("uses Excel serial days and Nairobi wall-clock time", () => {
    expect(excelSerialDate("2026-01-01")).toBe(46023);
    expect(excelSerialDate("2028-03-01") - excelSerialDate("2028-02-28")).toBe(2);
    expect(excelSerialNairobi(new Date("2026-11-14T21:00:00Z"))).toBe(
      excelSerialDate("2026-11-15"),
    );
    expect(excelSerialNairobi(new Date("2026-11-15T03:00:00Z"))).toBe(
      excelSerialDate("2026-11-15") + 0.25,
    );
    expect(minorToShillings(1_250_050)).toBe(12500.5);
  });
});
