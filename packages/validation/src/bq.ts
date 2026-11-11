import {
  BQ_AMOUNT_SOURCES,
  BQ_BILL_KINDS,
  BQ_FIELDS,
  BQ_FILE_TYPES,
  BQ_IMPORT_FAILURES,
  BQ_IMPORT_LIMITS,
  BQ_IMPORT_STATUSES,
  BQ_ISSUE_CODES,
  BQ_ISSUE_SEVERITIES,
  BQ_ITEM_KINDS,
  BQ_ROW_ACTIONS,
  BQ_SCAN_STATUSES,
  BQ_SHEET_KINDS,
  BQ_UNITS,
  BQ_VERSION_STATUSES,
  type BqField,
  type BqIssueCode,
} from "@pm-buddy/types";
import { z } from "zod";
import { decimalStringSchema, minorUnitsSchema } from "./primitives.js";

/**
 * BQ import, viewer and export contracts (D2.2). Request schemas are strict (unknown fields are
 * refused, so a body can never carry a tenant, project or storage key) and response schemas are
 * strict (the web never trusts an unexpected shape). Amounts are KES minor units; quantities and
 * rates are decimal strings.
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const version = z.number().int().min(1).max(2_147_483_647);
const excelRow = z
  .number()
  .int()
  .min(1)
  .max(BQ_IMPORT_LIMITS.maxRowsPerSheet + 1);
const sheetIndex = z
  .number()
  .int()
  .min(0)
  .max(BQ_IMPORT_LIMITS.maxSheets - 1);
const column = z
  .number()
  .int()
  .min(0)
  .max(BQ_IMPORT_LIMITS.maxColumnsPerSheet - 1);
const person = z.strictObject({ id: uuid, displayName: z.string() });
const reasonText = z.string().trim().min(3).max(500);

export const bqImportStatusSchema = z.enum(BQ_IMPORT_STATUSES);
export const bqFieldSchema = z.enum(BQ_FIELDS);
export const bqIssueCodeSchema = z.enum(BQ_ISSUE_CODES as [BqIssueCode, ...BqIssueCode[]]);
export const bqRowActionSchema = z.enum(BQ_ROW_ACTIONS);

export const bqColumnMapSchema = z.strictObject(
  Object.fromEntries(BQ_FIELDS.map((field) => [field, column.optional()])) as Record<
    BqField,
    z.ZodOptional<typeof column>
  >,
);

/**
 * A template's columns, as offsets from the first titled header cell. A column left of that cell
 * (a reference column with a blank title is common) has a negative offset.
 */
const templateOffset = z
  .number()
  .int()
  .min(-(BQ_IMPORT_LIMITS.maxColumnsPerSheet - 1))
  .max(BQ_IMPORT_LIMITS.maxColumnsPerSheet - 1);
export const bqTemplateColumnsSchema = z.strictObject(
  Object.fromEntries(BQ_FIELDS.map((field) => [field, templateOffset.optional()])) as Record<
    BqField,
    z.ZodOptional<typeof templateOffset>
  >,
);
/** Most data starts within a few rows of the header; the database allows at most 20. */
export const BQ_TEMPLATE_MAX_DATA_OFFSET = 20;

/** One worksheet's confirmed mapping. Rows are 1-based Excel rows; columns are 0-based (A = 0). */
export const bqSheetMappingSchema = z
  .strictObject({
    sheetIndex,
    include: z.boolean(),
    role: z.enum(["bill", "summary"]),
    billNumber: z.string().trim().max(20),
    billTitle: z.string().trim().max(200),
    headerRow: excelRow,
    firstDataRow: excelRow,
    lastDataRow: excelRow,
    columns: bqColumnMapSchema,
  })
  .superRefine((sheet, ctx) => {
    if (sheet.lastDataRow < sheet.firstDataRow)
      ctx.addIssue({ code: "custom", path: ["lastDataRow"], message: "last_before_first" });
    if (!sheet.include || sheet.role !== "bill") return;
    if (!/^[A-Za-z0-9][A-Za-z0-9./-]{0,19}$/.test(sheet.billNumber))
      ctx.addIssue({ code: "custom", path: ["billNumber"], message: "invalid_bill_number" });
    if (!sheet.billTitle)
      ctx.addIssue({ code: "custom", path: ["billTitle"], message: "bill_title_required" });
    if (sheet.columns.description === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["columns", "description"],
        message: "description_required",
      });
    const used = Object.values(sheet.columns).filter((value) => value !== undefined);
    if (new Set(used).size !== used.length)
      ctx.addIssue({ code: "custom", path: ["columns"], message: "column_mapped_twice" });
    if (
      sheet.columns.amount === undefined &&
      (sheet.columns.quantity === undefined || sheet.columns.rate === undefined)
    )
      ctx.addIssue({
        code: "custom",
        path: ["columns"],
        message: "amount_or_quantity_rate_required",
      });
  });

