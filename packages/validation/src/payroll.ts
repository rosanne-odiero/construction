import { statutoryParameterIssues } from "@pm-buddy/domain";
import {
  ADVANCE_DISBURSEMENT_METHODS,
  ADVANCE_DISPLAY_STATUSES,
  ADVANCE_STATUSES,
  ALLOWANCE_BASES,
  DAY_TYPES,
  EARNING_KINDS,
  EMPLOYEE_STATUTORY,
  EMPLOYER_COSTS,
  ENGAGEMENT_TYPES,
  MINIMUM_WAGE_AREAS,
  MINIMUM_WAGE_OCCUPATIONS,
  OUTPUT_STATUSES,
  PAY_FREQUENCIES,
  PAYDAY_OFFSET_LIMITS,
  PAYROLL_BATCH_STATUSES,
  PAYROLL_EXCLUSION_REASONS,
  PAYROLL_EXPORT_KINDS,
  PAYROLL_SETTINGS_LIMITS,
  PAYROLL_WARNING_CODES,
  PRE_TAX_DEDUCTIONS,
  RATE_BASES,
  RULE_VERIFICATION_STATUSES,
  STATUTORY_ITEMS,
  STATUTORY_METHODS,
  STATUTORY_RULE_KINDS,
  type StatutoryParameters,
  type StatutoryRuleKind,
} from "@pm-buddy/types";
import { z } from "zod";

/**
 * Payroll engine (D4.1): pay calendars, statutory rule versions, minimum wages, allowances,
 * piece-rate output, salary advances, payroll batches with their immutable submitted snapshot,
 * payslips and statutory exports. Requests are strict; money is integer KES minor units; rates and
 * quantities are decimal strings; dates are YYYY-MM-DD in Africa/Nairobi.
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "invalid_month");
const version = z.number().int().min(1).max(2_147_483_647);
/** 0 means "still on the defaults" (no row saved yet). */
const versionOrZero = z.number().int().min(0).max(2_147_483_647);
const minor = z.number().int().refine(Number.isSafeInteger, "amount_out_of_range");
const positiveMinor = minor.refine((value) => value > 0, "amount_not_positive");
const nonNegativeMinor = minor.refine((value) => value >= 0, "amount_negative");
const amountLimit = z
  .number()
  .int()
  .min(PAYROLL_SETTINGS_LIMITS.amountMinor.min)
  .max(PAYROLL_SETTINGS_LIMITS.amountMinor.max);
const percent = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, "invalid_percent")
  .refine((value) => Number(value) >= 1 && Number(value) <= 100, "percent_out_of_range");
const ratePercent = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, "invalid_rate");
const actor = z.object({ id: uuid, displayName: z.string().min(1).max(100) }).strict();
const projectRef = z.object({ id: uuid, code: z.string(), name: z.string() }).strict();
const labourerRef = z.object({ id: uuid, workerNo: z.string(), fullName: z.string() }).strict();
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
/** A reason or reviewer note: 10–500 characters. */
export const payrollReasonSchema = text(10, 500);

export const payFrequencySchema = z.enum(PAY_FREQUENCIES);
export const payrollBatchStatusSchema = z.enum(PAYROLL_BATCH_STATUSES);
export const statutoryRuleKindSchema = z.enum(STATUTORY_RULE_KINDS);
export const ruleVerificationStatusSchema = z.enum(RULE_VERIFICATION_STATUSES);
export const minimumWageAreaSchema = z.enum(MINIMUM_WAGE_AREAS);
export const minimumWageOccupationSchema = z.enum(MINIMUM_WAGE_OCCUPATIONS);
export const allowanceBasisSchema = z.enum(ALLOWANCE_BASES);
export const outputStatusSchema = z.enum(OUTPUT_STATUSES);
export const advanceStatusSchema = z.enum(ADVANCE_STATUSES);
export const advanceDisplayStatusSchema = z.enum(ADVANCE_DISPLAY_STATUSES);
export const advanceDisbursementMethodSchema = z.enum(ADVANCE_DISBURSEMENT_METHODS);
export const payrollExportKindSchema = z.enum(PAYROLL_EXPORT_KINDS);
export const payrollExclusionReasonSchema = z.enum(PAYROLL_EXCLUSION_REASONS);
export const payrollWarningCodeSchema = z.enum(PAYROLL_WARNING_CODES);

