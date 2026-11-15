import {
  DEFAULT_SUBCONTRACT_TERMS,
  PIECE_RATE_EXTENSION_STATUSES,
  PIECE_RATE_JOB_STATUSES,
  PIECE_RATE_LIMITS,
  RECONCILIATION_FLAGS,
  RELEASE_STAGES,
  RETENTION_STAGES,
  SUBCONTRACT_ADVANCE_STATUSES,
  SUBCONTRACT_CERTIFICATE_KINDS,
  SUBCONTRACT_CERTIFICATE_STATUSES,
  SUBCONTRACT_KINDS,
  SUBCONTRACT_LIMITS,
  SUBCONTRACT_LINE_BASES,
  SUBCONTRACT_PAYMENT_METHODS,
  SUBCONTRACT_STATUSES,
  SUBCONTRACT_TERM_LIMITS,
  SUBCONTRACT_VARIATION_STATUSES,
  SUBCONTRACT_VAT_TREATMENTS,
} from "@pm-buddy/types";
import { z } from "zod";
import { pageInfoSchema } from "./api.js";
import { pieceRateOutputSchema } from "./payroll.js";
import { projectRefSchema, spendingBqItemSchema } from "./spending.js";

/**
 * D6.3 part B contracts: subcontractors (D5.1 suppliers flagged as subcontractors), subcontracts
 * with lines on BQ items at their own rates, append-only variations, advances, subcontract payment
 * certificates (rule KE-SUB-1) with payments recorded outside PM-Buddy and the subcontractor's
 * invoice matched to them, the subcontractor statement, piece-rate jobs and the reconciliation of
 * piece-rate pay against measured quantities. Money is integer KES minor units (`*Minor`),
 * quantities decimal strings (subcontract lines four places, piece-rate output three) and
 * percentages decimal strings. Requests never carry a figure the server computes.
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();
const version = z.number().int().min(1).max(2_147_483_647);
const person = z.strictObject({ id: uuid, displayName: z.string() });
const minor = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const positiveMinor = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/, "invalid_digest");

function printable(value: string, multiline: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (multiline && (code === 9 || code === 10 || code === 13)) continue;
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
const length = (value: string) => Array.from(value).length;
const text = (min: number, max: number, multiline = false) =>
  z
    .string()
    .trim()
    .refine((value) => length(value) >= min, "too_short")
    .refine((value) => length(value) <= max, "too_long")
    .refine((value) => printable(value, multiline), "control_characters");
const optionalText = (max: number, multiline = false) =>
  z
    .string()
    .trim()
    .refine((value) => length(value) <= max, "too_long")
    .refine((value) => printable(value, multiline), "control_characters")
    .transform((value) => (value === "" ? null : value))
    .nullable();
const reason = text(3, 500);
/** A quantity with up to four decimals, not negative (subcontract lines and claims). */
const quantity4 = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/, "invalid_quantity");
const positiveQuantity4 = quantity4.refine((value) => Number(value) > 0, "quantity_not_positive");
/** A signed quantity change with up to four decimals, never zero. */
const quantityChange = z
  .string()
  .trim()
  .regex(/^-?(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/, "invalid_quantity")
  .refine((value) => Number(value) !== 0, "quantity_zero");
/** A piece-rate quantity (three decimals, as D4.1 output). */
const quantity3 = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, "invalid_quantity")
  .refine((value) => Number(value) > 0, "quantity_not_positive");
const percent = (limits: { min: number; max: number }) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,3}(?:\.\d{1,2})?$/, "invalid_percent")
    .refine((value) => Number(value) >= limits.min && Number(value) <= limits.max, "out_of_range");
const rateMinor = z.number().int().min(1).max(100_000_000_000);
const reference = text(2, 60);

const kind = z.enum(SUBCONTRACT_KINDS);
const status = z.enum(SUBCONTRACT_STATUSES);
const vatTreatment = z.enum(SUBCONTRACT_VAT_TREATMENTS);
const method = z.enum(SUBCONTRACT_PAYMENT_METHODS);

// Requests --------------------------------------------------------------------------------------

const termFields = {
  retentionPercent: percent(SUBCONTRACT_TERM_LIMITS.retentionPercent),
  retentionLimitPercent: percent(SUBCONTRACT_TERM_LIMITS.retentionLimitPercent).nullable(),
  practicalReleasePercent: percent(SUBCONTRACT_TERM_LIMITS.practicalReleasePercent),
  vatPercent: percent(SUBCONTRACT_TERM_LIMITS.vatPercent),
  whtPercent: percent(SUBCONTRACT_TERM_LIMITS.whtPercent),
  advanceLimitMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  advanceRecoveryPercent: percent(SUBCONTRACT_TERM_LIMITS.advanceRecoveryPercent),
  paymentTermsDays: z
    .number()
    .int()
    .min(SUBCONTRACT_TERM_LIMITS.paymentTermsDays.min)
    .max(SUBCONTRACT_TERM_LIMITS.paymentTermsDays.max),
  paymentTermsNote: optionalText(500, true),
};

