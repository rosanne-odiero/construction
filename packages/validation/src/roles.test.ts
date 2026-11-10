import { PERMISSIONS, TENANT_PERMISSIONS } from "@pm-buddy/types";
import { describe, expect, it } from "vitest";
import {
  createRoleRequestSchema,
  memberRoleRequestSchema,
  permissionCatalogue,
  permissionCatalogueResponseSchema,
  roleReferenceSchema,
  rolesResponseSchema,
  tenantPermissionSchema,
  tenantsResponseSchema,
  updateRoleRequestSchema,
} from "./index.js";

const id = "550e8400-e29b-41d4-a716-446655440000";
const date = "2026-11-10T20:00:00.000Z";

describe("role and permission contracts", () => {
  it("never accepts platform.admin or unknown permissions in a tenant role", () => {
    expect(tenantPermissionSchema.options).toEqual(TENANT_PERMISSIONS);
    expect(tenantPermissionSchema.safeParse("platform.admin").success).toBe(false);
    for (const permissions of [["platform.admin"], ["payments.steal"], [], ["bq.view", "bq.view"]])
      expect(
        createRoleRequestSchema.safeParse({ name: "Site clerk", permissions }).success,
        JSON.stringify(permissions),
      ).toBe(false);
    expect(
      updateRoleRequestSchema.safeParse({ permissions: ["projects.view", "platform.admin"] })
        .success,
    ).toBe(false);
  });

  it("accepts a valid custom role and defaults it to project-scoped", () => {
    expect(
      createRoleRequestSchema.parse({ name: "  Site clerk ", permissions: ["projects.view"] }),
    ).toEqual({ name: "Site clerk", permissions: ["projects.view"], tenantWide: false });
  });

  it("rejects reserved, empty and unsafe role names and mass assignment", () => {
    for (const name of ["Owner", "project manager", "PLATFORM_ADMIN", "x", "<script>", " "])
      expect(
        createRoleRequestSchema.safeParse({ name, permissions: ["projects.view"] }).success,
        name,
      ).toBe(false);
    expect(
      createRoleRequestSchema.safeParse({
        name: "Mhasibu msaidizi",
        permissions: ["finance.view"],
        tenantId: id,
      }).success,
    ).toBe(false);
    expect(
      createRoleRequestSchema.safeParse({ name: "Mhasibu msaidizi", permissions: ["finance.view"] })
        .success,
    ).toBe(true);
    expect(updateRoleRequestSchema.safeParse({}).success).toBe(false);
  });

  it("references a system role key or a custom role ID, never platform_admin", () => {
    expect(roleReferenceSchema.safeParse("project_manager").success).toBe(true);
    expect(roleReferenceSchema.safeParse(id).success).toBe(true);
    expect(roleReferenceSchema.safeParse("platform_admin").success).toBe(false);
    expect(roleReferenceSchema.safeParse("administrator").success).toBe(false);
    expect(memberRoleRequestSchema.safeParse({ role: "owner", userId: id }).success).toBe(false);
  });

  it("serves the whole catalogue grouped by area with platform.admin not assignable", () => {
    const catalogue = permissionCatalogueResponseSchema.parse(permissionCatalogue());
    const keys = catalogue.areas.flatMap((area) => area.permissions.map((entry) => entry.key));
    expect(keys).toEqual([...PERMISSIONS]);
    const entries = catalogue.areas.flatMap((area) => area.permissions);
    expect(entries.find((entry) => entry.key === "platform.admin")?.assignable).toBe(false);
    expect(entries.find((entry) => entry.key === "payments.approve")).toMatchObject({
      mfaRequired: true,
      projectScoped: true,
      assignable: true,
    });
    expect(entries.find((entry) => entry.key === "roles.manage")).toMatchObject({
      mfaRequired: true,
      projectScoped: false,
    });
    for (const area of catalogue.areas)
      for (const entry of area.permissions)
        expect(entry.key.startsWith(`${area.area}.`)).toBe(true);
  });

  it("validates system and custom role listings strictly", () => {
    const system = {
      kind: "system",
      id: "owner",
      name: null,
      permissions: ["roles.manage"],
      tenantWide: true,
      mfaRequired: true,
      memberCount: 1,
      assignable: true,
    };
    const custom = {
      ...system,
      kind: "custom",
      id,
      name: "Site clerk",
      tenantWide: false,
      mfaRequired: false,
      createdAt: date,
      updatedAt: date,
    };
    expect(rolesResponseSchema.parse({ roles: [system, custom] }).roles).toHaveLength(2);
    expect(rolesResponseSchema.safeParse({ roles: [{ ...system, id }] }).success).toBe(false);
    expect(rolesResponseSchema.safeParse({ roles: [{ ...custom, name: null }] }).success).toBe(
      false,
    );
    expect(rolesResponseSchema.safeParse({ roles: [{ ...system, tenantId: id }] }).success).toBe(
      false,
    );
  });

  it("requires the caller's permissions and role name on every company entry", () => {
    expect(
      tenantsResponseSchema.safeParse({ tenants: [{ id, name: "Company", role: "owner" }] })
        .success,
    ).toBe(false);
  });
});
