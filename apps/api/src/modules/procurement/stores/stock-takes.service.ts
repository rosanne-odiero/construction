import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import {
  averageUnitCost,
  countVariance,
  microTimes,
  microToMinor,
  subtractDecimals,
  toMicro,
} from "@pm-buddy/domain";
import type { StockTakeStatus } from "@pm-buddy/types";
import {
  stockTakeResponseSchema,
  stockTakesResponseSchema,
  type CreateStockTakeRequest,
  type ParsedRecordCountsRequest,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../../common/database-errors.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { Scope } from "../../identity/access-policy.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { iso, isoOrNull, materialWire, personOrNull, requestDigest } from "../p2p/p2p-common.js";
import { peopleOf, personOf } from "../procurement-mappers.js";
import { stockDatabaseProblem } from "./movements.service.js";
import { StockLedger } from "./stock-ledger.js";
import {
  dec,
  decOrNull,
  nextStoresNumber,
  STORES_APPROVE,
  STORES_MANAGE,
  StoresAccess,
  storeRefs,
  storesConflict,
  storesInvalidTransition,
  storesProblem,
  storesVersionConflict,
} from "./stores-common.js";

type TakeRow = Prisma.StockTakeGetPayload<object>;

/**
 * Stock takes (D5.3, WORKFLOWS "Stores"). A count sheet snapshots the system quantity of each
 * material when it is started. Stores keep working during the count (no freeze): each count is
 * compared with the system quantity **when that line was counted** (snapshot + movements since,
 * read under the balance lock), so issues and receipts during the count are never mistaken for
 * losses or surpluses. Counts are append-only evidence (offline-ready batches with client IDs and
 * an `Idempotency-Key`); a recount replaces the line's current count. Submission needs every
 * line counted; approval (procurement.approve) by someone who neither created, counted nor
 * submitted it posts each variance as an adjustment entry (surplus at the average cost, shortage
 * leaving at the average).
 */
@Injectable()
export class StockTakesService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: StoresAccess,
    private readonly ledger: StockLedger,
  ) {}

  list(
    principal: Principal,
    query: { storeId?: string; status?: StockTakeStatus; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const projectIds = await this.access.visibleProjectIds(scope);
      const rows = await scope.tx.stockTake.findMany({
        where: {
          tenantId: scope.access.tenantId,
          projectId: { in: projectIds },
          ...(query.storeId ? { storeId: query.storeId } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        orderBy: { id: "desc" },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const wired = await this.wire(scope, page);
      return stockTakesResponseSchema.parse({
        stockTakes: wired.map(({ lines: _lines, ...take }) => take),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
        },
      });
    });
  }

  get(principal: Principal, id: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const row = await this.row(scope, id);
      await this.access.viewer(scope, row.projectId);
      return this.response(scope, row, false);
    });
  }

  create(principal: Principal, input: CreateStockTakeRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const store = await tx.store.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: input.storeId } },
          });
          if (!store) throw new NotFoundException("Store not found");
          await this.access.require(scope, store.projectId, [STORES_MANAGE], { writable: true });
          const open = await tx.stockTake.count({
            where: {
              tenantId: access.tenantId,
              storeId: store.id,
              status: { in: ["draft", "submitted"] },
            },
          });
          if (open)
            throw storesConflict("stock-take-open", "This store already has an open stock take");
          const [balances, levels] = await Promise.all([
            tx.stockBalance.findMany({ where: { tenantId: access.tenantId, storeId: store.id } }),
            tx.stockReorderLevel.findMany({
              where: { tenantId: access.tenantId, storeId: store.id },
            }),
          ]);
          const wanted = input.materialIds?.length
            ? [...new Set(input.materialIds)]
            : [
                ...new Set([
                  ...balances
                    .filter((balance) => /[1-9]/.test(dec(balance.quantity)))
                    .map((b) => b.materialId),
                  ...levels.map((level) => level.materialId),
                ]),
              ];
          if (!wanted.length)
            throw storesConflict("stock-take-empty", "There is nothing to count in this store yet");
          const materials = await tx.material.findMany({
            where: { tenantId: access.tenantId, id: { in: wanted } },
            orderBy: { name: "asc" },
          });
          if (materials.length !== wanted.length) throw new NotFoundException("Material not found");
          const take = await tx.stockTake.create({
            data: {
              tenantId: access.tenantId,
              projectId: store.projectId,
              storeId: store.id,
              number: await nextStoresNumber(tx, access.tenantId, "stockTake"),
              notes: input.notes ?? null,
              contributors: [access.userId],
              lineCount: materials.length,
              createdBy: access.userId,
              updatedBy: access.userId,
            },
          });
          await tx.stockTakeLine.createMany({
            data: materials.map((material, index) => {
              const balance = balances.find((entry) => entry.materialId === material.id);
              return {
                tenantId: access.tenantId,
                stockTakeId: take.id,
                lineNo: index + 1,
                materialId: material.id,
                snapshotQuantity: balance ? dec(balance.quantity) : "0",
                snapshotSeq: balance?.lastSeq ?? 0n,
              };
            }),
          });
          await this.scope.audit(tx, "stock_take.created", take.id, {
            storeId: store.id,
            lines: materials.length,
          });
          return this.response(scope, take, false);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw storesConflict("stock-take-open", "This store already has an open stock take");
        throw error;
      });
  }

  count(
    principal: Principal,
    id: string,
    input: ParsedRecordCountsRequest,
    key: string,
    req: Request,
  ) {
    const digest = requestDigest("stores.stock_take.count", { id, ...input });
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const take = await this.row(scope, id);
          await this.access.require(scope, take.projectId, [STORES_MANAGE], { writable: true });
          const previous = await tx.stockTakeCount.findMany({
            where: { tenantId: access.tenantId, idempotencyKey: key },
            select: { requestDigest: true, stockTakeId: true },
          });
          if (previous.length) {
            if (
              previous.some((entry) => entry.requestDigest !== digest || entry.stockTakeId !== id)
            )
              throw storesConflict(
                "idempotency-key-reused",
                "This idempotency key was used for different counts",
              );
            return this.response(scope, take, true);
          }
          const clash = await tx.stockTakeCount.count({
            where: { tenantId: access.tenantId, id: { in: input.counts.map((entry) => entry.id) } },
          });
          if (clash)
            throw storesConflict(
              "count-id-conflict",
              "A count with this ID was sent with another key",
            );
          if (take.status !== "draft") throw storesInvalidTransition(take.status);
          const lines = await tx.stockTakeLine.findMany({
            where: { tenantId: access.tenantId, stockTakeId: id },
          });
          const byId = new Map(lines.map((line) => [line.id, line]));
          for (const entry of input.counts) {
            const line = byId.get(entry.lineId);
            if (!line)
              throw new BadRequestException({
                code: "line-not-on-stock-take",
                message: "A count names a line that is not on this stock take",
              });
            const position = await this.ledger.position(scope, take.storeId, line.materialId);
            const balance = await tx.stockBalance.findUnique({
              where: {
                tenantId_storeId_materialId: {
                  tenantId: access.tenantId,
                  storeId: take.storeId,
                  materialId: line.materialId,
                },
              },
              select: { lastSeq: true },
            });
            await tx.stockTakeCount.create({
              data: {
                id: entry.id,
                tenantId: access.tenantId,
                stockTakeId: id,
                lineId: line.id,
                countedQuantity: entry.countedQuantity,
                expectedQuantity: position.quantity,
                countedSeq: balance?.lastSeq ?? 0n,
                idempotencyKey: key,
                requestDigest: digest,
                capturedAt: new Date(input.capturedAt),
                countedBy: access.userId,
              },
            });
            await tx.stockTakeLine.update({
              where: { tenantId_id: { tenantId: access.tenantId, id: line.id } },
              data: {
                countedQuantity: entry.countedQuantity,
                expectedQuantity: position.quantity,
                countedSeq: balance?.lastSeq ?? 0n,
                countedBy: access.userId,
                countedAt: new Date(),
                countId: entry.id,
              },
            });
          }
          await tx.stockTake.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data: { updatedBy: access.userId, updatedAt: new Date(), version: { increment: 1 } },
          });
          await this.scope.audit(tx, "stock_take.counted", id, { counts: input.counts.length });
          return this.response(scope, await this.row(scope, id), false);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw storesConflict(
            "count-id-conflict",
            "These counts were recorded by another request",
          );
        throw error;
      });
  }

  submit(principal: Principal, id: string, version: number, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const take = await this.row(scope, id);
        await this.access.require(scope, take.projectId, [STORES_MANAGE], { writable: true });
        if (take.status !== "draft") throw storesInvalidTransition(take.status);
        if (take.version !== version) throw storesVersionConflict();
        const uncounted = await tx.stockTakeLine.count({
          where: { tenantId: access.tenantId, stockTakeId: id, countedQuantity: null },
        });
        if (uncounted)
          throw storesConflict("stock-take-incomplete", `${uncounted} line(s) are not counted yet`);
        await this.transition(scope, take, {
          status: "submitted",
          submittedBy: access.userId,
          submittedAt: new Date(),
          updatedBy: access.userId,
          returnReason: null,
        });
        await this.scope.audit(tx, "stock_take.submitted", id, { lines: take.lineCount });
        return this.response(scope, await this.row(scope, id), false);
      },
      true,
    );
  }

  approve(principal: Principal, id: string, version: number, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const take = await this.row(scope, id);
          await this.access.require(scope, take.projectId, [STORES_APPROVE], { writable: true });
          if (take.status !== "submitted") throw storesInvalidTransition(take.status);
          if (take.version !== version) throw storesVersionConflict();
          if (take.contributors.includes(access.userId))
            throw storesProblem(
              403,
              "maker-checker",
              "Someone who did not create, count or submit this stock take approves it",
            );
          await this.transition(scope, take, {
            status: "approved",
            approvedBy: access.userId,
            approvedAt: new Date(),
          });
          const lines = await tx.stockTakeLine.findMany({
            where: { tenantId: access.tenantId, stockTakeId: id },
            include: { material: true },
            orderBy: { lineNo: "asc" },
          });
          let adjusted = 0;
          for (const line of lines) {
            const variance = countVariance(dec(line.expectedQuantity!), dec(line.countedQuantity!));
            const micro = toMicro(variance);
            if (micro === 0n) continue;
            const target = {
              storeId: take.storeId,
              projectId: take.projectId,
              material: line.material,
            };
            const refs = { stockTakeId: id, stockTakeLineId: line.id };
            if (micro > 0n) {
              const position = await this.ledger.position(scope, take.storeId, line.materialId);
              const cost =
                averageUnitCost(position) ??
                (await this.ledger.lastUnitCost(scope, take.storeId, line.materialId));
              await this.ledger.receive(scope, target, "adjustment", variance, cost, refs);
            } else await this.ledger.remove(scope, target, "adjustment", variance.slice(1), refs);
            adjusted += 1;
          }
          await this.scope.audit(tx, "stock_take.approved", id, { lines: lines.length, adjusted });
          return this.response(scope, await this.row(scope, id), false);
        },
        true,
      )
      .catch((error: unknown) => {
        throw stockDatabaseProblem(error) ?? error;
      });
  }

  returnForRecount(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const take = await this.row(scope, id);
        await this.access.require(scope, take.projectId, [STORES_APPROVE], { writable: true });
        if (take.status !== "submitted") throw storesInvalidTransition(take.status);
        if (take.version !== input.version) throw storesVersionConflict();
        await this.transition(scope, take, {
          status: "draft",
          submittedBy: null,
          submittedAt: null,
          returnReason: input.reason,
        });
        await this.scope.audit(scope.tx, "stock_take.returned", id, { reasonGiven: true });
        return this.response(scope, await this.row(scope, id), false);
      },
      true,
    );
  }

  cancel(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const take = await this.row(scope, id);
        await this.access.require(scope, take.projectId, [STORES_MANAGE, STORES_APPROVE], {
          writable: true,
        });
        if (take.status !== "draft" && take.status !== "submitted")
          throw storesInvalidTransition(take.status);
        if (take.version !== input.version) throw storesVersionConflict();
        await this.transition(scope, take, {
          status: "cancelled",
          cancelledBy: scope.access.userId,
          cancelledAt: new Date(),
          cancelReason: input.reason,
        });
        await this.scope.audit(scope.tx, "stock_take.cancelled", id, { reasonGiven: true });
        return this.response(scope, await this.row(scope, id), false);
      },
      true,
    );
  }

  // Helpers ---------------------------------------------------------------------------------

  async row(scope: Scope, id: string): Promise<TakeRow> {
    const row = await scope.tx.stockTake.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("Stock take not found");
    return row;
  }

  private async transition(
    scope: Scope,
    take: TakeRow,
    data: Prisma.StockTakeUpdateManyMutationInput,
  ) {
    const updated = await scope.tx.stockTake.updateMany({
      where: { tenantId: scope.access.tenantId, id: take.id, version: take.version },
      data: { ...data, version: { increment: 1 }, updatedAt: new Date() },
    });
    if (!updated.count) throw storesVersionConflict();
  }

  async response(scope: Scope, row: TakeRow, replayed: boolean) {
    const project = await this.access.on(scope, row.projectId);
    const [take] = await this.wire(scope, [row]);
    const manage = this.access.can(project, STORES_MANAGE);
    const approve = this.access.can(project, STORES_APPROVE);
    const draft = row.status === "draft";
    const submitted = row.status === "submitted";
    return stockTakeResponseSchema.parse({
      stockTake: take,
      replayed,
      permissions: {
        canCount: manage && draft,
        canSubmit: manage && draft && take!.countedCount === take!.lineCount,
        canApprove: approve && submitted && !row.contributors.includes(scope.access.userId),
        canReturn: approve && submitted,
        canCancel: (manage || approve) && (draft || submitted),
      },
    });
  }

  private async wire(scope: Scope, rows: TakeRow[]) {
    const { tx, access } = scope;
    if (!rows.length) return [];
    const [stores, lines, balances, entries] = await Promise.all([
      storeRefs(
        scope,
        rows.map((row) => row.storeId),
      ),
      tx.stockTakeLine.findMany({
        where: { tenantId: access.tenantId, stockTakeId: { in: rows.map((row) => row.id) } },
        include: { material: true },
        orderBy: { lineNo: "asc" },
      }),
      tx.stockBalance.findMany({
        where: { tenantId: access.tenantId, storeId: { in: rows.map((row) => row.storeId) } },
      }),
      tx.stockLedgerEntry.findMany({
        where: { tenantId: access.tenantId, stockTakeId: { in: rows.map((row) => row.id) } },
        select: { id: true, stockTakeLineId: true, valueMinor: true },
      }),
    ]);
    const people = await peopleOf(tx, [
      ...rows.flatMap((row) => [
        row.createdBy,
        row.submittedBy,
        row.approvedBy,
        row.cancelledBy,
        ...row.contributors,
      ]),
      ...lines.map((line) => line.countedBy),
    ]);
    return rows.map((row) => {
      const mine = lines.filter((line) => line.stockTakeId === row.id);
      const wiredLines = mine.map((line) => {
        const counted = decOrNull(line.countedQuantity);
        const expected = decOrNull(line.expectedQuantity);
        const variance =
          counted !== null && expected !== null ? countVariance(expected, counted) : null;
        const entry = entries.find((candidate) => candidate.stockTakeLineId === line.id);
        let varianceValue: number | null = null;
        if (entry) varianceValue = microToMinor(toMicro(dec(entry.valueMinor)));
        else if (variance !== null) {
          const balance = balances.find(
            (candidate) =>
              candidate.storeId === row.storeId && candidate.materialId === line.materialId,
          );
          const average = balance
            ? averageUnitCost({
                quantity: dec(balance.quantity),
                valueMinor: dec(balance.valueMinor),
              })
            : null;
          varianceValue =
            average === null ? null : microToMinor(microTimes(toMicro(variance), toMicro(average)));
        }
        return {
          id: line.id,
          lineNo: line.lineNo,
          material: materialWire(line.material),
          snapshotQuantity: dec(line.snapshotQuantity),
          countedQuantity: counted,
          expectedQuantity: expected,
          movementsSinceSnapshot:
            expected === null ? null : subtractDecimals(expected, dec(line.snapshotQuantity)),
          varianceQuantity: variance,
          varianceValueMinor: varianceValue,
          countedBy: personOrNull(people, line.countedBy),
          countedAt: isoOrNull(line.countedAt),
          adjustmentEntryId: entry?.id ?? null,
        };
      });
      return {
        id: row.id,
        number: row.number,
        status: row.status as StockTakeStatus,
        store: stores.get(row.storeId),
        notes: row.notes,
        createdAt: iso(row.createdAt),
        createdBy: personOf(people, row.createdBy),
        submittedAt: isoOrNull(row.submittedAt),
        submittedBy: personOrNull(people, row.submittedBy),
        approvedAt: isoOrNull(row.approvedAt),
        approvedBy: personOrNull(people, row.approvedBy),
        returnReason: row.returnReason,
        cancelledAt: isoOrNull(row.cancelledAt),
        cancelledBy: personOrNull(people, row.cancelledBy),
        cancelReason: row.cancelReason,
        contributors: row.contributors.map((id) => personOf(people, id)),
        version: row.version,
        lineCount: row.lineCount,
        countedCount: wiredLines.filter((line) => line.countedQuantity !== null).length,
        varianceCount: wiredLines.filter(
          (line) => line.varianceQuantity !== null && line.varianceQuantity !== "0",
        ).length,
        lines: wiredLines,
      };
    });
  }
}
