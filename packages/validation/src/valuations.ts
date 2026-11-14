import { adjustmentSignOk } from "@pm-buddy/domain";
import {
  ADJUSTMENT_KINDS,
  BQ_ITEM_KINDS,
  CONTRACT_SETTINGS_LIMITS,
  ETC_BASES,
  MATERIALS_SOURCES,
  MEASUREMENT_BASES,
  MEASUREMENT_DECISIONS,
  MEASUREMENT_STATES,
  MEASUREMENT_STATUSES,
  RELEASE_STAGES,
  RETENTION_STAGES,
  VALUATION_KINDS,
  VALUATION_LIMITS,
  VALUATION_STATUSES,
} from "@pm-buddy/types";
import { z } from "zod";
import { pageInfoSchema } from "./api.js";
import { projectRefSchema, spendingBqItemSchema } from "./spending.js";
import { storesBqItemSchema } from "./stores.js";

/**
 * D6.3 part A contracts: progress measurements with photo evidence and independent review, the
 * measurement sheet per BQ item, interim valuations and payment certificates (materials on site,
 * retention, agreed adjustments, VAT), retention releases, contract settings, earned value with
 * the S-curve, and cost to complete. Money is integer KES minor units (`*Minor`), quantities
 * decimal strings with up to four places, percentages decimal strings. Requests are strict and
 * never carry a figure the server computes (values, retention, amounts due, VAT, digests are
 * computed and checked by the API and the database).
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();
const version = z.number().int().min(1).max(2_147_483_647);
const person = z.strictObject({ id: uuid, displayName: z.string() });
const minor = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const positiveMinor = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/, "invalid_digest");
const ratio = z.string().regex(/^-?\d+\.\d{2}$/, "invalid_ratio");
const percentText = z.string().regex(/^-?\d+\.\d$/, "invalid_percent");
const listLimit = z.coerce.number().int().min(1).max(200).default(50);

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
/** A quantity to date: up to 14 digits and four decimals, not negative. */
const quantityToDate = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/, "invalid_quantity");
/** A contract-settings percentage: up to two decimals. */
const settingPercent = (limits: { min: number; max: number }) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,3}(?:\.\d{1,2})?$/, "invalid_percent")
    .refine((value) => Number(value) >= limits.min && Number(value) <= limits.max, "out_of_range");
const versionRef = z.strictObject({ id: uuid, versionNo: z.number().int().min(1) });

// Measurements -------------------------------------------------------------------------------

export const createMeasurementRequestSchema = z
  .strictObject({
    /** Client-generated ID for offline capture (with an Idempotency-Key); optional on the web. */
    id: uuid.optional(),
    bqItemLineageId: uuid,
    measuredOn: calendarDate,
    /** Quantity completed to date in the item's unit, or percent complete for a lump sum. */
    quantityToDate,
    note: optionalText(500, true).optional(),
    correctsMeasurementId: uuid.nullable().default(null),
    correctionReason: optionalText(500).optional(),
    /** Required when the quantity is above the BQ quantity (an over-measure). */
    overMeasureReason: optionalText(500).optional(),
    /** Site photos of this project as evidence (more can be added until it is reviewed). */
    photoIds: z
      .array(uuid)
      .max(VALUATION_LIMITS.photosPerMeasurement)
      .refine((ids) => new Set(ids).size === ids.length, "duplicate_photo")
      .default([]),
  })
  .superRefine((value, ctx) => {
    if (value.correctsMeasurementId && !value.correctionReason)
      ctx.addIssue({ code: "custom", path: ["correctionReason"], message: "required" });
    if (value.correctionReason && length(value.correctionReason) < 3)
      ctx.addIssue({ code: "custom", path: ["correctionReason"], message: "too_short" });
    if (value.overMeasureReason && length(value.overMeasureReason) < 3)
      ctx.addIssue({ code: "custom", path: ["overMeasureReason"], message: "too_short" });
  });
