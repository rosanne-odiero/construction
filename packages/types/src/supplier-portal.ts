import type { Permission } from "./permissions.js";

/**
 * Supplier portal vocabulary (D7.2, brief §3 and §5.3; ARCHITECTURE §4.12). The database CHECK
 * constraints in migration `20261127090000_supplier_portal` list the same values.
 */

/**
 * A supplier contact's access: invited (an invitation is pending), active (bound to exactly one
 * supplier of the company) or revoked (kept as history; never reactivated, invite again instead).
 */
export const SUPPLIER_PORTAL_USER_STATUSES = ["invited", "active", "revoked"] as const;
export type SupplierPortalUserStatus = (typeof SUPPLIER_PORTAL_USER_STATUSES)[number];

/** Why access ended: revoked by company staff, or the membership was removed or changed role. */
export const SUPPLIER_PORTAL_REVOKE_CAUSES = ["revoked", "membership_ended"] as const;
export type SupplierPortalRevokeCause = (typeof SUPPLIER_PORTAL_REVOKE_CAUSES)[number];

/** Who put an invoice into the procure-to-pay workflow: company staff or the supplier. */
export const INVOICE_SOURCES = ["company", "supplier_portal"] as const;
export type InvoiceSource = (typeof INVOICE_SOURCES)[number];

/**
 * The status a supplier sees for an invoice (packages/domain `supplierInvoiceStatus`): the
 * contractor's internal states, said the way a supplier needs them. "Paid" is what the company
 * recorded; the portal never confirms a payment (brief §15 D).
 */
export const SUPPLIER_INVOICE_STATUSES = [
  "submitted",
  "under_review",
  "disputed",
  "approved",
  "partly_paid",
  "paid",
  "cancelled",
] as const;
export type SupplierInvoiceStatus = (typeof SUPPLIER_INVOICE_STATUSES)[number];

/** Lines of a supplier statement. */
export const STATEMENT_ENTRY_KINDS = ["invoice", "payment"] as const;
export type StatementEntryKind = (typeof STATEMENT_ENTRY_KINDS)[number];

/**
 * Company staff who invite, list and revoke a supplier's portal users: procurement (company-level)
 * or company-wide finance (`finance.manage` is project-scoped, so a company-wide role is needed).
 */
export const SUPPLIER_PORTAL_MANAGE_PERMISSIONS = [
  "procurement.manage_suppliers",
  "finance.manage",
] as const satisfies readonly Permission[];

export const SUPPLIER_PORTAL_LIMITS = {
  /** Invoice submissions per portal user per hour (replays count too). */
  submissionsPerHour: 30,
  /** Documents a supplier may attach to one invoice. */
  documentsPerInvoice: 3,
  /** Invitations per staff member per hour. */
  invitationsPerHour: 20,
  /** Statement exports per user per ten minutes. */
  exportsPerTenMinutes: 30,
  /** A statement covers at most this many days. */
  statementMaxDays: 1_096,
  /** The default statement period when none is asked for (today and the 89 days before). */
  statementDefaultDays: 90,
  /** Lines in a statement PDF (Excel has no limit). */
  statementPdfMaxEntries: 5_000,
  pageSize: 50,
} as const;
