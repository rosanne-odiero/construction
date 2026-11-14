import type { INestApplicationContext } from "@nestjs/common";
import type { Request } from "express";
import { PrismaService } from "../infra/prisma.service.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { ReportSubscriptionsService } from "../modules/reports/report-subscriptions.service.js";
import { seedPrincipal } from "./demo-procure-to-pay.js";

/**
 * D8.1 demo data: report subscriptions through the real service (the subscriber must be able to run
 * the report with its parameters; the scheduled email carries a sign-in link, never report data) —
 * the owner's weekly cost ledger for Ruiru Heights (Mondays) and finance's monthly supplier invoice
 * ageing across the company (on the 1st). Idempotent: skipped when the owner already has one.
 */
export type ReportsSeedSummary = {
  created: boolean;
  subscriptions: { report: string; frequency: string; subscriber: string }[];
};

const seedRequest = { headers: {} } as Request;

export async function seedReports(
  app: INestApplicationContext,
  tenantId: string,
  users: { ownerId: string; financeId: string },
): Promise<ReportsSeedSummary> {
  const prisma = app.get(PrismaService);
  const db = app.get(TenantDatabase);
  const service = app.get(ReportSubscriptionsService);
  const read = <T>(work: (tx: Parameters<Parameters<TenantDatabase["run"]>[1]>[0]) => Promise<T>) =>
    db.run({ userId: users.ownerId, tenantId, requestId: "seed" }, work);
  const summary = async (created: boolean): Promise<ReportsSeedSummary> => {
    const rows = await read((tx) =>
      tx.reportSubscription.findMany({
        where: { tenantId, status: { not: "deleted" } },
        select: { reportId: true, frequency: true, user: { select: { displayName: true } } },
        orderBy: { createdAt: "asc" },
      }),
    );
    return {
      created,
      subscriptions: rows.map((row) => ({
        report: row.reportId,
        frequency: row.frequency,
        subscriber: row.user.displayName,
      })),
    };
  };
  const existing = await read((tx) =>
    tx.reportSubscription.count({ where: { tenantId, userId: users.ownerId } }),
  );
  if (existing) return summary(false);

  const ruiru = await read((tx) =>
    tx.project.findUniqueOrThrow({ where: { tenantId_code: { tenantId, code: "RUI-HTS" } } }),
  );
  const owner = await seedPrincipal(prisma, users.ownerId, tenantId);
  const finance = await seedPrincipal(prisma, users.financeId, tenantId);
  await service.create(
    owner,
    {
      reportId: "cost-ledger",
      parameters: { projectId: ruiru.id },
      frequency: "weekly",
      weekday: 1,
      locale: "en",
    },
    seedRequest,
  );
  await service.create(
    finance,
    {
      reportId: "invoice-ageing",
      parameters: {},
      frequency: "monthly",
      dayOfMonth: 1,
      locale: "sw",
    },
    seedRequest,
  );
  return summary(true);
}
