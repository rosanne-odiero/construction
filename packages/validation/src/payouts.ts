import {
  APPROVAL_BLOCKERS,
  APPROVAL_LIMIT_BOUNDS,
  APPROVAL_LIMIT_SOURCES,
  CARRY_FORWARD_STATUSES,
  MANUAL_CHANNEL_REASONS,
  MANUAL_PAYMENT_LIMITS,
  MANUAL_PAYOUT_METHODS,
  NAME_CHECK_RESULTS,
  NOTIFICATION_ERROR_CODES,
  OBLIGATION_PROGRESS_STATUSES,
  PAYOUT_BLOCK_REASONS,
  PAYOUT_DISPLAY_STATUSES,
  PAYOUT_FLAG_CODES,
  PAYOUT_FLAG_STATUSES,
  PAYOUT_HOLD_KINDS,
  PAYOUT_HOLD_STATES,
  PAYOUT_SETTINGS_LIMITS,
  PAYROLL_DECISION_ACTIONS,
  PAYROLL_DECISION_LIMITS,
  PAYROLL_NOTIFICATION_CHANNELS,
  PAYROLL_NOTIFICATION_KINDS,
  PAYROLL_NOTIFICATION_STATUSES,
  PAYROLL_OBLIGATION_CHANNELS,
  PAYROLL_OBLIGATION_STATUSES,
  PAYROLL_PAYOUT_METHODS,
  PAYROLL_PAYOUT_STATUSES,
  PAYSLIP_NOTICE_STATES,
  RECIPIENT_VERIFICATION_METHODS,
  RECIPIENT_VERIFICATION_STATES,
  TENANT_SYSTEM_ROLES,
} from "@pm-buddy/types";
import { z } from "zod";
import { localeSchema } from "./labour.js";
import { balanceCheckSchema, paymentRequestStatusSchema } from "./payments.js";
import { payrollBatchSchema, payrollReasonSchema } from "./payroll.js";

/**
 * Payroll approvals and payouts (D4.3): review, rejection, reopening and approval of a batch with
 * its approval snapshot; obligations with their M-Pesa, cash and bank payouts, live per-worker
 * status, unusual-payout flags and payslip notifications; payout settings, the segregation waiver
 * and approval limits; and the payout side of a worker record (in-person number verification,
 * holds, the change hold). Requests are strict; money is integer KES minor units; dates are
 * YYYY-MM-DD in Africa/Nairobi; phone numbers and receiver names leave the API masked, except the
 * receiver name of a name mismatch shown to payments.approve / payments.review holders.
 * Every command takes an `Idempotency-Key` header (shared rules). Obligations and payouts are
 * whole shillings; the cents of each line's net are carried to the worker's next payroll (D-167).
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();
const version = z.number().int().min(1).max(2_147_483_647);
/** 0 means "still on the defaults" (no row saved yet). */
const versionOrZero = z.number().int().min(0).max(2_147_483_647);
const minor = z.number().int().refine(Number.isSafeInteger, "amount_out_of_range");
const positiveMinor = minor.refine((value) => value > 0, "amount_not_positive");
const count = z.number().int().min(0);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "invalid_digest");
const actor = z.object({ id: uuid, displayName: z.string().min(1).max(100) }).strict();
const projectRef = z.object({ id: uuid, code: z.string(), name: z.string() }).strict();
const labourerRef = z.object({ id: uuid, workerNo: z.string(), fullName: z.string() }).strict();
const masked = z.string().max(40);
/** The cents of a line's net carried to the next payroll (0 when none, D-167). */
const carryMinor = z.number().int().min(0).max(99);
const wholeShillings = (value: number) => value % 100 === 0;
const unique = (values: readonly string[]) => new Set(values).size === values.length;
/** A configured money limit: whole shillings within the approval-limit bounds. */
const limitMinor = z
  .number()
  .int()
  .min(APPROVAL_LIMIT_BOUNDS.minMinor)
  .max(APPROVAL_LIMIT_BOUNDS.maxMinor)
  .refine((value) => value % 100 === 0, "whole_shillings");
/** A 24-hour time of day, `HH:MM` (Africa/Nairobi). */
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "invalid_time");

/** A reason for a rejection, a release, a waiver, a resolution: 10–500 characters. */
export const payoutReasonSchema = payrollReasonSchema;
/** An optional review or approval note. */
const decisionNote = z.string().trim().max(PAYROLL_DECISION_LIMITS.noteMax);

