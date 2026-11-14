/**
 * D8.1 dashboards and reports for the mock API: the owner dashboard (sections gated by the same
 * permission sets as the API, omitted rather than zeroed), the reports centre list with each
 * report's rule (reports.view plus the source screen's permission on the same project), parameter
 * options, report previews built as the shared typed model, PDF/Excel bytes, and email
 * subscriptions with "run due now". Figures are small fixed samples; the API e2e suite checks the
 * real arithmetic. Every response is validated with the shared schema. Synthetic data only.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { messages } from "@pm-buddy/i18n";
import {
  addCalendarDays,
  datesBetween,
  nairobiDate,
  nextReportRun,
  reportPeriod,
  scheduledPeriod,
} from "@pm-buddy/domain";
import {
  PETTY_CASH_READ_PERMISSIONS,
  PLANT_ALERT_KINDS,
  PLANT_READ_PERMISSIONS,
  QUALITY_READ_PERMISSIONS,
  REPORT_DEFINITIONS,
  REPORT_IDS,
  REPORT_LIMITS,
  REPORT_SUBSCRIPTION_ADMIN_PERMISSION,
  SAFETY_READ_PERMISSIONS,
  SPEND_ALERT_KINDS,
  SPENDING_READ_PERMISSIONS,
  VALUATION_READ_PERMISSIONS,
  type IsoWeekday,
  type Locale,
  type Permission,
  type ProjectStatus,
  type ReportColumnType,
  type ReportId,
} from "@pm-buddy/types";
import {
  createSubscriptionRequestSchema,
  dashboardResponseSchema,
  deleteSubscriptionRequestSchema,
  reportModelSchema,
  reportOptionsResponseSchema,
  reportQuerySchema,
  reportsResponseSchema,
  reportSubscriptionResponseSchema,
  reportSubscriptionsResponseSchema,
  runDueResponseSchema,
  updateSubscriptionRequestSchema,
  type DashboardResponse,
  type ReportCell,
  type ReportModel,
  type ReportParams,
  type ReportSection,
  type ReportSubscription,
} from "@pm-buddy/validation";

type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };
type Person = { id: string; displayName: string };
type ProjectInfo = {
  id: string;
  code: string;
  name: string;
  status: ProjectStatus;
  contractSumMinor: number | null;
  sites: { id: string; name: string }[];
  /** The caller's effective permissions on the project (role ∩ assignment, or tenant-wide). */
  permissions: readonly Permission[];
};
export type ReportsDeps = {
  companyName: string;
  actor: Person & { email: string | null };
  tenantWide: boolean;
  companyPermissions: readonly Permission[];
  projects: ProjectInfo[];
  stores: { id: string; name: string; projectId: string }[];
  labourers: (projectId: string) => { workerNo: string; fullName: string }[];
  people: Person[];
  /** Throws 403 step-up-required unless the caller verified recently. */
  stepUp: () => void;
  fail: (status: number, code: string) => Error;
  parse: <T>(schema: z.ZodType<T>, body: unknown) => T;
};

type MockSubscription = {
  id: string;
  subscriber: Person;
  reportId: ReportId;
  parameters: Omit<ReportParams, "from" | "to" | "asAt">;
  frequency: "weekly" | "monthly";
  weekday: number | null;
  dayOfMonth: number | null;
  locale: Locale;
  status: "active" | "paused" | "deleted";
  nextRunAt: string | null;
  createdAt: string;
  version: number;
};
type MockRun = {
  id: string;
  subscriptionId: string;
  dueAt: string;
  outcome: "sent" | "failed" | "skipped";
  reason: null;
  periodFrom: string | null;
  periodTo: string | null;
  createdAt: string;
};
export type ReportsState = {
  subscriptions: MockSubscription[];
  runs: MockRun[];
  batchId: string;
};

// The API's rules (apps/api/src/modules/reports/report-registry.ts), kept in step by hand.
const PAYROLL_VIEW: readonly Permission[] = ["payroll.view", "payroll.prepare"];
const P2P_VIEW: readonly Permission[] = [
  "procurement.requisition",
  "procurement.approve",
  "stores.manage",
  "finance.view",
  "finance.manage",
  "payments.approve",
  "payments.disburse",
];
const STORES_VIEW: readonly Permission[] = [
  "stores.manage",
  "procurement.requisition",
  "procurement.approve",
  "finance.view",
  "finance.manage",
];
type Rule = {
  project?: readonly Permission[];
  alsoProject?: readonly Permission[];
  companyAlso?: readonly Permission[];
  company?: Permission;
  stepUp?: boolean;
};
const P2P_RULE: Rule = { project: P2P_VIEW, companyAlso: ["procurement.manage_suppliers"] };
const RULES: Record<ReportId, Rule> = {
  "muster-roll": { project: ["attendance.view"] },
  "payroll-register": { project: PAYROLL_VIEW },
  "cost-ledger": { project: SPENDING_READ_PERMISSIONS },
  "budget-vs-actual": { project: SPENDING_READ_PERMISSIONS },
  stock: { project: STORES_VIEW },
  "valuations-register": { project: VALUATION_READ_PERMISSIONS },
  "lpo-register": P2P_RULE,
  "invoice-ageing": P2P_RULE,
  "supplier-payments": P2P_RULE,
  "petty-cash": { project: PETTY_CASH_READ_PERMISSIONS },
  "mpesa-reconciliation": { project: ["payments.view"] },
  "safety-actions": { project: SAFETY_READ_PERMISSIONS, alsoProject: ["projects.view"] },
  "audit-log": { company: "audit.view", stepUp: true },
};

const has = (held: readonly Permission[], wanted: readonly Permission[]) =>
  wanted.some((permission) => held.includes(permission));
const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
const ref = (project: ProjectInfo) => ({ id: project.id, code: project.code, name: project.name });

export function initialReports(owner: Person, projectId: string): ReportsState {
  const now = new Date();
  return {
    batchId: "61000000-0000-4000-8000-000000000001",
    runs: [],
    subscriptions: [
      {
        id: randomUUID(),
        subscriber: owner,
        reportId: "cost-ledger",
        parameters: { projectId },
        frequency: "weekly",
        weekday: 1,
        dayOfMonth: null,
        locale: "en",
        status: "active",
        // Due now, so "Run due now" has something to send.
        nextRunAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
        createdAt: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
        version: 1,
      },
    ],
  };
}

