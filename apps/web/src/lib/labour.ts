import type { AccreditationStatus, ConsentStatus } from "@pm-buddy/types";
import {
  labourViewFiltersSchema,
  type LabourView,
  type LabourViewFilters,
} from "@pm-buddy/validation";
import type { Tone } from "@/components/status-badge";

/** Registry rows per page. */
export const LABOUR_PAGE_SIZE = 50;

const FILTER_KEYS = [
  "search",
  "status",
  "tradeId",
  "skillLevelId",
  "projectId",
  "gangId",
  "accreditation",
  "consent",
  "doNotRehire",
] as const satisfies readonly (keyof LabourViewFilters)[];

/** Reads registry filters from the page's search params; anything invalid is dropped. */
export function filtersFromSearchParams(
  raw: Record<string, string | string[] | undefined>,
): LabourViewFilters {
  const picked: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) picked[key] = value.trim();
  }
  const parsed = labourViewFiltersSchema.safeParse(picked);
  if (parsed.success) return parsed.data;
  // Keep the valid filters when one is malformed (e.g. a stale link).
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(picked))
    if (labourViewFiltersSchema.safeParse({ [key]: value }).success) kept[key] = value;
  return labourViewFiltersSchema.parse(kept);
}

/** A query string (without "?") for filters plus optional extras, in a stable order. */
export function labourQuery(
  filters: LabourViewFilters,
  extra: Record<string, string | number | undefined> = {},
): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  for (const [key, value] of Object.entries(extra))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params.toString();
}

export const registryHref = (
  filters: LabourViewFilters,
  extra: Record<string, string | number | undefined> = {},
) => {
  const query = labourQuery(filters, extra);
  return `/labour${query ? `?${query}` : ""}`;
};

/** Whether a view's filters equal the current filters (to highlight the active view). */
export function sameFilters(a: LabourViewFilters, b: LabourViewFilters): boolean {
  return labourQuery(a) === labourQuery(b);
}

/** The view whose filters match, preferring built-in views. */
export function activeView(views: readonly LabourView[], filters: LabourViewFilters) {
  return views.find((view) => sameFilters(view.filters, filters)) ?? null;
}

export const accreditationTone: Record<AccreditationStatus, Tone> = {
  valid: "success",
  expiring: "warning",
  expired: "danger",
  missing: "warning",
  not_required: "neutral",
};

export const consentTone: Record<ConsentStatus, Tone> = {
  granted: "success",
  withdrawn: "danger",
  missing: "warning",
};

/** "254700000001" style masks keep their bullets; nothing else is shown. */
export const isMasked = (value: string | null) => value === null || value.includes("•");
