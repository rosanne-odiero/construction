import {
  MINIMUM_LABOURER_AGE_YEARS,
  type AccreditationStatus,
  type IdDocumentType,
  type RateBasis,
} from "@pm-buddy/types";

/**
 * Labour registry rules (D3.1): age on the registration date, NCA accreditation expiry, identifier
 * normalisation for blind indexes and masking, and effective-dated rate resolution. Pure functions
 * on calendar dates (YYYY-MM-DD in Africa/Nairobi), shared by the API, web and database tests.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(isoDate: string): [number, number, number] {
  const match = ISO_DATE.exec(isoDate);
  if (!match) throw new TypeError(`Expected a YYYY-MM-DD date, got "${isoDate}"`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");
const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Calendar arithmetic without time zones: `addCalendarDays("2026-02-28", 1)` is "2026-03-01". */
export function addCalendarDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  const moved = new Date(Date.UTC(y, m - 1, d + days));
  return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function calendarDaysBetween(from: string, to: string): number {
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/**
 * The latest date of birth that is old enough on `onDate`: the same day `years` earlier, clamped to
 * the end of a shorter month. On 28/02/2026 that is 28/02/2008, so someone born on 29/02/2008 turns
 * 18 on 01/03/2026. Identical to PostgreSQL's `onDate - interval '18 years'`, which the database
 * constraint uses.
 */
export function latestAllowedBirthDate(
  onDate: string,
  years: number = MINIMUM_LABOURER_AGE_YEARS,
): string {
  const [y, m, d] = parts(onDate);
  const year = y - years;
  return `${pad(year, 4)}-${pad(m)}-${pad(Math.min(d, daysInMonth(year, m)))}`;
}

/** Brief §6: nobody under 18 on the registration date (Africa/Nairobi) can be registered. */
export function isOldEnoughToRegister(
  dateOfBirth: string,
  onDate: string,
  years: number = MINIMUM_LABOURER_AGE_YEARS,
): boolean {
  parts(dateOfBirth);
  return dateOfBirth <= latestAllowedBirthDate(onDate, years);
}

/** One accreditation card on a day: expired after its expiry date, expiring within the lead time. */
export function accreditationStatus(
  expiresOn: string,
  today: string,
  alertDays: number,
): Extract<AccreditationStatus, "valid" | "expiring" | "expired"> {
  if (expiresOn < today) return "expired";
  if (expiresOn <= addCalendarDays(today, alertDays)) return "expiring";
  return "valid";
}

export type AccreditationSummary = {
  status: AccreditationStatus;
  expiresOn: string | null;
  /** Days from today to the expiry date (negative once expired). */
  daysLeft: number | null;
};

/**
 * A labourer's accreditation state: the card that expires last decides. Without a card the state
 * is `missing` when the skill level expects one (skilled workers, site supervisors), otherwise
 * `not_required`. COMPLIANCE-REVIEW: CR-NCA-03 (which roles need NCA accreditation).
 */
export function summariseAccreditation(
  cards: readonly { expiresOn: string }[],
  accreditationExpected: boolean,
  today: string,
  alertDays: number,
): AccreditationSummary {
  if (!cards.length)
    return {
      status: accreditationExpected ? "missing" : "not_required",
      expiresOn: null,
      daysLeft: null,
    };
  const latest = cards.reduce((best, card) => (card.expiresOn > best.expiresOn ? card : best));
  return {
    status: accreditationStatus(latest.expiresOn, today, alertDays),
    expiresOn: latest.expiresOn,
    daysLeft: calendarDaysBetween(today, latest.expiresOn),
  };
}

const compact = (value: string) => value.replace(/[\s./-]/g, "").toUpperCase();

/**
 * Canonical form of an identity document number, used for the blind index (duplicate and
 * do-not-rehire matching) and for encryption. Null when the value cannot be a valid number.
 * Kenyan national IDs are digits (up to 9); alien IDs and passports are letters and digits.
 */
export function normaliseIdNumber(type: IdDocumentType, value: string): string | null {
  const candidate = compact(value);
  if (type === "national_id") return /^\d{6,9}$/.test(candidate) ? candidate : null;
  if (!/^[A-Z0-9]{6,12}$/.test(candidate) || !/\d/.test(candidate)) return null;
  return candidate;
}

/** KRA PINs: a letter (A for individuals), nine digits and a check letter, e.g. A012345678Z. */
export function normaliseKraPin(value: string): string | null {
  const candidate = compact(value);
  return /^[AP]\d{9}[A-Z]$/.test(candidate) ? candidate : null;
}

/** NSSF and SHA member numbers: 4–20 letters and digits. COMPLIANCE-REVIEW: formats unverified. */
export function normaliseStatutoryNumber(value: string): string | null {
  const candidate = compact(value);
  return /^[A-Z0-9]{4,20}$/.test(candidate) && /\d/.test(candidate) ? candidate : null;
}

/** Default display of an identifier: only the last three characters, e.g. "•••••678". */
export function maskIdentifier(value: string, visible = 3): string {
  return `•••••${value.slice(-visible)}`;
}

/** Most specific first. A labourer's own rate applies on one project only. */
export const RATE_SCOPES = [
  "labourer",
  "project_skill",
  "project_trade",
  "company_skill",
  "company_trade",
] as const;
export type RateScope = (typeof RATE_SCOPES)[number];

export type RateCandidate = {
  id: string;
  projectId: string | null;
  labourerId: string | null;
  tradeId: string | null;
  skillLevelId: string | null;
  basis: RateBasis;
  rateMinor: number;
  /** First day the rate applies (Africa/Nairobi). A rate applies until the next one of its kind. */
  effectiveFrom: string;
};

export type RateQuery = {
  onDate: string;
  basis: RateBasis;
  projectId: string | null;
  labourerId: string | null;
  tradeId: string | null;
  skillLevelId: string | null;
};

/** The scope a rate row was set at, from its shape. */
export function rateScopeOf(rate: Omit<RateCandidate, "rateMinor" | "id">): RateScope {
  if (rate.labourerId) return "labourer";
  if (rate.projectId) return rate.skillLevelId ? "project_skill" : "project_trade";
  return rate.skillLevelId ? "company_skill" : "company_trade";
}

/**
 * Rows with the same key form one effective-dated history (the database computes the same
 * `scope_key`): a newer row starts a new rate, it never overwrites the one before it.
 */
export function rateKey(rate: Omit<RateCandidate, "rateMinor" | "id" | "effectiveFrom">): string {
  return [rate.projectId, rate.labourerId, rate.tradeId, rate.skillLevelId, rate.basis]
    .map((part) => part ?? "-")
    .join("|");
}

function applies(rate: RateCandidate, query: RateQuery): boolean {
  if (rate.basis !== query.basis || rate.effectiveFrom > query.onDate) return false;
  switch (rateScopeOf(rate)) {
    case "labourer":
      return rate.labourerId === query.labourerId && rate.projectId === query.projectId;
    case "project_skill":
      return (
        rate.projectId === query.projectId &&
        rate.tradeId === query.tradeId &&
        rate.skillLevelId === query.skillLevelId
      );
    case "project_trade":
      return rate.projectId === query.projectId && rate.tradeId === query.tradeId;
    case "company_skill":
      return rate.tradeId === query.tradeId && rate.skillLevelId === query.skillLevelId;
    case "company_trade":
      return rate.tradeId === query.tradeId;
  }
}

/**
 * The rate in force for a labourer on a date: the most specific scope that has a rate in force
 * (a labourer's own rate on the project, then the project's trade and skill rate, the project's
 * trade rate, the company's trade and skill rate, the company's trade rate); within that scope the
 * row with the latest `effectiveFrom` on or before the date. Null when nothing applies.
 */
export function resolveRate<T extends RateCandidate>(
  candidates: readonly T[],
  query: RateQuery,
): { rate: T; scope: RateScope } | null {
  let best: { rate: T; scope: RateScope; rank: number } | null = null;
  for (const rate of candidates) {
    if (!applies(rate, query)) continue;
    const scope = rateScopeOf(rate);
    const rank = RATE_SCOPES.indexOf(scope);
    if (
      !best ||
      rank < best.rank ||
      (rank === best.rank && rate.effectiveFrom > best.rate.effectiveFrom)
    )
      best = { rate, scope, rank };
  }
  return best ? { rate: best.rate, scope: best.scope } : null;
}

/** The last day a rate applies: the day before the next row of its kind starts (null if none). */
export function rateEffectiveTo<T extends RateCandidate>(
  rate: T,
  all: readonly T[],
): string | null {
  const key = rateKey(rate);
  const next = all
    .filter((other) => rateKey(other) === key && other.effectiveFrom > rate.effectiveFrom)
    .reduce<string | null>(
      (earliest, other) =>
        earliest === null || other.effectiveFrom < earliest ? other.effectiveFrom : earliest,
      null,
    );
  return next ? addCalendarDays(next, -1) : null;
}
