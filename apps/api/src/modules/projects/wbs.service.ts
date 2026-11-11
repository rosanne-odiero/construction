import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import {
  checkMilestoneTransition,
  MAX_WBS_DEPTH,
  nairobiDate,
  wbsDepth,
  wbsProgress,
  wbsSubtreeHeight,
  wbsWeightGroups,
  wbsWeightsComplete,
  wouldCreateCycle,
} from "@pm-buddy/domain";
import type { MilestoneStatus } from "@pm-buddy/types";
import {
  messageResponseSchema,
  milestoneResponseSchema,
  milestonesResponseSchema,
  wbsNodeResponseSchema,
  wbsResponseSchema,
  type MilestoneStatusRequest,
  type ReorderWbsRequest,
} from "@pm-buddy/validation";
import { isForeignKeyViolation, isUniqueViolation } from "../../common/database-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { badRequest, conflict, ProjectAccess, versionConflict } from "./project-access.js";
import { fromCalendarDate, toMilestone, toWbsNode } from "./project-mappers.js";

const wbsCodeTaken = () =>
  conflict("wbs-code-taken", "This project already has a WBS node with this code");
const milestoneNameTaken = () =>
  conflict("milestone-name-taken", "This project already has a milestone with this name");
const tooDeep = () => conflict("wbs-too-deep", `A WBS can be at most ${MAX_WBS_DEPTH} levels deep`);

/**
 * The work breakdown structure and milestones of a project (D2.1). Weights are validated per
 * sibling group (packages/domain wbs.ts): percentage complete stays unavailable until every group
 * sums to 100 % and progress measurements exist (D6.3).
 */
