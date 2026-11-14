import { divideRound, fromMicro, microDivide, microTimes, toMicro } from "./decimal6.js";

/**
 * Weighted average (moving average) stock valuation per store and material (D5.3, ARCHITECTURE
 * D-49, COMPLIANCE-REVIEW CR-STK-01). A position is the on-hand quantity in the material's base
 * unit and its total value in KES minor units, both with six decimals and never negative
 * (negative stock is never allowed, D-50).
 *
 * - Inflows carry their own unit cost: a receipt the LPO's net price per base unit (VAT
 *   excluded), a transfer in the dispatching store's average, a return the issue's unit cost, a
 *   stock-take surplus the current average. Value = round(quantity × unit cost, 6).
 * - Outflows (issues, transfers out, wastage, shortages, receipt reversals) leave at the average:
 *   value = round(quantity × value ÷ on-hand, 6); an outflow that empties the position takes all
 *   of its remaining value, so no rounding residue is ever left on zero stock.
 * - A reversal of an outflow puts back exactly the value it took out.
 *
 * The database repeats these rules in `app.post_stock_entry` (division-free comparisons), so a
 * bypassed API check cannot post a mis-valued entry.
 */

export type StockPosition = { quantity: string; valueMinor: string };
export const EMPTY_POSITION: StockPosition = { quantity: "0", valueMinor: "0" };

/** Value ÷ quantity rounded to six places; null when nothing is on hand. */
export function averageUnitCost(position: StockPosition): string | null {
  const quantity = toMicro(position.quantity);
  if (quantity === 0n) return null;
  return fromMicro(microDivide(toMicro(position.valueMinor), quantity));
}

export type InflowResult = { valueMinor: string; after: StockPosition };

/** Stock coming in at `unitCostMinor` per base unit (quantity > 0, cost ≥ 0). */
export function receiveIntoStock(
  position: StockPosition,
  quantity: string,
  unitCostMinor: string,
): InflowResult {
  const amount = toMicro(quantity);
  const cost = toMicro(unitCostMinor);
  if (amount <= 0n) throw new RangeError("An inflow needs a positive quantity");
  if (cost < 0n) throw new RangeError("A unit cost is never negative");
  const value = microTimes(amount, cost);
  return {
    valueMinor: fromMicro(value),
    after: {
      quantity: fromMicro(toMicro(position.quantity) + amount),
      valueMinor: fromMicro(toMicro(position.valueMinor) + value),
    },
  };
}

export type OutflowResult =
  | { ok: true; valueMinor: string; unitCostMinor: string; after: StockPosition }
  | { ok: false; reason: "insufficient-stock"; available: string };

/**
 * Stock leaving at the average cost (quantity > 0). Refused, never clipped, when it would take
 * the position below zero. `valueMinor` is the (positive) value removed.
 */
export function takeFromStock(position: StockPosition, quantity: string): OutflowResult {
  const amount = toMicro(quantity);
  if (amount <= 0n) throw new RangeError("An outflow needs a positive quantity");
  const onHand = toMicro(position.quantity);
  const value = toMicro(position.valueMinor);
  if (amount > onHand)
    return { ok: false, reason: "insufficient-stock", available: fromMicro(onHand) };
  const out = amount === onHand ? value : divideRound(amount * value, onHand);
  return {
    ok: true,
    valueMinor: fromMicro(out),
    unitCostMinor: fromMicro(microDivide(value, onHand)),
    after: { quantity: fromMicro(onHand - amount), valueMinor: fromMicro(value - out) },
  };
}

/** A posted entry (signed quantity and value) applied to a position; throws if it goes negative. */
export function applyEntry(
  position: StockPosition,
  entry: { quantity: string; valueMinor: string },
): StockPosition {
  const quantity = toMicro(position.quantity) + toMicro(entry.quantity);
  const value = toMicro(position.valueMinor) + toMicro(entry.valueMinor);
  if (quantity < 0n || value < 0n) throw new RangeError("Stock never goes below zero");
  if (quantity === 0n && value !== 0n) throw new RangeError("Zero stock carries no value");
  return { quantity: fromMicro(quantity), valueMinor: fromMicro(value) };
}

/** The sum of signed decimal strings (exact). */
export const sumDecimals = (values: readonly string[]): string =>
  fromMicro(values.reduce((total, value) => total + toMicro(value), 0n));

/** left − right (exact, signed). */
export const subtractDecimals = (left: string, right: string): string =>
  fromMicro(toMicro(left) - toMicro(right));

/** −value (exact). */
export const negateDecimal = (value: string): string => fromMicro(-toMicro(value));

/** −1, 0 or 1. */
export function compareDecimals(left: string, right: string): number {
  const difference = toMicro(left) - toMicro(right);
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

/** Whether a stock position is at or below its reorder level (a level of zero never triggers). */
export function isLowStock(onHand: string, reorderLevel: string | null): boolean {
  if (reorderLevel === null) return false;
  const level = toMicro(reorderLevel);
  return level > 0n && toMicro(onHand) <= level;
}