function access(deps: ReportsDeps) {
  const canOn = (project: ProjectInfo, rule: Rule) =>
    project.permissions.includes("reports.view") &&
    (rule.alsoProject ?? []).every((permission) => project.permissions.includes(permission)) &&
    (has(project.permissions, rule.project ?? []) ||
      has(deps.companyPermissions, rule.companyAlso ?? []));
  const reportsSomewhere = deps.tenantWide
    ? deps.companyPermissions.includes("reports.view")
    : deps.projects.some((project) => project.permissions.includes("reports.view"));
  return {
    reportsSomewhere,
    projectsFor: (rule: Rule) => deps.projects.filter((project) => canOn(project, rule)),
    canCompany: (rule: Rule) =>
      !!rule.company && reportsSomewhere && deps.companyPermissions.includes(rule.company),
  };
}

// Dashboard ---------------------------------------------------------------------------------------

function dashboard(deps: ReportsDeps): DashboardResponse {
  const today = nairobiDate();
  const readable = (wanted: readonly Permission[], also: readonly Permission[] = []) =>
    deps.projects.filter(
      (project) =>
        has(project.permissions, wanted) &&
        also.every((permission) => project.permissions.includes(permission)),
    );
  const response: DashboardResponse = { today, generatedAt: new Date().toISOString() };
  const viewable = readable(["projects.view"]);
  const valuations = new Set(readable(VALUATION_READ_PERMISSIONS).map((project) => project.id));
  if (viewable.length)
    response.projects = viewable.map((project, index) => ({
      project: ref(project),
      status: project.status,
      contractSumMinor: project.contractSumMinor,
      ...(valuations.has(project.id)
        ? {
            certified:
              index === 0
                ? {
                    certifiedMinor: 1_850_000_000,
                    percentOfContract: project.contractSumMinor
                      ? (
                          Math.trunc((1_850_000_000 / project.contractSumMinor) * 1000) / 10
                        ).toFixed(1)
                      : null,
                    retentionHeldMinor: 92_500_000,
                    latest: {
                      number: "IPC-02",
                      date: addCalendarDays(today, -12),
                      amountDueMinor: 640_000_000,
                    },
                  }
                : {
                    certifiedMinor: 0,
                    percentOfContract: null,
                    retentionHeldMinor: 0,
                    latest: null,
                  },
          }
        : {}),
    }));
  const spending = readable(SPENDING_READ_PERMISSIONS);
  if (spending.length) {
    const rows = spending.map((project, index) =>
      index === 0
        ? {
            project: ref(project),
            budgetMinor: 4_200_000_000,
            committedMinor: 610_000_000,
            actualMinor: 2_980_000_000,
            paidMinor: 2_450_000_000,
            usedPercent: "85.4",
            level: "threshold" as const,
          }
        : {
            project: ref(project),
            budgetMinor: null,
            committedMinor: 0,
            actualMinor: 12_000_000,
            paidMinor: 12_000_000,
            usedPercent: null,
            level: "unavailable" as const,
          },
    );
    const sum = (key: "committedMinor" | "actualMinor" | "paidMinor") =>
      rows.reduce((total, row) => total + row[key], 0);
    response.spending = {
      thresholdPercent: 80,
      totals: {
        budgetMinor: 4_200_000_000,
        committedMinor: sum("committedMinor"),
        actualMinor: sum("actualMinor"),
        paidMinor: sum("paidMinor"),
        usedPercent: rows.length > 1 ? null : "85.4",
      },
      projects: rows,
    };
    response.spendAlerts = {
      counts: Object.fromEntries(
        SPEND_ALERT_KINDS.map((kind) => [kind, kind === "budget_threshold" ? 1 : 0]),
      ) as Record<(typeof SPEND_ALERT_KINDS)[number], number>,
      total: 1,
    };
  }
  if (deps.tenantWide && has(deps.companyPermissions, SPENDING_READ_PERMISSIONS))
    response.forecast = {
      openingMinor: 1_200_000_000,
      overdueOutMinor: 45_000_000,
      weeks: [0, 7, 14, 21].map((offset, index) => ({
        start: addCalendarDays(today, offset),
        inMinor: index === 1 ? 640_000_000 : 0,
        outMinor: 150_000_000 + index * 20_000_000,
        closingMinor: 1_200_000_000 + (index >= 1 ? 640_000_000 : 0) - 150_000_000 * (index + 1),
      })),
    };
  const attendance = readable(["attendance.view"]).filter(
    (project) => !["closed", "cancelled"].includes(project.status),
  );
  if (attendance.length)
    response.attendance = {
      date: today,
      present: 14,
      halfDay: 1,
      absent: 2,
      projects: attendance.map((project, index) => ({
        project: ref(project),
        present: index === 0 ? 14 : 0,
        halfDay: index === 0 ? 1 : 0,
        absent: index === 0 ? 2 : 0,
        sites: project.sites.length,
        sitesRecorded: index === 0 ? Math.min(1, project.sites.length) : 0,
      })),
    };
  if (readable(P2P_VIEW).length || deps.companyPermissions.includes("procurement.manage_suppliers"))
    response.invoices = {
      windowDays: 7,
      dueSoon: { count: 1, outstandingMinor: 23_200_000 },
      overdue: { count: 2, outstandingMinor: 81_200_000 },
    };
  if (readable(STORES_VIEW).length)
    response.stock = {
      valueMinor: 38_450_000,
      lowStock: 1,
      items: [
        {
          store: "Main plot store",
          material: "Cement 42.5N (50 kg)",
          quantity: "35",
          reorderLevel: "50",
          unit: "bag",
        },
      ],
    };
  if (readable(PLANT_READ_PERMISSIONS, ["projects.view"]).length)
    response.plant = {
      counts: Object.fromEntries(
        PLANT_ALERT_KINDS.map((kind) => [kind, kind === "fuel_over_standard" ? 1 : 0]),
      ) as Record<(typeof PLANT_ALERT_KINDS)[number], number>,
      total: 1,
    };
  const safety = readable(SAFETY_READ_PERMISSIONS, ["projects.view"]);
  if (safety.length)
    response.safety = {
      openIncidents: 1,
      overdueActions: 1,
      projects: safety.map((project, index) => ({
        project: ref(project),
        openIncidents: index === 0 ? 1 : 0,
        overdueActions: index === 0 ? 1 : 0,
      })),
    };
  const quality = readable(QUALITY_READ_PERMISSIONS, ["projects.view"]);
  if (quality.length)
    response.quality = {
      openSnags: 3,
      inspectionsAwaitingSignOff: 1,
      projects: quality.map((project, index) => ({
        project: ref(project),
        openSnags: index === 0 ? 3 : 0,
        inspectionsAwaitingSignOff: index === 0 ? 1 : 0,
      })),
    };
  return response;
}

