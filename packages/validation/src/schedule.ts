import {
  ACTIVITY_STATUSES,
  DELAY_CAUSES,
  DELAY_CLAIM_FLAGS,
  DELAY_STATUSES,
  DEPENDENCY_TYPES,
  MILESTONE_STATUSES,
  PROGRESS_BASES,
  SCHEDULE_ITEM_KINDS,
  SCHEDULE_LIMITS,
} from "@pm-buddy/types";
import { z } from "zod";
import { planningDateSchema } from "./primitives.js";

/**
 * Schedule (D6.2): activities, dependencies, the working calendar, baselines with variance and
 * the delay log. Requests are strict (a body never carries a tenant or project ID); responses are
 * strict so the web never trusts an unexpected shape. Dates are business dates (YYYY-MM-DD,
 * Africa/Nairobi).
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();
const version = z.number().int().min(1).max(2_147_483_647);
const reason = z.string().trim().min(3).max(500);
const person = z.strictObject({ id: uuid, displayName: z.string() });

export const scheduleItemKindSchema = z.enum(SCHEDULE_ITEM_KINDS);
export const dependencyTypeSchema = z.enum(DEPENDENCY_TYPES);
export const progressBasisSchema = z.enum(PROGRESS_BASES);
export const activityStatusSchema = z.enum(ACTIVITY_STATUSES);
export const delayCauseSchema = z.enum(DELAY_CAUSES);
export const delayClaimFlagSchema = z.enum(DELAY_CLAIM_FLAGS);
export const delayStatusSchema = z.enum(DELAY_STATUSES);

/** A task (schedule activity ID) or a project milestone (milestone ID). */
export const scheduleItemRefSchema = z.strictObject({ kind: scheduleItemKindSchema, id: uuid });

// Working calendar --------------------------------------------------------------------------------

const weekdays = z
  .array(z.number().int().min(1).max(7))
  .min(1)
  .max(7)
  .refine((days) => new Set(days).size === days.length, "duplicate_weekdays")
  .transform((days) => [...days].sort((a, b) => a - b));

export const scheduleCalendarSchema = z.strictObject({
  /** ISO weekdays worked (1 = Monday … 7 = Sunday). */
  workingWeekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  includePublicHolidays: z.boolean(),
  /** Company public holidays applied (0 when they are excluded). */
  holidaysApplied: z.number().int().min(0),
  /** 0 while the defaults have never been saved. */
  version: z.number().int().min(0),
});
export const scheduleCalendarResponseSchema = z.strictObject({ calendar: scheduleCalendarSchema });
export const updateScheduleCalendarRequestSchema = z.strictObject({
  workingWeekdays: weekdays,
  includePublicHolidays: z.boolean(),
  version: z.number().int().min(0).max(2_147_483_647),
});

// Activities --------------------------------------------------------------------------------------

export const activityCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,19}$/, "invalid_activity_code");
const activityName = z.string().trim().min(1).max(150);
const duration = z.number().int().min(1).max(SCHEDULE_LIMITS.maxDurationDays);

export const createActivityRequestSchema = z.strictObject({
  code: activityCodeSchema,
  name: activityName,
  wbsNodeId: uuid.nullable().optional(),
  /** A BQ item lineage in the project's newest approved BQ version (optional). */
  bqItemLineageId: uuid.nullable().optional(),
  durationDays: duration,
  startNoEarlierThan: planningDateSchema.nullable().optional(),
});
export const updateActivityRequestSchema = z
  .strictObject({
    code: activityCodeSchema.optional(),
    name: activityName.optional(),
    wbsNodeId: uuid.nullable().optional(),
    bqItemLineageId: uuid.nullable().optional(),
    durationDays: duration.optional(),
    startNoEarlierThan: planningDateSchema.nullable().optional(),
    version,
  })
  .refine(
    ({ version: _version, ...fields }) =>
      Object.values(fields).some((field) => field !== undefined),
    "no_changes",
  );

const quantity = z
  .string()
  .trim()
  .regex(/^\d{1,16}(\.\d{1,4})?$/, "invalid_quantity");
