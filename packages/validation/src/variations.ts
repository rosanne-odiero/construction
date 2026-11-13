import {
  BQ_ITEM_KINDS,
  BQ_UNITS,
  BUILDUP_LIMITS,
  BUILDUP_OUTPUT_UNITS,
  BUILDUP_RESOURCE_KINDS,
  INSTRUCTION_ISSUER_ROLES,
  INSTRUCTION_STATUSES,
  VARIATION_ACTIONS,
  VARIATION_ADD_KINDS,
  VARIATION_LIMITS,
  VARIATION_LINE_ACTIONS,
  VARIATION_LINE_ISSUES,
  VARIATION_STATUSES,
} from "@pm-buddy/types";
import { z } from "zod";
import { bqVersionSchema } from "./bq.js";
import { minorUnitsSchema } from "./primitives.js";

/**
 * D2.3 contracts: BQ versions (history, baseline approval, comparison, contract sums),
 * Architect's/Engineer's Instructions, Variation Orders and the company's rate build-up library.
 * Requests are strict (a body never carries a tenant, project, maker or approver) and responses
 * are strict. Money is KES minor units; quantities and rates are decimal strings.
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();
const version = z.number().int().min(1).max(2_147_483_647);
const person = z.strictObject({ id: uuid, displayName: z.string() });
const digest = z.string().regex(/^[0-9a-f]{64}$/, "invalid_digest");

/** True when every character is printable (tabs and line breaks allowed where `multiline`). */
function printable(value: string, multiline: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (multiline && (code === 9 || code === 10 || code === 13)) continue;
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

/** Trimmed text of `min`–`max` characters without control characters. */
const text = (min: number, max: number, multiline = false) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => printable(value, multiline), "control_characters");
/** Optional text: an empty string is stored as null. */
const optionalText = (max: number, multiline = false) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => printable(value, multiline), "control_characters")
    .transform((value) => (value === "" ? null : value))
    .nullable();
const reason = text(3, 500, true);

/** A BQ quantity or rate: 0 – 999,999,999,999 with up to four decimals (numeric(20,4)). */
export const bqDecimalInputSchema = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,4})?$/, "invalid_decimal");
/** A non-negative amount in minor units within the BQ's amount range. */
const amountInput = z.number().int().min(0).max(99_999_999_999_999);

// Versions ----------------------------------------------------------------------------------------

export const bqVersionsResponseSchema = z.strictObject({ versions: z.array(bqVersionSchema) });
export const bqVersionResponseSchema = z.strictObject({ version: bqVersionSchema });
export const approveBaselineRequestSchema = z.strictObject({ version });

export const bqCompareQuerySchema = z.strictObject({ from: uuid, to: uuid });

const comparedValues = z.strictObject({
  quantity: z.string().nullable(),
  rate: z.string().nullable(),
  amountMinor: minorUnitsSchema,
  amountSource: z.string(),
});
const totalsTriple = z.strictObject({
  subtotalMinor: minorUnitsSchema,
  vatMinor: minorUnitsSchema,
  grandTotalMinor: minorUnitsSchema,
});
export const bqItemDifferenceSchema = z.strictObject({
  lineageId: uuid,
  billNumber: z.string(),
  ref: z.string().nullable(),
  description: z.string(),
  unit: z.enum(BQ_UNITS).nullable(),
  unitRaw: z.string().nullable(),
  from: comparedValues.nullable(),
  to: comparedValues.nullable(),
  fields: z.array(z.enum(["quantity", "rate", "amount", "amountSource"])),
  differenceMinor: minorUnitsSchema,
});
export const bqCompareResponseSchema = z.strictObject({
  from: z.strictObject({ id: uuid, versionNo: z.number().int().min(1) }),
  to: z.strictObject({ id: uuid, versionNo: z.number().int().min(1) }),
  added: z.array(bqItemDifferenceSchema),
  removed: z.array(bqItemDifferenceSchema),
  changed: z.array(bqItemDifferenceSchema),
  bills: z.array(
    z.strictObject({
      lineageId: uuid,
      number: z.string(),
      title: z.string(),
      fromMinor: minorUnitsSchema.nullable(),
      toMinor: minorUnitsSchema.nullable(),
      differenceMinor: minorUnitsSchema,
    }),
  ),
  totals: z.strictObject({ from: totalsTriple, to: totalsTriple, difference: totalsTriple }),
});