// Report models -----------------------------------------------------------------------------------

type Column = [key: string, label: string, type: ReportColumnType];
type Context = {
  t: ReturnType<typeof messages>["reportExport"];
  projects: ProjectInfo[];
  site: { id: string; name: string } | null;
  from: string | null;
  to: string | null;
  asAt: string | null;
  labourers: { workerNo: string; fullName: string }[];
  actor: Person;
};

function section(
  t: Context["t"],
  key: string,
  title: string,
  columns: Column[],
  rows: ReportCell[][],
  options: { totals?: number[]; rowCount?: number; notes?: string[] } = {},
): ReportSection {
  const totals = options.totals
    ? columns.map((_, index) =>
        index === 0
          ? t.total
          : options.totals!.includes(index)
            ? rows.reduce<number>((total, row) => total + ((row[index] as number | null) ?? 0), 0)
            : null,
      )
    : null;
  return {
    key,
    title,
    columns: columns.map(([columnKey, label, type]) => ({ key: columnKey, label, type })),
    rows: rows.slice(0, REPORT_LIMITS.previewRows),
    rowCount: options.rowCount ?? rows.length,
    totals,
    notes: options.notes ?? [],
    emptyText: t.empty,
  };
}

function sections(id: ReportId, c: Context): ReportSection[] {
  const { t } = c;
  const project = c.projects[0]!;
  const code = project.code;
  const day = (offset: number) => addCalendarDays(c.to ?? c.asAt ?? nairobiDate(), -offset);
  switch (id) {
    case "muster-roll": {
      const days = datesBetween(c.from!, c.to!);
      const codes = t.muster.codes;
      const people = c.labourers.slice(0, 4);
      const rows = people.map((person, index) => {
        const marks = days.map((_, dayIndex) =>
          (dayIndex + index) % 5 === 4 ? codes.absent : codes.present,
        );
        const present = marks.filter((mark) => mark === codes.present).length;
        return [
          person.workerNo,
          person.fullName,
          ...marks,
          String(present),
          String(days.length - present),
          (present * 8).toFixed(2),
        ];
      });
      return [
        section(
          t,
          "muster",
          t.muster.section,
          [
            ["workerNo", t.muster.workerNo, "text"],
            ["name", t.muster.name, "text"],
            ...days.map((date): Column => [`d${date}`, date.slice(8), "text"]),
            ["present", t.muster.days, "quantity"],
            ["absent", t.muster.absent, "quantity"],
            ["hours", t.muster.hours, "quantity"],
          ],
          rows,
          { notes: [t.muster.legend] },
        ),
      ];
    }
    case "payroll-register": {
      const people = c.labourers.slice(0, 3);
      const rows = people.map((person, index) => {
        const gross = 1_260_000 + index * 180_000;
        const nssf = Math.round(gross * 0.06);
        const shif = Math.round(gross * 0.0275);
        const ahl = Math.round(gross * 0.015);
        return [
          person.workerNo,
          person.fullName,
          "6",
          gross,
          0,
          nssf,
          shif,
          ahl,
          0,
          0,
          gross - nssf - shif - ahl,
        ];
      });
      const sum = (index: number) => rows.reduce((total, row) => total + (row[index] as number), 0);
      return [
        section(
          t,
          "lines",
          t.payroll.lines,
          [
            ["workerNo", t.payroll.workerNo, "text"],
            ["name", t.payroll.name, "text"],
            ["days", t.payroll.days, "quantity"],
            ["gross", t.payroll.gross, "money"],
            ["paye", t.payroll.paye, "money"],
            ["nssf", t.payroll.nssf, "money"],
            ["shif", t.payroll.shif, "money"],
            ["ahl", t.payroll.ahl, "money"],
            ["advances", t.payroll.advances, "money"],
            ["other", t.payroll.other, "money"],
            ["net", t.payroll.net, "money"],
          ],
          rows,
          { totals: [3, 4, 5, 6, 7, 8, 9, 10] },
        ),
        section(
          t,
          "statutory",
          t.payroll.statutory,
          [
            ["item", t.payroll.item, "text"],
            ["employee", t.payroll.employee, "money"],
            ["employer", t.payroll.employer, "money"],
          ],
          [
            [t.payroll.kinds.nssf, sum(5), sum(5)],
            [t.payroll.kinds.shif, sum(6), 0],
            [t.payroll.kinds.ahl, sum(7), sum(7)],
          ],
          {
            totals: [1, 2],
            notes: [fill(t.payroll.statusNote, { status: t.payroll.statuses.submitted })],
          },
        ),
      ];
    }
    case "cost-ledger": {
      const rows: ReportCell[][] = [
        [day(1), code, "Materials", "B1.2 Concrete", "Bamburi Cement", "INV-0042", 23_200_000, 0],
        [day(3), code, "Labour", "—", "Payroll", "PAY-0007", 4_100_000, 4_100_000],
        [day(5), code, "Plant", "CC-PLANT", "Tatu Plant Hire", "INV-0040", 1_850_000, 1_850_000],
      ];
      return [
        section(
          t,
          "entries",
          t.costLedger.entries,
          [
            ["date", t.costLedger.date, "date"],
            ["project", t.costLedger.project, "text"],
            ["category", t.costLedger.category, "text"],
            ["tag", t.costLedger.tag, "text"],
            ["counterparty", t.costLedger.counterparty, "text"],
            ["document", t.costLedger.document, "text"],
            ["accrued", t.costLedger.accrued, "money"],
            ["paid", t.costLedger.paid, "money"],
          ],
          rows,
          { totals: [6, 7], notes: [t.costLedger.note] },
        ),
        section(
          t,
          "categories",
          t.costLedger.byCategory,
          [
            ["category", t.costLedger.category, "text"],
            ["accrued", t.costLedger.accrued, "money"],
            ["paid", t.costLedger.paid, "money"],
          ],
          rows.map((row) => [row[2]!, row[6]!, row[7]!]),
          { totals: [1, 2] },
        ),
      ];
    }
    case "budget-vs-actual":
      return [
        section(
          t,
          "categories",
          t.budget.categories,
          [
            ["category", t.budget.category, "text"],
            ["budget", t.budget.budget, "money"],
            ["committed", t.budget.committed, "money"],
            ["actual", t.budget.actual, "money"],
            ["paid", t.budget.paid, "money"],
            ["forecast", t.budget.forecast, "money"],
            ["remaining", t.budget.remaining, "money"],
            ["used", t.budget.used, "percent"],
          ],
          [
            [
              "Materials",
              2_600_000_000,
              610_000_000,
              1_900_000_000,
              1_500_000_000,
              2_510_000_000,
              90_000_000,
              "96.5",
            ],
            [
              "Labour",
              1_600_000_000,
              0,
              1_080_000_000,
              950_000_000,
              1_080_000_000,
              520_000_000,
              "67.5",
            ],
          ],
          { totals: [1, 2, 3, 4, 5, 6], notes: [t.budget.note] },
        ),
      ];
    case "stock":
      return [
        section(
          t,
          "on-hand",
          t.stock.onHand,
          [
            ["store", t.stock.store, "text"],
            ["project", t.stock.project, "text"],
            ["code", t.stock.code, "text"],
            ["material", t.stock.material, "text"],
            ["unit", t.stock.unit, "text"],
            ["quantity", t.stock.quantity, "quantity"],
            ["averageCost", t.stock.averageCost, "money"],
            ["value", t.stock.value, "money"],
          ],
          [
            [
              "Main plot store",
              code,
              "MAT-0001",
              "Cement 42.5N (50 kg)",
              "bag",
              "35",
              82_000,
              2_870_000,
            ],
            ["Main plot store", code, "MAT-0002", "River sand", "t", "12.5", 284_000, 3_550_000],
          ],
          { totals: [7], notes: [t.stock.note] },
        ),
        section(
          t,
          "movements",
          t.stock.movements,
          [
            ["date", t.stock.date, "date"],
            ["store", t.stock.store, "text"],
            ["material", t.stock.material, "text"],
            ["kind", t.stock.kind, "text"],
            ["reference", t.stock.reference, "text"],
            ["in", t.stock.in, "quantity"],
            ["out", t.stock.out, "quantity"],
          ],
          [
            [day(4), "Main plot store", "Cement 42.5N (50 kg)", "Receipt", "GRN-0003", "100", null],
            [day(2), "Main plot store", "Cement 42.5N (50 kg)", "Issue", "ISS-0004", null, "65"],
          ],
        ),
      ];
    case "valuations-register":
      return [
        section(
          t,
          "certificates",
          t.valuations.section,
          [
            ["valuation", t.valuations.valuation, "text"],
            ["certificate", t.valuations.certificate, "text"],
            ["date", t.valuations.date, "date"],
            ["status", t.valuations.status, "text"],
            ["gross", t.valuations.gross, "money"],
            ["retention", t.valuations.retention, "money"],
            ["previous", t.valuations.previous, "money"],
            ["due", t.valuations.due, "money"],
            ["vat", t.valuations.vat, "money"],
            ["total", t.valuations.total, "money"],
          ],
          [
            [
              "VAL-01",
              "IPC-01",
              day(40),
              "Certified",
              1_270_000_000,
              63_500_000,
              0,
              1_206_500_000,
              193_040_000,
              1_399_540_000,
            ],
            [
              "VAL-02",
              "IPC-02",
              day(12),
              "Certified",
              1_947_500_000,
              97_375_000,
              1_206_500_000,
              643_625_000,
              102_980_000,
              746_605_000,
            ],
          ],
          { totals: [7, 8, 9], notes: [t.valuations.note] },
        ),
      ];
    case "lpo-register":
      return [
        section(
          t,
          "lpos",
          t.lpo.section,
          [
            ["number", t.lpo.number, "text"],
            ["project", t.lpo.project, "text"],
            ["supplier", t.lpo.supplier, "text"],
            ["status", t.lpo.status, "text"],
            ["created", t.lpo.created, "date"],
            ["subtotal", t.lpo.subtotal, "money"],
            ["vat", t.lpo.vat, "money"],
            ["total", t.lpo.total, "money"],
            ["invoiced", t.lpo.invoiced, "money"],
          ],
          [
            [
              "LPO-0001",
              code,
              "Bamburi Cement",
              "Fully received",
              day(20),
              20_000_000,
              3_200_000,
              23_200_000,
              23_200_000,
            ],
            [
              "LPO-0002",
              code,
              "Tatu Plant Hire",
              "Approved",
              day(6),
              50_000_000,
              8_000_000,
              58_000_000,
              0,
            ],
          ],
          { totals: [5, 6, 7, 8], notes: [t.lpo.note] },
        ),
      ];
    case "invoice-ageing":
      return [
        section(
          t,
          "summary",
          t.ageing.summary,
          [
            ["bucket", t.ageing.bucket, "text"],
            ["count", t.ageing.count, "quantity"],
            ["outstanding", t.ageing.outstanding, "money"],
          ],
          [
            [t.ageing.buckets.current, "1", 23_200_000],
            [t.ageing.buckets["1-30"], "1", 58_000_000],
            [t.ageing.buckets["31-60"], "1", 23_200_000],
            [t.ageing.buckets["61-90"], "0", 0],
            [t.ageing.buckets["over-90"], "0", 0],
          ],
          { totals: [2] },
        ),
        section(
          t,
          "invoices",
          t.ageing.invoices,
          [
            ["invoice", t.ageing.invoice, "text"],
            ["project", t.ageing.project, "text"],
            ["supplier", t.ageing.supplier, "text"],
            ["invoiceDate", t.ageing.invoiceDate, "date"],
            ["dueDate", t.ageing.dueDate, "date"],
            ["total", t.ageing.total, "money"],
            ["paid", t.ageing.paidToDate, "money"],
            ["outstanding", t.ageing.outstanding, "money"],
            ["days", t.ageing.daysOverdue, "quantity"],
            ["bucket", t.ageing.bucket, "text"],
          ],
          [
            [
              "INV-0042",
              code,
              "Bamburi Cement",
              day(10),
              day(-20),
              23_200_000,
              0,
              23_200_000,
              "0",
              t.ageing.buckets.current,
            ],
            [
              "INV-0040",
              code,
              "Tatu Plant Hire",
              day(40),
              day(10),
              58_000_000,
              0,
              58_000_000,
              "10",
              t.ageing.buckets["1-30"],
            ],
            [
              "INV-0031",
              code,
              "Bamburi Cement",
              day(75),
              day(45),
              46_400_000,
              23_200_000,
              23_200_000,
              "45",
              t.ageing.buckets["31-60"],
            ],
          ],
          { totals: [5, 6, 7], notes: [t.ageing.note] },
        ),
      ];
    case "supplier-payments":
      return [
        section(
          t,
          "invoices",
          t.payments.invoices,
          [
            ["invoice", t.payments.invoice, "text"],
            ["project", t.payments.project, "text"],
            ["supplier", t.payments.supplier, "text"],
            ["approved", t.payments.approved, "money"],
            ["before", t.payments.before, "money"],
            ["during", t.payments.during, "money"],
            ["toDate", t.payments.toDate, "money"],
            ["outstanding", t.payments.outstanding, "money"],
            ["state", t.payments.state, "text"],
          ],
          [
            [
              "INV-0031",
              code,
              "Bamburi Cement",
              46_400_000,
              0,
              23_200_000,
              23_200_000,
              23_200_000,
              t.payments.states["part-paid"],
            ],
            [
              "INV-0029",
              code,
              "Tatu Plant Hire",
              18_560_000,
              0,
              18_560_000,
              18_560_000,
              0,
              t.payments.states.paid,
            ],
          ],
          { totals: [3, 4, 5, 6, 7], notes: [t.payments.note] },
        ),
        section(
          t,
          "payments",
          t.payments.payments,
          [
            ["paidOn", t.payments.paidOn, "date"],
            ["invoice", t.payments.invoice, "text"],
            ["method", t.payments.method, "text"],
            ["reference", t.payments.reference, "text"],
            ["amount", t.payments.amount, "money"],
          ],
          [
            [day(8), "INV-0031", "Bank transfer", "EFT-88231", 23_200_000],
            [day(15), "INV-0029", "M-Pesa", "QK7X2LM9PA", 18_560_000],
          ],
          { totals: [4] },
        ),
      ];
    case "petty-cash":
      return [
        section(
          t,
          "floats",
          t.pettyCash.floats,
          [
            ["float", t.pettyCash.float, "text"],
            ["project", t.pettyCash.project, "text"],
            ["custodian", t.pettyCash.custodian, "text"],
            ["opening", t.pettyCash.opening, "money"],
            ["topUps", t.pettyCash.topUps, "money"],
            ["expenses", t.pettyCash.expenses, "money"],
            ["rejected", t.pettyCash.rejected, "money"],
            ["adjustments", t.pettyCash.adjustments, "money"],
            ["closing", t.pettyCash.closing, "money"],
          ],
          [
            [
              "Main plot float",
              code,
              "Kevin Kiprono",
              2_000_000,
              1_000_000,
              1_240_000,
              60_000,
              -20_000,
              1_800_000,
            ],
          ],
          { totals: [3, 4, 5, 6, 7, 8], notes: [t.pettyCash.note] },
        ),
        section(
          t,
          "counts",
          t.pettyCash.counts,
          [
            ["number", t.pettyCash.number, "text"],
            ["countedAt", t.pettyCash.countedAt, "datetime"],
            ["book", t.pettyCash.book, "money"],
            ["counted", t.pettyCash.counted, "money"],
            ["variance", t.pettyCash.variance, "money"],
            ["status", t.pettyCash.status, "text"],
          ],
          [["CNT-0002", `${day(3)}T14:30:00.000Z`, 1_820_000, 1_800_000, -20_000, "Approved"]],
        ),
      ];
    case "safety-actions":
      return [
        section(
          t,
          "incidents",
          t.safety.incidents,
          [
            ["number", t.safety.number, "text"],
            ["occurred", t.safety.occurred, "date"],
            ["site", t.safety.site, "text"],
            ["kind", t.safety.kind, "text"],
            ["severity", t.safety.severity, "text"],
            ["status", t.safety.status, "text"],
            ["actions", t.safety.actionCount, "quantity"],
            ["open", t.safety.openActions, "quantity"],
          ],
          [
            [
              "INC-0001",
              day(9),
              project.sites[0]?.name ?? "—",
              "Near miss",
              "Minor",
              "Open",
              "1",
              "1",
            ],
          ],
          { notes: [t.safety.note] },
        ),
        section(
          t,
          "actions",
          t.safety.actions,
          [
            ["number", t.safety.number, "text"],
            ["source", t.safety.source, "text"],
            ["incident", t.safety.incident, "text"],
            ["owner", t.safety.owner, "text"],
            ["due", t.safety.due, "date"],
            ["status", t.safety.status, "text"],
            ["overdue", t.safety.overdue, "quantity"],
          ],
          [["CA-0001", "Incident", "INC-0001", "Kevin Kiprono", day(2), "Open", "2"]],
        ),
      ];
    case "audit-log": {
      // A long log, so the screen shows the "too many rows for a PDF" path (rows past 200 are
      // only in the Excel file).
      const rowCount = REPORT_LIMITS.pdfMaxRows + 120;
      const rows: ReportCell[][] = Array.from({ length: REPORT_LIMITS.previewRows }, (_, index) => [
        String(rowCount - index),
        new Date(Date.now() - index * 60_000).toISOString(),
        c.actor.displayName,
        index % 2 ? "report.viewed" : "report.exported",
        "report",
        index % 2 ? "report=cost-ledger" : "report=stock format=xlsx",
      ]);
      return [
        section(
          t,
          "events",
          t.audit.section,
          [
            ["sequence", t.audit.sequence, "quantity"],
            ["time", t.audit.time, "datetime"],
            ["actor", t.audit.actor, "text"],
            ["action", t.audit.action, "text"],
            ["resource", t.audit.resource, "text"],
            ["metadata", t.audit.metadata, "text"],
          ],
          rows,
          { rowCount, notes: [t.audit.note] },
        ),
      ];
    }
    case "mpesa-reconciliation":
      throw new Error("not available");
  }
}