/** Actual dates and physical progress with its basis (whole percent, or quantity done of total). */
export const activityProgressRequestSchema = z
  .strictObject({
    version,
    actualStart: planningDateSchema.nullable(),
    actualFinish: planningDateSchema.nullable(),
    basis: progressBasisSchema,
    percentComplete: z.number().int().min(0).max(100).nullable().optional(),
    quantityDone: quantity.nullable().optional(),
    quantityTotal: quantity.nullable().optional(),
    quantityUnit: z.string().trim().min(1).max(20).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const quantityFields = [value.quantityDone, value.quantityTotal, value.quantityUnit];
    if (value.basis === "physical" && quantityFields.some((field) => field != null))
      ctx.addIssue({ code: "custom", path: ["basis"], message: "quantity_not_allowed" });
    if (value.basis === "quantity" && value.percentComplete != null)
      ctx.addIssue({ code: "custom", path: ["percentComplete"], message: "percent_not_allowed" });
  });

export const activityProgressSchema = z.strictObject({
  basis: progressBasisSchema,
  /** Physical progress 0–100 (quantity: done ÷ total, rounded down); null = not reported. */
  percentComplete: z.number().min(0).max(100).nullable(),
  quantityDone: z.string().nullable(),
  quantityTotal: z.string().nullable(),
  quantityUnit: z.string().nullable(),
});

const datePair = z.strictObject({ start: calendarDate, finish: calendarDate });

export const scheduleItemSchema = z.strictObject({
  kind: scheduleItemKindSchema,
  /** Task: the activity ID. Milestone: the milestone ID. */
  id: uuid,
  /** The schedule activity row (a task, or a milestone's link once it has dependencies). */
  activityId: uuid.nullable(),
  code: z.string().nullable(),
  name: z.string(),
  wbsNodeId: uuid.nullable(),
  bqItem: z
    .strictObject({
      lineageId: uuid,
      versionId: uuid,
      ref: z.string().nullable(),
      description: z.string(),
    })
    .nullable(),
  /** Planned working days (0 for milestones). */
  durationDays: z.number().int().min(0),
  startNoEarlierThan: calendarDate.nullable(),
  /** Milestones only. */
  dueDate: calendarDate.nullable(),
  milestoneStatus: z.enum(MILESTONE_STATUSES).nullable(),
  actualStart: calendarDate.nullable(),
  actualFinish: calendarDate.nullable(),
  progress: activityProgressSchema.nullable(),
  status: activityStatusSchema,
  /** The current schedule (CPM with progress at the data date). */
  planned: datePair,
  late: z.strictObject({ start: calendarDate.nullable(), finish: calendarDate.nullable() }),
  totalFloatDays: z.number().int().nullable(),
  critical: z.boolean(),
  /** The compared baseline's dates; null when there is no baseline or the item was not in it. */
  baseline: datePair.nullable(),
  /** Working days later (+) or earlier (−) than the baseline; null = unavailable. */
  variance: z.strictObject({
    startDays: z.number().int().nullable(),
    finishDays: z.number().int().nullable(),
  }),
  /** Task version (null for milestones, which are edited on the WBS tab). */
  version: version.nullable(),
  permissions: z.strictObject({
    canEdit: z.boolean(),
    canRecordProgress: z.boolean(),
    canDelete: z.boolean(),
  }),
});

export const scheduleDependencySchema = z.strictObject({
  id: uuid,
  predecessor: scheduleItemRefSchema,
  successor: scheduleItemRefSchema,
  type: dependencyTypeSchema,
  lagDays: z.number().int(),
  version,
  /** This link sets its successor's date. */
  driving: z.boolean(),
  /** Driving between two critical items. */
  critical: z.boolean(),
  permissions: z.strictObject({ canEdit: z.boolean(), canDelete: z.boolean() }),
});

export const scheduleBaselineSummarySchema = z.strictObject({
  id: uuid,
  number: z.number().int().min(1),
  name: z.string(),
  reason: z.string(),
  dataDate: calendarDate,
  projectFinish: calendarDate.nullable(),
  itemCount: z.number().int().min(0),
  createdAt: timestamp,
  createdBy: person,
  /** The newest baseline is current; re-baselining appends a new one. */
  current: z.boolean(),
  /** Baselines are immutable: never editable or deletable. */
  permissions: z.strictObject({ canEdit: z.literal(false), canDelete: z.literal(false) }),
});

