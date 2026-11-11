import { Injectable } from "@nestjs/common";
import {
  addTotals,
  computeLabourerDay,
  emptyTotals,
  resolveTimesheetRule,
  sumDays,
  timesheetDays,
  type DayRecord,
  type DayRule,
  type LabourerDayResult,
  type RecordAllocationValues,
  type TimesheetDay,
  type TimesheetTotals,
} from "@pm-buddy/domain";
import type { AttendanceEntryValues, TimesheetLine } from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import { canonicalJson, sha256 } from "./attendance-support.js";
import {
  dayRule,
  fromClock,
  ruleKey,
  totalsFromWire,
  totalsWire,
  type AdjustmentRow,
  type PeriodRow,
  type RecordRow,
  type RuleRow,
  type StoredDay,
  type StoredDelta,
} from "./attendance-mappers.js";

type Tx = Prisma.TransactionClient;

export type CalcContext = {
  rules: RuleRow[];
  holidays: Set<string>;
  holidayNames: Map<string, { nameEn: string; nameSw: string }>;
};

/** A day input record with where it came from (a stored record or an approved adjustment). */
export type EffectiveRecord = DayRecord & {
  labourerId: string;
  date: string;
  /** The record's period is approved (its allocation is the snapshot). */
  fromLockedPeriod: boolean;
};

export const dayKey = (labourerId: string, date: string) => `${labourerId}|${date}`;

/** The values of a record as a domain day record. */
export function dayRecordOf(record: RecordRow): DayRecord {
  return {
    id: record.id,
    projectId: record.projectId,
    siteId: record.siteId,
    status: record.status as DayRecord["status"],
    checkIn: record.checkInMinutes,
    checkOut: record.checkOutMinutes,
    overnight: record.overnight,
    breakMinutes: record.breakMinutes,
  };
}

export function overlayValues(base: DayRecord, values: AttendanceEntryValues): DayRecord {
  return {
    ...base,
    status: values.status,
    checkIn: fromClock(values.checkIn),
    checkOut: fromClock(values.checkOut),
    overnight: values.overnight,
    breakMinutes: values.breakMinutes,
  };
}

export type ComputedLine = {
  line: Omit<TimesheetLine, "workerNo" | "fullName">;
  stored: StoredDay[];
};

/**
 * Loads what the timesheet computation needs and runs it (packages/domain does the arithmetic):
 * rule versions, holidays, every record of the labourers concerned on every site and project,
 * approved snapshot allocations (locked) and approved adjustments (overlays). Queries run one at a
 * time because a transaction has one connection.
 */
