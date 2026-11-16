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
  /**
   * An existing record the request collided with, e.g. the labourer a duplicate registration
   * matched (`{ labourerId, workerNo, matchedOn }`). Identifiers only, never personal data.
   */
  match?: Record<string, string>;
  /**
   * Safe figures that explain a refusal (D4.3), e.g. `{ limitMinor, netMinor }` for
   * `approval-limit-exceeded`, `{ labourerIds }` for `unverified-recipients` or the float figures
   * of `insufficient-float`. Keys come from PROBLEM_FACT_KEYS; values are KES minor units, counts,
   * timestamps or record IDs, never personal data.
   */
  facts?: Record<string, number | string | boolean | null | string[]>;
}

export const PROBLEM_TYPE_BASE = "https://pm-buddy.dev/problems/";

export const problemType = (code: string) => `${PROBLEM_TYPE_BASE}${code}`;
