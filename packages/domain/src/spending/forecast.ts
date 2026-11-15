import type { ForecastBasis, ForecastLineKind } from "@pm-buddy/types";
import { isoWeekday } from "../attendance/time.js";
import { addCalendarDays } from "../labour.js";
import { payPeriodsBetween, type PayCalendar } from "../payroll/periods.js";

/**
 * Weekly cash-flow forecast (D5.4, brief §5.8). Weeks run Monday to Sunday on Africa/Nairobi
 * business dates. Items dated before the current week are overdue: they are shown in the first
 * week (flagged), because unpaid money is still to be paid. Items after the last week are summed
 * as "later". Amounts are integer KES minor units.
 */

export type ForecastItem = {
  kind: ForecastLineKind;
  direction: "in" | "out";
  /** The expected date (business date). */
  date: string;
  amountMinor: number;
  basis: ForecastBasis;
};

export type ForecastWeek = {
  start: string;
  end: string;
  inMinor: number;
  outMinor: number;
  netMinor: number;
  /** Opening + every net up to and including this week; null when there is no opening. */
  closingMinor: number | null;
  byKind: Partial<Record<ForecastLineKind, number>>;
  estimatedMinor: number;
  overdueMinor: number;
};

export type Forecast = {
  weeks: ForecastWeek[];
  openingMinor: number | null;
  later: { inMinor: number; outMinor: number };
};

/** The Monday on or before `date`. */
export function weekStartOf(date: string): string {
  return addCalendarDays(date, 1 - isoWeekday(date));
}

/**
 * Buckets items into `count` weeks from the week of `today`. Overdue items (before the first
 * week) fall into the first week; items after the last week go to `later`.
 */
export function bucketForecast(
  items: readonly ForecastItem[],
  today: string,
  count: number,
  openingMinor: number | null,
): Forecast {
  const first = weekStartOf(today);
  const weeks: ForecastWeek[] = Array.from({ length: count }, (_, index) => {
    const start = addCalendarDays(first, index * 7);
    return {
      start,
      end: addCalendarDays(start, 6),
      inMinor: 0,
      outMinor: 0,
      netMinor: 0,
      closingMinor: null,
      byKind: {},
      estimatedMinor: 0,
      overdueMinor: 0,
    };
  });
  const later = { inMinor: 0, outMinor: 0 };
  const lastEnd = weeks.at(-1)?.end ?? addCalendarDays(first, -1);
  for (const item of items) {
    if (item.amountMinor <= 0) continue;
    if (item.date > lastEnd) {
      if (item.direction === "in") later.inMinor += item.amountMinor;
      else later.outMinor += item.amountMinor;
      continue;
    }
    const overdue = item.date < first;
    const index = overdue
      ? 0
      : Math.floor(
          (Date.parse(`${weekStartOf(item.date)}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) /
            (7 * 86_400_000),
        );
    const week = weeks[index];
    if (!week) continue;
    if (item.direction === "in") week.inMinor += item.amountMinor;
    else week.outMinor += item.amountMinor;
    const signed = item.direction === "in" ? item.amountMinor : -item.amountMinor;
    week.byKind[item.kind] = (week.byKind[item.kind] ?? 0) + signed;
    if (item.basis === "estimated") week.estimatedMinor += item.amountMinor;
    if (overdue) week.overdueMinor += item.amountMinor;
  }
  let running = openingMinor;
  for (const week of weeks) {
    week.netMinor = week.inMinor - week.outMinor;
    if (running !== null) {
      running += week.netMinor;
      week.closingMinor = running;
    }
  }
  return { weeks, openingMinor, later };
}

/**
 * The date a supplier is expected to be paid for an approved LPO not yet invoiced: its delivery
 * date (else the approval date) plus its credit days. An assumption, labelled as an estimate.
 */
export function expectedLpoPaymentDate(input: {
  deliveryDate: string | null;
  approvedOn: string;
  creditDays: number;
}): string {
  return addCalendarDays(input.deliveryDate ?? input.approvedOn, Math.max(0, input.creditDays));
}

export type PayrollBatchFact = {
  periodStart: string;
  payDate: string;
  /** Gross pay plus the employer's statutory cost: what the payroll needs in cash. */
  amountMinor: number;
  status: "draft" | "submitted";
};

/**
 * Payroll outflows from today to `until`: each live batch (draft or submitted) on its pay date
 * (submitted = recorded, draft = estimated), and every later pay period of the project's calendar
 * that has no batch yet at the run rate of the latest submitted batch (estimated). Batches whose pay
 * date has passed are left out: D4.3 records payouts, and until then a past pay date is assumed
 * paid outside PM-Buddy.
 */
export function projectPayroll(input: {
  calendar: PayCalendar;
  today: string;
  until: string;
  batches: readonly PayrollBatchFact[];
  runRateMinor: number | null;
}): ForecastItem[] {
  const items: ForecastItem[] = [];
  const covered = new Set(input.batches.map((batch) => batch.periodStart));
  for (const batch of input.batches)
    if (batch.payDate >= input.today && batch.payDate <= input.until)
      items.push({
        kind: "payroll",
        direction: "out",
        date: batch.payDate,
        amountMinor: batch.amountMinor,
        basis: batch.status === "submitted" ? "recorded" : "estimated",
      });
  if (input.runRateMinor && input.runRateMinor > 0)
    for (const period of payPeriodsBetween(input.today, input.until, input.calendar, 200))
      if (
        !covered.has(period.startDate) &&
        period.payDate >= input.today &&
        period.payDate <= input.until
      )
        items.push({
          kind: "payroll",
          direction: "out",
          date: period.payDate,
          amountMinor: input.runRateMinor,
          basis: "estimated",
        });
  return items;
}