/**
 * Original vs revised contract sum (grand totals including VAT). Original is the approved
 * baseline; revised the newest approved version; approved variations = revised − original.
 * Submitted variations are reported separately as pending and never added into the revised sum.
 */
export const bqContractSumResponseSchema = z.strictObject({
  status: z.enum(["no-bq", "draft", "approved"]),
  vatRatePercent: z.string().nullable(),
  draftTotalMinor: minorUnitsSchema.nullable(),
  originalMinor: minorUnitsSchema.nullable(),
  approvedVariationsMinor: minorUnitsSchema.nullable(),
  revisedMinor: minorUnitsSchema.nullable(),
  approvedCount: z.number().int().min(0),
  pendingMinor: minorUnitsSchema,
  pendingCount: z.number().int().min(0),
  currentVersionNo: z.number().int().min(1).nullable(),
  baselineApprovedAt: timestamp.nullable(),
});

// Instructions ------------------------------------------------------------------------------------

export const instructionIssuerRoleSchema = z.enum(INSTRUCTION_ISSUER_ROLES);
export const instructionStatusSchema = z.enum(INSTRUCTION_STATUSES);
/** e.g. AI-007, EI/12, SI 3: letters, digits, space, dot, slash, underscore, hyphen. */
export const instructionNumberSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,29}$/, "invalid_instruction_number");
const attachmentSchema = z.strictObject({
  name: text(1, 150),
  reference: optionalText(300),
});

export const createInstructionRequestSchema = z.strictObject({
  number: instructionNumberSchema,
  issuedOn: calendarDate,
  issuerName: text(2, 150),
  issuerRole: instructionIssuerRoleSchema,
  subject: text(3, 200),
  description: optionalText(4_000, true).optional(),
  attachments: z.array(attachmentSchema).max(VARIATION_LIMITS.maxAttachments).default([]),
});
export const updateInstructionRequestSchema = z.strictObject({
  number: instructionNumberSchema.optional(),
  issuedOn: calendarDate.optional(),
  issuerName: text(2, 150).optional(),
  issuerRole: instructionIssuerRoleSchema.optional(),
  subject: text(3, 200).optional(),
  description: optionalText(4_000, true).optional(),
  attachments: z.array(attachmentSchema).max(VARIATION_LIMITS.maxAttachments).optional(),
  status: instructionStatusSchema.optional(),
  version,
});
export const instructionListQuerySchema = z.strictObject({
  status: instructionStatusSchema.optional(),
});

export const instructionSchema = z.strictObject({
  id: uuid,
  number: z.string(),
  issuedOn: calendarDate,
  issuerName: z.string(),
  issuerRole: instructionIssuerRoleSchema,
  subject: z.string(),
  description: z.string().nullable(),
  attachments: z.array(z.strictObject({ name: z.string(), reference: z.string().nullable() })),
  status: instructionStatusSchema,
  variations: z.strictObject({
    total: z.number().int().min(0),
    approved: z.number().int().min(0),
    pending: z.number().int().min(0),
  }),
  createdBy: person,
  createdAt: timestamp,
  updatedAt: timestamp,
  version,
});
export const instructionsResponseSchema = z.strictObject({
  instructions: z.array(instructionSchema),
  permissions: z.strictObject({ canEdit: z.boolean() }),
});
export const instructionResponseSchema = z.strictObject({ instruction: instructionSchema });

// Variations --------------------------------------------------------------------------------------

export const variationStatusSchema = z.enum(VARIATION_STATUSES);
export const variationActionSchema = z.enum(VARIATION_ACTIONS);

const lineNote = optionalText(500, true).optional();
const optionalDecimal = bqDecimalInputSchema.nullable().optional();

