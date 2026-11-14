import { Injectable, NotFoundException } from "@nestjs/common";
import { checkDelayDays, countWorkingDays, nairobiDate } from "@pm-buddy/domain";
import type { DelayCause, Permission } from "@pm-buddy/types";
import {
  scheduleDelayResponseSchema,
  scheduleDelaysResponseSchema,
  type AmendDelayRequest,
  type CreateDelayRequest,
  type ScheduleDelay,
  type ScheduleDelayVersion,
  type WithdrawDelayRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { isUniqueViolation } from "../../common/database-errors.js";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { peopleOf } from "../procurement/procurement-mappers.js";
import { ProjectAccess } from "../projects/project-access.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  canEditSchedule,
  loadCalendar,
  requireDelayLogReader,
  scheduleProblem,
  type ScheduleProject,
  scheduleVersionConflict,
} from "./schedule-model.js";

type DelayRow = Prisma.ScheduleDelayGetPayload<{
  include: {
    activities: { include: { activity: { select: { id: true; code: true; name: true } } } };
    siteDiary: { select: { id: true; date: true; siteId: true } };
  };
}>;
const delayInclude = {
  activities: { include: { activity: { select: { id: true, code: true, name: true } } } },
  siteDiary: { select: { id: true, date: true, siteId: true } },
} as const;

const dayMessages = {
  "delay-date-future": "A delay cannot be recorded for future dates",
  "delay-dates-invalid": "The delay must end on or after its start, in whole or half days",
  "delay-days-exceed-range": "The working days lost exceed the working days in the period",
} as const;

/**
 * The delay log (D6.2): delays with a cause from a fixed list, the affected activities, the
 * period, working days lost, a description, an optional site diary and a claim-support flag (the
 * company's position, not a legal determination). Versioned and append-only: amending or
 * withdrawing appends the next version with a reason; the history stays readable.
 */
