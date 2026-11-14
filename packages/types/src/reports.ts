/**
 * Dashboards and reports vocabulary (D8.1, brief §5.17 and §15 F; ARCHITECTURE §4.14; WORKFLOWS
 * "Report subscriptions"). The report registry is code-defined: the API owns each report's
 * permission rule and builder (`apps/api/src/modules/reports/report-registry.ts`); this file holds
 * what web and API share — identifiers, parameters, limits and the subscription vocabulary. The
 * database CHECK constraints in migration `20261129090000_reports` list the same report IDs,
 * frequencies, statuses, outcomes and reasons, so adding one needs a migration as well.
 */

/** Every report in the reports centre, in display order. */
export const REPORT_IDS = [
  "muster-roll",
  "payroll-register",
  "cost-ledger",
  "budget-vs-actual",
  "stock",
  "valuations-register",
  "lpo-register",
  "invoice-ageing",
  "supplier-payments",
  "petty-cash",
  "mpesa-reconciliation",
  "safety-actions",
  "audit-log",
] as const;
export type ReportId = (typeof REPORT_IDS)[number];
export const isReportId = (value: string): value is ReportId =>
  (REPORT_IDS as readonly string[]).includes(value);

/** How the reports centre groups its reports. */
export const REPORT_GROUPS = ["labour", "finance", "materials", "commercial", "records"] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

/** What a report's period means when it runs on a schedule (WORKFLOWS "Report subscriptions"). */
export const REPORT_PERIOD_KINDS = ["range", "as-at", "none"] as const;
export type ReportPeriodKind = (typeof REPORT_PERIOD_KINDS)[number];

/** Whether a report takes a project, and whether it may run across every permitted project. */
export const REPORT_PROJECT_RULES = ["required", "optional", "none"] as const;
export type ReportProjectRule = (typeof REPORT_PROJECT_RULES)[number];

export type ReportDefinition = {
  id: ReportId;
  group: ReportGroup;
  /** False while the data the report needs is not built (it is listed as "not available yet"). */
  available: boolean;
  /** The deliverable that brings it, when not available. */
  availableWith: string | null;
  project: ReportProjectRule;
  /** A site of the project is required (the muster roll is per site). */
  site: boolean;
  /** A store may narrow the report (stock). */
  store: boolean;
  /** A payroll batch of the project is required (payroll register). */
  batch: boolean;
  /** Who and what (audit log filters). */
  actor: boolean;
  period: ReportPeriodKind;
  /** The longest period accepted (range reports). */
  maxPeriodDays: number;
  /** The default period when none is given: this many days ending today (range reports). */
  defaultPeriodDays: number;
  /** The source screen asks for a recent MFA check, so the report does too (audit log). */
  stepUp: boolean;
};

const range = (maxPeriodDays: number, defaultPeriodDays: number) => ({
  period: "range" as const,
  maxPeriodDays,
  defaultPeriodDays,
});
const base = {
  available: true,
  availableWith: null,
  site: false,
  store: false,
  batch: false,
  actor: false,
  stepUp: false,
};

/**
 * The registry shared by web and API. Permissions are not here: each report requires
 * `reports.view` plus the permission of the screen its data comes from, on the same project
 * (role ∩ assignment), as the API's registry states (INVARIANTS "Reports").
 */
export const REPORT_DEFINITIONS: Readonly<Record<ReportId, ReportDefinition>> = {
  "muster-roll": {
    ...base,
    id: "muster-roll",
    group: "labour",
    project: "required",
    site: true,
    ...range(31, 7),
  },
  "payroll-register": {
    ...base,
    id: "payroll-register",
    group: "labour",
    project: "required",
    batch: true,
    period: "none",
    maxPeriodDays: 0,
    defaultPeriodDays: 0,
  },
  "cost-ledger": {
    ...base,
    id: "cost-ledger",
    group: "finance",
    project: "optional",
    ...range(366, 30),
  },
  "budget-vs-actual": {
    ...base,
    id: "budget-vs-actual",
    group: "finance",
    project: "required",
    period: "none",
    maxPeriodDays: 0,
    defaultPeriodDays: 0,
  },
  stock: {
    ...base,
    id: "stock",
    group: "materials",
    project: "optional",
    store: true,
    ...range(366, 30),
  },
  "valuations-register": {
    ...base,
    id: "valuations-register",
    group: "commercial",
    project: "required",
    period: "none",
    maxPeriodDays: 0,
    defaultPeriodDays: 0,
  },
  "lpo-register": {
    ...base,
    id: "lpo-register",
    group: "materials",
    project: "optional",
    ...range(366, 90),
  },
  "invoice-ageing": {
    ...base,
    id: "invoice-ageing",
    group: "materials",
    project: "optional",
    period: "as-at",
    maxPeriodDays: 0,
    defaultPeriodDays: 0,
  },
  "supplier-payments": {
    ...base,
    id: "supplier-payments",
    group: "finance",
    project: "optional",
    ...range(366, 90),
  },
  "petty-cash": {
    ...base,
    id: "petty-cash",
    group: "finance",
    project: "optional",
    ...range(366, 30),
  },
  "mpesa-reconciliation": {
    ...base,
    id: "mpesa-reconciliation",
    group: "finance",
    available: false,
    availableWith: "D4.3",
    project: "optional",
    ...range(366, 30),
  },
  "safety-actions": {
    ...base,
    id: "safety-actions",
    group: "records",
    project: "required",
    ...range(366, 90),
  },
  "audit-log": {
    ...base,
    id: "audit-log",
    group: "records",
    project: "none",
    actor: true,
    stepUp: true,
    ...range(92, 7),
  },
};

