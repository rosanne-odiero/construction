import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import {
  consumptionVariance,
  measurementBasis,
  nairobiDate,
  negateDecimal,
  Ratio,
  sumDecimals,
  theoreticalConsumption,
} from "@pm-buddy/domain";
import { DEFAULT_CONSUMPTION_VARIANCE_PERCENT, type VarianceState } from "@pm-buddy/types";
import { varianceResponseSchema, type VarianceRow } from "@pm-buddy/validation";
import type { Scope } from "../../identity/access-policy.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { materialWire, projectRef } from "../p2p/p2p-common.js";
import { measurable } from "../../progress/valuations/valuation-common.js";
import { peopleOf, personOf, toCalendarDate } from "../procurement-mappers.js";
import { dec, decOrNull, StoresAccess } from "./stores-common.js";

const UNAVAILABLE: readonly VarianceState[] = [
  "no_measurement",
  "no_buildup",
  "not_mapped",
  "not_in_buildup",
  "no_progress",
];

/**
 * Theoretical versus actual material consumption per BQ item (D5.3 acceptance criterion; brief
 * §5.3 and §15 G). For each item of a project's BQ in force that has a rate build-up linked or
 * material issued to it:
 *   theoretical = latest measured quantity to date × build-up quantity per unit × (1 + waste %)
 *                 × base units per build-up unit (the line's catalogue mapping);
 *   actual = issued to the item − returned from those issues (reversals net out);
 *   alert when actual > theoretical × (1 + `stores.consumption_variance_percent`).
 * These are ESTIMATES for review, never proof of theft: without a measurement the variance is
 * unavailable (not zero), unmapped build-up lines are reported as "not mapped", and material
 * issued to an item whose build-up does not use it is reported separately. Transfers and
 * wastage are store-level and never counted as consumption of an item.
 */
