import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { defineCustomUnit, STANDARD_UNITS } from "@pm-buddy/domain";
import {
  DEFAULT_BLOCK_PAYMENT_WITHOUT_ETIMS,
  DEFAULT_MIN_QUOTES,
  DEFAULT_PRICE_TOLERANCE_PERCENT,
  DEFAULT_QTY_TOLERANCE_PERCENT,
  PROCUREMENT_LIMITS,
  type MaterialCategory,
  type UnitDimension,
} from "@pm-buddy/types";
import {
  attributeIssues,
  loadDefaultsResponseSchema,
  materialDetailResponseSchema,
  materialResponseSchema,
  materialsResponseSchema,
  procurementSettingsResponseSchema,
  unitResponseSchema,
  unitsResponseSchema,
  type CreateMaterialRequest,
  type CreateUnitRequest,
  type MaterialAttributesInput,
  type MaterialListQuery,
  type UpdateProcurementSettingsRequest,
  type UpdateMaterialRequest,
} from "@pm-buddy/validation";
import { Ratio } from "@pm-buddy/domain";
import { isUniqueViolation } from "../../common/database-errors.js";
import { AppConfig } from "../../config/app-config.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { businessToday, CatalogueStore, nextMaterialCode, nextId } from "./catalogue-store.js";
import {
  procurementBadRequest,
  procurementConflict,
  procurementProblem,
  ProcurementAccess,
  versionConflict,
} from "./procurement-access.js";
import {
  changedFields,
  derivedFactors,
  materialRef,
  peopleOf,
  personOf,
  standardUnitWire,
  supplierRef,
  toConversion,
  toMaterial,
  toPrice,
  toRule,
  toUnitWire,
  unitKnown,
  type MaterialRow,
  type Ref,
  type UnitRow,
} from "./procurement-mappers.js";
import { loadStarterCatalogue } from "./starter-catalogue.js";

/** Checks a unit is known and usable for new records (422 unknown, 409 archived). */
export function assertUsableUnit(code: string, units: readonly UnitRow[]) {
  if (unitKnown(code, units)) return;
  if (unitKnown(code, units, false))
    throw procurementConflict("unit-archived", `The unit ${code} is archived`);
  throw procurementProblem(422, "unit-unknown", `Unknown unit ${code}`);
}

/**
 * The material catalogue (D5.1): materials with Kenyan base units and category attributes, the
 * Kenyan starter catalogue, company units and procurement settings. Every operation runs in the
 * caller's company transaction and authorises through ProcurementAccess; changes are audited with
 * field names only.
 */
