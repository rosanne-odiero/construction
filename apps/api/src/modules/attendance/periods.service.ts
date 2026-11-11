import { Injectable, NotFoundException } from "@nestjs/common";
import {
  addCalendarDays,
  addTotals,
  emptyTotals,
  formatClock,
  isPeriodDue,
  nairobiDate,
  sumDays,
  timesheetDays,
  totalsOf,
} from "@pm-buddy/domain";
import {
  labourerAttendanceResponseSchema,
  periodDetailResponseSchema,
  periodsResponseSchema,
  timesheetLinesResponseSchema,
  type Adjustment,
  type PeriodDetailResponse,
  type TimesheetLine,
  type TimesheetPeriod,
} from "@pm-buddy/validation";
import type { Request } from "express";
import type { z } from "zod";
import type {
  labourerAttendanceQuerySchema,
  periodActionRequestSchema,
  rejectPeriodRequestSchema,
} from "@pm-buddy/validation";
import { AppConfig } from "../../config/app-config.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  attendanceConflict,
  AttendanceAccess,
  AttendanceCommands,
  inProjects,
  samePerson,
  versionConflict,
} from "./attendance-support.js";
import {
  iso,
  optionalActor,
  toRule,
  totalsWire,
  type Names,
  type PeriodRow,
  type StoredDay,
} from "./attendance-mappers.js";
import { toAdjustments } from "./adjustments.service.js";
import { AnomalyEvaluator, loadPeriodSettings } from "./period-store.js";
import { publicDay, sumLines, TimesheetCalculator } from "./timesheet-calculator.js";

type Tx = Prisma.TransactionClient;

export function toPeriod(row: PeriodRow, names: Names, now = new Date()): TimesheetPeriod {
  return {
    id: row.id,
    projectId: row.projectId,
    startDate: toCalendarDate(row.startDate),
    endDate: toCalendarDate(row.endDate),
    cutoffAt: row.cutoffAt.toISOString(),
    status: row.status as TimesheetPeriod["status"],
    due: isPeriodDue(row.cutoffAt, now),
    version: row.version,
    submittedBy: optionalActor(names, row.submittedBy),
    submittedAt: iso(row.submittedAt),
    approvedBy: optionalActor(names, row.approvedBy),
    approvedAt: iso(row.approvedAt),
    rejectedBy: optionalActor(names, row.rejectedBy),
    rejectedAt: iso(row.rejectedAt),
    rejectionReason: row.rejectionReason,
    submittedDigest: row.submittedDigest,
  };
}

const periodNames = (row: PeriodRow) => [row.submittedBy, row.approvedBy, row.rejectedBy];

/**
 * Timesheet periods with cut-off and lock (QUESTIONS Q-C4). Approval writes the immutable
 * `timesheet_lines` snapshot that payroll (D4.1) reads: one `attendance` line per labourer and one
 * `adjustment` line per approved adjustment landing in the period, each with the rule versions and
 * source attendance record IDs it was computed from. Submitting needs timesheets.submit; approving
 * and rejecting timesheets.approve and a person other than the submitter.
 */
@Injectable()
export class PeriodsService {
  constructor(
    private readonly commands: AttendanceCommands,
    private readonly access: AttendanceAccess,
    private readonly calculator: TimesheetCalculator,
    private readonly anomalies: AnomalyEvaluator,
    private readonly config: AppConfig,
  ) {}