@Injectable()
export class VarianceService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: StoresAccess,
  ) {}

  report(principal: Principal, query: { projectId?: string; state?: VarianceState }, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const settings = await scope.tx.procurementSettings.findUnique({
        where: { tenantId: scope.access.tenantId },
      });
      const threshold = settings
        ? dec(settings.consumptionVariancePercent)
        : DEFAULT_CONSUMPTION_VARIANCE_PERCENT;
      const projectIds = await this.access.visibleProjectIds(scope, query.projectId);
      const rows: VarianceRow[] = [];
      for (const projectId of projectIds)
        rows.push(...(await this.project(scope, projectId, threshold)));
      const filtered = query.state ? rows.filter((row) => row.state === query.state) : rows;
      return varianceResponseSchema.parse({
        thresholdPercent: threshold,
        generatedOn: nairobiDate(),
        rows: filtered,
        counts: {
          alert: rows.filter((row) => row.state === "alert").length,
          within: rows.filter((row) => row.state === "within").length,
          unavailable: rows.filter((row) => UNAVAILABLE.includes(row.state)).length,
        },
      });
    });
  }

  private async project(
    scope: Scope,
    projectId: string,
    threshold: string,
  ): Promise<VarianceRow[]> {
    const { tx, access } = scope;
    const project = await this.access.on(scope, projectId);
    const canMeasure = project.permissions.has("bq.edit") && this.access.isWritable(project);
    const version = await tx.bqVersion.findFirst({
      where: { tenantId: access.tenantId, projectId, status: "approved" },
      orderBy: { versionNo: "desc" },
    });
    if (!version) return [];
    const [links, consumed, measurements] = await Promise.all([
      tx.bqItemRateLink.findMany({
        where: { tenantId: access.tenantId, projectId, unlinkedAt: null },
        include: {
          buildupVersion: {
            include: {
              buildup: { select: { id: true, code: true } },
              lines: {
                where: { kind: "material" },
                orderBy: { lineNo: "asc" },
                include: {
                  materialMaps: { where: { unmappedAt: null }, include: { material: true } },
                },
              },
            },
          },
        },
      }),
      tx.stockLedgerEntry.groupBy({
        by: ["bqItemLineageId", "materialId", "kind"],
        where: {
          tenantId: access.tenantId,
          projectId,
          kind: { in: ["issue", "return"] },
          bqItemLineageId: { not: null },
        },
        _sum: { quantity: true },
      }),
      tx.progressMeasurement.findMany({
        // The latest measurement that is not rejected and not superseded by a correction that
        // still stands (pending or approved; a rejected correction leaves the original in force,
        // as in valuations); a pending one still informs the estimate.
        where: {
          tenantId: access.tenantId,
          projectId,
          OR: [
            { correctedBy: { is: null } },
            { correctedBy: { is: { review: { is: { decision: "rejected" } } } } },
          ],
          NOT: { review: { is: { decision: "rejected" } } },
        },
        orderBy: [{ measuredOn: "desc" }, { recordedAt: "desc" }],
      }),
    ]);
    const lineages = [
      ...new Set([
        ...links.map((link) => link.itemLineageId),
        ...consumed.map((entry) => entry.bqItemLineageId!),
      ]),
    ];
    if (!lineages.length) return [];
    const items = await tx.bqItem.findMany({
      where: { tenantId: access.tenantId, lineageId: { in: lineages } },
      include: { bill: { select: { version: { select: { versionNo: true } } } } },
    });
    const materialIds = [...new Set(consumed.map((entry) => entry.materialId))];
    const materials = new Map(
      (
        await tx.material.findMany({
          where: { tenantId: access.tenantId, id: { in: materialIds } },
        })
      ).map((material) => [material.id, material]),
    );
    const latest = new Map<string, (typeof measurements)[number]>();
    for (const measurement of measurements)
      if (!latest.has(measurement.itemLineageId))
        latest.set(measurement.itemLineageId, measurement);
    const people = await peopleOf(
      tx,
      [...latest.values()].map((entry) => entry.measuredBy),
    );
    const ref = projectRef(project.project);
    const rows: VarianceRow[] = [];
    for (const lineage of lineages) {
      // The item as it stands in the BQ in force, else its newest version.
      const candidates = items
        .filter((item) => item.lineageId === lineage)
        .sort((left, right) => right.bill.version.versionNo - left.bill.version.versionNo);
      const item = candidates.find((entry) => entry.versionId === version.id) ?? candidates[0];
      if (!item) continue;
      const bqItem = {
        versionId: item.versionId,
        lineageId: item.lineageId,
        ref: item.ref,
        description: item.description,
        unit: item.unit,
        basis: measurementBasis(measurable(item)),
      };
      const usage = new Map<string, { issued: string; returned: string }>();
      for (const entry of consumed.filter((candidate) => candidate.bqItemLineageId === lineage)) {
        const current = usage.get(entry.materialId) ?? { issued: "0", returned: "0" };
        const sum = entry._sum.quantity ? dec(entry._sum.quantity) : "0";
        if (entry.kind === "issue")
          current.issued = sumDecimals([current.issued, negateDecimal(sum)]);
        else current.returned = sumDecimals([current.returned, sum]);
        usage.set(entry.materialId, current);
      }
      const measurement = latest.get(lineage) ?? null;
      const measured = measurement
        ? {
            id: measurement.id,
            quantityToDate: dec(measurement.quantityToDate),
            measuredOn: toCalendarDate(measurement.measuredOn),
            measuredBy: personOf(people, measurement.measuredBy),
          }
        : null;
      const base = (material: VarianceRow["material"], used = { issued: "0", returned: "0" }) => ({
        project: ref,
        bqItem,
        material,
        measurement: measured,
        issuedQuantity: used.issued,
        returnedQuantity: used.returned,
        actualQuantity: sumDecimals([used.issued, negateDecimal(used.returned)]),
        canMeasure,
      });
      const empty = {
        buildup: null,
        mapping: null,
        theoreticalQuantity: null,
        limitQuantity: null,
        varianceQuantity: null,
        variancePercent: null,
      };
      const link = links.find((entry) => entry.itemLineageId === lineage);
      if (!link) {
        for (const [materialId, used] of usage) {
          const material = materials.get(materialId);
          if (material)
            rows.push({ ...base(materialWire(material), used), ...empty, state: "no_buildup" });
        }
        continue;
      }
      const buildupVersion = link.buildupVersion;
      const covered = new Set<string>();
      const grouped = new Map<string, { lines: typeof buildupVersion.lines }>();
      for (const line of buildupVersion.lines) {
        const mapping = line.materialMaps[0];
        const buildup = {
          id: buildupVersion.buildup.id,
          code: buildupVersion.buildup.code,
          versionNo: buildupVersion.versionNo,
          lineNo: line.lineNo,
          resourceName: line.resourceName,
          unit: line.unit,
          quantityPerUnit: dec(line.quantity),
          wastePercent: decOrNull(line.wastePercent),
        };
        if (!mapping) {
          rows.push({ ...base(null), ...empty, buildup, state: "not_mapped" });
          continue;
        }
        const group = grouped.get(mapping.materialId) ?? { lines: [] };
        group.lines.push(line);
        grouped.set(mapping.materialId, group);
      }
      for (const [materialId, group] of grouped) {
        covered.add(materialId);
        const first = group.lines[0]!;
        const mapping = first.materialMaps[0]!;
        const used = usage.get(materialId);
        const buildup = {
          id: buildupVersion.buildup.id,
          code: buildupVersion.buildup.code,
          versionNo: buildupVersion.versionNo,
          lineNo: first.lineNo,
          resourceName: first.resourceName,
          unit: first.unit,
          quantityPerUnit: dec(first.quantity),
          wastePercent: decOrNull(first.wastePercent),
        };
        const ratio = Ratio.parse(mapping.basePerUnit);
        const mappingWire = {
          unit: mapping.unit,
          basePerUnit: mapping.basePerUnit,
          basePerUnitDecimal: ratio.toDecimal(6).value,
        };
        const row = base(materialWire(mapping.material), used);
        if (!measured) {
          rows.push({ ...row, ...empty, buildup, mapping: mappingWire, state: "no_measurement" });
          continue;
        }
        const theoretical = sumDecimals(
          group.lines.map((line) =>
            theoreticalConsumption({
              measuredQuantity: measured.quantityToDate,
              quantityPerUnit: dec(line.quantity),
              wastePercent: decOrNull(line.wastePercent),
              basePerUnit: Ratio.parse(line.materialMaps[0]!.basePerUnit),
            }),
          ),
        );
        const result = consumptionVariance({
          theoretical,
          issued: row.issuedQuantity,
          returned: row.returnedQuantity,
          thresholdPercent: threshold,
        });
        rows.push({
          ...row,
          buildup,
          mapping: mappingWire,
          theoreticalQuantity: theoretical,
          limitQuantity: result.limit,
          varianceQuantity: result.variance,
          variancePercent: result.variancePercent,
          state: result.state,
        });
      }
      for (const [materialId, used] of usage) {
        if (covered.has(materialId)) continue;
        const material = materials.get(materialId);
        if (material)
          rows.push({ ...base(materialWire(material), used), ...empty, state: "not_in_buildup" });
      }
    }
    const order: Record<VarianceState, number> = {
      alert: 0,
      not_in_buildup: 1,
      no_progress: 2,
      within: 3,
      no_measurement: 4,
      not_mapped: 5,
      no_buildup: 6,
    };
    return rows.sort(
      (left, right) =>
        order[left.state] - order[right.state] ||
        (left.bqItem.ref ?? "").localeCompare(right.bqItem.ref ?? ""),
    );
  }
}
