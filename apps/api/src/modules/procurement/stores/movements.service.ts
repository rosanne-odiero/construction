import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import {
  microToMinor,
  nairobiDate,
  returnableQuantity,
  sumDecimals,
  toMicro,
} from "@pm-buddy/domain";
import type {
  StockMovementKind,
  StockMovementStatus,
  StoreSource,
  WastageReason,
} from "@pm-buddy/types";
import {
  movementResponseSchema,
  movementsResponseSchema,
  type ParsedIssueRequest,
  type ParsedReturnRequest,
  type ParsedWastageRequest,
} from "@pm-buddy/validation";
import { isCheckViolation, isUniqueViolation } from "../../../common/database-errors.js";
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
import { peopleOf, personOf, toCalendarDate, type MaterialRow } from "../procurement-mappers.js";
import { StockLedger, type LedgerRefs } from "./stock-ledger.js";
import {
  dec,
  nextStoresNumber,
  STORES_MANAGE,
  StoresAccess,
  storeRefs,
  storesConflict,
  storesInvalidTransition,
  storesProblem,
} from "./stores-common.js";

type MovementRow = Prisma.StockMovementGetPayload<object>;
type LineInput = { materialId: string; quantity: string; unit: string };

/** A database refusal raised by the stores triggers, as the API's problem. */
export function stockDatabaseProblem(error: unknown): Error | null {
  if (!isCheckViolation(error)) return null;
  const text = JSON.stringify(error, Object.getOwnPropertyNames(error as object));
  if (/below zero|already used/.test(text))
    return storesConflict("insufficient-stock", "There is not enough stock for this movement");
  if (/outstanding on the issue/.test(text))
    return storesConflict("return-exceeds-issued", "More than is still outstanding on the issue");
  if (/returns before the issue/.test(text))
    return storesConflict("movement-has-returns", "Reverse the returns of this issue first");
  return null;
}

/**
 * Issues (to a BQ item and/or a gang), returns and wastage (D5.3, brief §5.3 and §15 E/G). Built
 * for offline sync like GRNs: the client chooses the ID and sends an `Idempotency-Key`; a replay
 * returns the original (`replayed: true`), a changed payload under the key is 409
 * idempotency-key-reused and the same ID under another key is 409 movement-id-conflict. Posted
 * movements never change; a mistaken one is reversed with a reason (reversing entries).
 */
