import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { checkConversionRule, convertQuantity } from "@pm-buddy/domain";
import {
  conversionResponseSchema,
  conversionResultResponseSchema,
  type ConvertQuery,
  type CreateConversionRequest,
} from "@pm-buddy/validation";
import { Ratio } from "@pm-buddy/domain";
import { isCheckViolation } from "../../common/database-errors.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { assertUsableUnit } from "./catalogue.service.js";
import { businessToday, CatalogueStore, nextId } from "./catalogue-store.js";
import {
  procurementBadRequest,
  procurementConflict,
  procurementProblem,
  ProcurementAccess,
} from "./procurement-access.js";
import {
  fromCalendarDate,
  peopleOf,
  supplierRef,
  toCalendarDate,
  toConversion,
  toRule,
  unitDefinitions,
  type ConversionRow,
  type Ref,
} from "./procurement-mappers.js";
import type { Scope } from "../identity/access-policy.js";

/**
 * Explicit, effective-dated unit conversions per material (optionally per supplier) and the
 * conversion calculator (D5.1, brief §15 G). Factors are never edited: a new factor for the same
 * unit pair and scope ends the one in force on its start date; the database refuses overlaps.
 */
@Injectable()
export class ConversionsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: ProcurementAccess,
    private readonly store: CatalogueStore,
  ) {}

  private async wire(scope: Scope, row: ConversionRow) {
    const people = await peopleOf(scope.tx, [row.createdBy, row.endedBy]);
    const suppliers = new Map<string, Ref>();
    if (row.supplierId)
      suppliers.set(row.supplierId, supplierRef(await this.store.supplier(scope, row.supplierId)));
    const rule = toRule(row);
    const ratio = Ratio.fromQuantities(rule.fromQuantity, rule.toQuantity);
    return conversionResponseSchema.parse({
      conversion: toConversion(row, {
        people,
        suppliers,
        on: businessToday(),
        factor: ratio.toDecimal(12).value,
        ratio: ratio.toString(),
      }),
    });
  }

  create(principal: Principal, materialId: string, input: CreateConversionRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          await this.access.manager(scope);
          return this.wire(scope, await this.createInScope(scope, materialId, input));
        },
        true,
      )
      .catch((error: unknown) => {
        if (isCheckViolation(error))
          throw procurementConflict(
            "conversion-overlap",
            "Another factor for these units is in force on these dates",
          );
        throw error;
      });
  }

  /** Adds a factor, ending the one in force for the same pair (permission checked by caller). */
  async createInScope(scope: Scope, materialId: string, input: CreateConversionRequest) {
    const { tx, access } = scope;
    const material = await this.store.lockMaterial(scope, materialId);
    if (material.status !== "active")
      throw procurementConflict("material-archived", "The material is archived");
    if (input.supplierId) await this.store.supplier(scope, input.supplierId);
    const units = await this.store.customUnits(scope);
    assertUsableUnit(input.fromUnit, units);
    assertUsableUnit(input.toUnit, units);
    const check = checkConversionRule(input, unitDefinitions(units));
    if (!check.ok) {
      if (check.issue === "unknown-unit")
        throw procurementProblem(422, "unit-unknown", "Unknown unit");
      if (check.issue === "same-unit")
        throw procurementBadRequest("same-unit", "A conversion needs two different units");
      if (check.issue === "standard-conversion-exists")
        throw procurementConflict(
          "standard-conversion-exists",
          "These units already convert by a standard factor",
        );
      throw procurementBadRequest("invalid-quantity", "Quantities must be positive");
    }
    const effectiveFrom = input.effectiveFrom ?? businessToday();
    // The factor in force for the same pair and scope ends where the new one starts.
    const current = await tx.unitConversion.findFirst({
      where: {
        tenantId: access.tenantId,
        materialId,
        supplierId: input.supplierId,
        pairKey: check.pairKey,
        effectiveTo: null,
      },
    });
    if (current) {
      if (toCalendarDate(current.effectiveFrom) >= effectiveFrom)
        throw procurementConflict(
          "conversion-overlap",
          "A factor for these units starts on or after this date; end it first",
        );
      await tx.unitConversion.update({
        where: { tenantId_id: { tenantId: access.tenantId, id: current.id } },
        data: {
          effectiveTo: fromCalendarDate(effectiveFrom),
          endedBy: access.userId,
          endedAt: new Date(),
        },
      });
    }
    const id = nextId();
    const row = await tx.unitConversion.create({
      data: {
        id,
        tenantId: access.tenantId,
        materialId,
        supplierId: input.supplierId,
        fromUnit: input.fromUnit,
        fromQuantity: input.fromQuantity,
        toUnit: input.toUnit,
        toQuantity: input.toQuantity,
        pairKey: check.pairKey,
        effectiveFrom: fromCalendarDate(effectiveFrom),
        note: input.note ?? null,
        createdBy: access.userId,
      },
    });
    await this.scope.audit(tx, "unit_conversion.created", id, {
      materialId,
      supplierId: input.supplierId,
      fromUnit: input.fromUnit,
      toUnit: input.toUnit,
      effectiveFrom,
      replaced: current?.id ?? null,
    });
    return row;
  }

  end(
    principal: Principal,
    materialId: string,
    conversionId: string,
    effectiveTo: string,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.access.manager(scope);
        await this.store.lockMaterial(scope, materialId);
        const row = await tx.unitConversion.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: conversionId } },
        });
        if (!row || row.materialId !== materialId)
          throw new NotFoundException("Conversion not found");
        if (row.effectiveTo) throw procurementConflict("conversion-ended", "Already ended");
        if (effectiveTo <= toCalendarDate(row.effectiveFrom))
          throw procurementBadRequest(
            "conversion-end-invalid",
            "The end date must be after the start date",
          );
        const updated = await tx.unitConversion.update({
          where: { tenantId_id: { tenantId: access.tenantId, id: conversionId } },
          data: {
            effectiveTo: fromCalendarDate(effectiveTo),
            endedBy: access.userId,
            endedAt: new Date(),
          },
        });
        await this.scope.audit(tx, "unit_conversion.ended", conversionId, {
          materialId,
          effectiveTo,
        });
        return this.wire(scope, updated);
      },
      true,
    );
  }

  /** The calculator: 422 with the refusal code when a quantity cannot be converted. */
  calculate(principal: Principal, query: ConvertQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.viewer(scope);
      const material = query.materialId ? await this.store.material(scope, query.materialId) : null;
      if (query.supplierId) await this.store.supplier(scope, query.supplierId);
      const on = query.on ?? businessToday();
      const context = await this.store.context(scope, material, query.supplierId ?? null, on);
      const result = convertQuantity(query.quantity, query.from, query.to, context);
      if (!result.ok) {
        const code = result.reason === "unknown-unit" ? "unit-unknown" : result.reason;
        throw procurementProblem(422, code, `Cannot convert: ${result.reason}`);
      }
      return conversionResultResponseSchema.parse({
        result: {
          input: query.quantity,
          from: query.from,
          to: query.to,
          quantity: result.quantity,
          exact: result.exact,
          factor: result.ratio.toDecimal(12).value,
          ratio: result.ratio.toString(),
          on,
          steps: result.steps,
        },
      });
    });
  }
}
