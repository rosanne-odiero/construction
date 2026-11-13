import type {
  CallbackKind,
  PaymentAttemptKind,
  PaymentDirection,
  QuarantineReason,
} from "@pm-buddy/types";
import type { ParsedCallback } from "./callbacks.js";

/** What the stored attempt expects; a callback is evidence only if it agrees on every point. */
export type ExpectedOutcome = {
  kind: PaymentAttemptKind;
  direction: PaymentDirection;
  amountMinor: number;
  currency: string;
  /** The company's shortcode the attempt used (checked when the callback states one). */
  shortcode: string | null;
};

/** Callback endpoints that may report on each attempt kind (and so its direction). */
const COMPATIBLE: Readonly<Record<PaymentAttemptKind, readonly CallbackKind[]>> = {
  stk_push: ["stk"],
  b2c: ["b2c_result", "timeout"],
  b2b_paybill: ["b2b_result", "timeout"],
  b2b_buygoods: ["b2b_result", "timeout"],
  reversal: ["reversal_result", "timeout"],
};

/** The direction a callback endpoint implies. */
export const callbackDirection = (kind: CallbackKind): PaymentDirection | null => {
  if (kind === "stk" || kind === "c2b_confirmation" || kind === "c2b_validation") return "in";
  if (kind === "b2c_result" || kind === "b2b_result" || kind === "reversal_result") return "out";
  return null;
};

export type Verification = { ok: true } | { ok: false; reason: QuarantineReason };

/**
 * Verifies a callback already matched on stored request identifiers (never on the phone number,
 * which may be masked) against the attempt: endpoint kind and direction always; for a success the
 * amount (exact, in minor units), the receipt, the currency when stated (M-Pesa Kenya results
 * mostly state none, so KES is implied by the account) and the shortcode when stated.
 */
export function verifyCallback(parsed: ParsedCallback, expected: ExpectedOutcome): Verification {
  const direction = callbackDirection(parsed.kind);
  if (direction && direction !== expected.direction && expected.kind !== "reversal")
    return { ok: false, reason: "direction_mismatch" };
  if (!COMPATIBLE[expected.kind].includes(parsed.kind))
    return { ok: false, reason: "kind_mismatch" };
  if (parsed.outcome !== "success") return { ok: true };
  return verifySettlement(
    {
      amountMinor: parsed.amountMinor,
      currency: parsed.currency,
      receipt: parsed.receipt,
      shortcode: parsed.shortcode,
    },
    expected,
  );
}

/** The settlement checks shared by callbacks, status answers and manual evidence. */
export function verifySettlement(
  evidence: {
    amountMinor: number | null;
    currency: string | null;
    receipt: string | null;
    shortcode: string | null;
  },
  expected: Pick<ExpectedOutcome, "amountMinor" | "currency" | "shortcode">,
): Verification {
  if (evidence.amountMinor === null || !evidence.receipt) return { ok: false, reason: "malformed" };
  if (evidence.amountMinor !== expected.amountMinor)
    return { ok: false, reason: "amount_mismatch" };
  if (evidence.currency !== null && evidence.currency.toUpperCase() !== expected.currency)
    return { ok: false, reason: "currency_mismatch" };
  if (
    evidence.shortcode !== null &&
    expected.shortcode &&
    evidence.shortcode !== expected.shortcode
  )
    return { ok: false, reason: "shortcode_mismatch" };
  return { ok: true };
}

/**
 * Transaction Status answers (ASSUMPTION, flagged in docs/ARCHITECTURE.md §4.5): the Daraja
 * documentation shows only `TransactionStatus: "Completed"`. Completed is settlement evidence; the
 * listed failure words are treated as definitive non-settlement; anything else (including "not
 * found") leaves the attempt unknown for manual review.
 */
export const STATUS_COMPLETED = ["completed"] as const;
export const STATUS_DEFINITIVE_FAILURE = [
  "failed",
  "declined",
  "cancelled",
  "canceled",
  "expired",
  "reversed",
] as const;

export type StatusAnswer = "completed" | "failed" | "undetermined";

export function interpretTransactionStatus(status: string | null): StatusAnswer {
  const value = (status ?? "").trim().toLowerCase();
  if ((STATUS_COMPLETED as readonly string[]).includes(value)) return "completed";
  if ((STATUS_DEFINITIVE_FAILURE as readonly string[]).includes(value)) return "failed";
  return "undetermined";
}

/**
 * STK Query (synchronous). Documented result codes: 0 processed successfully, 1032 cancelled by
 * the user. The answer carries no amount or receipt, so success is not settlement evidence on its
 * own (it opens an `unverified_success` review); these non-zero codes are definitive failures.
 * Error responses such as "The transaction is being processed" (500.001.1001) are not answers.
 */
export const STK_DEFINITIVE_FAILURE_CODES = ["1", "1001", "1019", "1025", "1032", "1037", "2001"];

export function interpretStkQuery(resultCode: string | null): StatusAnswer {
  if (resultCode === "0") return "completed";
  if (resultCode !== null && STK_DEFINITIVE_FAILURE_CODES.includes(resultCode)) return "failed";
  return "undetermined";
}
