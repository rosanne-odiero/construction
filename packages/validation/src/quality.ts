import {
  COMPLETION_ACTIONS,
  COMPLETION_KINDS,
  COMPLETION_STATUSES,
  CONCRETE_CLASSES,
  CUBE_AGE_STATES,
  CUBE_OUTCOMES,
  CUBE_SET_STATUSES,
  CUBE_TEST_AGES,
  INSPECTION_ACTIONS,
  INSPECTION_CATEGORIES,
  INSPECTION_ITEM_RESULTS,
  INSPECTION_RESULTS,
  INSPECTION_STATUSES,
  INSPECTOR_TYPES,
  QUALITY_LIMITS,
  QUALITY_SETTINGS_LIMITS,
  SLUMP_OUTCOMES,
  SNAG_ACTIONS,
  SNAG_PHASES,
  SNAG_RESPONSIBLE_KINDS,
  SNAG_SEVERITIES,
  SNAG_STATUSES,
} from "@pm-buddy/types";
import { z } from "zod";
import { planningDateSchema } from "./primitives.js";

/**
 * Quality (D6.1): checklist templates, inspections, concrete cube and slump tests, snags,
 * practical and final completion, and the company quality settings. Requests are strict (a body
 * never carries a tenant or project ID); responses are strict so the web never trusts an
 * unexpected shape. Dates are business dates (YYYY-MM-DD, Africa/Nairobi); strengths are decimal
 * strings in N/mm².
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();
const version = z.number().int().min(1).max(2_147_483_647);
const person = z.strictObject({ id: uuid, displayName: z.string() });
const count = z.number().int().min(0);

/** Characters as PostgreSQL's char_length counts them (code points), not UTF-16 units. */
const characters = (value: string) => Array.from(value).length;
const printable = (value: string, multiline: boolean) =>
  Array.from(value).every((char) => {
    const code = char.codePointAt(0)!;
    if (multiline && (code === 9 || code === 10 || code === 13)) return true;
    return code >= 32 && !(code >= 127 && code <= 159);
  });
const text = (min: number, max: number, multiline = false) =>
  z
    .string()
    .trim()
    .refine((value) => characters(value) >= min && characters(value) <= max, "length")
    .refine((value) => printable(value, multiline), "control_characters");
/** Optional text: an empty string is stored as null. */
const optionalText = (max: number, multiline = false) =>
  z
    .string()
    .trim()
    .refine((value) => characters(value) <= max, "length")
    .refine((value) => printable(value, multiline), "control_characters")
    .transform((value) => (value === "" ? null : value))
    .nullable();
const reason = text(3, 500, true);
const photoIds = z.array(uuid).max(QUALITY_LIMITS.maxPhotosPerItem);
const search = z.string().trim().max(100).optional();
const cursor = z.coerce.number().int().min(1).optional();
const limit = z.coerce.number().int().min(1).max(QUALITY_LIMITS.maxPageSize).default(30);

export const inspectionCategorySchema = z.enum(INSPECTION_CATEGORIES);
export const inspectorTypeSchema = z.enum(INSPECTOR_TYPES);
export const inspectionStatusSchema = z.enum(INSPECTION_STATUSES);
export const inspectionItemResultSchema = z.enum(INSPECTION_ITEM_RESULTS);
export const concreteClassSchema = z.enum(CONCRETE_CLASSES);
export const snagSeveritySchema = z.enum(SNAG_SEVERITIES);
export const snagStatusSchema = z.enum(SNAG_STATUSES);
export const completionKindSchema = z.enum(COMPLETION_KINDS);

/** A linked site photo (thumbnails come from the photos endpoint). */
export const qualityPhotoSchema = z.strictObject({
  id: uuid,
  verified: z.boolean(),
  caption: z.string().nullable(),
});
export type QualityPhoto = z.infer<typeof qualityPhotoSchema>;

// Checklist templates ---------------------------------------------------------------------------

