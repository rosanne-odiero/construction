import { describe, expect, it } from "vitest";
import { DEMO_TIMESHEET_RULE } from "@pm-buddy/types";
import {
  createAdjustmentRequestSchema,
  createCorrectionRequestSchema,
  createTimesheetRuleRequestSchema,
  reviewAnomalyRequestSchema,
  saveMusterRequestSchema,
  timesheetTotalsSchema,
  updatePeriodSettingsRequestSchema,
} from "./index.js";

const labourerId = "01890000-0000-7000-8000-000000000001";
const siteId = "01890000-0000-7000-8000-000000000002";
const issues = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? [] : result.error!.issues.map((issue) => issue.message);

describe("muster roll requests", () => {
  const save = (entry: Record<string, unknown>) =>
    saveMusterRequestSchema.safeParse({
      siteId,
      date: "2026-11-11",
      dayVersion: 0,
      entries: [{ labourerId, version: 0, ...entry }],
    });

  it("accepts a present day with times and defaults the rest", () => {
    const result = save({ status: "present", checkIn: "07:00", checkOut: "16:00" });
    expect(result.success).toBe(true);
    expect(result.data!.entries[0]).toMatchObject({
      overnight: false,
      breakMinutes: null,
      notes: null,
    });
    expect(save({ status: "absent" }).success).toBe(true);
    expect(
      save({ status: "present", checkIn: "07:00", checkOut: "16:00", notes: "  " }).data!
        .entries[0]!.notes,
    ).toBeNull();
  });

  it("refuses inconsistent times with the domain issue codes", () => {
    expect(issues(save({ status: "present", checkIn: "07:00" }))).toContain("times_required");
    expect(issues(save({ status: "present", checkIn: "16:00", checkOut: "07:00" }))).toContain(
      "check_out_not_after_check_in",
    );
    expect(
      save({ status: "present", checkIn: "18:00", checkOut: "06:00", overnight: true }).success,
    ).toBe(true);
    expect(issues(save({ status: "absent", checkIn: "07:00" }))).toContain("times_not_allowed");
    expect(
      issues(save({ status: "present", checkIn: "07:00", checkOut: "08:00", breakMinutes: 60 })),
    ).toContain("break_too_long");
    expect(issues(save({ status: "present", checkIn: "7:00", checkOut: "16:00" }))).toContain(
      "invalid_time",
    );
    expect(save({ status: "late" }).success).toBe(false);
  });

  it("refuses unknown fields, tenant IDs and duplicate labourers", () => {
    expect(save({ status: "absent", tenantId: siteId }).success).toBe(false);
    const twice = saveMusterRequestSchema.safeParse({
      siteId,
      date: "2026-11-11",
      dayVersion: 0,
      entries: [
        { labourerId, status: "absent", version: 0 },
        { labourerId, status: "leave", version: 0 },
      ],
    });
    expect(issues(twice)).toContain("duplicate_labourer");
  });
});

describe("corrections, adjustments and decisions", () => {
  it("needs a reason of at least ten characters", () => {
    const base = { labourerId, status: "present", checkIn: "07:00", checkOut: "16:00" };
    expect(
      createCorrectionRequestSchema.safeParse({ ...base, recordVersion: 1, reason: "Too short" })
        .success,
    ).toBe(false);
    expect(
      createCorrectionRequestSchema.safeParse({
        ...base,
        recordVersion: 1,
        reason: "Gate book shows 16:00",
      }).success,
    ).toBe(true);
    expect(
      createAdjustmentRequestSchema.safeParse({
        ...base,
        siteId,
        date: "2026-10-01",
        reason: "Late attendance found after approval",
      }).success,
    ).toBe(true);
    expect(
      reviewAnomalyRequestSchema.safeParse({ decision: "dismiss", note: "Checked", version: 1 })
        .success,
    ).toBe(false);
  });
});

describe("timesheet rules and settings", () => {
  const rule = {
    effectiveFrom: "2026-11-12",
    ...DEMO_TIMESHEET_RULE,
  };

  it("accepts the demonstration rule and refuses inconsistent ones", () => {
    expect(createTimesheetRuleRequestSchema.safeParse(rule).success).toBe(true);
    expect(
      issues(createTimesheetRuleRequestSchema.safeParse({ ...rule, halfDayThresholdMinutes: 481 })),
    ).toContain("half_day_above_normal");
    expect(
      createTimesheetRuleRequestSchema.safeParse({ ...rule, otWeekdayMultiplier: 1.5 }).success,
    ).toBe(false);
    expect(createTimesheetRuleRequestSchema.safeParse({ ...rule, restDays: [0] }).success).toBe(
      false,
    );
  });

  it("validates the cut-off settings", () => {
    expect(
      updatePeriodSettingsRequestSchema.safeParse({
        weekEndsOn: 4,
        cutoffTime: "18:00",
        paydayWeekday: 5,
        version: 0,
      }).success,
    ).toBe(true);
    expect(
      updatePeriodSettingsRequestSchema.safeParse({
        weekEndsOn: 8,
        cutoffTime: "18:00",
        paydayWeekday: 5,
        version: 0,
      }).success,
    ).toBe(false);
  });

  it("carries day counts as exact half-day decimals", () => {
    const totals = {
      days: "4.5",
      halfDays: 9,
      workedMinutes: 2160,
      normalMinutes: 1920,
      overtimeMinutes: { weekday: 240, rest_day: 0, public_holiday: 0 },
      lateMinutes: 0,
      statusCounts: { present: 4, half_day: 1, absent: 0, leave: 0, sick: 0 },
    };
    expect(timesheetTotalsSchema.safeParse(totals).success).toBe(true);
    expect(timesheetTotalsSchema.safeParse({ ...totals, days: "4.25" }).success).toBe(false);
    expect(timesheetTotalsSchema.safeParse({ ...totals, workedMinutes: 1.5 }).success).toBe(false);
  });
});
