import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { ProjectPermission } from "@pm-buddy/validation";
import type { Prisma, Membership } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infra/prisma.service.js";
import { AuthService, type Principal, requestId } from "./auth.service.js";
import { AuthSecurity, digest, opaqueToken } from "./auth-security.service.js";
import { TenantDatabase } from "./tenant-database.service.js";

type Tx = Prisma.TransactionClient;
const publicProject = { id: true, name: true, createdAt: true } as const;
const rolePermissions = (role: string): ProjectPermission[] =>
  role === "project_manager" ? ["projects.view", "projects.manage"] : ["projects.view"];

@Injectable()
export class TenancyService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly security: AuthSecurity,
  ) {}

  private context(principal: Principal, req: Request, tenantId = principal.session.activeTenantId) {
    return { userId: principal.user.id, tenantId, requestId: requestId(req) };
  }

  private async run<T>(
    principal: Principal,
    req: Request,
    operation: (tx: Tx, membership: Membership) => Promise<T>,
    mutation = false,
  ): Promise<T> {
    this.auth.requireMfa(principal);
    const tenantId = principal.session.activeTenantId;
    if (!tenantId) throw new ForbiddenException("Select a tenant first");
    return this.db.run(this.context(principal, req), async (tx) => {
      if (mutation) {
        await tx.$queryRaw`SELECT tenant_id FROM tenants WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT user_id FROM memberships WHERE tenant_id = ${tenantId}::uuid
        AND user_id = ${principal.user.id}::uuid FOR SHARE`;
      const membership = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId: principal.user.id } },
      });
      if (!membership) throw new ForbiddenException("Tenant membership required");
      if (
        ["owner", "finance"].includes(membership.role) &&
        (!principal.user.mfaEnabled || !principal.session.mfaVerifiedAt)
      ) {
        throw new ForbiddenException("This role requires MFA");
      }
      return operation(tx, membership);
    });
  }

  private owner(principal: Principal, membership: Membership): void {
    if (membership.role !== "owner") throw new ForbiddenException("Owner permission required");
    this.auth.requireMfa(principal, true);
  }

  private async audit(
    tx: Tx,
    action: string,
    resourceId: string,
    metadata: Prisma.InputJsonValue = {},
  ) {
    const context = this.db.current();
    if (!context.tenantId) throw new Error("Audit requires a tenant");
    await tx.auditEvent.create({
      data: {
        tenantId: context.tenantId,
        actorId: context.userId,
        requestId: context.requestId,
        action,
        resourceId,
        metadata,
      },
    });
  }

  async list(principal: Principal, req: Request) {
    this.auth.requireMfa(principal);
    return this.db.run(this.context(principal, req, null), async (tx) => {
      const memberships = await tx.membership.findMany({
        where: { userId: principal.user.id },
        include: { tenant: { select: { id: true, name: true } } },
        orderBy: { joinedAt: "asc" },
      });
      return { tenants: memberships.map((member) => ({ ...member.tenant, role: member.role })) };
    });
  }

  async create(principal: Principal, name: string, req: Request, res: Response) {
    this.auth.requireMfa(principal, true);
    const id = randomUUID();
    const tenant = await this.db.run(this.context(principal, req, id), async (tx) => {
      const value = await tx.tenant.create({
        data: { id, name, createdBy: principal.user.id },
        select: { id: true, name: true },
      });
      await tx.membership.create({
        data: { tenantId: id, userId: principal.user.id, role: "owner" },
      });
      await this.audit(tx, "tenant.created", id);
      await tx.session.update({
        where: { id: principal.session.id },
        data: { activeTenantId: id },
      });
      return value;
    });
    await this.auth.issue(principal.session.id, res);
    return { tenant };
  }

  async select(principal: Principal, tenantId: string, req: Request, res: Response) {
    this.auth.requireMfa(principal);
    await this.db.run(this.context(principal, req, tenantId), async (tx) => {
      await tx.$queryRaw`SELECT user_id FROM memberships WHERE tenant_id = ${tenantId}::uuid
        AND user_id = ${principal.user.id}::uuid FOR SHARE`;
      const membership = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId: principal.user.id } },
      });
      if (!membership) throw new NotFoundException("Tenant not found");
      if (["owner", "finance"].includes(membership.role)) this.auth.requireMfa(principal, true);
      await tx.session.update({
        where: { id: principal.session.id },
        data: { activeTenantId: tenantId },
      });
    });
    return this.auth.issue(principal.session.id, res);
  }

  members(principal: Principal, req: Request) {
    return this.run(principal, req, async (tx, member) => {
      this.owner(principal, member);
      const members = await tx.membership.findMany({
        where: { tenantId: member.tenantId },
        select: {
          userId: true,
          role: true,
          joinedAt: true,
          user: { select: { displayName: true, identifier: true, mfaEnabled: true } },
        },
        orderBy: { joinedAt: "asc" },
      });
      return { members };
    });
  }

  async invite(
    principal: Principal,
    input: { identifier: string; role: string; projectIds: string[] },
    req: Request,
  ) {
    await this.auth.throttle(req, "invitation", principal.user.id);
    const token = opaqueToken();
    const invitation = await this.run(
      principal,
      req,
      async (tx, member) => {
        this.owner(principal, member);
        if (input.projectIds.length !== new Set(input.projectIds).size)
          throw new ConflictException("Duplicate project IDs");
        const count = await tx.project.count({
          where: { tenantId: member.tenantId, id: { in: input.projectIds } },
        });
        if (count !== input.projectIds.length) throw new NotFoundException("Project not found");
        const invitation = await tx.invitation.create({
          data: {
            tenantId: member.tenantId,
            identifier: input.identifier,
            role: input.role,
            digest: digest(token),
            expiresAt: new Date(Date.now() + 48 * 60 * 60_000),
            createdBy: principal.user.id,
          },
          select: { id: true, identifier: true, role: true, expiresAt: true },
        });
        await tx.invitationProject.createMany({
          data: input.projectIds.map((projectId) => ({
            tenantId: member.tenantId,
            invitationId: invitation.id,
            projectId,
          })),
        });
        await this.audit(tx, "membership.invited", invitation.id, {
          role: input.role,
          projectIds: input.projectIds,
        });
        return invitation;
      },
      true,
    );
    await this.security.notify(
      input.identifier,
      "Company invitation",
      `Invitation token: ${token}\nExpires in 48 hours.`,
    );
    return { invitation };
  }

  async accept(principal: Principal, token: string, req: Request) {
    await this.auth.throttle(req, "invitation-accept", principal.user.id);
    this.auth.requireMfa(principal);
    const invitation = await this.db.run(this.context(principal, req, null), (tx) =>
      tx.invitation.findFirst({
        where: {
          digest: digest(token),
          identifier: principal.user.identifier,
          acceptedAt: null,
          expiresAt: { gt: new Date() },
        },
      }),
    );
    if (!invitation) throw new NotFoundException("Invitation not found or expired");
    if (["owner", "finance"].includes(invitation.role)) this.auth.requireMfa(principal, true);
    await this.db.run(this.context(principal, req, invitation.tenantId), async (tx) => {
      await tx.$queryRaw`SELECT tenant_id FROM tenants WHERE tenant_id = ${invitation.tenantId}::uuid FOR UPDATE`;
      const result = await tx.invitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, expiresAt: { gt: new Date() } },
        data: { acceptedAt: new Date() },
      });
      if (!result.count) throw new ConflictException("Invitation already accepted or expired");
      const existing = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId: invitation.tenantId, userId: principal.user.id } },
      });
      if (existing)
        throw new ConflictException(
          "Already a member; roles cannot be changed through an invitation",
        );
      await tx.membership.create({
        data: { tenantId: invitation.tenantId, userId: principal.user.id, role: invitation.role },
      });
      const invitedProjects = await tx.invitationProject.findMany({
        where: { tenantId: invitation.tenantId, invitationId: invitation.id },
        select: { projectId: true },
      });
      for (const { projectId } of invitedProjects) {
        const project = await tx.project.findUnique({
          where: { tenantId_id: { tenantId: invitation.tenantId, id: projectId } },
        });
        if (!project) throw new ConflictException("An invited project no longer exists");
        await tx.projectMembership.create({
          data: {
            tenantId: invitation.tenantId,
            projectId,
            userId: principal.user.id,
            permissions: rolePermissions(invitation.role),
          },
        });
      }
      await this.audit(tx, "membership.joined", principal.user.id, { role: invitation.role });
    });
    return { message: "Invitation accepted. Select the company to continue." };
  }

  remove(principal: Principal, userId: string, req: Request) {
    return this.run(
      principal,
      req,
      async (tx, member) => {
        this.owner(principal, member);
        const target = await tx.membership.findUnique({
          where: { tenantId_userId: { tenantId: member.tenantId, userId } },
        });
        if (!target) throw new NotFoundException("Member not found");
        if (
          target.role === "owner" &&
          (await tx.membership.count({
            where: { tenantId: member.tenantId, role: "owner" },
          })) <= 1
        )
          throw new ConflictException("The last owner cannot be removed");
        await tx.membership.delete({
          where: { tenantId_userId: { tenantId: member.tenantId, userId } },
        });
        await tx.session.updateMany({
          where: { userId, activeTenantId: member.tenantId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.audit(tx, "membership.removed", userId, { role: target.role });
        return { message: "Membership removed and active tenant sessions revoked." };
      },
      true,
    );
  }

  auditLog(principal: Principal, req: Request) {
    return this.run(principal, req, async (tx, member) => {
      this.owner(principal, member);
      const events = await tx.auditEvent.findMany({
        where: { tenantId: member.tenantId },
        orderBy: { sequence: "desc" },
        take: 100,
      });
      return { events: events.map((event) => ({ ...event, sequence: event.sequence.toString() })) };
    });
  }

  projects(principal: Principal, req: Request) {
    return this.run(principal, req, async (tx, member) => ({
      projects: await tx.project.findMany({
        where: {
          tenantId: member.tenantId,
          ...(member.role === "owner"
            ? {}
            : {
                members: { some: { userId: member.userId, permissions: { has: "projects.view" } } },
              }),
        },
        select: publicProject,
        orderBy: { createdAt: "asc" },
      }),
    }));
  }

  createProject(principal: Principal, name: string, req: Request) {
    return this.run(
      principal,
      req,
      async (tx, member) => {
        this.owner(principal, member);
        const project = await tx.project.create({
          data: { tenantId: member.tenantId, name },
          select: publicProject,
        });
        await this.audit(tx, "project.created", project.id);
        return { project };
      },
      true,
    );
  }

  updateProject(principal: Principal, projectId: string, name: string, req: Request) {
    return this.run(
      principal,
      req,
      async (tx, member) => {
        const project = await tx.project.findUnique({
          where: { tenantId_id: { tenantId: member.tenantId, id: projectId } },
        });
        if (!project) throw new NotFoundException("Project not found");
        if (member.role !== "owner") {
          const assignment = await tx.projectMembership.findUnique({
            where: {
              tenantId_projectId_userId: {
                tenantId: member.tenantId,
                projectId,
                userId: member.userId,
              },
            },
          });
          if (!assignment?.permissions.includes("projects.manage"))
            throw new ForbiddenException("Project update permission required");
        }
        const updated = await tx.project.update({
          where: { id: project.id },
          data: { name },
          select: publicProject,
        });
        await this.audit(tx, "project.updated", projectId);
        return { project: updated };
      },
      true,
    );
  }

  assign(
    principal: Principal,
    projectId: string,
    userId: string,
    permissions: ProjectPermission[],
    req: Request,
  ) {
    return this.run(
      principal,
      req,
      async (tx, member) => {
        this.owner(principal, member);
        const [project, target] = await Promise.all([
          tx.project.findUnique({
            where: { tenantId_id: { tenantId: member.tenantId, id: projectId } },
          }),
          tx.membership.findUnique({
            where: { tenantId_userId: { tenantId: member.tenantId, userId } },
          }),
        ]);
        if (!project || !target) throw new NotFoundException("Project or member not found");
        if (new Set(permissions).size !== permissions.length)
          throw new ConflictException("Duplicate permissions");
        await tx.projectMembership.upsert({
          where: { tenantId_projectId_userId: { tenantId: member.tenantId, projectId, userId } },
          create: { tenantId: member.tenantId, projectId, userId, permissions },
          update: { permissions },
        });
        await this.audit(tx, "project.permissions.changed", projectId, { userId, permissions });
        return { message: "Project permissions updated." };
      },
      true,
    );
  }
}
