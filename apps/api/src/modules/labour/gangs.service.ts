import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { nairobiDate } from "@pm-buddy/domain";
import { gangDetailResponseSchema, gangsResponseSchema, type Gang } from "@pm-buddy/validation";
import type { z } from "zod";
import type {
  addGangMemberRequestSchema,
  createGangRequestSchema,
  gangListQuerySchema,
  leaveGangRequestSchema,
  updateGangRequestSchema,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  inProjects,
  LabourAccess,
  labourBadRequest,
  labourConflict,
  rethrowLabourDbError,
  versionConflict,
} from "./labour-support.js";

type Tx = Prisma.TransactionClient;
type GangRow = Prisma.GangGetPayload<object> & {
  project: { code: string; name: string; status: string };
  site: { name: string } | null;
  leader: { id: string; workerNo: string; fullName: string } | null;
  memberCount: number;
};

/** Gangs with their project, site, leader and current member count (one query per relation). */
async function loadGangs(
  tx: Tx,
  tenantId: string,
  where: Prisma.GangWhereInput,
): Promise<GangRow[]> {
  const gangs = await tx.gang.findMany({
    where: { AND: [{ tenantId }, where] },
    orderBy: [{ projectId: "asc" }, { name: "asc" }],
  });
  if (!gangs.length) return [];
  const projects = await tx.project.findMany({
    where: { tenantId, id: { in: [...new Set(gangs.map((gang) => gang.projectId))] } },
    select: { id: true, code: true, name: true, status: true },
  });
  const siteIds = gangs.flatMap((gang) => (gang.siteId ? [gang.siteId] : []));
  const sites = siteIds.length
    ? await tx.site.findMany({
        where: { tenantId, id: { in: siteIds } },
        select: { id: true, name: true },
      })
    : [];
  const leaderIds = gangs.flatMap((gang) => (gang.leaderLabourerId ? [gang.leaderLabourerId] : []));
  const leaders = leaderIds.length
    ? await tx.labourer.findMany({
        where: { tenantId, id: { in: leaderIds } },
        select: { id: true, workerNo: true, fullName: true },
      })
    : [];
  const counts = await tx.gangMembership.groupBy({
    by: ["gangId"],
    where: { tenantId, gangId: { in: gangs.map((gang) => gang.id) }, leftOn: null },
    _count: { _all: true },
  });
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const siteById = new Map(sites.map((site) => [site.id, site]));
  const leaderById = new Map(leaders.map((leader) => [leader.id, leader]));
  const countByGang = new Map(counts.map((count) => [count.gangId, count._count._all]));
  return gangs.map((gang) => ({
    ...gang,
    project: projectById.get(gang.projectId)!,
    site: gang.siteId ? (siteById.get(gang.siteId) ?? null) : null,
    leader: gang.leaderLabourerId ? (leaderById.get(gang.leaderLabourerId) ?? null) : null,
    memberCount: countByGang.get(gang.id) ?? 0,
  }));
}