@Injectable()
export class MovementsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: StoresAccess,
    private readonly catalogue: CatalogueStore,
    private readonly ledger: StockLedger,
  ) {}

  list(
    principal: Principal,
    query: { storeId?: string; kind?: StockMovementKind; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const projectIds = await this.access.visibleProjectIds(scope);
      // Client-chosen IDs are not time-ordered: page by (recorded at, id), newest first.
      const after = query.cursor
        ? await scope.tx.stockMovement.findUnique({
            where: { tenantId_id: { tenantId: scope.access.tenantId, id: query.cursor } },
            select: { id: true, recordedAt: true },
          })
        : null;
      const rows = await scope.tx.stockMovement.findMany({
        where: {
          tenantId: scope.access.tenantId,
          projectId: { in: projectIds },
          ...(query.storeId ? { storeId: query.storeId } : {}),
          ...(query.kind ? { kind: query.kind } : {}),
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
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const wired = await this.wire(scope, page);
      return movementsResponseSchema.parse({
        movements: wired.map(({ lines: _lines, returns: _returns, ...movement }) => movement),
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

  issue(principal: Principal, input: ParsedIssueRequest, key: string, req: Request) {
    const digest = requestDigest("stores.issue", input);
    return this.record(principal, req, input.id, key, digest, async (scope) => {
      const { tx, access } = scope;
      const store = await this.store(scope, input.storeId);
      await this.access.require(scope, store.projectId, [STORES_MANAGE], { writable: true });
      let bq: { versionId: string; lineageId: string } | null = null;
      if (input.bqItemLineageId) {
        const version = await tx.bqVersion.findFirst({
          where: { tenantId: access.tenantId, projectId: store.projectId, status: "approved" },
          orderBy: { versionNo: "desc" },
          select: { id: true },
        });
        if (!version)
          throw storesConflict("bq-not-approved", "The project has no approved BQ version yet");
        const item = await tx.bqItem.findUnique({
          where: {
            tenantId_versionId_lineageId: {
              tenantId: access.tenantId,
              versionId: version.id,
              lineageId: input.bqItemLineageId,
            },
          },
        });
        if (!item)
          throw storesProblem(422, "bq-item-not-found", "The BQ item is not in the BQ in force");
        bq = { versionId: version.id, lineageId: item.lineageId };
      }
      if (input.gangId) {
        const gang = await tx.gang.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: input.gangId } },
        });
        if (!gang || gang.projectId !== store.projectId)
          throw new BadRequestException({
            code: "gang-not-in-project",
            message: "The gang is not on this store's project",
          });
      }
      const lines = await this.convert(scope, input.lines);
      const movement = await this.createMovement(scope, store, "issue", input, key, digest, lines, {
        bqVersionId: bq?.versionId ?? null,
        bqItemLineageId: bq?.lineageId ?? null,
        gangId: input.gangId,
        issuedToName: input.issuedToName,
      });
      await this.scope.audit(tx, "stock.issued", movement.id, {
        storeId: store.id,
        projectId: store.projectId,
        lines: lines.length,
        bqItem: Boolean(bq),
        gang: Boolean(input.gangId),
        source: input.source,
      });
      return movement;
    });
  }

  wastage(principal: Principal, input: ParsedWastageRequest, key: string, req: Request) {
    const digest = requestDigest("stores.wastage", input);
    return this.record(principal, req, input.id, key, digest, async (scope) => {
      const store = await this.store(scope, input.storeId);
      await this.access.require(scope, store.projectId, [STORES_MANAGE], { writable: true });
      const lines = await this.convert(scope, input.lines);
      const movement = await this.createMovement(
        scope,
        store,
        "wastage",
        input,
        key,
        digest,
        lines,
        {
          wastageReason: input.reason,
        },
      );
      await this.scope.audit(scope.tx, "stock.wasted", movement.id, {
        storeId: store.id,
        projectId: store.projectId,
        lines: lines.length,
        reason: input.reason,
        source: input.source,
      });
      return movement;
    });
  }

  return(principal: Principal, input: ParsedReturnRequest, key: string, req: Request) {
    const digest = requestDigest("stores.return", input);
    return this.record(principal, req, input.id, key, digest, async (scope) => {
      const { tx, access } = scope;
      const issue = await this.row(scope, input.issueId);
      if (issue.kind !== "issue") throw new NotFoundException("Issue not found");
      await this.access.require(scope, issue.projectId, [STORES_MANAGE], { writable: true });
      if (issue.status !== "posted")
        throw storesConflict("issue-not-posted", "A reversed issue cannot be returned");
      const store = await this.store(scope, issue.storeId);
      const issueLines = await tx.stockMovementLine.findMany({
        where: { tenantId: access.tenantId, movementId: issue.id },
        include: { material: true },
      });
      const returned = await this.returnedByLine(
        scope,
        issueLines.map((line) => line.id),
      );
      const units = await this.catalogue.customUnits(scope);
      const lines = [];
      for (const entry of input.lines) {
        const issued = issueLines.find((line) => line.id === entry.issueLineId);
        if (!issued)
          throw new BadRequestException({
            code: "line-not-on-issue",
            message: "A line is not on this issue",
          });
        const unit = entry.unit ?? issued.unit;
        assertUsableUnit(unit, units);
        const converted = await toBaseQuantity(
          this.catalogue,
          scope,
          issued.material,
          null,
          nairobiDate(),
          entry.quantity,
          unit,
          units,
        );
        const left = returnableQuantity(dec(issued.baseQuantity), returned.get(issued.id) ?? "0");
        if (toMicro(converted.baseQuantity) > toMicro(left))
          throw storesConflict(
            "return-exceeds-issued",
            `At most ${left} ${issued.material.baseUnit} of ${issued.material.name} can be returned`,
          );
        lines.push({
          material: issued.material,
          quantity: entry.quantity,
          unit,
          converted,
          returnOf: issued.id,
        });
      }
      const movement = await this.createMovement(
        scope,
        store,
        "return",
        input,
        key,
        digest,
        lines,
        {
          bqVersionId: issue.bqVersionId,
          bqItemLineageId: issue.bqItemLineageId,
          gangId: issue.gangId,
          returnOfId: issue.id,
        },
      );
      await this.scope.audit(tx, "stock.returned", movement.id, {
        storeId: store.id,
        issueId: issue.id,
        lines: lines.length,
        source: input.source,
      });
      return movement;
    });
  }

  reverse(principal: Principal, id: string, input: { reason: string }, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.row(scope, id);
          await this.access.require(scope, row.projectId, [STORES_MANAGE], { writable: true });
          if (row.status !== "posted") throw storesInvalidTransition(row.status);
          if (row.kind === "issue" && (await this.postedReturns(scope, row.id)) > 0)
            throw storesConflict("movement-has-returns", "Reverse the returns of this issue first");
          await tx.stockMovement.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data: {
              status: "reversed",
              reversedBy: access.userId,
              reversedAt: new Date(),
              reversalReason: input.reason,
            },
          });
          const entries = await tx.stockLedgerEntry.findMany({
            where: { tenantId: access.tenantId, movementId: id, reversesEntryId: null },
            include: { material: true },
            orderBy: { id: "asc" },
          });
          for (const entry of entries) await this.ledger.reverse(scope, entry, entry.material);
          await this.scope.audit(tx, "stock.movement_reversed", id, {
            kind: row.kind,
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

  async row(scope: Scope, id: string): Promise<MovementRow> {
    const row = await scope.tx.stockMovement.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("Stock movement not found");
    return row;
  }

  private async store(scope: Scope, id: string) {
    const store = await scope.tx.store.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!store) throw new NotFoundException("Store not found");
    return store;
  }

  /** Idempotent creation: replay, ID clash and database refusals handled the same way for all. */
  private record(
    principal: Principal,
    req: Request,
    id: string,
    key: string,
    digest: string,
    work: (scope: Scope) => Promise<MovementRow>,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const replay = await tx.stockMovement.findUnique({
            where: { tenantId_idempotencyKey: { tenantId: access.tenantId, idempotencyKey: key } },
          });
          if (replay) {
            if (replay.requestDigest !== digest || replay.id !== id)
              throw storesConflict(
                "idempotency-key-reused",
                "This idempotency key was used for a different movement",
              );
            await this.access.viewer(scope, replay.projectId);
            return this.response(scope, replay, true);
          }
          const clash = await tx.stockMovement.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
          });
          if (clash)
            throw storesConflict(
              "movement-id-conflict",
              "A movement with this ID was sent with another key",
            );
          return this.response(scope, await work(scope), false);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw storesConflict(
            "movement-id-conflict",
            "This movement was recorded by another request",
          );
        throw stockDatabaseProblem(error) ?? error;
      });
  }

  private async convert(scope: Scope, input: readonly LineInput[]) {
    const { tx, access } = scope;
    const materials = await tx.material.findMany({
      where: { tenantId: access.tenantId, id: { in: input.map((line) => line.materialId) } },
    });
    const byId = new Map(materials.map((material) => [material.id, material]));
    const units = await this.catalogue.customUnits(scope);
    const lines = [];
    for (const line of input) {
      const material = byId.get(line.materialId);
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
      lines.push({ material, quantity: line.quantity, unit: line.unit, converted, returnOf: null });
    }
    return lines;
  }

  private async createMovement(
    scope: Scope,
    store: { id: string; projectId: string; name: string },
    kind: StockMovementKind,
    input: { id: string; capturedAt: string; notes?: string | null; source: StoreSource },
    key: string,
    digest: string,
    lines: {
      material: MaterialRow;
      quantity: string;
      unit: string;
      converted: { baseQuantity: string; ratio: string; steps: unknown[] };
      returnOf: string | null;
    }[],
    extra: {
      bqVersionId?: string | null;
      bqItemLineageId?: string | null;
      gangId?: string | null;
      issuedToName?: string;
      returnOfId?: string;
      wastageReason?: WastageReason;
    },
  ): Promise<MovementRow> {
    const { tx, access } = scope;
    const movement = await tx.stockMovement.create({
      data: {
        id: input.id,
        tenantId: access.tenantId,
        projectId: store.projectId,
        storeId: store.id,
        kind,
        number: await nextStoresNumber(tx, access.tenantId, kind),
        bqVersionId: extra.bqVersionId ?? null,
        bqItemLineageId: extra.bqItemLineageId ?? null,
        gangId: extra.gangId ?? null,
        issuedToName: extra.issuedToName ?? null,
        returnOfId: extra.returnOfId ?? null,
        wastageReason: extra.wastageReason ?? null,
        notes: input.notes ?? null,
        idempotencyKey: key,
        requestDigest: digest,
        capturedAt: new Date(input.capturedAt),
        businessDate: new Date(`${nairobiDate()}T00:00:00.000Z`),
        source: input.source,
        lineCount: lines.length,
        recordedBy: access.userId,
      },
    });
    const rows = lines.map((line, index) => ({
      id: nextId(),
      tenantId: access.tenantId,
      movementId: movement.id,
      lineNo: index + 1,
      materialId: line.material.id,
      quantity: line.quantity,
      unit: line.unit,
      baseQuantity: line.converted.baseQuantity,
      conversion: JSON.parse(
        JSON.stringify({ ratio: line.converted.ratio, steps: line.converted.steps }),
      ) as Prisma.InputJsonValue,
      returnOfLineId: line.returnOf,
    }));
    await tx.stockMovementLine.createMany({ data: rows });
    const refs: LedgerRefs = {
      movementId: movement.id,
      bqVersionId: movement.bqVersionId,
      bqItemLineageId: movement.bqItemLineageId,
      gangId: movement.gangId,
    };
    for (const [index, row] of rows.entries()) {
      const target = {
        storeId: store.id,
        projectId: store.projectId,
        material: lines[index]!.material,
      };
      const lineRefs = { ...refs, movementLineId: row.id };
      if (kind === "return") {
        const issued = await tx.stockLedgerEntry.findFirstOrThrow({
          where: {
            tenantId: access.tenantId,
            movementLineId: row.returnOfLineId!,
            reversesEntryId: null,
          },
        });
        await this.ledger.receive(
          scope,
          target,
          "return",
          row.baseQuantity,
          dec(issued.unitCostMinor),
          lineRefs,
        );
      } else await this.ledger.remove(scope, target, kind, row.baseQuantity, lineRefs);
    }
    return movement;
  }

  /** Returned base quantity per issue line (posted returns only). */
  private async returnedByLine(scope: Scope, issueLineIds: string[]): Promise<Map<string, string>> {
    if (!issueLineIds.length) return new Map();
    const rows = await scope.tx.stockMovementLine.findMany({
      where: {
        tenantId: scope.access.tenantId,
        returnOfLineId: { in: issueLineIds },
        movement: { status: "posted" },
      },
      select: { returnOfLineId: true, baseQuantity: true },
    });
    const totals = new Map<string, string>();
    for (const row of rows)
      totals.set(
        row.returnOfLineId!,
        sumDecimals([totals.get(row.returnOfLineId!) ?? "0", dec(row.baseQuantity)]),
      );
    return totals;
  }

  private postedReturns(scope: Scope, issueId: string) {
    return scope.tx.stockMovement.count({
      where: { tenantId: scope.access.tenantId, returnOfId: issueId, status: "posted" },
    });
  }

  async response(scope: Scope, row: MovementRow, replayed: boolean) {
    const project = await this.access.on(scope, row.projectId);
    const [movement] = await this.wire(scope, [row]);
    const manage = this.access.can(project, STORES_MANAGE);
    const posted = row.status === "posted";
    const hasReturns = row.kind === "issue" && (await this.postedReturns(scope, row.id)) > 0;
    return movementResponseSchema.parse({
      movement,
      replayed,
      permissions: {
        canReverse: manage && posted && !hasReturns,
        canReturn:
          manage &&
          posted &&
          row.kind === "issue" &&
          movement!.lines.some((line) => /[1-9]/.test(line.returnableBaseQuantity ?? "0")),
      },
    });
  }

  private async wire(scope: Scope, rows: MovementRow[]) {
    const { tx, access } = scope;
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const [stores, lines, entries, returns, origins, gangs, items] = await Promise.all([
      storeRefs(
        scope,
        rows.map((row) => row.storeId),
      ),
      tx.stockMovementLine.findMany({
        where: { tenantId: access.tenantId, movementId: { in: ids } },
        include: { material: true },
        orderBy: { lineNo: "asc" },
      }),
      tx.stockLedgerEntry.findMany({
        where: { tenantId: access.tenantId, movementId: { in: ids }, reversesEntryId: null },
        select: { movementLineId: true, unitCostMinor: true, valueMinor: true },
      }),
      tx.stockMovement.findMany({
        where: { tenantId: access.tenantId, returnOfId: { in: ids } },
        select: { id: true, number: true, status: true, returnOfId: true },
        orderBy: { number: "asc" },
      }),
      tx.stockMovement.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: rows.map((row) => row.returnOfId).filter((id): id is string => id !== null) },
        },
        select: { id: true, number: true, status: true },
      }),
      tx.gang.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: rows.map((row) => row.gangId).filter((id): id is string => id !== null) },
        },
        select: { id: true, name: true },
      }),
      tx.bqItem.findMany({
        where: {
          tenantId: access.tenantId,
          OR: rows
            .filter((row) => row.bqVersionId && row.bqItemLineageId)
            .map((row) => ({ versionId: row.bqVersionId!, lineageId: row.bqItemLineageId! })),
        },
        select: { versionId: true, lineageId: true, ref: true, description: true, unit: true },
      }),
    ]);
    const returned = await this.returnedByLine(
      scope,
      lines
        .filter((line) => rows.find((row) => row.id === line.movementId)?.kind === "issue")
        .map((line) => line.id),
    );
    const people = await peopleOf(tx, [
      ...rows.map((row) => row.recordedBy),
      ...rows.map((row) => row.reversedBy),
    ]);
    const entryByLine = new Map(entries.map((entry) => [entry.movementLineId, entry]));
    return rows.map((row) => {
      const mine = lines.filter((line) => line.movementId === row.id);
      const item = items.find(
        (entry) => entry.versionId === row.bqVersionId && entry.lineageId === row.bqItemLineageId,
      );
      const total = mine.reduce((sum, line) => {
        const entry = entryByLine.get(line.id);
        const value = entry ? toMicro(dec(entry.valueMinor)) : 0n;
        return sum + (value < 0n ? -value : value);
      }, 0n);
      return {
        id: row.id,
        number: row.number,
        kind: row.kind as StockMovementKind,
        status: row.status as StockMovementStatus,
        store: stores.get(row.storeId),
        bqItem: item ?? null,
        gang: gangs.find((gang) => gang.id === row.gangId) ?? null,
        issuedToName: row.issuedToName,
        returnOf: origins.find((origin) => origin.id === row.returnOfId) ?? null,
        wastageReason: row.wastageReason as WastageReason | null,
        notes: row.notes,
        capturedAt: iso(row.capturedAt),
        recordedAt: iso(row.recordedAt),
        businessDate: toCalendarDate(row.businessDate),
        recordedBy: personOf(people, row.recordedBy),
        source: row.source as StoreSource,
        reversedAt: isoOrNull(row.reversedAt),
        reversedBy: personOrNull(people, row.reversedBy),
        reversalReason: row.reversalReason,
        totalValueMinor: microToMinor(total),
        lineCount: row.lineCount,
        lines: mine.map((line) => {
          const entry = entryByLine.get(line.id);
          const value = entry ? dec(entry.valueMinor) : "0";
          const issue = row.kind === "issue";
          const back = returned.get(line.id) ?? "0";
          return {
            id: line.id,
            lineNo: line.lineNo,
            material: materialWire(line.material),
            quantity: dec(line.quantity),
            unit: line.unit,
            baseQuantity: dec(line.baseQuantity),
            valueMinor: value.startsWith("-") ? value.slice(1) : value,
            unitCostMinor: entry ? dec(entry.unitCostMinor) : "0",
            returnOfLineId: line.returnOfLineId,
            returnedBaseQuantity: issue ? back : null,
            returnableBaseQuantity: issue
              ? row.status === "posted"
                ? returnableQuantity(dec(line.baseQuantity), back)
                : "0"
              : null,
          };
        }),
        returns: returns
          .filter((entry) => entry.returnOfId === row.id)
          .map(({ id, number, status }) => ({ id, number, status })),
      };
    });
  }
}
