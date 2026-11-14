import type { Permission } from "./permissions.js";

/**
 * Client portal vocabulary (D7.1, brief §3, §5.7 and §5.10; ARCHITECTURE §4.15). The database
 * CHECK constraints in migration `20261130090000_client_portal` list the same values.
 */

/** Currencies a client may display amounts in. KES is the ledger currency (never converted). */
export const DISPLAY_CURRENCIES = ["KES", "USD", "GBP", "EUR"] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

/** Foreign currencies with indicative rates entered by finance (no external FX feed). */
export const FX_CURRENCIES = ["USD", "GBP", "EUR"] as const;
export type FxCurrency = (typeof FX_CURRENCIES)[number];

/** How the company recorded money received from the client against a certificate. */
export const CLIENT_PAYMENT_METHODS = ["mpesa_paybill", "bank", "cheque", "cash"] as const;
export type ClientPaymentMethod = (typeof CLIENT_PAYMENT_METHODS)[number];

/** A receipt, or the entry that reverses one in full (append-only; never edited or deleted). */
export const CLIENT_PAYMENT_KINDS = ["receipt", "reversal"] as const;
export type ClientPaymentKind = (typeof CLIENT_PAYMENT_KINDS)[number];

/**
 * Where a certified certificate stands for the client (packages/domain `certificateBalances`):
 * nothing recorded, part recorded, or fully settled by recorded receipts (and credits); `credit`
 * is a certificate with a negative total (a correction), which reduces what is owed on the oldest
 * certificates. "Paid" only ever means receipts recorded by the company (brief §15 D); overdue is
 * shown separately.
 */
/**
 * A certificate's payment state: `paid` only when recorded receipts cover its total; `nothing_due`
 * when nothing is outstanding but receipts do not cover it (a zero certificate, or one covered by a
 * later negative certificate's credit) — never shown as paid without a receipt (brief §15 D).
 */
export const CLIENT_CERTIFICATE_STATES = [
  "unpaid",
  "part_paid",
  "paid",
  "nothing_due",
  "credit",
] as const;
export type ClientCertificateState = (typeof CLIENT_CERTIFICATE_STATES)[number];

/** Lines of a client statement. */
export const CLIENT_STATEMENT_ENTRY_KINDS = ["certificate", "receipt", "reversal"] as const;
export type ClientStatementEntryKind = (typeof CLIENT_STATEMENT_ENTRY_KINDS)[number];

/**
 * The M-Pesa Paybill account reference a client types: the project code and the certificate's
 * number (`RUI-HTS-0002`), or the project code alone (finance allocates the receipt).
 */
export const PAYBILL_ACCOUNT_FORMATS = ["project_certificate", "project"] as const;
export type PaybillAccountFormat = (typeof PAYBILL_ACCOUNT_FORMATS)[number];

/** A client's decision on a variation sent to them. */
export const CLIENT_DECISIONS = ["approved", "rejected"] as const;
export type ClientDecision = (typeof CLIENT_DECISIONS)[number];

/**
 * A variation sending as the client sees it (packages/domain `clientRequestState`): waiting for
 * their decision, decided by them, or withdrawn (the contractor changed, rebased, cancelled or
 * decided the variation before the client answered).
 */
export const CLIENT_REQUEST_STATES = [
  "awaiting_decision",
  "approved",
  "rejected",
  "withdrawn",
] as const;
export type ClientRequestState = (typeof CLIENT_REQUEST_STATES)[number];

/**
 * An STK Push payment request (the `ClientPaymentRequests` boundary, D-135). Only a reconciled
 * provider callback makes a request `confirmed`; `unknown` is an outcome that must be reconciled
 * before anything else is tried. Disabled until the Daraja integration (D4.2) is on main.
 */
export const CLIENT_PAYMENT_REQUEST_STATES = [
  "created",
  "submitting",
  "pending",
  "unknown",
  "confirmed",
  "failed",
  "cancelled",
] as const;
export type ClientPaymentRequestState = (typeof CLIENT_PAYMENT_REQUEST_STATES)[number];

/** Whether Pay with M-Pesa (STK Push) is offered. False until D4.2 provides a provider. */
export const STK_PUSH_AVAILABLE = false as const;

/** Who records and reverses client receipts (company-wide finance holds it on every project). */
export const CLIENT_PAYMENT_RECORD_PERMISSIONS = [
  "finance.manage",
] as const satisfies readonly Permission[];

/** Who reads client receipts and statements on a project (the valuation readers). */
export const CLIENT_PAYMENT_READ_PERMISSIONS = [
  "bq.edit",
  "finance.view",
  "finance.manage",
] as const satisfies readonly Permission[];

/** Who sends a submitted variation to the client (the people who prepare variations). */
export const CLIENT_SEND_VARIATION_PERMISSIONS = [
  "bq.edit",
] as const satisfies readonly Permission[];

/** Who reads a variation's client sendings and decisions (anyone who reads the variation). */
export const CLIENT_REQUEST_READ_PERMISSIONS = ["bq.view"] as const satisfies readonly Permission[];

/** Who changes a project's client terms (client approval of variations, payment period). */
export const CLIENT_SETTINGS_PERMISSIONS = [
  "projects.manage",
] as const satisfies readonly Permission[];

/** Who maintains the company's Paybill instructions (company configuration). */
export const PAYMENT_INSTRUCTIONS_PERMISSIONS = [
  "config.manage",
] as const satisfies readonly Permission[];

/** Who enters indicative FX rates (company-wide finance, or company configuration). */
export const FX_RATE_PERMISSIONS = [
  "finance.manage",
  "config.manage",
] as const satisfies readonly Permission[];

/**
 * A project's client terms when no version was saved (CONFIGURATION "Client portal"): variations
 * do not wait for the client, and a certificate is due 14 days after certification
 * (COMPLIANCE-REVIEW CR-CLI-03: the contract's payment period applies).
 */
export const DEFAULT_CLIENT_SETTINGS = {
  clientApprovalRequired: false,
  paymentTermsDays: 14,
} as const;

export const CLIENT_PORTAL_LIMITS = {
  /** A certificate's payment period in days (the database CHECK repeats it). */
  paymentTermsDays: { min: 0, max: 120 },
  /** KES per unit of a foreign currency, with at most four decimal places. */
  fxRate: { min: 1, max: 10_000, scale: 4 },
  /** A rate older than this (days, Nairobi dates) is not shown: conversions say "not available". */
  fxMaxAgeDays: 31,
  /** Rates listed for finance. */
  fxRatesListed: 60,
  photoPageSize: 24,
  photoMaxPageSize: 48,
  diaryPageSize: 20,
  /** Receipts (and their reversals) recorded against one certificate. */
  paymentsPerCertificate: 200,
  /** Statement exports per user per ten minutes, and the PDF's line limit (Excel has none). */
  exportsPerTenMinutes: 30,
  statementPdfMaxEntries: 5_000,
  /** Variation decisions per client per hour; STK Push requests per client per hour. */
  decisionsPerHour: 30,
  paymentRequestsPerHour: 10,
  commentMax: 1_000,
  messageMax: 1_000,
  referenceMax: 60,
  noteMax: 500,
} as const;
