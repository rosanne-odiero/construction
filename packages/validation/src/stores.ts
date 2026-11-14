import {
  STOCK_ENTRY_KINDS,
  STOCK_MOVEMENT_KINDS,
  STOCK_MOVEMENT_STATUSES,
  STOCK_TAKE_STATUSES,
  STORE_SOURCES,
  STORES_LIMITS,
  TRANSFER_STATUSES,
  VARIANCE_STATES,
  WASTAGE_REASONS,
} from "@pm-buddy/types";
import { z } from "zod";
import { pageInfoSchema } from "./api.js";
import { positiveQuantitySchema, quantitySchema, unitCodeSchema } from "./procurement.js";

/**
 * D5.3 stores contracts: stores per site, the append-only stock ledger and balances (base units,
 * weighted average value), issues to a BQ item or gang, returns, wastage, inter-site transfers,
 * stock takes with independent approval, reorder levels, theoretical-versus-actual consumption
 * variance and build-up line → material mappings (progress measurements: valuations.ts). Movement,
 * transfer and count requests are offline-ready: the client chooses the record's ID and sends an
 * `Idempotency-Key`; a replay returns the original result. Requests are strict and never carry a
 * tenant, recorder, approver, cost or value the server computes. Quantities are decimal strings
 * (six places); values are KES minor units (`*ValueMinor` strings keep six decimals, `*Minor`
 * numbers are rounded to whole cents for display).
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();
const version = z.number().int().min(1).max(2_147_483_647);
const person = z.strictObject({ id: uuid, displayName: z.string() });
const minor = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const listLimit = z.coerce.number().int().min(1).max(200).default(STORES_LIMITS.pageSize);
/** A signed decimal with at most six places, as stored in the ledger. */
const signedDecimal = z.string().regex(/^-?\d{1,24}(?:\.\d{1,6})?$/, "invalid_decimal");
/** A non-negative ratio "numerator/denominator" (exact conversion factors). */
const ratioText = z.string().regex(/^\d+\/\d+$/, "invalid_ratio");

function printable(value: string, multiline: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (multiline && (code === 9 || code === 10 || code === 13)) continue;
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
const text = (min: number, max: number, multiline = false) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => printable(value, multiline), "control_characters");
const optionalText = (max: number, multiline = false) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => printable(value, multiline), "control_characters")
    .transform((value) => (value === "" ? null : value))
    .nullable();

const projectRef = z.strictObject({ id: uuid, code: z.string(), name: z.string() });
const siteRef = z.strictObject({ id: uuid, name: z.string() });
const materialRef = z.strictObject({
  id: uuid,
  code: z.string(),
  name: z.string(),
  baseUnit: z.string(),
});
export const storeRefSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  project: projectRef,
  site: siteRef,
});
export type StoreRef = z.infer<typeof storeRefSchema>;
const recordRef = z.strictObject({ id: uuid, number: z.string(), status: z.string() });
/** A BQ item by lineage (stable across versions) with the version it was taken from. */
export const storesBqItemSchema = z.strictObject({
  versionId: uuid,
  lineageId: uuid,
  ref: z.string().nullable(),
  description: z.string(),
  unit: z.string().nullable(),
});
export type StoresBqItem = z.infer<typeof storesBqItemSchema>;
const gangRef = z.strictObject({ id: uuid, name: z.string() });

const lineUniqueness =
  (key: "materialId" | "issueLineId" | "lineId") =>
  (lines: readonly Record<string, unknown>[], ctx: z.RefinementCtx) => {
    const ids = lines.map((line) => line[key]);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["lines"], message: "duplicate_line" });
  };

// Stores and balances ------------------------------------------------------------------------

export const storeSummarySchema = z.strictObject({
  id: uuid,
  name: z.string(),
  project: projectRef,
  site: siteRef,
  storekeeper: person.nullable(),
  /** Stock value at weighted average cost, rounded to whole minor units. */
  valueMinor: minor,
  /** Materials with stock on hand. */
  materialCount: z.number().int().min(0),
  lowStockCount: z.number().int().min(0),
  inTransitIn: z.number().int().min(0),
  inTransitOut: z.number().int().min(0),
  lastMovementAt: timestamp.nullable(),
  version,
});
export type StoreSummary = z.infer<typeof storeSummarySchema>;

