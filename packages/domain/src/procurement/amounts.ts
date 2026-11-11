import { COMPARABLE_PRICE_DECIMALS, type VatTreatment } from "@pm-buddy/types";
import { exactNetPrice } from "../materials/prices.js";
import { Ratio } from "../materials/ratio.js";

/**
 * Procure-to-pay money (D5.2, FINANCIAL_MODEL "Precision and rounding"). Prices are KES minor
 * units per unit of sale with a VAT treatment; for ordering, comparing and matching they are taken
 * net of VAT exactly and expressed per base unit of the material (the D5.1 conversion engine
 * supplies the ratio). A line amount is the base quantity × that exact net price, **rounded
 * half-up to the cent once**; VAT is charged once on the subtotal of the VAT-able lines (also
 * half-up). Quantities are the stored six-decimal base quantities, so the API, the database
 * backstop and the web compute the same figures.
 */

const HUNDRED = Ratio.of(100);

const toSafe = (value: string): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError("Amount out of the safe integer range");
  return result;
};

/** Lines whose price carries VAT (inclusive or exclusive); `not_applicable` lines carry none. */
export const isVatable = (treatment: VatTreatment): boolean => treatment !== "not_applicable";

/**
 * The exact net price per base unit: the unit price net of VAT × the number of price units in one
 * base unit (`priceUnitsPerBase`, from `comparableUnitPrice`/`resolveConversion(base, priceUnit)`).
 */
export function netPricePerBase(
  unitPriceMinor: number,
  treatment: VatTreatment,
  vatRatePercent: string,
  priceUnitsPerBase: Ratio,
): Ratio {
  return exactNetPrice(unitPriceMinor, treatment, vatRatePercent).times(priceUnitsPerBase);
}

/** A per-base price for display and storage: minor units with six decimals (half-up). */
export const perBaseMinor = (value: Ratio): string =>
  value.toDecimal(COMPARABLE_PRICE_DECIMALS).value;

/** Base quantity × exact net price per base unit, rounded half-up to the cent once. */
export function lineNetAmountMinor(baseQuantity: string, netPerBase: Ratio): number {
  return toSafe(Ratio.fromDecimal(baseQuantity).times(netPerBase).toDecimal(0).value);
}

export interface TotalsLine {
  netAmountMinor: number;
  vatable: boolean;
}

export interface DocumentTotals {
  subtotalMinor: number;
  /** The part of the subtotal VAT is charged on. */
  vatableMinor: number;
  vatMinor: number;
  totalMinor: number;
}

/** Subtotal = Σ rounded line amounts; VAT = VAT-able subtotal × rate, half-up once; total. */
export function documentTotals(
  lines: readonly TotalsLine[],
  vatRatePercent: string,
): DocumentTotals {
  let subtotal = 0;
  let vatable = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.netAmountMinor) || line.netAmountMinor < 0)
      throw new RangeError("Line amounts are non-negative whole minor units");
    subtotal += line.netAmountMinor;
    if (line.vatable) vatable += line.netAmountMinor;
  }
  const vat = toSafe(
    Ratio.of(vatable).times(Ratio.fromDecimal(vatRatePercent)).dividedBy(HUNDRED).toDecimal(0)
      .value,
  );
  if (!Number.isSafeInteger(subtotal + vat)) throw new RangeError("Total out of range");
  return {
    subtotalMinor: subtotal,
    vatableMinor: vatable,
    vatMinor: vat,
    totalMinor: subtotal + vat,
  };
}
