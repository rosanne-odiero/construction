/** RFC 9457 problem details, the body of every API error (`application/problem+json`). */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** Stable machine-readable code, e.g. `validation-error`, `step-up-required`. */
  code?: string;
  /** Request ID, also returned in the `X-Request-Id` header. */
  traceId?: string;
  errors?: { path: string; message: string }[];
}

export const PROBLEM_TYPE_BASE = "https://pm-buddy.dev/problems/";

export const problemType = (code: string) => `${PROBLEM_TYPE_BASE}${code}`;
