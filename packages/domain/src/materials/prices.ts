import {
  COMPARABLE_PRICE_DECIMALS,
  PRICE_CHANGE_DECIMALS,
  type PriceAlertState,
  type VatTreatment,
} from "@pm-buddy/types";
import { resolveConversion, type ConversionContext, type ConversionStep } from "./convert.js";
import { parseUnsignedDecimal, Ratio } from "./ratio.js";

/**
 * Price history maths (D5.1). Prices are KES minor units per unit of sale. For comparison each
 * price is taken net of VAT (exactly, before the cent rounding of `splitVat`) and converted to the
 * material's base unit with the conversion engine (supplier factors first), then rounded once
 * half-up to six decimal places of a minor unit. The change against the previous comparable price
 * is reported to four decimal places of a percent; the alert compares the unrounded change with
 * the threshold (strictly greater).
 */

export interface VatSplit {
  netMinor: number;
  grossMinor: number;
  /** The VAT rate applied, or null when VAT does not apply. */
  ratePercent: string | null;
}

const HUNDRED = Ratio.of(100);

const toSafe = (value: string): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError("Amount out of the safe integer range");
  return result;
};

/**
 * Net and gross unit prices. Inclusive: net = gross × 100 / (100 + rate); exclusive: gross =
 * net × (100 + rate) / 100; each rounded half-up to the cent once. VAT-exempt, zero-rated or
 * unregistered suppliers use `not_applicable` (net = gross).
 */
export function splitVat(
  unitPriceMinor: number,
  treatment: VatTreatment,
  ratePercent: string,
): VatSplit {
  if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor <= 0)
    throw new RangeError("A unit price is a positive whole number of minor units");
  if (treatment === "not_applicable")
    return { netMinor: unitPriceMinor, grossMinor: unitPriceMinor, ratePercent: null };
  const rate = Ratio.fromDecimal(ratePercent);
  const price = Ratio.of(unitPriceMinor);
  const gross = HUNDRED.plus(rate);
  if (treatment === "inclusive")
    return {
      grossMinor: unitPriceMinor,
      netMinor: toSafe(price.times(HUNDRED).dividedBy(gross).toDecimal(0).value),
      ratePercent,
    };
  return {
    netMinor: unitPriceMinor,
    grossMinor: toSafe(price.times(gross).dividedBy(HUNDRED).toDecimal(0).value),
    ratePercent,
  };
}

/**
 * The exact net unit price (no rounding), for comparisons: rounding to the cent first would make a
 * VAT-inclusive 800 → 900 read as +12.4989 % instead of +12.5 %.
 */
export function exactNetPrice(
  unitPriceMinor: number,
  treatment: VatTreatment,
  ratePercent: string,
): Ratio {
  if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor <= 0)
    throw new RangeError("A unit price is a positive whole number of minor units");
  const price = Ratio.of(unitPriceMinor);
  if (treatment !== "inclusive") return price;
  return price.times(HUNDRED).dividedBy(HUNDRED.plus(Ratio.fromDecimal(ratePercent)));
}

export type ComparablePrice =
  | {
      ok: true;
      /** Minor units per base unit, six decimal places, trailing zeros removed. */
      valueMinor: string;
      /** Price-unit quantity in one base unit (exact). */
      ratio: Ratio;
      steps: ConversionStep[];
    }
  | { ok: false };

/**
 * A net unit price expressed per `baseUnit` (price per unit × units in one base unit). Pass the
 * exact net from `exactNetPrice` so the result is rounded only once.
 */
export function comparableUnitPrice(
  net: Ratio | number,
  priceUnit: string,
  baseUnit: string,
  context: ConversionContext,
): ComparablePrice {
  const path = resolveConversion(baseUnit, priceUnit, context);
  if (!path.ok) return { ok: false };
  const exactNet = typeof net === "number" ? Ratio.of(net) : net;
  return {
    ok: true,
    valueMinor: exactNet.times(path.ratio).toDecimal(COMPARABLE_PRICE_DECIMALS).value,
    ratio: path.ratio,
    steps: path.steps,
  };
}

export interface PriceChange {
  /** Signed percent change, four decimal places (half-up, away from zero). */
  percent: string;
  state: Extract<PriceAlertState, "within_threshold" | "above_threshold">;
}

/**
 * Percent change from the previous comparable price; `above_threshold` when the exact change is
 * strictly greater than `thresholdPercent` in either direction. Null when the previous price is
 * zero (no meaningful percentage).
 */
export function priceChange(
  previousMinor: string,
  currentMinor: string,
  thresholdPercent: string,
): PriceChange | null {
  if (!parseUnsignedDecimal(previousMinor) || !parseUnsignedDecimal(currentMinor))
    throw new TypeError("Comparable prices are non-negative decimal strings");
  const previous = Ratio.fromDecimal(previousMinor);
  if (previous.isZero()) return null;
  const { value, below } = Ratio.fromDecimal(currentMinor).distance(previous);
  const magnitude = value.dividedBy(previous).times(HUNDRED);
  const rounded = magnitude.toDecimal(PRICE_CHANGE_DECIMALS).value;
  return {
    percent: below && rounded !== "0" ? `-${rounded}` : rounded,
    state:
      magnitude.compare(Ratio.fromDecimal(thresholdPercent)) > 0
        ? "above_threshold"
        : "within_threshold",
  };
}
