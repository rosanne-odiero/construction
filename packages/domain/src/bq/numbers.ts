import { Decimal } from "decimal.js";
import type { GridCell } from "./grid.js";
import { sanitiseCellText } from "./text.js";

/** Quantities and rates are stored as numeric(20,4): four decimal places (ARCHITECTURE §9). */
export const BQ_DECIMAL_SCALE = 4;
/** Largest quantity, rate or amount accepted (well inside numeric(20,4) and safe minor units). */
export const BQ_MAX_VALUE = new Decimal("999999999999");

export type NumericCell =
  | { kind: "blank" }
  | { kind: "number"; value: string; rounded: boolean }
  /** "Incl.", "Included": priced elsewhere. "Rate only": no quantity on purpose. */
  | { kind: "token"; token: "included" | "rate_only" }
  | { kind: "invalid"; raw: string };

/**
 * A spreadsheet number as an exact decimal string. Excel keeps 15 significant digits, so the
 * value is first reduced to 15 significant digits: 0.30000000000000004 becomes "0.3".
 */
export function decimalFromNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("not a finite number");
  return new Decimal(value.toPrecision(15)).toFixed();
}

const BLANK_TOKENS = /^(?:-+|–|—|nil|n\/?a|none)$/i;
const INCLUDED_TOKENS = /^(?:incl?\.?|incld\.?|included|inclusive|in rates?)$/i;
const RATE_ONLY_TOKENS = /^(?:rate\s*only|r\/o)$/i;
const CURRENCY_PREFIX = /^(?:kshs?\.?|kes|shs?\.?|ksh\.?)\s*/i;
const CURRENCY_SUFFIX = /\s*(?:\/=|\/-|kshs?\.?|kes)$/i;
const GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const PLAIN = /^\d+(?:\.\d+)?$/;
const LEADING_DOT = /^\.\d+$/;

function fromText(raw: string): NumericCell {
  const text = sanitiseCellText(raw, 200).text.replace(/\s+/g, " ");
  if (!text || BLANK_TOKENS.test(text)) return { kind: "blank" };
  if (INCLUDED_TOKENS.test(text)) return { kind: "token", token: "included" };
  if (RATE_ONLY_TOKENS.test(text)) return { kind: "token", token: "rate_only" };
  let body = text.replace(CURRENCY_PREFIX, "").replace(CURRENCY_SUFFIX, "").replace(/ /g, "");
  let negative = false;
  if (/^\(.*\)$/.test(body)) {
    negative = true;
    body = body.slice(1, -1);
  } else if (body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  }
  if (LEADING_DOT.test(body)) body = `0${body}`;
  if (!GROUPED.test(body) && !PLAIN.test(body)) return { kind: "invalid", raw: text };
  const decimal = new Decimal(body.replace(/,/g, ""));
  return scaled(negative ? decimal.negated() : decimal);
}

function scaled(value: Decimal): NumericCell {
  if (value.abs().greaterThan(BQ_MAX_VALUE)) return { kind: "invalid", raw: value.toFixed() };
  const rounded = value.decimalPlaces() > BQ_DECIMAL_SCALE;
  const result = rounded ? value.toDecimalPlaces(BQ_DECIMAL_SCALE, Decimal.ROUND_HALF_UP) : value;
  return { kind: "number", value: result.isZero() ? "0" : result.toFixed(), rounded };
}

/**
 * Reads a quantity, rate or amount cell. Numbers keep up to four decimals (more are rounded
 * half-up and reported); text numbers may use thousands separators, a KShs/KES prefix, a `/=`
 * suffix or parentheses for negatives. A formula without a cached value is the caller's concern.
 */
export function readNumeric(cell: GridCell | null): NumericCell {
  if (cell === null) return { kind: "blank" };
  switch (cell.t) {
    case "n":
      return scaled(new Decimal(decimalFromNumber(cell.v)));
    case "s":
      return fromText(cell.v);
    case "b":
      return { kind: "invalid", raw: cell.v ? "TRUE" : "FALSE" };
    case "e":
      return { kind: "invalid", raw: cell.v };
    case "f":
      return { kind: "blank" };
  }
}

/** A cell as display text (references like 2.1 may be stored as numbers). */
export function cellText(cell: GridCell | null, maxLength = 4_000): string {
  if (cell === null) return "";
  switch (cell.t) {
    case "s":
      return sanitiseCellText(cell.v, maxLength).text;
    case "n":
      return decimalFromNumber(cell.v);
    case "b":
      return cell.v ? "TRUE" : "FALSE";
    case "e":
    case "f":
      return "";
  }
}

/** Compares two decimal strings. */
export const compareDecimal = (left: string, right: string): number =>
  new Decimal(left).comparedTo(new Decimal(right));

export const isNegativeDecimal = (value: string): boolean => new Decimal(value).isNegative();

/** Minor units → a fixed two-decimal KES string, for reports. */
export function minorToDecimal(minor: number): string {
  return new Decimal(minor).dividedBy(100).toFixed(2);
}

/** A percentage of a base amount (minor units), rounded half-up to the cent. */
export function percentageOfMinor(percent: string, baseMinor: number): number {
  const result = new Decimal(percent)
    .times(baseMinor)
    .dividedBy(100)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const value = result.toNumber();
  if (!Number.isSafeInteger(value)) throw new RangeError("amount out of range");
  return value;
}