@Injectable()
export class DelaysService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: ProjectAccess,
  ) {}

  list(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { project, effective } = await this.access.load(scope, projectId, "projects.view");
      requireDelayLogReader(effective);
      const rows = await scope.tx.scheduleDelay.findMany({
        where: { tenantId: scope.access.tenantId, projectId },
        include: delayInclude,
        orderBy: [{ delayNo: "desc" }, { versionNo: "desc" }],
      });
      const current = new Map<string, DelayRow>();
      const firsts = new Map<string, DelayRow>();
      for (const row of rows) {
        if (!current.has(row.delayId)) current.set(row.delayId, row);
        if (row.versionNo === 1) firsts.set(row.delayId, row);
      }
      const { calendar } = await loadCalendar(scope.tx, scope.access.tenantId, projectId);
      const people = await peopleOf(
        scope.tx,
        rows.map((row) => row.recordedBy),
      );
      const delays = [...current.values()].map((row) =>
        this.toDelay(row, firsts.get(row.delayId)!, people, calendar, effective, project),
      );
      const recorded = delays.filter((delay) => delay.status === "recorded");
      const byCause = new Map<DelayCause, { count: number; workingDaysLost: number }>();
      for (const delay of recorded) {
        const entry = byCause.get(delay.cause) ?? { count: 0, workingDaysLost: 0 };
        entry.count += 1;
        entry.workingDaysLost += delay.workingDaysLost;
        byCause.set(delay.cause, entry);
      }
      return scheduleDelaysResponseSchema.parse({
        delays,
        totals: {
          count: recorded.length,
          workingDaysLost: recorded.reduce((sum, delay) => sum + delay.workingDaysLost, 0),
          byCause: [...byCause.entries()]
            .map(([cause, entry]) => ({ cause, ...entry }))
            .sort(
              (a, b) => b.workingDaysLost - a.workingDaysLost || a.cause.localeCompare(b.cause),
            ),
        },
        permissions: { canRecord: canEditSchedule(effective, project) },
      });
    });
  }

  get(principal: Principal, projectId: string, delayId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { project, effective } = await this.access.load(scope, projectId, "projects.view");
      requireDelayLogReader(effective);
      return this.detail(scope, project, effective, delayId);
    });
  }

  create(principal: Principal, projectId: string, input: CreateDelayRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { project, effective } = await this.access.editable(scope, projectId);
        const { tenantId } = scope.access;
        await this.validate(scope, projectId, input);
        const latest = await scope.tx.scheduleDelay.findFirst({
          where: { tenantId, projectId },
          orderBy: { delayNo: "desc" },
          select: { delayNo: true },
        });
        const id = uuidv7();
        const number = (latest?.delayNo ?? 0) + 1;
        await this.write(scope, projectId, {
          id,
          delayId: id,
          delayNo: number,
          versionNo: 1,
          supersedesId: null,
          status: "recorded",
          changeReason: null,
          content: input,
        });
        await this.scope.audit(scope.tx, "schedule.delay_recorded", id, {
          projectId,
          number,
          cause: input.cause,
          claimFlag: input.claimFlag ?? "not_assessed",
          activityCount: input.activityIds.length,
          diaryLinked: Boolean(input.siteDiaryId),
          open: input.endDate === null,
        });
        return this.detail(scope, project, effective, id);
      },
      true,
    );
  }

  amend(
    principal: Principal,
    projectId: string,
    delayId: string,
    input: AmendDelayRequest,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { project, effective } = await this.access.editable(scope, projectId);
          const current = await this.current(scope, projectId, delayId, input.version);
          // Leaving siteDiaryId out keeps the cited diary; null removes it.
          const content = {
            ...input,
            siteDiaryId: input.siteDiaryId === undefined ? current.siteDiaryId : input.siteDiaryId,
          };
          await this.validate(scope, projectId, content);
          const id = uuidv7();
          await this.write(scope, projectId, {
            id,
            delayId,
            delayNo: current.delayNo,
            versionNo: current.versionNo + 1,
            supersedesId: current.id,
            status: "recorded",
            changeReason: input.reason,
            content,
          });
          const before = {
            cause: current.cause,
            startDate: toCalendarDate(current.startDate),
            endDate: current.endDate ? toCalendarDate(current.endDate) : null,
            workingDaysLost: current.workingDaysLost.toNumber(),
            description: current.description,
            siteDiaryId: current.siteDiaryId,
            claimFlag: current.claimFlag,
            activityIds: current.activities
              .map((link) => link.activityId)
              .sort()
              .join(","),
          };
          const after = {
            ...content,
            siteDiaryId: content.siteDiaryId ?? null,
            claimFlag: input.claimFlag ?? "not_assessed",
            activityIds: [...input.activityIds].sort().join(","),
          };
          await this.scope.audit(scope.tx, "schedule.delay_amended", id, {
            projectId,
            delayId,
            number: current.delayNo,
            version: current.versionNo + 1,
            fields: (Object.keys(before) as (keyof typeof before)[]).filter(
              (key) => before[key] !== after[key],
            ),
            reasonGiven: true,
          });
          return this.detail(scope, project, effective, delayId);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw scheduleVersionConflict();
        throw error;
      });
  }

  withdraw(
    principal: Principal,
    projectId: string,
    delayId: string,
    input: WithdrawDelayRequest,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { project, effective } = await this.access.editable(scope, projectId);
          const current = await this.current(scope, projectId, delayId, input.version);
          const id = uuidv7();
          await this.write(scope, projectId, {
            id,
            delayId,
            delayNo: current.delayNo,
            versionNo: current.versionNo + 1,
            supersedesId: current.id,
            status: "withdrawn",
            changeReason: input.reason,
            content: {
              cause: current.cause as DelayCause,
              startDate: toCalendarDate(current.startDate),
              endDate: current.endDate ? toCalendarDate(current.endDate) : null,
              workingDaysLost: current.workingDaysLost.toNumber(),
              description: current.description,
              siteDiaryId: current.siteDiaryId,
              claimFlag: current.claimFlag as CreateDelayRequest["claimFlag"],
              activityIds: current.activities.map((link) => link.activityId),
            },
          });
          await this.scope.audit(scope.tx, "schedule.delay_withdrawn", id, {
            projectId,
            delayId,
            number: current.delayNo,
            version: current.versionNo + 1,
            reasonGiven: true,
          });
          return this.detail(scope, project, effective, delayId);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw scheduleVersionConflict();
        throw error;
      });
  }

  /** The current version, checked against the version the caller saw (409 otherwise). */
  private async current(scope: Scope, projectId: string, delayId: string, version: number) {
    const current = await scope.tx.scheduleDelay.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, delayId },
      orderBy: { versionNo: "desc" },
      include: { activities: { select: { activityId: true } } },
    });
    if (!current) throw new NotFoundException("Delay not found");
    if (current.status === "withdrawn")
      throw scheduleProblem(409, "delay-withdrawn", "A withdrawn delay can no longer change");
    if (current.versionNo !== version) throw scheduleVersionConflict();
    return current;
  }

  private async validate(scope: Scope, projectId: string, input: CreateDelayRequest) {
    const { tenantId } = scope.access;
    const { calendar } = await loadCalendar(scope.tx, tenantId, projectId);
    const check = checkDelayDays(calendar, input, nairobiDate());
    if (!check.ok) throw scheduleProblem(400, check.error, dayMessages[check.error]);
    if (input.activityIds.length) {
      const found = await scope.tx.scheduleActivity.count({
        where: { tenantId, projectId, kind: "task", id: { in: input.activityIds } },
      });
      if (found !== input.activityIds.length) throw new NotFoundException("Activity not found");
    }
    if (input.siteDiaryId) {
      const diary = await scope.tx.siteDiary.findFirst({
        where: { tenantId, projectId, id: input.siteDiaryId },
        select: { id: true },
      });
      if (!diary) throw new NotFoundException("Site diary not found in this project");
    }
  }

  private async write(
    scope: Scope,
    projectId: string,
    version: {
      id: string;
      delayId: string;
      delayNo: number;
      versionNo: number;
      supersedesId: string | null;
      status: "recorded" | "withdrawn";
      changeReason: string | null;
      content: CreateDelayRequest;
    },
  ) {
    const { tenantId, userId } = scope.access;
    const { content } = version;
    await scope.tx.scheduleDelay.create({
      data: {
        id: version.id,
        tenantId,
        projectId,
        delayId: version.delayId,
        delayNo: version.delayNo,
        versionNo: version.versionNo,
        supersedesId: version.supersedesId,
        status: version.status,
        cause: content.cause,
        startDate: fromCalendarDate(content.startDate),
        endDate: content.endDate ? fromCalendarDate(content.endDate) : null,
        workingDaysLost: content.workingDaysLost,
        description: content.description,
        siteDiaryId: content.siteDiaryId ?? null,
        claimFlag: content.claimFlag ?? "not_assessed",
        changeReason: version.changeReason,
        recordedBy: userId,
      },
    });
    if (content.activityIds.length)
      await scope.tx.scheduleDelayActivity.createMany({
        data: content.activityIds.map((activityId) => ({
          tenantId,
          projectId,
          delayVersionId: version.id,
          activityId,
        })),
      });
  }

  private async detail(
    scope: Scope,
    project: ScheduleProject,
    effective: ReadonlySet<Permission>,
    delayId: string,
  ) {
    const rows = await scope.tx.scheduleDelay.findMany({
      where: { tenantId: scope.access.tenantId, projectId: project.id, delayId },
      include: delayInclude,
      orderBy: { versionNo: "desc" },
    });
    if (!rows.length) throw new NotFoundException("Delay not found");
    const { calendar } = await loadCalendar(scope.tx, scope.access.tenantId, project.id);
    const people = await peopleOf(
      scope.tx,
      rows.map((row) => row.recordedBy),
    );
    return scheduleDelayResponseSchema.parse({
      delay: this.toDelay(rows[0]!, rows.at(-1)!, people, calendar, effective, project),
      history: rows.map((row) => toVersion(row, people)),
    });
  }

  private toDelay(
    row: DelayRow,
    first: DelayRow,
    people: ReadonlyMap<string, string>,
    calendar: Awaited<ReturnType<typeof loadCalendar>>["calendar"],
    effective: ReadonlySet<Permission>,
    project: ScheduleProject,
  ): ScheduleDelay {
    const editable = canEditSchedule(effective, project) && row.status === "recorded";
    const start = toCalendarDate(row.startDate);
    return {
      id: row.delayId,
      number: row.delayNo,
      ...toVersion(row, people),
      workingDaysInPeriod: countWorkingDays(
        calendar,
        start,
        row.endDate ? toCalendarDate(row.endDate) : nairobiDate(),
      ),
      createdAt: first.recordedAt.toISOString(),
      createdBy: { id: first.recordedBy, displayName: people.get(first.recordedBy) ?? "—" },
      permissions: { canAmend: editable, canWithdraw: editable },
    };
  }
}

function toVersion(row: DelayRow, people: ReadonlyMap<string, string>): ScheduleDelayVersion {
  return {
    version: row.versionNo,
    status: row.status as ScheduleDelayVersion["status"],
    cause: row.cause as DelayCause,
    startDate: toCalendarDate(row.startDate),
    endDate: row.endDate ? toCalendarDate(row.endDate) : null,
    workingDaysLost: row.workingDaysLost.toNumber(),
    description: row.description,
    siteDiary: row.siteDiary
      ? {
          id: row.siteDiary.id,
          date: toCalendarDate(row.siteDiary.date),
          siteId: row.siteDiary.siteId,
        }
      : null,
    claimFlag: row.claimFlag as ScheduleDelayVersion["claimFlag"],
    activities: row.activities
      .map((link) => ({
        id: link.activity.id,
        code: link.activity.code ?? "",
        name: link.activity.name ?? "",
      }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    changeReason: row.changeReason,
    recordedAt: row.recordedAt.toISOString(),
    recordedBy: { id: row.recordedBy, displayName: people.get(row.recordedBy) ?? "—" },
  };
}
