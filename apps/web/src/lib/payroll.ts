import type { z } from "zod";
import { formatDuration } from "@pm-buddy/domain";
import type { PayrollBatchStatus, AdvanceDisplayStatus, OutputStatus } from "@pm-buddy/types";
import type { Tone } from "@/components/status-badge";
import { liveRequest } from "./live-api";

/**
 * Payroll helpers for the live pages (D4.1). Money is integer KES minor units from the API and is
 * only formatted here; nothing is recomputed in the browser.
 */

/**
 * A state-changing payroll command with a fresh Idempotency-Key, so the one automatic retry after
 * a session refresh (or a double click reaching the API twice) is answered with the stored result.
 */
export function payrollCommand<T>(
  path: string,
  schema: z.ZodType<T>,
  body: Record<string, unknown>,
  method: "POST" | "PUT" | "DELETE" = "POST",
): Promise<T> {
  return liveRequest(path, schema, {
    method,
    body,
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
}

/** Minutes as h:mm (485 → "8:05"). */
export const hours = (minutes: number) => formatDuration(minutes);

export const batchTone: Record<PayrollBatchStatus, Tone> = {
  draft: "neutral",
  submitted: "info",
  cancelled: "danger",
};

export const advanceTone: Record<AdvanceDisplayStatus, Tone> = {
  requested: "warning",
  approved: "info",
  rejected: "danger",
  cancelled: "neutral",
  disbursed: "info",
  recovering: "warning",
  recovered: "success",
};

export const outputTone: Record<OutputStatus, Tone> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
};

/** "2026-11" → "11/2026" (the statutory month as shown). */
export const formatMonth = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;

/** The current statutory month in Africa/Nairobi ("YYYY-MM") from an ISO date. */
export const monthOf = (date: string) => date.slice(0, 7);

/** A whole-shilling or decimal KES amount typed by a user ("1,250.50") → minor units, or null. */
export function kesInputToMinor(value: string): number | null {
  const cleaned = value.replace(/[,\s]/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