export const payrollObligationStatusSchema = z.enum(PAYROLL_OBLIGATION_STATUSES);
export const payrollObligationChannelSchema = z.enum(PAYROLL_OBLIGATION_CHANNELS);
export const manualChannelReasonSchema = z.enum(MANUAL_CHANNEL_REASONS);
export const payrollPayoutMethodSchema = z.enum(PAYROLL_PAYOUT_METHODS);
export const manualPayoutMethodSchema = z.enum(MANUAL_PAYOUT_METHODS);
export const payrollPayoutStatusSchema = z.enum(PAYROLL_PAYOUT_STATUSES);
export const payoutDisplayStatusSchema = z.enum(PAYOUT_DISPLAY_STATUSES);
export const obligationProgressSchema = z.enum(OBLIGATION_PROGRESS_STATUSES);
export const nameCheckResultSchema = z.enum(NAME_CHECK_RESULTS);
export const payoutBlockReasonSchema = z.enum(PAYOUT_BLOCK_REASONS);
export const payoutFlagCodeSchema = z.enum(PAYOUT_FLAG_CODES);
export const payoutFlagStatusSchema = z.enum(PAYOUT_FLAG_STATUSES);
export const payoutHoldKindSchema = z.enum(PAYOUT_HOLD_KINDS);
export const payoutHoldStateSchema = z.enum(PAYOUT_HOLD_STATES);
export const recipientVerificationMethodSchema = z.enum(RECIPIENT_VERIFICATION_METHODS);
export const recipientVerificationStateSchema = z.enum(RECIPIENT_VERIFICATION_STATES);
export const approvalBlockerSchema = z.enum(APPROVAL_BLOCKERS);
export const approvalLimitSourceSchema = z.enum(APPROVAL_LIMIT_SOURCES);
export const payrollDecisionActionSchema = z.enum(PAYROLL_DECISION_ACTIONS);
export const payrollNotificationKindSchema = z.enum(PAYROLL_NOTIFICATION_KINDS);
export const payrollNotificationChannelSchema = z.enum(PAYROLL_NOTIFICATION_CHANNELS);
export const payrollNotificationStatusSchema = z.enum(PAYROLL_NOTIFICATION_STATUSES);
export const notificationErrorCodeSchema = z.enum(NOTIFICATION_ERROR_CODES);
export const payslipNoticeStateSchema = z.enum(PAYSLIP_NOTICE_STATES);
export const carryForwardStatusSchema = z.enum(CARRY_FORWARD_STATUSES);

// Batch decisions (review, reject, reopen, approve) -----------------------------------------------

/**
 * One row of the append-only decision log (non-repudiation, T-12, A-17): `actionHash` is
 * `sha256(batchId|version|digest|approvalDigest|net|action)`.
 */
export const batchDecisionSchema = z
  .object({
    id: uuid,
    action: payrollDecisionActionSchema,
    actor,
    batchVersion: version,
    digest: sha256Hex,
    approvalDigest: sha256Hex.nullable(),
    netMinor: minor,
    /** The approver's applied limit (approvals only). */
    appliedLimitMinor: minor.nullable(),
    underWaiver: z.boolean(),
    stepUpAt: timestamp.nullable(),
    actionHash: sha256Hex,
    /** The review or approval note, or the rejection reason. */
    note: z.string().nullable(),
    /** The obligation a `destination_approve` decision re-approved. */
    obligationId: uuid.nullable(),
    createdAt: timestamp,
  })
  .strict();
export type BatchDecision = z.infer<typeof batchDecisionSchema>;

/**
 * `POST payroll/batches/:id/review`: the snapshot digest the reviewer saw (409 `snapshot-changed`).
 */
export const reviewBatchRequestSchema = z
  .object({ version, digest: sha256Hex, note: decisionNote.optional() })
  .strict();
export type ReviewBatchRequest = z.input<typeof reviewBatchRequestSchema>;

/** `POST payroll/batches/:id/reject`: from submitted or reviewed; no obligations are created. */
export const rejectBatchRequestSchema = z.object({ version, reason: payrollReasonSchema }).strict();
export type RejectBatchRequest = z.input<typeof rejectBatchRequestSchema>;

/** `POST payroll/batches/:id/reopen`: rejected → draft, version + 1 (payroll.prepare). */
export const reopenBatchRequestSchema = z.object({ version }).strict();
export type ReopenBatchRequest = z.input<typeof reopenBatchRequestSchema>;

/**
 * `POST payroll/batches/:id/approve` (payroll.approve + fresh step-up): binds both the snapshot
 * digest and the approval digest shown by the readiness view (409 `snapshot-changed`).
 */
export const approveBatchRequestSchema = z
  .object({
    version,
    digest: sha256Hex,
    approvalDigest: sha256Hex,
    note: decisionNote.optional(),
  })
  .strict();
export type ApproveBatchRequest = z.input<typeof approveBatchRequestSchema>;

/** The answer to review, reject and reopen. */
export const batchDecisionResponseSchema = z
  .object({ batch: payrollBatchSchema, decision: batchDecisionSchema })
  .strict();
export type BatchDecisionResponse = z.infer<typeof batchDecisionResponseSchema>;

