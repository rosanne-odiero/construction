import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { z } from "zod";
import { PORTAL_HOME, portalFor, type Portal } from "@pm-buddy/types";
import { authResponseSchema, tenantsResponseSchema } from "@pm-buddy/validation";
import { API_INTERNAL_URL } from "./api";
import { signInHref } from "./safe-next";

export type ServerApiResult<T> =
  { ok: true; data: T } | { ok: false; status: number; code: string };

/**
 * Server-side API call through API_INTERNAL_URL. Only the incoming request's Cookie header is
 * forwarded (the httpOnly session cookies never reach client JavaScript), and every success is
 * parsed with the shared response schema.
 */
export async function serverApi<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<ServerApiResult<T>> {
  const cookie = (await headers()).get("cookie");
  let response: Response;
  try {
    response = await fetch(`${API_INTERNAL_URL}/api/v1${path}`, {
      headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, status: 0, code: "network" };
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { code?: unknown }).code === "string"
        ? (body as { code: string }).code
        : "requestFailed";
    return { ok: false, status: response.status, code };
  }
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, status: response.status, code: "invalidResponse" };
}

export type LiveSession = {
  user: { id: string; displayName: string; identifier: string };
  company: {
    id: string;
    name: string;
    role: string;
    roleName: string | null;
    tenantWide: boolean;
    permissions: string[];
  };
};
export type SessionState =
  | { status: "signed-in"; session: LiveSession }
  | { status: "signed-out" }
  | { status: "incomplete" }
  | { status: "unavailable" };

/** The signed-in user and selected company for this request (deduplicated per request). */
export const getSessionState = cache(async (): Promise<SessionState> => {
  const me = await serverApi("/auth/me", authResponseSchema);
  if (!me.ok) return { status: me.status === 401 ? "signed-out" : "unavailable" };
  const tenantId = me.data.session.tenantId;
  if (me.data.mfaRequired || !tenantId) return { status: "incomplete" };
  const tenants = await serverApi("/tenants", tenantsResponseSchema);
  if (!tenants.ok) {
    if (tenants.status === 401) return { status: "signed-out" };
    return { status: tenants.status === 403 ? "incomplete" : "unavailable" };
  }
  const company = tenants.data.tenants.find((tenant) => tenant.id === tenantId);
  if (!company) return { status: "incomplete" };
  return {
    status: "signed-in",
    session: {
      user: {
        id: me.data.user.id,
        displayName: me.data.user.displayName,
        identifier: me.data.user.identifier,
      },
      company: { ...company, permissions: [...company.permissions] },
    },
  };
});

/**
 * Live pages: the session, or a redirect to sign-in that returns to `path`. Null means the API
 * could not be reached (the page shows an explicit unavailable state, never mock data).
 */
export async function requireSession(path: string): Promise<LiveSession | null> {
  const state = await getSessionState();
  if (state.status === "signed-in") return state.session;
  if (state.status === "unavailable") return null;
  redirect(signInHref(path));
}

/**
 * Portal pages: the session, if the selected company's role uses this portal. Anyone else is
 * sent to their own portal (staff to the office app, clients to /portal, labourers to /worker).
 */
export async function requirePortal(portal: Portal, path: string): Promise<LiveSession | null> {
  const session = await requireSession(path);
  if (!session) return null;
  const actual = portalFor(session.company.permissions);
  if (actual !== portal) redirect(PORTAL_HOME[actual]);
  return session;
}

/**
 * Loads live page data: 401 → sign-in, 404 → not found; other failures are returned for an
 * explicit error state.
 */
export async function loadLive<T>(
  path: string,
  schema: z.ZodType<T>,
  returnTo: string,
): Promise<{ ok: true; data: T } | { ok: false; status: number; code: string }> {
  const result = await serverApi(path, schema);
  if (result.ok) return result;
  if (result.status === 401) redirect(signInHref(returnTo));
  if (result.status === 404 || result.status === 400) notFound();
  return result;
}
