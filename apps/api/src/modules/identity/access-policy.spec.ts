import { ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  PROJECT_PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  TENANT_PERMISSIONS,
  TENANT_SYSTEM_ROLES,
  type Permission,
} from "@pm-buddy/types";
import { describe, expect, it, vi } from "vitest";
import { AccessPolicy, type Access, type Scope } from "./access-policy.js";
import type { AuthService, Principal } from "./auth.service.js";
import {
  effectiveProjectPermissions,
  escalation,
  grantOf,
  requiresMfa,
  roleReference,
  systemGrant,
} from "./role-grants.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000002";
const projectId = "10000000-0000-4000-8000-000000000003";
const roleId = "10000000-0000-4000-8000-000000000004";

const custom = (permissions: string[], tenantWide = false) =>
  grantOf({
    role: "custom",
    customRoleId: roleId,
    customRole: { name: "Site clerk", permissions, tenantWide },
  });

function scopeFor(
  grant: ReturnType<typeof grantOf>,
  project: { members: { permissions: string[] }[] } | null = { members: [] },
) {
  const requireMfa = vi.fn();
  const findUnique = vi.fn().mockResolvedValue(project);
  const access: Access = { ...grant, tenantId, userId };
  const scope = {
    tx: { project: { findUnique } },
    principal: {} as Principal,
    access,
  } as unknown as Scope;
  const policy = new AccessPolicy({ requireMfa } as unknown as AuthService);
  return { scope, policy, requireMfa, findUnique };
}

describe("role resolution", () => {
  it("resolves system roles from the shared defaults", () => {
    for (const role of TENANT_SYSTEM_ROLES) {
      const grant = grantOf({ role, customRoleId: null });
      expect([...grant.permissions].sort()).toEqual([...SYSTEM_ROLE_PERMISSIONS[role]].sort());
      expect(roleReference(grant)).toBe(role);
      expect(grant.unresolved).toBe(false);
    }
    expect(systemGrant("owner").tenantWide).toBe(true);
    expect(systemGrant("project_manager").tenantWide).toBe(false);
  });

  it("resolves custom roles and drops anything outside the tenant catalogue", () => {
    const grant = custom(["projects.view", "platform.admin", "payments.steal"]);
    expect([...grant.permissions]).toEqual(["projects.view"]);
    expect(grant.roleName).toBe("Site clerk");
    expect(roleReference(grant)).toBe(roleId);
  });

  it("fails closed on inconsistent or unreadable roles: no permissions, MFA still required", () => {
    for (const stored of [
      { role: "custom", customRoleId: roleId, customRole: null },
      { role: "owner", customRoleId: roleId },
      { role: "platform_admin", customRoleId: null },
      { role: "administrator", customRoleId: null },
    ]) {
      const grant = grantOf(stored);
      expect(grant.permissions.size, JSON.stringify(stored)).toBe(0);
      expect(grant.unresolved).toBe(true);
      expect(requiresMfa(grant)).toBe(true);
    }
  });

  it("requires MFA by permission, not role name", () => {
    expect(requiresMfa(systemGrant("owner"))).toBe(true);
    expect(requiresMfa(systemGrant("finance"))).toBe(true);
    expect(requiresMfa(systemGrant("project_manager"))).toBe(false);
    expect(requiresMfa(custom(["projects.view", "payments.approve"]))).toBe(true);
    expect(requiresMfa(custom(["roles.manage"]))).toBe(true);
    expect(requiresMfa(custom(["projects.view", "bq.edit"]))).toBe(false);
  });
});

describe("project scope", () => {
  it("gives company-wide roles their project permissions on every project", () => {
    const owner = effectiveProjectPermissions(systemGrant("owner"), null);
    expect([...owner].sort()).toEqual([...PROJECT_PERMISSIONS].sort());
    expect(owner.has("roles.manage")).toBe(false);
  });

  it("intersects other roles with their project assignment", () => {
    const manager = systemGrant("project_manager");
    expect(effectiveProjectPermissions(manager, null).size).toBe(0);
    expect([...effectiveProjectPermissions(manager, ["projects.view"])]).toEqual(["projects.view"]);
    const client = systemGrant("client");
    expect([...effectiveProjectPermissions(client, ["projects.view", "projects.manage"])]).toEqual([
      "projects.view",
    ]);
  });
});

