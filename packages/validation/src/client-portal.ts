import { isPaybillNumber, parseFxRate } from "@pm-buddy/domain";
import {
  CLIENT_CERTIFICATE_STATES,
  CLIENT_DECISIONS,
  CLIENT_PAYMENT_KINDS,
  CLIENT_PAYMENT_METHODS,
  CLIENT_PORTAL_LIMITS,
  CLIENT_REQUEST_STATES,
  CLIENT_STATEMENT_ENTRY_KINDS,
  COUNTY_KEYS,
  DISPLAY_CURRENCIES,
  FX_CURRENCIES,
  MILESTONE_STATUSES,
  PAYBILL_ACCOUNT_FORMATS,
  PROJECT_STATUSES,
  RELEASE_STAGES,
  VALUATION_KINDS,
  VARIATION_LINE_ACTIONS,
} from "@pm-buddy/types";
import { z } from "zod";
import { kenyanPhoneSchema, planningDateSchema } from "./primitives.js";

/**
 * D7.1 client portal contracts (brief §5.10, §5.7 and §15; ARCHITECTURE §4.15). Client responses
 * are curated and strict: assigned projects only; earned-value progress and the S-curve without
 * cost data; general site photos with their verification checks (never coordinates, uploaders or
 * incident photos); approved diaries with the workforce as counts by trade; certified
 * certificates with what the company recorded as received; variations sent to the client.
 * Money is KES minor units; foreign currencies are an indicative display only (the rate travels,
 * the web converts with packages/domain `indicativeAmount`).
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();
const version = z.number().int().min(0).max(2_147_483_647);
const person = z.strictObject({ id: uuid, displayName: z.string() });
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const signedMinor = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const percent = z.string().regex(/^-?\d{1,6}\.\d$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
function printable(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
/** Free text on one line or several (newlines and tabs allowed, other controls refused). */
function printableMultiline(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
const text = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine(printable, "control_characters");
const longText = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine(printableMultiline, "control_characters");
const projectRef = z.strictObject({
  id: uuid,
  code: z.string().min(2).max(20),
  name: z.string().min(1).max(150),
  status: z.enum(PROJECT_STATUSES),
});
const pageLimit = (fallback: number, max: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);

// Display currency -------------------------------------------------------------------------------

/** A rate finance entered: KES per unit, its date and where it came from. */
export const fxRateSchema = z.strictObject({
  id: uuid,
  currency: z.enum(FX_CURRENCIES),
  kesPerUnit: z.string().regex(/^\d{1,5}\.\d{4}$/),
  rateDate: calendarDate,
  source: z.string().min(3).max(200),
  enteredBy: person.nullable(),
  enteredAt: timestamp,
  /** Whether it may be shown today (not in the future and at most 31 days old). */
  usable: z.boolean(),
});
export type FxRate = z.infer<typeof fxRateSchema>;

/**
 * How the caller wants amounts shown: KES only, or KES with an indicative conversion at `rate`
 * (null when no usable rate exists for the chosen currency: the web says "not available").
 */
export const displaySchema = z.strictObject({
  currency: z.enum(DISPLAY_CURRENCIES),
  rate: z
    .strictObject({
      currency: z.enum(FX_CURRENCIES),
      kesPerUnit: z.string().regex(/^\d{1,5}\.\d{4}$/),
      rateDate: calendarDate,
      source: z.string(),
    })
    .nullable(),
});
export type ClientDisplay = z.infer<typeof displaySchema>;

export const clientPreferencesResponseSchema = z.strictObject({
  displayCurrency: z.enum(DISPLAY_CURRENCIES),
  /** The newest rate per currency (usable or not), for the settings page. */
  rates: z.array(fxRateSchema),
});
export type ClientPreferencesResponse = z.infer<typeof clientPreferencesResponseSchema>;

export const updateClientPreferencesRequestSchema = z.strictObject({
  displayCurrency: z.enum(DISPLAY_CURRENCIES),
});
export type UpdateClientPreferencesRequest = z.infer<typeof updateClientPreferencesRequestSchema>;

/** `?currency=` overrides the stored preference for one page (for example a shared link). */
export const clientDisplayQuerySchema = z.object({
  currency: z.enum(DISPLAY_CURRENCIES).optional(),
});

// Projects and overview ----------------------------------------------------------------------------

const balanceSchema = z.strictObject({
  /** Certificates' totals incl. VAT (a correcting certificate counts negative). */
  certifiedMinor: signedMinor,
  receivedMinor: minor,
  /** What the client owes now (negative: the client is in credit). */
  outstandingMinor: signedMinor,
  overdueMinor: minor,
});

export const clientPortalProjectSchema = z.strictObject({
  id: uuid,
  code: z.string().min(2).max(20),
  name: z.string().min(1).max(150),
  status: z.enum(PROJECT_STATUSES),
  county: z.enum(COUNTY_KEYS).nullable(),
  town: z.string().nullable(),
  startDate: calendarDate.nullable(),
  endDate: calendarDate.nullable(),
  contractSumMinor: minor.nullable(),
  currency: z.literal("KES"),
  milestones: z.strictObject({ total: z.number().int().min(0), achieved: z.number().int().min(0) }),
  balance: balanceSchema,
  /** Variations sent to the client and waiting for their decision. */
  awaitingDecisions: z.number().int().min(0),
});

const progressSummarySchema = z.strictObject({
  dataDate: calendarDate,
  percentComplete: percent.nullable(),
  plannedPercent: percent.nullable(),
  variancePoints: percent.nullable(),
  bqVersionNo: z.number().int().min(1).nullable(),
  baselineName: z.string().nullable(),
});

export const clientWorkforceSchema = z.strictObject({
  total: z.number().int().min(0),
  /** Headcount by trade (attendance snapshot); never names or worker records. */
  trades: z.array(
    z.strictObject({
      key: z.string(),
      nameEn: z.string(),
      nameSw: z.string(),
      headcount: z.number().int().min(1),
    }),
  ),
});

export const clientDiaryEntrySchema = z.strictObject({
  id: uuid,
  date: calendarDate,
  siteName: z.string().min(1).max(120),
  workPerformed: z.string().min(1).max(6000),
  weather: z.string().max(250).nullable(),
  delays: z.string().max(2000).nullable(),
  workforceCount: z.number().int().min(0).nullable(),
  /** The attendance snapshot by trade, or null when the count was typed in. */
  workforce: clientWorkforceSchema.nullable(),
  approvedAt: timestamp,
});

export const clientMilestoneEntrySchema = z.strictObject({
  id: uuid,
  name: z.string().min(1).max(150),
  dueDate: calendarDate,
  status: z.enum(MILESTONE_STATUSES),
  actualDate: calendarDate.nullable(),
});

// Photos -----------------------------------------------------------------------------------------

export const clientPhotoSchema = z.strictObject({
  id: uuid,
  siteName: z.string(),
  caption: z.string().nullable(),
  /** The capture time the photo's own metadata claims (null when it had none). */
  capturedAt: timestamp.nullable(),
  timeSource: z.enum(["gps", "offset", "assumed_nairobi"]).nullable(),
  /** When the server received it. */
  uploadedAt: timestamp,
  /** Server checks of the photo's metadata (D6.1); evidence for review, not proof. */
  verified: z.boolean(),
  checks: z.strictObject({
    location: z.enum(["inside", "outside", "missing", "no_geofence"]),
    time: z.enum(["ok", "future", "stale", "missing", "diary_mismatch"]),
    /** Metres outside the site boundary when the location is outside. */
    distanceM: z.number().nullable(),
  }),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
});
export type ClientPhoto = z.infer<typeof clientPhotoSchema>;

export const clientPhotosQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: pageLimit(CLIENT_PORTAL_LIMITS.photoPageSize, CLIENT_PORTAL_LIMITS.photoMaxPageSize),
});
export const clientPhotosResponseSchema = z.strictObject({
  project: projectRef,
  photos: z.array(clientPhotoSchema),
  nextCursor: uuid.nullable(),
  /** Counts over all the project's general photos. */
  counts: z.strictObject({ total: z.number().int().min(0), verified: z.number().int().min(0) }),
});
export type ClientPhotosResponse = z.infer<typeof clientPhotosResponseSchema>;

