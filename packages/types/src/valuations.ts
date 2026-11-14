import type { BqItemKind } from "./bq.js";
import type { Permission } from "./permissions.js";

/**
 * Measurement, interim valuations, payment certificates, retention and earned value (D6.3 part A;
 * brief §5.2 and §15 C/G; ARCHITECTURE §4.10; WORKFLOWS "Measurements" and "Valuations"). The
 * database CHECK constraints and triggers in migration `20261125090000_valuations` list the same
 * values.
 */

/**
 * How a BQ item is measured. `quantity`: the quantity done to date in the item's unit, valued at
 * quantity × rate. `percent`: a lump sum (no quantity) measured as percent complete, valued at
 * that share of its amount. Items without a basis are not measured (see NOT_MEASURED_ITEM_KINDS).
 */
export const MEASUREMENT_BASES = ["quantity", "percent"] as const;
export type MeasurementBasis = (typeof MEASUREMENT_BASES)[number];

/**
 * Provisional sums, PC sums (with their attendance and profit lines) and contingencies are never
 * measured: they are expended through variations (D2.3), which put measured or fixed items into
 * the BQ in force. Dayworks and preliminaries are measured like any other item.
 */
export const NOT_MEASURED_ITEM_KINDS = [
  "provisional_sum",
  "pc_sum",
  "pc_attendance",
  "pc_profit",
  "contingency",
] as const satisfies readonly BqItemKind[];

/**
 * Where a measurement stands (derived from its review and its corrections, never stored):
 * - `pending`: recorded (recording is the submission), waiting for an independent review;
 * - `approved`: counts towards value of work done, earned value and valuations;
 * - `rejected`: reviewed and refused (with a reason); never counts;
 * - `withdrawn`: corrected before anyone reviewed it; never counts;
 * - `superseded`: approved, then replaced by an approved correction; no longer counts.
 */
export const MEASUREMENT_STATES = [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
  "superseded",
] as const;
export type MeasurementState = (typeof MEASUREMENT_STATES)[number];

export const MEASUREMENT_DECISIONS = ["approved", "rejected"] as const;
export type MeasurementDecision = (typeof MEASUREMENT_DECISIONS)[number];

/**
 * Valuations and their certificates (WORKFLOWS "Valuations"): draft → submitted → certified
 * (finance.manage + step-up, never a contributor, on the digest seen); submitted → draft when
 * returned (reason); draft or submitted → cancelled (reason). A certified certificate never
 * changes and is never cancelled: the next certificate corrects it (amounts are cumulative).
 */
export const VALUATION_STATUSES = ["draft", "submitted", "certified", "cancelled"] as const;
export type ValuationStatus = (typeof VALUATION_STATUSES)[number];
export const VALUATION_ACTIONS = ["submit", "certify", "return", "cancel"] as const;
export type ValuationAction = (typeof VALUATION_ACTIONS)[number];

/** An interim valuation, or a retention release at practical or final completion. */
export const VALUATION_KINDS = ["interim", "retention_release"] as const;
export type ValuationKind = (typeof VALUATION_KINDS)[number];
export const RELEASE_STAGES = ["practical", "final"] as const;
export type ReleaseStage = (typeof RELEASE_STAGES)[number];
/** How much of the retention is still held: all of it, the part left after practical, none. */
export const RETENTION_STAGES = ["none", "practical", "final"] as const;
export type RetentionStage = (typeof RETENTION_STAGES)[number];

/** Lines frozen on a submitted certificate. */
export const VALUATION_LINE_KINDS = ["item", "materials", "adjustment"] as const;
export type ValuationLineKind = (typeof VALUATION_LINE_KINDS)[number];

/** Materials on site: on hand in the project's stores at cost, or entered against a BQ item. */
export const MATERIALS_SOURCES = ["stores", "manual"] as const;
export type MaterialsSource = (typeof MATERIALS_SOURCES)[number];

/**
 * Agreed adjustments on a certificate (signed KES): an advance paid to the contractor (+), its
 * recovery (−, never more than the advances certified), a contra charge (−) or another agreed
 * adjustment (±). All are COMPLIANCE-REVIEW CR-VAL-02.
 */
