import { isShortcode } from "@pm-buddy/domain";
import {
  B2C_COMMANDS,
  CALLBACK_KINDS,
  CALLBACK_STATUSES,
  DARAJA_FIELD_LIMITS,
  PAYMENT_ATTEMPT_KINDS,
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_DIRECTIONS,
  PAYMENT_ENVIRONMENTS,
  PAYMENT_LIMIT_BOUNDS,
  PAYMENT_PURPOSES,
  PAYMENT_REASON_CODES,
  PAYMENT_REQUEST_KINDS,
  PAYMENT_REQUEST_STATUSES,
  PAYMENT_SECRET_FIELDS,
  PROVIDER_QUERY_KINDS,
  PROVIDER_QUERY_STATUSES,
  PROVIDER_TRANSACTION_KINDS,
  PROVIDER_TRANSACTION_STATUSES,
  QUARANTINE_REASONS,
  RECONCILIATION_CASE_KINDS,
  RECONCILIATION_CASE_STATUSES,
  RECONCILIATION_RESOLUTIONS,
  STK_TRANSACTION_TYPES,
} from "@pm-buddy/types";
import { z } from "zod";
import { kenyanPhoneSchema } from "./primitives.js";

/**
 * Payments console and Daraja integration (D4.2). Requests are strict. Secrets are write-only:
 * no response schema has a field that could carry one. Amounts are integer KES minor units;
 * phone numbers leave the API masked only.
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const version = z.number().int().min(1).max(2_147_483_647);
const actor = z.object({ id: uuid, displayName: z.string().min(1).max(100) }).strict();
const amountMinor = z.number().int().positive().max(PAYMENT_LIMIT_BOUNDS.maxMinor);
/** A reason for a review, a switch change, a reversal or a rotation: 10–500 characters. */
export const paymentReasonSchema = z.string().trim().min(10).max(500);

export const paymentEnvironmentSchema = z.enum(PAYMENT_ENVIRONMENTS);
export const paymentRequestKindSchema = z.enum(PAYMENT_REQUEST_KINDS);
export const paymentAttemptKindSchema = z.enum(PAYMENT_ATTEMPT_KINDS);
export const paymentAttemptStatusSchema = z.enum(PAYMENT_ATTEMPT_STATUSES);
export const paymentRequestStatusSchema = z.enum(PAYMENT_REQUEST_STATUSES);
export const paymentDirectionSchema = z.enum(PAYMENT_DIRECTIONS);
export const paymentPurposeSchema = z.enum(PAYMENT_PURPOSES);
export const callbackKindSchema = z.enum(CALLBACK_KINDS);
export const callbackStatusSchema = z.enum(CALLBACK_STATUSES);
export const quarantineReasonSchema = z.enum(QUARANTINE_REASONS);
export const reconciliationCaseKindSchema = z.enum(RECONCILIATION_CASE_KINDS);
export const reconciliationCaseStatusSchema = z.enum(RECONCILIATION_CASE_STATUSES);

export const shortcodeSchema = z
  .string()
  .trim()
  .refine((value) => isShortcode(value), "invalid_shortcode");
const nullableShortcode = shortcodeSchema.nullable();

const limitValue = z
  .number()
  .int()
  .min(PAYMENT_LIMIT_BOUNDS.minMinor)
  .max(PAYMENT_LIMIT_BOUNDS.maxMinor)
  .refine((value) => value % 100 === 0, "whole_shillings");

export const paymentLimitsSchema = z
  .object({
    stkMaxMinor: limitValue,
    b2cMinMinor: limitValue,
    b2cMaxMinor: limitValue,
    b2bMaxMinor: limitValue,
    dailyPayoutMaxMinor: limitValue,
  })
  .strict()
  .refine((limits) => limits.b2cMinMinor <= limits.b2cMaxMinor, {
    message: "min_above_max",
    path: ["b2cMinMinor"],
  });