const detailValue = z.union([
  z.string().max(200),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(64)).max(60),
]);
export const payrollWarningSchema = z
  .object({ code: payrollWarningCodeSchema, details: z.record(z.string(), detailValue) })
  .strict();
export type PayrollWarning = z.infer<typeof payrollWarningSchema>;

// Settings and calendars --------------------------------------------------------------------------

export const payrollSettingsSchema = z
  .object({
    advanceMaxMinor: minor,
    advanceMaxOutstandingMinor: minor,
    recoveryMaxPercent: z.string(),
    version: versionOrZero,
  })
  .strict();
export const payCalendarSchema = z
  .object({
    frequency: payFrequencySchema,
    anchorDate: calendarDate,
    paydayOffsetDays: z.number().int().min(PAYDAY_OFFSET_LIMITS.min).max(PAYDAY_OFFSET_LIMITS.max),
    minimumWageArea: minimumWageAreaSchema.nullable(),
    version: versionOrZero,
    isDefault: z.boolean(),
  })
  .strict();
export type PayCalendarWire = z.infer<typeof payCalendarSchema>;
export const payrollSettingsResponseSchema = z
  .object({
    today: calendarDate,
    settings: payrollSettingsSchema,
    calendars: z.array(
      z.object({ project: projectRef, calendar: payCalendarSchema, canEdit: z.boolean() }).strict(),
    ),
    canConfigure: z.boolean(),
  })
  .strict();
export type PayrollSettingsResponse = z.infer<typeof payrollSettingsResponseSchema>;
export const updatePayrollSettingsRequestSchema = z
  .object({
    advanceMaxMinor: amountLimit,
    advanceMaxOutstandingMinor: amountLimit,
    recoveryMaxPercent: percent,
    version: versionOrZero,
  })
  .strict()
  .refine((value) => value.advanceMaxOutstandingMinor >= value.advanceMaxMinor, {
    message: "outstanding_below_single",
    path: ["advanceMaxOutstandingMinor"],
  });
export const updatePayCalendarRequestSchema = z
  .object({
    frequency: payFrequencySchema,
    anchorDate: calendarDate,
    paydayOffsetDays: z.number().int().min(PAYDAY_OFFSET_LIMITS.min).max(PAYDAY_OFFSET_LIMITS.max),
    minimumWageArea: minimumWageAreaSchema.nullable(),
    version: versionOrZero,
  })
  .strict();
export const payCalendarResponseSchema = z
  .object({ project: projectRef, calendar: payCalendarSchema })
  .strict();

// Statutory rules ---------------------------------------------------------------------------------

const payeParameters = z
  .object({
    bands: z
      .array(
        z.object({ upToMinor: nonNegativeMinor.nullable(), ratePercent: ratePercent }).strict(),
      )
      .min(1)
      .max(12),
    personalReliefMinor: nonNegativeMinor,
    deductibleBeforeTax: z.array(z.enum(PRE_TAX_DEDUCTIONS)).max(3),
  })
  .strict();
const nssfParameters = z
  .object({
    employeeRatePercent: ratePercent,
    employerRatePercent: ratePercent,
    lowerEarningsLimitMinor: nonNegativeMinor,
    upperEarningsLimitMinor: nonNegativeMinor,
  })
  .strict();
const shifParameters = z
  .object({
    employeeRatePercent: ratePercent,
    minimumMinor: nonNegativeMinor,
    maximumMinor: nonNegativeMinor.nullable(),
  })
  .strict();
const ahlParameters = z
  .object({ employeeRatePercent: ratePercent, employerRatePercent: ratePercent })
  .strict();
const nitaParameters = z.object({ employerAmountPerEmployeeMinor: nonNegativeMinor }).strict();
const methodParameters = z.object({ method: z.enum(STATUTORY_METHODS) }).strict();
const itemFlags = z
  .object(
    Object.fromEntries(STATUTORY_ITEMS.map((item) => [item, z.boolean()])) as {
      [K in (typeof STATUTORY_ITEMS)[number]]: z.ZodBoolean;
    },
  )
  .strict();
const applicabilityParameters = z
  .object(
    Object.fromEntries(ENGAGEMENT_TYPES.map((type) => [type, itemFlags])) as {
      [K in (typeof ENGAGEMENT_TYPES)[number]]: typeof itemFlags;
    },
  )
  .strict();

