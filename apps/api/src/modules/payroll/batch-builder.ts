import { Injectable } from "@nestjs/common";
import {
  computeBatch,
  defaultPayCalendar,
  emptyPriorMonth,
  ruleSetVersions,
  selectRuleSet,
  statutoryMonthOf,
  type AdvanceBalance,
  type BatchInput,
  type BatchLabourer,
  type BatchResult,
  type DayClaim,
  type MinimumWageRow,
  type PayCalendar,
  type PriorMonth,
  type StatutoryRuleSet,
  type StatutoryRuleVersion,
  type TimesheetRuleRef,
  normaliseDecimal,
} from "@pm-buddy/domain";
import {
  DEFAULT_MINIMUM_WAGE_OCCUPATION,
  DEFAULT_PAYROLL_SETTINGS,
  EMPLOYEE_STATUTORY,
  EMPLOYER_COSTS,
  type DayType,
  type EmployeeStatutory,
  type EmployerCost,
  type EngagementType,
  type IsoWeekday,
  type MinimumWageArea,
  type MinimumWageOccupation,
  type NcaCategory,
  type PayFrequency,
  type PayrollSettingsValues,
  type RateBasis,
  type StatutoryRuleKind,
} from "@pm-buddy/types";
import type { TimesheetLine as TimesheetLineWire } from "@pm-buddy/validation";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { loadPeriodSettings } from "../attendance/period-store.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  canonicalJson,
  money,
  payrollConflict,
  sha256,
  versionConflict,
} from "./payroll-support.js";

type Tx = Prisma.TransactionClient;

/** A project's pay calendar with its minimum-wage area (defaults when no row is saved). */
export type ProjectCalendar = PayCalendar & {
  minimumWageArea: MinimumWageArea | null;
  version: number;
  isDefault: boolean;
};

export async function loadCalendar(
  tx: Tx,
  tenantId: string,
  projectId: string,
): Promise<ProjectCalendar> {
  const row = await tx.payCalendar.findUnique({
    where: { tenantId_projectId: { tenantId, projectId } },
  });
  if (row)
    return {
      frequency: row.frequency as PayFrequency,
      anchorDate: toCalendarDate(row.anchorDate),
      paydayOffsetDays: row.paydayOffsetDays,
      minimumWageArea: row.minimumWageArea as MinimumWageArea | null,
      version: row.version,
      isDefault: false,
    };
  const settings = await loadPeriodSettings(tx, tenantId);
  return {
    ...defaultPayCalendar({
      weekEndsOn: settings.weekEndsOn as IsoWeekday,
      paydayWeekday: settings.paydayWeekday as IsoWeekday,
    }),
    minimumWageArea: null,
    version: 0,
    isDefault: true,
  };
}

export async function loadPayrollSettings(
  tx: Tx,
  tenantId: string,
): Promise<PayrollSettingsValues & { version: number }> {
  const row = await tx.payrollSettings.findUnique({ where: { tenantId } });
  if (!row) return { ...DEFAULT_PAYROLL_SETTINGS, version: 0 };
  return {
    advanceMaxMinor: money(row.advanceMaxMinor),
    advanceMaxOutstandingMinor: money(row.advanceMaxOutstandingMinor),
    recoveryMaxPercent: normaliseDecimal(row.recoveryMaxPercent.toString()),
    version: row.version,
  };
}

type RuleRow = Prisma.StatutoryRuleVersionGetPayload<object>;

export const toRuleVersion = (row: RuleRow): StatutoryRuleVersion =>
  ({
    id: row.id,
    kind: row.kind as StatutoryRuleKind,
    effectiveFrom: toCalendarDate(row.effectiveFrom),
    status: row.status as "unverified" | "verified",
    parameters: row.parameters,
  }) as StatutoryRuleVersion;

/** The rule set in force on `date`, or 409 rules-not-configured naming the missing kinds. */
export async function ruleSetOn(tx: Tx, tenantId: string, date: string) {
  const rows = await tx.statutoryRuleVersion.findMany({ where: { tenantId } });
  const { rules, missing } = selectRuleSet(rows.map(toRuleVersion), date);
  if (!rules)
    throw payrollConflict(
      "rules-not-configured",
      `No statutory rule version is in force on the pay date for: ${missing.join(", ")}.`,
    );
  return rules;
}

