import { indicativeAmount } from "@pm-buddy/domain";
import type {
  ClientCertificateState,
  ClientRequestState,
  DisplayCurrency,
  FxCurrency,
} from "@pm-buddy/types";
import type { ClientDisplay } from "@pm-buddy/validation";
import type { Tone } from "../components/status-badge";

/**
 * Display helpers for the client portal (D7.1). Money stays in integer KES minor units; a foreign
 * currency is an indicative conversion at a dated rate finance entered (packages/domain
 * `indicativeAmount`, exact and rounded half away from zero to the cent), never a payable amount.
 */

const grouped = new Intl.NumberFormat("en-GB", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Foreign minor units as "USD 953.70" (the code first, as the KES amounts are shown). */
export function formatForeignMinor(minor: number, currency: FxCurrency): string {
  const sign = minor < 0 ? "\u2212" : "";
  return `${sign}${currency} ${grouped.format(Math.abs(minor) / 100)}`;
}

/**
 * A rate without trailing zeros: "129.4500" → "129.45", "170.1000" → "170.1", "150.0000" →
 * "150". A linear scan from the end (no regular expression on the value).
 */
export function formatRate(kesPerUnit: string): string {
  if (!kesPerUnit.includes(".")) return kesPerUnit;
  let end = kesPerUnit.length;
  while (end > 0 && kesPerUnit[end - 1] === "0") end -= 1;
  if (kesPerUnit[end - 1] === ".") end -= 1;
  return kesPerUnit.slice(0, end);
}

export type IndicativeText = {
  amount: string;
  rate: string;
  currency: FxCurrency;
  rateDate: string;
};

/**
 * The parts of "≈ USD 1,234.00 at 129.45 KES/USD on 14/11/2026 (indicative)" for a KES amount, or
 * null when amounts are shown in KES only or no usable rate exists (the page then says the
 * conversion is not available).
 */
export function indicative(
  kesMinor: number | null,
  display: ClientDisplay,
  today: string,
): IndicativeText | null {
  if (display.currency === "KES" || !display.rate) return null;
  const converted = indicativeAmount(kesMinor, display.rate, today);
  if (!converted) return null;
  return {
    amount: formatForeignMinor(converted.minor, converted.currency),
    rate: formatRate(converted.kesPerUnit),
    currency: converted.currency,
    rateDate: converted.rateDate,
  };
}

/** Whether the caller chose a foreign currency that has no usable rate today. */
export const conversionUnavailable = (display: ClientDisplay): boolean =>
  display.currency !== "KES" && display.rate === null;

export const DISPLAY_CHOICES: readonly DisplayCurrency[] = ["KES", "USD", "GBP", "EUR"];

/** A percentage string from the API as a bar width (0–100), or null when not available. */
export function barWidth(percent: string | null): number | null {
  if (percent === null) return null;
  const value = Number(percent);
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

export const certificateTone = (state: ClientCertificateState, overdue: boolean): Tone =>
  overdue
    ? "danger"
    : state === "paid"
      ? "success"
      : state === "nothing_due"
        ? "info"
        : state === "part_paid"
          ? "warning"
          : state === "credit"
            ? "info"
            : "neutral";

export const requestTone: Record<ClientRequestState, Tone> = {
  awaiting_decision: "warning",
  approved: "success",
  rejected: "danger",
  withdrawn: "neutral",
};

/** The client portal's project pages, in the order of the project navigation. */
export const CLIENT_SECTIONS = [
  "overview",
  "progress",
  "photos",
  "diaries",
  "statement",
  "pay",
  "variations",
] as const;
export type ClientSection = (typeof CLIENT_SECTIONS)[number];

export const sectionHref = (projectId: string, section: ClientSection): string =>
  section === "overview"
    ? `/portal/projects/${projectId}`
    : `/portal/projects/${projectId}/${section}`;

/** The query string for a client page that overrides the display currency. */
export function currencySearch(currency: DisplayCurrency | undefined): string {
  return currency ? `?currency=${currency}` : "";
}

/** `?currency=` from a page's search parameters, when it is one the portal offers. */
export function parseCurrency(value: string | string[] | undefined): DisplayCurrency | undefined {
  return typeof value === "string" && (DISPLAY_CHOICES as readonly string[]).includes(value)
    ? (value as DisplayCurrency)
    : undefined;
}
