import { describe, expect, it } from "vitest";
import {
  isPermission,
  MFA_REQUIRED_PERMISSIONS,
  MFA_REQUIRED_ROLES,
  permissionArea,
  PERMISSION_AREAS,
  PERMISSIONS,
  permissionsRequireMfa,
  PORTAL_HOME,
  pinAllowed,
  portalFor,
  PROJECT_PERMISSIONS,
  problemType,
  SYSTEM_ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  TENANT_LEVEL_PERMISSIONS,
  TENANT_PERMISSIONS,
  TENANT_SYSTEM_ROLES,
  TENANT_WIDE_SYSTEM_ROLES,
  type Permission,
} from "./index.js";

describe("permission catalogue", () => {
  it("uses unique module.action keys", () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const permission of PERMISSIONS) expect(permission).toMatch(/^[a-z]+\.[a-z_]+$/);
  });

  it("guards unknown permissions", () => {
    expect(isPermission("payments.approve")).toBe(true);
    expect(isPermission("payments.steal")).toBe(false);
  });

  it("groups every permission into exactly one area", () => {
    expect(permissionArea("payments.approve")).toBe("payments");
    expect(PERMISSION_AREAS[0]).toBe("tenancy");
    expect(new Set(PERMISSION_AREAS).size).toBe(PERMISSION_AREAS.length);
    for (const permission of PERMISSIONS)
      expect(PERMISSION_AREAS).toContain(permissionArea(permission));
  });

  it("keeps platform.admin out of every tenant permission set", () => {
    expect(TENANT_PERMISSIONS).not.toContain("platform.admin");
    expect(TENANT_PERMISSIONS).toHaveLength(PERMISSIONS.length - 1);
    expect(PROJECT_PERMISSIONS).not.toContain("platform.admin");
  });

  it("partitions tenant permissions into company-level and project-scoped", () => {
    const levels = [...TENANT_LEVEL_PERMISSIONS, ...PROJECT_PERMISSIONS].sort();
    expect(levels).toEqual([...TENANT_PERMISSIONS].sort());
    expect(PROJECT_PERMISSIONS).toContain("projects.view");
    expect(PROJECT_PERMISSIONS).not.toContain("roles.manage");
  });

  it("requires MFA for the brief's privileged permissions only", () => {
    for (const permission of MFA_REQUIRED_PERMISSIONS) expect(isPermission(permission)).toBe(true);
    expect(permissionsRequireMfa(["payments.approve"])).toBe(true);
    expect(permissionsRequireMfa(["roles.manage", "projects.view"])).toBe(true);
    expect(permissionsRequireMfa(["projects.view", "bq.edit", "payroll.prepare"])).toBe(false);
    expect(permissionsRequireMfa([])).toBe(false);
  });
});

describe("system roles", () => {
  it("lists only catalogue permissions without duplicates", () => {
    for (const role of SYSTEM_ROLES) {
      const permissions = SYSTEM_ROLE_PERMISSIONS[role];
      expect(new Set(permissions).size, role).toBe(permissions.length);
      for (const permission of permissions) expect(isPermission(permission), role).toBe(true);
    }
  });

  it("gives the owner every tenant permission and nobody but the platform operator platform.admin", () => {
    expect([...SYSTEM_ROLE_PERMISSIONS.owner].sort()).toEqual([...TENANT_PERMISSIONS].sort());
    for (const role of TENANT_SYSTEM_ROLES)
      expect(SYSTEM_ROLE_PERMISSIONS[role], role).not.toContain("platform.admin");
    expect(SYSTEM_ROLE_PERMISSIONS.platform_admin).toEqual(["platform.admin"]);
    expect(TENANT_SYSTEM_ROLES).not.toContain("platform_admin");
  });

  it("limits clients and suppliers to their portal and view permissions", () => {
    const allowed = (permission: Permission) =>
      permission.startsWith("portal.") || permission.endsWith(".view");
    for (const role of ["client", "supplier", "labourer"] as const)
      expect(SYSTEM_ROLE_PERMISSIONS[role].every(allowed), role).toBe(true);
    expect(SYSTEM_ROLE_PERMISSIONS.client).toContain("portal.client");
    expect(SYSTEM_ROLE_PERMISSIONS.client).not.toContain("portal.supplier");
    expect(SYSTEM_ROLE_PERMISSIONS.supplier).toContain("portal.supplier");
    expect(SYSTEM_ROLE_PERMISSIONS.supplier).not.toContain("portal.client");
    expect(SYSTEM_ROLE_PERMISSIONS.labourer).toEqual(["portal.worker"]);
  });

  it("sends staff to the office, clients, labourers and suppliers to their own portals", () => {
    expect(portalFor(SYSTEM_ROLE_PERMISSIONS.client)).toBe("client");
    expect(portalFor(SYSTEM_ROLE_PERMISSIONS.labourer)).toBe("worker");
    expect(portalFor(SYSTEM_ROLE_PERMISSIONS.supplier)).toBe("supplier");
    for (const role of TENANT_SYSTEM_ROLES.filter(
      (r) => r !== "client" && r !== "labourer" && r !== "supplier",
    ))
      expect(portalFor(SYSTEM_ROLE_PERMISSIONS[role]), role).toBe("office");
    expect(portalFor(["portal.supplier", "procurement.requisition"])).toBe("office");
    expect(portalFor(["portal.client", "site.diary"])).toBe("office");
    expect(portalFor(["projects.view"])).toBe("office");
    expect(portalFor(["portal.worker", "not.a.permission"])).toBe("worker");
    expect(portalFor([])).toBe("office");
    expect(PORTAL_HOME).toEqual({
      office: "/projects",
      client: "/portal",
      worker: "/worker",
      supplier: "/supplier",
    });
  });

  it("lets a PIN session act only with the labourer portal permission", () => {
    expect(pinAllowed(SYSTEM_ROLE_PERMISSIONS.labourer)).toBe(true);
    // A worker for portalFor, but a guessed PIN must not open BQ rates or contract sums.
    expect(portalFor(["portal.worker", "bq.view", "projects.view"])).toBe("worker");
    expect(pinAllowed(["portal.worker", "bq.view", "projects.view"])).toBe(false);
    expect(pinAllowed(["portal.worker", "portal.client"])).toBe(false);
    expect(pinAllowed(SYSTEM_ROLE_PERMISSIONS.client)).toBe(false);
    expect(pinAllowed([])).toBe(false);
  });

  it("derives the MFA-required roles from their permissions (owner, finance, platform admin)", () => {
    expect([...MFA_REQUIRED_ROLES].sort()).toEqual(["finance", "owner", "platform_admin"]);
    for (const role of SYSTEM_ROLES)
      expect(MFA_REQUIRED_ROLES.includes(role), role).toBe(
        permissionsRequireMfa(SYSTEM_ROLE_PERMISSIONS[role]),
      );
  });

  it("makes only owner, finance and the platform operator company-wide", () => {
    expect([...TENANT_WIDE_SYSTEM_ROLES].sort()).toEqual(["finance", "owner", "platform_admin"]);
  });
});

describe("problemType", () => {
  it("builds stable problem type URIs", () => {
    expect(problemType("step-up-required")).toBe("https://pm-buddy.dev/problems/step-up-required");
  });
});
