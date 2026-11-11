import { addCalendarDays, formatHalfDays } from "@pm-buddy/domain";
import {
  EMPLOYEE_STATUTORY,
  type EngagementType,
  type MinimumWageArea,
  type MinimumWageOccupation,
  type PayFrequency,
  type PayrollBatchStatus,
  type RateBasis,
  type StatutoryRuleKind,
} from "@pm-buddy/types";
import type {
  PayrollBatch,
  PayrollLineSummary,
  PayrollWarning,
  StatutoryRule,
  MinimumWage,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import { toCalendarDate } from "../projects/project-mappers.js";
import { money } from "./payroll-support.js";

export type Names = ReadonlyMap<string, string>;
export const actor = (names: Names, id: string) => ({ id, displayName: names.get(id) ?? "—" });
export const optionalActor = (names: Names, id: string | null) => (id ? actor(names, id) : null);
export const iso = (value: Date | null) => (value ? value.toISOString() : null);

export type BatchRow = Prisma.PayrollBatchGetPayload<object>;

export const batchNames = (row: BatchRow) => [row.createdBy, row.submittedBy, row.cancelledBy];

export function toBatch(row: BatchRow, names: Names): PayrollBatch {
  return {
    id: row.id,
    projectId: row.projectId,
    periodStart: toCalendarDate(row.periodStart),
    periodEnd: toCalendarDate(row.periodEnd),
    payDate: toCalendarDate(row.payDate),
    statutoryMonth: row.statutoryMonth,
    frequency: row.frequency as PayFrequency,
    status: row.status as PayrollBatchStatus,
    version: row.version,
    unverifiedRules: row.unverifiedRules,
    lineCount: row.lineCount,
    grossMinor: money(row.grossMinor),
    totalDeductionsMinor: money(row.totalDeductionsMinor),
    netMinor: money(row.netMinor),
    employerCostMinor: money(row.employerCostMinor),
    digest: row.digest,
    calculatedAt: row.calculatedAt.toISOString(),
    createdBy: actor(names, row.createdBy),
    createdAt: row.createdAt.toISOString(),
    submittedBy: optionalActor(names, row.submittedBy),
    submittedAt: iso(row.submittedAt),
    cancelledBy: optionalActor(names, row.cancelledBy),
    cancelledAt: iso(row.cancelledAt),
    cancellationReason: row.cancellationReason,
  };
}

type RuleRow = Prisma.StatutoryRuleVersionGetPayload<object>;

/** A rule version with its derived end date (the day before the next version of its kind). */
export function toRule(
  row: RuleRow,
  all: readonly RuleRow[],
  today: string,
  names: Names,
  submittedBatches: number,
): StatutoryRule {
  const from = toCalendarDate(row.effectiveFrom);
  const next = all
    .filter((other) => other.kind === row.kind && toCalendarDate(other.effectiveFrom) > from)
    .map((other) => toCalendarDate(other.effectiveFrom))
    .sort()[0];
  const effectiveTo = next ? addCalendarDays(next, -1) : null;
  return {
    id: row.id,
    kind: row.kind as StatutoryRuleKind,
    effectiveFrom: from,
    effectiveTo,
    inForce: from <= today && (effectiveTo === null || effectiveTo >= today),
    parameters: row.parameters as StatutoryRule["parameters"],
    status: row.status as StatutoryRule["status"],
    sourceReference: row.sourceReference,
    notes: row.notes,
    createdBy: actor(names, row.createdBy),
    createdAt: row.createdAt.toISOString(),
    verifiedBy: optionalActor(names, row.verifiedBy),
    verifiedAt: iso(row.verifiedAt),
    verificationNote: row.verificationNote,
    submittedBatches,
  };
}

export function toMinimumWage(row: Prisma.MinimumWageRateGetPayload<object>): MinimumWage {
  return {
    id: row.id,
    effectiveFrom: toCalendarDate(row.effectiveFrom),
    area: row.area as MinimumWageArea,
    occupation: row.occupation as MinimumWageOccupation,
    monthlyMinor: money(row.monthlyMinor),
    dailyMinor: row.dailyMinor === null ? null : money(row.dailyMinor),
    hourlyMinor: row.hourlyMinor === null ? null : money(row.hourlyMinor),
    source: row.source,
    status: row.complianceStatus as MinimumWage["status"],
    createdAt: row.createdAt.toISOString(),
  };
}

export type LineRow = Prisma.PayrollLineGetPayload<object>;

export function toLineSummary(row: LineRow): PayrollLineSummary {
  return {
    id: row.id,
    labourer: { id: row.labourerId, workerNo: row.workerNo, fullName: row.fullName },
    engagementType: row.engagementType as EngagementType,
    rateBasis: row.rateBasis as RateBasis,
    days: formatHalfDays(row.halfDays),
    daysWorked: row.daysWorked,
    halfDays: row.halfDays,
    normalMinutes: row.normalMinutes,
    overtimeMinutes: {
      weekday: row.otWeekdayMinutes,
      rest_day: row.otRestDayMinutes,
      public_holiday: row.otHolidayMinutes,
    },
    grossMinor: money(row.grossMinor),
    statutoryWithheldMinor: money(row.statutoryWithheldMinor),
    advanceRecoveryMinor: money(row.advanceRecoveryMinor),
    netMinor: money(row.netMinor),
    employerCostMinor: money(row.employerCostMinor),
    warnings: row.warnings as unknown as PayrollWarning[],
  };
}

export const employeeKinds = EMPLOYEE_STATUTORY;
