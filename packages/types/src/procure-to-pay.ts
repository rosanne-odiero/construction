/**
 * Procure-to-pay vocabulary (D5.2, brief §5.3 and §15 C/D/G; WORKFLOWS "Procurement and
 * certification"; ARCHITECTURE §4.5). The database CHECK constraints and triggers in migration
 * `20261115100000_procure_to_pay` list the same values.
 */

/** Requisition lifecycle; `order`/`unorder` are system transitions driven by the LPO. */
export const REQUISITION_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "ordered",
  "cancelled",
] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];
export const REQUISITION_ACTIONS = [
  "submit",
  "approve",
  "reject",
  "reopen",
  "cancel",
  "order",
  "unorder",
] as const;
export type RequisitionAction = (typeof REQUISITION_ACTIONS)[number];

/** An RFQ collects quotations until it is awarded (an LPO exists) or cancelled. */
export const RFQ_STATUSES = ["open", "awarded", "cancelled"] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];
export const RFQ_ACTIONS = ["award", "reopen", "cancel"] as const;
export type RfqAction = (typeof RFQ_ACTIONS)[number];

/** Single-source (fewer than the minimum quotes) exception on an RFQ. */
export const RFQ_EXCEPTION_STATUSES = ["none", "requested", "approved"] as const;
export type RfqExceptionStatus = (typeof RFQ_EXCEPTION_STATUSES)[number];

export const QUOTATION_STATUSES = ["received", "withdrawn"] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];
export const QUOTATION_LINE_STATUSES = ["quoted", "no_bid"] as const;
export type QuotationLineStatus = (typeof QUOTATION_LINE_STATUSES)[number];

/** LPO lifecycle. Approved LPOs never change; an amendment is a cancellation and a reissue. */
export const LPO_STATUSES = ["draft", "submitted", "approved", "cancelled"] as const;
export type LpoStatus = (typeof LPO_STATUSES)[number];
export const LPO_ACTIONS = ["submit", "approve", "return", "cancel"] as const;
export type LpoAction = (typeof LPO_ACTIONS)[number];

/** Delivery progress of an approved LPO, derived from its recorded GRNs (never stored). */
export const LPO_DELIVERY_STATES = ["none", "partial", "complete", "over"] as const;
export type LpoDeliveryState = (typeof LPO_DELIVERY_STATES)[number];

/** Goods Received Notes are append-only evidence; a mistaken one is voided with a reason. */
export const GRN_STATUSES = ["recorded", "voided"] as const;
export type GrnStatus = (typeof GRN_STATUSES)[number];
/** Where the device said it was, against the site geofence in force (a review signal only). */
export const GRN_LOCATION_STATES = ["inside", "outside", "no_fix", "no_geofence"] as const;
export type GrnLocationState = (typeof GRN_LOCATION_STATES)[number];
export const GRN_SOURCES = ["web", "site_app"] as const;
export type GrnSource = (typeof GRN_SOURCES)[number];
/** Why the browser or device had no position (shown on the GRN, never a refusal). */
export const LOCATION_ERRORS = ["denied", "unavailable", "timeout", "unsupported"] as const;
export type LocationError = (typeof LOCATION_ERRORS)[number];
export const VEHICLE_REG_FORMATS = ["kenyan", "other"] as const;
export type VehicleRegFormat = (typeof VEHICLE_REG_FORMATS)[number];

/**
 * Supplier invoice lifecycle (WORKFLOWS). `submitted` is transient: submission runs the
 * three-way match in the same transaction, which moves the invoice to `matched` or `disputed`.
 */
