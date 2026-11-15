/**
 * Plant quantities as exact integers (decision D-95): meter readings, hours, kilometres and litres
 * in tenths (one decimal place, `"1234.5"` ↔ 12345), standard consumption in hundredths of a litre
 * per hour or per km (`"14.00"` ↔ 1400). The API, the database (readings numeric(8,1), litres
 * numeric(5,1), standards numeric(5,2)) and the web agree exactly; nothing is computed in floating
 * point.
 */

const fixed = (places: number) => new RegExp(`^(\\d{1,9})(?:\\.(\\d{1,${places}}))?$`);

function parseFixed(text: string, places: number, max: number): number | null {
  const match = fixed(places).exec(text.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(places, "0"));
  const value = whole * 10 ** places + fraction;
  return value <= max ? value : null;
}

function formatFixed(value: number, places: number): string {
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  const scale = 10 ** places;
  return `${sign}${Math.trunc(magnitude / scale)}.${String(magnitude % scale).padStart(places, "0")}`;
}

/** "1234.5", "1234" or "0.7" → tenths (12345, 12340, 7); null when not a number with ≤ 1 decimal. */
export const parseTenths = (text: string, max = Number.MAX_SAFE_INTEGER): number | null =>
  parseFixed(text, 1, max);
/** 12345 → "1234.5"; −15 → "-1.5". */
export const formatTenths = (value: number): string => formatFixed(value, 1);
/** "14", "14.5" or "14.25" → hundredths (1400, 1450, 1425); null otherwise. */
export const parseHundredths = (text: string, max = Number.MAX_SAFE_INTEGER): number | null =>
  parseFixed(text, 2, max);
/** 1425 → "14.25". */
export const formatHundredths = (value: number): string => formatFixed(value, 2);

/** numerator ÷ denominator rounded half away from zero (denominator > 0). */
export function roundRatio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const rounded = (magnitude * 2n + denominator) / (denominator * 2n);
  return Number(negative ? -rounded : rounded);
}

/**
 * numerator ÷ denominator truncated toward zero (denominator > 0): percentages are truncated so a
 * figure never shows a threshold it has not reached (D-67).
 */
export function truncateRatio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  return Number(numerator / denominator);
}