const templateContent = {
  name: text(3, 120),
  category: inspectionCategorySchema,
  description: optionalText(500, true).optional().default(null),
  items: z
    .array(z.strictObject({ text: text(3, QUALITY_LIMITS.maxTemplateItemChars, true) }))
    .min(1)
    .max(QUALITY_LIMITS.maxTemplateItems),
};
export const createChecklistTemplateRequestSchema = z.strictObject(templateContent);
export const reviseChecklistTemplateRequestSchema = z.strictObject({
  ...templateContent,
  expectedVersion: version,
});
export const retireChecklistTemplateRequestSchema = z.strictObject({ expectedVersion: version });
/** Load the starter templates (packages/types) in one language; names that exist are skipped. */
export const loadStarterTemplatesRequestSchema = z.strictObject({ language: z.enum(["en", "sw"]) });
export const loadStarterTemplatesResponseSchema = z.strictObject({ created: count });
export const checklistTemplatesQuerySchema = z.strictObject({
  includeRetired: z.enum(["true", "false"]).optional(),
});

export const checklistTemplateSummarySchema = z.strictObject({
  id: uuid,
  lineageId: uuid,
  version,
  name: z.string(),
  category: inspectionCategorySchema,
  description: z.string().nullable(),
  retired: z.boolean(),
  itemCount: z.number().int().min(1),
  createdBy: person,
  createdAt: timestamp,
});
export const checklistTemplateSchema = checklistTemplateSummarySchema.extend({
  /** True for the newest version of its lineage (only that one can be revised or retired). */
  current: z.boolean(),
  items: z.array(z.strictObject({ id: uuid, position: z.number().int().min(1), text: z.string() })),
  permissions: z.strictObject({ canRevise: z.boolean(), canRetire: z.boolean() }),
});
export const checklistTemplatesResponseSchema = z.strictObject({
  templates: z.array(checklistTemplateSummarySchema),
  permissions: z.strictObject({ canCreate: z.boolean() }),
});
export const checklistTemplateResponseSchema = z.strictObject({
  template: checklistTemplateSchema,
  /** Older versions of the lineage, newest first. */
  history: z.array(checklistTemplateSummarySchema),
});

// Inspections -----------------------------------------------------------------------------------

const inspectionLinks = {
  wbsNodeId: uuid.nullable().optional(),
  scheduleActivityId: uuid.nullable().optional(),
  /** An item of the project's newest approved BQ version (the server records that version). */
  bqItemLineageId: uuid.nullable().optional(),
};
export const createInspectionRequestSchema = z.strictObject({
  siteId: uuid,
  templateId: uuid,
  location: text(2, 200),
  inspectorType: inspectorTypeSchema,
  inspectorName: optionalText(150).optional().default(null),
  inspectedOn: planningDateSchema,
  notes: optionalText(2000, true).optional().default(null),
  ...inspectionLinks,
});
export const inspectionItemInputSchema = z
  .strictObject({
    id: uuid,
    result: inspectionItemResultSchema,
    note: optionalText(1000, true),
    photoIds,
  })
  .superRefine((value, ctx) => {
    if (new Set(value.photoIds).size !== value.photoIds.length)
      ctx.addIssue({ code: "custom", path: ["photoIds"], message: "duplicate_photo" });
  });
export const updateInspectionRequestSchema = z
  .strictObject({
    version,
    location: text(2, 200).optional(),
    inspectorType: inspectorTypeSchema.optional(),
    inspectorName: optionalText(150).optional(),
    inspectedOn: planningDateSchema.optional(),
    notes: optionalText(2000, true).optional(),
    ...inspectionLinks,
    items: z.array(inspectionItemInputSchema).max(QUALITY_LIMITS.maxTemplateItems).optional(),
  })
  .superRefine((value, ctx) => {
    const ids = value.items?.map((item) => item.id) ?? [];
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["items"], message: "duplicate_item" });
  });
export const inspectionActionRequestSchema = z
  .strictObject({
    version,
    action: z.enum(INSPECTION_ACTIONS),
    reason: reason.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "return" && !value.reason)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason_required" });
    if (value.action !== "return" && value.reason !== undefined)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason_not_allowed" });
  });
export const inspectionsQuerySchema = z.strictObject({
  status: inspectionStatusSchema.optional(),
  result: z.enum(INSPECTION_RESULTS).optional(),
  search,
  cursor,
  limit,
});

