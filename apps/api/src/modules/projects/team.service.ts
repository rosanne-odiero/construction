import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Request } from "express";
import {
  isProjectAssignablePermission,
  PROJECT_ASSIGNABLE_PERMISSIONS,
  type Permission,
  type ProjectAssignablePermission,
} from "@pm-buddy/types";
import { messageResponseSchema, projectTeamResponseSchema } from "@pm-buddy/validation";
import { AccessPolicy, customRoleColumns } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { effectiveProjectPermissions, grantOf, roleReference } from "../identity/role-grants.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { ProjectAccess } from "./project-access.js";
import { inCatalogueOrder } from "./project-mappers.js";

const assignable = (permissions: Iterable<string>): ProjectAssignablePermission[] =>
  PROJECT_ASSIGNABLE_PERMISSIONS.filter((permission) => [...permissions].includes(permission));

const notHeld = () =>
  new ForbiddenException(
    "You can only grant or remove project permissions you hold on this project",
  );

/**
 * Project team (D2.1): who works on a project, with their company role and effective project
 * permissions (role ∩ assignment), and assignment changes through AccessPolicy's rules.
 */
@Injectable()
export class TeamService {
  constructor(
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
    private readonly access: ProjectAccess,
  ) {}

  team(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const { effective } = await this.access.load(scope, projectId, "projects.view");
      const canAssign = access.permissions.has("users.invite") && effective.has("projects.manage");
      const [memberships, assignments] = await Promise.all([
        tx.membership.findMany({
          where: { tenantId: access.tenantId },
          select: { ...customRoleColumns, userId: true, user: { select: { displayName: true } } },
          orderBy: { joinedAt: "asc" },
        }),
        tx.projectMembership.findMany({
          where: { tenantId: access.tenantId, projectId },
          select: { userId: true, permissions: true },
        }),
      ]);
      const assignmentOf = new Map(assignments.map((row) => [row.userId, row.permissions]));
      const members = [];
      const candidates = [];
      for (const membership of memberships) {
        const grant = grantOf(membership);
        const stored = assignmentOf.get(membership.userId) ?? null;
        const base = {
          userId: membership.userId,
          displayName: membership.user.displayName,
          role: roleReference(grant),
          roleName: grant.roleName,
        };
        if (grant.tenantWide || (stored && stored.length > 0)) {
          members.push({
            ...base,
            companyWide: grant.tenantWide,
            assignment: stored ? assignable(stored) : null,
            effective: inCatalogueOrder(effectiveProjectPermissions(grant, stored)),
          });
        } else if (canAssign) {
          candidates.push(base);
        }
      }
      return projectTeamResponseSchema.parse({
        members,
        candidates,
        canAssign,
        grantable: canAssign ? assignable(effective) : [],
      });
    });
  }

  /**
   * Sets a member's project permissions. Needs users.invite (fresh step-up) and projects.manage on
   * the project; every permission granted or taken away must be one the caller holds there.
   */
  assign(
    principal: Principal,
    projectId: string,
    userId: string,
    permissions: Permission[],
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
        if (!permissions.every(isProjectAssignablePermission)) throw notHeld();
        // Supplier portal users (D7.2) are scoped by their supplier, never by a project.
        if (
          await tx.supplierPortalUser.count({
            where: { tenantId: access.tenantId, userId, status: "active" },
          })
        )
          throw new ConflictException({
            code: "supplier-portal-user",
            message: "Supplier portal users see their supplier's orders only; they join no project",
          });
        const current = await tx.projectMembership.findUnique({
          where: { tenantId_projectId_userId: { tenantId: access.tenantId, projectId, userId } },
          select: { permissions: true },
        });
        const before = new Set(current?.permissions ?? []);
        const after = new Set<string>(permissions);
        const added = permissions.filter((permission) => !before.has(permission));
        const removed = [...before].filter((permission) => !after.has(permission));
        if ([...added, ...removed].some((permission) => !held.has(permission as Permission)))
          throw notHeld();
        const stored = assignable(permissions);
        await tx.projectMembership.upsert({
          where: { tenantId_projectId_userId: { tenantId: access.tenantId, projectId, userId } },
          create: { tenantId: access.tenantId, projectId, userId, permissions: stored },
          update: { permissions: stored },
        });
        await this.scope.audit(tx, "project.permissions.changed", projectId, {
          userId,
          permissions: stored,
        });
        return messageResponseSchema.parse({ message: "Project permissions updated." });
      },
      true,
    );
  }

  /** Removes a member's project assignment (same checks as assign: they must all be held). */
  remove(principal: Principal, projectId: string, userId: string, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.policy.require(scope, "users.invite", { stepUp: true });
        const held = await this.policy.require(scope, "projects.manage", { projectId });
        const current = await tx.projectMembership.findUnique({
          where: { tenantId_projectId_userId: { tenantId: access.tenantId, projectId, userId } },
          select: { permissions: true },
        });
        if (!current) throw new NotFoundException("Project member not found");
        if (current.permissions.some((permission) => !held.has(permission as Permission)))
          throw notHeld();
        await tx.projectMembership.delete({
          where: { tenantId_projectId_userId: { tenantId: access.tenantId, projectId, userId } },
        });
        await this.scope.audit(tx, "project.member_removed", projectId, {
          userId,
          permissions: current.permissions,
        });
        return messageResponseSchema.parse({ message: "Removed from the project." });
      },
      true,
    );
  }
}
