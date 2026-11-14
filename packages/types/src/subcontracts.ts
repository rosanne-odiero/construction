import type { Permission } from "./permissions.js";

/**
 * Subcontracts, subcontract payment certificates, advances to subcontractors and piece-rate jobs
 * (D6.3 part B; brief §5.14 and §15 C/G; ARCHITECTURE §4.16; WORKFLOWS "Subcontracts",
 * "Subcontract certificates", "Subcontract advances" and "Piece-rate jobs"). The database CHECK
 * constraints and triggers in migration `20261201090000_subcontracts` list the same values.
 *
 * A subcontractor is a D5.1 supplier flagged `isSubcontractor` (decision D-140): KRA PIN, eTIMS,
 * contacts and maker-checked payout details are the supplier's.
 */

/** Labour-only (the contractor supplies the materials) or supply-and-fix (materials included). */
export const SUBCONTRACT_KINDS = ["labour_only", "supply_and_fix"] as const;
export type SubcontractKind = (typeof SUBCONTRACT_KINDS)[number];

/**
 * draft → submitted (frozen with a digest) → approved (procurement.approve + step-up, never a
 * contributor, on the digest seen) → active (work started) → completed | terminated (reason);
 * submitted → draft (returned, reason); draft | submitted → cancelled (reason); approved →
 * terminated (reason) before work starts. Completed, terminated and cancelled are final.
 */
export const SUBCONTRACT_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "active",
  "completed",
  "terminated",
  "cancelled",
] as const;
export type SubcontractStatus = (typeof SUBCONTRACT_STATUSES)[number];
export const SUBCONTRACT_ACTIONS = [
  "submit",
  "approve",
  "return",
  "activate",
  "complete",
  "terminate",
  "cancel",
] as const;
export type SubcontractAction = (typeof SUBCONTRACT_ACTIONS)[number];

/** Statuses whose lines are committed (they count against the BQ quantity and the budget). */
export const SUBCONTRACT_LIVE_STATUSES = [
  "approved",
  "active",
  "completed",
  "terminated",
] as const satisfies readonly SubcontractStatus[];

/** How a subcontract line is measured: the BQ item's basis (quantity, or percent of a lump sum). */
export const SUBCONTRACT_LINE_BASES = ["quantity", "percent"] as const;
export type SubcontractLineBasis = (typeof SUBCONTRACT_LINE_BASES)[number];

/**
 * VAT on a line's work (COMPLIANCE-REVIEW CR-SCN-02): standard-rated at the subcontract's VAT %,
 * zero-rated or exempt (no VAT, e.g. a subcontractor who is not VAT-registered).
 */
export const SUBCONTRACT_VAT_TREATMENTS = ["standard", "zero_rated", "exempt"] as const;
export type SubcontractVatTreatment = (typeof SUBCONTRACT_VAT_TREATMENTS)[number];

/** Variations are append-only: pending → approved | rejected (reason). */
export const SUBCONTRACT_VARIATION_STATUSES = ["pending", "approved", "rejected"] as const;
export type SubcontractVariationStatus = (typeof SUBCONTRACT_VARIATION_STATUSES)[number];
/** A variation adds a line (a BQ item not yet on the subcontract) or adjusts a line's quantity. */
export const SUBCONTRACT_VARIATION_ACTIONS = ["add", "adjust"] as const;
export type SubcontractVariationAction = (typeof SUBCONTRACT_VARIATION_ACTIONS)[number];

/**
 * Subcontract payment certificates (WORKFLOWS "Subcontract certificates"): draft → submitted
 * (lines and figures frozen with a digest) → certified (finance.manage + step-up, never a
 * contributor, on the digest seen; numbered SCC-NNNN per subcontract; never changes again);
 * submitted → draft (returned, reason); draft | submitted → cancelled (reason).
 */
export const SUBCONTRACT_CERTIFICATE_STATUSES = [
  "draft",
  "submitted",
  "certified",
  "cancelled",
] as const;
export type SubcontractCertificateStatus = (typeof SUBCONTRACT_CERTIFICATE_STATUSES)[number];
export const SUBCONTRACT_CERTIFICATE_ACTIONS = ["submit", "certify", "return", "cancel"] as const;
export type SubcontractCertificateAction = (typeof SUBCONTRACT_CERTIFICATE_ACTIONS)[number];
export const SUBCONTRACT_CERTIFICATE_KINDS = ["interim", "retention_release"] as const;
export type SubcontractCertificateKind = (typeof SUBCONTRACT_CERTIFICATE_KINDS)[number];