describe("privilege-escalation guard", () => {
  const manager = systemGrant("project_manager");

  it("never allows platform.admin, even for owners", () => {
    expect(
      escalation(systemGrant("owner"), { permissions: ["platform.admin"], tenantWide: false }),
    ).toBe("platform-permission");
  });

  it("allows only permissions the actor holds", () => {
    expect(
      escalation(manager, { permissions: ["projects.view", "bq.edit"], tenantWide: false }),
    ).toBe(null);
    expect(escalation(manager, { permissions: ["payments.approve"], tenantWide: false })).toBe(
      "permission-not-held",
    );
    expect(escalation(manager, systemGrant("owner"))).toBe("permission-not-held");
    expect(
      escalation(systemGrant("owner"), { permissions: TENANT_PERMISSIONS, tenantWide: true }),
    ).toBe(null);
  });

  it("allows company-wide scope only from a company-wide role", () => {
    expect(escalation(manager, { permissions: ["projects.view"], tenantWide: true })).toBe(
      "tenant-wide-not-held",
    );
    const admin = custom(["roles.manage", "projects.view"], true);
    expect(escalation(admin, { permissions: ["projects.view"], tenantWide: true })).toBe(null);
  });

  it("lets nobody with an unresolved role grant anything", () => {
    const unresolved = grantOf({ role: "custom", customRoleId: roleId, customRole: null });
    expect(escalation(unresolved, { permissions: [], tenantWide: false })).toBe(
      "permission-not-held",
    );
  });
});

describe("AccessPolicy.require", () => {
  it("allows a held company-level permission and enforces step-up when asked", async () => {
    const { scope, policy, requireMfa } = scopeFor(systemGrant("owner"));
    await expect(policy.require(scope, "roles.manage")).resolves.toBeDefined();
    expect(requireMfa).not.toHaveBeenCalled();
    await policy.require(scope, "roles.manage", { stepUp: true });
    expect(requireMfa).toHaveBeenCalledWith(scope.principal, true);
  });

  it("denies permissions the role lacks with 403, before any step-up", async () => {
    const { scope, policy, requireMfa } = scopeFor(systemGrant("client"));
    await expect(policy.require(scope, "roles.manage", { stepUp: true })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(requireMfa).not.toHaveBeenCalled();
  });

  it("treats a project permission without a project as company-wide use", async () => {
    const manager = scopeFor(systemGrant("project_manager"));
    await expect(manager.policy.require(manager.scope, "projects.view")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const owner = scopeFor(systemGrant("owner"));
    await expect(owner.policy.require(owner.scope, "projects.view")).resolves.toBeDefined();
  });

  it("resolves the project in the caller's tenant: 404 when absent, role ∩ assignment otherwise", async () => {
    const missing = scopeFor(systemGrant("owner"), null);
    await expect(
      missing.policy.require(missing.scope, "projects.manage", { projectId }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(missing.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId_id: { tenantId, id: projectId } } }),
    );

    const unassigned = scopeFor(systemGrant("project_manager"), { members: [] });
    await expect(
      unassigned.policy.require(unassigned.scope, "projects.view", { projectId }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const viewer = scopeFor(systemGrant("project_manager"), {
      members: [{ permissions: ["projects.view"] }],
    });
    await expect(
      viewer.policy.require(viewer.scope, "projects.view", { projectId }),
    ).resolves.toEqual(new Set<Permission>(["projects.view"]));
    await expect(
      viewer.policy.require(viewer.scope, "projects.manage", { projectId }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const client = scopeFor(systemGrant("client"), {
      members: [{ permissions: ["projects.view", "projects.manage"] }],
    });
    await expect(
      client.policy.require(client.scope, "projects.manage", { projectId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("accepts any one of several permissions", async () => {
    const { scope, policy } = scopeFor(custom(["users.invite"]));
    await expect(policy.requireAny(scope, ["roles.manage", "users.invite"])).resolves.toBeDefined();
    await expect(policy.requireAny(scope, ["roles.manage", "audit.view"])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("filters projects by scope", () => {
    const owner = scopeFor(systemGrant("owner"));
    expect(owner.policy.projectWhere(owner.scope, "projects.view")).toEqual({ tenantId });
    const manager = scopeFor(systemGrant("project_manager"));
    expect(manager.policy.projectWhere(manager.scope, "projects.view")).toEqual({
      tenantId,
      members: { some: { userId, permissions: { has: "projects.view" } } },
    });
    const none = scopeFor(custom(["bq.view"]));
    expect(none.policy.projectWhere(none.scope, "projects.view")).toEqual({ id: { in: [] } });
  });

  it("raises 403 for escalation attempts", () => {
    const { scope, policy } = scopeFor(systemGrant("project_manager"));
    expect(() =>
      policy.assertGrantable(scope.access, { permissions: ["finance.manage"], tenantWide: false }),
    ).toThrow(ForbiddenException);
    expect(() =>
      policy.assertGrantable(scope.access, { permissions: ["projects.view"], tenantWide: false }),
    ).not.toThrow();
  });
});
