import { Injectable } from "@nestjs/common";
import {
  addCalendarDays,
  computeLabourerDay,
  detectDayAnomalies,
  isPeriodDue,
  weeklyPeriodFor,
  zonedDateTime,
  type AnomalyRecord,
} from "@pm-buddy/domain";
import {
  ANOMALY_SEVERITY,
  DEFAULT_PERIOD_SETTINGS,
  type IsoWeekday,
  type LabourerStatus,
  type PeriodSettings,
} from "@pm-buddy/types";
import type { Prisma } from "../../generated/prisma/client.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import { attendanceConflict } from "./attendance-support.js";
import type { PeriodRow } from "./attendance-mappers.js";
import { dayKey, TimesheetCalculator, type CalcContext } from "./timesheet-calculator.js";

type Tx = Prisma.TransactionClient;

/** Whether the labourer is engaged on the project on `date` (labour_engagements). */
export async function isEngaged(
  tx: Tx,
  tenantId: string,
  labourerId: string,
  projectId: string,
  date: string,
): Promise<boolean> {
  const day = fromCalendarDate(date);
  const engagement = await tx.labourEngagement.findFirst({
    where: {
      tenantId,
      labourerId,
      projectId,
      startDate: { lte: day },
      OR: [{ endDate: null }, { endDate: { gte: day } }],
    },
    select: { id: true },
  });
  return Boolean(engagement);
}

export async function loadPeriodSettings(
  tx: Tx,
  tenantId: string,
): Promise<PeriodSettings & { version: number }> {
  const row = await tx.attendanceSettings.findUnique({ where: { tenantId } });
  if (!row) return { ...DEFAULT_PERIOD_SETTINGS, version: 0 };
  return {
    frequency: "weekly",
    weekEndsOn: row.weekEndsOn as IsoWeekday,
    cutoffMinutes: row.cutoffMinutes,
    paydayWeekday: row.paydayWeekday as IsoWeekday,
    version: row.version,
  };
}

export const periodSummary = (period: PeriodRow, now = new Date()) => ({
  id: period.id,
  startDate: toCalendarDate(period.startDate),
  endDate: toCalendarDate(period.endDate),
  cutoffAt: period.cutoffAt.toISOString(),
  status: period.status as "open" | "submitted" | "rejected" | "approved",
  due: isPeriodDue(period.cutoffAt, now),
});

/** Periods: found by date, or created from the company's period settings when first needed. */
@Injectable()
export class PeriodStore {
  async covering(tx: Tx, tenantId: string, projectId: string, date: string) {
    const day = fromCalendarDate(date);
    return tx.timesheetPeriod.findFirst({
      where: { tenantId, projectId, startDate: { lte: day }, endDate: { gte: day } },
    });
  }

  /** The window a new period covering `date` would get (clipped to existing neighbours). */
  async window(tx: Tx, tenantId: string, projectId: string, date: string) {
    const settings = await loadPeriodSettings(tx, tenantId);
    const window = weeklyPeriodFor(date, settings);
    const before = await tx.timesheetPeriod.findFirst({
      where: { tenantId, projectId, endDate: { lt: fromCalendarDate(date) } },
      orderBy: { endDate: "desc" },
      select: { endDate: true },
    });
    const after = await tx.timesheetPeriod.findFirst({
      where: { tenantId, projectId, startDate: { gt: fromCalendarDate(date) } },
      orderBy: { startDate: "asc" },
      select: { startDate: true },
    });
    let startDate = window.startDate;
    let endDate = window.endDate;
    if (before && toCalendarDate(before.endDate) >= startDate)
      startDate = addCalendarDays(toCalendarDate(before.endDate), 1);
    if (after && toCalendarDate(after.startDate) <= endDate)
      endDate = addCalendarDays(toCalendarDate(after.startDate), -1);
    const cutoffAt =
      endDate === window.endDate ? window.cutoffAt : zonedDateTime(endDate, settings.cutoffMinutes);
    return { startDate, endDate, cutoffAt };
  }

  async ensure(tx: Tx, tenantId: string, projectId: string, date: string, userId: string) {
    const existing = await this.covering(tx, tenantId, projectId, date);
    if (existing) return { period: existing, created: false };
    const window = await this.window(tx, tenantId, projectId, date);
    if (window.startDate > window.endDate)
      throw attendanceConflict("period-overlap", "No period can cover this date.");
    const period = await tx.timesheetPeriod.create({
      data: {
        tenantId,
        projectId,
        startDate: fromCalendarDate(window.startDate),
        endDate: fromCalendarDate(window.endDate),
        cutoffAt: window.cutoffAt,
        createdBy: userId,
      },
    });
    return { period, created: true };
  }
}

/**
 * Re-detects anomalies for labourer-days and synchronises the open ones: new findings are opened,
 * findings that no longer hold are cleared. A finding a person already resolved or dismissed is not
 * raised again unless the record has changed since. Corrections' `manual_override` anomalies are
 * managed by the correction workflow.
 */