export const inspectionItemSchema = z.strictObject({
  id: uuid,
  position: z.number().int().min(1),
  text: z.string(),
  result: inspectionItemResultSchema,
  note: z.string().nullable(),
  photos: z.array(qualityPhotoSchema),
  /** Snags raised from this item. */
  snagCount: count,
});
export const inspectionSchema = z.strictObject({
  id: uuid,
  projectId: uuid,
  siteId: uuid,
  siteName: z.string(),
  number: z.number().int().min(1),
  code: z.string(),
  template: z.strictObject({ id: uuid, name: z.string(), version }),
  category: inspectionCategorySchema,
  location: z.string(),
  inspectorType: inspectorTypeSchema,
  inspectorName: z.string().nullable(),
  inspectedOn: calendarDate,
  links: z.strictObject({
    wbsNode: z.strictObject({ id: uuid, code: z.string(), name: z.string() }).nullable(),
    scheduleActivity: z
      .strictObject({ id: uuid, code: z.string().nullable(), name: z.string() })
      .nullable(),
    bqItem: z
      .strictObject({
        versionId: uuid,
        lineageId: uuid,
        reference: z.string().nullable(),
        description: z.string(),
      })
      .nullable(),
  }),
  status: inspectionStatusSchema,
  /** Null while any item is pending. */
  result: z.enum(INSPECTION_RESULTS).nullable(),
  itemCounts: z.strictObject({ total: count, pass: count, fail: count, na: count, pending: count }),
  notes: z.string().nullable(),
  version,
  createdBy: person,
  createdAt: timestamp,
  submittedBy: person.nullable(),
  submittedAt: timestamp.nullable(),
  signedOffBy: person.nullable(),
  signedOffAt: timestamp.nullable(),
  returnedBy: person.nullable(),
  returnedAt: timestamp.nullable(),
  returnReason: z.string().nullable(),
  permissions: z.strictObject({
    canEdit: z.boolean(),
    canSubmit: z.boolean(),
    canSignOff: z.boolean(),
    canReturn: z.boolean(),
    canRaiseSnags: z.boolean(),
  }),
});
export const inspectionsResponseSchema = z.strictObject({
  inspections: z.array(inspectionSchema),
  nextCursor: z.number().int().min(1).nullable(),
  permissions: z.strictObject({ canCreate: z.boolean() }),
});

// Snags -----------------------------------------------------------------------------------------

export const createSnagRequestSchema = z
  .strictObject({
    siteId: uuid,
    location: text(2, 200),
    description: text(3, 2000, true),
    severity: snagSeveritySchema,
    responsibleKind: z.enum(SNAG_RESPONSIBLE_KINDS),
    responsibleName: text(2, 150),
    dueOn: planningDateSchema.nullable().optional().default(null),
    inspectionItemId: uuid.optional(),
    photoIds: photoIds.optional().default([]),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.photoIds).size !== value.photoIds.length)
      ctx.addIssue({ code: "custom", path: ["photoIds"], message: "duplicate_photo" });
  });
export const updateSnagRequestSchema = z.strictObject({
  version,
  location: text(2, 200).optional(),
  description: text(3, 2000, true).optional(),
  severity: snagSeveritySchema.optional(),
  responsibleKind: z.enum(SNAG_RESPONSIBLE_KINDS).optional(),
  responsibleName: text(2, 150).optional(),
  dueOn: planningDateSchema.nullable().optional(),
});
export const snagActionRequestSchema = z
  .strictObject({
    version,
    action: z.enum(SNAG_ACTIONS),
    /** What was done (fix only, optional). */
    note: text(3, 1000, true).optional(),
    reason: reason.optional(),
    photoIds: photoIds.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "reopen" && !value.reason)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason_required" });
    if (value.action !== "reopen" && value.reason !== undefined)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason_not_allowed" });
    if (value.action !== "fix" && (value.note !== undefined || value.photoIds !== undefined))
      ctx.addIssue({ code: "custom", path: ["note"], message: "fix_only" });
    if (value.photoIds && new Set(value.photoIds).size !== value.photoIds.length)
      ctx.addIssue({ code: "custom", path: ["photoIds"], message: "duplicate_photo" });
  });
export const snagsQuerySchema = z.strictObject({
  /** `active`: open or fixed (awaiting verification). */
  status: z.enum([...SNAG_STATUSES, "active"]).optional(),
  severity: snagSeveritySchema.optional(),
  phase: z.enum(SNAG_PHASES).optional(),
  search,
  cursor,
  limit,
});

