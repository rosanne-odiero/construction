import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import {
  isImportResumable,
  isProjectReadOnly,
  type BqKindTotals,
  type BqResolutions,
} from "@pm-buddy/domain";
import {
  BQ_IMPORT_STATUSES,
  type BqIssueCode,
  type BqItemKind,
  type ProjectStatus,
} from "@pm-buddy/types";
import {
  bqBillResponseSchema,
  bqResponseSchema,
  bqSearchResponseSchema,
  type BqReport,
  type BqSheetSummary,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { BqAccess } from "./bq-access.js";
import { safeMinor, toItem, toVersion } from "./bq-mappers.js";

type Tx = Prisma.TransactionClient;

const KIND_BUCKET: Record<BqItemKind, keyof BqKindTotals> = {
  measured: "measured",
  preliminary: "preliminaries",
  provisional_sum: "provisionalSums",
  pc_sum: "pcSums",
  pc_attendance: "pcAttendanceProfit",
  pc_profit: "pcAttendanceProfit",
  contingency: "contingencies",
  daywork: "dayworks",
};

const SEARCH_LIMIT = 200;

/** The project's current BQ version (the newest one), or null. */
export async function currentVersion(tx: Tx, tenantId: string, projectId: string) {
  const bq = await tx.bq.findUnique({ where: { tenantId_projectId: { tenantId, projectId } } });
  if (!bq) return null;
  const version = await tx.bqVersion.findFirst({
    where: { tenantId, bqId: bq.id },
    orderBy: { versionNo: "desc" },
  });
  return version ? { bq, version } : null;
}

/** The BQ viewer: tree (bills and sections; items per bill), summary, search (bq.view). */
@Injectable()
export class BqViewerService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: BqAccess,
  ) {}

  bq(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { project, effective } = await this.access.load(scope, projectId, "bq.view");
      const { tx, access } = scope;
      const canImport =
        effective.has("bq.import") && !isProjectReadOnly(project.status as ProjectStatus);
      const openImports = canImport
        ? await tx.bqImport.count({
            where: {
              tenantId: access.tenantId,
              projectId,
              status: { in: BQ_IMPORT_STATUSES.filter(isImportResumable) },
            },
          })
        : 0;
      const permissions = { canImport, canExport: true };
      const current = await currentVersion(tx, access.tenantId, projectId);
      if (!current) return bqResponseSchema.parse({ bq: null, permissions, openImports });
      const { bq, version } = current;
      const [bills, sections, sectionCounts, billCounts, kinds, source] = await Promise.all([
        tx.bqBill.findMany({
          where: { tenantId: access.tenantId, versionId: version.id },
          orderBy: { sortOrder: "asc" },
        }),
        tx.bqSection.findMany({
          where: { tenantId: access.tenantId, versionId: version.id },
          orderBy: [{ sortOrder: "asc" }],
        }),
        tx.bqItem.groupBy({
          by: ["sectionId"],
          where: { tenantId: access.tenantId, versionId: version.id },
          _count: { _all: true },
        }),
        tx.bqItem.groupBy({
          by: ["billId"],
          where: { tenantId: access.tenantId, versionId: version.id },
          _count: { _all: true },
        }),
        tx.bqItem.groupBy({
          by: ["kind"],
          where: { tenantId: access.tenantId, versionId: version.id },
          _sum: { amountMinor: true },
        }),
        tx.bqImport.findFirst({
          where: { tenantId: access.tenantId, bqVersionId: version.id, status: "committed" },
        }),
      ]);
      const perSection = new Map(
        sectionCounts.map((entry) => [entry.sectionId, entry._count._all]),
      );
      const perBill = new Map(billCounts.map((entry) => [entry.billId, entry._count._all]));
      const byKind: BqKindTotals = {
        measured: 0,
        preliminaries: 0,
        provisionalSums: 0,
        pcSums: 0,
        pcAttendanceProfit: 0,
        contingencies: 0,
        dayworks: 0,
      };
      for (const entry of kinds)
        byKind[KIND_BUCKET[entry.kind as BqItemKind]] += safeMinor(entry._sum.amountMinor ?? 0n);

      let sourceInfo = null;
      if (source?.committedAt && source.committedBy) {
        const committer = await tx.user.findUnique({
          where: { id: source.committedBy },
          select: { displayName: true },
        });
        const report = source.report as BqReport | null;
        const resolutions = source.resolutions as unknown as BqResolutions;
        const sheets = (source.sheets as BqSheetSummary[] | null) ?? [];
        sourceInfo = {
          importId: source.id,
          fileName: source.fileName,
          fileType: source.fileType,
          committedAt: source.committedAt.toISOString(),
          committedBy: { id: source.committedBy, displayName: committer?.displayName ?? "—" },
          counts: report?.counts ?? {},
          accepted: resolutions.accepted,
          overrides: resolutions.rows.map((entry) => {
            const findings = (report?.issues ?? []).filter(
              (issue) => issue.sheetIndex === entry.sheetIndex && issue.row === entry.row,
            );
            return {
              sheet: sheets[entry.sheetIndex]?.name ?? `Sheet ${entry.sheetIndex + 1}`,
              row: entry.row,
              ref: findings.find((issue) => issue.ref)?.ref ?? null,
              action: entry.action,
              reason: entry.reason ?? null,
              codes: [...new Set(findings.map((issue) => issue.code as BqIssueCode))],
            };
          }),
        };
      }

      return bqResponseSchema.parse({
        bq: {
          id: bq.id,
          name: bq.name,
          version: toVersion(version),
          bills: bills.map((bill) => ({
            id: bill.id,
            number: bill.number,
            title: bill.title,
            kind: bill.kind,
            totalMinor: safeMinor(bill.totalMinor),
            sheetTotalMinor: bill.sheetTotalMinor === null ? null : safeMinor(bill.sheetTotalMinor),
            itemCount: perBill.get(bill.id) ?? 0,
            sections: sections
              .filter((section) => section.billId === bill.id)
              .map((section) => ({
                id: section.id,
                code: section.code,
                title: section.title,
                notes: section.notes,
                totalMinor: safeMinor(section.totalMinor),
                itemCount: perSection.get(section.id) ?? 0,
              })),
          })),
          byKind,
          contractSumMinor:
            project.contractSumMinor === null ? null : safeMinor(project.contractSumMinor),
          source: sourceInfo,
        },
        permissions,
        openImports,
      });
    });
  }

  private async billOf(scope: Scope, projectId: string, billId: string) {
    const current = await currentVersion(scope.tx, scope.access.tenantId, projectId);
    if (!current) throw new NotFoundException("Bill not found");
    const bill = await scope.tx.bqBill.findUnique({
      where: {
        tenantId_versionId_id: {
          tenantId: scope.access.tenantId,
          versionId: current.version.id,
          id: billId,
        },
      },
    });
    if (!bill) throw new NotFoundException("Bill not found");
    return { bill, version: current.version };
  }

  /** One bill's sections and items (the tree loads bills on demand, so large BQs stay usable). */
  bill(principal: Principal, projectId: string, billId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "bq.view");
      const { bill, version } = await this.billOf(scope, projectId, billId);
      const where = { tenantId: scope.access.tenantId, versionId: version.id, billId };
      const [sections, items] = await Promise.all([
        scope.tx.bqSection.findMany({ where, orderBy: { sortOrder: "asc" } }),
        scope.tx.bqItem.findMany({ where, orderBy: { sortOrder: "asc" } }),
      ]);
      const counts = new Map<string | null, number>();
      for (const item of items) counts.set(item.sectionId, (counts.get(item.sectionId) ?? 0) + 1);
      return bqBillResponseSchema.parse({
        bill: {
          id: bill.id,
          number: bill.number,
          title: bill.title,
          kind: bill.kind,
          totalMinor: safeMinor(bill.totalMinor),
          sheetTotalMinor: bill.sheetTotalMinor === null ? null : safeMinor(bill.sheetTotalMinor),
          itemCount: items.length,
          sections: sections.map((section) => ({
            id: section.id,
            code: section.code,
            title: section.title,
            notes: section.notes,
            totalMinor: safeMinor(section.totalMinor),
            itemCount: counts.get(section.id) ?? 0,
          })),
        },
        items: items.map(toItem),
      });
    });
  }

  /** Items whose description or reference contains the search text (current version). */
  search(principal: Principal, projectId: string, query: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "bq.view");
      const current = await currentVersion(scope.tx, scope.access.tenantId, projectId);
      if (!current) return bqSearchResponseSchema.parse({ items: [], truncated: false });
      const contains = { contains: query, mode: "insensitive" as const };
      const rows = await scope.tx.bqItem.findMany({
        where: {
          tenantId: scope.access.tenantId,
          versionId: current.version.id,
          OR: [{ description: contains }, { ref: contains }],
        },
        include: {
          bill: { select: { number: true, sortOrder: true } },
          section: { select: { title: true } },
        },
        orderBy: [{ bill: { sortOrder: "asc" } }, { sortOrder: "asc" }],
        take: SEARCH_LIMIT + 1,
      });
      return bqSearchResponseSchema.parse({
        items: rows.slice(0, SEARCH_LIMIT).map((row) => ({
          ...toItem(row),
          billId: row.billId,
          billNumber: row.bill.number,
          sectionTitle: row.section?.title ?? null,
        })),
        truncated: rows.length > SEARCH_LIMIT,
      });
    });
  }
}
