import type { EtcBasis } from "@pm-buddy/types";
import { isoWeekday } from "../attendance/time.js";
import { addCalendarDays, calendarDaysBetween } from "../labour.js";
import { isWorkingDay, type WorkingCalendar } from "../schedule/calendar.js";
import { divideHalfUp, percentText, ratioText, safeMinor } from "./arithmetic.js";

/**
 * Earned value management and cost to complete (D6.3, brief §5.2 and §15 G). Amounts are KES
 * minor units net of VAT. Definitions (ARCHITECTURE §4.10):
 * - BAC: the value of the measurable items of the BQ in force (contract rates);
 * - PV: BAC spread over the current schedule baseline (see `PlannedValue`);
 * - EV: approved measured value of work done (quantity × rate on the BQ in force);
 * - AC: accrued cost in the D5.4 cost ledger, by the date it happened.
 * EV and PV are at contract (selling) rates and AC is cost, so CPI includes the margin: CPI 1.00
 * means break-even and EAC = BAC ÷ CPI is the forecast COST at completion, VAC = BAC − EAC the
 * forecast margin. A ratio with a zero or negative base is unavailable (null), never 0 or ∞.
 */

export type EarnedValueFigures = {
  bacMinor: number;
  pvMinor: number | null;
  evMinor: number;
  acMinor: number;
  /** EV − AC. */
  cvMinor: number;
  /** EV − PV; null without a baseline. */
  svMinor: number | null;
  /** EV ÷ AC (two decimals, half up); null when AC ≤ 0. */
  cpi: string | null;
  /** EV ÷ PV; null without a baseline or when PV ≤ 0. */
  spi: string | null;
  /** BAC × AC ÷ EV (= BAC ÷ CPI); null when CPI is unavailable or zero. */
  eacMinor: number | null;
  /** EAC − AC. */
  etcMinor: number | null;
  /** BAC − EAC. */
  vacMinor: number | null;
  /** EV ÷ BAC, truncated to one decimal; null when BAC ≤ 0. */
  percentComplete: string | null;
  /** PV ÷ BAC; null without a baseline or BAC. */
  percentPlanned: string | null;
};

export function earnedValueFigures(input: {
  bacMinor: number;
  pvMinor: number | null;
  evMinor: number;
  acMinor: number;
}): EarnedValueFigures {
  const bac = BigInt(input.bacMinor);
  const ev = BigInt(input.evMinor);
  const ac = BigInt(input.acMinor);
  const pv = input.pvMinor === null ? null : BigInt(input.pvMinor);
  const eac = ac > 0n && ev > 0n ? divideHalfUp(bac * ac, ev) : null;
  return {
    bacMinor: input.bacMinor,
    pvMinor: input.pvMinor,
    evMinor: input.evMinor,
    acMinor: input.acMinor,
    cvMinor: safeMinor(ev - ac),
    svMinor: pv === null ? null : safeMinor(ev - pv),
    cpi: ratioText(ev, ac),
    spi: pv === null ? null : ratioText(ev, pv),
    eacMinor: eac === null ? null : safeMinor(eac),
    etcMinor: eac === null ? null : safeMinor(eac - ac),
    vacMinor: eac === null ? null : safeMinor(bac - eac),
    percentComplete: percentText(ev, bac),
    percentPlanned: pv === null ? null : percentText(pv, bac),
  };
}

/** Working days per calendar day over a fixed range, answered in O(1) (prefix sums). */
export class WorkingDayCounter {
  private readonly prefix: number[];

  constructor(
    private readonly calendar: WorkingCalendar,
    private readonly from: string,
    private readonly to: string,
  ) {
    const days = Math.max(0, calendarDaysBetween(from, to) + 1);
    this.prefix = [0];
    for (let offset = 0; offset < days; offset += 1)
      this.prefix.push(
        this.prefix[offset]! + (isWorkingDay(calendar, addCalendarDays(from, offset)) ? 1 : 0),
      );
  }