/**
 * Advances to a subcontractor (maker-checker, paid outside PM-Buddy, recovered by certificates):
 * requested → approved (payments.approve + step-up, not the requester) → paid (recorded with
 * payments.disburse + step-up, neither the requester nor the approver); requested → rejected
 * (reason); requested | approved → cancelled (reason). Paid is final.
 */
export const SUBCONTRACT_ADVANCE_STATUSES = [
  "requested",
  "approved",
  "paid",
  "rejected",
  "cancelled",
] as const;
export type SubcontractAdvanceStatus = (typeof SUBCONTRACT_ADVANCE_STATUSES)[number];

/** How a payment made outside PM-Buddy was made (M-Pesa B2B payouts are D4.3, not on main). */
export const SUBCONTRACT_PAYMENT_METHODS = [
  "bank_transfer",
  "cheque",
  "mpesa",
  "cash",
  "other",
] as const;
export type SubcontractPaymentMethod = (typeof SUBCONTRACT_PAYMENT_METHODS)[number];

/** The subcontract certificate rule implemented in packages/domain and repeated by the database. */
export const SUBCONTRACT_RULE_VERSION = "KE-SUB-1";

/**
 * Terms a new subcontract starts with (COMPLIANCE-REVIEW CR-SCN-01–05): retention 5 % limited to
 * 5 % of the original subcontract value, half released at practical completion; VAT 16 % on
 * standard-rated lines; no withholding tax until an accountant configures it (CR-SCN-01); no
 * advance; payment 30 days after certification.
 */
export const DEFAULT_SUBCONTRACT_TERMS = {
  retentionPercent: "5",
  retentionLimitPercent: "5",
  practicalReleasePercent: "50",
  vatPercent: "16",
  whtPercent: "0",
  advanceLimitMinor: 0,
  advanceRecoveryPercent: "0",
  paymentTermsDays: 30,
} as const;

/** Allowed ranges of the terms (the database CHECK repeats them). */
export const SUBCONTRACT_TERM_LIMITS = {
  retentionPercent: { min: 0, max: 20 },
  retentionLimitPercent: { min: 0, max: 100 },
  practicalReleasePercent: { min: 0, max: 100 },
  vatPercent: { min: 0, max: 30 },
  whtPercent: { min: 0, max: 20 },
  advanceRecoveryPercent: { min: 0, max: 100 },
  paymentTermsDays: { min: 0, max: 365 },
} as const;

export const SUBCONTRACT_LIMITS = {
  linesPerSubcontract: 500,
  changesPerVariation: 100,
  /** Subcontracts listed for a project (newest first). */
  listSize: 200,
  /** Certificates, advances, payments and variations listed for one subcontract. */
  historySize: 200,
  /** PDFs above this many lines are refused (Excel has no such limit). */
  pdfMaxLines: 2_000,
} as const;

/**
 * Who reads a project's subcontracts, certificates, advances and statements: the people who let
 * and value them (`bq.edit`, `procurement.approve`) and finance. Clients, consultants, site agents
 * and suppliers (including a subcontractor's own portal users) hold none of these.
 */
export const SUBCONTRACT_READ_PERMISSIONS = [
  "bq.edit",
  "procurement.approve",
  "finance.view",
  "finance.manage",
] as const satisfies readonly Permission[];

/** Who prepares a subcontract, its lines and variations, and its certificates. */
export const SUBCONTRACT_PREPARE_PERMISSIONS = ["bq.edit"] as const satisfies readonly Permission[];

/**
 * Who approves a subcontract or a variation (a commitment, like an LPO): procurement.approve with
 * step-up, never a contributor; also activates, completes and terminates.
 */
export const SUBCONTRACT_APPROVE_PERMISSIONS = [
  "procurement.approve",
] as const satisfies readonly Permission[];

/** Who certifies (step-up, never a contributor) or returns a submitted subcontract certificate. */
export const SUBCONTRACT_CERTIFY_PERMISSIONS = [
  "finance.manage",
] as const satisfies readonly Permission[];

