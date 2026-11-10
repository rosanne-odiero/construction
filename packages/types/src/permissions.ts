/**
 * Granular permission catalogue (ARCHITECTURE §8). The API policy checks these keys and the
 * database CHECK constraints on custom roles and project assignments list the same keys. Add new
 * permissions here, then extend those constraints in a new migration, so web, site app, API and
 * database agree.
 */
export const PERMISSIONS = [
  "tenancy.manage",
  "users.invite",
  "roles.manage",
  "audit.view",
  "config.manage",
  "config.manage_statutory",
  "projects.view",
  "projects.create",
  "projects.manage",
  "bq.view",
  "bq.edit",
  "bq.import",
  "bq.approve_variation",
  "labour.view",
  "labour.manage",
  "labour.view_sensitive",
  "attendance.view",
  "attendance.record",
  "attendance.override",
  "attendance.review_anomalies",
  "payroll.prepare",
  "payroll.review",
  "payroll.approve",
  "payments.view",
  "payments.approve",
  "payments.disburse",
  "payments.record_cash",
  "payments.reverse",
  "procurement.requisition",
  "procurement.approve",
  "procurement.manage_suppliers",
  "stores.manage",
  "finance.view",
  "finance.manage",
  "finance.view_sensitive",
  "site.diary",
  "site.photos",
  "quality.manage",
  "safety.manage",
  "plant.manage",
  "documents.manage",
  "reports.view",
  "portal.client",
  "portal.supplier",
  "platform.admin",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const isPermission = (value: string): value is Permission =>
  (PERMISSIONS as readonly string[]).includes(value);

/** The functional area of a permission: the part before the dot (`payments.approve` → `payments`). */
export type PermissionArea = Permission extends `${infer Area}.${string}` ? Area : never;

export const permissionArea = (permission: Permission): PermissionArea =>
  permission.slice(0, permission.indexOf(".")) as PermissionArea;

/** Areas in catalogue order, for grouping permission pickers. */
export const PERMISSION_AREAS: readonly PermissionArea[] = [
  ...new Set(PERMISSIONS.map(permissionArea)),
];

/** Held only by platform operators; no tenant role, system or custom, can ever grant it. */
export const PLATFORM_PERMISSIONS = ["platform.admin"] as const satisfies readonly Permission[];

/** Everything a tenant role may contain: the catalogue without the platform-only permissions. */
export const TENANT_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (permission) => !(PLATFORM_PERMISSIONS as readonly Permission[]).includes(permission),
);

/**
 * Company-level permissions. They are never project-scoped: a project assignment cannot carry
 * them. Every other tenant permission is project-scoped (ARCHITECTURE §8).
 */
export const TENANT_LEVEL_PERMISSIONS = [
  "tenancy.manage",
  "users.invite",
  "roles.manage",
  "audit.view",
  "config.manage",
  "config.manage_statutory",
  "projects.create",
  "procurement.manage_suppliers",
] as const satisfies readonly Permission[];

/** Permissions that a project assignment may carry; effective = role ∩ assignment. */
export const PROJECT_PERMISSIONS: readonly Permission[] = TENANT_PERMISSIONS.filter(
  (permission) => !(TENANT_LEVEL_PERMISSIONS as readonly Permission[]).includes(permission),
);

export const isProjectPermission = (permission: Permission): boolean =>
  PROJECT_PERMISSIONS.includes(permission);

/**
 * Holding any of these makes enrolled and verified MFA mandatory (brief §7: Owner, Finance and
 * Admin). The database guard app.permissions_require_mfa() lists the same keys.
 */
export const MFA_REQUIRED_PERMISSIONS = [
  "payroll.approve",
  "payments.approve",
  "payments.disburse",
  "payments.reverse",
  "finance.manage",
  "config.manage_statutory",
  "roles.manage",
  "tenancy.manage",
  "platform.admin",
] as const satisfies readonly Permission[];

export const permissionsRequireMfa = (permissions: Iterable<Permission>): boolean => {
  for (const permission of permissions)
    if ((MFA_REQUIRED_PERMISSIONS as readonly Permission[]).includes(permission)) return true;
  return false;
};
