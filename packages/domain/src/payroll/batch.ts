import {
  EMPLOYEE_STATUTORY,
  EMPLOYER_COSTS,
  type EngagementType,
  type MinimumWageArea,
  type MinimumWageOccupation,
  type PayrollExclusionReason,
  type PayrollWarningCode,
  type RateBasis,
} from "@pm-buddy/types";
import { resolveRate, type RateCandidate } from "../labour.js";
import { planRecoveries, type AdvanceBalance, type Recovery } from "./advances.js";
import {
  allowanceEarnings,
  dayEarnings,
  minimumWageComparison,
  type AllowanceRef,
  type Earning,
  type MinimumWageRef,
  type TimesheetDayInput,
  type TimesheetRuleRef,
} from "./earnings.js";
import {
  batchStatutory,
  emptyPriorMonth,
  ruleSetVersions,
  type BatchStatutory,
  type PriorMonth,
  type StatutoryRuleSet,
} from "./statutory.js";

/**
 * Builds one payroll batch (one project, one pay period) from its sources (D4.1). Pure: the API
 * loads the inputs in one tenant transaction and persists the result.
 *
 * Which components coexist on one labourer-day (brief §5.6, §15 C):
 * - attendance pay and overtime: yes (same timesheet day);
 * - attendance or overtime and piece rate: never. Piece rate replaces the day's attendance and
 *   overtime when both are in the batch, or when piece rate was already paid for that day by an
 *   earlier batch. Piece rate for a day whose attendance was already paid is left out
 *   (`day-paid-by-attendance`) and stays available. The database repeats this (day claims).
 * - allowances: yes, alongside either basis.
 * - labourers engaged on piece rate: attendance never pays them; only approved output does.
 *
 * A labourer whose gross would be negative (an adjustment that takes back more than the batch
 * pays) is left out with all their sources (`negative-gross`); the sources stay available and are
 * paid with later earnings. Excluded sources are never consumed.
 */

export type BatchLabourer = {
  id: string;
  workerNo: string;
  fullName: string;
  engagementType: EngagementType;
  rateBasis: RateBasis;
  tradeId: string;
  skillLevelId: string;
  /** The General Order occupation the minimum-wage warning compares with (null: none). */
  occupation: MinimumWageOccupation | null;
};

export type TimesheetLineSource = {
  id: string;
  labourerId: string;
  kind: "attendance" | "adjustment";
  periodId: string;
  periodEndDate: string;
  days: TimesheetDayInput[];
};

export type PieceRateShareSource = {
  id: string;
  outputId: string;
  labourerId: string;
  workDate: string;
  amountMinor: number;
  description: string;
  quantity: string;
  unit: string;
  rateMinor: number;
};

export type DayBasis = "attendance" | "piece_rate";
export type DayClaim = { labourerId: string; date: string; basis: DayBasis };

export type MinimumWageRow = MinimumWageRef & {
  id: string;
  area: MinimumWageArea;
  occupation: MinimumWageOccupation;
  effectiveFrom: string;
};

export type BatchInput = {
  projectId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  rules: StatutoryRuleSet;
  labourers: readonly BatchLabourer[];
  rates: readonly RateCandidate[];
  timesheetRules: ReadonlyMap<string, TimesheetRuleRef>;
  lines: readonly TimesheetLineSource[];
  shares: readonly PieceRateShareSource[];
  allowances: readonly AllowanceRef[];
  prior: ReadonlyMap<string, PriorMonth>;
  advances: ReadonlyMap<string, readonly AdvanceBalance[]>;
  /** Day claims of other non-cancelled batches (any project of the company). */
  claims: readonly DayClaim[];
  recoveryMaxPercent: string;
  /** False in production: lines computed with unverified timesheet rules are left out. */
  allowUnverifiedTimesheetRules: boolean;
  minimumWageArea: MinimumWageArea | null;
  minimumWages: readonly MinimumWageRow[];
};

export type LineWarning = { code: PayrollWarningCode; details: Record<string, unknown> };

export type Exclusion = {
  sourceKind: "timesheet_line" | "piece_rate_share";
  sourceId: string;
  labourerId: string;
  reason: PayrollExclusionReason;
  date: string | null;
};

export type PayrollLineResult = {
  labourer: BatchLabourer;
  timesheetLineIds: string[];
  pieceRateShareIds: string[];
  earnings: Earning[];
  summary: {
    halfDays: number;
    normalMinutes: number;
    overtimeMinutes: Record<"weekday" | "rest_day" | "public_holiday", number>;
    daysWorked: number;
    pieceRateDays: string[];
    replacedDays: string[];
  };
  grossMinor: number;
  statutoryBaseMinor: number;
  statutory: BatchStatutory;
  prior: PriorMonth;
  recoveries: Recovery[];
  otherDeductionsMinor: number;
  totalDeductionsMinor: number;
  netMinor: number;
  employerCostMinor: number;
  claims: DayClaim[];
  warnings: LineWarning[];
};

