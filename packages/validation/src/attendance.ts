import { entryIssues, parseClock, ruleIssues, type AttendanceEntry } from "@pm-buddy/domain";
import {
  ANOMALY_DECISIONS,
  ANOMALY_KINDS,
  ANOMALY_SEVERITIES,
  ANOMALY_STATUSES,
  ATTENDANCE_DAY_STATUSES,
  ATTENDANCE_STATUSES,
  CAPTURE_METHODS,
  DAY_TYPES,
  DECISION_STATUSES,
  HOLIDAY_KINDS,
  ISO_WEEKDAYS,
  LABOURER_STATUSES,
  PERIOD_FREQUENCIES,
  PROJECT_STATUSES,
  RULE_COMPLIANCE_STATUSES,
  TIMESHEET_PERIOD_STATUSES,
  TIMESHEET_RULE_LIMITS,
  type IsoWeekday,
} from "@pm-buddy/types";
import { z } from "zod";

/**
 * Attendance and timesheets (D3.3, web-only slice): settings (timesheet rule versions, the period
 * cut-off and the public holiday calendar), the daily muster roll, day submission and confirmation,
 * corrections, anomalies, timesheet periods with their approved snapshot (the payroll-facing
 * contract) and adjustments. Requests are strict; times travel as 24-hour "HH:MM" strings and
 * durations as integer minutes; day counts as integer half-day units plus a decimal string.
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();
const version = z.number().int().min(1).max(2_147_483_647);
const minutes = z.number().int().min(-1_000_000_000).max(1_000_000_000);
const actor = z.object({ id: uuid, displayName: z.string().min(1).max(100) }).strict();
/** A reason for a correction, adjustment, rejection or anomaly decision: 10–500 characters. */
export const attendanceReasonSchema = z.string().trim().min(10).max(500);
const optionalNote = z
  .string()
  .trim()
  .max(500)
  .refine((value) => value.length === 0 || value.length >= 3, "note_too_short");

export const captureMethodSchema = z.enum(CAPTURE_METHODS);
export const attendanceStatusSchema = z.enum(ATTENDANCE_STATUSES);
export const attendanceDayStatusSchema = z.enum(ATTENDANCE_DAY_STATUSES);
export const timesheetPeriodStatusSchema = z.enum(TIMESHEET_PERIOD_STATUSES);
export const decisionStatusSchema = z.enum(DECISION_STATUSES);
export const dayTypeSchema = z.enum(DAY_TYPES);
export const anomalyKindSchema = z.enum(ANOMALY_KINDS);
export const anomalySeveritySchema = z.enum(ANOMALY_SEVERITIES);
export const anomalyStatusSchema = z.enum(ANOMALY_STATUSES);
export const holidayKindSchema = z.enum(HOLIDAY_KINDS);
export const ruleComplianceStatusSchema = z.enum(RULE_COMPLIANCE_STATUSES);
export const isoWeekdaySchema = z
  .number()
  .int()
  .refine((value): value is IsoWeekday => (ISO_WEEKDAYS as readonly number[]).includes(value));

/** A 24-hour time of day, "07:30". */
export const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "invalid_time");

const toEntry = (value: {
  status: AttendanceEntry["status"];
  checkIn: string | null;
  checkOut: string | null;
  overnight: boolean;
  breakMinutes: number | null;
}): AttendanceEntry => ({
  status: value.status,
  checkIn: value.checkIn === null ? null : parseClock(value.checkIn),
  checkOut: value.checkOut === null ? null : parseClock(value.checkOut),
  overnight: value.overnight,
  breakMinutes: value.breakMinutes,
});

const entryFields = {
  status: attendanceStatusSchema,
  checkIn: clockSchema.nullable().default(null),
  checkOut: clockSchema.nullable().default(null),
  /** The shift ends the next morning (the record is dated on the start day). */
  overnight: z.boolean().default(false),
  /** Unpaid break in minutes; null applies the rule's default break. */
  breakMinutes: z.number().int().min(0).max(720).nullable().default(null),
  notes: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .default(null)
    .transform((value) => (value ? value : null)),
};

