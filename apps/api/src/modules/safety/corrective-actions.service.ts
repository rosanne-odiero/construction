import { Injectable, NotFoundException } from "@nestjs/common";
import {
  checkProcurementTransition,
  correctiveActionDoneAllowed,
  correctiveActionVerifierIndependent,
  CORRECTIVE_ACTION_TRANSITIONS,
  nairobiDate,
} from "@pm-buddy/domain";
import { SAFETY_READ_PERMISSIONS, type CorrectiveActionStatus } from "@pm-buddy/types";
import {
  correctiveActionResponseSchema,
  correctiveActionsResponseSchema,
  type CorrectiveActionActionRequest,
  type CorrectiveActionsQuery,
  type CreateCorrectiveActionRequest,
  type UpdateCorrectiveActionRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { changedFields, peopleOf } from "../procurement/procurement-mappers.js";
import { fromCalendarDate } from "../projects/project-mappers.js";
import {
  lockProject,
  requireStaff,
  SafetyAccess,
  safetyProblem,
  searchNumber,
  versionConflict,
  type SafetyContext,
} from "./safety-access.js";
import { actionInclude, actionPeople, toCorrectiveAction } from "./safety-mappers.js";

/**
 * Corrective actions (D8.2): raised by a safety.manage holder from an open incident, an inspection,
 * a confirmed toolbox talk or on their own, with an owner (a project member who can read safety
 * records) and a due date. Only the owner marks an action done; someone who is neither the owner
 * nor whoever marked it done verifies it or sends it back with a reason. Lists show overdue
 * actions first (packages/domain compareCorrectiveActions, repeated in SQL for paging).
 */
@Injectable()
export class CorrectiveActionsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly safety: SafetyAccess,
  ) {}

  list(principal: Principal, projectId: string, query: CorrectiveActionsQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.safety.load(scope, projectId);
      const { tenantId, userId } = scope.access;
      const today = nairobiDate();
      const filters: Prisma.Sql[] = [
        Prisma.sql`tenant_id = ${tenantId}::uuid`,
        Prisma.sql`project_id = ${projectId}::uuid`,
      ];
      if (query.status === "active") filters.push(Prisma.sql`status IN ('open', 'done')`);
      else if (query.status === "overdue")
        filters.push(Prisma.sql`status = 'open' AND due_on < ${today}::date`);
      else if (query.status) filters.push(Prisma.sql`status = ${query.status}`);
      if (query.incidentId) filters.push(Prisma.sql`incident_id = ${query.incidentId}::uuid`);
      if (query.mine === "true") filters.push(Prisma.sql`owner_id = ${userId}::uuid`);
      const search = query.search?.trim();
      if (search) {
        const number = searchNumber(search, "CA");
        const pattern = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        filters.push(
          number !== null
            ? Prisma.sql`(description ILIKE ${pattern} OR number = ${number})`
            : Prisma.sql`description ILIKE ${pattern}`,
        );
      }
      const offset = query.cursor ?? 0;
      // Overdue first (most overdue first), then open by due date, done, verified, cancelled.
      const ids = await scope.tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM corrective_actions
         WHERE ${Prisma.join(filters, " AND ")}
         ORDER BY CASE
             WHEN status = 'open' AND due_on < ${today}::date THEN 0
             WHEN status = 'open' THEN 1
             WHEN status = 'done' THEN 2
             WHEN status = 'verified' THEN 3
             ELSE 4 END,
           due_on, number
         OFFSET ${offset} LIMIT ${query.limit + 1}`;
      const page = ids.slice(0, query.limit).map((row) => row.id);
      const scoped = { tenantId, projectId };
      const [rows, open, overdue, done, verified] = await Promise.all([
        scope.tx.correctiveAction.findMany({
          where: { ...scoped, id: { in: page } },
          include: actionInclude,
        }),
        scope.tx.correctiveAction.count({ where: { ...scoped, status: "open" } }),
        scope.tx.correctiveAction.count({
          where: { ...scoped, status: "open", dueOn: { lt: fromCalendarDate(today) } },
        }),
        scope.tx.correctiveAction.count({ where: { ...scoped, status: "done" } }),
        scope.tx.correctiveAction.count({ where: { ...scoped, status: "verified" } }),
      ]);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const ordered = page.map((id) => byId.get(id)!).filter(Boolean);
      const people = await peopleOf(scope.tx, ordered.flatMap(actionPeople));
      return correctiveActionsResponseSchema.parse({
        actions: ordered.map((row) => toCorrectiveAction(row, people, context)),
        nextCursor: ids.length > query.limit ? offset + query.limit : null,
        counts: { open, overdue, done, verified },
        permissions: { canCreate: context.canManage },
      });
    });
  }

  get(principal: Principal, projectId: string, actionId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.safety.load(scope, projectId);
      return this.detail(scope, context, actionId);
    });
  }

  create(
    principal: Principal,
    projectId: string,
    input: CreateCorrectiveActionRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.manager(scope, projectId);
        const { tenantId, userId } = scope.access;
        await requireStaff(scope, projectId, input.ownerId, SAFETY_READ_PERMISSIONS);
        await this.checkSource(scope, projectId, input);
        await lockProject(scope.tx, tenantId, projectId);
        const latest = await scope.tx.correctiveAction.findFirst({
          where: { tenantId, projectId },
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const id = uuidv7();
        const number = (latest?.number ?? 0) + 1;
        await scope.tx.correctiveAction.create({
          data: {
            id,
            tenantId,
            projectId,
            number,
            source: input.source,
            incidentId: input.incidentId ?? null,
            inspectionId: input.inspectionId ?? null,
            toolboxTalkId: input.toolboxTalkId ?? null,
            description: input.description,
            ownerId: input.ownerId,
            dueOn: fromCalendarDate(input.dueOn),
            raisedBy: userId,
            updatedBy: userId,
          },
        });
        await this.scope.audit(scope.tx, "safety.action_raised", id, {
          projectId,
          number,
          source: input.source,
          sourceId: input.incidentId ?? input.inspectionId ?? input.toolboxTalkId ?? null,
          ownerId: input.ownerId,
          dueOn: input.dueOn,
        });
        return this.detail(scope, context, id);
      },
      true,
    );
  }

  update(
    principal: Principal,
    projectId: string,
    actionId: string,
    input: UpdateCorrectiveActionRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.manager(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.load(scope, projectId, actionId, input.version);
        if (row.status !== "open")
          throw safetyProblem(409, "invalid-transition", "Only an open action can be edited");
        if (input.ownerId)
          await requireStaff(scope, projectId, input.ownerId, SAFETY_READ_PERMISSIONS);
        const changed = await scope.tx.correctiveAction.updateMany({
          where: { tenantId, projectId, id: actionId, version: input.version },
          data: {
            description: input.description,
            ownerId: input.ownerId,
            ...(input.dueOn ? { dueOn: fromCalendarDate(input.dueOn) } : {}),
            updatedBy: userId,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(scope.tx, "safety.action_updated", actionId, {
          projectId,
          number: row.number,
          fields: changedFields(input),
          ownerId: input.ownerId && input.ownerId !== row.ownerId ? input.ownerId : null,
          dueOn: input.dueOn ?? null,
          version: input.version + 1,
        });
        return this.detail(scope, context, actionId);
      },
      true,
    );
  }

  action(
    principal: Principal,
    projectId: string,
    actionId: string,
    input: CorrectiveActionActionRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context =
          input.action === "done"
            ? await this.safety.participant(scope, projectId)
            : await this.safety.manager(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.load(scope, projectId, actionId, input.version);
        const check = checkProcurementTransition(
          CORRECTIVE_ACTION_TRANSITIONS,
          row.status as CorrectiveActionStatus,
          input.action,
          input.reason,
        );
        if (!check.ok)
          throw safetyProblem(409, "invalid-transition", "This action is not available now");
        if (input.action === "done" && !correctiveActionDoneAllowed(row, userId))
          throw safetyProblem(403, "action-owner-only", "Only the action's owner can mark it done");
        if (
          (input.action === "verify" || input.action === "reject") &&
          !correctiveActionVerifierIndependent(row, userId)
        )
          throw safetyProblem(
            403,
            "action-independent-verification",
            "Someone other than the owner and whoever marked it done must verify it",
          );
        const data: Prisma.CorrectiveActionUncheckedUpdateManyInput =
          input.action === "done"
            ? { status: "done", doneBy: userId, doneNote: input.note ?? null }
            : input.action === "verify"
              ? { status: "verified", verifiedBy: userId }
              : input.action === "reject"
                ? {
                    status: "open",
                    doneBy: null,
                    doneAt: null,
                    doneNote: null,
                    rejectCount: row.rejectCount + 1,
                    lastRejectReason: input.reason!,
                  }
                : { status: "cancelled", cancelledBy: userId, cancelReason: input.reason! };
        const changed = await scope.tx.correctiveAction.updateMany({
          where: { tenantId, projectId, id: actionId, version: input.version },
          data: { ...data, updatedBy: userId, version: { increment: 1 } },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(
          scope.tx,
          {
            done: "safety.action_done",
            verify: "safety.action_verified",
            reject: "safety.action_rejected",
            cancel: "safety.action_cancelled",
          }[input.action],
          actionId,
          {
            projectId,
            number: row.number,
            incidentId: row.incidentId,
            from: row.status,
            to: check.to,
            version: input.version + 1,
          },
        );
        return this.detail(scope, context, actionId);
      },
      true,
    );
  }

  /** The source must be an open incident, an inspection or a confirmed talk of this project. */
  private async checkSource(scope: Scope, projectId: string, input: CreateCorrectiveActionRequest) {
    const { tenantId } = scope.access;
    const where = { tenantId, projectId };
    let valid = true;
    if (input.incidentId) {
      const incident = await scope.tx.safetyIncident.findFirst({
        where: { ...where, id: input.incidentId },
        select: { status: true },
      });
      if (!incident) throw new NotFoundException("Incident not found");
      if (incident.status !== "reported" && incident.status !== "investigated")
        throw safetyProblem(409, "incident-not-open", "Closed and voided incidents are locked");
    } else if (input.inspectionId) {
      valid = Boolean(
        await scope.tx.inspection.findFirst({
          where: { ...where, id: input.inspectionId },
          select: { id: true },
        }),
      );
    } else if (input.toolboxTalkId) {
      const talk = await scope.tx.toolboxTalk.findFirst({
        where: { ...where, id: input.toolboxTalkId },
        select: { status: true },
      });
      valid = talk?.status === "confirmed";
    }
    if (!valid)
      throw safetyProblem(
        422,
        "action-source-invalid",
        "Actions come from an inspection or a confirmed toolbox talk of this project",
      );
  }

  private async load(scope: Scope, projectId: string, actionId: string, version: number) {
    const row = await scope.tx.correctiveAction.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: actionId },
      include: { incident: { select: { status: true } } },
    });
    if (!row) throw new NotFoundException("Corrective action not found");
    if (
      row.incident &&
      row.incident.status !== "reported" &&
      row.incident.status !== "investigated"
    )
      throw safetyProblem(409, "incident-not-open", "Closed and voided incidents are locked");
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private async detail(scope: Scope, context: SafetyContext, actionId: string) {
    const row = await scope.tx.correctiveAction.findFirst({
      where: { tenantId: scope.access.tenantId, projectId: context.project.id, id: actionId },
      include: actionInclude,
    });
    if (!row) throw new NotFoundException("Corrective action not found");
    const people = await peopleOf(scope.tx, actionPeople(row));
    return correctiveActionResponseSchema.parse({
      action: toCorrectiveAction(row, people, context),
    });
  }
}
