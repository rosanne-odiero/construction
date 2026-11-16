import { ForbiddenException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  workerNotificationHistorySchema,
  workerNotificationPreferencesSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import type { z } from "zod";
import { AuthService, type Principal } from "../identity/auth.service.js";
import { AccessPolicy } from "../identity/access-policy.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { WorkerNotificationDispatcher } from "./worker-notification-dispatcher.js";

type Preferences = z.infer<typeof workerNotificationPreferencesSchema>;

@Injectable()
export class WorkerNotificationsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
    private readonly auth: AuthService,
    private readonly dispatcher: WorkerNotificationDispatcher,
  ) {}

  preferences(principal: Principal, req: Request, input?: Preferences) {
    return this.scope.run(principal, req, async (scope) => {
      await this.policy.requireSomewhere(scope, "portal.worker");
      const { tx } = scope;
      const userId = principal.user.id;
      if (input) {
        const row = await tx.notificationPreference.upsert({
          where: { userId },
          create: { userId, ...input },
          update: input,
        });
        await this.scope.audit(tx, "worker.notification_preferences.updated", userId);
        return workerNotificationPreferencesSchema.parse({
          sms: row.sms,
          whatsapp: row.whatsapp,
          locale: row.locale,
        });
      }
      const row = await tx.notificationPreference.findUnique({ where: { userId } });
      return workerNotificationPreferencesSchema.parse(
        row
          ? { sms: row.sms, whatsapp: row.whatsapp, locale: row.locale }
          : { sms: false, whatsapp: false, locale: "en" },
      );
    });
  }

  history(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.policy.requireSomewhere(scope, "portal.worker");
      const projects = await scope.tx.project.findMany({
        where: this.policy.projectWhere(scope, "portal.worker"),
        select: { id: true },
      });
      const items = await scope.tx.workerNotification.findMany({
        where: {
          userId: principal.user.id,
          OR: [{ projectId: null }, { projectId: { in: projects.map((p) => p.id) } }],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
        select: {
          id: true,
          topic: true,
          channel: true,
          status: true,
          reason: true,
          createdAt: true,
        },
      });
      return workerNotificationHistorySchema.parse({
        items: items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
      });
    });
  }

  async send(principal: Principal, req: Request, channel: "sms" | "whatsapp") {
    await this.auth.throttle(req, "worker-notification", principal.user.id, {
      maximum: 3,
      seconds: 3600,
    });
    const preference = await this.preferences(principal, req);
    if (!preference[channel])
      throw new ForbiddenException("Enable this notification channel first");
    if (!/^254[17]\d{8}$/.test(principal.user.identifier))
      throw new ForbiddenException("Verified Kenyan phone required");
    const notification = await this.scope.run(principal, req, async (scope) => {
      await this.policy.requireSomewhere(scope, "portal.worker");
      return scope.tx.workerNotification.create({
        data: {
          tenantId: scope.access.tenantId,
          userId: principal.user.id,
          topic: "worker.reminder",
          channel,
        },
      });
    });
    if (!(await this.dispatcher.deliver(notification.tenantId, principal.user.id, notification.id)))
      throw new ServiceUnavailableException(
        "Notification acceptance is unconfirmed. Check notification history; do not resend automatically.",
      );
    return { message: "Notification accepted by the provider. Handset delivery is not confirmed." };
  }
}
