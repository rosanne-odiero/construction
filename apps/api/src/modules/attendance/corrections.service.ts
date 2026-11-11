import { Injectable, NotFoundException } from "@nestjs/common";
import {
  correctionResponseSchema,
  correctionsResponseSchema,
  type AttendanceEntryValues,
  type Correction,
} from "@pm-buddy/validation";
import type { Request } from "express";
import type { z } from "zod";
import type {
  approveDecisionRequestSchema,
  correctionListQuerySchema,
  createCorrectionRequestSchema,
  rejectDecisionRequestSchema,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import { AuthService, type Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { toCalendarDate } from "../projects/project-mappers.js";
import {
  attendanceConflict,
  AttendanceAccess,
  AttendanceCommands,
  requireStepUp,
  samePerson,
  versionConflict,
} from "./attendance-support.js";
import {
  correctionApplies,
  entryColumns,
  entryValues,
  toCorrection,
  type CorrectionRow,
} from "./attendance-mappers.js";
import { AnomalyEvaluator, isEngaged } from "./period-store.js";

type Tx = Prisma.TransactionClient;

const changedFields = (before: AttendanceEntryValues | null, after: AttendanceEntryValues) =>
  (Object.keys(after) as (keyof AttendanceEntryValues)[]).filter(
    (key) => !before || before[key] !== after[key],
  );

/**
 * Corrections of a submitted or confirmed day (brief §5.5: manual overrides need a reason, are
 * flagged for review, audit-logged and confirmed by a distinct person). Requesting needs
 * attendance.override and step-up MFA; deciding needs attendance.confirm and a different person.
 * The record changes only when the correction is approved.
 */
@Injectable()
export class CorrectionsService {
  constructor(
    private readonly commands: AttendanceCommands,
    private readonly access: AttendanceAccess,
    private readonly auth: AuthService,
    private readonly anomalies: AnomalyEvaluator,
  ) {}

  list(
    principal: Principal,
    projectId: string,
    query: z.output<typeof correctionListQuerySchema>,
    req: Request,
  ) {
    return this.commands.read(principal, req, async (scope) => {
      const { tx, access } = scope;
      await this.access.project(scope, projectId, "attendance.view");
      const rows = await tx.attendanceCorrection.findMany({
        where: {
          tenantId: access.tenantId,
          day: { projectId },
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: { requestedAt: "desc" },
        take: 500,
      });
      return correctionsResponseSchema.parse({
        corrections: await this.map(tx, access.tenantId, rows),
      });
    });
  }

  create(
    principal: Principal,
    dayId: string,
    input: z.output<typeof createCorrectionRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "attendance.correction.create",
      { dayId, input },
      async (scope) => {
        const { tx, access } = scope;
        const day = await tx.attendanceDay.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: dayId } },
        });
        if (!day) throw new NotFoundException("Day not found");
        const { project } = await this.access.project(scope, day.projectId, "attendance.override");
        this.access.assertWritable(project);
        requireStepUp(this.auth, principal);
        if (day.status === "draft")
          throw attendanceConflict(
            "correction-not-needed",
            "This day is still a draft: change it on the muster roll.",
          );
        await this.assertPeriodEditable(tx, access.tenantId, day.periodId);
        const date = toCalendarDate(day.workDate);
        const record = await tx.attendanceRecord.findFirst({
          where: { tenantId: access.tenantId, dayId, labourerId: input.labourerId },
        });
        if (record ? record.version !== input.recordVersion : input.recordVersion !== 0)
          throw versionConflict();
        if (
          !record &&
          !(await isEngaged(tx, access.tenantId, input.labourerId, day.projectId, date))
        )
          throw attendanceConflict(
            "not-engaged",
            "Only labourers engaged on the project that day can be recorded.",
            { labourerId: input.labourerId },
          );
        const proposed: AttendanceEntryValues = {
          status: input.status,
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          overnight: input.overnight,
          breakMinutes: input.breakMinutes,
          notes: input.notes,
        };
        const previous = record ? entryValues(record) : null;
        const fields = changedFields(previous, proposed);
        if (!fields.length) throw attendanceConflict("no-changes", "Nothing would change.");
        const pending = await tx.attendanceCorrection.findFirst({
          where: {
            tenantId: access.tenantId,
            dayId,
            labourerId: input.labourerId,
            status: "pending",
          },
          select: { id: true },
        });
        if (pending)
          throw attendanceConflict(
            "correction-pending",
            "A correction for this labourer and day is already waiting for a decision.",
          );
        const row = await tx.attendanceCorrection.create({
          data: {
            tenantId: access.tenantId,
            dayId,
            siteId: day.siteId,
            workDate: day.workDate,
            recordId: record?.id ?? null,
            labourerId: input.labourerId,
            proposed,
            ...(previous ? { previous } : {}),
            reason: input.reason,
            requestedBy: access.userId,
          },
        });
        if (record)
          await tx.attendanceAnomaly.create({
            data: {
              tenantId: access.tenantId,
              projectId: day.projectId,
              siteId: day.siteId,
              recordId: record.id,
              labourerId: input.labourerId,
              workDate: day.workDate,
              kind: "manual_override",
              severity: "info",
              details: { fields },
              correctionId: row.id,
            },
          });
        await this.commands.audit(scope, "attendance.correction_requested", row.id, {
          dayId,
          labourerId: input.labourerId,
          fields,
          reasonGiven: true,
        });
        return correctionResponseSchema.parse({
          correction: (await this.map(tx, access.tenantId, [row]))[0],
        });
      },
    );
  }

  approve(
    principal: Principal,
    correctionId: string,
    input: z.output<typeof approveDecisionRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "attendance.correction.approve",
      { correctionId, input },
      async (scope) => {
        const { tx, access } = scope;
        const { row, day } = await this.decidable(scope, correctionId, input.version);
        const current = await tx.attendanceRecord.findFirst({
          where: { tenantId: access.tenantId, dayId: day.id, labourerId: row.labourerId },
        });
        if (
          !correctionApplies({
            dayStatus: day.status,
            recordId: row.recordId,
            previous: (row.previous as unknown as AttendanceEntryValues | null) ?? null,
            record: current,
          })
        )
          throw attendanceConflict(
            "correction-outdated",
            "The day or the record changed after this correction was asked for. Reject it and ask again.",
          );
        await tx.attendanceCorrection.update({
          where: { id: row.id },
          data: {
            status: "approved",
            decidedBy: access.userId,
            decisionNote: input.note ? input.note : null,
            version: { increment: 1 },
          },
        });
        const proposed = row.proposed as unknown as AttendanceEntryValues;
        if (row.recordId) {
          const updated = await tx.attendanceRecord.updateMany({
            where: { tenantId: access.tenantId, id: row.recordId },
            data: {
              ...entryColumns(proposed),
              corrected: true,
              updatedBy: access.userId,
              version: { increment: 1 },
            },
          });
          if (!updated.count) throw versionConflict();
        } else
          await tx.attendanceRecord.create({
            data: {
              tenantId: access.tenantId,
              dayId: day.id,
              projectId: day.projectId,
              siteId: day.siteId,
              workDate: day.workDate,
              labourerId: row.labourerId,
              ...entryColumns(proposed),
              captureMethod: "web_manual",
              corrected: true,
              createdBy: row.requestedBy,
              updatedBy: access.userId,
            },
          });
        await this.closeOverride(
          tx,
          access.tenantId,
          row.id,
          "resolved",
          access.userId,
          input.note,
        );
        await this.anomalies.refresh(tx, access.tenantId, [
          { labourerId: row.labourerId, date: toCalendarDate(row.workDate) },
        ]);
        await this.commands.audit(scope, "attendance.correction_approved", row.id, {
          dayId: row.dayId,
          labourerId: row.labourerId,
        });
        return this.reload(scope, row.id);
      },
    );
  }

  reject(
    principal: Principal,
    correctionId: string,
    input: z.output<typeof rejectDecisionRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "attendance.correction.reject",
      { correctionId, input },
      async (scope) => {
        const { tx, access } = scope;
        const { row } = await this.decidable(scope, correctionId, input.version);
        await tx.attendanceCorrection.update({
          where: { id: row.id },
          data: {
            status: "rejected",
            decidedBy: access.userId,
            decisionNote: input.note,
            version: { increment: 1 },
          },
        });
        await this.closeOverride(
          tx,
          access.tenantId,
          row.id,
          "dismissed",
          access.userId,
          input.note,
        );
        await this.commands.audit(scope, "attendance.correction_rejected", row.id, {
          dayId: row.dayId,
          labourerId: row.labourerId,
          reasonGiven: true,
        });
        return this.reload(scope, row.id);
      },
    );
  }

  private async decidable(scope: Scope, correctionId: string, version: number) {
    const { tx, access } = scope;
    const row = await tx.attendanceCorrection.findUnique({
      where: { tenantId_id: { tenantId: access.tenantId, id: correctionId } },
    });
    if (!row) throw new NotFoundException("Correction not found");
    const day = await tx.attendanceDay.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: access.tenantId, id: row.dayId } },
    });
    const { project } = await this.access.project(scope, day.projectId, "attendance.confirm");
    this.access.assertWritable(project);
    if (row.version !== version) throw versionConflict();
    if (row.status !== "pending")
      throw attendanceConflict("invalid-transition", "This correction was already decided.");
    if (row.requestedBy === access.userId)
      throw samePerson("The person who asked for a correction cannot decide it.");
    await this.assertPeriodEditable(tx, access.tenantId, day.periodId);
    return { row, day };
  }

  private async closeOverride(
    tx: Tx,
    tenantId: string,
    correctionId: string,
    status: "resolved" | "dismissed",
    userId: string,
    note: string | undefined,
  ) {
    await tx.attendanceAnomaly.updateMany({
      where: { tenantId, correctionId, status: "open" },
      data: {
        status,
        openMarker: null,
        reviewedBy: userId,
        reviewNote: note || (status === "resolved" ? "Correction approved" : "Correction rejected"),
        version: { increment: 1 },
      },
    });
  }

  private async assertPeriodEditable(tx: Tx, tenantId: string, periodId: string) {
    const period = await tx.timesheetPeriod.findUnique({
      where: { tenantId_id: { tenantId, id: periodId } },
      select: { status: true },
    });
    if (!period || (period.status !== "open" && period.status !== "rejected"))
      throw attendanceConflict(
        "period-locked",
        "This date's timesheet period is submitted or approved; request an adjustment.",
      );
  }

  private async reload(scope: Scope, correctionId: string) {
    const { tx, access } = scope;
    const row = await tx.attendanceCorrection.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: access.tenantId, id: correctionId } },
    });
    return correctionResponseSchema.parse({
      correction: (await this.map(tx, access.tenantId, [row]))[0],
    });
  }

  private async map(tx: Tx, tenantId: string, rows: CorrectionRow[]): Promise<Correction[]> {
    if (!rows.length) return [];
    const names = await displayNames(
      tx,
      rows.flatMap((row) => [row.requestedBy, row.decidedBy]),
    );
    const labourers = await tx.labourer.findMany({
      where: { tenantId, id: { in: [...new Set(rows.map((row) => row.labourerId))] } },
      select: { id: true, workerNo: true, fullName: true },
    });
    const byId = new Map(labourers.map((row) => [row.id, row]));
    return rows.map((row) => toCorrection(row, names, byId.get(row.labourerId) ?? null));
  }
}