export type CreateMeasurementRequest = z.input<typeof createMeasurementRequestSchema>;
export type ParsedMeasurementRequest = z.infer<typeof createMeasurementRequestSchema>;

export const measurementPhotosRequestSchema = z.strictObject({
  photoIds: z
    .array(uuid)
    .min(1)
    .max(VALUATION_LIMITS.photosPerMeasurement)
    .refine((ids) => new Set(ids).size === ids.length, "duplicate_photo"),
});
export const rejectMeasurementRequestSchema = z.strictObject({ reason });
export const approveMeasurementRequestSchema = z.strictObject({});

export const measurementPhotoSchema = z.strictObject({
  id: uuid,
  verified: z.boolean(),
  caption: z.string().nullable(),
});
export type MeasurementPhoto = z.infer<typeof measurementPhotoSchema>;

export const measurementReviewSchema = z.strictObject({
  decision: z.enum(MEASUREMENT_DECISIONS),
  reason: z.string().nullable(),
  decidedBy: person,
  decidedAt: timestamp,
});

export const measurementSchema = z.strictObject({
  id: uuid,
  projectId: uuid,
  bqItem: storesBqItemSchema,
  measuredOn: calendarDate,
  quantityToDate: z.string(),
  status: z.enum(MEASUREMENT_STATUSES),
  /** Derived from the review and corrections (pending, approved, rejected, withdrawn, superseded). */
  state: z.enum(MEASUREMENT_STATES),
  /** Quantity or percent complete; null for a D5.3 measurement recorded before D6.3. */
  basis: z.enum(MEASUREMENT_BASES).nullable(),
  /** The item on the measured BQ version. */
  itemQuantity: z.string().nullable(),
  itemAmountMinor: minor,
  /** Value of work done at this quantity on the measured version (0 when not measured). */
  valueMinor: minor,
  percentComplete: z.string().nullable(),
  overMeasured: z.boolean(),
  overMeasureReason: z.string().nullable(),
  note: z.string().nullable(),
  measuredBy: person,
  recordedAt: timestamp,
  correctsMeasurementId: uuid.nullable(),
  correctionReason: z.string().nullable(),
  /** A later measurement corrected this one. */
  corrected: z.boolean(),
  photos: z.array(measurementPhotoSchema),
  review: measurementReviewSchema.nullable(),
  permissions: z.strictObject({
    canApprove: z.boolean(),
    canReject: z.boolean(),
    canCorrect: z.boolean(),
    canAddPhotos: z.boolean(),
  }),
});
export type Measurement = z.infer<typeof measurementSchema>;
export const measurementResponseSchema = z.strictObject({
  measurement: measurementSchema,
  /** True when an Idempotency-Key replay returned the original measurement. */
  replayed: z.boolean(),
});
export type MeasurementResponse = z.infer<typeof measurementResponseSchema>;
export const measurementsResponseSchema = z.strictObject({
  measurements: z.array(measurementSchema),
  permissions: z.strictObject({ canRecord: z.boolean(), canApprove: z.boolean() }),
});
export type MeasurementsResponse = z.infer<typeof measurementsResponseSchema>;
export const measurementListQuerySchema = z.object({
  bqItemLineageId: uuid.optional(),
  state: z.enum(MEASUREMENT_STATES).optional(),
});
export const measurementDetailResponseSchema = z.strictObject({
  measurement: measurementSchema,
  project: projectRefSchema,
  /** Every measurement of the same item, newest first. */
  history: z.array(measurementSchema),
});
export type MeasurementDetailResponse = z.infer<typeof measurementDetailResponseSchema>;

export const approvalQueueResponseSchema = z.strictObject({
  entries: z.array(z.strictObject({ project: projectRefSchema, measurement: measurementSchema })),
  truncated: z.boolean(),
});
export type ApprovalQueueResponse = z.infer<typeof approvalQueueResponseSchema>;
export const approvalQueueQuerySchema = z.object({ projectId: uuid.optional() });