export const clientDiariesQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: pageLimit(CLIENT_PORTAL_LIMITS.diaryPageSize, 50),
});
export const clientDiariesResponseSchema = z.strictObject({
  project: projectRef,
  diaries: z.array(clientDiaryEntrySchema),
  nextCursor: uuid.nullable(),
});
export type ClientDiariesResponse = z.infer<typeof clientDiariesResponseSchema>;

// Certificates and statement ---------------------------------------------------------------------

export const clientCertificateSchema = z.strictObject({
  id: uuid,
  /** IPC-NNNN. */
  number: z.string(),
  kind: z.enum(VALUATION_KINDS),
  releaseStage: z.enum(RELEASE_STAGES).nullable(),
  valuationDate: calendarDate,
  certifiedOn: calendarDate,
  dueDate: calendarDate,
  amountDueMinor: signedMinor,
  vatPercent: z.string(),
  vatMinor: signedMinor,
  totalMinor: signedMinor,
  receivedMinor: minor,
  /** Credit applied from a correcting (negative) certificate. */
  creditedMinor: minor,
  outstandingMinor: minor,
  state: z.enum(CLIENT_CERTIFICATE_STATES),
  overdue: z.boolean(),
  overdueDays: z.number().int().min(0),
  /** What to type as the Paybill account number (null without Paybill instructions). */
  accountReference: z.string().nullable(),
});
export type ClientCertificate = z.infer<typeof clientCertificateSchema>;