/** Limits on report work and output (CONFIGURATION "Reports"). */
export const REPORT_LIMITS = {
  /** Rows (all sections) a PDF may hold; above it the API answers 422 use-excel. */
  pdfMaxRows: 5_000,
  /** Rows (all sections) any report may hold; above it 422 report-too-large (narrow the filters). */
  maxRows: 20_000,
  /** Rows per section returned for the on-screen preview (the totals cover every row). */
  previewRows: 200,
  /** Previews per user per minute. */
  previewsPerMinute: 60,
  /** PDF and Excel exports per user per ten minutes. */
  exportsPerTenMinutes: 60,
  /** Dashboard loads per user per minute (each reads every visible project's summaries). */
  dashboardsPerMinute: 30,
  /**
   * A user's dashboard is reused for this long while their access is unchanged (any change of
   * role permissions or project assignments builds a new one at once).
   */
  dashboardCacheSeconds: 60,
  /** Active and paused subscriptions per user, and per company. */
  subscriptionsPerUser: 20,
  subscriptionsPerCompany: 200,
  /** Subscriptions the scheduler handles per cycle (the rest wait for the next minute). */
  schedulerBatch: 25,
  /** The scheduler looks for due subscriptions this often. */
  schedulerIntervalSeconds: 60,
  /** Scheduled emails go out at this hour, Africa/Nairobi time. */
  sendHourNairobi: 7,
  /** The audit log's action filter (a prefix such as `plant.` or `invoice.approved`). */
  actionFilterMaxLength: 100,
} as const;

/** Column types of a report table (one renderer turns them into HTML, PDF and Excel). */
export const REPORT_COLUMN_TYPES = [
  "text",
  "date",
  "datetime",
  "money",
  "quantity",
  "percent",
] as const;
export type ReportColumnType = (typeof REPORT_COLUMN_TYPES)[number];

export const REPORT_EXPORT_FORMATS = ["pdf", "xlsx"] as const;
export type ReportExportFormat = (typeof REPORT_EXPORT_FORMATS)[number];

// Subscriptions ---------------------------------------------------------------------------------

/** Weekly on a weekday, or monthly on a day of the month (clamped to short months). */
export const REPORT_FREQUENCIES = ["weekly", "monthly"] as const;
export type ReportFrequency = (typeof REPORT_FREQUENCIES)[number];

/** active ⇄ paused; either → deleted (final, kept with its runs). */
export const REPORT_SUBSCRIPTION_STATUSES = ["active", "paused", "deleted"] as const;
export type ReportSubscriptionStatus = (typeof REPORT_SUBSCRIPTION_STATUSES)[number];

/** What a scheduled run did; append-only, one per subscription and due time. */
export const REPORT_RUN_OUTCOMES = ["sent", "failed", "skipped"] as const;
export type ReportRunOutcome = (typeof REPORT_RUN_OUTCOMES)[number];

/** Why a run was skipped or failed (never personal data). */
export const REPORT_RUN_REASONS = [
  "permission-lost",
  "membership-ended",
  "report-unavailable",
  "no-email-address",
  "delivery-failed",
] as const;
export type ReportRunReason = (typeof REPORT_RUN_REASONS)[number];

/** Who sees which subscriptions: their own, or (config.manage) the company's. */
export const REPORT_SUBSCRIPTION_ADMIN_PERMISSION = "config.manage" as const;