export const statutoryParameterSchemas = {
  paye: payeParameters,
  nssf: nssfParameters,
  shif: shifParameters,
  ahl: ahlParameters,
  nita: nitaParameters,
  method: methodParameters,
  applicability: applicabilityParameters,
} as const;

const ruleFields = {
  effectiveFrom: calendarDate,
  sourceReference: text(10, 2000),
  notes: z.string().trim().max(1000),
};
const ruleVariant = <K extends StatutoryRuleKind>(kind: K) =>
  z
    .object({
      kind: z.literal(kind),
      parameters: statutoryParameterSchemas[kind],
      ...ruleFields,
    })
    .strict();

/** A new statutory rule version (never an edit of an existing one). */
export const createStatutoryRuleRequestSchema = z
  .discriminatedUnion("kind", [
    ruleVariant("paye"),
    ruleVariant("nssf"),
    ruleVariant("shif"),
    ruleVariant("ahl"),
    ruleVariant("nita"),
    ruleVariant("method"),
    ruleVariant("applicability"),
  ])
  .superRefine((value, ctx) => {
    for (const issue of statutoryParameterIssues(
      value.kind,
      value.parameters as StatutoryParameters[typeof value.kind],
    ))
      ctx.addIssue({ code: "custom", message: `parameters_${issue}`, path: ["parameters"] });
  });
export type CreateStatutoryRuleRequest = z.infer<typeof createStatutoryRuleRequestSchema>;

export const statutoryRuleSchema = z
  .object({
    id: uuid,
    kind: statutoryRuleKindSchema,
    effectiveFrom: calendarDate,
    /** The day before the next version of the same kind starts; null while none follows. */
    effectiveTo: calendarDate.nullable(),
    inForce: z.boolean(),
    parameters: z.union([
      payeParameters,
      nssfParameters,
      shifParameters,
      ahlParameters,
      nitaParameters,
      methodParameters,
      applicabilityParameters,
    ]),
    status: ruleVerificationStatusSchema,
    sourceReference: z.string(),
    notes: z.string(),
    createdBy: actor,
    createdAt: timestamp,
    verifiedBy: actor.nullable(),
    verifiedAt: timestamp.nullable(),
    verificationNote: z.string().nullable(),
    /** Submitted batches that used this version (they keep it whatever happens next). */
    submittedBatches: z.number().int().min(0),
  })
  .strict();
export type StatutoryRule = z.infer<typeof statutoryRuleSchema>;

export const minimumWageSchema = z
  .object({
    id: uuid,
    effectiveFrom: calendarDate,
    area: minimumWageAreaSchema,
    occupation: minimumWageOccupationSchema,
    monthlyMinor: minor,
    dailyMinor: minor.nullable(),
    hourlyMinor: minor.nullable(),
    source: z.string(),
    status: ruleVerificationStatusSchema,
    createdAt: timestamp,
  })
  .strict();
export type MinimumWage = z.infer<typeof minimumWageSchema>;

export const payrollRulesResponseSchema = z
  .object({
    today: calendarDate,
    rules: z.array(statutoryRuleSchema),
    minimumWages: z.array(minimumWageSchema),
    occupationByCategory: z.record(z.string(), minimumWageOccupationSchema),
    permissions: z.object({ canManage: z.boolean(), canVerify: z.boolean() }).strict(),
    production: z.boolean(),
  })
  .strict();
export type PayrollRulesResponse = z.infer<typeof payrollRulesResponseSchema>;
export const verifyStatutoryRuleRequestSchema = z.object({ note: payrollReasonSchema }).strict();
export const statutoryRuleResponseSchema = z.object({ rule: statutoryRuleSchema }).strict();
export const createMinimumWageRequestSchema = z
  .object({
    effectiveFrom: calendarDate,
    area: minimumWageAreaSchema,
    occupation: minimumWageOccupationSchema,
    monthlyMinor: positiveMinor,
    dailyMinor: positiveMinor.nullable().default(null),
    hourlyMinor: positiveMinor.nullable().default(null),
    source: text(10, 2000),
  })
  .strict();
export const minimumWageResponseSchema = z.object({ minimumWage: minimumWageSchema }).strict();

// Allowances --------------------------------------------------------------------------------------