export const paymentShortcodesSchema = z
  .object({
    stkShortcode: nullableShortcode,
    stkPartyB: nullableShortcode,
    stkTransactionType: z.enum(STK_TRANSACTION_TYPES),
    c2bShortcode: nullableShortcode,
    b2cShortcode: nullableShortcode,
    b2bShortcode: nullableShortcode,
  })
  .strict();

/** Environment, shortcodes and limits (payments.manage_credentials with a fresh step-up). */
export const updatePaymentSettingsRequestSchema = z
  .object({
    version,
    environment: paymentEnvironmentSchema,
    shortcodes: paymentShortcodesSchema,
    limits: paymentLimitsSchema,
  })
  .strict();

const secret = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value, "no_surrounding_spaces");

/** Write-only secrets: send only the ones to replace. Never echoed, logged or audited. */
export const updatePaymentCredentialsRequestSchema = z
  .object({
    version,
    consumerKey: secret.optional(),
    consumerSecret: secret.optional(),
    initiatorName: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.@-]+$/, "invalid_initiator")
      .optional(),
    initiatorPassword: secret.optional(),
    passkey: secret.optional(),
  })
  .strict()
  .refine(
    (value) => PAYMENT_SECRET_FIELDS.some((field) => value[field] !== undefined),
    "nothing_to_change",
  );

export const payoutSwitchRequestSchema = z
  .object({ version, enabled: z.boolean(), reason: paymentReasonSchema })
  .strict();

export const rotateCallbackTokenRequestSchema = z
  .object({ version, reason: paymentReasonSchema })
  .strict();

export const registerC2bUrlsRequestSchema = z
  .object({ responseType: z.enum(["Completed", "Cancelled"]) })
  .strict();

const remarks = z.string().trim().min(2).max(DARAJA_FIELD_LIMITS.remarks);
const accountReference = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9 _#/.-]+$/, "invalid_account_reference");

const testCommon = {
  amountMinor,
  projectId: uuid.nullable().optional(),
};

/**
 * A console test transaction (payments.initiate_test): mock or sandbox only, purpose `test`.
 * Real business payments (payroll, invoices) are created by their own modules (D4.3, D5, D7).
 */
export const createTestPaymentRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("stk_push"),
      ...testCommon,
      phone: kenyanPhoneSchema,
      accountReference: accountReference(DARAJA_FIELD_LIMITS.stkAccountReference),
      description: z.string().trim().max(DARAJA_FIELD_LIMITS.stkTransactionDesc).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("b2c"),
      ...testCommon,
      phone: kenyanPhoneSchema,
      command: z.enum(B2C_COMMANDS),
      remarks,
      occasion: z.string().trim().max(100).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["b2b_paybill", "b2b_buygoods"]),
      ...testCommon,
      partyB: shortcodeSchema,
      accountReference: accountReference(DARAJA_FIELD_LIMITS.b2bAccountReference),
      remarks,
    })
    .strict(),
]);

export const requestReversalRequestSchema = z
  .object({ version, reason: paymentReasonSchema })
  .strict();

export const resolveCaseRequestSchema = z
  .object({
    version,
    resolution: z.enum(RECONCILIATION_RESOLUTIONS),
    reason: paymentReasonSchema,
    /** Manual confirmation needs the M-Pesa receipt and amount from the statement (D4.3 uploads). */
    receipt: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{8,20}$/, "invalid_receipt")
      .optional(),
    amountMinor: amountMinor.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.resolution !== "confirmed" ||
      (value.receipt !== undefined && value.amountMinor !== undefined),
    { message: "evidence_required", path: ["receipt"] },
  );

export const reviewCallbackRequestSchema = z
  .object({ version, decision: z.enum(["resolved", "dismissed"]), reason: paymentReasonSchema })
  .strict();

