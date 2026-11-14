import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { addCalendarDays, contentDisposition, nairobiDate, reportPeriod } from "@pm-buddy/domain";
import { messages } from "@pm-buddy/i18n";
import {
  REPORT_DEFINITIONS,
  REPORT_IDS,
  REPORT_LIMITS,
  type Locale,
  type PayrollBatchStatus,
  type ReportId,
} from "@pm-buddy/types";
import {
  reportModelSchema,
  reportOptionsResponseSchema,
  reportsResponseSchema,
  type ReportModel,
  type ReportParams,
  type ReportQuery,
} from "@pm-buddy/validation";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import { AuthSecurity } from "../identity/auth-security.service.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { SpendingReportService } from "../finance/spending-report.service.js";
import { REPORT_BUILDERS, REPORT_RULES } from "./report-registry.js";
import {
  assertPdfFits,
  day,
  renderPdf,
  renderXlsx,
  reportFileName,
  totalRows,
  XLSX_CONTENT_TYPE,
} from "./report-renderer.js";
import { fill, tooLarge, type ResolvedParams } from "./report-model.js";
import {
  reportProblem,
  ReportsAccess,
  type ReportCaller,
  type ReportProject,
} from "./reports-access.js";

export type ReportMode = "preview" | "pdf" | "xlsx";

const ID_PARAMS = ["projectId", "siteId", "storeId", "batchId", "actorId"] as const;