/** A receipt or reversal as the client sees it (never staff notes or who recorded it). */
export const clientReceiptSchema = z.strictObject({
  id: uuid,
  kind: z.enum(CLIENT_PAYMENT_KINDS),
  certificateId: uuid,
  certificateNumber: z.string(),
  receivedOn: calendarDate,
  amountMinor: minor,
  method: z.enum(CLIENT_PAYMENT_METHODS).nullable(),
  reference: z.string().nullable(),
  /** For a reversal: the receipt it reverses and why (the reason is shown to the client). */
  reversesId: uuid.nullable(),
  reason: z.string().nullable(),
  /** For a receipt: whether a later entry reversed it. */
  reversed: z.boolean(),
  recordedAt: timestamp,
});
export type ClientReceipt = z.infer<typeof clientReceiptSchema>;

export const clientStatementEntrySchema = z.strictObject({
  kind: z.enum(CLIENT_STATEMENT_ENTRY_KINDS),
  id: uuid,
  date: calendarDate,
  certificateId: uuid,
  certificateNumber: z.string(),
  debitMinor: minor,
  creditMinor: minor,
  balanceMinor: signedMinor,
});

export const clientStatementResponseSchema = z.strictObject({
  project: projectRef,
  company: z.strictObject({ name: z.string() }),
  clientName: z.string().nullable(),
  today: calendarDate,
  /** The payment period in force now (each certificate keeps the one it was certified under). */
  paymentTermsDays: z.number().int().min(0),
  certificates: z.array(clientCertificateSchema),
  receipts: z.array(clientReceiptSchema),
  entries: z.array(clientStatementEntrySchema),
  totals: balanceSchema,
  generatedAt: timestamp,
  display: displaySchema,
});
export type ClientStatementResponse = z.infer<typeof clientStatementResponseSchema>;

export const clientExportQuerySchema = z.object({
  locale: z.enum(["en", "sw"]).default("en"),
});

// Overview ---------------------------------------------------------------------------------------

export const clientPortalProjectsResponseSchema = z.strictObject({
  company: z.strictObject({ id: uuid, name: z.string().min(1) }),
  projects: z.array(clientPortalProjectSchema),
  display: displaySchema,
});
export type ClientPortalProjectsResponse = z.infer<typeof clientPortalProjectsResponseSchema>;

export const clientPortalOverviewResponseSchema = z.strictObject({
  project: clientPortalProjectSchema,
  progress: progressSummarySchema,
  milestones: z.array(clientMilestoneEntrySchema),
  /** Approved (locked) diaries only, newest day first, at most 5 (all on the diaries page). */
  diaries: z.array(clientDiaryEntrySchema),
  nextDue: z
    .strictObject({
      certificateId: uuid,
      number: z.string(),
      dueDate: calendarDate,
      outstandingMinor: minor,
      overdue: z.boolean(),
    })
    .nullable(),
  photos: z.strictObject({ total: z.number().int().min(0), verified: z.number().int().min(0) }),
  display: displaySchema,
});
export type ClientPortalOverviewResponse = z.infer<typeof clientPortalOverviewResponseSchema>;

// Progress and S-curve ---------------------------------------------------------------------------