export const paymentRequestListQuerySchema = z
  .object({
    status: paymentRequestStatusSchema.optional(),
    kind: paymentRequestKindSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

export const callbackListQuerySchema = z
  .object({
    status: callbackStatusSchema.optional(),
    kind: callbackKindSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

export const caseListQuerySchema = z
  .object({
    status: reconciliationCaseStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

// Responses ---------------------------------------------------------------------------------------

const secretStatus = z
  .object({ configured: z.boolean(), updatedAt: timestamp.nullable() })
  .strict();

export const paymentSettingsSchema = z
  .object({
    environment: paymentEnvironmentSchema,
    availableEnvironments: z.array(paymentEnvironmentSchema),
    productionEnabled: z.literal(false),
    payoutsEnabled: z.boolean(),
    payoutsChangedAt: timestamp.nullable(),
    payoutsChangedBy: actor.nullable(),
    shortcodes: paymentShortcodesSchema,
    limits: paymentLimitsSchema,
    limitsStatus: z.enum(["demo", "reviewed"]),
    secrets: z.object(
      Object.fromEntries(PAYMENT_SECRET_FIELDS.map((field) => [field, secretStatus])) as Record<
        (typeof PAYMENT_SECRET_FIELDS)[number],
        typeof secretStatus
      >,
    ),
    credentialsUpdatedAt: timestamp.nullable(),
    credentialsUpdatedBy: actor.nullable(),
    callbackUrls: z.array(z.object({ kind: callbackKindSchema, url: z.string() }).strict()),
    callbackUrlWarnings: z.array(z.string()),
    callbackTokenRotatedAt: timestamp.nullable(),
    ipAllowlistEnabled: z.boolean(),
    certificateConfigured: z.boolean(),
    version,
    updatedAt: timestamp,
  })
  .strict();

export const paymentSettingsResponseSchema = z
  .object({
    configured: z.boolean(),
    settings: paymentSettingsSchema.nullable(),
    canManage: z.boolean(),
    canPause: z.boolean(),
  })
  .strict();

const providerIds = z
  .object({
    merchantRequestId: z.string().nullable(),
    checkoutRequestId: z.string().nullable(),
    originatorConversationId: z.string().nullable(),
    conversationId: z.string().nullable(),
  })
  .strict();

export const paymentAttemptSchema = z
  .object({
    id: uuid,
    sequence: z.number().int().min(1),
    kind: paymentAttemptKindSchema,
    direction: paymentDirectionSchema,
    status: paymentAttemptStatusSchema,
    version,
    amountMinor,
    currency: z.literal("KES"),
    environment: paymentEnvironmentSchema,
    shortcode: z.string().nullable(),
    providerIds,
    receipt: z.string().nullable(),
    resultCode: z.string().nullable(),
    resultDesc: z.string().nullable(),
    reason: z.enum(PAYMENT_REASON_CODES).nullable(),
    reversesAttemptId: uuid.nullable(),
    statusQueries: z.number().int().min(0),
    createdAt: timestamp,
    submittedAt: timestamp.nullable(),
    acceptedAt: timestamp.nullable(),
    finalizedAt: timestamp.nullable(),
  })
  .strict();

export const paymentRequestSummarySchema = z
  .object({
    id: uuid,
    reference: z.string(),
    kind: paymentRequestKindSchema,
    direction: paymentDirectionSchema,
    purpose: paymentPurposeSchema,
    status: paymentRequestStatusSchema,
    amountMinor,
    currency: z.literal("KES"),
    counterparty: z.string(),
    accountReference: z.string().nullable(),
    description: z.string().nullable(),
    environment: paymentEnvironmentSchema,
    projectId: uuid.nullable(),
    createdAt: timestamp,
    createdBy: actor.nullable(),
    latestAttempt: paymentAttemptSchema.nullable(),
    version,
  })
  .strict();

export const paymentEventSchema = z
  .object({
    id: uuid,
    at: timestamp,
    subjectType: z.enum(["request", "attempt", "callback", "case", "settings", "query"]),
    subjectId: uuid,
    event: z.string(),
    fromStatus: z.string().nullable(),
    toStatus: z.string().nullable(),
    reason: z.string().nullable(),
    actor: actor.nullable(),
    detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .strict();

export const paymentCallbackSchema = z
  .object({
    id: uuid,
    kind: callbackKindSchema,
    status: callbackStatusSchema,
    receivedAt: timestamp,
    processedAt: timestamp.nullable(),
    quarantineReason: quarantineReasonSchema.nullable(),
    requestId: uuid.nullable(),
    attemptId: uuid.nullable(),
    bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
    bodyBytes: z.number().int().min(0),
    duplicates: z.number().int().min(0),
    redactedBody: z.unknown(),
    review: z
      .object({
        decision: z.enum(["resolved", "dismissed"]),
        reason: z.string(),
        by: actor.nullable(),
        at: timestamp,
      })
      .strict()
      .nullable(),
    version,
  })
  .strict();

export const reconciliationCaseSchema = z
  .object({
    id: uuid,
    kind: reconciliationCaseKindSchema,
    status: reconciliationCaseStatusSchema,
    openedAt: timestamp,
    reason: z.string(),
    requestId: uuid.nullable(),
    attemptId: uuid.nullable(),
    callbackId: uuid.nullable(),
    attemptStatus: paymentAttemptStatusSchema.nullable(),
    amountMinor: z.number().int().nullable(),
    owner: z.string(),
    resolution: z.enum(RECONCILIATION_RESOLUTIONS).nullable(),
    resolutionNote: z.string().nullable(),
    resolvedAt: timestamp.nullable(),
    resolvedBy: actor.nullable(),
    canResolve: z.boolean(),
    version,
  })
  .strict();

export const providerQuerySchema = z
  .object({
    id: uuid,
    kind: z.enum(PROVIDER_QUERY_KINDS),
    status: z.enum(PROVIDER_QUERY_STATUSES),
    attemptId: uuid.nullable(),
    resultCode: z.string().nullable(),
    summary: z.string().nullable(),
    createdAt: timestamp,
    answeredAt: timestamp.nullable(),
  })
  .strict();

export const providerTransactionSchema = z
  .object({
    id: uuid,
    kind: z.enum(PROVIDER_TRANSACTION_KINDS),
    direction: paymentDirectionSchema,
    status: z.enum(PROVIDER_TRANSACTION_STATUSES),
    receipt: z.string(),
    amountMinor: z.number().int(),
    currency: z.literal("KES"),
    shortcode: z.string().nullable(),
    accountReference: z.string().nullable(),
    attemptId: uuid.nullable(),
    callbackId: uuid.nullable(),
    recordedAt: timestamp,
  })
  .strict();

export const paymentRequestResponseSchema = z
  .object({ request: paymentRequestSummarySchema })
  .strict();

export const paymentRequestsResponseSchema = z
  .object({ requests: z.array(paymentRequestSummarySchema), total: z.number().int().min(0) })
  .strict();

export const paymentRequestDetailResponseSchema = z
  .object({
    request: paymentRequestSummarySchema,
    attempts: z.array(paymentAttemptSchema),
    timeline: z.array(paymentEventSchema),
    callbacks: z.array(paymentCallbackSchema),
    cases: z.array(reconciliationCaseSchema),
    queries: z.array(providerQuerySchema),
    transactions: z.array(providerTransactionSchema),
    canReverse: z.boolean(),
    canQueryStatus: z.boolean(),
  })
  .strict();

export const paymentCallbacksResponseSchema = z
  .object({
    callbacks: z.array(paymentCallbackSchema),
    total: z.number().int().min(0),
    openAlerts: z.number().int().min(0),
  })
  .strict();

export const paymentCallbackResponseSchema = z
  .object({ callback: paymentCallbackSchema, canReview: z.boolean() })
  .strict();

export const reconciliationCasesResponseSchema = z
  .object({
    cases: z.array(reconciliationCaseSchema),
    total: z.number().int().min(0),
    open: z.number().int().min(0),
  })
  .strict();

export const reconciliationCaseResponseSchema = z
  .object({ case: reconciliationCaseSchema, timeline: z.array(paymentEventSchema) })
  .strict();

export const balanceSchema = z
  .object({
    account: z.string(),
    currency: z.string(),
    availableMinor: z.number().int().nullable(),
  })
  .strict();

export const balanceCheckSchema = z
  .object({
    id: uuid,
    status: z.enum(PROVIDER_QUERY_STATUSES),
    requestedAt: timestamp,
    answeredAt: timestamp.nullable(),
    balances: z.array(balanceSchema).nullable(),
  })
  .strict();

export const balanceCheckResponseSchema = z.object({ check: balanceCheckSchema }).strict();

export const paymentsOverviewResponseSchema = z
  .object({
    configured: z.boolean(),
    environment: paymentEnvironmentSchema.nullable(),
    payoutsEnabled: z.boolean(),
    counts: z
      .object({
        inProgress: z.number().int().min(0),
        uncertain: z.number().int().min(0),
        confirmed: z.number().int().min(0),
        failed: z.number().int().min(0),
        openCases: z.number().int().min(0),
        quarantinedCallbacks: z.number().int().min(0),
        receivedCallbacks: z.number().int().min(0),
        pendingOutbox: z.number().int().min(0),
      })
      .strict(),
    oldestUncertainAt: timestamp.nullable(),
    latestBalance: balanceCheckSchema.nullable(),
    receipts: z.array(providerTransactionSchema),
    permissions: z
      .object({
        view: z.boolean(),
        review: z.boolean(),
        manageCredentials: z.boolean(),
        initiateTest: z.boolean(),
        reverse: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type PaymentSettingsResponse = z.infer<typeof paymentSettingsResponseSchema>;
export type PaymentSettings = z.infer<typeof paymentSettingsSchema>;
export type UpdatePaymentSettingsRequest = z.infer<typeof updatePaymentSettingsRequestSchema>;
export type UpdatePaymentCredentialsRequest = z.infer<typeof updatePaymentCredentialsRequestSchema>;
export type CreateTestPaymentRequest = z.infer<typeof createTestPaymentRequestSchema>;
export type ResolveCaseRequest = z.infer<typeof resolveCaseRequestSchema>;
export type ReviewCallbackRequest = z.infer<typeof reviewCallbackRequestSchema>;
export type PaymentAttempt = z.infer<typeof paymentAttemptSchema>;
export type PaymentRequestSummary = z.infer<typeof paymentRequestSummarySchema>;
export type PaymentEvent = z.infer<typeof paymentEventSchema>;
export type PaymentCallback = z.infer<typeof paymentCallbackSchema>;
export type ReconciliationCase = z.infer<typeof reconciliationCaseSchema>;
export type ProviderQuery = z.infer<typeof providerQuerySchema>;
export type ProviderTransaction = z.infer<typeof providerTransactionSchema>;
export type PaymentRequestDetailResponse = z.infer<typeof paymentRequestDetailResponseSchema>;
export type PaymentRequestsResponse = z.infer<typeof paymentRequestsResponseSchema>;
export type PaymentCallbacksResponse = z.infer<typeof paymentCallbacksResponseSchema>;
export type PaymentCallbackResponse = z.infer<typeof paymentCallbackResponseSchema>;
export type ReconciliationCasesResponse = z.infer<typeof reconciliationCasesResponseSchema>;
export type ReconciliationCaseResponse = z.infer<typeof reconciliationCaseResponseSchema>;
export type BalanceCheck = z.infer<typeof balanceCheckSchema>;
export type PaymentsOverviewResponse = z.infer<typeof paymentsOverviewResponseSchema>;
export type PaymentLimitsWire = z.infer<typeof paymentLimitsSchema>;
export type PaymentShortcodes = z.infer<typeof paymentShortcodesSchema>;
