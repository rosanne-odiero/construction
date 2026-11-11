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
  type BqItemRateLink,
  type BqReport,
  type BqSheetSummary,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { BqAccess } from "./bq-access.js";
import { peopleOf, personOf, safeMinor, toItem } from "./bq-mappers.js";
import { BqVersionsService, versionWires } from "./bq-versions.service.js";

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

/**
 * The project's current BQ version, or null: the newest version, which is the newest approved one
 * (every version after the baseline is approved when created) or the draft baseline.
 */
export async function currentVersion(tx: Tx, tenantId: string, projectId: string) {
  const bq = await tx.bq.findUnique({ where: { tenantId_projectId: { tenantId, projectId } } });
  if (!bq) return null;
  const version = await tx.bqVersion.findFirst({
    where: { tenantId, bqId: bq.id },
    orderBy: { versionNo: "desc" },
  });
  return version ? { bq, version } : null;
}

/** Active build-up links of these item lineages, as wire objects keyed by lineage. */
export async function linksOf(
  tx: Tx,
  tenantId: string,
  bqId: string,
  lineages: readonly string[],
): Promise<Map<string, BqItemRateLink>> {
  if (!lineages.length) return new Map();
  const rows = await tx.bqItemRateLink.findMany({
    where: { tenantId, bqId, unlinkedAt: null, itemLineageId: { in: [...lineages] } },
    include: { buildupVersion: { include: { buildup: { select: { code: true } } } } },
  });
  const people = await peopleOf(
    tx,
    rows.map((row) => row.linkedBy),
  );
  return new Map(
    rows.map((row) => [
      row.itemLineageId,
      {
        buildupId: row.buildupId,
        buildupVersionId: row.buildupVersionId,
        code: row.buildupVersion.buildup.code,
        name: row.buildupVersion.name,
        versionNo: row.buildupVersion.versionNo,
        unit: row.buildupVersion.unit as BqItemRateLink["unit"],
        rateMinor:
          row.buildupVersion.rateMinor === null ? null : safeMinor(row.buildupVersion.rateMinor),
        linkedAt: row.linkedAt.toISOString(),
        linkedBy: personOf(people, row.linkedBy),
      },
    ]),
  );
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
      const readOnly = isProjectReadOnly(project.status as ProjectStatus);
      const canImport = effective.has("bq.import") && !readOnly;
      const openImports = canImport
        ? await tx.bqImport.count({
            where: {
              tenantId: access.tenantId,
              projectId,
              status: { in: BQ_IMPORT_STATUSES.filter(isImportResumable) },
            },
          })
        : 0;
      const permissions = {
        canImport,
        canExport: true,
        canEdit: effective.has("bq.edit") && !readOnly,
        canApprove: effective.has("bq.approve_variation") && !readOnly,
      };
      const current = await currentVersion(tx, access.tenantId, projectId);
      const baselineApproval = await BqVersionsService.baselineApproval(
        scope,
        project,
        effective,
        current?.version ?? null,
      );
      if (!current)
        return bqResponseSchema.parse({ bq: null, permissions, baselineApproval, openImports });
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
          version: (await versionWires(tx, access.tenantId, [version]))[0],
          bills: bills.map((bill) => ({
            id: bill.id,
            lineageId: bill.lineageId,
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
                lineageId: section.lineageId,
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
        baselineApproval,
        openImports,
      });
    });
  }

  /**
   * A bill of the current version, or of `versionId` (any version of this project's BQ, e.g. a
   * variation's base); 404 for anything else, including other companies' IDs.
   */
  private async billOf(scope: Scope, projectId: string, billId: string, versionId?: string) {
    const current = await currentVersion(scope.tx, scope.access.tenantId, projectId);
    if (!current) throw new NotFoundException("Bill not found");
    let version = current.version;
    if (versionId && versionId !== version.id) {
      const other = await scope.tx.bqVersion.findUnique({
        where: { tenantId_id: { tenantId: scope.access.tenantId, id: versionId } },
      });
      if (!other || other.bqId !== current.bq.id) throw new NotFoundException("Bill not found");
      version = other;
    }
    const bill = await scope.tx.bqBill.findUnique({
      where: {
        tenantId_versionId_id: {
          tenantId: scope.access.tenantId,
          versionId: version.id,
          id: billId,
        },
      },
    });
    if (!bill) throw new NotFoundException("Bill not found");
    return { bill, version, bq: current.bq };
  }

  /** One bill's sections and items (the tree loads bills on demand, so large BQs stay usable). */
  bill(principal: Principal, projectId: string, billId: string, req: Request, versionId?: string) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "bq.view");
      const { bill, version, bq } = await this.billOf(scope, projectId, billId, versionId);
      const where = { tenantId: scope.access.tenantId, versionId: version.id, billId };
      const [sections, items] = await Promise.all([
        scope.tx.bqSection.findMany({ where, orderBy: { sortOrder: "asc" } }),
        scope.tx.bqItem.findMany({ where, orderBy: { sortOrder: "asc" } }),
      ]);
      const links = await linksOf(
        scope.tx,
        scope.access.tenantId,
        bq.id,
        items.map((item) => item.lineageId),
      );
      const counts = new Map<string | null, number>();
      for (const item of items) counts.set(item.sectionId, (counts.get(item.sectionId) ?? 0) + 1);
      return bqBillResponseSchema.parse({
        bill: {
          id: bill.id,
          lineageId: bill.lineageId,
          number: bill.number,
          title: bill.title,
          kind: bill.kind,
          totalMinor: safeMinor(bill.totalMinor),
          sheetTotalMinor: bill.sheetTotalMinor === null ? null : safeMinor(bill.sheetTotalMinor),
          itemCount: items.length,
          sections: sections.map((section) => ({
            id: section.id,
            lineageId: section.lineageId,
            code: section.code,
            title: section.title,
            notes: section.notes,
            totalMinor: safeMinor(section.totalMinor),
            itemCount: counts.get(section.id) ?? 0,
          })),
        },
        items: items.map((item) => toItem(item, links.get(item.lineageId) ?? null)),
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
      const links = await linksOf(
        scope.tx,
        scope.access.tenantId,
        current.bq.id,
        rows.map((row) => row.lineageId),
      );
      return bqSearchResponseSchema.parse({
        items: rows.slice(0, SEARCH_LIMIT).map((row) => ({
          ...toItem(row, links.get(row.lineageId) ?? null),
          billId: row.billId,
          billNumber: row.bill.number,
          sectionTitle: row.section?.title ?? null,
        })),
        truncated: rows.length > SEARCH_LIMIT,
      });
    });
  }
}
