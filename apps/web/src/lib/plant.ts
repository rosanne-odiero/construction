import { formatTenths, parseTenths } from "@pm-buddy/domain";
import {
  PLANT_FUEL_PERMISSIONS,
  PLANT_LIMITS,
  PLANT_READ_PERMISSIONS,
  PLANT_RECORD_PERMISSIONS,
  type BreakdownStatus,
  type FuelWindowState,
  type OperatorCertificateState,
  type PlantAlertSeverity,
  type PlantRecordState,
  type PlantStatus,
  type ServiceState,
} from "@pm-buddy/types";
import type { Tone } from "@/components/status-badge";
import { FoundationApiError } from "./foundation-api";

/** Display and input helpers for the plant and equipment screens (D8.3). */

/** The rules the API applies to a caller's project permissions (decision D-90). */
export function plantAccess(permissions: readonly string[]) {
  const has = (list: readonly string[]) => list.some((key) => permissions.includes(key));
  return {
    read: permissions.includes("projects.view") && has(PLANT_READ_PERMISSIONS),
    record: has(PLANT_RECORD_PERMISSIONS),
    fuel: has(PLANT_FUEL_PERMISSIONS),
    manage: permissions.includes("plant.manage"),
  };
}

export const plantTabHref = (projectId: string, saved?: "usage" | "fuel") =>
  `/projects/${projectId}?tab=plant${saved ? `&saved=${saved}` : ""}`;

/**
 * A meter reading or litres typed on site: digits with at most one decimal place (a decimal point,
 * no thousands separators), within `max` tenths; normalised to one decimal ("1208" → "1208.0").
 */
export function parseTenthsInput(
  text: string,
  min = 0,
  max: number = PLANT_LIMITS.maxReadingTenths,
) {
  const value = parseTenths(text.replace(/\s+/g, ""), max);
  return value === null || value < min ? null : formatTenths(value);
}
export const parseLitresInput = (text: string) =>
  parseTenthsInput(text, 1, PLANT_LIMITS.maxLitresTenths);

/** Hours or km between two typed readings ("8.5"), or null while either is not valid. */
export function runBetween(start: string, end: string): string | null {
  const from = parseTenths(start.trim());
  const to = parseTenths(end.trim());
  return from === null || to === null || to < from ? null : formatTenths(to - from);
}

/**
 * What a site form does with its record ID and Idempotency-Key after a failed submit
 * (offline-ready contract): a collision with its own ID or key means an earlier attempt was
 * recorded; any other refusal recorded nothing, so the corrected form is a new request; a dropped
 * connection or a server error keeps both, so a retry cannot record twice.
 */
export function recordRetryPlan(error: unknown): "recorded" | "renew" | "keep" {
  if (!(error instanceof FoundationApiError)) return "keep";
  if (
    error.code === "idempotency-key-reused" ||
    error.code === "usage-id-conflict" ||
    error.code === "fuel-id-conflict"
  )
    return "recorded";
  return error.status >= 400 && error.status < 500 ? "renew" : "keep";
}

/** "+30.0 %" / "−7.1 %" for a variance string from the API. */
export function signedPercent(value: string): string {
  return value.startsWith("-") ? `−${value.slice(1)} %` : `+${value} %`;
}

export const plantStatusTone: Record<PlantStatus, Tone> = {
  available: "info",
  on_site: "success",
  under_repair: "warning",
  off_hire: "neutral",
  disposed: "neutral",
};
export const alertTone: Record<PlantAlertSeverity, Tone> = {
  critical: "danger",
  warning: "warning",
};
export const serviceTone: Record<ServiceState, Tone> = {
  not_scheduled: "neutral",
  ok: "success",
  due: "warning",
  overdue: "danger",
};
export const windowTone: Record<FuelWindowState, Tone> = {
  within_standard: "success",
  over_standard: "warning",
  short_sample: "neutral",
};
export const certificateTone: Record<OperatorCertificateState, Tone> = {
  not_required: "neutral",
  valid: "success",
  expiring: "warning",
  expired: "danger",
  missing: "danger",
};
export const breakdownTone: Record<BreakdownStatus, Tone> = {
  open: "danger",
  repaired: "success",
  off_hire: "neutral",
  written_off: "neutral",
};
export const recordTone: Record<PlantRecordState, Tone> = {
  current: "success",
  superseded: "neutral",
  voided: "neutral",
};