export const approveBatchResponseSchema = z
  .object({
    batch: payrollBatchSchema,
    decision: batchDecisionSchema,
    obligations: z
      .object({
        total: count,
        mpesa: count,
        manual: count,
        flagged: count,
        amountMinor: minor,
        /** Carry-forwards created (one per line whose net has cents) and their sum. */
        carryForwards: count,
        carryForwardMinor: minor,
      })
      .strict(),
  })
  .strict();
export type ApproveBatchResponse = z.infer<typeof approveBatchResponseSchema>;

// Recipients (shared by the approval view, the payouts view and the worker record) --------------

export const recipientVerificationSchema = z
  .object({
    id: uuid,
    method: recipientVerificationMethodSchema,
    note: z.string().nullable(),
    /** The number that was verified, masked. */
    phoneMasked: masked.nullable(),
    /** It verifies the labourer's current number (a later change makes it stale). */
    current: z.boolean(),
    verifiedBy: actor,
    verifiedAt: timestamp,
  })
  .strict();
export type RecipientVerification = z.infer<typeof recipientVerificationSchema>;

export const payoutHoldSchema = z
  .object({
    id: uuid,
    labourerId: uuid,
    kind: payoutHoldKindSchema,
    state: payoutHoldStateSchema,
    phoneMasked: masked.nullable(),
    reason: z.string(),
    /** The payout whose receiver name did not match (`name_mismatch` holds). */
    payoutId: uuid.nullable(),
    /** Null when the system placed it (a name mismatch). */
    createdBy: actor.nullable(),
    createdAt: timestamp,
    releasedBy: actor.nullable(),
    releasedAt: timestamp.nullable(),
    releaseReason: z.string().nullable(),
  })
  .strict();
export type PayoutHold = z.infer<typeof payoutHoldSchema>;

/** The hold after a number change (OR-05) and the owner's override, if any. */
export const changeHoldSchema = z
  .object({
    changedAt: timestamp,
    changedBy: actor.nullable(),
    until: timestamp,
    active: z.boolean(),
    override: z.object({ by: actor, at: timestamp, reason: z.string() }).strict().nullable(),
  })
  .strict();
export type ChangeHold = z.infer<typeof changeHoldSchema>;

const flagDetails = z.record(z.string(), z.union([z.number(), z.string(), z.boolean()]));

/** A line's place in a carry-forward: the batch line that created or consumed it. */
const carryForwardLineRef = z
  .object({
    batchId: uuid,
    lineId: uuid,
    projectId: uuid,
    periodStart: calendarDate,
    periodEnd: calendarDate,
  })
  .strict();

/**
 * Cents owed to a worker (D-167): created when their line's batch is approved, `consumed` by the
 * line of their next calculated batch (as brought forward), released if that batch is cancelled.
 */
export const carryForwardSchema = z
  .object({
    id: uuid,
    labourer: labourerRef,
    amountMinor: z.number().int().min(1).max(99),
    status: carryForwardStatusSchema,
    source: carryForwardLineRef,
    consumedBy: carryForwardLineRef.nullable(),
    createdAt: timestamp,
    consumedAt: timestamp.nullable(),
  })
  .strict();
export type CarryForward = z.infer<typeof carryForwardSchema>;

// Approval readiness -----------------------------------------------------------------------------

export const approvalRecipientSchema = z
  .object({
    lineId: uuid,
    labourer: labourerRef,
    /** The line's exact net, brought-forward amount included. */
    lineNetMinor: positiveMinor,
    broughtForwardMinor: minor,
    /** The obligation: the net's whole shillings. */
    amountMinor: positiveMinor,
    carryForwardMinor: carryMinor,
    channel: payrollObligationChannelSchema,
    manualReason: manualChannelReasonSchema.nullable(),
    /** The line's payee number (the approved destination), masked. */
    phoneMasked: masked.nullable(),
    /** The labourer's number changed since the batch was calculated (reopen and recalculate). */
    numberChanged: z.boolean(),
    verificationState: recipientVerificationStateSchema,
    verification: recipientVerificationSchema.nullable(),
    activeHolds: z.array(payoutHoldSchema),
    changeHoldUntil: timestamp.nullable(),
    /** Flags approval would raise (§7), with safe details only. */
    flags: z.array(z.object({ code: payoutFlagCodeSchema, details: flagDetails }).strict()),
  })
  .strict();
export type ApprovalRecipient = z.infer<typeof approvalRecipientSchema>;

export const waiverStateSchema = z
  .object({
    enabled: z.boolean(),
    reason: z.string().nullable(),
    limitMinor: minor,
    changedBy: actor.nullable(),
    changedAt: timestamp.nullable(),
  })
  .strict();
export type WaiverState = z.infer<typeof waiverStateSchema>;

/**
 * `GET payroll/batches/:id/approval`: what an approval would bind and whether the caller may give
 * it. `approvalDigest` is null until the batch is submitted. Lines netting to zero create no
 * obligation and are only counted.
 */
