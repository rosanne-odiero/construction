import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { SPENDING_READ_PERMISSIONS, type CostCategory } from "@pm-buddy/types";
import {
  costLedgerResponseSchema,
  journalResponseSchema,
  journalsResponseSchema,
  type CostLedgerQuery,
  type CreateJournalRequest,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../common/database-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { nextId } from "../procurement/catalogue-store.js";
import { peopleOf, personOf, toCalendarDate } from "../procurement/procurement-mappers.js";
import {
  approvedBqVersion,
  bqItemRefs,
  costCodeRefs,
  databaseMessage,
  itemKey,
  makerChecker,
  minorOf,
  nextSpendingNumber,
  projectRef,
  SpendingAccess,
  spendingConflict,
  spendingInvalidTransition,
  spendingProblem,
  spendingVersionConflict,
  supplierNames,
} from "./spending-common.js";

type EntryRow = Prisma.CostEntryGetPayload<object>;
type JournalRow = Prisma.CostJournalGetPayload<object>;
const MANAGER = ["finance.manage"] as const;
const fromDate = (value: string) => new Date(`${value}T00:00:00.000Z`);

/**
 * The append-only cost ledger and manual journals (D5.4, brief §5.8 and §15 C). Entries are
 * posted by their sources (approved invoices and settlements by database triggers; approved
 * expenses, counts and journals by the services in the same transaction) and checked against them
 * by `app.check_cost_entry`; nothing is ever edited. A correction is a REVERSAL JOURNAL that
 * mirrors one entry with the opposite sign, proposed by one `finance.manage` holder and approved
 * (step-up) by another; an adjustment journal posts new tagged lines the same way. Audit events
 * name records and counts, never amounts or references.
 */
@Injectable()
export class CostLedgerService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: SpendingAccess,
  ) {}

  list(principal: Principal, query: CostLedgerQuery & { limit: number }, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const projectIds = await this.access.projectIds(
        scope,
        SPENDING_READ_PERMISSIONS,
        query.projectId,
      );
      const where: Prisma.CostEntryWhereInput = {
        tenantId: access.tenantId,
        projectId: { in: projectIds },
        ...(query.measure ? { measure: query.measure } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.source ? { source: query.source } : {}),
        ...(query.costCodeId ? { costCodeId: query.costCodeId } : {}),
        ...(query.bqItemLineageId ? { bqItemLineageId: query.bqItemLineageId } : {}),
        ...(query.from || query.to
          ? {
              occurredOn: {
                ...(query.from ? { gte: fromDate(query.from) } : {}),
                ...(query.to ? { lte: fromDate(query.to) } : {}),
              },
            }
          : {}),
      };
      const after = query.cursor
        ? await tx.costEntry.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: query.cursor } },
            select: { id: true, recordedAt: true },
          })
        : null;
      const [rows, totals] = await Promise.all([
        tx.costEntry.findMany({
          where: {
            ...where,
            ...(after
              ? {
                  OR: [
                    { recordedAt: { lt: after.recordedAt } },
                    { recordedAt: after.recordedAt, id: { lt: after.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
          take: query.limit! + 1,
        }),
        tx.costEntry.groupBy({ by: ["measure"], where, _sum: { amountMinor: true }, _count: true }),
      ]);
      const page = rows.slice(0, query.limit);
      const sum = (measure: string) =>
        minorOf(totals.find((row) => row.measure === measure)?._sum.amountMinor ?? 0n);
      return costLedgerResponseSchema.parse({
        entries: await this.wire(scope, page),
        totals: {
          accruedMinor: sum("accrued"),
          paidMinor: sum("paid"),
          count: totals.reduce((count, row) => count + row._count, 0),
        },
        page: {
          hasMore: rows.length > query.limit!,
          nextCursor: rows.length > query.limit! ? page.at(-1)!.id : null,
        },
        permissions: { canReverse: this.access.company(scope, MANAGER) },
      });
    });
  }

  async wire(scope: Scope, rows: EntryRow[]) {
    const { tx, access } = scope;
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const [
      projects,
      sites,
      codes,
      items,
      suppliers,
      people,
      reversals,
      invoices,
      expenses,
      counts,
      journals,
    ] = await Promise.all([
      tx.project.findMany({
        where: { tenantId: access.tenantId, id: { in: rows.map((row) => row.projectId) } },
        select: { id: true, code: true, name: true },
      }),
      tx.site.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: rows.flatMap((row) => (row.siteId ? [row.siteId] : [])) },
        },
        select: { id: true, name: true },
      }),
      costCodeRefs(
        tx,
        access.tenantId,
        rows.map((row) => row.costCodeId),
      ),
      bqItemRefs(
        tx,
        access.tenantId,
        rows.map((row) =>
          row.bqVersionId && row.bqItemLineageId
            ? { versionId: row.bqVersionId, lineageId: row.bqItemLineageId }
            : null,
        ),
      ),
      supplierNames(
        tx,
        access.tenantId,
        rows.map((row) => row.supplierId),
      ),
      peopleOf(
        tx,
        rows.map((row) => row.recordedBy),
      ),
      tx.costEntry.findMany({
        where: { tenantId: access.tenantId, reversesEntryId: { in: ids } },
        select: { id: true, reversesEntryId: true },
      }),
      tx.supplierInvoice.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: rows.flatMap((row) => (row.invoiceId ? [row.invoiceId] : [])) },
        },
        select: { id: true, invoiceNumber: true },
      }),
      tx.pettyCashExpense.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: rows.flatMap((row) => (row.expenseId ? [row.expenseId] : [])) },
        },
        select: { id: true, number: true },
      }),
      tx.pettyCashCount.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: rows.flatMap((row) => (row.floatCountId ? [row.floatCountId] : [])) },
        },
        select: { id: true, number: true },
      }),
      tx.costJournal.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: rows.flatMap((row) => (row.journalId ? [row.journalId] : [])) },
        },
        select: { id: true, number: true },
      }),
    ]);
    const label = (list: { id: string; number?: string; invoiceNumber?: string }[], id: string) => {
      const found = list.find((entry) => entry.id === id);
      return found?.number ?? found?.invoiceNumber ?? "—";
    };
    return rows.map((row) => {
      const project = projects.find((entry) => entry.id === row.projectId)!;
      const document =
        row.source === "supplier_invoice" || row.source === "invoice_settlement"
          ? { kind: row.source, id: row.invoiceId!, label: label(invoices, row.invoiceId!) }
          : row.source === "petty_cash_expense"
            ? { kind: row.source, id: row.expenseId!, label: label(expenses, row.expenseId!) }
            : row.source === "petty_cash_count"
              ? { kind: row.source, id: row.floatCountId!, label: label(counts, row.floatCountId!) }
              : { kind: row.source, id: row.journalId!, label: label(journals, row.journalId!) };
      return {
        id: row.id,
        project: projectRef(project),
        site: sites.find((site) => site.id === row.siteId) ?? null,
        measure: row.measure,
        category: row.category as CostCategory,
        costCode: row.costCodeId ? (codes.get(row.costCodeId) ?? null) : null,
        bqItem: items.get(itemKey(row.bqVersionId, row.bqItemLineageId) ?? "") ?? null,
        counterpartyKind: row.counterpartyKind,
        supplier: row.supplierId
          ? { id: row.supplierId, name: suppliers.get(row.supplierId) ?? "—" }
          : null,
        counterpartyName: row.counterpartyName,
        paymentReference: row.paymentReference,
        amountMinor: minorOf(row.amountMinor),
        occurredOn: toCalendarDate(row.occurredOn),
        source: row.source,
        purpose: row.purpose,
        document,
        reversesEntryId: row.reversesEntryId,
        reversedByEntryId: reversals.find((entry) => entry.reversesEntryId === row.id)?.id ?? null,
        recordedBy: personOf(people, row.recordedBy),
        recordedAt: row.recordedAt.toISOString(),
        businessDate: toCalendarDate(row.businessDate),
      };
    });
  }

  // Journals ----------------------------------------------------------------------------------

  journals(
    principal: Principal,
    query: { projectId?: string; status?: string; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const projectIds = await this.access.projectIds(
        scope,
        SPENDING_READ_PERMISSIONS,
        query.projectId,
      );
      const after = query.cursor
        ? await tx.costJournal.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: query.cursor } },
            select: { id: true, createdAt: true },
          })
        : null;
      const rows = await tx.costJournal.findMany({
        where: {
          tenantId: access.tenantId,
          projectId: { in: projectIds },
          ...(query.status ? { status: query.status } : {}),
          ...(after
            ? {
                OR: [
                  { createdAt: { lt: after.createdAt } },
                  { createdAt: after.createdAt, id: { lt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      return journalsResponseSchema.parse({
        journals: await this.summaries(scope, page),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
        },
        permissions: { canCreate: this.access.company(scope, MANAGER) },
      });
    });
  }

  journal(principal: Principal, id: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const row = await this.journalRow(scope, id);
      await this.access.reader(scope, row.projectId);
      return this.journalResponse(scope, row);
    });
  }

  createJournal(principal: Principal, input: CreateJournalRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.access.require(scope, input.projectId, MANAGER, { writable: true });
        const bq = await approvedBqVersion(tx, access.tenantId, input.projectId);
        const lines = [];
        for (const [index, line] of input.lines.entries()) {
          if (line.costCodeId) {
            const code = await tx.costCode.findUnique({
              where: { tenantId_id: { tenantId: access.tenantId, id: line.costCodeId } },
            });
            if (!code) throw spendingProblem(422, "cost-code-not-found", "Cost code not found");
            if (!code.active)
              throw spendingConflict("cost-code-inactive", "This cost code is inactive");
          }
          if (line.bqItemLineageId) {
            if (!bq) throw spendingConflict("bq-not-approved", "The project has no approved BQ");
            const item = await tx.bqItem.findUnique({
              where: {
                tenantId_versionId_lineageId: {
                  tenantId: access.tenantId,
                  versionId: bq.id,
                  lineageId: line.bqItemLineageId,
                },
              },
            });
            if (!item)
              throw spendingProblem(422, "bq-item-not-found", "The item is not in the BQ in force");
          }
          if (line.siteId) {
            const site = await tx.site.findUnique({
              where: { tenantId_id: { tenantId: access.tenantId, id: line.siteId } },
            });
            if (!site || site.projectId !== input.projectId)
              throw new BadRequestException({
                code: "site-not-in-project",
                message: "The site is not on this project",
              });
          }
          if (line.supplierId) {
            const supplier = await tx.supplier.findUnique({
              where: { tenantId_id: { tenantId: access.tenantId, id: line.supplierId } },
            });
            if (!supplier) throw spendingProblem(422, "supplier-not-found", "Supplier not found");
          }
          lines.push({
            id: nextId(),
            tenantId: access.tenantId,
            projectId: input.projectId,
            lineNo: index + 1,
            measure: line.measure,
            category: line.category,
            costCodeId: line.costCodeId ?? null,
            bqVersionId: line.bqItemLineageId ? bq!.id : null,
            bqItemLineageId: line.bqItemLineageId ?? null,
            siteId: line.siteId ?? null,
            counterpartyKind: line.counterpartyKind,
            supplierId: line.supplierId ?? null,
            counterpartyName: line.counterpartyName ?? null,
            paymentReference: line.paymentReference ?? null,
            occurredOn: fromDate(line.occurredOn),
            amountMinor: BigInt(line.amountMinor),
          });
        }
        const id = nextId();
        await tx.costJournal.create({
          data: {
            id,
            tenantId: access.tenantId,
            projectId: input.projectId,
            number: await nextSpendingNumber(tx, access.tenantId, "journal"),
            kind: "adjustment",
            reason: input.reason,
            lineCount: lines.length,
            createdBy: access.userId,
          },
        });
        await tx.costJournalLine.createMany({
          data: lines.map((line) => ({ ...line, journalId: id })),
        });
        await this.scope.audit(tx, "cost_journal.proposed", id, {
          projectId: input.projectId,
          kind: "adjustment",
          lines: lines.length,
        });
        return this.journalResponse(scope, await this.journalRow(scope, id));
      },
      true,
    );
  }

  /** Proposes the reversal of one entry (the mirror line with the opposite sign). */
  createReversal(principal: Principal, input: { entryId: string; reason: string }, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const entry = await tx.costEntry.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: input.entryId } },
        });
        if (!entry) throw new NotFoundException("Cost entry not found");
        await this.access.require(scope, entry.projectId, MANAGER, { writable: true });
        if (entry.purpose === "reversal")
          throw spendingConflict("entry-is-reversal", "A reversal is not reversed again");
        const taken = await tx.costJournalLine.findFirst({
          where: {
            tenantId: access.tenantId,
            reversesEntryId: entry.id,
            journal: { status: { in: ["submitted", "approved"] } },
          },
        });
        if (taken)
          throw spendingConflict("entry-already-reversed", "This entry is already being reversed");
        const id = nextId();
        await tx.costJournal.create({
          data: {
            id,
            tenantId: access.tenantId,
            projectId: entry.projectId,
            number: await nextSpendingNumber(tx, access.tenantId, "journal"),
            kind: "reversal",
            reason: input.reason,
            lineCount: 1,
            createdBy: access.userId,
          },
        });
        await tx.costJournalLine.create({
          data: {
            id: nextId(),
            tenantId: access.tenantId,
            projectId: entry.projectId,
            journalId: id,
            lineNo: 1,
            measure: entry.measure,
            category: entry.category,
            costCodeId: entry.costCodeId,
            bqVersionId: entry.bqVersionId,
            bqItemLineageId: entry.bqItemLineageId,
            siteId: entry.siteId,
            counterpartyKind: entry.counterpartyKind,
            supplierId: entry.supplierId,
            counterpartyName: entry.counterpartyName,
            paymentReference: entry.paymentReference,
            occurredOn: entry.occurredOn,
            amountMinor: -entry.amountMinor,
            reversesEntryId: entry.id,
          },
        });
        await this.scope.audit(tx, "cost_journal.proposed", id, {
          projectId: entry.projectId,
          kind: "reversal",
          entryId: entry.id,
        });
        return this.journalResponse(scope, await this.journalRow(scope, id));
      },
      true,
    );
  }

  /** Approval posts every line to the ledger; the approver is never the journal's author. */
  approveJournal(principal: Principal, id: string, version: number, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.journalRow(scope, id);
          await this.access.require(scope, row.projectId, MANAGER, {
            stepUp: true,
            writable: true,
          });
          if (row.status !== "submitted") throw spendingInvalidTransition(row.status);
          if (row.version !== version) throw spendingVersionConflict();
          if (row.createdBy === access.userId)
            throw makerChecker("The author of a journal cannot approve it");
          await tx.costJournal.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data: {
              status: "approved",
              decidedBy: access.userId,
              decidedAt: new Date(),
              version: { increment: 1 },
            },
          });
          const lines = await tx.costJournalLine.findMany({
            where: { tenantId: access.tenantId, journalId: id },
            orderBy: { lineNo: "asc" },
          });
          for (const line of lines)
            await tx.costEntry.create({
              data: {
                id: nextId(),
                tenantId: access.tenantId,
                projectId: line.projectId,
                siteId: line.siteId,
                measure: line.measure,
                category: line.category,
                costCodeId: line.costCodeId,
                bqVersionId: line.bqVersionId,
                bqItemLineageId: line.bqItemLineageId,
                counterpartyKind: line.counterpartyKind,
                supplierId: line.supplierId,
                counterpartyName: line.counterpartyName,
                paymentReference: line.paymentReference,
                amountMinor: line.amountMinor,
                occurredOn: line.occurredOn,
                source: "cost_journal",
                purpose: line.reversesEntryId ? "reversal" : "journal",
                journalId: id,
                journalLineId: line.id,
                reversesEntryId: line.reversesEntryId,
                recordedBy: access.userId,
                businessDate: new Date(),
              },
            });
          await this.scope.audit(tx, "cost_journal.approved", id, {
            projectId: row.projectId,
            kind: row.kind,
            lines: lines.length,
          });
          return this.journalResponse(scope, await this.journalRow(scope, id));
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw spendingConflict("entry-already-reversed", "This entry was already reversed");
        if (databaseMessage(error).includes("other than its author"))
          throw makerChecker("The author of a journal cannot approve it");
        throw error;
      });
  }

  rejectJournal(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.journalRow(scope, id);
        await this.access.require(scope, row.projectId, MANAGER, { writable: true });
        if (row.status !== "submitted") throw spendingInvalidTransition(row.status);
        if (row.version !== input.version) throw spendingVersionConflict();
        if (row.createdBy === access.userId)
          throw makerChecker("The author of a journal cannot decide it");
        await tx.costJournal.update({
          where: { tenantId_id: { tenantId: access.tenantId, id } },
          data: {
            status: "rejected",
            decidedBy: access.userId,
            decidedAt: new Date(),
            decisionReason: input.reason,
            version: { increment: 1 },
          },
        });
        await this.scope.audit(tx, "cost_journal.rejected", id, {
          projectId: row.projectId,
          reasonGiven: true,
        });
        return this.journalResponse(scope, await this.journalRow(scope, id));
      },
      true,
    );
  }

  private async journalRow(scope: Scope, id: string): Promise<JournalRow> {
    const row = await scope.tx.costJournal.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("Journal not found");
    return row;
  }

  private async summaries(scope: Scope, rows: JournalRow[]) {
    const { tx, access } = scope;
    if (!rows.length) return [];
    const [projects, people, totals] = await Promise.all([
      tx.project.findMany({
        where: { tenantId: access.tenantId, id: { in: rows.map((row) => row.projectId) } },
        select: { id: true, code: true, name: true },
      }),
      peopleOf(
        tx,
        rows.flatMap((row) => [row.createdBy, row.decidedBy]),
      ),
      tx.costJournalLine.groupBy({
        by: ["journalId"],
        where: { tenantId: access.tenantId, journalId: { in: rows.map((row) => row.id) } },
        _sum: { amountMinor: true },
      }),
    ]);
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      project: projectRef(projects.find((project) => project.id === row.projectId)!),
      kind: row.kind as "adjustment" | "reversal",
      reason: row.reason,
      status: row.status as "submitted" | "approved" | "rejected",
      lineCount: row.lineCount,
      totalMinor: minorOf(
        totals.find((total) => total.journalId === row.id)?._sum.amountMinor ?? 0n,
      ),
      createdBy: personOf(people, row.createdBy),
      createdAt: row.createdAt.toISOString(),
      decidedBy: row.decidedBy ? personOf(people, row.decidedBy) : null,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionReason: row.decisionReason,
      version: row.version,
    }));
  }

  private async journalResponse(scope: Scope, row: JournalRow) {
    const { tx, access } = scope;
    const [summary] = await this.summaries(scope, [row]);
    const lines = await tx.costJournalLine.findMany({
      where: { tenantId: access.tenantId, journalId: row.id },
      orderBy: { lineNo: "asc" },
    });
    const [codes, items, suppliers, sites, posted] = await Promise.all([
      costCodeRefs(
        tx,
        access.tenantId,
        lines.map((line) => line.costCodeId),
      ),
      bqItemRefs(
        tx,
        access.tenantId,
        lines.map((line) =>
          line.bqVersionId && line.bqItemLineageId
            ? { versionId: line.bqVersionId, lineageId: line.bqItemLineageId }
            : null,
        ),
      ),
      supplierNames(
        tx,
        access.tenantId,
        lines.map((line) => line.supplierId),
      ),
      tx.site.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: lines.flatMap((line) => (line.siteId ? [line.siteId] : [])) },
        },
        select: { id: true, name: true },
      }),
      tx.costEntry.findMany({
        where: { tenantId: access.tenantId, journalId: row.id },
        select: { id: true, journalLineId: true },
      }),
    ]);
    const project = await this.access.on(scope, row.projectId);
    const decider =
      this.access.can(project, MANAGER) &&
      row.status === "submitted" &&
      row.createdBy !== access.userId;
    return journalResponseSchema.parse({
      journal: {
        ...summary!,
        lines: lines.map((line) => ({
          id: line.id,
          lineNo: line.lineNo,
          measure: line.measure,
          category: line.category,
          costCode: line.costCodeId ? (codes.get(line.costCodeId) ?? null) : null,
          bqItem: items.get(itemKey(line.bqVersionId, line.bqItemLineageId) ?? "") ?? null,
          site: sites.find((site) => site.id === line.siteId) ?? null,
          counterpartyKind: line.counterpartyKind,
          supplier: line.supplierId
            ? { id: line.supplierId, name: suppliers.get(line.supplierId) ?? "—" }
            : null,
          counterpartyName: line.counterpartyName,
          paymentReference: line.paymentReference,
          occurredOn: toCalendarDate(line.occurredOn),
          amountMinor: minorOf(line.amountMinor),
          reversesEntryId: line.reversesEntryId,
          postedEntryId: posted.find((entry) => entry.journalLineId === line.id)?.id ?? null,
        })),
      },
      permissions: { canApprove: decider, canReject: decider },
    });
  }
}
