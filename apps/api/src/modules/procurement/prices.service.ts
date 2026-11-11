import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { comparableUnitPrice, exactNetPrice, priceChange, splitVat } from "@pm-buddy/domain";
import { BQ_VAT_RULE, type PriceAlertState, type PriceSource } from "@pm-buddy/types";
import {
  priceAlertsResponseSchema,
  priceResponseSchema,
  type CorrectPriceRequest,
  type RecordPriceRequest,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../common/database-errors.js";
import { AppConfig } from "../../config/app-config.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { assertUsableUnit } from "./catalogue.service.js";
import { CatalogueStore, nextId } from "./catalogue-store.js";
import { procurementConflict, ProcurementAccess } from "./procurement-access.js";
import {
  fromCalendarDate,
  materialRef,
  peopleOf,
  supplierRef,
  toPrice,
  type PriceRow,
} from "./procurement-mappers.js";

/**
 * Price history (D5.1, brief §5.3): append-only prices per material and supplier, VAT net and
 * gross from the configured rate (CR-TAX-01), a comparable net price per base unit through the
 * conversion engine (supplier factors first) and a price-change alert against the previous
 * comparable price of the same material and supplier. Corrections are new rows.
 */
@Injectable()
export class PricesService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: ProcurementAccess,
    private readonly store: CatalogueStore,
    private readonly config: AppConfig,
  ) {}

  private async wire(scope: Scope, row: PriceRow) {
    const [material, supplier, people, corrected] = await Promise.all([
      this.store.material(scope, row.materialId),
      this.store.supplier(scope, row.supplierId),
      peopleOf(scope.tx, [row.recordedBy]),
      scope.tx.materialPrice.findFirst({
        where: { tenantId: scope.access.tenantId, correctsPriceId: row.id },
        select: { id: true },
      }),
    ]);
    return toPrice(row, {
      people,
      material: materialRef(material),
      supplier: supplierRef(supplier),
      correctedById: corrected?.id ?? null,
    });
  }

  /**
   * Writes a price (or a correction) under the material row lock; the permission is checked by
   * the caller. D5.2 quotations write `source = quotation` rows the same way (append-only, with
   * the same comparison and alert).
   */
  async recordInScope(
    scope: Scope,
    materialId: string,
    input: RecordPriceRequest,
    correction: { priceId: string; reason: string } | null,
    source: PriceSource = "manual",
  ) {
    const { tx, access } = scope;
    const material = await this.store.lockMaterial(scope, materialId);
    if (material.status !== "active")
      throw procurementConflict("material-archived", "The material is archived");
    await this.store.supplier(scope, input.supplierId);
    const units = await this.store.customUnits(scope);
    assertUsableUnit(input.unit, units);
    if (correction) {
      const target = await tx.materialPrice.findUnique({
        where: { tenantId_id: { tenantId: access.tenantId, id: correction.priceId } },
        include: { correctedBy: { select: { id: true } } },
      });
      if (!target || target.materialId !== materialId)
        throw new NotFoundException("Price not found");
      if (target.correctedBy.length)
        throw procurementConflict("price-already-corrected", "This price was already corrected");
    }

    const rate = this.config.get("BQ_VAT_RATE_PERCENT");
    const vat = splitVat(input.unitPriceMinor, input.vatTreatment, rate);
    const threshold = await this.store.threshold(scope);
    const context = await this.store.context(
      scope,
      material,
      input.supplierId,
      input.effectiveOn,
      units,
    );
    const comparable = comparableUnitPrice(
      exactNetPrice(input.unitPriceMinor, input.vatTreatment, rate),
      input.unit,
      material.baseUnit,
      context,
    );

    let state: PriceAlertState = "not_comparable";
    let previousId: string | null = null;
    let percent: string | null = null;
    if (comparable.ok) {
      // The latest earlier-or-same-day comparable price of this material and supplier that has
      // not been corrected (and is not the one being corrected).
      const previous = await tx.materialPrice.findFirst({
        where: {
          tenantId: access.tenantId,
          materialId,
          supplierId: input.supplierId,
          comparableUnit: material.baseUnit,
          comparableUnitPriceMinor: { not: null },
          effectiveOn: { lte: fromCalendarDate(input.effectiveOn) },
          correctedBy: { none: {} },
          ...(correction ? { id: { not: correction.priceId } } : {}),
        },
        orderBy: [{ effectiveOn: "desc" }, { recordedAt: "desc" }, { id: "desc" }],
      });
      if (!previous) state = "first_price";
      else {
        const change = priceChange(
          previous.comparableUnitPriceMinor!.toFixed(),
          comparable.valueMinor,
          threshold,
        );
        if (change) {
          state = change.state;
          previousId = previous.id;
          percent = change.percent;
        }
      }
    }

    const id = nextId();
    const row = await tx.materialPrice.create({
      data: {
        id,
        tenantId: access.tenantId,
        materialId,
        supplierId: input.supplierId,
        unit: input.unit,
        unitPriceMinor: BigInt(input.unitPriceMinor),
        vatTreatment: input.vatTreatment,
        vatRatePercent: vat.ratePercent,
        vatRuleStatus: vat.ratePercent === null ? null : BQ_VAT_RULE.status,
        netUnitPriceMinor: BigInt(vat.netMinor),
        grossUnitPriceMinor: BigInt(vat.grossMinor),
        effectiveOn: fromCalendarDate(input.effectiveOn),
        source,
        sourceReference: input.sourceReference ?? null,
        note: input.note ?? null,
        comparableUnit: comparable.ok ? material.baseUnit : null,
        comparableUnitPriceMinor: comparable.ok ? comparable.valueMinor : null,
        conversionSnapshot: comparable.ok
          ? (JSON.parse(
              JSON.stringify({ ratio: comparable.ratio.toString(), steps: comparable.steps }),
            ) as Prisma.InputJsonValue)
          : undefined,
        previousPriceId: previousId,
        changePercent: percent,
        alertState: state,
        alertThresholdPercent: threshold,
        correctsPriceId: correction?.priceId ?? null,
        correctionReason: correction?.reason ?? null,
        recordedBy: access.userId,
      },
    });
    // Amounts stay out of the audit log; the alert outcome is recorded.
    await this.scope.audit(
      tx,
      correction ? "material_price.corrected" : "material_price.recorded",
      id,
      {
        materialId,
        supplierId: input.supplierId,
        unit: input.unit,
        vatTreatment: input.vatTreatment,
        alertState: state,
        correctsPriceId: correction?.priceId ?? null,
        source,
      },
    );
    return priceResponseSchema.parse({ price: await this.wire(scope, row) });
  }

  record(principal: Principal, materialId: string, input: RecordPriceRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.access.manager(scope);
        return this.recordInScope(scope, materialId, input, null);
      },
      true,
    );
  }

  correct(
    principal: Principal,
    materialId: string,
    priceId: string,
    input: CorrectPriceRequest,
    req: Request,
  ) {
    const { reason, ...fields } = input;
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          await this.access.manager(scope);
          return this.recordInScope(scope, materialId, fields, { priceId, reason });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw procurementConflict("price-already-corrected", "This price was already corrected");
        throw error;
      });
  }

  /** Prices above the change threshold that have not been corrected, newest first. */
  alerts(principal: Principal, query: { cursor?: string; limit: number }, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      await this.access.viewer(scope);
      const rows = await tx.materialPrice.findMany({
        where: {
          tenantId: access.tenantId,
          alertState: "above_threshold",
          correctedBy: { none: {} },
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        orderBy: { id: "desc" },
        take: query.limit + 1,
        include: {
          material: { select: { id: true, code: true, name: true } },
          supplier: { select: { id: true, code: true, legalName: true, tradingName: true } },
        },
      });
      const page = rows.slice(0, query.limit);
      const people = await peopleOf(
        tx,
        page.map((row) => row.recordedBy),
      );
      return priceAlertsResponseSchema.parse({
        alerts: page.map((row) =>
          toPrice(row, {
            people,
            material: materialRef(row.material),
            supplier: supplierRef(row.supplier),
            correctedById: null,
          }),
        ),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
        },
        priceChangeAlertPercent: await this.store.threshold(scope),
      });
    });
  }
}