/**
 * The reports centre (D8.1, ARCHITECTURE §4.14): the list of reports with what the caller may run,
 * parameter options, and every report built from the code registry into one typed model — shown
 * on screen (rows limited) or rendered as PDF or Excel. Each report checks `reports.view` and its
 * source screen's permission on the same project (report-registry.ts), is rate limited and
 * audited with IDs only (`report.viewed`, `report.exported`).
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: ReportsAccess,
    private readonly policy: AccessPolicy,
    private readonly security: AuthSecurity,
    private readonly spending: SpendingReportService,
  ) {}

  list(principal: Principal, locale: Locale, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.access.caller(scope);
      if (!caller.reportsSomewhere) throw forbidden();
      const t = messages(locale).reportExport;
      return reportsResponseSchema.parse({
        reports: REPORT_IDS.map((id) => {
          const definition = REPORT_DEFINITIONS[id];
          const rule = REPORT_RULES[id];
          const projects =
            definition.project === "none"
              ? []
              : caller.projectsFor(rule).map(({ id: projectId, code, name }) => ({
                  id: projectId,
                  code,
                  name,
                }));
          const canRun =
            definition.available &&
            (definition.project === "none" ? caller.canCompany(rule) : projects.length > 0);
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
        canManageSubscriptions: scope.access.permissions.has("config.manage"),
      });
    });
  }

  /** Sites, stores, payroll batches or people for a report's parameter form. */
  options(principal: Principal, id: ReportId, projectId: string | undefined, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const caller = await this.access.caller(scope);
      const definition = REPORT_DEFINITIONS[id];
      const rule = REPORT_RULES[id];
      if (!definition.available)
        throw reportProblem(409, "report-not-available", "This report is not available yet");
      let projects: ReportProject[] = [];
      if (definition.project === "none") {
        if (!caller.canCompany(rule)) throw forbidden();
      } else if (projectId) {
        projects = [await this.projectOf(scope, caller, rule, projectId)];
      } else {
        projects = caller.projectsFor(rule);
        if (!projects.length) throw forbidden();
      }
      const ids = projects.map((project) => project.id);
      const one = projectId ?? null;
      const [sites, stores, batches, actors] = await Promise.all([
        definition.site && one
          ? tx.site.findMany({
              where: { tenantId: access.tenantId, projectId: one },
              select: { id: true, name: true },
              orderBy: { name: "asc" },
            })
          : [],
        definition.store
          ? tx.store.findMany({
              where: { tenantId: access.tenantId, projectId: { in: ids } },
              select: { id: true, name: true, projectId: true },
              orderBy: { name: "asc" },
            })
          : [],
        definition.batch && one
          ? tx.payrollBatch.findMany({
              where: { tenantId: access.tenantId, projectId: one, status: { not: "cancelled" } },
              select: { id: true, periodStart: true, periodEnd: true, payDate: true, status: true },
              orderBy: [{ periodStart: "desc" }, { id: "desc" }],
              take: 100,
            })
          : [],
        definition.actor
          ? tx.membership.findMany({
              where: { tenantId: access.tenantId },
              select: { user: { select: { id: true, displayName: true } } },
              orderBy: { user: { displayName: "asc" } },
              take: 500,
            })
          : [],
      ]);
      const byId = new Map(projects.map((project) => [project.id, project]));
      const iso = (value: Date) => value.toISOString().slice(0, 10);
      return reportOptionsResponseSchema.parse({
        sites,
        stores: stores.map((store) => {
          const project = byId.get(store.projectId)!;
          return {
            id: store.id,
            name: store.name,
            project: { id: project.id, code: project.code, name: project.name },
          };
        }),
        batches: batches.map((batch) => ({
          id: batch.id,
          periodStart: iso(batch.periodStart),
          periodEnd: iso(batch.periodEnd),
          payDate: iso(batch.payDate),
          status: batch.status,
        })),
        actors: actors.map((member) => member.user),
      });
    });
  }

  /** The project (404 outside the company, 403 without the report's permission on it). */
  private async projectOf(
    scope: Scope,
    caller: ReportCaller,
    rule: (typeof REPORT_RULES)[ReportId],
    projectId: string,
  ): Promise<ReportProject> {
    if (!caller.canOn(projectId, rule)) {
      const exists = await scope.tx.project.findUnique({
        where: { tenantId_id: { tenantId: scope.access.tenantId, id: projectId } },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException("Project not found");
      throw forbidden();
    }
    return caller.projects.get(projectId)!;
  }

  /**
   * Checks a report's parameters for the caller and resolves them (the scheduler uses the same
   * check before sending a link): only the parameters the report takes, the project's own sites,
   * stores and batches, the period within the report's limit, and the permission rule.
   */
  async resolve(
    scope: Scope,
    caller: ReportCaller,
    id: ReportId,
    params: ReportParams,
    today: string,
    options: { scheduled?: boolean } = {},
  ): Promise<{ resolved: ResolvedParams; projects: ReportProject[] }> {
    const definition = REPORT_DEFINITIONS[id];
    const rule = REPORT_RULES[id];
    if (!definition.available || !REPORT_BUILDERS[id])
      throw reportProblem(409, "report-not-available", "This report is not available yet");
    const allowed = new Set<string>([
      ...(definition.project === "none" ? [] : ["projectId"]),
      ...(definition.site ? ["siteId"] : []),
      ...(definition.store ? ["storeId"] : []),
      ...(definition.batch ? ["batchId"] : []),
      ...(definition.actor ? ["actorId", "action"] : []),
      ...(definition.period === "range" ? ["from", "to"] : []),
      ...(definition.period === "as-at" ? ["asAt"] : []),
    ]);
    const extra = Object.entries(params).find(
      ([key, value]) => value !== undefined && !allowed.has(key),
    );
    if (extra)
      throw reportProblem(
        400,
        "report-parameter-invalid",
        `This report does not take the parameter ${extra[0]}`,
      );
    const { tx, access } = scope;
    const resolved: ResolvedParams = {};
    let projects: ReportProject[] = [];
    if (definition.project === "none") {
      if (!caller.canCompany(rule)) throw forbidden();
      // A scheduled run only checks the permission: its email holds a link, and opening the link
      // asks for the same recent MFA check as the source screen.
      if (rule.stepUp && !options.scheduled) this.policy.stepUp(scope);
    } else if (params.projectId) {
      projects = [await this.projectOf(scope, caller, rule, params.projectId)];
      resolved.projectId = params.projectId;
    } else {
      if (definition.project === "required")
        throw reportProblem(422, "project-required", "Choose a project");
      projects = caller.projectsFor(rule);
      if (!projects.length) throw forbidden();
    }
    if (definition.site) {
      if (!params.siteId) throw reportProblem(422, "site-required", "Choose a site");
      const site = await tx.site.findFirst({
        where: { tenantId: access.tenantId, projectId: resolved.projectId!, id: params.siteId },
        select: { id: true },
      });
      if (!site) throw invalid("The site is not one of this project's sites");
      resolved.siteId = params.siteId;
    }
    if (definition.store && params.storeId) {
      const store = await tx.store.findFirst({
        where: {
          tenantId: access.tenantId,
          id: params.storeId,
          projectId: { in: projects.map((project) => project.id) },
        },
        select: { id: true, projectId: true },
      });
      if (!store) throw invalid("The store is not one of the projects you may report on");
      resolved.storeId = store.id;
      projects = projects.filter((project) => project.id === store.projectId);
    }
    if (definition.batch) {
      if (!params.batchId) throw reportProblem(422, "batch-required", "Choose a payroll batch");
      const batch = await tx.payrollBatch.findFirst({
        where: { tenantId: access.tenantId, projectId: resolved.projectId!, id: params.batchId },
        select: { id: true },
      });
      if (!batch) throw invalid("The payroll batch is not one of this project's batches");
      resolved.batchId = params.batchId;
    }
    if (definition.actor) {
      if (params.actorId) resolved.actorId = params.actorId;
      if (params.action) resolved.action = params.action;
    }
    if (definition.period === "range") {
      const result = reportPeriod(definition, params, today);
      if (!result.ok)
        throw reportProblem(
          422,
          result.problem,
          result.problem === "period-too-long"
            ? `The period may be at most ${definition.maxPeriodDays} days`
            : "Give a period from a date to a date, ending today at the latest",
        );
      resolved.period = result.period;
    }
    if (definition.period === "as-at") {
      const asAt = params.asAt ?? today;
      if (asAt > today || asAt < addCalendarDays(today, -366))
        throw reportProblem(422, "period-invalid", "The date must be within the last year");
      resolved.asAt = asAt;
    }
    return { resolved, projects };
  }

  /** Builds a report for the caller: the full model (exports) or the first rows (preview). */
  async model(
    principal: Principal,
    id: ReportId,
    query: ReportQuery,
    mode: ReportMode,
    req: Request,
  ): Promise<ReportModel> {
    if (mode === "preview")
      await this.security.limit(
        `report-preview:${principal.user.id}`,
        REPORT_LIMITS.previewsPerMinute,
        60,
      );
    else
      await this.security.limit(
        `report-export:${principal.user.id}`,
        REPORT_LIMITS.exportsPerTenMinutes,
        600,
      );
    const { locale, ...params } = query;
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.access.caller(scope);
        const today = nairobiDate();
        const { resolved, projects } = await this.resolve(scope, caller, id, params, today);
        const m = messages(locale);
        const t = m.reportExport;
        const result = await REPORT_BUILDERS[id]!({
          id,
          scope,
          caller,
          definition: REPORT_DEFINITIONS[id],
          rule: REPORT_RULES[id],
          params: resolved,
          projects,
          locale,
          m,
          t,
          today,
          maxRows: REPORT_LIMITS.maxRows,
          principal,
          req,
          spending: this.spending,
        });
        const company = await scope.tx.tenant.findUniqueOrThrow({
          where: { id: scope.access.tenantId },
          select: { name: true },
        });
        const model = reportModelSchema.parse({
          report: { id, title: t.catalogue[id].title, description: t.catalogue[id].description },
          locale,
          company,
          parameters: await this.parameters(scope, id, resolved, projects, locale),
          query: {
            ...Object.fromEntries(
              ID_PARAMS.flatMap((key) => (resolved[key] ? [[key, resolved[key]]] : [])),
            ),
            ...(resolved.action ? { action: resolved.action } : {}),
            ...(resolved.period ? { from: resolved.period.from, to: resolved.period.to } : {}),
            ...(resolved.asAt ? { asAt: resolved.asAt } : {}),
          },
          generatedAt: new Date().toISOString(),
          generatedBy: { displayName: principal.user.displayName },
          sections: result.sections.map((section) => ({
            ...section,
            rows:
              mode === "preview" ? section.rows.slice(0, REPORT_LIMITS.previewRows) : section.rows,
            rowCount: section.rows.length,
            emptyText: t.empty,
          })),
          notes: result.notes,
          truncated:
            mode === "preview" &&
            result.sections.some((section) => section.rows.length > REPORT_LIMITS.previewRows),
        });
        const rows = totalRows(model);
        if (rows > REPORT_LIMITS.maxRows) throw tooLarge(REPORT_LIMITS.maxRows);
        if (mode === "pdf") assertPdfFits(model);
        await this.scope.audit(
          scope.tx,
          mode === "preview" ? "report.viewed" : "report.exported",
          id,
          {
            report: id,
            format: mode === "preview" ? "screen" : mode,
            ...Object.fromEntries(
              ID_PARAMS.flatMap((key) => (resolved[key] ? [[key, resolved[key]]] : [])),
            ),
            rows,
          },
        );
        return model;
      },
      false,
      mode === "preview" ? undefined : 30_000,
    );
  }

  /** The header lines: project, site, store, batch, period, as-at, person and action. */
  private async parameters(
    scope: Scope,
    id: ReportId,
    resolved: ResolvedParams,
    projects: ReportProject[],
    locale: Locale,
  ) {
    const { tx, access } = scope;
    const definition = REPORT_DEFINITIONS[id];
    const t = messages(locale).reportExport.params;
    const lines: { key: string; label: string; value: string }[] = [];
    if (definition.project !== "none") {
      const project = resolved.projectId
        ? projects.find((entry) => entry.id === resolved.projectId)
        : null;
      lines.push({
        key: "project",
        label: t.project,
        value: project
          ? `${project.code} – ${project.name}`
          : fill(t.allProjects, { count: projects.length }),
      });
    }
    if (resolved.siteId) {
      const site = await tx.site.findFirstOrThrow({
        where: { tenantId: access.tenantId, id: resolved.siteId },
        select: { name: true },
      });
      lines.push({ key: "site", label: t.site, value: site.name });
    }
    if (definition.store) {
      const store = resolved.storeId
        ? await tx.store.findFirstOrThrow({
            where: { tenantId: access.tenantId, id: resolved.storeId },
            select: { name: true },
          })
        : null;
      lines.push({ key: "store", label: t.store, value: store?.name ?? t.allStores });
    }
    if (resolved.batchId) {
      const batch = await tx.payrollBatch.findFirstOrThrow({
        where: { tenantId: access.tenantId, id: resolved.batchId },
        select: { periodStart: true, periodEnd: true, payDate: true, status: true },
      });
      const iso = (value: Date) => day(value.toISOString().slice(0, 10));
      lines.push({
        key: "batch",
        label: t.batch,
        value: fill(t.batchValue, {
          from: iso(batch.periodStart),
          to: iso(batch.periodEnd),
          payDate: iso(batch.payDate),
          status:
            messages(locale).reportExport.payroll.statuses[batch.status as PayrollBatchStatus],
        }),
      });
    }
    if (resolved.period)
      lines.push({
        key: "period",
        label: t.period,
        value: fill(t.periodValue, {
          from: day(resolved.period.from),
          to: day(resolved.period.to),
        }),
      });
    if (resolved.asAt) lines.push({ key: "asAt", label: t.asAt, value: day(resolved.asAt) });
    if (definition.actor) {
      const actor = resolved.actorId
        ? await tx.user.findUnique({
            where: { id: resolved.actorId },
            select: { displayName: true },
          })
        : null;
      lines.push({
        key: "actor",
        label: t.actor,
        value: actor?.displayName ?? (resolved.actorId ? resolved.actorId : t.anyone),
      });
      lines.push({ key: "action", label: t.action, value: resolved.action ?? t.anyAction });
    }
    return lines;
  }

  async pdf(principal: Principal, id: ReportId, query: ReportQuery, req: Request) {
    const model = await this.model(principal, id, query, "pdf", req);
    const content = await renderPdf(model);
    return {
      content,
      contentType: "application/pdf",
      disposition: contentDisposition(reportFileName(model, "pdf")),
    };
  }

  async xlsx(principal: Principal, id: ReportId, query: ReportQuery, req: Request) {
    const model = await this.model(principal, id, query, "xlsx", req);
    const content = renderXlsx(model);
    return {
      content,
      contentType: XLSX_CONTENT_TYPE,
      disposition: contentDisposition(reportFileName(model, "xlsx")),
    };
  }
}

const forbidden = () =>
  reportProblem(
    403,
    "report-forbidden",
    "You may not run this report (it needs reports.view and the permission of its source screen)",
  );
const invalid = (message: string) => reportProblem(422, "report-parameter-invalid", message);
