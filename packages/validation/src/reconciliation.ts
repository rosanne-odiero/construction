import { tariffBandIssues } from "@pm-buddy/domain";
import {
  PAYROLL_PAYOUT_METHODS,
  RECONCILIATION_ITEM_CATEGORIES,
  RECONCILIATION_ITEM_EVENTS,
  RECONCILIATION_ITEM_KINDS,
  RECONCILIATION_ITEM_OUTCOMES,
  RECONCILIATION_ITEM_SEVERITIES,
  RECONCILIATION_ITEM_STATUSES,
  RECONCILIATION_RUN_TRIGGERS,
  RECONCILIATION_SUBJECT_TYPES,
  STATEMENT_COLUMNS,
  STATEMENT_FORMATS,
  STATEMENT_LINE_CLASSES,
  STATEMENT_ROW_ISSUES,
  TARIFF_KINDS,
  TARIFF_LIMITS,
  TARIFF_STATUSES,
  type ReconciliationItemOutcome,
} from "@pm-buddy/types";
import { z } from "zod";
import { payoutReasonSchema } from "./payouts.js";

/**
 * M-Pesa reconciliation (D4.3 §11–12): uploaded organisation-portal statements and their lines,
 * daily reconciliation items with their append-only history, manual runs, worker disputes and the
 * effective-dated charges tariff. Requests are strict; money is integer KES minor units; business
 * dates are YYYY-MM-DD in Africa/Nairobi; the statement's other-party details leave the API masked.
 * The statement layout is assumed and must be checked against a real export at the sandbox gate.
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();
const version = z.number().int().min(1).max(2_147_483_647);
const minor = z.number().int().refine(Number.isSafeInteger, "amount_out_of_range");
const count = z.number().int().min(0);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "invalid_digest");
const actor = z.object({ id: uuid, displayName: z.string().min(1).max(100) }).strict();
const limit = z.coerce.number().int().min(1).max(200).default(50);
const offset = z.coerce.number().int().min(0).max(100_000).default(0);

export const reconciliationItemKindSchema = z.enum(RECONCILIATION_ITEM_KINDS);
export const reconciliationItemStatusSchema = z.enum(RECONCILIATION_ITEM_STATUSES);
export const reconciliationItemCategorySchema = z.enum(RECONCILIATION_ITEM_CATEGORIES);
export const reconciliationItemSeveritySchema = z.enum(RECONCILIATION_ITEM_SEVERITIES);
export const reconciliationItemOutcomeSchema = z.enum(RECONCILIATION_ITEM_OUTCOMES);
export const reconciliationItemEventKindSchema = z.enum(RECONCILIATION_ITEM_EVENTS);
export const reconciliationSubjectTypeSchema = z.enum(RECONCILIATION_SUBJECT_TYPES);
export const reconciliationRunTriggerSchema = z.enum(RECONCILIATION_RUN_TRIGGERS);
export const statementLineClassSchema = z.enum(STATEMENT_LINE_CLASSES);
export const statementFormatSchema = z.enum(STATEMENT_FORMATS);
export const tariffStatusSchema = z.enum(TARIFF_STATUSES);

/** The outcomes a person may choose (the system's `auto_matched` and `superseded` excluded). */
export const MANUAL_RECONCILIATION_OUTCOMES = RECONCILIATION_ITEM_OUTCOMES.filter(
  (outcome): outcome is Exclude<ReconciliationItemOutcome, "auto_matched" | "superseded"> =>
    outcome !== "auto_matched" && outcome !== "superseded",
);

// Statements -------------------------------------------------------------------------------------

export const statementSummarySchema = z
  .object({
    id: uuid,
    fileName: z.string(),
    format: statementFormatSchema,
    sizeBytes: z.number().int().min(1),
    /** Unique per company: the same file twice is 409 `statement-already-uploaded`. */
    sha256: sha256Hex,
    /** First and last completion dates of its lines (the dates it covers). */
    periodFrom: calendarDate.nullable(),
    periodTo: calendarDate.nullable(),
    lines: count,
    byClass: z
      .object(
        Object.fromEntries(STATEMENT_LINE_CLASSES.map((lineClass) => [lineClass, count])) as {
          [K in (typeof STATEMENT_LINE_CLASSES)[number]]: typeof count;
        },
      )
      .strict(),
    issues: count,
    note: z.string().nullable(),
    uploadedBy: actor,
    uploadedAt: timestamp,
  })
  .strict();
export type StatementSummary = z.infer<typeof statementSummarySchema>;