/** What a batch covers; `id` is chosen before the first insert so the digest can bind it. */
export type BatchTarget = {
  id: string;
  projectId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  frequency: PayFrequency;
};

const decimalText = (value: { toString(): string } | string | null) =>
  value === null ? null : normaliseDecimal(value.toString());

type LinePayload = Prisma.PayrollLineCreateManyInput & { id: string };
type EarningPayload = Prisma.PayrollEarningCreateManyInput;
type DeductionPayload = Prisma.PayrollDeductionCreateManyInput;
type RecoveryPayload = Prisma.AdvanceRecoveryCreateManyInput;
type ConsumptionPayload = Prisma.PayrollConsumptionCreateManyInput;
type ClaimPayload = Prisma.PayrollDayClaimCreateManyInput;

export type BatchRows = {
  lines: LinePayload[];
  earnings: EarningPayload[];
  deductions: DeductionPayload[];
  recoveries: RecoveryPayload[];
  consumptions: ConsumptionPayload[];
  claims: ClaimPayload[];
};

export type BuiltBatch = {
  target: BatchTarget;
  statutoryMonth: string;
  result: BatchResult;
  rules: StatutoryRuleSet;
  rows: BatchRows;
  mtdBatchIds: string[];
  digest: string;
};

type SnapshotRules = { id: string; kind: string; effectiveFrom: string; parameters: unknown }[];
type SnapshotTimesheetRules = {
  id: string;
  normalMinutes: number;
  multipliers: Record<DayType, string>;
}[];

/**
 * The canonical snapshot a batch's digest covers (the contract D4.3 approves against): the batch
 * identity and period, whether unverified rules were used, every statutory and timesheet rule
 * version's values, the earlier batches of the month it was computed against, every line with its
 * identity snapshot, payee fingerprint, components (rates and rule versions used), deductions,
 * employer costs and recoveries, every consumed source, every day claim, the exclusions and the
 * totals. Row IDs and timestamps are left out, so recalculating unchanged inputs gives the same
 * digest; rule verification status is left out (verifying later does not change what was paid).
 */