// Resolution (the API's ReportsService.resolve) ----------------------------------------------------

type Resolved = {
  params: ReportParams;
  projects: ProjectInfo[];
  site: { id: string; name: string } | null;
  from: string | null;
  to: string | null;
  asAt: string | null;
};

function resolve(
  deps: ReportsDeps,
  state: ReportsState,
  id: ReportId,
  params: ReportParams,
): Resolved {
  const { fail } = deps;
  const definition = REPORT_DEFINITIONS[id];
  const rule = RULES[id];
  const caller = access(deps);
  if (!definition.available) throw fail(409, "report-not-available");
  const today = nairobiDate();
  const resolved: Resolved = {
    params: {},
    projects: [],
    site: null,
    from: null,
    to: null,
    asAt: null,
  };
  if (definition.project === "none") {
    if (!caller.canCompany(rule)) throw fail(403, "report-forbidden");
    if (rule.stepUp) deps.stepUp();
  } else if (params.projectId) {
    const project = deps.projects.find((entry) => entry.id === params.projectId);
    if (!project) throw fail(404, "not-found");
    if (!caller.projectsFor(rule).includes(project)) throw fail(403, "report-forbidden");
    resolved.projects = [project];
    resolved.params.projectId = project.id;
  } else {
    if (definition.project === "required") throw fail(422, "project-required");
    resolved.projects = caller.projectsFor(rule);
    if (!resolved.projects.length) throw fail(403, "report-forbidden");
  }
  if (definition.site) {
    if (!params.siteId) throw fail(422, "site-required");
    const site = resolved.projects[0]!.sites.find((entry) => entry.id === params.siteId);
    if (!site) throw fail(422, "report-parameter-invalid");
    resolved.site = site;
    resolved.params.siteId = site.id;
  }
  if (definition.store && params.storeId) {
    const store = deps.stores.find(
      (entry) =>
        entry.id === params.storeId &&
        resolved.projects.some((project) => project.id === entry.projectId),
    );
    if (!store) throw fail(422, "report-parameter-invalid");
    resolved.params.storeId = store.id;
  }
  if (definition.batch) {
    if (!params.batchId) throw fail(422, "batch-required");
    if (params.batchId !== state.batchId) throw fail(422, "report-parameter-invalid");
    resolved.params.batchId = params.batchId;
  }
  if (definition.actor) {
    if (params.actorId) resolved.params.actorId = params.actorId;
    if (params.action) resolved.params.action = params.action;
  }
  if (definition.period === "range") {
    const result = reportPeriod(definition, params, today);
    if (!result.ok) throw fail(422, result.problem);
    resolved.from = result.period.from;
    resolved.to = result.period.to;
    resolved.params.from = result.period.from;
    resolved.params.to = result.period.to;
  }
  if (definition.period === "as-at") {
    const asAt = params.asAt ?? today;
    if (asAt > today || asAt < addCalendarDays(today, -366)) throw fail(422, "period-invalid");
    resolved.asAt = asAt;
    resolved.params.asAt = asAt;
  }
  return resolved;
}

