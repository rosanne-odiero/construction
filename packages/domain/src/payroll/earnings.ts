import { Decimal } from "decimal.js";
import {
  DAY_TYPES,
  MINIMUM_WAGE_DERIVATION,
  type AllowanceBasis,
  type DayType,
  type EarningKind,
  type RateBasis,
} from "@pm-buddy/types";

/**
 * Earnings components (brief §5.6, D4.1). Every amount is KES minor units rounded half-up to the
 * cent once per component row (FINANCIAL_MODEL: a total is the sum of its rounded rows).
 *
 * Attendance and overtime from an approved timesheet day, with the labourer's rate resolved on that
 * date and the timesheet rule version recorded on the day (COMPLIANCE-REVIEW CR-PAY-08):
 * - Daily rate, weekday: half-day units × rate ÷ 2. Overtime minutes × rate × multiplier ÷ the
 *   rule's normal minutes: the hourly equivalent of a daily rate is rate ÷ (normal minutes ÷ 60).
 * - Daily rate, rest day or public holiday: no day pay; every worked minute is overtime of that
 *   category (D3.3 records them so) at rate × multiplier ÷ normal minutes. A full rest day at 2.00
 *   therefore earns two day rates, never three.
 * - Hourly rate: normal minutes × rate ÷ 60 plus overtime minutes × rate × multiplier ÷ 60.
 * - Leave, sick and absent days are counted by D3.3 but not paid here (policy; CR-PAY-08).
 * Adjustment lines are signed deltas, so their components can be negative.
 */

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const round = (value: InstanceType<typeof D>): number => {
  const rounded = value.toDecimalPlaces(0, D.ROUND_HALF_UP).toNumber();
  if (!Number.isSafeInteger(rounded)) throw new RangeError("Amount out of range");
  return rounded;
};

export type EarningSourceKind = "timesheet_line" | "piece_rate_share" | "allowance";

export type Earning = {
  kind: EarningKind;
  /** Day type of overtime (and of attendance rows); null for allowances and piece rate. */
  category: DayType | null;
  date: string | null;
  /** Decimal string in `unit` (days, minutes, the output unit, or days for per-day allowances). */
  quantity: string;
  unit: string;
  rateMinor: number | null;
  labourRateId: string | null;
  multiplier: string | null;
  timesheetRuleId: string | null;
  sourceKind: EarningSourceKind;
  sourceId: string;
  description: string;
  amountMinor: number;
  taxable: boolean;
};

export type TimesheetDayInput = {
  date: string;
  dayType: DayType;
  ruleVersionId: string | null;
  halfDays: number;
  normalMinutes: number;
  overtimeMinutes: Record<DayType, number>;
};

export type TimesheetRuleRef = {
  id: string;
  normalMinutes: number;
  multipliers: Record<DayType, string>;
  verified: boolean;
};

export type RateRef = { id: string; basis: RateBasis; rateMinor: number };

const halfDaysAsDays = (halfDays: number) => {
  const sign = halfDays < 0 ? "-" : "";
  const value = Math.abs(halfDays);
  return `${sign}${Math.floor(value / 2)}${value % 2 ? ".5" : ""}`;
};

/** Attendance and overtime components of one timesheet day (see the module notes). */
export function dayEarnings(
  day: TimesheetDayInput,
  rate: RateRef,
  rule: TimesheetRuleRef,
  sourceId: string,
): Earning[] {
  const rows: Earning[] = [];
  const common = {
    date: day.date,
    rateMinor: rate.rateMinor,
    labourRateId: rate.id,
    timesheetRuleId: rule.id,
    sourceKind: "timesheet_line" as const,
    sourceId,
    taxable: true,
  };
  if (rate.basis === "daily") {
    if (day.dayType === "weekday" && day.halfDays !== 0)
      rows.push({
        ...common,
        kind: "attendance",
        category: day.dayType,
        quantity: halfDaysAsDays(day.halfDays),
        unit: "day",
        multiplier: null,
        description: "attendance",
        amountMinor: round(new D(day.halfDays).times(rate.rateMinor).dividedBy(2)),
      });
  } else if (day.normalMinutes !== 0) {
    rows.push({
      ...common,
      kind: "attendance",
      category: day.dayType,
      quantity: String(day.normalMinutes),
      unit: "minute",
      multiplier: null,
      description: "attendance",
      amountMinor: round(new D(day.normalMinutes).times(rate.rateMinor).dividedBy(60)),
    });
  }
  for (const category of DAY_TYPES) {
    const minutes = day.overtimeMinutes[category];
    if (!minutes) continue;
    const multiplier = rule.multipliers[category];
    const divisor = rate.basis === "daily" ? rule.normalMinutes : 60;
    rows.push({
      ...common,
      kind: "overtime",
      category,
      quantity: String(minutes),
      unit: "minute",
      multiplier,
      description: `overtime_${category}`,
      amountMinor: round(new D(minutes).times(rate.rateMinor).times(multiplier).dividedBy(divisor)),
    });
  }
  return rows;
}

/**
 * Splits a gang's output amount equally between its members (sorted as given: by worker number),
 * the leftover cents going one each to the first members (largest remainder). The shares always
 * add up to the amount (COMPLIANCE-REVIEW CR-PAY-16: equal split is a product default).
 */
