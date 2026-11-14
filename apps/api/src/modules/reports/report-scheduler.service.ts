import {
  HttpException,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { nairobiDate, nextReportRun, scheduledPeriod } from "@pm-buddy/domain";
import { messages } from "@pm-buddy/i18n";
import {
  isReportId,
  REPORT_DEFINITIONS,
  REPORT_LIMITS,
  type ReportFrequency,
  type ReportId,
  type ReportRunOutcome,
  type ReportRunReason,
} from "@pm-buddy/types";
import type { RunDueResponse } from "@pm-buddy/validation";
import { AppConfig } from "../../config/app-config.js";
import { PrismaService } from "../../infra/prisma.service.js";
import { AccessPolicy } from "../identity/access-policy.js";
import { AuthSecurity } from "../identity/auth-security.service.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantDatabase } from "../identity/tenant-database.service.js";
import { day } from "./report-renderer.js";
import { fill, fromDay } from "./report-model.js";
import { ReportsAccess } from "./reports-access.js";
import { scheduleOf } from "./report-subscriptions.service.js";
import { ReportsService } from "./reports.service.js";

/** pg advisory lock key for the report scheduler (any fixed 64-bit number; "pmb-rpts"). */
const LOCK_KEY = 0x706d622d72707473n;

type DueRow = { tenant_id: string; id: string; next_run_at: Date };
type ClaimedRow = {
  id: string;
  user_id: string;
  report_id: string;
  parameters: Record<string, string>;
  frequency: string;
  weekday: number | null;
  day_of_month: number | null;
  locale: string;
  next_run_at: Date;
};

/**
 * Scheduled report emails (D-126, D-127; WORKFLOWS "Report subscriptions"). Every minute (when
 * REPORT_SCHEDULER is on) one instance — the one holding a Postgres advisory lock — asks
 * app.due_report_subscriptions() for due subscriptions and handles each in its own transaction in
 * the subscriber's company context: it claims the row with FOR UPDATE SKIP LOCKED (and re-checks
 * it is still due), checks the subscriber can still run the report with its parameters (else the
 * run is skipped and why is recorded), emails a link — never report data — and records the run
 * (append-only, once per subscription and due time) and the next due time. Missed slots are not
 * replayed: the next run is the next slot after now.
 */
@Injectable()
export class ReportSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReportSchedulerService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: TenantDatabase,
    private readonly policy: AccessPolicy,
    private readonly access: ReportsAccess,
    private readonly reports: ReportsService,
    private readonly security: AuthSecurity,
    private readonly config: AppConfig,
  ) {}

  get enabled(): boolean {
    const setting = this.config.get("REPORT_SCHEDULER");
    return setting ? setting === "on" : this.config.get("NODE_ENV") !== "test";
  }

  onModuleInit() {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.tick(), REPORT_LIMITS.schedulerIntervalSeconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.runDue();
      if (result?.claimed)
        this.logger.log(
          `Report subscriptions: ${result.sent} sent, ${result.skipped} skipped, ${result.failed} failed`,
        );
    } catch (error) {
      this.logger.warn(`Report scheduler cycle failed: ${(error as Error).name}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One cycle. Returns null when another instance holds the lock. With `tenantId` (an
   * administrator's "run due now"), only that company's due subscriptions are handled.
   */
  async runDue(options: { tenantId?: string } = {}): Promise<RunDueResponse | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${LOCK_KEY}::bigint) AS locked`;
        if (!lock?.locked) return null;
        if (options.tenantId)
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${options.tenantId}, true)`;
        const due = await tx.$queryRaw<DueRow[]>`
          SELECT tenant_id, id, next_run_at
            FROM app.due_report_subscriptions(${REPORT_LIMITS.schedulerBatch}::integer)`;
        const result: RunDueResponse = { claimed: 0, sent: 0, skipped: 0, failed: 0 };
        for (const row of due) {
          const outcome = await this.runOne(row.tenant_id, row.id);
          if (!outcome) continue;
          result.claimed += 1;
          result[outcome] += 1;
        }
        return result;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  }

  /**
   * Handles one due subscription in its company's context; null when another worker has it or it
   * is no longer due (paused, deleted or already run).
   */
  async runOne(tenantId: string, subscriptionId: string): Promise<ReportRunOutcome | null> {
    return this.db.run(
      { userId: "", tenantId, requestId: "report-scheduler" },
      async (tx) => {
        const [row] = await tx.$queryRaw<ClaimedRow[]>`
          SELECT id, user_id, report_id, parameters, frequency, weekday, day_of_month, locale,
                 next_run_at
            FROM report_subscriptions
           WHERE tenant_id = ${tenantId}::uuid AND id = ${subscriptionId}::uuid
             AND status = 'active' AND next_run_at <= now()
             FOR UPDATE SKIP LOCKED`;
        if (!row) return null;
        // From here the run acts as the subscriber (the guards allow only the owner).
        await tx.$executeRaw`SELECT set_config('app.user_id', ${row.user_id}, true)`;
        const dueAt = row.next_run_at;
        const runDate = nairobiDate(dueAt);
        const reportId = isReportId(row.report_id) ? row.report_id : null;
        const definition = reportId ? REPORT_DEFINITIONS[reportId] : null;
        const period =
          definition?.period === "range"
            ? scheduledPeriod(row.frequency as ReportFrequency, runDate)
            : null;
        const asAt = definition?.period === "as-at" ? runDate : undefined;

        let outcome: ReportRunOutcome = "sent";
        let reason: ReportRunReason | null = null;
        const access = await this.policy.load(tx, tenantId, row.user_id);
        if (!access) {
          outcome = "skipped";
          reason = "membership-ended";
        } else if (!reportId || !definition?.available) {
          outcome = "skipped";
          reason = "report-unavailable";
        } else {
          const scope = { tx, access, principal: undefined as unknown as Principal };
          try {
            const caller = await this.access.caller(scope);
            await this.reports.resolve(
              scope,
              caller,
              reportId,
              { ...row.parameters, ...period, ...(asAt ? { asAt } : {}) },
              runDate,
              { scheduled: true },
            );
          } catch (error) {
            if (!(error instanceof HttpException) || error.getStatus() >= 500) throw error;
            outcome = "skipped";
            reason =
              (error.getResponse() as { code?: string }).code === "report-not-available"
                ? "report-unavailable"
                : "permission-lost";
          }
          if (outcome === "sent") {
            const user = await tx.user.findUnique({
              where: { id: row.user_id },
              select: { identifier: true },
            });
            if (!user?.identifier.includes("@")) {
              outcome = "skipped";
              reason = "no-email-address";
            } else {
              const company = await tx.tenant.findUniqueOrThrow({
                where: { id: tenantId },
                select: { name: true },
              });
              const email = this.email(
                row,
                reportId,
                company.name,
                period ? { ...period } : null,
                asAt ?? null,
              );
              try {
                await this.security.notify(user.identifier, email.subject, email.text, "email");
              } catch {
                outcome = "failed";
                reason = "delivery-failed";
              }
            }
          }
        }
        await tx.reportSubscriptionRun.create({
          data: {
            tenantId,
            subscriptionId: row.id,
            dueAt,
            outcome,
            reason,
            periodFrom: period ? fromDay(period.from) : null,
            periodTo: period ? fromDay(period.to) : null,
          },
        });
        await tx.reportSubscription.update({
          where: { tenantId_id: { tenantId, id: row.id } },
          data: {
            nextRunAt: nextReportRun(
              scheduleOf({
                frequency: row.frequency,
                weekday: row.weekday,
                dayOfMonth: row.day_of_month,
              }),
              new Date(),
              REPORT_LIMITS.sendHourNairobi,
            ),
            lastRunAt: new Date(),
          },
        });
        await tx.auditEvent.create({
          data: {
            tenantId,
            actorId: row.user_id,
            requestId: "report-scheduler",
            action: "report.subscription_run",
            resourceId: row.id,
            metadata: { report: row.report_id, outcome, reason },
          },
        });
        return outcome;
      },
      30_000,
    );
  }

  /** The email: the report's name, period and a sign-in link with the IDs — no report data. */
  private email(
    row: ClaimedRow,
    reportId: ReportId,
    company: string,
    period: { from: string; to: string } | null,
    asAt: string | null,
  ) {
    const t = messages(row.locale).reportExport;
    const title = t.catalogue[reportId].title;
    const query = new URLSearchParams({
      ...row.parameters,
      ...period,
      ...(asAt ? { asAt } : {}),
    });
    const link = `${this.config.get("WEB_ORIGIN")}/reports/${reportId}?${query.toString()}`;
    const when = period
      ? fill(t.email.period, { from: day(period.from), to: day(period.to) })
      : asAt
        ? fill(t.email.asAt, { date: day(asAt) })
        : t.email.current;
    return {
      subject: fill(t.email.subject, { report: title }),
      text: [
        fill(t.email.intro, { report: title }),
        fill(t.email.company, { company }),
        when,
        "",
        fill(t.email.link, { link }),
        "",
        t.email.noData,
        t.email.stop,
      ].join("\n"),
    };
  }
}