export const scheduleResponseSchema = z.strictObject({
  projectId: uuid,
  calendar: scheduleCalendarSchema,
  /** Where the schedule starts: the project start date, or today when the project has none. */
  start: z.strictObject({ date: calendarDate, source: z.enum(["project_start", "today"]) }),
  /** Today in Africa/Nairobi: remaining work is scheduled from here. */
  dataDate: calendarDate,
  items: z.array(scheduleItemSchema),
  dependencies: z.array(scheduleDependencySchema),
  finish: calendarDate.nullable(),
  /** The compared baseline (the current one unless `baselineId` chose another). */
  baseline: scheduleBaselineSummarySchema.nullable(),
  currentBaselineId: uuid.nullable(),
  projectVariance: z.strictObject({
    baselineFinish: calendarDate.nullable(),
    finish: calendarDate.nullable(),
    finishDays: z.number().int().nullable(),
  }),
  /** Baseline items that are no longer in the schedule. */
  removedSinceBaseline: z.array(
    z.strictObject({
      kind: scheduleItemKindSchema,
      id: uuid,
      code: z.string().nullable(),
      name: z.string(),
    }),
  ),
  /** Duration-weighted physical progress of the tasks (not earned or certified value). */
  progress: z.strictObject({
    basis: z.literal("duration_weighted_physical"),
    ratio: z.number().min(0).max(1).nullable(),
  }),
  permissions: z.strictObject({
    canEdit: z.boolean(),
    canBaseline: z.boolean(),
    canRecordDelay: z.boolean(),
  }),
});

export const scheduleListQuerySchema = z.strictObject({ baselineId: uuid.optional() });

export const scheduleActivityResponseSchema = z.strictObject({ item: scheduleItemSchema });
export const scheduleDependencyResponseSchema = z.strictObject({
  dependency: scheduleDependencySchema,
});

export const createDependencyRequestSchema = z
  .strictObject({
    predecessor: scheduleItemRefSchema,
    successor: scheduleItemRefSchema,
    type: dependencyTypeSchema,
    lagDays: z.number().int().min(SCHEDULE_LIMITS.minLagDays).max(SCHEDULE_LIMITS.maxLagDays),
  })
  .refine(
    (value) =>
      value.predecessor.id !== value.successor.id ||
      value.predecessor.kind !== value.successor.kind,
    { message: "dependency_self", path: ["successor"] },
  );
export const updateDependencyRequestSchema = z
  .strictObject({
    type: dependencyTypeSchema.optional(),
    lagDays: z
      .number()
      .int()
      .min(SCHEDULE_LIMITS.minLagDays)
      .max(SCHEDULE_LIMITS.maxLagDays)
      .optional(),
    version,
  })
  .refine((value) => value.type !== undefined || value.lagDays !== undefined, "no_changes");

/** DELETE …?version=n: the version the caller saw. */
export const versionQuerySchema = z.strictObject({ version: z.coerce.number().pipe(version) });

// Baselines ---------------------------------------------------------------------------------------

export const createBaselineRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  reason,
});
export const scheduleBaselineItemSchema = z.strictObject({
  kind: scheduleItemKindSchema,
  id: uuid,
  code: z.string().nullable(),
  name: z.string(),
  start: calendarDate,
  finish: calendarDate,
  durationDays: z.number().int().min(0),
  totalFloatDays: z.number().int().nullable(),
  critical: z.boolean(),
});
export const scheduleBaselinesResponseSchema = z.strictObject({
  baselines: z.array(scheduleBaselineSummarySchema),
  permissions: z.strictObject({ canBaseline: z.boolean() }),
});
export const scheduleBaselineResponseSchema = z.strictObject({
  baseline: scheduleBaselineSummarySchema,
  items: z.array(scheduleBaselineItemSchema),
});

// Delay log ---------------------------------------------------------------------------------------

const workingDaysLost = z
  .number()
  .min(0)
  .max(SCHEDULE_LIMITS.maxDelayDays)
  .refine((value) => Number.isInteger(value * 2), "half_days_only");
const delayContent = {
  cause: delayCauseSchema,
  startDate: planningDateSchema,
  /** Null while the delay is ongoing. */
  endDate: planningDateSchema.nullable(),
  workingDaysLost,
  description: z.string().trim().min(3).max(2000),
  siteDiaryId: uuid.nullable().optional(),
  claimFlag: delayClaimFlagSchema.optional(),
  activityIds: z
    .array(uuid)
    .max(SCHEDULE_LIMITS.maxDelayActivities)
    .refine((ids) => new Set(ids).size === ids.length, "duplicate_ids"),
};
export const createDelayRequestSchema = z.strictObject(delayContent);
export const amendDelayRequestSchema = z.strictObject({ ...delayContent, version, reason });
export const withdrawDelayRequestSchema = z.strictObject({ version, reason });