export type BatchTotals = {
  lines: number;
  grossMinor: number;
  statutoryBaseMinor: number;
  employee: Record<(typeof EMPLOYEE_STATUTORY)[number], number>;
  advanceRecoveryMinor: number;
  otherDeductionsMinor: number;
  totalDeductionsMinor: number;
  netMinor: number;
  employer: Record<(typeof EMPLOYER_COSTS)[number], number>;
  employerCostMinor: number;
  shortfallMinor: number;
};

export type BatchResult = {
  lines: PayrollLineResult[];
  exclusions: Exclusion[];
  totals: BatchTotals;
  ruleVersionIds: string[];
  timesheetRuleIds: string[];
  unverified: boolean;
};

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const key = (labourerId: string, date: string) => `${labourerId}|${date}`;

function minimumWageWarning(
  labourer: BatchLabourer,
  rate: { basis: RateBasis; rateMinor: number },
  date: string,
  input: BatchInput,
): LineWarning | null {
  if (!input.minimumWageArea || !labourer.occupation)
    return {
      code: "minimum-wage-not-configured",
      details: { area: input.minimumWageArea, occupation: labourer.occupation },
    };
  const row = input.minimumWages
    .filter(
      (entry) =>
        entry.area === input.minimumWageArea &&
        entry.occupation === labourer.occupation &&
        entry.effectiveFrom <= date,
    )
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  if (!row)
    return {
      code: "minimum-wage-not-configured",
      details: { area: input.minimumWageArea, occupation: labourer.occupation },
    };
  const comparison = minimumWageComparison(rate, row);
  if (!comparison.below) return null;
  return {
    code: "below-minimum-wage",
    details: {
      date,
      basis: rate.basis,
      rateMinor: rate.rateMinor,
      minimumMinor: comparison.minimumMinor,
      derived: comparison.derived,
      area: row.area,
      occupation: row.occupation,
      minimumWageId: row.id,
    },
  };
}

