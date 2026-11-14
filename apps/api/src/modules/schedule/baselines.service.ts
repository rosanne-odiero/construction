import { Injectable, NotFoundException } from "@nestjs/common";
import { SCHEDULE_LIMITS } from "@pm-buddy/types";
import {
  scheduleBaselineResponseSchema,
  scheduleBaselinesResponseSchema,
  type CreateBaselineRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { isUniqueViolation } from "../../common/database-errors.js";
import { uuidv7 } from "../../common/uuid.js";
import { peopleOf } from "../procurement/procurement-mappers.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { ProjectAccess } from "../projects/project-access.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  baselineSummary,
  canEditSchedule,
  compute,
  loadSchedule,
  milestoneKey,
  scheduleProblem,
  scheduleVersionConflict,
  taskKey,
} from "./schedule-model.js";

/**
 * Schedule baselines (D6.2): an immutable snapshot of every task's and milestone's scheduled
 * dates, with a name, a reason, who and when. Baselines are append-only (database triggers and
 * privileges); re-baselining appends a new one, which becomes current, and keeps the old ones
 * for comparison.
 */
@Injectable()
export class BaselinesService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: ProjectAccess,
  ) {}

  list(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { project, effective } = await this.access.load(scope, projectId, "projects.view");
      const rows = await scope.tx.scheduleBaseline.findMany({
        where: { tenantId: scope.access.tenantId, projectId },
        orderBy: { baselineNo: "desc" },
      });
      const people = await peopleOf(
        scope.tx,
        rows.map((row) => row.createdBy),
      );
      const currentId = rows[0]?.id ?? null;
      return scheduleBaselinesResponseSchema.parse({
        baselines: rows.map((row) => baselineSummary(row, currentId, people)),
        permissions: { canBaseline: canEditSchedule(effective, project) },
      });
    });
  }

  get(principal: Principal, projectId: string, baselineId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "projects.view");
      const { tenantId } = scope.access;
      const [row, current] = await Promise.all([
        scope.tx.scheduleBaseline.findFirst({ where: { tenantId, projectId, id: baselineId } }),
        scope.tx.scheduleBaseline.findFirst({
          where: { tenantId, projectId },
          orderBy: { baselineNo: "desc" },
          select: { id: true },
        }),
      ]);
      if (!row) throw new NotFoundException("Baseline not found");
      const items = await scope.tx.scheduleBaselineItem.findMany({
        where: { tenantId, baselineId },
        orderBy: [{ startDate: "asc" }, { finishDate: "asc" }, { name: "asc" }],
      });
      const people = await peopleOf(scope.tx, [row.createdBy]);
      return scheduleBaselineResponseSchema.parse({
        baseline: baselineSummary(row, current?.id ?? null, people),
        items: items.map((item) => ({
          kind: item.kind,
          id: item.refId,
          code: item.code,
          name: item.name,
          start: toCalendarDate(item.startDate),
          finish: toCalendarDate(item.finishDate),
          durationDays: item.durationDays,
          totalFloatDays: item.totalFloatDays,
          critical: item.critical,
        })),
      });
    });
  }

  /** Freezes the current schedule (as computed today) as the next, current baseline. */
  create(principal: Principal, projectId: string, input: CreateBaselineRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { project, effective } = await this.access.editable(scope, projectId);
          const { tenantId, userId } = scope.access;
          const latest = await scope.tx.scheduleBaseline.findFirst({
            where: { tenantId, projectId },
            orderBy: { baselineNo: "desc" },
            select: { baselineNo: true },
          });
          if ((latest?.baselineNo ?? 0) >= SCHEDULE_LIMITS.maxBaselines)
            throw scheduleProblem(
              409,
              "too-many-baselines",
              `A project keeps at most ${SCHEDULE_LIMITS.maxBaselines} baselines`,
            );
          const data = await loadSchedule(scope.tx, tenantId, project, effective);
          const computed = compute(data);
          const items = [
            ...data.tasks.map((task) => ({
              kind: "task",
              refId: task.id,
              code: task.code,
              name: task.name ?? "",
              wbsNodeId: task.wbsNodeId,
              scheduled: computed.items.get(taskKey(task.id))!,
            })),
            ...data.milestones
              .filter((milestone) => milestone.status !== "cancelled")
              .map((milestone) => ({
                kind: "milestone",
                refId: milestone.id,
                code: null,
                name: milestone.name,
                wbsNodeId: milestone.wbsNodeId,
                scheduled: computed.items.get(milestoneKey(milestone.id))!,
              })),
          ];
          if (!items.length)
            throw scheduleProblem(
              409,
              "schedule-empty",
              "Add activities or milestones before freezing a baseline",
            );
          const id = uuidv7();
          const number = (latest?.baselineNo ?? 0) + 1;
          await scope.tx.scheduleBaseline.create({
            data: {
              id,
              tenantId,
              projectId,
              baselineNo: number,
              name: input.name,
              reason: input.reason,
              dataDate: fromCalendarDate(data.dataDate),
              startDate: fromCalendarDate(data.start.date),
              projectFinish: computed.finish ? fromCalendarDate(computed.finish) : null,
              workingWeekdays: data.settings.workingWeekdays,
              includePublicHolidays: data.settings.includePublicHolidays,
              itemCount: items.length,
              createdBy: userId,
            },
          });
          await scope.tx.scheduleBaselineItem.createMany({
            data: items.map(({ scheduled, ...item }) => ({
              ...item,
              tenantId,
              baselineId: id,
              startDate: fromCalendarDate(scheduled.start),
              finishDate: fromCalendarDate(scheduled.finish),
              durationDays: scheduled.durationDays,
              totalFloatDays: scheduled.totalFloatDays,
              critical: scheduled.critical,
            })),
          });
          await this.scope.audit(scope.tx, "schedule.baseline_created", id, {
            projectId,
            number,
            itemCount: items.length,
            reasonGiven: true,
          });
          const row = await scope.tx.scheduleBaseline.findUniqueOrThrow({
            where: { tenantId_id: { tenantId, id } },
          });
          const people = await peopleOf(scope.tx, [userId]);
          return scheduleBaselineResponseSchema.parse({
            baseline: baselineSummary(row, id, people),
            items: items.map(({ kind, refId, code, name, scheduled }) => ({
              kind,
              id: refId,
              code,
              name,
              start: scheduled.start,
              finish: scheduled.finish,
              durationDays: scheduled.durationDays,
              totalFloatDays: scheduled.totalFloatDays,
              critical: scheduled.critical,
            })),
          });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw scheduleVersionConflict();
        throw error;
      });
  }
}