export const snagSchema = z.strictObject({
  id: uuid,
  projectId: uuid,
  siteId: uuid,
  siteName: z.string(),
  number: z.number().int().min(1),
  code: z.string(),
  location: z.string(),
  description: z.string(),
  severity: snagSeveritySchema,
  responsibleKind: z.enum(SNAG_RESPONSIBLE_KINDS),
  responsibleName: z.string(),
  dueOn: calendarDate.nullable(),
  /** Past its due date (Africa/Nairobi) and not yet closed. */
  overdue: z.boolean(),
  phase: z.enum(SNAG_PHASES),
  inspection: z.strictObject({ id: uuid, code: z.string(), itemText: z.string() }).nullable(),
  status: snagStatusSchema,
  fixNote: z.string().nullable(),
  reopenCount: count,
  lastReopenReason: z.string().nullable(),
  photos: z.strictObject({
    raised: z.array(qualityPhotoSchema),
    fixed: z.array(qualityPhotoSchema),
  }),
  raisedBy: person,
  raisedAt: timestamp,
  fixedBy: person.nullable(),
  fixedAt: timestamp.nullable(),
  closedBy: person.nullable(),
  closedAt: timestamp.nullable(),
  version,
  permissions: z.strictObject({
    canEdit: z.boolean(),
    canFix: z.boolean(),
    canClose: z.boolean(),
    canReopen: z.boolean(),
  }),
});
export const snagResponseSchema = z.strictObject({ snag: snagSchema });
export const snagsResponseSchema = z.strictObject({
  snags: z.array(snagSchema),
  nextCursor: z.number().int().min(1).nullable(),
  counts: z.strictObject({
    open: count,
    fixed: count,
    closed: count,
    openCritical: count,
    overdue: count,
    dlpOpen: count,
  }),
  permissions: z.strictObject({ canCreate: z.boolean() }),
});

export const inspectionDetailResponseSchema = z.strictObject({
  inspection: inspectionSchema,
  items: z.array(inspectionItemSchema),
  snags: z.array(snagSchema),
});
export const inspectionResponseSchema = inspectionDetailResponseSchema;

// Concrete tests --------------------------------------------------------------------------------

/** N/mm² with at most one decimal place (0–150). */
export const cubeStrengthSchema = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d)?$/, "invalid_strength")
  .refine((value) => Number(value) <= QUALITY_LIMITS.maxCubeStrength, "strength_out_of_range");
const strengths = z.array(cubeStrengthSchema).min(1).max(QUALITY_LIMITS.maxCubesPerAge);
const cubeAge = z.union([z.literal(CUBE_TEST_AGES[0]), z.literal(CUBE_TEST_AGES[1])]);

export const createCubeSetRequestSchema = z.strictObject({
  siteId: uuid,
  element: text(3, 200),
  concreteClass: concreteClassSchema,
  castOn: planningDateSchema,
  cubesPerAge: z.number().int().min(1).max(QUALITY_LIMITS.maxCubesPerAge).default(3),
  batchReference: optionalText(60).optional().default(null),
  notes: optionalText(1000, true).optional().default(null),
});
const cubeResultContent = {
  testedOn: planningDateSchema,
  strengths,
  laboratory: optionalText(120).optional().default(null),
  reportReference: optionalText(60).optional().default(null),
};
export const recordCubeResultRequestSchema = z.strictObject({
  ageDays: cubeAge,
  ...cubeResultContent,
});
export const correctCubeResultRequestSchema = z.strictObject({ ...cubeResultContent, reason });
export const voidCubeSetRequestSchema = z.strictObject({ version, reason });
export const cubeSetsQuerySchema = z.strictObject({
  /** `overdue`: a result past its due date and grace days; `failed`: failed at 28 days. */
  filter: z.enum(["all", "overdue", "failed"]).default("all"),
  search,
  cursor,
  limit,
});

