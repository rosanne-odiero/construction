import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Request } from "express";
import { permissionsRequireMfa, TENANT_SYSTEM_ROLES, type Permission } from "@pm-buddy/types";
import {
  permissionCatalogue,
  type CreateRoleRequest,
  type Role,
  type UpdateRoleRequest,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, customRoleColumns, type Scope } from "./access-policy.js";
import { AuthService, type Principal } from "./auth.service.js";
import {
  escalation,
  grantOf,
  isTenantSystemRole,
  requiresMfa,
  roleReference,
  systemGrant,
  type Grant,
} from "./role-grants.js";
import { TenantScope } from "./tenant-scope.service.js";

type CustomRole = Prisma.TenantRoleGetPayload<{
  select: {
    id: true;
    name: true;
    permissions: true;
    tenantWide: true;
    createdAt: true;
    updatedAt: true;
  };
}>;
const customRoleSelect = {
  id: true,
  name: true,
  permissions: true,
  tenantWide: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Role names are unique per company, case-insensitively (citext unique index). */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "P2002";

/** Sorted, de-duplicated permissions, so stored roles and audit summaries are canonical. */
const canonical = (permissions: readonly Permission[]): Permission[] =>
  [...new Set(permissions)].sort();

/**
 * Tenant custom roles and member role changes (ARCHITECTURE §8). System roles are immutable;
 * every change needs roles.manage plus fresh step-up MFA, passes the privilege-escalation guard and
 * is audited.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly auth: AuthService,
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
  ) {}

  catalogue(principal: Principal) {
    this.auth.requireMfa(principal);
    return permissionCatalogue();
  }

  list(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.policy.requireAny(scope, ["roles.manage", "users.invite"]);
      const { tx, access } = scope;
      const [customRoles, counts] = await Promise.all([
        tx.tenantRole.findMany({
          where: { tenantId: access.tenantId },
          select: customRoleSelect,
          orderBy: { createdAt: "asc" },
        }),
        tx.membership.groupBy({
          by: ["role", "customRoleId"],
          where: { tenantId: access.tenantId },
          _count: { _all: true },
        }),
      ]);
      const count = (role: string, customRoleId: string | null = null) =>
        counts.find((row) => row.role === role && row.customRoleId === customRoleId)?._count._all ??
        0;
      const roles: Role[] = [
        ...TENANT_SYSTEM_ROLES.map((key) => this.describe(scope, systemGrant(key), count(key))),
        ...customRoles.map((role) => this.describeCustom(scope, role, count("custom", role.id))),
      ];
      return { roles };
    });
  }

  create(principal: Principal, input: CreateRoleRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          await this.policy.require(scope, "roles.manage", { stepUp: true });
          const permissions = canonical(input.permissions);
          this.policy.assertGrantable(access, { permissions, tenantWide: input.tenantWide });
          const role = await tx.tenantRole.create({
            data: {
              tenantId: access.tenantId,
              name: input.name,
              permissions,
              tenantWide: input.tenantWide,
              createdBy: access.userId,
            },
            select: customRoleSelect,
          });
          await this.scope.audit(tx, "role.created", role.id, {
            name: role.name,
            permissions,
            tenantWide: role.tenantWide,
          });
          return { role: this.describeCustom(scope, role, 0) };
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException("A role with this name exists");
        throw error;
      });
  }

  update(principal: Principal, reference: string, input: UpdateRoleRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          await this.policy.require(scope, "roles.manage", { stepUp: true });
          const current = await this.customRole(scope, reference);
          this.policy.assertGrantable(access, current);
          const permissions = input.permissions
            ? canonical(input.permissions)
            : current.permissions;
          const tenantWide = input.tenantWide ?? current.tenantWide;
          this.policy.assertGrantable(access, { permissions, tenantWide });
          if (permissionsRequireMfa(permissions as Permission[])) {
            const withoutMfa = await tx.membership.count({
              where: {
                tenantId: access.tenantId,
                customRoleId: current.id,
                user: { OR: [{ mfaEnabled: false }, { verifiedAt: null }] },
              },
            });
            if (withoutMfa)
              throw new ConflictException(
                "Every member holding this role must enrol MFA before it can include privileged permissions",
              );
          }
          const role = await tx.tenantRole.update({
            where: { tenantId_id: { tenantId: access.tenantId, id: current.id } },
            data: { name: input.name, permissions, tenantWide },
            select: customRoleSelect,
          });
          const before = new Set(current.permissions);
          await this.scope.audit(tx, "role.updated", role.id, {
            name: role.name,
            added: permissions.filter((permission) => !before.has(permission)),
            removed: current.permissions.filter((permission) => !permissions.includes(permission)),
            tenantWide: role.tenantWide,
          });
          const members = await tx.membership.count({
            where: { tenantId: access.tenantId, customRoleId: role.id },
          });
          return { role: this.describeCustom(scope, role, members) };
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException("A role with this name exists");
        throw error;
      });
  }

  remove(principal: Principal, reference: string, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.policy.require(scope, "roles.manage", { stepUp: true });
        const role = await this.customRole(scope, reference);
        this.policy.assertGrantable(access, role);
        const members = await tx.membership.count({
          where: { tenantId: access.tenantId, customRoleId: role.id },
        });
        if (members)
          throw new ConflictException(
            "This role is in use; move its members to another role first",
          );
        const pending = await tx.invitation.count({
          where: {
            tenantId: access.tenantId,
            customRoleId: role.id,
            acceptedAt: null,
            expiresAt: { gt: new Date() },
          },
        });
        if (pending)
          throw new ConflictException("Pending invitations use this role; wait for them to expire");
        // Accepted and expired invitations that named the role are removed with it (FK cascade).
        await tx.tenantRole.delete({
          where: { tenantId_id: { tenantId: access.tenantId, id: role.id } },
        });
        await this.scope.audit(tx, "role.deleted", role.id, { name: role.name });
        return { message: "Role deleted." };
      },
      true,
    );
  }

  /**
   * Moves a member to another role. Their active sessions in this company are revoked so the new
   * permissions apply from their next sign-in.
   */
  changeMemberRole(principal: Principal, userId: string, reference: string, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.policy.require(scope, "roles.manage", { stepUp: true });
        const target = await tx.membership.findUnique({
          where: { tenantId_userId: { tenantId: access.tenantId, userId } },
          select: {
            ...customRoleColumns,
            user: { select: { mfaEnabled: true, verifiedAt: true } },
          },
        });
        if (!target) throw new NotFoundException("Member not found");
        const current = grantOf(target);
        const next = await this.policy.resolveRole(scope, reference);
        this.policy.assertGrantable(access, current);
        this.policy.assertGrantable(access, next);
        if (roleReference(current) === roleReference(next))
          throw new ConflictException("The member already has this role");
        if (
          target.role === "owner" &&
          (await tx.membership.count({ where: { tenantId: access.tenantId, role: "owner" } })) <= 1
        )
          throw new ConflictException("The last owner cannot be demoted");
        if (requiresMfa(next) && !(target.user.mfaEnabled && target.user.verifiedAt))
          throw new ConflictException("This role requires the member to enrol MFA first");
        await tx.membership.update({
          where: { tenantId_userId: { tenantId: access.tenantId, userId } },
          data: { role: next.role, customRoleId: next.customRoleId },
        });
        const revoked = await tx.session.updateMany({
          where: { userId, activeTenantId: access.tenantId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.scope.audit(tx, "membership.role_changed", userId, {
          from: roleReference(current),
          to: roleReference(next),
          sessionsRevoked: revoked.count,
        });
        return {
          message: "Role changed and the member's active sessions in this company revoked.",
        };
      },
      true,
    );
  }

  private async customRole(scope: Scope, reference: string) {
    if (isTenantSystemRole(reference) || reference === "platform_admin")
      throw new ForbiddenException("System roles cannot be changed or deleted");
    const role = await scope.tx.tenantRole.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: reference } },
      select: customRoleSelect,
    });
    if (!role) throw new NotFoundException("Role not found");
    return role;
  }

  private describe(scope: Scope, grant: Grant, memberCount: number): Role {
    if (grant.role === "custom") throw new Error("Use describeCustom for custom roles");
    return {
      kind: "system",
      id: grant.role,
      name: null,
      permissions: [...grant.permissions],
      tenantWide: grant.tenantWide,
      mfaRequired: requiresMfa(grant),
      memberCount,
      assignable: escalation(scope.access, grant) === null,
    };
  }

  private describeCustom(scope: Scope, role: CustomRole, memberCount: number): Role {
    const grant = grantOf({ role: "custom", customRoleId: role.id, customRole: role });
    return {
      kind: "custom",
      id: role.id,
      name: role.name,
      permissions: [...grant.permissions],
      tenantWide: role.tenantWide,
      mfaRequired: requiresMfa(grant),
      memberCount,
      assignable: escalation(scope.access, grant) === null,
      createdAt: role.createdAt.toISOString(),
      updatedAt: role.updatedAt.toISOString(),
    };
  }
}
