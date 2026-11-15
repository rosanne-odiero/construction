import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { budgetRow, stockValueToMinor, sumFigures, type BudgetFigures } from "@pm-buddy/domain";
import {
  BUDGET_PREPARE_PERMISSIONS,
  COST_CATEGORIES,
  SPENDING_LIMITS,
  SPENDING_READ_PERMISSIONS,
  type CostCategory,
} from "@pm-buddy/types";
import {
  billItemsResponseSchema,
  bqItemSearchResponseSchema,
  projectSpendingResponseSchema,
  spendingSummaryResponseSchema,
  type SpendingBqItem,
} from "@pm-buddy/validation";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { projectCommitments } from "../procurement/p2p/p2p-overview.service.js";
import {
  approvedBqVersion,
  bqItemSelect,
  minorOf,
  projectRef,
  SpendingAccess,
  spendingSettings,
  toBqItem,
  type Tx,
} from "./spending-common.js";

type Figures = BudgetFigures;
const empty = (): Figures => ({
  budgetMinor: null,
  committedMinor: 0,
  actualMinor: 0,
  paidMinor: 0,
});
const addBudget = (figures: Figures, amount: number) => {
  figures.budgetMinor = (figures.budgetMinor ?? 0) + amount;
};

type BillRef = { lineageId: string; number: string; title: string };

/**
 * Everything budget against actual and committed needs for one project, computed on read:
 * - budget: the newest approved budget version's lines (BQ items and cost codes);
 * - committed: approved LPOs not yet invoiced, per requisition BQ item (the D5.2 commitments);
 * - actual: accrued cost entries; paid: paid cost entries (net of VAT);
 * - materials issued: stock issues net of returns per BQ item, at the stores' weighted average.
 *   ISSUES RE-ALLOCATE COST, THEY NEVER ADD IT (decision D-53): material cost is accrued once,
 *   from the approved supplier invoice, to the project (held in stores); an issue moves its value
 *   from "not on BQ items" to the item, so the project total is unchanged.
 */
export type ProjectFacts = {
  budget: {
    id: string;
    versionNo: number;
    name: string;
    approvedAt: Date | null;
    totalMinor: number;
    bqVersionId: string | null;
  } | null;
  budgetLines: {
    lineageId: string | null;
    category: CostCategory | null;
    costCodeId: string | null;
    amountMinor: number;
  }[];
  /** Accrued and paid per (category, BQ lineage or null). */
  entries: { measure: string; category: CostCategory; lineageId: string | null; sum: number }[];
  commitments: { lineageId: string | null; versionId: string | null; open: number }[];
  /** Issued − returned value per BQ lineage (whole cents, rounded once per item). */
  issued: Map<string, { versionId: string; value: number }>;
  materialsAccruedMinor: number;
  transferredInMinor: number;
  transferredOutMinor: number;
  settledCashMinor: number;
  paidNotFromSettlementsMinor: number;
};

