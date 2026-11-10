import {
  isPermission,
  isProjectPermission,
  permissionsRequireMfa,
  PLATFORM_PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  TENANT_SYSTEM_ROLES,
  TENANT_WIDE_SYSTEM_ROLES,
  type Permission,
  type TenantSystemRole,
} from "@pm-buddy/types";

/** What a membership's role grants in its company (ARCHITECTURE §8). */
export type Grant = {
  /** System role key, or "custom". */
  role: TenantSystemRole | "custom";
  customRoleId: string | null;
  /** Custom role name; null for system roles (clients localise the key). */
  roleName: string | null;
  permissions: ReadonlySet<Permission>;
  /** Applies to every project in the company rather than only assigned projects. */
  tenantWide: boolean;
  /** The stored role could not be resolved; it grants nothing but still demands MFA. */
  unresolved: boolean;
};

/** The role columns of a membership or invitation, with its custom role when there is one. */
export type StoredRole = {
  role: string;
  customRoleId: string | null;
  customRole?: { name: string; permissions: string[]; tenantWide: boolean } | null;
};

const platformOnly = new Set<Permission>(PLATFORM_PERMISSIONS);
const tenantPermissions = (values: readonly string[]): Set<Permission> =>
  new Set(values.filter(isPermission).filter((permission) => !platformOnly.has(permission)));

export const isTenantSystemRole = (value: string): value is TenantSystemRole =>
  (TENANT_SYSTEM_ROLES as readonly string[]).includes(value);

export function systemGrant(role: TenantSystemRole): Grant {
  return {
    role,
    customRoleId: null,
    roleName: null,
    permissions: tenantPermissions(SYSTEM_ROLE_PERMISSIONS[role]),
    tenantWide: TENANT_WIDE_SYSTEM_ROLES.includes(role),
    unresolved: false,
  };
}

/** Resolves a stored role. Anything inconsistent fails closed: no permissions, MFA required. */
export function grantOf(stored: StoredRole): Grant {
  if (stored.role !== "custom" && stored.customRoleId === null && isTenantSystemRole(stored.role))
    return systemGrant(stored.role);
  const custom = stored.role === "custom" && stored.customRoleId ? stored.customRole : null;
  if (!custom) {
    return {
      role: "custom",
      customRoleId: stored.customRoleId,
      roleName: null,
      permissions: new Set(),
      tenantWide: false,
      unresolved: true,
    };
  }
  return {
    role: "custom",
    customRoleId: stored.customRoleId,
    roleName: custom.name,
    permissions: tenantPermissions(custom.permissions),
    tenantWide: custom.tenantWide,
    unresolved: false,
  };
}

/** The wire reference for a role: the system key or the custom role ID. */
export const roleReference = (grant: Grant): string =>
  grant.role === "custom" ? (grant.customRoleId ?? "custom") : grant.role;

/** Mandatory MFA follows the permissions held, not role names (brief §7). */
export const requiresMfa = (grant: Grant): boolean =>
  grant.unresolved || permissionsRequireMfa(grant.permissions);

/**
 * Effective permissions on one project. Company-wide roles keep their project-scoped permissions
 * everywhere; other roles need a project assignment and get role ∩ assignment.
 */
export function effectiveProjectPermissions(
  grant: Grant,
  assignment: readonly string[] | null,
): Set<Permission> {
  const scoped = [...grant.permissions].filter(isProjectPermission);
  if (grant.tenantWide) return new Set(scoped);
  if (!assignment) return new Set();
  return new Set(scoped.filter((permission) => assignment.includes(permission)));
}

export type EscalationReason =
  "platform-permission" | "permission-not-held" | "tenant-wide-not-held";

/**
 * Privilege-escalation guard: nobody may create, change, assign or remove a role carrying anything
 * they do not hold themselves, and platform permissions are never grantable.
 */
export function escalation(
  actor: Pick<Grant, "permissions" | "tenantWide" | "unresolved">,
  target: { permissions: Iterable<string>; tenantWide: boolean },
): EscalationReason | null {
  const permissions = [...target.permissions];
  if (permissions.some((permission) => platformOnly.has(permission as Permission)))
    return "platform-permission";
  if (actor.unresolved) return "permission-not-held";
  if (permissions.some((permission) => !actor.permissions.has(permission as Permission)))
    return "permission-not-held";
  if (target.tenantWide && !actor.tenantWide) return "tenant-wide-not-held";
  return null;
}