export const clientProgressQuerySchema = z.object({ asOf: calendarDate.optional() });

export const clientCurvePointSchema = z.strictObject({
  weekEnd: calendarDate,
  /** Planned and earned value to date at contract rates (null: no baseline / after the data date). */
  pvMinor: minor.nullable(),
  evMinor: minor.nullable(),
  plannedPercent: percent.nullable(),
  earnedPercent: percent.nullable(),
});
export type ClientCurvePoint = z.infer<typeof clientCurvePointSchema>;

export const clientProgressResponseSchema = z.strictObject({
  project: projectRef,
  dataDate: calendarDate,
  bqVersion: z.strictObject({ versionNo: z.number().int().min(1) }).nullable(),
  baseline: z
    .strictObject({
      name: z.string(),
      startDate: calendarDate,
      finishDate: calendarDate.nullable(),
    })
    .nullable(),
  figures: z.strictObject({
    /** The measured work's value at completion (contract rates, excl. VAT). */
    bacMinor: minor,
    evMinor: minor,
    pvMinor: minor.nullable(),
    percentComplete: percent.nullable(),
    plannedPercent: percent.nullable(),
    variancePoints: percent.nullable(),
  }),
  curve: z.array(clientCurvePointSchema),
  curveTruncated: z.boolean(),
  milestones: z.array(clientMilestoneEntrySchema),
  display: displaySchema,
});
export type ClientProgressResponse = z.infer<typeof clientProgressResponseSchema>;

// Paying -----------------------------------------------------------------------------------------

export const paymentInstructionsSchema = z.strictObject({
  version: z.number().int().min(1),
  paybillNumber: z.string().nullable(),
  tillNumber: z.string().nullable(),
  accountName: z.string(),
  accountFormat: z.enum(PAYBILL_ACCOUNT_FORMATS),
  bankInstructions: z.string().nullable(),
  updatedAt: timestamp,
});
export type PaymentInstructions = z.infer<typeof paymentInstructionsSchema>;

export const clientPayResponseSchema = z.strictObject({
  project: projectRef,
  instructions: paymentInstructionsSchema.nullable(),
  /** Certified certificates with something outstanding, oldest first. */
  certificates: z.array(clientCertificateSchema),
  totals: balanceSchema,
  stk: z.strictObject({
    available: z.boolean(),
    /** Why Pay with M-Pesa is not offered (until D4.2: the provider is not connected). */
    reason: z.enum(["provider-not-connected"]).nullable(),
  }),
  display: displaySchema,
});
export type ClientPayResponse = z.infer<typeof clientPayResponseSchema>;

/** An STK Push request (refused with 503 stk-push-unavailable until D4.2). */
export const clientStkPushRequestSchema = z.strictObject({
  amountMinor: z.number().int().min(100).max(Number.MAX_SAFE_INTEGER),
  phone: kenyanPhoneSchema,
});
export type ClientStkPushRequest = z.input<typeof clientStkPushRequestSchema>;

// Variations -------------------------------------------------------------------------------------

export const clientVariationLineSchema = z.strictObject({
  lineNo: z.number().int().min(1),
  action: z.enum(VARIATION_LINE_ACTIONS),
  ref: z.string().nullable(),
  description: z.string(),
  unit: z.string().nullable(),
  quantity: z.string().nullable(),
  rate: z.string().nullable(),
  baseAmountMinor: signedMinor,
  newAmountMinor: minor,
  deltaMinor: signedMinor,
});

export const clientVariationViewSchema = z.strictObject({
  number: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  instruction: z.strictObject({ number: z.string(), subject: z.string() }),
  lines: z.array(clientVariationLineSchema),
  totals: z.strictObject({ additionsMinor: minor, omissionsMinor: minor, netMinor: signedMinor }),
  vatRatePercent: z.string(),
  baseGrandTotalMinor: signedMinor,
  projectedGrandTotalMinor: signedMinor,
  grandTotalEffectMinor: signedMinor,
});
export type ClientVariationViewWire = z.infer<typeof clientVariationViewSchema>;

/** What happened to the variation itself (the contractor's process), as the client sees it. */
export const CLIENT_VARIATION_OUTCOMES = [
  "in_review",
  "approved",
  "rejected",
  "cancelled",
] as const;

