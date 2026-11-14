import { addCalendarDays, calendarDaysBetween } from "@pm-buddy/domain";
import {
  SUPPLIER_PORTAL_LIMITS,
  type SupplierInvoiceStatus,
  type SupplierPortalUserStatus,
} from "@pm-buddy/types";
import type { Tone } from "@/components/status-badge";

/**
 * Display helpers for the supplier portal (D7.2). Money stays in integer KES minor units and
 * dates in Nairobi calendar dates (YYYY-MM-DD).
 */

export const supplierInvoiceTone: Record<SupplierInvoiceStatus, Tone> = {
  submitted: "info",
  under_review: "info",
  disputed: "danger",
  approved: "success",
  partly_paid: "warning",
  paid: "success",
  cancelled: "neutral",
};

export const portalUserTone: Record<SupplierPortalUserStatus, Tone> = {
  invited: "info",
  active: "success",
  revoked: "neutral",
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The statement period a page shows, as the API computes it: `to` defaults to today and `from`
 * to the 89 days before; null when the dates are malformed, inverted or too far apart (the page
 * then explains the rule instead of calling the API with a request it refuses).
 */
export function statementPeriod(
  query: { from?: string; to?: string },
  today: string,
): { from: string; to: string } | null {
  const to = query.to ?? (query.from && query.from > today ? query.from : today);
  const from =
    query.from ?? addCalendarDays(to, -(SUPPLIER_PORTAL_LIMITS.statementDefaultDays - 1));
  if (!DATE.test(from) || !DATE.test(to) || from > to) return null;
  if (calendarDaysBetween(from, to) + 1 > SUPPLIER_PORTAL_LIMITS.statementMaxDays) return null;
  return { from, to };
}

/** The query string for a statement (and its exports): only the filters that are set. */
export function statementSearch(filters: {
  from?: string;
  to?: string;
  projectId?: string;
  locale?: string;
}): string {
  const params = new URLSearchParams();
  for (const key of ["projectId", "from", "to", "locale"] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * A UUID version 7 for the supplier's new invoice (RFC 9562: 48-bit Unix milliseconds, then
 * random bits), so portal invoices sort by submission time in lists ordered by ID, like the
 * server-made IDs of staff-recorded invoices.
 */
export function newTimeOrderedId(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (let index = 0; index < 6; index += 1)
    bytes[index] = Math.floor(now / 2 ** (8 * (5 - index))) % 256;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
