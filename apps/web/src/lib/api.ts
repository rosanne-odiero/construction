import { readyResponseSchema, type ReadyResponse } from "@pm-buddy/validation";

/**
 * How the web server reaches the API. Browsers never use this: they call same-origin /api/*,
 * which next.config.ts rewrites to the same address (ARCHITECTURE D-16).
 */
export const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

export type ReadinessResult =
  | { reachable: true; report: ReadyResponse; roundTripMs: number }
  | { reachable: false; reason: "network" | "invalidResponse" };

/** Server-side readiness probe. A degraded API still answers (HTTP 503) with a valid report. */
export async function fetchReadiness(): Promise<ReadinessResult> {
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(`${API_INTERNAL_URL}/api/v1/health/ready`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { reachable: false, reason: "network" };
  }
  const parsed = readyResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { reachable: false, reason: "invalidResponse" };
  return {
    reachable: true,
    report: parsed.data,
    roundTripMs: Math.round(performance.now() - started),
  };
}
