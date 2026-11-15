import { strengthTenths, suggestedSlumpTolerance } from "@pm-buddy/domain";
import {
  QUALITY_LIMITS,
  QUALITY_READ_PERMISSIONS,
  QUALITY_RECORD_PERMISSIONS,
  type CubeAgeState,
  type CubeOutcome,
  type InspectionStatus,
  type SnagSeverity,
  type SnagStatus,
} from "@pm-buddy/types";
import type { Tone } from "@/components/status-badge";

/** Display and input helpers for the quality screens (D6.1). */

export const QUALITY_VIEWS = ["inspections", "tests", "snags", "completion"] as const;
export type QualityView = (typeof QUALITY_VIEWS)[number];

/** The rules the API applies to a caller's project permissions (decision D-60). */
export function qualityAccess(permissions: readonly string[]) {
  const has = (list: readonly string[]) => list.some((key) => permissions.includes(key));
  return {
    read: has(QUALITY_READ_PERMISSIONS),
    record: has(QUALITY_RECORD_PERMISSIONS),
    review: permissions.includes("quality.manage"),
    propose: permissions.includes("projects.manage"),
  };
}

/**
 * Cube strengths typed on site: "27.5, 28 26.8" → ["27.5", "28", "26.8"]. Commas, spaces or
 * semicolons separate values; each is 0–150 N/mm² with at most one decimal; 1–6 values. Null
 * when anything is off (the form then says what is expected).
 */
export function parseStrengths(text: string): string[] | null {
  const values = text
    .trim()
    .split(/[\s,;]+/)
    .filter((value) => value !== "");
  if (!values.length || values.length > QUALITY_LIMITS.maxCubesPerAge) return null;
  for (const value of values) {
    const tenths = strengthTenths(value);
    if (tenths === null || tenths > QUALITY_LIMITS.maxCubeStrength * 10) return null;
  }
  return values;
}

/** A whole number typed in a form (trimmed), within bounds; null otherwise. */
export function parseWhole(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

/** The tolerance suggested for a typed target slump, or null while the target is not valid. */
export function slumpToleranceFor(targetText: string): number | null {
  const target = parseWhole(targetText, 10, QUALITY_LIMITS.maxSlumpTargetMm);
  return target === null ? null : suggestedSlumpTolerance(target);
}

export const inspectionTone: Record<InspectionStatus, Tone> = {
  draft: "neutral",
  submitted: "info",
  signed_off: "success",
};
export const snagStatusTone: Record<SnagStatus, Tone> = {
  open: "warning",
  fixed: "info",
  closed: "success",
};
export const severityTone: Record<SnagSeverity, Tone> = {
  critical: "danger",
  major: "warning",
  minor: "neutral",
};
export const cubeOutcomeTone: Record<CubeOutcome, Tone> = {
  pass: "success",
  fail: "danger",
  indicative_ok: "info",
  indicative_low: "warning",
};
export const cubeStateTone: Record<CubeAgeState, Tone> = {
  not_due: "neutral",
  due: "info",
  overdue: "danger",
  recorded: "success",
};

export const photoThumbnail = (projectId: string, photoId: string) =>
  `/api/v1/projects/${projectId}/photos/${photoId}/thumbnail`;

/** The quality area of a project, with optional filters kept in the URL. */
export function qualityHref(
  projectId: string,
  view: QualityView,
  params: Record<string, string | undefined> = {},
): string {
  const query = new URLSearchParams({ tab: "quality" });
  if (view !== "inspections") query.set("view", view);
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  return `/projects/${projectId}?${query.toString()}`;
}