/** A line as the client sends it. `id` names an existing line of this variation (kept on save). */
export const variationLineInputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    id: uuid.optional(),
    action: z.literal("adjust"),
    itemLineageId: uuid,
    quantity: optionalDecimal,
    rate: optionalDecimal,
    amountMinor: amountInput.nullable().optional(),
    note: lineNote,
  }),
  z.strictObject({
    id: uuid.optional(),
    action: z.literal("omit"),
    itemLineageId: uuid,
    note: lineNote,
  }),
  z.strictObject({
    id: uuid.optional(),
    action: z.literal("add"),
    billLineageId: uuid,
    sectionLineageId: uuid.nullable().optional(),
    newSection: z
      .strictObject({ code: optionalText(30).optional(), title: text(1, 300) })
      .nullable()
      .optional(),
    ref: optionalText(30).optional(),
    description: text(1, 4_000, true),
    unit: z.enum(BQ_UNITS).nullable().optional(),
    kind: z.enum(VARIATION_ADD_KINDS),
    quantity: optionalDecimal,
    rate: optionalDecimal,
    amountMinor: amountInput.nullable().optional(),
    note: lineNote,
  }),
]);

export const createVariationRequestSchema = z.strictObject({
  instructionId: uuid,
  title: text(3, 200),
  description: optionalText(4_000, true).optional(),
});
export const updateVariationRequestSchema = z.strictObject({
  instructionId: uuid.optional(),
  title: text(3, 200).optional(),
  description: optionalText(4_000, true).optional(),
  version,
});
export const saveVariationLinesRequestSchema = z.strictObject({
  lines: z.array(variationLineInputSchema).max(VARIATION_LIMITS.maxLines),
  version,
});
export const variationVersionRequestSchema = z.strictObject({ version });
/** Approval binds to the snapshot the approver saw (its digest) and the record version. */
export const approveVariationRequestSchema = z.strictObject({ version, snapshotDigest: digest });
export const rejectVariationRequestSchema = z.strictObject({
  version,
  snapshotDigest: digest,
  reason,
});
export const cancelVariationRequestSchema = z.strictObject({ version, reason });
export const variationListQuerySchema = z.strictObject({
  status: variationStatusSchema.optional(),
});

const versionRef = z.strictObject({ id: uuid, versionNo: z.number().int().min(1) });
const variationTotalsSchema = z.strictObject({
  additionsMinor: minorUnitsSchema,
  omissionsMinor: minorUnitsSchema,
  netMinor: minorUnitsSchema,
});

export const variationSummarySchema = z.strictObject({
  id: uuid,
  number: z.string(),
  title: z.string(),
  status: variationStatusSchema,
  instruction: z.strictObject({ id: uuid, number: z.string(), subject: z.string() }),
  baseVersion: versionRef,
  resultVersion: versionRef.nullable(),
  totals: variationTotalsSchema,
  /** The effect on the grand total including VAT, as the new version would compute it. */
  grandTotalEffectMinor: minorUnitsSchema,
  lineCount: z.number().int().min(0),
  /** The base is no longer the newest approved version: approval is refused until rebased. */
  stale: z.boolean(),
  createdBy: person,
  createdAt: timestamp,
  submittedAt: timestamp.nullable(),
  decidedAt: timestamp.nullable(),
  version,
});

export const variationLineSchema = z.strictObject({
  id: uuid,
  lineNo: z.number().int().min(1),
  action: z.enum(VARIATION_LINE_ACTIONS),
  itemLineageId: uuid.nullable(),
  billLineageId: uuid.nullable(),
  sectionLineageId: uuid.nullable(),
  newSection: z.strictObject({ code: z.string().nullable(), title: z.string() }).nullable(),
  newLineageId: uuid.nullable(),
  ref: z.string().nullable(),
  description: z.string().nullable(),
  unit: z.enum(BQ_UNITS).nullable(),
  kind: z.enum(BQ_ITEM_KINDS).nullable(),
  quantity: z.string().nullable(),
  rate: z.string().nullable(),
  amountMinor: minorUnitsSchema.nullable(),
  note: z.string().nullable(),
  baseAmountMinor: minorUnitsSchema,
  newAmountMinor: minorUnitsSchema,
  deltaMinor: minorUnitsSchema,
  /**
   * Why the line cannot be submitted against the variation's current base (after a rebase a line
   * may no longer apply or may leave its item unchanged); null when it is fine.
   */
  issue: z.enum(VARIATION_LINE_ISSUES).nullable(),
  /** The base version's item (adjust/omit) or bill (add), for display. */
  target: z.strictObject({
    billNumber: z.string(),
    billTitle: z.string(),
    sectionTitle: z.string().nullable(),
    ref: z.string().nullable(),
    description: z.string().nullable(),
    unit: z.enum(BQ_UNITS).nullable(),
    unitRaw: z.string().nullable(),
    quantity: z.string().nullable(),
    rate: z.string().nullable(),
    amountSource: z.string().nullable(),
  }),
});

