import { Injectable } from "@nestjs/common";
import {
  fromMicro,
  nairobiDate,
  negateDecimal,
  receiveIntoStock,
  takeFromStock,
  toMicro,
  type StockPosition,
} from "@pm-buddy/domain";
import type { StockEntryKind } from "@pm-buddy/types";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { Scope } from "../../identity/access-policy.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { fromCalendarDate } from "../procurement-mappers.js";
import { nextId } from "../catalogue-store.js";
import { dec, storesConflict } from "./stores-common.js";

export type LedgerRow = Prisma.StockLedgerEntryGetPayload<object>;
export type StoreRow = Prisma.StoreGetPayload<object>;

/** Where an entry goes: the store (and its project) and the material with its base unit. */
export type LedgerTarget = {
  storeId: string;
  projectId: string;
  material: { id: string; name: string; baseUnit: string };
};

/** The source document of an entry (exactly one) and, for issues and returns, what it fed. */
export type LedgerRefs = Partial<
  Pick<
    LedgerRow,
    | "grnId"
    | "grnLineId"
    | "movementId"
    | "movementLineId"
    | "transferId"
    | "transferLineId"
    | "stockTakeId"
    | "stockTakeLineId"
    | "bqVersionId"
    | "bqItemLineageId"
    | "gangId"
  >
>;

/**
 * Posts stock ledger entries (D5.3, ARCHITECTURE §4.6). Each posting locks the (store, material)
 * balance row (`SELECT … FOR UPDATE`) in the caller's transaction, values the movement with the
 * weighted-average rules of packages/domain and inserts the entry; the database trigger
 * `app.post_stock_entry` takes the same lock, checks the source document, the valuation and that
 * stock never goes below zero, numbers the entry and moves the balance. A refused outflow is
 * 409 insufficient-stock (negative stock is never allowed, D-45).
 */
@Injectable()
export class StockLedger {
  constructor(private readonly tenant: TenantScope) {}

