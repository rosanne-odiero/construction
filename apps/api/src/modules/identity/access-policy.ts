import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { isProjectPermission, type Permission } from "@pm-buddy/types";
import type { Prisma } from "../../generated/prisma/client.js";
import { AuthService, type Principal } from "./auth.service.js";
import {
  effectiveProjectPermissions,
  escalation,
  grantOf,
  isTenantSystemRole,
  systemGrant,
  type EscalationReason,
  type Grant,
} from "./role-grants.js";

type Tx = Prisma.TransactionClient;

/** The caller's resolved access in the selected company, inside one tenant transaction. */
export type Access = Grant & { tenantId: string; userId: string };
export type Scope = { tx: Tx; principal: Principal; access: Access };
export type RequireOptions = {
  /** Check the permission on this project (resolved in the caller's tenant, never trusted). */
  projectId?: string;
  /** Also require MFA verified within the last five minutes (sensitive actions). */
  stepUp?: boolean;
};

const escalationMessages: Record<EscalationReason, string> = {
  "platform-permission": "Platform permissions can never be granted by a company",
  "permission-not-held": "You can only grant, change or remove roles whose permissions you hold",
  "tenant-wide-not-held": "Only a company-wide role can grant company-wide access",
};

export const customRoleColumns = {
  role: true,
  customRoleId: true,
  customRole: { select: { name: true, permissions: true, tenantWide: true } },
} as const;

/**
 * The single authorisation policy for tenancy and project endpoints (ARCHITECTURE §8). Every
 * check is a catalogue permission: role names are never compared outside role resolution.
 */
@Injectable()
export class AccessPolicy {
  constructor(private readonly auth: AuthService) {}

  /** Loads the caller's membership and role in `tenantId`; null if they are not a member. */
  async load(tx: Tx, tenantId: string, userId: string): Promise<Access | null> {
    const membership = await tx.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: customRoleColumns,
    });
    return membership ? { ...grantOf(membership), tenantId, userId } : null;
  }

  /**
   * Throws 403 unless the caller holds `permission`, on `projectId` when given (404 if the project
   * is not in the caller's company). A project-scoped permission without a project is a
   * company-wide use, so it needs a company-wide role. Returns the effective permissions.
   */
  async require(
    scope: Scope,
    permission: Permission,
    options: RequireOptions = {},
  ): Promise<ReadonlySet<Permission>> {
    const effective = await this.effective(scope, options.projectId);
    if (!effective.has(permission))
      throw new ForbiddenException(`Permission required: ${permission}`);
    if (!options.projectId && isProjectPermission(permission) && !scope.access.tenantWide)
      throw new ForbiddenException(`Company-wide permission required: ${permission}`);
    if (options.stepUp) this.auth.requireMfa(scope.principal, true);
    return effective;
  }

  /** Like require, for endpoints that any one of several permissions unlocks. */
  async requireAny(
    scope: Scope,
    permissions: readonly Permission[],
    options: RequireOptions = {},
  ): Promise<ReadonlySet<Permission>> {
    const effective = await this.effective(scope, options.projectId);
    if (!permissions.some((permission) => effective.has(permission)))
      throw new ForbiddenException(
        `One of these permissions is required: ${permissions.join(", ")}`,
      );
    if (options.stepUp) this.auth.requireMfa(scope.principal, true);
    return effective;
  }

  /** A filter for the projects on which the caller holds `permission`. */
  projectWhere(scope: Scope, permission: Permission): Prisma.ProjectWhereInput {
    const { access } = scope;
    if (!access.permissions.has(permission)) return { id: { in: [] } };
    if (access.tenantWide) return { tenantId: access.tenantId };
    return {
      tenantId: access.tenantId,
      members: { some: { userId: access.userId, permissions: { has: permission } } },
    };
  }

  /**
   * Resolves a role reference (system key or custom role ID) in the caller's company. A custom
   * role of another company is invisible under RLS and its composite key cannot match: 404.
   */
  async resolveRole(scope: Scope, reference: string): Promise<Grant> {
    if (isTenantSystemRole(reference)) return systemGrant(reference);
    const role = await scope.tx.tenantRole.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: reference } },
      select: { id: true, name: true, permissions: true, tenantWide: true },
    });
    if (!role) throw new NotFoundException("Role not found");
    return grantOf({ role: "custom", customRoleId: role.id, customRole: role });
  }

  /** Privilege-escalation guard (403). */
  assertGrantable(access: Access, target: { permissions: Iterable<string>; tenantWide: boolean }) {
    const reason = escalation(access, target);
    if (reason) throw new ForbiddenException(escalationMessages[reason]);
  }

  private async effective(scope: Scope, projectId?: string): Promise<ReadonlySet<Permission>> {
    const { tx, access } = scope;
    if (!projectId) return access.permissions;
    const project = await tx.project.findUnique({
      where: { tenantId_id: { tenantId: access.tenantId, id: projectId } },
      select: {
        members: { where: { userId: access.userId }, select: { permissions: true } },
      },
    });
    if (!project) throw new NotFoundException("Project not found");
    return effectiveProjectPermissions(access, project.members[0]?.permissions ?? null);
  }
}