export const statementLineSchema = z
  .object({
    id: uuid,
    statementId: uuid,
    row: z.number().int().min(1),
    receipt: z.string(),
    completedAt: timestamp,
    completedOn: calendarDate,
    initiatedAt: timestamp.nullable(),
    details: z.string().nullable(),
    transactionStatus: z.string().nullable(),
    paidInMinor: minor,
    withdrawnMinor: minor,
    balanceMinor: minor.nullable(),
    reasonType: z.string().nullable(),
    /** The other party's number and name, masked ("2547•••••678 - J. D."). */
    otherPartyMasked: z.string().nullable(),
    linkedTransactionId: z.string().nullable(),
    lineClass: statementLineClassSchema,
    /** A charge's payout receipt. */
    chargeFor: z.string().nullable(),
    /** The payroll payout with this receipt, if any. */
    payoutId: uuid.nullable(),
  })
  .strict();
export type StatementLineWire = z.infer<typeof statementLineSchema>;

export const statementIssueSchema = z
  .object({
    row: z.number().int().min(1),
    issue: z.enum(STATEMENT_ROW_ISSUES),
    column: z.enum(STATEMENT_COLUMNS).nullable(),
  })
  .strict();
export type StatementIssueWire = z.infer<typeof statementIssueSchema>;

/**
 * `POST payments/statements` (payments.review), multipart: `file` (CSV or XLSX, at most 5 MB)
 * plus these text fields.
 */
export const uploadStatementFieldsSchema = z
  .object({ note: z.string().trim().max(500).optional() })
  .strict();
export type UploadStatementFields = z.input<typeof uploadStatementFieldsSchema>;

export const statementResponseSchema = z
  .object({
    statement: statementSummarySchema,
    issues: z.array(statementIssueSchema),
    /** The business dates re-reconciled because the statement covers them. */
    reconciledDates: z.array(calendarDate),
  })
  .strict();
export type StatementResponse = z.infer<typeof statementResponseSchema>;

/** `GET payments/statements`. */
export const statementsQuerySchema = z.object({ limit, offset }).strict();
export type StatementsQuery = z.output<typeof statementsQuerySchema>;
export const statementsResponseSchema = z
  .object({ statements: z.array(statementSummarySchema), total: count })
  .strict();
export type StatementsResponse = z.infer<typeof statementsResponseSchema>;

/** `GET payments/statements/:id`: its lines, a page at a time. */
export const statementDetailQuerySchema = z
  .object({ lineClass: statementLineClassSchema.optional(), limit, offset })
  .strict();
export type StatementDetailQuery = z.output<typeof statementDetailQuerySchema>;
export const statementDetailResponseSchema = z
  .object({
    statement: statementSummarySchema,
    lines: z.array(statementLineSchema),
    total: count,
    issues: z.array(statementIssueSchema),
  })
  .strict();
export type StatementDetailResponse = z.infer<typeof statementDetailResponseSchema>;

// Reconciliation items ---------------------------------------------------------------------------

/**
 * One M-Pesa reconciliation item (named apart from D6.3b's piece-rate `reconciliationItemSchema`).
 */
export const mpesaReconciliationItemSchema = z
  .object({
    id: uuid,
    businessDate: calendarDate,
    kind: reconciliationItemKindSchema,
    category: reconciliationItemCategorySchema,
    severity: reconciliationItemSeveritySchema,
    status: reconciliationItemStatusSchema,
    /** `unmatched_internal` while no statement covering the date has been uploaded. */
    awaitingStatement: z.boolean(),
    subjectType: reconciliationSubjectTypeSchema,
    subjectId: uuid,
    payout: z
      .object({
        id: uuid,
        obligationId: uuid,
        batchId: uuid,
        projectId: uuid,
        method: z.enum(PAYROLL_PAYOUT_METHODS),
        createdBy: actor.nullable(),
      })
      .strict()
      .nullable(),
    /** The worker paid, masked (worker number and initials). */
    worker: z
      .object({ labourerId: uuid, workerNo: z.string(), nameMasked: z.string() })
      .strict()
      .nullable(),
    paymentRequestId: uuid.nullable(),
    /** The D4.2 reconciliation case of an `uncertain` payout. */
    caseId: uuid.nullable(),
    receipt: z.string().nullable(),
    statementLineId: uuid.nullable(),
    relatedLineIds: z.array(uuid),
    chargeLineIds: z.array(uuid),
    amountMinor: minor.nullable(),
    statementAmountMinor: minor.nullable(),
    bookedChargeMinor: minor.nullable(),
    statementChargeMinor: minor.nullable(),
    owner: actor.nullable(),
    openedAt: timestamp,
    /** Whole hours since it opened (age). */
    ageHours: count,
    outcome: reconciliationItemOutcomeSchema.nullable(),
    resolutionReason: z.string().nullable(),
    /** The D5.4 cost journal that corrected a charge (`charge_journal`). */
    journalId: uuid.nullable(),
    resolvedBy: actor.nullable(),
    resolvedAt: timestamp.nullable(),
    version,
  })
  .strict();