/** Domain entry checks (times required, check-out after check-in unless overnight, break). */
const checkEntry = (value: Parameters<typeof toEntry>[0], ctx: z.RefinementCtx): void => {
  for (const issue of entryIssues(toEntry(value)))
    ctx.addIssue({
      code: "custom",
      message: issue,
      path: [issue === "break_too_long" ? "breakMinutes" : "checkOut"],
    });
};

/** The values of a record as the muster roll shows them (also stored on corrections). */
export const attendanceEntryValuesSchema = z
  .object({
    status: attendanceStatusSchema,
    checkIn: clockSchema.nullable(),
    checkOut: clockSchema.nullable(),
    overnight: z.boolean(),
    breakMinutes: z.number().int().min(0).max(720).nullable(),
    notes: z.string().max(500).nullable(),
  })
  .strict();
export type AttendanceEntryValues = z.infer<typeof attendanceEntryValuesSchema>;

// Settings ---------------------------------------------------------------------------------------

const limit = (key: Exclude<keyof typeof TIMESHEET_RULE_LIMITS, "multiplier">) =>
  z.number().int().min(TIMESHEET_RULE_LIMITS[key].min).max(TIMESHEET_RULE_LIMITS[key].max);
const multiplierSchema = z.string().regex(/^\d{1,2}\.\d{2}$/, "invalid_multiplier");

const ruleValueFields = {
  normalMinutes: limit("normalMinutes"),
  defaultBreakMinutes: limit("defaultBreakMinutes"),
  breakAfterMinutes: limit("breakAfterMinutes"),
  dayStartMinutes: limit("dayStartMinutes"),
  lateGraceMinutes: limit("lateGraceMinutes"),
  halfDayThresholdMinutes: limit("halfDayThresholdMinutes"),
  maxPlausibleMinutes: limit("maxPlausibleMinutes"),
  restDays: z.array(isoWeekdaySchema).max(6),
  otWeekdayMultiplier: multiplierSchema,
  otRestDayMultiplier: multiplierSchema,
  otHolidayMultiplier: multiplierSchema,
};

export const timesheetRuleSchema = z
  .object({
    id: uuid,
    /** Null for the company default; otherwise a project override. */
    projectId: uuid.nullable(),
    projectCode: z.string().nullable(),
    effectiveFrom: calendarDate,
    /** The day before the next version of the same scope starts; null while it is the latest. */
    effectiveTo: calendarDate.nullable(),
    inForce: z.boolean(),
    scheduled: z.boolean(),
    ...ruleValueFields,
    complianceStatus: ruleComplianceStatusSchema,
    sourceReference: z.string().min(1).max(300),
    createdAt: timestamp,
    createdBy: actor,
  })
  .strict();
export type TimesheetRule = z.infer<typeof timesheetRuleSchema>;

export const createTimesheetRuleRequestSchema = z
  .object({
    projectId: uuid.nullable().default(null),
    effectiveFrom: calendarDate,
    ...ruleValueFields,
    sourceReference: z.string().trim().min(3).max(300),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const issue of ruleIssues(value)) ctx.addIssue({ code: "custom", message: issue });
  });
export type CreateTimesheetRuleRequest = z.input<typeof createTimesheetRuleRequestSchema>;
export const timesheetRuleResponseSchema = z.object({ rule: timesheetRuleSchema }).strict();

export const periodSettingsSchema = z
  .object({
    frequency: z.enum(PERIOD_FREQUENCIES),
    weekEndsOn: isoWeekdaySchema,
    cutoffTime: clockSchema,
    paydayWeekday: isoWeekdaySchema,
    /** 0 while the company uses the defaults (no settings row yet). */
    version: z.number().int().min(0),
  })
  .strict();