function model(
  deps: ReportsDeps,
  state: ReportsState,
  id: ReportId,
  query: URLSearchParams,
): ReportModel {
  const { locale, ...params } = deps.parse(reportQuerySchema, Object.fromEntries(query));
  const definition = REPORT_DEFINITIONS[id];
  const allowed = new Set<string>([
    ...(definition.project === "none" ? [] : ["projectId"]),
    ...(definition.site ? ["siteId"] : []),
    ...(definition.store ? ["storeId"] : []),
    ...(definition.batch ? ["batchId"] : []),
    ...(definition.actor ? ["actorId", "action"] : []),
    ...(definition.period === "range" ? ["from", "to"] : []),
    ...(definition.period === "as-at" ? ["asAt"] : []),
  ]);
  if (Object.keys(params).some((key) => !allowed.has(key)))
    throw deps.fail(400, "report-parameter-invalid");
  const resolved = resolve(deps, state, id, params);
  const all = messages(locale);
  const t = all.reportExport;
  const header: ReportModel["parameters"] = [];
  if (definition.project !== "none")
    header.push({
      key: "project",
      label: t.params.project,
      value: resolved.params.projectId
        ? `${resolved.projects[0]!.code} · ${resolved.projects[0]!.name}`
        : fill(t.params.allProjects, { count: resolved.projects.length }),
    });
  if (resolved.site) header.push({ key: "site", label: t.params.site, value: resolved.site.name });
  if (definition.store)
    header.push({
      key: "store",
      label: t.params.store,
      value: resolved.params.storeId
        ? (deps.stores.find((store) => store.id === resolved.params.storeId)?.name ?? "—")
        : t.params.allStores,
    });
  if (resolved.from && resolved.to)
    header.push({
      key: "period",
      label: t.params.period,
      value: fill(t.params.periodValue, { from: resolved.from, to: resolved.to }),
    });
  if (resolved.asAt) header.push({ key: "asAt", label: t.params.asAt, value: resolved.asAt });
  if (definition.actor)
    header.push(
      {
        key: "actor",
        label: t.params.actor,
        value: resolved.params.actorId
          ? (deps.people.find((person) => person.id === resolved.params.actorId)?.displayName ??
            "—")
          : t.params.anyone,
      },
      {
        key: "action",
        label: t.params.action,
        value: resolved.params.action ?? t.params.anyAction,
      },
    );
  const built = sections(id, {
    t,
    projects: resolved.projects.length ? resolved.projects : deps.projects,
    site: resolved.site,
    from: resolved.from,
    to: resolved.to,
    asAt: resolved.asAt,
    labourers: resolved.projects[0] ? deps.labourers(resolved.projects[0].id) : [],
    actor: deps.actor,
  });
  return {
    report: {
      id,
      title: t.catalogue[id].title,
      description: t.catalogue[id].description,
    },
    locale,
    company: { name: deps.companyName },
    parameters: header,
    query: resolved.params,
    generatedAt: new Date().toISOString(),
    generatedBy: { displayName: deps.actor.displayName },
    sections: built,
    notes: [],
    truncated: built.some((entry) => entry.rows.length < entry.rowCount),
  };
}

