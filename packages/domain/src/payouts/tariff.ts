import { TARIFF_LIMITS, type TariffBand } from "@pm-buddy/types";

/**
 * M-Pesa charges tariff (D4.3 §12, ARCHITECTURE §14.5, CR-PMT-02): effective-dated versions of
 * ascending bands; a payout's estimated charge is the band charge for its amount on the payout
 * date (owner decision 6: booked as cost when the payout confirms, statement differences become
 * reconciliation disputes).
 */

const BAND_ISSUES = [
  "empty",
  "too_many",
  "not_ascending",
  "invalid_amount",
  "not_whole_shillings",
] as const;
export type TariffBandIssue = (typeof BAND_ISSUES)[number];

/** Problems with a band table: at least one band, strictly ascending, whole-shilling amounts. */
export function tariffBandIssues(bands: readonly TariffBand[]): TariffBandIssue[] {
  const issues = new Set<TariffBandIssue>();
  if (bands.length === 0) issues.add("empty");
  if (bands.length > TARIFF_LIMITS.maxBands) issues.add("too_many");
  let previous = 0;
  for (const band of bands) {
    if (
      !Number.isSafeInteger(band.upToMinor) ||
      !Number.isSafeInteger(band.chargeMinor) ||
      band.upToMinor <= 0 ||
      band.upToMinor > TARIFF_LIMITS.upToMaxMinor ||
      band.chargeMinor < 0 ||
      band.chargeMinor > TARIFF_LIMITS.chargeMaxMinor
    )
      issues.add("invalid_amount");
    else if (band.upToMinor % 100 !== 0 || band.chargeMinor % 100 !== 0)
      issues.add("not_whole_shillings");
    if (band.upToMinor <= previous) issues.add("not_ascending");
    previous = band.upToMinor;
  }
  return BAND_ISSUES.filter((issue) => issues.has(issue));
}

/**
 * The charge for paying `amountMinor`: the first band whose `upToMinor` is at or above it; null
 * when the amount is not positive or above the last band (the tariff cannot price it).
 */
export function tariffCharge(bands: readonly TariffBand[], amountMinor: number): number | null {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;
  return bands.find((band) => amountMinor <= band.upToMinor)?.chargeMinor ?? null;
}

/** The version in force on `date`: the latest `effectiveFrom` on or before it, else null. */
export function tariffVersionOn<T extends { effectiveFrom: string }>(
  versions: readonly T[],
  date: string,
): T | null {
  let found: T | null = null;
  for (const version of versions)
    if (version.effectiveFrom <= date && (!found || version.effectiveFrom > found.effectiveFrom))
      found = version;
  return found;
}