/** One item of the BQ in force with its measured progress (the measurement sheet). */
export const measurementItemSchema = z.strictObject({
  item: spendingBqItemSchema,
  kind: z.enum(BQ_ITEM_KINDS),
  basis: z.enum(MEASUREMENT_BASES).nullable(),
  quantity: z.string().nullable(),
  rate: z.string().nullable(),
  amountMinor: minor,
  /** The approved measurement in force today, valued on the BQ in force. */
  approved: z
    .strictObject({
      measurementId: uuid,
      measuredOn: calendarDate,
      quantityToDate: z.string(),
      valueMinor: minor,
      percentComplete: z.string().nullable(),
    })
    .nullable(),
  /** The newest measurement whatever its state. */
  latest: z
    .strictObject({
      measurementId: uuid,
      state: z.enum(MEASUREMENT_STATES),
      measuredOn: calendarDate,
      quantityToDate: z.string(),
    })
    .nullable(),
  pendingCount: z.number().int().min(0),
});
export type MeasurementItem = z.infer<typeof measurementItemSchema>;
export const measurementItemsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  billLineageId: uuid.optional(),
  cursor: z
    .string()
    .regex(/^\d{1,7}$/)
    .optional(),
  limit: listLimit,
});
export const measurementItemsResponseSchema = z.strictObject({
  project: projectRefSchema,
  bqVersion: versionRef.nullable(),
  bills: z.array(z.strictObject({ lineageId: uuid, number: z.string(), title: z.string() })),
  items: z.array(measurementItemSchema),
  page: pageInfoSchema,
  totals: z.strictObject({
    measurableMinor: minor,
    approvedValueMinor: minor,
    percentComplete: percentText.nullable(),
    pendingCount: z.number().int().min(0),
  }),
  permissions: z.strictObject({ canRecord: z.boolean(), canApprove: z.boolean() }),
});
export type MeasurementItemsResponse = z.infer<typeof measurementItemsResponseSchema>;

// Contract settings --------------------------------------------------------------------------

export const contractSettingsSchema = z.strictObject({
  retentionPercent: z.string(),
  retentionCapPercent: z.string().nullable(),
  vatPercent: z.string(),
  materialsPercent: z.string(),
  practicalReleasePercent: z.string(),
  /** 0 = the defaults (never saved for this project). */
  version: z.number().int().min(0),
  updatedAt: timestamp.nullable(),
  updatedBy: person.nullable(),
});
export type ContractSettings = z.infer<typeof contractSettingsSchema>;
export const updateContractSettingsRequestSchema = z.strictObject({
  /** The settings version read (0 for the defaults). */
  version: z.number().int().min(0).max(2_147_483_647),
  retentionPercent: settingPercent(CONTRACT_SETTINGS_LIMITS.retentionPercent),
  retentionCapPercent: settingPercent(CONTRACT_SETTINGS_LIMITS.retentionCapPercent).nullable(),
  vatPercent: settingPercent(CONTRACT_SETTINGS_LIMITS.vatPercent),
  materialsPercent: settingPercent(CONTRACT_SETTINGS_LIMITS.materialsPercent),
  practicalReleasePercent: settingPercent(CONTRACT_SETTINGS_LIMITS.practicalReleasePercent),
});
export type UpdateContractSettingsRequest = z.infer<typeof updateContractSettingsRequestSchema>;
export const contractSettingsResponseSchema = z.strictObject({
  project: projectRefSchema,
  settings: contractSettingsSchema,
});

// Valuations and certificates ----------------------------------------------------------------