@Injectable()
export class AnomalyEvaluator {
  constructor(private readonly calculator: TimesheetCalculator) {}

  async refresh(
    tx: Tx,
    tenantId: string,
    pairs: readonly { labourerId: string; date: string }[],
    ctx?: CalcContext,
  ): Promise<void> {
    if (!pairs.length) return;
    const context = ctx ?? (await this.calculator.context(tx, tenantId));
    const labourerIds = [...new Set(pairs.map((pair) => pair.labourerId))];
    const dates = pairs.map((pair) => pair.date).sort();
    const inputs = await this.calculator.inputs(
      tx,
      tenantId,
      labourerIds,
      dates[0]!,
      dates.at(-1)!,
    );
    const records = await tx.attendanceRecord.findMany({
      where: {
        tenantId,
        labourerId: { in: labourerIds },
        workDate: { gte: fromCalendarDate(dates[0]!), lte: fromCalendarDate(dates.at(-1)!) },
      },
      select: { id: true, updatedAt: true, projectId: true, siteId: true },
    });
    const recordById = new Map(records.map((record) => [record.id, record]));
    const labourers = await tx.labourer.findMany({
      where: { tenantId, id: { in: labourerIds } },
      select: { id: true, status: true, doNotRehire: true, skillLevelId: true },
    });
    const levels = await tx.skillLevel.findMany({
      where: { tenantId, id: { in: [...new Set(labourers.map((row) => row.skillLevelId))] } },
      select: { id: true, accreditationExpected: true },
    });
    const cards = await tx.labourerAccreditation.findMany({
      where: { tenantId, labourerId: { in: labourerIds } },
      select: { labourerId: true, issuedOn: true, expiresOn: true },
    });
    const engagements = await tx.labourEngagement.findMany({
      where: { tenantId, labourerId: { in: labourerIds } },
      select: { labourerId: true, projectId: true, startDate: true, endDate: true },
    });
    const existing = records.length
      ? await tx.attendanceAnomaly.findMany({
          where: { tenantId, recordId: { in: records.map((record) => record.id) } },
        })
      : [];
    const expected = new Map(levels.map((level) => [level.id, level.accreditationExpected]));
    const wanted = new Set(pairs.map((pair) => dayKey(pair.labourerId, pair.date)));
    for (const key of wanted) {
      const [labourerId, date] = key.split("|") as [string, string];
      const labourer = labourers.find((row) => row.id === labourerId);
      const entries = (inputs.get(key) ?? []).filter((entry) => recordById.has(entry.id));
      if (!labourer || !entries.length) continue;
      const result = computeLabourerDay({
        date,
        records: inputs.get(key) ?? [],
        ruleFor: this.calculator.ruleFor(context, date),
        holidays: context.holidays,
      });
      const anomalyRecords: AnomalyRecord[] = entries.map((entry) => ({
        ...entry,
        engaged: engagements.some(
          (engagement) =>
            engagement.labourerId === labourerId &&
            engagement.projectId === entry.projectId &&
            toCalendarDate(engagement.startDate) <= date &&
            (engagement.endDate === null || toCalendarDate(engagement.endDate) >= date),
        ),
      }));
      const found = detectDayAnomalies({
        date,
        records: anomalyRecords,
        result,
        labourer: {
          status: labourer.status as LabourerStatus,
          doNotRehire: labourer.doNotRehire,
          accreditationExpected: expected.get(labourer.skillLevelId) ?? false,
          cards: cards
            .filter((card) => card.labourerId === labourerId)
            .map((card) => ({
              issuedOn: card.issuedOn ? toCalendarDate(card.issuedOn) : null,
              expiresOn: toCalendarDate(card.expiresOn),
            })),
        },
      });
      const foundKeys = new Set(found.map((entry) => `${entry.recordId}|${entry.kind}`));
      for (const finding of found) {
        const record = recordById.get(finding.recordId)!;
        const same = existing.filter(
          (row) => row.recordId === finding.recordId && row.kind === finding.kind,
        );
        if (same.some((row) => row.status === "open")) continue;
        if (
          same.some(
            (row) =>
              (row.status === "resolved" || row.status === "dismissed") &&
              row.reviewedAt !== null &&
              row.reviewedAt >= record.updatedAt,
          )
        )
          continue;
        await tx.attendanceAnomaly.create({
          data: {
            tenantId,
            projectId: record.projectId,
            siteId: record.siteId,
            recordId: finding.recordId,
            labourerId,
            workDate: fromCalendarDate(date),
            kind: finding.kind,
            severity: ANOMALY_SEVERITY[finding.kind],
            details: finding.details,
          },
        });
      }
      for (const row of existing)
        if (
          row.status === "open" &&
          row.kind !== "manual_override" &&
          entries.some((entry) => entry.id === row.recordId) &&
          !foundKeys.has(`${row.recordId}|${row.kind}`)
        )
          await tx.attendanceAnomaly.update({
            where: { id: row.id },
            data: { status: "cleared", openMarker: null, version: { increment: 1 } },
          });
    }
  }
}