  /** Working days in the inclusive range `start`–`end`, clamped to the counter's range. */
  count(start: string, end: string): number {
    const first = start < this.from ? this.from : start;
    const last = end > this.to ? this.to : end;
    if (last < first) return 0;
    const a = calendarDaysBetween(this.from, first);
    const b = calendarDaysBetween(this.from, last);
    return this.prefix[b + 1]! - this.prefix[a]!;
  }
}

export type PlannedWindow = { start: string; finish: string };
export type PlannedItem = { amountMinor: number; windows: readonly PlannedWindow[] };

/**
 * Planned value from the schedule baseline (the weighting, ARCHITECTURE §4.10; COMPLIANCE-REVIEW
 * CR-VAL-05): each measurable BQ item's value is spread evenly over the WORKING days of the
 * baseline tasks linked to it (a schedule activity names the item), in proportion to their
 * working days; an item linked to no task is spread over the whole baseline (its start to its
 * finish). A window without a working day (a milestone) is a step at its finish. PV on a date
 * is the sum over items of round(amount × working days elapsed ÷ working days planned), so the
 * curve reaches BAC exactly at the last planned day.
 */
export class PlannedValue {
  private readonly counter: WorkingDayCounter;
  private readonly prepared: { amount: bigint; windows: PlannedWindow[]; total: number }[];

  constructor(
    calendar: WorkingCalendar,
    readonly span: PlannedWindow,
    items: readonly PlannedItem[],
  ) {
    let from = span.start;
    let to = span.finish;
    for (const item of items)
      for (const window of item.windows) {
        if (window.start < from) from = window.start;
        if (window.finish > to) to = window.finish;
      }
    this.counter = new WorkingDayCounter(calendar, from, to);
    this.prepared = items.map((item) => {
      const windows = item.windows.length ? [...item.windows] : [span];
      const total = windows.reduce(
        (sum, window) => sum + this.counter.count(window.start, window.finish),
        0,
      );
      return { amount: BigInt(item.amountMinor), windows, total };
    });
  }

  /** Cumulative planned value at the end of `date`. */
  at(date: string): number {
    let total = 0n;
    for (const item of this.prepared) {
      if (item.total === 0) {
        const finish = item.windows.reduce(
          (latest, window) => (window.finish > latest ? window.finish : latest),
          item.windows[0]!.finish,
        );
        if (date >= finish) total += item.amount;
        continue;
      }
      const elapsed = item.windows.reduce(
        (sum, window) =>
          date < window.start
            ? sum
            : sum + this.counter.count(window.start, date < window.finish ? date : window.finish),
        0,
      );
      total += divideHalfUp(item.amount * BigInt(elapsed), BigInt(item.total));
    }
    return safeMinor(total);
  }
}

/** The Sunday on or after `date` (weeks run Monday to Sunday, Nairobi business dates). */
export function weekEndOf(date: string): string {
  return addCalendarDays(date, 7 - isoWeekday(date));
}

/**
 * Week ends (Sundays) from the week of `from` to the week of `to`, at most `max` of them (the
 * latest ones, so a long project still shows the data date).
 */
export function weekEnds(from: string, to: string, max: number): string[] {
  if (to < from) return [];
  const first = weekEndOf(from);
  const last = weekEndOf(to);
  const count = Math.floor(calendarDaysBetween(first, last) / 7) + 1;
  const skip = Math.max(0, count - max);
  return Array.from({ length: count - skip }, (_, index) =>
    addCalendarDays(first, (index + skip) * 7),
  );
}

/** A dated value of a step series (an item's approved value from its measurement date). */
export type DatedValue = { date: string; valueMinor: number };

/**
 * Cumulative series evaluated on dates: `steps` are values that REPLACE the previous one from their
 * date (an item's value to date); `amounts` ADD on their date (costs). Inputs need not be sorted.
 */
