import { compareDecimals, isMicroDecimal, microToMinor, toMicro } from "@pm-buddy/domain";
import type {
  StockEntryKind,
  StockMovementKind,
  StockMovementStatus,
  StockTakeStatus,
  TransferStatus,
  VarianceState,
} from "@pm-buddy/types";
import type { Tone } from "@/components/status-badge";
import { formatDecimalString } from "./format";

/**
 * Display and input helpers for the stores screens (D5.3). Quantities stay decimal strings in the
 * material's base unit; values arrive as KES minor units. Input helpers trim what was typed and
 * never throw, so a pasted "12 " or "1e3" can never break a render.
 */

export const movementTone: Record<StockMovementStatus, Tone> = {
  posted: "success",
  reversed: "neutral",
};

export const movementKindTone: Record<StockMovementKind, Tone> = {
  issue: "info",
  return: "success",
  wastage: "warning",
};

export const transferTone: Record<TransferStatus, Tone> = {
  dispatched: "info",
  received: "success",
  disputed: "danger",
  resolved: "neutral",
  cancelled: "neutral",
};

export const stockTakeTone: Record<StockTakeStatus, Tone> = {
  draft: "neutral",
  submitted: "info",
  approved: "success",
  cancelled: "neutral",
};

export const varianceTone: Record<VarianceState, Tone> = {
  alert: "danger",
  within: "success",
  no_measurement: "neutral",
  no_buildup: "neutral",
  not_mapped: "warning",
  not_in_buildup: "warning",
  no_progress: "warning",
};

export const entryTone: Record<StockEntryKind, Tone> = {
  receipt: "success",
  issue: "info",
  return: "success",
  transfer_out: "info",
  transfer_in: "success",
  wastage: "warning",
  adjustment: "neutral",
};

/** A quantity for display: "1234.5" → "1,234.5"; signed values keep their sign. */
export const formatStock = (value: string): string => formatDecimalString(value);

/** A six-decimal minor-unit value (e.g. "-2400000.5") as whole minor units, or null. */
export function decimalMinorToNumber(value: string): number | null {
  if (!isMicroDecimal(value)) return null;
  const result = microToMinor(toMicro(value));
  return Number.isSafeInteger(result) ? result : null;
}

/** A positive quantity with at most six places, as typed (trimmed); null otherwise. */
export function positiveQuantity(value: string): string | null {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(trimmed)) return null;
  return /[1-9]/.test(trimmed) ? trimmed : null;
}

/** A quantity ≥ 0 with at most six places, as typed (trimmed); null otherwise. */
export function nonNegativeQuantity(value: string): string | null {
  const trimmed = value.trim();
  return /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(trimmed) ? trimmed : null;
}

/** Whether `left` is above `right` (both decimals); false when either is malformed. */
export function above(left: string, right: string): boolean {
  if (!isMicroDecimal(left) || !isMicroDecimal(right)) return false;
  return compareDecimals(left, right) > 0;
}

/** A client-generated identifier (record IDs and idempotency keys), created once per form. */
export const newClientId = () => crypto.randomUUID();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