/** PDF/Excel bytes of a report the caller may run (same checks as the preview). */
export function reportExport(
  deps: ReportsDeps,
  state: ReportsState,
  path: string,
  query: URLSearchParams,
): { contentType: string; content: Buffer; filename: string } {
  const match = /^\/reports\/([^/]+)\/export\/(pdf|xlsx)$/.exec(path)!;
  const id = reportId(deps, match[1]!);
  const built = model(deps, state, id, query);
  const rows = built.sections.reduce((total, entry) => total + entry.rowCount, 0);
  if (match[2] === "pdf") {
    if (rows > REPORT_LIMITS.pdfMaxRows) throw deps.fail(422, "use-excel");
    return {
      contentType: "application/pdf",
      content: Buffer.from(`%PDF-1.4\n% ${built.report.title} (mock)\n%%EOF\n`),
      filename: `${id}.pdf`,
    };
  }
  return {
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    content: Buffer.from(`PK mock ${built.report.title}`),
    filename: `${id}.xlsx`,
  };
}

function reportId(deps: ReportsDeps, value: string): ReportId {
  if (!(REPORT_IDS as readonly string[]).includes(value)) throw deps.fail(404, "not-found");
  return value as ReportId;
}

// Subscriptions -----------------------------------------------------------------------------------

