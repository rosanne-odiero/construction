/**
 * Exact arithmetic for valuations and earned value (D6.3). Money is integer KES minor units;
 * quantities, rates and percentages are decimal strings scaled to integers, so every product and
 * quotient is computed with BigInt and rounded once, half away from zero (PostgreSQL `round()`),
 * the rule FINANCIAL_MODEL calls half-up.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** A JS number that is safe as an integer of minor units. */
export function safeMinor(value: bigint): number {
  if (value > MAX_SAFE || value < -MAX_SAFE) throw new RangeError("Amount out of safe range");
  return Number(value);
}

/** numerator ÷ denominator rounded half away from zero; the denominator must be positive. */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("divideHalfUp needs a positive denominator");
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = (2n * magnitude + denominator) / (2n * denominator);
  return negative ? -quotient : quotient;
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Drops trailing zeros in linear time (a `/0+$/` replace is quadratic on long runs of zeros). */
const trimTrailingZeros = (digits: string) => {
  let end = digits.length;
  while (end > 0 && digits.charCodeAt(end - 1) === 48) end -= 1;
  return digits.slice(0, end);
};

/**
 * "12.345" with `places` 4 → 123450n. Refuses more decimals than `places` (never rounds an input
 * silently) and anything that is not a plain decimal.
 */
export function scaled(value: string, places: number): bigint {
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new TypeError(`Not a decimal: "${value}"`);
  const fraction = trimTrailingZeros(match[3] ?? "");
  if (fraction.length > places) throw new RangeError(`More than ${places} decimals: "${value}"`);
  const units = BigInt(match[2]!) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, "0"));
  return match[1] ? -units : units;
}

/** A scaled integer back to its shortest decimal text (123450n, 4 → "12.345"). */
export function unscaled(units: bigint, places: number): string {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const base = 10n ** BigInt(places);
  const whole = magnitude / base;
  const fraction = trimTrailingZeros((magnitude % base).toString().padStart(places, "0"));
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

const fixed = (units: bigint, places: number) => {
  const factor = 10n ** BigInt(places);
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const fraction = places ? `.${(magnitude % factor).toString().padStart(places, "0")}` : "";
  return `${negative ? "-" : ""}${magnitude / factor}${fraction}`;
};

/**
 * part ÷ whole × 100 TRUNCATED (towards minus infinity) to `places` decimals, or null when the
 * whole is not positive: an undefined ratio is unavailable, never 0 %. Truncating means a figure
 * just short of a whole percentage never displays as that percentage.
 */
export function percentText(part: bigint, whole: bigint, places = 1): string | null {
  if (whole <= 0n) return null;
  const numerator = part * 100n * 10n ** BigInt(places);
  let units = numerator / whole;
  if (numerator < 0n && numerator % whole !== 0n) units -= 1n;
  return fixed(units, places);
}

/**
 * numerator ÷ denominator as a decimal with `places` decimals, rounded half away from zero, or
 * null when the denominator is not positive (CPI, SPI: unavailable rather than 0 or infinite).
 */
export function ratioText(numerator: bigint, denominator: bigint, places = 2): string | null {
  if (denominator <= 0n) return null;
  return fixed(divideHalfUp(numerator * 10n ** BigInt(places), denominator), places);
}

/** A percentage of an amount (VAT, retention, release) in minor units, half away from zero. */
export function percentageOf(amountMinor: number, percent: string): number {
  return safeMinor(divideHalfUp(BigInt(amountMinor) * scaled(percent, 2), 10_000n));
}