export const cubeResultSchema = z.strictObject({
  id: uuid,
  ageDays: cubeAge,
  testedOn: calendarDate,
  strengths: z.array(z.string()),
  meanStrength: z.string(),
  minStrength: z.string(),
  percentOfClass: z.string(),
  outcome: z.enum(CUBE_OUTCOMES),
  ruleVersion: z.string(),
  laboratory: z.string().nullable(),
  reportReference: z.string().nullable(),
  supersedesId: uuid.nullable(),
  correctionReason: z.string().nullable(),
  /** False once a correction replaced it. */
  current: z.boolean(),
  recordedBy: person,
  recordedAt: timestamp,
});
export const cubeSetSchema = z.strictObject({
  id: uuid,
  projectId: uuid,
  siteId: uuid,
  siteName: z.string(),
  number: z.number().int().min(1),
  code: z.string(),
  element: z.string(),
  concreteClass: concreteClassSchema,
  /** f_cu, N/mm². */
  specifiedStrength: z.number().int().min(1),
  castOn: calendarDate,
  cubesPerAge: z.number().int().min(1),
  batchReference: z.string().nullable(),
  notes: z.string().nullable(),
  status: z.enum(CUBE_SET_STATUSES),
  voidReason: z.string().nullable(),
  ages: z.array(
    z.strictObject({
      ageDays: cubeAge,
      dueOn: calendarDate,
      state: z.enum(CUBE_AGE_STATES),
      result: cubeResultSchema.nullable(),
    }),
  ),
  /** The current 28-day outcome; null until recorded. */
  outcome: z.enum(["pass", "fail"]).nullable(),
  version,
  createdBy: person,
  createdAt: timestamp,
  permissions: z.strictObject({
    canRecord: z.boolean(),
    canCorrect: z.boolean(),
    canVoid: z.boolean(),
  }),
});
export const cubeSetResponseSchema = z.strictObject({
  cubeSet: cubeSetSchema,
  /** Every result version (corrections included), newest first. */
  history: z.array(cubeResultSchema),
});
export const cubeSetsResponseSchema = z.strictObject({
  cubeSets: z.array(cubeSetSchema),
  nextCursor: z.number().int().min(1).nullable(),
  counts: z.strictObject({ overdue: count, failed: count }),
  permissions: z.strictObject({ canCreate: z.boolean() }),
});

const slumpContent = {
  testedOn: planningDateSchema,
  element: text(3, 200),
  concreteClass: concreteClassSchema.nullable().optional().default(null),
  targetMm: z.number().int().min(10).max(QUALITY_LIMITS.maxSlumpTargetMm),
  toleranceMm: z.number().int().min(5).max(QUALITY_LIMITS.maxSlumpToleranceMm),
  measuredMm: z.number().int().min(0).max(QUALITY_LIMITS.maxSlumpMm),
  notes: optionalText(1000, true).optional().default(null),
};
export const createSlumpTestRequestSchema = z.strictObject({
  siteId: uuid,
  cubeSetId: uuid.nullable().optional().default(null),
  ...slumpContent,
});
export const correctSlumpTestRequestSchema = z.strictObject({ ...slumpContent, reason });
export const slumpTestsQuerySchema = z.strictObject({
  outcome: z.enum(SLUMP_OUTCOMES).optional(),
  search,
  cursor,
  limit,
});
export const slumpTestSchema = z.strictObject({
  id: uuid,
  projectId: uuid,
  siteId: uuid,
  siteName: z.string(),
  number: z.number().int().min(1),
  code: z.string(),
  testedOn: calendarDate,
  element: z.string(),
  concreteClass: concreteClassSchema.nullable(),
  cubeSet: z.strictObject({ id: uuid, code: z.string() }).nullable(),
  targetMm: z.number().int(),
  toleranceMm: z.number().int(),
  measuredMm: z.number().int(),
  deviationMm: z.number().int(),
  outcome: z.enum(SLUMP_OUTCOMES),
  ruleVersion: z.string(),
  notes: z.string().nullable(),
  supersedesId: uuid.nullable(),
  correctionReason: z.string().nullable(),
  current: z.boolean(),
  recordedBy: person,
  recordedAt: timestamp,
  permissions: z.strictObject({ canCorrect: z.boolean() }),
});
export const slumpTestResponseSchema = z.strictObject({
  slumpTest: slumpTestSchema,
  history: z.array(slumpTestSchema),
});
export const slumpTestsResponseSchema = z.strictObject({
  slumpTests: z.array(slumpTestSchema),
  nextCursor: z.number().int().min(1).nullable(),
  permissions: z.strictObject({ canCreate: z.boolean() }),
});

