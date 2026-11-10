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

/** Normalises Kenyan mobile numbers to 2547XXXXXXXX / 2541XXXXXXXX, or returns null. */
export function normalizeKenyanPhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  let candidate = digits;
  if (digits.length === 10 && digits.startsWith("0")) candidate = `254${digits.slice(1)}`;
  else if (digits.length === 9 && /^[71]/.test(digits)) candidate = `254${digits}`;
  return /^254[71]\d{8}$/.test(candidate) ? candidate : null;
}

export function maskPhone(normalised: string): string {
  return `${normalised.slice(0, 4)}•••••${normalised.slice(-3)}`;
}

export function maskId(idNumber: string): string {
  return `••••${idNumber.slice(-4)}`;
}

export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}