export type PeriodSettingsWire = z.infer<typeof periodSettingsSchema>;
export const updatePeriodSettingsRequestSchema = z
  .object({
    weekEndsOn: isoWeekdaySchema,
    cutoffTime: clockSchema,
    paydayWeekday: isoWeekdaySchema,
    version: z.number().int().min(0),
  })
  .strict();

export const publicHolidaySchema = z
  .object({
    id: uuid,
    date: calendarDate,
    nameEn: z.string().min(1).max(120),
    nameSw: z.string().min(1).max(120),
    kind: holidayKindSchema,
    source: z.string().min(1).max(400),
    complianceStatus: ruleComplianceStatusSchema,
    /** Inside a submitted or approved period of some project: it can no longer change. */
    locked: z.boolean(),
  })
  .strict();
export type PublicHoliday = z.infer<typeof publicHolidaySchema>;
export const createHolidayRequestSchema = z
  .object({
    date: calendarDate,
    nameEn: z.string().trim().min(3).max(120),
    nameSw: z.string().trim().min(3).max(120),
    kind: holidayKindSchema,
    source: z.string().trim().min(3).max(400),
  })
  .strict();
export const holidayResponseSchema = z.object({ holiday: publicHolidaySchema }).strict();

const projectRef = z.object({ id: uuid, code: z.string(), name: z.string() }).strict();

export const attendanceSettingsResponseSchema = z
  .object({
    today: calendarDate,
    periodSettings: periodSettingsSchema,
    rules: z.array(timesheetRuleSchema),
    holidays: z.array(publicHolidaySchema),
    /** config.manage: company rules, holidays and the period cut-off. */
    canConfigure: z.boolean(),
    /** Projects on which the caller may add project rule overrides (timesheets.manage_rules). */
    ruleProjects: z.array(projectRef),
  })
  .strict();
export type AttendanceSettingsResponse = z.infer<typeof attendanceSettingsResponseSchema>;

// Overview ---------------------------------------------------------------------------------------

export const timesheetPeriodSummarySchema = z
  .object({
    id: uuid.nullable(),
    startDate: calendarDate,
    endDate: calendarDate,
    cutoffAt: timestamp,
    status: timesheetPeriodStatusSchema,
    due: z.boolean(),
  })
  .strict();