export const ADJUSTMENT_KINDS = ["advance", "advance_recovery", "contra_charge", "other"] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

/** The valuation rule implemented in packages/domain and repeated by the database. */
export const VALUATION_RULE_VERSION = "KE-VAL-1";

/**
 * Project contract settings (CONFIGURATION "Valuations"); no row = these defaults. Retention 10 %
 * of the gross valuation up to a limit of 5 % of the original contract sum, half released at
 * practical completion and the rest at final completion; VAT 16 % shown on top of the certified
 * (net) amount; materials on site at 100 % of cost. All COMPLIANCE-REVIEW CR-VAL-01–04.
 */
export const DEFAULT_CONTRACT_SETTINGS = {
  retentionPercent: "10",
  retentionCapPercent: "5",
  vatPercent: "16",
  materialsPercent: "100",
  practicalReleasePercent: "50",
} as const;

/** Allowed ranges of the contract settings (the database CHECK repeats them). */
export const CONTRACT_SETTINGS_LIMITS = {
  retentionPercent: { min: 0, max: 20 },
  retentionCapPercent: { min: 0, max: 100 },
  vatPercent: { min: 0, max: 30 },
  materialsPercent: { min: 0, max: 100 },
  practicalReleasePercent: { min: 0, max: 100 },
} as const;

export const VALUATION_LIMITS = {
  photosPerMeasurement: 6,
  materialsPerValuation: 100,
  adjustmentsPerValuation: 50,
  /** Items valued on one certificate (the BQ in force). */
  itemsPerValuation: 5_000,
  /** Weeks drawn by the S-curve (the most recent ones when the project is longer). */
  sCurveMaxWeeks: 260,
  /** Pending measurements listed in the approval queue. */
  queueSize: 200,
  /** Measurements listed for an item or a project page. */
  listSize: 200,
} as const;

/**
 * Who may read measurements on a project: the people who record and approve them, the stores
 * readers (consumption variance) and finance. `bq.view` alone (client, consultant) is not enough:
 * measurements are the contractor's working records until a deliberate portal view (D7.1).
 */
export const MEASUREMENT_READ_PERMISSIONS = [
  "bq.edit",
  "site.diary",
  "projects.manage",
  "stores.manage",
  "procurement.requisition",
  "procurement.approve",
  "finance.view",
  "finance.manage",
] as const satisfies readonly Permission[];

/** Who records a measurement (site agent and foreman through `site.diary`; QS and PM `bq.edit`). */
export const MEASUREMENT_RECORD_PERMISSIONS = [
  "bq.edit",
  "site.diary",
] as const satisfies readonly Permission[];

/** Who approves or rejects a measurement: `bq.edit` (QS, PM, owner), never its measurer. */
export const MEASUREMENT_APPROVE_PERMISSIONS = ["bq.edit"] as const satisfies readonly Permission[];

/** Who reads valuations and certificates: the QS (`bq.edit`) and finance. */
export const VALUATION_READ_PERMISSIONS = [
  "bq.edit",
  "finance.view",
  "finance.manage",
] as const satisfies readonly Permission[];

/** Who prepares a valuation (draft, materials, adjustments, submit, cancel). */
export const VALUATION_PREPARE_PERMISSIONS = ["bq.edit"] as const satisfies readonly Permission[];

/** Who certifies (step-up, never a contributor) or returns a submitted valuation. */
export const VALUATION_CERTIFY_PERMISSIONS = [
  "finance.manage",
] as const satisfies readonly Permission[];

/** Who changes a project's retention, VAT and materials-on-site settings. */
export const CONTRACT_SETTINGS_PERMISSIONS = [
  "finance.manage",
] as const satisfies readonly Permission[];

/** Who reads earned value and cost to complete (they show the cost ledger: finance readers). */
export const EARNED_VALUE_READ_PERMISSIONS = [
  "finance.view",
  "finance.manage",
] as const satisfies readonly Permission[];

/** How an item's estimate to complete was worked out (see packages/domain costToComplete). */
export const ETC_BASES = ["cpi", "budget", "unavailable"] as const;
export type EtcBasis = (typeof ETC_BASES)[number];