@Injectable()
export class CatalogueService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: ProcurementAccess,
    private readonly store: CatalogueStore,
    private readonly config: AppConfig,
  ) {}

  /** Latest prices and open alert counts for a page of materials. */
  private async summaries(scope: Scope, rows: MaterialRow[]) {
    const { tx, access } = scope;
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const [latest, alerts] = await Promise.all([
      tx.materialPrice.findMany({
        where: { tenantId: access.tenantId, materialId: { in: ids }, correctedBy: { none: {} } },
        orderBy: [{ effectiveOn: "desc" }, { recordedAt: "desc" }, { id: "desc" }],
        distinct: ["materialId"],
        include: {
          supplier: { select: { id: true, code: true, legalName: true, tradingName: true } },
        },
      }),
      tx.materialPrice.findMany({
        where: {
          tenantId: access.tenantId,
          materialId: { in: ids },
          alertState: "above_threshold",
          correctedBy: { none: {} },
        },
        select: { materialId: true },
      }),
    ]);
    const latestBy = new Map(latest.map((price) => [price.materialId, price]));
    const alertCount = new Map<string, number>();
    for (const alert of alerts)
      alertCount.set(alert.materialId, (alertCount.get(alert.materialId) ?? 0) + 1);
    return rows.map((row) => {
      const price = latestBy.get(row.id);
      return toMaterial(row, {
        latest: price ? { ...price, supplier: supplierRef(price.supplier) } : null,
        alertCount: alertCount.get(row.id) ?? 0,
      });
    });
  }

  list(principal: Principal, query: MaterialListQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.viewer(scope);
      const filters: Prisma.MaterialWhereInput[] = [{ tenantId: scope.access.tenantId }];
      if (query.category) filters.push({ category: query.category });
      if (query.status) filters.push({ status: query.status });
      if (query.search) {
        const contains = { contains: query.search, mode: "insensitive" as const };
        filters.push({
          OR: [{ code: contains }, { name: contains }, { nameSw: contains }, { spec: contains }],
        });
      }
      if (query.cursor) filters.push({ id: { gt: query.cursor } });
      const rows = await scope.tx.material.findMany({
        where: { AND: filters },
        orderBy: { id: "asc" },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      return materialsResponseSchema.parse({
        materials: await this.summaries(scope, page),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
        },
        permissions: { canManage: this.access.canManage(scope) },
      });
    });
  }

  private assertAttributes(category: string, attributes: MaterialAttributesInput) {
    const issues = attributeIssues(category as MaterialCategory, attributes);
    if (issues.length)
      throw procurementBadRequest(
        "attribute-not-allowed",
        `These attributes do not apply to ${category}: ${issues.join(", ")}`,
      );
  }

  private nameTaken = (error: unknown) => {
    if (isUniqueViolation(error))
      throw procurementConflict("material-name-taken", "Another material has this name");
    throw error;
  };

  create(principal: Principal, input: CreateMaterialRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          await this.access.manager(scope);
          assertUsableUnit(input.baseUnit, await this.store.customUnits(scope));
          this.assertAttributes(input.category, input.attributes);
          const id = nextId();
          const code = await nextMaterialCode(tx, access.tenantId);
          const row = await tx.material.create({
            data: {
              id,
              tenantId: access.tenantId,
              code,
              name: input.name,
              nameSw: input.nameSw ?? null,
              category: input.category,
              baseUnit: input.baseUnit,
              spec: input.spec ?? null,
              attributes: input.attributes as Prisma.InputJsonValue,
              notes: input.notes ?? null,
              createdBy: access.userId,
              updatedBy: access.userId,
            },
          });
          await this.scope.audit(tx, "material.created", id, {
            code,
            category: input.category,
            baseUnit: input.baseUnit,
            fields: changedFields(input),
          });
          const [material] = await this.summaries(scope, [row]);
          return materialResponseSchema.parse({ material });
        },
        true,
      )
      .catch(this.nameTaken);
  }

  get(principal: Principal, materialId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.viewer(scope);
      return this.detail(scope, materialId);
    });
  }

  async detail(scope: Scope, materialId: string) {
    const { tx, access } = scope;
    const row = await this.store.material(scope, materialId);
    const [conversions, prices] = await Promise.all([
      tx.unitConversion.findMany({
        where: { tenantId: access.tenantId, materialId },
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
      }),
      tx.materialPrice.findMany({
        where: { tenantId: access.tenantId, materialId },
        orderBy: [{ effectiveOn: "desc" }, { recordedAt: "desc" }, { id: "desc" }],
        take: 200,
        include: { correctedBy: { select: { id: true } } },
      }),
    ]);
    const supplierIds = [
      ...new Set([
        ...conversions.map((conversion) => conversion.supplierId).filter(Boolean),
        ...prices.map((price) => price.supplierId),
      ]),
    ] as string[];
    const suppliers = await tx.supplier.findMany({
      where: { tenantId: access.tenantId, id: { in: supplierIds } },
      select: { id: true, code: true, legalName: true, tradingName: true },
      orderBy: { code: "asc" },
    });
    const refs = new Map<string, Ref>(
      suppliers.map((supplier) => [supplier.id, supplierRef(supplier)]),
    );
    const people = await peopleOf(tx, [
      ...conversions.flatMap((conversion) => [conversion.createdBy, conversion.endedBy]),
      ...prices.map((price) => price.recordedBy),
    ]);
    const on = businessToday();
    const [material] = await this.summaries(scope, [row]);
    return materialDetailResponseSchema.parse({
      material,
      conversions: conversions.map((conversion) => {
        const rule = toRule(conversion);
        const ratio = Ratio.fromQuantities(rule.fromQuantity, rule.toQuantity);
        return toConversion(conversion, {
          people,
          suppliers: refs,
          on,
          factor: ratio.toDecimal(12).value,
          ratio: ratio.toString(),
        });
      }),
      standardConversions: derivedFactors(row),
      prices: prices.map((price) =>
        toPrice(price, {
          people,
          material: materialRef(row),
          supplier: refs.get(price.supplierId)!,
          correctedById: price.correctedBy[0]?.id ?? null,
        }),
      ),
      suppliers: [...refs.values()],
      priceChangeAlertPercent: await this.store.threshold(scope),
      vatRatePercent: this.config.get("BQ_VAT_RATE_PERCENT"),
      permissions: { canManage: this.access.canManage(scope) },
    });
  }

  update(principal: Principal, materialId: string, input: UpdateMaterialRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          await this.access.manager(scope);
          const row = await this.store.lockMaterial(scope, materialId);
          if (row.version !== input.version) throw versionConflict();
          const { version, ...fields } = input;
          if (fields.baseUnit !== undefined && fields.baseUnit !== row.baseUnit) {
            assertUsableUnit(fields.baseUnit, await this.store.customUnits(scope));
            const priced = await tx.materialPrice.count({
              where: { tenantId: access.tenantId, materialId },
            });
            if (priced)
              throw procurementConflict(
                "base-unit-fixed",
                "The base unit is fixed once the material has prices",
              );
          }
          const category = fields.category ?? row.category;
          const attributes =
            fields.attributes ??
            (fields.category && fields.category !== row.category
              ? {}
              : (row.attributes as MaterialAttributesInput));
          this.assertAttributes(category, attributes);
          const updated = await tx.material.updateMany({
            where: { tenantId: access.tenantId, id: materialId, version },
            data: {
              ...(fields.name !== undefined ? { name: fields.name } : {}),
              ...(fields.nameSw !== undefined ? { nameSw: fields.nameSw } : {}),
              ...(fields.category !== undefined ? { category: fields.category } : {}),
              ...(fields.baseUnit !== undefined ? { baseUnit: fields.baseUnit } : {}),
              ...(fields.spec !== undefined ? { spec: fields.spec } : {}),
              ...(fields.notes !== undefined ? { notes: fields.notes } : {}),
              ...(fields.status !== undefined ? { status: fields.status } : {}),
              attributes: attributes as Prisma.InputJsonValue,
              version: { increment: 1 },
              updatedBy: access.userId,
              updatedAt: new Date(),
            },
          });
          if (!updated.count) throw versionConflict();
          await this.scope.audit(tx, "material.updated", materialId, {
            fields: changedFields(fields),
            version: version + 1,
          });
          const [material] = await this.summaries(scope, [
            await this.store.material(scope, materialId),
          ]);
          return materialResponseSchema.parse({ material });
        },
        true,
      )
      .catch(this.nameTaken);
  }

  loadDefaults(principal: Principal, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.access.manager(scope);
        const summary = await loadStarterCatalogue(
          scope.tx,
          scope.access.tenantId,
          scope.access.userId,
          businessToday(),
        );
        await this.scope.audit(
          scope.tx,
          "materials.defaults_loaded",
          scope.access.tenantId,
          summary,
        );
        return loadDefaultsResponseSchema.parse(summary);
      },
      true,
      30_000,
    );
  }

  // Units -------------------------------------------------------------------------------------

  units(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.viewer(scope);
      const custom = await this.store.customUnits(scope);
      return unitsResponseSchema.parse({
        units: [...STANDARD_UNITS.map(standardUnitWire), ...custom.map(toUnitWire)],
        permissions: { canManage: this.access.canManage(scope) },
      });
    });
  }

  createUnit(principal: Principal, input: CreateUnitRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          await this.access.manager(scope);
          // The tenant row is locked for mutations, so the count cannot race another create.
          const existing = await tx.unit.count({ where: { tenantId: access.tenantId } });
          if (existing >= PROCUREMENT_LIMITS.customUnitsPerTenant)
            throw procurementConflict(
              "unit-limit",
              `A company can have at most ${PROCUREMENT_LIMITS.customUnitsPerTenant} units of its own`,
            );
          const check = defineCustomUnit({
            code: input.code,
            dimension: input.dimension as UnitDimension,
            equalsQuantity: input.equalsQuantity,
            equalsUnit: input.equalsUnit,
          });
          if (!check.ok) {
            if (check.issue === "standard-code")
              throw procurementConflict("unit-code-taken", "This is a standard unit code");
            throw procurementBadRequest("unit-invalid", `Invalid unit size (${check.issue})`);
          }
          const id = nextId();
          const row = await tx.unit.create({
            data: {
              id,
              tenantId: access.tenantId,
              code: input.code,
              name: input.name,
              nameSw: input.nameSw ?? null,
              dimension: input.dimension,
              equalsQuantity: input.equalsQuantity,
              equalsUnit: input.equalsUnit,
              createdBy: access.userId,
              updatedBy: access.userId,
            },
          });
          await this.scope.audit(tx, "unit.created", id, {
            code: input.code,
            dimension: input.dimension,
          });
          return unitResponseSchema.parse({ unit: toUnitWire(row) });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw procurementConflict("unit-code-taken", "Another unit has this code");
        throw error;
      });
  }

  updateUnit(
    principal: Principal,
    unitId: string,
    input: { version: number; status: "active" | "archived" },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.access.manager(scope);
        const row = await tx.unit.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: unitId } },
        });
        if (!row) throw new NotFoundException("Unit not found");
        const updated = await tx.unit.updateMany({
          where: { tenantId: access.tenantId, id: unitId, version: input.version },
          data: {
            status: input.status,
            version: { increment: 1 },
            updatedBy: access.userId,
            updatedAt: new Date(),
          },
        });
        if (!updated.count) throw versionConflict();
        await this.scope.audit(tx, "unit.updated", unitId, { status: input.status });
        const fresh = await tx.unit.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: access.tenantId, id: unitId } },
        });
        return unitResponseSchema.parse({ unit: toUnitWire(fresh) });
      },
      true,
    );
  }

  // Settings ----------------------------------------------------------------------------------

  private async settingsView(scope: Scope) {
    const row = await scope.tx.procurementSettings.findUnique({
      where: { tenantId: scope.access.tenantId },
    });
    const people = await peopleOf(scope.tx, [row?.updatedBy]);
    return procurementSettingsResponseSchema.parse({
      settings: {
        priceChangeAlertPercent: await this.store.threshold(scope),
        minQuotes: row?.minQuotes ?? DEFAULT_MIN_QUOTES,
        qtyTolerancePercent: row
          ? row.qtyTolerancePercent.toFixed()
          : DEFAULT_QTY_TOLERANCE_PERCENT,
        priceTolerancePercent: row
          ? row.priceTolerancePercent.toFixed()
          : DEFAULT_PRICE_TOLERANCE_PERCENT,
        blockPaymentWithoutEtims:
          row?.blockPaymentWithoutEtims ?? DEFAULT_BLOCK_PAYMENT_WITHOUT_ETIMS,
        version: row?.version ?? 0,
        updatedAt: row ? row.updatedAt.toISOString() : null,
        updatedBy: row ? personOf(people, row.updatedBy) : null,
      },
      permissions: { canManage: scope.access.permissions.has("config.manage") },
    });
  }

  settings(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.viewer(scope);
      return this.settingsView(scope);
    });
  }

  updateSettings(principal: Principal, input: UpdateProcurementSettingsRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.access.settingsManager(scope);
        const row = await tx.procurementSettings.findUnique({
          where: { tenantId: access.tenantId },
        });
        if ((row?.version ?? 0) !== input.version) throw versionConflict();
        // D5.2 settings: omitted ones keep their value (or the default before the first save).
        const p2p = {
          ...(input.minQuotes !== undefined ? { minQuotes: input.minQuotes } : {}),
          ...(input.qtyTolerancePercent !== undefined
            ? { qtyTolerancePercent: input.qtyTolerancePercent }
            : {}),
          ...(input.priceTolerancePercent !== undefined
            ? { priceTolerancePercent: input.priceTolerancePercent }
            : {}),
          ...(input.blockPaymentWithoutEtims !== undefined
            ? { blockPaymentWithoutEtims: input.blockPaymentWithoutEtims }
            : {}),
        };
        if (!row)
          await tx.procurementSettings.create({
            data: {
              tenantId: access.tenantId,
              priceChangeAlertPercent: input.priceChangeAlertPercent,
              ...p2p,
              updatedBy: access.userId,
            },
          });
        else {
          const updated = await tx.procurementSettings.updateMany({
            where: { tenantId: access.tenantId, version: input.version },
            data: {
              priceChangeAlertPercent: input.priceChangeAlertPercent,
              ...p2p,
              version: { increment: 1 },
              updatedBy: access.userId,
              updatedAt: new Date(),
            },
          });
          if (!updated.count) throw versionConflict();
        }
        await this.scope.audit(tx, "procurement.settings_updated", access.tenantId, {
          fields: Object.keys(input).filter((field) => field !== "version"),
        });
        return this.settingsView(scope);
      },
      true,
    );
  }
}
