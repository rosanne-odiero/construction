import type { IsoWeekday, ReportFrequency } from "@pm-buddy/types";
import { dateParts, isoWeekday, zonedDateTime } from "../attendance/time.js";
import { addCalendarDays } from "../labour.js";
import { nairobiDate } from "../project-lifecycle.js";

/**
 * Report subscription schedules (D-126): weekly on an ISO weekday or monthly on a day of the month,
 * sent at a fixed hour in Africa/Nairobi. A monthly day after the end of a shorter month runs on
 * its last day (31 → 30 April, 28 or 29 February).
 */
export type ReportSchedule =
  { frequency: "weekly"; weekday: IsoWeekday } | { frequency: "monthly"; dayOfMonth: number };

const pad = (value: number) => String(value).padStart(2, "0");

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The date a monthly subscription runs in a month (clamped to the month's last day). */
export function monthlyRunDate(year: number, month: number, dayOfMonth: number): string {
  const day = Math.min(dayOfMonth, daysInMonth(year, month));
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** The first send time strictly after `after`: `hour`:00 Nairobi time on the next matching date. */
export function nextReportRun(schedule: ReportSchedule, after: Date, hour: number): Date {
  const today = nairobiDate(after);
  const at = (date: string) => zonedDateTime(date, hour * 60);
  if (schedule.frequency === "weekly") {
    for (let offset = 0; offset <= 7; offset += 1) {
      const date = addCalendarDays(today, offset);
      if (isoWeekday(date) !== schedule.weekday) continue;
      const instant = at(date);
      if (instant.getTime() > after.getTime()) return instant;
    }
    throw new Error("unreachable: a weekday recurs within eight days");
  }
  const [year, month] = dateParts(today);
  for (let step = 0; step <= 1; step += 1) {
    const y = year + Math.floor((month - 1 + step) / 12);
    const m = ((month - 1 + step) % 12) + 1;
    const instant = at(monthlyRunDate(y, m, schedule.dayOfMonth));
    if (instant.getTime() > after.getTime()) return instant;
  }
  throw new Error("unreachable: the next month always follows");
}

/**
 * The period a scheduled run reports on (range reports): weekly → the last whole Monday–Sunday
 * week before the run date; monthly → the previous calendar month.
 */
export function scheduledPeriod(
  frequency: ReportFrequency,
  runDate: string,
): { from: string; to: string } {
  if (frequency === "weekly") {
    const to = addCalendarDays(runDate, -isoWeekday(runDate));
    return { from: addCalendarDays(to, -6), to };
  }
  const [year, month] = dateParts(runDate);
  const y = month === 1 ? year - 1 : year;
  const m = month === 1 ? 12 : month - 1;
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(daysInMonth(y, m))}` };
}