@Injectable()
export class TimesheetCalculator {
  async context(tx: Tx, tenantId: string): Promise<CalcContext> {
    const rules = await tx.timesheetRuleVersion.findMany({
      where: { tenantId },
      orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }],
    });
    const holidays = await tx.publicHoliday.findMany({ where: { tenantId } });
    return {
      rules,
      holidays: new Set(holidays.map((holiday) => toCalendarDate(holiday.holidayDate))),
      holidayNames: new Map(
        holidays.map((holiday) => [
          toCalendarDate(holiday.holidayDate),
          { nameEn: holiday.nameEn, nameSw: holiday.nameSw },
        ]),
      ),
    };
  }

  ruleRow(ctx: CalcContext, projectId: string, date: string): RuleRow | null {
    const key = resolveTimesheetRule(ctx.rules.map(ruleKey), projectId, date);
    return key ? (ctx.rules.find((rule) => rule.id === key.id) ?? null) : null;
  }

  ruleFor(ctx: CalcContext, date: string): (projectId: string) => DayRule | null {
    return (projectId) => {
      const row = this.ruleRow(ctx, projectId, date);
      return row ? dayRule(row) : null;
    };
  }

  /**
   * Effective day inputs for labourers between two dates, keyed by labourer and date. Records in
   * approved periods carry their snapshot allocation; an approved adjustment replaces the values of
   * its site's record (or adds one) and carries the allocation it was approved with.
   */
  async inputs(
    tx: Tx,
    tenantId: string,
    labourerIds: readonly string[],
    from: string,
    to: string,
  ): Promise<Map<string, EffectiveRecord[]>> {
    const result = new Map<string, EffectiveRecord[]>();
    if (!labourerIds.length) return result;
    const range = { gte: fromCalendarDate(from), lte: fromCalendarDate(to) };
    const records = await tx.attendanceRecord.findMany({
      where: { tenantId, labourerId: { in: [...labourerIds] }, workDate: range },
      orderBy: [{ workDate: "asc" }, { createdAt: "asc" }],
    });
    const dayIds = [...new Set(records.map((record) => record.dayId))];
    const days = dayIds.length
      ? await tx.attendanceDay.findMany({
          where: { tenantId, id: { in: dayIds } },
          select: { id: true, periodId: true },
        })
      : [];
    const periodIds = [...new Set(days.map((day) => day.periodId))];
    const approved = periodIds.length
      ? await tx.timesheetPeriod.findMany({
          where: { tenantId, id: { in: periodIds }, status: "approved" },
          select: { id: true },
        })
      : [];
    const approvedIds = new Set(approved.map((period) => period.id));
    const locked = new Map<string, RecordAllocationValues>();
    if (approvedIds.size) {
      const lines = await tx.timesheetLine.findMany({
        where: {
          tenantId,
          periodId: { in: [...approvedIds] },
          kind: "attendance",
          labourerId: { in: [...labourerIds] },
        },
        select: { days: true },
      });
      for (const line of lines)
        for (const day of line.days as unknown as StoredDay[])
          for (const allocation of day.allocations) {
            const { recordId, ...values } = allocation;
            locked.set(recordId, values);
          }
    }
    const periodOfDay = new Map(days.map((day) => [day.id, day.periodId]));
    for (const record of records) {
      const date = toCalendarDate(record.workDate);
      const lockedPeriod = approvedIds.has(periodOfDay.get(record.dayId) ?? "");
      const key = dayKey(record.labourerId, date);
      const list = result.get(key) ?? [];
      list.push({
        ...dayRecordOf(record),
        labourerId: record.labourerId,
        date,
        fromLockedPeriod: lockedPeriod,
        // A record in an approved period without a snapshot allocation was not paid there.
        locked: lockedPeriod ? (locked.get(record.id) ?? zeroAllocation()) : null,
      });
      result.set(key, list);
    }
    const adjustments = await tx.timesheetAdjustment.findMany({
      where: {
        tenantId,
        labourerId: { in: [...labourerIds] },
        workDate: range,
        status: "approved",
      },
      orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
    });
    for (const adjustment of adjustments) this.overlay(result, adjustment);
    return result;
  }

  /** Applies an approved adjustment to the effective inputs. */
  overlay(inputs: Map<string, EffectiveRecord[]>, adjustment: AdjustmentRow) {
    const date = toCalendarDate(adjustment.workDate);
    const key = dayKey(adjustment.labourerId, date);
    const list = inputs.get(key) ?? [];
    const delta = adjustment.delta as unknown as StoredDelta;
    const values = adjustment.proposed as unknown as AttendanceEntryValues;
    const index = list.findIndex((entry) => entry.siteId === adjustment.siteId);
    const base: EffectiveRecord =
      index >= 0
        ? list[index]!
        : {
            id: adjustment.id,
            projectId: adjustment.projectId,
            siteId: adjustment.siteId,
            labourerId: adjustment.labourerId,
            date,
            status: "absent",
            checkIn: null,
            checkOut: null,
            overnight: false,
            breakMinutes: null,
            fromLockedPeriod: true,
          };
    const next: EffectiveRecord = { ...base, ...overlayValues(base, values), locked: delta.after };
    if (index >= 0) list[index] = next;
    else list.push(next);
    inputs.set(key, list);
  }

  computeDay(ctx: CalcContext, date: string, records: readonly DayRecord[]): LabourerDayResult {
    return computeLabourerDay({
      date,
      records,
      ruleFor: this.ruleFor(ctx, date),
      holidays: ctx.holidays,
    });
  }

  /** Every computed labourer-day in the inputs. */
  computeAll(ctx: CalcContext, inputs: Map<string, EffectiveRecord[]>) {
    const results = new Map<string, LabourerDayResult>();
    for (const [key, records] of inputs) {
      const date = records[0]!.date;
      results.set(key, this.computeDay(ctx, date, records));
    }
    return results;
  }

  /**
   * A project's timesheet for a period: an `attendance` line per labourer with records in it, and
   * an `adjustment` line per approved adjustment that lands in it. `digest` binds approval to this
   * exact content.
   */
  async periodLines(
    tx: Tx,
    tenantId: string,
    period: PeriodRow,
    ctx: CalcContext,
  ): Promise<{
    lines: ComputedLine[];
    digest: string;
    missingRuleDates: string[];
    ruleIds: string[];
  }> {
    const from = toCalendarDate(period.startDate);
    const to = toCalendarDate(period.endDate);
    const own = await tx.attendanceRecord.findMany({
      where: {
        tenantId,
        projectId: period.projectId,
        workDate: { gte: period.startDate, lte: period.endDate },
      },
      select: { labourerId: true },
      distinct: ["labourerId"],
    });
    const labourerIds = own.map((row) => row.labourerId).sort();
    const inputs = await this.inputs(tx, tenantId, labourerIds, from, to);
    const results = this.computeAll(ctx, inputs);
    const byLabourer = new Map<string, LabourerDayResult[]>();
    const missing = new Set<string>();
    for (const [key, result] of results) {
      const labourerId = key.split("|")[0]!;
      byLabourer.set(labourerId, [...(byLabourer.get(labourerId) ?? []), result]);
    }
    const lines: ComputedLine[] = [];
    const ruleIds = new Set<string>();
    for (const labourerId of labourerIds) {
      const days = timesheetDays(byLabourer.get(labourerId) ?? [], period.projectId);
      if (!days.length) continue;
      for (const result of byLabourer.get(labourerId) ?? [])
        if (
          result.missingRule &&
          result.records.some((record) => record.projectId === period.projectId)
        )
          missing.add(result.date);
      const stored = days.map(storedDay);
      for (const day of stored) if (day.ruleVersionId) ruleIds.add(day.ruleVersionId);
      lines.push({
        line: {
          labourerId,
          kind: "attendance",
          adjustmentId: null,
          originalPeriodId: null,
          totals: totalsWire(sumDays(days)),
          ruleVersionIds: [
            ...new Set(stored.flatMap((day) => (day.ruleVersionId ? [day.ruleVersionId] : []))),
          ],
          recordIds: stored.flatMap((day) => day.recordIds),
          days: stored.map(publicDay),
        },
        stored,
      });
    }
    const landed = await tx.timesheetAdjustment.findMany({
      where: { tenantId, targetPeriodId: period.id, status: "approved" },
      orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
    });
    for (const adjustment of landed) {
      const delta = adjustment.delta as unknown as StoredDelta;
      const date = toCalendarDate(adjustment.workDate);
      const day: StoredDay = {
        date,
        dayType: delta.dayType,
        ruleVersionId: adjustment.ruleVersionId,
        totals: delta.totals,
        recordIds: adjustment.recordId ? [adjustment.recordId] : [],
        allocations: [],
      };
      if (adjustment.ruleVersionId) ruleIds.add(adjustment.ruleVersionId);
      lines.push({
        line: {
          labourerId: adjustment.labourerId,
          kind: "adjustment",
          adjustmentId: adjustment.id,
          originalPeriodId: adjustment.originalPeriodId,
          totals: delta.totals,
          ruleVersionIds: adjustment.ruleVersionId ? [adjustment.ruleVersionId] : [],
          recordIds: day.recordIds,
          days: [publicDay(day)],
        },
        stored: [day],
      });
    }
    const digest = sha256(canonicalJson(lines.map(({ line, stored }) => ({ line, stored }))));
    return { lines, digest, missingRuleDates: [...missing].sort(), ruleIds: [...ruleIds] };
  }
}