export const attendanceOverviewResponseSchema = z
  .object({
    today: calendarDate,
    projects: z.array(
      z
        .object({
          id: uuid,
          code: z.string(),
          name: z.string(),
          status: z.enum(PROJECT_STATUSES),
          sites: z.array(
            z
              .object({
                id: uuid,
                name: z.string(),
                today: z
                  .object({
                    dayId: uuid.nullable(),
                    status: attendanceDayStatusSchema.nullable(),
                    records: z.number().int().min(0),
                  })
                  .strict(),
              })
              .strict(),
          ),
          openAnomalies: z.number().int().min(0),
          pendingCorrections: z.number().int().min(0),
          pendingAdjustments: z.number().int().min(0),
          periodsAwaitingApproval: z.number().int().min(0),
          currentPeriod: timesheetPeriodSummarySchema,
          canRecord: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type AttendanceOverviewResponse = z.infer<typeof attendanceOverviewResponseSchema>;

// Muster roll ------------------------------------------------------------------------------------

export const musterQuerySchema = z
  .object({ siteId: uuid, date: calendarDate, gangId: uuid.optional() })
  .strict();

export const recordComputationSchema = z
  .object({
    dayType: dayTypeSchema,
    halfDays: z.number().int().min(0).max(2),
    workedMinutes: minutes,
    normalMinutes: minutes,
    overtimeMinutes: minutes,
    lateMinutes: minutes,
    breakMinutes: minutes,
  })
  .strict();

export const anomalyBadgeSchema = z
  .object({
    id: uuid,
    kind: anomalyKindSchema,
    severity: anomalySeveritySchema,
    status: anomalyStatusSchema,
  })
  .strict();

export const attendanceRecordSchema = z
  .object({
    id: uuid,
    ...attendanceEntryValuesSchema.shape,
    captureMethod: captureMethodSchema,
    /** A correction was applied after the day was submitted. */
    corrected: z.boolean(),
    version,
    recordedBy: actor,
    updatedAt: timestamp,
    /** The record's share of the labourer's day; null when no rule is configured. */
    computed: recordComputationSchema.nullable(),
  })
  .strict();
export type AttendanceRecord = z.infer<typeof attendanceRecordSchema>;

export const attendanceDaySchema = z
  .object({
    id: uuid,
    status: attendanceDayStatusSchema,
    version,
    submittedBy: actor.nullable(),
    submittedAt: timestamp.nullable(),
    confirmedBy: actor.nullable(),
    confirmedAt: timestamp.nullable(),
    returnedBy: actor.nullable(),
    returnedAt: timestamp.nullable(),
    returnReason: z.string().nullable(),
    recorders: z.array(actor),
  })
  .strict();

export const correctionSchema = z
  .object({
    id: uuid,
    dayId: uuid,
    recordId: uuid.nullable(),
    labourerId: uuid,
    workerNo: z.string(),
    fullName: z.string(),
    siteId: uuid,
    date: calendarDate,
    proposed: attendanceEntryValuesSchema,
    previous: attendanceEntryValuesSchema.nullable(),
    reason: z.string(),
    status: decisionStatusSchema,
    requestedBy: actor,
    requestedAt: timestamp,
    decidedBy: actor.nullable(),
    decidedAt: timestamp.nullable(),
    decisionNote: z.string().nullable(),
    version,
  })
  .strict();
export type Correction = z.infer<typeof correctionSchema>;

export const musterRowSchema = z
  .object({
    labourer: z
      .object({
        id: uuid,
        workerNo: z.string(),
        fullName: z.string(),
        tradeNameEn: z.string(),
        tradeNameSw: z.string(),
        status: z.enum(LABOURER_STATUSES),
        doNotRehire: z.boolean(),
        gangId: uuid.nullable(),
        gangName: z.string().nullable(),
        /** Engaged on the project on this date (only engaged labourers can be recorded). */
        engaged: z.boolean(),
      })
      .strict(),
    record: attendanceRecordSchema.nullable(),
    anomalies: z.array(anomalyBadgeSchema),
    /** The same labourer's records on other sites that day. */
    otherSites: z.array(
      z
        .object({
          siteId: uuid,
          siteName: z.string(),
          projectCode: z.string(),
          status: attendanceStatusSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type MusterRow = z.infer<typeof musterRowSchema>;

export const MUSTER_LOCKS = [
  "future-date",
  "project-read-only",
  "period-submitted",
  "period-approved",
  "day-submitted",
  "day-confirmed",
] as const;

export const musterResponseSchema = z
  .object({
    project: z
      .object({
        id: uuid,
        code: z.string(),
        name: z.string(),
        status: z.enum(PROJECT_STATUSES),
      })
      .strict(),
    site: z.object({ id: uuid, name: z.string() }).strict(),
    sites: z.array(z.object({ id: uuid, name: z.string() }).strict()),
    gangs: z.array(z.object({ id: uuid, name: z.string() }).strict()),
    gangId: uuid.nullable(),
    date: calendarDate,
    today: calendarDate,
    dayType: dayTypeSchema.nullable(),
    holiday: z.object({ nameEn: z.string(), nameSw: z.string() }).strict().nullable(),
    rule: timesheetRuleSchema.nullable(),
    period: timesheetPeriodSummarySchema,
    day: attendanceDaySchema.nullable(),
    rows: z.array(musterRowSchema),
    corrections: z.array(correctionSchema),
    /** Records can be entered or changed directly (a draft day in an editable period). */
    editable: z.boolean(),
    locked: z.enum(MUSTER_LOCKS).nullable(),
    permissions: z
      .object({
        canRecord: z.boolean(),
        canConfirm: z.boolean(),
        canOverride: z.boolean(),
        canReview: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type MusterResponse = z.infer<typeof musterResponseSchema>;

export const musterEntrySchema = z
  .object({
    labourerId: uuid,
    ...entryFields,
    /** The record version read; 0 for a labourer without a record yet. */
    version: z.number().int().min(0),
  })
  .strict()
  .superRefine(checkEntry);
export type MusterEntryInput = z.input<typeof musterEntrySchema>;

export const saveMusterRequestSchema = z
  .object({
    siteId: uuid,
    date: calendarDate,
    /** The day version read; 0 when the day has no records yet. */
    dayVersion: z.number().int().min(0),
    entries: z.array(musterEntrySchema).min(1).max(500),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.entries.map((entry) => entry.labourerId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "duplicate_labourer", path: ["entries"] });
  });
export type SaveMusterRequest = z.input<typeof saveMusterRequestSchema>;

export const dayActionRequestSchema = z.object({ version }).strict();
export const returnDayRequestSchema = z
  .object({ version, reason: attendanceReasonSchema })
  .strict();

export const createCorrectionRequestSchema = z
  .object({
    labourerId: uuid,
    ...entryFields,
    reason: attendanceReasonSchema,
    /** The record version read; 0 when the labourer had no record that day. */
    recordVersion: z.number().int().min(0),
  })
  .strict()
  .superRefine(checkEntry);
export type CreateCorrectionRequest = z.input<typeof createCorrectionRequestSchema>;
export const approveDecisionRequestSchema = z
  .object({ version, note: optionalNote.optional() })
  .strict();
export const rejectDecisionRequestSchema = z
  .object({ version, note: attendanceReasonSchema })
  .strict();
export const correctionResponseSchema = z.object({ correction: correctionSchema }).strict();
export const correctionsResponseSchema = z
  .object({ corrections: z.array(correctionSchema) })
  .strict();
export const correctionListQuerySchema = z
  .object({ status: decisionStatusSchema.optional() })
  .strict();

// Anomalies --------------------------------------------------------------------------------------

const detailValue = z.union([
  z.string().max(200),
  z.number().int(),
  z.boolean(),
  z.array(z.string().max(64)).max(20),
]);

export const anomalySchema = z
  .object({
    id: uuid,
    projectId: uuid,
    projectCode: z.string(),
    siteId: uuid,
    siteName: z.string(),
    recordId: uuid,
    labourerId: uuid,
    workerNo: z.string(),
    fullName: z.string(),
    date: calendarDate,
    kind: anomalyKindSchema,
    severity: anomalySeveritySchema,
    status: anomalyStatusSchema,
    details: z.record(z.string(), detailValue),
    correctionId: uuid.nullable(),
    detectedAt: timestamp,
    recordedBy: actor,
    reviewedBy: actor.nullable(),
    reviewedAt: timestamp.nullable(),
    reviewNote: z.string().nullable(),
    version,
  })
  .strict();
export type Anomaly = z.infer<typeof anomalySchema>;

export const anomalyListQuerySchema = z
  .object({
    projectId: uuid.optional(),
    status: anomalyStatusSchema.optional(),
    kind: anomalyKindSchema.optional(),
    from: calendarDate.optional(),
    to: calendarDate.optional(),
  })
  .strict();
export const anomaliesResponseSchema = z
  .object({
    anomalies: z.array(anomalySchema),
    counts: z
      .object({
        open: z.number().int().min(0),
        critical: z.number().int().min(0),
      })
      .strict(),
    reviewableProjectIds: z.array(uuid),
    projects: z.array(projectRef),
  })
  .strict();
export type AnomaliesResponse = z.infer<typeof anomaliesResponseSchema>;
export const reviewAnomalyRequestSchema = z
  .object({
    decision: z.enum(ANOMALY_DECISIONS),
    note: attendanceReasonSchema,
    version,
  })
  .strict();
export const anomalyResponseSchema = z.object({ anomaly: anomalySchema }).strict();

// Periods and timesheets -------------------------------------------------------------------------

export const timesheetTotalsSchema = z
  .object({
    /** Day count as a decimal string ("4.5"); `halfDays` is the exact integer. */
    days: z.string().regex(/^-?\d+(\.5)?$/),
    halfDays: z.number().int(),
    workedMinutes: minutes,
    normalMinutes: minutes,
    overtimeMinutes: z
      .object({ weekday: minutes, rest_day: minutes, public_holiday: minutes })
      .strict(),
    lateMinutes: minutes,
    statusCounts: z
      .object({
        present: z.number().int(),
        half_day: z.number().int(),
        absent: z.number().int(),
        leave: z.number().int(),
        sick: z.number().int(),
      })
      .strict(),
  })
  .strict();
export type TimesheetTotalsWire = z.infer<typeof timesheetTotalsSchema>;

export const timesheetLineDaySchema = z
  .object({
    date: calendarDate,
    dayType: dayTypeSchema,
    /** Null only while no rule is configured for the date (the period cannot be submitted). */
    ruleVersionId: uuid.nullable(),
    totals: timesheetTotalsSchema,
    recordIds: z.array(uuid),
  })
  .strict();

export const timesheetLineSchema = z
  .object({
    labourerId: uuid,
    workerNo: z.string(),
    fullName: z.string(),
    kind: z.enum(["attendance", "adjustment"]),
    adjustmentId: uuid.nullable(),
    originalPeriodId: uuid.nullable(),
    totals: timesheetTotalsSchema,
    ruleVersionIds: z.array(uuid),
    recordIds: z.array(uuid),
    days: z.array(timesheetLineDaySchema),
  })
  .strict();
export type TimesheetLine = z.infer<typeof timesheetLineSchema>;

export const timesheetPeriodSchema = z
  .object({
    id: uuid,
    projectId: uuid,
    startDate: calendarDate,
    endDate: calendarDate,
    cutoffAt: timestamp,
    status: timesheetPeriodStatusSchema,
    due: z.boolean(),
    version,
    submittedBy: actor.nullable(),
    submittedAt: timestamp.nullable(),
    approvedBy: actor.nullable(),
    approvedAt: timestamp.nullable(),
    rejectedBy: actor.nullable(),
    rejectedAt: timestamp.nullable(),
    rejectionReason: z.string().nullable(),
    /** SHA-256 of the computed lines when submitted; approval must see the same content. */
    submittedDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict();
export type TimesheetPeriod = z.infer<typeof timesheetPeriodSchema>;

export const periodListItemSchema = z
  .object({
    period: timesheetPeriodSchema,
    days: z.number().int().min(0),
    unconfirmedDays: z.number().int().min(0),
    openAnomalies: z.number().int().min(0),
    labourers: z.number().int().min(0),
  })
  .strict();
export const periodsResponseSchema = z
  .object({
    project: projectRef,
    periods: z.array(periodListItemSchema),
    settings: periodSettingsSchema,
    pendingAdjustments: z.number().int().min(0),
  })
  .strict();
export type PeriodsResponse = z.infer<typeof periodsResponseSchema>;

export const adjustmentSchema = z
  .object({
    id: uuid,
    projectId: uuid,
    originalPeriodId: uuid,
    targetPeriodId: uuid.nullable(),
    labourerId: uuid,
    workerNo: z.string(),
    fullName: z.string(),
    siteId: uuid,
    siteName: z.string(),
    date: calendarDate,
    recordId: uuid.nullable(),
    proposed: attendanceEntryValuesSchema,
    previous: attendanceEntryValuesSchema.nullable(),
    reason: z.string(),
    status: decisionStatusSchema,
    requestedBy: actor,
    requestedAt: timestamp,
    decidedBy: actor.nullable(),
    decidedAt: timestamp.nullable(),
    decisionNote: z.string().nullable(),
    /** Change to the labourer's timesheet, fixed when approved. */
    delta: timesheetTotalsSchema.nullable(),
    version,
  })
  .strict();
export type Adjustment = z.infer<typeof adjustmentSchema>;

export const periodDetailResponseSchema = z
  .object({
    project: projectRef,
    period: timesheetPeriodSchema,
    /** `snapshot` for approved periods (immutable lines), `live` otherwise. */
    source: z.enum(["snapshot", "live"]),
    lines: z.array(timesheetLineSchema),
    totals: timesheetTotalsSchema,
    rules: z.array(timesheetRuleSchema),
    holidays: z.array(z.object({ date: calendarDate, nameEn: z.string(), nameSw: z.string() })),
    blockers: z
      .object({
        notDue: z.boolean(),
        unconfirmedDays: z.array(
          z
            .object({
              dayId: uuid,
              siteId: uuid,
              siteName: z.string(),
              date: calendarDate,
              status: attendanceDayStatusSchema,
            })
            .strict(),
        ),
        openAnomalies: z.number().int().min(0),
        missingRuleDates: z.array(calendarDate),
        pendingCorrections: z.number().int().min(0),
        /** Some rule version is unverified (COMPLIANCE-REVIEW); production refuses approval. */
        rulesUnverified: z.boolean(),
      })
      .strict(),
    adjustments: z
      .object({
        requested: z.array(adjustmentSchema),
        landed: z.array(adjustmentSchema),
      })
      .strict(),
    permissions: z
      .object({
        canSubmit: z.boolean(),
        /** Approve or reject: timesheets.approve, submitted, and the caller did not submit it. */
        canApprove: z.boolean(),
        canReopen: z.boolean(),
        canRequestAdjustment: z.boolean(),
        canDecideAdjustments: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type PeriodDetailResponse = z.infer<typeof periodDetailResponseSchema>;

export const periodActionRequestSchema = z.object({ version }).strict();
export const rejectPeriodRequestSchema = z
  .object({ version, reason: attendanceReasonSchema })
  .strict();

/**
 * The payroll-facing contract (D4.1): an approved period's immutable lines with the rule versions
 * (and their overtime multipliers) and public holidays they were computed with.
 */
export const timesheetLinesResponseSchema = z
  .object({
    project: projectRef,
    period: timesheetPeriodSchema,
    lines: z.array(timesheetLineSchema),
    ruleVersions: z.array(timesheetRuleSchema),
    holidays: z.array(z.object({ date: calendarDate, nameEn: z.string(), nameSw: z.string() })),
  })
  .strict();
export type TimesheetLinesResponse = z.infer<typeof timesheetLinesResponseSchema>;

export const createAdjustmentRequestSchema = z
  .object({
    labourerId: uuid,
    siteId: uuid,
    date: calendarDate,
    ...entryFields,
    reason: attendanceReasonSchema,
  })
  .strict()
  .superRefine(checkEntry);
export type CreateAdjustmentRequest = z.input<typeof createAdjustmentRequestSchema>;
export const adjustmentResponseSchema = z.object({ adjustment: adjustmentSchema }).strict();
export const adjustmentsResponseSchema = z
  .object({ adjustments: z.array(adjustmentSchema) })
  .strict();
export const adjustmentListQuerySchema = z
  .object({ status: decisionStatusSchema.optional() })
  .strict();

// Labourer summary -------------------------------------------------------------------------------

export const labourerAttendanceQuerySchema = z
  .object({ from: calendarDate.optional(), to: calendarDate.optional() })
  .strict();

export const labourerAttendanceResponseSchema = z
  .object({
    labourerId: uuid,
    from: calendarDate,
    to: calendarDate,
    projects: z.array(
      z
        .object({
          projectId: uuid,
          code: z.string(),
          name: z.string(),
          /** From approved timesheets (snapshot lines, adjustments included). */
          approved: timesheetTotalsSchema,
          /** Recorded in periods not yet approved (computed with today's data). */
          pending: timesheetTotalsSchema,
          lastWorkedOn: calendarDate.nullable(),
        })
        .strict(),
    ),
    openAnomalies: z.number().int().min(0),
  })
  .strict();
export type LabourerAttendanceResponse = z.infer<typeof labourerAttendanceResponseSchema>;
