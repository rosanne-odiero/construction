/**
 * Granular permission catalogue (ARCHITECTURE §8). Seeded into the `permissions` table in D1.4 and
 * checked by the API policy guard. Add new permissions here only, so web, site app and API agree.
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