  list(principal: Principal, projectId: string, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      const { tx, access } = scope;
      const { project } = await this.access.project(scope, projectId, "attendance.view");
      const periods = await tx.timesheetPeriod.findMany({
        where: { tenantId: access.tenantId, projectId },
        orderBy: { startDate: "desc" },
        take: 60,
      });
      const names = await displayNames(tx, periods.flatMap(periodNames));
      const items = [];
      for (const period of periods) {
        const days = await tx.attendanceDay.findMany({
          where: { tenantId: access.tenantId, periodId: period.id },
          select: { status: true },
        });
        const openAnomalies = await tx.attendanceAnomaly.count({
          where: {
            tenantId: access.tenantId,
            projectId,
            status: "open",
            workDate: { gte: period.startDate, lte: period.endDate },
          },
        });
        const labourers = await tx.attendanceRecord.findMany({
          where: {
            tenantId: access.tenantId,
            projectId,
            workDate: { gte: period.startDate, lte: period.endDate },
          },
          select: { labourerId: true },
          distinct: ["labourerId"],
        });
        items.push({
          period: toPeriod(period, names),
          days: days.length,
          unconfirmedDays: days.filter((day) => day.status !== "confirmed").length,
          openAnomalies,
          labourers: labourers.length,
        });
      }
      const settings = await loadPeriodSettings(tx, access.tenantId);
      const pendingAdjustments = await tx.timesheetAdjustment.count({
        where: { tenantId: access.tenantId, projectId, status: "pending" },
      });
      return periodsResponseSchema.parse({
        project: { id: project.id, code: project.code, name: project.name },
        periods: items,
        settings: {
          frequency: settings.frequency,
          weekEndsOn: settings.weekEndsOn,
          cutoffTime: formatClock(settings.cutoffMinutes),
          paydayWeekday: settings.paydayWeekday,
          version: settings.version,
        },
        pendingAdjustments,
      });
    });
  }

  detail(principal: Principal, periodId: string, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      const period = await this.period(scope, periodId);
      await this.access.project(scope, period.projectId, "attendance.view");
      return this.view(scope, period);
    });
  }

  submit(
    principal: Principal,
    periodId: string,
    input: z.output<typeof periodActionRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "timesheet.period.submit",
      { periodId, input },
      async (scope) => {
        const { tx, access } = scope;
        const period = await this.period(scope, periodId);
        const { project } = await this.access.project(scope, period.projectId, "timesheets.submit");
        this.access.assertWritable(project);
        if (period.version !== input.version) throw versionConflict();
        if (period.status !== "open")
          throw attendanceConflict(
            "invalid-transition",
            period.status === "rejected"
              ? "Reopen the rejected period before submitting it again."
              : "Only an open period can be submitted.",
          );
        if (!isPeriodDue(period.cutoffAt))
          throw attendanceConflict("period-not-due", "The period's cut-off has not passed yet.");
        const unconfirmed = await tx.attendanceDay.count({
          where: { tenantId: access.tenantId, periodId, status: { not: "confirmed" } },
        });
        if (unconfirmed)
          throw attendanceConflict(
            "unconfirmed-days",
            "Every muster day of the period must be confirmed first.",
          );
        const pending = await tx.attendanceCorrection.count({
          where: { tenantId: access.tenantId, status: "pending", day: { periodId } },
        });
        if (pending)
          throw attendanceConflict(
            "pending-corrections",
            "Decide the pending corrections of this period first.",
          );
        const computed = await this.submitCore(tx, access.tenantId, access.userId, period);
        await this.commands.audit(scope, "timesheet.period_submitted", periodId, {
          projectId: period.projectId,
          lines: computed.lines.length,
          digest: computed.digest,
        });
        return this.view(scope, await this.period(scope, periodId));
      },
    );
  }

  approve(
    principal: Principal,
    periodId: string,
    input: z.output<typeof periodActionRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "timesheet.period.approve",
      { periodId, input },
      async (scope) => {
        const { tx, access } = scope;
        const period = await this.period(scope, periodId);
        await this.access.project(scope, period.projectId, "timesheets.approve");
        if (period.version !== input.version) throw versionConflict();
        if (period.status !== "submitted")
          throw attendanceConflict(
            "invalid-transition",
            "Only a submitted period can be approved.",
          );
        if (period.submittedBy === access.userId)
          throw samePerson("The person who submitted a period cannot approve it.");
        const open = await this.openAnomalies(tx, access.tenantId, periodId);
        if (open)
          throw attendanceConflict(
            "open-anomalies",
            "Review every open anomaly of the period before approving it.",
          );
        const { computed, unverified } = await this.approveCore(
          tx,
          access.tenantId,
          access.userId,
          period,
        );
        await this.commands.audit(scope, "timesheet.period_approved", periodId, {
          projectId: period.projectId,
          lines: computed.lines.length,
          digest: computed.digest,
          rulesUnverified: unverified,
        });
        return this.view(scope, await this.period(scope, periodId));
      },
    );
  }

  reject(
    principal: Principal,
    periodId: string,
    input: z.output<typeof rejectPeriodRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "timesheet.period.reject",
      { periodId, input },
      async (scope) => {
        const { tx, access } = scope;
        const period = await this.period(scope, periodId);
        await this.access.project(scope, period.projectId, "timesheets.approve");
        if (period.version !== input.version) throw versionConflict();
        if (period.status !== "submitted")
          throw attendanceConflict(
            "invalid-transition",
            "Only a submitted period can be rejected.",
          );
        if (period.submittedBy === access.userId)
          throw samePerson("The person who submitted a period cannot reject it.");
        const updated = await tx.timesheetPeriod.updateMany({
          where: { tenantId: access.tenantId, id: periodId, version: input.version },
          data: {
            status: "rejected",
            rejectedBy: access.userId,
            rejectionReason: input.reason,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw versionConflict();
        await this.commands.audit(scope, "timesheet.period_rejected", periodId, {
          projectId: period.projectId,
          reasonGiven: true,
        });
        return this.view(scope, await this.period(scope, periodId));
      },
    );
  }

  reopen(
    principal: Principal,
    periodId: string,
    input: z.output<typeof periodActionRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "timesheet.period.reopen",
      { periodId, input },
      async (scope) => {
        const { tx, access } = scope;
        const period = await this.period(scope, periodId);
        const { project } = await this.access.project(scope, period.projectId, "timesheets.submit");
        this.access.assertWritable(project);
        if (period.version !== input.version) throw versionConflict();
        if (period.status !== "rejected")
          throw attendanceConflict("invalid-transition", "Only a rejected period can be reopened.");
        const updated = await tx.timesheetPeriod.updateMany({
          where: { tenantId: access.tenantId, id: periodId, version: input.version },
          data: {
            status: "open",
            submittedBy: null,
            submittedAt: null,
            submittedDigest: null,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw versionConflict();
        await this.commands.audit(scope, "timesheet.period_reopened", periodId, {
          projectId: period.projectId,
        });
        return this.view(scope, await this.period(scope, periodId));
      },
    );
  }

  /** The payroll-facing contract: an approved period's immutable lines and their rule versions. */
  lines(principal: Principal, periodId: string, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      const { tx, access } = scope;
      const period = await this.period(scope, periodId);
      const { project } = await this.access.projectAny(scope, period.projectId, [
        "attendance.view",
        "payroll.prepare",
        "finance.view",
      ]);
      if (period.status !== "approved")
        throw attendanceConflict(
          "period-not-approved",
          "Only an approved period has payroll timesheet lines.",
        );
      const lines = await this.snapshotLines(tx, access.tenantId, periodId);
      const ruleIds = [...new Set(lines.flatMap((line) => line.ruleVersionIds))];
      const rules = await tx.timesheetRuleVersion.findMany({
        where: { tenantId: access.tenantId },
      });
      const names = await displayNames(tx, [
        ...periodNames(period),
        ...rules.map((rule) => rule.createdBy),
      ]);
      const codes = new Map([[project.id, project.code]]);
      return timesheetLinesResponseSchema.parse({
        project: { id: project.id, code: project.code, name: project.name },
        period: toPeriod(period, names),
        lines,
        ruleVersions: rules
          .filter((rule) => ruleIds.includes(rule.id))
          .map((rule) => toRule(rule, rules, nairobiDate(), names, codes)),
        holidays: await this.holidays(tx, access.tenantId, period),
      });
    });
  }

  /** A labourer's attendance summary per project (worker panel). */
  labourerSummary(
    principal: Principal,
    labourerId: string,
    query: z.output<typeof labourerAttendanceQuerySchema>,
    req: Request,
  ) {
    return this.commands.read(principal, req, async (scope) => {
      const { tx, access } = scope;
      const labourer = await tx.labourer.findUnique({
        where: { tenantId_id: { tenantId: access.tenantId, id: labourerId } },
        select: { id: true },
      });
      if (!labourer) throw new NotFoundException("Labourer not found");
      const visible = await this.access.projectsWith(scope, "attendance.view");
      const engagements = await tx.labourEngagement.findMany({
        where: { tenantId: access.tenantId, labourerId },
        select: { projectId: true },
      });
      const projectIds = [...new Set(engagements.map((row) => row.projectId))].filter((id) =>
        inProjects(visible, id),
      );
      if (!projectIds.length) throw new NotFoundException("Labourer not found");
      const to = query.to ?? nairobiDate();
      const from = query.from ?? addCalendarDays(to, -55);
      const projects = await tx.project.findMany({
        where: { tenantId: access.tenantId, id: { in: projectIds } },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      });
      const approvedPeriods = await tx.timesheetPeriod.findMany({
        where: {
          tenantId: access.tenantId,
          projectId: { in: projectIds },
          status: "approved",
          endDate: { gte: fromCalendarDate(from) },
          startDate: { lte: fromCalendarDate(to) },
        },
        select: { id: true },
      });
      const approvedIds = new Set(approvedPeriods.map((row) => row.id));
      const lines = approvedIds.size
        ? await tx.timesheetLine.findMany({
            where: { tenantId: access.tenantId, labourerId, periodId: { in: [...approvedIds] } },
          })
        : [];
      const ctx = await this.calculator.context(tx, access.tenantId);
      const inputs = await this.calculator.inputs(tx, access.tenantId, [labourerId], from, to);
      const results = [...this.calculator.computeAll(ctx, inputs).values()];
      const pendingRecords = new Set(
        [...inputs.values()]
          .flat()
          .filter((entry) => !entry.fromLockedPeriod)
          .map((entry) => entry.id),
      );
      const summary = projects.map((project) => {
        const approved = lines
          .filter((line) => line.projectId === project.id)
          .reduce(
            (sum, line) =>
              addTotals(sum, {
                halfDays: line.halfDays,
                workedMinutes: line.workedMinutes,
                normalMinutes: line.normalMinutes,
                overtimeMinutes: {
                  weekday: line.otWeekdayMinutes,
                  rest_day: line.otRestDayMinutes,
                  public_holiday: line.otHolidayMinutes,
                },
                lateMinutes: line.lateMinutes,
                statusCounts: {
                  present: line.presentCount,
                  half_day: line.halfDayCount,
                  absent: line.absentCount,
                  leave: line.leaveCount,
                  sick: line.sickCount,
                },
              }),
            emptyTotals(),
          );
        const days = timesheetDays(results, project.id).map((day) => ({
          ...day,
          allocations: day.allocations.filter((entry) => pendingRecords.has(entry.recordId)),
        }));
        const pending = sumDays(
          days
            .filter((day) => day.allocations.length)
            .map((day) => ({ ...day, totals: totalsOf(day.allocations) })),
        );
        const worked = results
          .filter((result) =>
            result.records.some(
              (record) =>
                record.projectId === project.id &&
                (record.status === "present" || record.status === "half_day"),
            ),
          )
          .map((result) => result.date)
          .sort();
        return {
          projectId: project.id,
          code: project.code,
          name: project.name,
          approved: totalsWire(approved),
          pending: totalsWire(pending),
          lastWorkedOn: worked.at(-1) ?? null,
        };
      });
      const openAnomalies = await tx.attendanceAnomaly.count({
        where: {
          tenantId: access.tenantId,
          labourerId,
          status: "open",
          projectId: { in: projectIds },
        },
      });
      return labourerAttendanceResponseSchema.parse({
        labourerId,
        from,
        to,
        projects: summary,
        openAnomalies,
      });
    });
  }

  /**
   * Submission without the caller checks (also used by the development seed): re-evaluates the
   * anomalies of every record in the period, computes the lines and binds the submission to their
   * digest. The database trigger repeats the cut-off and all-days-confirmed rules.
   */
  async submitCore(tx: Tx, tenantId: string, userId: string, period: PeriodRow) {
    const records = await tx.attendanceRecord.findMany({
      where: {
        tenantId,
        projectId: period.projectId,
        workDate: { gte: period.startDate, lte: period.endDate },
      },
      select: { labourerId: true, workDate: true },
    });
    const ctx = await this.calculator.context(tx, tenantId);
    await this.anomalies.refresh(
      tx,
      tenantId,
      records.map((record) => ({
        labourerId: record.labourerId,
        date: toCalendarDate(record.workDate),
      })),
      ctx,
    );
    const computed = await this.calculator.periodLines(tx, tenantId, period, ctx);
    if (computed.missingRuleDates.length)
      throw attendanceConflict(
        "rules-not-configured",
        "Configure timesheet rules for every recorded date first.",
      );
    const updated = await tx.timesheetPeriod.updateMany({
      where: { tenantId, id: period.id, version: period.version, status: "open" },
      data: {
        status: "submitted",
        submittedBy: userId,
        submittedDigest: computed.digest,
        version: { increment: 1 },
      },
    });
    if (!updated.count) throw versionConflict();
    return computed;
  }

  /**
   * Approval without the caller checks (also used by the development seed): the recomputed lines
   * must match the submitted digest; the period is locked and its lines snapshotted in the same
   * transaction, with an outbox event for payroll.
   */
  async approveCore(tx: Tx, tenantId: string, userId: string, period: PeriodRow) {
    const ctx = await this.calculator.context(tx, tenantId);
    const computed = await this.calculator.periodLines(tx, tenantId, period, ctx);
    const unverified = ctx.rules.some(
      (rule) => computed.ruleIds.includes(rule.id) && rule.complianceStatus !== "approved",
    );
    // COMPLIANCE-REVIEW (INVARIANTS): unverified legal rules cannot drive production pay.
    if (unverified && this.config.get("NODE_ENV") === "production")
      throw attendanceConflict(
        "rules-unverified",
        "The timesheet rules are not approved by a compliance reviewer yet.",
      );
    if (computed.digest !== period.submittedDigest)
      throw attendanceConflict(
        "period-changed",
        "The timesheet changed after it was submitted. Reject it so it can be submitted again.",
      );
    const updated = await tx.timesheetPeriod.updateMany({
      where: { tenantId, id: period.id, version: period.version, status: "submitted" },
      data: { status: "approved", approvedBy: userId, version: { increment: 1 } },
    });
    if (!updated.count) throw versionConflict();
    await tx.timesheetLine.createMany({
      data: computed.lines.map(({ line, stored }) => ({
        tenantId,
        projectId: period.projectId,
        periodId: period.id,
        labourerId: line.labourerId,
        lineKey: line.kind === "attendance" ? "attendance" : `adjustment:${line.adjustmentId}`,
        kind: line.kind,
        adjustmentId: line.adjustmentId,
        originalPeriodId: line.originalPeriodId,
        halfDays: line.totals.halfDays,
        workedMinutes: line.totals.workedMinutes,
        normalMinutes: line.totals.normalMinutes,
        otWeekdayMinutes: line.totals.overtimeMinutes.weekday,
        otRestDayMinutes: line.totals.overtimeMinutes.rest_day,
        otHolidayMinutes: line.totals.overtimeMinutes.public_holiday,
        lateMinutes: line.totals.lateMinutes,
        presentCount: line.totals.statusCounts.present,
        halfDayCount: line.totals.statusCounts.half_day,
        absentCount: line.totals.statusCounts.absent,
        leaveCount: line.totals.statusCounts.leave,
        sickCount: line.totals.statusCounts.sick,
        ruleVersionIds: line.ruleVersionIds,
        recordIds: line.recordIds,
        days: stored as unknown as Prisma.InputJsonValue,
      })),
    });
    await tx.outboxEvent.create({
      data: {
        tenantId,
        topic: "timesheet.period_approved",
        aggregateId: period.id,
        payload: {
          projectId: period.projectId,
          lines: computed.lines.length,
          startDate: toCalendarDate(period.startDate),
          endDate: toCalendarDate(period.endDate),
        },
      },
    });
    return { computed, unverified };
  }

  async view(scope: Scope, period: PeriodRow): Promise<PeriodDetailResponse> {
    const { tx, access } = scope;
    const project = await tx.project.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: access.tenantId, id: period.projectId } },
      select: { id: true, code: true, name: true, status: true },
    });
    const effective = await this.access.project(scope, period.projectId, "attendance.view");
    const ctx = await this.calculator.context(tx, access.tenantId);
    let lines: TimesheetLine[];
    let missingRuleDates: string[] = [];
    let ruleIds: string[];
    if (period.status === "approved") {
      lines = await this.snapshotLines(tx, access.tenantId, period.id);
      ruleIds = [...new Set(lines.flatMap((line) => line.ruleVersionIds))];
    } else {
      const computed = await this.calculator.periodLines(tx, access.tenantId, period, ctx);
      missingRuleDates = computed.missingRuleDates;
      ruleIds = computed.ruleIds;
      lines = await this.named(
        tx,
        access.tenantId,
        computed.lines.map(({ line }) => line),
      );
    }
    const days = await tx.attendanceDay.findMany({
      where: { tenantId: access.tenantId, periodId: period.id, status: { not: "confirmed" } },
      orderBy: [{ workDate: "asc" }],
    });
    const sites = await tx.site.findMany({
      where: { tenantId: access.tenantId, projectId: period.projectId },
      select: { id: true, name: true },
    });
    const pendingCorrections = await tx.attendanceCorrection.count({
      where: { tenantId: access.tenantId, status: "pending", day: { periodId: period.id } },
    });
    const requested = await tx.timesheetAdjustment.findMany({
      where: { tenantId: access.tenantId, originalPeriodId: period.id },
      orderBy: { requestedAt: "desc" },
    });
    const landed = await tx.timesheetAdjustment.findMany({
      where: { tenantId: access.tenantId, targetPeriodId: period.id },
      orderBy: { decidedAt: "asc" },
    });
    const adjustments: { requested: Adjustment[]; landed: Adjustment[] } = {
      requested: await toAdjustments(tx, access.tenantId, requested),
      landed: await toAdjustments(tx, access.tenantId, landed),
    };
    const names = await displayNames(tx, [
      ...periodNames(period),
      ...ctx.rules.map((rule) => rule.createdBy),
    ]);
    const codes = new Map([[project.id, project.code]]);
    const rules = ctx.rules.filter((rule) => ruleIds.includes(rule.id));
    const open = await this.openAnomalies(tx, access.tenantId, period.id);
    const can = (permission: "timesheets.submit" | "timesheets.approve" | "attendance.override") =>
      effective.effective.has(permission);
    const readOnly = project.status === "closed" || project.status === "cancelled";
    return periodDetailResponseSchema.parse({
      project: { id: project.id, code: project.code, name: project.name },
      period: toPeriod(period, names),
      source: period.status === "approved" ? "snapshot" : "live",
      lines,
      totals: totalsWire(sumLines(lines)),
      rules: rules.map((rule) => toRule(rule, ctx.rules, nairobiDate(), names, codes)),
      holidays: await this.holidays(tx, access.tenantId, period),
      blockers: {
        notDue: !isPeriodDue(period.cutoffAt),
        unconfirmedDays: days.map((day) => ({
          dayId: day.id,
          siteId: day.siteId,
          siteName: sites.find((site) => site.id === day.siteId)?.name ?? "—",
          date: toCalendarDate(day.workDate),
          status: day.status,
        })),
        openAnomalies: open,
        missingRuleDates,
        pendingCorrections,
        rulesUnverified: rules.some((rule) => rule.complianceStatus !== "approved"),
      },
      adjustments,
      permissions: {
        canSubmit: can("timesheets.submit") && period.status === "open" && !readOnly,
        canApprove:
          can("timesheets.approve") &&
          period.status === "submitted" &&
          period.submittedBy !== access.userId,
        canReopen: can("timesheets.submit") && period.status === "rejected" && !readOnly,
        canRequestAdjustment: can("attendance.override") && period.status === "approved",
        /** Adjustments are decided by an approver other than the requester (checked on decide). */
        canDecideAdjustments: can("timesheets.approve"),
      },
    });
  }

  private async snapshotLines(tx: Tx, tenantId: string, periodId: string) {
    const rows = await tx.timesheetLine.findMany({
      where: { tenantId, periodId },
      orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
    });
    return this.named(
      tx,
      tenantId,
      rows.map((row) => ({
        labourerId: row.labourerId,
        kind: row.kind as TimesheetLine["kind"],
        adjustmentId: row.adjustmentId,
        originalPeriodId: row.originalPeriodId,
        totals: totalsWire({
          halfDays: row.halfDays,
          workedMinutes: row.workedMinutes,
          normalMinutes: row.normalMinutes,
          overtimeMinutes: {
            weekday: row.otWeekdayMinutes,
            rest_day: row.otRestDayMinutes,
            public_holiday: row.otHolidayMinutes,
          },
          lateMinutes: row.lateMinutes,
          statusCounts: {
            present: row.presentCount,
            half_day: row.halfDayCount,
            absent: row.absentCount,
            leave: row.leaveCount,
            sick: row.sickCount,
          },
        }),
        ruleVersionIds: row.ruleVersionIds,
        recordIds: row.recordIds,
        days: (row.days as unknown as StoredDay[]).map(publicDay),
      })),
    );
  }

  /** Adds worker numbers and names, sorted by worker number (attendance lines first). */
  private async named(
    tx: Tx,
    tenantId: string,
    lines: Omit<TimesheetLine, "workerNo" | "fullName">[],
  ): Promise<TimesheetLine[]> {
    const labourers = lines.length
      ? await tx.labourer.findMany({
          where: { tenantId, id: { in: [...new Set(lines.map((line) => line.labourerId))] } },
          select: { id: true, workerNo: true, fullName: true },
        })
      : [];
    const byId = new Map(labourers.map((row) => [row.id, row]));
    return lines
      .map((line) => ({
        ...line,
        workerNo: byId.get(line.labourerId)?.workerNo ?? "—",
        fullName: byId.get(line.labourerId)?.fullName ?? "—",
      }))
      .sort(
        (a, b) =>
          (a.kind === b.kind ? 0 : a.kind === "attendance" ? -1 : 1) ||
          (a.workerNo < b.workerNo ? -1 : a.workerNo > b.workerNo ? 1 : 0),
      );
  }

  private async holidays(tx: Tx, tenantId: string, period: PeriodRow) {
    const rows = await tx.publicHoliday.findMany({
      where: { tenantId, holidayDate: { gte: period.startDate, lte: period.endDate } },
      orderBy: { holidayDate: "asc" },
    });
    return rows.map((row) => ({
      date: toCalendarDate(row.holidayDate),
      nameEn: row.nameEn,
      nameSw: row.nameSw,
    }));
  }

  private openAnomalies(tx: Tx, tenantId: string, periodId: string) {
    return tx.attendanceAnomaly.count({
      where: { tenantId, status: "open", record: { day: { periodId } } },
    });
  }

  private async period(scope: Scope, periodId: string): Promise<PeriodRow> {
    const period = await scope.tx.timesheetPeriod.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: periodId } },
    });
    if (!period) throw new NotFoundException("Period not found");
    return period;
  }
}
