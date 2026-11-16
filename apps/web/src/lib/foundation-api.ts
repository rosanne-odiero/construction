import { z } from "zod";

const problemSchema = z.object({
  code: z.string().optional(),
  traceId: z.string().optional(),
  match: z.record(z.string(), z.string()).optional(),
  facts: z
    .record(
      z.string(),
      z.union([z.number(), z.string(), z.boolean(), z.null(), z.array(z.string())]),
    )
    .optional(),
});

/** Safe figures a refusal carries (RFC 9457 extension, D4.3), e.g. a limit and the amount. */
export type ProblemFacts = Readonly<Record<string, number | string | boolean | null | string[]>>;

/** The problem body of a failed response, or null when it is not one. */
export function parseProblem(body: unknown) {
  const problem = problemSchema.safeParse(body);
  return problem.success ? problem.data : null;
}

export class FoundationApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly traceId?: string,
    /** The existing record a 409 collided with (RFC 9457 extension), e.g. a labourer. */
    readonly match?: Readonly<Record<string, string>>,
    /** Safe figures explaining a refusal (D4.3), e.g. `{ limitMinor, netMinor }`. */
    readonly facts?: ProblemFacts,
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
    const problem = parseProblem(body);
    throw new FoundationApiError(
      response.status,
      problem?.code ?? "requestFailed",
      problem?.traceId,
      problem?.match,
      problem?.facts,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new FoundationApiError(response.status, "invalidResponse");
  return parsed.data;
}
