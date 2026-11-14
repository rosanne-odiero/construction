/**
 * Stores vocabulary (D5.3, brief §5.3 and §15 C/E/G; ARCHITECTURE §4.6; WORKFLOWS "Stores").
 * The database CHECK constraints and triggers in migration `20261118090000_stores` list the same
 * values.
 */

/**
 * Kinds of stock ledger entry. Quantities are signed and in the material's base unit: receipts,
 * returns and transfers in add stock; issues, transfers out and wastage remove it; adjustments
 * (from approved stock takes) go either way. A correction is an entry of the same kind with the
 * opposite sign that names the entry it reverses.
 */
export const STOCK_ENTRY_KINDS = [
  "receipt",
  "issue",
  "return",
  "transfer_out",
  "transfer_in",
  "wastage",
  "adjustment",
] as const;
export type StockEntryKind = (typeof STOCK_ENTRY_KINDS)[number];

/** Store documents that move stock out of (issue, wastage) or back into (return) one store. */
export const STOCK_MOVEMENT_KINDS = ["issue", "return", "wastage"] as const;
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];
/** A movement is posted once; a mistaken one is reversed with a reason (never edited). */
export const STOCK_MOVEMENT_STATUSES = ["posted", "reversed"] as const;
export type StockMovementStatus = (typeof STOCK_MOVEMENT_STATUSES)[number];

export const WASTAGE_REASONS = [
  "damaged",
  "expired",
  "spilled",
  "weather",
  "theft_suspected",
  "other",
] as const;
export type WastageReason = (typeof WASTAGE_REASONS)[number];

/**
 * Inter-site transfers: dispatched (stock left the source store and is in transit) → received
 * (everything arrived) or disputed (quantities differ; the shortfall is a transit loss) →
 * resolved (reviewed with a note); a dispatched transfer can be cancelled (the stock returns).
 */
export const TRANSFER_STATUSES = [
  "dispatched",
  "received",
  "disputed",
  "resolved",
  "cancelled",
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];
export const TRANSFER_ACTIONS = ["receive", "dispute", "resolve", "cancel"] as const;
export type TransferAction = (typeof TRANSFER_ACTIONS)[number];

/**
 * Stock takes: draft (counting) → submitted → approved (adjustments posted) by someone who did
 * not count; submitted → draft (returned with a reason for a recount); draft or submitted →
 * cancelled with a reason.
 */
export const STOCK_TAKE_STATUSES = ["draft", "submitted", "approved", "cancelled"] as const;
export type StockTakeStatus = (typeof STOCK_TAKE_STATUSES)[number];
export const STOCK_TAKE_ACTIONS = ["submit", "approve", "return", "cancel"] as const;
export type StockTakeAction = (typeof STOCK_TAKE_ACTIONS)[number];

export const STORE_SOURCES = ["web", "site_app"] as const;
export type StoreSource = (typeof STORE_SOURCES)[number];

/**
 * A consumption variance row's state (an estimate, never proof of theft; brief §15 G):
 * - `alert`: actual (issued − returned) is above theoretical × (1 + threshold);
 * - `within`: at or below that limit;
 * - `no_measurement`: the BQ item has no progress measurement, so the variance is unavailable;
 * - `no_buildup`: the BQ item has no rate build-up linked;
 * - `not_mapped`: a material line of the build-up is not mapped to a catalogue material;
 * - `not_in_buildup`: material issued to the item that its build-up does not use (mapped);
 * - `no_progress`: measured quantity is zero, so theoretical is zero and a percentage is undefined.
 */
export const VARIANCE_STATES = [
  "alert",
  "within",
  "no_measurement",
  "no_buildup",
  "not_mapped",
  "not_in_buildup",
  "no_progress",
] as const;
export type VarianceState = (typeof VARIANCE_STATES)[number];

/** Progress measurements (D5.3 minimal form; D6.3 adds submission and approval). */
export const MEASUREMENT_STATUSES = ["recorded"] as const;
export type MeasurementStatus = (typeof MEASUREMENT_STATUSES)[number];

/** `stores.consumption_variance_percent` default (CONFIGURATION §5). */
export const DEFAULT_CONSUMPTION_VARIANCE_PERCENT = "10";

export const STORES_LIMITS = {
  linesPerDocument: 50,
  /** Lines on one stock-take count sheet. */
  stockTakeLines: 300,
  /** Counts in one batch (offline sync of a count sheet). */
  countsPerBatch: 300,
  /** Threshold 0–1000 % with up to four decimals. */
  maxVariancePercent: 1000,
  pageSize: 50,
  /** Ledger quantities and costs are stored with six decimal places. */
  quantityDecimals: 6,
} as const;
