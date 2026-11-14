import "server-only";
import type { z } from "zod";
import { loadLive, requirePortal } from "./server-api";

export type ClientPage<T> = { kind: "ok"; data: T } | { kind: "unavailable" };

/**
 * Client portal pages (D7.1): only for someone whose role uses the client portal (others are sent
 * to their own portal), then the live data. An unassigned or unknown project is a 404 like any
 * unknown ID (`loadLive` shows the not-found page).
 */
export async function loadClientPage<T>(
  path: string,
  apiPath: string,
  schema: z.ZodType<T>,
): Promise<ClientPage<T>> {
  const session = await requirePortal("client", path);
  if (!session) return { kind: "unavailable" };
  const result = await loadLive(apiPath, schema, path);
  return result.ok ? { kind: "ok", data: result.data } : { kind: "unavailable" };
}
