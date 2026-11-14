import { createHash } from "node:crypto";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Request } from "express";
import {
  BUDGET_PREPARE_PERMISSIONS,
  SPENDING_LIMITS,
  type BudgetSource,
  type BudgetStatus,
  type CostCategory,
} from "@pm-buddy/types";
import {
  budgetDetailResponseSchema,
  budgetLinesResponseSchema,
  budgetsResponseSchema,
  type BudgetSummary,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../common/database-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { nextId } from "../procurement/catalogue-store.js";
import { peopleOf, personOf } from "../procurement/procurement-mappers.js";
import {
  approvedBqVersion,
  bqItemRefs,
  costCodeRefs,
  databaseMessage,
  itemKey,
  makerChecker,
  minorOf,
  projectRef,
  SpendingAccess,
  spendingConflict,
  spendingDatabaseProblem,
  spendingInvalidTransition,
  spendingProblem,
  spendingVersionConflict,
  type ProjectAccess,
} from "./spending-common.js";

type BudgetRow = Prisma.BudgetGetPayload<object>;
const APPROVER = ["finance.manage"] as const;
const truncate = (value: string, max: number) => Array.from(value).slice(0, max).join("");

/**
 * Versioned project budgets (D5.4, brief §5.8, WORKFLOWS "Budgets"): prepared by someone with
 * `finance.manage` or `bq.edit` on the project, from the BQ in force (one line per item at the BQ
 * amount), a copy of the budget in force, or empty, plus cost-code lines (preliminaries, fees,
 * permits…); submitted with a SHA-256 digest of its lines; approved with step-up by a
 * `finance.manage` holder who never contributed and who quotes the digest they saw. The newest
 * approved version is the budget in force; approved versions never change (database trigger).
 */
@Injectable()
export class BudgetsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: SpendingAccess,
  ) {}

  private canSee(access: ProjectAccess) {
    return this.access.canRead(access) || this.access.holds(access, BUDGET_PREPARE_PERMISSIONS);
  }

  private async viewer(scope: Scope, projectId: string) {
    const access = await this.access.on(scope, projectId);
    if (!this.canSee(access)) throw new ForbiddenException("No budget permission on this project");
    return access;
  }

  list(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const project = await this.viewer(scope, projectId);
      const rows = await scope.tx.budget.findMany({
        where: { tenantId: scope.access.tenantId, projectId },
        orderBy: { versionNo: "desc" },
      });
      const open = rows.some((row) => row.status === "draft" || row.status === "submitted");
      return budgetsResponseSchema.parse({
        project: projectRef(project.project),
        budgets: await this.summaries(scope, project, rows),
        permissions: {
          canCreate: this.access.can(project, BUDGET_PREPARE_PERMISSIONS) && !open,
        },
      });
    });
  }

  create(
    principal: Principal,
    input: { projectId: string; name: string; source: BudgetSource; notes?: string | null },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          await this.access.require(scope, input.projectId, BUDGET_PREPARE_PERMISSIONS, {
            writable: true,
          });
          const open = await tx.budget.findFirst({
            where: {
              tenantId: access.tenantId,
              projectId: input.projectId,
              status: { in: ["draft", "submitted"] },
            },
          });
          if (open)
            throw spendingConflict("budget-open", "A budget version is already being prepared");
          const bq = await approvedBqVersion(tx, access.tenantId, input.projectId);
          if (input.source === "bq" && !bq)
            throw spendingConflict("bq-not-approved", "The project has no approved BQ yet");
          const last = await tx.budget.findFirst({
            where: { tenantId: access.tenantId, projectId: input.projectId },
            orderBy: { versionNo: "desc" },
            select: { versionNo: true },
          });
          const id = nextId();
          await tx.budget.create({
            data: {
              id,
              tenantId: access.tenantId,
              projectId: input.projectId,
              versionNo: (last?.versionNo ?? 0) + 1,
              name: input.name,
              notes: input.notes ?? null,
              bqVersionId: bq?.id ?? null,
              contributors: [access.userId],
              createdBy: access.userId,
              updatedBy: access.userId,
            },
          });
          const lines = await this.startingLines(scope, input, bq?.id ?? null);
          if (lines.length > SPENDING_LIMITS.budgetLines)
            throw spendingConflict(
              "budget-too-large",
              `A budget holds at most ${SPENDING_LIMITS.budgetLines} lines`,
            );
          if (lines.length)
            await tx.budgetLine.createMany({
              data: lines.map((line, index) => ({
                id: nextId(),
                tenantId: access.tenantId,
                budgetId: id,
                lineNo: index + 1,
                ...line,
              })),
            });
          await this.scope.audit(tx, "budget.created", id, {
            projectId: input.projectId,
            source: input.source,
            lines: lines.length,
          });
          return this.detailOf(scope, id);
        },
        true,
        60_000,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw spendingConflict("budget-open", "A budget version is already being prepared");
        throw spendingDatabaseProblem(error) ?? error;
      });
  }

  /** The lines a new version starts with. */
  private async startingLines(
    scope: Scope,
    input: { projectId: string; source: BudgetSource },
    bqVersionId: string | null,
  ) {
    const { tx, access } = scope;
    if (input.source === "bq" && bqVersionId) {
      const items = await tx.bqItem.findMany({
        where: { tenantId: access.tenantId, versionId: bqVersionId, amountMinor: { gt: 0 } },
        orderBy: [{ bill: { sortOrder: "asc" } }, { sortOrder: "asc" }],
        select: { lineageId: true, ref: true, description: true, amountMinor: true },
      });
      return items.map((item) => ({
        bqVersionId,
        bqItemLineageId: item.lineageId,
        costCodeId: null,
        category: null,
        description: truncate(`${item.ref ? `${item.ref} ` : ""}${item.description}`, 300),
        amountMinor: item.amountMinor,
      }));
    }
    if (input.source === "copy") {
      const current = await tx.budget.findFirst({
        where: { tenantId: access.tenantId, projectId: input.projectId, status: "approved" },
        orderBy: { versionNo: "desc" },
      });
      if (!current) return [];
      const lines = await tx.budgetLine.findMany({
        where: { tenantId: access.tenantId, budgetId: current.id },
        orderBy: { lineNo: "asc" },
      });
      // Item lines follow their item into the BQ in force (same lineage); items no longer there
      // are left out and can be budgeted again by a cost code.
      const present = bqVersionId
        ? new Set(
            (
              await tx.bqItem.findMany({
                where: {
                  tenantId: access.tenantId,
                  versionId: bqVersionId,
                  lineageId: {
                    in: lines.flatMap((line) =>
                      line.bqItemLineageId ? [line.bqItemLineageId] : [],
                    ),
                  },
                },
                select: { lineageId: true },
              })
            ).map((row) => row.lineageId),
          )
        : new Set<string>();
      return lines
        .filter((line) => !line.bqItemLineageId || present.has(line.bqItemLineageId))
        .map((line) => ({
          bqVersionId: line.bqItemLineageId ? bqVersionId : null,
          bqItemLineageId: line.bqItemLineageId,
          costCodeId: line.costCodeId,
          category: line.category,
          description: line.description,
          amountMinor: line.amountMinor,
        }));
    }
    return [];
  }

  detail(principal: Principal, id: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const row = await this.row(scope, id);
      await this.viewer(scope, row.projectId);
      return this.detailOf(scope, id);
    });
  }

  lines(
    principal: Principal,
    id: string,
    query: { search?: string; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const row = await this.row(scope, id);
      await this.viewer(scope, row.projectId);
      const search = query.search?.trim();
      const rows = await tx.budgetLine.findMany({
        where: {
          tenantId: access.tenantId,
          budgetId: id,
          ...(search ? { description: { contains: search, mode: "insensitive" } } : {}),
          ...(query.cursor ? { lineNo: { gt: Number(query.cursor) } } : {}),
        },
        orderBy: { lineNo: "asc" },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      return budgetLinesResponseSchema.parse({
        lines: await this.wireLines(scope, page),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? String(page.at(-1)!.lineNo) : null,
        },
      });
    });
  }

  update(
    principal: Principal,
    id: string,
    input: { version: number; name?: string; notes?: string | null },
    req: Request,
  ) {
    return this.edit(principal, id, input.version, req, async (scope, row) => {
      await scope.tx.budget.update({
        where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
      });
      await this.scope.audit(scope.tx, "budget.updated", id, {
        fields: ["name", "notes"].filter((key) => key in input),
        projectId: row.projectId,
      });
    });
  }

  addLine(
    principal: Principal,
    id: string,
    input: {
      version: number;
      bqItemLineageId?: string;
      costCodeId?: string;
      description?: string | null;
      category?: CostCategory | null;
      amountMinor: number;
    },
    req: Request,
  ) {
    return this.edit(principal, id, input.version, req, async (scope, row) => {
      const { tx, access } = scope;
      let line: {
        bqVersionId: string | null;
        bqItemLineageId: string | null;
        costCodeId: string | null;
        category: string | null;
        description: string;
      };
      if (input.bqItemLineageId) {
        if (!row.bqVersionId)
          throw spendingConflict("bq-not-approved", "This budget follows no approved BQ version");
        const item = await tx.bqItem.findUnique({
          where: {
            tenantId_versionId_lineageId: {
              tenantId: access.tenantId,
              versionId: row.bqVersionId,
              lineageId: input.bqItemLineageId,
            },
          },
        });
        if (!item)
          throw spendingProblem(422, "bq-item-not-found", "The item is not in the budget's BQ");
        line = {
          bqVersionId: row.bqVersionId,
          bqItemLineageId: item.lineageId,
          costCodeId: null,
          category: input.category ?? null,
          description:
            input.description ??
            truncate(`${item.ref ? `${item.ref} ` : ""}${item.description}`, 300),
        };
      } else {
        const code = await tx.costCode.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: input.costCodeId! } },
        });
        if (!code) throw spendingProblem(422, "cost-code-not-found", "Cost code not found");
        if (!code.active)
          throw spendingConflict("cost-code-inactive", "This cost code is inactive");
        line = {
          bqVersionId: null,
          bqItemLineageId: null,
          costCodeId: code.id,
          category: code.category,
          description: input.description ?? `${code.code} ${code.name}`,
        };
      }
      const last = await tx.budgetLine.findFirst({
        where: { tenantId: access.tenantId, budgetId: id },
        orderBy: { lineNo: "desc" },
        select: { lineNo: true },
      });
      if (row.lineCount >= SPENDING_LIMITS.budgetLines)
        throw spendingConflict("budget-too-large", "This budget is full");
      await tx.budgetLine.create({
        data: {
          id: nextId(),
          tenantId: access.tenantId,
          budgetId: id,
          lineNo: (last?.lineNo ?? 0) + 1,
          ...line,
          amountMinor: BigInt(input.amountMinor),
        },
      });
      await this.scope.audit(tx, "budget.line_added", id, {
        kind: input.bqItemLineageId ? "bq_item" : "cost_code",
      });
    });
  }

  updateLine(
    principal: Principal,
    id: string,
    lineId: string,
    input: {
      version: number;
      amountMinor?: number;
      description?: string;
      category?: CostCategory | null;
    },
    req: Request,
  ) {
    return this.edit(principal, id, input.version, req, async (scope) => {
      const { tx, access } = scope;
      const line = await tx.budgetLine.findUnique({
        where: { tenantId_id: { tenantId: access.tenantId, id: lineId } },
      });
      if (!line || line.budgetId !== id) throw new NotFoundException("Budget line not found");
      if (line.costCodeId && input.category !== undefined && input.category !== line.category)
        throw new BadRequestException({
          code: "validation-error",
          message: "A cost-code line keeps its code's category",
        });
      await tx.budgetLine.update({
        where: { tenantId_id: { tenantId: access.tenantId, id: lineId } },
        data: {
          ...(input.amountMinor !== undefined ? { amountMinor: BigInt(input.amountMinor) } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.category !== undefined && !line.costCodeId ? { category: input.category } : {}),
        },
      });
      await this.scope.audit(tx, "budget.line_updated", id, {
        lineId,
        fields: ["amountMinor", "description", "category"].filter(
          (key) => input[key as keyof typeof input] !== undefined,
        ),
      });
    });
  }

  removeLine(principal: Principal, id: string, lineId: string, version: number, req: Request) {
    return this.edit(principal, id, version, req, async (scope) => {
      const { tx, access } = scope;
      const line = await tx.budgetLine.findUnique({
        where: { tenantId_id: { tenantId: access.tenantId, id: lineId } },
      });
      if (!line || line.budgetId !== id) throw new NotFoundException("Budget line not found");
      await tx.budgetLine.delete({
        where: { tenantId_id: { tenantId: access.tenantId, id: lineId } },
      });
      await this.scope.audit(tx, "budget.line_removed", id, { lineId });
    });
  }

  submit(principal: Principal, id: string, version: number, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.row(scope, id);
        await this.access.require(scope, row.projectId, BUDGET_PREPARE_PERMISSIONS, {
          writable: true,
        });
        if (row.status !== "draft") throw spendingInvalidTransition(row.status);
        if (row.version !== version) throw spendingVersionConflict();
        if (row.lineCount === 0) throw spendingConflict("budget-empty", "Add lines first");
        await tx.budget.update({
          where: { tenantId_id: { tenantId: access.tenantId, id } },
          data: {
            status: "submitted",
            digest: await this.digest(scope, row),
            submittedBy: access.userId,
            submittedAt: new Date(),
            returnReason: null,
            updatedBy: access.userId,
            updatedAt: new Date(),
            version: { increment: 1 },
          },
        });
        await this.scope.audit(tx, "budget.submitted", id, {
          projectId: row.projectId,
          lines: row.lineCount,
        });
        return this.detailOf(scope, id);
      },
      true,
    );
  }

  /** Approval: finance.manage + step-up, never a contributor, on the digest the approver saw. */
  approve(
    principal: Principal,
    id: string,
    input: { version: number; digest: string },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.row(scope, id);
          await this.access.require(scope, row.projectId, APPROVER, {
            stepUp: true,
            writable: true,
          });
          if (row.status !== "submitted") throw spendingInvalidTransition(row.status);
          if (row.version !== input.version) throw spendingVersionConflict();
          if (row.contributors.includes(access.userId))
            throw makerChecker("Someone who prepared this budget cannot approve it");
          if (row.digest !== input.digest || (await this.digest(scope, row)) !== row.digest)
            throw spendingConflict("budget-stale", "The budget changed since you opened it");
          await tx.budget.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data: {
              status: "approved",
              approvedBy: access.userId,
              approvedAt: new Date(),
              version: { increment: 1 },
            },
          });
          await this.scope.audit(tx, "budget.approved", id, {
            projectId: row.projectId,
            versionNo: row.versionNo,
          });
          return this.detailOf(scope, id);
        },
        true,
      )
      .catch((error: unknown) => {
        if (databaseMessage(error).includes("never a contributor"))
          throw makerChecker("Someone who prepared this budget cannot approve it");
        throw error;
      });
  }

  decide(
    principal: Principal,
    id: string,
    action: "return" | "cancel",
    input: { version: number; reason: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.row(scope, id);
        const permissions = action === "return" ? APPROVER : BUDGET_PREPARE_PERMISSIONS;
        await this.access.require(scope, row.projectId, permissions, { writable: true });
        const allowed: BudgetStatus[] =
          action === "return" ? ["submitted"] : ["draft", "submitted"];
        if (!allowed.includes(row.status as BudgetStatus))
          throw spendingInvalidTransition(row.status);
        if (row.version !== input.version) throw spendingVersionConflict();
        await tx.budget.update({
          where: { tenantId_id: { tenantId: access.tenantId, id } },
          data:
            action === "return"
              ? {
                  status: "draft",
                  digest: null,
                  submittedBy: null,
                  submittedAt: null,
                  returnReason: input.reason,
                  version: { increment: 1 },
                }
              : {
                  status: "cancelled",
                  cancelledBy: access.userId,
                  cancelledAt: new Date(),
                  cancelReason: input.reason,
                  version: { increment: 1 },
                },
        });
        await this.scope.audit(
          tx,
          action === "return" ? "budget.returned" : "budget.cancelled",
          id,
          {
            projectId: row.projectId,
            reasonGiven: true,
          },
        );
        return this.detailOf(scope, id);
      },
      true,
    );
  }

  // Helpers -----------------------------------------------------------------------------------

  private edit(
    principal: Principal,
    id: string,
    version: number,
    req: Request,
    work: (scope: Scope, row: BudgetRow) => Promise<void>,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.row(scope, id);
          await this.access.require(scope, row.projectId, BUDGET_PREPARE_PERMISSIONS, {
            writable: true,
          });
          if (row.status !== "draft") throw spendingInvalidTransition(row.status);
          if (row.version !== version) throw spendingVersionConflict();
          await work(scope, row);
          await tx.budget.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data: { updatedBy: access.userId, updatedAt: new Date(), version: { increment: 1 } },
          });
          return this.detailOf(scope, id);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw spendingConflict(
            "budget-line-exists",
            "This item or cost code is already budgeted",
          );
        throw spendingDatabaseProblem(error) ?? error;
      });
  }

  async row(scope: Scope, id: string): Promise<BudgetRow> {
    const row = await scope.tx.budget.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("Budget not found");
    return row;
  }

  /** SHA-256 of the budget's lines in line order (what an approver approves). */
  private async digest(scope: Scope, row: BudgetRow): Promise<string> {
    const lines = await scope.tx.budgetLine.findMany({
      where: { tenantId: scope.access.tenantId, budgetId: row.id },
      orderBy: { lineNo: "asc" },
      select: {
        lineNo: true,
        bqVersionId: true,
        bqItemLineageId: true,
        costCodeId: true,
        category: true,
        description: true,
        amountMinor: true,
      },
    });
    return createHash("sha256")
      .update(
        JSON.stringify({
          budget: row.id,
          bqVersionId: row.bqVersionId,
          lines: lines.map((line) => ({ ...line, amountMinor: line.amountMinor.toString() })),
        }),
      )
      .digest("hex");
  }

  private async summaries(
    scope: Scope,
    project: ProjectAccess,
    rows: BudgetRow[],
  ): Promise<BudgetSummary[]> {
    const { tx, access } = scope;
    const people = await peopleOf(
      tx,
      rows.flatMap((row) => [row.createdBy, row.approvedBy]),
    );
    const versions = await tx.bqVersion.findMany({
      where: {
        tenantId: access.tenantId,
        id: { in: rows.flatMap((row) => (row.bqVersionId ? [row.bqVersionId] : [])) },
      },
      select: { id: true, versionNo: true },
    });
    const currentId = rows
      .filter((row) => row.status === "approved")
      .sort((a, b) => b.versionNo - a.versionNo)[0]?.id;
    return rows.map((row) => ({
      id: row.id,
      project: projectRef(project.project),
      versionNo: row.versionNo,
      name: row.name,
      status: row.status as BudgetStatus,
      totalMinor: minorOf(row.totalMinor),
      lineCount: row.lineCount,
      bqVersion: versions.find((version) => version.id === row.bqVersionId) ?? null,
      createdBy: personOf(people, row.createdBy),
      createdAt: row.createdAt.toISOString(),
      submittedAt: row.submittedAt?.toISOString() ?? null,
      approvedBy: row.approvedBy ? personOf(people, row.approvedBy) : null,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      current: row.id === currentId,
      version: row.version,
    }));
  }

  private async wireLines(scope: Scope, rows: Prisma.BudgetLineGetPayload<object>[]) {
    const { tx, access } = scope;
    const [items, codes] = await Promise.all([
      bqItemRefs(
        tx,
        access.tenantId,
        rows.map((row) =>
          row.bqVersionId && row.bqItemLineageId
            ? { versionId: row.bqVersionId, lineageId: row.bqItemLineageId }
            : null,
        ),
      ),
      costCodeRefs(
        tx,
        access.tenantId,
        rows.map((row) => row.costCodeId),
      ),
    ]);
    return rows.map((row) => ({
      id: row.id,
      lineNo: row.lineNo,
      bqItem: items.get(itemKey(row.bqVersionId, row.bqItemLineageId) ?? "") ?? null,
      costCode: row.costCodeId ? (codes.get(row.costCodeId) ?? null) : null,
      category: row.category as CostCategory | null,
      description: row.description,
      amountMinor: minorOf(row.amountMinor),
    }));
  }

  private async detailOf(scope: Scope, id: string) {
    const { tx, access } = scope;
    const row = await this.row(scope, id);
    const project = await this.access.on(scope, row.projectId);
    const [summary] = await this.summaries(scope, project, [row]);
    const newer = await tx.budget.findFirst({
      where: {
        tenantId: access.tenantId,
        projectId: row.projectId,
        status: "approved",
        versionNo: { gt: row.versionNo },
      },
      select: { id: true },
    });
    const people = await peopleOf(tx, [row.submittedBy, row.cancelledBy]);
    const byCategory = await tx.budgetLine.groupBy({
      by: ["category"],
      where: { tenantId: access.tenantId, budgetId: id },
      _sum: { amountMinor: true },
      orderBy: { category: "asc" },
    });
    const byItemBill = row.bqVersionId
      ? await tx.$queryRaw<
          {
            lineage_id: string | null;
            number: string | null;
            title: string | null;
            total: bigint;
          }[]
        >`
          SELECT b.lineage_id, b.number, b.title, sum(l.amount_minor)::bigint AS total
            FROM budget_lines l
            LEFT JOIN bq_items i ON i.tenant_id = l.tenant_id AND i.version_id = l.bq_version_id
                                AND i.lineage_id = l.bq_item_lineage_id
            LEFT JOIN bq_bills b ON b.tenant_id = i.tenant_id AND b.id = i.bill_id
           WHERE l.tenant_id = ${access.tenantId}::uuid AND l.budget_id = ${id}::uuid
           GROUP BY b.lineage_id, b.number, b.title, b.sort_order
           ORDER BY b.sort_order NULLS LAST`
      : [];
    const preparer = this.access.can(project, BUDGET_PREPARE_PERMISSIONS);
    const approver = this.access.can(project, APPROVER);
    const contributor = row.contributors.includes(access.userId);
    return budgetDetailResponseSchema.parse({
      budget: {
        ...summary!,
        current: summary!.current && !newer,
        notes: row.notes,
        digest: row.digest,
        submittedBy: row.submittedBy ? personOf(people, row.submittedBy) : null,
        returnReason: row.returnReason,
        cancelledBy: row.cancelledBy ? personOf(people, row.cancelledBy) : null,
        cancelledAt: row.cancelledAt?.toISOString() ?? null,
        cancelReason: row.cancelReason,
      },
      totals: {
        byCategory: byCategory.map((entry) => ({
          category: entry.category as CostCategory | null,
          amountMinor: minorOf(entry._sum.amountMinor ?? 0n),
        })),
        byBill: byItemBill.map((entry) => ({
          bill: entry.lineage_id
            ? { lineageId: entry.lineage_id, number: entry.number!, title: entry.title! }
            : null,
          amountMinor: minorOf(entry.total),
        })),
      },
      permissions: {
        canEdit: preparer && row.status === "draft",
        canSubmit: preparer && row.status === "draft" && row.lineCount > 0,
        canApprove: approver && row.status === "submitted" && !contributor,
        canReturn: approver && row.status === "submitted",
        canCancel: preparer && (row.status === "draft" || row.status === "submitted"),
      },
    });
  }
}