/** Who asks for an advance to a subcontractor. */
export const SUBCONTRACT_ADVANCE_REQUEST_PERMISSIONS = [
  "bq.edit",
  "finance.manage",
] as const satisfies readonly Permission[];

/** Who approves an advance (step-up, not the requester). */
export const SUBCONTRACT_ADVANCE_APPROVE_PERMISSIONS = [
  "payments.approve",
] as const satisfies readonly Permission[];

/**
 * Who records a payment made outside PM-Buddy (an advance or a certificate; step-up; never the
 * requester or approver of the advance, never the certifier of the certificate).
 */
export const SUBCONTRACT_PAY_PERMISSIONS = [
  "payments.disburse",
] as const satisfies readonly Permission[];

/** Who matches a subcontractor's tax invoice to a certified certificate. */
export const SUBCONTRACT_INVOICE_PERMISSIONS = [
  "finance.manage",
] as const satisfies readonly Permission[];

// Piece-rate jobs ----------------------------------------------------------------------------------

/**
 * A piece-rate job: the agreed rate and scope against a BQ item for a gang or a labourer.
 * pending → approved (timesheets.approve, not the creator) | rejected (reason); approved → closed
 * (no more output). Outputs recorded against a job take its rate.
 */
export const PIECE_RATE_JOB_STATUSES = ["pending", "approved", "rejected", "closed"] as const;
export type PieceRateJobStatus = (typeof PIECE_RATE_JOB_STATUSES)[number];
/** An extension of a job's agreed quantity: pending → approved | rejected (reason). */
export const PIECE_RATE_EXTENSION_STATUSES = ["pending", "approved", "rejected"] as const;
export type PieceRateExtensionStatus = (typeof PIECE_RATE_EXTENSION_STATUSES)[number];

export const PIECE_RATE_LIMITS = {
  /** The largest rate per unit (KES 1,000,000.00 in minor units), as for D4.1 outputs. */
  maxRateMinor: 100_000_000,
  /** Jobs listed for a project. */
  listSize: 300,
  /** Outputs listed for one job. */
  outputsPerJob: 300,
} as const;

/** Who sees a project's piece-rate jobs (the D4.1 output readers). */
export const PIECE_RATE_READ_PERMISSIONS = [
  "payroll.view",
  "payroll.prepare",
  "attendance.record",
  "timesheets.approve",
] as const satisfies readonly Permission[];

/** Who creates a job, asks for an extension and closes a job. */
export const PIECE_RATE_JOB_PREPARE_PERMISSIONS = [
  "payroll.prepare",
  "labour.manage",
] as const satisfies readonly Permission[];

/** Who approves or rejects a job and an extension (never the person who asked). */
export const PIECE_RATE_JOB_APPROVE_PERMISSIONS = [
  "timesheets.approve",
] as const satisfies readonly Permission[];

/** Who records output against a job (the D4.1 output recorders). */
export const PIECE_RATE_OUTPUT_RECORD_PERMISSIONS = [
  "attendance.record",
  "payroll.prepare",
] as const satisfies readonly Permission[];

/**
 * Who reads the reconciliation of piece-rate quantities against measured quantities: the job
 * readers, the QS and finance.
 */
export const PIECE_RATE_RECONCILIATION_PERMISSIONS = [
  ...PIECE_RATE_READ_PERMISSIONS,
  "bq.edit",
  "finance.view",
  "finance.manage",
] as const satisfies readonly Permission[];

/**
 * Reconciliation flags per BQ item (brief §15 G: review signals, never automatic pay decisions):
 * - `piece-rate-above-measured`: approved piece-rate quantity (in the BQ unit) above the approved
 *   measured quantity (D6.3) — paying for work that was not measured;
 * - `combined-above-measured`: piece-rate plus subcontract-certified quantity above it;
 * - `not-measured`: piece-rate output approved on an item with no approved measurement;
 * - `unlinked-outputs`: approved outputs on the item recorded without a job (free rate).
 */
export const RECONCILIATION_FLAGS = [
  "piece-rate-above-measured",
  "combined-above-measured",
  "not-measured",
  "unlinked-outputs",
] as const;
export type ReconciliationFlag = (typeof RECONCILIATION_FLAGS)[number];