// Completion and the defects liability period ---------------------------------------------------

export const proposeCompletionRequestSchema = z
  .strictObject({
    kind: completionKindSchema,
    completionDate: planningDateSchema,
    dlpMonths: z
      .number()
      .int()
      .min(QUALITY_SETTINGS_LIMITS.dlpMonths.min)
      .max(QUALITY_SETTINGS_LIMITS.dlpMonths.max)
      .optional(),
    exceptionReason: optionalText(500, true).optional().default(null),
    notes: optionalText(1000, true).optional().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "final" && value.dlpMonths !== undefined)
      ctx.addIssue({ code: "custom", path: ["dlpMonths"], message: "practical_only" });
    if (value.exceptionReason !== null && characters(value.exceptionReason) < 3)
      ctx.addIssue({ code: "custom", path: ["exceptionReason"], message: "too_short" });
  });
export const completionActionRequestSchema = z
  .strictObject({
    version,
    action: z.enum(COMPLETION_ACTIONS),
    reason: reason.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "withdraw" && !value.reason)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason_required" });
    if (value.action !== "withdraw" && value.reason !== undefined)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason_not_allowed" });
  });

export const completionBlockerSchema = z.enum([
  "open_critical_snags",
  "open_snags",
  "practical_not_certified",
  "dlp_not_ended",
  "date_future",
]);
export const completionCertificateSchema = z.strictObject({
  id: uuid,
  kind: completionKindSchema,
  status: z.enum(COMPLETION_STATUSES),
  completionDate: calendarDate,
  dlpMonths: z.number().int().nullable(),
  dlpEndsOn: calendarDate.nullable(),
  /** Snags open (not closed) when proposed, refreshed at certification. */
  openCriticalSnags: count,
  openSnags: count,
  exceptionReason: z.string().nullable(),
  notes: z.string().nullable(),
  version,
  proposedBy: person,
  proposedAt: timestamp,
  certifiedBy: person.nullable(),
  certifiedAt: timestamp.nullable(),
  withdrawnBy: person.nullable(),
  withdrawnAt: timestamp.nullable(),
  withdrawReason: z.string().nullable(),
  permissions: z.strictObject({ canCertify: z.boolean(), canWithdraw: z.boolean() }),
});
export const completionResponseSchema = z.strictObject({
  practical: completionCertificateSchema.nullable(),
  final: completionCertificateSchema.nullable(),
  /** Every certificate, withdrawn ones included, newest first. */
  history: z.array(completionCertificateSchema),
  dlp: z
    .strictObject({
      startsOn: calendarDate,
      endsOn: calendarDate,
      months: z.number().int(),
      state: z.enum(["running", "ended"]),
      daysRemaining: count,
      defects: z.strictObject({ open: count, fixed: count, closed: count }),
    })
    .nullable(),
  readiness: z.strictObject({
    openCriticalSnags: count,
    openSnags: count,
    practicalBlockers: z.array(completionBlockerSchema),
    finalBlockers: z.array(completionBlockerSchema),
  }),
  defaultDlpMonths: z.number().int(),
  permissions: z.strictObject({ canPropose: z.boolean() }),
});

// Summary and settings --------------------------------------------------------------------------

export const qualitySummaryResponseSchema = z.strictObject({
  inspections: z.strictObject({ draft: count, submitted: count, signedOff: count, failed: count }),
  cubes: z.strictObject({ overdue: count, failed: count }),
  slumpFailed: count,
  snags: z.strictObject({ open: count, fixed: count, openCritical: count, overdue: count }),
  completion: z.strictObject({
    practical: z.enum(COMPLETION_STATUSES).nullable(),
    final: z.enum(COMPLETION_STATUSES).nullable(),
    dlpEndsOn: calendarDate.nullable(),
  }),
});