export function snapshotOf(input: {
  target: BatchTarget;
  statutoryMonth: string;
  unverifiedRules: boolean;
  rules: SnapshotRules;
  timesheetRules: SnapshotTimesheetRules;
  mtdBatchIds: readonly string[];
  rows: BatchRows;
  exclusions: unknown;
  totals: unknown;
}) {
  const byLine = <T extends { lineId: string }>(rows: readonly T[], lineId: string) =>
    rows.filter((row) => row.lineId === lineId);
  const lines = [...input.rows.lines]
    .sort((a, b) => a.labourerId.localeCompare(b.labourerId))
    .map((line) => ({
      labourerId: line.labourerId,
      workerNo: line.workerNo,
      fullName: line.fullName,
      tradeNameEn: line.tradeNameEn ?? null,
      tradeNameSw: line.tradeNameSw ?? null,
      engagementType: line.engagementType,
      rateBasis: line.rateBasis,
      halfDays: line.halfDays,
      normalMinutes: line.normalMinutes,
      otWeekdayMinutes: line.otWeekdayMinutes,
      otRestDayMinutes: line.otRestDayMinutes,
      otHolidayMinutes: line.otHolidayMinutes,
      daysWorked: line.daysWorked,
      grossMinor: money(line.grossMinor as bigint),
      statutoryBaseMinor: money(line.statutoryBaseMinor as bigint),
      statutoryWithheldMinor: money(line.statutoryWithheldMinor as bigint),
      advanceRecoveryMinor: money(line.advanceRecoveryMinor as bigint),
      otherDeductionsMinor: money(line.otherDeductionsMinor as bigint),
      netMinor: money(line.netMinor as bigint),
      employerCostMinor: money(line.employerCostMinor as bigint),
      statutoryMonth: line.statutoryMonth,
      monthToDate: line.monthToDate,
      warnings: line.warnings,
      payeePhoneBidx: line.payeePhoneBidx ?? null,
      earnings: byLine(input.rows.earnings, line.id)
        .sort((a, b) => a.position - b.position)
        .map((row) => ({
          position: row.position,
          kind: row.kind,
          category: row.category ?? null,
          workDate: row.workDate ? toCalendarDate(new Date(row.workDate)) : null,
          quantity: decimalText(row.quantity as string),
          unit: row.unit,
          rateMinor:
            row.rateMinor === null || row.rateMinor === undefined
              ? null
              : money(row.rateMinor as bigint),
          multiplier: decimalText((row.multiplier ?? null) as string | null),
          description: row.description,
          amountMinor: money(row.amountMinor as bigint),
          taxable: row.taxable,
          labourRateId: row.labourRateId ?? null,
          timesheetRuleId: row.timesheetRuleId ?? null,
          timesheetLineId: row.timesheetLineId ?? null,
          shareId: row.shareId ?? null,
          allowanceId: row.allowanceId ?? null,
        })),
      deductions: byLine(input.rows.deductions, line.id)
        .sort((a, b) => `${a.party}:${a.kind}`.localeCompare(`${b.party}:${b.kind}`))
        .map((row) => ({
          party: row.party,
          kind: row.kind,
          dueMinor: money(row.dueMinor as bigint),
          withheldMinor: money(row.withheldMinor as bigint),
          shortfallMinor: money(row.shortfallMinor as bigint),
          ruleVersionId: row.ruleVersionId,
        })),
      recoveries: byLine(input.rows.recoveries, line.id)
        .sort((a, b) => a.advanceId.localeCompare(b.advanceId))
        .map((row) => ({
          advanceId: row.advanceId,
          amountMinor: money(row.amountMinor as bigint),
          outstandingAfterMinor: money(row.outstandingAfterMinor as bigint),
        })),
    }));
  return {
    batch: {
      id: input.target.id,
      projectId: input.target.projectId,
      periodStart: input.target.periodStart,
      periodEnd: input.target.periodEnd,
      payDate: input.target.payDate,
      statutoryMonth: input.statutoryMonth,
      frequency: input.target.frequency,
      unverifiedRules: input.unverifiedRules,
    },
    rules: [...input.rules].sort((a, b) => a.id.localeCompare(b.id)),
    timesheetRules: [...input.timesheetRules].sort((a, b) => a.id.localeCompare(b.id)),
    mtdBatchIds: [...input.mtdBatchIds].sort(),
    lines,
    consumptions: input.rows.consumptions
      .map((row) => `${row.sourceKind}:${row.timesheetLineId ?? row.shareId}`)
      .sort(),
    claims: input.rows.claims
      .map((row) => `${row.labourerId}:${toCalendarDate(new Date(row.workDate))}:${row.basis}`)
      .sort(),
    exclusions: input.exclusions,
    totals: input.totals,
  };
}

export const digestOf = (snapshot: unknown) => sha256(canonicalJson(snapshot));

type TimesheetRuleRow = Prisma.TimesheetRuleVersionGetPayload<object>;
const multipliersOf = (rule: TimesheetRuleRow): Record<DayType, string> => ({
  weekday: rule.otWeekdayMultiplier.toFixed(2),
  rest_day: rule.otRestDayMultiplier.toFixed(2),
  public_holiday: rule.otHolidayMultiplier.toFixed(2),
});

/**
 * Loads a batch's inputs in the tenant transaction, runs the pure engine (packages/domain
 * computeBatch) and turns the result into rows and a digest; persists drafts. Sources consumed,
 * days claimed and advances recovered by other live batches are left out; the batch's own are
 * available to it (recalculation).
 */