function parameterText(deps: ReportsDeps, parameters: MockSubscription["parameters"]) {
  const project = deps.projects.find((entry) => entry.id === parameters.projectId);
  const parts = [
    project ? project.code : null,
    project?.sites.find((site) => site.id === parameters.siteId)?.name ?? null,
    deps.stores.find((store) => store.id === parameters.storeId)?.name ?? null,
    parameters.action ?? null,
  ].filter((part): part is string => !!part);
  return parts.join(" · ");
}

function subscriptionView(
  deps: ReportsDeps,
  state: ReportsState,
  entry: MockSubscription,
  locale: Locale,
): ReportSubscription {
  const last = state.runs.filter((run) => run.subscriptionId === entry.id).at(-1);
  return {
    id: entry.id,
    report: {
      id: entry.reportId,
      title: messages(locale).reportExport.catalogue[entry.reportId].title,
    },
    parameters: entry.parameters,
    parameterText: parameterText(deps, entry.parameters),
    frequency: entry.frequency,
    weekday: entry.weekday,
    dayOfMonth: entry.dayOfMonth,
    locale: entry.locale,
    status: entry.status,
    nextRunAt: entry.status === "active" ? entry.nextRunAt : null,
    lastRun: last ? { outcome: last.outcome, reason: last.reason, at: last.createdAt } : null,
    subscriber: entry.subscriber,
    createdAt: entry.createdAt,
    version: entry.version,
    mine: entry.subscriber.id === deps.actor.id,
  };
}

const scheduleOf = (entry: MockSubscription) =>
  entry.frequency === "weekly"
    ? { frequency: "weekly" as const, weekday: entry.weekday as IsoWeekday }
    : { frequency: "monthly" as const, dayOfMonth: entry.dayOfMonth! };

function own(deps: ReportsDeps, state: ReportsState, id: string, version: number) {
  const entry = state.subscriptions.find(
    (candidate) => candidate.id === id && candidate.status !== "deleted",
  );
  if (!entry) throw deps.fail(404, "not-found");
  if (entry.subscriber.id !== deps.actor.id) throw deps.fail(403, "forbidden");
  if (entry.version !== version) throw deps.fail(409, "version-conflict");
  return entry;
}