export function stepValueAt(steps: readonly DatedValue[], date: string): number {
  let best: DatedValue | null = null;
  for (const step of steps)
    if (step.date <= date && (best === null || step.date >= best.date)) best = step;
  return best?.valueMinor ?? 0;
}

export function runningTotal(amounts: readonly DatedValue[]): (date: string) => number {
  const sorted = [...amounts].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const dates = sorted.map((entry) => entry.date);
  const totals: bigint[] = [];
  let running = 0n;
  for (const entry of sorted) {
    running += BigInt(entry.valueMinor);
    totals.push(running);
  }
  return (date: string) => {
    let low = 0;
    let high = dates.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (dates[middle]! <= date) low = middle + 1;
      else high = middle;
    }
    return low === 0 ? 0 : safeMinor(totals[low - 1]!);
  };
}

export type CurvePoint = {
  weekEnd: string;
  pvMinor: number | null;
  /** Earned and actual values stop at the data date (null for weeks after it). */
  evMinor: number | null;
  acMinor: number | null;
};

/** The weekly S-curve: planned, earned and actual cumulative values at each week end. */
export function sCurve(input: {
  weekEnds: readonly string[];
  dataDate: string;
  pv: ((date: string) => number) | null;
  ev: (date: string) => number;
  ac: (date: string) => number;
}): CurvePoint[] {
  return input.weekEnds.map((weekEnd) => {
    const weekStart = addCalendarDays(weekEnd, -6);
    const past = weekStart <= input.dataDate;
    const at = weekEnd < input.dataDate ? weekEnd : input.dataDate;
    return {
      weekEnd,
      pvMinor: input.pv ? input.pv(weekEnd) : null,
      evMinor: past ? input.ev(at) : null,
      acMinor: past ? input.ac(at) : null,
    };
  });
}

export type CostToComplete = {
  /** Budget × EV ÷ contract value: the budgeted cost of the work done; null without a budget. */
  earnedBudgetMinor: number | null;
  /** Earned budget ÷ actual (cost performance at cost); null when unavailable. */
  cpi: string | null;
  /** Estimate to complete; null without a budget. */
  etcMinor: number | null;
  /** Actual + ETC. */
  eacMinor: number | null;
  /** Budget − EAC (negative: forecast overrun). */
  vacMinor: number | null;
  basis: EtcBasis;
};

/**
 * Cost to complete of a BQ item or bill (brief §5.2 "budget vs actual and cost-to-complete"):
 * the fraction done is EV ÷ contract value; the earned budget is that fraction of the budget; the
 * remaining budget (never below zero) is re-estimated at the item's cost performance
 * (ETC = remaining × actual ÷ earned budget, basis `cpi`) once both are positive, otherwise taken
 * at budget (basis `budget`). Without a budget everything is unavailable.
 */
export function costToComplete(input: {
  contractMinor: number;
  evMinor: number;
  budgetMinor: number | null;
  actualMinor: number;
}): CostToComplete {
  if (input.budgetMinor === null)
    return {
      earnedBudgetMinor: null,
      cpi: null,
      etcMinor: null,
      eacMinor: null,
      vacMinor: null,
      basis: "unavailable",
    };
  const budget = BigInt(input.budgetMinor);
  const actual = BigInt(input.actualMinor);
  const earned =
    input.contractMinor > 0
      ? divideHalfUp(budget * BigInt(input.evMinor), BigInt(input.contractMinor))
      : 0n;
  const remaining = budget - earned > 0n ? budget - earned : 0n;
  const useCpi = actual > 0n && earned > 0n;
  const etc = useCpi ? divideHalfUp(remaining * actual, earned) : remaining;
  const eac = actual + etc;
  return {
    earnedBudgetMinor: safeMinor(earned),
    cpi: ratioText(earned, actual),
    etcMinor: safeMinor(etc),
    eacMinor: safeMinor(eac),
    vacMinor: safeMinor(budget - eac),
    basis: useCpi ? "cpi" : "budget",
  };
}
