import {
  isWorkedStatus,
  TIMESHEET_RULE_LIMITS,
  type AttendanceStatus,
  type DayType,
  type IsoWeekday,
  type TimesheetRuleValues,
} from "@pm-buddy/types";
import { isoWeekday, MINUTES_PER_DAY } from "./time.js";

/**
 * Timesheet rules (brief §5.5): effective-dated versions at company level (`projectId` null) with
 * optional project overrides. The most specific scope that has a version in force wins, then the
 * latest `effectiveFrom` on or before the date, exactly like labour rates (D-32).
 */
export type RuleVersionKey = { id: string; projectId: string | null; effectiveFrom: string };

export function resolveTimesheetRule<T extends RuleVersionKey>(
  versions: readonly T[],
  projectId: string,
  date: string,
): T | null {
  const latest = (candidates: T[]) =>
    candidates.reduce<T | null>(
      (best, version) => (!best || version.effectiveFrom > best.effectiveFrom ? version : best),
      null,
    );
  const inForce = versions.filter((version) => version.effectiveFrom <= date);
  return (
    latest(inForce.filter((version) => version.projectId === projectId)) ??
    latest(inForce.filter((version) => version.projectId === null))
  );
}

/** A public holiday takes precedence over a rest day (a holiday on a Sunday is paid as a holiday). */
export function dayTypeOf(
  date: string,
  restDays: readonly IsoWeekday[],
  holidays: ReadonlySet<string>,
): DayType {
  if (holidays.has(date)) return "public_holiday";
  return restDays.includes(isoWeekday(date)) ? "rest_day" : "weekday";
}

const MULTIPLIER = /^\d{1,2}\.\d{2}$/;

export const RULE_ISSUES = [
  "out_of_range",
  "half_day_above_normal",
  "max_below_normal",
  "rest_days_invalid",
  "multiplier_invalid",
] as const;
export type RuleIssue = (typeof RULE_ISSUES)[number];

/** Consistency checks on a rule version (also enforced by database CHECK constraints). */
export function ruleIssues(rule: TimesheetRuleValues): RuleIssue[] {
  const issues = new Set<RuleIssue>();
  const inRange = (value: number, limits: { min: number; max: number }) =>
    Number.isInteger(value) && value >= limits.min && value <= limits.max;
  for (const key of [
    "normalMinutes",
    "defaultBreakMinutes",
    "breakAfterMinutes",
    "dayStartMinutes",
    "lateGraceMinutes",
    "halfDayThresholdMinutes",
    "maxPlausibleMinutes",
  ] as const)
    if (!inRange(rule[key], TIMESHEET_RULE_LIMITS[key])) issues.add("out_of_range");
  if (rule.halfDayThresholdMinutes > rule.normalMinutes) issues.add("half_day_above_normal");
  if (rule.maxPlausibleMinutes < rule.normalMinutes) issues.add("max_below_normal");
  if (
    rule.restDays.length > 6 ||
    new Set(rule.restDays).size !== rule.restDays.length ||
    rule.restDays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
  )
    issues.add("rest_days_invalid");
  const [low, high] = [
    multiplierHundredths(TIMESHEET_RULE_LIMITS.multiplier.min),
    multiplierHundredths(TIMESHEET_RULE_LIMITS.multiplier.max),
  ];
  for (const multiplier of [
    rule.otWeekdayMultiplier,
    rule.otRestDayMultiplier,
    rule.otHolidayMultiplier,
  ]) {
    const value = multiplierHundredths(multiplier);
    if (value === null || value < low! || value > high!) issues.add("multiplier_invalid");
  }
  return [...issues];
}

/** "1.50" → 150 (integer hundredths); null when not a decimal with exactly two places. */
export function multiplierHundredths(multiplier: string): number | null {
  return MULTIPLIER.test(multiplier) ? Number.parseInt(multiplier.replace(".", ""), 10) : null;
}

/** One labourer's entry on one site and date, as typed on the muster roll. */
export type AttendanceEntry = {
  status: AttendanceStatus;
  /** Minutes after midnight. */
  checkIn: number | null;
  checkOut: number | null;
  /** The shift ends the next morning (for example a night watchman); the date is the start day. */
  overnight: boolean;
  /** Unpaid break minutes; null applies the rule's default break. */
  breakMinutes: number | null;
};

export const ENTRY_ISSUES = [
  "times_required",
  "times_not_allowed",
  "time_out_of_range",
  "check_out_not_after_check_in",
  "overnight_too_long",
  "break_too_long",
] as const;
export type EntryIssue = (typeof ENTRY_ISSUES)[number];

/** Minutes between check-in and check-out (overnight shifts end the next day); null without times. */
export function shiftSpan(entry: Pick<AttendanceEntry, "checkIn" | "checkOut" | "overnight">) {
  if (entry.checkIn === null || entry.checkOut === null) return null;
  return entry.checkOut + (entry.overnight ? MINUTES_PER_DAY : 0) - entry.checkIn;
}

/**
 * Explicit refusals at entry (never silently fixed): worked statuses need both times, other
 * statuses carry none; a check-out at or before the check-in is refused unless the shift is marked
 * overnight, and an overnight shift cannot reach 24 hours; a break must be shorter than the shift.
 */
export function entryIssues(entry: AttendanceEntry): EntryIssue[] {
  const issues: EntryIssue[] = [];
  const timed = entry.checkIn !== null || entry.checkOut !== null;
  if (!isWorkedStatus(entry.status)) {
    if (timed || entry.overnight || entry.breakMinutes !== null) issues.push("times_not_allowed");
    return issues;
  }
  if (entry.checkIn === null || entry.checkOut === null) return ["times_required"];
  for (const value of [entry.checkIn, entry.checkOut])
    if (!Number.isInteger(value) || value < 0 || value >= MINUTES_PER_DAY) {
      issues.push("time_out_of_range");
      return issues;
    }
  if (!entry.overnight && entry.checkOut <= entry.checkIn)
    issues.push("check_out_not_after_check_in");
  if (entry.overnight && entry.checkOut >= entry.checkIn) issues.push("overnight_too_long");
  const span = shiftSpan(entry)!;
  if (
    entry.breakMinutes !== null &&
    (!Number.isInteger(entry.breakMinutes) || entry.breakMinutes < 0 || entry.breakMinutes >= span)
  )
    issues.push("break_too_long");
  return issues;
}