const datesInOrder = (value: { startDate?: string; endDate?: string }, ctx: z.RefinementCtx) => {
  if (value.startDate && value.endDate && value.endDate < value.startDate)
    ctx.addIssue({ code: "custom", path: ["endDate"], message: "end_before_start" });
};
const advanceRecovered = (
  value: { advanceLimitMinor?: number; advanceRecoveryPercent?: string },
  ctx: z.RefinementCtx,
) => {
  if ((value.advanceLimitMinor ?? 0) > 0 && Number(value.advanceRecoveryPercent ?? "0") <= 0)
    ctx.addIssue({
      code: "custom",
      path: ["advanceRecoveryPercent"],
      message: "recovery_required",
    });
};

export const createSubcontractRequestSchema = z
  .strictObject({
    supplierId: uuid,
    kind,
    title: text(3, 200),
    scope: optionalText(2000, true).optional(),
    startDate: calendarDate,
    endDate: calendarDate,
    retentionPercent: termFields.retentionPercent.default(
      DEFAULT_SUBCONTRACT_TERMS.retentionPercent,
    ),
    retentionLimitPercent: termFields.retentionLimitPercent.default(
      DEFAULT_SUBCONTRACT_TERMS.retentionLimitPercent,
    ),
    practicalReleasePercent: termFields.practicalReleasePercent.default(
      DEFAULT_SUBCONTRACT_TERMS.practicalReleasePercent,
    ),
    vatPercent: termFields.vatPercent.default(DEFAULT_SUBCONTRACT_TERMS.vatPercent),
    whtPercent: termFields.whtPercent.default(DEFAULT_SUBCONTRACT_TERMS.whtPercent),
    advanceLimitMinor: termFields.advanceLimitMinor.default(
      DEFAULT_SUBCONTRACT_TERMS.advanceLimitMinor,
    ),
    advanceRecoveryPercent: termFields.advanceRecoveryPercent.default(
      DEFAULT_SUBCONTRACT_TERMS.advanceRecoveryPercent,
    ),
    paymentTermsDays: termFields.paymentTermsDays.default(
      DEFAULT_SUBCONTRACT_TERMS.paymentTermsDays,
    ),
    paymentTermsNote: termFields.paymentTermsNote.optional(),
  })
  .superRefine((value, ctx) => {
    datesInOrder(value, ctx);
    advanceRecovered(value, ctx);
  });
export type CreateSubcontractRequest = z.input<typeof createSubcontractRequestSchema>;
export type ParsedCreateSubcontractRequest = z.infer<typeof createSubcontractRequestSchema>;

export const updateSubcontractRequestSchema = z
  .strictObject({
    version,
    supplierId: uuid.optional(),
    kind: kind.optional(),
    title: text(3, 200).optional(),
    scope: optionalText(2000, true).optional(),
    startDate: calendarDate.optional(),
    endDate: calendarDate.optional(),
    retentionPercent: termFields.retentionPercent.optional(),
    retentionLimitPercent: termFields.retentionLimitPercent.optional(),
    practicalReleasePercent: termFields.practicalReleasePercent.optional(),
    vatPercent: termFields.vatPercent.optional(),
    whtPercent: termFields.whtPercent.optional(),
    advanceLimitMinor: termFields.advanceLimitMinor.optional(),
    advanceRecoveryPercent: termFields.advanceRecoveryPercent.optional(),
    paymentTermsDays: termFields.paymentTermsDays.optional(),
    paymentTermsNote: termFields.paymentTermsNote.optional(),
  })
  .superRefine(datesInOrder);
export type UpdateSubcontractRequest = z.infer<typeof updateSubcontractRequestSchema>;

/**
 * A line: a BQ item of the BQ in force at the subcontract's own rate — `rateMinor` per unit for an
 * item measured by quantity, or `lumpSumMinor` for the share (`quantity`, percent) of a lump sum.
 */
