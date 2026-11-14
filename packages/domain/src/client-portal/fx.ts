import { CLIENT_PORTAL_LIMITS, type FxCurrency } from "@pm-buddy/types";
import { calendarDaysBetween } from "../labour.js";

/**
 * Indicative foreign-currency display for diaspora clients (D7.1, rule D-136). Finance enters
 * dated rates as KES per unit (for example 129.45 KES per US dollar) with a source note; nothing
 * calls an external FX service. Conversions are for display only: amounts due, receipts and
 * statements stay in KES (brief §15 C: foreign-currency display never changes KES amounts).
 *
 * Arithmetic is exact: the rate is held as an integer of ten-thousandths, and KES minor units ÷
 * rate gives the foreign currency's minor units (cents/pence), rounded half away from zero.
 */

const SCALE = 10_000n;
const RATE = /^\d{1,5}(?:\.\d{1,4})?$/;

/**
 * The rate as ten-thousandths of a shilling per unit (129.45 → 1,294,500n), or null when it is
 * not a plain decimal with at most four places within the allowed range.
 */
export function parseFxRate(text: string): bigint | null {
  if (!RATE.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const scaled = BigInt(whole!) * SCALE + BigInt(fraction.padEnd(4, "0"));
  const { min, max } = CLIENT_PORTAL_LIMITS.fxRate;
  if (scaled < BigInt(min) * SCALE || scaled > BigInt(max) * SCALE) return null;
  return scaled;
}

/** The canonical text of a valid rate with four decimal places ("129.45" → "129.4500"). */
export function canonicalFxRate(text: string): string {
  const scaled = parseFxRate(text);
  if (scaled === null) throw new RangeError("An FX rate is KES per unit between 1 and 10,000");
  return `${scaled / SCALE}.${String(scaled % SCALE).padStart(4, "0")}`;
}

/**
 * KES minor units in the foreign currency's minor units at `kesPerUnit` (exact, rounded half away
 * from zero to the cent). 12,345,600 KES cents (KES 123,456.00) at 129.45 is USD 953.70.
 */
export function kesToForeignMinor(kesMinor: number, kesPerUnit: string): number {
  if (!Number.isSafeInteger(kesMinor)) throw new RangeError("KES amounts are whole minor units");
  const rate = parseFxRate(kesPerUnit);
  if (rate === null) throw new RangeError("An FX rate is KES per unit between 1 and 10,000");
  const negative = kesMinor < 0;
  const scaled = BigInt(Math.abs(kesMinor)) * SCALE;
  let quotient = scaled / rate;
  if ((scaled % rate) * 2n >= rate) quotient += 1n;
  const value = Number(quotient);
  return negative ? -value : value;
}

/**
 * Whether a rate dated `rateDate` may be shown on `today` (Nairobi dates): not in the future and
 * at most `maxAgeDays` old. An older rate is not shown at all: the amount says "not available".
 */
export function fxRateUsable(
  rateDate: string,
  today: string,
  maxAgeDays: number = CLIENT_PORTAL_LIMITS.fxMaxAgeDays,
): boolean {
  const age = calendarDaysBetween(rateDate, today);
  return age >= 0 && age <= maxAgeDays;
}

export type FxRateInput = { currency: FxCurrency; kesPerUnit: string; rateDate: string };

export type IndicativeAmount = {
  currency: FxCurrency;
  minor: number;
  kesPerUnit: string;
  rateDate: string;
};

/**
 * The indicative amount for a KES figure, or null when there is no usable rate (none entered, in
 * the future or too old) or the KES figure itself is not available.
 */
export function indicativeAmount(
  kesMinor: number | null,
  rate: FxRateInput | null,
  today: string,
): IndicativeAmount | null {
  if (kesMinor === null || !rate || !fxRateUsable(rate.rateDate, today)) return null;
  return {
    currency: rate.currency,
    minor: kesToForeignMinor(kesMinor, rate.kesPerUnit),
    kesPerUnit: canonicalFxRate(rate.kesPerUnit),
    rateDate: rate.rateDate,
  };
}