export const valuationFiguresSchema = z.strictObject({
  workDoneMinor: minor,
  materialsGrossMinor: minor,
  materialsMinor: minor,
  grossMinor: minor,
  retentionStage: z.enum(RETENTION_STAGES),
  retentionCapMinor: minor.nullable(),
  retentionComputedMinor: minor,
  retentionHeldMinor: minor,
  adjustmentsMinor: minor,
  adjustmentsToDateMinor: minor,
  netToDateMinor: minor,
  previousCertifiedMinor: minor,
  amountDueMinor: minor,
  vatMinor: minor,
  totalMinor: minor,
});
export type ValuationFigures = z.infer<typeof valuationFiguresSchema>;

export const valuationTermsSchema = z.strictObject({
  retentionPercent: z.string(),
  retentionCapPercent: z.string().nullable(),
  vatPercent: z.string(),
  materialsPercent: z.string(),
  practicalReleasePercent: z.string(),
  settingsVersion: z.number().int().min(0),
  ruleVersion: z.string(),
});
export type ValuationTerms = z.infer<typeof valuationTermsSchema>;

export const contractSumSchema = z.strictObject({
  /** The approved baseline BQ (version 1), net of VAT. */
  originalMinor: minor,
  /** The BQ in force (after approved variations), net of VAT. */
  revisedMinor: minor,
  revisedVersionNo: z.number().int().min(1),
});
export type ContractSum = z.infer<typeof contractSumSchema>;

export const valuationSummarySchema = z.strictObject({
  id: uuid,
  project: projectRefSchema,
  number: z.string(),
  certificateNumber: z.string().nullable(),
  kind: z.enum(VALUATION_KINDS),
  releaseStage: z.enum(RELEASE_STAGES).nullable(),
  status: z.enum(VALUATION_STATUSES),
  valuationDate: calendarDate,
  /** Frozen at submission; null while a draft (its preview is on the detail). */
  amountDueMinor: minor.nullable(),
  totalMinor: minor.nullable(),
  createdBy: person,
  createdAt: timestamp,
  submittedAt: timestamp.nullable(),
  certifiedBy: person.nullable(),
  certifiedAt: timestamp.nullable(),
  version,
});
export type ValuationSummary = z.infer<typeof valuationSummarySchema>;

export const valuationItemLineSchema = z.strictObject({
  lineNo: z.number().int().min(1),
  bqItem: spendingBqItemSchema,
  kind: z.enum(BQ_ITEM_KINDS),
  basis: z.enum(MEASUREMENT_BASES).nullable(),
  itemQuantity: z.string().nullable(),
  rate: z.string().nullable(),
  itemAmountMinor: minor,
  measurementId: uuid.nullable(),
  measuredOn: calendarDate.nullable(),
  quantityToDate: z.string().nullable(),
  percentComplete: z.string().nullable(),
  overMeasured: z.boolean(),
  /** On the previous certified interim certificate. */
  previousMinor: minor,
  toDateMinor: minor,
  thisPeriodMinor: minor,
});
export type ValuationItemLine = z.infer<typeof valuationItemLineSchema>;

export const valuationMaterialsLineSchema = z.strictObject({
  lineNo: z.number().int().min(1),
  source: z.enum(MATERIALS_SOURCES),
  description: z.string(),
  unit: z.string().nullable(),
  quantity: z.string().nullable(),
  /** At cost, before the materials percentage. */
  amountMinor: minor,
  bqItem: spendingBqItemSchema.nullable(),
  store: z.strictObject({ id: uuid, name: z.string() }).nullable(),
  reference: z.string().nullable(),
});
export type ValuationMaterialsLine = z.infer<typeof valuationMaterialsLineSchema>;

export const valuationAdjustmentLineSchema = z.strictObject({
  lineNo: z.number().int().min(1),
  kind: z.enum(ADJUSTMENT_KINDS),
  description: z.string(),
  amountMinor: minor,
});

export const valuationMaterialInputSchema = z.strictObject({
  id: uuid,
  bqItem: spendingBqItemSchema,
  description: z.string(),
  unit: z.string().nullable(),
  quantity: z.string(),
  amountMinor: minor,
  reference: z.string().nullable(),
  createdBy: person,
});
export const valuationAdjustmentInputSchema = z.strictObject({
  id: uuid,
  kind: z.enum(ADJUSTMENT_KINDS),
  description: z.string(),
  amountMinor: minor,
  createdBy: person,
});

