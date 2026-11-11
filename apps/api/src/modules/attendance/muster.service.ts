import { Injectable, NotFoundException } from "@nestjs/common";
import { dayTypeOf, isPeriodEditable, nairobiDate } from "@pm-buddy/domain";
import { ANOMALY_SEVERITY, type AnomalyKind, type TimesheetPeriodStatus } from "@pm-buddy/types";
import {
  attendanceOverviewResponseSchema,
  musterResponseSchema,
  type AttendanceEntryValues,
  type MusterResponse,
} from "@pm-buddy/validation";
import type { Request } from "express";
import type { z } from "zod";
import type {
  dayActionRequestSchema,
  musterQuerySchema,
  returnDayRequestSchema,
  saveMusterRequestSchema,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  attendanceBadRequest,
  attendanceConflict,
  AttendanceAccess,
  AttendanceCommands,
  inProjects,
  samePerson,
  versionConflict,
} from "./attendance-support.js";
import {
  actor,
  dayRule,
  entryColumns,
  entryValues,
  iso,
  optionalActor,
  toCorrection,
  toRule,
  type DayRow,
} from "./attendance-mappers.js";
import { AnomalyEvaluator, isEngaged, PeriodStore, periodSummary } from "./period-store.js";
import { dayKey, TimesheetCalculator } from "./timesheet-calculator.js";

type Tx = Prisma.TransactionClient;
type MusterLock = NonNullable<MusterResponse["locked"]>;

const sameValues = (a: AttendanceEntryValues, b: AttendanceEntryValues) =>
  a.status === b.status &&
  a.checkIn === b.checkIn &&
  a.checkOut === b.checkOut &&
  a.overnight === b.overnight &&
  a.breakMinutes === b.breakMinutes &&
  a.notes === b.notes;

/**
 * The daily muster roll per project, site and date (brief §5.5): the labourers engaged on the
 * project that day, their records, flags and the day's workflow (draft → submitted → confirmed by
 * someone who neither submitted nor recorded it). Only `web_manual` capture is implemented.
 */
@Injectable()
export class MusterService {
  constructor(
    private readonly commands: AttendanceCommands,
    private readonly access: AttendanceAccess,
    private readonly calculator: TimesheetCalculator,
    private readonly periods: PeriodStore,
    private readonly anomalies: AnomalyEvaluator,
  ) {}

