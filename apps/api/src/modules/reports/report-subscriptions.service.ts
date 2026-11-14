import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { nairobiDate, nextReportRun, type ReportSchedule } from "@pm-buddy/domain";
import { messages } from "@pm-buddy/i18n";
import {
  isReportId,
  REPORT_DEFINITIONS,
  REPORT_LIMITS,
  REPORT_SUBSCRIPTION_ADMIN_PERMISSION,
  type IsoWeekday,
  type Locale,
  type ReportFrequency,
  type ReportId,
  type ReportRunOutcome,
  type ReportRunReason,
} from "@pm-buddy/types";
import {
  reportSubscriptionResponseSchema,
  reportSubscriptionsResponseSchema,
  subscriptionParamsSchema,
  type CreateSubscriptionRequest,
  type ReportSubscription,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { displayNames, type Tx } from "./report-model.js";
import { reportProblem, ReportsAccess } from "./reports-access.js";
import { ReportsService } from "./reports.service.js";

type SubscriptionRow = Prisma.ReportSubscriptionGetPayload<object>;

export const scheduleOf = (row: {
  frequency: string;
  weekday: number | null;
  dayOfMonth: number | null;
}): ReportSchedule =>
  row.frequency === "weekly"
    ? { frequency: "weekly", weekday: row.weekday as IsoWeekday }
    : { frequency: "monthly", dayOfMonth: row.dayOfMonth! };

/** Only the parameters given, so the same subscription stored twice compares equal. */
const storedParams = (parameters: Record<string, string | undefined>) =>
  Object.fromEntries(
    Object.entries(parameters)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  ) as Record<string, string>;

/**
 * Report subscriptions (D-126, D-127): a user subscribes themselves to a report they may run now,
 * with fixed parameters, weekly or monthly (sent at REPORT_LIMITS.sendHourNairobi, Nairobi time);
 * only they pause, resume or delete it; config.manage holders see the company's subscriptions and
 * runs. The scheduled email carries a link, never report data (report-scheduler.service.ts).
 */
@Injectable()
export class ReportSubscriptionsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: ReportsAccess,
    private readonly reports: ReportsService,
  ) {}

  list(principal: Principal, which: "mine" | "company", locale: Locale, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const canManage = access.permissions.has(REPORT_SUBSCRIPTION_ADMIN_PERMISSION);
      if (which === "company" && !canManage)
        throw new ForbiddenException(
          `Permission required: ${REPORT_SUBSCRIPTION_ADMIN_PERMISSION}`,
        );
      const rows = await tx.reportSubscription.findMany({
        where: {
          tenantId: access.tenantId,
          status: { not: "deleted" },
          ...(which === "mine" ? { userId: access.userId } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: REPORT_LIMITS.subscriptionsPerCompany,
      });
      const runs = rows.length
        ? await tx.reportSubscriptionRun.findMany({
            where: { tenantId: access.tenantId, subscriptionId: { in: rows.map((row) => row.id) } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 100,
          })
        : [];
      const views = await this.views(scope, rows, locale);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const titles = messages(locale).reportExport.catalogue;
      return reportSubscriptionsResponseSchema.parse({
        scope: which,
        subscriptions: rows.map((row) =>
          views.view(
            row,
            runs.find((run) => run.subscriptionId === row.id),
          ),
        ),
        runs: runs.map((run) => {
          const subscription = byId.get(run.subscriptionId)!;
          return {
            id: run.id,
            subscriptionId: run.subscriptionId,
            report: {
              id: subscription.reportId,
              title: titles[subscription.reportId as ReportId].title,
            },
            subscriber: {
              id: subscription.userId,
              displayName: views.people.get(subscription.userId) ?? "—",
            },
            dueAt: run.dueAt.toISOString(),
            outcome: run.outcome,
            reason: run.reason,
            periodFrom: run.periodFrom?.toISOString().slice(0, 10) ?? null,
            periodTo: run.periodTo?.toISOString().slice(0, 10) ?? null,
            createdAt: run.createdAt.toISOString(),
          };
        }),
        canManage,
        sendHour: REPORT_LIMITS.sendHourNairobi,
      });
    });
  }

  create(principal: Principal, body: CreateSubscriptionRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const definition = REPORT_DEFINITIONS[body.reportId];
        if (!definition.available)
          throw reportProblem(409, "report-not-available", "This report is not available yet");
        if (!principal.user.identifier.includes("@"))
          throw reportProblem(
            422,
            "email-required",
            "Scheduled reports are sent by email; your account has no email address",
          );
        const [mine, company] = await Promise.all([
          tx.reportSubscription.count({
            where: { tenantId: access.tenantId, userId: access.userId, status: { not: "deleted" } },
          }),
          tx.reportSubscription.count({
            where: { tenantId: access.tenantId, status: { not: "deleted" } },
          }),
        ]);
        if (
          mine >= REPORT_LIMITS.subscriptionsPerUser ||
          company >= REPORT_LIMITS.subscriptionsPerCompany
        )
          throw reportProblem(
            409,
            "subscription-limit",
            `At most ${REPORT_LIMITS.subscriptionsPerUser} subscriptions per person and ${REPORT_LIMITS.subscriptionsPerCompany} per company`,
          );
        // The subscriber must be able to run the report with these parameters now.
        const caller = await this.access.caller(scope);
        const parameters = storedParams(subscriptionParamsSchema.parse(body.parameters));
        await this.reports.resolve(scope, caller, body.reportId, parameters, nairobiDate());
        const schedule: ReportSchedule =
          body.frequency === "weekly"
            ? { frequency: "weekly", weekday: body.weekday as IsoWeekday }
            : { frequency: "monthly", dayOfMonth: body.dayOfMonth! };
        const row = await tx.reportSubscription.create({
          data: {
            tenantId: access.tenantId,
            userId: access.userId,
            reportId: body.reportId,
            parameters,
            frequency: body.frequency,
            weekday: body.frequency === "weekly" ? body.weekday! : null,
            dayOfMonth: body.frequency === "monthly" ? body.dayOfMonth! : null,
            locale: body.locale,
            nextRunAt: nextReportRun(schedule, new Date(), REPORT_LIMITS.sendHourNairobi),
          },
        });
        await this.scope.audit(tx, "report.subscription_created", row.id, {
          report: row.reportId,
          frequency: row.frequency,
          ...parameters,
        });
        return this.one(scope, row);
      },
      true,
    );
  }

  /** Pause or resume (the owner only); a resumed subscription runs at its next slot from now. */
  update(
    principal: Principal,
    id: string,
    body: { version: number; status: "active" | "paused" },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const row = await this.own(scope, id);
        if (row.status === body.status)
          throw reportProblem(
            409,
            "invalid-transition",
            `The subscription is already ${row.status}`,
          );
        const updated = await this.change(scope.tx, row, body.version, {
          status: body.status,
          ...(body.status === "active"
            ? {
                nextRunAt: nextReportRun(
                  scheduleOf(row),
                  new Date(),
                  REPORT_LIMITS.sendHourNairobi,
                ),
              }
            : {}),
        });
        await this.scope.audit(
          scope.tx,
          body.status === "paused" ? "report.subscription_paused" : "report.subscription_resumed",
          row.id,
          { report: row.reportId },
        );
        return this.one(scope, updated);
      },
      true,
    );
  }

  /** Delete (the owner only): the subscription stops for good; it and its runs are kept. */
  remove(principal: Principal, id: string, version: number, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const row = await this.own(scope, id);
        const updated = await this.change(scope.tx, row, version, { status: "deleted" });
        await this.scope.audit(scope.tx, "report.subscription_deleted", row.id, {
          report: row.reportId,
        });
        return this.one(scope, updated);
      },
      true,
    );
  }

  /** config.manage may run the company's due subscriptions now (audited); returns the company. */
  authoriseRunDue(principal: Principal, req: Request): Promise<string> {
    return this.scope.run(principal, req, async (scope) => {
      if (!scope.access.permissions.has(REPORT_SUBSCRIPTION_ADMIN_PERMISSION))
        throw new ForbiddenException(
          `Permission required: ${REPORT_SUBSCRIPTION_ADMIN_PERMISSION}`,
        );
      await this.scope.audit(scope.tx, "report.run_due_requested", scope.access.tenantId);
      return scope.access.tenantId;
    });
  }

  private async own(scope: Scope, id: string): Promise<SubscriptionRow> {
    const row = await scope.tx.reportSubscription.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    // Someone else's subscription is not found: only its owner changes it.
    if (!row || row.userId !== scope.access.userId || row.status === "deleted")
      throw new NotFoundException("Subscription not found");
    return row;
  }

  private async change(
    tx: Tx,
    row: SubscriptionRow,
    version: number,
    data: Prisma.ReportSubscriptionUpdateManyMutationInput,
  ): Promise<SubscriptionRow> {
    const { count } = await tx.reportSubscription.updateMany({
      where: { tenantId: row.tenantId, id: row.id, version },
      data: { ...data, version: { increment: 1 } },
    });
    if (!count)
      throw reportProblem(
        409,
        "version-conflict",
        "This subscription was changed elsewhere. Reload and try again.",
      );
    return tx.reportSubscription.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: row.tenantId, id: row.id } },
    });
  }

  private async one(scope: Scope, row: SubscriptionRow) {
    const views = await this.views(scope, [row], "en");
    const last = await scope.tx.reportSubscriptionRun.findFirst({
      where: { tenantId: row.tenantId, subscriptionId: row.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return reportSubscriptionResponseSchema.parse({
      subscription: views.view(row, last ?? undefined),
    });
  }

  /** Names for the subscriber and the parameters (project code, site, store, batch, person). */
  private async views(scope: Scope, rows: SubscriptionRow[], locale: Locale) {
    const { tx, access } = scope;
    const params = rows.map((row) => row.parameters as Record<string, string>);
    const ids = (key: string) => params.flatMap((entry) => (entry[key] ? [entry[key]] : []));
    const [projects, sites, stores, batches, people] = await Promise.all([
      tx.project.findMany({
        where: { tenantId: access.tenantId, id: { in: ids("projectId") } },
        select: { id: true, code: true },
      }),
      tx.site.findMany({
        where: { tenantId: access.tenantId, id: { in: ids("siteId") } },
        select: { id: true, name: true },
      }),
      tx.store.findMany({
        where: { tenantId: access.tenantId, id: { in: ids("storeId") } },
        select: { id: true, name: true },
      }),
      tx.payrollBatch.findMany({
        where: { tenantId: access.tenantId, id: { in: ids("batchId") } },
        select: { id: true, periodStart: true, periodEnd: true },
      }),
      displayNames(tx, [...rows.map((row) => row.userId), ...ids("actorId")]),
    ]);
    const titles = messages(locale).reportExport;
    const text = (entry: Record<string, string>) =>
      [
        entry["projectId"]
          ? (projects.find((row) => row.id === entry["projectId"])?.code ?? "—")
          : null,
        entry["siteId"] ? sites.find((row) => row.id === entry["siteId"])?.name : null,
        entry["storeId"] ? stores.find((row) => row.id === entry["storeId"])?.name : null,
        entry["batchId"]
          ? (() => {
              const batch = batches.find((row) => row.id === entry["batchId"]);
              return batch
                ? `${batch.periodStart.toISOString().slice(0, 10)}–${batch.periodEnd.toISOString().slice(0, 10)}`
                : "—";
            })()
          : null,
        entry["actorId"] ? (people.get(entry["actorId"]) ?? "—") : null,
        entry["action"] ? `${entry["action"]}…` : null,
      ]
        .filter((part): part is string => !!part)
        .join(" · ") || titles.params.allProjects.replace(/ \(\{count\}\)$/, "");
    return {
      people,
      view: (
        row: SubscriptionRow,
        last: { outcome: string; reason: string | null; createdAt: Date } | undefined,
      ): ReportSubscription => ({
        id: row.id,
        report: {
          id: row.reportId as ReportId,
          title: isReportId(row.reportId) ? titles.catalogue[row.reportId].title : row.reportId,
        },
        parameters: row.parameters as Record<string, string>,
        parameterText: text(row.parameters as Record<string, string>),
        frequency: row.frequency as ReportFrequency,
        weekday: row.weekday,
        dayOfMonth: row.dayOfMonth,
        locale: row.locale as Locale,
        status: row.status as ReportSubscription["status"],
        nextRunAt: row.status === "active" && row.nextRunAt ? row.nextRunAt.toISOString() : null,
        lastRun: last
          ? {
              outcome: last.outcome as ReportRunOutcome,
              reason: last.reason as ReportRunReason | null,
              at: last.createdAt.toISOString(),
            }
          : null,
        subscriber: { id: row.userId, displayName: people.get(row.userId) ?? "—" },
        createdAt: row.createdAt.toISOString(),
        version: row.version,
        mine: row.userId === access.userId,
      }),
    };
  }
}