const lineInput = {
  bqItemLineageId: uuid,
  quantity: positiveQuantity4,
  rateMinor: rateMinor.nullable().default(null),
  lumpSumMinor: positiveMinor.nullable().default(null),
  vatTreatment,
  description: optionalText(500).optional(),
  /** Required when the item's live subcontract lines would exceed its BQ quantity. */
  overQuantityReason: optionalText(500).optional(),
};
const oneRate = (
  value: { rateMinor: number | null; lumpSumMinor: number | null },
  ctx: z.RefinementCtx,
) => {
  if ((value.rateMinor === null) === (value.lumpSumMinor === null))
    ctx.addIssue({ code: "custom", path: ["rateMinor"], message: "rate_or_lump_sum" });
};
export const subcontractLineInputSchema = z.strictObject(lineInput).superRefine(oneRate);
export type SubcontractLineInput = z.input<typeof subcontractLineInputSchema>;
export const addSubcontractLineRequestSchema = z
  .strictObject({ version, ...lineInput })
  .superRefine(oneRate);
export type AddSubcontractLineRequest = z.input<typeof addSubcontractLineRequestSchema>;
export type ParsedAddSubcontractLineRequest = z.infer<typeof addSubcontractLineRequestSchema>;

export const subcontractVersionRequestSchema = z.strictObject({ version });
export const subcontractReasonRequestSchema = z.strictObject({ version, reason });
/** Approval binds to the version and the digest the approver saw. */
export const subcontractDigestRequestSchema = z.strictObject({ version, digest });
export const subcontractVersionQuerySchema = z.object({ version: z.coerce.number().int().min(1) });

export const createSubcontractVariationRequestSchema = z
  .strictObject({
    reason: text(3, 1000, true),
    additions: z
      .array(subcontractLineInputSchema)
      .max(SUBCONTRACT_LIMITS.changesPerVariation)
      .default([]),
    changes: z
      .array(
        z.strictObject({
          lineId: uuid,
          quantityChange,
          overQuantityReason: optionalText(500).optional(),
        }),
      )
      .max(SUBCONTRACT_LIMITS.changesPerVariation)
      .refine(
        (rows) => new Set(rows.map((row) => row.lineId)).size === rows.length,
        "duplicate_line",
      )
      .default([]),
  })
  .refine((value) => value.additions.length + value.changes.length > 0, {
    message: "variation_empty",
    path: ["changes"],
  });
export type CreateSubcontractVariationRequest = z.input<
  typeof createSubcontractVariationRequestSchema
>;
export type ParsedSubcontractVariationRequest = z.infer<
  typeof createSubcontractVariationRequestSchema
>;

export const createSubcontractAdvanceRequestSchema = z.strictObject({
  amountMinor: positiveMinor,
  reason,
});
export type CreateSubcontractAdvanceRequest = z.infer<typeof createSubcontractAdvanceRequestSchema>;
export const paySubcontractAdvanceRequestSchema = z.strictObject({
  version,
  paidOn: calendarDate,
  method,
  reference,
});
export type PaySubcontractAdvanceRequest = z.infer<typeof paySubcontractAdvanceRequestSchema>;

export const createSubcontractCertificateRequestSchema = z
  .strictObject({
    kind: z.enum(SUBCONTRACT_CERTIFICATE_KINDS).default("interim"),
    releaseStage: z.enum(RELEASE_STAGES).nullable().default(null),
    valuationDate: calendarDate,
    notes: optionalText(1000, true).optional(),
  })
  .refine((value) => (value.kind === "retention_release") === (value.releaseStage !== null), {
    message: "release_stage",
    path: ["releaseStage"],
  });
export type CreateSubcontractCertificateRequest = z.input<
  typeof createSubcontractCertificateRequestSchema
>;
export const updateSubcontractCertificateRequestSchema = z.strictObject({
  version,
  valuationDate: calendarDate.optional(),
  notes: optionalText(1000, true).optional(),
});
export type UpdateSubcontractCertificateRequest = z.infer<
  typeof updateSubcontractCertificateRequestSchema
