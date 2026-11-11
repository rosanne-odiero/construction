import {
  ATTENDANCE_STATUSES,
  DAY_TYPES,
  isWorkedStatus,
  type AttendanceStatus,
  type DayType,
  type TimesheetRuleValues,
} from "@pm-buddy/types";
import { dayTypeOf } from "./rules.js";
import { MINUTES_PER_DAY } from "./time.js";

/**
 * Timesheet computation (brief §5.5, D3.3): pure integer arithmetic on minutes and half-day units,
 * no floating point. A labourer's day is computed once across every site and project they were
 * recorded on, so the same minutes and the same day are never counted twice; each record then
 * receives its share, and a project's timesheet sums the shares of its own records.
 *
 * Rules applied to one labourer-day (all records of one labourer on one date):
 * 1. Worked records (present or half day, with times) are taken in check-in order. Minutes a record
 *    shares with an earlier record are counted once (and flagged `overlapping_times`).
 * 2. Each record deducts its break: the entered minutes, or the rule's default break when the shift
 *    is longer than `breakAfterMinutes`.
 * 3. The governing rule is the rule of the earliest worked record's project. It decides the day
 *    type (public holiday before rest day before weekday), the normal minutes, the half-day
 *    threshold and lateness.
 * 4. On a weekday the first `normalMinutes` of the day are normal time, in check-in order; the rest
 *    is weekday overtime. On a rest day or public holiday every worked minute is overtime of that
 *    category (COMPLIANCE-REVIEW CR-PAY-08: payroll applies the multipliers).
 * 5. Day units (half days): a day whose worked records are all `half_day` is one half; otherwise a
 *    day reaching `halfDayThresholdMinutes` is a full day (two halves) and a shorter one a half.
 *    Units are shared between records in proportion to their minutes (largest remainder).
 * 6. Lateness: minutes from the expected start when the first check-in is after start + grace,
 *    on weekdays only and not for overnight (night) shifts.
 * 7. Records in an approved (locked) period keep their snapshot allocation; the other records
 *    share only what remains, so a late record on another project can never be paid twice.
 */

export type RecordAllocationValues = {
  halfDays: number;
  workedMinutes: number;
  normalMinutes: number;
  overtimeMinutes: number;
  lateMinutes: number;
};

export type DayRecord = {
  id: string;
  projectId: string;
  siteId: string;
  status: AttendanceStatus;
  checkIn: number | null;
  checkOut: number | null;
  overnight: boolean;
  breakMinutes: number | null;
  /** Allocation fixed by an approved timesheet; never recomputed. */
  locked?: RecordAllocationValues | null;
};

export type DayRule = TimesheetRuleValues & { id: string };

export type RecordAllocation = RecordAllocationValues & {
  recordId: string;
  projectId: string;
  siteId: string;
  status: AttendanceStatus;
  /** The overtime category of `overtimeMinutes` (the day type). */
  dayType: DayType;
  /** The break deducted (entered or the rule default). */
  breakMinutes: number;
  locked: boolean;
};

export type LabourerDayResult = {
  date: string;
  /** Null when no timesheet rule is configured for a project recorded that day. */
  dayType: DayType | null;
  ruleId: string | null;
  missingRule: boolean;
  /** Every worked minute of the day once (before any locked allocation is taken out). */
  totalWorkedMinutes: number;
  halfDays: number;
  normalMinutes: number;
  overtimeMinutes: number;
  lateMinutes: number;
  overlapMinutes: number;
  /** Distinct sites with worked records. */
  siteCount: number;
  maxPlausibleMinutes: number | null;
  records: RecordAllocation[];
};

export type LabourerDayInput = {
  date: string;
  records: readonly DayRecord[];
  /** The rule version in force for a project on `date`, or null when none is configured. */
  ruleFor: (projectId: string) => DayRule | null;
  holidays: ReadonlySet<string>;
};

type Interval = [number, number];

/** Minutes of [start, end) already covered by the sorted, disjoint intervals. */
function coveredMinutes(covered: readonly Interval[], start: number, end: number): number {
  let minutes = 0;
  for (const [from, to] of covered)
    minutes += Math.max(0, Math.min(end, to) - Math.max(start, from));
  return minutes;
}

function addInterval(covered: Interval[], start: number, end: number): void {
  covered.push([start, end]);
  covered.sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  for (const interval of covered) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([interval[0], interval[1]]);
  }
  covered.splice(0, covered.length, ...merged);
}

const zero = (): RecordAllocationValues => ({
  halfDays: 0,
  workedMinutes: 0,
  normalMinutes: 0,
  overtimeMinutes: 0,
  lateMinutes: 0,
});

