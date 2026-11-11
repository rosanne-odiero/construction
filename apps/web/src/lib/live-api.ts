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

/**
 * Same-origin multipart upload of one file (field `file`, after any text `fields`) with the CSRF
 * token, one refresh on an expired access token, and the response parsed with the shared schema.
 */
export async function liveUpload<T>(
  path: string,
  file: File,
  schema: z.ZodType<T>,
  fields: Record<string, string> = {},
): Promise<T> {
  const attempt = async (): Promise<T> => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    form.append("file", file, file.name);
    let response: Response;
    try {
      response = await fetch(`/api/v1${path}`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(120_000),
        headers: { Accept: "application/json", "X-CSRF-Token": await csrfToken() },
        body: form,
      });
    } catch {
      throw new FoundationApiError(0, "network");
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code =
        typeof body === "object" &&
        body !== null &&
        typeof (body as { code?: unknown }).code === "string"
          ? (body as { code: string }).code
          : "requestFailed";
      throw new FoundationApiError(response.status, code);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new FoundationApiError(response.status, "invalidResponse");
    return parsed.data;
  };
  try {
    return await attempt();
  } catch (error) {
    if (error instanceof FoundationApiError && error.status === 401 && (await refreshSession()))
      return attempt();
    throw error;
  }
}

export { FoundationApiError as LiveApiError };