const toGang = (row: GangRow): Gang => ({
  id: row.id,
  projectId: row.projectId,
  projectCode: row.project.code,
  projectName: row.project.name,
  siteId: row.siteId,
  siteName: row.site?.name ?? null,
  name: row.name,
  status: row.status as Gang["status"],
  leader: row.leader
    ? { labourerId: row.leader.id, workerNo: row.leader.workerNo, fullName: row.leader.fullName }
    : null,
  memberCount: row.memberCount,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * Gangs (crews) on a project with a leader who is a current member, and membership history with
 * join and leave dates (D3.1). Reading needs labour.view on the project, changes labour.manage.
 */
@Injectable()
export class GangsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: LabourAccess,
  ) {}

  list(principal: Principal, query: z.output<typeof gangListQuerySchema>, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const visible = await this.access.requireSomewhere(scope, "labour.view");
      const manage = await this.access.projectsWith(scope, "labour.manage");
      const where: Prisma.GangWhereInput = {
        tenantId: access.tenantId,
        ...(visible === "all" ? {} : { projectId: { in: [...visible] } }),
        ...(query.status ? { status: query.status } : {}),
      };
      if (query.projectId) {
        if (!inProjects(visible, query.projectId))
          return gangsResponseSchema.parse({ gangs: [], manageableProjectIds: [] });
        where.projectId = query.projectId;
      }
      const rows = await loadGangs(tx, access.tenantId, where);
      const projects =
        manage === "all"
          ? (
              await tx.project.findMany({
                where: { tenantId: access.tenantId, status: { notIn: ["closed", "cancelled"] } },
                select: { id: true },
              })
            ).map((project) => project.id)
          : [...manage];
      return gangsResponseSchema.parse({
        gangs: rows.map(toGang),
        manageableProjectIds: projects,
      });
    });
  }

  get(principal: Principal, gangId: string, req: Request) {
    return this.scope.run(principal, req, (scope) => this.detail(scope, gangId));
  }

  create(principal: Principal, input: z.output<typeof createGangRequestSchema>, req: Request) {
    return this.mutate(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.access.requireOnProject(scope, "labour.manage", input.projectId);
        await this.assertProjectOpen(tx, access.tenantId, input.projectId);
        if (input.siteId) await this.assertSite(tx, access.tenantId, input.projectId, input.siteId);
        const row = await tx.gang.create({
          data: {
            tenantId: access.tenantId,
            projectId: input.projectId,
            siteId: input.siteId ?? null,
            name: input.name,
            createdBy: access.userId,
          },
        });
        await this.scope.audit(tx, "gang.created", row.id, {
          projectId: input.projectId,
          siteId: row.siteId,
        });
        return this.detail(scope, row.id);
      },
      "gang-name-taken",
    );
  }

  update(
    principal: Principal,
    gangId: string,
    input: z.output<typeof updateGangRequestSchema>,
    req: Request,
  ) {
    return this.mutate(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const gang = await this.manageable(scope, gangId);
        if (gang.version !== input.version) throw versionConflict();
        if (input.siteId) await this.assertSite(tx, access.tenantId, gang.projectId, input.siteId);
        const current = await tx.gangMembership.findMany({
          where: { tenantId: access.tenantId, gangId, leftOn: null },
          select: { labourerId: true },
        });
        if (
          input.leaderLabourerId &&
          !current.some((member) => member.labourerId === input.leaderLabourerId)
        )
          throw labourConflict("leader-not-member", "Choose the leader from the gang's members.");
        if (input.status === "archived" && current.length)
          throw labourConflict(
            "gang-has-members",
            "Move or remove the members before archiving the gang.",
          );
        const updated = await tx.gang.updateMany({
          where: { tenantId: access.tenantId, id: gangId, version: input.version },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.siteId !== undefined ? { siteId: input.siteId } : {}),
            ...(input.leaderLabourerId !== undefined
              ? { leaderLabourerId: input.leaderLabourerId }
              : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw versionConflict();
        await this.scope.audit(tx, "gang.updated", gangId, {
          fields: Object.entries(input)
            .filter(([key, value]) => key !== "version" && value !== undefined)
            .map(([key]) => key)
            .sort(),
        });
        return this.detail(scope, gangId);
      },
      "gang-name-taken",
    );
  }

  addMember(
    principal: Principal,
    gangId: string,
    input: z.output<typeof addGangMemberRequestSchema>,
    req: Request,
  ) {
    return this.mutate(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const gang = await this.manageable(scope, gangId);
        if (gang.status !== "active")
          throw labourConflict("gang-archived", "Archived gangs take no new members.");
        const joinedOn = input.joinedOn ?? nairobiDate();
        if (joinedOn > nairobiDate())
          throw labourBadRequest("date-in-future", "The join date cannot be in the future.");
        const engaged = await tx.labourEngagement.findFirst({
          where: {
            tenantId: access.tenantId,
            labourerId: input.labourerId,
            projectId: gang.projectId,
            startDate: { lte: fromCalendarDate(joinedOn) },
            endDate: null,
          },
          select: { id: true },
        });
        if (!engaged)
          throw labourConflict(
            "not-engaged",
            "The worker must be engaged on this project on the join date.",
          );
        const elsewhere = await tx.gangMembership.findFirst({
          where: {
            tenantId: access.tenantId,
            projectId: gang.projectId,
            labourerId: input.labourerId,
            leftOn: null,
          },
          select: { id: true },
        });
        if (elsewhere)
          throw labourConflict(
            "already-in-gang",
            "The worker is already in a gang on this project.",
          );
        const membership = await tx.gangMembership.create({
          data: {
            tenantId: access.tenantId,
            projectId: gang.projectId,
            gangId,
            labourerId: input.labourerId,
            joinedOn: fromCalendarDate(joinedOn),
            addedBy: access.userId,
          },
        });
        await this.scope.audit(tx, "gang.member_added", gangId, {
          membershipId: membership.id,
          labourerId: input.labourerId,
          joinedOn,
        });
        return this.detail(scope, gangId);
      },
      "already-in-gang",
    );
  }

  leave(
    principal: Principal,
    gangId: string,
    membershipId: string,
    input: z.output<typeof leaveGangRequestSchema>,
    req: Request,
  ) {
    return this.mutate(principal, req, async (scope) => {
      const { tx, access } = scope;
      const gang = await this.manageable(scope, gangId);
      const membership = await tx.gangMembership.findFirst({
        where: { tenantId: access.tenantId, id: membershipId, gangId },
      });
      if (!membership) throw new NotFoundException("Membership not found");
      if (membership.leftOn)
        throw labourConflict("membership-ended", "The worker has already left this gang.");
      if (gang.leaderLabourerId === membership.labourerId)
        throw labourConflict("leader-must-change", "Choose another gang leader first.");
      const leftOn = input.leftOn ?? nairobiDate();
      if (leftOn > nairobiDate())
        throw labourBadRequest("date-in-future", "The leave date cannot be in the future.");
      if (leftOn < toCalendarDate(membership.joinedOn))
        throw labourBadRequest("end-before-start", "The leave date is before the join date.");
      await tx.gangMembership.update({
        where: { id: membershipId },
        data: { leftOn: fromCalendarDate(leftOn), removedBy: access.userId },
      });
      await this.scope.audit(tx, "gang.member_left", gangId, {
        membershipId,
        labourerId: membership.labourerId,
        leftOn,
      });
      return this.detail(scope, gangId);
    });
  }

  private async detail(scope: Scope, gangId: string) {
    const { tx, access } = scope;
    const [row] = await loadGangs(tx, access.tenantId, { id: gangId });
    if (!row) throw new NotFoundException("Gang not found");
    const visible = await this.access.projectsWith(scope, "labour.view");
    if (!inProjects(visible, row.projectId)) throw new NotFoundException("Gang not found");
    const manage = await this.access.projectsWith(scope, "labour.manage");
    const members = await tx.gangMembership.findMany({
      where: { tenantId: access.tenantId, gangId },
      include: { labourer: { select: { workerNo: true, fullName: true } } },
      orderBy: [{ leftOn: { sort: "desc", nulls: "first" } }, { joinedOn: "asc" }],
    });
    return gangDetailResponseSchema.parse({
      gang: toGang(row),
      members: members.map((member) => ({
        membershipId: member.id,
        labourerId: member.labourerId,
        workerNo: member.labourer.workerNo,
        fullName: member.labourer.fullName,
        joinedOn: toCalendarDate(member.joinedOn),
        leftOn: member.leftOn ? toCalendarDate(member.leftOn) : null,
        current: member.leftOn === null,
      })),
      canManage:
        inProjects(manage, row.projectId) &&
        row.project.status !== "closed" &&
        row.project.status !== "cancelled",
    });
  }

  /** A gang the caller may change: labour.manage on its project (404 outside the company). */
  private async manageable(scope: Scope, gangId: string) {
    const gang = await scope.tx.gang.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: gangId } },
    });
    if (!gang) throw new NotFoundException("Gang not found");
    const visible = await this.access.projectsWith(scope, "labour.view");
    if (!inProjects(visible, gang.projectId)) throw new NotFoundException("Gang not found");
    await this.access.requireOnProject(scope, "labour.manage", gang.projectId);
    await this.assertProjectOpen(scope.tx, scope.access.tenantId, gang.projectId);
    return gang;
  }

  private async assertSite(tx: Tx, tenantId: string, projectId: string, siteId: string) {
    const site = await tx.site.findFirst({
      where: { tenantId, projectId, id: siteId },
      select: { id: true },
    });
    if (!site) throw labourBadRequest("site-not-in-project", "Choose a site of this project.");
  }

  private async assertProjectOpen(tx: Tx, tenantId: string, projectId: string) {
    const project = await tx.project.findUnique({
      where: { tenantId_id: { tenantId, id: projectId } },
      select: { status: true },
    });
    if (!project) throw new NotFoundException("Project not found");
    if (project.status === "closed" || project.status === "cancelled")
      throw labourConflict("project-read-only", "Closed and cancelled projects are read-only.");
  }

  private mutate<T>(
    principal: Principal,
    req: Request,
    operation: (scope: Scope) => Promise<T>,
    uniqueCode: Parameters<typeof rethrowLabourDbError>[1] = "labour-rule",
  ): Promise<T> {
    return this.scope
      .run(principal, req, operation, true)
      .catch((error: unknown) => rethrowLabourDbError(error, uniqueCode));
  }
}