export function handleReports(
  deps: ReportsDeps,
  state: ReportsState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): Reply | null {
  const { fail, parse } = deps;
  const locale: Locale = query.get("locale") === "sw" ? "sw" : "en";
  if (path === "/dashboard" && method === "GET")
    return { body: dashboard(deps), schema: dashboardResponseSchema };
  if (path === "/reports" && method === "GET") {
    const caller = access(deps);
    if (!caller.reportsSomewhere) throw fail(403, "report-forbidden");
    const t = messages(locale).reportExport;
    return {
      body: {
        reports: REPORT_IDS.map((id) => {
          const definition = REPORT_DEFINITIONS[id];
          const projects =
            definition.project === "none" ? [] : caller.projectsFor(RULES[id]).map(ref);
          const canRun =
            definition.available &&
            (definition.project === "none" ? caller.canCompany(RULES[id]) : projects.length > 0);
          return {
            id,
            group: definition.group,
            title: t.catalogue[id].title,
            description: t.catalogue[id].description,
            available: definition.available,
            availableWith: definition.availableWith,
            canRun,
            projects: definition.available ? projects : [],
            acrossProjects: canRun && definition.project === "optional",
            rule: t.catalogue[id].rule,
          };
        }),
        canSubscribe: caller.reportsSomewhere,
        canManageSubscriptions: deps.companyPermissions.includes(
          REPORT_SUBSCRIPTION_ADMIN_PERMISSION,
        ),
      },
      schema: reportsResponseSchema,
    };
  }
  const canManage = deps.companyPermissions.includes(REPORT_SUBSCRIPTION_ADMIN_PERMISSION);
  if (path === "/reports/subscriptions" && method === "GET") {
    if (!access(deps).reportsSomewhere && !canManage) throw fail(403, "report-forbidden");
    const scope = query.get("scope") === "company" ? "company" : "mine";
    if (scope === "company" && !canManage) throw fail(403, "forbidden");
    const listed = state.subscriptions.filter(
      (entry) =>
        entry.status !== "deleted" &&
        (scope === "company" || entry.subscriber.id === deps.actor.id),
    );
    const ids = new Set(listed.map((entry) => entry.id));
    return {
      body: {
        scope,
        subscriptions: listed.map((entry) => subscriptionView(deps, state, entry, locale)),
        runs: state.runs
          .filter((run) => ids.has(run.subscriptionId))
          .slice()
          .reverse()
          .slice(0, 100)
          .map((run) => {
            const entry = state.subscriptions.find((sub) => sub.id === run.subscriptionId)!;
            return {
              ...run,
              report: {
                id: entry.reportId,
                title: messages(locale).reportExport.catalogue[entry.reportId].title,
              },
              subscriber: entry.subscriber,
            };
          }),
        canManage,
        sendHour: REPORT_LIMITS.sendHourNairobi,
      },
      schema: reportSubscriptionsResponseSchema,
    };
  }
  if (path === "/reports/subscriptions" && method === "POST") {
    const request = parse(createSubscriptionRequestSchema, body);
    if (!deps.actor.email) throw fail(422, "email-required");
    const live = state.subscriptions.filter(
      (entry) => entry.status !== "deleted" && entry.subscriber.id === deps.actor.id,
    );
    if (live.length >= REPORT_LIMITS.subscriptionsPerUser) throw fail(409, "subscription-limit");
    resolve(deps, state, request.reportId, request.parameters);
    const key = (parameters: object) => JSON.stringify(Object.entries(parameters).sort());
    if (
      live.some(
        (entry) =>
          entry.reportId === request.reportId &&
          entry.frequency === request.frequency &&
          key(entry.parameters) === key(request.parameters),
      )
    )
      throw fail(409, "subscription-exists");
    const entry: MockSubscription = {
      id: randomUUID(),
      subscriber: { id: deps.actor.id, displayName: deps.actor.displayName },
      reportId: request.reportId,
      parameters: request.parameters,
      frequency: request.frequency,
      weekday: request.frequency === "weekly" ? request.weekday! : null,
      dayOfMonth: request.frequency === "monthly" ? request.dayOfMonth! : null,
      locale: request.locale,
      status: "active",
      nextRunAt: null,
      createdAt: new Date().toISOString(),
      version: 1,
    };
    entry.nextRunAt = nextReportRun(
      scheduleOf(entry),
      new Date(),
      REPORT_LIMITS.sendHourNairobi,
    ).toISOString();
    state.subscriptions.push(entry);
    return {
      status: 201,
      body: { subscription: subscriptionView(deps, state, entry, locale) },
      schema: reportSubscriptionResponseSchema,
    };
  }
  if (path === "/reports/subscriptions/run-due" && method === "POST") {
    if (!canManage) throw fail(403, "forbidden");
    const now = new Date();
    const due = state.subscriptions.filter(
      (entry) => entry.status === "active" && entry.nextRunAt && new Date(entry.nextRunAt) <= now,
    );
    for (const entry of due) {
      const runDate = nairobiDate(new Date(entry.nextRunAt!));
      const period =
        REPORT_DEFINITIONS[entry.reportId].period === "range"
          ? scheduledPeriod(entry.frequency, runDate)
          : null;
      state.runs.push({
        id: randomUUID(),
        subscriptionId: entry.id,
        dueAt: entry.nextRunAt!,
        outcome: "sent",
        reason: null,
        periodFrom: period?.from ?? null,
        periodTo: period?.to ?? null,
        createdAt: now.toISOString(),
      });
      entry.nextRunAt = nextReportRun(
        scheduleOf(entry),
        now,
        REPORT_LIMITS.sendHourNairobi,
      ).toISOString();
    }
    return {
      body: { claimed: due.length, sent: due.length, skipped: 0, failed: 0 },
      schema: runDueResponseSchema,
    };
  }
  const update = /^\/reports\/subscriptions\/([^/]+)$/.exec(path);
  if (update && method === "PATCH") {
    const request = parse(updateSubscriptionRequestSchema, body);
    const entry = own(deps, state, update[1]!, request.version);
    if (entry.status === request.status) throw fail(409, "invalid-transition");
    entry.status = request.status;
    entry.version += 1;
    if (request.status === "active")
      entry.nextRunAt = nextReportRun(
        scheduleOf(entry),
        new Date(),
        REPORT_LIMITS.sendHourNairobi,
      ).toISOString();
    return {
      body: { subscription: subscriptionView(deps, state, entry, locale) },
      schema: reportSubscriptionResponseSchema,
    };
  }
  const remove = /^\/reports\/subscriptions\/([^/]+)\/delete$/.exec(path);
  if (remove && method === "POST") {
    const request = parse(deleteSubscriptionRequestSchema, body);
    const entry = own(deps, state, remove[1]!, request.version);
    entry.status = "deleted";
    entry.version += 1;
    entry.nextRunAt = null;
    return {
      body: { subscription: subscriptionView(deps, state, entry, locale) },
      schema: reportSubscriptionResponseSchema,
    };
  }
  const options = /^\/reports\/([^/]+)\/options$/.exec(path);
  if (options && method === "GET") {
    const id = reportId(deps, options[1]!);
    const definition = REPORT_DEFINITIONS[id];
    const projects = access(deps).projectsFor(RULES[id]);
    const projectId = query.get("projectId");
    const project = projectId ? projects.find((entry) => entry.id === projectId) : undefined;
    if (projectId && !project) throw fail(403, "report-forbidden");
    if (definition.project !== "none" && !projects.length) throw fail(403, "report-forbidden");
    if (definition.project === "none" && !access(deps).canCompany(RULES[id]))
      throw fail(403, "report-forbidden");
    const scoped = project ? [project] : projects;
    return {
      body: {
        sites: definition.site && project ? project.sites : [],
        stores: definition.store
          ? deps.stores.flatMap((store) => {
              const owner = scoped.find((entry) => entry.id === store.projectId);
              return owner ? [{ id: store.id, name: store.name, project: ref(owner) }] : [];
            })
          : [],
        batches:
          definition.batch && project && project === projects[0]
            ? [
                {
                  id: state.batchId,
                  periodStart: addCalendarDays(nairobiDate(), -13),
                  periodEnd: addCalendarDays(nairobiDate(), -7),
                  payDate: addCalendarDays(nairobiDate(), -6),
                  status: "submitted",
                },
              ]
            : [],
        actors: definition.actor ? deps.people : [],
      },
      schema: reportOptionsResponseSchema,
    };
  }
  const preview = /^\/reports\/([^/]+)$/.exec(path);
  if (preview && method === "GET") {
    const id = reportId(deps, preview[1]!);
    return { body: model(deps, state, id, query), schema: reportModelSchema };
  }
  return null;
}