@Injectable()
export class BatchBuilder {
  async compute(
    tx: Tx,
    tenantId: string,
    target: BatchTarget,
    calendar: ProjectCalendar,
    production: boolean,
  ): Promise<BuiltBatch> {
    const statutoryMonth = statutoryMonthOf(target.payDate);
    const rules = await ruleSetOn(tx, tenantId, target.payDate);
    const settings = await loadPayrollSettings(tx, tenantId);
    const periodEnd = fromCalendarDate(target.periodEnd);
    const floor = fromCalendarDate(calendar.anchorDate);
    const notOthers = { none: { activeMarker: "active", batchId: { not: target.id } } };

    const lines = await tx.timesheetLine.findMany({
      where: {
        tenantId,
        projectId: target.projectId,
        period: { status: "approved", endDate: { lte: periodEnd, gte: floor } },
        consumptions: notOthers,
      },
      include: { period: { select: { endDate: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const shares = await tx.pieceRateOutputShare.findMany({
      where: {
        tenantId,
        projectId: target.projectId,
        workDate: { lte: periodEnd, gte: floor },
        output: { status: "approved" },
        consumptions: notOthers,
      },
      include: { output: true },
      orderBy: [{ workDate: "asc" }, { id: "asc" }],
    });
    const labourerIds = [
      ...new Set([...lines.map((line) => line.labourerId), ...shares.map((s) => s.labourerId)]),
    ];
    const plainLabourers = await tx.labourer.findMany({
      where: { tenantId, id: { in: labourerIds } },
    });
    const skillLevels = await tx.skillLevel.findMany({ where: { tenantId } });
    const tradeRows = await tx.trade.findMany({ where: { tenantId } });
    const labourerRows = plainLabourers.map((row) => ({
      ...row,
      skillLevel: skillLevels.find((level) => level.id === row.skillLevelId)!,
      trade: tradeRows.find((trade) => trade.id === row.tradeId)!,
    }));
    const labourers: BatchLabourer[] = labourerRows.map((row) => ({
      id: row.id,
      workerNo: row.workerNo,
      fullName: row.fullName,
      engagementType: row.engagementType as EngagementType,
      rateBasis: row.rateBasis as RateBasis,
      tradeId: row.tradeId,
      skillLevelId: row.skillLevelId,
      occupation:
        DEFAULT_MINIMUM_WAGE_OCCUPATION[row.skillLevel.ncaCategory as NcaCategory] ?? null,
    }));
    const rates = (
      await tx.labourRate.findMany({
        where: {
          tenantId,
          OR: [{ projectId: target.projectId }, { projectId: null }],
          AND: [{ OR: [{ labourerId: null }, { labourerId: { in: labourerIds } }] }],
        },
      })
    ).map((row) => ({
      id: row.id,
      projectId: row.projectId,
      labourerId: row.labourerId,
      tradeId: row.tradeId,
      skillLevelId: row.skillLevelId,
      basis: row.basis as RateBasis,
      rateMinor: money(row.rateMinor),
      effectiveFrom: toCalendarDate(row.effectiveFrom),
    }));
    const ruleRows = await tx.timesheetRuleVersion.findMany({ where: { tenantId } });
    const timesheetRules = new Map<string, TimesheetRuleRef>(
      ruleRows.map((row) => [
        row.id,
        {
          id: row.id,
          normalMinutes: row.normalMinutes,
          multipliers: multipliersOf(row),
          verified: row.complianceStatus === "approved",
        },
      ]),
    );
    const allowances = (
      await tx.payrollAllowance.findMany({ where: { tenantId, projectId: target.projectId } })
    ).map((row) => ({
      id: row.id,
      code: row.code,
      nameEn: row.nameEn,
      basis: row.basis as "per_day_worked" | "per_period",
      amountMinor: money(row.amountMinor),
      taxable: row.taxable,
      tradeId: row.tradeId,
      labourerId: row.labourerId,
      effectiveFrom: toCalendarDate(row.effectiveFrom),
      endedOn: row.endedOn ? toCalendarDate(row.endedOn) : null,
    }));

    // Earlier submitted batches of the statutory month (company-wide), excluding this one.
    const priorLines = labourerIds.length
      ? await tx.payrollLine.findMany({
          where: {
            tenantId,
            statutoryMonth,
            labourerId: { in: labourerIds },
            batch: { status: "submitted", id: { not: target.id } },
          },
          include: { deductions: true },
        })
      : [];
    const prior = new Map<string, PriorMonth>();
    const mtdBatchIds = new Set<string>();
    for (const line of priorLines) {
      const entry = prior.get(line.labourerId) ?? emptyPriorMonth();
      entry.baseMinor += money(line.statutoryBaseMinor);
      for (const deduction of line.deductions) {
        if (deduction.party === "employee")
          entry.withheld[deduction.kind as EmployeeStatutory] += money(deduction.withheldMinor);
        else entry.employer[deduction.kind as EmployerCost] += money(deduction.withheldMinor);
      }
      if (!entry.batchIds.includes(line.batchId)) entry.batchIds.push(line.batchId);
      entry.batchIds.sort();
      prior.set(line.labourerId, entry);
      mtdBatchIds.add(line.batchId);
    }

    // Disbursed advances on this project with what other live batches already recover.
    const advanceRows = labourerIds.length
      ? await tx.salaryAdvance.findMany({
          where: {
            tenantId,
            projectId: target.projectId,
            status: "disbursed",
            labourerId: { in: labourerIds },
            paidOn: { lte: fromCalendarDate(target.payDate) },
          },
          include: {
            recoveries: {
              where: {
                batchId: { not: target.id },
                line: { batch: { status: { not: "cancelled" } } },
              },
            },
          },
        })
      : [];
    const advances = new Map<string, AdvanceBalance[]>();
    for (const row of advanceRows) {
      const recovered = row.recoveries.reduce((sum, entry) => sum + money(entry.amountMinor), 0);
      const list = advances.get(row.labourerId) ?? [];
      list.push({
        id: row.id,
        outstandingMinor: money(row.amountMinor) - recovered,
        instalmentMinor: row.instalmentMinor === null ? null : money(row.instalmentMinor),
        maxRecoveryPercent:
          row.maxRecoveryPercent === null
            ? null
            : normaliseDecimal(row.maxRecoveryPercent.toString()),
        disbursedOn: row.paidOn ? toCalendarDate(row.paidOn) : target.payDate,
      });
      advances.set(row.labourerId, list);
    }

    const claims: DayClaim[] = labourerIds.length
      ? (
          await tx.payrollDayClaim.findMany({
            where: {
              tenantId,
              labourerId: { in: labourerIds },
              activeMarker: "active",
              batchId: { not: target.id },
            },
          })
        ).map((row) => ({
          labourerId: row.labourerId,
          date: toCalendarDate(row.workDate),
          basis: row.basis as "attendance" | "piece_rate",
        }))
      : [];
    const minimumWages: MinimumWageRow[] = (
      await tx.minimumWageRate.findMany({ where: { tenantId } })
    ).map((row) => ({
      id: row.id,
      area: row.area as MinimumWageArea,
      occupation: row.occupation as MinimumWageOccupation,
      effectiveFrom: toCalendarDate(row.effectiveFrom),
      monthlyMinor: money(row.monthlyMinor),
      dailyMinor: row.dailyMinor === null ? null : money(row.dailyMinor),
      hourlyMinor: row.hourlyMinor === null ? null : money(row.hourlyMinor),
    }));

    const input: BatchInput = {
      projectId: target.projectId,
      periodStart: target.periodStart,
      periodEnd: target.periodEnd,
      payDate: target.payDate,
      rules,
      labourers,
      rates,
      timesheetRules,
      lines: lines.map((line) => ({
        id: line.id,
        labourerId: line.labourerId,
        kind: line.kind as "attendance" | "adjustment",
        periodId: line.periodId,
        periodEndDate: toCalendarDate(line.period.endDate),
        days: (line.days as unknown as TimesheetLineWire["days"]).map((day) => ({
          date: day.date,
          dayType: day.dayType,
          ruleVersionId: day.ruleVersionId,
          halfDays: day.totals.halfDays,
          normalMinutes: day.totals.normalMinutes,
          overtimeMinutes: { ...day.totals.overtimeMinutes },
        })),
      })),
      shares: shares.map((share) => ({
        id: share.id,
        outputId: share.outputId,
        labourerId: share.labourerId,
        workDate: toCalendarDate(share.workDate),
        amountMinor: money(share.amountMinor),
        description: share.output.description,
        quantity: normaliseDecimal(share.output.quantity.toString()),
        unit: share.output.unit,
        rateMinor: money(share.output.rateMinor),
      })),
      allowances,
      prior,
      advances,
      claims,
      recoveryMaxPercent: settings.recoveryMaxPercent,
      allowUnverifiedTimesheetRules: !production,
      minimumWageArea: calendar.minimumWageArea,
      minimumWages,
    };
    const result = computeBatch(input);
    const byLabourer = new Map(labourerRows.map((row) => [row.id, row]));
    const rows = this.rows(tenantId, target, statutoryMonth, result, byLabourer);
    const usedTimesheetRules = ruleRows.filter((row) => result.timesheetRuleIds.includes(row.id));
    const usedMtd = [...mtdBatchIds].filter((id) =>
      result.lines.some((line) => line.prior.batchIds.includes(id)),
    );
    const snapshot = snapshotOf({
      target,
      statutoryMonth,
      unverifiedRules: result.unverified,
      rules: ruleSetVersions(rules).map((rule) => ({
        id: rule.id,
        kind: rule.kind,
        effectiveFrom: rule.effectiveFrom,
        parameters: rule.parameters,
      })),
      timesheetRules: usedTimesheetRules.map((row) => ({
        id: row.id,
        normalMinutes: row.normalMinutes,
        multipliers: multipliersOf(row),
      })),
      mtdBatchIds: usedMtd,
      rows,
      exclusions: result.exclusions,
      totals: result.totals,
    });
    return {
      target,
      statutoryMonth,
      result,
      rules,
      rows,
      mtdBatchIds: usedMtd.sort(),
      digest: digestOf(snapshot),
    };
  }

  /** Database rows for a computed batch (IDs chosen here; never part of the digest). */
  private rows(
    tenantId: string,
    target: BatchTarget,
    statutoryMonth: string,
    result: BatchResult,
    labourers: Map<string, { phoneBidx: string | null; trade: { nameEn: string; nameSw: string } }>,
  ): BatchRows {
    const rows: BatchRows = {
      lines: [],
      earnings: [],
      deductions: [],
      recoveries: [],
      consumptions: [],
      claims: [],
    };
    const base = { tenantId, batchId: target.id };
    for (const line of result.lines) {
      const id = uuidv7();
      const labourer = labourers.get(line.labourer.id);
      const withheld = EMPLOYEE_STATUTORY.reduce(
        (sum, item) => sum + line.statutory.withheld[item],
        0,
      );
      rows.lines.push({
        ...base,
        id,
        projectId: target.projectId,
        labourerId: line.labourer.id,
        workerNo: line.labourer.workerNo,
        fullName: line.labourer.fullName,
        tradeNameEn: labourer?.trade.nameEn ?? null,
        tradeNameSw: labourer?.trade.nameSw ?? null,
        engagementType: line.labourer.engagementType,
        rateBasis: line.labourer.rateBasis,
        halfDays: line.summary.halfDays,
        normalMinutes: line.summary.normalMinutes,
        otWeekdayMinutes: line.summary.overtimeMinutes.weekday,
        otRestDayMinutes: line.summary.overtimeMinutes.rest_day,
        otHolidayMinutes: line.summary.overtimeMinutes.public_holiday,
        daysWorked: line.summary.daysWorked,
        grossMinor: BigInt(line.grossMinor),
        statutoryBaseMinor: BigInt(line.statutoryBaseMinor),
        statutoryWithheldMinor: BigInt(withheld),
        advanceRecoveryMinor: BigInt(
          line.recoveries.reduce((sum, entry) => sum + entry.amountMinor, 0),
        ),
        otherDeductionsMinor: BigInt(line.otherDeductionsMinor),
        netMinor: BigInt(line.netMinor),
        employerCostMinor: BigInt(line.employerCostMinor),
        statutoryMonth,
        monthToDate: {
          statutoryMonth,
          priorBatchIds: line.prior.batchIds,
          prior: {
            baseMinor: line.prior.baseMinor,
            withheld: line.prior.withheld,
            employer: line.prior.employer,
          },
          cumulativeBaseMinor: line.statutory.cumulativeBaseMinor,
          monthly: {
            employee: line.statutory.monthly.employee,
            employer: line.statutory.monthly.employer,
            nssf: line.statutory.monthly.nssf,
            taxablePayMinor: line.statutory.monthly.taxablePayMinor,
            payeBeforeReliefMinor: line.statutory.monthly.payeBeforeReliefMinor,
            personalReliefMinor: line.statutory.monthly.personalReliefMinor,
          },
          summary: {
            pieceRateDays: line.summary.pieceRateDays,
            replacedDays: line.summary.replacedDays,
          },
        },
        warnings: line.warnings as unknown as Prisma.InputJsonValue,
        payeePhoneBidx: labourer?.phoneBidx ?? null,
      });
      line.earnings.forEach((earning, position) =>
        rows.earnings.push({
          ...base,
          id: uuidv7(),
          lineId: id,
          position,
          kind: earning.kind,
          category: earning.category,
          workDate: earning.date ? fromCalendarDate(earning.date) : null,
          quantity: earning.quantity,
          unit: earning.unit,
          rateMinor: earning.rateMinor === null ? null : BigInt(earning.rateMinor),
          multiplier: earning.multiplier,
          description: earning.description,
          amountMinor: BigInt(earning.amountMinor),
          taxable: earning.taxable,
          labourRateId: earning.labourRateId,
          timesheetRuleId: earning.timesheetRuleId,
          timesheetLineId: earning.sourceKind === "timesheet_line" ? earning.sourceId : null,
          shareId: earning.sourceKind === "piece_rate_share" ? earning.sourceId : null,
          allowanceId: earning.sourceKind === "allowance" ? earning.sourceId : null,
        }),
      );
      for (const item of EMPLOYEE_STATUTORY) {
        const kind = item;
        rows.deductions.push({
          ...base,
          id: uuidv7(),
          lineId: id,
          party: "employee",
          kind,
          dueMinor: BigInt(line.statutory.due[item]),
          withheldMinor: BigInt(line.statutory.withheld[item]),
          shortfallMinor: BigInt(line.statutory.shortfall[item]),
          ruleVersionId: ruleIdFor(kind, result),
        });
      }
      for (const item of EMPLOYER_COSTS)
        rows.deductions.push({
          ...base,
          id: uuidv7(),
          lineId: id,
          party: "employer",
          kind: item,
          dueMinor: BigInt(line.statutory.employer[item]),
          withheldMinor: BigInt(line.statutory.employer[item]),
          shortfallMinor: 0n,
          ruleVersionId: ruleIdFor(item, result),
        });
      for (const recovery of line.recoveries)
        rows.recoveries.push({
          ...base,
          id: uuidv7(),
          lineId: id,
          advanceId: recovery.advanceId,
          amountMinor: BigInt(recovery.amountMinor),
          outstandingAfterMinor: BigInt(recovery.outstandingAfterMinor),
        });
      for (const timesheetLineId of line.timesheetLineIds)
        rows.consumptions.push({
          ...base,
          id: uuidv7(),
          projectId: target.projectId,
          sourceKind: "timesheet_line",
          timesheetLineId,
        });
      for (const shareId of line.pieceRateShareIds)
        rows.consumptions.push({
          ...base,
          id: uuidv7(),
          projectId: target.projectId,
          sourceKind: "piece_rate_share",
          shareId,
        });
      for (const claim of line.claims)
        rows.claims.push({
          ...base,
          id: uuidv7(),
          projectId: target.projectId,
          labourerId: claim.labourerId,
          workDate: fromCalendarDate(claim.date),
          basis: claim.basis,
        });
    }
    return rows;
  }

  /** Writes a computed draft: creates the batch, or replaces the draft's rows (expected version). */
  async persist(
    tx: Tx,
    tenantId: string,
    userId: string,
    built: BuiltBatch,
    existingVersion: number | null,
  ) {
    const { target, result } = built;
    const calc = {
      unverifiedRules: result.unverified,
      lineCount: result.lines.length,
      grossMinor: BigInt(result.totals.grossMinor),
      totalDeductionsMinor: BigInt(result.totals.totalDeductionsMinor),
      netMinor: BigInt(result.totals.netMinor),
      employerCostMinor: BigInt(result.totals.employerCostMinor),
      totals: result.totals as unknown as Prisma.InputJsonValue,
      exclusions: result.exclusions as unknown as Prisma.InputJsonValue,
      ruleVersionIds: result.ruleVersionIds,
      timesheetRuleIds: result.timesheetRuleIds,
      mtdBatchIds: built.mtdBatchIds,
      digest: built.digest,
      calculatedBy: userId,
    };
    if (existingVersion === null) {
      await tx.payrollBatch.create({
        data: {
          id: target.id,
          tenantId,
          projectId: target.projectId,
          periodStart: fromCalendarDate(target.periodStart),
          periodEnd: fromCalendarDate(target.periodEnd),
          payDate: fromCalendarDate(target.payDate),
          statutoryMonth: built.statutoryMonth,
          frequency: target.frequency,
          createdBy: userId,
          ...calc,
        },
      });
    } else {
      await tx.payrollDayClaim.deleteMany({ where: { tenantId, batchId: target.id } });
      await tx.payrollConsumption.deleteMany({ where: { tenantId, batchId: target.id } });
      await tx.payrollLine.deleteMany({ where: { tenantId, batchId: target.id } });
      const updated = await tx.payrollBatch.updateMany({
        where: { tenantId, id: target.id, version: existingVersion, status: "draft" },
        data: { ...calc, version: { increment: 1 } },
      });
      if (!updated.count) throw versionConflict();
    }
    const { rows } = built;
    if (rows.lines.length) await tx.payrollLine.createMany({ data: rows.lines });
    if (rows.earnings.length) await tx.payrollEarning.createMany({ data: rows.earnings });
    if (rows.deductions.length) await tx.payrollDeduction.createMany({ data: rows.deductions });
    if (rows.recoveries.length) await tx.advanceRecovery.createMany({ data: rows.recoveries });
    if (rows.consumptions.length)
      await tx.payrollConsumption.createMany({ data: rows.consumptions });
    if (rows.claims.length) await tx.payrollDayClaim.createMany({ data: rows.claims });
  }

  /** The stored snapshot of a batch, rebuilt from its rows, and its digest (integrity check). */
  async storedSnapshot(tx: Tx, tenantId: string, batchId: string) {
    const batch = await tx.payrollBatch.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: batchId } },
    });
    const lines = await tx.payrollLine.findMany({ where: { tenantId, batchId } });
    const rows: BatchRows = {
      lines: lines.map((line) => ({
        ...line,
        monthToDate: line.monthToDate as Prisma.InputJsonValue,
        warnings: line.warnings as Prisma.InputJsonValue,
      })),
      earnings: (await tx.payrollEarning.findMany({ where: { tenantId, batchId } })).map((row) => ({
        ...row,
        quantity: row.quantity.toString(),
        multiplier: row.multiplier === null ? null : row.multiplier.toString(),
      })),
      deductions: await tx.payrollDeduction.findMany({ where: { tenantId, batchId } }),
      recoveries: await tx.advanceRecovery.findMany({ where: { tenantId, batchId } }),
      consumptions: await tx.payrollConsumption.findMany({ where: { tenantId, batchId } }),
      claims: await tx.payrollDayClaim.findMany({ where: { tenantId, batchId } }),
    };
    const rules = await tx.statutoryRuleVersion.findMany({
      where: { tenantId, id: { in: batch.ruleVersionIds } },
    });
    const timesheetRules = await tx.timesheetRuleVersion.findMany({
      where: { tenantId, id: { in: batch.timesheetRuleIds } },
    });
    const snapshot = snapshotOf({
      target: {
        id: batch.id,
        projectId: batch.projectId,
        periodStart: toCalendarDate(batch.periodStart),
        periodEnd: toCalendarDate(batch.periodEnd),
        payDate: toCalendarDate(batch.payDate),
        frequency: batch.frequency as PayFrequency,
      },
      statutoryMonth: batch.statutoryMonth,
      unverifiedRules: batch.unverifiedRules,
      rules: rules.map((row) => ({
        id: row.id,
        kind: row.kind,
        effectiveFrom: toCalendarDate(row.effectiveFrom),
        parameters: row.parameters,
      })),
      timesheetRules: timesheetRules.map((row) => ({
        id: row.id,
        normalMinutes: row.normalMinutes,
        multipliers: multipliersOf(row),
      })),
      mtdBatchIds: batch.mtdBatchIds,
      rows,
      exclusions: batch.exclusions,
      totals: batch.totals,
    });
    return { batch, snapshot, digest: digestOf(snapshot) };
  }
}

/** The rule version an employee deduction or employer cost was computed with. */
function ruleIdFor(kind: EmployeeStatutory | EmployerCost, result: BatchResult): string {
  const order: Record<EmployeeStatutory | EmployerCost, number> = {
    paye: 0,
    nssf: 1,
    shif: 2,
    ahl: 3,
    nssf_employer: 1,
    ahl_employer: 3,
    nita: 4,
  };
  const id = result.ruleVersionIds[order[kind]];
  if (!id) throw new Error(`No rule version for ${kind}`);
  return id;
}
