import {
  addCalendarDays,
  formatClock,
  formatHalfDays,
  parseClock,
  type DayRule,
  type RecordAllocationValues,
  type TimesheetTotals,
} from "@pm-buddy/domain";
import type { AttendanceStatus, DayType, IsoWeekday, RuleComplianceStatus } from "@pm-buddy/types";
import type {
  AttendanceEntryValues,
  Correction,
  TimesheetRule,
  TimesheetTotalsWire,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import { toCalendarDate } from "../projects/project-mappers.js";

export type RuleRow = Prisma.TimesheetRuleVersionGetPayload<object>;
export type RecordRow = Prisma.AttendanceRecordGetPayload<object>;
export type DayRow = Prisma.AttendanceDayGetPayload<object>;
export type PeriodRow = Prisma.TimesheetPeriodGetPayload<object>;
export type CorrectionRow = Prisma.AttendanceCorrectionGetPayload<object>;
export type AnomalyRow = Prisma.AttendanceAnomalyGetPayload<object>;
export type AdjustmentRow = Prisma.TimesheetAdjustmentGetPayload<object>;
export type HolidayRow = Prisma.PublicHolidayGetPayload<object>;
export type Names = ReadonlyMap<string, string>;

export const toClock = (minutes: number | null): string | null =>
  minutes === null ? null : formatClock(minutes);
export const fromClock = (value: string | null): number | null =>
  value === null ? null : parseClock(value);

export const actor = (names: Names, id: string) => ({ id, displayName: names.get(id) ?? "—" });
export const optionalActor = (names: Names, id: string | null) => (id ? actor(names, id) : null);
export const iso = (value: Date | null) => (value ? value.toISOString() : null);

/** A rule version as the domain computation needs it. */
export function dayRule(row: RuleRow): DayRule {
  return {
    id: row.id,
    normalMinutes: row.normalMinutes,
    defaultBreakMinutes: row.defaultBreakMinutes,
    breakAfterMinutes: row.breakAfterMinutes,
    dayStartMinutes: row.dayStartMinutes,
    lateGraceMinutes: row.lateGraceMinutes,
    halfDayThresholdMinutes: row.halfDayThresholdMinutes,
    maxPlausibleMinutes: row.maxPlausibleMinutes,
    restDays: row.restDays as IsoWeekday[],
    otWeekdayMultiplier: row.otWeekdayMultiplier.toFixed(2),
    otRestDayMultiplier: row.otRestDayMultiplier.toFixed(2),
    otHolidayMultiplier: row.otHolidayMultiplier.toFixed(2),
  };
}

export const ruleKey = (row: Pick<RuleRow, "projectId" | "effectiveFrom" | "id">) => ({
  id: row.id,
  projectId: row.projectId,
  effectiveFrom: toCalendarDate(row.effectiveFrom),
});

export function toRule(
  row: RuleRow,
  all: readonly RuleRow[],
  today: string,
  names: Names,
  projectCodes: ReadonlyMap<string, string>,
): TimesheetRule {
  const effectiveFrom = toCalendarDate(row.effectiveFrom);
  const next = all
    .filter((other) => other.projectId === row.projectId)
    .map((other) => toCalendarDate(other.effectiveFrom))
    .filter((date) => date > effectiveFrom)
    .sort()[0];
  const effectiveTo = next ? addCalendarDays(next, -1) : null;
  const values = dayRule(row);
  return {
    id: row.id,
    projectId: row.projectId,
    projectCode: row.projectId ? (projectCodes.get(row.projectId) ?? null) : null,
    effectiveFrom,
    effectiveTo,
    inForce: effectiveFrom <= today && (effectiveTo === null || effectiveTo >= today),
    scheduled: effectiveFrom > today,
    normalMinutes: values.normalMinutes,
    defaultBreakMinutes: values.defaultBreakMinutes,
    breakAfterMinutes: values.breakAfterMinutes,
    dayStartMinutes: values.dayStartMinutes,
    lateGraceMinutes: values.lateGraceMinutes,
    halfDayThresholdMinutes: values.halfDayThresholdMinutes,
    maxPlausibleMinutes: values.maxPlausibleMinutes,
    restDays: [...values.restDays].sort((a, b) => a - b),
    otWeekdayMultiplier: values.otWeekdayMultiplier,
    otRestDayMultiplier: values.otRestDayMultiplier,
    otHolidayMultiplier: values.otHolidayMultiplier,
    complianceStatus: row.complianceStatus as RuleComplianceStatus,
    sourceReference: row.sourceReference,
    createdAt: row.createdAt.toISOString(),
    createdBy: actor(names, row.createdBy),
  };
}

export function totalsWire(totals: TimesheetTotals): TimesheetTotalsWire {
  return {
    days: formatHalfDays(totals.halfDays),
    halfDays: totals.halfDays,
    workedMinutes: totals.workedMinutes,
    normalMinutes: totals.normalMinutes,
    overtimeMinutes: { ...totals.overtimeMinutes },
    lateMinutes: totals.lateMinutes,
    statusCounts: { ...totals.statusCounts },
  };
}

export function totalsFromWire(wire: TimesheetTotalsWire): TimesheetTotals {
  return {
    halfDays: wire.halfDays,
    workedMinutes: wire.workedMinutes,
    normalMinutes: wire.normalMinutes,
    overtimeMinutes: { ...wire.overtimeMinutes },
    lateMinutes: wire.lateMinutes,
    statusCounts: { ...wire.statusCounts },
  };
}

/** A record's values as shown on the muster roll and stored on corrections and adjustments. */
export function entryValues(record: {
  status: string;
  checkInMinutes: number | null;
  checkOutMinutes: number | null;
  overnight: boolean;
  breakMinutes: number | null;
  notes: string | null;
}): AttendanceEntryValues {
  return {
    status: record.status as AttendanceStatus,
    checkIn: toClock(record.checkInMinutes),
    checkOut: toClock(record.checkOutMinutes),
    overnight: record.overnight,
    breakMinutes: record.breakMinutes,
    notes: record.notes,
  };
}

/** Database columns from entry values. */
export function entryColumns(values: AttendanceEntryValues) {
  return {
    status: values.status,
    checkInMinutes: fromClock(values.checkIn),
    checkOutMinutes: fromClock(values.checkOut),
    overnight: values.overnight,
    breakMinutes: values.breakMinutes,
    notes: values.notes,
  };
}

/** One labourer-day of an approved line, as stored in `timesheet_lines.days`. */
export type StoredDay = {
  date: string;
  dayType: DayType;
  /** Null only while no rule is configured (such a period cannot be submitted). */
  ruleVersionId: string | null;
  totals: TimesheetTotalsWire;
  recordIds: string[];
  allocations: (RecordAllocationValues & { recordId: string })[];
};

/** The stored delta of an approved adjustment (`timesheet_adjustments.delta`). */
export type StoredDelta = {
  totals: TimesheetTotalsWire;
  dayType: DayType;
  before: RecordAllocationValues | null;
  after: RecordAllocationValues;
};

export function toCorrection(
  row: CorrectionRow,
  names: Names,
  labourer: { workerNo: string; fullName: string } | null,
): Correction {
  return {
    id: row.id,
    dayId: row.dayId,
    recordId: row.recordId,
    labourerId: row.labourerId,
    workerNo: labourer?.workerNo ?? "—",
    fullName: labourer?.fullName ?? "—",
    siteId: row.siteId,
    date: toCalendarDate(row.workDate),
    proposed: row.proposed as unknown as AttendanceEntryValues,
    previous: (row.previous as unknown as AttendanceEntryValues | null) ?? null,
    reason: row.reason,
    status: row.status as Correction["status"],
    requestedBy: actor(names, row.requestedBy),
    requestedAt: row.requestedAt.toISOString(),
    decidedBy: optionalActor(names, row.decidedBy),
    decidedAt: iso(row.decidedAt),
    decisionNote: row.decisionNote,
    version: row.version,
  };
}
