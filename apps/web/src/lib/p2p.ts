import {
  documentTotals,
  isVatable,
  lineNetAmountMinor,
  netPricePerBase,
  Ratio,
  type DocumentTotals,
} from "@pm-buddy/domain";
import type {
  GrnLocationState,
  GrnStatus,
  InvoiceStatus,
  LpoDeliveryState,
  LpoStatus,
  RequisitionStatus,
  RfqStatus,
  VatTreatment,
} from "@pm-buddy/types";
import type { Tone } from "@/components/status-badge";
import { formatDecimalString } from "./format";

/**
 * Display and input helpers for the procure-to-pay screens (D5.2). Money stays in integer KES
 * minor units and quantities in decimal strings; conversions use packages/domain Ratio, never
 * floating point.
 */

export const requisitionTone: Record<RequisitionStatus, Tone> = {
  draft: "neutral",
  submitted: "info",
  approved: "success",
  rejected: "danger",
  ordered: "success",
  cancelled: "neutral",
};

export const rfqTone: Record<RfqStatus, Tone> = {
  open: "info",
  awarded: "success",
  cancelled: "neutral",
};

export const lpoTone: Record<LpoStatus, Tone> = {
  draft: "neutral",
  submitted: "info",
  approved: "success",
  cancelled: "neutral",
};

export const deliveryTone: Record<LpoDeliveryState, Tone> = {
  none: "neutral",
  partial: "info",
  complete: "success",
  over: "warning",
};

export const grnTone: Record<GrnStatus, Tone> = { recorded: "success", voided: "neutral" };

export const locationTone: Record<GrnLocationState, Tone> = {
  inside: "success",
  outside: "warning",
  no_fix: "warning",
  no_geofence: "neutral",
};

export const invoiceTone: Record<InvoiceStatus, Tone> = {
  draft: "neutral",
  submitted: "info",
  matched: "success",
  disputed: "danger",
  approved: "success",
  partly_settled: "info",
  settled: "success",
  cancelled: "neutral",
};

/** A quantity string for display: "1234.5" → "1,234.5". */
export const formatQuantity = (value: string): string => formatDecimalString(value);

/** Integer minor units as an input value in shillings: 400050 → "4000.50", 400000 → "4000". */
export function minorToInput(minor: number): string {
  const shillings = Math.trunc(minor / 100);
  const cents = Math.abs(minor % 100);
  return cents === 0 ? String(shillings) : `${shillings}.${String(cents).padStart(2, "0")}`;
}

/** A shillings input ("4,000.5", "4000") as integer minor units; null when it is not money. */
export function inputToMinor(value: string): number | null {
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(value.replace(/[,\s]/g, ""));
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

/** A positive decimal quantity with at most six places (the API's quantity format). */
export const QUANTITY_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;
export const isQuantity = (value: string) => QUANTITY_PATTERN.test(value.trim());
export const isPositiveQuantity = (value: string) =>
  isQuantity(value) && /[1-9]/.test(value.trim());

/**
 * An invoice's totals from what has been typed, exactly as the API computes them; null while a line
 * is incomplete, malformed or too large for the API. Never throws: it runs on every keystroke.
 * `perBase` is the number of the typed unit in one base unit.
 */
export function invoiceTotals(
  lines: readonly { quantity: string; price: string; vat: VatTreatment; perBase: Ratio }[],
  vatRatePercent: string,
): DocumentTotals | null {
  try {
    const priced = [];
    for (const line of lines) {
      const quantity = line.quantity.trim();
      const price = inputToMinor(line.price);
      if (!isPositiveQuantity(quantity) || !price || price <= 0) return null;
      const baseQuantity = Ratio.fromDecimal(quantity).dividedBy(line.perBase).toDecimal(6).value;
      const net = netPricePerBase(price, line.vat, vatRatePercent, line.perBase);
      priced.push({
        netAmountMinor: lineNetAmountMinor(baseQuantity, net),
        vatable: isVatable(line.vat),
      });
    }
    return documentTotals(priced, vatRatePercent);
  } catch {
    return null;
  }
}

/** value × numerator / denominator, exactly, as a six-place decimal string. */
export function scaleQuantity(value: string, numerator: string, denominator: string): string {
  return Ratio.fromDecimal(value)
    .times(Ratio.fromDecimal(numerator))
    .dividedBy(Ratio.fromDecimal(denominator))
    .toDecimal(6).value;
}

/** Whether a six-place decimal string is greater than another (exact). */
export const quantityAbove = (left: string, right: string) =>
  Ratio.fromDecimal(left).compare(Ratio.fromDecimal(right)) > 0;

/** left − right, at least zero, as a six-place decimal string. */
export function remainingQuantity(left: string, right: string): string {
  const difference = Ratio.fromDecimal(left).distance(Ratio.fromDecimal(right));
  return difference.below ? "0" : difference.value.toDecimal(6).value;
}

/** A client-generated identifier (GRN IDs and idempotency keys). */
export const newClientId = () => crypto.randomUUID();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

/** Query values from searchParams: a trimmed string or undefined. */
export function pickParam(
  raw: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = raw[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
