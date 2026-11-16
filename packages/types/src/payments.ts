/**
 * Payments and the Daraja (M-Pesa) integration, D4.2 (brief §5.7, §15 D; WORKFLOWS "Payment
 * attempts"). Provider-neutral vocabulary: a payment request is the business intent, each attempt
 * is one call to the provider with its own state machine, and callbacks land in a durable inbox.
 */

/**
 * Where a company's Daraja calls go. `mock` is the local mock server (tools for development and
 * tests); `sandbox` is Safaricom's sandbox. `production` exists in the vocabulary but is refused
 * by the API and by a database CHECK until the go-live gate (COMPLIANCE-REVIEW CR-PMT-04) is
 * passed for a company.
 */
export const PAYMENT_ENVIRONMENTS = ["mock", "sandbox", "production"] as const;
export type PaymentEnvironment = (typeof PAYMENT_ENVIRONMENTS)[number];
export const ENABLED_PAYMENT_ENVIRONMENTS = [
  "mock",
  "sandbox",
] as const satisfies readonly PaymentEnvironment[];

/** Provider operations a payment request can use (reversal attempts belong to a confirmed one). */
export const PAYMENT_REQUEST_KINDS = ["stk_push", "b2c", "b2b_paybill", "b2b_buygoods"] as const;
export type PaymentRequestKind = (typeof PAYMENT_REQUEST_KINDS)[number];
export const PAYMENT_ATTEMPT_KINDS = [...PAYMENT_REQUEST_KINDS, "reversal"] as const;
export type PaymentAttemptKind = (typeof PAYMENT_ATTEMPT_KINDS)[number];

export const PAYMENT_DIRECTIONS = ["in", "out"] as const;
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

/** Money moves in: STK Push (and C2B receipts). Everything else pays out. */
export const directionOfKind = (kind: PaymentRequestKind): PaymentDirection =>
  kind === "stk_push" ? "in" : "out";

/**
 * What a request pays for. D4.2 creates `test` requests only (console demonstrations against the
 * mock server or the sandbox); D4.3 attaches payroll obligations (B2C), D5/D7 invoices
 * (STK/C2B/B2B). The database CHECK lists the same keys.
 */
export const PAYMENT_PURPOSES = [
  "test",
  "payroll_obligation",
  "client_invoice",
  "supplier_invoice",
] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

/** B2C command IDs from the Daraja documentation (CommandID). Wages use SalaryPayment. */
export const B2C_COMMANDS = ["SalaryPayment", "BusinessPayment", "PromotionPayment"] as const;
export type B2cCommand = (typeof B2C_COMMANDS)[number];

/** STK TransactionType: Paybill or till (Buy Goods). */
export const STK_TRANSACTION_TYPES = ["CustomerPayBillOnline", "CustomerBuyGoodsOnline"] as const;
export type StkTransactionType = (typeof STK_TRANSACTION_TYPES)[number];

/**
 * Attempt states (brief §15 D). `created` → `queued` happen in the creating transaction; a worker
 * owns `submitting` (call intent persisted first); only verified provider evidence reaches
 * `confirmed` or `failed`; timeouts, lost responses and expired leases become `unknown`.
 */
export const PAYMENT_ATTEMPT_STATUSES = [
  "created",
  "queued",
  "submitting",
  "pending",
  "unknown",
  "confirmed",
  "failed",
  "reversal_pending",
  "reversed",
] as const;
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

/** Every allowed edge of WORKFLOWS "Payment attempts"; anything else is refused (API and database). */
export const PAYMENT_ATTEMPT_TRANSITIONS: Readonly<
  Record<PaymentAttemptStatus, readonly PaymentAttemptStatus[]>
> = {
  created: ["queued"],
  queued: ["submitting"],
  submitting: ["pending", "unknown", "failed"],
  pending: ["unknown", "confirmed", "failed"],
  unknown: ["confirmed", "failed"],
  confirmed: ["reversal_pending"],
  failed: [],
  reversal_pending: ["reversed", "confirmed"],
  reversed: [],
};