export async function loadProjectFacts(
  tx: Tx,
  tenantId: string,
  projectId: string,
): Promise<ProjectFacts> {
  const budget = await tx.budget.findFirst({
    where: { tenantId, projectId, status: "approved" },
    orderBy: { versionNo: "desc" },
  });
  const [lines, grouped, commitments, issueRows, transferRows, settled, materials, paidOther] =
    await Promise.all([
      budget
        ? tx.budgetLine.findMany({
            where: { tenantId, budgetId: budget.id },
            select: { bqItemLineageId: true, category: true, costCodeId: true, amountMinor: true },
          })
        : Promise.resolve([]),
      tx.costEntry.groupBy({
        by: ["measure", "category", "bqItemLineageId"],
        where: { tenantId, projectId },
        _sum: { amountMinor: true },
      }),
      projectCommitments(tx, tenantId, projectId),
      tx.$queryRaw<{ version_id: string; lineage_id: string; value: string }[]>`
        SELECT (array_agg(bq_version_id ORDER BY recorded_at DESC))[1] AS version_id,
               bq_item_lineage_id AS lineage_id, (-sum(value_minor))::text AS value
          FROM stock_ledger_entries
         WHERE tenant_id = ${tenantId}::uuid AND project_id = ${projectId}::uuid
           AND kind IN ('issue', 'return') AND bq_item_lineage_id IS NOT NULL
         GROUP BY bq_item_lineage_id`,
      tx.$queryRaw<{ direction: string; value: string }[]>`
        SELECT CASE WHEN e.kind = 'transfer_in' THEN 'in' ELSE 'out' END AS direction,
               abs(sum(e.value_minor))::text AS value
          FROM stock_ledger_entries e
          JOIN stock_transfers t ON t.tenant_id = e.tenant_id AND t.id = e.transfer_id
         WHERE e.tenant_id = ${tenantId}::uuid AND e.project_id = ${projectId}::uuid
           AND t.from_project_id <> t.to_project_id
         GROUP BY 1`,
      tx.invoiceSettlement.aggregate({
        where: { tenantId, payable: { invoice: { projectId } } },
        _sum: { amountMinor: true },
      }),
      tx.costEntry.aggregate({
        where: { tenantId, projectId, measure: "accrued", invoiceId: { not: null } },
        _sum: { amountMinor: true },
      }),
      tx.costEntry.aggregate({
        where: { tenantId, projectId, measure: "paid", settlementId: null },
        _sum: { amountMinor: true },
      }),
    ]);
  const issued = new Map<string, { versionId: string; value: number }>();
  for (const row of issueRows) {
    const value = stockValueToMinor(row.value);
    if (value !== 0) issued.set(row.lineage_id, { versionId: row.version_id, value });
  }
  const transfer = (direction: string) => {
    const row = transferRows.find((entry) => entry.direction === direction);
    return row ? stockValueToMinor(row.value) : 0;
  };
  return {
    budget: budget
      ? {
          id: budget.id,
          versionNo: budget.versionNo,
          name: budget.name,
          approvedAt: budget.approvedAt,
          totalMinor: minorOf(budget.totalMinor),
          bqVersionId: budget.bqVersionId,
        }
      : null,
    budgetLines: lines.map((line) => ({
      lineageId: line.bqItemLineageId,
      category: line.category as CostCategory | null,
      costCodeId: line.costCodeId,
      amountMinor: minorOf(line.amountMinor),
    })),
    entries: grouped.map((row) => ({
      measure: row.measure,
      category: row.category as CostCategory,
      lineageId: row.bqItemLineageId,
      sum: minorOf(row._sum.amountMinor ?? 0n),
    })),
    commitments: commitments.items.map((item) => ({
      lineageId: item.bqItem?.lineageId ?? null,
      versionId: item.bqItem?.versionId ?? null,
      open: item.openCommitmentMinor,
    })),
    issued,
    materialsAccruedMinor: minorOf(materials._sum.amountMinor ?? 0n),
    transferredInMinor: transfer("in"),
    transferredOutMinor: transfer("out"),
    settledCashMinor: minorOf(settled._sum.amountMinor ?? 0n),
    paidNotFromSettlementsMinor: minorOf(paidOther._sum.amountMinor ?? 0n),
  };
}

/** Project totals: budget, committed, actual (accrued) and paid (net of VAT). */
export function projectTotals(facts: ProjectFacts): Figures {
  const figures = empty();
  if (facts.budget) figures.budgetMinor = facts.budget.totalMinor;
  for (const commitment of facts.commitments) figures.committedMinor += commitment.open;
  for (const entry of facts.entries)
    if (entry.measure === "accrued") figures.actualMinor += entry.sum;
    else figures.paidMinor += entry.sum;
  return figures;
}