export const INVOICE_STATUSES = [
  "draft",
  "submitted",
  "matched",
  "disputed",
  "approved",
  "partly_settled",
  "settled",
  "cancelled",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const INVOICE_ACTIONS = [
  "submit",
  "match",
  "dispute",
  "except",
  "reopen",
  "approve",
  "settle_part",
  "settle",
  "cancel",
] as const;
export type InvoiceAction = (typeof INVOICE_ACTIONS)[number];

/** How the KRA eTIMS number on an invoice looks (format only; never verified with KRA). */
export const ETIMS_NUMBER_FORMATS = ["etims", "unrecognised"] as const;
export type EtimsNumberFormat = (typeof ETIMS_NUMBER_FORMATS)[number];

export const MATCH_OUTCOMES = ["matched", "mismatch"] as const;
export type MatchOutcome = (typeof MATCH_OUTCOMES)[number];

/** Per-line reasons a three-way match fails. */
export const MATCH_LINE_REASONS = [
  "not-received",
  "qty-exceeds-received",
  "qty-exceeds-ordered",
  "price-above-order",
  "line-not-on-order",
] as const;
export type MatchLineReason = (typeof MATCH_LINE_REASONS)[number];

/** Invoice-level reasons a three-way match fails. */
export const MATCH_HEADER_REASONS = [
  "invoice-empty",
  "total-arithmetic",
  "subtotal-mismatch",
  "vat-mismatch",
  "total-exceeds-order",
  "etims-missing",
] as const;
export type MatchHeaderReason = (typeof MATCH_HEADER_REASONS)[number];
export type MatchReason = MatchLineReason | MatchHeaderReason;

/** Reasons an approved exception may never override (fix the invoice or the setting instead). */
export const MATCH_REASONS_NOT_EXCEPTABLE = [
  "etims-missing",
  "total-arithmetic",
  "invoice-empty",
  "line-not-on-order",
] as const satisfies readonly MatchReason[];

/** Signals shown with a match that never block it. */
export const MATCH_WARNINGS = [
  "etims-missing",
  "etims-format-unrecognised",
  "price-below-order",
] as const;
export type MatchWarning = (typeof MATCH_WARNINGS)[number];

/** Why a stored match no longer describes the invoice (it must be run again). */
export const MATCH_STALE_REASONS = [
  "invoice-changed",
  "grns-changed",
  "invoices-changed",
  "settings-changed",
] as const;
export type MatchStaleReason = (typeof MATCH_STALE_REASONS)[number];

/** Settlements recorded by hand for payments made outside PM-Buddy (D4.2/D4.3 add B2B). */
export const SETTLEMENT_METHODS = ["bank_transfer", "cheque", "mpesa_b2b", "other"] as const;
export type SettlementMethod = (typeof SETTLEMENT_METHODS)[number];

export const PAYABLE_STATUSES = ["active", "superseded"] as const;
export type PayableStatus = (typeof PAYABLE_STATUSES)[number];

/** Files kept with procurement records (private bucket, malware hook, images or PDF). */
export const PROCUREMENT_DOCUMENT_KINDS = [
  "quotation",
  "delivery_note",
  "goods",
  "invoice",
] as const;
export type ProcurementDocumentKind = (typeof PROCUREMENT_DOCUMENT_KINDS)[number];
export const GRN_PHOTO_KINDS = ["delivery_note", "goods"] as const;
export type GrnPhotoKind = (typeof GRN_PHOTO_KINDS)[number];
export const PROCUREMENT_DOCUMENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;
export type ProcurementDocumentType = (typeof PROCUREMENT_DOCUMENT_TYPES)[number];

/** Items in the "waiting for me" inbox. */
export const INBOX_KINDS = [
  "requisition-approval",
  "rfq-exception",
  "lpo-approval",
  "invoice-exception",
  "invoice-approval",
  "invoice-reapproval",
  "invoice-settlement",
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/** `procurement.min_quotes` default (CONFIGURATION §5). */
export const DEFAULT_MIN_QUOTES = 3;
/** `procurement.three_way_match.qty_tolerance_pct` / `.price_tolerance_pct` defaults. */
export const DEFAULT_QTY_TOLERANCE_PERCENT = "0";
export const DEFAULT_PRICE_TOLERANCE_PERCENT = "0";
/** `procurement.block_payment_without_etims` default (CR-TAX-02). */
export const DEFAULT_BLOCK_PAYMENT_WITHOUT_ETIMS = true;

export const P2P_LIMITS = {
  linesPerDocument: 100,
  requisitionsPerRfq: 10,
  suppliersPerRfq: 10,
  maxMinQuotes: 10,
  /** Tolerances are 0–100 % with up to four decimals. */
  maxTolerancePercent: 100,
  photosPerGrn: 10,
  imageMaxBytes: 5 * 1024 * 1024,
  documentMaxBytes: 10 * 1024 * 1024,
  /** Uploads per user per hour. */
  uploadsPerHour: 120,
  /** Position fixes worse than this are flagged as low accuracy. */
  gpsMaxAccuracyM: 100,
  /** The geofence check allows the reported accuracy, at most this much. */
  gpsToleranceCapM: 50,
  pageSize: 50,
} as const;
