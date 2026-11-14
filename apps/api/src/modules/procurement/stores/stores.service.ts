import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { averageUnitCost, isLowStock, microToMinor, toMicro } from "@pm-buddy/domain";
import {
  DEFAULT_CONSUMPTION_VARIANCE_PERCENT,
  DEFAULT_PRICE_CHANGE_ALERT_PERCENT,
  type StockEntryKind,
} from "@pm-buddy/types";
import {
  issueOptionsResponseSchema,
  ledgerResponseSchema,
  storeDetailResponseSchema,
  storesResponseSchema,
  storesSettingsResponseSchema,
  transferTargetsResponseSchema,
  type CreateStoreRequest,
  type LedgerQuery,
  type ReorderLevelsRequest,
  type UpdateStoreRequest,
  type UpdateStoresSettingsRequest,
} from "@pm-buddy/validation";
import { customRoleColumns, type Scope } from "../../identity/access-policy.js";
import type { Principal } from "../../identity/auth.service.js";
import { effectiveProjectPermissions, grantOf } from "../../identity/role-grants.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { nextId } from "../catalogue-store.js";
import { iso, isoOrNull, materialWire, projectRef } from "../p2p/p2p-common.js";
import { fromCalendarDate, peopleOf, personOf, toCalendarDate } from "../procurement-mappers.js";
import {
  dec,
  STORES_MANAGE,
  StoresAccess,
  storeRefs,
  storesConflict,
  storesVersionConflict,
} from "./stores-common.js";
import type { StoreRow } from "./stock-ledger.js";

const minorOf = (micro: bigint) => microToMinor(micro);

/**
 * Stores per site, balances, the ledger, reorder levels and the stores settings (D5.3,
 * ARCHITECTURE §4.6). Reads are open to STORES_VIEW_PERMISSIONS on the store's project; changes
 * need stores.manage there (settings: config.manage, company-level).
 */