@Injectable()
export class WbsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: ProjectAccess,
  ) {}

  tree(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "projects.view");
      const nodes = await this.nodes(scope, projectId);
      const weights = nodes.map(({ id, parentId, weightBasisPoints }) => ({
        id,
        parentId,
        weightBasisPoints,
      }));
      return wbsResponseSchema.parse({
        nodes: nodes.map(toWbsNode),
        weights: {
          complete: wbsWeightsComplete(weights),
          groups: wbsWeightGroups(weights).map(({ parentId, sumBasisPoints, complete }) => ({
            parentId,
            sumBasisPoints,
            complete,
          })),
        },
        // No progress measurements exist before D6.3, so this is null ("unavailable"), never 0.
        progress: wbsProgress(weights, new Map()),
      });
    });
  }

  createNode(
    principal: Principal,
    projectId: string,
    input: { parentId?: string | null; code: string; name: string; weightBasisPoints: number },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          await this.access.editable(scope, projectId);
          const nodes = await this.nodes(scope, projectId);
          const parentId = input.parentId ?? null;
          if (parentId) {
            if (!nodes.some((node) => node.id === parentId))
              throw new NotFoundException("Parent WBS node not found");
            if ((wbsDepth(nodes, parentId) ?? MAX_WBS_DEPTH) + 1 > MAX_WBS_DEPTH) throw tooDeep();
          }
          const siblings = nodes.filter((node) => node.parentId === parentId);
          const node = await scope.tx.wbsNode.create({
            data: {
              tenantId: scope.access.tenantId,
              projectId,
              parentId,
              code: input.code,
              name: input.name,
              weightBasisPoints: input.weightBasisPoints,
              sortOrder: Math.max(-1, ...siblings.map((sibling) => sibling.sortOrder)) + 1,
              createdBy: scope.access.userId,
            },
          });
          await this.scope.audit(scope.tx, "wbs.node_created", node.id, {
            projectId,
            code: node.code,
            parentId,
            weightBasisPoints: node.weightBasisPoints,
          });
          return wbsNodeResponseSchema.parse({ node: toWbsNode(node) });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw wbsCodeTaken();
        throw error;
      });
  }

  updateNode(
    principal: Principal,
    projectId: string,
    nodeId: string,
    input: {
      parentId?: string | null;
      code?: string;
      name?: string;
      weightBasisPoints?: number;
      version: number;
    },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          await this.access.editable(scope, projectId);
          const nodes = await this.nodes(scope, projectId);
          const node = nodes.find((candidate) => candidate.id === nodeId);
          if (!node) throw new NotFoundException("WBS node not found");
          if (node.version !== input.version) throw versionConflict();
          const data: Prisma.WbsNodeUncheckedUpdateManyInput = { version: { increment: 1 } };
          if (input.code !== undefined) data.code = input.code;
          if (input.name !== undefined) data.name = input.name;
          if (input.weightBasisPoints !== undefined)
            data.weightBasisPoints = input.weightBasisPoints;
          if (input.parentId !== undefined && input.parentId !== node.parentId) {
            const parentId = input.parentId;
            if (parentId && !nodes.some((candidate) => candidate.id === parentId))
              throw new NotFoundException("Parent WBS node not found");
            if (wouldCreateCycle(nodes, nodeId, parentId))
              throw conflict("wbs-cycle", "A WBS node cannot move under itself or its descendants");
            const parentDepth = parentId ? (wbsDepth(nodes, parentId) ?? MAX_WBS_DEPTH) : 0;
            if (parentDepth + wbsSubtreeHeight(nodes, nodeId) > MAX_WBS_DEPTH) throw tooDeep();
            data.parentId = parentId;
            data.sortOrder =
              Math.max(
                -1,
                ...nodes
                  .filter((sibling) => sibling.parentId === parentId)
                  .map((sibling) => sibling.sortOrder),
              ) + 1;
          }
          const updated = await scope.tx.wbsNode.updateMany({
            where: {
              tenantId: scope.access.tenantId,
              projectId,
              id: nodeId,
              version: input.version,
            },
            data,
          });
          if (!updated.count) throw versionConflict();
          await this.scope.audit(scope.tx, "wbs.node_updated", nodeId, {
            projectId,
            fields: (["code", "name", "weightBasisPoints", "parentId"] as const).filter(
              (key) => input[key] !== undefined,
            ),
          });
          const row = await scope.tx.wbsNode.findUniqueOrThrow({
            where: {
              tenantId_projectId_id: { tenantId: scope.access.tenantId, projectId, id: nodeId },
            },
          });
          return wbsNodeResponseSchema.parse({ node: toWbsNode(row) });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw wbsCodeTaken();
        throw error;
      });
  }

  /** Sets the order of one parent's children; `nodeIds` must be exactly those children. */
  reorder(principal: Principal, projectId: string, input: ReorderWbsRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.access.editable(scope, projectId);
        const siblings = (await this.nodes(scope, projectId)).filter(
          (node) => node.parentId === input.parentId,
        );
        const expected = new Set(siblings.map((node) => node.id));
        if (
          expected.size !== input.nodeIds.length ||
          !input.nodeIds.every((id) => expected.has(id))
        )
          throw conflict(
            "wbs-order-mismatch",
            "List every child of this parent exactly once to reorder them",
          );
        for (const [index, id] of input.nodeIds.entries()) {
          const node = siblings.find((sibling) => sibling.id === id)!;
          if (node.sortOrder === index) continue;
          await scope.tx.wbsNode.update({
            where: { tenantId_projectId_id: { tenantId: scope.access.tenantId, projectId, id } },
            data: { sortOrder: index, version: { increment: 1 } },
          });
        }
        await this.scope.audit(scope.tx, "wbs.reordered", projectId, {
          parentId: input.parentId,
          count: input.nodeIds.length,
        });
        return messageResponseSchema.parse({ message: "WBS order saved." });
      },
      true,
    );
  }

  removeNode(principal: Principal, projectId: string, nodeId: string, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          await this.access.editable(scope, projectId);
          const nodes = await this.nodes(scope, projectId);
          const node = nodes.find((candidate) => candidate.id === nodeId);
          if (!node) throw new NotFoundException("WBS node not found");
          if (nodes.some((candidate) => candidate.parentId === nodeId))
            throw conflict("wbs-has-children", "Remove or move this node's children first");
          const milestones = await scope.tx.milestone.count({
            where: { tenantId: scope.access.tenantId, projectId, wbsNodeId: nodeId },
          });
          if (milestones)
            throw conflict("wbs-in-use", "Milestones refer to this WBS node; change them first");
          await scope.tx.wbsNode.delete({
            where: {
              tenantId_projectId_id: { tenantId: scope.access.tenantId, projectId, id: nodeId },
            },
          });
          await this.scope.audit(scope.tx, "wbs.node_deleted", nodeId, {
            projectId,
            code: node.code,
          });
          return messageResponseSchema.parse({ message: "WBS node removed." });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isForeignKeyViolation(error))
          throw conflict("wbs-in-use", "Something still refers to this WBS node");
        throw error;
      });
  }

  milestones(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "projects.view");
      const rows = await scope.tx.milestone.findMany({
        where: { tenantId: scope.access.tenantId, projectId },
        orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      });
      return milestonesResponseSchema.parse({ milestones: rows.map(toMilestone) });
    });
  }

  createMilestone(
    principal: Principal,
    projectId: string,
    input: { name: string; dueDate: string; wbsNodeId?: string | null },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          await this.access.editable(scope, projectId);
          const wbsNodeId = input.wbsNodeId ?? null;
          if (wbsNodeId) await this.node(scope, projectId, wbsNodeId);
          const row = await scope.tx.milestone.create({
            data: {
              tenantId: scope.access.tenantId,
              projectId,
              wbsNodeId,
              name: input.name,
              dueDate: fromCalendarDate(input.dueDate),
              createdBy: scope.access.userId,
            },
          });
          await this.scope.audit(scope.tx, "milestone.created", row.id, {
            projectId,
            dueDate: input.dueDate,
          });
          return milestoneResponseSchema.parse({ milestone: toMilestone(row) });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw milestoneNameTaken();
        throw error;
      });
  }

  updateMilestone(
    principal: Principal,
    projectId: string,
    milestoneId: string,
    input: { name?: string; dueDate?: string; wbsNodeId?: string | null; version: number },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          await this.access.editable(scope, projectId);
          const milestone = await this.milestone(scope, projectId, milestoneId);
          if (milestone.version !== input.version) throw versionConflict();
          if (input.wbsNodeId) await this.node(scope, projectId, input.wbsNodeId);
          const data: Prisma.MilestoneUncheckedUpdateManyInput = { version: { increment: 1 } };
          if (input.name !== undefined) data.name = input.name;
          if (input.dueDate !== undefined) data.dueDate = fromCalendarDate(input.dueDate);
          if (input.wbsNodeId !== undefined) data.wbsNodeId = input.wbsNodeId;
          const updated = await scope.tx.milestone.updateMany({
            where: {
              tenantId: scope.access.tenantId,
              projectId,
              id: milestoneId,
              version: input.version,
            },
            data,
          });
          if (!updated.count) throw versionConflict();
          await this.scope.audit(scope.tx, "milestone.updated", milestoneId, {
            projectId,
            fields: (["name", "dueDate", "wbsNodeId"] as const).filter(
              (key) => input[key] !== undefined,
            ),
          });
          const row = await this.milestone(scope, projectId, milestoneId);
          return milestoneResponseSchema.parse({ milestone: toMilestone(row) });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw milestoneNameTaken();
        throw error;
      });
  }

  changeMilestoneStatus(
    principal: Principal,
    projectId: string,
    milestoneId: string,
    input: MilestoneStatusRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.access.editable(scope, projectId);
        const milestone = await this.milestone(scope, projectId, milestoneId);
        if (milestone.version !== input.version) throw versionConflict();
        const reason = input.reason?.trim() || null;
        const check = checkMilestoneTransition({
          from: milestone.status as MilestoneStatus,
          to: input.to,
          reason,
          actualDate: input.actualDate ?? null,
          today: nairobiDate(),
        });
        if (!check.ok) {
          if (check.error === "reason_required")
            throw badRequest("reason-required", "A reason is required for this change");
          if (check.error === "actual_date_required")
            throw badRequest("actual-date-required", "Give the date the milestone was achieved");
          if (check.error === "actual_date_future")
            throw badRequest("actual-date-future", "The achieved date cannot be in the future");
          throw conflict(
            "invalid-transition",
            `A milestone cannot move from ${milestone.status} to ${input.to}`,
          );
        }
        const achieved = check.transition.action === "achieve";
        const updated = await scope.tx.milestone.updateMany({
          where: {
            tenantId: scope.access.tenantId,
            projectId,
            id: milestoneId,
            version: input.version,
          },
          data: {
            status: input.to,
            actualDate: achieved && input.actualDate ? fromCalendarDate(input.actualDate) : null,
            statusReason: reason,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw versionConflict();
        await this.scope.audit(scope.tx, "milestone.status_changed", milestoneId, {
          projectId,
          from: milestone.status,
          to: input.to,
          reasonGiven: reason !== null,
        });
        const row = await this.milestone(scope, projectId, milestoneId);
        return milestoneResponseSchema.parse({ milestone: toMilestone(row) });
      },
      true,
    );
  }

  /** Only a planned milestone can be deleted; later ones are cancelled, keeping their history. */
  removeMilestone(principal: Principal, projectId: string, milestoneId: string, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.access.editable(scope, projectId);
        const milestone = await this.milestone(scope, projectId, milestoneId);
        if (milestone.status !== "planned")
          throw conflict(
            "milestone-not-planned",
            "Only planned milestones can be deleted; cancel this one instead",
          );
        await scope.tx.milestone.delete({
          where: { tenantId_id: { tenantId: scope.access.tenantId, id: milestoneId } },
        });
        await this.scope.audit(scope.tx, "milestone.deleted", milestoneId, { projectId });
        return messageResponseSchema.parse({ message: "Milestone removed." });
      },
      true,
    );
  }

  private nodes(scope: Scope, projectId: string) {
    return scope.tx.wbsNode.findMany({
      where: { tenantId: scope.access.tenantId, projectId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
  }

  private async node(scope: Scope, projectId: string, nodeId: string) {
    const node = await scope.tx.wbsNode.findUnique({
      where: { tenantId_projectId_id: { tenantId: scope.access.tenantId, projectId, id: nodeId } },
    });
    if (!node) throw new NotFoundException("WBS node not found");
    return node;
  }

  private async milestone(scope: Scope, projectId: string, milestoneId: string) {
    const milestone = await scope.tx.milestone.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: milestoneId },
    });
    if (!milestone) throw new NotFoundException("Milestone not found");
    return milestone;
  }
}
