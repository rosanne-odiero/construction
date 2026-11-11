/**
 * Display formatters for the Kenyan market (brief §9):
 * KES 1,250,000 · DD/MM/YYYY · Africa/Nairobi · phones normalised to 2547XXXXXXXX / 2541XXXXXXXX.
 * Money is always passed around as integer minor units (cents), never floats.
 */

export const NAIROBI_TZ = "Africa/Nairobi";

const wholeShillings = new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 });
const withCents = new Intl.NumberFormat("en-KE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const compact = new Intl.NumberFormat("en-KE", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const plainNumber = new Intl.NumberFormat("en-KE", { maximumFractionDigits: 2 });

const MINUS = "\u2212";

export function formatKES(amountMinor: number): string {
  const sign = amountMinor < 0 ? MINUS : "";
  const abs = Math.abs(amountMinor);
  const body = abs % 100 === 0 ? wholeShillings.format(abs / 100) : withCents.format(abs / 100);
  return `${sign}KES ${body}`;
}

export function formatKESCompact(amountMinor: number): string {
  const sign = amountMinor < 0 ? MINUS : "";
  return `${sign}KES ${compact.format(Math.abs(amountMinor) / 100)}`;
}

export function formatForeign(
  amountMinorKES: number,
  currency: "USD" | "GBP" | "EUR",
  kesPerUnit: number,
) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amountMinorKES / 100 / kesPerUnit);
}

/** A decimal string (quantity or rate) with thousands separators, digits unchanged. */
export function formatDecimalString(value: string): string {
  const negative = value.startsWith("-");
  const [whole = "0", fraction] = value.replace(/^-/, "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? MINUS : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

/** "947400.00" (a report value in KES) → integer minor units, without floating point. */
export function decimalKesToMinor(value: string): number | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const minor = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] ? -minor : minor;
}

export function formatNumber(value: number): string {
  return plainNumber.format(value);
}

export function formatPercent(ratio: number, digits = 0): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: NAIROBI_TZ,
});
const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: NAIROBI_TZ,
});

function toDate(value: string | Date): Date {
  return typeof value === "string" ? new Date(value) : value;
}

export function formatDate(value: string | Date): string {
  return dateFmt.format(toDate(value));
}

export function formatTime(value: string | Date): string {
  return timeFmt.format(toDate(value));
}

export function formatDateTime(value: string | Date): string {
  return `${formatDate(value)} ${formatTime(value)}`;
}

export function formatWeekdayDate(value: string | Date, locale: string): string {
  const weekday = new Intl.DateTimeFormat(locale === "sw" ? "sw-KE" : "en-GB", {
    weekday: "long",
    timeZone: NAIROBI_TZ,
  }).format(toDate(value));
  return `${weekday}, ${formatDate(value)}`;
}

// Canonical 2547XXXXXXXX / 2541XXXXXXXX handling is shared with the API (packages/domain).
export { maskPhone, normalizeKenyanPhone } from "@pm-buddy/domain";

export function maskId(idNumber: string): string {
  return `••••${idNumber.slice(-4)}`;
}

export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

/** A business calendar date (YYYY-MM-DD) as DD/MM/YYYY, without any time-zone conversion. */
export function formatCalendarDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

const areaFmt = new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 });
const hectareFmt = new Intl.NumberFormat("en-KE", { maximumFractionDigits: 2 });

/** Square metres below one hectare, then hectares: "2,925 m²", "3.14 ha". */
export function formatArea(squareMetres: number): string {
  return squareMetres < 10_000
    ? `${areaFmt.format(squareMetres)} m²`
    : `${hectareFmt.format(squareMetres / 10_000)} ha`;
}

/** Metres below one kilometre, then kilometres: "234 m", "1.26 km". */
export function formatLength(metres: number): string {
  return metres < 1_000 ? `${areaFmt.format(metres)} m` : `${hectareFmt.format(metres / 1_000)} km`;
}

/** Basis points as a percentage with up to two decimals: 2550 → "25.5%". */
export function formatBasisPoints(basisPoints: number): string {
  return `${hectareFmt.format(basisPoints / 100)}%`;
}
