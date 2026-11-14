import {
  ISO_WEEKDAYS,
  LOCALES,
  PLANT_ALERT_KINDS,
  PROJECT_STATUSES,
  REPORT_COLUMN_TYPES,
  REPORT_FREQUENCIES,
  REPORT_GROUPS,
  REPORT_IDS,
  REPORT_LIMITS,
  REPORT_RUN_OUTCOMES,
  REPORT_RUN_REASONS,
  REPORT_SUBSCRIPTION_STATUSES,
  SPEND_ALERT_KINDS,
} from "@pm-buddy/types";
import { z } from "zod";

/**
 * Dashboards and reports (D8.1): the report parameters, the typed report model every report is
 * built into (one model, rendered as HTML on the web and as PDF and Excel by the API), the reports
 * centre list, parameter options, subscriptions and their runs, and the owner dashboard. Requests
 * are strict (a body never carries a tenant or user ID); responses are strict so the web never
 * trusts an unexpected shape. Money is KES minor units, quantities and percentages decimal
 * strings, dates Nairobi business dates (YYYY-MM-DD) and instants ISO timestamps.
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();
const version = z.number().int().min(1).max(2_147_483_647);
const count = z.number().int().min(0);
const minor = z.number().int().refine(Number.isSafeInteger, "amount_out_of_range");
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, "invalid_decimal");
const person = z.strictObject({ id: uuid, displayName: z.string() });
const projectRef = z.strictObject({ id: uuid, code: z.string(), name: z.string() });

export const reportIdSchema = z.enum(REPORT_IDS);
const localeSchema = z.enum(LOCALES);

// Parameters ------------------------------------------------------------------------------------

/** Every report parameter (each report uses some of them; the API refuses the ones it does not). */
export const reportParamsSchema = z.strictObject({
  projectId: uuid.optional(),
  siteId: uuid.optional(),
  storeId: uuid.optional(),
  batchId: uuid.optional(),
  actorId: uuid.optional(),
  action: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_.]*$/, "invalid_action")
    .max(REPORT_LIMITS.actionFilterMaxLength)
    .optional(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  asAt: calendarDate.optional(),
});
export type ReportParams = z.infer<typeof reportParamsSchema>;