export const clientDecisionSchema = z.strictObject({
  decision: z.enum(CLIENT_DECISIONS),
  comment: z.string().nullable(),
  decidedBy: person,
  decidedAt: timestamp,
});

export const clientVariationRequestSchema = z.strictObject({
  id: uuid,
  number: z.string(),
  title: z.string(),
  sentAt: timestamp,
  message: z.string().nullable(),
  netMinor: signedMinor,
  grandTotalEffectMinor: signedMinor,
  state: z.enum(CLIENT_REQUEST_STATES),
  outcome: z.enum(CLIENT_VARIATION_OUTCOMES),
  decision: clientDecisionSchema.nullable(),
});
export type ClientVariationRequest = z.infer<typeof clientVariationRequestSchema>;

export const clientVariationsResponseSchema = z.strictObject({
  project: projectRef,
  /** Whether the contractor waits for the client's approval before approving variations. */
  approvalRequired: z.boolean(),
  requests: z.array(clientVariationRequestSchema),
  display: displaySchema,
});
export type ClientVariationsResponse = z.infer<typeof clientVariationsResponseSchema>;

export const clientVariationDetailResponseSchema = z.strictObject({
  project: projectRef,
  approvalRequired: z.boolean(),
  request: clientVariationRequestSchema.extend({
    view: clientVariationViewSchema,
    /** The digest the decision quotes (SHA-256 of the view). */
    clientDigest: digest,
    canDecide: z.boolean(),
  }),
  display: displaySchema,
});
export type ClientVariationDetailResponse = z.infer<typeof clientVariationDetailResponseSchema>;

export const clientDecisionRequestSchema = z
  .strictObject({
    decision: z.enum(CLIENT_DECISIONS),
    comment: longText(0, CLIENT_PORTAL_LIMITS.commentMax).optional(),
    clientDigest: digest,
  })
  .superRefine((value, ctx) => {
    if (value.decision === "rejected" && (value.comment ?? "").length < 3)
      ctx.addIssue({ code: "custom", path: ["comment"], message: "comment_required" });
  });
export type ClientDecisionRequest = z.input<typeof clientDecisionRequestSchema>;

// Staff: client receipts -------------------------------------------------------------------------

export const recordClientPaymentRequestSchema = z.strictObject({
  /** Client-generated (UUIDv7 from the web), so a retried request names the same receipt. */
  id: uuid,
  valuationId: uuid,
  amountMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  receivedOn: planningDateSchema,
  method: z.enum(CLIENT_PAYMENT_METHODS),
  reference: text(3, CLIENT_PORTAL_LIMITS.referenceMax),
  note: longText(0, CLIENT_PORTAL_LIMITS.noteMax).optional(),
});
export type RecordClientPaymentRequest = z.input<typeof recordClientPaymentRequestSchema>;

export const reverseClientPaymentRequestSchema = z.strictObject({
  /** Client-generated ID of the reversal entry. */
  id: uuid,
  reason: longText(3, 500),
});
export type ReverseClientPaymentRequest = z.input<typeof reverseClientPaymentRequestSchema>;

export const staffClientPaymentSchema = clientReceiptSchema.extend({
  note: z.string().nullable(),
  recordedBy: person,
  /** For a receipt: the reversal entry that undid it. */
  reversedBy: uuid.nullable(),
});
export type StaffClientPayment = z.infer<typeof staffClientPaymentSchema>;

export const clientSettingsSchema = z.strictObject({
  /** 0 = the defaults (nothing saved yet). */
  version,
  clientApprovalRequired: z.boolean(),
  paymentTermsDays: z.number().int().min(0),
  updatedBy: person.nullable(),
  updatedAt: timestamp.nullable(),
});
export type ClientSettings = z.infer<typeof clientSettingsSchema>;

export const clientPaymentsResponseSchema = z.strictObject({
  project: projectRef,
  clientName: z.string().nullable(),
  today: calendarDate,
  certificates: z.array(clientCertificateSchema),
  payments: z.array(staffClientPaymentSchema),
  entries: z.array(clientStatementEntrySchema),
  totals: balanceSchema,
  settings: clientSettingsSchema,
  /** Client members assigned to the project (they see these figures in the portal). */
  clientMembers: z.number().int().min(0),
  readOnly: z.boolean(),
  permissions: z.strictObject({
    canRecord: z.boolean(),
    canManageSettings: z.boolean(),
  }),
});
export type ClientPaymentsResponse = z.infer<typeof clientPaymentsResponseSchema>;

