import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { formatClock, nairobiDate, parseClock } from "@pm-buddy/domain";
import { DEMO_TIMESHEET_RULE, KENYA_PUBLIC_HOLIDAYS, type HolidayKind } from "@pm-buddy/types";
import {
  attendanceSettingsResponseSchema,
  holidayResponseSchema,
  messageResponseSchema,
  timesheetRuleResponseSchema,
  type PublicHoliday,
} from "@pm-buddy/validation";
import type { Request } from "express";
import type { z } from "zod";
import type {
  createHolidayRequestSchema,
  createTimesheetRuleRequestSchema,
  updatePeriodSettingsRequestSchema,
} from "@pm-buddy/validation";
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
  versionConflict,
} from "./attendance-support.js";
import { toRule, type HolidayRow } from "./attendance-mappers.js";
import { loadPeriodSettings } from "./period-store.js";

type Tx = Prisma.TransactionClient;

/** Whether a date lies inside a submitted or approved period of any project of the company. */
async function lockedDates(tx: Tx, tenantId: string): Promise<(date: string) => boolean> {
  const periods = await tx.timesheetPeriod.findMany({
    where: { tenantId, status: { in: ["submitted", "approved"] } },
    select: { startDate: true, endDate: true },
  });
  const ranges = periods.map((period) => [
    toCalendarDate(period.startDate),
    toCalendarDate(period.endDate),
  ]);
  return (date) => ranges.some(([from, to]) => date >= from! && date <= to!);
}

export function toHoliday(row: HolidayRow, locked: boolean): PublicHoliday {
  return {
    id: row.id,
    date: toCalendarDate(row.holidayDate),
    nameEn: row.nameEn,
    nameSw: row.nameSw,
    kind: row.kind as HolidayKind,
    source: row.source,
    complianceStatus: row.complianceStatus as PublicHoliday["complianceStatus"],
    locked,
  };
}

/**
 * Timesheet rules (company default and project overrides), the period cut-off and the public
 * holiday calendar (brief §5.5). Company configuration needs config.manage; a project override
 * needs timesheets.manage_rules on the project. Every change is audited (field names only).
 */
@Injectable()
export class AttendanceSettingsService {
  constructor(
    private readonly commands: AttendanceCommands,
    private readonly access: AttendanceAccess,
  ) {}

  get(principal: Principal, req: Request) {
    return this.commands.read(principal, req, (scope) => this.view(scope));
  }