/** A preview or export query: the parameters and the language of the labels. */
export const reportQuerySchema = reportParamsSchema.extend({
  locale: localeSchema.default("en"),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const reportOptionsQuerySchema = z.strictObject({ projectId: uuid.optional() });

// The report model ------------------------------------------------------------------------------

/** money: integer minor units; every other type: a string (date YYYY-MM-DD, decimal, text); null = unavailable. */
export const reportCellSchema = z.union([z.string(), minor, z.null()]);
export type ReportCell = z.infer<typeof reportCellSchema>;

export const reportColumnSchema = z.strictObject({
  key: z.string().regex(/^[a-zA-Z0-9_.-]{1,60}$/),
  label: z.string(),
  type: z.enum(REPORT_COLUMN_TYPES),
});
export type ReportColumn = z.infer<typeof reportColumnSchema>;

const cellFits = (type: (typeof REPORT_COLUMN_TYPES)[number], cell: ReportCell) => {
  if (cell === null) return true;
  if (type === "money") return typeof cell === "number";
  if (typeof cell !== "string") return false;
  if (type === "date") return calendarDate.safeParse(cell).success;
  if (type === "datetime") return timestamp.safeParse(cell).success;
  if (type === "quantity" || type === "percent") return decimal.safeParse(cell).success;
  return true;
};

export const reportSectionSchema = z
  .strictObject({
    key: z.string().regex(/^[a-z0-9-]{1,40}$/),
    title: z.string(),
    columns: z.array(reportColumnSchema).min(1).max(40),
    rows: z.array(z.array(reportCellSchema)),
    /** Every row of the section (the preview may carry fewer). */
    rowCount: count,
    /** Totals over every row, aligned with the columns; the first cell is the label. */
    totals: z.array(reportCellSchema).nullable(),
    notes: z.array(z.string()),
    emptyText: z.string(),
  })
  .superRefine((section, ctx) => {
    const width = section.columns.length;
    const check = (cells: ReportCell[], where: string, labelled = false) => {
      if (cells.length !== width)
        ctx.addIssue({ code: "custom", message: `${where}: ${cells.length} cells for ${width}` });
      cells.forEach((cell, index) => {
        const column = section.columns[index];
        // The totals row's first cell is its label, whatever the column's type.
        if (labelled && index === 0 && typeof cell === "string") return;
        if (column && !cellFits(column.type, cell))
          ctx.addIssue({
            code: "custom",
            message: `${where}: cell ${index} is not ${column.type}`,
          });
      });
    };
    section.rows.forEach((row, index) => check(row, `row ${index}`));
    if (section.totals) check(section.totals, "totals", true);
    if (section.rows.length > section.rowCount)
      ctx.addIssue({ code: "custom", message: "more rows than rowCount" });
  });
export type ReportSection = z.infer<typeof reportSectionSchema>;

export const reportModelSchema = z.strictObject({
  report: z.strictObject({ id: reportIdSchema, title: z.string(), description: z.string() }),
  locale: localeSchema,
  company: z.strictObject({ name: z.string() }),
  /** The parameters as shown in the header (labels and display values in the report's language). */
  parameters: z.array(z.strictObject({ key: z.string(), label: z.string(), value: z.string() })),
  /** The parameters actually used (the default period filled in), for links and exports. */
  query: reportParamsSchema,
  generatedAt: timestamp,
  generatedBy: z.strictObject({ displayName: z.string() }),
  sections: z.array(reportSectionSchema).min(1).max(10),
  notes: z.array(z.string()),
  /** True when some section shows fewer rows than it has (the exports carry them all). */
  truncated: z.boolean(),
});
export type ReportModel = z.infer<typeof reportModelSchema>;

// The reports centre ------------------------------------------------------------------------------

export const reportSummarySchema = z.strictObject({
  id: reportIdSchema,
  group: z.enum(REPORT_GROUPS),
  title: z.string(),
  description: z.string(),
  available: z.boolean(),
  availableWith: z.string().nullable(),
  /** The caller may run it now (reports.view and the source permission, somewhere). */
  canRun: z.boolean(),
  /** Projects the caller may run it for (empty for company reports). */
  projects: z.array(projectRef),
  /** The caller may run it across all their permitted projects at once (no project chosen). */
  acrossProjects: z.boolean(),
  /** Plain words for who may run it (the permission rule). */
  rule: z.string(),
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;

export const reportsResponseSchema = z.strictObject({
  reports: z.array(reportSummarySchema),
  canSubscribe: z.boolean(),
  /** config.manage: sees the company's subscriptions and may run due ones now. */
  canManageSubscriptions: z.boolean(),
});
export type ReportsResponse = z.infer<typeof reportsResponseSchema>;

export const reportOptionsResponseSchema = z.strictObject({
  sites: z.array(z.strictObject({ id: uuid, name: z.string() })),
  stores: z.array(z.strictObject({ id: uuid, name: z.string(), project: projectRef })),
  batches: z.array(
    z.strictObject({
      id: uuid,
      periodStart: calendarDate,
      periodEnd: calendarDate,
      payDate: calendarDate,
      status: z.string(),
    }),
  ),
  actors: z.array(person),
});
export type ReportOptionsResponse = z.infer<typeof reportOptionsResponseSchema>;

// Subscriptions -----------------------------------------------------------------------------------

/** The fixed parameters a subscription keeps (the period follows each run). */
export const subscriptionParamsSchema = reportParamsSchema.omit({
  from: true,
  to: true,
  asAt: true,
});

export const createSubscriptionRequestSchema = z
  .strictObject({
    reportId: reportIdSchema,
    parameters: subscriptionParamsSchema,
    frequency: z.enum(REPORT_FREQUENCIES),
    weekday: z
      .number()
      .int()
      .refine((value) => (ISO_WEEKDAYS as readonly number[]).includes(value), "invalid_weekday")
      .nullable()
      .optional(),
    dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
    locale: localeSchema,
  })
  .superRefine((value, ctx) => {
    if (value.frequency === "weekly" && !value.weekday)
      ctx.addIssue({ code: "custom", path: ["weekday"], message: "weekday_required" });
    if (value.frequency === "monthly" && !value.dayOfMonth)
      ctx.addIssue({ code: "custom", path: ["dayOfMonth"], message: "day_required" });
  });
export type CreateSubscriptionRequest = z.infer<typeof createSubscriptionRequestSchema>;

export const updateSubscriptionRequestSchema = z.strictObject({
  version,
  status: z.enum(["active", "paused"]),
});
export const deleteSubscriptionRequestSchema = z.strictObject({ version });

const lastRun = z.strictObject({
  outcome: z.enum(REPORT_RUN_OUTCOMES),
  reason: z.enum(REPORT_RUN_REASONS).nullable(),
  at: timestamp,
});

export const reportSubscriptionSchema = z.strictObject({
  id: uuid,
  report: z.strictObject({ id: reportIdSchema, title: z.string() }),
  parameters: subscriptionParamsSchema,
  /** The parameters in words (project code, site and store names). */
  parameterText: z.string(),
  frequency: z.enum(REPORT_FREQUENCIES),
  weekday: z.number().int().nullable(),
  dayOfMonth: z.number().int().nullable(),
  locale: localeSchema,
  status: z.enum(REPORT_SUBSCRIPTION_STATUSES),
  nextRunAt: timestamp.nullable(),
  lastRun: lastRun.nullable(),
  subscriber: person,
  createdAt: timestamp,
  version,
  /** The caller owns it (only the owner pauses, resumes or deletes). */
  mine: z.boolean(),
});
export type ReportSubscription = z.infer<typeof reportSubscriptionSchema>;

export const reportSubscriptionResponseSchema = z.strictObject({
  subscription: reportSubscriptionSchema,
});

export const reportRunSchema = z.strictObject({
  id: uuid,
  subscriptionId: uuid,
  report: z.strictObject({ id: reportIdSchema, title: z.string() }),
  subscriber: person,
  dueAt: timestamp,
  outcome: z.enum(REPORT_RUN_OUTCOMES),
  reason: z.enum(REPORT_RUN_REASONS).nullable(),
  periodFrom: calendarDate.nullable(),
  periodTo: calendarDate.nullable(),
  createdAt: timestamp,
});
export type ReportRun = z.infer<typeof reportRunSchema>;

export const reportSubscriptionsQuerySchema = z.strictObject({
  scope: z.enum(["mine", "company"]).default("mine"),
});

export const reportSubscriptionsResponseSchema = z.strictObject({
  scope: z.enum(["mine", "company"]),
  subscriptions: z.array(reportSubscriptionSchema),
  /** Recent runs of the listed subscriptions, newest first (at most 100). */
  runs: z.array(reportRunSchema),
  canManage: z.boolean(),
  /** The send hour, Nairobi time. */
  sendHour: z.number().int().min(0).max(23),
});
export type ReportSubscriptionsResponse = z.infer<typeof reportSubscriptionsResponseSchema>;

export const runDueResponseSchema = z.strictObject({
  claimed: count,
  sent: count,
  skipped: count,
  failed: count,
});
export type RunDueResponse = z.infer<typeof runDueResponseSchema>;

// The owner dashboard ---------------------------------------------------------------------------

const level = z.enum(["unavailable", "within", "threshold", "over"]);

/**
 * The owner dashboard (D-121): one call, sections built from the same reads as their source
 * screens. A section the caller may not see is absent (never zero); within a section only the
 * projects the caller may read appear; undefined ratios are null ("unavailable").
 */
export const dashboardResponseSchema = z.strictObject({
  today: calendarDate,
  generatedAt: timestamp,
  projects: z
    .array(
      z.strictObject({
        project: projectRef,
        status: z.enum(PROJECT_STATUSES),
        contractSumMinor: minor.nullable(),
        /** Present only where the caller reads valuations (QS, finance, owner). */
        certified: z
          .strictObject({
            certifiedMinor: minor,
            /** Certified work ÷ contract sum, truncated to one decimal; null without a sum. */
            percentOfContract: decimal.nullable(),
            retentionHeldMinor: minor,
            latest: z
              .strictObject({ number: z.string(), date: calendarDate, amountDueMinor: minor })
              .nullable(),
          })
          .optional(),
      }),
    )
    .optional(),
  spending: z
    .strictObject({
      thresholdPercent: z.number().int(),
      totals: z.strictObject({
        budgetMinor: minor.nullable(),
        committedMinor: minor,
        actualMinor: minor,
        paidMinor: minor,
        usedPercent: decimal.nullable(),
      }),
      projects: z.array(
        z.strictObject({
          project: projectRef,
          budgetMinor: minor.nullable(),
          committedMinor: minor,
          actualMinor: minor,
          paidMinor: minor,
          usedPercent: decimal.nullable(),
          level,
        }),
      ),
    })
    .optional(),
  forecast: z
    .strictObject({
      openingMinor: minor.nullable(),
      weeks: z.array(
        z.strictObject({
          start: calendarDate,
          inMinor: minor,
          outMinor: minor,
          closingMinor: minor.nullable(),
        }),
      ),
      overdueOutMinor: minor,
    })
    .optional(),
  spendAlerts: z
    .strictObject({ counts: z.record(z.enum(SPEND_ALERT_KINDS), count), total: count })
    .optional(),
  attendance: z
    .strictObject({
      date: calendarDate,
      present: count,
      halfDay: count,
      absent: count,
      projects: z.array(
        z.strictObject({
          project: projectRef,
          present: count,
          halfDay: count,
          absent: count,
          sites: count,
          sitesRecorded: count,
        }),
      ),
    })
    .optional(),
  invoices: z
    .strictObject({
      windowDays: z.number().int().min(1),
      dueSoon: z.strictObject({ count, outstandingMinor: minor }),
      overdue: z.strictObject({ count, outstandingMinor: minor }),
    })
    .optional(),
  stock: z
    .strictObject({
      valueMinor: minor,
      lowStock: count,
      items: z.array(
        z.strictObject({
          store: z.string(),
          material: z.string(),
          quantity: z.string(),
          reorderLevel: z.string(),
          unit: z.string(),
        }),
      ),
    })
    .optional(),
  plant: z
    .strictObject({ counts: z.record(z.enum(PLANT_ALERT_KINDS), count), total: count })
    .optional(),
  safety: z
    .strictObject({
      openIncidents: count,
      overdueActions: count,
      projects: z.array(
        z.strictObject({ project: projectRef, openIncidents: count, overdueActions: count }),
      ),
    })
    .optional(),
  quality: z
    .strictObject({
      openSnags: count,
      inspectionsAwaitingSignOff: count,
      projects: z.array(
        z.strictObject({
          project: projectRef,
          openSnags: count,
          inspectionsAwaitingSignOff: count,
        }),
      ),
    })
    .optional(),
});
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
