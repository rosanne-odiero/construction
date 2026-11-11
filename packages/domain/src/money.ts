import { Decimal } from "decimal.js";

/** Money is always an integer number of minor units (cents). Never a float (brief §10). */
export type MinorUnits = number;
export type RoundingMode = "half_up" | "half_even";

const DECIMAL = /^-?\d+(\.\d+)?$/;

const rounding = (mode: RoundingMode) =>
  mode === "half_even" ? Decimal.ROUND_HALF_EVEN : Decimal.ROUND_HALF_UP;

function toSafeMinor(value: Decimal): MinorUnits {
  const result = value.toNumber();
  if (!Number.isSafeInteger(result))
    throw new RangeError(`Amount out of safe integer range: ${value.toString()}`);
  return result;
}

function parseDecimal(input: string, label: string): Decimal {
  if (!DECIMAL.test(input))
    throw new TypeError(`${label} must be a decimal string, got "${input}"`);
  return new Decimal(input);
}

/** "1250000.50" → 125000050. Rejects more than two decimal places instead of silently rounding. */
export function toMinor(amount: string): MinorUnits {
  const value = parseDecimal(amount, "amount");
  if (value.decimalPlaces() > 2)
    throw new RangeError(`amount has more than 2 decimal places: ${amount}`);
  return toSafeMinor(value.times(100));
}

/** 125000050 → "1250000.50" */
export function fromMinor(minor: MinorUnits): string {
  if (!Number.isSafeInteger(minor))
    throw new RangeError(`minor units must be a safe integer, got ${minor}`);
  return new Decimal(minor).dividedBy(100).toFixed(2);
}

/** BQ line amount: quantity (decimal string, e.g. "12.345" m³) × rate (minor units), rounded to cents. */
export function lineAmountMinor(
  quantity: string,
  rateMinor: MinorUnits,
  mode: RoundingMode = "half_up",
): MinorUnits {
  const qty = parseDecimal(quantity, "quantity");
  return toSafeMinor(qty.times(rateMinor).toDecimalPlaces(0, rounding(mode)));
}

/** A percentage of an amount, e.g. VAT at "16" or retention at "10", rounded to cents. */
export function percentOfMinor(
  baseMinor: MinorUnits,
  ratePercent: string,
  mode: RoundingMode = "half_up",
): MinorUnits {
  const rate = parseDecimal(ratePercent, "ratePercent");
  return toSafeMinor(
    new Decimal(baseMinor).times(rate).dividedBy(100).toDecimalPlaces(0, rounding(mode)),
  );
}

export function sumMinor(values: readonly MinorUnits[]): MinorUnits {
  return toSafeMinor(values.reduce((acc, v) => acc.plus(v), new Decimal(0)));
}

/**
 * BQ line amount from decimal strings (D2.2): quantity × rate (rate in KES, up to four decimals),
 * rounded per line to the cent with `mode` (default half-up, which rounds a tie away from zero,
 * like PostgreSQL `round(numeric)`). A bill total is the sum of its rounded lines.
 */
export function lineAmountFromRate(
  quantity: string,
  rate: string,
  mode: RoundingMode = "half_up",
): MinorUnits {
  const qty = parseDecimal(quantity, "quantity");
  const unitRate = parseDecimal(rate, "rate");
  return toSafeMinor(qty.times(unitRate).times(100).toDecimalPlaces(0, rounding(mode)));
}

/** A decimal KES amount with any number of decimals → minor units rounded to the cent. */
export function decimalToMinor(amount: string, mode: RoundingMode = "half_up"): MinorUnits {
  return toSafeMinor(parseDecimal(amount, "amount").times(100).toDecimalPlaces(0, rounding(mode)));
}

/** A decimal string in its shortest exact form ("1.500" → "1.5", "2.00" → "2"). */
export function normaliseDecimal(value: string): string {
  return parseDecimal(value, "value").toString();
}
