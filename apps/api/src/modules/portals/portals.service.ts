import { ForbiddenException, Injectable } from "@nestjs/common";
import type { Permission } from "@pm-buddy/types";
import {
  clientProjectResponseSchema,
  clientProjectsResponseSchema,
  workerPortalResponseSchema,
  type ClientProject,
} from "@pm-buddy/validation";
import type { Request } from "express";
import type { Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { toCalendarDate, toProject } from "../projects/project-mappers.js";

type ProjectRow = Prisma.ProjectGetPayload<object>;
const DIARY_LIMIT = 30;

const portalProject = (row: ProjectRow) => {
  const project = toProject(row);
  return {
    id: project.id,
    code: project.code,
    name: project.name,
    status: project.status,
    county: project.county,
    town: project.town,
  };
};

const clientProject = (row: ProjectRow, milestones: { status: string }[]): ClientProject => {
  const project = toProject(row);
  return {
    ...portalProject(row),
    startDate: project.startDate,
    endDate: project.endDate,
    contractSumMinor: project.contractSumMinor,
    currency: project.currency,
    milestones: {
      total: milestones.filter((milestone) => milestone.status !== "cancelled").length,
      achieved: milestones.filter((milestone) => milestone.status === "achieved").length,
    },
  };
};

/**
 * Read-only data for the client and labourer portals. Access is the role's portal permission
 * (role ∩ project assignment, so a client or labourer sees only assigned projects) and every
 * response is a curated view, not the office API's full records.
 */
@Injectable()
export class PortalsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
  ) {}

  clientProjects(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      this.requirePortal(scope, "portal.client");
      const [company, rows] = await Promise.all([
        this.company(scope),
        scope.tx.project.findMany({
          where: this.policy.projectWhere(scope, "portal.client"),
          include: { milestones: { select: { status: true } } },
          orderBy: { name: "asc" },
        }),
      ]);
      return clientProjectsResponseSchema.parse({
        company,
        projects: rows.map(({ milestones, ...row }) => clientProject(row, milestones)),
      });
    });
  }

  clientProjectDetail(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.policy.require(scope, "portal.client", { projectId });
      const { milestones, ...row } = await scope.tx.project.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: scope.access.tenantId, id: projectId } },
        include: { milestones: { orderBy: [{ dueDate: "asc" }, { name: "asc" }] } },
      });
      // Clients see approved (locked) diaries only: never drafts, rejections or reviewers.
      const diaries = await scope.tx.siteDiary.findMany({
        where: { tenantId: scope.access.tenantId, projectId, status: "approved" },
        include: { site: { select: { name: true } } },
        orderBy: [{ date: "desc" }, { id: "desc" }],
        take: DIARY_LIMIT,
      });
      return clientProjectResponseSchema.parse({
        project: clientProject(row, milestones),
        milestones: milestones.map((milestone) => ({
          id: milestone.id,
          name: milestone.name,
          dueDate: toCalendarDate(milestone.dueDate),
          status: milestone.status,
          actualDate: milestone.actualDate ? toCalendarDate(milestone.actualDate) : null,
        })),
        diaries: diaries.map((diary) => ({
          id: diary.id,
          date: toCalendarDate(diary.date),
          siteName: diary.site.name,
          workPerformed: diary.workPerformed,
          weather: diary.weather,
          delays: diary.delays,
          workforceCount: diary.workforceCount,
          approvedAt: diary.reviewedAt!.toISOString(),
        })),
      });
    });
  }

  worker(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      this.requirePortal(scope, "portal.worker");
      const [company, rows] = await Promise.all([
        this.company(scope),
        scope.tx.project.findMany({
          where: this.policy.projectWhere(scope, "portal.worker"),
          include: {
            sites: { select: { id: true, name: true, address: true }, orderBy: { name: "asc" } },
          },
          orderBy: { name: "asc" },
        }),
      ]);
      return workerPortalResponseSchema.parse({
        displayName: principal.user.displayName,
        company,
        assignments: rows.map(({ sites, ...row }) => ({ project: portalProject(row), sites })),
        attendance: null,
        pay: null,
      });
    });
  }

  private requirePortal(scope: Scope, permission: Permission) {
    if (!scope.access.permissions.has(permission))
      throw new ForbiddenException(`Permission required: ${permission}`);
  }

  private company(scope: Scope) {
    return scope.tx.tenant.findUniqueOrThrow({
      where: { id: scope.access.tenantId },
      select: { id: true, name: true },
    });
  }
}
