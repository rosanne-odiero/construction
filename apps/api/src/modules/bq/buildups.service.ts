import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { buildupRate, unitsCompatible } from "@pm-buddy/domain";
import {
  BUILDUP_ROUNDING,
  type BqUnit,
  type BuildupOutputUnit,
  type BuildupResourceKind,
} from "@pm-buddy/types";
import {
  bqItemLinkResponseSchema,
  buildupResponseSchema,
  buildupsResponseSchema,
  buildupVersionResponseSchema,
  type BuildupVersion,
  type CreateBuildupRequest,
  type UpdateBuildupRequest,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../common/database-errors.js";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { BqAccess, bqConflict, bqProblem, recordConflict } from "./bq-access.js";
import { peopleOf, personOf, safeMinor } from "./bq-mappers.js";
import { currentVersion, linksOf } from "./bq-viewer.service.js";
import { refuseClientPortalMember } from "../portals/client/client-portal-access.js";

type Tx = Prisma.TransactionClient;
type VersionRow = Prisma.RateBuildupVersionGetPayload<{ include: { lines: true } }>;

function toVersionWire(row: VersionRow, people: ReadonlyMap<string, string>): BuildupVersion {
  const lines = [...row.lines].sort((left, right) => left.lineNo - right.lineNo);
  const byKind = { material: 0, labour: 0, plant: 0 };
  for (const line of lines)
    if (line.amountMinor !== null)
      byKind[line.kind as BuildupResourceKind] += safeMinor(line.amountMinor);
  return {
    id: row.id,
    versionNo: row.versionNo,
    name: row.name,
    unit: row.unit as BuildupOutputUnit,
    assumptions: row.assumptions,
    rateMinor: row.rateMinor === null ? null : safeMinor(row.rateMinor),
    pricedMinor: safeMinor(row.pricedMinor),
    unpricedLines: row.unpricedLines,
    byKind,
    lines: lines.map((line) => ({
      lineNo: line.lineNo,
      kind: line.kind as BuildupResourceKind,
      resourceName: line.resourceName,
      unit: line.unit,
      quantity: line.quantity.toFixed(),
      wastePercent: line.wastePercent === null ? null : line.wastePercent.toFixed(),
      unitCostMinor: line.unitCostMinor === null ? null : safeMinor(line.unitCostMinor),
      amountMinor: line.amountMinor === null ? null : safeMinor(line.amountMinor),
    })),
    createdAt: row.createdAt.toISOString(),
    createdBy: personOf(people, row.createdBy),
  };
}

/**
 * The company's rate build-up library (D2.3, brief §5.2): named composite rates per unit of work.
 * Reading needs bq.view and changing bq.edit, held company-wide or on at least one assigned
 * project (the library is shared by the company's projects). Editing appends a version; links
 * from BQ items keep the version they were made with. Rates follow packages/domain buildupRate
 * (each line rounded half-up to the cent; undefined while any line is unpriced) and the database
 * re-checks every line and total at commit.
 */
@Injectable()
export class BuildupsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
    private readonly access: BqAccess,
  ) {}

  private async summaries(scope: Scope, rows: Prisma.RateBuildupGetPayload<object>[]) {
    const { tx, access } = scope;
    if (!rows.length) return [];
    const [versions, links] = await Promise.all([
      tx.rateBuildupVersion.findMany({
        where: {
          tenantId: access.tenantId,
          OR: rows.map((row) => ({ buildupId: row.id, versionNo: row.currentVersionNo })),
        },
      }),
      tx.bqItemRateLink.groupBy({
        by: ["buildupId"],
        where: {
          tenantId: access.tenantId,
          unlinkedAt: null,
          buildupId: { in: rows.map((row) => row.id) },
        },
        _count: { _all: true },
      }),
    ]);
    const current = new Map(versions.map((version) => [version.buildupId, version]));
    const linkCount = new Map(links.map((entry) => [entry.buildupId, entry._count._all]));
    return rows.map((row) => {
      const version = current.get(row.id)!;
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        unit: row.unit as BuildupOutputUnit,
        currentVersionId: version.id,
        currentVersionNo: row.currentVersionNo,
        rateMinor: version.rateMinor === null ? null : safeMinor(version.rateMinor),
        unpricedLines: version.unpricedLines,
        lineCount: version.lineCount,
        linkCount: linkCount.get(row.id) ?? 0,
        updatedAt: row.updatedAt.toISOString(),
        version: row.version,
      };
    });
  }

  list(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.policy.requireSomewhere(scope, "bq.view");
      refuseClientPortalMember(scope);
      const rows = await scope.tx.rateBuildup.findMany({
        where: { tenantId: scope.access.tenantId },
        orderBy: { code: "asc" },
      });
      return buildupsResponseSchema.parse({
        buildups: await this.summaries(scope, rows),
        permissions: { canEdit: await this.policy.holdsSomewhere(scope, "bq.edit") },
      });
    });
  }

  private async header(scope: Scope, buildupId: string) {
    const row = await scope.tx.rateBuildup.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: buildupId } },
    });
    if (!row) throw new NotFoundException("Build-up not found");
    return row;
  }

  private async detail(scope: Scope, buildupId: string) {
    const { tx, access } = scope;
    const row = await this.header(scope, buildupId);
    const versions = await tx.rateBuildupVersion.findMany({
      where: { tenantId: access.tenantId, buildupId },
      orderBy: { versionNo: "desc" },
      include: { lines: true },
    });
    const people = await peopleOf(
      tx,
      versions.map((version) => version.createdBy),
    );
    const current = versions.find((version) => version.versionNo === row.currentVersionNo)!;
    const [summary] = await this.summaries(scope, [row]);
    return buildupResponseSchema.parse({
      buildup: summary,
      current: toVersionWire(current, people),
      versions: versions.map((version) => ({
        id: version.id,
        versionNo: version.versionNo,
        name: version.name,
        rateMinor: version.rateMinor === null ? null : safeMinor(version.rateMinor),
        createdAt: version.createdAt.toISOString(),
        createdBy: personOf(people, version.createdBy),
      })),
      permissions: { canEdit: await this.policy.holdsSomewhere(scope, "bq.edit") },
    });
  }

  get(principal: Principal, buildupId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.policy.requireSomewhere(scope, "bq.view");
      refuseClientPortalMember(scope);
      return this.detail(scope, buildupId);
    });
  }

  version(principal: Principal, buildupId: string, versionNo: number, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.policy.requireSomewhere(scope, "bq.view");
      refuseClientPortalMember(scope);
      await this.header(scope, buildupId);
      const row = await scope.tx.rateBuildupVersion.findUnique({
        where: {
          tenantId_buildupId_versionNo: { tenantId: scope.access.tenantId, buildupId, versionNo },
        },
        include: { lines: true },
      });
      if (!row) throw new NotFoundException("Build-up version not found");
      const people = await peopleOf(scope.tx, [row.createdBy]);
      return buildupVersionResponseSchema.parse({ version: toVersionWire(row, people) });
    });
  }

  /** Writes version `versionNo` with its lines (rate from packages/domain buildupRate). */
  private async writeVersion(
    tx: Tx,
    scope: Scope,
    buildupId: string,
    versionNo: number,
    input: Omit<CreateBuildupRequest, "code">,
  ) {
    const lines = input.lines.map((line) => ({
      kind: line.kind,
      resourceName: line.resourceName,
      unit: line.unit,
      quantity: line.quantity,
      wastePercent: line.wastePercent,
      unitCostMinor: line.unitCostMinor,
    }));
    const rate = buildupRate(lines);
    const versionId = uuidv7();
    await tx.rateBuildupVersion.create({
      data: {
        id: versionId,
        tenantId: scope.access.tenantId,
        buildupId,
        versionNo,
        name: input.name,
        unit: input.unit,
        assumptions: input.assumptions ?? null,
        rateMinor: rate.rateMinor === null ? null : BigInt(rate.rateMinor),
        pricedMinor: BigInt(rate.pricedMinor),
        unpricedLines: rate.unpricedLines,
        lineCount: lines.length,
        rounding: BUILDUP_ROUNDING,
        createdBy: scope.access.userId,
      },
    });
    await tx.rateBuildupLine.createMany({
      data: lines.map((line, index) => ({
        id: uuidv7(),
        tenantId: scope.access.tenantId,
        versionId,
        lineNo: index + 1,
        kind: line.kind,
        resourceName: line.resourceName,
        unit: line.unit,
        quantity: line.quantity,
        wastePercent: line.wastePercent,
        unitCostMinor: line.unitCostMinor === null ? null : BigInt(line.unitCostMinor),
        amountMinor:
          rate.lineAmountsMinor[index] === null || rate.lineAmountsMinor[index] === undefined
            ? null
            : BigInt(rate.lineAmountsMinor[index]),
      })),
    });
    return { versionId, rate };
  }

  create(principal: Principal, input: CreateBuildupRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          await this.policy.requireSomewhere(scope, "bq.edit");
          const id = uuidv7();
          await tx.rateBuildup.create({
            data: {
              id,
              tenantId: access.tenantId,
              code: input.code,
              name: input.name,
              unit: input.unit,
              currentVersionNo: 1,
              createdBy: access.userId,
              updatedBy: access.userId,
            },
          });
          const { versionId, rate } = await this.writeVersion(tx, scope, id, 1, input);
          await this.scope.audit(tx, "rate_buildup.created", id, {
            versionId,
            versionNo: 1,
            unit: input.unit,
            lines: input.lines.length,
            unpricedLines: rate.unpricedLines,
          });
          return this.detail(scope, id);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw bqConflict("buildup-code-taken", "Another build-up in this company uses this code");
        throw error;
      });
  }

  /** Appends a new version; earlier versions and the links to them are never changed. */
  update(principal: Principal, buildupId: string, input: UpdateBuildupRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.policy.requireSomewhere(scope, "bq.edit");
        await this.header(scope, buildupId);
        await tx.$queryRaw`SELECT id FROM rate_buildups WHERE tenant_id = ${access.tenantId}::uuid
          AND id = ${buildupId}::uuid FOR UPDATE`;
        const row = await this.header(scope, buildupId);
        if (row.version !== input.version) throw recordConflict();
        const versionNo = row.currentVersionNo + 1;
        const updated = await tx.rateBuildup.updateMany({
          where: { tenantId: access.tenantId, id: buildupId, version: input.version },
          data: {
            name: input.name,
            unit: input.unit,
            currentVersionNo: versionNo,
            version: { increment: 1 },
            updatedBy: access.userId,
            updatedAt: new Date(),
          },
        });
        if (!updated.count) throw recordConflict();
        const { versionId, rate } = await this.writeVersion(tx, scope, buildupId, versionNo, input);
        await this.scope.audit(tx, "rate_buildup.versioned", buildupId, {
          versionId,
          versionNo,
          unitChanged: row.unit !== input.unit,
          lines: input.lines.length,
          unpricedLines: rate.unpricedLines,
        });
        return this.detail(scope, buildupId);
      },
      true,
    );
  }

  // Item links (project-scoped) ----------------------------------------------------------------

  /**
   * Links a BQ item (by lineage, in the current approved version) to a build-up version, after
   * checking that the build-up's unit equals the item's unit once normalised. Replaces an active
   * link (the old one is stamped unlinked, never deleted).
   */
  link(
    principal: Principal,
    projectId: string,
    lineageId: string,
    input: { buildupVersionId: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.access.editable(scope, projectId);
        const { bq, item, version } = await this.itemOf(scope, projectId, lineageId);
        const buildupVersion = await tx.rateBuildupVersion.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: input.buildupVersionId } },
        });
        if (!buildupVersion) throw new NotFoundException("Build-up version not found");
        const check = unitsCompatible(
          { unit: item.unit as BqUnit | null, unitRaw: item.unitRaw },
          buildupVersion.unit as BuildupOutputUnit,
        );
        if (!check.ok)
          throw bqProblem(
            422,
            check.error,
            check.error === "unit-mismatch"
              ? `The build-up is priced per ${buildupVersion.unit} but the item is measured in ${item.unit === "other" ? item.unitRaw : item.unit}`
              : check.error === "item-unit-missing"
                ? "The item has no unit, so no build-up can be linked"
                : "The item's unit is not recognised, so no build-up can be linked",
          );
        const now = new Date();
        const replaced = await tx.bqItemRateLink.updateMany({
          where: {
            tenantId: access.tenantId,
            bqId: bq.id,
            itemLineageId: lineageId,
            unlinkedAt: null,
          },
          data: { unlinkedAt: now, unlinkedBy: access.userId },
        });
        await tx.bqItemRateLink.create({
          data: {
            id: uuidv7(),
            tenantId: access.tenantId,
            projectId,
            bqId: bq.id,
            versionId: version.id,
            itemLineageId: lineageId,
            buildupId: buildupVersion.buildupId,
            buildupVersionId: buildupVersion.id,
            linkedBy: access.userId,
            linkedAt: now,
          },
        });
        await this.scope.audit(tx, "bq.item.rate_linked", lineageId, {
          projectId,
          versionId: version.id,
          buildupId: buildupVersion.buildupId,
          buildupVersionId: buildupVersion.id,
          replaced: replaced.count,
        });
        return this.linkResponse(scope, bq.id, lineageId);
      },
      true,
    );
  }

  unlink(principal: Principal, projectId: string, lineageId: string, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.access.editable(scope, projectId);
        const { bq } = await this.itemOf(scope, projectId, lineageId);
        const updated = await tx.bqItemRateLink.updateMany({
          where: {
            tenantId: access.tenantId,
            bqId: bq.id,
            itemLineageId: lineageId,
            unlinkedAt: null,
          },
          data: { unlinkedAt: new Date(), unlinkedBy: access.userId },
        });
        if (!updated.count) throw new NotFoundException("This item has no build-up link");
        await this.scope.audit(tx, "bq.item.rate_unlinked", lineageId, { projectId });
        return this.linkResponse(scope, bq.id, lineageId);
      },
      true,
    );
  }

  getLink(principal: Principal, projectId: string, lineageId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "bq.view");
      refuseClientPortalMember(scope);
      const { bq } = await this.itemOf(scope, projectId, lineageId, false);
      return this.linkResponse(scope, bq.id, lineageId);
    });
  }

  /** The item with this lineage in the project's current version (approved, when linking). */
  private async itemOf(scope: Scope, projectId: string, lineageId: string, approved = true) {
    const current = await currentVersion(scope.tx, scope.access.tenantId, projectId);
    if (!current) throw new NotFoundException("Item not found");
    if (approved && current.version.status !== "approved")
      throw bqConflict(
        "bq-not-approved",
        "Approve the BQ baseline before linking items to build-ups",
      );
    const item = await scope.tx.bqItem.findUnique({
      where: {
        tenantId_versionId_lineageId: {
          tenantId: scope.access.tenantId,
          versionId: current.version.id,
          lineageId,
        },
      },
    });
    if (!item) throw new NotFoundException("Item not found");
    return { bq: current.bq, version: current.version, item };
  }

  private async linkResponse(scope: Scope, bqId: string, lineageId: string) {
    const links = await linksOf(scope.tx, scope.access.tenantId, bqId, [lineageId]);
    const link = links.get(lineageId);
    return bqItemLinkResponseSchema.parse({
      link: link ? { itemLineageId: lineageId, ...link } : null,
    });
  }
}
