import type { CompletionKind } from "@pm-buddy/types";
import { calendarDaysBetween } from "../labour.js";

/**
 * Practical completion and the defects liability period (D6.1, brief §5.9). Dates are business
 * dates (Africa/Nairobi, YYYY-MM-DD).
 */

const parts = (date: string) => date.split("-").map(Number) as [number, number, number];
const pad = (value: number) => String(value).padStart(2, "0");

/**
 * `date` plus whole calendar months, clamped to the end of a shorter month (31/08/2026 + 6 months
 * = 28/02/2027). Identical to PostgreSQL's `date + make_interval(months => n)`, which the database
 * uses to check a certificate's DLP end date.
 */
export function addCalendarMonths(date: string, months: number): string {
  const [year, month, day] = parts(date);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, lastDay))}`;
}

/**
 * The defects liability period runs from the practical completion date for `months` calendar
 * months and ends on the same day of the month (clamped); defects reported up to and including
 * that day are DLP defects.
 */
export const dlpEndDate = (practicalCompletionDate: string, months: number): string =>
  addCalendarMonths(practicalCompletionDate, months);

export type DlpState = { state: "running" | "ended"; daysRemaining: number };

/** Whether the DLP is still running on `today`, and the calendar days left (0 on its last day). */
export function dlpState(today: string, endsOn: string): DlpState {
  const daysRemaining = calendarDaysBetween(today, endsOn);
  return daysRemaining >= 0
    ? { state: "running", daysRemaining }
    : { state: "ended", daysRemaining: 0 };
}

export type CompletionBlocker =
  | "open_critical_snags"
  | "open_snags"
  | "practical_not_certified"
  | "dlp_not_ended"
  | "date_future";

/**
 * What stops a completion certificate being proposed or certified:
 * - practical: open critical snags, unless an exception reason is recorded;
 * - final: a certified practical completion, a date on or after the DLP end, and no open snags
 *   of any severity, unless an exception reason is recorded;
 * - either: a completion date after today.
 */
export function completionBlockers(input: {
  kind: CompletionKind;
  completionDate: string;
  today: string;
  openCriticalSnags: number;
  openSnags: number;
  exceptionReason: string | null;
  practical: { dlpEndsOn: string } | null;
}): CompletionBlocker[] {
  const blockers: CompletionBlocker[] = [];
  const excepted = (input.exceptionReason?.trim().length ?? 0) >= 3;
  if (input.completionDate > input.today) blockers.push("date_future");
  if (input.kind === "practical") {
    if (input.openCriticalSnags > 0 && !excepted) blockers.push("open_critical_snags");
    return blockers;
  }
  if (!input.practical) blockers.push("practical_not_certified");
  else if (input.completionDate < input.practical.dlpEndsOn) blockers.push("dlp_not_ended");
  if (input.openSnags > 0 && !excepted) blockers.push("open_snags");
  return blockers;
}