/** Not yet final and possibly in flight: a request may have at most one (database index). */
export const LIVE_ATTEMPT_STATUSES = [
  "created",
  "queued",
  "submitting",
  "pending",
  "unknown",
] as const satisfies readonly PaymentAttemptStatus[];
/** Provider acceptance or outcome is uncertain: never resubmitted, reconciled first. */
export const UNCERTAIN_ATTEMPT_STATUSES = [
  "submitting",
  "pending",
  "unknown",
] as const satisfies readonly PaymentAttemptStatus[];

/** A payment request's summary status, derived from its attempts in the same transaction. */
export const PAYMENT_REQUEST_STATUSES = [
  "in_progress",
  "uncertain",
  "confirmed",
  "failed",
  "reversal_pending",
  "reversed",
] as const;
export type PaymentRequestStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];

/** Why an attempt moved; shown on the state timeline (the web localises the code). */
export const PAYMENT_REASON_CODES = [
  "created",
  "queued",
  "submission_started",
  "accepted",
  "rejected_by_provider",
  "not_delivered",
  "timeout",
  "lost_response",
  "duplicate_originator_id",
  "lease_expired",
  "result_overdue",
  "queue_timeout",
  "result_before_acceptance",
  "provider_success",
  "provider_failure",
  "status_query_success",
  "status_query_failure",
  "manual_confirmation",
  "manual_failure",
  "reversal_requested",
  "reversal_confirmed",
  "reversal_rejected",
] as const;
export type PaymentReasonCode = (typeof PAYMENT_REASON_CODES)[number];

/** Callback endpoints (one URL path segment each; the paths avoid words Daraja refuses in URLs). */
export const CALLBACK_KINDS = [
  "stk",
  "b2c_result",
  "b2b_result",
  "status_result",
  "balance_result",
  "reversal_result",
  "timeout",
  "c2b_validation",
  "c2b_confirmation",
] as const;
export type CallbackKind = (typeof CALLBACK_KINDS)[number];
export const callbackPathSegment = (kind: CallbackKind): string => kind.replace(/_/g, "-");
export const callbackKindFromSegment = (segment: string): CallbackKind | null =>
  (CALLBACK_KINDS as readonly string[]).includes(segment.replace(/-/g, "_"))
    ? (segment.replace(/-/g, "_") as CallbackKind)
    : null;

/** Durable inbox states: received (persisted, acknowledged) → processed or quarantined → reviewed. */
export const CALLBACK_STATUSES = [
  "received",
  "processed",
  "quarantined",
  "resolved",
  "dismissed",
] as const;
export type CallbackStatus = (typeof CALLBACK_STATUSES)[number];

/** Why a callback was set aside for review instead of changing any payment. */
export const QUARANTINE_REASONS = [
  "unknown_request",
  "malformed",
  "amount_mismatch",
  "currency_mismatch",
  "direction_mismatch",
  "shortcode_mismatch",
  "kind_mismatch",
  "conflicting_result",
  "duplicate_receipt",
  "unsupported",
] as const;
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

/** Reconciliation cases: an owner, age, evidence and append-only history (brief §15 D). */
export const RECONCILIATION_CASE_KINDS = [
  "unknown_outcome",
  "quarantined_callback",
  "conflicting_evidence",
  "unverified_success",
] as const;
export type ReconciliationCaseKind = (typeof RECONCILIATION_CASE_KINDS)[number];
export const RECONCILIATION_CASE_STATUSES = ["open", "resolved", "dismissed"] as const;
export type ReconciliationCaseStatus = (typeof RECONCILIATION_CASE_STATUSES)[number];
export const RECONCILIATION_RESOLUTIONS = [
  "confirmed",
  "failed",
  "no_payment_effect",
  "dismissed",
] as const;
export type ReconciliationResolution = (typeof RECONCILIATION_RESOLUTIONS)[number];