  /** The store of a site, created on first use ("<site> store"). */
  async ensureStore(scope: Scope, projectId: string, siteId: string): Promise<StoreRow> {
    const { tx, access } = scope;
    const existing = await tx.store.findUnique({
      where: { tenantId_siteId: { tenantId: access.tenantId, siteId } },
    });
    if (existing) return existing;
    const site = await tx.site.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: access.tenantId, id: siteId } },
    });
    const store = await tx.store.create({
      data: {
        id: nextId(),
        tenantId: access.tenantId,
        projectId,
        siteId,
        name: `${site.name} store`.slice(0, 120),
        createdBy: access.userId,
        updatedBy: access.userId,
      },
    });
    await this.tenant.audit(tx, "store.created", store.id, { projectId, siteId, onDemand: true });
    return store;
  }

  /** The position of a material in a store, locked for this transaction. */
  async position(scope: Scope, storeId: string, materialId: string): Promise<StockPosition> {
    const { tx, access } = scope;
    const rows = await tx.$queryRaw<{ quantity: string; value_minor: string }[]>`
      SELECT quantity::text AS quantity, value_minor::text AS value_minor FROM stock_balances
       WHERE tenant_id = ${access.tenantId}::uuid AND store_id = ${storeId}::uuid
         AND material_id = ${materialId}::uuid
         FOR UPDATE`;
    const row = rows[0];
    return row
      ? {
          quantity: fromMicro(toMicro(row.quantity)),
          valueMinor: fromMicro(toMicro(row.value_minor)),
        }
      : { quantity: "0", valueMinor: "0" };
  }

  /** Stock coming in at `unitCostMinor` per base unit. */
  async receive(
    scope: Scope,
    target: LedgerTarget,
    kind: Extract<StockEntryKind, "receipt" | "return" | "transfer_in" | "adjustment">,
    quantity: string,
    unitCostMinor: string,
    refs: LedgerRefs,
  ): Promise<LedgerRow> {
    const position = await this.position(scope, target.storeId, target.material.id);
    const inflow = receiveIntoStock(position, quantity, unitCostMinor);
    return this.insert(scope, target, kind, quantity, unitCostMinor, inflow.valueMinor, refs, null);
  }

  /** Stock leaving at the weighted average cost; 409 insufficient-stock when there is not enough. */
  async remove(
    scope: Scope,
    target: LedgerTarget,
    kind: Extract<StockEntryKind, "issue" | "transfer_out" | "wastage" | "adjustment">,
    quantity: string,
    refs: LedgerRefs,
  ): Promise<LedgerRow> {
    const position = await this.position(scope, target.storeId, target.material.id);
    const outflow = takeFromStock(position, quantity);
    if (!outflow.ok) throw this.insufficient(target, outflow.available);
    return this.insert(
      scope,
      target,
      kind,
      negateDecimal(quantity),
      outflow.unitCostMinor,
      negateDecimal(outflow.valueMinor),
      refs,
      null,
    );
  }

  /**
   * The correction of an entry: an outflow comes back with exactly the value it took; an inflow
   * leaves again at the current average (409 when the stock was already used).
   */
  async reverse(scope: Scope, original: LedgerRow, material: LedgerTarget["material"]) {
    const target = { storeId: original.storeId, projectId: original.projectId, material };
    const refs: LedgerRefs = {
      grnId: original.grnId,
      grnLineId: original.grnLineId,
      movementId: original.movementId,
      movementLineId: original.movementLineId,
      transferId: original.transferId,
      transferLineId: original.transferLineId,
      bqVersionId: original.bqVersionId,
      bqItemLineageId: original.bqItemLineageId,
      gangId: original.gangId,
    };
    const quantity = dec(original.quantity);
    const position = await this.position(scope, original.storeId, original.materialId);
    if (quantity.startsWith("-"))
      return this.insert(
        scope,
        target,
        original.kind as StockEntryKind,
        negateDecimal(quantity),
        dec(original.unitCostMinor),
        negateDecimal(dec(original.valueMinor)),
        refs,
        original.id,
      );
    const outflow = takeFromStock(position, quantity);
    if (!outflow.ok) throw this.insufficient(target, outflow.available);
    return this.insert(
      scope,
      target,
      original.kind as StockEntryKind,
      negateDecimal(quantity),
      outflow.unitCostMinor,
      negateDecimal(outflow.valueMinor),
      refs,
      original.id,
    );
  }

  /** The unit cost of the last entry for a store and material ("0" when there is none). */
  async lastUnitCost(scope: Scope, storeId: string, materialId: string): Promise<string> {
    const last = await scope.tx.stockLedgerEntry.findFirst({
      where: { tenantId: scope.access.tenantId, storeId, materialId },
      orderBy: { seq: "desc" },
      select: { unitCostMinor: true },
    });
    return last ? dec(last.unitCostMinor) : "0";
  }

  private insufficient(target: LedgerTarget, available: string) {
    return storesConflict(
      "insufficient-stock",
      `Only ${available} ${target.material.baseUnit} of ${target.material.name} is in this store`,
    );
  }

  private insert(
    scope: Scope,
    target: LedgerTarget,
    kind: StockEntryKind,
    quantity: string,
    unitCostMinor: string,
    valueMinor: string,
    refs: LedgerRefs,
    reversesEntryId: string | null,
  ): Promise<LedgerRow> {
    const { tx, access } = scope;
    // seq, the running balance and the business date are set by app.post_stock_entry.
    return tx.stockLedgerEntry.create({
      data: {
        id: nextId(),
        tenantId: access.tenantId,
        projectId: target.projectId,
        storeId: target.storeId,
        materialId: target.material.id,
        baseUnit: target.material.baseUnit,
        seq: 0n,
        kind,
        quantity,
        unitCostMinor,
        valueMinor,
        balanceQuantity: "0",
        balanceValueMinor: "0",
        businessDate: fromCalendarDate(nairobiDate()),
        recordedBy: access.userId,
        reversesEntryId,
        ...refs,
      },
    });
  }
}
