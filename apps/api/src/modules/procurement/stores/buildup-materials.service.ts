import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { convertQuantity, nairobiDate, Ratio } from "@pm-buddy/domain";
import {
  buildupMaterialsResponseSchema,
  type BuildupMaterialMappingRequest,
} from "@pm-buddy/validation";
import type { Prisma } from "../../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../../identity/access-policy.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { assertUsableUnit } from "../catalogue.service.js";
import { CatalogueStore } from "../catalogue-store.js";
import { iso, materialWire } from "../p2p/p2p-common.js";
import { peopleOf, personOf } from "../procurement-mappers.js";
import { dec, decOrNull, storesConflict, storesProblem } from "./stores-common.js";
import { refuseClientPortalMember } from "../../portals/client/client-portal-access.js";

/**
 * Maps the material lines of a rate build-up version to catalogue materials (D5.3) so theoretical
 * consumption can be expressed in the material's base unit. Build-up versions and lines stay
 * immutable (D2.3): a mapping is a separate row keyed by the version's line, naming the material
 * and the catalogue unit the line's quantity is in ("bag (50 kg)" → `bag_50kg`), with the exact
 * base units per that unit from the D5.1 conversion engine (snapshotted with its steps).
 * Re-mapping stamps the previous mapping unmapped; nothing is deleted. Like the library itself,
 * reading needs bq.view and mapping bq.edit, company-wide or on at least one assigned project.
 */
@Injectable()
export class BuildupMaterialsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
    private readonly catalogue: CatalogueStore,
  ) {}

  list(principal: Principal, buildupId: string, versionNo: number, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.policy.requireSomewhere(scope, "bq.view");
      refuseClientPortalMember(scope);
      return this.view(scope, await this.version(scope, buildupId, versionNo));
    });
  }

  map(
    principal: Principal,
    buildupId: string,
    versionNo: number,
    lineId: string,
    input: BuildupMaterialMappingRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.policy.requireSomewhere(scope, "bq.edit");
        const version = await this.version(scope, buildupId, versionNo);
        const line = version.lines.find((entry) => entry.id === lineId);
        if (!line) throw new NotFoundException("Build-up line not found");
        if (line.kind !== "material")
          throw storesConflict("buildup-line-not-material", "Only material lines are mapped");
        const material = await this.catalogue.material(scope, input.materialId);
        const units = await this.catalogue.customUnits(scope);
        assertUsableUnit(input.unit, units);
        const context = await this.catalogue.context(scope, material, null, nairobiDate(), units);
        const converted = convertQuantity("1", input.unit, material.baseUnit, context);
        if (!converted.ok || converted.ratio.isZero())
          throw storesProblem(
            422,
            "no-conversion",
            `Cannot convert ${input.unit} to ${material.baseUnit} for this material`,
          );
        await tx.buildupLineMaterial.updateMany({
          where: { tenantId: access.tenantId, lineId, unmappedAt: null },
          data: { unmappedBy: access.userId, unmappedAt: new Date() },
        });
        await tx.buildupLineMaterial.create({
          data: {
            tenantId: access.tenantId,
            buildupId,
            buildupVersionId: version.id,
            lineId,
            materialId: material.id,
            unit: input.unit,
            baseUnit: material.baseUnit,
            basePerUnit: converted.ratio.toString(),
            conversion: JSON.parse(
              JSON.stringify({ steps: converted.steps }),
            ) as Prisma.InputJsonValue,
            mappedBy: access.userId,
          },
        });
        await this.scope.audit(tx, "rate_buildup.material_mapped", buildupId, {
          versionNo,
          lineNo: line.lineNo,
          materialId: material.id,
          unit: input.unit,
        });
        return this.view(scope, await this.version(scope, buildupId, versionNo));
      },
      true,
    );
  }

  unmap(principal: Principal, buildupId: string, versionNo: number, lineId: string, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.policy.requireSomewhere(scope, "bq.edit");
        const version = await this.version(scope, buildupId, versionNo);
        const line = version.lines.find((entry) => entry.id === lineId);
        if (!line) throw new NotFoundException("Build-up line not found");
        const updated = await tx.buildupLineMaterial.updateMany({
          where: { tenantId: access.tenantId, lineId, unmappedAt: null },
          data: { unmappedBy: access.userId, unmappedAt: new Date() },
        });
        if (updated.count)
          await this.scope.audit(tx, "rate_buildup.material_unmapped", buildupId, {
            versionNo,
            lineNo: line.lineNo,
          });
        return this.view(scope, await this.version(scope, buildupId, versionNo));
      },
      true,
    );
  }

  private async version(scope: Scope, buildupId: string, versionNo: number) {
    const version = await scope.tx.rateBuildupVersion.findUnique({
      where: {
        tenantId_buildupId_versionNo: { tenantId: scope.access.tenantId, buildupId, versionNo },
      },
      include: {
        buildup: { select: { id: true, code: true, name: true, unit: true } },
        lines: {
          orderBy: { lineNo: "asc" },
          include: { materialMaps: { where: { unmappedAt: null }, include: { material: true } } },
        },
      },
    });
    if (!version) throw new NotFoundException("Rate build-up version not found");
    return version;
  }

  private async view(
    scope: Scope,
    version: Awaited<ReturnType<BuildupMaterialsService["version"]>>,
  ) {
    const lines = version.lines.filter((line) => line.kind === "material");
    const people = await peopleOf(
      scope.tx,
      lines.map((line) => line.materialMaps[0]?.mappedBy),
    );
    return buildupMaterialsResponseSchema.parse({
      buildup: version.buildup,
      versionNo: version.versionNo,
      lines: lines.map((line) => {
        const mapping = line.materialMaps[0];
        return {
          lineId: line.id,
          lineNo: line.lineNo,
          resourceName: line.resourceName,
          unit: line.unit,
          quantity: dec(line.quantity),
          wastePercent: decOrNull(line.wastePercent),
          mapping: mapping
            ? {
                id: mapping.id,
                material: materialWire(mapping.material),
                unit: mapping.unit,
                basePerUnit: mapping.basePerUnit,
                basePerUnitDecimal: Ratio.parse(mapping.basePerUnit).toDecimal(6).value,
                mappedAt: iso(mapping.mappedAt),
                mappedBy: personOf(people, mapping.mappedBy),
              }
            : null,
        };
      }),
      permissions: { canMap: await this.policy.holdsSomewhere(scope, "bq.edit") },
    });
  }
}