  updatePeriods(
    principal: Principal,
    input: z.output<typeof updatePeriodSettingsRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "attendance.settings.periods",
      input,
      async (scope) => {
        const { tx, access } = scope;
        await this.access.requireCompany(scope, "config.manage");
        const current = await loadPeriodSettings(tx, access.tenantId);
        if (current.version !== input.version) throw versionConflict();
        const data = {
          weekEndsOn: input.weekEndsOn,
          cutoffMinutes: parseClock(input.cutoffTime)!,
          paydayWeekday: input.paydayWeekday,
          updatedBy: access.userId,
        };
        if (input.version === 0)
          await tx.attendanceSettings.create({ data: { tenantId: access.tenantId, ...data } });
        else {
          const updated = await tx.attendanceSettings.updateMany({
            where: { tenantId: access.tenantId, version: input.version },
            data: { ...data, version: { increment: 1 } },
          });
          if (!updated.count) throw versionConflict();
        }
        await this.commands.audit(scope, "attendance.settings_updated", access.tenantId, {
          fields: ["weekEndsOn", "cutoffTime", "paydayWeekday"],
        });
        return this.view(scope);
      },
    );
  }

  createRule(
    principal: Principal,
    input: z.output<typeof createTimesheetRuleRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(principal, req, "attendance.rules.create", input, async (scope) => {
      const { tx, access } = scope;
      await this.requireRuleScope(scope, input.projectId);
      // A version may start in the past (a company starting to record earlier days) but never
      // inside a submitted or approved period: approved timesheets keep the rules they used.
      const locked = await tx.timesheetPeriod.findFirst({
        where: {
          tenantId: access.tenantId,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          status: { in: ["submitted", "approved"] },
          endDate: { gte: fromCalendarDate(input.effectiveFrom) },
        },
        select: { id: true },
      });
      if (locked)
        throw attendanceConflict(
          "period-locked",
          "A rule cannot take effect inside a submitted or approved timesheet period.",
        );
      const clash = await tx.timesheetRuleVersion.findFirst({
        where: {
          tenantId: access.tenantId,
          projectId: input.projectId,
          effectiveFrom: fromCalendarDate(input.effectiveFrom),
        },
        select: { id: true },
      });
      if (clash)
        throw attendanceConflict(
          "rule-exists",
          "A version for this scope already starts on that day.",
        );
      const row = await tx.timesheetRuleVersion.create({
        data: {
          tenantId: access.tenantId,
          projectId: input.projectId,
          effectiveFrom: fromCalendarDate(input.effectiveFrom),
          normalMinutes: input.normalMinutes,
          defaultBreakMinutes: input.defaultBreakMinutes,
          breakAfterMinutes: input.breakAfterMinutes,
          dayStartMinutes: input.dayStartMinutes,
          lateGraceMinutes: input.lateGraceMinutes,
          halfDayThresholdMinutes: input.halfDayThresholdMinutes,
          maxPlausibleMinutes: input.maxPlausibleMinutes,
          restDays: [...input.restDays],
          otWeekdayMultiplier: input.otWeekdayMultiplier,
          otRestDayMultiplier: input.otRestDayMultiplier,
          otHolidayMultiplier: input.otHolidayMultiplier,
          // COMPLIANCE-REVIEW: CR-PAY-08. Approval of legal values needs a named reviewer.
          complianceStatus: "unverified",
          sourceReference: input.sourceReference,
          createdBy: access.userId,
        },
      });
      await this.commands.audit(scope, "timesheet.rule_created", row.id, {
        projectId: input.projectId,
        effectiveFrom: input.effectiveFrom,
      });
      return timesheetRuleResponseSchema.parse({ rule: await this.rule(scope, row.id) });
    });
  }

  deleteRule(principal: Principal, ruleId: string, req: Request) {
    return this.commands.run(
      principal,
      req,
      "attendance.rules.delete",
      { ruleId },
      async (scope) => {
        const { tx, access } = scope;
        const row = await tx.timesheetRuleVersion.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: ruleId } },
        });
        if (!row) throw new NotFoundException("Rule not found");
        await this.requireRuleScope(scope, row.projectId);
        if (toCalendarDate(row.effectiveFrom) <= nairobiDate())
          throw attendanceConflict(
            "rule-in-force",
            "Only a version that has not started can be cancelled.",
          );
        await tx.timesheetRuleVersion.delete({ where: { id: row.id } });
        await this.commands.audit(scope, "timesheet.rule_deleted", row.id, {
          projectId: row.projectId,
          effectiveFrom: toCalendarDate(row.effectiveFrom),
        });
        return messageResponseSchema.parse({ message: "Rule version cancelled." });
      },
    );
  }

  /** Installs the Q-C3 demonstration rule as the company default when none exists. */
  installDefaultRule(principal: Principal, req: Request) {
    return this.commands.run(principal, req, "attendance.rules.defaults", {}, async (scope) => {
      const { tx, access } = scope;
      await this.access.requireCompany(scope, "config.manage");
      const existing = await tx.timesheetRuleVersion.findFirst({
        where: { tenantId: access.tenantId, projectId: null },
        select: { id: true },
      });
      if (!existing) {
        const { sourceReference, ...values } = DEMO_TIMESHEET_RULE;
        const row = await tx.timesheetRuleVersion.create({
          data: {
            tenantId: access.tenantId,
            projectId: null,
            effectiveFrom: fromCalendarDate(nairobiDate()),
            ...values,
            restDays: [...values.restDays],
            complianceStatus: "unverified",
            sourceReference,
            createdBy: access.userId,
          },
        });
        await this.commands.audit(scope, "timesheet.rule_created", row.id, {
          projectId: null,
          effectiveFrom: nairobiDate(),
          source: "demo_defaults",
        });
      }
      return this.view(scope);
    });
  }

  createHoliday(
    principal: Principal,
    input: z.output<typeof createHolidayRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(principal, req, "attendance.holidays.create", input, async (scope) => {
      const { tx, access } = scope;
      await this.access.requireCompany(scope, "config.manage");
      const locked = await lockedDates(tx, access.tenantId);
      if (locked(input.date))
        throw attendanceConflict(
          "period-locked",
          "The date is inside a submitted or approved timesheet period.",
        );
      const clash = await tx.publicHoliday.findUnique({
        where: {
          tenantId_holidayDate: {
            tenantId: access.tenantId,
            holidayDate: fromCalendarDate(input.date),
          },
        },
        select: { id: true },
      });
      if (clash) throw attendanceConflict("holiday-exists", "That date is already a holiday.");
      const row = await tx.publicHoliday.create({
        data: {
          tenantId: access.tenantId,
          holidayDate: fromCalendarDate(input.date),
          nameEn: input.nameEn,
          nameSw: input.nameSw,
          kind: input.kind,
          source: input.source,
          createdBy: access.userId,
        },
      });
      await this.commands.audit(scope, "attendance.holiday_added", row.id, {
        date: input.date,
        kind: input.kind,
      });
      return holidayResponseSchema.parse({ holiday: toHoliday(row, false) });
    });
  }

  deleteHoliday(principal: Principal, holidayId: string, req: Request) {
    return this.commands.run(
      principal,
      req,
      "attendance.holidays.delete",
      { holidayId },
      async (scope) => {
        const { tx, access } = scope;
        await this.access.requireCompany(scope, "config.manage");
        const row = await tx.publicHoliday.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: holidayId } },
        });
        if (!row) throw new NotFoundException("Holiday not found");
        const locked = await lockedDates(tx, access.tenantId);
        if (locked(toCalendarDate(row.holidayDate)))
          throw attendanceConflict(
            "period-locked",
            "The date is inside a submitted or approved timesheet period.",
          );
        await tx.publicHoliday.delete({ where: { id: row.id } });
        await this.commands.audit(scope, "attendance.holiday_removed", row.id, {
          date: toCalendarDate(row.holidayDate),
        });
        return messageResponseSchema.parse({ message: "Holiday removed." });
      },
    );
  }

  /** Adds the 2026–2027 Kenyan calendar (packages/types) for dates not yet in the company's list. */
  installHolidays(principal: Principal, req: Request) {
    return this.commands.run(principal, req, "attendance.holidays.defaults", {}, async (scope) => {
      const { tx, access } = scope;
      await this.access.requireCompany(scope, "config.manage");
      const locked = await lockedDates(tx, access.tenantId);
      const existing = await tx.publicHoliday.findMany({
        where: { tenantId: access.tenantId },
        select: { holidayDate: true },
      });
      const taken = new Set(existing.map((row) => toCalendarDate(row.holidayDate)));
      let added = 0;
      for (const holiday of KENYA_PUBLIC_HOLIDAYS) {
        if (taken.has(holiday.date) || locked(holiday.date)) continue;
        await tx.publicHoliday.create({
          data: {
            tenantId: access.tenantId,
            holidayDate: fromCalendarDate(holiday.date),
            nameEn: holiday.nameEn,
            nameSw: holiday.nameSw,
            kind: holiday.kind,
            source: holiday.source,
            createdBy: access.userId,
          },
        });
        added += 1;
      }
      await this.commands.audit(scope, "attendance.holidays_installed", access.tenantId, {
        added,
      });
      return this.view(scope);
    });
  }

  private async requireRuleScope(scope: Scope, projectId: string | null) {
    if (projectId === null) {
      await this.access.requireCompany(scope, "config.manage");
      return;
    }
    const { project } = await this.access.project(scope, projectId, "timesheets.manage_rules");
    this.access.assertWritable(project);
  }

  private async rule(scope: Scope, ruleId: string) {
    const { tx, access } = scope;
    const rows = await tx.timesheetRuleVersion.findMany({ where: { tenantId: access.tenantId } });
    const row = rows.find((candidate) => candidate.id === ruleId)!;
    const names = await displayNames(tx, [row.createdBy]);
    const projects = row.projectId
      ? await tx.project.findMany({
          where: { tenantId: access.tenantId, id: row.projectId },
          select: { id: true, code: true },
        })
      : [];
    return toRule(row, rows, nairobiDate(), names, new Map(projects.map((p) => [p.id, p.code])));
  }

  private async view(scope: Scope) {
    const { tx, access } = scope;
    const canConfigure = access.permissions.has("config.manage");
    const ruleSet = await this.access.projectsWith(scope, "timesheets.manage_rules");
    const viewSet = await this.access.projectsWith(scope, "attendance.view");
    const isEmpty = (set: typeof ruleSet) => set !== "all" && set.length === 0;
    if (!canConfigure && isEmpty(ruleSet) && isEmpty(viewSet))
      throw new ForbiddenException("Permission required: attendance.view");
    const today = nairobiDate();
    const settings = await loadPeriodSettings(tx, access.tenantId);
    const projects = await tx.project.findMany({
      where: { tenantId: access.tenantId },
      select: { id: true, code: true, name: true, status: true },
      orderBy: { code: "asc" },
    });
    const visible = (projectId: string) =>
      access.tenantWide || inProjects(viewSet, projectId) || inProjects(ruleSet, projectId);
    const rows = (
      await tx.timesheetRuleVersion.findMany({
        where: { tenantId: access.tenantId },
        orderBy: [{ projectId: "asc" }, { effectiveFrom: "desc" }],
      })
    ).filter((row) => row.projectId === null || visible(row.projectId));
    const names = await displayNames(
      tx,
      rows.map((row) => row.createdBy),
    );
    const holidays = await tx.publicHoliday.findMany({
      where: { tenantId: access.tenantId },
      orderBy: { holidayDate: "asc" },
    });
    const locked = await lockedDates(tx, access.tenantId);
    const codes = new Map(projects.map((project) => [project.id, project.code]));
    return attendanceSettingsResponseSchema.parse({
      today,
      periodSettings: {
        frequency: settings.frequency,
        weekEndsOn: settings.weekEndsOn,
        cutoffTime: formatClock(settings.cutoffMinutes),
        paydayWeekday: settings.paydayWeekday,
        version: settings.version,
      },
      rules: rows.map((row) => toRule(row, rows, today, names, codes)),
      holidays: holidays.map((row) => toHoliday(row, locked(toCalendarDate(row.holidayDate)))),
      canConfigure,
      ruleProjects: projects
        .filter(
          (project) =>
            inProjects(ruleSet, project.id) &&
            project.status !== "closed" &&
            project.status !== "cancelled",
        )
        .map(({ id, code, name }) => ({ id, code, name })),
    });
  }
}
