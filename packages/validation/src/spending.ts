import {
  BUDGET_SOURCES,
  BUDGET_STATUSES,
  CASH_FLOW_DIRECTIONS,
  CASH_FLOW_ITEM_STATUSES,
  COST_CATEGORIES,
  COST_MEASURES,
  COST_PURPOSES,
  COST_SOURCES,
  COUNT_STATUSES,
  COUNTERPARTY_KINDS,
  EXPENSE_PAYMENT_METHODS,
  EXPENSE_SOURCES,
  EXPENSE_STATUSES,
  FLOAT_ENTRY_KINDS,
  FLOAT_STATUSES,
  FORECAST_BASES,
  FORECAST_LINE_KINDS,
  JOURNAL_KINDS,
  JOURNAL_STATUSES,
  MPESA_OUTFLOW_KINDS,
  MPESA_SMS_KINDS,
  PLANNING_DATE_RANGE,
  SPEND_ALERT_KINDS,
  SPEND_ALERT_SEVERITIES,
  SPENDING_LIMITS,
  TOP_UP_METHODS,
  TOP_UP_STATUSES,
} from "@pm-buddy/types";
import { z } from "zod";
import { pageInfoSchema } from "./api.js";

/**
 * D5.4 spending and cash-flow contracts: company cost codes and settings, versioned budgets, the
 * append-only cost ledger, manual journals with maker-checker, budget against actual and
 * committed (project, category, bill, BQ item), petty-cash floats (expenses with receipts and
 * the M-Pesa SMS draft, top-ups, counts), manual cash-flow lines, the weekly forecast and spend
 * alerts. Money is integer KES minor units (`*Minor`). Requests are strict and never carry a
 * tenant, recorder, approver, balance or posted amount the server computes. Text limits count
 * characters (code points), not UTF-16 units.
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();
const planningDate = z.iso
  .date()
  .refine(
    (value) => value >= PLANNING_DATE_RANGE.min && value <= PLANNING_DATE_RANGE.max,
    "date_out_of_range",
  );
const version = z.number().int().min(1).max(2_147_483_647);
const person = z.strictObject({ id: uuid, displayName: z.string() });
const minor = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const positiveMinor = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonNegativeMinor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const listLimit = z.coerce.number().int().min(1).max(200).default(SPENDING_LIMITS.pageSize);
const page = pageInfoSchema;

function printable(value: string, multiline: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (multiline && (code === 9 || code === 10 || code === 13)) continue;
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
const length = (value: string) => Array.from(value).length;
/** Trimmed text of `min`–`max` characters (code points), without control characters. */
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
const category = z.enum(COST_CATEGORIES);
const booleanQuery = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional();
/** An M-Pesa transaction code: 10 letters and digits (at least one letter), uppercased. */
export const mpesaCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^(?=.*[A-Z])[A-Z0-9]{10}$/, "invalid_mpesa_code");

export const projectRefSchema = z.strictObject({ id: uuid, code: z.string(), name: z.string() });
const siteRef = z.strictObject({ id: uuid, name: z.string() });
export const costCodeRefSchema = z.strictObject({
  id: uuid,
  code: z.string(),
  name: z.string(),
  category,
});
export const spendingBqItemSchema = z.strictObject({
  versionId: uuid,
  lineageId: uuid,
  ref: z.string().nullable(),
  description: z.string(),
  unit: z.string().nullable(),
  bill: z.strictObject({ lineageId: uuid, number: z.string(), title: z.string() }).nullable(),
});
export type SpendingBqItem = z.infer<typeof spendingBqItemSchema>;
const supplierRef = z.strictObject({ id: uuid, name: z.string() });
const billRef = z.strictObject({ lineageId: uuid, number: z.string(), title: z.string() });

export const versionBodySchema = z.strictObject({ version });
export const reasonBodySchema = z.strictObject({ version, reason });
export type VersionBody = z.infer<typeof versionBodySchema>;
export type ReasonBody = z.infer<typeof reasonBodySchema>;

// Settings ----------------------------------------------------------------------------------------

