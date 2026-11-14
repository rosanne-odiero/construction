import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Request } from "express";
import {
  microTimes,
  microToMinor,
  nairobiDate,
  subtractDecimals,
  takeFromStock,
  toMicro,
} from "@pm-buddy/domain";
import type { StoreSource, TransferStatus } from "@pm-buddy/types";
import {
  transferResponseSchema,
  transfersResponseSchema,
  type ParsedDispatchTransferRequest,
  type ParsedReceiveTransferRequest,
  type TransferDecisionRequest,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../../common/database-errors.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { Scope } from "../../identity/access-policy.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { assertUsableUnit } from "../catalogue.service.js";
import { CatalogueStore, nextId } from "../catalogue-store.js";
import {
  iso,
  isoOrNull,
  materialWire,
  personOrNull,
  requestDigest,
  toBaseQuantity,
} from "../p2p/p2p-common.js";
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

type TransferRow = Prisma.StockTransferGetPayload<object>;

/**
 * Inter-site transfers (D5.3, WORKFLOWS "Stores"): dispatch takes the stock out of the source store
 * at its weighted average cost (in transit until received); receipt records what arrived per line
 * in the base unit (a difference needs a reason and makes the transfer disputed; the shortfall is
 * a transit loss, never silently booked into the destination); a dispute is resolved with a note by
 * an approver who neither sent nor received it; a transfer still in transit can be cancelled,
 * which puts the stock back at the value it left with. Dispatch and receipt are offline-ready
 * (client ID / `Idempotency-Key`; replays return the original).
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: StoresAccess,
    private readonly catalogue: CatalogueStore,
    private readonly ledger: StockLedger,
  ) {}

  list(
    principal: Principal,
    query: { storeId?: string; status?: TransferStatus; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const projectIds = await this.access.visibleProjectIds(scope);
      // Client-chosen IDs are not time-ordered: page by (dispatched at, id), newest first.
      const after = query.cursor
        ? await scope.tx.stockTransfer.findUnique({
            where: { tenantId_id: { tenantId: scope.access.tenantId, id: query.cursor } },
            select: { id: true, dispatchedAt: true },
          })
        : null;
      const rows = await scope.tx.stockTransfer.findMany({
        where: {
          tenantId: scope.access.tenantId,
          AND: [
            { OR: [{ fromProjectId: { in: projectIds } }, { toProjectId: { in: projectIds } }] },
            ...(query.storeId
              ? [{ OR: [{ fromStoreId: query.storeId }, { toStoreId: query.storeId }] }]
              : []),
            ...(after
              ? [
                  {
                    OR: [
                      { dispatchedAt: { lt: after.dispatchedAt } },
                      { dispatchedAt: after.dispatchedAt, id: { lt: after.id } },
                    ],
                  },
                ]
              : []),
          ],
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: [{ dispatchedAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const wired = await this.wire(scope, page);
      return transfersResponseSchema.parse({
        transfers: wired.map(({ lines: _lines, ...transfer }) => transfer),
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
      await this.viewer(scope, row);
      return this.response(scope, row, false);
    });
  }

  dispatch(principal: Principal, input: ParsedDispatchTransferRequest, key: string, req: Request) {
    const digest = requestDigest("stores.transfer", input);
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const replay = await tx.stockTransfer.findUnique({
            where: { tenantId_idempotencyKey: { tenantId: access.tenantId, idempotencyKey: key } },
          });
          if (replay) {
            if (replay.requestDigest !== digest || replay.id !== input.id)
              throw storesConflict(
                "idempotency-key-reused",
                "This idempotency key was used for a different transfer",
              );
            await this.viewer(scope, replay);
            return this.response(scope, replay, true);
          }
          if (
            await tx.stockTransfer.findUnique({
              where: { tenantId_id: { tenantId: access.tenantId, id: input.id } },
            })
          )
            throw storesConflict(
              "transfer-id-conflict",
              "A transfer with this ID was sent with another key",
            );
          const from = await this.store(scope, input.fromStoreId);
          const to = await this.store(scope, input.toStoreId);
          await this.access.require(scope, from.projectId, [STORES_MANAGE], { writable: true });
          await this.access.viewer(scope, to.projectId);
          const destination = await this.access.on(scope, to.projectId);
          this.access.writable(destination);
          const materials = await tx.material.findMany({
            where: {
              tenantId: access.tenantId,
              id: { in: input.lines.map((line) => line.materialId) },
            },
          });
          const units = await this.catalogue.customUnits(scope);
          const lines = [];
          for (const [index, line] of input.lines.entries()) {
            const material = materials.find((entry) => entry.id === line.materialId);
            if (!material) throw new NotFoundException("Material not found");
            assertUsableUnit(line.unit, units);
            const converted = await toBaseQuantity(
              this.catalogue,
              scope,
              material,
              null,
              nairobiDate(),
              line.quantity,
              line.unit,
              units,
            );
            if (!/[1-9]/.test(converted.baseQuantity))
              throw storesProblem(
                422,
                "invalid-quantity",
                "The quantity rounds to zero in the base unit",
              );
            const position = await this.ledger.position(scope, from.id, material.id);
            const outflow = takeFromStock(position, converted.baseQuantity);
            if (!outflow.ok)
              throw storesConflict(
                "insufficient-stock",
                `Only ${outflow.available} ${material.baseUnit} of ${material.name} is in this store`,
              );
            lines.push({
              row: {
                id: nextId(),
                tenantId: access.tenantId,
                transferId: input.id,
                lineNo: index + 1,
                materialId: material.id,
                quantity: line.quantity,
                unit: line.unit,
                baseQuantity: converted.baseQuantity,
                conversion: JSON.parse(
                  JSON.stringify({ ratio: converted.ratio, steps: converted.steps }),
                ) as Prisma.InputJsonValue,
                unitCostMinor: outflow.unitCostMinor,
                dispatchedValueMinor: outflow.valueMinor,
              },
              material,
            });
          }
          const transfer = await tx.stockTransfer.create({
            data: {
              id: input.id,
              tenantId: access.tenantId,
              number: await nextStoresNumber(tx, access.tenantId, "transfer"),
              fromProjectId: from.projectId,
              fromStoreId: from.id,
              toProjectId: to.projectId,
              toStoreId: to.id,
              source: input.source,
              idempotencyKey: key,
              requestDigest: digest,
              capturedAt: new Date(input.capturedAt),
              dispatchedBy: access.userId,
              dispatchNotes: input.notes ?? null,
              lineCount: lines.length,
            },
          });
          await tx.stockTransferLine.createMany({ data: lines.map((line) => line.row) });
          for (const line of lines)
            await this.ledger.remove(
              scope,
              { storeId: from.id, projectId: from.projectId, material: line.material },
              "transfer_out",
              line.row.baseQuantity,
              { transferId: transfer.id, transferLineId: line.row.id },
            );
          await this.scope.audit(tx, "stock.transfer_dispatched", transfer.id, {
            fromStoreId: from.id,
            toStoreId: to.id,
            lines: lines.length,
            source: input.source,
          });
          return this.response(scope, transfer, false);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw storesConflict(
            "transfer-id-conflict",
            "This transfer was recorded by another request",
          );
        throw stockDatabaseProblem(error) ?? error;
      });
  }

  receive(
    principal: Principal,
    id: string,
    input: ParsedReceiveTransferRequest,
    key: string,
    req: Request,
  ) {
    const digest = requestDigest("stores.transfer.receive", { id, ...input });
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.row(scope, id);
          await this.access.require(scope, row.toProjectId, [STORES_MANAGE], { writable: true });
          if (row.receiveIdempotencyKey === key) {
            if (row.receiveDigest !== digest)
              throw storesConflict(
                "idempotency-key-reused",
                "This idempotency key was used for a different receipt",
              );
            return this.response(scope, row, true);
          }
          const other = await tx.stockTransfer.findUnique({
            where: {
              tenantId_receiveIdempotencyKey: {
                tenantId: access.tenantId,
                receiveIdempotencyKey: key,
              },
            },
          });
          if (other)
            throw storesConflict(
              "idempotency-key-reused",
              "This idempotency key was used for another receipt",
            );
          if (row.status !== "dispatched") throw storesInvalidTransition(row.status);
          const lines = await tx.stockTransferLine.findMany({
            where: { tenantId: access.tenantId, transferId: id },
            include: { material: true },
            orderBy: { lineNo: "asc" },
          });
          const byId = new Map(input.lines.map((line) => [line.lineId, line]));
          if (byId.size !== lines.length || lines.some((line) => !byId.has(line.id)))
            throw new BadRequestException({
              code: "transfer-lines-mismatch",
              message: "Say what arrived for every line of the transfer",
            });
          let differs = false;
          for (const line of lines) {
            const entry = byId.get(line.id)!;
            const same = toMicro(entry.receivedQuantity) === toMicro(dec(line.baseQuantity));
            if (!same) differs = true;
            if (!same && !entry.differenceReason)
              throw new BadRequestException({
                code: "difference-reason-required",
                message: "Give a reason for every line that differs from what was sent",
              });
            await tx.stockTransferLine.update({
              where: { tenantId_id: { tenantId: access.tenantId, id: line.id } },
              data: {
                receivedBaseQuantity: entry.receivedQuantity,
                differenceReason: same ? null : (entry.differenceReason ?? null),
              },
            });
          }
          const status: TransferStatus = differs ? "disputed" : "received";
          const updated = await tx.stockTransfer.updateMany({
            where: { tenantId: access.tenantId, id, version: row.version, status: "dispatched" },
            data: {
              status,
              receiveIdempotencyKey: key,
              receiveDigest: digest,
              receiveCapturedAt: new Date(input.capturedAt),
              receivedBy: access.userId,
              receivedAt: new Date(),
              receiveNotes: input.notes ?? null,
              version: { increment: 1 },
            },
          });
          if (!updated.count) throw storesVersionConflict();
          for (const line of lines) {
            const received = byId.get(line.id)!.receivedQuantity;
            if (!/[1-9]/.test(received)) continue;
            await this.ledger.receive(
              scope,
              { storeId: row.toStoreId, projectId: row.toProjectId, material: line.material },
              "transfer_in",
              received,
              dec(line.unitCostMinor),
              { transferId: id, transferLineId: line.id },
            );
          }
          await this.scope.audit(tx, `stock.transfer_${status}`, id, {
            lines: lines.length,
            differences: lines.filter((line) => {
              const entry = byId.get(line.id)!;
              return toMicro(entry.receivedQuantity) !== toMicro(dec(line.baseQuantity));
            }).length,
          });
          return this.response(scope, await this.row(scope, id), false);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw storesConflict(
            "idempotency-key-reused",
            "This idempotency key was used for another receipt",
          );
        throw stockDatabaseProblem(error) ?? error;
      });
  }

  resolve(principal: Principal, id: string, input: TransferDecisionRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.row(scope, id);
        await this.approver(scope, row);
        if (row.status !== "disputed") throw storesInvalidTransition(row.status);
        if (row.version !== input.version) throw storesVersionConflict();
        if (access.userId === row.dispatchedBy || access.userId === row.receivedBy)
          throw storesProblem(
            403,
            "maker-checker",
            "Someone who neither sent nor received the transfer resolves the dispute",
          );
        const updated = await tx.stockTransfer.updateMany({
          where: { tenantId: access.tenantId, id, version: input.version },
          data: {
            status: "resolved",
            resolvedBy: access.userId,
            resolvedAt: new Date(),
            resolutionNote: input.reason,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw storesVersionConflict();
        await this.scope.audit(tx, "stock.transfer_resolved", id, { reasonGiven: true });
        return this.response(scope, await this.row(scope, id), false);
      },
      true,
    );
  }

  cancel(principal: Principal, id: string, input: TransferDecisionRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.row(scope, id);
          await this.access.require(scope, row.fromProjectId, [STORES_MANAGE], { writable: true });
          if (row.status !== "dispatched") throw storesInvalidTransition(row.status);
          if (row.version !== input.version) throw storesVersionConflict();
          const updated = await tx.stockTransfer.updateMany({
            where: { tenantId: access.tenantId, id, version: input.version, status: "dispatched" },
            data: {
              status: "cancelled",
              cancelledBy: access.userId,
              cancelledAt: new Date(),
              cancelReason: input.reason,
              version: { increment: 1 },
            },
          });
          if (!updated.count) throw storesVersionConflict();
          const entries = await tx.stockLedgerEntry.findMany({
            where: {
              tenantId: access.tenantId,
              transferId: id,
              kind: "transfer_out",
              reversesEntryId: null,
            },
            include: { material: true },
          });
          for (const entry of entries) await this.ledger.reverse(scope, entry, entry.material);
          await this.scope.audit(tx, "stock.transfer_cancelled", id, {
            lines: entries.length,
            reasonGiven: true,
          });
          return this.response(scope, await this.row(scope, id), false);
        },
        true,
      )
      .catch((error: unknown) => {
        throw stockDatabaseProblem(error) ?? error;
      });
  }

  // Helpers ---------------------------------------------------------------------------------

  async row(scope: Scope, id: string): Promise<TransferRow> {
    const row = await scope.tx.stockTransfer.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("Transfer not found");
    return row;
  }

  private async store(scope: Scope, id: string) {
    const store = await scope.tx.store.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!store) throw new NotFoundException("Store not found");
    return store;
  }

  /** Visible from either end. */
  private async viewer(scope: Scope, row: TransferRow) {
    const [from, to] = await Promise.all([
      this.access.on(scope, row.fromProjectId),
      this.access.on(scope, row.toProjectId),
    ]);
    if (!this.access.canView(from) && !this.access.canView(to))
      throw new ForbiddenException("No stores permission on this transfer's projects");
    return { from, to };
  }

  private async approver(scope: Scope, row: TransferRow) {
    const { from, to } = await this.viewer(scope, row);
    if (!this.access.can(from, STORES_APPROVE) && !this.access.can(to, STORES_APPROVE))
      throw new ForbiddenException(`Permission required: ${STORES_APPROVE}`);
  }

  async response(scope: Scope, row: TransferRow, replayed: boolean) {
    const [from, to] = await Promise.all([
      this.access.on(scope, row.fromProjectId),
      this.access.on(scope, row.toProjectId),
    ]);
    const [transfer] = await this.wire(scope, [row]);
    const me = scope.access.userId;
    return transferResponseSchema.parse({
      transfer,
      replayed,
      permissions: {
        canReceive: row.status === "dispatched" && this.access.can(to, STORES_MANAGE),
        canCancel: row.status === "dispatched" && this.access.can(from, STORES_MANAGE),
        canResolve:
          row.status === "disputed" &&
          (this.access.can(from, STORES_APPROVE) || this.access.can(to, STORES_APPROVE)) &&
          me !== row.dispatchedBy &&
          me !== row.receivedBy,
      },
    });
  }

  private async wire(scope: Scope, rows: TransferRow[]) {
    const { tx, access } = scope;
    if (!rows.length) return [];
    const [stores, lines] = await Promise.all([
      storeRefs(
        scope,
        rows.flatMap((row) => [row.fromStoreId, row.toStoreId]),
      ),
      tx.stockTransferLine.findMany({
        where: { tenantId: access.tenantId, transferId: { in: rows.map((row) => row.id) } },
        include: { material: true },
        orderBy: { lineNo: "asc" },
      }),
    ]);
    const people = await peopleOf(
      tx,
      rows.flatMap((row) => [row.dispatchedBy, row.receivedBy, row.resolvedBy, row.cancelledBy]),
    );
    return rows.map((row) => {
      const mine = lines.filter((line) => line.transferId === row.id);
      const dispatched = mine.reduce(
        (sum, line) => sum + toMicro(dec(line.dispatchedValueMinor)),
        0n,
      );
      const received = mine.every((line) => line.receivedBaseQuantity !== null);
      const arrived = mine.reduce(
        (sum, line) =>
          sum +
          (line.receivedBaseQuantity === null
            ? 0n
            : microTimes(
                toMicro(dec(line.receivedBaseQuantity)),
                toMicro(dec(line.unitCostMinor)),
              )),
        0n,
      );
      return {
        id: row.id,
        number: row.number,
        status: row.status as TransferStatus,
        fromStore: stores.get(row.fromStoreId),
        toStore: stores.get(row.toStoreId),
        capturedAt: iso(row.capturedAt),
        dispatchedAt: iso(row.dispatchedAt),
        dispatchedBy: personOf(people, row.dispatchedBy),
        dispatchNotes: row.dispatchNotes,
        receivedAt: isoOrNull(row.receivedAt),
        receivedBy: personOrNull(people, row.receivedBy),
        receiveNotes: row.receiveNotes,
        resolvedAt: isoOrNull(row.resolvedAt),
        resolvedBy: personOrNull(people, row.resolvedBy),
        resolutionNote: row.resolutionNote,
        cancelledAt: isoOrNull(row.cancelledAt),
        cancelledBy: personOrNull(people, row.cancelledBy),
        cancelReason: row.cancelReason,
        source: row.source as StoreSource,
        version: row.version,
        dispatchedValueMinor: microToMinor(dispatched),
        transitLossValueMinor:
          received && row.status !== "cancelled" && row.status !== "received"
            ? microToMinor(dispatched - arrived)
            : row.status === "received"
              ? 0
              : null,
        lineCount: row.lineCount,
        lines: mine.map((line) => {
          const got = decOrNull(line.receivedBaseQuantity);
          return {
            id: line.id,
            lineNo: line.lineNo,
            material: materialWire(line.material),
            quantity: dec(line.quantity),
            unit: line.unit,
            baseQuantity: dec(line.baseQuantity),
            unitCostMinor: dec(line.unitCostMinor),
            dispatchedValueMinor: dec(line.dispatchedValueMinor),
            receivedBaseQuantity: got,
            differenceBaseQuantity:
              got === null ? null : subtractDecimals(got, dec(line.baseQuantity)),
            differenceReason: line.differenceReason,
          };
        }),
      };
    });
  }
}