export const lowStockItemSchema = z.strictObject({
  store: z.strictObject({ id: uuid, name: z.string() }),
  material: materialRef,
  quantity: z.string(),
  reorderLevel: z.string(),
});
export type LowStockItem = z.infer<typeof lowStockItemSchema>;

export const storesResponseSchema = z.strictObject({
  stores: z.array(storeSummarySchema),
  /** Sites of visible projects without a store yet (one is created on demand or explicitly). */
  sitesWithoutStore: z.array(
    z.strictObject({ project: projectRef, site: siteRef, canCreate: z.boolean() }),
  ),
  lowStock: z.array(lowStockItemSchema),
  totalValueMinor: minor,
});
export type StoresResponse = z.infer<typeof storesResponseSchema>;

export const createStoreRequestSchema = z.strictObject({
  siteId: uuid,
  /** Defaults to "<site> store". */
  name: text(2, 120).optional(),
  storekeeperUserId: uuid.nullable().default(null),
});
export type CreateStoreRequest = z.input<typeof createStoreRequestSchema>;
export const updateStoreRequestSchema = z.strictObject({
  version,
  name: text(2, 120),
  storekeeperUserId: uuid.nullable(),
});
export type UpdateStoreRequest = z.infer<typeof updateStoreRequestSchema>;

export const stockBalanceSchema = z.strictObject({
  material: materialRef,
  quantity: z.string(),
  /** Value ÷ quantity, six decimals; null when nothing is on hand. */
  averageUnitCostMinor: z.string().nullable(),
  valueMinor: minor,
  reorderLevel: z.string().nullable(),
  low: z.boolean(),
  lastMovementAt: timestamp.nullable(),
});
export type StockBalance = z.infer<typeof stockBalanceSchema>;

export const inTransitSchema = z.strictObject({
  transfer: recordRef,
  direction: z.enum(["in", "out"]),
  otherStore: storeRefSchema,
  dispatchedAt: timestamp,
  valueMinor: minor,
  lines: z.array(z.strictObject({ material: materialRef, baseQuantity: z.string() })),
});
export type InTransit = z.infer<typeof inTransitSchema>;

export const storeDetailResponseSchema = z.strictObject({
  store: storeSummarySchema,
  balances: z.array(stockBalanceSchema),
  inTransit: z.array(inTransitSchema),
  openStockTake: recordRef.nullable(),
  /** Members who may keep this store (stores.manage on the project); only for editors. */
  storekeeperCandidates: z.array(person),
  permissions: z.strictObject({
    canIssue: z.boolean(),
    canWaste: z.boolean(),
    canTransfer: z.boolean(),
    canCount: z.boolean(),
    canEditReorderLevels: z.boolean(),
    canEdit: z.boolean(),
  }),
});
export type StoreDetailResponse = z.infer<typeof storeDetailResponseSchema>;

export const reorderLevelsRequestSchema = z
  .strictObject({
    levels: z
      .array(
        z.strictObject({
          materialId: uuid,
          /** In the material's base unit; null removes the level. */
          reorderLevel: quantitySchema.nullable(),
        }),
      )
      .min(1)
      .max(200),
  })
  .superRefine((value, ctx) => lineUniqueness("materialId")(value.levels, ctx));
export type ReorderLevelsRequest = z.infer<typeof reorderLevelsRequestSchema>;

// Ledger ------------------------------------------------------------------------------------

