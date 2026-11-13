/**
 * Controllable outcomes. A request picks its scenario from a "magic" whole-shilling amount (so a
 * scenario survives any client), unless an admin call set the next scenario. Every other amount
 * succeeds. Documented in apps/mock-daraja/README.md.
 */
export const MOCK_SCENARIOS = [
  "success",
  "failure",
  "insufficient_balance",
  "timeout_completed",
  "timeout_failed",
  "lost_response",
  "result_before_response",
  "duplicate_callback",
  "late_timeout",
  "conflicting_results",
  "unknown_callback",
  "amount_mismatch",
  "rejected",
  "server_error",
  "interim_then_success",
  "invalid_credentials",
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

/** KES amounts (whole shillings) that select a scenario. */
export const MAGIC_AMOUNTS: Readonly<Record<number, MockScenario>> = {
  1001: "failure",
  1002: "insufficient_balance",
  1003: "timeout_completed",
  1004: "timeout_failed",
  1005: "lost_response",
  1006: "duplicate_callback",
  1007: "late_timeout",
  1008: "conflicting_results",
  1009: "unknown_callback",
  1010: "amount_mismatch",
  1011: "rejected",
  1012: "server_error",
  1013: "interim_then_success",
  1014: "result_before_response",
};

export const SCENARIO_HELP: Readonly<Record<MockScenario, string>> = {
  success: "Accepted; one success callback (default for every other amount).",
  failure:
    "Accepted; one failure callback (STK 1032 cancelled by user, others 2001-style failure).",
  insufficient_balance: "Accepted; failure callback with ResultCode 1 (insufficient balance).",
  timeout_completed:
    "Accepted; no callback ever. Transaction Status / STK Query later report it completed.",
  timeout_failed:
    "Accepted; no callback ever. Transaction Status reports 'Failed'; STK Query answers 1032.",
  lost_response:
    "Processed, but the HTTP response is delayed past the client timeout; the success callback follows.",
  result_before_response:
    "The success callback is sent immediately while the HTTP response is delayed past the client timeout.",
  duplicate_callback: "Accepted; the same success callback is delivered twice.",
  late_timeout: "Accepted; success callback, then a late QueueTimeOutURL notification.",
  conflicting_results: "Accepted; success callback, then a failure callback for the same request.",
  unknown_callback:
    "Accepted; success callback plus a second callback with identifiers PM-Buddy never sent.",
  amount_mismatch: "Accepted; the success callback reports a different amount.",
  rejected: "Refused at submission: HTTP 400 with errorCode 400.002.02 (no callback).",
  server_error: "HTTP 500 with errorCode 500.003.1001 after processing: the outcome is unknown.",
  interim_then_success: "Accepted; a ResultType 1 interim result, then the success callback.",
  invalid_credentials:
    "Selected automatically when the SecurityCredential cannot be decrypted: ResultCode 2001.",
};

export function scenarioForAmount(amount: unknown): MockScenario {
  const value =
    typeof amount === "string" ? Number(amount) : typeof amount === "number" ? amount : NaN;
  return (Number.isInteger(value) && MAGIC_AMOUNTS[value]) || "success";
}

export const isScenario = (value: unknown): value is MockScenario =>
  typeof value === "string" && (MOCK_SCENARIOS as readonly string[]).includes(value);
