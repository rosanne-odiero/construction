import "server-only";
import { redirect } from "next/navigation";
import type { z } from "zod";
import {
  projectsResponseSchema,
  sitesResponseSchema,
  unitsResponseSchema,
  type UnitWire,
} from "@pm-buddy/validation";
import { signInHref } from "./safe-next";
import { serverApi, type ServerApiResult } from "./server-api";

/** Server-side loaders shared by the procure-to-pay pages (D5.2). */

export type ProjectOption = { id: string; code: string; name: string };
export type SiteOption = { id: string; name: string };

/** Projects the caller can see (for filters and pickers); empty when the call fails. */
export async function projectOptions(): Promise<ProjectOption[]> {
  const result = await serverApi("/projects", projectsResponseSchema);
  if (!result.ok) return [];
  return result.data.projects.map(({ id, code, name }) => ({ id, code, name }));
}

/** Each project's sites (at most 30 projects; a failed call leaves that project without sites). */
export async function sitesByProject(
  projectIds: readonly string[],
): Promise<Record<string, SiteOption[]>> {
  const entries = await Promise.all(
    projectIds.slice(0, 30).map(async (projectId) => {
      const result = await serverApi(
        `/projects/${encodeURIComponent(projectId)}/sites`,
        sitesResponseSchema,
      );
      return [
        projectId,
        result.ok ? result.data.sites.map(({ id, name }) => ({ id, name })) : [],
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

/** Standard and company units (active ones); empty when the call fails. */
export async function unitOptions(): Promise<UnitWire[]> {
  const result = await serverApi("/units", unitsResponseSchema);
  return result.ok ? result.data.units.filter((unit) => unit.status === "active") : [];
}

/**
 * A page's main API call: 401 → sign-in, 404/400 → not found handled by the caller; returns the
 * failure for the explicit forbidden/unavailable states.
 */
export async function loadOrRedirect<T>(
  path: string,
  schema: z.ZodType<T>,
  returnTo: string,
): Promise<ServerApiResult<T>> {
  const result = await serverApi(path, schema);
  if (!result.ok && result.status === 401) redirect(signInHref(returnTo));
  return result;
}

/** Up to 200 records of a list endpoint for a stage count, with whether there are more. */
export async function stageCount<T>(
  path: string,
  schema: z.ZodType<T>,
  pick: (data: T) => { count: number; more: boolean },
): Promise<{ count: number; more: boolean } | null> {
  const result = await serverApi(path, schema);
  return result.ok ? pick(result.data) : null;
}