export const variationDetailSchema = variationSummarySchema.extend({
  description: z.string().nullable(),
  lines: z.array(variationLineSchema),
  baseTotals: totalsTriple,
  projected: totalsTriple,
  vatRatePercent: z.string(),
  latestVersion: versionRef,
  snapshot: z.strictObject({ digest, submittedAt: timestamp, submittedBy: person }).nullable(),
  decision: z
    .strictObject({
      outcome: z.enum(["approved", "rejected"]),
      by: person,
      at: timestamp,
      reason: z.string().nullable(),
    })
    .nullable(),
  cancelReason: z.string().nullable(),
  history: z.array(
    z.strictObject({
      from: variationStatusSchema.nullable(),
      to: variationStatusSchema,
      action: z.enum(["create", ...VARIATION_ACTIONS]),
      reason: z.string().nullable(),
      by: person,
      at: timestamp,
    }),
  ),
  permissions: z.strictObject({
    canEdit: z.boolean(),
    actions: z.array(variationActionSchema),
    /** Why approval is not available to the caller, when it is not. */
    approvalBlocker: z.enum(["permission", "maker", "stale", "status", "read-only"]).nullable(),
  }),
});

export const variationsResponseSchema = z.strictObject({
  variations: z.array(variationSummarySchema),
  permissions: z.strictObject({ canCreate: z.boolean(), canApprove: z.boolean() }),
  /** Why new variations cannot be raised yet (no approved baseline, read-only project). */
  createBlocker: z.enum(["no-baseline", "permission", "read-only"]).nullable(),
});
export const variationResponseSchema = z.strictObject({ variation: variationDetailSchema });

// Rate build-ups ----------------------------------------------------------------------------------

export const buildupUnitSchema = z.enum(BUILDUP_OUTPUT_UNITS);
/** e.g. CONC-C25: letters, digits, dot, slash, hyphen; stored in upper case. */
export const buildupCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9./-]{0,29}$/, "invalid_buildup_code");

export const buildupLineInputSchema = z.strictObject({
  kind: z.enum(BUILDUP_RESOURCE_KINDS),
  resourceName: text(1, 120),
  unit: text(1, 30),
  quantity: z
    .string()
    .trim()
    .regex(/^\d{1,9}(\.\d{1,6})?$/, "invalid_decimal")
    .refine((value) => Number(value) > 0, "quantity_positive"),
  wastePercent: z
    .string()
    .trim()
    .regex(/^\d{1,3}(\.\d{1,4})?$/, "invalid_decimal")
    .refine((value) => Number(value) <= BUILDUP_LIMITS.maxWastePercent, "waste_too_high")
    .nullable(),
  unitCostMinor: z.number().int().min(0).max(99_999_999_999).nullable(),
});

const buildupBody = {
  name: text(3, 150),
  unit: buildupUnitSchema,
  assumptions: optionalText(2_000, true).optional(),
  lines: z.array(buildupLineInputSchema).min(1).max(BUILDUP_LIMITS.maxLines),
};
export const createBuildupRequestSchema = z.strictObject({
  code: buildupCodeSchema,
  ...buildupBody,
});
/** Editing creates a new version; earlier versions (and links to them) never change. */
export const updateBuildupRequestSchema = z.strictObject({ ...buildupBody, version });

