import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { ProjectPermission } from "@pm-buddy/validation";
import { AccessPolicy, customRoleColumns } from "./access-policy.js";
import { AuthService, type Principal } from "./auth.service.js";
import { AuthSecurity, digest, opaqueToken } from "./auth-security.service.js";
import { grantOf, requiresMfa, roleReference, type Grant } from "./role-grants.js";
import { TenantDatabase } from "./tenant-database.service.js";
import { TenantScope } from "./tenant-scope.service.js";

const publicProject = { id: true, name: true, createdAt: true } as const;
/** Project permissions that an assignment can carry today (the Phase 1 project policy). */
const ASSIGNABLE_PROJECT_PERMISSIONS: readonly ProjectPermission[] = [
  "projects.view",
  "projects.manage",
];
/** Invitation acceptance assigns the role's own project permissions on each invited project. */
const defaultAssignment = (grant: Grant): ProjectPermission[] =>
  ASSIGNABLE_PROJECT_PERMISSIONS.filter((permission) => grant.permissions.has(permission));

@Injectable()
export class TenancyService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly auth: AuthService,
    private readonly security: AuthSecurity,
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
  ) {}

  async list(principal: Principal, req: Request) {
    this.auth.requireMfa(principal);
    return this.db.run(this.scope.context(principal, req, null), async (tx) => {
      const memberships = await tx.membership.findMany({
        where: { userId: principal.user.id },
        select: { ...customRoleColumns, tenant: { select: { id: true, name: true } } },
        orderBy: { joinedAt: "asc" },
      });
      return {
        tenants: memberships.map((member) => {
          const grant = grantOf(member);
          return {
            ...member.tenant,
            role: roleReference(grant),
            roleName: grant.roleName,
            tenantWide: grant.tenantWide,
            permissions: [...grant.permissions],
          };
        }),
      };
    });
  }

  async create(principal: Principal, name: string, req: Request, res: Response) {
    this.auth.requireMfa(principal, true);
    const id = randomUUID();
    const tenant = await this.db.run(this.scope.context(principal, req, id), async (tx) => {
      const value = await tx.tenant.create({
        data: { id, name, createdBy: principal.user.id },
        select: { id: true, name: true },
      });
      await tx.membership.create({
        data: { tenantId: id, userId: principal.user.id, role: "owner" },
      });
      await this.scope.audit(tx, "tenant.created", id);
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
    await this.db.run(this.scope.context(principal, req, tenantId), async (tx) => {
      await tx.$queryRaw`SELECT user_id FROM memberships WHERE tenant_id = ${tenantId}::uuid
        AND user_id = ${principal.user.id}::uuid FOR SHARE`;
      const access = await this.policy.load(tx, tenantId, principal.user.id);
      if (!access) throw new NotFoundException("Tenant not found");
      if (requiresMfa(access)) this.auth.requireMfa(principal, true);
      await tx.session.update({
        where: { id: principal.session.id },
        data: { activeTenantId: tenantId },
      });
    });
    return this.auth.issue(principal.session.id, res);
  }

  members(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      // Member identifiers are personal data: listing them keeps the step-up the owner-only API had.
      await this.policy.requireAny(scope, ["users.invite", "roles.manage"], { stepUp: true });
      const members = await scope.tx.membership.findMany({
        where: { tenantId: scope.access.tenantId },
        select: {
          ...customRoleColumns,
          userId: true,
          joinedAt: true,
          user: { select: { displayName: true, identifier: true, mfaEnabled: true } },
        },
        orderBy: { joinedAt: "asc" },
      });
      return {
        members: members.map(({ role, customRoleId, customRole, ...member }) => {
          const grant = grantOf({ role, customRoleId, customRole });
          return { ...member, role: roleReference(grant), roleName: grant.roleName };
        }),
      };
    });
  }

  async invite(
    principal: Principal,
    input: { identifier: string; role: string; projectIds: string[] },
    req: Request,
  ) {
    await this.auth.throttle(req, "invitation", principal.user.id);
    const token = opaqueToken();
    const invitation = await this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.policy.require(scope, "users.invite", { stepUp: true });
        if (input.projectIds.length !== new Set(input.projectIds).size)
          throw new ConflictException("Duplicate project IDs");
        const grant = await this.policy.resolveRole(scope, input.role);
        this.policy.assertGrantable(access, grant);
        for (const projectId of input.projectIds)
          await this.policy.require(scope, "projects.manage", { projectId });
        const invitation = await tx.invitation.create({
          data: {
            tenantId: access.tenantId,
            identifier: input.identifier,
            role: grant.role,
            customRoleId: grant.customRoleId,
            digest: digest(token),
            expiresAt: new Date(Date.now() + 48 * 60 * 60_000),
            createdBy: principal.user.id,
          },
          select: { id: true, identifier: true, expiresAt: true },
        });
        await tx.invitationProject.createMany({
          data: input.projectIds.map((projectId) => ({
            tenantId: access.tenantId,
            invitationId: invitation.id,
            projectId,
          })),
        });
        await this.scope.audit(tx, "membership.invited", invitation.id, {
          role: roleReference(grant),
          projectIds: input.projectIds,
        });
        return { ...invitation, role: roleReference(grant), roleName: grant.roleName };
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
    const invitation = await this.db.run(this.scope.context(principal, req, null), (tx) =>
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
    await this.db.run(this.scope.context(principal, req, invitation.tenantId), async (tx) => {
      await tx.$queryRaw`SELECT tenant_id FROM tenants WHERE tenant_id = ${invitation.tenantId}::uuid FOR UPDATE`;
      const stored = await tx.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
        select: customRoleColumns,
      });
      const grant = grantOf(stored);
      // Privileged roles (by permission) need enrolled, freshly verified MFA before joining.
      if (requiresMfa(grant)) this.auth.requireMfa(principal, true);
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
        data: {
          tenantId: invitation.tenantId,
          userId: principal.user.id,
          role: grant.role,
          customRoleId: grant.customRoleId,
        },
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
            permissions: defaultAssignment(grant),
          },
        });
      }
      await this.scope.audit(tx, "membership.joined", principal.user.id, {
        role: roleReference(grant),
      });
    });
    return { message: "Invitation accepted. Select the company to continue." };
  }

  remove(principal: Principal, userId: string, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.policy.require(scope, "roles.manage", { stepUp: true });
        const target = await tx.membership.findUnique({
          where: { tenantId_userId: { tenantId: access.tenantId, userId } },
          select: customRoleColumns,
        });
        if (!target) throw new NotFoundException("Member not found");
        const grant = grantOf(target);
        this.policy.assertGrantable(access, grant);
        if (
          target.role === "owner" &&
          (await tx.membership.count({
            where: { tenantId: access.tenantId, role: "owner" },
          })) <= 1
        )
          throw new ConflictException("The last owner cannot be removed");
        await tx.membership.delete({
          where: { tenantId_userId: { tenantId: access.tenantId, userId } },
        });
        await tx.session.updateMany({
          where: { userId, activeTenantId: access.tenantId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.scope.audit(tx, "membership.removed", userId, { role: roleReference(grant) });
        return { message: "Membership removed and active tenant sessions revoked." };
      },
      true,
    );
  }

  auditLog(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.policy.require(scope, "audit.view", { stepUp: true });
      const events = await scope.tx.auditEvent.findMany({
        where: { tenantId: scope.access.tenantId },
        orderBy: { sequence: "desc" },
        take: 100,
      });
      return { events: events.map((event) => ({ ...event, sequence: event.sequence.toString() })) };
    });
  }

  projects(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => ({
      projects: await scope.tx.project.findMany({
        where: this.policy.projectWhere(scope, "projects.view"),
        select: publicProject,
        orderBy: { createdAt: "asc" },
      }),
    }));
  }

  createProject(principal: Principal, name: string, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.policy.require(scope, "projects.create", { stepUp: true });
        const project = await scope.tx.project.create({
          data: { tenantId: scope.access.tenantId, name },
          select: publicProject,
        });
        await this.scope.audit(scope.tx, "project.created", project.id);
        return { project };
      },
      true,
    );
  }

  updateProject(principal: Principal, projectId: string, name: string, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.policy.require(scope, "projects.manage", { projectId });
        const updated = await scope.tx.project.update({
          where: { tenantId_id: { tenantId: scope.access.tenantId, id: projectId } },
          data: { name },
          select: publicProject,
        });
        await this.scope.audit(scope.tx, "project.updated", projectId);
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
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.policy.require(scope, "users.invite", { stepUp: true });
        const held = await this.policy.require(scope, "projects.manage", { projectId });
        const target = await tx.membership.findUnique({
          where: { tenantId_userId: { tenantId: access.tenantId, userId } },
        });
        if (!target) throw new NotFoundException("Project or member not found");
        if (new Set(permissions).size !== permissions.length)
          throw new ConflictException("Duplicate permissions");
        if (permissions.some((permission) => !held.has(permission)))
          throw new ForbiddenException(
            "You can only grant project permissions you hold on this project",
          );
        await tx.projectMembership.upsert({
          where: { tenantId_projectId_userId: { tenantId: access.tenantId, projectId, userId } },
          create: { tenantId: access.tenantId, projectId, userId, permissions },
          update: { permissions },
        });
        await this.scope.audit(tx, "project.permissions.changed", projectId, {
          userId,
          permissions,
        });
        return { message: "Project permissions updated." };
      },
      true,
    );
  }
}
