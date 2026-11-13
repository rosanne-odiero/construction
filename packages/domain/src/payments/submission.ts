import type { PaymentAttemptKind, PaymentReasonCode } from "@pm-buddy/types";
import type { CallbackIdentifiers } from "./callbacks.js";

/**
 * What happened to one provider call, as seen by the worker. `not_sent` means the request never
 * left (connection refused, DNS failure, TLS failure before any byte was written); `timeout` and
 * `network` mean it may have reached the provider.
 */
export type SubmissionTransport =
  | { type: "not_sent"; code: string }
  | { type: "timeout" }
  | { type: "network"; code: string }
  | { type: "response"; httpStatus: number; body: unknown };

export type SubmissionOutcome =
  | { outcome: "pending"; reason: "accepted"; identifiers: CallbackIdentifiers }
  | {
      outcome: "failed";
      reason: Extract<PaymentReasonCode, "rejected_by_provider" | "not_delivered">;
      providerCode: string | null;
    }
  | {
      outcome: "unknown";
      reason: Extract<PaymentReasonCode, "timeout" | "lost_response" | "duplicate_originator_id">;
      providerCode: string | null;
    };

/**
 * Daraja gateway error codes that mean the request was refused before processing (Daraja error
 * tables, retrieved 11/11/2026): bad request/payload, invalid or expired token, wrong method or
 * resource, merchant/credential errors and rate-limit (spike arrest, quota) refusals.
 * `500.002.1001` (duplicate OriginatorConversationID) is the opposite: an earlier request with the
 * same ID exists, so the outcome is unknown. `500.003.1001` (internal server error) and unlisted
 * codes are unknown too.
 */
export const DEFINITIVE_REJECTION_CODES = [
  "400.002.02",
  "400.002.05",
  "400.003.01",
  "400.003.02",
  "400.008.01",
  "400.008.02",
  "401.002.01",
  "404.001.01",
  "404.001.03",
  "404.001.04",
  "404.002.01",
  "404.003.01",
  "405.001",
  "500.001.1001",
  "500.003.02",
  "500.003.03",
] as const;
export const DUPLICATE_ORIGINATOR_CODE = "500.002.1001";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, 100)
    : typeof value === "number"
      ? String(value)
      : null;

/** Classifies a submission (pure; unit-tested for every branch). Never "confirmed": results are asynchronous. */
export function classifySubmission(
  kind: PaymentAttemptKind,
  transport: SubmissionTransport,
  sentOriginatorConversationId: string | null,
): SubmissionOutcome {
  if (transport.type === "not_sent")
    return { outcome: "failed", reason: "not_delivered", providerCode: transport.code };
  if (transport.type === "timeout")
    return { outcome: "unknown", reason: "timeout", providerCode: null };
  if (transport.type === "network")
    return { outcome: "unknown", reason: "lost_response", providerCode: transport.code };

  const body = isObject(transport.body) ? transport.body : null;
  const errorCode = body ? str(body["errorCode"]) : null;
  if (transport.httpStatus < 200 || transport.httpStatus >= 300 || errorCode) {
    if (errorCode === DUPLICATE_ORIGINATOR_CODE)
      return { outcome: "unknown", reason: "duplicate_originator_id", providerCode: errorCode };
    if (errorCode && (DEFINITIVE_REJECTION_CODES as readonly string[]).includes(errorCode))
      return { outcome: "failed", reason: "rejected_by_provider", providerCode: errorCode };
    return {
      outcome: "unknown",
      reason: "lost_response",
      providerCode: errorCode ?? `http_${transport.httpStatus}`,
    };
  }
  if (!body) return { outcome: "unknown", reason: "lost_response", providerCode: null };
  const responseCode = str(body["ResponseCode"]);
  if (responseCode === null)
    return { outcome: "unknown", reason: "lost_response", providerCode: null };
  if (responseCode !== "0")
    return { outcome: "failed", reason: "rejected_by_provider", providerCode: responseCode };

  const identifiers: CallbackIdentifiers = {};
  const merchant = str(body["MerchantRequestID"]);
  const checkout = str(body["CheckoutRequestID"]);
  const originator = str(body["OriginatorConversationID"]);
  const conversation = str(body["ConversationID"]);
  if (merchant) identifiers.merchantRequestId = merchant;
  if (checkout) identifiers.checkoutRequestId = checkout;
  if (originator) identifiers.originatorConversationId = originator;
  if (conversation) identifiers.conversationId = conversation;

  const complete =
    kind === "stk_push"
      ? Boolean(merchant && checkout)
      : Boolean(conversation && (originator || sentOriginatorConversationId));
  // An acceptance that names a different originator ID than the one sent cannot be trusted.
  const consistent =
    !sentOriginatorConversationId || !originator || originator === sentOriginatorConversationId;
  if (!complete || !consistent)
    return { outcome: "unknown", reason: "lost_response", providerCode: "0" };
  return { outcome: "pending", reason: "accepted", identifiers };
}
