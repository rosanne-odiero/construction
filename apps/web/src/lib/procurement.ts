import { Ratio } from "@pm-buddy/domain";
import { isStandardUnitCode, type StandardUnitCode } from "@pm-buddy/types";
import type { UnitWire } from "@pm-buddy/validation";
import { formatDecimalString } from "./format";

/**
 * Display helpers for the catalogue and suppliers (D5.1). Amounts stay exact: decimal strings of
 * minor units are converted with packages/domain Ratio, never floating point.
 */

/** A unit's label: the EN/SW name of a standard unit, the company's name for its own units. */
export function unitLabel(
  code: string,
  translate: (code: StandardUnitCode) => string,
  units: readonly Pick<UnitWire, "code" | "name">[] = [],
): string {
  if (isStandardUnitCode(code)) return translate(code);
  return units.find((unit) => unit.code === code)?.name ?? code;
}

/** "10102.40625" minor units → "KES 101.02" (rounded half-up to the cent for display). */
export function formatMinorDecimal(minor: string): string {
  const negative = minor.startsWith("-");
  const value = Ratio.fromDecimal(minor.replace(/^-/, ""))
    .dividedBy(Ratio.of(100))
    .toDecimal(2, true).value;
  return `${negative ? "\u2212" : ""}KES ${formatDecimalString(value)}`;
}

/** The same value as a number of shillings, for charts only (never for arithmetic). */
export function minorDecimalToShillings(minor: string): number {
  return Number(Ratio.fromDecimal(minor).dividedBy(Ratio.of(100)).toDecimal(6).value);
}

/** "+12.5%" / "−2.7273%". */
export function formatChange(percent: string): string {
  if (percent.startsWith("-")) return `\u2212${percent.slice(1)}%`;
  return percent === "0" ? "0%" : `+${percent}%`;
}

/** A conversion factor for display, e.g. "0.888888888889" → "0.888889". */
export function formatFactor(factor: string): string {
  const ratio = Ratio.fromDecimal(factor);
  const rounded = ratio.toDecimal(6).value;
  return formatDecimalString(rounded);
}

/** Pages a picker loads at most (200 records each); beyond that the list is marked incomplete. */
export const PICKER_MAX_PAGES = 10;

export type PageFetch<T> = (
  cursor: string | null,
) => Promise<{ items: T[]; nextCursor: string | null } | null>;

/**
 * Follows `nextCursor` until the last page or `maxPages`. Null when the first page fails; a later
 * failure keeps what was loaded and reports the list as incomplete.
 */
export async function collectPages<T>(
  fetchPage: PageFetch<T>,
  maxPages = PICKER_MAX_PAGES,
): Promise<{ items: T[]; complete: boolean } | null> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPage(cursor);
    if (!result) return page === 0 ? null : { items, complete: false };
    items.push(...result.items);
    if (!result.nextCursor) return { items, complete: true };
    cursor = result.nextCursor;
  }
  return { items, complete: false };
}