/** Read-only provider queries (they never move money). */
export const PROVIDER_QUERY_KINDS = [
  "transaction_status",
  "stk_query",
  "account_balance",
  "c2b_register",
] as const;
export type ProviderQueryKind = (typeof PROVIDER_QUERY_KINDS)[number];
export const PROVIDER_QUERY_STATUSES = ["sent", "answered", "failed", "unknown"] as const;
export type ProviderQueryStatus = (typeof PROVIDER_QUERY_STATUSES)[number];

/** Provider receipts (M-Pesa transaction IDs) held as evidence, one per company and receipt. */
export const PROVIDER_TRANSACTION_KINDS = ["stk", "c2b", "b2c", "b2b", "reversal"] as const;
export type ProviderTransactionKind = (typeof PROVIDER_TRANSACTION_KINDS)[number];
export const PROVIDER_TRANSACTION_STATUSES = ["matched", "unallocated", "disputed"] as const;
export type ProviderTransactionStatus = (typeof PROVIDER_TRANSACTION_STATUSES)[number];

/** Write-only secrets of a company's Daraja app and API operator, never returned by the API. */
export const PAYMENT_SECRET_FIELDS = [
  "consumerKey",
  "consumerSecret",
  "initiatorName",
  "initiatorPassword",
  "passkey",
] as const;
export type PaymentSecretField = (typeof PAYMENT_SECRET_FIELDS)[number];

/**
 * Transaction and daily limits in KES minor units. DEMO placeholders (QUESTIONS Q-M2,
 * COMPLIANCE-REVIEW CR-PMT-02): the STK and B2C ceilings (KES 250,000 per transaction) and the
 * B2C minimum (KES 10) follow the limits quoted in Safaricom's Daraja FAQs (retrieved 11/11/2026);
 * the B2B ceiling and the company daily payout limit are placeholders, not Safaricom figures.
 */
export const DEMO_PAYMENT_LIMITS = {
  stkMaxMinor: 25_000_000,
  b2cMinMinor: 1_000,
  b2cMaxMinor: 25_000_000,
  b2bMaxMinor: 25_000_000,
  dailyPayoutMaxMinor: 50_000_000,
} as const;
export type PaymentLimits = {
  stkMaxMinor: number;
  b2cMinMinor: number;
  b2cMaxMinor: number;
  b2bMaxMinor: number;
  dailyPayoutMaxMinor: number;
};

/** Hard bounds a company can configure its limits within (sanity, not provider rules). */
export const PAYMENT_LIMIT_BOUNDS = { minMinor: 100, maxMinor: 100_000_000_000 } as const;

/** M-Pesa takes whole shillings; amounts with cents are refused before any call. */
export const MPESA_WHOLE_SHILLINGS = true;

/** Field limits from the Daraja documentation (AccountReference ≤ 12 for STK, ≤ 13 for B2B). */
export const DARAJA_FIELD_LIMITS = {
  stkAccountReference: 12,
  stkTransactionDesc: 13,
  b2bAccountReference: 13,
  remarks: 100,
  shortcodeMin: 5,
  shortcodeMax: 9,
} as const;

/** Read-only callback acknowledgement Daraja expects (C2B validation uses the same shape). */
export const CALLBACK_ACK = { ResultCode: 0, ResultDesc: "Accepted" } as const;

/** Stable problem codes of the payments API (the web maps each to an EN/SW message). */
export const PAYMENT_PROBLEMS = [
  "version-conflict",
  "idempotency-key-required",
  "invalid-idempotency-key",
  "idempotency-key-reused",
  "mfa-required",
  "production-not-enabled",
  "environment-unavailable",
  "payments-not-configured",
  "credentials-missing",
  "payouts-disabled",
  "amount-not-whole-shillings",
  "amount-below-minimum",
  "amount-above-limit",
  "daily-limit-exceeded",
  "invalid-transition",
  "attempt-not-confirmed",
  "reversal-in-progress",
  "uncertain-attempt",
  "same-person",
  "case-closed",
  "callback-not-reviewable",
  "evidence-mismatch",
  "status-query-unavailable",
  "payment-rule",
] as const;
export type PaymentProblem = (typeof PAYMENT_PROBLEMS)[number];