export const buildupLineSchema = z.strictObject({
  lineNo: z.number().int().min(1),
  kind: z.enum(BUILDUP_RESOURCE_KINDS),
  resourceName: z.string(),
  unit: z.string(),
  quantity: z.string(),
  wastePercent: z.string().nullable(),
  unitCostMinor: minorUnitsSchema.nullable(),
  amountMinor: minorUnitsSchema.nullable(),
});
export const buildupVersionSchema = z.strictObject({
  id: uuid,
  versionNo: z.number().int().min(1),
  name: z.string(),
  unit: buildupUnitSchema,
  assumptions: z.string().nullable(),
  rateMinor: minorUnitsSchema.nullable(),
  pricedMinor: minorUnitsSchema,
  unpricedLines: z.number().int().min(0),
  byKind: z.strictObject({
    material: minorUnitsSchema,
    labour: minorUnitsSchema,
    plant: minorUnitsSchema,
  }),
  lines: z.array(buildupLineSchema),
  createdAt: timestamp,
  createdBy: person,
});
export const buildupSummarySchema = z.strictObject({
  id: uuid,
  code: z.string(),
  name: z.string(),
  unit: buildupUnitSchema,
  currentVersionId: uuid,
  currentVersionNo: z.number().int().min(1),
  rateMinor: minorUnitsSchema.nullable(),
  unpricedLines: z.number().int().min(0),
  lineCount: z.number().int().min(0),
  linkCount: z.number().int().min(0),
  updatedAt: timestamp,
  version,
});
export const buildupsResponseSchema = z.strictObject({
  buildups: z.array(buildupSummarySchema),
  permissions: z.strictObject({ canEdit: z.boolean() }),
});
export const buildupResponseSchema = z.strictObject({
  buildup: buildupSummarySchema,
  current: buildupVersionSchema,
  versions: z.array(
    z.strictObject({
      id: uuid,
      versionNo: z.number().int().min(1),
      name: z.string(),
      rateMinor: minorUnitsSchema.nullable(),
      createdAt: timestamp,
      createdBy: person,
    }),
  ),
  permissions: z.strictObject({ canEdit: z.boolean() }),
});
export const buildupVersionResponseSchema = z.strictObject({ version: buildupVersionSchema });

export const linkBuildupRequestSchema = z.strictObject({ buildupVersionId: uuid });
export const bqItemLinkResponseSchema = z.strictObject({
  link: z
    .strictObject({
      itemLineageId: uuid,
      buildupId: uuid,
      buildupVersionId: uuid,
      code: z.string(),
      name: z.string(),
      versionNo: z.number().int().min(1),
      unit: buildupUnitSchema,
      rateMinor: minorUnitsSchema.nullable(),
      linkedAt: timestamp,
      linkedBy: person,
    })
    .nullable(),
});

export type BqVersionsResponse = z.infer<typeof bqVersionsResponseSchema>;
export type BqCompareResponse = z.infer<typeof bqCompareResponseSchema>;
export type BqItemDifferenceWire = z.infer<typeof bqItemDifferenceSchema>;
export type BqContractSumResponse = z.infer<typeof bqContractSumResponseSchema>;
export type CreateInstructionRequest = z.infer<typeof createInstructionRequestSchema>;
export type UpdateInstructionRequest = z.infer<typeof updateInstructionRequestSchema>;
export type Instruction = z.infer<typeof instructionSchema>;
export type InstructionsResponse = z.infer<typeof instructionsResponseSchema>;
export type VariationLineInputWire = z.infer<typeof variationLineInputSchema>;
export type CreateVariationRequest = z.infer<typeof createVariationRequestSchema>;
export type UpdateVariationRequest = z.infer<typeof updateVariationRequestSchema>;
export type SaveVariationLinesRequest = z.infer<typeof saveVariationLinesRequestSchema>;
export type VariationSummary = z.infer<typeof variationSummarySchema>;
export type VariationLine = z.infer<typeof variationLineSchema>;
export type VariationDetail = z.infer<typeof variationDetailSchema>;
export type VariationsResponse = z.infer<typeof variationsResponseSchema>;
export type BuildupLineInputWire = z.infer<typeof buildupLineInputSchema>;
export type CreateBuildupRequest = z.infer<typeof createBuildupRequestSchema>;
export type UpdateBuildupRequest = z.infer<typeof updateBuildupRequestSchema>;
export type BuildupSummary = z.infer<typeof buildupSummarySchema>;
export type BuildupVersion = z.infer<typeof buildupVersionSchema>;
export type BuildupResponse = z.infer<typeof buildupResponseSchema>;
export type BuildupsResponse = z.infer<typeof buildupsResponseSchema>;
export type BqItemLinkResponse = z.infer<typeof bqItemLinkResponseSchema>;
