import { createHash } from "node:crypto";
import { ForbiddenException, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { addCalendarDays, nairobiDate, percentOf } from "@pm-buddy/domain";
import {
  PLANT_READ_PERMISSIONS,
  QUALITY_READ_PERMISSIONS,
  REPORT_LIMITS,
  SAFETY_READ_PERMISSIONS,
  SPENDING_READ_PERMISSIONS,
  VALUATION_READ_PERMISSIONS,
  type Permission,
} from "@pm-buddy/types";
import {
  dashboardResponseSchema,
  plantAlertsQuerySchema,
  type DashboardResponse,
} from "@pm-buddy/validation";
import type { Scope } from "../identity/access-policy.js";
import { AuthSecurity } from "../identity/auth-security.service.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { CashFlowService } from "../finance/cash-flow.service.js";
import { SpendAlertsService } from "../finance/spend-alerts.service.js";
import { SpendingReportService } from "../finance/spending-report.service.js";
import { PlantRegisterService } from "../plant/plant-register.service.js";
import { P2P_VIEW_PERMISSIONS, P2pAccess } from "../procurement/p2p/p2p-common.js";
import { STORES_VIEW_PERMISSIONS } from "../procurement/stores/stores-common.js";
import { StoresService } from "../procurement/stores/stores.service.js";
import { ProjectsService } from "../projects/projects.service.js";
import { ValuationsService } from "../progress/valuations/valuations.service.js";
import { SafetySettingsService } from "../safety/safety-settings.service.js";
import { fromDay } from "./report-model.js";
import { ReportsAccess, type ReportCaller } from "./reports-access.js";

/** Supplier invoices due within this many days count as "due soon". */
const DUE_SOON_DAYS = 7;
/** Forecast weeks shown on the dashboard (the full forecast is on the spending page). */
const FORECAST_WEEKS = 6;
/** At most this many cached dashboards per API instance (oldest dropped first). */
const DASHBOARD_CACHE_ENTRIES = 500;

const somewhere = (
  caller: ReportCaller,
  permissions: readonly Permission[],
  also: readonly Permission[] = [],
) =>
  [...caller.projects.values()].filter(
    (project) =>
      permissions.some((permission) => project.effective.has(permission)) &&
      also.every((permission) => project.effective.has(permission)),
  );

/** Runs a source screen's read; a 403 from it omits the section, anything else is an error. */
async function optional<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ForbiddenException) return undefined;
    throw error;
  }
}

