import {
  HttpException,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { messages } from "@pm-buddy/i18n";
import { pinAllowed } from "@pm-buddy/types";
import { AppConfig } from "../../config/app-config.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infra/prisma.service.js";
import { AuthSecurity } from "../identity/auth-security.service.js";
import { effectiveProjectPermissions, grantOf } from "../identity/role-grants.js";
import { TenantDatabase } from "../identity/tenant-database.service.js";
import { LabourCrypto } from "../labour/labour-support.js";
import { NotificationProvider, type Notification } from "../notifications/notification.provider.js";

type Route = { tenant_id: string; user_id: string; id: string };
type Job = { tenant_id: string; event_id: string };
type Tx = Prisma.TransactionClient;
const context = (tenantId: string, userId = "") => ({
  tenantId,
  userId,
  requestId: "worker-notifications",
});

/** Separate outbox consumer. A committed send claim is never automatically retried. */
@Injectable()
export class WorkerNotificationDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerNotificationDispatcher.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: TenantDatabase,
    private readonly crypto: LabourCrypto,
    private readonly config: AppConfig,
    private readonly security: AuthSecurity,
    private readonly provider: NotificationProvider,
  ) {}

  onModuleInit() {
    if (this.config.get("WORKER_NOTIFICATION_DISPATCHER") !== "on") return;
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.runDue();
    } catch (error) {
      this.logger.error({
        event: "worker_notification_cycle_failed",
        error: error instanceof Error ? error.name : "Unknown",
      });
    } finally {
      this.running = false;
    }
  }

  async runDue(tenantId?: string) {
    const discoverJobs = (tx: Tx) =>
      tx.$queryRaw<Job[]>`SELECT * FROM app.due_worker_notification_jobs()`;
    const jobs = tenantId
      ? await this.db.run(context(tenantId), discoverJobs)
      : await discoverJobs(this.prisma);
    for (const job of jobs) {
      try {
        await this.expand(job);
      } catch (error) {
        this.logger.error({
          event: "worker_notification_job_failed",
          id: job.event_id,
          error: error instanceof Error ? error.name : "Unknown",
        });
      }
    }
    const discoverRoutes = (tx: Tx) =>
      tx.$queryRaw<Route[]>`SELECT * FROM app.due_worker_notifications()`;
    const routes = tenantId
      ? await this.db.run(context(tenantId), discoverRoutes)
      : await discoverRoutes(this.prisma);
    for (const route of routes) {
      try {
        await this.deliver(route.tenant_id, route.user_id, route.id);
      } catch (error) {
        this.logger.error({
          event: "worker_notification_attempt_failed",
          id: route.id,
          error: error instanceof Error ? error.name : "Unknown",
        });
      }
    }
  }

  private async expand(job: Job) {
    await this.db.run(
      context(job.tenant_id),
      async (tx) => {
        const [locked] = await tx.$queryRaw<{ event_id: string }[]>`
        SELECT event_id FROM worker_notification_jobs
        WHERE event_id = ${job.event_id}::uuid AND processed_at IS NULL
        FOR UPDATE SKIP LOCKED`;
        if (!locked) return;
        const event = await tx.outboxEvent.findUniqueOrThrow({ where: { id: job.event_id } });
        // Do not replay old alerts after an outage or after an operator enables dispatch.
        if (event.createdAt.getTime() >= Date.now() - 86_400_000) {
          const target = await this.target(tx, event);
          if (target) {
            const members = await tx.membership.findMany({
              where: { tenantId: job.tenant_id },
              include: {
                user: { select: { identifier: true, verifiedAt: true } },
                customRole: true,
                projects: { where: { projectId: target.projectId } },
              },
            });
            for (const member of members) {
              const grant = grantOf(member);
              if (
                !pinAllowed(grant.permissions) ||
                !effectiveProjectPermissions(grant, member.projects[0]?.permissions ?? null).has(
                  "portal.worker",
                ) ||
                member.joinedAt > event.createdAt ||
                !member.user.verifiedAt ||
                !/^254[17]\d{8}$/.test(member.user.identifier)
              )
                continue;
              const matches = await tx.labourer.findMany({
                where: {
                  tenantId: job.tenant_id,
                  phoneBidx: this.crypto.index(job.tenant_id, "phone", member.user.identifier),
                },
                select: { id: true },
                take: 2,
              });
              if (matches.length !== 1 || !target.workerIds.has(matches[0]!.id)) continue;
              await tx.$executeRaw`SELECT set_config('app.user_id', ${member.userId}, true)`;
              const preference = await tx.notificationPreference.findUnique({
                where: { userId: member.userId },
              });
              // Opting in later must not replay events from before consent.
              if (!preference || preference.updatedAt > event.createdAt) continue;
              for (const channel of ["sms", "whatsapp"] as const) {
                if (!preference[channel]) continue;
                await tx.workerNotification.createMany({
                  data: [
                    {
                      tenantId: job.tenant_id,
                      userId: member.userId,
                      eventId: event.id,
                      projectId: target.projectId,
                      topic: event.topic,
                      channel,
                      createdAt: event.createdAt,
                    },
                  ],
                  skipDuplicates: true,
                });
              }
            }
          }
        }
        await tx.workerNotificationJob.update({
          where: { eventId: job.event_id },
          data: { processedAt: new Date() },
        });
      },
      30_000,
    );
  }

  private async target(tx: Tx, event: { tenantId: string; topic: string; aggregateId: string }) {
    const where = { tenantId: event.tenantId, id: event.aggregateId };
    if (event.topic === "attendance.day_confirmed") {
      const day = await tx.attendanceDay.findFirst({
        where: { ...where, status: "confirmed" },
        select: { projectId: true, records: { select: { labourerId: true } } },
      });
      return day
        ? { projectId: day.projectId, workerIds: new Set(day.records.map((r) => r.labourerId)) }
        : null;
    }
    if (event.topic === "advance.disbursed") {
      const advance = await tx.salaryAdvance.findFirst({
        where: { ...where, status: "disbursed" },
      });
      return advance
        ? { projectId: advance.projectId, workerIds: new Set([advance.labourerId]) }
        : null;
    }
    const batch = await tx.payrollBatch.findFirst({
      where: {
        ...where,
        status: event.topic === "payroll.batch_submitted" ? "submitted" : "cancelled",
      },
      select: { projectId: true, lines: { select: { labourerId: true } } },
    });
    return batch
      ? { projectId: batch.projectId, workerIds: new Set(batch.lines.map((r) => r.labourerId)) }
      : null;
  }

  async deliver(tenantId: string, userId: string, id: string) {
    const claim = await this.db.run(context(tenantId, userId), async (tx) => {
      const [row] = await tx.$queryRaw<{ status: string; updated_at: Date }[]>`
        SELECT status, updated_at FROM worker_notifications WHERE id = ${id}::uuid
        FOR UPDATE SKIP LOCKED`;
      if (!row) return null;
      if (row.status === "sending") {
        if (row.updated_at.getTime() < Date.now() - 120_000)
          await tx.workerNotification.update({
            where: { id },
            data: { status: "unconfirmed", reason: "interrupted" },
          });
        return null;
      }
      if (row.status !== "pending") return null;
      const notification = await tx.workerNotification.findUniqueOrThrow({ where: { id } });
      const skip = async (reason: "expired" | "access-lost" | "opted-out") => {
        await tx.workerNotification.update({ where: { id }, data: { status: "skipped", reason } });
        return null;
      };
      if (notification.createdAt.getTime() < Date.now() - 86_400_000) return skip("expired");
      const preference = await tx.notificationPreference.findUnique({ where: { userId } });
      const channel = notification.channel === "sms" ? "sms" : "whatsapp";
      if (!preference?.[channel]) return skip("opted-out");
      const member = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        include: {
          customRole: true,
          user: { select: { identifier: true, verifiedAt: true } },
          projects: { where: notification.projectId ? { projectId: notification.projectId } : {} },
        },
      });
      if (!member || !member.user.verifiedAt || !/^254[17]\d{8}$/.test(member.user.identifier))
        return skip("access-lost");
      const grant = grantOf(member);
      if (
        !pinAllowed(grant.permissions) ||
        !(grant.tenantWide
          ? grant.permissions.has("portal.worker")
          : member.projects.some((p) =>
              effectiveProjectPermissions(grant, p.permissions).has("portal.worker"),
            ))
      )
        return skip("access-lost");
      if (notification.eventId) {
        const event = await tx.outboxEvent.findUniqueOrThrow({
          where: { id: notification.eventId },
        });
        const target = await this.target(tx, event);
        const matches = await tx.labourer.findMany({
          where: {
            tenantId,
            phoneBidx: this.crypto.index(tenantId, "phone", member.user.identifier),
          },
          select: { id: true },
          take: 2,
        });
        if (
          !target ||
          target.projectId !== notification.projectId ||
          matches.length !== 1 ||
          !target.workerIds.has(matches[0]!.id)
        )
          return skip("access-lost");
      }
      const locale = preference.locale === "sw" ? "sw" : "en";
      const templateName = this.config.get(
        locale === "sw" ? "WHATSAPP_WORKER_TEMPLATE_SW" : "WHATSAPP_WORKER_TEMPLATE_EN",
      );
      const template = messages(locale).workerNotifications;
      const send: Notification = {
        channel,
        recipient: member.user.identifier,
        subject: template.subject,
        text: template.body,
        ...(channel === "whatsapp" && templateName
          ? {
              whatsappTemplate: { approved: true, name: templateName, languageCode: locale },
            }
          : {}),
      };
      await tx.workerNotification.update({ where: { id }, data: { status: "sending" } });
      return send;
    });
    if (!claim) return false;
    let status: "accepted" | "unconfirmed" | "skipped" = "accepted";
    let reason: "provider" | "budget" | null = null;
    try {
      await this.security.limit(`worker-notification-account:${userId}`, 3, 3600);
      await this.security.limit(`worker-notification-company:${tenantId}`, 100, 3600);
      await this.provider.send(claim);
    } catch (error) {
      const budget = error instanceof HttpException && error.getStatus() === 429;
      status = budget ? "skipped" : "unconfirmed";
      reason = budget ? "budget" : "provider";
      this.logger.warn({ event: "worker_notification_not_accepted", id, reason });
    }
    await this.db.run(context(tenantId, userId), (tx) =>
      tx.workerNotification.update({
        where: { id },
        data: { status, reason },
      }),
    );
    return status === "accepted";
  }
}