@Injectable()
export class StoresService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: StoresAccess,
  ) {}

  list(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const projectIds = await this.access.visibleProjectIds(scope);
      const [stores, sites] = await Promise.all([
        tx.store.findMany({
          where: { tenantId: access.tenantId, projectId: { in: projectIds } },
          orderBy: { name: "asc" },
        }),
        tx.site.findMany({
          where: { tenantId: access.tenantId, projectId: { in: projectIds } },
          include: { project: { select: { id: true, code: true, name: true, status: true } } },
          orderBy: { name: "asc" },
        }),
      ]);
      const summaries = await this.summaries(scope, stores);
      const withStore = new Set(stores.map((store) => store.siteId));
      const sitesWithoutStore = [];
      for (const site of sites.filter((entry) => !withStore.has(entry.id))) {
        const project = await this.access.on(scope, site.projectId);
        sitesWithoutStore.push({
          project: projectRef(site.project),
          site: { id: site.id, name: site.name },
          canCreate: this.access.can(project, STORES_MANAGE),
        });
      }
      const lowStock = await this.lowStock(scope, stores);
      return storesResponseSchema.parse({
        stores: summaries,
        sitesWithoutStore,
        lowStock: lowStock.slice(0, 50),
        totalValueMinor: summaries.reduce((total, store) => total + store.valueMinor, 0),
      });
    });
  }

  create(principal: Principal, input: CreateStoreRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const site = await tx.site.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: input.siteId } },
        });
        if (!site) throw new NotFoundException("Site not found");
        const project = await this.access.require(scope, site.projectId, [STORES_MANAGE], {
          writable: true,
        });
        const existing = await tx.store.findUnique({
          where: { tenantId_siteId: { tenantId: access.tenantId, siteId: site.id } },
        });
        if (existing) throw storesConflict("store-exists", "This site already has a store");
        const keeper = input.storekeeperUserId ?? null;
        if (keeper) await this.assertStorekeeper(scope, project.project.id, keeper);
        const store = await tx.store.create({
          data: {
            id: nextId(),
            tenantId: access.tenantId,
            projectId: site.projectId,
            siteId: site.id,
            name: (input.name ?? `${site.name} store`).slice(0, 120),
            storekeeperId: keeper,
            createdBy: access.userId,
            updatedBy: access.userId,
          },
        });
        await this.scope.audit(tx, "store.created", store.id, {
          projectId: site.projectId,
          siteId: site.id,
          storekeeper: Boolean(keeper),
        });
        return this.detailOf(scope, store);
      },
      true,
    );
  }

  update(principal: Principal, id: string, input: UpdateStoreRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const store = await this.row(scope, id);
        await this.access.require(scope, store.projectId, [STORES_MANAGE], { writable: true });
        if (store.version !== input.version) throw storesVersionConflict();
        if (input.storekeeperUserId && input.storekeeperUserId !== store.storekeeperId)
          await this.assertStorekeeper(scope, store.projectId, input.storekeeperUserId);
        const updated = await tx.store.updateMany({
          where: { tenantId: access.tenantId, id, version: input.version },
          data: {
            name: input.name,
            storekeeperId: input.storekeeperUserId,
            version: { increment: 1 },
            updatedBy: access.userId,
            updatedAt: new Date(),
          },
        });
        if (!updated.count) throw storesVersionConflict();
        await this.scope.audit(tx, "store.updated", id, {
          fields: [
            ...(input.name !== store.name ? ["name"] : []),
            ...(input.storekeeperUserId !== store.storekeeperId ? ["storekeeper"] : []),
          ],
        });
        return this.detailOf(scope, await this.row(scope, id));
      },
      true,
    );
  }

  detail(principal: Principal, id: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const store = await this.row(scope, id);
      await this.access.viewer(scope, store.projectId);
      return this.detailOf(scope, store);
    });
  }

  ledger(principal: Principal, id: string, query: LedgerQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const store = await this.row(scope, id);
      await this.access.viewer(scope, store.projectId);
      const rows = await tx.stockLedgerEntry.findMany({
        where: {
          tenantId: access.tenantId,
          storeId: id,
          ...(query.materialId ? { materialId: query.materialId } : {}),
          ...(query.kind ? { kind: query.kind } : {}),
          ...(query.from || query.to
            ? {
                businessDate: {
                  ...(query.from ? { gte: fromCalendarDate(query.from) } : {}),
                  ...(query.to ? { lte: fromCalendarDate(query.to) } : {}),
                },
              }
            : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        orderBy: { id: "desc" },
        take: query.limit + 1,
        include: { material: true },
      });
      const page = rows.slice(0, query.limit);
      const entries = await this.entriesWire(scope, page);
      return ledgerResponseSchema.parse({
        store: { id: store.id, name: store.name },
        entries,
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
        },
      });
    });
  }

  reorderLevels(principal: Principal, id: string, input: ReorderLevelsRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const store = await this.row(scope, id);
        await this.access.require(scope, store.projectId, [STORES_MANAGE], { writable: true });
        const materials = await tx.material.count({
          where: { tenantId: access.tenantId, id: { in: input.levels.map((l) => l.materialId) } },
        });
        if (materials !== input.levels.length) throw new NotFoundException("Material not found");
        let set = 0;
        let removed = 0;
        for (const level of input.levels) {
          const key = { tenantId: access.tenantId, storeId: id, materialId: level.materialId };
          if (level.reorderLevel === null || !/[1-9]/.test(level.reorderLevel)) {
            removed += (await tx.stockReorderLevel.deleteMany({ where: key })).count;
            continue;
          }
          await tx.stockReorderLevel.upsert({
            where: { tenantId_storeId_materialId: key },
            create: { ...key, reorderLevel: level.reorderLevel, updatedBy: access.userId },
            update: {
              reorderLevel: level.reorderLevel,
              updatedBy: access.userId,
              updatedAt: new Date(),
            },
          });
          set += 1;
        }
        await this.scope.audit(tx, "store.reorder_levels_updated", id, { set, removed });
        return this.detailOf(scope, store);
      },
      true,
    );
  }

  /** What an issue form needs: BQ items of the newest approved version, gangs and stock on hand. */
  issueOptions(principal: Principal, id: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const store = await this.row(scope, id);
      await this.access.require(scope, store.projectId, [STORES_MANAGE]);
      const [refs, version, gangs, balances] = await Promise.all([
        storeRefs(scope, [id]),
        tx.bqVersion.findFirst({
          where: { tenantId: access.tenantId, projectId: store.projectId, status: "approved" },
          orderBy: { versionNo: "desc" },
          select: { id: true },
        }),
        tx.gang.findMany({
          where: { tenantId: access.tenantId, projectId: store.projectId, status: "active" },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        }),
        tx.stockBalance.findMany({
          where: { tenantId: access.tenantId, storeId: id, quantity: { gt: 0 } },
          include: { material: true },
        }),
      ]);
      const items = version
        ? await tx.bqItem.findMany({
            where: { tenantId: access.tenantId, versionId: version.id, kind: "measured" },
            orderBy: [{ billId: "asc" }, { sortOrder: "asc" }],
            take: 1000,
          })
        : [];
      return issueOptionsResponseSchema.parse({
        store: refs.get(id),
        bqItems: items.map((item) => ({
          versionId: item.versionId,
          lineageId: item.lineageId,
          ref: item.ref,
          description: item.description,
          unit: item.unit,
        })),
        gangs,
        stock: balances
          .sort((left, right) => left.material.name.localeCompare(right.material.name))
          .map((balance) => ({
            material: materialWire(balance.material),
            quantity: dec(balance.quantity),
          })),
      });
    });
  }

  /** Stores a transfer from this store can go to (other stores the caller can see). */
  transferTargets(principal: Principal, id: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const store = await this.row(scope, id);
      await this.access.require(scope, store.projectId, [STORES_MANAGE]);
      const projectIds = await this.access.visibleProjectIds(scope);
      const others = await scope.tx.store.findMany({
        where: { tenantId: scope.access.tenantId, projectId: { in: projectIds }, id: { not: id } },
        select: { id: true },
      });
      const refs = await storeRefs(
        scope,
        others.map((other) => other.id),
      );
      return transferTargetsResponseSchema.parse({
        stores: [...refs.values()].sort((left, right) => left.name.localeCompare(right.name)),
      });
    });
  }

  settings(principal: Principal, req: Request) {
    return this.scope.run(principal, req, (scope) => this.settingsView(scope));
  }

  updateSettings(principal: Principal, input: UpdateStoresSettingsRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        if (!access.permissions.has("config.manage"))
          throw new ForbiddenException("Permission required: config.manage");
        const row = await tx.procurementSettings.findUnique({
          where: { tenantId: access.tenantId },
        });
        if ((row?.version ?? null) !== input.version) throw storesVersionConflict();
        if (!row)
          await tx.procurementSettings.create({
            data: {
              tenantId: access.tenantId,
              priceChangeAlertPercent: DEFAULT_PRICE_CHANGE_ALERT_PERCENT,
              consumptionVariancePercent: input.varianceThresholdPercent,
              updatedBy: access.userId,
            },
          });
        else {
          const updated = await tx.procurementSettings.updateMany({
            where: { tenantId: access.tenantId, version: row.version },
            data: {
              consumptionVariancePercent: input.varianceThresholdPercent,
              version: { increment: 1 },
              updatedBy: access.userId,
              updatedAt: new Date(),
            },
          });
          if (!updated.count) throw storesVersionConflict();
        }
        await this.scope.audit(tx, "stores.settings_updated", access.tenantId, {
          fields: ["varianceThresholdPercent"],
        });
        return this.settingsView(scope);
      },
      true,
    );
  }

  // Helpers ---------------------------------------------------------------------------------

  async row(scope: Scope, id: string): Promise<StoreRow> {
    const row = await scope.tx.store.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("Store not found");
    return row;
  }

  private async settingsView(scope: Scope) {
    const row = await scope.tx.procurementSettings.findUnique({
      where: { tenantId: scope.access.tenantId },
    });
    return storesSettingsResponseSchema.parse({
      settings: {
        varianceThresholdPercent: row
          ? dec(row.consumptionVariancePercent)
          : DEFAULT_CONSUMPTION_VARIANCE_PERCENT,
        negativeStockAllowed: false,
        version: row?.version ?? null,
        updatedAt: row ? iso(row.updatedAt) : null,
      },
      permissions: { canEdit: scope.access.permissions.has("config.manage") },
    });
  }

  /** A storekeeper is a member whose effective permissions on the project include stores.manage. */
  private async assertStorekeeper(scope: Scope, projectId: string, userId: string) {
    const candidates = await this.storekeepers(scope, projectId);
    if (!candidates.some((candidate) => candidate === userId))
      throw storesConflict(
        "storekeeper-not-member",
        "The storekeeper must be a member with stores.manage on this project",
      );
  }

  private async storekeepers(scope: Scope, projectId: string): Promise<string[]> {
    const { tx, access } = scope;
    const [members, assignments] = await Promise.all([
      tx.membership.findMany({
        where: { tenantId: access.tenantId },
        select: { userId: true, ...customRoleColumns },
      }),
      tx.projectMembership.findMany({
        where: { tenantId: access.tenantId, projectId },
        select: { userId: true, permissions: true },
      }),
    ]);
    const assigned = new Map(assignments.map((row) => [row.userId, row.permissions]));
    return members
      .filter((member) =>
        effectiveProjectPermissions(grantOf(member), assigned.get(member.userId) ?? null).has(
          STORES_MANAGE,
        ),
      )
      .map((member) => member.userId);
  }

  private async summaries(scope: Scope, stores: StoreRow[]) {
    const { tx, access } = scope;
    if (!stores.length) return [];
    const ids = stores.map((store) => store.id);
    const [balances, levels, transfers, refs, people] = await Promise.all([
      tx.stockBalance.findMany({ where: { tenantId: access.tenantId, storeId: { in: ids } } }),
      tx.stockReorderLevel.findMany({ where: { tenantId: access.tenantId, storeId: { in: ids } } }),
      tx.stockTransfer.findMany({
        where: {
          tenantId: access.tenantId,
          status: "dispatched",
          OR: [{ fromStoreId: { in: ids } }, { toStoreId: { in: ids } }],
        },
        select: { fromStoreId: true, toStoreId: true },
      }),
      storeRefs(scope, ids),
      peopleOf(
        tx,
        stores.map((store) => store.storekeeperId),
      ),
    ]);
    return stores.map((store) => {
      const mine = balances.filter((balance) => balance.storeId === store.id);
      const level = new Map(
        levels
          .filter((entry) => entry.storeId === store.id)
          .map((entry) => [entry.materialId, dec(entry.reorderLevel)]),
      );
      const onHand = new Map(mine.map((balance) => [balance.materialId, dec(balance.quantity)]));
      const low = [...level.entries()].filter(([materialId, reorder]) =>
        isLowStock(onHand.get(materialId) ?? "0", reorder),
      ).length;
      const value = mine.reduce((total, balance) => total + toMicro(dec(balance.valueMinor)), 0n);
      const last = mine
        .map((balance) => balance.lastEntryAt)
        .filter((at): at is Date => at !== null)
        .sort((left, right) => right.getTime() - left.getTime())[0];
      const ref = refs.get(store.id)!;
      return {
        id: store.id,
        name: store.name,
        project: ref.project,
        site: ref.site,
        storekeeper: store.storekeeperId ? personOf(people, store.storekeeperId) : null,
        valueMinor: minorOf(value),
        materialCount: mine.filter((balance) => /[1-9]/.test(dec(balance.quantity))).length,
        lowStockCount: low,
        inTransitIn: transfers.filter((transfer) => transfer.toStoreId === store.id).length,
        inTransitOut: transfers.filter((transfer) => transfer.fromStoreId === store.id).length,
        lastMovementAt: last ? iso(last) : null,
        version: store.version,
      };
    });
  }

  private async lowStock(scope: Scope, stores: StoreRow[]) {
    const { tx, access } = scope;
    const ids = stores.map((store) => store.id);
    if (!ids.length) return [];
    const levels = await tx.stockReorderLevel.findMany({
      where: { tenantId: access.tenantId, storeId: { in: ids } },
      include: { material: true },
    });
    const balances = await tx.stockBalance.findMany({
      where: { tenantId: access.tenantId, storeId: { in: ids } },
    });
    const onHand = new Map(
      balances.map((balance) => [
        `${balance.storeId}:${balance.materialId}`,
        dec(balance.quantity),
      ]),
    );
    const names = new Map(stores.map((store) => [store.id, store.name]));
    return levels
      .map((level) => ({
        store: { id: level.storeId, name: names.get(level.storeId) ?? "—" },
        material: materialWire(level.material),
        quantity: onHand.get(`${level.storeId}:${level.materialId}`) ?? "0",
        reorderLevel: dec(level.reorderLevel),
      }))
      .filter((entry) => isLowStock(entry.quantity, entry.reorderLevel))
      .sort((left, right) => left.material.name.localeCompare(right.material.name));
  }

  async detailOf(scope: Scope, store: StoreRow) {
    const { tx, access } = scope;
    const project = await this.access.on(scope, store.projectId);
    const [summary] = await this.summaries(scope, [store]);
    const [balances, levels, transfers, openTake] = await Promise.all([
      tx.stockBalance.findMany({
        where: { tenantId: access.tenantId, storeId: store.id },
        include: { material: true },
      }),
      tx.stockReorderLevel.findMany({
        where: { tenantId: access.tenantId, storeId: store.id },
        include: { material: true },
      }),
      tx.stockTransfer.findMany({
        where: {
          tenantId: access.tenantId,
          status: "dispatched",
          OR: [{ fromStoreId: store.id }, { toStoreId: store.id }],
        },
        include: { lines: { include: { material: true }, orderBy: { lineNo: "asc" } } },
        orderBy: { dispatchedAt: "asc" },
      }),
      tx.stockTake.findFirst({
        where: {
          tenantId: access.tenantId,
          storeId: store.id,
          status: { in: ["draft", "submitted"] },
        },
        select: { id: true, number: true, status: true },
      }),
    ]);
    const level = new Map(levels.map((entry) => [entry.materialId, dec(entry.reorderLevel)]));
    const rows = new Map(
      balances.map((balance) => [
        balance.materialId,
        {
          material: materialWire(balance.material),
          quantity: dec(balance.quantity),
          valueMinor: dec(balance.valueMinor),
          lastMovementAt: isoOrNull(balance.lastEntryAt),
        },
      ]),
    );
    for (const entry of levels)
      if (!rows.has(entry.materialId))
        rows.set(entry.materialId, {
          material: materialWire(entry.material),
          quantity: "0",
          valueMinor: "0",
          lastMovementAt: null,
        });
    const others = await storeRefs(
      scope,
      transfers.map((transfer) =>
        transfer.fromStoreId === store.id ? transfer.toStoreId : transfer.fromStoreId,
      ),
    );
    const canManage = this.access.can(project, STORES_MANAGE);
    const candidates = canManage ? await this.storekeepers(scope, store.projectId) : [];
    const people = await peopleOf(tx, candidates);
    return storeDetailResponseSchema.parse({
      store: summary,
      balances: [...rows.values()]
        .filter((row) => /[1-9]/.test(row.quantity) || level.has(row.material.id))
        .sort((left, right) => left.material.name.localeCompare(right.material.name))
        .map((row) => {
          const reorder = level.get(row.material.id) ?? null;
          return {
            material: row.material,
            quantity: row.quantity,
            averageUnitCostMinor: averageUnitCost({
              quantity: row.quantity,
              valueMinor: row.valueMinor,
            }),
            valueMinor: minorOf(toMicro(row.valueMinor)),
            reorderLevel: reorder,
            low: isLowStock(row.quantity, reorder),
            lastMovementAt: row.lastMovementAt,
          };
        }),
      inTransit: transfers.map((transfer) => {
        const out = transfer.fromStoreId === store.id;
        return {
          transfer: { id: transfer.id, number: transfer.number, status: transfer.status },
          direction: out ? "out" : "in",
          otherStore: others.get(out ? transfer.toStoreId : transfer.fromStoreId),
          dispatchedAt: iso(transfer.dispatchedAt),
          valueMinor: minorOf(
            transfer.lines.reduce(
              (total, line) => total + toMicro(dec(line.dispatchedValueMinor)),
              0n,
            ),
          ),
          lines: transfer.lines.map((line) => ({
            material: materialWire(line.material),
            baseQuantity: dec(line.baseQuantity),
          })),
        };
      }),
      openStockTake: openTake,
      storekeeperCandidates: candidates.map((id) => personOf(people, id)),
      permissions: {
        canIssue: canManage,
        canWaste: canManage,
        canTransfer: canManage,
        canCount: canManage && !openTake,
        canEditReorderLevels: canManage,
        canEdit: canManage,
      },
    });
  }

  /** Ledger entries with their source document numbers, BQ items, gangs and recorders. */
  async entriesWire(
    scope: Scope,
    rows: (Awaited<ReturnType<Scope["tx"]["stockLedgerEntry"]["findMany"]>>[number] & {
      material: Parameters<typeof materialWire>[0];
    })[],
  ) {
    const { tx, access } = scope;
    const ids = (pick: (row: (typeof rows)[number]) => string | null) => [
      ...new Set(rows.map(pick).filter((id): id is string => id !== null)),
    ];
    const [grns, movements, transfers, takes, gangs, items, people] = await Promise.all([
      tx.grn.findMany({
        where: { tenantId: access.tenantId, id: { in: ids((row) => row.grnId) } },
        select: { id: true, number: true },
      }),
      tx.stockMovement.findMany({
        where: { tenantId: access.tenantId, id: { in: ids((row) => row.movementId) } },
        select: { id: true, number: true },
      }),
      tx.stockTransfer.findMany({
        where: { tenantId: access.tenantId, id: { in: ids((row) => row.transferId) } },
        select: { id: true, number: true },
      }),
      tx.stockTake.findMany({
        where: { tenantId: access.tenantId, id: { in: ids((row) => row.stockTakeId) } },
        select: { id: true, number: true },
      }),
      tx.gang.findMany({
        where: { tenantId: access.tenantId, id: { in: ids((row) => row.gangId) } },
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
      peopleOf(
        tx,
        rows.map((row) => row.recordedBy),
      ),
    ]);
    const numbers = new Map(
      [...grns, ...movements, ...transfers, ...takes].map((entry) => [entry.id, entry.number]),
    );
    const gangById = new Map(gangs.map((gang) => [gang.id, gang]));
    const itemByKey = new Map(items.map((item) => [`${item.versionId}:${item.lineageId}`, item]));
    return rows.map((row) => {
      const [type, sourceId] = row.grnId
        ? (["grn", row.grnId] as const)
        : row.movementId
          ? (["movement", row.movementId] as const)
          : row.transferId
            ? (["transfer", row.transferId] as const)
            : (["stock_take", row.stockTakeId!] as const);
      const item =
        row.bqVersionId && row.bqItemLineageId
          ? itemByKey.get(`${row.bqVersionId}:${row.bqItemLineageId}`)
          : undefined;
      return {
        id: row.id,
        seq: Number(row.seq),
        kind: row.kind as StockEntryKind,
        material: materialWire(row.material),
        quantity: dec(row.quantity),
        unitCostMinor: dec(row.unitCostMinor),
        valueMinor: dec(row.valueMinor),
        balanceQuantity: dec(row.balanceQuantity),
        balanceValueMinor: dec(row.balanceValueMinor),
        businessDate: toCalendarDate(row.businessDate),
        recordedAt: iso(row.recordedAt),
        recordedBy: personOf(people, row.recordedBy),
        source: { type, id: sourceId, number: numbers.get(sourceId) ?? "—" },
        bqItem: item
          ? {
              versionId: item.versionId,
              lineageId: item.lineageId,
              ref: item.ref,
              description: item.description,
              unit: item.unit,
            }
          : null,
        gang: row.gangId ? (gangById.get(row.gangId) ?? null) : null,
        reversesEntryId: row.reversesEntryId,
      };
    });
  }
}