export const allowanceSchema = z
  .object({
    id: uuid,
    projectId: uuid,
    code: z.string(),
    nameEn: z.string(),
    nameSw: z.string(),
    basis: allowanceBasisSchema,
    amountMinor: minor,
    taxable: z.boolean(),
    trade: z.object({ id: uuid, nameEn: z.string(), nameSw: z.string() }).strict().nullable(),
    labourer: labourerRef.nullable(),
    effectiveFrom: calendarDate,
    endedOn: calendarDate.nullable(),
    createdBy: actor,
    createdAt: timestamp,
  })
  .strict();
export type Allowance = z.infer<typeof allowanceSchema>;
export const allowancesResponseSchema = z
  .object({
    project: projectRef,
    today: calendarDate,
    allowances: z.array(allowanceSchema),
    trades: z.array(z.object({ id: uuid, nameEn: z.string(), nameSw: z.string() }).strict()),
    canManage: z.boolean(),
  })
  .strict();
export type AllowancesResponse = z.infer<typeof allowancesResponseSchema>;
export const createAllowanceRequestSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, "invalid_code"),
    nameEn: text(2, 80),
    nameSw: text(2, 80),
    basis: allowanceBasisSchema,
    amountMinor: positiveMinor.refine((value) => value <= 100_000_000, "amount_too_large"),
    taxable: z.boolean(),
    tradeId: uuid.nullable().default(null),
    labourerId: uuid.nullable().default(null),
    effectiveFrom: calendarDate,
  })
  .strict()
  .refine((value) => !(value.tradeId && value.labourerId), {
    message: "trade_or_labourer",
    path: ["labourerId"],
  });
export const endAllowanceRequestSchema = z.object({ endedOn: calendarDate }).strict();
export const allowanceResponseSchema = z.object({ allowance: allowanceSchema }).strict();

// Piece-rate output -------------------------------------------------------------------------------

export const outputShareSchema = z
  .object({
    id: uuid,
    labourer: labourerRef,
    amountMinor: minor,
    batchId: uuid.nullable(),
  })
  .strict();
export const pieceRateOutputSchema = z
  .object({
    id: uuid,
    projectId: uuid,
    workDate: calendarDate,
    labourer: labourerRef.nullable(),
    gang: z.object({ id: uuid, name: z.string() }).strict().nullable(),
    bqItem: z.object({ id: uuid, ref: z.string().nullable() }).strict().nullable(),
    description: z.string(),
    unit: z.string(),
    quantity: z.string(),
    rateMinor: minor,
    amountMinor: minor,
    status: outputStatusSchema,
    version,
    recordedBy: actor,
    recordedAt: timestamp,
    decidedBy: actor.nullable(),
    decidedAt: timestamp.nullable(),
    decisionNote: z.string().nullable(),
    shares: z.array(outputShareSchema),
  })
  .strict();
export type PieceRateOutput = z.infer<typeof pieceRateOutputSchema>;
export const outputsResponseSchema = z
  .object({
    project: projectRef,
    today: calendarDate,
    outputs: z.array(pieceRateOutputSchema),
    gangs: z.array(z.object({ id: uuid, name: z.string(), members: z.number().int() }).strict()),
    permissions: z.object({ canRecord: z.boolean(), canDecide: z.boolean() }).strict(),
  })
  .strict();
export type OutputsResponse = z.infer<typeof outputsResponseSchema>;
export const outputListQuerySchema = z.object({ status: outputStatusSchema.optional() }).strict();
export const createOutputRequestSchema = z
  .object({
    workDate: calendarDate,
    labourerId: uuid.nullable().default(null),
    gangId: uuid.nullable().default(null),
    bqItemId: uuid.nullable().default(null),
    description: text(3, 200),
    unit: text(1, 20),
    quantity: z
      .string()
      .regex(/^\d{1,9}(\.\d{1,3})?$/, "invalid_quantity")
      .refine((value) => Number(value) > 0, "quantity_not_positive"),
    rateMinor: positiveMinor.refine((value) => value <= 100_000_000, "amount_too_large"),
  })
  .strict()
  .refine((value) => Boolean(value.labourerId) !== Boolean(value.gangId), {
    message: "labourer_or_gang",
    path: ["gangId"],
  });
export const approveOutputRequestSchema = z
  .object({ version, note: z.string().trim().max(500).optional() })
  .strict();
export const rejectOutputRequestSchema = z.object({ version, note: payrollReasonSchema }).strict();
export const outputResponseSchema = z.object({ output: pieceRateOutputSchema }).strict();

// Advances ----------------------------------------------------------------------------------------