export const valuationWarningSchema = z.strictObject({
  code: z.enum([
    "pending-measurements",
    "basis-changed",
    "omitted-item",
    "no-measurements",
    "negative-amount",
  ]),
  count: z.number().int().min(0),
});
export type ValuationWarning = z.infer<typeof valuationWarningSchema>;

export const valuationDetailSchema = valuationSummarySchema.extend({
  notes: z.string().nullable(),
  materialsFromStores: z.boolean(),
  returnReason: z.string().nullable(),
  cancelReason: z.string().nullable(),
  cancelledBy: person.nullable(),
  cancelledAt: timestamp.nullable(),
  submittedBy: person.nullable(),
  bqVersion: versionRef.nullable(),
  contractSum: contractSumSchema.nullable(),
  terms: valuationTermsSchema,
  figures: valuationFiguresSchema,
  /** True for a draft: the figures are computed now and change until submission. */
  preview: z.boolean(),
  digest: digest.nullable(),
  revision: z.number().int().min(0),
  lines: z.strictObject({
    items: z.array(valuationItemLineSchema),
    materials: z.array(valuationMaterialsLineSchema),
    adjustments: z.array(valuationAdjustmentLineSchema),
  }),
  inputs: z.strictObject({
    materials: z.array(valuationMaterialInputSchema),
    adjustments: z.array(valuationAdjustmentInputSchema),
  }),
  warnings: z.array(valuationWarningSchema),
  permissions: z.strictObject({
    canEdit: z.boolean(),
    canSubmit: z.boolean(),
    canCertify: z.boolean(),
    canReturn: z.boolean(),
    canCancel: z.boolean(),
  }),
});
export type ValuationDetail = z.infer<typeof valuationDetailSchema>;
export const valuationResponseSchema = z.strictObject({ valuation: valuationDetailSchema });
export type ValuationResponse = z.infer<typeof valuationResponseSchema>;

export const retentionLedgerEntrySchema = z.strictObject({
  valuationId: uuid,
  certificateNumber: z.string(),
  kind: z.enum(VALUATION_KINDS),
  releaseStage: z.enum(RELEASE_STAGES).nullable(),
  valuationDate: calendarDate,
  certifiedAt: timestamp,
  /** Retention held after this certificate. */
  heldMinor: minor,
  /** Change from the previous certificate: positive when more is held, negative when released. */
  movementMinor: minor,
});
export type RetentionLedgerEntry = z.infer<typeof retentionLedgerEntrySchema>;

const completionRef = z
  .strictObject({ completionDate: calendarDate, dlpEndsOn: calendarDate.nullable() })
  .nullable();

export const projectValuationsResponseSchema = z.strictObject({
  project: projectRefSchema,
  contractSum: contractSumSchema.nullable(),
  settings: contractSettingsSchema,
  valuations: z.array(valuationSummarySchema),
  retention: z.strictObject({
    heldMinor: minor,
    releasedMinor: minor,
    stage: z.enum(RETENTION_STAGES),
    ledger: z.array(retentionLedgerEntrySchema),
  }),
  certified: z.strictObject({
    count: z.number().int().min(0),
    amountDueMinor: minor,
    vatMinor: minor,
    totalMinor: minor,
    workDoneMinor: minor,
  }),
  completions: z.strictObject({ practical: completionRef, final: completionRef }),
  permissions: z.strictObject({
    canCreate: z.boolean(),
    canRelease: z.strictObject({ practical: z.boolean(), final: z.boolean() }),
    canEditSettings: z.boolean(),
  }),
});
export type ProjectValuationsResponse = z.infer<typeof projectValuationsResponseSchema>;