export const qualitySettingsSchema = z.strictObject({
  dlpMonths: z.number().int(),
  cubeOverdueGraceDays: z.number().int(),
  /** 0 while the company uses the defaults. */
  version: z.number().int().min(0),
  updatedAt: timestamp.nullable(),
  permissions: z.strictObject({ canEdit: z.boolean() }),
});
export const qualitySettingsResponseSchema = z.strictObject({ settings: qualitySettingsSchema });
export const updateQualitySettingsRequestSchema = z.strictObject({
  dlpMonths: z
    .number()
    .int()
    .min(QUALITY_SETTINGS_LIMITS.dlpMonths.min)
    .max(QUALITY_SETTINGS_LIMITS.dlpMonths.max),
  cubeOverdueGraceDays: z
    .number()
    .int()
    .min(QUALITY_SETTINGS_LIMITS.cubeOverdueGraceDays.min)
    .max(QUALITY_SETTINGS_LIMITS.cubeOverdueGraceDays.max),
  version: z.number().int().min(0).max(2_147_483_647),
});

export type ChecklistTemplateSummary = z.infer<typeof checklistTemplateSummarySchema>;
export type ChecklistTemplate = z.infer<typeof checklistTemplateSchema>;
export type ChecklistTemplatesResponse = z.infer<typeof checklistTemplatesResponseSchema>;
export type ChecklistTemplateResponse = z.infer<typeof checklistTemplateResponseSchema>;
export type CreateChecklistTemplateRequest = z.infer<typeof createChecklistTemplateRequestSchema>;
export type ReviseChecklistTemplateRequest = z.infer<typeof reviseChecklistTemplateRequestSchema>;
export type Inspection = z.infer<typeof inspectionSchema>;
export type InspectionItem = z.infer<typeof inspectionItemSchema>;
export type InspectionsResponse = z.infer<typeof inspectionsResponseSchema>;
export type InspectionDetailResponse = z.infer<typeof inspectionDetailResponseSchema>;
export type CreateInspectionRequest = z.infer<typeof createInspectionRequestSchema>;
export type UpdateInspectionRequest = z.infer<typeof updateInspectionRequestSchema>;
export type InspectionActionRequest = z.infer<typeof inspectionActionRequestSchema>;
export type InspectionsQuery = z.infer<typeof inspectionsQuerySchema>;
export type Snag = z.infer<typeof snagSchema>;
export type SnagsResponse = z.infer<typeof snagsResponseSchema>;
export type CreateSnagRequest = z.infer<typeof createSnagRequestSchema>;
export type UpdateSnagRequest = z.infer<typeof updateSnagRequestSchema>;
export type SnagActionRequest = z.infer<typeof snagActionRequestSchema>;
export type SnagsQuery = z.infer<typeof snagsQuerySchema>;
export type CubeResult = z.infer<typeof cubeResultSchema>;
export type CubeSet = z.infer<typeof cubeSetSchema>;
export type CubeSetResponse = z.infer<typeof cubeSetResponseSchema>;
export type CubeSetsResponse = z.infer<typeof cubeSetsResponseSchema>;
export type CreateCubeSetRequest = z.infer<typeof createCubeSetRequestSchema>;
export type RecordCubeResultRequest = z.infer<typeof recordCubeResultRequestSchema>;
export type CorrectCubeResultRequest = z.infer<typeof correctCubeResultRequestSchema>;
export type CubeSetsQuery = z.infer<typeof cubeSetsQuerySchema>;
export type SlumpTest = z.infer<typeof slumpTestSchema>;
export type SlumpTestsResponse = z.infer<typeof slumpTestsResponseSchema>;
export type SlumpTestResponse = z.infer<typeof slumpTestResponseSchema>;
export type CreateSlumpTestRequest = z.infer<typeof createSlumpTestRequestSchema>;
export type CorrectSlumpTestRequest = z.infer<typeof correctSlumpTestRequestSchema>;
export type SlumpTestsQuery = z.infer<typeof slumpTestsQuerySchema>;
export type CompletionCertificate = z.infer<typeof completionCertificateSchema>;
export type CompletionResponse = z.infer<typeof completionResponseSchema>;
export type ProposeCompletionRequest = z.infer<typeof proposeCompletionRequestSchema>;
export type CompletionActionRequest = z.infer<typeof completionActionRequestSchema>;
export type QualitySummaryResponse = z.infer<typeof qualitySummaryResponseSchema>;
export type QualitySettings = z.infer<typeof qualitySettingsSchema>;
export type UpdateQualitySettingsRequest = z.infer<typeof updateQualitySettingsRequestSchema>;
