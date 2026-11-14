import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  pinAllowed,
  PROJECT_ASSIGNABLE_PERMISSIONS,
  type ProjectAssignablePermission,
} from "@pm-buddy/types";
import type { Prisma } from "../../generated/prisma/client.js";
import { AppConfig } from "../../config/app-config.js";
import { AccessPolicy, customRoleColumns, type Scope } from "./access-policy.js";
import { AuthService, type Principal } from "./auth.service.js";
import { AuthSecurity, digest, opaqueToken } from "./auth-security.service.js";
import { grantOf, requiresMfa, roleReference, type Grant } from "./role-grants.js";
import { TenantDatabase } from "./tenant-database.service.js";
import { pinSessionLimited, TenantScope } from "./tenant-scope.service.js";

/** Invitation acceptance assigns the role's own project permissions on each invited project. */
const defaultAssignment = (grant: Grant): ProjectAssignablePermission[] =>
  PROJECT_ASSIGNABLE_PERMISSIONS.filter((permission) => grant.permissions.has(permission));
const INVITATION_HOURS = 48;

@Injectable()
export class TenancyService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly auth: AuthService,
    private readonly security: AuthSecurity,
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
    private readonly config: AppConfig,
  ) {}

  /**
   * The SMS/email for an invitation. Labourers get a link that opens the PIN set-up page and
   * supplier contacts one that opens the supplier portal's join page (D7.2).
   */
  invitationText(grant: Grant, token: string): string {
    const origin = new URL(this.config.get("WEB_ORIGIN")).origin;
    if (grant.role === "labourer")
      return `You have been invited to PM-Buddy as a labourer. Open ${origin}/worker/join?token=${token} to set your PIN. Expires in ${INVITATION_HOURS} hours.`;
    if (grant.role === "supplier")
      return `Invitation token: ${token}\nYou have been invited to the PM-Buddy supplier portal. Open ${origin}/supplier/join?token=${token} to create your account or sign in. Expires in ${INVITATION_HOURS} hours.`;
    return `Invitation token: ${token}\nExpires in ${INVITATION_HOURS} hours.`;
  }

  /**
   * A supplier-portal invitation (D7.2) in the caller's transaction: the `supplier` system role,
   * no project, 48 hours. The caller has checked who may invite and binds the supplier; refused
   * when the identifier already belongs to a member of the company. Returns the token to send.
   */
  async createSupplierInvitation(scope: Scope, identifier: string) {
    const { tx, access } = scope;
    const existing = await tx.membership.findFirst({
      where: { tenantId: access.tenantId, user: { identifier } },
      select: { userId: true },
    });
    if (existing)
      throw new ConflictException({
        code: "already-member",
        message: "This email address or phone number already belongs to a member of the company",
      });
    const token = opaqueToken();
    const invitation = await tx.invitation.create({
      data: {
        tenantId: access.tenantId,
        identifier,
        role: "supplier",
        digest: digest(token),
        expiresAt: new Date(Date.now() + INVITATION_HOURS * 60 * 60_000),
        createdBy: access.userId,
      },
      select: { id: true, expiresAt: true },
    });
    return { ...invitation, token };
  }

  /** Sends a supplier-portal invitation after its transaction committed. */
  sendSupplierInvitation(identifier: string, token: string) {
    return this.security.notify(
      identifier,
      "PM-Buddy supplier portal invitation",
      this.invitationText(grantOf({ role: "supplier", customRoleId: null }), token),
    );
  }

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
    if (principal.session.authMethod === "pin") throw pinSessionLimited();
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
        if (grant.role === "labourer" && input.identifier.includes("@"))
          throw new BadRequestException({
            code: "labourer-phone-required",
            message: "Labourers sign in with a Kenyan phone number and PIN; invite a phone number",
          });
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
            expiresAt: new Date(Date.now() + INVITATION_HOURS * 60 * 60_000),
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
        return { ...invitation, role: roleReference(grant), roleName: grant.roleName, grant };
      },
      true,
    );
    const { grant, ...summary } = invitation;
    await this.security.notify(
      input.identifier,
      "Company invitation",
      this.invitationText(grant, token),
    );
    return { invitation: summary };
  }

  /**
   * A project manager (labour.manage on the project) invites a labourer by phone number: the
   * labourer role grants only `portal.worker`, assigned on this project, so no privilege can be
   * escalated and no MFA step-up is needed. The SMS carries a link to set a PIN.
   */
  async inviteLabourer(principal: Principal, projectId: string, identifier: string, req: Request) {
    await this.auth.throttle(req, "invitation", principal.user.id);
    const token = opaqueToken();
    const grant = grantOf({ role: "labourer", customRoleId: null });
    const invitation = await this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.policy.require(scope, "labour.manage", { projectId });
        const project = await tx.project.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: access.tenantId, id: projectId } },
          select: { status: true },
        });
        if (project.status === "closed" || project.status === "cancelled")
          throw new ConflictException({
            code: "project-read-only",
            message: "Closed and cancelled projects are read-only",
          });
        const existing = await tx.membership.findFirst({
          where: { tenantId: access.tenantId, user: { identifier } },
          select: { userId: true },
        });
        if (existing)
          throw new ConflictException({
            code: "already-member",
            message: "This phone number already belongs to a member of the company",
          });
        const created = await tx.invitation.create({
          data: {
            tenantId: access.tenantId,
            identifier,
            role: "labourer",
            digest: digest(token),
            expiresAt: new Date(Date.now() + INVITATION_HOURS * 60 * 60_000),
            createdBy: principal.user.id,
          },
          select: { id: true, identifier: true, expiresAt: true },
        });
        await tx.invitationProject.create({
          data: { tenantId: access.tenantId, invitationId: created.id, projectId },
        });
        await this.scope.audit(tx, "labourer.invited", created.id, { projectId });
        return { ...created, role: "labourer", roleName: null };
      },
      true,
    );
    await this.security.notify(
      identifier,
      "PM-Buddy invitation",
      this.invitationText(grant, token),
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
    await this.db.run(this.scope.context(principal, req, invitation.tenantId), (tx) =>
      this.redeem(tx, invitation, principal.user.id, (grant) => {
        // Privileged roles (by permission) need enrolled, freshly verified MFA before joining.
        if (requiresMfa(grant)) this.auth.requireMfa(principal, true);
        if (principal.session.authMethod === "pin" && !pinAllowed(grant.permissions))
          throw pinSessionLimited();
      }),
    );
    return { message: "Invitation accepted. Select the company to continue." };
  }

  /**
   * Joins the invitation's company in the caller's transaction (tenant context already set to
   * the invitation's company): single use, no existing membership, the role's own permissions on
   * each invited project. `check` may refuse the role (MFA, PIN sessions) before anything changes.
   */
  async redeem(
    tx: Prisma.TransactionClient,
    invitation: { id: string; tenantId: string },
    userId: string,
    check: (grant: Grant) => void,
  ): Promise<Grant> {
    await tx.$queryRaw`SELECT tenant_id FROM tenants WHERE tenant_id = ${invitation.tenantId}::uuid FOR UPDATE`;
    const stored = await tx.invitation.findUniqueOrThrow({
      where: { id: invitation.id },
      select: customRoleColumns,
    });
    const grant = grantOf(stored);
    check(grant);
    // A supplier-portal invitation (D7.2) binds the new member to its supplier once they join.
    const portal = await tx.supplierPortalUser.findUnique({
      where: {
        tenantId_invitationId: { tenantId: invitation.tenantId, invitationId: invitation.id },
      },
      select: { id: true, status: true },
    });
    if (portal && portal.status !== "invited")
      throw new ConflictException("This invitation was withdrawn");
    const result = await tx.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date() },
    });
    if (!result.count) throw new ConflictException("Invitation already accepted or expired");
    const existing = await tx.membership.findUnique({
      where: { tenantId_userId: { tenantId: invitation.tenantId, userId } },
    });
    if (existing)
      throw new ConflictException(
        "Already a member; roles cannot be changed through an invitation",
      );
    await tx.membership.create({
      data: {
        tenantId: invitation.tenantId,
        userId,
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
          userId,
          permissions: defaultAssignment(grant),
        },
      });
    }
    await tx.auditEvent.create({
      data: {
        tenantId: invitation.tenantId,
        actorId: userId,
        requestId: this.db.current().requestId,
        action: "membership.joined",
        resourceId: userId,
        metadata: { role: roleReference(grant) },
      },
    });
    if (portal) {
      await tx.supplierPortalUser.update({
        where: { tenantId_id: { tenantId: invitation.tenantId, id: portal.id } },
        data: { status: "active", userId, version: { increment: 1 } },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: invitation.tenantId,
          actorId: userId,
          requestId: this.db.current().requestId,
          action: "supplier_portal.user_activated",
          resourceId: portal.id,
          metadata: {},
        },
      });
    }
    return grant;
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
