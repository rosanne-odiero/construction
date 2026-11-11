import type { AccreditationStatus, ConsentStatus } from "@pm-buddy/types";
import {
  labourRegistryFiltersSchema,
  type LabourRegistryFilters,
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
] as const satisfies readonly (keyof LabourRegistryFilters)[];

/**
 * Reads registry filters from the page's search params; anything invalid is dropped. That
 * includes search text that could be an identifier (digits other than a worker number): such
 * terms are looked up through a request body instead, never through the URL.
 */
export function filtersFromSearchParams(
  raw: Record<string, string | string[] | undefined>,
): LabourRegistryFilters {
  const picked: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) picked[key] = value.trim();
  }
  const parsed = labourRegistryFiltersSchema.safeParse(picked);
  if (parsed.success) return parsed.data;
  // Keep the valid filters when one is malformed (e.g. a stale link).
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(picked))
    if (labourRegistryFiltersSchema.safeParse({ [key]: value }).success) kept[key] = value;
  return labourRegistryFiltersSchema.parse(kept);
}

/** The filters a saved view may store: everything except search text. */
export function viewFilters(filters: LabourRegistryFilters): LabourViewFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([key]) => key !== "search"),
  ) as LabourViewFilters;
}

/** A query string (without "?") for filters plus optional extras, in a stable order. */
export function labourQuery(
  filters: LabourRegistryFilters,
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
  filters: LabourRegistryFilters,
  extra: Record<string, string | number | undefined> = {},
) => {
  const query = labourQuery(filters, extra);
  return `/labour${query ? `?${query}` : ""}`;
};

/** Whether a view's filters equal the current filters (to highlight the active view). */
export function sameFilters(a: LabourRegistryFilters, b: LabourRegistryFilters): boolean {
  return labourQuery(a) === labourQuery(b);
}

/** The view whose filters match the current filters (search text narrows a view, it is not part of it). */
export function activeView(views: readonly LabourView[], filters: LabourRegistryFilters) {
  return views.find((view) => sameFilters(view.filters, viewFilters(filters))) ?? null;
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
