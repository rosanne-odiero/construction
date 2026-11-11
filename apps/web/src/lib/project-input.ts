import { toMinor } from "@pm-buddy/domain";

/**
 * Parsers for project form inputs. They return `null` for an empty field, `undefined` for invalid
 * input, and the API value otherwise, so the form can show a precise message per field.
 */

/** "86,400,000" or "1250000.50" (shillings) → integer minor units. */
export function parseShillings(text: string): number | null | undefined {
  const cleaned = text.replace(/[\s,]/g, "").replace(/^KES/i, "");
  if (cleaned === "") return null;
  try {
    const minor = toMinor(cleaned);
    return minor >= 0 ? minor : undefined;
  } catch {
    return undefined;
  }
}

/** Integer minor units → "86400000" or "1250000.50" for editing. */
export function shillingsInput(minor: number | null): string {
  if (minor === null) return "";
  const whole = Math.trunc(minor / 100);
  const cents = minor % 100;
  return cents ? `${whole}.${String(cents).padStart(2, "0")}` : String(whole);
}

/** "02/03/2026" → "2026-03-02"; rejects impossible dates such as 31/02/2026. */
export function parseCalendarInput(text: string): string | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (!match) return undefined;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "2026-03-02" → "02/03/2026" for editing. */
export function calendarInput(value: string | null): string {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

/** A decimal-degree coordinate, or null when empty. */
export function parseCoordinate(text: string): number | null | undefined {
  const trimmed = text.trim().replace("\u2212", "-");
  if (trimmed === "") return null;
  if (!/^-?\d{1,3}(\.\d+)?$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

/** "25.5" (percent, up to two decimals) → 2550 basis points; 0–100 %. */
export function parsePercentToBasisPoints(text: string): number | undefined {
  const trimmed = text.trim().replace(/%$/, "").trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return undefined;
  const basisPoints = Math.round(Number(trimmed) * 100);
  return basisPoints <= 10_000 ? basisPoints : undefined;
}

/** 2550 → "25.5" for editing. */
export const basisPointsInput = (basisPoints: number): string => String(basisPoints / 100);
