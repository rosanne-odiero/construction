import type { HireRateUnit, ServiceState } from "@pm-buddy/types";
import { addCalendarDays, calendarDaysBetween } from "../labour.js";
import { roundRatio } from "./quantities.js";

/**
 * Maintenance and hire (decisions D-96, D-97): when a service is due from the meter and the
 * calendar, the estimated hire charge accrued so far, and how long hired plant has stood idle.
 * All dates are Nairobi business dates (YYYY-MM-DD); money is KES minor units.
 */

export type ServiceInput = {
  /** Service every N tenths of an hour or km on the meter (null: no meter interval). */
  everyTenths: number | null;
  /** Service every N days (null: no calendar interval). */
  everyDays: number | null;
  /** Meter advance since the last service (or the opening reading), across resets. */
  runSinceTenths: number | null;
  /** The last service's date (or the opening date when never serviced). */
  lastOn: string;
  today: string;
  /** Due within the last N % of the interval (company setting, default 10). */
  dueSoonPercent: number;
};

export type ServiceStatus = {
  state: ServiceState;
  /** Hours or km left on the meter interval (negative when overdue); null without one. */
  remainingTenths: number | null;
  /** The calendar due date; null without a calendar interval. */
  dueOn: string | null;
};

const SEVERITY: Record<ServiceState, number> = { not_scheduled: 0, ok: 1, due: 2, overdue: 3 };
const worse = (a: ServiceState, b: ServiceState) => (SEVERITY[a] >= SEVERITY[b] ? a : b);

/**
 * Overdue once the meter has run more than the interval or the due date has passed; due within
 * the last `dueSoonPercent` of either interval (at the interval itself it is due, not overdue).
 */
export function serviceStatus(input: ServiceInput): ServiceStatus {
  let state: ServiceState = "not_scheduled";
  let remainingTenths: number | null = null;
  let dueOn: string | null = null;
  if (input.everyTenths !== null && input.everyTenths > 0) {
    const run = input.runSinceTenths ?? 0;
    remainingTenths = input.everyTenths - run;
    state = worse(
      state,
      run > input.everyTenths
        ? "overdue"
        : run * 100 >= input.everyTenths * (100 - input.dueSoonPercent)
          ? "due"
          : "ok",
    );
  }
  if (input.everyDays !== null && input.everyDays > 0) {
    dueOn = addCalendarDays(input.lastOn, input.everyDays);
    const warnDays = Math.floor((input.everyDays * input.dueSoonPercent) / 100);
    state = worse(
      state,
      input.today > dueOn
        ? "overdue"
        : input.today >= addCalendarDays(dueOn, -warnDays)
          ? "due"
          : "ok",
    );
  }
  return { state, remainingTenths, dueOn };
}

export type HireInput = {
  rateMinor: number;
  unit: HireRateUnit;
  startOn: string;
  /** The last chargeable day: the off-hire date, else today. */
  endOn: string;
  /** Hours on the hour meter within the hire (for hourly rates). */
  hoursTenths: number;
};

/**
 * The estimated hire charge so far (never posted to the cost ledger; the supplier's invoice is the
 * charge, decision D-97): per day × calendar days on hire (start and end inclusive); per month ×
 * days ÷ 30; per hour × metered hours. Rounded half up to the cent.
 */
export function hireCharge(input: HireInput): { days: number; estimateMinor: number } {
  const days =
    input.endOn < input.startOn ? 0 : calendarDaysBetween(input.startOn, input.endOn) + 1;
  const rate = BigInt(input.rateMinor);
  const estimateMinor =
    input.unit === "day"
      ? Number(rate * BigInt(days))
      : input.unit === "month"
        ? roundRatio(rate * BigInt(days), 30n)
        : roundRatio(rate * BigInt(Math.max(0, input.hoursTenths)), 10n);
  return { days, estimateMinor };
}

/**
 * Whole days a hired item has stood without a working day, not counting today (a day's log may
 * come in the evening): the days after its last working day, or since `since` (hire start) when it
 * never worked.
 */
export function idleDays(lastWorkingOn: string | null, since: string, today: string): number {
  const days = lastWorkingOn
    ? calendarDaysBetween(lastWorkingOn, today) - 1
    : calendarDaysBetween(since, today);
  return Math.max(0, days);
}
