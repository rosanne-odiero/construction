import type { ReportDefinition } from "@pm-buddy/types";
import { addCalendarDays, calendarDaysBetween } from "../labour.js";
import { dateParts } from "../attendance/time.js";

export type ReportPeriod = { from: string; to: string; days: number };
export type PeriodProblem = "period-required" | "period-invalid" | "period-too-long";

const isDate = (value: string) => {
  try {
    const [y, m, d] = dateParts(value);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  } catch {
    return false;
  }
};

/**
 * The period a range report covers, both ends included, on Nairobi business dates. Without dates
 * it is the report's default (that many days ending today); with one date the other is required;
 * the end may not be after today and the span may not exceed the report's maximum (inclusive:
 * 1 January to 31 December 2028 is 366 days, a leap year).
 */
export function reportPeriod(
  definition: Pick<ReportDefinition, "maxPeriodDays" | "defaultPeriodDays">,
  input: { from?: string | undefined; to?: string | undefined },
  today: string,
): { ok: true; period: ReportPeriod } | { ok: false; problem: PeriodProblem } {
  if (!input.from && !input.to) {
    const days = Math.max(1, definition.defaultPeriodDays);
    return {
      ok: true,
      period: { from: addCalendarDays(today, 1 - days), to: today, days },
    };
  }
  if (!input.from || !input.to) return { ok: false, problem: "period-required" };
  if (!isDate(input.from) || !isDate(input.to)) return { ok: false, problem: "period-invalid" };
  if (input.from > input.to || input.to > today) return { ok: false, problem: "period-invalid" };
  const days = calendarDaysBetween(input.from, input.to) + 1;
  if (days > definition.maxPeriodDays) return { ok: false, problem: "period-too-long" };
  return { ok: true, period: { from: input.from, to: input.to, days } };
}

/** Every calendar date from `from` to `to`, both included (a muster roll's day columns). */
export function datesBetween(from: string, to: string): string[] {
  const days = calendarDaysBetween(from, to);
  const dates: string[] = [];
  for (let offset = 0; offset <= days; offset += 1) dates.push(addCalendarDays(from, offset));
  return dates;
}
