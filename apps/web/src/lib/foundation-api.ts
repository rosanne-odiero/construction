import { z } from "zod";

const problemSchema = z.object({
  code: z.string().optional(),
  traceId: z.string().optional(),
  match: z.record(z.string(), z.string()).optional(),
});

export class FoundationApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly traceId?: string,
    /** The existing record a 409 collided with (RFC 9457 extension), e.g. a labourer. */
    readonly match?: Readonly<Record<string, string>>,
  ) {
    super(code);
    this.name = "FoundationApiError";
  }
}

export async function foundationRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  options: {
    method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (error) {
    if (
      error instanceof TypeError ||
      (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name))
    ) {
      throw new FoundationApiError(0, "network");
    }
    throw error;
  }
  const raw = await response.text();
  let body: unknown;
  try {
    body = raw.length ? JSON.parse(raw) : undefined;
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new FoundationApiError(response.status, "invalidResponse");
    throw error;
  }
  if (!response.ok) {
    const problem = problemSchema.safeParse(body);
    throw new FoundationApiError(
      response.status,
      problem.success ? (problem.data.code ?? "requestFailed") : "requestFailed",
      problem.success ? problem.data.traceId : undefined,
      problem.success ? problem.data.match : undefined,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new FoundationApiError(response.status, "invalidResponse");
  return parsed.data;
}