export const spendingSettingsSchema = z.strictObject({
  budgetAlertPercent: z.number().int(),
  unusualSpendMultiplier: z.string(),
  unusualSpendMinSamples: z.number().int(),
  duplicateWindowDays: z.number().int(),
  forecastWeeks: z.number().int(),
  openingCashMinor: minor.nullable(),
  openingCashOn: calendarDate.nullable(),
  /** 0 until the company first saves its settings (the defaults apply). */
  version: z.number().int().min(0),
  updatedAt: timestamp.nullable(),
});
export type SpendingSettings = z.infer<typeof spendingSettingsSchema>;
export const spendingSettingsResponseSchema = z.strictObject({
  settings: spendingSettingsSchema,
  permissions: z.strictObject({ canEdit: z.boolean() }),
});
export type SpendingSettingsResponse = z.infer<typeof spendingSettingsResponseSchema>;
export const updateSpendingSettingsRequestSchema = z
  .strictObject({
    version: z.number().int().min(0),
    budgetAlertPercent: z
      .number()
      .int()
      .min(SPENDING_LIMITS.budgetAlertPercent.min)
      .max(SPENDING_LIMITS.budgetAlertPercent.max),
    unusualSpendMultiplier: z
      .string()
      .trim()
      .regex(/^\d{1,3}(?:\.\d{1,2})?$/, "invalid_decimal")
      .refine(
        (value) =>
          Number(value) >= SPENDING_LIMITS.unusualSpendMultiplier.min &&
          Number(value) <= SPENDING_LIMITS.unusualSpendMultiplier.max,
        "out_of_range",
      ),
    unusualSpendMinSamples: z
      .number()
      .int()
      .min(SPENDING_LIMITS.unusualSpendMinSamples.min)
      .max(SPENDING_LIMITS.unusualSpendMinSamples.max),
    duplicateWindowDays: z
      .number()
      .int()
      .min(SPENDING_LIMITS.duplicateWindowDays.min)
      .max(SPENDING_LIMITS.duplicateWindowDays.max),
    forecastWeeks: z
      .number()
      .int()
      .min(SPENDING_LIMITS.forecastWeeks.min)
      .max(SPENDING_LIMITS.forecastWeeks.max),
    openingCashMinor: minor.nullable(),
    openingCashOn: planningDate.nullable(),
  })
  .refine((value) => (value.openingCashMinor === null) === (value.openingCashOn === null), {
    path: ["openingCashOn"],
    message: "opening_cash_incomplete",
  });
export type UpdateSpendingSettingsRequest = z.input<typeof updateSpendingSettingsRequestSchema>;

// Cost codes --------------------------------------------------------------------------------------

export const costCodeSchema = z.strictObject({
  id: uuid,
  code: z.string(),
  name: z.string(),
  category,
  active: z.boolean(),
  version,
});
export type CostCode = z.infer<typeof costCodeSchema>;
export const costCodesQuerySchema = z.object({
  search: z.string().trim().max(60).optional(),
  includeInactive: booleanQuery,
  cursor: z.string().min(1).max(40).optional(),
  limit: listLimit,
});
export const costCodesResponseSchema = z.strictObject({
  costCodes: z.array(costCodeSchema),
  page,
  permissions: z.strictObject({ canManage: z.boolean() }),
});
export type CostCodesResponse = z.infer<typeof costCodesResponseSchema>;
export const costCodeResponseSchema = z.strictObject({ costCode: costCodeSchema });
export const createCostCodeRequestSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, "invalid_cost_code"),
  name: text(2, 120),
  category,
});
export type CreateCostCodeRequest = z.input<typeof createCostCodeRequestSchema>;
export const updateCostCodeRequestSchema = z.strictObject({
  version,
  name: text(2, 120).optional(),
  category: category.optional(),
  active: z.boolean().optional(),
});
export const loadCostCodeDefaultsResponseSchema = z.strictObject({
  created: z.number().int().min(0),
  existing: z.number().int().min(0),
});

// Budget against actual and committed ---------------------------------------------------------

/** One row of budget against actual and committed (packages/domain budgetRow). */
export const budgetRowSchema = z.strictObject({
  /** Null when the row has no budget (unavailable, never zero). */
  budgetMinor: minor.nullable(),
  committedMinor: minor,
  actualMinor: minor,
  paidMinor: minor,
  forecastMinor: minor,
  remainingMinor: minor.nullable(),
  /** (Actual + committed) ÷ budget, truncated to one decimal; null when undefined. */
  usedPercent: z.string().nullable(),
  level: z.enum(["unavailable", "within", "threshold", "over"]),
});
export type BudgetRowWire = z.infer<typeof budgetRowSchema>;
const budgetRef = z.strictObject({
  id: uuid,
  versionNo: z.number().int().min(1),
  name: z.string(),
  approvedAt: timestamp.nullable(),
});

export const spendingSummaryResponseSchema = z.strictObject({
  thresholdPercent: z.number().int(),
  projects: z.array(
    z.strictObject({
      project: projectRefSchema,
      budget: budgetRef.nullable(),
      figures: budgetRowSchema,
      /** Cash paid to suppliers and from floats, including VAT. */
      cashPaidMinor: minor,
    }),
  ),
});
export type SpendingSummaryResponse = z.infer<typeof spendingSummaryResponseSchema>;

export const projectSpendingResponseSchema = z.strictObject({
  project: projectRefSchema,
  budget: budgetRef.nullable(),
  thresholdPercent: z.number().int(),
  totals: budgetRowSchema,
  cashPaidMinor: minor,
  categories: z.array(budgetRowSchema.extend({ category })),
  /** Budget lines of BQ items without a category (not in any category row). */
  uncategorisedBudgetMinor: minor,
  bills: z.array(budgetRowSchema.extend({ bill: billRef, itemCount: z.number().int() })),
  /** Cost on no BQ item: materials in stores, and costs tagged with a cost code only. */
  notOnBqItems: budgetRowSchema,
  materials: z.strictObject({
    /** Approved supplier invoices (net of VAT): materials bought for the project. */
    accruedMinor: minor,
    /** Issued to BQ items net of returns, at the stores' weighted average cost. */
    issuedMinor: minor,
    /** Bought but not (yet) issued: in stores, wasted or not yet received. */
    notIssuedMinor: minor,
    /** Stock moved to and from other projects' stores (the cost stays with the buyer). */
    transferredInMinor: minor,
    transferredOutMinor: minor,
  }),
  permissions: z.strictObject({ canPrepareBudget: z.boolean(), canJournal: z.boolean() }),
});
export type ProjectSpendingResponse = z.infer<typeof projectSpendingResponseSchema>;