/** Figures per BQ lineage (budget lines, commitments, accrued and paid entries, issues). */
export function itemFigures(facts: ProjectFacts): Map<string, Figures> {
  const items = new Map<string, Figures>();
  const of = (lineage: string) => {
    if (!items.has(lineage)) items.set(lineage, empty());
    return items.get(lineage)!;
  };
  for (const line of facts.budgetLines)
    if (line.lineageId) addBudget(of(line.lineageId), line.amountMinor);
  for (const commitment of facts.commitments)
    if (commitment.lineageId) of(commitment.lineageId).committedMinor += commitment.open;
  for (const entry of facts.entries)
    if (entry.lineageId) {
      if (entry.measure === "accrued") of(entry.lineageId).actualMinor += entry.sum;
      else of(entry.lineageId).paidMinor += entry.sum;
    }
  for (const [lineage, issue] of facts.issued) of(lineage).actualMinor += issue.value;
  return items;
}

/**
 * Budget against actual and committed (D5.4, brief §5.8): the company summary per project, a
 * project by category and by bill, and a bill's BQ items (searched and paged on the server). The
 * readers are SPENDING_READ_PERMISSIONS on the project; undefined ratios are null (unavailable).
 */
@Injectable()
export class SpendingReportService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: SpendingAccess,
  ) {}

  summary(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const settings = await spendingSettings(tx, access.tenantId);
      const ids = await this.access.projectIds(scope, SPENDING_READ_PERMISSIONS);
      const projects = await tx.project.findMany({
        where: { tenantId: access.tenantId, id: { in: ids } },
        orderBy: { code: "asc" },
      });
      const rows = [];
      for (const project of projects) {
        const facts = await loadProjectFacts(tx, access.tenantId, project.id);
        rows.push({
          project: projectRef(project),
          budget: facts.budget ? budgetRef(facts.budget) : null,
          figures: budgetRow(projectTotals(facts), settings.budgetAlertPercent),
          cashPaidMinor: facts.settledCashMinor + facts.paidNotFromSettlementsMinor,
        });
      }
      return spendingSummaryResponseSchema.parse({
        thresholdPercent: settings.budgetAlertPercent,
        projects: rows,
      });
    });
  }

  project(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const project = await this.access.reader(scope, projectId);
      const settings = await spendingSettings(tx, access.tenantId);
      const threshold = settings.budgetAlertPercent;
      const facts = await loadProjectFacts(tx, access.tenantId, projectId);
      const totals = projectTotals(facts);

      const categories = COST_CATEGORIES.map((category) => {
        const figures = empty();
        for (const line of facts.budgetLines)
          if (line.category === category) addBudget(figures, line.amountMinor);
        if (category === "materials")
          for (const commitment of facts.commitments) figures.committedMinor += commitment.open;
        for (const entry of facts.entries)
          if (entry.category === category) {
            if (entry.measure === "accrued") figures.actualMinor += entry.sum;
            else figures.paidMinor += entry.sum;
          }
        return { category, ...budgetRow(figures, threshold) };
      });
      const uncategorised = facts.budgetLines
        .filter((line) => line.category === null)
        .reduce((sum, line) => sum + line.amountMinor, 0);

      const items = itemFigures(facts);
      const bills = await this.billsOf(scope, projectId, items, facts);
      const onItems = sumFigures(bills.map((bill) => bill.figures));
      const costCodeBudget = facts.budgetLines
        .filter((line) => line.costCodeId !== null)
        .reduce<number | null>((sum, line) => (sum ?? 0) + line.amountMinor, null);
      const notOnBqItems: Figures = {
        budgetMinor: costCodeBudget,
        committedMinor: totals.committedMinor - onItems.committedMinor,
        actualMinor: totals.actualMinor - onItems.actualMinor,
        paidMinor: totals.paidMinor - onItems.paidMinor,
      };
      const issuedMinor = [...facts.issued.values()].reduce((sum, row) => sum + row.value, 0);
      return projectSpendingResponseSchema.parse({
        project: projectRef(project.project),
        budget: facts.budget ? budgetRef(facts.budget) : null,
        thresholdPercent: threshold,
        totals: budgetRow(totals, threshold),
        cashPaidMinor: facts.settledCashMinor + facts.paidNotFromSettlementsMinor,
        categories,
        uncategorisedBudgetMinor: uncategorised,
        bills: bills.map((bill) => ({
          bill: bill.bill,
          itemCount: bill.itemCount,
          ...budgetRow(bill.figures, threshold),
        })),
        notOnBqItems: budgetRow(notOnBqItems, threshold),
        materials: {
          accruedMinor: facts.materialsAccruedMinor,
          issuedMinor,
          notIssuedMinor: facts.materialsAccruedMinor - issuedMinor,
          transferredInMinor: facts.transferredInMinor,
          transferredOutMinor: facts.transferredOutMinor,
        },
        permissions: {
          canPrepareBudget: this.access.can(project, BUDGET_PREPARE_PERMISSIONS),
          canJournal: this.access.can(project, ["finance.manage"]),
        },
      });
    });
  }

  /**
   * Bills with their figures. Items are grouped by the bill they sit in in the BQ in force (the
   * newest approved version); an item that is no longer there (omitted by a variation) keeps the
   * bill of the version it was budgeted or posted against.
   */
  async billsOf(scope: Scope, projectId: string, items: Map<string, Figures>, facts: ProjectFacts) {
    const { tx, access } = scope;
    const current = await approvedBqVersion(tx, access.tenantId, projectId);
    const bills = new Map<
      string,
      { bill: BillRef; figures: Figures; itemCount: number; order: number }
    >();
    if (current) {
      const rows = await tx.bqBill.findMany({
        where: { tenantId: access.tenantId, versionId: current.id },
        orderBy: { sortOrder: "asc" },
        select: {
          lineageId: true,
          number: true,
          title: true,
          sortOrder: true,
          _count: { select: { items: true } },
        },
      });
      for (const row of rows)
        bills.set(row.lineageId, {
          bill: { lineageId: row.lineageId, number: row.number, title: row.title },
          figures: empty(),
          itemCount: row._count.items,
          order: row.sortOrder,
        });
    }
    const lineages = [...items.keys()];
    if (!lineages.length) return [...bills.values()].sort((a, b) => a.order - b.order);
    const placed = current
      ? await tx.bqItem.findMany({
          where: { tenantId: access.tenantId, versionId: current.id, lineageId: { in: lineages } },
          select: { lineageId: true, bill: { select: { lineageId: true } } },
        })
      : [];
    const billOf = new Map(placed.map((row) => [row.lineageId, row.bill.lineageId]));
    const missing = lineages.filter((lineage) => !billOf.has(lineage));
    if (missing.length) {
      // Their own version: from the budget, a commitment, an entry or an issue.
      const versions = new Set<string>();
      if (facts.budget?.bqVersionId) versions.add(facts.budget.bqVersionId);
      for (const commitment of facts.commitments)
        if (commitment.versionId) versions.add(commitment.versionId);
      for (const issue of facts.issued.values()) versions.add(issue.versionId);
      const entryVersions = await tx.costEntry.findMany({
        where: { tenantId: access.tenantId, projectId, bqItemLineageId: { in: missing } },
        select: { bqVersionId: true },
        distinct: ["bqVersionId"],
      });
      for (const row of entryVersions) if (row.bqVersionId) versions.add(row.bqVersionId);
      const older = await tx.bqItem.findMany({
        where: {
          tenantId: access.tenantId,
          versionId: { in: [...versions] },
          lineageId: { in: missing },
        },
        select: {
          lineageId: true,
          bill: { select: { lineageId: true, number: true, title: true, sortOrder: true } },
        },
      });
      for (const row of older) {
        billOf.set(row.lineageId, row.bill.lineageId);
        if (!bills.has(row.bill.lineageId))
          bills.set(row.bill.lineageId, {
            bill: { lineageId: row.bill.lineageId, number: row.bill.number, title: row.bill.title },
            figures: empty(),
            itemCount: 0,
            order: 10_000 + row.bill.sortOrder,
          });
      }
    }
    for (const [lineage, figures] of items) {
      const bill = bills.get(billOf.get(lineage) ?? "");
      if (!bill) continue;
      const sum = sumFigures([bill.figures, figures]);
      bill.figures = sum;
    }
    return [...bills.values()].sort((a, b) => a.order - b.order);
  }

  /** A bill's BQ items (BQ in force) with their figures, searched and paged on the server. */
  billItems(
    principal: Principal,
    projectId: string,
    billLineageId: string,
    query: { search?: string; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const project = await this.access.reader(scope, projectId);
      const settings = await spendingSettings(tx, access.tenantId);
      const current = await approvedBqVersion(tx, access.tenantId, projectId);
      if (!current) throw new NotFoundException("The project has no approved BQ");
      const bill = await tx.bqBill.findUnique({
        where: {
          tenantId_versionId_lineageId: {
            tenantId: access.tenantId,
            versionId: current.id,
            lineageId: billLineageId,
          },
        },
      });
      if (!bill) throw new NotFoundException("Bill not found in the BQ in force");
      const search = query.search?.trim();
      const offset = query.cursor ? Number(query.cursor) : 0;
      const rows = await tx.bqItem.findMany({
        where: {
          tenantId: access.tenantId,
          versionId: current.id,
          billId: bill.id,
          ...(search
            ? {
                OR: [
                  { ref: { contains: search, mode: "insensitive" } },
                  { description: { contains: search, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        orderBy: { sortOrder: "asc" },
        skip: offset,
        take: query.limit + 1,
        select: { ...bqItemSelect, amountMinor: true },
      });
      const page = rows.slice(0, query.limit);
      const facts = await loadProjectFacts(tx, access.tenantId, projectId);
      const figures = itemFigures(facts);
      return billItemsResponseSchema.parse({
        project: projectRef(project.project),
        bill: { lineageId: bill.lineageId, number: bill.number, title: bill.title },
        thresholdPercent: settings.budgetAlertPercent,
        items: page.map((row) => ({
          item: toBqItem(row),
          contractAmountMinor: minorOf(row.amountMinor),
          ...budgetRow(figures.get(row.lineageId) ?? empty(), settings.budgetAlertPercent),
        })),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? String(offset + query.limit) : null,
        },
      });
    });
  }

  /**
   * BQ items of the BQ in force (the newest approved version), searched on the server and capped
   * at SPENDING_LIMITS.bqItemsPerSearch (with `truncated`). Readers: spending readers, budget
   * preparers and petty-cash readers (the expense form tags an item).
   */
  bqItems(principal: Principal, projectId: string, search: string | undefined, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const project = await this.access.on(scope, projectId);
      if (
        !this.access.canRead(project) &&
        !this.access.canReadPettyCash(project) &&
        !this.access.holds(project, BUDGET_PREPARE_PERMISSIONS)
      )
        throw new ForbiddenException("No spending permission on this project");
      const current = await approvedBqVersion(tx, access.tenantId, projectId);
      if (!current)
        return bqItemSearchResponseSchema.parse({ items: [], truncated: false, versionId: null });
      const needle = search?.trim();
      const rows = await tx.bqItem.findMany({
        where: {
          tenantId: access.tenantId,
          versionId: current.id,
          ...(needle
            ? {
                OR: [
                  { ref: { contains: needle, mode: "insensitive" } },
                  { description: { contains: needle, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        orderBy: [{ bill: { sortOrder: "asc" } }, { sortOrder: "asc" }],
        take: SPENDING_LIMITS.bqItemsPerSearch + 1,
        select: bqItemSelect,
      });
      const items: SpendingBqItem[] = rows.slice(0, SPENDING_LIMITS.bqItemsPerSearch).map(toBqItem);
      return bqItemSearchResponseSchema.parse({
        items,
        truncated: rows.length > SPENDING_LIMITS.bqItemsPerSearch,
        versionId: current.id,
      });
    });
  }
}

const budgetRef = (budget: NonNullable<ProjectFacts["budget"]>) => ({
  id: budget.id,
  versionNo: budget.versionNo,
  name: budget.name,
  approvedAt: budget.approvedAt ? budget.approvedAt.toISOString() : null,
});