>;
export const setSubcontractClaimsRequestSchema = z.strictObject({
  version,
  claims: z
    .array(z.strictObject({ lineId: uuid, quantityToDate: quantity4 }))
    .min(1)
    .max(SUBCONTRACT_LIMITS.linesPerSubcontract)
    .refine(
      (rows) => new Set(rows.map((row) => row.lineId)).size === rows.length,
      "duplicate_line",
    ),
});
export type SetSubcontractClaimsRequest = z.infer<typeof setSubcontractClaimsRequestSchema>;
export const recordSubcontractPaymentRequestSchema = z.strictObject({
  amountMinor: positiveMinor,
  paidOn: calendarDate,
  method,
  reference,
});
export type RecordSubcontractPaymentRequest = z.infer<typeof recordSubcontractPaymentRequestSchema>;
export const matchSubcontractInvoiceRequestSchema = z.strictObject({
  invoiceNumber: text(1, 60),
  invoiceDate: calendarDate,
  etimsNumber: optionalText(60).optional(),
});
export type MatchSubcontractInvoiceRequest = z.infer<typeof matchSubcontractInvoiceRequestSchema>;
export const subcontractItemsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  cursor: z
    .string()
    .regex(/^\d{1,6}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

// Responses -------------------------------------------------------------------------------------

export const subcontractorRefSchema = z.strictObject({
  id: uuid,
  code: z.string(),
  name: z.string(),
  kraPinMasked: z.string().nullable(),
  etimsStatus: z.string(),
});
export type SubcontractorRef = z.infer<typeof subcontractorRefSchema>;

const certificateRef = z.strictObject({
  id: uuid,
  number: z.number().int(),
  code: z.string(),
  status: z.enum(SUBCONTRACT_CERTIFICATE_STATUSES),
});

/** What a subcontract stands at (statement figures, KES minor units). */
export const subcontractPositionSchema = z.strictObject({
  /** Gross work certified to date (the latest certified certificate's work done). */
  certifiedWorkMinor: minor,
  /** Amounts due certified to date (net of retention and advance recovery, excluding VAT). */
  certifiedDueMinor: minor,
  /** VAT and withholding tax on the certified certificates. */
  vatMinor: minor,
  whtMinor: minor,
  /** Payable to date (due + VAT − withholding) and recorded payments against it. */
  payableMinor: minor,
  paidMinor: minor,
  outstandingMinor: minor,
  retentionHeldMinor: minor,
  advancesPaidMinor: minor,
  advancesRecoveredMinor: minor,
  advancesOutstandingMinor: minor,
});
export type SubcontractPosition = z.infer<typeof subcontractPositionSchema>;

export const subcontractSummarySchema = z.strictObject({
  id: uuid,
  number: z.number().int(),
  code: z.string(),
  project: projectRefSchema,
  supplier: subcontractorRefSchema,
  kind,
  title: z.string(),
  status,
  startDate: calendarDate,
  endDate: calendarDate,
  contractVersion: z.number().int(),
  /** Σ lines while a draft or submitted; the approved values afterwards. */
  valueMinor: minor,
  originalValueMinor: minor.nullable(),
  /** Value not yet certified, counted as committed in the budget (live subcontracts only). */
  committedMinor: minor,
  position: subcontractPositionSchema,
  openCertificate: certificateRef.nullable(),
  version,
  updatedAt: timestamp,
});
export type SubcontractSummary = z.infer<typeof subcontractSummarySchema>;

export const subcontractTermsSchema = z.strictObject({
  retentionPercent: z.string(),
  retentionLimitPercent: z.string().nullable(),
  practicalReleasePercent: z.string(),
  vatPercent: z.string(),
  whtPercent: z.string(),
  advanceLimitMinor: minor,
  advanceRecoveryPercent: z.string(),
  paymentTermsDays: z.number().int(),
  paymentTermsNote: z.string().nullable(),
});
export type SubcontractTermsWire = z.infer<typeof subcontractTermsSchema>;

export const subcontractLineSchema = z.strictObject({
  id: uuid,
  lineNo: z.number().int(),
  bqItem: spendingBqItemSchema,
  basis: z.enum(SUBCONTRACT_LINE_BASES),
  description: z.string(),
  unit: z.string().nullable(),
  /** Quantity (or percent of the item) in force: as let plus approved changes. */
  quantity: z.string(),
  originalQuantity: z.string(),
  rateMinor: minor.nullable(),
  /** Value in force. */
  amountMinor: minor,
  vatTreatment,
  overQuantityReason: z.string().nullable(),
  /** The variation that added the line (null for a line of the contract). */
  addedBy: z
    .strictObject({ id: uuid, code: z.string(), status: z.enum(SUBCONTRACT_VARIATION_STATUSES) })
    .nullable(),
  /** Counts towards the subcontract (a contract line or one added by an approved variation). */
  inForce: z.boolean(),
  /** The item in the BQ in force: its quantity (null for a lump sum) and rate (KES). */
  bqQuantity: z.string().nullable(),
  bqRate: z.string().nullable(),
  /** The subcontract's own rate is above the client BQ rate (a warning, never a refusal). */
  rateAboveBq: z.boolean(),
  /** Quantity let on the item by the other live subcontracts. */
  letElsewhere: z.string(),
  /** The item's approved measured quantity to date (D6.3), "0" when none. */
  measuredToDate: z.string(),
  certifiedQuantity: z.string(),
  certifiedMinor: minor,
});
export type SubcontractLine = z.infer<typeof subcontractLineSchema>;

export const subcontractVariationSchema = z.strictObject({
  id: uuid,
  number: z.number().int(),
  code: z.string(),
  reason: z.string(),
  status: z.enum(SUBCONTRACT_VARIATION_STATUSES),
  valueChangeMinor: minor,
  digest,
  resultingVersion: z.number().int().nullable(),
  additions: z.array(uuid),
  changes: z.array(
    z.strictObject({
      lineId: uuid,
      lineNo: z.number().int(),
      quantityChange: z.string(),
      amountChangeMinor: minor,
      overQuantityReason: z.string().nullable(),
    }),
  ),
  createdBy: person,
  createdAt: timestamp,
  decidedBy: person.nullable(),
  decidedAt: timestamp.nullable(),
  decisionReason: z.string().nullable(),
  version,
  permissions: z.strictObject({ canApprove: z.boolean(), canReject: z.boolean() }),
});
export type SubcontractVariation = z.infer<typeof subcontractVariationSchema>;

export const subcontractAdvanceSchema = z.strictObject({
  id: uuid,
  number: z.number().int(),
  code: z.string(),
  amountMinor: minor,
  reason: z.string(),
  status: z.enum(SUBCONTRACT_ADVANCE_STATUSES),
  requestedBy: person,
  requestedAt: timestamp,
  decidedBy: person.nullable(),
  decidedAt: timestamp.nullable(),
  decisionNote: z.string().nullable(),
  paidBy: person.nullable(),
  paidAt: timestamp.nullable(),
  paidOn: calendarDate.nullable(),
  method: method.nullable(),
  reference: z.string().nullable(),
  version,
  permissions: z.strictObject({
    canApprove: z.boolean(),
    canReject: z.boolean(),
    canPay: z.boolean(),
    canCancel: z.boolean(),
  }),
});
export type SubcontractAdvance = z.infer<typeof subcontractAdvanceSchema>;

export const subcontractCertificateSummarySchema = z.strictObject({
  id: uuid,
  number: z.number().int(),
  code: z.string(),
  certificateNumber: z.number().int().nullable(),
  kind: z.enum(SUBCONTRACT_CERTIFICATE_KINDS),
  releaseStage: z.enum(RELEASE_STAGES).nullable(),
  status: z.enum(SUBCONTRACT_CERTIFICATE_STATUSES),
  valuationDate: calendarDate,
  workDoneMinor: minor.nullable(),
  amountDueMinor: minor.nullable(),
  payableMinor: minor.nullable(),
  paidMinor: minor,
  certifiedAt: timestamp.nullable(),
});
export type SubcontractCertificateSummary = z.infer<typeof subcontractCertificateSummarySchema>;

const problemSchema = z.strictObject({ code: z.string(), ref: z.string().nullable() });

export const subcontractDetailSchema = subcontractSummarySchema.extend({
  scope: z.string().nullable(),
  terms: subcontractTermsSchema,
  digest: digest.nullable(),
  /** The digest the approver must quote (computed now for a draft or submitted subcontract). */
  currentDigest: digest,
  createdBy: person,
  createdAt: timestamp,
  submittedBy: person.nullable(),
  submittedAt: timestamp.nullable(),
  approvedBy: person.nullable(),
  approvedAt: timestamp.nullable(),
  activatedBy: person.nullable(),
  activatedAt: timestamp.nullable(),
  closedBy: person.nullable(),
  closedAt: timestamp.nullable(),
  closeReason: z.string().nullable(),
  cancelledBy: person.nullable(),
  cancelledAt: timestamp.nullable(),
  cancelReason: z.string().nullable(),
  returnReason: z.string().nullable(),
  lines: z.array(subcontractLineSchema),
  variations: z.array(subcontractVariationSchema),
  advances: z.array(subcontractAdvanceSchema),
  certificates: z.array(subcontractCertificateSummarySchema),
  /** Why it cannot be submitted or approved now (e.g. a line above the BQ quantity). */
  problems: z.array(problemSchema),
  warnings: z.array(problemSchema),
  permissions: z.strictObject({
    canEdit: z.boolean(),
    canSubmit: z.boolean(),
    canApprove: z.boolean(),
    canReturn: z.boolean(),
    canActivate: z.boolean(),
    canComplete: z.boolean(),
    canTerminate: z.boolean(),
    canCancel: z.boolean(),
    canVary: z.boolean(),
    canRequestAdvance: z.boolean(),
    canCreateCertificate: z.boolean(),
    canExport: z.boolean(),
  }),
});
export type SubcontractDetail = z.infer<typeof subcontractDetailSchema>;
export const subcontractResponseSchema = z.strictObject({ subcontract: subcontractDetailSchema });
export type SubcontractResponse = z.infer<typeof subcontractResponseSchema>;

export const projectSubcontractsResponseSchema = z.strictObject({
  project: projectRefSchema,
  subcontracts: z.array(subcontractSummarySchema),
  subcontractors: z.array(subcontractorRefSchema),
  totals: z.strictObject({
    committedMinor: minor,
    certifiedWorkMinor: minor,
    retentionHeldMinor: minor,
    advancesOutstandingMinor: minor,
    outstandingMinor: minor,
  }),
  permissions: z.strictObject({
    canCreate: z.boolean(),
    canReadPieceRate: z.boolean(),
  }),
});
export type ProjectSubcontractsResponse = z.infer<typeof projectSubcontractsResponseSchema>;

export const subcontractsOverviewResponseSchema = z.strictObject({
  projects: z.array(
    z.strictObject({
      project: projectRefSchema,
      subcontracts: z.number().int(),
      /** Approved or active (open for work). */
      live: z.number().int(),
      committedMinor: minor,
      certifiedWorkMinor: minor,
      retentionHeldMinor: minor,
      advancesOutstandingMinor: minor,
      openCertificates: z.number().int(),
      pendingApprovals: z.number().int(),
    }),
  ),
  subcontractors: z.array(subcontractorRefSchema),
  pieceRateProjects: z.array(projectRefSchema),
});
export type SubcontractsOverviewResponse = z.infer<typeof subcontractsOverviewResponseSchema>;

export const subcontractItemSchema = spendingBqItemSchema.extend({
  basis: z.enum(SUBCONTRACT_LINE_BASES),
  bqQuantity: z.string().nullable(),
  bqRate: z.string().nullable(),
  /** Let by live subcontracts (all of them); available = BQ quantity (or 100 %) − let. */
  letQuantity: z.string(),
  availableQuantity: z.string(),
});
export type SubcontractItem = z.infer<typeof subcontractItemSchema>;
export const subcontractItemsResponseSchema = z.strictObject({
  bqVersion: z.strictObject({ id: uuid, versionNo: z.number().int() }).nullable(),
  items: z.array(subcontractItemSchema),
  page: pageInfoSchema,
});
export type SubcontractItemsResponse = z.infer<typeof subcontractItemsResponseSchema>;

export const subcontractFiguresSchema = z.strictObject({
  workDoneMinor: minor,
  vatableWorkDoneMinor: minor,
  retentionStage: z.enum(RETENTION_STAGES),
  retentionLimitMinor: minor.nullable(),
  retentionComputedMinor: minor,
  retentionHeldMinor: minor,
  advancesPaidMinor: minor,
  recoveredToDateMinor: minor,
  advancesOutstandingMinor: minor,
  netToDateMinor: minor,
  previousCertifiedMinor: minor,
  amountDueMinor: minor,
  vatMinor: minor,
  whtMinor: minor,
  payableMinor: minor,
});
export type SubcontractFigures = z.infer<typeof subcontractFiguresSchema>;

export const subcontractCertificateLineSchema = z.strictObject({
  lineId: uuid,
  lineNo: z.number().int(),
  bqItem: spendingBqItemSchema,
  basis: z.enum(SUBCONTRACT_LINE_BASES),
  description: z.string(),
  unit: z.string().nullable(),
  rateMinor: minor.nullable(),
  lineQuantity: z.string(),
  lineAmountMinor: minor,
  vatTreatment,
  /** The item's approved measured quantity on the certificate date (D6.3). */
  measuredToDate: z.string().nullable(),
  /** Claimed on the item by the other subcontracts' latest certificates. */
  otherClaims: z.string(),
  /** What may still be claimed on this line (within it and within measured − other claims). */
  availableQuantity: z.string(),
  quantityToDate: z.string(),
  previousQuantity: z.string(),
  previousMinor: minor,
  valueToDateMinor: minor,
  thisPeriodMinor: minor,
});
export type SubcontractCertificateLine = z.infer<typeof subcontractCertificateLineSchema>;

export const subcontractPaymentSchema = z.strictObject({
  id: uuid,
  amountMinor: minor,
  paidOn: calendarDate,
  method,
  reference: z.string(),
  recordedBy: person,
  recordedAt: timestamp,
});
export type SubcontractPayment = z.infer<typeof subcontractPaymentSchema>;

export const subcontractInvoiceSchema = z.strictObject({
  id: uuid,
  invoiceNumber: z.string(),
  invoiceDate: calendarDate,
  etimsNumber: z.string().nullable(),
  amountMinor: minor,
  recordedBy: person,
  recordedAt: timestamp,
});
export type SubcontractInvoice = z.infer<typeof subcontractInvoiceSchema>;

export const subcontractCertificateDetailSchema = subcontractCertificateSummarySchema.extend({
  project: projectRefSchema,
  subcontract: z.strictObject({
    id: uuid,
    code: z.string(),
    title: z.string(),
    kind,
    status,
    contractVersion: z.number().int(),
    supplier: subcontractorRefSchema,
  }),
  notes: z.string().nullable(),
  revision: z.number().int(),
  ruleVersion: z.string(),
  terms: subcontractTermsSchema,
  originalValueMinor: minor,
  /** Frozen once submitted; a draft's figures are a preview recomputed on every read. */
  figures: subcontractFiguresSchema,
  lines: z.array(subcontractCertificateLineSchema),
  digest: digest.nullable(),
  currentDigest: digest,
  problems: z.array(problemSchema),
  warnings: z.array(problemSchema),
  payments: z.array(subcontractPaymentSchema),
  invoice: subcontractInvoiceSchema.nullable(),
  outstandingMinor: minor,
  createdBy: person,
  createdAt: timestamp,
  submittedBy: person.nullable(),
  submittedAt: timestamp.nullable(),
  certifiedBy: person.nullable(),
  cancelledBy: person.nullable(),
  cancelledAt: timestamp.nullable(),
  cancelReason: z.string().nullable(),
  returnReason: z.string().nullable(),
  version,
  permissions: z.strictObject({
    canEdit: z.boolean(),
    canSubmit: z.boolean(),
    canCertify: z.boolean(),
    canReturn: z.boolean(),
    canCancel: z.boolean(),
    canPay: z.boolean(),
    canMatchInvoice: z.boolean(),
    canExport: z.boolean(),
  }),
});
export type SubcontractCertificateDetail = z.infer<typeof subcontractCertificateDetailSchema>;
export const subcontractCertificateResponseSchema = z.strictObject({
  certificate: subcontractCertificateDetailSchema,
  /** True when an Idempotency-Key replay returned the original payment. */
  replayed: z.boolean(),
});
export type SubcontractCertificateResponse = z.infer<typeof subcontractCertificateResponseSchema>;

// Piece-rate jobs -----------------------------------------------------------------------------

export const createPieceRateJobRequestSchema = z
  .strictObject({
    bqItemLineageId: uuid,
    labourerId: uuid.nullable().default(null),
    gangId: uuid.nullable().default(null),
    description: text(3, 200),
    /** The job's unit: the item's unit, or one D5.1 converts to it exactly. */
    unit: text(1, 20),
    rateMinor: z.number().int().min(1).max(PIECE_RATE_LIMITS.maxRateMinor),
    agreedQuantity: quantity3,
    startDate: calendarDate,
    endDate: calendarDate,
  })
  .refine((value) => Boolean(value.labourerId) !== Boolean(value.gangId), {
    message: "labourer_or_gang",
    path: ["gangId"],
  })
  .superRefine(datesInOrder);
export type CreatePieceRateJobRequest = z.input<typeof createPieceRateJobRequestSchema>;
export const pieceRateJobVersionRequestSchema = z.strictObject({ version });
export const pieceRateJobReasonRequestSchema = z.strictObject({ version, reason });
export const createPieceRateExtensionRequestSchema = z.strictObject({
  quantity: quantity3,
  reason,
});
export type CreatePieceRateExtensionRequest = z.infer<typeof createPieceRateExtensionRequestSchema>;
/** Output against a job: only the day and the quantity — the rate, unit and worker are the job's. */
export const recordJobOutputRequestSchema = z.strictObject({
  workDate: calendarDate,
  quantity: quantity3,
  description: optionalText(200).optional(),
});
export type RecordJobOutputRequest = z.infer<typeof recordJobOutputRequestSchema>;

const labourerRef = z.strictObject({ id: uuid, workerNo: z.string(), fullName: z.string() });
const gangRef = z.strictObject({ id: uuid, name: z.string() });

export const pieceRateExtensionSchema = z.strictObject({
  id: uuid,
  quantity: z.string(),
  reason: z.string(),
  status: z.enum(PIECE_RATE_EXTENSION_STATUSES),
  requestedBy: person,
  requestedAt: timestamp,
  decidedBy: person.nullable(),
  decidedAt: timestamp.nullable(),
  decisionNote: z.string().nullable(),
  version,
  permissions: z.strictObject({ canApprove: z.boolean(), canReject: z.boolean() }),
});
export type PieceRateExtension = z.infer<typeof pieceRateExtensionSchema>;

export const pieceRateJobSchema = z.strictObject({
  id: uuid,
  number: z.number().int(),
  code: z.string(),
  projectId: uuid,
  bqItem: spendingBqItemSchema,
  labourer: labourerRef.nullable(),
  gang: gangRef.nullable(),
  description: z.string(),
  unit: z.string(),
  bqUnit: z.string(),
  conversionFactor: z.string(),
  rateMinor: minor,
  agreedQuantity: z.string(),
  /** Agreed quantity plus approved extensions. */
  quantityInForce: z.string(),
  approvedQuantity: z.string(),
  pendingQuantity: z.string(),
  remainingQuantity: z.string(),
  approvedAmountMinor: minor,
  startDate: calendarDate,
  endDate: calendarDate,
  status: z.enum(PIECE_RATE_JOB_STATUSES),
  createdBy: person,
  createdAt: timestamp,
  decidedBy: person.nullable(),
  decidedAt: timestamp.nullable(),
  decisionNote: z.string().nullable(),
  closedBy: person.nullable(),
  closedAt: timestamp.nullable(),
  version,
  extensions: z.array(pieceRateExtensionSchema),
  permissions: z.strictObject({
    canApprove: z.boolean(),
    canReject: z.boolean(),
    canClose: z.boolean(),
    canExtend: z.boolean(),
    canRecord: z.boolean(),
  }),
});
export type PieceRateJob = z.infer<typeof pieceRateJobSchema>;

export const pieceRateJobsResponseSchema = z.strictObject({
  project: projectRefSchema,
  today: calendarDate,
  jobs: z.array(pieceRateJobSchema),
  permissions: z.strictObject({
    canCreate: z.boolean(),
    canDecide: z.boolean(),
    canRecord: z.boolean(),
    canReconcile: z.boolean(),
  }),
});
export type PieceRateJobsResponse = z.infer<typeof pieceRateJobsResponseSchema>;

export const pieceRateJobResponseSchema = z.strictObject({
  job: pieceRateJobSchema,
  outputs: z.array(pieceRateOutputSchema),
});
export type PieceRateJobResponse = z.infer<typeof pieceRateJobResponseSchema>;

export const pieceRateJobOptionsResponseSchema = z.strictObject({
  project: projectRefSchema,
  items: z.array(
    spendingBqItemSchema.extend({
      quantity: z.string().nullable(),
      /** Units a job may use: the item's unit first (factor 1), then units D5.1 converts exactly. */
      units: z.array(z.strictObject({ unit: z.string(), factor: z.string() })),
    }),
  ),
  gangs: z.array(gangRef.extend({ members: z.number().int() })),
  labourers: z.array(labourerRef),
});
export type PieceRateJobOptionsResponse = z.infer<typeof pieceRateJobOptionsResponseSchema>;

export const reconciliationItemSchema = z.strictObject({
  bqItem: spendingBqItemSchema,
  /** Approved measured quantity (BQ unit) today, null when the item has no approved measurement. */
  measured: z.string().nullable(),
  measuredOn: calendarDate.nullable(),
  /** Approved piece-rate output converted to the BQ unit (payable). */
  pieceRateQuantity: z.string(),
  pieceRateAmountMinor: minor,
  pendingQuantity: z.string(),
  /** Quantity certified to subcontractors on the item (their latest certified certificates). */
  subcontractedQuantity: z.string(),
  excessPieceRate: z.string(),
  excessCombined: z.string(),
  unlinkedOutputs: z.number().int(),
  jobs: z.array(
    z.strictObject({ id: uuid, code: z.string(), status: z.enum(PIECE_RATE_JOB_STATUSES) }),
  ),
  flags: z.array(z.enum(RECONCILIATION_FLAGS)),
});
export type ReconciliationItem = z.infer<typeof reconciliationItemSchema>;
export const pieceRateReconciliationResponseSchema = z.strictObject({
  project: projectRefSchema,
  asOf: calendarDate,
  items: z.array(reconciliationItemSchema),
  flagged: z.number().int(),
});
export type PieceRateReconciliationResponse = z.infer<typeof pieceRateReconciliationResponseSchema>;
