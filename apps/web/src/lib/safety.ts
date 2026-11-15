import {
  SAFETY_READ_PERMISSIONS,
  SAFETY_RECORD_PERMISSIONS,
  type CorrectiveActionStatus,
  type IncidentSeverity,
  type IncidentStatus,
  type InductionState,
  type KitState,
  type PpeReplacementState,
  type RegulatorState,
  type ToolboxTalkStatus,
  type CertificateState,
} from "@pm-buddy/types";
import type { Tone } from "@/components/status-badge";
import { parseCalendarInput } from "./project-input";

/** Display and input helpers for the health and safety screens (D8.2). */

export const SAFETY_VIEWS = [
  "incidents",
  "actions",
  "inductions",
  "talks",
  "ppe",
  "first-aid",
] as const;
export type SafetyView = (typeof SAFETY_VIEWS)[number];

/** The rules the API applies to a caller's project permissions (decision D-70). */
export function safetyAccess(permissions: readonly string[]) {
  const has = (list: readonly string[]) => list.some((key) => permissions.includes(key));
  return {
    read: permissions.includes("projects.view") && has(SAFETY_READ_PERMISSIONS),
    record: has(SAFETY_RECORD_PERMISSIONS),
    manage: permissions.includes("safety.manage"),
  };
}

/** The safety area of a project, with optional filters kept in the URL. */
export function safetyHref(
  projectId: string,
  view: SafetyView,
  params: Record<string, string | undefined> = {},
): string {
  const query = new URLSearchParams({ tab: "safety" });
  if (view !== "incidents") query.set("view", view);
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  return `/projects/${projectId}?${query.toString()}`;
}

/** "07:5" or "7:05" typed on site → "07:05"; null when it is not a time of day. */
export function parseTimeInput(text: string): string | null {
  const match = /^(\d{1,2})[:.](\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * A date (DD/MM/YYYY) and time (HH:MM) typed in Nairobi as an ISO moment with the +03:00 offset
 * (Kenya has no daylight saving), or null when either is not valid.
 */
export function nairobiMoment(dateText: string, timeText: string): string | null {
  const date = parseCalendarInput(dateText);
  const time = parseTimeInput(timeText);
  if (!date || !time) return null;
  return `${date}T${time}:00+03:00`;
}

/** A whole number typed in a form (trimmed), within bounds; null otherwise. */
export function parseWholeNumber(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

/** An empty optional field is "not given"; otherwise the parsed number (null when invalid). */
export function parseOptionalWhole(
  text: string,
  min: number,
  max: number,
): number | null | undefined {
  return text.trim() === "" ? undefined : parseWholeNumber(text, min, max);
}

export const incidentStatusTone: Record<IncidentStatus, Tone> = {
  reported: "warning",
  investigated: "info",
  closed: "success",
  voided: "neutral",
};
export const incidentSeverityTone: Record<IncidentSeverity, Tone> = {
  minor: "neutral",
  moderate: "warning",
  serious: "danger",
  fatal: "danger",
};
export const actionStatusTone: Record<CorrectiveActionStatus, Tone> = {
  open: "warning",
  done: "info",
  verified: "success",
  cancelled: "neutral",
};
export const talkStatusTone: Record<ToolboxTalkStatus, Tone> = {
  draft: "neutral",
  confirmed: "success",
  cancelled: "neutral",
};
export const inductionStateTone: Record<InductionState, Tone> = {
  valid: "success",
  expired: "warning",
  none: "danger",
};
export const ppeStateTone: Record<PpeReplacementState, Tone> = {
  ok: "success",
  due_soon: "warning",
  due: "danger",
};
export const kitStateTone: Record<KitState, Tone> = {
  ok: "success",
  expiring: "warning",
  check_due: "warning",
  expired: "danger",
  never_checked: "danger",
  retired: "neutral",
};
export const certificateTone: Record<CertificateState, Tone> = {
  valid: "success",
  expiring: "warning",
  expired: "danger",
};
export const regulatorTone: Record<RegulatorState, Tone> = {
  not_required: "neutral",
  required: "danger",
  notified: "success",
  not_notifiable: "info",
};