export const batchApprovalResponseSchema = z
  .object({
    project: projectRef,
    batch: payrollBatchSchema,
    approvalDigest: sha256Hex.nullable(),
    recipients: z.array(approvalRecipientSchema),
    /** Lines whose whole net is below KES 1: carried forward, no obligation (D-167). */
    carryForwardOnly: z.array(
      z.object({ lineId: uuid, labourer: labourerRef, carryForwardMinor: carryMinor }).strict(),
    ),
    zeroNetLines: count,
    totals: z
      .object({
        obligations: count,
        netMinor: minor,
        mpesaMinor: minor,
        manualMinor: minor,
        /** Every carry-forward approval creates, and the brought-forward amounts in the nets. */
        carryForwardMinor: minor,
        broughtForwardMinor: minor,
        unverified: count,
        flagged: count,
      })
      .strict(),
    /** The caller's approval limit (after the waiver minimum when they reviewed the batch). */
    limit: z
      .object({
        source: approvalLimitSourceSchema,
        maxBatchNetMinor: minor.nullable(),
        appliedLimitMinor: minor.nullable(),
      })
      .strict(),
    waiver: waiverStateSchema.extend({ appliesToCaller: z.boolean() }).strict(),
    /** For the caller, in precedence order; empty when they may approve now. */
    blockers: z.array(approvalBlockerSchema),
    unverifiedLabourerIds: z.array(uuid),
    separation: z
      .object({
        contributors: z.array(actor),
        reviewer: actor.nullable(),
        approver: actor.nullable(),
      })
      .strict(),
    approvedUnderWaiver: z.boolean(),
    decisions: z.array(batchDecisionSchema),
    permissions: z
      .object({
        canReview: z.boolean(),
        canReject: z.boolean(),
        canReopen: z.boolean(),
        canApprove: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type BatchApprovalResponse = z.infer<typeof batchApprovalResponseSchema>;

// Obligations, payouts, flags and notifications --------------------------------------------------

export const paymentEvidenceSchema = z
  .object({
    id: uuid,
    contentType: z.enum(MANUAL_PAYMENT_LIMITS.evidenceContentTypes),
    sizeBytes: z.number().int().min(1),
    scanStatus: z.enum(["clean", "not_scanned"]),
    uploadedAt: timestamp,
    uploadedBy: actor,
  })
  .strict();
export type PaymentEvidence = z.infer<typeof paymentEvidenceSchema>;

export const payrollPayoutSchema = z
  .object({
    id: uuid,
    obligationId: uuid,
    method: payrollPayoutMethodSchema,
    amountMinor: positiveMinor,
    status: payrollPayoutStatusSchema,
    displayStatus: payoutDisplayStatusSchema,
    version,
    /** M-Pesa: the D4.2 payment request and its summary status. */
    paymentRequestId: uuid.nullable(),
    requestStatus: paymentRequestStatusSchema.nullable(),
    receipt: z.string().nullable(),
    /** A definite failure's safe result code and description. */
    failure: z
      .object({ code: z.string().nullable(), description: z.string().nullable() })
      .strict()
      .nullable(),
    /** The tariff charge booked when it confirmed. */
    chargeMinor: minor.nullable(),
    nameCheck: z
      .object({
        result: nameCheckResultSchema,
        score: z.number().min(0).max(1).nullable(),
        /** Only on a mismatch, and only to payments.approve / payments.review holders. */
        receiverName: z.string().nullable(),
      })
      .strict()
      .nullable(),
    /** Cash and bank: the record and its second-person confirmation. */
    reference: z.string().nullable(),
    paidOn: calendarDate.nullable(),
    reason: z.string().nullable(),
    evidence: z.array(paymentEvidenceSchema),
    /** Who started the M-Pesa payout or recorded the cash or bank payment. */
    createdBy: actor.nullable(),
    confirmedBy: actor.nullable(),
    confirmedAt: timestamp.nullable(),
    rejectionReason: z.string().nullable(),
    createdAt: timestamp,
    finishedAt: timestamp.nullable(),
  })
  .strict();
export type PayrollPayout = z.infer<typeof payrollPayoutSchema>;

export const payoutFlagSchema = z
  .object({
    id: uuid,
    obligationId: uuid,
    code: payoutFlagCodeSchema,
    status: payoutFlagStatusSchema,
    details: flagDetails,
    createdAt: timestamp,
    /**
     * Who tried to start the payout (`outside_business_hours`); null for flags raised at approval.
     */
    createdBy: actor.nullable(),
    clearedBy: actor.nullable(),
    clearedAt: timestamp.nullable(),
    clearReason: z.string().nullable(),
  })
  .strict();
export type PayoutFlag = z.infer<typeof payoutFlagSchema>;

export const payrollNotificationSchema = z
  .object({
    id: uuid,
    kind: payrollNotificationKindSchema,
    channel: payrollNotificationChannelSchema,
    recipientMasked: masked,
    language: localeSchema,
    status: payrollNotificationStatusSchema,
    attempts: count,
    nextAttemptAt: timestamp.nullable(),
    lastErrorCode: notificationErrorCodeSchema.nullable(),
    sentAt: timestamp.nullable(),
    createdAt: timestamp,
  })
  .strict();
export type PayrollNotification = z.infer<typeof payrollNotificationSchema>;

export const obligationSchema = z
  .object({
    id: uuid,
    batchId: uuid,
    projectId: uuid,
    lineId: uuid,
    labourer: labourerRef,
    /** Whole shillings: the line's net less the cents carried forward (D-167). */
    amountMinor: positiveMinor,
    paidMinor: minor,
    outstandingMinor: minor,
    /** The line's exact net, the brought-forward amount it includes and its carried cents. */
    lineNetMinor: positiveMinor,
    broughtForwardMinor: minor,
    carryForwardMinor: carryMinor,
    status: payrollObligationStatusSchema,
    channel: payrollObligationChannelSchema,
    manualReason: manualChannelReasonSchema.nullable(),
    /** The approved destination and the labourer's current number, masked. */
    destinationMasked: masked.nullable(),
    currentPhoneMasked: masked.nullable(),
    verificationId: uuid.nullable(),
    destinationApprovedBy: actor.nullable(),
    destinationApprovedAt: timestamp.nullable(),
    progress: obligationProgressSchema,
    /** Why a new M-Pesa payout cannot start now (empty = eligible). */
    blockReasons: z.array(payoutBlockReasonSchema),
    changeHoldUntil: timestamp.nullable(),
    flags: z.array(payoutFlagSchema),
    payouts: z.array(payrollPayoutSchema),
    payslip: z
      .object({
        state: payslipNoticeStateSchema,
        notification: payrollNotificationSchema.nullable(),
      })
      .strict(),
    version,
    createdAt: timestamp,
  })
  .strict();
export type Obligation = z.infer<typeof obligationSchema>;

const progressCounts = z
  .object(
    Object.fromEntries(OBLIGATION_PROGRESS_STATUSES.map((status) => [status, count])) as {
      [K in (typeof OBLIGATION_PROGRESS_STATUSES)[number]]: typeof count;
    },
  )
  .strict();

/** The latest answered float (Account Balance) check and how much is committed since. */
export const floatStatusSchema = z
  .object({
    latest: balanceCheckSchema.nullable(),
    utilityAvailableMinor: minor.nullable(),
    ageMinutes: count.nullable(),
    maxAgeMinutes: count,
    fresh: z.boolean(),
    /** Payroll payouts created after that answer and not failed (amounts and charges). */
    inFlightMinor: minor,
  })
  .strict();
export type FloatStatus = z.infer<typeof floatStatusSchema>;

/** `GET payroll/batches/:id/payouts`: live per-worker status (joined from D4.2) and totals. */
export const batchPayoutsResponseSchema = z
  .object({
    project: projectRef,
    batch: payrollBatchSchema,
    approvedUnderWaiver: z.boolean(),
    obligations: z.array(obligationSchema),
    totals: z
      .object({
        obligations: count,
        amountMinor: minor,
        paidMinor: minor,
        outstandingMinor: minor,
        settled: count,
        eligible: count,
        eligibleMinor: minor,
        /** Tariff estimate for paying every eligible obligation now. */
        eligibleChargesMinor: minor,
        /** Charges booked for confirmed M-Pesa payouts. */
        chargesMinor: minor,
        /** Cents carried to the workers' next payroll, and brought forward into these nets. */
        carryForwardMinor: minor,
        broughtForwardMinor: minor,
        byProgress: progressCounts,
      })
      .strict(),
    /** Every carry-forward this batch created, including lines without an obligation. */
    carryForwards: z.array(carryForwardSchema),
    float: floatStatusSchema,
    payoutsEnabled: z.boolean(),
    businessHours: z.object({ start: clock, end: clock, open: z.boolean() }).strict(),
    permissions: z
      .object({
        canFloatCheck: z.boolean(),
        canStart: z.boolean(),
        canRecordManual: z.boolean(),
        canConfirmManual: z.boolean(),
        canApproveDestination: z.boolean(),
        canClearFlags: z.boolean(),
        canResend: z.boolean(),
        canViewReceiverNames: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type BatchPayoutsResponse = z.infer<typeof batchPayoutsResponseSchema>;

/** `POST payroll/batches/:id/float-check` (payments.disburse): asks D4.2 for the balance. */
export const floatCheckRequestSchema = z.object({}).strict();
export const floatCheckResponseSchema = z.object({ check: balanceCheckSchema }).strict();
export type FloatCheckResponse = z.infer<typeof floatCheckResponseSchema>;

/**
 * `POST payroll/batches/:id/payouts` (payments.disburse + step-up): pays every eligible obligation
 * of the batch, or only `obligationIds`, for its whole outstanding amount. Refusals are problems
 * (`payouts-paused`, `nothing-eligible`, `float-check-required`, `tariff-missing`,
 * `insufficient-float`, `daily-limit-exceeded`); outside business hours nothing is sent and the
 * eligible obligations are flagged instead (`outcome: outside_business_hours`).
 */
export const startPayoutsRequestSchema = z
  .object({
    obligationIds: z
      .array(uuid)
      .min(1)
      .max(1_000)
      .refine(unique, "duplicate_obligation")
      .optional(),
  })
  .strict();
export type StartPayoutsRequest = z.input<typeof startPayoutsRequestSchema>;

export const startPayoutsResponseSchema = z
  .object({
    outcome: z.enum(["submitted", "outside_business_hours"]),
    payouts: z.array(
      z
        .object({
          id: uuid,
          obligationId: uuid,
          amountMinor: positiveMinor,
          chargeMinor: minor,
          paymentRequestId: uuid,
        })
        .strict(),
    ),
    flagged: z.array(z.object({ obligationId: uuid, flagId: uuid }).strict()),
    ineligible: z.array(
      z.object({ obligationId: uuid, reasons: z.array(payoutBlockReasonSchema) }).strict(),
    ),
    totals: z.object({ payouts: count, amountMinor: minor, chargesMinor: minor }).strict(),
    float: z
      .object({
        availableMinor: minor,
        inFlightMinor: minor,
        requiredMinor: minor,
        answeredAt: timestamp,
      })
      .strict()
      .nullable(),
    batch: payrollBatchSchema,
  })
  .strict();
export type StartPayoutsResponse = z.infer<typeof startPayoutsResponseSchema>;

// Cash and bank (record-only) --------------------------------------------------------------------

const reference = z
  .string()
  .trim()
  .min(MANUAL_PAYMENT_LIMITS.referenceMin)
  .max(MANUAL_PAYMENT_LIMITS.referenceMax)
  .regex(/^[A-Za-z0-9 _#/.:-]+$/, "invalid_reference");
const manualCommon = {
  /** Whole shillings, like the obligation (D-167). */
  amountMinor: positiveMinor.refine(wholeShillings, "whole_shillings"),
  paidOn: calendarDate,
};

/**
 * `POST payroll/obligations/:id/manual-payments` (payments.record_cash + step-up): cash needs a
 * reason and then photo or signature evidence (`POST payroll/manual-payments/:id/evidence`,
 * multipart `file`) before it can be confirmed; bank needs its reference. The amount is at most
 * the outstanding; cash also within the per-worker period cap (409 `cash-cap-exceeded`,
 * `cash-disabled`).
 */
export const recordManualPaymentRequestSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("cash"),
      ...manualCommon,
      reason: payoutReasonSchema,
      reference: reference.optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("bank"),
      ...manualCommon,
      reason: payoutReasonSchema.optional(),
      reference,
    })
    .strict(),
]);
export type RecordManualPaymentRequest = z.input<typeof recordManualPaymentRequestSchema>;

/** `POST payroll/manual-payments/:id/confirm` (payments.approve + step-up, not the recorder). */
export const confirmManualPaymentRequestSchema = z.object({ version }).strict();
/** `POST payroll/manual-payments/:id/reject` (payments.approve + step-up, not the recorder). */
export const rejectManualPaymentRequestSchema = z
  .object({ version, reason: payoutReasonSchema })
  .strict();
export type ConfirmManualPaymentRequest = z.input<typeof confirmManualPaymentRequestSchema>;
export type RejectManualPaymentRequest = z.input<typeof rejectManualPaymentRequestSchema>;

/** The answer to recording, confirming or rejecting a manual payment. */
export const manualPaymentResponseSchema = z
  .object({ payout: payrollPayoutSchema, obligation: obligationSchema })
  .strict();
export type ManualPaymentResponse = z.infer<typeof manualPaymentResponseSchema>;

export const paymentEvidenceResponseSchema = z.object({ evidence: paymentEvidenceSchema }).strict();
export type PaymentEvidenceResponse = z.infer<typeof paymentEvidenceResponseSchema>;

// Destination re-approval, flags, notifications --------------------------------------------------

/**
 * `POST payroll/obligations/:id/destination-approval` (payroll.approve + step-up): re-approves the
 * labourer's changed number, naming the verification of the new number that was shown.
 */
export const destinationApprovalRequestSchema = z
  .object({ version, verificationId: uuid, note: decisionNote.optional() })
  .strict();
export type DestinationApprovalRequest = z.input<typeof destinationApprovalRequestSchema>;
export const obligationResponseSchema = z
  .object({ obligation: obligationSchema, decision: batchDecisionSchema.nullable() })
  .strict();
export type ObligationResponse = z.infer<typeof obligationResponseSchema>;

/** `POST payroll/flags/:id/clear` (payments.approve + step-up). */
export const clearFlagRequestSchema = z.object({ reason: payoutReasonSchema }).strict();
export type ClearFlagRequest = z.input<typeof clearFlagRequestSchema>;
export const payoutFlagResponseSchema = z.object({ flag: payoutFlagSchema }).strict();
export type PayoutFlagResponse = z.infer<typeof payoutFlagResponseSchema>;

/** `POST payroll/notifications/:id/resend` (payments.disburse): re-queues a failed one only. */
export const resendNotificationRequestSchema = z.object({}).strict();
export const payrollNotificationResponseSchema = z
  .object({ notification: payrollNotificationSchema })
  .strict();
export type PayrollNotificationResponse = z.infer<typeof payrollNotificationResponseSchema>;

// Payout settings, the waiver and approval limits -------------------------------------------------

const threshold = z
  .number()
  .min(PAYOUT_SETTINGS_LIMITS.nameMatchThreshold.min)
  .max(PAYOUT_SETTINGS_LIMITS.nameMatchThreshold.max)
  .refine((value) => /^(0\.\d{1,2}|1(\.0{1,2})?)$/.test(String(value)), "two_decimals");

const settingsFields = {
  cashMaxPerWorkerPeriodMinor: z
    .number()
    .int()
    .min(PAYOUT_SETTINGS_LIMITS.cashMaxPerWorkerPeriodMinor.min)
    .max(PAYOUT_SETTINGS_LIMITS.cashMaxPerWorkerPeriodMinor.max)
    .refine((value) => value % 100 === 0, "whole_shillings"),
  nameMatchThreshold: threshold,
  nameMismatchHold: z.boolean(),
  payeeChangeHoldHours: z
    .number()
    .int()
    .min(PAYOUT_SETTINGS_LIMITS.payeeChangeHoldHours.min)
    .max(PAYOUT_SETTINGS_LIMITS.payeeChangeHoldHours.max),
  unusualNewRecipientMinor: z
    .number()
    .int()
    .min(PAYOUT_SETTINGS_LIMITS.unusualNewRecipientMinor.min)
    .max(PAYOUT_SETTINGS_LIMITS.unusualNewRecipientMinor.max)
    .refine((value) => value % 100 === 0, "whole_shillings"),
  businessHoursStart: clock,
  businessHoursEnd: clock,
  floatCheckMaxAgeMinutes: z
    .number()
    .int()
    .min(PAYOUT_SETTINGS_LIMITS.floatCheckMaxAgeMinutes.min)
    .max(PAYOUT_SETTINGS_LIMITS.floatCheckMaxAgeMinutes.max),
};

export const payoutSettingsSchema = z
  .object({
    ...settingsFields,
    waiver: waiverStateSchema,
    version: versionOrZero,
    updatedBy: actor.nullable(),
    updatedAt: timestamp.nullable(),
  })
  .strict();
export type PayoutSettings = z.infer<typeof payoutSettingsSchema>;

/** `GET payroll/payout-settings` (payments.view or payroll.approve); the defaults until saved. */
export const payoutSettingsResponseSchema = z
  .object({
    settings: payoutSettingsSchema,
    canManage: z.boolean(),
    /** Only a member whose system role is `owner` changes the waiver. */
    canManageWaiver: z.boolean(),
  })
  .strict();
export type PayoutSettingsResponse = z.infer<typeof payoutSettingsResponseSchema>;

/** `PUT payroll/payout-settings` (config.manage + step-up); the waiver has its own command. */
export const updatePayoutSettingsRequestSchema = z
  .object({ ...settingsFields, version: versionOrZero })
  .strict()
  .refine((value) => value.businessHoursStart < value.businessHoursEnd, {
    message: "business_hours_order",
    path: ["businessHoursEnd"],
  });
export type UpdatePayoutSettingsRequest = z.input<typeof updatePayoutSettingsRequestSchema>;

/**
 * `PUT payroll/payout-settings/waiver` (system role owner + config.manage + step-up, OR-04):
 * enabling or disabling needs a reason; `limitMinor` sets the waiver's batch limit (default
 * KES 500,000).
 */
export const updateWaiverRequestSchema = z
  .object({
    version: versionOrZero,
    enabled: z.boolean(),
    reason: payoutReasonSchema,
    limitMinor: limitMinor.optional(),
  })
  .strict();
export type UpdateWaiverRequest = z.input<typeof updateWaiverRequestSchema>;

const tenantSystemRole = z.enum(TENANT_SYSTEM_ROLES);
const limitRole = {
  /** A system role key or a custom role ID: exactly one. */
  systemRole: tenantSystemRole.nullable(),
  customRoleId: uuid.nullable(),
};
const oneRole = (value: { systemRole: unknown; customRoleId: unknown }) =>
  (value.systemRole === null) !== (value.customRoleId === null);

export const approvalLimitSchema = z
  .object({
    ...limitRole,
    roleName: z.string(),
    maxBatchNetMinor: minor,
    updatedBy: actor.nullable(),
    updatedAt: timestamp.nullable(),
  })
  .strict();
export type ApprovalLimitEntry = z.infer<typeof approvalLimitSchema>;

/**
 * `GET payroll/approval-limits`: configured rows, the owner default (used while the owner has no
 * row) and the roles a limit can be set for (those holding payroll.approve).
 */
export const approvalLimitsResponseSchema = z
  .object({
    limits: z.array(approvalLimitSchema),
    ownerDefaultMinor: minor,
    roles: z.array(z.object({ ...limitRole, name: z.string() }).strict()),
    version: versionOrZero,
    canManage: z.boolean(),
  })
  .strict();
export type ApprovalLimitsResponse = z.infer<typeof approvalLimitsResponseSchema>;

/** `PUT payroll/approval-limits` (config.manage + step-up): replaces the whole set. */
export const updateApprovalLimitsRequestSchema = z
  .object({
    version: versionOrZero,
    limits: z
      .array(
        z
          .object({ ...limitRole, maxBatchNetMinor: limitMinor })
          .strict()
          .refine(oneRole, { message: "one_role", path: ["customRoleId"] }),
      )
      .max(50)
      .refine(
        (rows) => unique(rows.map((row) => row.systemRole ?? `custom:${row.customRoleId}`)),
        "duplicate_role",
      ),
  })
  .strict();
export type UpdateApprovalLimitsRequest = z.input<typeof updateApprovalLimitsRequestSchema>;

// The payout side of a worker record (labour endpoints) -------------------------------------------

/**
 * `GET labour/labourers/:id/payout-status`, also the answer to the verification, hold, release and
 * change-hold override commands.
 */
export const labourerPayoutStatusResponseSchema = z
  .object({
    labourer: z
      .object({
        id: uuid,
        workerNo: z.string(),
        fullName: z.string(),
        preferredLanguage: localeSchema,
        phoneMasked: masked.nullable(),
        version,
      })
      .strict(),
    verificationState: recipientVerificationStateSchema,
    /** Every in-person verification, newest first (`current` marks the valid one). */
    verifications: z.array(recipientVerificationSchema),
    changeHold: changeHoldSchema.nullable(),
    holds: z.array(payoutHoldSchema),
    /** What blocks M-Pesa payouts to this worker now (`unverified`, `on-hold`, `change-hold`). */
    blockReasons: z.array(payoutBlockReasonSchema),
    openObligations: count,
    outstandingMinor: minor,
    /** Cents owed to the worker until their next payroll brings them forward (D-167). */
    openCarryForwardMinor: minor,
    /** The open carry-forwards. */
    carryForwards: z.array(carryForwardSchema),
    permissions: z
      .object({
        canVerify: z.boolean(),
        canPlaceHold: z.boolean(),
        canReleaseHolds: z.boolean(),
        canOverrideChangeHold: z.boolean(),
        canSetLanguage: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type LabourerPayoutStatusResponse = z.infer<typeof labourerPayoutStatusResponseSchema>;

/**
 * `POST labour/labourers/:id/payout-verifications` (labour.manage + step-up): the verifier checked
 * the worker's ID in person; `version` binds the labourer record (and so the number) shown. Not
 * whoever changed the number, nor the registrar when it was entered at registration (403
 * `maker-checker`).
 */
export const createPayoutVerificationRequestSchema = z
  .object({
    version,
    method: recipientVerificationMethodSchema,
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type CreatePayoutVerificationRequest = z.input<typeof createPayoutVerificationRequestSchema>;

/** `POST labour/labourers/:id/payout-holds` (payments.approve): a manual hold. */
export const createPayoutHoldRequestSchema = z.object({ reason: payoutReasonSchema }).strict();
export type CreatePayoutHoldRequest = z.input<typeof createPayoutHoldRequestSchema>;

/** `POST labour/payout-holds/:id/release` (payments.approve + step-up). */
export const releasePayoutHoldRequestSchema = z.object({ reason: payoutReasonSchema }).strict();
export type ReleasePayoutHoldRequest = z.input<typeof releasePayoutHoldRequestSchema>;

/** `POST labour/labourers/:id/change-hold-override` (system role owner + step-up). */
export const changeHoldOverrideRequestSchema = z
  .object({ version, reason: payoutReasonSchema })
  .strict();
export type ChangeHoldOverrideRequest = z.input<typeof changeHoldOverrideRequestSchema>;