export type MpesaReconciliationItem = z.infer<typeof mpesaReconciliationItemSchema>;

export const reconciliationItemEventSchema = z
  .object({
    id: uuid,
    event: reconciliationItemEventKindSchema,
    /** Null for the system (runs and statement uploads). */
    actor: actor.nullable(),
    at: timestamp,
    note: z.string().nullable(),
    owner: actor.nullable(),
    outcome: reconciliationItemOutcomeSchema.nullable(),
  })
  .strict();
export type ReconciliationItemEvent = z.infer<typeof reconciliationItemEventSchema>;

/** `GET payments/reconciliation/items`: one date, or a range of at most 92 days. */
export const reconciliationItemsQuerySchema = z
  .object({
    date: calendarDate.optional(),
    from: calendarDate.optional(),
    to: calendarDate.optional(),
    kind: reconciliationItemKindSchema.optional(),
    status: reconciliationItemStatusSchema.optional(),
    severity: reconciliationItemSeveritySchema.optional(),
    ownerId: uuid.optional(),
    limit,
    offset,
  })
  .strict()
  .refine((value) => !(value.date && (value.from || value.to)), {
    message: "date_or_range",
    path: ["date"],
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "range_order",
    path: ["to"],
  })
  .refine(
    (value) =>
      !value.from ||
      !value.to ||
      Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`) <=
        91 * 86_400_000,
    { message: "range_too_long", path: ["to"] },
  );
export type ReconciliationItemsQuery = z.output<typeof reconciliationItemsQuerySchema>;

export const reconciliationItemsResponseSchema = z
  .object({ items: z.array(mpesaReconciliationItemSchema), total: count, open: count })
  .strict();
export type ReconciliationItemsResponse = z.infer<typeof reconciliationItemsResponseSchema>;

/**
 * `GET payments/reconciliation/items/:id`, also the answer to assign, notes, resolve and disputes.
 */
export const reconciliationItemResponseSchema = z
  .object({
    item: mpesaReconciliationItemSchema,
    events: z.array(reconciliationItemEventSchema),
    statementLine: statementLineSchema.nullable(),
    chargeLines: z.array(statementLineSchema),
    /** The outcomes allowed for this kind (RECONCILIATION_OUTCOMES_BY_KIND). */
    allowedOutcomes: z.array(reconciliationItemOutcomeSchema),
    permissions: z
      .object({ canAssign: z.boolean(), canNote: z.boolean(), canResolve: z.boolean() })
      .strict(),
  })
  .strict();
export type ReconciliationItemResponse = z.infer<typeof reconciliationItemResponseSchema>;

/** `POST payments/reconciliation/items/:id/assign` (payments.review); null unassigns. */
export const assignReconciliationItemRequestSchema = z
  .object({ version, ownerId: uuid.nullable() })
  .strict();
export type AssignReconciliationItemRequest = z.input<typeof assignReconciliationItemRequestSchema>;

/** `POST payments/reconciliation/items/:id/notes` (payments.review). */
export const noteReconciliationItemRequestSchema = z
  .object({ note: z.string().trim().min(3).max(1_000) })
  .strict();
export type NoteReconciliationItemRequest = z.input<typeof noteReconciliationItemRequestSchema>;

/**
 * `POST payments/reconciliation/items/:id/resolve` (payments.review + step-up; not someone who
 * recorded or started the payout). Never posts money: `charge_journal` names the D5.4 cost journal
 * that corrected the charge.
 */
export const resolveReconciliationItemRequestSchema = z
  .object({
    version,
    outcome: z.enum(MANUAL_RECONCILIATION_OUTCOMES),
    reason: payoutReasonSchema,
    journalId: uuid.optional(),
  })
  .strict()
  .refine((value) => (value.outcome === "charge_journal") === (value.journalId !== undefined), {
    message: "journal_required",
    path: ["journalId"],
  });
export type ResolveReconciliationItemRequest = z.input<
  typeof resolveReconciliationItemRequestSchema
>;

export const reconciliationRunSchema = z
  .object({
    id: uuid,
    businessDate: calendarDate,
    trigger: reconciliationRunTriggerSchema,
    startedAt: timestamp,
    finishedAt: timestamp.nullable(),
    created: count,
    updated: count,
    superseded: count,
    /** Null for the scheduled job and statement uploads. */
    runBy: actor.nullable(),
  })
  .strict();
export type ReconciliationRun = z.infer<typeof reconciliationRunSchema>;

/** `POST payments/reconciliation/runs` (payments.review): "run now" for a business date. */
export const runReconciliationRequestSchema = z.object({ date: calendarDate }).strict();
export type RunReconciliationRequest = z.input<typeof runReconciliationRequestSchema>;
export const reconciliationRunResponseSchema = z.object({ run: reconciliationRunSchema }).strict();
export type ReconciliationRunResponse = z.infer<typeof reconciliationRunResponseSchema>;

/** `POST payments/reconciliation/disputes` (payments.review): a worker disputes a payout (A-12). */
export const openDisputeRequestSchema = z
  .object({ payoutId: uuid, reason: payoutReasonSchema })
  .strict();
export type OpenDisputeRequest = z.input<typeof openDisputeRequestSchema>;

const kindCounts = z
  .object(
    Object.fromEntries(RECONCILIATION_ITEM_KINDS.map((kind) => [kind, count])) as {
      [K in (typeof RECONCILIATION_ITEM_KINDS)[number]]: typeof count;
    },
  )
  .strict();

/** `GET payments/reconciliation?date` (default today): the day at a glance. */
export const reconciliationDayQuerySchema = z.object({ date: calendarDate.optional() }).strict();
export type ReconciliationDayQuery = z.output<typeof reconciliationDayQuerySchema>;
export const reconciliationDayResponseSchema = z
  .object({
    date: calendarDate,
    today: calendarDate,
    /** A statement covering the date has been uploaded. */
    statementCovered: z.boolean(),
    statements: z.array(statementSummarySchema),
    lastRun: reconciliationRunSchema.nullable(),
    counts: z
      .object({
        byKind: kindCounts,
        open: count,
        resolved: count,
        critical: count,
        awaitingStatement: count,
      })
      .strict(),
    totals: z
      .object({
        payouts: count,
        payoutsMinor: minor,
        matchedMinor: minor,
        bookedChargesMinor: minor,
        statementChargesMinor: minor,
      })
      .strict(),
    permissions: z
      .object({
        canRun: z.boolean(),
        canUpload: z.boolean(),
        canResolve: z.boolean(),
        canDispute: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ReconciliationDayResponse = z.infer<typeof reconciliationDayResponseSchema>;

// Charges tariff ---------------------------------------------------------------------------------

export const tariffBandSchema = z
  .object({
    upToMinor: z.number().int().min(100).max(TARIFF_LIMITS.upToMaxMinor),
    chargeMinor: z.number().int().min(0).max(TARIFF_LIMITS.chargeMaxMinor),
  })
  .strict();

export const tariffVersionSchema = z
  .object({
    id: uuid,
    kind: z.enum(TARIFF_KINDS),
    effectiveFrom: calendarDate,
    /** The day before the next version starts; null while none follows. */
    effectiveTo: calendarDate.nullable(),
    inForce: z.boolean(),
    status: tariffStatusSchema,
    bands: z.array(tariffBandSchema),
    source: z.string(),
    /** Null for the seeded DEMO version. */
    createdBy: actor.nullable(),
    createdAt: timestamp,
  })
  .strict();
export type TariffVersion = z.infer<typeof tariffVersionSchema>;

/** `GET payments/tariffs` (payments.view or config.manage). */
export const tariffsResponseSchema = z
  .object({
    today: calendarDate,
    versions: z.array(tariffVersionSchema),
    inForce: tariffVersionSchema.nullable(),
    canManage: z.boolean(),
  })
  .strict();
export type TariffsResponse = z.infer<typeof tariffsResponseSchema>;

/**
 * `PUT payments/tariffs` (config.manage + step-up): a new effective-dated version (versions are
 * never edited). Bands ascend strictly, in whole shillings; `verified` only once the company has
 * confirmed its Safaricom tariff (CR-PMT-02).
 */
export const putTariffRequestSchema = z
  .object({
    kind: z.enum(TARIFF_KINDS).default("b2c"),
    effectiveFrom: calendarDate,
    status: tariffStatusSchema,
    bands: z.array(tariffBandSchema).min(1).max(TARIFF_LIMITS.maxBands),
    source: z.string().trim().min(10).max(2_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const issue of tariffBandIssues(value.bands))
      ctx.addIssue({ code: "custom", message: `bands_${issue}`, path: ["bands"] });
  });
export type PutTariffRequest = z.input<typeof putTariffRequestSchema>;
