import {
  type AttendanceDayStatus,
  type IsoWeekday,
  type PeriodSettings,
  type TimesheetPeriodStatus,
} from "@pm-buddy/types";
import { addCalendarDays } from "../labour.js";
import { isoWeekday, zonedDateTime } from "./time.js";

/**
 * Timesheet periods (QUESTIONS Q-C4): weekly by default, ending on `weekEndsOn` (Thursday) with a
 * cut-off at `cutoffMinutes` (18:00) Africa/Nairobi on that day. A period can be submitted only
 * after its cut-off; once approved it is locked and corrections become adjustments in a later
 * period (INVARIANTS: closed periods are stable).
 */
export type PeriodWindow = { startDate: string; endDate: string; cutoffAt: Date };

export function weeklyPeriodFor(
  date: string,
  settings: Pick<PeriodSettings, "weekEndsOn" | "cutoffMinutes">,
): PeriodWindow {
  const daysToEnd = (settings.weekEndsOn - isoWeekday(date) + 7) % 7;
  const endDate = addCalendarDays(date, daysToEnd);
  return {
    startDate: addCalendarDays(endDate, -6),
    endDate,
    cutoffAt: zonedDateTime(endDate, settings.cutoffMinutes),
  };
}

/** A period is due for submission once its cut-off has passed. */
export const isPeriodDue = (cutoffAt: Date, now: Date = new Date()) =>
  now.getTime() >= cutoffAt.getTime();

/** Attendance in a period can be recorded or changed only while the period is open or rejected. */
export const isPeriodEditable = (status: TimesheetPeriodStatus) =>
  status === "open" || status === "rejected";

export type DayAction = "submit" | "confirm" | "return";
export const DAY_TRANSITIONS: Readonly<
  Record<DayAction, { from: readonly AttendanceDayStatus[]; to: AttendanceDayStatus }>
> = {
  submit: { from: ["draft"], to: "submitted" },
  confirm: { from: ["submitted"], to: "confirmed" },
  return: { from: ["submitted"], to: "draft" },
};

export type PeriodAction = "submit" | "approve" | "reject" | "reopen";
export const PERIOD_TRANSITIONS: Readonly<
  Record<PeriodAction, { from: readonly TimesheetPeriodStatus[]; to: TimesheetPeriodStatus }>
> = {
  submit: { from: ["open"], to: "submitted" },
  approve: { from: ["submitted"], to: "approved" },
  reject: { from: ["submitted"], to: "rejected" },
  reopen: { from: ["rejected"], to: "open" },
};

export function dayTransition(from: AttendanceDayStatus, action: DayAction) {
  const transition = DAY_TRANSITIONS[action];
  return transition.from.includes(from) ? transition.to : null;
}

export function periodTransition(from: TimesheetPeriodStatus, action: PeriodAction) {
  const transition = PERIOD_TRANSITIONS[action];
  return transition.from.includes(from) ? transition.to : null;
}

/** Weekday names are rendered by the UI; this only checks the setting. */
export const isIsoWeekday = (value: number): value is IsoWeekday =>
  Number.isInteger(value) && value >= 1 && value <= 7;