export const billItemsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  cursor: z
    .string()
    .regex(/^\d{1,6}$/)
    .optional(),
  limit: listLimit,
});
export const billItemsResponseSchema = z.strictObject({
  project: projectRefSchema,
  bill: billRef,
  thresholdPercent: z.number().int(),
  items: z.array(
    budgetRowSchema.extend({ item: spendingBqItemSchema, contractAmountMinor: minor.nullable() }),
  ),
  page,
});
export type BillItemsResponse = z.infer<typeof billItemsResponseSchema>;

export const bqItemSearchQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
});
export const bqItemSearchResponseSchema = z.strictObject({
  items: z.array(spendingBqItemSchema),
  truncated: z.boolean(),
  /** The approved BQ version searched; null when the project has none. */
  versionId: uuid.nullable(),
});
export type BqItemSearchResponse = z.infer<typeof bqItemSearchResponseSchema>;

// Budgets -----------------------------------------------------------------------------------------

export const budgetSummarySchema = z.strictObject({
  id: uuid,
  project: projectRefSchema,
  versionNo: z.number().int().min(1),
  name: z.string(),
  status: z.enum(BUDGET_STATUSES),
  totalMinor: minor,
  lineCount: z.number().int().min(0),
  bqVersion: z.strictObject({ id: uuid, versionNo: z.number().int() }).nullable(),
  createdBy: person,
  createdAt: timestamp,
  submittedAt: timestamp.nullable(),
  approvedBy: person.nullable(),
  approvedAt: timestamp.nullable(),
  /** The newest approved version: the budget in force. */
  current: z.boolean(),
  version,
});
export type BudgetSummary = z.infer<typeof budgetSummarySchema>;
export const budgetsQuerySchema = z.object({ projectId: uuid });
export const budgetsResponseSchema = z.strictObject({
  project: projectRefSchema,
  budgets: z.array(budgetSummarySchema),
  permissions: z.strictObject({ canCreate: z.boolean() }),
});
export type BudgetsResponse = z.infer<typeof budgetsResponseSchema>;

export const budgetLineSchema = z.strictObject({
  id: uuid,
  lineNo: z.number().int().min(1),
  bqItem: spendingBqItemSchema.nullable(),
  costCode: costCodeRefSchema.nullable(),
  category: category.nullable(),
  description: z.string(),
  amountMinor: minor,
});
export type BudgetLine = z.infer<typeof budgetLineSchema>;
export const budgetDetailResponseSchema = z.strictObject({
  budget: budgetSummarySchema.extend({
    notes: z.string().nullable(),
    digest: z.string().nullable(),
    submittedBy: person.nullable(),
    returnReason: z.string().nullable(),
    cancelledBy: person.nullable(),
    cancelledAt: timestamp.nullable(),
    cancelReason: z.string().nullable(),
  }),
  totals: z.strictObject({
    byCategory: z.array(z.strictObject({ category: category.nullable(), amountMinor: minor })),
    byBill: z.array(z.strictObject({ bill: billRef.nullable(), amountMinor: minor })),
  }),
  permissions: z.strictObject({
    canEdit: z.boolean(),
    canSubmit: z.boolean(),
    canApprove: z.boolean(),
    canReturn: z.boolean(),
    canCancel: z.boolean(),
  }),
});
export type BudgetDetailResponse = z.infer<typeof budgetDetailResponseSchema>;
export const budgetLinesQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  cursor: z
    .string()
    .regex(/^\d{1,7}$/)
    .optional(),
  limit: listLimit,
});
export const budgetLinesResponseSchema = z.strictObject({
  lines: z.array(budgetLineSchema),
  page,
});
export type BudgetLinesResponse = z.infer<typeof budgetLinesResponseSchema>;
export const createBudgetRequestSchema = z.strictObject({
  projectId: uuid,
  name: text(2, 120),
  source: z.enum(BUDGET_SOURCES),
  notes: optionalText(1_000, true).optional(),
});
export type CreateBudgetRequest = z.input<typeof createBudgetRequestSchema>;
export const updateBudgetRequestSchema = z.strictObject({
  version,
  name: text(2, 120).optional(),
  notes: optionalText(1_000, true).optional(),
});
export const addBudgetLineRequestSchema = z
  .strictObject({
    version,
    bqItemLineageId: uuid.optional(),
    costCodeId: uuid.optional(),
    description: optionalText(300).optional(),
    category: category.nullable().optional(),
    amountMinor: nonNegativeMinor,
  })
  .refine((value) => Boolean(value.bqItemLineageId) !== Boolean(value.costCodeId), {
    path: ["bqItemLineageId"],
    message: "item_or_cost_code",
  });