export const ledgerQuerySchema = z.object({
  materialId: uuid.optional(),
  kind: z.enum(STOCK_ENTRY_KINDS).optional(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

export const ledgerEntrySchema = z.strictObject({
  id: uuid,
  seq: z.number().int().min(1),
  kind: z.enum(STOCK_ENTRY_KINDS),
  material: materialRef,
  /** Signed, in the material's base unit. */
  quantity: signedDecimal,
  unitCostMinor: signedDecimal,
  valueMinor: signedDecimal,
  balanceQuantity: signedDecimal,
  balanceValueMinor: signedDecimal,
  businessDate: calendarDate,
  recordedAt: timestamp,
  recordedBy: person,
  source: z.strictObject({
    type: z.enum(["grn", "movement", "transfer", "stock_take"]),
    id: uuid,
    number: z.string(),
  }),
  bqItem: storesBqItemSchema.nullable(),
  gang: gangRef.nullable(),
  /** The entry this one reverses (a correction), if any. */
  reversesEntryId: uuid.nullable(),
});
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
export const ledgerResponseSchema = z.strictObject({
  store: z.strictObject({ id: uuid, name: z.string() }),
  entries: z.array(ledgerEntrySchema),
  page: pageInfoSchema,
});
export type LedgerResponse = z.infer<typeof ledgerResponseSchema>;

// Issue options -----------------------------------------------------------------------------

export const issueOptionsQuerySchema = z.object({
  /** Matches an item's reference or description (case-insensitive). */
  bqSearch: z.string().trim().max(100).optional(),
});
export const issueOptionsResponseSchema = z.strictObject({
  store: storeRefSchema,
  /**
   * Measured items of the project's newest approved BQ version, in bill order (empty before the
   * baseline): the first STORES_LIMITS.issueBqItems, or those matching `bqSearch`.
   */
  bqItems: z.array(storesBqItemSchema),
  /** More items match than are listed: search to find the others. */
  bqItemsTruncated: z.boolean(),
  gangs: z.array(gangRef),
  /** Materials on hand in this store. */
  stock: z.array(z.strictObject({ material: materialRef, quantity: z.string() })),
});
export type IssueOptionsResponse = z.infer<typeof issueOptionsResponseSchema>;

// Movements: issues, returns and wastage ----------------------------------------------------

export const movementLineInputSchema = z.strictObject({
  materialId: uuid,
  quantity: positiveQuantitySchema,
  unit: unitCodeSchema,
});
const movementLines = z
  .array(movementLineInputSchema)
  .min(1)
  .max(STORES_LIMITS.linesPerDocument)
  .superRefine((lines, ctx) => lineUniqueness("materialId")(lines, ctx));

const offlineFields = {
  /** Client-generated, kept through offline retries. */
  id: uuid,
  /** The device's clock (a claim); the server's receipt time is authoritative. */
  capturedAt: timestamp,
  notes: optionalText(1000, true).optional(),
  source: z.enum(STORE_SOURCES).default("web"),
};

/** An issue to a BQ item (by lineage, approved BQ only) and/or a gang of the store's project. */
export const createIssueRequestSchema = z
  .strictObject({
    ...offlineFields,
    storeId: uuid,
    bqItemLineageId: uuid.nullable().default(null),
    gangId: uuid.nullable().default(null),
    issuedToName: text(2, 100),
    lines: movementLines,
  })
  .superRefine((value, ctx) => {
    if (!value.bqItemLineageId && !value.gangId)
      ctx.addIssue({ code: "custom", path: ["bqItemLineageId"], message: "issue_target_required" });
  });
export type CreateIssueRequest = z.input<typeof createIssueRequestSchema>;
export type ParsedIssueRequest = z.infer<typeof createIssueRequestSchema>;

/** A return of issued material into the same store; never more than is still outstanding. */
export const createReturnRequestSchema = z
  .strictObject({
    ...offlineFields,
    issueId: uuid,
    lines: z
      .array(
        z.strictObject({
          issueLineId: uuid,
          quantity: positiveQuantitySchema,
          /** Defaults to the issue line's unit. */
          unit: unitCodeSchema.nullable().default(null),
        }),
      )
      .min(1)
      .max(STORES_LIMITS.linesPerDocument),
  })
  .superRefine((value, ctx) => lineUniqueness("issueLineId")(value.lines, ctx));
export type CreateReturnRequest = z.input<typeof createReturnRequestSchema>;
export type ParsedReturnRequest = z.infer<typeof createReturnRequestSchema>;

export const createWastageRequestSchema = z.strictObject({
  ...offlineFields,
  storeId: uuid,
  reason: z.enum(WASTAGE_REASONS),
  /** What happened (required: wastage is reviewed). */
  notes: text(3, 1000, true),
  lines: movementLines,
});
export type CreateWastageRequest = z.input<typeof createWastageRequestSchema>;
export type ParsedWastageRequest = z.infer<typeof createWastageRequestSchema>;

export const reverseRequestSchema = z.strictObject({ reason: text(3, 500) });
export type ReverseRequest = z.infer<typeof reverseRequestSchema>;

export const movementLineSchema = z.strictObject({
  id: uuid,
  lineNo: z.number().int().min(1),
  material: materialRef,
  quantity: z.string(),
  unit: z.string(),
  baseQuantity: z.string(),
  /** The value moved (positive), at the unit cost below. */
  valueMinor: signedDecimal,
  unitCostMinor: signedDecimal,
  returnOfLineId: uuid.nullable(),
  /** Issue lines: returned so far (not counting reversed returns) and still returnable. */
  returnedBaseQuantity: z.string().nullable(),
  returnableBaseQuantity: z.string().nullable(),
});
export type MovementLine = z.infer<typeof movementLineSchema>;

export const movementSchema = z.strictObject({
  id: uuid,
  number: z.string(),
  kind: z.enum(STOCK_MOVEMENT_KINDS),
  status: z.enum(STOCK_MOVEMENT_STATUSES),
  store: storeRefSchema,
  bqItem: storesBqItemSchema.nullable(),
  gang: gangRef.nullable(),
  issuedToName: z.string().nullable(),
  returnOf: recordRef.nullable(),
  wastageReason: z.enum(WASTAGE_REASONS).nullable(),
  notes: z.string().nullable(),
  capturedAt: timestamp,
  recordedAt: timestamp,
  businessDate: calendarDate,
  recordedBy: person,
  source: z.enum(STORE_SOURCES),
  reversedAt: timestamp.nullable(),
  reversedBy: person.nullable(),
  reversalReason: z.string().nullable(),
  totalValueMinor: minor,
  lineCount: z.number().int().min(1),
  lines: z.array(movementLineSchema),
  /** Returns recorded against this issue. */
  returns: z.array(recordRef),
});
export type Movement = z.infer<typeof movementSchema>;
export const movementResponseSchema = z.strictObject({
  movement: movementSchema,
  replayed: z.boolean(),
  permissions: z.strictObject({ canReverse: z.boolean(), canReturn: z.boolean() }),
});
export type MovementResponse = z.infer<typeof movementResponseSchema>;
export const movementListQuerySchema = z.object({
  storeId: uuid.optional(),
  kind: z.enum(STOCK_MOVEMENT_KINDS).optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export const movementsResponseSchema = z.strictObject({
  movements: z.array(movementSchema.omit({ lines: true, returns: true })),
  page: pageInfoSchema,
});
export type MovementsResponse = z.infer<typeof movementsResponseSchema>;

// Transfers ---------------------------------------------------------------------------------

export const dispatchTransferRequestSchema = z
  .strictObject({
    ...offlineFields,
    fromStoreId: uuid,
    toStoreId: uuid,
    lines: movementLines,
  })
  .superRefine((value, ctx) => {
    if (value.fromStoreId === value.toStoreId)
      ctx.addIssue({ code: "custom", path: ["toStoreId"], message: "same_store" });
  });
export type DispatchTransferRequest = z.input<typeof dispatchTransferRequestSchema>;
export type ParsedDispatchTransferRequest = z.infer<typeof dispatchTransferRequestSchema>;

/** What arrived, per line, in the material's base unit; a difference needs a reason. */
export const receiveTransferRequestSchema = z
  .strictObject({
    capturedAt: timestamp,
    notes: optionalText(1000, true).optional(),
    lines: z
      .array(
        z.strictObject({
          lineId: uuid,
          receivedQuantity: quantitySchema,
          differenceReason: optionalText(300).optional(),
        }),
      )
      .min(1)
      .max(STORES_LIMITS.linesPerDocument),
  })
  .superRefine((value, ctx) => lineUniqueness("lineId")(value.lines, ctx));
export type ReceiveTransferRequest = z.input<typeof receiveTransferRequestSchema>;
export type ParsedReceiveTransferRequest = z.infer<typeof receiveTransferRequestSchema>;

export const transferDecisionRequestSchema = z.strictObject({ version, reason: text(3, 500) });
export type TransferDecisionRequest = z.infer<typeof transferDecisionRequestSchema>;

export const transferLineSchema = z.strictObject({
  id: uuid,
  lineNo: z.number().int().min(1),
  material: materialRef,
  quantity: z.string(),
  unit: z.string(),
  baseQuantity: z.string(),
  unitCostMinor: signedDecimal,
  dispatchedValueMinor: signedDecimal,
  receivedBaseQuantity: z.string().nullable(),
  /** received − dispatched (negative: short). */
  differenceBaseQuantity: signedDecimal.nullable(),
  differenceReason: z.string().nullable(),
});
export type TransferLine = z.infer<typeof transferLineSchema>;

export const transferSchema = z.strictObject({
  id: uuid,
  number: z.string(),
  status: z.enum(TRANSFER_STATUSES),
  fromStore: storeRefSchema,
  toStore: storeRefSchema,
  capturedAt: timestamp,
  dispatchedAt: timestamp,
  dispatchedBy: person,
  dispatchNotes: z.string().nullable(),
  receivedAt: timestamp.nullable(),
  receivedBy: person.nullable(),
  receiveNotes: z.string().nullable(),
  resolvedAt: timestamp.nullable(),
  resolvedBy: person.nullable(),
  resolutionNote: z.string().nullable(),
  cancelledAt: timestamp.nullable(),
  cancelledBy: person.nullable(),
  cancelReason: z.string().nullable(),
  source: z.enum(STORE_SOURCES),
  version,
  dispatchedValueMinor: minor,
  /** Value of what was dispatched but did not arrive (disputed or resolved transfers). */
  transitLossValueMinor: minor.nullable(),
  lineCount: z.number().int().min(1),
  lines: z.array(transferLineSchema),
});
export type Transfer = z.infer<typeof transferSchema>;
export const transferResponseSchema = z.strictObject({
  transfer: transferSchema,
  replayed: z.boolean(),
  permissions: z.strictObject({
    canReceive: z.boolean(),
    canResolve: z.boolean(),
    canCancel: z.boolean(),
  }),
});
export type TransferResponse = z.infer<typeof transferResponseSchema>;
export const transferListQuerySchema = z.object({
  storeId: uuid.optional(),
  status: z.enum(TRANSFER_STATUSES).optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export const transfersResponseSchema = z.strictObject({
  transfers: z.array(transferSchema.omit({ lines: true })),
  page: pageInfoSchema,
});
export type TransfersResponse = z.infer<typeof transfersResponseSchema>;
/** Stores a transfer can be sent to (active stores of visible projects, other than the source). */
export const transferTargetsResponseSchema = z.strictObject({ stores: z.array(storeRefSchema) });

// Stock takes -------------------------------------------------------------------------------

export const createStockTakeRequestSchema = z.strictObject({
  storeId: uuid,
  /** Defaults to every material the store holds or has a reorder level for. */
  materialIds: z.array(uuid).max(STORES_LIMITS.stockTakeLines).optional(),
  notes: optionalText(1000, true).optional(),
});
export type CreateStockTakeRequest = z.input<typeof createStockTakeRequestSchema>;

/** A batch of counts (offline-ready: each count has a client ID; Idempotency-Key header). */
export const recordCountsRequestSchema = z
  .strictObject({
    capturedAt: timestamp,
    counts: z
      .array(
        z.strictObject({
          id: uuid,
          lineId: uuid,
          countedQuantity: quantitySchema,
        }),
      )
      .min(1)
      .max(STORES_LIMITS.countsPerBatch),
  })
  .superRefine((value, ctx) => {
    const lines = value.counts.map((count) => count.lineId);
    if (new Set(lines).size !== lines.length)
      ctx.addIssue({ code: "custom", path: ["counts"], message: "duplicate_line" });
  });
export type RecordCountsRequest = z.input<typeof recordCountsRequestSchema>;
export type ParsedRecordCountsRequest = z.infer<typeof recordCountsRequestSchema>;

export const stockTakeVersionRequestSchema = z.strictObject({ version });
export const stockTakeReasonRequestSchema = z.strictObject({ version, reason: text(3, 500) });

export const stockTakeLineSchema = z.strictObject({
  id: uuid,
  lineNo: z.number().int().min(1),
  material: materialRef,
  /** System quantity when the sheet was started. */
  snapshotQuantity: z.string(),
  countedQuantity: z.string().nullable(),
  /** System quantity when this line was counted (snapshot + movements since). */
  expectedQuantity: z.string().nullable(),
  movementsSinceSnapshot: signedDecimal.nullable(),
  /** counted − expected. */
  varianceQuantity: signedDecimal.nullable(),
  /** The variance at the current average cost (an estimate until approval posts it). */
  varianceValueMinor: minor.nullable(),
  countedBy: person.nullable(),
  countedAt: timestamp.nullable(),
  adjustmentEntryId: uuid.nullable(),
});
export type StockTakeLine = z.infer<typeof stockTakeLineSchema>;

export const stockTakeSchema = z.strictObject({
  id: uuid,
  number: z.string(),
  status: z.enum(STOCK_TAKE_STATUSES),
  store: storeRefSchema,
  notes: z.string().nullable(),
  createdAt: timestamp,
  createdBy: person,
  submittedAt: timestamp.nullable(),
  submittedBy: person.nullable(),
  approvedAt: timestamp.nullable(),
  approvedBy: person.nullable(),
  returnReason: z.string().nullable(),
  cancelledAt: timestamp.nullable(),
  cancelledBy: person.nullable(),
  cancelReason: z.string().nullable(),
  /** Everyone who created, counted or submitted (none of them may approve). */
  contributors: z.array(person),
  version,
  lineCount: z.number().int().min(1),
  countedCount: z.number().int().min(0),
  varianceCount: z.number().int().min(0),
  lines: z.array(stockTakeLineSchema),
});
export type StockTake = z.infer<typeof stockTakeSchema>;
export const stockTakeResponseSchema = z.strictObject({
  stockTake: stockTakeSchema,
  replayed: z.boolean(),
  /**
   * Materials on hand or with a reorder level in this store that this open count does not cover
   * (a store with more than STORES_LIMITS.stockTakeLines is counted in turns; 0 once decided).
   */
  uncoveredMaterials: z.number().int().min(0),
  permissions: z.strictObject({
    canCount: z.boolean(),
    canSubmit: z.boolean(),
    canApprove: z.boolean(),
    canReturn: z.boolean(),
    canCancel: z.boolean(),
  }),
});
export type StockTakeResponse = z.infer<typeof stockTakeResponseSchema>;
export const stockTakeListQuerySchema = z.object({
  storeId: uuid.optional(),
  status: z.enum(STOCK_TAKE_STATUSES).optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export const stockTakesResponseSchema = z.strictObject({
  stockTakes: z.array(stockTakeSchema.omit({ lines: true })),
  page: pageInfoSchema,
});
export type StockTakesResponse = z.infer<typeof stockTakesResponseSchema>;

// Settings ----------------------------------------------------------------------------------

export const storesSettingsResponseSchema = z.strictObject({
  settings: z.strictObject({
    /** `stores.consumption_variance_percent` (default 10). */
    varianceThresholdPercent: z.string(),
    /** Negative stock is never allowed (D-50); shown for clarity, not configurable. */
    negativeStockAllowed: z.literal(false),
    version: z.number().int().min(1).nullable(),
    updatedAt: timestamp.nullable(),
  }),
  permissions: z.strictObject({ canEdit: z.boolean() }),
});
export type StoresSettingsResponse = z.infer<typeof storesSettingsResponseSchema>;
export const updateStoresSettingsRequestSchema = z.strictObject({
  version: version.nullable(),
  varianceThresholdPercent: z
    .string()
    .trim()
    .regex(/^\d{1,4}(?:\.\d{1,4})?$/, "invalid_percent")
    .refine((value) => Number(value) <= STORES_LIMITS.maxVariancePercent, "percent_too_large"),
});
export type UpdateStoresSettingsRequest = z.infer<typeof updateStoresSettingsRequestSchema>;

// Consumption variance ----------------------------------------------------------------------

export const varianceQuerySchema = z.object({
  projectId: uuid.optional(),
  state: z.enum(VARIANCE_STATES).optional(),
});

export const varianceRowSchema = z.strictObject({
  project: projectRef,
  bqItem: storesBqItemSchema,
  material: materialRef.nullable(),
  state: z.enum(VARIANCE_STATES),
  measurement: z
    .strictObject({
      id: uuid,
      quantityToDate: z.string(),
      measuredOn: calendarDate,
      measuredBy: person,
    })
    .nullable(),
  buildup: z
    .strictObject({
      id: uuid,
      code: z.string(),
      versionNo: z.number().int().min(1),
      lineNo: z.number().int().min(1),
      resourceName: z.string(),
      unit: z.string(),
      quantityPerUnit: z.string(),
      wastePercent: z.string().nullable(),
    })
    .nullable(),
  /** The build-up line's catalogue unit and how many base units make one of it. */
  mapping: z
    .strictObject({ unit: z.string(), basePerUnit: ratioText, basePerUnitDecimal: z.string() })
    .nullable(),
  theoreticalQuantity: z.string().nullable(),
  /** theoretical × (1 + threshold): the most that can be issued without an alert. */
  limitQuantity: z.string().nullable(),
  issuedQuantity: z.string(),
  returnedQuantity: z.string(),
  actualQuantity: z.string(),
  varianceQuantity: signedDecimal.nullable(),
  variancePercent: z.string().nullable(),
  /** Whether the caller may record a measurement for this item (bq.edit on the project). */
  canMeasure: z.boolean(),
});
export type VarianceRow = z.infer<typeof varianceRowSchema>;

export const varianceResponseSchema = z.strictObject({
  thresholdPercent: z.string(),
  generatedOn: calendarDate,
  rows: z.array(varianceRowSchema),
  counts: z.strictObject({
    alert: z.number().int().min(0),
    within: z.number().int().min(0),
    unavailable: z.number().int().min(0),
  }),
});
export type VarianceResponse = z.infer<typeof varianceResponseSchema>;

// Build-up line → catalogue material mappings ----------------------------------------------

export const buildupMaterialMappingRequestSchema = z.strictObject({
  materialId: uuid,
  /** The catalogue unit the line's quantity is in (e.g. bag_50kg for "bag (50 kg)"). */
  unit: unitCodeSchema,
});
export type BuildupMaterialMappingRequest = z.infer<typeof buildupMaterialMappingRequestSchema>;

export const buildupMaterialLineSchema = z.strictObject({
  lineId: uuid,
  lineNo: z.number().int().min(1),
  resourceName: z.string(),
  unit: z.string(),
  quantity: z.string(),
  wastePercent: z.string().nullable(),
  mapping: z
    .strictObject({
      id: uuid,
      material: materialRef,
      unit: z.string(),
      basePerUnit: ratioText,
      basePerUnitDecimal: z.string(),
      mappedAt: timestamp,
      mappedBy: person,
    })
    .nullable(),
});
export type BuildupMaterialLine = z.infer<typeof buildupMaterialLineSchema>;
export const buildupMaterialsResponseSchema = z.strictObject({
  buildup: z.strictObject({ id: uuid, code: z.string(), name: z.string(), unit: z.string() }),
  versionNo: z.number().int().min(1),
  lines: z.array(buildupMaterialLineSchema),
  permissions: z.strictObject({ canMap: z.boolean() }),
});
export type BuildupMaterialsResponse = z.infer<typeof buildupMaterialsResponseSchema>;