/**
 * The owner dashboard (D-121): one call, sections built from the reads behind their source
 * screens — the projects list, valuations overview, spending summary, company forecast, spend
 * alerts, stores, plant alerts and safety overview through their own services (each with its own
 * permission check), and today's attendance, invoices due and open snags and inspections with
 * bounded grouped queries filtered by the same permission sets. A section the caller may not see is
 * left out (never zero); undefined ratios are null.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: ReportsAccess,
    private readonly p2p: P2pAccess,
    private readonly projects: ProjectsService,
    private readonly valuations: ValuationsService,
    private readonly spending: SpendingReportService,
    private readonly cashFlow: CashFlowService,
    private readonly spendAlerts: SpendAlertsService,
    private readonly stores: StoresService,
    private readonly plant: PlantRegisterService,
    private readonly safety: SafetySettingsService,
    private readonly security: AuthSecurity,
  ) {}

  /** Recent dashboards per company, user and access fingerprint (see REPORT_LIMITS). */
  private readonly cache = new Map<string, { expires: number; value: DashboardResponse }>();

  /**
   * The dashboard, rate-limited per user and reused for a minute while the caller's access is
   * unchanged: it reads every visible project's summaries through the source services, so
   * reloading the landing page must not repeat that work each time.
   */
  async get(principal: Principal, req: Request): Promise<DashboardResponse> {
    await this.security.limit(
      `dashboard:${principal.user.id}`,
      REPORT_LIMITS.dashboardsPerMinute,
      60,
    );
    const fingerprint = await this.scope.run(
      principal,
      req,
      async (scope) => (await this.access.caller(scope)).fingerprint,
    );
    const key = [
      principal.session.activeTenantId,
      principal.user.id,
      createHash("sha256").update(fingerprint).digest("hex"),
    ].join(":");
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now() && cached.value.today === nairobiDate())
      return cached.value;
    const value = await this.build(principal, req);
    this.remember(key, value);
    return value;
  }

  private remember(key: string, value: DashboardResponse) {
    const now = Date.now();
    if (this.cache.size >= DASHBOARD_CACHE_ENTRIES)
      for (const [entry, { expires }] of this.cache) if (expires <= now) this.cache.delete(entry);
    while (this.cache.size >= DASHBOARD_CACHE_ENTRIES)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.delete(key);
    this.cache.set(key, { expires: now + REPORT_LIMITS.dashboardCacheSeconds * 1000, value });
  }

  private async build(principal: Principal, req: Request): Promise<DashboardResponse> {
    const today = nairobiDate();
    const local = await this.scope.run(principal, req, async (scope) => {
      const caller = await this.access.caller(scope);
      const finance = SPENDING_READ_PERMISSIONS.some((permission) => caller.role.has(permission));
      const visible = {
        projects: somewhere(caller, ["projects.view"]).length > 0,
        valuations: somewhere(caller, VALUATION_READ_PERMISSIONS).length > 0,
        spending: somewhere(caller, SPENDING_READ_PERMISSIONS).length > 0,
        forecast: caller.tenantWide && finance,
        stock: somewhere(caller, STORES_VIEW_PERMISSIONS).length > 0,
        plant: somewhere(caller, PLANT_READ_PERMISSIONS, ["projects.view"]).length > 0,
        safety: somewhere(caller, SAFETY_READ_PERMISSIONS, ["projects.view"]).length > 0,
      };
      return {
        visible,
        attendance: await this.attendance(scope, caller, today),
        invoices: await this.invoices(scope, today),
        quality: await this.quality(scope, caller),
      };
    });
    const { visible } = local;
    const [projectList, valuations, spending, forecast, alerts, stores, plant, safety] =
      await Promise.all([
        visible.projects ? optional(() => this.projects.list(principal, {}, req)) : undefined,
        visible.valuations ? optional(() => this.valuations.overview(principal, req)) : undefined,
        visible.spending ? optional(() => this.spending.summary(principal, req)) : undefined,
        visible.forecast
          ? optional(() => this.cashFlow.forecast(principal, undefined, req))
          : undefined,
        visible.spending
          ? optional(() => this.spendAlerts.list(principal, { limit: 1 }, req))
          : undefined,
        visible.stock ? optional(() => this.stores.list(principal, req)) : undefined,
        visible.plant
          ? optional(() =>
              this.plant.alerts(principal, plantAlertsQuerySchema.parse({ limit: 1 }), req),
            )
          : undefined,
        visible.safety ? optional(() => this.safety.overview(principal, req)) : undefined,
      ]);

    const certified = new Map(
      (valuations?.projects ?? [])
        .filter((row) => row.canReadValuations && row.certifiedMinor !== null)
        .map((row) => [row.project.id, row]),
    );
    const response: DashboardResponse = {
      today,
      generatedAt: new Date().toISOString(),
    };
    if (projectList)
      response.projects = projectList.projects.map((project) => {
        const position = certified.get(project.id);
        return {
          project: { id: project.id, code: project.code, name: project.name },
          status: project.status,
          contractSumMinor: project.contractSumMinor,
          ...(position
            ? {
                certified: {
                  certifiedMinor: position.certifiedMinor!,
                  percentOfContract: percentOf(
                    position.certifiedMinor!,
                    position.contractSum?.revisedMinor ?? null,
                  ),
                  retentionHeldMinor: position.retentionHeldMinor ?? 0,
                  latest: position.latestCertificate
                    ? {
                        number: position.latestCertificate.certificateNumber,
                        date: position.latestCertificate.valuationDate,
                        amountDueMinor: position.latestCertificate.amountDueMinor,
                      }
                    : null,
                },
              }
            : {}),
        };
      });
    if (spending) {
      const rows = spending.projects;
      const total = (pick: (row: (typeof rows)[number]) => number) =>
        rows.reduce((sum, row) => sum + pick(row), 0);
      const budgets = rows.filter((row) => row.figures.budgetMinor !== null);
      const budgetMinor = budgets.length
        ? budgets.reduce((sum, row) => sum + row.figures.budgetMinor!, 0)
        : null;
      response.spending = {
        thresholdPercent: spending.thresholdPercent,
        totals: {
          budgetMinor,
          committedMinor: total((row) => row.figures.committedMinor),
          actualMinor: total((row) => row.figures.actualMinor),
          paidMinor: total((row) => row.figures.paidMinor),
          usedPercent:
            budgetMinor === null
              ? null
              : percentOf(
                  budgets.reduce((sum, row) => sum + row.figures.forecastMinor, 0),
                  budgetMinor,
                ),
        },
        projects: rows.map((row) => ({
          project: row.project,
          budgetMinor: row.figures.budgetMinor,
          committedMinor: row.figures.committedMinor,
          actualMinor: row.figures.actualMinor,
          paidMinor: row.figures.paidMinor,
          usedPercent: row.figures.usedPercent,
          level: row.figures.level,
        })),
      };
    }
    if (forecast)
      response.forecast = {
        openingMinor: forecast.opening.amountMinor,
        weeks: forecast.weeks.slice(0, FORECAST_WEEKS).map((week) => ({
          start: week.start,
          inMinor: week.inMinor,
          outMinor: week.outMinor,
          closingMinor: week.closingMinor,
        })),
        overdueOutMinor: forecast.weeks[0]?.overdueMinor ?? 0,
      };
    if (alerts)
      response.spendAlerts = {
        counts: alerts.counts,
        total: Object.values(alerts.counts).reduce((sum, count) => sum + count, 0),
      };
    if (local.attendance) response.attendance = local.attendance;
    if (local.invoices) response.invoices = local.invoices;
    if (stores)
      response.stock = {
        valueMinor: stores.totalValueMinor,
        lowStock: stores.lowStock.length,
        items: stores.lowStock.slice(0, 5).map((item) => ({
          store: item.store.name,
          material: item.material.name,
          quantity: item.quantity,
          reorderLevel: item.reorderLevel,
          unit: item.material.baseUnit,
        })),
      };
    if (plant)
      response.plant = {
        counts: plant.counts,
        total: Object.values(plant.counts).reduce((sum, count) => sum + count, 0),
      };
    if (safety) {
      const rows = safety.projects;
      response.safety = {
        openIncidents: rows.reduce((sum, row) => sum + row.openIncidents, 0),
        overdueActions: rows.reduce((sum, row) => sum + row.overdueActions, 0),
        projects: rows.map((row) => ({
          project: { id: row.id, code: row.code, name: row.name },
          openIncidents: row.openIncidents,
          overdueActions: row.overdueActions,
        })),
      };
    }
    if (local.quality) response.quality = local.quality;
    return dashboardResponseSchema.parse(response);
  }

  /** Today's records (any day status) per project where the caller holds attendance.view. */
  private async attendance(scope: Scope, caller: ReportCaller, today: string) {
    const readable = somewhere(caller, ["attendance.view"]);
    if (!readable.length) return undefined;
    const projects = readable.filter(
      (project) => !["closed", "cancelled"].includes(project.status),
    );
    const { tx, access } = scope;
    const ids = projects.map((project) => project.id);
    const [records, sites, days] = await Promise.all([
      tx.attendanceRecord.groupBy({
        by: ["projectId", "status"],
        where: { tenantId: access.tenantId, projectId: { in: ids }, workDate: fromDay(today) },
        _count: { _all: true },
      }),
      tx.site.groupBy({
        by: ["projectId"],
        where: { tenantId: access.tenantId, projectId: { in: ids } },
        _count: { _all: true },
      }),
      tx.attendanceDay.groupBy({
        by: ["projectId"],
        where: { tenantId: access.tenantId, projectId: { in: ids }, workDate: fromDay(today) },
        _count: { _all: true },
      }),
    ]);
    const countOf = (projectId: string, status: string) =>
      records.find((row) => row.projectId === projectId && row.status === status)?._count._all ?? 0;
    const rows = projects.map((project) => ({
      project: { id: project.id, code: project.code, name: project.name },
      present: countOf(project.id, "present"),
      halfDay: countOf(project.id, "half_day"),
      absent: countOf(project.id, "absent"),
      sites: sites.find((row) => row.projectId === project.id)?._count._all ?? 0,
      sitesRecorded: days.find((row) => row.projectId === project.id)?._count._all ?? 0,
    }));
    return {
      date: today,
      present: rows.reduce((sum, row) => sum + row.present, 0),
      halfDay: rows.reduce((sum, row) => sum + row.halfDay, 0),
      absent: rows.reduce((sum, row) => sum + row.absent, 0),
      projects: rows,
    };
  }

  /** Approved supplier invoices not fully paid, overdue or due within a week (procurement viewers). */
  private async invoices(scope: Scope, today: string) {
    const { access } = scope;
    const role = access.permissions;
    const companyLevel = role.has("procurement.manage_suppliers");
    if (!companyLevel && !P2P_VIEW_PERMISSIONS.some((permission) => role.has(permission)))
      return undefined;
    const ids = await this.p2p.visibleProjectIds(scope);
    if (!ids.length && !access.tenantWide && !companyLevel) return undefined;
    const rows = ids.length
      ? await scope.tx.$queryRaw<{ overdue: boolean; count: bigint; outstanding: bigint }[]>`
          SELECT x.due_date < ${fromDay(today)}::date AS overdue, count(*)::bigint AS count,
                 COALESCE(sum(x.outstanding), 0)::bigint AS outstanding
            FROM (SELECT i.due_date, i.total_minor - COALESCE((
                    SELECT sum(s.amount_minor) FROM invoice_settlements s
                     WHERE s.tenant_id = i.tenant_id AND s.invoice_id = i.id), 0) AS outstanding
                    FROM supplier_invoices i
                   WHERE i.tenant_id = ${access.tenantId}::uuid
                     AND i.project_id = ANY(${ids}::uuid[])
                     AND i.status IN ('approved', 'partly_settled')
                     AND i.due_date <= ${fromDay(addCalendarDays(today, DUE_SOON_DAYS))}::date) x
           WHERE x.outstanding > 0
           GROUP BY 1`
      : [];
    const pick = (overdue: boolean) => {
      const row = rows.find((entry) => entry.overdue === overdue);
      return { count: Number(row?.count ?? 0n), outstandingMinor: Number(row?.outstanding ?? 0n) };
    };
    return { windowDays: DUE_SOON_DAYS, dueSoon: pick(false), overdue: pick(true) };
  }

  /** Open snags (open or fixed, not yet closed) and inspections awaiting sign-off. */
  private async quality(scope: Scope, caller: ReportCaller) {
    const projects = somewhere(caller, QUALITY_READ_PERMISSIONS, ["projects.view"]);
    if (!projects.length) return undefined;
    const { tx, access } = scope;
    const ids = projects.map((project) => project.id);
    const [snags, inspections] = await Promise.all([
      tx.snag.groupBy({
        by: ["projectId"],
        where: {
          tenantId: access.tenantId,
          projectId: { in: ids },
          status: { in: ["open", "fixed"] },
        },
        _count: { _all: true },
      }),
      tx.inspection.groupBy({
        by: ["projectId"],
        where: { tenantId: access.tenantId, projectId: { in: ids }, status: "submitted" },
        _count: { _all: true },
      }),
    ]);
    const rows = projects.map((project) => ({
      project: { id: project.id, code: project.code, name: project.name },
      openSnags: snags.find((row) => row.projectId === project.id)?._count._all ?? 0,
      inspectionsAwaitingSignOff:
        inspections.find((row) => row.projectId === project.id)?._count._all ?? 0,
    }));
    return {
      openSnags: rows.reduce((sum, row) => sum + row.openSnags, 0),
      inspectionsAwaitingSignOff: rows.reduce(
        (sum, row) => sum + row.inspectionsAwaitingSignOff,
        0,
      ),
      projects: rows,
    };
  }
}