export function splitEqually(amountMinor: number, memberCount: number): number[] {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0)
    throw new RangeError("amount must be a non-negative integer");
  if (!Number.isInteger(memberCount) || memberCount < 1) throw new RangeError("no members");
  const base = Math.floor(amountMinor / memberCount);
  const leftover = amountMinor - base * memberCount;
  return Array.from({ length: memberCount }, (_, index) => base + (index < leftover ? 1 : 0));
}

/** Quantity (decimal string, up to 3 places) × rate per unit (minor), rounded half-up. */
export function outputAmountMinor(quantity: string, rateMinor: number): number {
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(quantity)) throw new TypeError("quantity");
  return round(new D(quantity).times(rateMinor));
}

export type AllowanceRef = {
  id: string;
  code: string;
  nameEn: string;
  basis: AllowanceBasis;
  amountMinor: number;
  taxable: boolean;
  tradeId: string | null;
  labourerId: string | null;
  effectiveFrom: string;
  endedOn: string | null;
};

const specificity = (allowance: AllowanceRef) =>
  allowance.labourerId ? 2 : allowance.tradeId ? 1 : 0;

/**
 * The allowances in force on `date` for a labourer: per code, the most specific one (labourer, then
 * trade, then the whole project), latest start first.
 */
export function allowancesInForce(
  allowances: readonly AllowanceRef[],
  labourer: { id: string; tradeId: string },
  date: string,
): AllowanceRef[] {
  const best = new Map<string, AllowanceRef>();
  for (const allowance of allowances) {
    if (allowance.effectiveFrom > date) continue;
    if (allowance.endedOn !== null && allowance.endedOn < date) continue;
    if (allowance.labourerId && allowance.labourerId !== labourer.id) continue;
    if (!allowance.labourerId && allowance.tradeId && allowance.tradeId !== labourer.tradeId)
      continue;
    const current = best.get(allowance.code);
    if (
      !current ||
      specificity(allowance) > specificity(current) ||
      (specificity(allowance) === specificity(current) &&
        allowance.effectiveFrom > current.effectiveFrom)
    )
      best.set(allowance.code, allowance);
  }
  return [...best.values()];
}

/**
 * Allowance components: per day worked (each date with paid attendance, overtime or piece rate in
 * this batch) or once per period (when the labourer earned anything, on the period's last day).
 */
export function allowanceEarnings(
  allowances: readonly AllowanceRef[],
  labourer: { id: string; tradeId: string },
  workedDates: readonly string[],
  periodEnd: string,
): Earning[] {
  const perDay = new Map<string, { allowance: AllowanceRef; days: number }>();
  for (const date of [...new Set(workedDates)].sort())
    for (const allowance of allowancesInForce(allowances, labourer, date)) {
      if (allowance.basis !== "per_day_worked") continue;
      const entry = perDay.get(allowance.id) ?? { allowance, days: 0 };
      entry.days += 1;
      perDay.set(allowance.id, entry);
    }
  const rows: Earning[] = [...perDay.values()].map(({ allowance, days }) => ({
    kind: "allowance",
    category: null,
    date: null,
    quantity: String(days),
    unit: "day",
    rateMinor: allowance.amountMinor,
    labourRateId: null,
    multiplier: null,
    timesheetRuleId: null,
    sourceKind: "allowance",
    sourceId: allowance.id,
    description: allowance.code,
    amountMinor: allowance.amountMinor * days,
    taxable: allowance.taxable,
  }));
  if (workedDates.length)
    for (const allowance of allowancesInForce(allowances, labourer, periodEnd)) {
      if (allowance.basis !== "per_period") continue;
      rows.push({
        kind: "allowance",
        category: null,
        date: null,
        quantity: "1",
        unit: "period",
        rateMinor: allowance.amountMinor,
        labourRateId: null,
        multiplier: null,
        timesheetRuleId: null,
        sourceKind: "allowance",
        sourceId: allowance.id,
        description: allowance.code,
        amountMinor: allowance.amountMinor,
        taxable: allowance.taxable,
      });
    }
  return rows;
}

export type MinimumWageRef = {
  monthlyMinor: number;
  dailyMinor: number | null;
  hourlyMinor: number | null;
};

/**
 * Compares a rate with a minimum wage (CR-PAY-09; a warning, never a block). The gazetted daily or
 * hourly figure is used when configured; otherwise the monthly figure is converted with the
 * documented divisors (÷ 26 days, ÷ 225 hours) and the result is marked `derived`.
 */
export function minimumWageComparison(
  rate: { basis: RateBasis; rateMinor: number },
  minimum: MinimumWageRef,
): { minimumMinor: number; derived: boolean; below: boolean } {
  const gazetted = rate.basis === "daily" ? minimum.dailyMinor : minimum.hourlyMinor;
  if (gazetted !== null)
    return { minimumMinor: gazetted, derived: false, below: rate.rateMinor < gazetted };
  const divisor =
    rate.basis === "daily"
      ? MINIMUM_WAGE_DERIVATION.workingDaysPerMonth
      : MINIMUM_WAGE_DERIVATION.hoursPerMonth;
  return {
    minimumMinor: round(new D(minimum.monthlyMinor).dividedBy(divisor)),
    derived: true,
    below: new D(rate.rateMinor).times(divisor).lessThan(minimum.monthlyMinor),
  };
}
