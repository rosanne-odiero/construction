import { Injectable, NotFoundException } from "@nestjs/common";
import { nairobiDate, type ConversionContext } from "@pm-buddy/domain";
import { DEFAULT_PRICE_CHANGE_ALERT_PERCENT, type MaterialCategory } from "@pm-buddy/types";
import { uuidv7 } from "../../common/uuid.js";
import type { Scope } from "../identity/access-policy.js";
import {
  attributesOf,
  toRule,
  unitDefinitions,
  type MaterialRow,
  type SupplierRow,
  type Tx,
  type UnitRow,
} from "./procurement-mappers.js";

// Up to 12 digits keeps the arithmetic exact and the prefix plus number within VARCHAR(20).
const MATERIAL_CODE = /^MAT-(\d{1,12})$/;
const SUPPLIER_CODE = /^SUP-(\d{1,12})$/;

const nextCode = (codes: readonly string[], pattern: RegExp, prefix: string) => {
  const highest = codes.reduce((max, code) => {
    const match = pattern.exec(code);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${prefix}${String(highest + 1).padStart(4, "0")}`;
};

/** The next MAT-NNNN code in the company (the tenant lock serialises concurrent creates). */
export async function nextMaterialCode(tx: Tx, tenantId: string): Promise<string> {
  const rows = await tx.material.findMany({
    where: { tenantId, code: { startsWith: "MAT-" } },
    select: { code: true },
  });
  return nextCode(
    rows.map((row) => row.code),
    MATERIAL_CODE,
    "MAT-",
  );
}

/** The next SUP-NNNN code in the company. */
export async function nextSupplierCode(tx: Tx, tenantId: string): Promise<string> {
  const rows = await tx.supplier.findMany({
    where: { tenantId, code: { startsWith: "SUP-" } },
    select: { code: true },
  });
  return nextCode(
    rows.map((row) => row.code),
    SUPPLIER_CODE,
    "SUP-",
  );
}

let lastIdMs = 0;
/**
 * A UUIDv7 whose timestamp is strictly greater than the previous one from this process, so lists
 * ordered by ID (materials, suppliers, alerts) follow creation order even within one millisecond.
 */
export function nextId(): string {
  lastIdMs = Math.max(Date.now(), lastIdMs + 1);
  return uuidv7(lastIdMs);
}

/** Today's business date (Africa/Nairobi). */
export const businessToday = () => nairobiDate();

/** Shared lookups for the catalogue, conversion and price services (inside the tenant scope). */
@Injectable()
export class CatalogueStore {
  async material(scope: Scope, materialId: string): Promise<MaterialRow> {
    const row = await scope.tx.material.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: materialId } },
    });
    if (!row) throw new NotFoundException("Material not found");
    return row;
  }

  /** Locks the material row: conversions and prices of one material are written one at a time. */
  async lockMaterial(scope: Scope, materialId: string): Promise<MaterialRow> {
    await scope.tx
      .$queryRaw`SELECT id FROM materials WHERE tenant_id = ${scope.access.tenantId}::uuid
      AND id = ${materialId}::uuid FOR UPDATE`;
    return this.material(scope, materialId);
  }

  async supplier(scope: Scope, supplierId: string): Promise<SupplierRow> {
    const row = await scope.tx.supplier.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: supplierId } },
    });
    if (!row) throw new NotFoundException("Supplier not found");
    return row;
  }

  customUnits(scope: Scope): Promise<UnitRow[]> {
    return scope.tx.unit.findMany({
      where: { tenantId: scope.access.tenantId },
      orderBy: { code: "asc" },
    });
  }

  /** The company's price-change alert threshold (percent, decimal string). */
  async threshold(scope: Scope): Promise<string> {
    const row = await scope.tx.procurementSettings.findUnique({
      where: { tenantId: scope.access.tenantId },
    });
    return row ? row.priceChangeAlertPercent.toFixed() : DEFAULT_PRICE_CHANGE_ALERT_PERCENT;
  }

  /** The conversion context for a material (its factors and the company's units) on a date. */
  async context(
    scope: Scope,
    material: MaterialRow | null,
    supplierId: string | null,
    on: string,
    units?: UnitRow[],
  ): Promise<ConversionContext> {
    const rows = material
      ? await scope.tx.unitConversion.findMany({
          where: { tenantId: scope.access.tenantId, materialId: material.id },
        })
      : [];
    return {
      on,
      supplierId,
      customUnits: unitDefinitions(units ?? (await this.customUnits(scope))),
      material: material
        ? { category: material.category as MaterialCategory, attributes: attributesOf(material) }
        : null,
      rules: rows.map(toRule),
    };
  }
}