export const updateClientSettingsRequestSchema = z.strictObject({
  /** The version read (0 = defaults). */
  version,
  clientApprovalRequired: z.boolean(),
  paymentTermsDays: z
    .number()
    .int()
    .min(CLIENT_PORTAL_LIMITS.paymentTermsDays.min)
    .max(CLIENT_PORTAL_LIMITS.paymentTermsDays.max),
});
export type UpdateClientSettingsRequest = z.infer<typeof updateClientSettingsRequestSchema>;

// Staff: Paybill instructions and FX rates -------------------------------------------------------

const paybill = z
  .string()
  .trim()
  .refine((value) => isPaybillNumber(value), "invalid_paybill");

export const updatePaymentInstructionsRequestSchema = z
  .strictObject({
    /** The version read (0 = none saved yet). */
    version,
    paybillNumber: paybill.nullable(),
    tillNumber: paybill.nullable(),
    accountName: text(3, 150),
    accountFormat: z.enum(PAYBILL_ACCOUNT_FORMATS),
    bankInstructions: longText(0, 500).nullable(),
  })
  .superRefine((value, ctx) => {
    if (!value.paybillNumber && !value.tillNumber && !value.bankInstructions)
      ctx.addIssue({ code: "custom", path: ["paybillNumber"], message: "payment_route_required" });
  });
export type UpdatePaymentInstructionsRequest = z.input<
  typeof updatePaymentInstructionsRequestSchema
>;

export const paymentInstructionsResponseSchema = z.strictObject({
  instructions: paymentInstructionsSchema.nullable(),
  updatedBy: person.nullable(),
  permissions: z.strictObject({ canEdit: z.boolean() }),
});
export type PaymentInstructionsResponse = z.infer<typeof paymentInstructionsResponseSchema>;

export const createFxRateRequestSchema = z.strictObject({
  currency: z.enum(FX_CURRENCIES),
  kesPerUnit: z
    .string()
    .trim()
    .refine((value) => parseFxRate(value) !== null, "invalid_fx_rate"),
  rateDate: planningDateSchema,
  source: text(3, 200),
});
export type CreateFxRateRequest = z.input<typeof createFxRateRequestSchema>;

export const fxRatesResponseSchema = z.strictObject({
  /** The newest entries first. */
  rates: z.array(fxRateSchema),
  /** The rate shown to clients now for each currency (null when none is usable). */
  current: z.array(
    z.strictObject({ currency: z.enum(FX_CURRENCIES), rate: fxRateSchema.nullable() }),
  ),
  permissions: z.strictObject({ canEnter: z.boolean() }),
});
export type FxRatesResponse = z.infer<typeof fxRatesResponseSchema>;

// Staff: a variation's sendings to the client -----------------------------------------------------

export const staffClientRequestSchema = z.strictObject({
  id: uuid,
  sentAt: timestamp,
  sentBy: person,
  message: z.string().nullable(),
  snapshotDigest: digest,
  clientDigest: digest,
  state: z.enum(CLIENT_REQUEST_STATES),
  decision: clientDecisionSchema.nullable(),
});
export type StaffClientRequest = z.infer<typeof staffClientRequestSchema>;

export const variationClientResponseSchema = z.strictObject({
  approvalRequired: z.boolean(),
  /** Client members assigned to the project (who can decide). */
  clientMembers: z.number().int().min(0),
  requests: z.array(staffClientRequestSchema),
  /** The client's decision on the current submission (null when none yet). */
  currentDecision: z.enum(CLIENT_DECISIONS).nullable(),
  permissions: z.strictObject({
    canSend: z.boolean(),
    sendBlocker: z
      .enum(["status", "permission", "read-only", "no-client", "already-sent", "stale"])
      .nullable(),
  }),
});
export type VariationClientResponse = z.infer<typeof variationClientResponseSchema>;

export const sendVariationToClientRequestSchema = z.strictObject({
  version: z.number().int().min(1),
  snapshotDigest: digest,
  message: longText(0, CLIENT_PORTAL_LIMITS.messageMax).optional(),
});
export type SendVariationToClientRequest = z.input<typeof sendVariationToClientRequestSchema>;
