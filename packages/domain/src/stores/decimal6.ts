/**
 * Signed fixed-point decimals with six places on BigInt (D5.3 stock ledger). Ledger quantities,
 * unit costs and values are `numeric(…, 6)` in the database; here they are integers of millionths
 * ("micro" units), so sums are exact and every product or quotient is rounded exactly once, half
 * away from zero (PostgreSQL's `round` on numeric). No floating point is used.
 */

export const STOCK_DECIMALS = 6;
const UNIT = 1_000_000n;
const SIGNED = /^(-)?(\d{1,24})(?:\.(\d{1,6}))?$/;

/** Parses "12", "-0.5" or "1234.123456" (at most six places) into micro units. */
export function toMicro(text: string): bigint {
  const match = SIGNED.exec(text.trim());
  if (!match) throw new TypeError(`Not a decimal with at most six places: "${text}"`);
  const fraction = (match[3] ?? "").padEnd(STOCK_DECIMALS, "0");
  const magnitude = BigInt(match[2]!) * UNIT + BigInt(fraction);
  return match[1] && magnitude !== 0n ? -magnitude : magnitude;
}

/** Whether `text` is a decimal the ledger can hold exactly (sign, digits, ≤ six places). */
export const isMicroDecimal = (text: string): boolean => SIGNED.test(text.trim());

/** Micro units as a decimal string without trailing zeros ("-1.5", "0", "12"). */
export function fromMicro(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / UNIT;
  let fraction = (magnitude % UNIT).toString().padStart(STOCK_DECIMALS, "0");
  let end = fraction.length;
  while (end > 0 && fraction.charCodeAt(end - 1) === 48) end -= 1;
  fraction = fraction.slice(0, end);
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** n / d rounded half away from zero to an integer (d ≠ 0). */
export function divideRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError("Division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const rounded = (2n * n + d) / (2n * d);
  return negative ? -rounded : rounded;
}

/** a × b for two micro values, rounded once to six places. */
export const microTimes = (left: bigint, right: bigint): bigint => divideRound(left * right, UNIT);

/** a ÷ b for two micro values, rounded once to six places. */
export const microDivide = (left: bigint, right: bigint): bigint => divideRound(left * UNIT, right);

/** A micro value of KES minor units rounded half away from zero to whole minor units. */
export const microToMinor = (value: bigint): number => Number(divideRound(value, UNIT));

/** A decimal string rounded half away from zero to exactly `places` (0–6) decimals. */
export function roundDecimal(text: string, places: number): string {
  const step = 10n ** BigInt(STOCK_DECIMALS - places);
  const out = fromMicro(divideRound(toMicro(text), step) * step);
  if (places === 0) return out;
  const [whole, fraction = ""] = out.split(".");
  return `${whole}.${fraction.padEnd(places, "0")}`;
}