export const advanceSchema = z
  .object({
    id: uuid,
    project: projectRef,
    labourer: labourerRef,
    amountMinor: minor,
    reason: z.string(),
    instalmentMinor: minor.nullable(),
    maxRecoveryPercent: z.string().nullable(),
    status: advanceStatusSchema,
    displayStatus: advanceDisplayStatusSchema,
    recoveredMinor: minor,
    outstandingMinor: minor,
    version,
    requestedBy: actor,
    requestedAt: timestamp,
    decidedBy: actor.nullable(),
    decidedAt: timestamp.nullable(),
    decisionNote: z.string().nullable(),
    disbursement: z
      .object({
        method: advanceDisbursementMethodSchema,
        reference: z.string(),
        paidOn: calendarDate,
        evidenceNote: z.string(),
        recordedBy: actor,
        recordedAt: timestamp,
      })
      .strict()
      .nullable(),
    cancelledBy: actor.nullable(),
    cancelledAt: timestamp.nullable(),
    cancellationReason: z.string().nullable(),
    recoveries: z.array(
      z
        .object({
          batchId: uuid,
          batchStatus: payrollBatchStatusSchema,
          periodStart: calendarDate,
          periodEnd: calendarDate,
          amountMinor: minor,
        })
        .strict(),
    ),
    permissions: z
      .object({ canDecide: z.boolean(), canDisburse: z.boolean(), canCancel: z.boolean() })
      .strict(),
  })
  .strict();
export type Advance = z.infer<typeof advanceSchema>;
export const advancesResponseSchema = z
  .object({
    today: calendarDate,
    advances: z.array(advanceSchema),
    limits: payrollSettingsSchema,
    requestableProjects: z.array(projectRef),
  })
  .strict();
export type AdvancesResponse = z.infer<typeof advancesResponseSchema>;
export const advanceListQuerySchema = z
  .object({
    projectId: uuid.optional(),
    labourerId: uuid.optional(),
    status: advanceStatusSchema.optional(),
  })
  .strict();
export const createAdvanceRequestSchema = z
  .object({
    labourerId: uuid,
    amountMinor: positiveMinor,
    reason: payrollReasonSchema,
    instalmentMinor: positiveMinor.nullable().default(null),
    maxRecoveryPercent: percent.nullable().default(null),
  })
  .strict()
  .refine((value) => value.instalmentMinor === null || value.instalmentMinor <= value.amountMinor, {
    message: "instalment_above_amount",
    path: ["instalmentMinor"],
  });
export const approveAdvanceRequestSchema = z
  .object({ version, note: z.string().trim().max(500).optional() })
  .strict();
export const rejectAdvanceRequestSchema = z.object({ version, note: payrollReasonSchema }).strict();
export const disburseAdvanceRequestSchema = z
  .object({
    version,
    method: advanceDisbursementMethodSchema,
    reference: text(3, 60),
    paidOn: calendarDate,
    evidenceNote: payrollReasonSchema,
  })
  .strict();
export const cancelAdvanceRequestSchema = z
  .object({ version, reason: payrollReasonSchema })
  .strict();
export const advanceResponseSchema = z.object({ advance: advanceSchema }).strict();

// Batches -----------------------------------------------------------------------------------------

export const payrollBatchSchema = z
  .object({
    id: uuid,
    projectId: uuid,
    periodStart: calendarDate,
    periodEnd: calendarDate,
    payDate: calendarDate,
    statutoryMonth: month,
    frequency: payFrequencySchema,
    status: payrollBatchStatusSchema,
    version,
    unverifiedRules: z.boolean(),
    lineCount: z.number().int().min(0),
    grossMinor: minor,
    totalDeductionsMinor: minor,
    netMinor: minor,
    employerCostMinor: minor,
    /** The calculation digest (draft) or the frozen snapshot digest (submitted). */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    calculatedAt: timestamp,
    createdBy: actor,
    createdAt: timestamp,
    submittedBy: actor.nullable(),
    submittedAt: timestamp.nullable(),
    cancelledBy: actor.nullable(),
    cancelledAt: timestamp.nullable(),
    cancellationReason: z.string().nullable(),
  })
  .strict();
export type PayrollBatch = z.infer<typeof payrollBatchSchema>;

export const payPeriodRowSchema = z
  .object({
    startDate: calendarDate,
    endDate: calendarDate,
    payDate: calendarDate,
    ended: z.boolean(),
    batch: payrollBatchSchema.nullable(),
    timesheetPeriods: z
      .object({ approved: z.number().int(), notApproved: z.number().int() })
      .strict(),
  })
  .strict();
