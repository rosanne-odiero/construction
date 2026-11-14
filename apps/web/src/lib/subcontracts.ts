import type {
  PieceRateJobStatus,
  ReconciliationFlag,
  SubcontractAdvanceStatus,
  SubcontractCertificateStatus,
  SubcontractStatus,
  SubcontractVariationStatus,
} from "@pm-buddy/types";
import type { Tone } from "@/components/status-badge";

/**
 * Display and input helpers for subcontracts and piece-rate jobs (D6.3 part B). Money is integer
 * KES minor units; subcontract quantities are decimal strings with up to four places, piece-rate
 * output three. Input helpers trim what was typed with linear scans (never a backtracking regex on
 * user input) and return null instead of throwing.
 */

export const subcontractStatusTone: Record<SubcontractStatus, Tone> = {
  draft: "neutral",
  submitted: "info",
  approved: "info",
  active: "success",
  completed: "success",
  terminated: "warning",
  cancelled: "neutral",
};

export const certificateStatusTone: Record<SubcontractCertificateStatus, Tone> = {
  draft: "neutral",
  submitted: "info",
  certified: "success",
  cancelled: "neutral",
};

export const advanceStatusTone: Record<SubcontractAdvanceStatus, Tone> = {
  requested: "info",
  approved: "info",
  paid: "success",
  rejected: "danger",
  cancelled: "neutral",
};

export const variationStatusTone: Record<SubcontractVariationStatus, Tone> = {
  pending: "info",
  approved: "success",
  rejected: "danger",
};

export const jobStatusTone: Record<PieceRateJobStatus, Tone> = {
  pending: "info",
  approved: "success",
  rejected: "danger",
  closed: "neutral",
};

export const flagTone: Record<ReconciliationFlag, Tone> = {
  "piece-rate-above-measured": "danger",
  "combined-above-measured": "danger",
  "not-measured": "warning",
  "unlinked-outputs": "warning",
  "not-comparable": "danger",
};

/** D6.3 part B problem codes worded for subcontracts and piece-rate jobs (EN/SW). */
export const SUBCONTRACT_PROBLEM_KEYS = {
  "subcontractor-not-eligible": "subcontractorNotEligible",
  "subcontract-empty": "subcontractEmpty",
  "line-exists": "lineExists",
  "too-many-lines": "tooManyLines",
  "over-bq-quantity": "overBqQuantity",
  "advance-not-recoverable": "advanceNotRecoverable",
  "subcontract-stale": "subcontractStale",
  "subcontract-has-open-items": "subcontractHasOpenItems",
  "subcontract-variation-open": "variationOpen",
  "subcontract-variation-stale": "variationStale",
  "line-below-certified": "lineBelowCertified",
  "advance-exceeds-limit": "advanceExceedsLimit",
  "certificate-open": "certificateOpen",
  "certificate-stale": "certificateStale",
  "certificate-date-invalid": "certificateDateInvalid",
  "completion-not-certified": "completionNotCertified",
  "release-exists": "releaseExists",
  "nothing-to-release": "nothingToRelease",
  "release-exceeds-held": "releaseExceedsHeld",
  "no-certified-certificate": "noCertifiedCertificate",
  "claim-exceeds-line": "claimExceedsLine",
  "claim-exceeds-measured": "claimExceedsMeasured",
  "basis-changed": "basisChanged",
  "payment-exceeds-payable": "paymentExceedsPayable",
  "payment-reference-taken": "paymentReferenceTaken",
  "payment-date-invalid": "paymentDateInvalid",
  "invoice-amount-mismatch": "invoiceAmountMismatch",
  "invoice-exists": "invoiceExists",
  "item-not-measurable": "itemNotMeasurable",
  "bq-not-approved": "bqNotApproved",
  "invalid-transition": "invalidTransition",
  "line-reduced": "lineReduced",
  "negative-amount": "negativeAmount",
  "subcontract-rule": "subcontractRule",
  "export-too-large": "exportTooLarge",
  "unit-not-convertible": "unitNotConvertible",
  "job-not-approved": "jobNotApproved",
  "job-dates": "jobDates",
  "job-quantity-exceeded": "jobQuantityExceeded",
  "bq-item-not-in-project": "itemNotForPieceRate",
  "payroll-rule": "payrollRule",
} as const;

/** The EN/SW key of a problem or warning code (anything unknown reads as a broken rule). */
export const problemKey = (code: string) =>
  SUBCONTRACT_PROBLEM_KEYS[code as keyof typeof SUBCONTRACT_PROBLEM_KEYS] ?? "subcontractRule";

/** What the caller may do on a project (the API enforces the same permissions, role ∩ assignment). */
export function subcontractAccess(permissions: readonly string[]) {
  const has = (...keys: string[]) => keys.some((key) => permissions.includes(key));
  return {
    read: has("bq.edit", "procurement.approve", "finance.view", "finance.manage"),
    prepare: has("bq.edit"),
    pieceRate: has("payroll.view", "payroll.prepare", "attendance.record", "timesheets.approve"),
  };
}

/** The text without leading and trailing whitespace and without thousands separators. */
function tidy(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 32) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= 32) end -= 1;
  return value.slice(start, end).replaceAll(",", "");
}

/** Digits only (at least one). */
function digits(value: string): boolean {
  if (!value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/** Drops trailing zeros of a fraction with a linear scan. */
function trimZeros(fraction: string): string {
  let end = fraction.length;
  while (end > 0 && fraction[end - 1] === "0") end -= 1;
  return fraction.slice(0, end);
}

/**
 * A quantity as typed ("12.5", " 1,250 ") → its canonical decimal text with at most `places`
 * decimals; null when malformed, negative, zero (unless allowed) or too precise.
 */
export function parseDecimalInput(
  value: string,
  places: number,
  { allowZero = false, maxWhole = 14 }: { allowZero?: boolean; maxWhole?: number } = {},
): string | null {
  const text = tidy(value);
  const point = text.indexOf(".");
  const whole = point === -1 ? text : text.slice(0, point);
  const fraction = point === -1 ? "" : text.slice(point + 1);
  if (!digits(whole) || whole.length > maxWhole) return null;
  if (whole.length > 1 && whole.startsWith("0")) return null;
  if (point !== -1 && (!digits(fraction) || fraction.length > places)) return null;
  const kept = trimZeros(fraction);
  const canonical = kept ? `${whole}.${kept}` : whole;
  if (!allowZero && Number(canonical) === 0) return null;
  return canonical;
}

/** A signed quantity change (a variation): "-50", "12.5"; never zero. */
export function parseChangeInput(value: string): string | null {
  const text = tidy(value);
  const negative = text.startsWith("-");
  const parsed = parseDecimalInput(negative ? text.slice(1) : text, 4);
  return parsed === null ? null : negative ? `-${parsed}` : parsed;
}

/** A percentage as typed ("5", "2.5") within [min, max] with at most two decimals. */
export function parsePercentInput(value: string, min = 0, max = 100): string | null {
  const parsed = parseDecimalInput(value, 2, { allowZero: true, maxWhole: 3 });
  if (parsed === null) return null;
  const number = Number(parsed);
  return number >= min && number <= max ? parsed : null;
}

/** A fresh idempotency key for one payment or output form (offline-ready retries reuse it). */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}
