import type { z } from "zod";
import { csrfResponseSchema } from "@pm-buddy/validation";
import { foundationRequest } from "./foundation-api";

/** A same-origin POST with a fresh CSRF token; the success body is parsed with `schema`. */
export async function postWithCsrf<T>(
  path: string,
  schema: z.ZodType<T>,
  body: Record<string, unknown>,
): Promise<T> {
  const { csrfToken } = await foundationRequest("/auth/csrf", csrfResponseSchema);
  return foundationRequest(path, schema, {
    method: "POST",
    body,
    headers: { "X-CSRF-Token": csrfToken },
  });
}
