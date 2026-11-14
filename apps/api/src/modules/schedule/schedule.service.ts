import { Injectable, NotFoundException } from "@nestjs/common";
import { checkActivityProgress, dependencyCreatesCycle, nairobiDate } from "@pm-buddy/domain";
import { SCHEDULE_LIMITS, type Permission } from "@pm-buddy/types";
import {
  scheduleActivityResponseSchema,
  scheduleCalendarResponseSchema,
  scheduleDependencyResponseSchema,
  scheduleResponseSchema,
  messageResponseSchema,
  type ActivityProgressRequest,
  type CreateActivityRequest,
  type CreateDependencyRequest,
  type ScheduleItemRef,
  type UpdateActivityRequest,
  type UpdateDependencyRequest,
  type UpdateScheduleCalendarRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { isCheckViolation, isUniqueViolation } from "../../common/database-errors.js";
import { peopleOf } from "../procurement/procurement-mappers.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { ProjectAccess } from "../projects/project-access.js";
import { fromCalendarDate } from "../projects/project-mappers.js";
import {
  assembleSchedule,
  compute,
  loadCalendar,
  loadSchedule,
  requireScheduleReader,
  scheduleProblem,
  type ScheduleProject,
  scheduleVersionConflict,
} from "./schedule-model.js";

const codeTaken = () =>
  scheduleProblem(
    409,
    "activity-code-taken",
    "This project already has an activity with this code",
  );
const cycle = () =>
  scheduleProblem(
    409,
    "schedule-cycle",
    "This dependency would make a loop: an activity would wait for itself",
  );

/**
 * The schedule of a project (D6.2): activities, dependencies and the working calendar, computed
 * with CPM on every read. Reading needs projects.view; changing needs projects.manage on an open
 * project (like the WBS and milestones), always checked through ProjectAccess (role ∩
 * assignment). Every change writes an audit event with field names and codes only.
 */
@Injectable()
export class ScheduleService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: ProjectAccess,
  ) {}

  get(principal: Principal, projectId: string, baselineId: string | undefined, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { project, effective } = await this.access.load(scope, projectId, "projects.view");
      requireScheduleReader(effective);
      return this.respond(scope, project, effective, baselineId);
    });
  }

  updateCalendar(
    principal: Principal,
    projectId: string,
    input: UpdateScheduleCalendarRequest,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          await this.access.editable(scope, projectId);
          const { tenantId, userId } = scope.access;
          if (input.version === 0) {
            await scope.tx.scheduleSettings.create({
              data: {
                tenantId,
                projectId,
                workingWeekdays: input.workingWeekdays,
                includePublicHolidays: input.includePublicHolidays,
                updatedBy: userId,
              },
            });
          } else {
            const updated = await scope.tx.scheduleSettings.updateMany({
              where: { tenantId, projectId, version: input.version },
              data: {
                workingWeekdays: input.workingWeekdays,
                includePublicHolidays: input.includePublicHolidays,
                version: { increment: 1 },
                updatedBy: userId,
              },
            });
            if (!updated.count) throw scheduleVersionConflict();
          }
          await this.scope.audit(scope.tx, "schedule.calendar_updated", projectId, {
            projectId,
            workingWeekdays: input.workingWeekdays,
            includePublicHolidays: input.includePublicHolidays,
          });
          const { settings, holidays } = await loadCalendar(scope.tx, tenantId, projectId);
          return scheduleCalendarResponseSchema.parse({
            calendar: {
              workingWeekdays: settings.workingWeekdays,
              includePublicHolidays: settings.includePublicHolidays,
              holidaysApplied: holidays.length,
              version: settings.version,
            },
          });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw scheduleVersionConflict();
        throw error;
      });
  }

  createActivity(
    principal: Principal,
    projectId: string,
    input: CreateActivityRequest,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { project, effective } = await this.access.editable(scope, projectId);
          const { tenantId, userId } = scope.access;
          const count = await scope.tx.scheduleActivity.count({
            where: { tenantId, projectId, kind: "task" },
          });
          if (count >= SCHEDULE_LIMITS.maxActivities)
            throw scheduleProblem(
              409,
              "too-many-activities",
              `A project schedule holds at most ${SCHEDULE_LIMITS.maxActivities} activities`,
            );
          if (input.wbsNodeId) await this.wbsNode(scope, projectId, input.wbsNodeId);
          const bqVersionId = input.bqItemLineageId
            ? await this.bqVersionFor(scope, projectId, input.bqItemLineageId)
            : null;
          const row = await scope.tx.scheduleActivity.create({
            data: {
              tenantId,
              projectId,
              kind: "task",
              code: input.code,
              name: input.name,
              wbsNodeId: input.wbsNodeId ?? null,
              bqVersionId,
              bqItemLineageId: bqVersionId ? input.bqItemLineageId : null,
              durationDays: input.durationDays,
              startNoEarlierThan: input.startNoEarlierThan
                ? fromCalendarDate(input.startNoEarlierThan)
                : null,
              progressBasis: "physical",
              createdBy: userId,
              updatedBy: userId,
            },
          });
          await this.scope.audit(scope.tx, "schedule.activity_created", row.id, {
            projectId,
            code: row.code,
            durationDays: row.durationDays,
            fields: Object.keys(input).filter(
              (key) => input[key as keyof CreateActivityRequest] != null,
            ),
          });
          return this.itemResponse(scope, project, effective, row.id);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw codeTaken();
        throw error;
      });
  }

  updateActivity(
    principal: Principal,
    projectId: string,
    activityId: string,
    input: UpdateActivityRequest,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { project, effective } = await this.access.editable(scope, projectId);
          const task = await this.task(scope, projectId, activityId);
          if (task.version !== input.version) throw scheduleVersionConflict();
          const data: Prisma.ScheduleActivityUncheckedUpdateManyInput = {
            version: { increment: 1 },
            updatedBy: scope.access.userId,
          };
          if (input.code !== undefined) data.code = input.code;
          if (input.name !== undefined) data.name = input.name;
          if (input.durationDays !== undefined) data.durationDays = input.durationDays;
          if (input.startNoEarlierThan !== undefined)
            data.startNoEarlierThan = input.startNoEarlierThan
              ? fromCalendarDate(input.startNoEarlierThan)
              : null;
          if (input.wbsNodeId !== undefined) {
            if (input.wbsNodeId) await this.wbsNode(scope, projectId, input.wbsNodeId);
            data.wbsNodeId = input.wbsNodeId;
          }
          if (input.bqItemLineageId !== undefined) {
            const bqVersionId = input.bqItemLineageId
              ? await this.bqVersionFor(scope, projectId, input.bqItemLineageId)
              : null;
            data.bqVersionId = bqVersionId;
            data.bqItemLineageId = bqVersionId ? input.bqItemLineageId : null;
          }
          const updated = await scope.tx.scheduleActivity.updateMany({
            where: {
              tenantId: scope.access.tenantId,
              projectId,
              id: activityId,
              version: input.version,
            },
            data,
          });
          if (!updated.count) throw scheduleVersionConflict();
          await this.scope.audit(scope.tx, "schedule.activity_updated", activityId, {
            projectId,
            fields: (
              [
                "code",
                "name",
                "wbsNodeId",
                "bqItemLineageId",
                "durationDays",
                "startNoEarlierThan",
              ] as const
            ).filter((key) => input[key] !== undefined),
          });
          return this.itemResponse(scope, project, effective, activityId);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw codeTaken();
        throw error;
      });
  }

  /** Actual dates and physical progress with its basis (packages/domain checkActivityProgress). */
  recordProgress(
    principal: Principal,
    projectId: string,
    activityId: string,
    input: ActivityProgressRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { project, effective } = await this.access.editable(scope, projectId);
        const task = await this.task(scope, projectId, activityId);
        if (task.version !== input.version) throw scheduleVersionConflict();
        const check = checkActivityProgress(
          {
            actualStart: input.actualStart,
            actualFinish: input.actualFinish,
            basis: input.basis,
            percentComplete: input.percentComplete ?? null,
            quantityDone: input.quantityDone ?? null,
            quantityTotal: input.quantityTotal ?? null,
            quantityUnit: input.quantityUnit ?? null,
          },
          nairobiDate(),
        );
        if (!check.ok) throw scheduleProblem(400, check.error, progressMessages[check.error]);
        const updated = await scope.tx.scheduleActivity.updateMany({
          where: {
            tenantId: scope.access.tenantId,
            projectId,
            id: activityId,
            version: input.version,
          },
          data: {
            actualStart: input.actualStart ? fromCalendarDate(input.actualStart) : null,
            actualFinish: input.actualFinish ? fromCalendarDate(input.actualFinish) : null,
            progressBasis: input.basis,
            percentComplete: check.percentComplete,
            quantityDone: check.quantityDone,
            quantityTotal: check.quantityTotal,
            quantityUnit: check.quantityUnit,
            version: { increment: 1 },
            updatedBy: scope.access.userId,
          },
        });
        if (!updated.count) throw scheduleVersionConflict();
        await this.scope.audit(scope.tx, "schedule.progress_recorded", activityId, {
          projectId,
          status: check.status,
          basis: input.basis,
          fields: (
            [
              "actualStart",
              "actualFinish",
              "percentComplete",
              "quantityDone",
              "quantityTotal",
              "quantityUnit",
            ] as const
          ).filter((key) => input[key] != null),
        });
        return this.itemResponse(scope, project, effective, activityId);
      },
      true,
    );
  }

  /** Only an unstarted activity that no delay names can be deleted; its links go with it. */
  removeActivity(
    principal: Principal,
    projectId: string,
    activityId: string,
    version: number,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.access.editable(scope, projectId);
        const task = await this.task(scope, projectId, activityId);
        if (task.version !== version) throw scheduleVersionConflict();
        if (task.actualStart)
          throw scheduleProblem(
            409,
            "activity-started",
            "A started activity keeps its history; it cannot be deleted",
          );
        const delays = await scope.tx.scheduleDelayActivity.count({
          where: { tenantId: scope.access.tenantId, projectId, activityId },
        });
        if (delays)
          throw scheduleProblem(
            409,
            "activity-in-use",
            "The delay log refers to this activity; it cannot be deleted",
          );
        const removed = await scope.tx.scheduleActivity.deleteMany({
          where: { tenantId: scope.access.tenantId, projectId, id: activityId, version },
        });
        if (!removed.count) throw scheduleVersionConflict();
        await this.scope.audit(scope.tx, "schedule.activity_deleted", activityId, {
          projectId,
          code: task.code,
        });
        return messageResponseSchema.parse({ message: "Activity removed." });
      },
      true,
    );
  }

  createDependency(
    principal: Principal,
    projectId: string,
    input: CreateDependencyRequest,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { project, effective } = await this.access.editable(scope, projectId);
          const { tenantId, userId } = scope.access;
          const predecessorId = await this.nodeFor(scope, projectId, input.predecessor);
          const successorId = await this.nodeFor(scope, projectId, input.successor);
          const existing = await scope.tx.scheduleDependency.findMany({
            where: { tenantId, projectId },
            select: { predecessorId: true, successorId: true },
          });
          if (existing.length >= SCHEDULE_LIMITS.maxDependencies)
            throw scheduleProblem(
              409,
              "too-many-dependencies",
              `A project schedule holds at most ${SCHEDULE_LIMITS.maxDependencies} dependencies`,
            );
          if (
            existing.some(
              (link) => link.predecessorId === predecessorId && link.successorId === successorId,
            )
          )
            throw scheduleProblem(409, "dependency-exists", "These two items are already linked");
          if (dependencyCreatesCycle(existing, predecessorId, successorId)) throw cycle();
          const row = await scope.tx.scheduleDependency.create({
            data: {
              tenantId,
              projectId,
              predecessorId,
              successorId,
              type: input.type,
              lagDays: input.lagDays,
              createdBy: userId,
              updatedBy: userId,
            },
          });
          await this.scope.audit(scope.tx, "schedule.dependency_created", row.id, {
            projectId,
            type: row.type,
            lagDays: row.lagDays,
            predecessorKind: input.predecessor.kind,
            successorKind: input.successor.kind,
          });
          return this.dependencyResponse(scope, project, effective, row.id);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw scheduleProblem(409, "dependency-exists", "These two items are already linked");
        // The database refuses a cycle that a concurrent request closed first.
        if (isCheckViolation(error)) throw cycle();
        throw error;
      });
  }

  updateDependency(
    principal: Principal,
    projectId: string,
    dependencyId: string,
    input: UpdateDependencyRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { project, effective } = await this.access.editable(scope, projectId);
        const dependency = await this.dependency(scope, projectId, dependencyId);
        if (dependency.version !== input.version) throw scheduleVersionConflict();
        const updated = await scope.tx.scheduleDependency.updateMany({
          where: {
            tenantId: scope.access.tenantId,
            projectId,
            id: dependencyId,
            version: input.version,
          },
          data: {
            ...(input.type !== undefined ? { type: input.type } : {}),
            ...(input.lagDays !== undefined ? { lagDays: input.lagDays } : {}),
            version: { increment: 1 },
            updatedBy: scope.access.userId,
          },
        });
        if (!updated.count) throw scheduleVersionConflict();
        await this.scope.audit(scope.tx, "schedule.dependency_updated", dependencyId, {
          projectId,
          fields: (["type", "lagDays"] as const).filter((key) => input[key] !== undefined),
        });
        return this.dependencyResponse(scope, project, effective, dependencyId);
      },
      true,
    );
  }

  removeDependency(
    principal: Principal,
    projectId: string,
    dependencyId: string,
    version: number,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.access.editable(scope, projectId);
        const dependency = await this.dependency(scope, projectId, dependencyId);
        if (dependency.version !== version) throw scheduleVersionConflict();
        const removed = await scope.tx.scheduleDependency.deleteMany({
          where: { tenantId: scope.access.tenantId, projectId, id: dependencyId, version },
        });
        if (!removed.count) throw scheduleVersionConflict();
        await this.scope.audit(scope.tx, "schedule.dependency_deleted", dependencyId, {
          projectId,
          type: dependency.type,
        });
        return messageResponseSchema.parse({ message: "Dependency removed." });
      },
      true,
    );
  }

  /** The schedule response; `baselineId` compares with that baseline instead of the current. */
  async respond(
    scope: Scope,
    project: ScheduleProject,
    effective: ReadonlySet<Permission>,
    baselineId?: string,
  ) {
    const { tenantId } = scope.access;
    const data = await loadSchedule(scope.tx, tenantId, project, effective);
    const computed = compute(data);
    const current = await scope.tx.scheduleBaseline.findFirst({
      where: { tenantId, projectId: project.id },
      orderBy: { baselineNo: "desc" },
    });
    const baseline = baselineId
      ? await scope.tx.scheduleBaseline.findFirst({
          where: { tenantId, projectId: project.id, id: baselineId },
        })
      : current;
    if (baselineId && !baseline) throw new NotFoundException("Baseline not found");
    const items = baseline
      ? await scope.tx.scheduleBaselineItem.findMany({
          where: { tenantId, baselineId: baseline.id },
        })
      : [];
    const people = await peopleOf(scope.tx, [baseline?.createdBy]);
    return scheduleResponseSchema.parse(
      assembleSchedule(
        data,
        computed,
        baseline ? { baseline, items } : null,
        current?.id ?? null,
        people,
      ),
    );
  }

  private async itemResponse(
    scope: Scope,
    project: ScheduleProject,
    effective: ReadonlySet<Permission>,
    activityId: string,
  ) {
    const schedule = await this.respond(scope, project, effective);
    const item = schedule.items.find((entry) => entry.kind === "task" && entry.id === activityId);
    return scheduleActivityResponseSchema.parse({ item });
  }

  private async dependencyResponse(
    scope: Scope,
    project: ScheduleProject,
    effective: ReadonlySet<Permission>,
    dependencyId: string,
  ) {
    const schedule = await this.respond(scope, project, effective);
    const dependency = schedule.dependencies.find((entry) => entry.id === dependencyId);
    return scheduleDependencyResponseSchema.parse({ dependency });
  }

  private async task(scope: Scope, projectId: string, activityId: string) {
    const task = await scope.tx.scheduleActivity.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: activityId, kind: "task" },
    });
    if (!task) throw new NotFoundException("Activity not found");
    return task;
  }

  private async dependency(scope: Scope, projectId: string, dependencyId: string) {
    const dependency = await scope.tx.scheduleDependency.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: dependencyId },
    });
    if (!dependency) throw new NotFoundException("Dependency not found");
    return dependency;
  }

  private async wbsNode(scope: Scope, projectId: string, nodeId: string) {
    const node = await scope.tx.wbsNode.findUnique({
      where: { tenantId_projectId_id: { tenantId: scope.access.tenantId, projectId, id: nodeId } },
      select: { id: true },
    });
    if (!node) throw new NotFoundException("WBS node not found");
  }

  /** The newest approved BQ version holding this item lineage (422 otherwise). */
  private async bqVersionFor(scope: Scope, projectId: string, lineageId: string) {
    const { tenantId } = scope.access;
    const version = await scope.tx.bqVersion.findFirst({
      where: { tenantId, projectId, status: "approved" },
      orderBy: { versionNo: "desc" },
      select: { id: true },
    });
    const item = version
      ? await scope.tx.bqItem.findFirst({
          where: { tenantId, versionId: version.id, lineageId },
          select: { id: true },
        })
      : null;
    if (!version || !item)
      throw scheduleProblem(
        422,
        "bq-item-not-found",
        "The BQ item is not in the project's newest approved BQ version",
      );
    return version.id;
  }

  /**
   * The activity row behind a schedule item: a task, or a milestone's link into the network,
   * created the first time the milestone gets a dependency.
   */
  private async nodeFor(scope: Scope, projectId: string, ref: ScheduleItemRef): Promise<string> {
    const { tenantId, userId } = scope.access;
    if (ref.kind === "task") return (await this.task(scope, projectId, ref.id)).id;
    const milestone = await scope.tx.milestone.findFirst({
      where: { tenantId, projectId, id: ref.id },
      select: { id: true, status: true },
    });
    if (!milestone) throw new NotFoundException("Milestone not found");
    if (milestone.status === "cancelled")
      throw scheduleProblem(
        409,
        "milestone-cancelled",
        "A cancelled milestone is not part of the schedule",
      );
    const link = await scope.tx.scheduleActivity.findFirst({
      where: { tenantId, projectId, kind: "milestone", milestoneId: ref.id },
      select: { id: true },
    });
    if (link) return link.id;
    const created = await scope.tx.scheduleActivity.create({
      data: {
        tenantId,
        projectId,
        kind: "milestone",
        milestoneId: ref.id,
        durationDays: 0,
        createdBy: userId,
        updatedBy: userId,
      },
    });
    await this.scope.audit(scope.tx, "schedule.milestone_linked", created.id, {
      projectId,
      milestoneId: ref.id,
    });
    return created.id;
  }
}

const progressMessages: Record<string, string> = {
  "actual-date-future": "Actual dates cannot be in the future",
  "finish-without-start": "Record the actual start before the actual finish",
  "finish-before-start": "The actual finish cannot be before the actual start",
  "progress-without-start": "Progress needs an actual start",
  "progress-inconsistent": "An activity is 100 % complete exactly when it has an actual finish",
  "quantity-invalid": "Give a total above zero, a unit, and a quantity done up to the total",
};