export function computeBatch(input: BatchInput): BatchResult {
  const exclusions: Exclusion[] = [];
  const lines: PayrollLineResult[] = [];
  const timesheetRuleIds = new Set<string>();
  const claimed = new Map<string, Set<DayBasis>>();
  for (const claim of input.claims) {
    const set = claimed.get(key(claim.labourerId, claim.date)) ?? new Set<DayBasis>();
    set.add(claim.basis);
    claimed.set(key(claim.labourerId, claim.date), set);
  }
  const byLabourer = new Map(input.labourers.map((labourer) => [labourer.id, labourer]));
  const labourerIds = [
    ...new Set([
      ...input.lines.map((line) => line.labourerId),
      ...input.shares.map((share) => share.labourerId),
    ]),
  ];
  for (const labourerId of labourerIds) {
    const labourer = byLabourer.get(labourerId);
    const ownLines = input.lines.filter((line) => line.labourerId === labourerId);
    const ownShares = input.shares
      .filter((share) => share.labourerId === labourerId)
      .sort((a, b) => a.workDate.localeCompare(b.workDate) || a.id.localeCompare(b.id));
    if (!labourer) {
      for (const line of ownLines)
        exclusions.push({
          sourceKind: "timesheet_line",
          sourceId: line.id,
          labourerId,
          reason: "labourer-not-found",
          date: null,
        });
      for (const share of ownShares)
        exclusions.push({
          sourceKind: "piece_rate_share",
          sourceId: share.id,
          labourerId,
          reason: "labourer-not-found",
          date: share.workDate,
        });
      continue;
    }
    const pieceRateEngaged = labourer.engagementType === "piece_rate";
    const rateFor = (date: string) =>
      resolveRate(input.rates, {
        onDate: date,
        basis: labourer.rateBasis,
        projectId: input.projectId,
        labourerId,
        tradeId: labourer.tradeId,
        skillLevelId: labourer.skillLevelId,
      });

    // 1. Timesheet lines that can be paid (rules present and allowed, a rate on every paid day).
    const keptLines: TimesheetLineSource[] = [];
    for (const line of ownLines) {
      let reason: PayrollExclusionReason | null = null;
      let date: string | null = null;
      for (const day of line.days) {
        const rule = day.ruleVersionId ? input.timesheetRules.get(day.ruleVersionId) : undefined;
        if (!rule) {
          reason = "rule-missing";
          date = day.date;
          break;
        }
        if (!rule.verified && !input.allowUnverifiedTimesheetRules) {
          reason = "timesheet-rule-unverified";
          date = day.date;
          break;
        }
        if (!pieceRateEngaged && !rateFor(day.date)) {
          reason = "missing-rate";
          date = day.date;
          break;
        }
      }
      if (reason)
        exclusions.push({
          sourceKind: "timesheet_line",
          sourceId: line.id,
          labourerId,
          reason,
          date,
        });
      else keptLines.push(line);
    }

    // 2. Piece rate never pays a day whose attendance an earlier batch already paid.
    const keptShares: PieceRateShareSource[] = [];
    for (const share of ownShares) {
      if (claimed.get(key(labourerId, share.workDate))?.has("attendance"))
        exclusions.push({
          sourceKind: "piece_rate_share",
          sourceId: share.id,
          labourerId,
          reason: "day-paid-by-attendance",
          date: share.workDate,
        });
      else keptShares.push(share);
    }
    const pieceRateDays = new Set(keptShares.map((share) => share.workDate));
    for (const claim of input.claims)
      if (claim.labourerId === labourerId && claim.basis === "piece_rate")
        pieceRateDays.add(claim.date);

    // 3. Earnings.
    const earnings: Earning[] = [];
    const warnings: LineWarning[] = [];
    const replacedDays = new Set<string>();
    const dayPay = new Map<string, number>();
    const attendanceWorked = new Set<string>();
    const summary = {
      halfDays: 0,
      normalMinutes: 0,
      overtimeMinutes: { weekday: 0, rest_day: 0, public_holiday: 0 },
    };
    const minimumChecked = new Set<string>();
    for (const line of keptLines) {
      if (line.periodEndDate < input.periodStart)
        warnings.push({
          code: "brought-forward",
          details: { timesheetLineId: line.id, periodEndDate: line.periodEndDate },
        });
      for (const day of line.days) {
        const rule = input.timesheetRules.get(day.ruleVersionId!)!;
        timesheetRuleIds.add(rule.id);
        if (pieceRateEngaged) continue;
        if (pieceRateDays.has(day.date)) {
          replacedDays.add(day.date);
          continue;
        }
        const resolved = rateFor(day.date)!;
        const rate = {
          id: resolved.rate.id,
          basis: resolved.rate.basis,
          rateMinor: resolved.rate.rateMinor,
        };
        const rows = dayEarnings(day, rate, rule, line.id);
        earnings.push(...rows);
        const paid = sum(rows.map((row) => row.amountMinor));
        dayPay.set(day.date, (dayPay.get(day.date) ?? 0) + paid);
        summary.halfDays += day.halfDays;
        summary.normalMinutes += day.normalMinutes;
        summary.overtimeMinutes.weekday += day.overtimeMinutes.weekday;
        summary.overtimeMinutes.rest_day += day.overtimeMinutes.rest_day;
        summary.overtimeMinutes.public_holiday += day.overtimeMinutes.public_holiday;
        if (line.kind === "attendance" && paid > 0) attendanceWorked.add(day.date);
        if (!minimumChecked.has(rate.id)) {
          minimumChecked.add(rate.id);
          const warning = minimumWageWarning(labourer, rate, day.date, input);
          const repeated =
            warning?.code === "minimum-wage-not-configured" &&
            warnings.some((entry) => entry.code === warning.code);
          if (warning && !repeated) warnings.push(warning);
        }
      }
    }
    if (pieceRateEngaged && keptLines.length)
      warnings.push({ code: "piece-rate-engagement", details: { lines: keptLines.length } });
    if (replacedDays.size)
      warnings.push({
        code: "attendance-replaced-by-piece-rate",
        details: { dates: [...replacedDays].sort() },
      });
    for (const share of keptShares)
      earnings.push({
        kind: "piece_rate",
        category: null,
        date: share.workDate,
        quantity: share.quantity,
        unit: share.unit,
        rateMinor: share.rateMinor,
        labourRateId: null,
        multiplier: null,
        timesheetRuleId: null,
        sourceKind: "piece_rate_share",
        sourceId: share.id,
        description: share.description,
        amountMinor: share.amountMinor,
        taxable: true,
      });
    const workedDates = [...new Set([...attendanceWorked, ...keptShares.map((s) => s.workDate)])];
    earnings.push(...allowanceEarnings(input.allowances, labourer, workedDates, input.periodEnd));

    const grossMinor = sum(earnings.map((row) => row.amountMinor));
    if (grossMinor < 0) {
      for (const line of keptLines)
        exclusions.push({
          sourceKind: "timesheet_line",
          sourceId: line.id,
          labourerId,
          reason: "negative-gross",
          date: null,
        });
      for (const share of keptShares)
        exclusions.push({
          sourceKind: "piece_rate_share",
          sourceId: share.id,
          labourerId,
          reason: "negative-gross",
          date: share.workDate,
        });
      continue;
    }
    if (!keptLines.length && !keptShares.length) continue;
    const statutoryBaseMinor = sum(
      earnings.filter((row) => row.taxable).map((row) => row.amountMinor),
    );
    const prior = input.prior.get(labourerId) ?? emptyPriorMonth();
    const statutory = batchStatutory(
      grossMinor,
      statutoryBaseMinor,
      prior,
      input.rules,
      labourer.engagementType,
    );
    const plan = planRecoveries(
      statutory.availableAfterMinor,
      input.advances.get(labourerId) ?? [],
      input.recoveryMaxPercent,
    );
    const recovered = sum(plan.recoveries.map((entry) => entry.amountMinor));
    const withheld = sum(EMPLOYEE_STATUTORY.map((item) => statutory.withheld[item]));
    const netMinor = grossMinor - withheld - recovered;
    if (plan.capped)
      warnings.push({ code: "advance-recovery-capped", details: { capMinor: plan.capMinor } });
    const shortfall = sum(EMPLOYEE_STATUTORY.map((item) => statutory.shortfall[item]));
    if (shortfall > 0)
      warnings.push({ code: "statutory-shortfall", details: { shortfallMinor: shortfall } });
    if (EMPLOYEE_STATUTORY.some((item) => statutory.withheld[item] < 0))
      warnings.push({
        code: "statutory-refund",
        details: {
          refundMinor: -sum(
            EMPLOYEE_STATUTORY.map((item) => Math.min(0, statutory.withheld[item])),
          ),
        },
      });
    if (grossMinor === 0) warnings.push({ code: "zero-pay", details: {} });

    const claims: DayClaim[] = [];
    for (const [date, paid] of [...dayPay].sort(([a], [b]) => a.localeCompare(b)))
      if (paid > 0) claims.push({ labourerId, date, basis: "attendance" });
    for (const date of [...new Set(keptShares.map((share) => share.workDate))].sort())
      claims.push({ labourerId, date, basis: "piece_rate" });

    lines.push({
      labourer,
      timesheetLineIds: keptLines.map((line) => line.id),
      pieceRateShareIds: keptShares.map((share) => share.id),
      earnings,
      summary: {
        ...summary,
        daysWorked: workedDates.length,
        pieceRateDays: [...new Set(keptShares.map((share) => share.workDate))].sort(),
        replacedDays: [...replacedDays].sort(),
      },
      grossMinor,
      statutoryBaseMinor,
      statutory,
      prior,
      recoveries: plan.recoveries,
      otherDeductionsMinor: 0,
      totalDeductionsMinor: withheld + recovered,
      netMinor,
      employerCostMinor: sum(EMPLOYER_COSTS.map((item) => statutory.employer[item])),
      claims,
      warnings,
    });
  }

  lines.sort(
    (a, b) =>
      a.labourer.workerNo.localeCompare(b.labourer.workerNo) ||
      a.labourer.id.localeCompare(b.labourer.id),
  );
  const employee = { nssf: 0, shif: 0, ahl: 0, paye: 0 };
  const employer = { nssf_employer: 0, ahl_employer: 0, nita: 0 };
  for (const line of lines) {
    for (const item of EMPLOYEE_STATUTORY) employee[item] += line.statutory.withheld[item];
    for (const item of EMPLOYER_COSTS) employer[item] += line.statutory.employer[item];
  }
  const totals: BatchTotals = {
    lines: lines.length,
    grossMinor: sum(lines.map((line) => line.grossMinor)),
    statutoryBaseMinor: sum(lines.map((line) => line.statutoryBaseMinor)),
    employee,
    advanceRecoveryMinor: sum(
      lines.flatMap((line) => line.recoveries.map((entry) => entry.amountMinor)),
    ),
    otherDeductionsMinor: sum(lines.map((line) => line.otherDeductionsMinor)),
    totalDeductionsMinor: sum(lines.map((line) => line.totalDeductionsMinor)),
    netMinor: sum(lines.map((line) => line.netMinor)),
    employer,
    employerCostMinor: sum(lines.map((line) => line.employerCostMinor)),
    shortfallMinor: sum(
      lines.flatMap((line) => EMPLOYEE_STATUTORY.map((item) => line.statutory.shortfall[item])),
    ),
  };
  const statutoryIds = ruleSetVersions(input.rules).map((rule) => rule.id);
  const unverified =
    ruleSetVersions(input.rules).some((rule) => rule.status !== "verified") ||
    [...timesheetRuleIds].some((id) => !input.timesheetRules.get(id)?.verified);
  return {
    lines,
    exclusions,
    totals,
    ruleVersionIds: statutoryIds,
    timesheetRuleIds: [...timesheetRuleIds].sort(),
    unverified,
  };
}