export const valuationsOverviewResponseSchema = z.strictObject({
  projects: z.array(
    z.strictObject({
      project: projectRefSchema,
      canReadValuations: z.boolean(),
      canMeasure: z.boolean(),
      canApprove: z.boolean(),
      contractSum: contractSumSchema.nullable(),
      certifiedMinor: minor.nullable(),
      retentionHeldMinor: minor.nullable(),
      latestCertificate: z
        .strictObject({
          id: uuid,
          certificateNumber: z.string(),
          valuationDate: calendarDate,
          amountDueMinor: minor,
        })
        .nullable(),
      openValuation: z
        .strictObject({ id: uuid, number: z.string(), status: z.enum(VALUATION_STATUSES) })
        .nullable(),
      pendingMeasurements: z.number().int().min(0),
    }),
  ),
  /** Pending measurements the caller may review (not their own). */
  approvalQueue: z.number().int().min(0),
});
export type ValuationsOverviewResponse = z.infer<typeof valuationsOverviewResponseSchema>;

export const createValuationRequestSchema = z
  .strictObject({
    kind: z.enum(VALUATION_KINDS),
    releaseStage: z.enum(RELEASE_STAGES).nullable().default(null),
    valuationDate: calendarDate,
    notes: optionalText(1000, true).optional(),
    /** Include materials on hand in the project's stores at cost (interim only). */
    materialsFromStores: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if ((value.kind === "retention_release") !== (value.releaseStage !== null))
      ctx.addIssue({ code: "custom", path: ["releaseStage"], message: "release_stage_mismatch" });
    if (value.kind === "retention_release" && value.materialsFromStores)
      ctx.addIssue({ code: "custom", path: ["materialsFromStores"], message: "interim_only" });
  });
export type CreateValuationRequest = z.input<typeof createValuationRequestSchema>;

export const updateValuationRequestSchema = z.strictObject({
  version,
  valuationDate: calendarDate.optional(),
  notes: optionalText(1000, true).optional(),
  materialsFromStores: z.boolean().optional(),
});
export type UpdateValuationRequest = z.infer<typeof updateValuationRequestSchema>;

export const addValuationMaterialRequestSchema = z.strictObject({
  version,
  bqItemLineageId: uuid,
  description: text(2, 200),
  unit: optionalText(20).optional(),
  quantity: z
    .string()
    .trim()
    .regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/, "invalid_quantity")
    .refine((value) => Number(value) > 0, "must_be_positive"),
  amountMinor: positiveMinor,
  reference: optionalText(60).optional(),
});
export type AddValuationMaterialRequest = z.infer<typeof addValuationMaterialRequestSchema>;

export const addValuationAdjustmentRequestSchema = z
  .strictObject({
    version,
    kind: z.enum(ADJUSTMENT_KINDS),
    description: text(3, 200),
    amountMinor: minor,
  })
  .refine((value) => adjustmentSignOk(value.kind, value.amountMinor), {
    path: ["amountMinor"],
    message: "adjustment_sign",
  });
export type AddValuationAdjustmentRequest = z.infer<typeof addValuationAdjustmentRequestSchema>;

export const certifyValuationRequestSchema = z.strictObject({ version, digest });
export const valuationVersionRequestSchema = z.strictObject({ version });
export const valuationReasonRequestSchema = z.strictObject({ version, reason });
export const valuationVersionQuerySchema = z.object({ version: z.coerce.number().int().min(1) });
export const valuationExportQuerySchema = z.object({
  locale: z.enum(["en", "sw"]).default("en"),
});

// Earned value and cost to complete ----------------------------------------------------------

export const earnedValueQuerySchema = z.object({ asOf: calendarDate.optional() });