/** Shares `units` in proportion to `weights` (largest remainder; ties go to the earlier entry). */
export function shareProportionally(units: number, weights: readonly number[]): number[] {
  if (!weights.length || units <= 0) return weights.map(() => 0);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return weights.map((_, index) => (index === 0 ? units : 0));
  const base = weights.map((weight) => Math.floor((units * weight) / total));
  let left = units - base.reduce((sum, value) => sum + value, 0);
  const order = weights
    .map((weight, index) => ({ index, remainder: (units * weight) % total }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    base[index]! += 1;
    left -= 1;
  }
  return base;
}

export function computeLabourerDay(input: LabourerDayInput): LabourerDayResult {
  const worked = input.records
    .filter((record) => isWorkedStatus(record.status))
    .filter((record) => record.checkIn !== null && record.checkOut !== null)
    .map((record) => ({
      record,
      start: record.checkIn!,
      end: record.checkOut! + (record.overnight ? MINUTES_PER_DAY : 0),
    }))
    .sort(
      (a, b) =>
        a.start - b.start ||
        a.end - b.end ||
        (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0),
    );
  const missingRule = input.records.some((record) => input.ruleFor(record.projectId) === null);
  const governing = worked[0]?.record ?? input.records[0];
  const rule = governing ? input.ruleFor(governing.projectId) : null;
  const base = {
    date: input.date,
    missingRule,
    siteCount: new Set(worked.map((entry) => entry.record.siteId)).size,
  };
  if (!rule)
    return {
      ...base,
      dayType: null,
      ruleId: null,
      totalWorkedMinutes: 0,
      halfDays: 0,
      normalMinutes: 0,
      overtimeMinutes: 0,
      lateMinutes: 0,
      overlapMinutes: 0,
      maxPlausibleMinutes: null,
      records: input.records.map((record) => ({
        ...(record.locked ?? zero()),
        recordId: record.id,
        projectId: record.projectId,
        siteId: record.siteId,
        status: record.status,
        dayType: "weekday",
        breakMinutes: 0,
        locked: Boolean(record.locked),
      })),
    };

  const dayType = dayTypeOf(input.date, rule.restDays, input.holidays);
  const covered: Interval[] = [];
  let overlapMinutes = 0;
  const counted = new Map<string, { minutes: number; breakMinutes: number }>();
  for (const { record, start, end } of worked) {
    const span = end - start;
    const recordRule = input.ruleFor(record.projectId) ?? rule;
    const breakMinutes = Math.min(
      span,
      record.breakMinutes ??
        (span > recordRule.breakAfterMinutes ? recordRule.defaultBreakMinutes : 0),
    );
    const overlap = coveredMinutes(covered, start, end);
    overlapMinutes += overlap;
    counted.set(record.id, { minutes: Math.max(0, span - overlap - breakMinutes), breakMinutes });
    addInterval(covered, start, end);
  }

  const totalWorkedMinutes = [...counted.values()].reduce((sum, entry) => sum + entry.minutes, 0);
  const normalCap = dayType === "weekday" ? rule.normalMinutes : 0;
  const normalMinutes = Math.min(totalWorkedMinutes, normalCap);
  const overtimeMinutes = totalWorkedMinutes - normalMinutes;
  const allHalf = worked.length > 0 && worked.every((entry) => entry.record.status === "half_day");
  const halfDays = !worked.length
    ? 0
    : allHalf || totalWorkedMinutes < rule.halfDayThresholdMinutes
      ? 1
      : 2;
  const first = worked[0];
  const lateMinutes =
    first &&
    dayType === "weekday" &&
    !first.record.overnight &&
    first.start > rule.dayStartMinutes + rule.lateGraceMinutes
      ? first.start - rule.dayStartMinutes
      : 0;

  // Locked records keep their snapshot; the others share what remains of the day.
  const lockedTotal = input.records.reduce((sum, record) => {
    const locked = record.locked;
    if (!locked) return sum;
    return {
      halfDays: sum.halfDays + locked.halfDays,
      workedMinutes: sum.workedMinutes + locked.workedMinutes,
      normalMinutes: sum.normalMinutes + locked.normalMinutes,
      overtimeMinutes: sum.overtimeMinutes + locked.overtimeMinutes,
      lateMinutes: sum.lateMinutes + locked.lateMinutes,
    };
  }, zero());
  let normalLeft = Math.max(0, normalMinutes - lockedTotal.normalMinutes);
  let overtimeLeft = Math.max(0, overtimeMinutes - lockedTotal.overtimeMinutes);
  let lateLeft = Math.max(0, lateMinutes - lockedTotal.lateMinutes);
  const halfDaysLeft = Math.max(0, halfDays - lockedTotal.halfDays);

  const allocations = new Map<string, RecordAllocationValues>();
  const free = worked.filter((entry) => !entry.record.locked);
  for (const { record } of free) {
    const minutes = counted.get(record.id)!.minutes;
    const normal = Math.min(minutes, normalLeft);
    normalLeft -= normal;
    const overtime = Math.min(minutes - normal, overtimeLeft);
    overtimeLeft -= overtime;
    const late = record === first?.record ? lateLeft : 0;
    lateLeft -= late;
    allocations.set(record.id, {
      halfDays: 0,
      workedMinutes: normal + overtime,
      normalMinutes: normal,
      overtimeMinutes: overtime,
      lateMinutes: late,
    });
  }
  const shares = shareProportionally(
    halfDaysLeft,
    free.map((entry) => allocations.get(entry.record.id)!.workedMinutes),
  );
  free.forEach((entry, index) => {
    allocations.get(entry.record.id)!.halfDays = shares[index]!;
  });

  return {
    ...base,
    dayType,
    ruleId: rule.id,
    totalWorkedMinutes,
    halfDays,
    normalMinutes,
    overtimeMinutes,
    lateMinutes,
    overlapMinutes,
    maxPlausibleMinutes: rule.maxPlausibleMinutes,
    records: input.records.map((record) => ({
      ...(record.locked ?? allocations.get(record.id) ?? zero()),
      recordId: record.id,
      projectId: record.projectId,
      siteId: record.siteId,
      status: record.status,
      dayType,
      breakMinutes: counted.get(record.id)?.breakMinutes ?? 0,
      locked: Boolean(record.locked),
    })),
  };
}

/** Totals of a timesheet line: half-day units and integer minutes, overtime by day type. */
export type TimesheetTotals = {
  halfDays: number;
  workedMinutes: number;
  normalMinutes: number;
  overtimeMinutes: Record<DayType, number>;
  lateMinutes: number;
  statusCounts: Record<AttendanceStatus, number>;
};

export function emptyTotals(): TimesheetTotals {
  return {
    halfDays: 0,
    workedMinutes: 0,
    normalMinutes: 0,
    overtimeMinutes: Object.fromEntries(DAY_TYPES.map((type) => [type, 0])) as Record<
      DayType,
      number
    >,
    lateMinutes: 0,
    statusCounts: Object.fromEntries(ATTENDANCE_STATUSES.map((status) => [status, 0])) as Record<
      AttendanceStatus,
      number
    >,
  };
}

export function addTotals(a: TimesheetTotals, b: TimesheetTotals): TimesheetTotals {
  return combine(a, b, 1);
}

/** `a − b`, field by field (adjustment deltas). */
export function subtractTotals(a: TimesheetTotals, b: TimesheetTotals): TimesheetTotals {
  return combine(a, b, -1);
}

function combine(a: TimesheetTotals, b: TimesheetTotals, sign: 1 | -1): TimesheetTotals {
  return {
    halfDays: a.halfDays + sign * b.halfDays,
    workedMinutes: a.workedMinutes + sign * b.workedMinutes,
    normalMinutes: a.normalMinutes + sign * b.normalMinutes,
    overtimeMinutes: Object.fromEntries(
      DAY_TYPES.map((type) => [type, a.overtimeMinutes[type] + sign * b.overtimeMinutes[type]]),
    ) as Record<DayType, number>,
    lateMinutes: a.lateMinutes + sign * b.lateMinutes,
    statusCounts: Object.fromEntries(
      ATTENDANCE_STATUSES.map((status) => [
        status,
        a.statusCounts[status] + sign * b.statusCounts[status],
      ]),
    ) as Record<AttendanceStatus, number>,
  };
}

export function isZeroTotals(totals: TimesheetTotals): boolean {
  return (
    totals.halfDays === 0 &&
    totals.workedMinutes === 0 &&
    totals.normalMinutes === 0 &&
    totals.lateMinutes === 0 &&
    DAY_TYPES.every((type) => totals.overtimeMinutes[type] === 0) &&
    ATTENDANCE_STATUSES.every((status) => totals.statusCounts[status] === 0)
  );
}

/** One labourer's part of a timesheet on one date (one project's records only). */
export type TimesheetDay = {
  date: string;
  dayType: DayType;
  ruleId: string;
  totals: TimesheetTotals;
  /** The project's records that day (source attendance record IDs). */
  recordIds: string[];
  allocations: RecordAllocation[];
};

/** The totals of a set of record allocations (one project's records of one labourer-day). */
export function totalsOf(allocations: readonly RecordAllocation[]): TimesheetTotals {
  const totals = emptyTotals();
  for (const allocation of allocations) {
    totals.halfDays += allocation.halfDays;
    totals.workedMinutes += allocation.workedMinutes;
    totals.normalMinutes += allocation.normalMinutes;
    totals.overtimeMinutes[allocation.dayType] += allocation.overtimeMinutes;
    totals.lateMinutes += allocation.lateMinutes;
    totals.statusCounts[allocation.status] += 1;
  }
  return totals;
}

/** A project's share of computed labourer-days (days without its records are skipped). */
export function timesheetDays(
  results: readonly LabourerDayResult[],
  projectId: string,
): TimesheetDay[] {
  return results
    .map((result) => {
      const allocations = result.records.filter((record) => record.projectId === projectId);
      return { result, allocations };
    })
    .filter(({ allocations }) => allocations.length > 0)
    .map(({ result, allocations }) => ({
      date: result.date,
      dayType: result.dayType ?? "weekday",
      ruleId: result.ruleId ?? "",
      totals: totalsOf(allocations),
      recordIds: allocations.map((allocation) => allocation.recordId),
      allocations,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function sumDays(days: readonly TimesheetDay[]): TimesheetTotals {
  return days.reduce((total, day) => addTotals(total, day.totals), emptyTotals());
}
