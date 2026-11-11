import { permissionsRequireMfa, TENANT_PERMISSIONS, type Permission } from "./permissions.js";

/** System roles from brief §3. Tenants add custom roles made of catalogue permissions (D1.4). */
export const SYSTEM_ROLES = [
  "platform_admin",
  "owner",
  "project_manager",
  "site_agent",
  "foreman",
  "quantity_surveyor",
  "storekeeper",
  "finance",
  "client",
  "consultant",
  "supplier",
  "labourer",
] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

/** System roles a company can assign; platform administration is never a tenant role. */
export const TENANT_SYSTEM_ROLES = SYSTEM_ROLES.filter(
  (role): role is Exclude<SystemRole, "platform_admin"> => role !== "platform_admin",
);
export type TenantSystemRole = (typeof TENANT_SYSTEM_ROLES)[number];

/**
 * Default permission sets, derived from brief §3 and documented in ARCHITECTURE §8. System roles
 * are immutable; tenants who need something else create a custom role.
 */
export const SYSTEM_ROLE_PERMISSIONS: Readonly<Record<SystemRole, readonly Permission[]>> = {
  platform_admin: ["platform.admin"],
  owner: TENANT_PERMISSIONS,
  project_manager: [
    "projects.view",
    "projects.manage",
    "bq.view",
    "bq.edit",
    "bq.import",
    "bq.approve_variation",
    "labour.view",
    "labour.manage",
    "labour.do_not_rehire",
    "labour.consent",
    "attendance.view",
    "attendance.override",
    "attendance.review_anomalies",
    "attendance.confirm",
    "timesheets.submit",
    "timesheets.approve",
    "timesheets.manage_rules",
    "payroll.view",
    "payroll.prepare",
    "payroll.review",
    "advances.request",
    "advances.approve",
    "payments.view",
    "procurement.requisition",
    "procurement.approve",
    "finance.view",
    "site.diary",
    "site.photos",
    "quality.manage",
    "safety.manage",
    "plant.manage",
    "documents.manage",
    "reports.view",
  ],
  site_agent: [
    "projects.view",
    "bq.view",
    "labour.view",
    "labour.consent",
    "attendance.view",
    "attendance.record",
    "attendance.confirm",
    "timesheets.submit",
    "advances.request",
    "procurement.requisition",
    "site.diary",
    "site.photos",
    "quality.manage",
    "safety.manage",
    "reports.view",
  ],
  foreman: [
    "projects.view",
    "labour.view",
    "labour.consent",
    "attendance.view",
    "attendance.record",
    "advances.request",
    "site.diary",
    "site.photos",
  ],
  quantity_surveyor: [
    "projects.view",
    "bq.view",
    "bq.edit",
    "bq.import",
    "finance.view",
    "documents.manage",
    "reports.view",
  ],
  storekeeper: ["projects.view", "procurement.requisition", "stores.manage"],
  finance: [
    "config.manage_statutory",
    "projects.view",
    "labour.view",
    "labour.view_sensitive",
    "attendance.view",
    "timesheets.approve",
    "payroll.view",
    "payroll.review",
    "payroll.manage_rules",
    "payroll.verify_rules",
    "payroll.export",
    "advances.approve",
    "payments.view",
    "payments.approve",
    "payments.disburse",
    "payments.record_cash",
    "payments.reverse",
    "finance.view",
    "finance.manage",
    "finance.view_sensitive",
    "reports.view",
  ],
  client: ["projects.view", "bq.view", "portal.client"],
  consultant: [
    "projects.view",
    "bq.view",
    "bq.approve_variation",
    "site.photos",
    "quality.manage",
    "documents.manage",
    "reports.view",
  ],
  supplier: ["projects.view", "portal.supplier"],
  // Labourers see only their own portal (assigned sites, later attendance and pay); never
  // project details such as contract sums, teams or diaries.
  labourer: ["portal.worker"],
};

/**
 * Roles whose permissions apply to every project in the company. Other roles act only on projects
 * they are assigned to, with effective permissions = role ∩ project assignment.
 */
export const TENANT_WIDE_SYSTEM_ROLES: readonly SystemRole[] = [
  "platform_admin",
  "owner",
  "finance",
];

/** Roles that must enrol TOTP or a passkey: those holding any MFA-required permission (brief §7). */
export const MFA_REQUIRED_ROLES: readonly SystemRole[] = SYSTEM_ROLES.filter((role) =>
  permissionsRequireMfa(SYSTEM_ROLE_PERMISSIONS[role]),
);
