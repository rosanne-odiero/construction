import {
  NOT_MEASURED_ITEM_KINDS,
  type BqAmountSource,
  type BqItemKind,
  type MeasurementBasis,
  type MeasurementDecision,
  type MeasurementState,
} from "@pm-buddy/types";
import { divideHalfUp, percentText, safeMinor, scaled } from "./arithmetic.js";

/**
 * Progress measurement against BQ items (D6.3, brief §5.2 and §15 G). Quantities and rates carry
 * up to four decimals (numeric(20,4)); a percent-complete measurement up to two. Value of work
 * done is computed once per item and rounded half away from zero to the cent.
 */

export type MeasurableItem = {
  kind: BqItemKind;
  amountSource: BqAmountSource;
  /** The item's BQ quantity (decimal string) or null for a lump sum. */
  quantity: string | null;
  /** The item's rate in KES (decimal string) or null. */
  rate: string | null;
  amountMinor: number;
};

/**
 * How an item is measured, or null when it is not measured: provisional sums, PC sums and their
 * attendance and profit, contingencies (expended through variations) and items worth nothing
 * (unpriced, included, omitted). An item with a quantity is measured by quantity; a priced lump
 * sum without one by percent complete.
 */
export function measurementBasis(item: MeasurableItem): MeasurementBasis | null {
  if ((NOT_MEASURED_ITEM_KINDS as readonly string[]).includes(item.kind)) return null;
  if (item.amountMinor <= 0) return null;
  if (item.quantity !== null && scaled(item.quantity, 4) > 0n) return "quantity";
  return "percent";
}

export type MeasuredQuantityCheck =
  | { ok: true; overMeasured: boolean }
  | { ok: false; problem: "over-measure-reason-required" | "percent-over-100" | "not-measured" };

/**
 * Whether a quantity to date may be recorded. A percent-complete measurement never exceeds 100.
 * A quantity above the BQ quantity is an OVER-MEASURE: accepted only with a reason (shown to the
 * approver and on the certificate) and then valued in full at the BQ rate, as a remeasured
 * quantity is (COMPLIANCE-REVIEW CR-VAL-03: on lump-sum contracts the QS may prefer a variation).
 */
export function checkMeasuredQuantity(
  basis: MeasurementBasis | null,
  itemQuantity: string | null,
  quantityToDate: string,
  overMeasureReason: string | null | undefined,
): MeasuredQuantityCheck {
  if (basis === null) return { ok: false, problem: "not-measured" };
  const quantity = scaled(quantityToDate, 4);
  if (basis === "percent")
    return quantity > 1_000_000n
      ? { ok: false, problem: "percent-over-100" }
      : { ok: true, overMeasured: false };
  const overMeasured = quantity > scaled(itemQuantity ?? "0", 4);
  if (overMeasured && !overMeasureReason?.trim())
    return { ok: false, problem: "over-measure-reason-required" };
  return { ok: true, overMeasured };
}

/**
 * Value of work done for a measured quantity to date on an item (KES minor units):
 * - quantity basis, computed item: quantity to date × rate (D2.2 line rule);
 * - quantity basis, any other priced item (sheet override, fixed): amount × quantity ÷ BQ quantity;
 * - percent basis: amount × percent ÷ 100.
 * Rounded once, half away from zero. 0 for an item that is not measured.
 */
export function measuredValueMinor(item: MeasurableItem, quantityToDate: string): number {
  const basis = measurementBasis(item);
  if (basis === null) return 0;
  const done = scaled(quantityToDate, 4);
  if (basis === "percent")
    return safeMinor(divideHalfUp(BigInt(item.amountMinor) * done, 1_000_000n));
  if (item.amountSource === "computed" && item.rate !== null)
    return safeMinor(divideHalfUp(done * scaled(item.rate, 4) * 100n, 100_000_000n));
  return safeMinor(divideHalfUp(BigInt(item.amountMinor) * done, scaled(item.quantity!, 4)));
}

/**
 * Physical percent complete of an item, truncated to one decimal, or null when it is unavailable
 * (no basis, or no BQ quantity). An over-measured item shows above 100 %.
 */
export function measuredPercent(item: MeasurableItem, quantityToDate: string): string | null {
  const basis = measurementBasis(item);
  if (basis === null) return null;
  const done = scaled(quantityToDate, 4);
  if (basis === "percent") return percentText(done, 1_000_000n);
  return percentText(done, scaled(item.quantity!, 4));
}

/**
 * Where a measurement stands, from its review and the newest correction naming it:
 * - reviewed and rejected → `rejected`;
 * - approved, and an approved correction replaced it → `superseded`, otherwise `approved`;
 * - not reviewed: corrected → `withdrawn`, otherwise `pending`.
 */
export function measurementState(input: {
  decision: MeasurementDecision | null;
  correctedBy: { decision: MeasurementDecision | null } | null;
}): MeasurementState {
  if (input.decision === "rejected") return "rejected";
  if (input.decision === "approved")
    return input.correctedBy?.decision === "approved" ? "superseded" : "approved";
  return input.correctedBy ? "withdrawn" : "pending";
}

export type DatedMeasurement = {
  id: string;
  lineageId: string;
  measuredOn: string;
  /** ISO timestamp of the database stamp: orders two measurements of one day. */
  recordedAt: string;
  state: MeasurementState;
};

/**
 * The measurement in force per BQ item on `asOf`: the newest APPROVED measurement measured on or
 * before that date (by date, then recording time). Pending, rejected, withdrawn and superseded
 * measurements never count.
 */
export function measurementsInForce<T extends DatedMeasurement>(
  rows: readonly T[],
  asOf: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    if (row.state !== "approved" || row.measuredOn > asOf) continue;
    const current = result.get(row.lineageId);
    if (
      !current ||
      row.measuredOn > current.measuredOn ||
      (row.measuredOn === current.measuredOn &&
        (row.recordedAt > current.recordedAt ||
          (row.recordedAt === current.recordedAt && row.id > current.id)))
    )
      result.set(row.lineageId, row);
  }
  return result;
}