export const earnedValueFiguresSchema = z.strictObject({
  bacMinor: minor,
  pvMinor: minor.nullable(),
  evMinor: minor,
  acMinor: minor,
  cvMinor: minor,
  svMinor: minor.nullable(),
  cpi: ratio.nullable(),
  spi: ratio.nullable(),
  eacMinor: minor.nullable(),
  etcMinor: minor.nullable(),
  vacMinor: minor.nullable(),
  percentComplete: percentText.nullable(),
  percentPlanned: percentText.nullable(),
});
export type EarnedValueFiguresWire = z.infer<typeof earnedValueFiguresSchema>;

export const curvePointSchema = z.strictObject({
  weekEnd: calendarDate,
  pvMinor: minor.nullable(),
  evMinor: minor.nullable(),
  acMinor: minor.nullable(),
});
export type CurvePointWire = z.infer<typeof curvePointSchema>;

export const earnedValueResponseSchema = z.strictObject({
  project: projectRefSchema,
  dataDate: calendarDate,
  bqVersion: versionRef.nullable(),
  baseline: z
    .strictObject({
      id: uuid,
      baselineNo: z.number().int().min(1),
      name: z.string(),
      startDate: calendarDate,
      finishDate: calendarDate.nullable(),
    })
    .nullable(),
  figures: earnedValueFiguresSchema,
  curve: z.array(curvePointSchema),
  curveTruncated: z.boolean(),
  /**
   * Brief §15 G keeps these apart: physical progress (schedule), earned value (measured, at
   * contract rates), certified value (certificates), invoiced value and cash received.
   */
  values: z.strictObject({
    physicalPercent: z.string().nullable(),
    earnedMinor: minor,
    certifiedWorkMinor: minor.nullable(),
    certifiedNetMinor: minor,
    invoicedMinor: minor.nullable(),
    receivedMinor: minor.nullable(),
  }),
  notes: z.strictObject({
    /** Materials still in the project's stores at cost on the data date (part of AC). */
    stockOnHandMinor: minor,
    itemsLinkedToBaseline: z.number().int().min(0),
    itemsSpreadOverBaseline: z.number().int().min(0),
  }),
});
export type EarnedValueResponse = z.infer<typeof earnedValueResponseSchema>;

export const costToCompleteRowSchema = z.strictObject({
  contractMinor: minor,
  evMinor: minor,
  budgetMinor: minor.nullable(),
  actualMinor: minor,
  earnedBudgetMinor: minor.nullable(),
  cpi: ratio.nullable(),
  etcMinor: minor.nullable(),
  eacMinor: minor.nullable(),
  vacMinor: minor.nullable(),
  basis: z.enum(ETC_BASES),
});
export type CostToCompleteRow = z.infer<typeof costToCompleteRowSchema>;

export const costToCompleteQuerySchema = z.object({
  billLineageId: uuid.optional(),
  search: z.string().trim().max(100).optional(),
  cursor: z
    .string()
    .regex(/^\d{1,7}$/)
    .optional(),
  limit: listLimit,
});

export const costToCompleteResponseSchema = z.strictObject({
  project: projectRefSchema,
  bqVersion: versionRef.nullable(),
  budget: z
    .strictObject({ id: uuid, versionNo: z.number().int().min(1), name: z.string() })
    .nullable(),
  totals: costToCompleteRowSchema,
  bills: z.array(
    costToCompleteRowSchema.extend({
      bill: z.strictObject({ lineageId: uuid, number: z.string(), title: z.string() }),
    }),
  ),
  bill: z.strictObject({ lineageId: uuid, number: z.string(), title: z.string() }).nullable(),
  items: z.array(
    costToCompleteRowSchema.extend({
      item: spendingBqItemSchema,
      percentComplete: z.string().nullable(),
    }),
  ),
  page: pageInfoSchema.nullable(),
  /** Costs not tagged to a BQ item (cost codes, materials still in stores): outside item ETC. */
  notOnBqItems: z.strictObject({ actualMinor: minor, budgetMinor: minor.nullable() }),
});
export type CostToCompleteResponse = z.infer<typeof costToCompleteResponseSchema>;
