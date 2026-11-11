import type { z } from "zod";
import { authResponseSchema, csrfResponseSchema } from "@pm-buddy/validation";
import { FoundationApiError, foundationRequest } from "./foundation-api";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

let refreshing: Promise<boolean> | null = null;

async function csrfToken(): Promise<string> {
  return (await foundationRequest("/auth/csrf", csrfResponseSchema)).csrfToken;
}

/**
 * Rotates the session once for all concurrent callers: replaying a used refresh credential
 * revokes the whole session, so two parallel refreshes must never happen.
 */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      await foundationRequest("/auth/refresh", authResponseSchema, {
        method: "POST",
        body: {},
        headers: { "X-CSRF-Token": await csrfToken() },
      });
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => {
        refreshing = null;
      }, 0);
    }
  })();
  return refreshing;
}

/**
 * Same-origin API call for live pages: state-changing requests carry the CSRF token, an expired
 * access token is refreshed once and the request retried, and every success is parsed with the
 * shared schema (a malformed response is an error, never a success).
 */
export async function liveRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { method?: Method; body?: Record<string, unknown> } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const attempt = async () =>
    foundationRequest(path, schema, {
      method,
      body: options.body ?? (method === "GET" ? undefined : {}),
      headers: method === "GET" ? {} : { "X-CSRF-Token": await csrfToken() },
    });
  try {
    return await attempt();
  } catch (error) {
    if (error instanceof FoundationApiError && error.status === 401 && (await refreshSession()))
      return attempt();
    throw error;
  }
}

export { FoundationApiError as LiveApiError };