export type PayPeriodRow = z.infer<typeof payPeriodRowSchema>;

export const projectPayrollResponseSchema = z
  .object({
    project: projectRef,
    today: calendarDate,
    calendar: payCalendarSchema,
    periods: z.array(payPeriodRowSchema),
    batches: z.array(payrollBatchSchema),
    permissions: z
      .object({
        canPrepare: z.boolean(),
        canRecordOutput: z.boolean(),
        canDecideOutput: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ProjectPayrollResponse = z.infer<typeof projectPayrollResponseSchema>;

export const payrollOverviewResponseSchema = z
  .object({
    today: calendarDate,
    production: z.boolean(),
    unverifiedRuleVersions: z.number().int(),
    projects: z.array(
      z
        .object({
          project: projectRef,
          calendar: payCalendarSchema,
          current: payPeriodRowSchema,
          drafts: z.number().int(),
          submitted: z.number().int(),
          canPrepare: z.boolean(),
        })
        .strict(),
    ),
    permissions: z
      .object({
        canViewRules: z.boolean(),
        canExport: z.boolean(),
        canSeeAdvances: z.boolean(),
        canConfigure: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type PayrollOverviewResponse = z.infer<typeof payrollOverviewResponseSchema>;

const overtimeMinutes = z
  .object(
    Object.fromEntries(DAY_TYPES.map((type) => [type, z.number().int()])) as {
      [K in (typeof DAY_TYPES)[number]]: z.ZodNumber;
    },
  )
  .strict();
const employeeAmounts = z
  .object(
    Object.fromEntries(EMPLOYEE_STATUTORY.map((item) => [item, minor])) as {
      [K in (typeof EMPLOYEE_STATUTORY)[number]]: typeof minor;
    },
  )
  .strict();
const employerAmounts = z
  .object(
    Object.fromEntries(EMPLOYER_COSTS.map((item) => [item, minor])) as {
      [K in (typeof EMPLOYER_COSTS)[number]]: typeof minor;
    },
  )
  .strict();

export const payrollLineSummarySchema = z
  .object({
    id: uuid,
    labourer: labourerRef,
    engagementType: z.enum(ENGAGEMENT_TYPES),
    rateBasis: z.enum(RATE_BASES),
    /** Days worked as a decimal string from half-day units ("4.5"). */
    days: z.string(),
    daysWorked: z.number().int(),
    halfDays: z.number().int(),
    normalMinutes: z.number().int(),
    overtimeMinutes,
    grossMinor: minor,
    statutoryWithheldMinor: minor,
    advanceRecoveryMinor: minor,
    netMinor: minor,
    employerCostMinor: minor,
    warnings: z.array(payrollWarningSchema),
  })
  .strict();
export type PayrollLineSummary = z.infer<typeof payrollLineSummarySchema>;

export const payrollExclusionSchema = z
  .object({
    sourceKind: z.enum(["timesheet_line", "piece_rate_share"]),
    sourceId: uuid,
    labourer: labourerRef.nullable(),
    reason: payrollExclusionReasonSchema,
    date: calendarDate.nullable(),
  })
  .strict();
export type PayrollExclusion = z.infer<typeof payrollExclusionSchema>;

export const payrollTotalsSchema = z
  .object({
    lines: z.number().int(),
    grossMinor: minor,
    statutoryBaseMinor: minor,
    employee: employeeAmounts,
    advanceRecoveryMinor: minor,
    otherDeductionsMinor: minor,
    totalDeductionsMinor: minor,
    netMinor: minor,
    employer: employerAmounts,
    employerCostMinor: minor,
    shortfallMinor: minor,
  })
  .strict();
export type PayrollTotals = z.infer<typeof payrollTotalsSchema>;

export const batchRuleRefSchema = z
  .object({
    id: uuid,
    kind: z.union([statutoryRuleKindSchema, z.literal("timesheet")]),
    effectiveFrom: calendarDate,
    status: ruleVerificationStatusSchema,
  })
  .strict();

export const batchDetailResponseSchema = z
  .object({
    project: projectRef,
    batch: payrollBatchSchema,
    totals: payrollTotalsSchema,
    lines: z.array(payrollLineSummarySchema),
    exclusions: z.array(payrollExclusionSchema),
    unapprovedPeriods: z.array(
      z
        .object({
          id: uuid,
          startDate: calendarDate,
          endDate: calendarDate,
          status: z.enum(["open", "submitted", "rejected"]),
        })
        .strict(),
    ),
    pendingOutputs: z.number().int(),
    rules: z.array(batchRuleRefSchema),
    snapshot: z
      .object({ digest: z.string().nullable(), verified: z.boolean().nullable() })
      .strict(),
    production: z.boolean(),
    permissions: z
      .object({
        canRecalculate: z.boolean(),
        canSubmit: z.boolean(),
        canCancel: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type BatchDetailResponse = z.infer<typeof batchDetailResponseSchema>;

export const createBatchRequestSchema = z.object({ periodStart: calendarDate }).strict();
export const batchActionRequestSchema = z.object({ version }).strict();
export const cancelBatchRequestSchema = z.object({ version, reason: payrollReasonSchema }).strict();

export const payslipEarningSchema = z
  .object({
    kind: z.enum(EARNING_KINDS),
    category: z.enum(DAY_TYPES).nullable(),
    date: calendarDate.nullable(),
    description: z.string(),
    quantity: z.string(),
    unit: z.string(),
    rateMinor: minor.nullable(),
    multiplier: z.string().nullable(),
    labourRateId: uuid.nullable(),
    amountMinor: minor,
    taxable: z.boolean(),
  })
  .strict();
export const payslipResponseSchema = z
  .object({
    company: z.string(),
    project: projectRef,
    batch: payrollBatchSchema,
    line: payrollLineSummarySchema.extend({
      trade: z.object({ nameEn: z.string(), nameSw: z.string() }).strict().nullable(),
      earnings: z.array(payslipEarningSchema),
      deductions: z.array(
        z
          .object({
            kind: z.enum(EMPLOYEE_STATUTORY),
            dueMinor: minor,
            withheldMinor: minor,
            shortfallMinor: minor,
            ruleVersionId: uuid,
          })
          .strict(),
      ),
      recoveries: z.array(
        z.object({ advanceId: uuid, amountMinor: minor, outstandingAfterMinor: minor }).strict(),
      ),
      employerCosts: z.array(
        z
          .object({ kind: z.enum(EMPLOYER_COSTS), amountMinor: minor, ruleVersionId: uuid })
          .strict(),
      ),
      monthToDate: z
        .object({
          statutoryMonth: month,
          priorBatches: z.number().int(),
          priorBaseMinor: minor,
          cumulativeBaseMinor: minor,
          taxablePayMinor: minor,
          payeBeforeReliefMinor: minor,
          personalReliefMinor: minor,
          monthly: employeeAmounts,
        })
        .strict(),
      advanceBalanceMinor: minor,
    }),
  })
  .strict();
export type PayslipResponse = z.infer<typeof payslipResponseSchema>;

export const batchSnapshotResponseSchema = z
  .object({
    batchId: uuid,
    status: payrollBatchStatusSchema,
    version,
    digest: z.string(),
    recomputedDigest: z.string(),
    matches: z.boolean(),
    snapshot: z.record(z.string(), z.unknown()),
  })
  .strict();
export type BatchSnapshotResponse = z.infer<typeof batchSnapshotResponseSchema>;

// Statutory exports -------------------------------------------------------------------------------

export const exportQuerySchema = z.object({ month }).strict();
export const exportRequestSchema = z.object({ month, kind: payrollExportKindSchema }).strict();
export const exportSummaryResponseSchema = z
  .object({
    month,
    production: z.boolean(),
    batches: z.array(
      z
        .object({
          id: uuid,
          project: projectRef,
          periodStart: calendarDate,
          periodEnd: calendarDate,
          payDate: calendarDate,
          unverifiedRules: z.boolean(),
        })
        .strict(),
    ),
    employees: z.number().int(),
    totals: z
      .object({
        grossMinor: minor,
        employee: employeeAmounts,
        employer: employerAmounts,
        shortfallMinor: minor,
      })
      .strict(),
    missingIdentifiers: z
      .object({
        kraPin: z.number().int(),
        nssfNumber: z.number().int(),
        shaNumber: z.number().int(),
      })
      .strict(),
    unverified: z.boolean(),
    blocked: z.boolean(),
    canExport: z.boolean(),
  })
  .strict();
export type ExportSummaryResponse = z.infer<typeof exportSummaryResponseSchema>;