export const bqMappingSchema = z
  .strictObject({
    sheets: z.array(bqSheetMappingSchema).min(1).max(BQ_IMPORT_LIMITS.maxSheets),
    templateId: uuid.nullable(),
  })
  .superRefine((mapping, ctx) => {
    const indexes = mapping.sheets.map((sheet) => sheet.sheetIndex);
    if (new Set(indexes).size !== indexes.length)
      ctx.addIssue({ code: "custom", path: ["sheets"], message: "sheet_listed_twice" });
    if (!mapping.sheets.some((sheet) => sheet.include && sheet.role === "bill"))
      ctx.addIssue({ code: "custom", path: ["sheets"], message: "no_bill_sheet" });
  });

export const saveBqMappingRequestSchema = z.strictObject({ mapping: bqMappingSchema, version });

export const bqResolutionsSchema = z.strictObject({
  rows: z
    .array(
      z.strictObject({
        sheetIndex,
        row: excelRow,
        action: bqRowActionSchema,
        reason: reasonText.nullable().optional(),
      }),
    )
    .max(5_000),
  accepted: z.array(z.strictObject({ code: bqIssueCodeSchema, reason: reasonText })).max(60),
});

export const saveBqResolutionsRequestSchema = z.strictObject({
  resolutions: bqResolutionsSchema,
  version,
});
export const bqImportVersionRequestSchema = z.strictObject({ version });
export const applyBqTemplateRequestSchema = z.strictObject({ templateId: uuid, version });

export const bqIssueSchema = z.strictObject({
  code: bqIssueCodeSchema,
  severity: z.enum(BQ_ISSUE_SEVERITIES),
  sheetIndex: z.number().int().nullable(),
  sheet: z.string().nullable(),
  row: z.number().int().nullable(),
  column: z.string().nullable(),
  billNumber: z.string().nullable(),
  ref: z.string().nullable(),
  values: z.record(z.string(), z.string()),
  actions: z.array(bqRowActionSchema),
  resolution: bqRowActionSchema.nullable(),
});

const kindTotalsSchema = z.strictObject({
  measured: minorUnitsSchema,
  preliminaries: minorUnitsSchema,
  provisionalSums: minorUnitsSchema,
  pcSums: minorUnitsSchema,
  pcAttendanceProfit: minorUnitsSchema,
  contingencies: minorUnitsSchema,
  dayworks: minorUnitsSchema,
});

export const bqTotalsSchema = z.strictObject({
  billCount: z.number().int().min(0),
  sectionCount: z.number().int().min(0),
  itemCount: z.number().int().min(0),
  subtotalMinor: minorUnitsSchema,
  vatRatePercent: decimalStringSchema,
  vatMinor: minorUnitsSchema,
  grandTotalMinor: minorUnitsSchema,
  byKind: kindTotalsSchema,
  sheet: z.strictObject({
    subtotalMinor: minorUnitsSchema.nullable(),
    vatMinor: minorUnitsSchema.nullable(),
    grandTotalMinor: minorUnitsSchema.nullable(),
  }),
  contractSumMinor: minorUnitsSchema.nullable(),
});

export const bqReadinessSchema = z.strictObject({
  blocking: z.number().int().min(0),
  unacceptedWarnings: z.array(bqIssueCodeSchema),
  canCommit: z.boolean(),
});

const countsSchema = z.record(z.string(), z.number().int().min(0));

export const bqReportSchema = z.strictObject({
  issues: z.array(bqIssueSchema),
  counts: countsSchema,
  unresolvedCounts: countsSchema,
  truncated: z.boolean(),
  totals: bqTotalsSchema,
  readiness: bqReadinessSchema,
  vatRuleStatus: z.string(),
  generatedAt: timestamp,
});

export const bqSheetSummarySchema = z.strictObject({
  index: z.number().int().min(0),
  name: z.string(),
  hidden: z.boolean(),
  usedRows: z.number().int().min(0),
  usedColumns: z.number().int().min(0),
  kind: z.enum(BQ_SHEET_KINDS),
  kindConfidence: z.number().min(0).max(1),
  headerRow: z.number().int().nullable(),
  headerConfidence: z.number().min(0).max(1).nullable(),
  headerSignature: z.string().nullable(),
  proposedColumns: bqColumnMapSchema,
  billNumber: z.string().nullable(),
  billTitle: z.string().nullable(),
  firstDataRow: z.number().int().nullable(),
  lastDataRow: z.number().int().nullable(),
  itemRows: z.number().int().min(0),
  templateId: uuid.nullable(),
});

