import { Injectable, NotFoundException } from "@nestjs/common";
import { addCalendarDays, nairobiDate, subtractTotals, totalsOf } from "@pm-buddy/domain";
import {
  adjustmentResponseSchema,
  adjustmentsResponseSchema,
  type Adjustment,
  type AttendanceEntryValues,
} from "@pm-buddy/validation";
import type { Request } from "express";
import type { z } from "zod";
import type {
  adjustmentListQuerySchema,
  approveDecisionRequestSchema,
  createAdjustmentRequestSchema,
  rejectDecisionRequestSchema,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import { AuthService, type Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  attendanceBadRequest,
  attendanceConflict,
  AttendanceAccess,
  AttendanceCommands,
  requireStepUp,
  samePerson,
  versionConflict,
} from "./attendance-support.js";
import {
  actor,
  entryValues,
  iso,
  optionalActor,
  totalsWire,
  type AdjustmentRow,
  type StoredDelta,
} from "./attendance-mappers.js";
import { AnomalyEvaluator, isEngaged, PeriodStore } from "./period-store.js";
import {
  dayKey,
  overlayValues,
  TimesheetCalculator,
  zeroAllocation,
  type EffectiveRecord,
} from "./timesheet-calculator.js";

type Tx = Prisma.TransactionClient;

export async function toAdjustments(
  tx: Tx,
  tenantId: string,
  rows: AdjustmentRow[],
): Promise<Adjustment[]> {
  if (!rows.length) return [];
  const names = await displayNames(
    tx,
    rows.flatMap((row) => [row.requestedBy, row.decidedBy]),
  );
  const labourers = await tx.labourer.findMany({
    where: { tenantId, id: { in: [...new Set(rows.map((row) => row.labourerId))] } },
    select: { id: true, workerNo: true, fullName: true },
  });
  const sites = await tx.site.findMany({
    where: { tenantId, id: { in: [...new Set(rows.map((row) => row.siteId))] } },
    select: { id: true, name: true },
  });
  return rows.map((row) => {
    const labourer = labourers.find((entry) => entry.id === row.labourerId);
    const delta = row.delta as unknown as StoredDelta | null;
    return {
      id: row.id,
      projectId: row.projectId,
      originalPeriodId: row.originalPeriodId,
      targetPeriodId: row.targetPeriodId,
      labourerId: row.labourerId,
      workerNo: labourer?.workerNo ?? "—",
      fullName: labourer?.fullName ?? "—",
      siteId: row.siteId,
      siteName: sites.find((entry) => entry.id === row.siteId)?.name ?? "—",
      date: toCalendarDate(row.workDate),
      recordId: row.recordId,
      proposed: row.proposed as unknown as AttendanceEntryValues,
      previous: (row.previous as unknown as AttendanceEntryValues | null) ?? null,
      reason: row.reason,
      status: row.status as Adjustment["status"],
      requestedBy: actor(names, row.requestedBy),
      requestedAt: row.requestedAt.toISOString(),
      decidedBy: optionalActor(names, row.decidedBy),
      decidedAt: iso(row.decidedAt),
      decisionNote: row.decisionNote,
      delta: delta ? delta.totals : null,
      version: row.version,
    };
  });
}

const sameValues = (a: AttendanceEntryValues | null, b: AttendanceEntryValues) =>
  a !== null &&
  a.status === b.status &&
  a.checkIn === b.checkIn &&
  a.checkOut === b.checkOut &&
  a.overnight === b.overnight &&
  a.breakMinutes === b.breakMinutes &&
  a.notes === b.notes;

/**
 * Adjustments (INVARIANTS: late attendance creates adjustments, never mutates closed periods): a
 * correction to a date of an approved period, with a reason, decided by someone other than the
 * requester. Approval fixes the delta to the labourer's timesheet and lands it in a later open
 * period, where it becomes an `adjustment` line when that period is approved. The approved period,
 * its snapshot and its attendance records never change.
 */
@Injectable()
export class AdjustmentsService {
  constructor(
    private readonly commands: AttendanceCommands,
    private readonly access: AttendanceAccess,
    private readonly auth: AuthService,
    private readonly calculator: TimesheetCalculator,
    private readonly periods: PeriodStore,
    private readonly anomalies: AnomalyEvaluator,
  ) {}

  list(
    principal: Principal,
    projectId: string,
    query: z.output<typeof adjustmentListQuerySchema>,
    req: Request,
  ) {
    return this.commands.read(principal, req, async (scope) => {
      const { tx, access } = scope;
      await this.access.project(scope, projectId, "attendance.view");
      const rows = await tx.timesheetAdjustment.findMany({
        where: {
          tenantId: access.tenantId,
          projectId,
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: { requestedAt: "desc" },
        take: 500,
      });
      return adjustmentsResponseSchema.parse({
        adjustments: await toAdjustments(tx, access.tenantId, rows),
      });
    });
  }

  create(
    principal: Principal,
    periodId: string,
    input: z.output<typeof createAdjustmentRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "timesheet.adjustment.create",
      { periodId, input },
      async (scope) => {
        const { tx, access } = scope;
        const period = await tx.timesheetPeriod.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: periodId } },
        });
        if (!period) throw new NotFoundException("Period not found");
        const { project } = await this.access.project(
          scope,
          period.projectId,
          "attendance.override",
        );
        this.access.assertWritable(project);
        requireStepUp(this.auth, principal);
        if (period.status !== "approved")
          throw attendanceConflict(
            "period-not-approved",
            "Adjustments correct approved periods; change open periods on the muster roll.",
          );
        if (
          input.date < toCalendarDate(period.startDate) ||
          input.date > toCalendarDate(period.endDate)
        )
          throw attendanceBadRequest("date-outside-period", "The date is outside this period.");
        const site = await tx.site.findFirst({
          where: { tenantId: access.tenantId, projectId: period.projectId, id: input.siteId },
          select: { id: true },
        });
        if (!site)
          throw attendanceBadRequest("site-not-in-project", "Choose a site of this project.");
        if (!(await isEngaged(tx, access.tenantId, input.labourerId, period.projectId, input.date)))
          throw attendanceConflict(
            "not-engaged",
            "Only labourers engaged on the project that day can be recorded.",
            { labourerId: input.labourerId },
          );
        const pending = await tx.timesheetAdjustment.findFirst({
          where: {
            tenantId: access.tenantId,
            labourerId: input.labourerId,
            workDate: fromCalendarDate(input.date),
            status: "pending",
          },
          select: { id: true },
        });
        if (pending)
          throw attendanceConflict(
            "adjustment-pending",
            "An adjustment for this labourer and day is already waiting for a decision.",
          );
        const { values: previous, recordId } = await this.effectiveValues(
          tx,
          access.tenantId,
          input.labourerId,
          input.siteId,
          input.date,
        );
        const proposed: AttendanceEntryValues = {
          status: input.status,
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          overnight: input.overnight,
          breakMinutes: input.breakMinutes,
          notes: input.notes,
        };
        // The same values are a reallocation: allowed only while the approved share of this site
        // differs from the day as recomputed now (a `locked_share_changed` anomaly).
        if (
          sameValues(previous, proposed) &&
          !(await this.shareChanged(
            tx,
            access.tenantId,
            input.labourerId,
            input.siteId,
            input.date,
          ))
        )
          throw attendanceConflict("no-changes", "Nothing would change.");
        const row = await tx.timesheetAdjustment.create({
          data: {
            tenantId: access.tenantId,
            projectId: period.projectId,
            originalPeriodId: period.id,
            labourerId: input.labourerId,
            siteId: input.siteId,
            workDate: fromCalendarDate(input.date),
            recordId,
            proposed,
            ...(previous ? { previous } : {}),
            reason: input.reason,
            requestedBy: access.userId,
          },
        });
        await this.commands.audit(scope, "timesheet.adjustment_requested", row.id, {
          periodId: period.id,
          labourerId: input.labourerId,
          date: input.date,
          reasonGiven: true,
        });
        return adjustmentResponseSchema.parse({
          adjustment: (await toAdjustments(tx, access.tenantId, [row]))[0],
        });
      },
    );
  }

  approve(
    principal: Principal,
    adjustmentId: string,
    input: z.output<typeof approveDecisionRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "timesheet.adjustment.approve",
      { adjustmentId, input },
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.decidable(scope, adjustmentId, input.version);
        const target = await this.approveCore(tx, access.tenantId, access.userId, row, input.note);
        // The new locked share may clear a locked_share_changed anomaly, or reveal another one.
        await this.anomalies.refresh(tx, access.tenantId, [
          { labourerId: row.labourerId, date: toCalendarDate(row.workDate) },
        ]);
        await this.commands.audit(scope, "timesheet.adjustment_approved", row.id, {
          originalPeriodId: row.originalPeriodId,
          targetPeriodId: target.id,
          labourerId: row.labourerId,
        });
        await this.commands.outbox(scope, "timesheet.adjustment_approved", row.id, {
          projectId: row.projectId,
          originalPeriodId: row.originalPeriodId,
          targetPeriodId: target.id,
        });
        return this.reload(scope, row.id);
      },
    );
  }

  reject(
    principal: Principal,
    adjustmentId: string,
    input: z.output<typeof rejectDecisionRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "timesheet.adjustment.reject",
      { adjustmentId, input },
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.decidable(scope, adjustmentId, input.version);
        const updated = await tx.timesheetAdjustment.updateMany({
          where: {
            tenantId: access.tenantId,
            id: row.id,
            version: input.version,
            status: "pending",
          },
          data: {
            status: "rejected",
            decidedBy: access.userId,
            decisionNote: input.note,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw versionConflict();
        await this.commands.audit(scope, "timesheet.adjustment_rejected", row.id, {
          originalPeriodId: row.originalPeriodId,
          reasonGiven: true,
        });
        return this.reload(scope, row.id);
      },
    );
  }

  /**
   * Approval without the caller checks (also used by the development seed): computes the delta of
   * the labourer's day against what was paid (the snapshot or an earlier adjustment), picks the
   * period it lands in and records the decision. Nothing of the approved period changes. The new
   * share is the record's share of the whole day recomputed with nothing locked (review finding
   * 3), so a locked share always moves to the same value the drift check compares against.
   */
  async approveCore(
    tx: Tx,
    tenantId: string,
    userId: string,
    row: AdjustmentRow,
    note: string | undefined,
  ) {
    const date = toCalendarDate(row.workDate);
    const ctx = await this.calculator.context(tx, tenantId);
    const inputs = await this.calculator.inputs(tx, tenantId, [row.labourerId], date, date);
    const records: EffectiveRecord[] = [...(inputs.get(dayKey(row.labourerId, date)) ?? [])];
    const index = records.findIndex((entry) => entry.siteId === row.siteId);
    const existing = index >= 0 ? records[index]! : null;
    const before = existing?.locked ?? null;
    const proposed = row.proposed as unknown as AttendanceEntryValues;
    const free: EffectiveRecord = {
      ...overlayValues(
        existing ?? {
          id: row.id,
          projectId: row.projectId,
          siteId: row.siteId,
          status: "absent",
          checkIn: null,
          checkOut: null,
          overnight: false,
          breakMinutes: null,
        },
        proposed,
      ),
      labourerId: row.labourerId,
      date,
      fromLockedPeriod: true,
      locked: null,
    };
    if (index >= 0) records[index] = free;
    else records.push(free);
    const result = this.calculator.computeDay(
      ctx,
      date,
      records.map((entry) => ({ ...entry, locked: null })),
    );
    const allocation = result.records.find((entry) => entry.recordId === free.id)!;
    if (!result.dayType || result.missingRule)
      throw attendanceConflict(
        "rules-not-configured",
        "Configure timesheet rules for this date first.",
      );
    const after = {
      halfDays: allocation.halfDays,
      workedMinutes: allocation.workedMinutes,
      normalMinutes: allocation.normalMinutes,
      overtimeMinutes: allocation.overtimeMinutes,
      lateMinutes: allocation.lateMinutes,
    };
    const previous = row.previous as unknown as AttendanceEntryValues | null;
    const beforeTotals = previous
      ? totalsOf([
          {
            ...(before ?? zeroAllocation()),
            recordId: free.id,
            projectId: row.projectId,
            siteId: row.siteId,
            status: previous.status,
            dayType: result.dayType,
            breakMinutes: 0,
            locked: true,
          },
        ])
      : totalsOf([]);
    const delta: StoredDelta = {
      totals: totalsWire(subtractTotals(totalsOf([allocation]), beforeTotals)),
      dayType: result.dayType,
      before,
      after,
    };
    const target = await this.targetPeriod(tx, tenantId, row, userId);
    const updated = await tx.timesheetAdjustment.updateMany({
      where: {
        tenantId,
        id: row.id,
        version: row.version,
        status: "pending",
      },
      data: {
        status: "approved",
        decidedBy: userId,
        decisionNote: note ? note : null,
        targetPeriodId: target.id,
        delta: delta as unknown as Prisma.InputJsonValue,
        ruleVersionId: result.ruleId,
        version: { increment: 1 },
      },
    });
    if (!updated.count) throw versionConflict();
    return target;
  }

  /** Whether the locked share of this site differs from the day as recomputed now. */
  private async shareChanged(
    tx: Tx,
    tenantId: string,
    labourerId: string,
    siteId: string,
    date: string,
  ): Promise<boolean> {
    const ctx = await this.calculator.context(tx, tenantId);
    const inputs = await this.calculator.inputs(tx, tenantId, [labourerId], date, date);
    const records = inputs.get(dayKey(labourerId, date)) ?? [];
    if (!records.length) return false;
    return this.calculator
      .computeDay(ctx, date, records)
      .lockedDrift.some((drift) => drift.siteId === siteId);
  }

  /** The values in force for a labourer on a site and date (record, then approved adjustments). */
  private async effectiveValues(
    tx: Tx,
    tenantId: string,
    labourerId: string,
    siteId: string,
    date: string,
  ): Promise<{ values: AttendanceEntryValues | null; recordId: string | null }> {
    const record = await tx.attendanceRecord.findFirst({
      where: { tenantId, labourerId, siteId, workDate: fromCalendarDate(date) },
    });
    const latest = await tx.timesheetAdjustment.findFirst({
      where: { tenantId, labourerId, siteId, workDate: fromCalendarDate(date), status: "approved" },
      orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
    });
    if (latest)
      return {
        values: latest.proposed as unknown as AttendanceEntryValues,
        recordId: record?.id ?? null,
      };
    return { values: record ? entryValues(record) : null, recordId: record?.id ?? null };
  }

  /**
   * The open (or rejected) period after the original period that the adjustment lands in: the one
   * covering today, or the next one if that is already submitted or approved (created on demand).
   */
  private async targetPeriod(tx: Tx, tenantId: string, row: AdjustmentRow, userId: string) {
    const original = await tx.timesheetPeriod.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: row.originalPeriodId } },
    });
    let date = nairobiDate();
    const after = addCalendarDays(toCalendarDate(original.endDate), 1);
    if (date < after) date = after;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const { period } = await this.periods.ensure(tx, tenantId, row.projectId, date, userId);
      if (period.status === "open" || period.status === "rejected") return period;
      date = addCalendarDays(toCalendarDate(period.endDate), 1);
    }
    throw attendanceConflict(
      "no-target-period",
      "No open period is available for this adjustment.",
    );
  }

  private async decidable(scope: Scope, adjustmentId: string, version: number) {
    const { tx, access } = scope;
    const row = await tx.timesheetAdjustment.findUnique({
      where: { tenantId_id: { tenantId: access.tenantId, id: adjustmentId } },
    });
    if (!row) throw new NotFoundException("Adjustment not found");
    const { project } = await this.access.project(scope, row.projectId, "timesheets.approve");
    this.access.assertWritable(project);
    if (row.version !== version) throw versionConflict();
    if (row.status !== "pending")
      throw attendanceConflict("invalid-transition", "This adjustment was already decided.");
    if (row.requestedBy === access.userId)
      throw samePerson("The person who asked for an adjustment cannot decide it.");
    return row;
  }

  private async reload(scope: Scope, adjustmentId: string) {
    const { tx, access } = scope;
    const row = await tx.timesheetAdjustment.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: access.tenantId, id: adjustmentId } },
    });
    return adjustmentResponseSchema.parse({
      adjustment: (await toAdjustments(tx, access.tenantId, [row]))[0],
    });
  }
}