const delayVersionFields = {
  version,
  status: delayStatusSchema,
  cause: delayCauseSchema,
  startDate: calendarDate,
  endDate: calendarDate.nullable(),
  workingDaysLost: z.number().min(0),
  description: z.string(),
  siteDiary: z.strictObject({ id: uuid, date: calendarDate, siteId: uuid }).nullable(),
  claimFlag: delayClaimFlagSchema,
  activities: z.array(z.strictObject({ id: uuid, code: z.string(), name: z.string() })),
  /** Why this version was recorded (null for the first). */
  changeReason: z.string().nullable(),
  recordedAt: timestamp,
  recordedBy: person,
};
export const scheduleDelayVersionSchema = z.strictObject(delayVersionFields);
export const scheduleDelaySchema = z.strictObject({
  /** Stable across versions. */
  id: uuid,
  /** DLY-number within the project. */
  number: z.number().int().min(1),
  ...delayVersionFields,
  /** Working days in the period (to today while ongoing), for comparison with the days lost. */
  workingDaysInPeriod: z.number().int().min(0),
  createdAt: timestamp,
  createdBy: person,
  permissions: z.strictObject({ canAmend: z.boolean(), canWithdraw: z.boolean() }),
});
export const scheduleDelaysResponseSchema = z.strictObject({
  delays: z.array(scheduleDelaySchema),
  /** Recorded (not withdrawn) delays only. */
  totals: z.strictObject({
    count: z.number().int().min(0),
    workingDaysLost: z.number().min(0),
    byCause: z.array(
      z.strictObject({
        cause: delayCauseSchema,
        count: z.number().int().min(1),
        workingDaysLost: z.number().min(0),
      }),
    ),
  }),
  permissions: z.strictObject({ canRecord: z.boolean() }),
});
export const scheduleDelayResponseSchema = z.strictObject({
  delay: scheduleDelaySchema,
  history: z.array(scheduleDelayVersionSchema),
});

export type ScheduleItemRef = z.infer<typeof scheduleItemRefSchema>;
export type ScheduleCalendar = z.infer<typeof scheduleCalendarSchema>;
export type UpdateScheduleCalendarRequest = z.infer<typeof updateScheduleCalendarRequestSchema>;
export type CreateActivityRequest = z.infer<typeof createActivityRequestSchema>;
export type UpdateActivityRequest = z.infer<typeof updateActivityRequestSchema>;
export type ActivityProgressRequest = z.infer<typeof activityProgressRequestSchema>;
export type ScheduleItem = z.infer<typeof scheduleItemSchema>;
export type ScheduleDependency = z.infer<typeof scheduleDependencySchema>;
export type ScheduleBaselineSummary = z.infer<typeof scheduleBaselineSummarySchema>;
export type ScheduleBaselineItem = z.infer<typeof scheduleBaselineItemSchema>;
export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;
export type CreateDependencyRequest = z.infer<typeof createDependencyRequestSchema>;
export type UpdateDependencyRequest = z.infer<typeof updateDependencyRequestSchema>;
export type CreateBaselineRequest = z.infer<typeof createBaselineRequestSchema>;
export type ScheduleBaselinesResponse = z.infer<typeof scheduleBaselinesResponseSchema>;
export type ScheduleBaselineResponse = z.infer<typeof scheduleBaselineResponseSchema>;
export type CreateDelayRequest = z.infer<typeof createDelayRequestSchema>;
export type AmendDelayRequest = z.infer<typeof amendDelayRequestSchema>;
export type WithdrawDelayRequest = z.infer<typeof withdrawDelayRequestSchema>;
export type ScheduleDelay = z.infer<typeof scheduleDelaySchema>;
export type ScheduleDelayVersion = z.infer<typeof scheduleDelayVersionSchema>;
export type ScheduleDelaysResponse = z.infer<typeof scheduleDelaysResponseSchema>;
export type ScheduleDelayResponse = z.infer<typeof scheduleDelayResponseSchema>;