export const bqImportSummarySchema = z.strictObject({
  id: uuid,
  status: bqImportStatusSchema,
  fileName: z.string(),
  fileType: z.enum(BQ_FILE_TYPES),
  fileSizeBytes: z.number().int().min(1),
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  scanStatus: z.enum(BQ_SCAN_STATUSES),
  scanEngine: z.string(),
  failureCode: z.enum(BQ_IMPORT_FAILURES).nullable(),
  uploadedBy: person,
  createdAt: timestamp,
  updatedAt: timestamp,
  committedAt: timestamp.nullable(),
  bqVersionId: uuid.nullable(),
  version,
});

export const bqImportSchema = bqImportSummarySchema.extend({
  sheets: z.array(bqSheetSummarySchema).nullable(),
  mapping: bqMappingSchema.nullable(),
  resolutions: bqResolutionsSchema,
  report: bqReportSchema.nullable(),
  committedBy: person.nullable(),
});

export const bqImportResponseSchema = z.strictObject({ import: bqImportSchema });
export const bqImportsResponseSchema = z.strictObject({ imports: z.array(bqImportSummarySchema) });

export const bqSheetRowsQuerySchema = z.strictObject({
  from: z.coerce.number().int().min(1).max(BQ_IMPORT_LIMITS.maxRowsPerSheet).default(1),
  count: z.coerce.number().int().min(1).max(BQ_IMPORT_LIMITS.previewRows).default(60),
});

export const bqSheetRowsResponseSchema = z.strictObject({
  sheetIndex: z.number().int().min(0),
  name: z.string(),
  from: z.number().int().min(1),
  totalRows: z.number().int().min(0),
  columns: z.array(z.strictObject({ index: z.number().int().min(0), letter: z.string() })),
  rows: z.array(
    z.strictObject({
      row: z.number().int().min(1),
      cells: z.array(z.string().nullable()),
      formulas: z.array(z.number().int().min(0)),
    }),
  ),
});

const billPreviewSchema = z.strictObject({
  number: z.string(),
  title: z.string(),
  kind: z.enum(BQ_BILL_KINDS),
  sheetName: z.string(),
  sectionCount: z.number().int().min(0),
  itemCount: z.number().int().min(0),
  totalMinor: minorUnitsSchema,
  sheetTotalMinor: minorUnitsSchema.nullable(),
});

export const bqPreviewResponseSchema = z.strictObject({
  importId: uuid,
  totals: bqTotalsSchema,
  readiness: bqReadinessSchema,
  bills: z.array(billPreviewSchema),
  existingDraft: z
    .strictObject({
      versionId: uuid,
      versionNo: z.number().int().min(1),
      grandTotalMinor: minorUnitsSchema,
      itemCount: z.number().int().min(0),
      sourceFileName: z.string().nullable(),
    })
    .nullable(),
  differences: z.array(
    z.strictObject({
      billNumber: z.string(),
      title: z.string(),
      change: z.enum(["added", "removed", "changed", "unchanged"]),
      currentTotalMinor: minorUnitsSchema.nullable(),
      newTotalMinor: minorUnitsSchema.nullable(),
      currentItemCount: z.number().int().min(0).nullable(),
      newItemCount: z.number().int().min(0).nullable(),
    }),
  ),
});

export const bqItemSchema = z.strictObject({
  id: uuid,
  sectionId: uuid.nullable(),
  ref: z.string().nullable(),
  description: z.string(),
  unit: z.enum(BQ_UNITS).nullable(),
  unitRaw: z.string().nullable(),
  quantity: decimalStringSchema.nullable(),
  rate: decimalStringSchema.nullable(),
  amountMinor: minorUnitsSchema,
  sheetAmountMinor: minorUnitsSchema.nullable(),
  amountSource: z.enum(BQ_AMOUNT_SOURCES),
  overrideReason: z.string().nullable(),
  kind: z.enum(BQ_ITEM_KINDS),
  notes: z.string().nullable(),
  sourceSheet: z.string(),
  sourceRow: z.number().int().min(1),
  hasFormula: z.boolean(),
});

export const bqSectionSchema = z.strictObject({
  id: uuid,
  code: z.string().nullable(),
  title: z.string().nullable(),
  notes: z.string().nullable(),
  totalMinor: minorUnitsSchema,
  itemCount: z.number().int().min(0),
});

export const bqBillSchema = z.strictObject({
  id: uuid,
  number: z.string(),
  title: z.string(),
  kind: z.enum(BQ_BILL_KINDS),
  totalMinor: minorUnitsSchema,
  sheetTotalMinor: minorUnitsSchema.nullable(),
  itemCount: z.number().int().min(0),
  sections: z.array(bqSectionSchema),
});

