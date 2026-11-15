import "server-only";
import type { z } from "zod";
import { loadLive, requirePortal } from "./server-api";

export type SupplierPage<T> =
  { kind: "ok"; data: T; company: string } | { kind: "unavailable" } | { kind: "notLinked" };

/**
 * Supplier portal pages (D7.2): only for someone whose role uses the supplier portal (others are
 * sent to their own portal), then the live data. An ended or unlinked access shows its own state;
 * an ID of another supplier or company is a 404 like any unknown ID.
 */
export async function loadSupplierPage<T>(
  path: string,
  apiPath: string,
  schema: z.ZodType<T>,
): Promise<SupplierPage<T>> {
  const session = await requirePortal("supplier", path);
  if (!session) return { kind: "unavailable" };
  const result = await loadLive(apiPath, schema, path);
  if (result.ok) return { kind: "ok", data: result.data, company: session.company.name };
  if (result.code === "supplier-portal-not-linked" || result.status === 403)
    return { kind: "notLinked" };
  return { kind: "unavailable" };
}