export type AddBudgetLineRequest = z.input<typeof addBudgetLineRequestSchema>;
export const updateBudgetLineRequestSchema = z.strictObject({
  version,
  amountMinor: nonNegativeMinor.optional(),
  description: text(1, 300).optional(),
  category: category.nullable().optional(),
});
export const deleteBudgetLineQuerySchema = z.object({ version: z.coerce.number().int().min(1) });
export const approveBudgetRequestSchema = z.strictObject({
  version,
  digest: z.string().regex(/^[0-9a-f]{64}$/, "invalid_digest"),
});

// The cost ledger -----------------------------------------------------------------------------

export const costEntrySchema = z.strictObject({
  id: uuid,
  project: projectRefSchema,
  site: siteRef.nullable(),
  measure: z.enum(COST_MEASURES),
  category,
  costCode: costCodeRefSchema.nullable(),
  bqItem: spendingBqItemSchema.nullable(),
  counterpartyKind: z.enum(COUNTERPARTY_KINDS),
  supplier: supplierRef.nullable(),
  counterpartyName: z.string().nullable(),
  paymentReference: z.string().nullable(),
  amountMinor: minor,
  occurredOn: calendarDate,
  source: z.enum(COST_SOURCES),
  purpose: z.enum(COST_PURPOSES),
  /** The document behind the entry (invoice, expense, count or journal number). */
  document: z.strictObject({ kind: z.enum(COST_SOURCES), id: uuid, label: z.string() }),
  reversesEntryId: uuid.nullable(),
  reversedByEntryId: uuid.nullable(),
  recordedBy: person,
  recordedAt: timestamp,
  businessDate: calendarDate,
});
export type CostEntry = z.infer<typeof costEntrySchema>;
export const costLedgerQuerySchema = z.object({
  projectId: uuid.optional(),
  measure: z.enum(COST_MEASURES).optional(),
  category: category.optional(),
  source: z.enum(COST_SOURCES).optional(),
  costCodeId: uuid.optional(),
  bqItemLineageId: uuid.optional(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export type CostLedgerQuery = z.input<typeof costLedgerQuerySchema>;
export const costLedgerResponseSchema = z.strictObject({
  entries: z.array(costEntrySchema),
  /** Sums over everything the filters match (all pages). */
  totals: z.strictObject({ accruedMinor: minor, paidMinor: minor, count: z.number().int() }),
  page,
  permissions: z.strictObject({ canReverse: z.boolean() }),
});
export type CostLedgerResponse = z.infer<typeof costLedgerResponseSchema>;

// Journals ------------------------------------------------------------------------------------

export const journalLineInputSchema = z
  .strictObject({
    measure: z.enum(COST_MEASURES),
    category,
    costCodeId: uuid.nullable().optional(),
    bqItemLineageId: uuid.nullable().optional(),
    siteId: uuid.nullable().optional(),
    counterpartyKind: z.enum(COUNTERPARTY_KINDS),
    supplierId: uuid.nullable().optional(),
    counterpartyName: optionalText(200).optional(),
    paymentReference: optionalText(60).optional(),
    occurredOn: planningDate,
    amountMinor: minor.refine((value) => value !== 0, "zero_amount"),
  })
  .superRefine((line, ctx) => {
    if (!line.costCodeId && !line.bqItemLineageId)
      ctx.addIssue({ code: "custom", path: ["costCodeId"], message: "item_or_cost_code" });
    if ((line.counterpartyKind === "supplier") !== Boolean(line.supplierId))
      ctx.addIssue({ code: "custom", path: ["supplierId"], message: "supplier_mismatch" });
    if (line.counterpartyKind === "none" && line.counterpartyName)
      ctx.addIssue({ code: "custom", path: ["counterpartyName"], message: "no_counterparty" });
  });
export type JournalLineInput = z.input<typeof journalLineInputSchema>;
export const createJournalRequestSchema = z.strictObject({
  projectId: uuid,
  reason,
  lines: z.array(journalLineInputSchema).min(1).max(SPENDING_LIMITS.journalLines),
});
export type CreateJournalRequest = z.input<typeof createJournalRequestSchema>;
export const reversalJournalRequestSchema = z.strictObject({ entryId: uuid, reason });

export const journalLineSchema = z.strictObject({
  id: uuid,
  lineNo: z.number().int().min(1),
  measure: z.enum(COST_MEASURES),
  category,
  costCode: costCodeRefSchema.nullable(),
  bqItem: spendingBqItemSchema.nullable(),
  site: siteRef.nullable(),
  counterpartyKind: z.enum(COUNTERPARTY_KINDS),
  supplier: supplierRef.nullable(),
  counterpartyName: z.string().nullable(),
  paymentReference: z.string().nullable(),
  occurredOn: calendarDate,
  amountMinor: minor,
  reversesEntryId: uuid.nullable(),
  postedEntryId: uuid.nullable(),
});
export const journalSummarySchema = z.strictObject({
  id: uuid,
  number: z.string(),
  project: projectRefSchema,
  kind: z.enum(JOURNAL_KINDS),
  reason: z.string(),
  status: z.enum(JOURNAL_STATUSES),
  lineCount: z.number().int(),
  totalMinor: minor,
  createdBy: person,
  createdAt: timestamp,
  decidedBy: person.nullable(),
  decidedAt: timestamp.nullable(),
  decisionReason: z.string().nullable(),
  version,
});
export type JournalSummary = z.infer<typeof journalSummarySchema>;
export const journalsQuerySchema = z.object({
  projectId: uuid.optional(),
  status: z.enum(JOURNAL_STATUSES).optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export const journalsResponseSchema = z.strictObject({
  journals: z.array(journalSummarySchema),
  page,
  permissions: z.strictObject({ canCreate: z.boolean() }),
});
export type JournalsResponse = z.infer<typeof journalsResponseSchema>;
export const journalResponseSchema = z.strictObject({
  journal: journalSummarySchema.extend({ lines: z.array(journalLineSchema) }),
  permissions: z.strictObject({ canApprove: z.boolean(), canReject: z.boolean() }),
});
export type JournalResponse = z.infer<typeof journalResponseSchema>;

// Petty cash ----------------------------------------------------------------------------------

const floatRef = z.strictObject({ id: uuid, name: z.string() });
export const floatSummarySchema = z.strictObject({
  id: uuid,
  name: z.string(),
  project: projectRefSchema,
  site: siteRef,
  custodian: person,
  limitMinor: minor,
  balanceMinor: minor,
  status: z.enum(FLOAT_STATUSES),
  lastEntryAt: timestamp.nullable(),
  submittedExpenses: z.number().int(),
  openTopUps: z.number().int(),
  openCount: z.boolean(),
  lastApprovedCount: z
    .strictObject({ number: z.string(), countedAt: timestamp, varianceMinor: minor })
    .nullable(),
  version,
});
export type FloatSummary = z.infer<typeof floatSummarySchema>;
export const floatsResponseSchema = z.strictObject({
  floats: z.array(floatSummarySchema),
  sitesWithoutFloat: z.array(
    z.strictObject({ project: projectRefSchema, site: siteRef, canCreate: z.boolean() }),
  ),
});
export type FloatsResponse = z.infer<typeof floatsResponseSchema>;
export const floatResponseSchema = z.strictObject({
  float: floatSummarySchema,
  permissions: z.strictObject({
    canRecordExpense: z.boolean(),
    canRequestTopUp: z.boolean(),
    canCount: z.boolean(),
    canEdit: z.boolean(),
  }),
});
export type FloatResponse = z.infer<typeof floatResponseSchema>;
export const createFloatRequestSchema = z.strictObject({
  siteId: uuid,
  name: text(2, 120),
  custodianUserId: uuid,
  limitMinor: positiveMinor,
});
export type CreateFloatRequest = z.input<typeof createFloatRequestSchema>;
export const updateFloatRequestSchema = z.strictObject({
  version,
  name: text(2, 120).optional(),
  custodianUserId: uuid.optional(),
  limitMinor: positiveMinor.optional(),
  close: z.literal(true).optional(),
});
export const custodiansQuerySchema = z.object({ projectId: uuid });
export const custodiansResponseSchema = z.strictObject({ people: z.array(person) });

export const floatEntrySchema = z.strictObject({
  id: uuid,
  seq: z.number().int().min(1),
  kind: z.enum(FLOAT_ENTRY_KINDS),
  amountMinor: minor,
  balanceMinor: minor,
  document: z.strictObject({
    kind: z.enum(["top_up", "expense", "count"]),
    id: uuid,
    number: z.string(),
  }),
  recordedBy: person,
  recordedAt: timestamp,
  businessDate: calendarDate,
});
export const floatLedgerQuerySchema = z.object({
  cursor: z.coerce.number().int().min(1).optional(),
  limit: listLimit,
});
export const floatLedgerResponseSchema = z.strictObject({
  entries: z.array(floatEntrySchema),
  page,
});
export type FloatLedgerResponse = z.infer<typeof floatLedgerResponseSchema>;

export const receiptSchema = z.strictObject({
  id: uuid,
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  sizeBytes: z.number().int().min(1),
  scanStatus: z.enum(["clean", "not_scanned"]),
  uploadedAt: timestamp,
  uploadedBy: person,
});
export const receiptResponseSchema = z.strictObject({ receipt: receiptSchema });

export const expenseSchema = z.strictObject({
  id: uuid,
  number: z.string(),
  float: floatRef,
  project: projectRefSchema,
  site: siteRef,
  spentOn: calendarDate,
  amountMinor: minor,
  chargeMinor: minor,
  category,
  costCode: costCodeRefSchema.nullable(),
  bqItem: spendingBqItemSchema.nullable(),
  counterpartyKind: z.enum(["supplier", "worker", "other"]),
  supplier: supplierRef.nullable(),
  payeeName: z.string(),
  payeeAccount: z.string().nullable(),
  payeePhoneMasked: z.string().nullable(),
  paymentMethod: z.enum(EXPENSE_PAYMENT_METHODS),
  mpesaCode: z.string().nullable(),
  /** Filled from a pasted SMS: a draft that a person checked, never proof of settlement. */
  parsedFromSms: z.boolean(),
  smsKind: z.enum(MPESA_SMS_KINDS).nullable(),
  description: z.string(),
  status: z.enum(EXPENSE_STATUSES),
  source: z.enum(EXPENSE_SOURCES),
  capturedAt: timestamp,
  recordedAt: timestamp,
  recordedBy: person,
  decidedBy: person.nullable(),
  decidedAt: timestamp.nullable(),
  decisionReason: z.string().nullable(),
  receiptCount: z.number().int().min(0),
  version,
});
export type Expense = z.infer<typeof expenseSchema>;
export const expenseResponseSchema = z.strictObject({
  expense: expenseSchema.extend({ receipts: z.array(receiptSchema) }),
  replayed: z.boolean(),
  permissions: z.strictObject({
    canApprove: z.boolean(),
    canReject: z.boolean(),
    canAddReceipt: z.boolean(),
  }),
});
export type ExpenseResponse = z.infer<typeof expenseResponseSchema>;
export const expensesQuerySchema = z.object({
  floatId: uuid.optional(),
  projectId: uuid.optional(),
  status: z.enum(EXPENSE_STATUSES).optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export const expensesResponseSchema = z.strictObject({
  expenses: z.array(expenseSchema),
  page,
});
export type ExpensesResponse = z.infer<typeof expensesResponseSchema>;

/**
 * An expense, offline-ready: the client chooses the ID and sends an `Idempotency-Key`; a replay
 * returns the original. Amounts are what left the float (amount + M-Pesa charge).
 */
export const createExpenseRequestSchema = z
  .strictObject({
    id: uuid,
    floatId: uuid,
    capturedAt: timestamp,
    spentOn: planningDate,
    amountMinor: positiveMinor,
    chargeMinor: nonNegativeMinor.default(0),
    category,
    costCodeId: uuid.nullable().optional(),
    bqItemLineageId: uuid.nullable().optional(),
    counterpartyKind: z.enum(["supplier", "worker", "other"]),
    supplierId: uuid.nullable().optional(),
    payeeName: text(2, 200),
    payeeAccount: optionalText(40).optional(),
    payeePhoneMasked: z
      .string()
      .regex(/^0[17]\d{2}\*{3}\d{3}$/, "invalid_masked_phone")
      .nullable()
      .optional(),
    paymentMethod: z.enum(EXPENSE_PAYMENT_METHODS),
    mpesaCode: mpesaCodeSchema.nullable().optional(),
    parsedFromSms: z.boolean().default(false),
    smsKind: z.enum(MPESA_OUTFLOW_KINDS).nullable().optional(),
    description: text(3, 500),
    source: z.enum(EXPENSE_SOURCES).default("web"),
  })
  .superRefine((value, ctx) => {
    if (!value.costCodeId && !value.bqItemLineageId)
      ctx.addIssue({ code: "custom", path: ["costCodeId"], message: "item_or_cost_code" });
    if ((value.counterpartyKind === "supplier") !== Boolean(value.supplierId))
      ctx.addIssue({ code: "custom", path: ["supplierId"], message: "supplier_mismatch" });
    if ((value.paymentMethod === "mpesa") !== Boolean(value.mpesaCode))
      ctx.addIssue({ code: "custom", path: ["mpesaCode"], message: "mpesa_code_required" });
    if (value.parsedFromSms !== Boolean(value.smsKind))
      ctx.addIssue({ code: "custom", path: ["smsKind"], message: "sms_kind_required" });
    if (value.paymentMethod === "cash" && value.chargeMinor > 0)
      ctx.addIssue({ code: "custom", path: ["chargeMinor"], message: "cash_has_no_charge" });
  });
export type CreateExpenseRequest = z.input<typeof createExpenseRequestSchema>;
export type ParsedExpenseRequest = z.infer<typeof createExpenseRequestSchema>;
export const approveExpenseRequestSchema = z.strictObject({ version });

export const smsParseRequestSchema = z.strictObject({
  text: z.string().refine((value) => length(value) <= SPENDING_LIMITS.smsMaxLength, "too_long"),
});
const smsDraftSchema = z.strictObject({
  kind: z.enum(MPESA_SMS_KINDS),
  language: z.enum(["en", "sw"]),
  code: z.string(),
  amountMinor: minor,
  counterpartyName: z.string().nullable(),
  counterpartyPhoneMasked: z.string().nullable(),
  account: z.string().nullable(),
  occurredOn: calendarDate.nullable(),
  occurredAt: z.string().nullable(),
  balanceMinor: minor.nullable(),
  chargeMinor: minor.nullable(),
  direction: z.enum(["out", "in"]),
  confirmsSettlement: z.literal(false),
});
export const smsParseResponseSchema = z.strictObject({
  result: z.discriminatedUnion("ok", [
    z.strictObject({
      ok: z.literal(true),
      draft: smsDraftSchema,
      warnings: z.array(z.enum(["no_counterparty", "no_date", "no_balance", "no_charge"])),
    }),
    z.strictObject({
      ok: z.literal(false),
      error: z.enum(["empty", "too_long", "no_code", "unrecognised", "no_amount"]),
    }),
  ]),
  /** Records already holding this transaction code (a likely duplicate). */
  duplicates: z.array(
    z.strictObject({
      kind: z.enum(["expense", "settlement", "top_up"]),
      id: uuid,
      label: z.string(),
      status: z.string(),
    }),
  ),
  /** Always false: an SMS is a draft to check, never proof that money moved. */
  confirmsSettlement: z.literal(false),
});
export type SmsParseResponse = z.infer<typeof smsParseResponseSchema>;

export const topUpSchema = z.strictObject({
  id: uuid,
  number: z.string(),
  float: floatRef,
  project: projectRefSchema,
  amountMinor: minor,
  reason: z.string(),
  status: z.enum(TOP_UP_STATUSES),
  requestedBy: person,
  requestedAt: timestamp,
  decidedBy: person.nullable(),
  decidedAt: timestamp.nullable(),
  decisionReason: z.string().nullable(),
  paidBy: person.nullable(),
  paidAt: timestamp.nullable(),
  paidOn: calendarDate.nullable(),
  method: z.enum(TOP_UP_METHODS).nullable(),
  reference: z.string().nullable(),
  cancelledBy: person.nullable(),
  cancelReason: z.string().nullable(),
  version,
  permissions: z.strictObject({
    canApprove: z.boolean(),
    canReject: z.boolean(),
    canPay: z.boolean(),
    canCancel: z.boolean(),
  }),
});
export type TopUp = z.infer<typeof topUpSchema>;
export const topUpsQuerySchema = z.object({
  floatId: uuid.optional(),
  status: z.enum(TOP_UP_STATUSES).optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export const topUpsResponseSchema = z.strictObject({ topUps: z.array(topUpSchema), page });
export type TopUpsResponse = z.infer<typeof topUpsResponseSchema>;
export const topUpResponseSchema = z.strictObject({ topUp: topUpSchema });
export const createTopUpRequestSchema = z.strictObject({
  floatId: uuid,
  amountMinor: positiveMinor,
  reason,
});
export const payTopUpRequestSchema = z.strictObject({
  version,
  method: z.enum(TOP_UP_METHODS),
  reference: text(3, 60),
  paidOn: planningDate,
});
export type PayTopUpRequest = z.input<typeof payTopUpRequestSchema>;

export const countSchema = z.strictObject({
  id: uuid,
  number: z.string(),
  float: floatRef,
  project: projectRefSchema,
  countedMinor: minor,
  bookMinor: minor,
  /** Counted − book: negative is a shortage, positive an overage. */
  varianceMinor: minor,
  note: z.string().nullable(),
  status: z.enum(COUNT_STATUSES),
  countedBy: person,
  countedAt: timestamp,
  decidedBy: person.nullable(),
  decidedAt: timestamp.nullable(),
  decisionReason: z.string().nullable(),
  version,
  permissions: z.strictObject({ canApprove: z.boolean(), canReturn: z.boolean() }),
});
export type Count = z.infer<typeof countSchema>;
export const countsQuerySchema = z.object({
  floatId: uuid.optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export const countsResponseSchema = z.strictObject({ counts: z.array(countSchema), page });
export type CountsResponse = z.infer<typeof countsResponseSchema>;
export const countResponseSchema = z.strictObject({ count: countSchema });
export const createCountRequestSchema = z.strictObject({
  floatId: uuid,
  countedMinor: nonNegativeMinor,
  note: optionalText(500).optional(),
});

// Cash flow -------------------------------------------------------------------------------------

export const cashFlowItemSchema = z.strictObject({
  id: uuid,
  project: projectRefSchema,
  direction: z.enum(CASH_FLOW_DIRECTIONS),
  description: z.string(),
  expectedOn: calendarDate,
  amountMinor: minor,
  status: z.enum(CASH_FLOW_ITEM_STATUSES),
  receivedOn: calendarDate.nullable(),
  receivedMinor: minor.nullable(),
  reference: z.string().nullable(),
  createdBy: person,
  createdAt: timestamp,
  version,
  permissions: z.strictObject({ canEdit: z.boolean() }),
});
export type CashFlowItem = z.infer<typeof cashFlowItemSchema>;
export const cashFlowItemsQuerySchema = z.object({
  projectId: uuid.optional(),
  status: z.enum(CASH_FLOW_ITEM_STATUSES).optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export const cashFlowItemsResponseSchema = z.strictObject({
  items: z.array(cashFlowItemSchema),
  page,
});
export type CashFlowItemsResponse = z.infer<typeof cashFlowItemsResponseSchema>;
export const cashFlowItemResponseSchema = z.strictObject({ item: cashFlowItemSchema });
export const createCashFlowItemRequestSchema = z.strictObject({
  projectId: uuid,
  direction: z.enum(CASH_FLOW_DIRECTIONS),
  description: text(3, 200),
  expectedOn: planningDate,
  amountMinor: positiveMinor,
  reference: optionalText(60).optional(),
});
export type CreateCashFlowItemRequest = z.input<typeof createCashFlowItemRequestSchema>;
export const updateCashFlowItemRequestSchema = z.strictObject({
  version,
  description: text(3, 200).optional(),
  expectedOn: planningDate.optional(),
  amountMinor: positiveMinor.optional(),
  reference: optionalText(60).optional(),
});
export const receiveCashFlowItemRequestSchema = z.strictObject({
  version,
  receivedOn: planningDate,
  receivedMinor: positiveMinor,
  reference: optionalText(60).optional(),
});

export const forecastQuerySchema = z.object({ projectId: uuid.optional() });
export const forecastLineSchema = z.strictObject({
  kind: z.enum(FORECAST_LINE_KINDS),
  direction: z.enum(["in", "out"]),
  date: calendarDate,
  amountMinor: minor,
  basis: z.enum(FORECAST_BASES),
  overdue: z.boolean(),
  project: projectRefSchema,
  document: z
    .strictObject({
      kind: z.enum([
        "payroll_batch",
        "pay_period",
        "invoice",
        "lpo",
        "top_up",
        "cash_flow_item",
        "certificate",
      ]),
      id: uuid.nullable(),
      label: z.string(),
    })
    .nullable(),
});
export type ForecastLine = z.infer<typeof forecastLineSchema>;
export const forecastWeekSchema = z.strictObject({
  start: calendarDate,
  end: calendarDate,
  inMinor: minor,
  outMinor: minor,
  netMinor: minor,
  closingMinor: minor.nullable(),
  byKind: z.partialRecord(z.enum(FORECAST_LINE_KINDS), minor),
  estimatedMinor: minor,
  overdueMinor: minor,
});
export const forecastResponseSchema = z.strictObject({
  scope: z.enum(["project", "company"]),
  project: projectRefSchema.nullable(),
  today: calendarDate,
  opening: z.strictObject({
    /** entered: the company's opening cash, moved by what was recorded since; derived: a
     * project's receipts − payments to date; none: no opening entered. */
    basis: z.enum(["entered", "derived", "none"]),
    amountMinor: minor.nullable(),
    enteredMinor: minor.nullable(),
    enteredOn: calendarDate.nullable(),
    receivedSinceMinor: minor,
    paidSinceMinor: minor,
  }),
  weeks: z.array(forecastWeekSchema),
  later: z.strictObject({ inMinor: minor, outMinor: minor }),
  lines: z.array(forecastLineSchema),
  linesTruncated: z.boolean(),
});
export type ForecastResponse = z.infer<typeof forecastResponseSchema>;

// Alerts --------------------------------------------------------------------------------------

export const spendAlertSchema = z.strictObject({
  /** Stable for the same facts (kind and the records involved). */
  id: z.string(),
  kind: z.enum(SPEND_ALERT_KINDS),
  severity: z.enum(SPEND_ALERT_SEVERITIES),
  project: projectRefSchema,
  detectedOn: calendarDate,
  amountMinor: minor.nullable(),
  /** budget_threshold: which budget figure (project, a category or a bill). */
  scope: z
    .strictObject({
      kind: z.enum(["project", "category", "bill"]),
      category: category.nullable(),
      bill: billRef.nullable(),
    })
    .nullable(),
  figures: z
    .strictObject({
      usedMinor: minor,
      budgetMinor: minor,
      usedPercent: z.string(),
      thresholdPercent: z.number().int(),
    })
    .nullable(),
  /** unusual_spend: the median of the float's earlier expenses and the rule's multiplier. */
  typical: z
    .strictObject({ medianMinor: z.string(), multiplier: z.string(), samples: z.number().int() })
    .nullable(),
  /** duplicate_payment: which rule matched. */
  rule: z.enum(["same_reference", "same_counterparty_amount"]).nullable(),
  records: z.array(
    z.strictObject({
      kind: z.enum(["expense", "settlement", "top_up", "invoice"]),
      id: uuid,
      label: z.string(),
      date: calendarDate.nullable(),
      amountMinor: minor.nullable(),
    }),
  ),
});
export type SpendAlert = z.infer<typeof spendAlertSchema>;
export const spendAlertsQuerySchema = z.object({
  projectId: uuid.optional(),
  kind: z.enum(SPEND_ALERT_KINDS).optional(),
  cursor: z
    .string()
    .regex(/^\d{1,6}$/)
    .optional(),
  limit: listLimit,
});
export const spendAlertsResponseSchema = z.strictObject({
  alerts: z.array(spendAlertSchema),
  counts: z.record(z.enum(SPEND_ALERT_KINDS), z.number().int()),
  page,
});
export type SpendAlertsResponse = z.infer<typeof spendAlertsResponseSchema>;