export const zeroAllocation = (): RecordAllocationValues => ({
  halfDays: 0,
  workedMinutes: 0,
  normalMinutes: 0,
  overtimeMinutes: 0,
  lateMinutes: 0,
});

export function storedDay(day: TimesheetDay): StoredDay {
  return {
    date: day.date,
    dayType: day.dayType,
    ruleVersionId: day.ruleId || null,
    totals: totalsWire(day.totals),
    recordIds: day.recordIds,
    allocations: day.allocations.map((allocation) => ({
      recordId: allocation.recordId,
      halfDays: allocation.halfDays,
      workedMinutes: allocation.workedMinutes,
      normalMinutes: allocation.normalMinutes,
      overtimeMinutes: allocation.overtimeMinutes,
      lateMinutes: allocation.lateMinutes,
    })),
  };
}

export function publicDay(day: StoredDay): TimesheetLine["days"][number] {
  return {
    date: day.date,
    dayType: day.dayType,
    ruleVersionId: day.ruleVersionId,
    totals: day.totals,
    recordIds: day.recordIds,
  };
}

/** Sum of line totals (wire form). */
export function sumLines(lines: readonly { totals: TimesheetLine["totals"] }[]): TimesheetTotals {
  return lines.reduce((sum, line) => addTotals(sum, totalsFromWire(line.totals)), emptyTotals());
}
