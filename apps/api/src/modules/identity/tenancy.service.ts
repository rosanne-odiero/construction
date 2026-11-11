import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { PROJECT_ASSIGNABLE_PERMISSIONS, type ProjectAssignablePermission } from "@pm-buddy/types";
import { AccessPolicy, customRoleColumns } from "./access-policy.js";
import { AuthService, type Principal } from "./auth.service.js";
import { AuthSecurity, digest, opaqueToken } from "./auth-security.service.js";
import { grantOf, requiresMfa, roleReference, type Grant } from "./role-grants.js";
import { TenantDatabase } from "./tenant-database.service.js";
import { TenantScope } from "./tenant-scope.service.js";

/** Invitation acceptance assigns the role's own project permissions on each invited project. */
const defaultAssignment = (grant: Grant): ProjectAssignablePermission[] =>
  PROJECT_ASSIGNABLE_PERMISSIONS.filter((permission) => grant.permissions.has(permission));

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
        // Same guard as direct assignment: acceptance grants the role's project permissions on
        // each project, so the inviter must hold all of them there (role ∩ their assignment).
        const granted = defaultAssignment(grant);
        for (const projectId of input.projectIds) {
          const held = await this.policy.require(scope, "projects.manage", { projectId });
          if (granted.some((permission) => !held.has(permission)))
            throw new ForbiddenException(
              "You can only invite to a project with permissions you hold on that project",
            );
        }
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
}