  overview(principal: Principal, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      const { tx, access } = scope;
      const visible = await this.access.projectsWith(scope, "attendance.view");
      const record = await this.access.projectsWith(scope, "attendance.record");
      const projects = await tx.project.findMany({
        where: {
          tenantId: access.tenantId,
          status: { notIn: ["cancelled"] },
          ...(visible === "all" ? {} : { id: { in: [...visible] } }),
        },
        orderBy: { code: "asc" },
      });
      const today = nairobiDate();
      const result = [];
      for (const project of projects) {
        const sites = await tx.site.findMany({
          where: { tenantId: access.tenantId, projectId: project.id },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        });
        const days = await tx.attendanceDay.findMany({
          where: {
            tenantId: access.tenantId,
            projectId: project.id,
            workDate: fromCalendarDate(today),
          },
          select: { id: true, siteId: true, status: true, _count: { select: { records: true } } },
        });
        const openAnomalies = await tx.attendanceAnomaly.count({
          where: { tenantId: access.tenantId, projectId: project.id, status: "open" },
        });
        const pendingCorrections = await tx.attendanceCorrection.count({
          where: {
            tenantId: access.tenantId,
            status: "pending",
            day: { projectId: project.id },
          },
        });
        const pendingAdjustments = await tx.timesheetAdjustment.count({
          where: { tenantId: access.tenantId, projectId: project.id, status: "pending" },
        });
        const awaiting = await tx.timesheetPeriod.count({
          where: { tenantId: access.tenantId, projectId: project.id, status: "submitted" },
        });
        const period = await this.periods.covering(tx, access.tenantId, project.id, today);
        const window = period
          ? periodSummary(period)
          : await this.virtualPeriod(tx, access.tenantId, project.id, today);
        result.push({
          id: project.id,
          code: project.code,
          name: project.name,
          status: project.status,
          sites: sites.map((site) => {
            const day = days.find((entry) => entry.siteId === site.id);
            return {
              id: site.id,
              name: site.name,
              today: {
                dayId: day?.id ?? null,
                status: day?.status ?? null,
                records: day?._count.records ?? 0,
              },
            };
          }),
          openAnomalies,
          pendingCorrections,
          pendingAdjustments,
          periodsAwaitingApproval: awaiting,
          currentPeriod: window,
          canRecord: inProjects(record, project.id),
        });
      }
      return attendanceOverviewResponseSchema.parse({ today, projects: result });
    });
  }

  get(
    principal: Principal,
    projectId: string,
    query: z.output<typeof musterQuerySchema>,
    req: Request,
  ) {
    return this.commands.read(principal, req, async (scope) => {
      await this.access.project(scope, projectId, "attendance.view");
      return this.build(scope, projectId, query.siteId, query.date, query.gangId ?? null);
    });
  }

  save(
    principal: Principal,
    projectId: string,
    input: z.output<typeof saveMusterRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "attendance.muster.save",
      { projectId, input },
      async (scope) => {
        const { tx, access } = scope;
        const { project } = await this.access.project(scope, projectId, "attendance.record");
        this.access.assertWritable(project);
        if (input.date > nairobiDate())
          throw attendanceBadRequest("date-in-future", "Attendance cannot be recorded in advance.");
        await this.site(tx, access.tenantId, projectId, input.siteId);
        const { period, created } = await this.periods.ensure(
          tx,
          access.tenantId,
          projectId,
          input.date,
          access.userId,
        );
        if (created)
          await this.commands.audit(scope, "timesheet.period_created", period.id, {
            projectId,
            startDate: toCalendarDate(period.startDate),
            endDate: toCalendarDate(period.endDate),
          });
        if (!isPeriodEditable(period.status as TimesheetPeriodStatus))
          throw attendanceConflict(
            "period-locked",
            "This date's timesheet period is submitted or approved; request an adjustment.",
          );
        let day = await tx.attendanceDay.findUnique({
          where: {
            tenantId_siteId_workDate: {
              tenantId: access.tenantId,
              siteId: input.siteId,
              workDate: fromCalendarDate(input.date),
            },
          },
        });
        if (day ? day.version !== input.dayVersion : input.dayVersion !== 0)
          throw versionConflict();
        if (day && day.status !== "draft")
          throw attendanceConflict(
            "day-not-draft",
            "This day was submitted. Corrections need a reason and a second person.",
          );
        if (!day)
          day = await tx.attendanceDay.create({
            data: {
              tenantId: access.tenantId,
              projectId,
              siteId: input.siteId,
              workDate: fromCalendarDate(input.date),
              periodId: period.id,
              createdBy: access.userId,
            },
          });
        const existing = await tx.attendanceRecord.findMany({
          where: {
            tenantId: access.tenantId,
            dayId: day.id,
            labourerId: { in: input.entries.map((entry) => entry.labourerId) },
          },
        });
        let createdCount = 0;
        let updatedCount = 0;
        const changed: string[] = [];
        for (const entry of input.entries) {
          const record = existing.find((row) => row.labourerId === entry.labourerId);
          const values: AttendanceEntryValues = {
            status: entry.status,
            checkIn: entry.checkIn,
            checkOut: entry.checkOut,
            overnight: entry.overnight,
            breakMinutes: entry.breakMinutes,
            notes: entry.notes,
          };
          if (record) {
            if (record.version !== entry.version) throw versionConflict();
            if (sameValues(entryValues(record), values)) continue;
            const updated = await tx.attendanceRecord.updateMany({
              where: { tenantId: access.tenantId, id: record.id, version: entry.version },
              data: {
                ...entryColumns(values),
                updatedBy: access.userId,
                version: { increment: 1 },
              },
            });
            if (!updated.count) throw versionConflict();
            updatedCount += 1;
          } else {
            if (entry.version !== 0) throw versionConflict();
            const labourer = await tx.labourer.findUnique({
              where: { tenantId_id: { tenantId: access.tenantId, id: entry.labourerId } },
              select: { id: true },
            });
            if (
              !labourer ||
              !(await isEngaged(tx, access.tenantId, entry.labourerId, projectId, input.date))
            )
              throw attendanceConflict(
                "not-engaged",
                "Only labourers engaged on the project that day can be recorded.",
                { labourerId: entry.labourerId },
              );
            await tx.attendanceRecord.create({
              data: {
                tenantId: access.tenantId,
                dayId: day.id,
                projectId,
                siteId: input.siteId,
                workDate: fromCalendarDate(input.date),
                labourerId: entry.labourerId,
                ...entryColumns(values),
                captureMethod: "web_manual",
                createdBy: access.userId,
                updatedBy: access.userId,
              },
            });
            createdCount += 1;
          }
          changed.push(entry.labourerId);
        }
        if (changed.length) {
          await tx.attendanceDay.update({
            where: { id: day.id },
            data: { version: { increment: 1 } },
          });
          await this.anomalies.refresh(
            tx,
            access.tenantId,
            changed.map((labourerId) => ({ labourerId, date: input.date })),
          );
          await this.commands.audit(scope, "attendance.muster_saved", day.id, {
            projectId,
            siteId: input.siteId,
            date: input.date,
            created: createdCount,
            updated: updatedCount,
            captureMethod: "web_manual",
          });
        }
        return this.build(scope, projectId, input.siteId, input.date, null);
      },
    );
  }

  submit(
    principal: Principal,
    dayId: string,
    input: z.output<typeof dayActionRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "attendance.day.submit",
      { dayId, input },
      async (scope) => {
        const { tx, access } = scope;
        const day = await this.day(scope, dayId, "attendance.record");
        if (day.version !== input.version) throw versionConflict();
        if (day.status !== "draft")
          throw attendanceConflict("invalid-transition", "Only a draft day can be submitted.");
        await this.assertPeriodEditable(tx, access.tenantId, day.periodId);
        const records = await tx.attendanceRecord.findMany({
          where: { tenantId: access.tenantId, dayId },
          select: { labourerId: true },
        });
        if (!records.length)
          throw attendanceConflict("day-empty", "Record at least one labourer first.");
        await this.transition(tx, day, {
          status: "submitted",
          submittedBy: access.userId,
        });
        const date = toCalendarDate(day.workDate);
        await this.anomalies.refresh(
          tx,
          access.tenantId,
          records.map((record) => ({ labourerId: record.labourerId, date })),
        );
        await this.commands.audit(scope, "attendance.day_submitted", dayId, {
          projectId: day.projectId,
          siteId: day.siteId,
          date,
          records: records.length,
        });
        return this.build(scope, day.projectId, day.siteId, date, null);
      },
    );
  }

  confirm(
    principal: Principal,
    dayId: string,
    input: z.output<typeof dayActionRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "attendance.day.confirm",
      { dayId, input },
      async (scope) => {
        const { tx, access } = scope;
        const day = await this.day(scope, dayId, "attendance.confirm");
        if (day.version !== input.version) throw versionConflict();
        if (day.status !== "submitted")
          throw attendanceConflict("invalid-transition", "Only a submitted day can be confirmed.");
        await this.assertPeriodEditable(tx, access.tenantId, day.periodId);
        if (day.submittedBy === access.userId)
          throw samePerson("The person who submitted a day cannot confirm it.");
        const recordedByCaller = await tx.attendanceRecord.findFirst({
          where: {
            tenantId: access.tenantId,
            dayId,
            OR: [{ createdBy: access.userId }, { updatedBy: access.userId }],
          },
          select: { id: true },
        });
        if (recordedByCaller)
          throw samePerson("Someone who recorded attendance on this day cannot confirm it.");
        await this.transition(tx, day, { status: "confirmed", confirmedBy: access.userId });
        const date = toCalendarDate(day.workDate);
        await this.commands.audit(scope, "attendance.day_confirmed", dayId, {
          projectId: day.projectId,
          siteId: day.siteId,
          date,
        });
        await this.commands.outbox(scope, "attendance.day_confirmed", dayId, {
          projectId: day.projectId,
          siteId: day.siteId,
          date,
        });
        return this.build(scope, day.projectId, day.siteId, date, null);
      },
    );
  }

  returnDay(
    principal: Principal,
    dayId: string,
    input: z.output<typeof returnDayRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "attendance.day.return",
      { dayId, input },
      async (scope) => {
        const { tx, access } = scope;
        const day = await this.day(scope, dayId, "attendance.confirm");
        if (day.version !== input.version) throw versionConflict();
        if (day.status !== "submitted")
          throw attendanceConflict("invalid-transition", "Only a submitted day can be returned.");
        await this.assertPeriodEditable(tx, access.tenantId, day.periodId);
        if (day.submittedBy === access.userId)
          throw samePerson("The person who submitted a day cannot return it; ask a confirmer.");
        // A pending correction was asked against the submitted values: returning the day would
        // let them change underneath it (review finding 4). Decide the corrections first.
        const pending = await tx.attendanceCorrection.count({
          where: { tenantId: access.tenantId, dayId, status: "pending" },
        });
        if (pending)
          throw attendanceConflict(
            "pending-corrections",
            "Decide the pending corrections of this day before returning it.",
          );
        await this.transition(tx, day, {
          status: "draft",
          submittedBy: null,
          submittedAt: null,
          returnedBy: access.userId,
          returnReason: input.reason,
        });
        const date = toCalendarDate(day.workDate);
        await this.commands.audit(scope, "attendance.day_returned", dayId, {
          projectId: day.projectId,
          date,
          reasonGiven: true,
        });
        return this.build(scope, day.projectId, day.siteId, date, null);
      },
    );
  }

  /** The muster response for a project site and date. */
  async build(
    scope: Scope,
    projectId: string,
    siteId: string,
    date: string,
    gangId: string | null,
  ): Promise<MusterResponse> {
    const { tx, access } = scope;
    const tenantId = access.tenantId;
    const effective = await this.access.project(scope, projectId, "attendance.view");
    const project = effective.project;
    const site = await this.site(tx, tenantId, projectId, siteId, true);
    const sites = await tx.site.findMany({
      where: { tenantId, projectId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });
    const gangs = await tx.gang.findMany({
      where: { tenantId, projectId, status: "active" },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });
    const day = await tx.attendanceDay.findUnique({
      where: {
        tenantId_siteId_workDate: { tenantId, siteId, workDate: fromCalendarDate(date) },
      },
    });
    const records = day
      ? await tx.attendanceRecord.findMany({ where: { tenantId, dayId: day.id } })
      : [];
    const workDate = fromCalendarDate(date);
    const engagements = await tx.labourEngagement.findMany({
      where: {
        tenantId,
        projectId,
        startDate: { lte: workDate },
        OR: [{ endDate: null }, { endDate: { gte: workDate } }],
      },
      select: { labourerId: true },
    });
    const engaged = new Set(engagements.map((row) => row.labourerId));
    const labourerIds = [...new Set([...engaged, ...records.map((row) => row.labourerId)])];
    const labourers = labourerIds.length
      ? await tx.labourer.findMany({
          where: { tenantId, id: { in: labourerIds } },
          select: {
            id: true,
            workerNo: true,
            fullName: true,
            status: true,
            doNotRehire: true,
            tradeId: true,
          },
        })
      : [];
    const trades = await tx.trade.findMany({
      where: { tenantId, id: { in: [...new Set(labourers.map((row) => row.tradeId))] } },
      select: { id: true, nameEn: true, nameSw: true },
    });
    const memberships = labourerIds.length
      ? await tx.gangMembership.findMany({
          where: {
            tenantId,
            projectId,
            labourerId: { in: labourerIds },
            joinedOn: { lte: workDate },
            OR: [{ leftOn: null }, { leftOn: { gte: workDate } }],
          },
          select: { labourerId: true, gangId: true },
        })
      : [];
    const gangOf = new Map(memberships.map((row) => [row.labourerId, row.gangId]));
    const gangNames = new Map(gangs.map((gang) => [gang.id, gang.name]));
    const others = labourerIds.length
      ? await tx.attendanceRecord.findMany({
          where: {
            tenantId,
            labourerId: { in: labourerIds },
            workDate,
            siteId: { not: siteId },
          },
          select: { labourerId: true, siteId: true, projectId: true, status: true },
        })
      : [];
    const otherSites = others.length
      ? await tx.site.findMany({
          where: { tenantId, id: { in: [...new Set(others.map((row) => row.siteId))] } },
          select: { id: true, name: true, projectId: true },
        })
      : [];
    const otherProjects = others.length
      ? await tx.project.findMany({
          where: { tenantId, id: { in: [...new Set(others.map((row) => row.projectId))] } },
          select: { id: true, code: true },
        })
      : [];
    const anomalies = records.length
      ? await tx.attendanceAnomaly.findMany({
          where: { tenantId, recordId: { in: records.map((row) => row.id) }, status: "open" },
          select: { id: true, recordId: true, kind: true, severity: true, status: true },
        })
      : [];
    const corrections = day
      ? await tx.attendanceCorrection.findMany({
          where: { tenantId, dayId: day.id },
          orderBy: { requestedAt: "desc" },
        })
      : [];
    const ctx = await this.calculator.context(tx, tenantId);
    const inputs = records.length
      ? await this.calculator.inputs(
          tx,
          tenantId,
          records.map((row) => row.labourerId),
          date,
          date,
        )
      : new Map();
    const results = this.calculator.computeAll(ctx, inputs);
    const ruleRow = this.calculator.ruleRow(ctx, projectId, date);
    const period = await this.periods.covering(tx, tenantId, projectId, date);
    const periodView = period
      ? periodSummary(period)
      : await this.virtualPeriod(tx, tenantId, projectId, date);
    const names = await displayNames(tx, [
      ...records.map((row) => row.updatedBy),
      ...records.map((row) => row.createdBy),
      day?.submittedBy ?? null,
      day?.confirmedBy ?? null,
      day?.returnedBy ?? null,
      ...corrections.flatMap((row) => [row.requestedBy, row.decidedBy]),
      ruleRow?.createdBy ?? null,
    ]);
    const today = nairobiDate();
    const lock = this.lock(project.status, date, today, periodView.status, day);
    const permissions = {
      canRecord: effective.effective.has("attendance.record"),
      canConfirm: effective.effective.has("attendance.confirm"),
      canOverride: effective.effective.has("attendance.override"),
      canReview: effective.effective.has("attendance.review_anomalies"),
    };
    const labourerNames = new Map(labourers.map((row) => [row.id, row]));
    const rows = labourers
      .filter((labourer) => !gangId || gangOf.get(labourer.id) === gangId)
      .sort((a, b) => (a.workerNo < b.workerNo ? -1 : a.workerNo > b.workerNo ? 1 : 0))
      .map((labourer) => {
        const record = records.find((row) => row.labourerId === labourer.id) ?? null;
        const trade = trades.find((row) => row.id === labourer.tradeId);
        const result = results.get(dayKey(labourer.id, date));
        const allocation = record
          ? result?.records.find((entry) => entry.recordId === record.id)
          : undefined;
        return {
          labourer: {
            id: labourer.id,
            workerNo: labourer.workerNo,
            fullName: labourer.fullName,
            tradeNameEn: trade?.nameEn ?? "—",
            tradeNameSw: trade?.nameSw ?? "—",
            status: labourer.status as "active" | "inactive" | "left",
            doNotRehire: labourer.doNotRehire,
            gangId: gangOf.get(labourer.id) ?? null,
            gangName: gangNames.get(gangOf.get(labourer.id) ?? "") ?? null,
            engaged: engaged.has(labourer.id),
          },
          record: record
            ? {
                id: record.id,
                ...entryValues(record),
                captureMethod: record.captureMethod as "web_manual",
                corrected: record.corrected,
                version: record.version,
                recordedBy: actor(names, record.updatedBy),
                updatedAt: record.updatedAt.toISOString(),
                computed:
                  allocation && result?.dayType && !result.missingRule
                    ? {
                        dayType: result.dayType,
                        halfDays: allocation.halfDays,
                        workedMinutes: allocation.workedMinutes,
                        normalMinutes: allocation.normalMinutes,
                        overtimeMinutes: allocation.overtimeMinutes,
                        lateMinutes: allocation.lateMinutes,
                        breakMinutes: allocation.breakMinutes,
                      }
                    : null,
              }
            : null,
          anomalies: anomalies
            .filter((row) => row.recordId === record?.id)
            .map((row) => ({
              id: row.id,
              kind: row.kind as AnomalyKind,
              severity: ANOMALY_SEVERITY[row.kind as AnomalyKind],
              status: "open" as const,
            })),
          otherSites: others
            .filter((row) => row.labourerId === labourer.id)
            .map((row) => {
              const other = otherSites.find((entry) => entry.id === row.siteId);
              return {
                siteId: row.siteId,
                siteName: other?.name ?? "—",
                projectCode: otherProjects.find((entry) => entry.id === row.projectId)?.code ?? "—",
                status: row.status as "present",
              };
            }),
        };
      });
    const holidayName = ctx.holidayNames.get(date) ?? null;
    const recorders = [...new Set(records.flatMap((row) => [row.createdBy, row.updatedBy]))].map(
      (id) => actor(names, id),
    );
    return musterResponseSchema.parse({
      project: { id: project.id, code: project.code, name: project.name, status: project.status },
      site: { id: site.id, name: site.name },
      sites,
      gangs,
      gangId,
      date,
      today,
      dayType: ruleRow ? dayTypeOf(date, dayRule(ruleRow).restDays, ctx.holidays) : null,
      holiday: holidayName,
      rule: ruleRow
        ? toRule(ruleRow, ctx.rules, today, names, new Map([[project.id, project.code]]))
        : null,
      period: periodView,
      day: day
        ? {
            id: day.id,
            status: day.status,
            version: day.version,
            submittedBy: optionalActor(names, day.submittedBy),
            submittedAt: iso(day.submittedAt),
            confirmedBy: optionalActor(names, day.confirmedBy),
            confirmedAt: iso(day.confirmedAt),
            returnedBy: optionalActor(names, day.returnedBy),
            returnedAt: iso(day.returnedAt),
            returnReason: day.returnReason,
            recorders,
          }
        : null,
      rows,
      corrections: corrections.map((row) =>
        toCorrection(row, names, labourerNames.get(row.labourerId) ?? null),
      ),
      editable: lock === null && permissions.canRecord,
      locked: lock,
      permissions,
    });
  }

  private lock(
    projectStatus: string,
    date: string,
    today: string,
    periodStatus: string,
    day: DayRow | null,
  ): MusterLock | null {
    if (projectStatus === "closed" || projectStatus === "cancelled") return "project-read-only";
    if (date > today) return "future-date";
    if (periodStatus === "approved") return "period-approved";
    if (periodStatus === "submitted") return "period-submitted";
    if (day?.status === "submitted") return "day-submitted";
    if (day?.status === "confirmed") return "day-confirmed";
    return null;
  }

  private async virtualPeriod(tx: Tx, tenantId: string, projectId: string, date: string) {
    const window = await this.periods.window(tx, tenantId, projectId, date);
    return {
      id: null,
      startDate: window.startDate,
      endDate: window.endDate,
      cutoffAt: window.cutoffAt.toISOString(),
      status: "open" as const,
      due: window.cutoffAt.getTime() <= Date.now(),
    };
  }

  private async site(tx: Tx, tenantId: string, projectId: string, siteId: string, read = false) {
    const site = await tx.site.findFirst({
      where: { tenantId, projectId, id: siteId },
      select: { id: true, name: true },
    });
    if (!site) {
      if (read) throw new NotFoundException("Site not found");
      throw attendanceBadRequest("site-not-in-project", "Choose a site of this project.");
    }
    return site;
  }

  /** A day the caller may act on with `permission` on its project (404 outside the company). */
  private async day(
    scope: Scope,
    dayId: string,
    permission: "attendance.record" | "attendance.confirm",
  ) {
    const day = await scope.tx.attendanceDay.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: dayId } },
    });
    if (!day) throw new NotFoundException("Day not found");
    const { project } = await this.access.project(scope, day.projectId, permission);
    this.access.assertWritable(project);
    return day;
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

  private async transition(tx: Tx, day: DayRow, data: Prisma.AttendanceDayUpdateManyMutationInput) {
    const updated = await tx.attendanceDay.updateMany({
      where: { tenantId: day.tenantId, id: day.id, version: day.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (!updated.count) throw versionConflict();
  }
}
