import type { IsoWeekday, PayFrequency } from "@pm-buddy/types";
import { isoWeekday, dateParts } from "../attendance/time.js";
import { addCalendarDays, calendarDaysBetween } from "../labour.js";

/**
 * Pay calendars (brief §5.6, QUESTIONS Q-C4). A project pays daily, weekly, fortnightly or monthly.
 * Weekly and fortnightly periods repeat from an anchor date (the first day of some period); daily
 * periods are single days; monthly periods are calendar months. The pay date is the period's last
 * day plus `paydayOffsetDays` (a Thursday cut-off paid on Friday is 1). Statutory rules are monthly:
 * a batch belongs to the calendar month of its pay date (`statutoryMonthOf`).
 */
export type PayCalendar = {
  frequency: PayFrequency;
  /** The first day of one period (weekly and fortnightly); ignored by daily and monthly. */
  anchorDate: string;
  paydayOffsetDays: number;
};

export type PayPeriod = { startDate: string; endDate: string; payDate: string };

/** The earliest anchor used for defaults: periods repeat both ways, so any matching date works. */
const DEFAULT_ANCHOR_SEARCH_FROM = "2024-01-01";

/**
 * The default calendar follows the company's timesheet periods (D3.3): weekly, starting the day
 * after `weekEndsOn` (Friday after a Thursday end) and paid on `paydayWeekday` (Friday).
 */
export function defaultPayCalendar(settings: {
  weekEndsOn: IsoWeekday;
  paydayWeekday: IsoWeekday;
}): PayCalendar {
  const startWeekday = (settings.weekEndsOn % 7) + 1;
  let anchor = DEFAULT_ANCHOR_SEARCH_FROM;
  while (isoWeekday(anchor) !== startWeekday) anchor = addCalendarDays(anchor, 1);
  return {
    frequency: "weekly",
    anchorDate: anchor,
    paydayOffsetDays: (settings.paydayWeekday - settings.weekEndsOn + 7) % 7,
  };
}

const lengthOf = (frequency: "weekly" | "fortnightly") => (frequency === "weekly" ? 7 : 14);

/** First and last day of the calendar month of `date`. */
export function monthBounds(date: string): { startDate: string; endDate: string } {
  const [y, m] = dateParts(date);
  const start = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { startDate: start, endDate: `${start.slice(0, 8)}${String(last).padStart(2, "0")}` };
}

/** The pay period containing `date`. */
export function payPeriodFor(date: string, calendar: PayCalendar): PayPeriod {
  let startDate: string;
  let endDate: string;
  switch (calendar.frequency) {
    case "daily":
      startDate = date;
      endDate = date;
      break;
    case "monthly":
      ({ startDate, endDate } = monthBounds(date));
      break;
    default: {
      const length = lengthOf(calendar.frequency);
      const offset = calendarDaysBetween(calendar.anchorDate, date);
      startDate = addCalendarDays(calendar.anchorDate, Math.floor(offset / length) * length);
      endDate = addCalendarDays(startDate, length - 1);
    }
  }
  return { startDate, endDate, payDate: addCalendarDays(endDate, calendar.paydayOffsetDays) };
}

/** Whether `date` is the first day of a period of this calendar. */
export const isPeriodStart = (date: string, calendar: PayCalendar) =>
  payPeriodFor(date, calendar).startDate === date;

/** Periods overlapping [from, to], oldest first (at most `limit`). */
export function payPeriodsBetween(
  from: string,
  to: string,
  calendar: PayCalendar,
  limit = 60,
): PayPeriod[] {
  const periods: PayPeriod[] = [];
  let cursor = payPeriodFor(from, calendar);
  while (cursor.startDate <= to && periods.length < limit) {
    periods.push(cursor);
    cursor = payPeriodFor(addCalendarDays(cursor.endDate, 1), calendar);
  }
  return periods;
}

/** The statutory month ("YYYY-MM") a pay date belongs to (COMPLIANCE-REVIEW CR-PAY-01). */
export const statutoryMonthOf = (payDate: string) => payDate.slice(0, 7);

/** Validates a calendar; returns issue codes (empty when valid). */
export function payCalendarIssues(calendar: PayCalendar): string[] {
  const issues: string[] = [];
  if (
    !Number.isInteger(calendar.paydayOffsetDays) ||
    calendar.paydayOffsetDays < 0 ||
    calendar.paydayOffsetDays > 14
  )
    issues.push("payday-offset");
  try {
    dateParts(calendar.anchorDate);
  } catch {
    issues.push("anchor-date");
  }
  return issues;
}
