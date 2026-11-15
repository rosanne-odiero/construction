import { Decimal } from "decimal.js";
import { SCHEDULE_LIMITS, type ActivityStatus, type ProgressBasis } from "@pm-buddy/types";
import { countWorkingDays, workingDaysBetween, type WorkingCalendar } from "./calendar.js";

/**
 * Activity progress, variance and delay rules (D6.2, brief §15 G). Percentage complete is
 * PHYSICAL progress with a declared basis; it is never earned, certified or invoiced value.
 * Undefined ratios are null ("unavailable"), never 0.
 */

export type ProgressInput = {
  actualStart: string | null;
  actualFinish: string | null;
  basis: ProgressBasis;
  /** Physical basis: a whole percent 0–100 (null = not reported); finer estimates are false precision. */
  percentComplete: number | null;
  /** Quantity basis: exact decimal strings and the unit. */
  quantityDone: string | null;
  quantityTotal: string | null;
  quantityUnit: string | null;
};

export type ProgressProblem =
  | "actual-date-future"
  | "finish-without-start"
  | "finish-before-start"
  | "progress-without-start"
  | "progress-inconsistent"
  | "quantity-invalid";

export type ProgressCheck =
  | {
      ok: true;
      status: ActivityStatus;
      /** The normalised values to store. */
      percentComplete: number | null;
      quantityDone: string | null;
      quantityTotal: string | null;
      quantityUnit: string | null;
    }
  | { ok: false; error: ProgressProblem };

const QUANTITY = /^\d{1,16}(\.\d{1,4})?$/;

/** Percentage of a quantity, rounded down to two decimals (never shows 100 % early). */
export function quantityPercent(done: string, total: string): number {
  const ratio = new Decimal(done).div(total).mul(100);
  return ratio.toDecimalPlaces(2, Decimal.ROUND_DOWN).toNumber();
}

/**
 * Validates actual dates and progress together, given today's business date. Rules: a finish
 * needs a start on or before it, neither may be in the future, nothing is reported before the
 * start, an activity is 100 % only when it has an actual finish (a finish sets it to 100 %).
 */
export function checkActivityProgress(input: ProgressInput, today: string): ProgressCheck {
  const { actualStart, actualFinish } = input;
  if ((actualStart && actualStart > today) || (actualFinish && actualFinish > today))
    return { ok: false, error: "actual-date-future" };
  if (actualFinish && !actualStart) return { ok: false, error: "finish-without-start" };
  if (actualStart && actualFinish && actualFinish < actualStart)
    return { ok: false, error: "finish-before-start" };
  const status: ActivityStatus = actualFinish
    ? "complete"
    : actualStart
      ? "in_progress"
      : "not_started";

  if (input.basis === "physical") {
    const percent = input.percentComplete;
    if (percent !== null && (!Number.isInteger(percent) || percent < 0 || percent > 100))
      return { ok: false, error: "progress-inconsistent" };
    if (status === "not_started" && percent !== null && percent > 0)
      return { ok: false, error: "progress-without-start" };
    if (status === "complete" && percent !== null && percent !== 100)
      return { ok: false, error: "progress-inconsistent" };
    if (status === "in_progress" && percent === 100)
      return { ok: false, error: "progress-inconsistent" };
    return {
      ok: true,
      status,
      percentComplete: status === "complete" ? 100 : status === "not_started" ? null : percent,
      quantityDone: null,
      quantityTotal: null,
      quantityUnit: null,
    };
  }

  const unit = input.quantityUnit?.trim() ?? "";
  const total = input.quantityTotal;
  const done = input.quantityDone ?? "0";
  if (
    !total ||
    !QUANTITY.test(total) ||
    !QUANTITY.test(done) ||
    !unit ||
    Array.from(unit).length > 20
  )
    return { ok: false, error: "quantity-invalid" };
  if (new Decimal(total).lte(0)) return { ok: false, error: "quantity-invalid" };
  const cmp = new Decimal(done).cmp(total);
  if (cmp > 0) return { ok: false, error: "quantity-invalid" };
  if (status === "not_started" && new Decimal(done).gt(0))
    return { ok: false, error: "progress-without-start" };
  if (status === "in_progress" && cmp === 0) return { ok: false, error: "progress-inconsistent" };
  if (status === "complete" && input.quantityDone !== null && cmp !== 0)
    return { ok: false, error: "progress-inconsistent" };
  const storedDone = status === "complete" ? normalise(total) : normalise(done);
  return {
    ok: true,
    status,
    percentComplete: quantityPercent(storedDone, total),
    quantityDone: storedDone,
    quantityTotal: normalise(total),
    quantityUnit: unit,
  };
}

const normalise = (value: string) => new Decimal(value).toFixed();

/**
 * Duration-weighted physical progress of a set of tasks, as a ratio 0–1: Σ(duration × %) ÷
 * Σ duration. Complete tasks count 100 %, unstarted 0 %; null ("unavailable") when there are no
 * tasks or a task in progress has no reported percentage. The weighting (planned working days)
 * is defined up front (brief §15 G).
 */
export function scheduleProgress(
  tasks: readonly {
    durationDays: number;
    status: ActivityStatus;
    percentComplete: number | null;
  }[],
): number | null {
  let weight = 0;
  let done = 0;
  for (const task of tasks) {
    const percent =
      task.status === "complete" ? 100 : task.status === "not_started" ? 0 : task.percentComplete;
    if (percent === null) return null;
    weight += task.durationDays;
    done += task.durationDays * percent;
  }
  return weight > 0 ? done / weight / 100 : null;
}

/**
 * Variance in working days of a current date against a baseline date: positive is later than
 * the baseline (a slip), negative earlier. Null ("unavailable") without both dates.
 */
export function workingDayVariance(
  calendar: WorkingCalendar,
  baseline: string | null | undefined,
  current: string | null | undefined,
): number | null {
  if (!baseline || !current) return null;
  return workingDaysBetween(calendar, baseline, current);
}

export type DelayDaysProblem =
  "delay-date-future" | "delay-dates-invalid" | "delay-days-exceed-range";

/**
 * Checks a delay's dates and working days lost: the period cannot start in the future or end
 * before it starts or after today; the days lost (in half days) cannot exceed the working days
 * in the period (an open delay is counted to today). Returns the working days in the period.
 */
export function checkDelayDays(
  calendar: WorkingCalendar,
  input: { startDate: string; endDate: string | null; workingDaysLost: number },
  today: string,
): { ok: true; workingDaysInPeriod: number } | { ok: false; error: DelayDaysProblem } {
  if (input.startDate > today || (input.endDate !== null && input.endDate > today))
    return { ok: false, error: "delay-date-future" };
  if (input.endDate !== null && input.endDate < input.startDate)
    return { ok: false, error: "delay-dates-invalid" };
  const lost = input.workingDaysLost;
  if (
    !Number.isFinite(lost) ||
    lost < 0 ||
    lost > SCHEDULE_LIMITS.maxDelayDays ||
    (lost * 2) % 1 !== 0
  )
    return { ok: false, error: "delay-dates-invalid" };
  const workingDaysInPeriod = countWorkingDays(calendar, input.startDate, input.endDate ?? today);
  if (lost > workingDaysInPeriod) return { ok: false, error: "delay-days-exceed-range" };
  return { ok: true, workingDaysInPeriod };
}
