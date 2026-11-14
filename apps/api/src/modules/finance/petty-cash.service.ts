import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { nairobiDate, settlementReferenceKey } from "@pm-buddy/domain";
import {
  PETTY_CASH_APPROVE_PERMISSIONS,
  PETTY_CASH_READ_PERMISSIONS,
  type CountStatus,
  type FloatEntryKind,
  type Permission,
  type TopUpMethod,
  type TopUpStatus,
} from "@pm-buddy/types";
import {
  countResponseSchema,
  countsResponseSchema,
  custodiansResponseSchema,
  floatLedgerResponseSchema,
  floatResponseSchema,
  floatsResponseSchema,
  topUpResponseSchema,
  topUpsResponseSchema,
  type PayTopUpRequest,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../common/database-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { effectiveProjectPermissions, grantOf } from "../identity/role-grants.js";
import { customRoleColumns } from "../identity/access-policy.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { nextId } from "../procurement/catalogue-store.js";
import { peopleOf, personOf, toCalendarDate } from "../procurement/procurement-mappers.js";
import {
  makerChecker,
  minorOf,
  nextSpendingNumber,
  projectRef,
  SpendingAccess,
  spendingConflict,
  spendingDatabaseProblem,
  spendingInvalidTransition,
  spendingProblem,
  spendingVersionConflict,
  type ProjectAccess,
  type Tx,
} from "./spending-common.js";

type FloatRow = Prisma.PettyCashFloatGetPayload<object>;
type TopUpRow = Prisma.PettyCashTopUpGetPayload<object>;
type CountRow = Prisma.PettyCashCountGetPayload<object>;
const CUSTODIAN: Permission = "finance.petty_cash";
const MANAGER: Permission = "finance.manage";

/** The company members who hold `permission` on a project (role ∩ assignment). */
export async function holdersOf(
  tx: Tx,
  tenantId: string,
  projectId: string,
  permission: Permission,
) {
  const [members, assignments] = await Promise.all([
    tx.membership.findMany({
      where: { tenantId },
      select: { userId: true, user: { select: { displayName: true } }, ...customRoleColumns },
    }),
    tx.projectMembership.findMany({
      where: { tenantId, projectId },
      select: { userId: true, permissions: true },
    }),
  ]);
  return members
    .filter((member) =>
      effectiveProjectPermissions(
        grantOf(member),
        assignments.find((entry) => entry.userId === member.userId)?.permissions ?? null,
      ).has(permission),
    )
    .map((member) => ({ id: member.userId, displayName: member.user.displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Petty-cash floats, top-ups and cash counts (D5.4, brief §5.8, WORKFLOWS "Petty cash"). One float
 * per site with a custodian (who holds `finance.petty_cash` on the project) and a limit; the book
 * balance moves only through the float's append-only ledger and NEVER GOES BELOW ZERO (the
 * database locks the float row for every entry). Top-ups are requested, approved
 * (`payments.approve`, step-up, not the requester) and recorded as paid (`payments.disburse`,
 * step-up, not the approver); a count is approved or returned by a `finance.manage` or
 * `procurement.approve` holder who neither counted nor holds the float, and an approved
 * variance adjusts the float and posts petty-cash cost.
 */
@Injectable()
export class PettyCashService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: SpendingAccess,
  ) {}

  // Floats ------------------------------------------------------------------------------------

  floats(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const projectIds = await this.access.projectIds(scope, PETTY_CASH_READ_PERMISSIONS);
      const rows = await tx.pettyCashFloat.findMany({
        where: { tenantId: access.tenantId, projectId: { in: projectIds } },
        orderBy: [{ status: "asc" }, { name: "asc" }],
      });
      const sites = await tx.site.findMany({
        where: {
          tenantId: access.tenantId,
          projectId: { in: projectIds },
          id: { notIn: rows.map((row) => row.siteId) },
        },
        include: { project: { select: { id: true, code: true, name: true, status: true } } },
        orderBy: [{ project: { code: "asc" } }, { name: "asc" }],
      });
      const accessOf = await this.accessCache(scope);
      const sitesWithoutFloat = [];
      for (const site of sites)
        sitesWithoutFloat.push({
          project: projectRef(site.project),
          site: { id: site.id, name: site.name },
          canCreate: this.access.can(await accessOf(site.projectId), [MANAGER]),
        });
      return floatsResponseSchema.parse({
        floats: await this.floatSummaries(scope, rows),
        sitesWithoutFloat,
      });
    });
  }

  float(principal: Principal, id: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const row = await this.floatRow(scope, id);
      const project = await this.access.pettyCashReader(scope, row.projectId);
      return this.floatResponse(scope, row, project);
    });
  }

  custodians(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.require(scope, projectId, [MANAGER]);
      return custodiansResponseSchema.parse({
        people: await holdersOf(scope.tx, scope.access.tenantId, projectId, CUSTODIAN),
      });
    });
  }

  createFloat(
    principal: Principal,
    input: { siteId: string; name: string; custodianUserId: string; limitMinor: number },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const site = await tx.site.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: input.siteId } },
          });
          if (!site) throw new NotFoundException("Site not found");
          await this.access.require(scope, site.projectId, [MANAGER], { writable: true });
          await this.eligibleCustodian(scope, site.projectId, input.custodianUserId);
          const id = nextId();
          const row = await tx.pettyCashFloat.create({
            data: {
              id,
              tenantId: access.tenantId,
              projectId: site.projectId,
              siteId: site.id,
              name: input.name,
              custodianUserId: input.custodianUserId,
              limitMinor: BigInt(input.limitMinor),
              createdBy: access.userId,
              updatedBy: access.userId,
            },
          });
          await this.scope.audit(tx, "petty_cash.float_created", id, {
            projectId: site.projectId,
            siteId: site.id,
          });
          return this.floatResponse(scope, row, await this.access.on(scope, site.projectId));
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw spendingConflict("float-exists", "This site already has a petty-cash float");
        throw error;
      });
  }

  updateFloat(
    principal: Principal,
    id: string,
    input: {
      version: number;
      name?: string;
      custodianUserId?: string;
      limitMinor?: number;
      close?: true;
    },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.floatRow(scope, id);
        const project = await this.access.require(scope, row.projectId, [MANAGER], {
          writable: true,
        });
        if (row.status !== "active") throw spendingConflict("float-closed", "This float is closed");
        if (row.version !== input.version) throw spendingVersionConflict();
        const changesCustodian =
          input.custodianUserId !== undefined && input.custodianUserId !== row.custodianUserId;
        if (changesCustodian) {
          await this.eligibleCustodian(scope, row.projectId, input.custodianUserId!);
          await this.assertCountedHandover(scope, row);
        }
        if (input.close) {
          if (row.balanceMinor !== 0n)
            throw spendingConflict("float-not-empty", "Count and empty the float before closing");
          if ((await this.openItems(scope, row.id)) > 0)
            throw spendingConflict(
              "float-has-open-items",
              "Decide its expenses, top-ups and counts first",
            );
        }
        const updated = await tx.pettyCashFloat.update({
          where: { tenantId_id: { tenantId: access.tenantId, id } },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(changesCustodian ? { custodianUserId: input.custodianUserId } : {}),
            ...(input.limitMinor !== undefined ? { limitMinor: BigInt(input.limitMinor) } : {}),
            ...(input.close ? { status: "closed" } : {}),
            updatedBy: access.userId,
            updatedAt: new Date(),
            version: { increment: 1 },
          },
        });
        await this.scope.audit(
          tx,
          input.close ? "petty_cash.float_closed" : "petty_cash.float_updated",
          id,
          {
            fields: Object.keys(input)
              .filter((key) => key !== "version")
              .sort(),
            custodianChanged: changesCustodian,
          },
        );
        return this.floatResponse(scope, updated, project);
      },
      true,
    );
  }

  ledger(
    principal: Principal,
    id: string,
    query: { cursor?: number; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const row = await this.floatRow(scope, id);
      await this.access.pettyCashReader(scope, row.projectId);
      const rows = await tx.pettyCashEntry.findMany({
        where: {
          tenantId: access.tenantId,
          floatId: id,
          ...(query.cursor ? { seq: { lt: BigInt(query.cursor) } } : {}),
        },
        orderBy: { seq: "desc" },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const [people, topUps, expenses, counts] = await Promise.all([
        peopleOf(
          tx,
          page.map((entry) => entry.recordedBy),
        ),
        tx.pettyCashTopUp.findMany({
          where: {
            tenantId: access.tenantId,
            id: { in: page.flatMap((entry) => (entry.topUpId ? [entry.topUpId] : [])) },
          },
          select: { id: true, number: true },
        }),
        tx.pettyCashExpense.findMany({
          where: {
            tenantId: access.tenantId,
            id: { in: page.flatMap((entry) => (entry.expenseId ? [entry.expenseId] : [])) },
          },
          select: { id: true, number: true },
        }),
        tx.pettyCashCount.findMany({
          where: {
            tenantId: access.tenantId,
            id: { in: page.flatMap((entry) => (entry.countId ? [entry.countId] : [])) },
          },
          select: { id: true, number: true },
        }),
      ]);
      const document = (entry: (typeof page)[number]) => {
        if (entry.topUpId)
          return {
            kind: "top_up" as const,
            id: entry.topUpId,
            number: topUps.find((row) => row.id === entry.topUpId)?.number ?? "—",
          };
        if (entry.expenseId)
          return {
            kind: "expense" as const,
            id: entry.expenseId,
            number: expenses.find((row) => row.id === entry.expenseId)?.number ?? "—",
          };
        return {
          kind: "count" as const,
          id: entry.countId!,
          number: counts.find((row) => row.id === entry.countId)?.number ?? "—",
        };
      };
      return floatLedgerResponseSchema.parse({
        entries: page.map((entry) => ({
          id: entry.id,
          seq: Number(entry.seq),
          kind: entry.kind as FloatEntryKind,
          amountMinor: minorOf(entry.amountMinor),
          balanceMinor: minorOf(entry.balanceMinor),
          document: document(entry),
          recordedBy: personOf(people, entry.recordedBy),
          recordedAt: entry.recordedAt.toISOString(),
          businessDate: toCalendarDate(entry.businessDate),
        })),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? String(page.at(-1)!.seq) : null,
        },
      });
    });
  }

  // Top-ups -----------------------------------------------------------------------------------

  topUps(
    principal: Principal,
    query: { floatId?: string; status?: TopUpStatus; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const projectIds = await this.access.projectIds(scope, PETTY_CASH_READ_PERMISSIONS);
      const after = query.cursor
        ? await tx.pettyCashTopUp.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: query.cursor } },
            select: { id: true, requestedAt: true },
          })
        : null;
      const rows = await tx.pettyCashTopUp.findMany({
        where: {
          tenantId: access.tenantId,
          projectId: { in: projectIds },
          ...(query.floatId ? { floatId: query.floatId } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(after
            ? {
                OR: [
                  { requestedAt: { lt: after.requestedAt } },
                  { requestedAt: after.requestedAt, id: { lt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      return topUpsResponseSchema.parse({
        topUps: await this.wireTopUps(scope, page),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
        },
      });
    });
  }

  requestTopUp(
    principal: Principal,
    input: { floatId: string; amountMinor: number; reason: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const float = await this.floatRow(scope, input.floatId);
        const project = await this.access.pettyCashReader(scope, float.projectId);
        this.access.writable(project);
        if (float.status !== "active")
          throw spendingConflict("float-closed", "This float is closed");
        if (!this.mayOperate(project, float, access.userId))
          throw new ForbiddenException("Only the custodian or finance can ask for a top-up");
        if (BigInt(input.amountMinor) + float.balanceMinor > float.limitMinor)
          throw spendingConflict(
            "float-limit-exceeded",
            "This top-up would take the float above its limit",
          );
        const id = nextId();
        await tx.pettyCashTopUp.create({
          data: {
            id,
            tenantId: access.tenantId,
            projectId: float.projectId,
            floatId: float.id,
            number: await nextSpendingNumber(tx, access.tenantId, "topUp"),
            amountMinor: BigInt(input.amountMinor),
            reason: input.reason,
            requestedBy: access.userId,
          },
        });
        await this.scope.audit(tx, "petty_cash.top_up_requested", id, { floatId: float.id });
        return this.topUpResponse(scope, id);
      },
      true,
    );
  }

  decideTopUp(
    principal: Principal,
    id: string,
    action: "approve" | "reject" | "cancel",
    input: { version: number; reason?: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.topUpRow(scope, id);
        const project =
          action === "cancel"
            ? await this.access.pettyCashReader(scope, row.projectId)
            : await this.access.require(scope, row.projectId, ["payments.approve"], {
                stepUp: action === "approve",
              });
        this.access.writable(project);
        if (row.version !== input.version) throw spendingVersionConflict();
        const allowed: TopUpStatus[] =
          action === "cancel" ? ["requested", "approved"] : ["requested"];
        if (!allowed.includes(row.status as TopUpStatus))
          throw spendingInvalidTransition(row.status);
        if (action !== "cancel" && row.requestedBy === access.userId)
          throw makerChecker("The requester of a top-up cannot decide it");
        if (
          action === "cancel" &&
          row.requestedBy !== access.userId &&
          !this.access.holds(project, [MANAGER])
        )
          throw new ForbiddenException("Only the requester or finance can cancel a top-up");
        const decided = { decidedBy: access.userId, decidedAt: new Date() };
        await tx.pettyCashTopUp.update({
          where: { tenantId_id: { tenantId: access.tenantId, id } },
          data: {
            ...(action === "approve"
              ? { status: "approved", ...decided }
              : action === "reject"
                ? { status: "rejected", ...decided, decisionReason: input.reason }
                : {
                    status: "cancelled",
                    cancelledBy: access.userId,
                    cancelledAt: new Date(),
                    cancelReason: input.reason,
                  }),
            version: { increment: 1 },
          },
        });
        await this.scope.audit(
          tx,
          `petty_cash.top_up_${action === "approve" ? "approved" : action === "reject" ? "rejected" : "cancelled"}`,
          id,
          {
            floatId: row.floatId,
            ...(action === "approve" ? {} : { reasonGiven: true }),
          },
        );
        return this.topUpResponse(scope, id);
      },
      true,
    );
  }

  /** Records that an approved top-up was paid (outside PM-Buddy); the float's balance rises. */
  payTopUp(principal: Principal, id: string, input: PayTopUpRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.topUpRow(scope, id);
          await this.access.require(scope, row.projectId, ["payments.disburse"], {
            stepUp: true,
            writable: true,
          });
          if (row.status !== "approved") throw spendingInvalidTransition(row.status);
          if (row.version !== input.version) throw spendingVersionConflict();
          if (row.decidedBy === access.userId)
            throw makerChecker("The approver of a top-up cannot record its payment");
          const requestedOn = nairobiDate(row.requestedAt);
          if (input.paidOn > nairobiDate() || input.paidOn < requestedOn)
            throw spendingProblem(
              400,
              "top-up-date-invalid",
              "The payment date is between the request and today",
            );
          await tx.pettyCashTopUp.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data: {
              status: "paid",
              paidBy: access.userId,
              paidAt: new Date(),
              paidOn: new Date(`${input.paidOn}T00:00:00.000Z`),
              method: input.method,
              reference: input.reference,
              referenceKey: settlementReferenceKey(input.reference),
              version: { increment: 1 },
            },
          });
          await tx.pettyCashEntry.create({
            data: {
              id: nextId(),
              tenantId: access.tenantId,
              floatId: row.floatId,
              seq: 0n,
              kind: "top_up",
              amountMinor: row.amountMinor,
              balanceMinor: 0n,
              topUpId: id,
              recordedBy: access.userId,
              businessDate: new Date(),
            },
          });
          // The reference and the amount stay out of the audit log.
          await this.scope.audit(tx, "petty_cash.top_up_paid", id, {
            floatId: row.floatId,
            method: input.method,
          });
          return this.topUpResponse(scope, id);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw spendingConflict(
            "top-up-reference-taken",
            "This payment reference was already used",
          );
        throw spendingDatabaseProblem(error) ?? error;
      });
  }

  // Counts ------------------------------------------------------------------------------------

  counts(
    principal: Principal,
    query: { floatId?: string; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const projectIds = await this.access.projectIds(scope, PETTY_CASH_READ_PERMISSIONS);
      const after = query.cursor
        ? await tx.pettyCashCount.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: query.cursor } },
            select: { id: true, countedAt: true },
          })
        : null;
      const rows = await tx.pettyCashCount.findMany({
        where: {
          tenantId: access.tenantId,
          projectId: { in: projectIds },
          ...(query.floatId ? { floatId: query.floatId } : {}),
          ...(after
            ? {
                OR: [
                  { countedAt: { lt: after.countedAt } },
                  { countedAt: after.countedAt, id: { lt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ countedAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      return countsResponseSchema.parse({
        counts: await this.wireCounts(scope, page),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
        },
      });
    });
  }

  recordCount(
    principal: Principal,
    input: { floatId: string; countedMinor: number; note?: string | null },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          // Lock the float so the book balance cannot move while the count is recorded.
          await tx.$queryRaw`SELECT id FROM petty_cash_floats
            WHERE tenant_id = ${access.tenantId}::uuid AND id = ${input.floatId}::uuid FOR UPDATE`;
          const float = await this.floatRow(scope, input.floatId);
          const project = await this.access.pettyCashReader(scope, float.projectId);
          this.access.writable(project);
          if (float.status !== "active")
            throw spendingConflict("float-closed", "This float is closed");
          if (!this.mayOperate(project, float, access.userId))
            throw new ForbiddenException("Only the custodian or finance can count the float");
          const open = await tx.pettyCashCount.count({
            where: { tenantId: access.tenantId, floatId: float.id, status: "submitted" },
          });
          if (open) throw spendingConflict("count-open", "A count of this float awaits a decision");
          const id = nextId();
          await tx.pettyCashCount.create({
            data: {
              id,
              tenantId: access.tenantId,
              projectId: float.projectId,
              floatId: float.id,
              number: await nextSpendingNumber(tx, access.tenantId, "count"),
              countedMinor: BigInt(input.countedMinor),
              bookMinor: float.balanceMinor,
              bookSeq: float.lastSeq,
              varianceMinor: BigInt(input.countedMinor) - float.balanceMinor,
              note: input.note ?? null,
              countedBy: access.userId,
            },
          });
          await this.scope.audit(tx, "petty_cash.counted", id, { floatId: float.id });
          return countResponseSchema.parse({
            count: (await this.wireCounts(scope, [await this.countRow(scope, id)]))[0],
          });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw spendingConflict("count-open", "A count of this float awaits a decision");
        throw error;
      });
  }

  decideCount(
    principal: Principal,
    id: string,
    action: "approve" | "return",
    input: { version: number; reason?: string },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.countRow(scope, id);
          await this.access.require(scope, row.projectId, PETTY_CASH_APPROVE_PERMISSIONS, {
            writable: true,
          });
          if (row.status !== "submitted") throw spendingInvalidTransition(row.status);
          if (row.version !== input.version) throw spendingVersionConflict();
          const float = await this.floatRow(scope, row.floatId);
          if (access.userId === row.countedBy || access.userId === float.custodianUserId)
            throw makerChecker(
              "A count is decided by someone who neither counted nor holds the float",
            );
          await tx.pettyCashCount.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data: {
              status: action === "approve" ? "approved" : "returned",
              decidedBy: access.userId,
              decidedAt: new Date(),
              decisionReason: action === "return" ? input.reason : null,
              version: { increment: 1 },
            },
          });
          if (action === "approve" && row.varianceMinor !== 0n) {
            await tx.pettyCashEntry.create({
              data: {
                id: nextId(),
                tenantId: access.tenantId,
                floatId: row.floatId,
                seq: 0n,
                kind: "count_adjustment",
                amountMinor: row.varianceMinor,
                balanceMinor: 0n,
                countId: id,
                recordedBy: access.userId,
                businessDate: new Date(),
              },
            });
            for (const [purpose, measure] of [
              ["variance_accrual", "accrued"],
              ["variance_payment", "paid"],
            ] as const)
              await tx.costEntry.create({
                data: {
                  id: nextId(),
                  tenantId: access.tenantId,
                  projectId: row.projectId,
                  siteId: float.siteId,
                  measure,
                  category: "petty_cash",
                  counterpartyKind: "none",
                  amountMinor: -row.varianceMinor,
                  occurredOn: new Date(`${nairobiDate(row.countedAt)}T00:00:00.000Z`),
                  source: "petty_cash_count",
                  purpose,
                  floatCountId: id,
                  recordedBy: access.userId,
                  businessDate: new Date(),
                },
              });
          }
          await this.scope.audit(
            tx,
            action === "approve" ? "petty_cash.count_approved" : "petty_cash.count_returned",
            id,
            {
              floatId: row.floatId,
              variance:
                row.varianceMinor === 0n ? "none" : row.varianceMinor < 0n ? "short" : "over",
              ...(action === "return" ? { reasonGiven: true } : {}),
            },
          );
          return countResponseSchema.parse({
            count: (await this.wireCounts(scope, [await this.countRow(scope, id)]))[0],
          });
        },
        true,
      )
      .catch((error: unknown) => {
        throw spendingDatabaseProblem(error) ?? error;
      });
  }

  // Helpers -----------------------------------------------------------------------------------

  /** The custodian (holding finance.petty_cash) or a finance manager may operate the float. */
  mayOperate(project: ProjectAccess, float: FloatRow, userId: string): boolean {
    return (
      (float.custodianUserId === userId && project.permissions.has(CUSTODIAN)) ||
      project.permissions.has(MANAGER)
    );
  }

  private async eligibleCustodian(scope: Scope, projectId: string, userId: string) {
    const holders = await holdersOf(scope.tx, scope.access.tenantId, projectId, CUSTODIAN);
    if (!holders.some((holder) => holder.id === userId))
      throw spendingProblem(
        422,
        "custodian-not-eligible",
        "The custodian must hold the petty-cash permission on this project",
      );
  }

  /**
   * A float changes hands only after an approved count with nothing moved since (or when it is
   * empty), so the new custodian takes over a counted balance.
   */
  private async assertCountedHandover(scope: Scope, row: FloatRow) {
    if (row.balanceMinor === 0n) return;
    const { tx, access } = scope;
    const counted = await tx.pettyCashCount.findFirst({
      where: { tenantId: access.tenantId, floatId: row.id, status: "approved" },
      orderBy: { decidedAt: "desc" },
    });
    const since = counted
      ? await tx.pettyCashEntry.count({
          where: {
            tenantId: access.tenantId,
            floatId: row.id,
            seq: { gt: counted.bookSeq },
            NOT: { countId: counted.id },
          },
        })
      : 1;
    if (since > 0)
      throw spendingConflict(
        "handover-needs-count",
        "Count the float and have the count approved before handing it over",
      );
  }

  private async openItems(scope: Scope, floatId: string) {
    const { tx, access } = scope;
    const [expenses, topUps, counts] = await Promise.all([
      tx.pettyCashExpense.count({
        where: { tenantId: access.tenantId, floatId, status: "submitted" },
      }),
      tx.pettyCashTopUp.count({
        where: { tenantId: access.tenantId, floatId, status: { in: ["requested", "approved"] } },
      }),
      tx.pettyCashCount.count({
        where: { tenantId: access.tenantId, floatId, status: "submitted" },
      }),
    ]);
    return expenses + topUps + counts;
  }

  async floatRow(scope: Scope, id: string): Promise<FloatRow> {
    const row = await scope.tx.pettyCashFloat.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("Float not found");
    return row;
  }

  private async topUpRow(scope: Scope, id: string): Promise<TopUpRow> {
    const row = await scope.tx.pettyCashTopUp.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("Top-up not found");
    return row;
  }

  private async countRow(scope: Scope, id: string): Promise<CountRow> {
    const row = await scope.tx.pettyCashCount.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("Count not found");
    return row;
  }

  private async accessCache(scope: Scope) {
    const cache = new Map<string, ProjectAccess>();
    return async (projectId: string) => {
      if (!cache.has(projectId)) cache.set(projectId, await this.access.on(scope, projectId));
      return cache.get(projectId)!;
    };
  }

  async floatSummaries(scope: Scope, rows: FloatRow[]) {
    const { tx, access } = scope;
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const [projects, sites, people, expenses, topUps, openCounts, approved] = await Promise.all([
      tx.project.findMany({
        where: { tenantId: access.tenantId, id: { in: rows.map((row) => row.projectId) } },
        select: { id: true, code: true, name: true },
      }),
      tx.site.findMany({
        where: { tenantId: access.tenantId, id: { in: rows.map((row) => row.siteId) } },
        select: { id: true, name: true },
      }),
      peopleOf(
        tx,
        rows.map((row) => row.custodianUserId),
      ),
      tx.pettyCashExpense.groupBy({
        by: ["floatId"],
        where: { tenantId: access.tenantId, floatId: { in: ids }, status: "submitted" },
        _count: true,
      }),
      tx.pettyCashTopUp.groupBy({
        by: ["floatId"],
        where: {
          tenantId: access.tenantId,
          floatId: { in: ids },
          status: { in: ["requested", "approved"] },
        },
        _count: true,
      }),
      tx.pettyCashCount.findMany({
        where: { tenantId: access.tenantId, floatId: { in: ids }, status: "submitted" },
        select: { floatId: true },
      }),
      tx.pettyCashCount.findMany({
        where: { tenantId: access.tenantId, floatId: { in: ids }, status: "approved" },
        orderBy: { decidedAt: "desc" },
        select: { floatId: true, number: true, countedAt: true, varianceMinor: true },
      }),
    ]);
    return rows.map((row) => {
      const last = approved.find((count) => count.floatId === row.id);
      return {
        id: row.id,
        name: row.name,
        project: projectRef(projects.find((project) => project.id === row.projectId)!),
        site: sites.find((site) => site.id === row.siteId)!,
        custodian: personOf(people, row.custodianUserId),
        limitMinor: minorOf(row.limitMinor),
        balanceMinor: minorOf(row.balanceMinor),
        status: row.status as "active" | "closed",
        lastEntryAt: row.lastEntryAt?.toISOString() ?? null,
        submittedExpenses: expenses.find((entry) => entry.floatId === row.id)?._count ?? 0,
        openTopUps: topUps.find((entry) => entry.floatId === row.id)?._count ?? 0,
        openCount: openCounts.some((count) => count.floatId === row.id),
        lastApprovedCount: last
          ? {
              number: last.number,
              countedAt: last.countedAt.toISOString(),
              varianceMinor: minorOf(last.varianceMinor),
            }
          : null,
        version: row.version,
      };
    });
  }

  private async floatResponse(scope: Scope, row: FloatRow, project: ProjectAccess) {
    const [summary] = await this.floatSummaries(scope, [row]);
    const active = row.status === "active" && this.access.isWritable(project);
    const operator = this.mayOperate(project, row, scope.access.userId);
    return floatResponseSchema.parse({
      float: summary,
      permissions: {
        canRecordExpense:
          active &&
          row.custodianUserId === scope.access.userId &&
          project.permissions.has(CUSTODIAN),
        canRequestTopUp: active && operator,
        canCount: active && operator && !summary!.openCount,
        canEdit: active && project.permissions.has(MANAGER),
      },
    });
  }

  private async topUpResponse(scope: Scope, id: string) {
    const [topUp] = await this.wireTopUps(scope, [await this.topUpRow(scope, id)]);
    return topUpResponseSchema.parse({ topUp });
  }

  private async wireTopUps(scope: Scope, rows: TopUpRow[]) {
    const { tx, access } = scope;
    if (!rows.length) return [];
    const [floats, projects, people] = await Promise.all([
      tx.pettyCashFloat.findMany({
        where: { tenantId: access.tenantId, id: { in: rows.map((row) => row.floatId) } },
        select: { id: true, name: true },
      }),
      tx.project.findMany({
        where: { tenantId: access.tenantId, id: { in: rows.map((row) => row.projectId) } },
        select: { id: true, code: true, name: true },
      }),
      peopleOf(
        tx,
        rows.flatMap((row) => [row.requestedBy, row.decidedBy, row.paidBy, row.cancelledBy]),
      ),
    ]);
    const accessOf = await this.accessCache(scope);
    const wired = [];
    for (const row of rows) {
      const project = await accessOf(row.projectId);
      const me = access.userId;
      const status = row.status as TopUpStatus;
      wired.push({
        id: row.id,
        number: row.number,
        float: floats.find((float) => float.id === row.floatId)!,
        project: projectRef(projects.find((entry) => entry.id === row.projectId)!),
        amountMinor: minorOf(row.amountMinor),
        reason: row.reason,
        status,
        requestedBy: personOf(people, row.requestedBy),
        requestedAt: row.requestedAt.toISOString(),
        decidedBy: row.decidedBy ? personOf(people, row.decidedBy) : null,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        decisionReason: row.decisionReason,
        paidBy: row.paidBy ? personOf(people, row.paidBy) : null,
        paidAt: row.paidAt?.toISOString() ?? null,
        paidOn: row.paidOn ? toCalendarDate(row.paidOn) : null,
        method: row.method as TopUpMethod | null,
        reference: row.reference,
        cancelledBy: row.cancelledBy ? personOf(people, row.cancelledBy) : null,
        cancelReason: row.cancelReason,
        version: row.version,
        permissions: {
          canApprove:
            this.access.can(project, ["payments.approve"]) &&
            status === "requested" &&
            row.requestedBy !== me,
          canReject:
            this.access.can(project, ["payments.approve"]) &&
            status === "requested" &&
            row.requestedBy !== me,
          canPay:
            this.access.can(project, ["payments.disburse"]) &&
            status === "approved" &&
            row.decidedBy !== me,
          canCancel:
            this.access.isWritable(project) &&
            (status === "requested" || status === "approved") &&
            (row.requestedBy === me || project.permissions.has(MANAGER)),
        },
      });
    }
    return wired;
  }

  private async wireCounts(scope: Scope, rows: CountRow[]) {
    const { tx, access } = scope;
    if (!rows.length) return [];
    const [floats, projects, people] = await Promise.all([
      tx.pettyCashFloat.findMany({
        where: { tenantId: access.tenantId, id: { in: rows.map((row) => row.floatId) } },
        select: { id: true, name: true, custodianUserId: true },
      }),
      tx.project.findMany({
        where: { tenantId: access.tenantId, id: { in: rows.map((row) => row.projectId) } },
        select: { id: true, code: true, name: true },
      }),
      peopleOf(
        tx,
        rows.flatMap((row) => [row.countedBy, row.decidedBy]),
      ),
    ]);
    const accessOf = await this.accessCache(scope);
    const wired = [];
    for (const row of rows) {
      const float = floats.find((entry) => entry.id === row.floatId)!;
      const project = await accessOf(row.projectId);
      const independent =
        access.userId !== row.countedBy && access.userId !== float.custodianUserId;
      const decider =
        this.access.canApprovePettyCash(project) && row.status === "submitted" && independent;
      wired.push({
        id: row.id,
        number: row.number,
        float: { id: float.id, name: float.name },
        project: projectRef(projects.find((entry) => entry.id === row.projectId)!),
        countedMinor: minorOf(row.countedMinor),
        bookMinor: minorOf(row.bookMinor),
        varianceMinor: minorOf(row.varianceMinor),
        note: row.note,
        status: row.status as CountStatus,
        countedBy: personOf(people, row.countedBy),
        countedAt: row.countedAt.toISOString(),
        decidedBy: row.decidedBy ? personOf(people, row.decidedBy) : null,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        decisionReason: row.decisionReason,
        version: row.version,
        permissions: { canApprove: decider, canReturn: decider },
      });
    }
    return wired;
  }
}