export const bqVersionSchema = z.strictObject({
  id: uuid,
  versionNo: z.number().int().min(1),
  status: z.enum(BQ_VERSION_STATUSES),
  source: z.enum(["import", "variation", "manual"]),
  vatRatePercent: decimalStringSchema,
  vatRuleKey: z.string(),
  vatRuleStatus: z.string(),
  rounding: z.string(),
  subtotalMinor: minorUnitsSchema,
  vatMinor: minorUnitsSchema,
  grandTotalMinor: minorUnitsSchema,
  billCount: z.number().int().min(0),
  itemCount: z.number().int().min(0),
  createdAt: timestamp,
  updatedAt: timestamp,
  version,
});

export const bqOverrideSchema = z.strictObject({
  sheet: z.string(),
  row: z.number().int().min(1),
  ref: z.string().nullable(),
  action: bqRowActionSchema,
  reason: z.string().nullable(),
  codes: z.array(bqIssueCodeSchema),
});

export const bqResponseSchema = z.strictObject({
  bq: z
    .strictObject({
      id: uuid,
      name: z.string(),
      version: bqVersionSchema,
      bills: z.array(bqBillSchema),
      byKind: kindTotalsSchema,
      contractSumMinor: minorUnitsSchema.nullable(),
      source: z
        .strictObject({
          importId: uuid,
          fileName: z.string(),
          fileType: z.enum(BQ_FILE_TYPES),
          committedAt: timestamp,
          committedBy: person,
          counts: countsSchema,
          accepted: z.array(z.strictObject({ code: bqIssueCodeSchema, reason: z.string() })),
          overrides: z.array(bqOverrideSchema),
        })
        .nullable(),
    })
    .nullable(),
  permissions: z.strictObject({ canImport: z.boolean(), canExport: z.boolean() }),
  openImports: z.number().int().min(0),
});

export const bqBillResponseSchema = z.strictObject({
  bill: bqBillSchema,
  items: z.array(bqItemSchema),
});

export const bqSearchQuerySchema = z.strictObject({ q: z.string().trim().min(2).max(100) });
export const bqSearchResponseSchema = z.strictObject({
  items: z.array(
    bqItemSchema.extend({
      billId: uuid,
      billNumber: z.string(),
      sectionTitle: z.string().nullable(),
    }),
  ),
  truncated: z.boolean(),
});

export const bqExportQuerySchema = z.strictObject({ locale: z.enum(["en", "sw"]).default("en") });

export const bqTemplateSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  signature: z.string(),
  columns: bqTemplateColumnsSchema,
  dataOffset: z.number().int().min(1).max(BQ_TEMPLATE_MAX_DATA_OFFSET),
  createdAt: timestamp,
  createdBy: person,
});
export const bqTemplatesResponseSchema = z.strictObject({ templates: z.array(bqTemplateSchema) });
export const bqTemplateResponseSchema = z.strictObject({ template: bqTemplateSchema });
export const createBqTemplateRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  importId: uuid,
  sheetIndex,
});

export type BqImport = z.infer<typeof bqImportSchema>;
export type BqImportSummary = z.infer<typeof bqImportSummarySchema>;
export type BqImportResponse = z.infer<typeof bqImportResponseSchema>;
export type BqImportsResponse = z.infer<typeof bqImportsResponseSchema>;
export type BqSheetSummary = z.infer<typeof bqSheetSummarySchema>;
export type BqSheetMappingInput = z.infer<typeof bqSheetMappingSchema>;
export type BqMappingInput = z.infer<typeof bqMappingSchema>;
export type BqResolutionsInput = z.infer<typeof bqResolutionsSchema>;
export type BqIssueWire = z.infer<typeof bqIssueSchema>;
export type BqReport = z.infer<typeof bqReportSchema>;
export type BqTotalsWire = z.infer<typeof bqTotalsSchema>;
export type BqSheetRowsResponse = z.infer<typeof bqSheetRowsResponseSchema>;
export type BqPreviewResponse = z.infer<typeof bqPreviewResponseSchema>;
export type BqItemWire = z.infer<typeof bqItemSchema>;
export type BqSectionWire = z.infer<typeof bqSectionSchema>;
export type BqBillWire = z.infer<typeof bqBillSchema>;
export type BqVersionWire = z.infer<typeof bqVersionSchema>;
export type BqResponse = z.infer<typeof bqResponseSchema>;
export type BqBillResponse = z.infer<typeof bqBillResponseSchema>;
export type BqSearchResponse = z.infer<typeof bqSearchResponseSchema>;
export type BqTemplate = z.infer<typeof bqTemplateSchema>;
export type BqTemplatesResponse = z.infer<typeof bqTemplatesResponseSchema>;
export type SaveBqMappingRequest = z.infer<typeof saveBqMappingRequestSchema>;
export type SaveBqResolutionsRequest = z.infer<typeof saveBqResolutionsRequestSchema>;
export type CreateBqTemplateRequest = z.infer<typeof createBqTemplateRequestSchema>;
