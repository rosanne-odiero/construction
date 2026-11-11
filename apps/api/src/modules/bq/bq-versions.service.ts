import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { compareVersions, isProjectReadOnly, projectedTotals } from "@pm-buddy/domain";
import type { ProjectStatus } from "@pm-buddy/types";
import {
  bqCompareResponseSchema,
  bqContractSumResponseSchema,
  bqVersionResponseSchema,
  bqVersionsResponseSchema,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { BqAccess, bqConflict, bqProblem, recordConflict } from "./bq-access.js";
import { loadContent } from "./bq-content.js";
import { peopleOf, safeMinor, toVersion, type BqVersionRow } from "./bq-mappers.js";

type Tx = Prisma.TransactionClient;

/** The project's BQ and all its versions (oldest first), or null when nothing was imported. */
export async function versionsOf(tx: Tx, tenantId: string, projectId: string) {
  const bq = await tx.bq.findUnique({ where: { tenantId_projectId: { tenantId, projectId } } });
  if (!bq) return null;
  const versions = await tx.bqVersion.findMany({
    where: { tenantId, bqId: bq.id },
    orderBy: { versionNo: "asc" },
  });
  return { bq, versions };
}

/** The newest approved version (the one in force), or null while the baseline is a draft. */
export const latestApproved = (versions: readonly BqVersionRow[]): BqVersionRow | null =>
  [...versions].reverse().find((version) => version.status === "approved") ?? null;

/** The version in force: the newest approved one, or the draft baseline. */
export const currentOf = (versions: readonly BqVersionRow[]): BqVersionRow | null =>
  latestApproved(versions) ?? versions.at(-1) ?? null;

/** Wire versions with people, variation numbers and the `current` flag. */
export async function versionWires(tx: Tx, tenantId: string, versions: readonly BqVersionRow[]) {
  const variationIds = versions.flatMap((version) => version.variationId ?? []);
  const [people, variations] = await Promise.all([
    peopleOf(
      tx,
      versions.flatMap((version) => [version.createdBy, version.approvedBy]),
    ),
    variationIds.length
      ? tx.variationOrder.findMany({
          where: { tenantId, id: { in: variationIds } },
          select: { id: true, number: true },
        })
      : Promise.resolve([]),
  ]);
  const numbers = new Map(variations.map((variation) => [variation.id, variation.number]));
  const current = currentOf(versions);
  return versions.map((version) =>
    toVersion(version, {
      people,
      current: version.id === current?.id,
      variationNumber: version.variationId ? (numbers.get(version.variationId) ?? null) : null,
    }),
  );
}

/**
 * BQ version history (D2.3): the list, approving the imported draft as the contract baseline,
 * comparing two versions, and the original vs revised contract sum.
 */
@Injectable()
export class BqVersionsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: BqAccess,
  ) {}

  list(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "bq.view");
      const found = await versionsOf(scope.tx, scope.access.tenantId, projectId);
      const versions = found
        ? await versionWires(scope.tx, scope.access.tenantId, found.versions)
        : [];
      return bqVersionsResponseSchema.parse({ versions: [...versions].reverse() });
    });
  }

  /**
   * The people who made the draft baseline: its creator and last writer, and everyone who
   * uploaded, mapped, resolved, validated or committed the import it holds (the import's
   * `contributors`). None of them may approve it (maker-checker by identity).
   */
  static async makersOf(tx: Tx, tenantId: string, version: BqVersionRow): Promise<Set<string>> {
    const imports = await tx.bqImport.findMany({
      where: { tenantId, bqVersionId: version.id, status: "committed" },
      select: { uploadedBy: true, committedBy: true, contributors: true },
    });
    return new Set(
      [
        version.createdBy,
        version.updatedBy,
        ...imports.flatMap((entry) => [entry.uploadedBy, entry.committedBy, ...entry.contributors]),
      ].filter((id): id is string => Boolean(id)),
    );
  }

  /**
   * Approves version 1 (draft, from the import) as the contract baseline: bq.approve_variation,
   * fresh step-up MFA, an approver who neither imported nor committed it, and the version the
   * caller saw. From then on the version is immutable and re-import is refused.
   */
  approveBaseline(
    principal: Principal,
    projectId: string,
    versionId: string,
    input: { version: number },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.access.approver(scope, projectId);
        const found = await versionsOf(tx, access.tenantId, projectId);
        const target = found?.versions.find((version) => version.id === versionId);
        if (!found || !target) throw new NotFoundException("Version not found");
        await tx.$queryRaw`SELECT id FROM bqs WHERE tenant_id = ${access.tenantId}::uuid
          AND id = ${found.bq.id}::uuid FOR UPDATE`;
        const locked = await tx.bqVersion.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: access.tenantId, id: versionId } },
        });
        if (locked.status !== "draft")
          throw bqConflict("bq-not-draft", "This version is already approved");
        if (locked.version !== input.version) throw recordConflict();
        const makers = await BqVersionsService.makersOf(tx, access.tenantId, locked);
        if (makers.has(access.userId))
          throw bqProblem(
            403,
            "maker-checker",
            "Someone other than the person who imported this BQ must approve it",
          );
        const updated = await tx.bqVersion.updateMany({
          where: {
            tenantId: access.tenantId,
            id: versionId,
            version: input.version,
            status: "draft",
          },
          data: {
            status: "approved",
            approvedBy: access.userId,
            approvedAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw recordConflict();
        await this.scope.audit(tx, "bq.baseline.approved", versionId, {
          projectId,
          versionNo: locked.versionNo,
          bills: locked.billCount,
          items: locked.itemCount,
        });
        const after = await versionsOf(tx, access.tenantId, projectId);
        const wires = await versionWires(tx, access.tenantId, after!.versions);
        return bqVersionResponseSchema.parse({
          version: wires.find((version) => version.id === versionId),
        });
      },
      true,
    );
  }

  compare(principal: Principal, projectId: string, fromId: string, toId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      await this.access.load(scope, projectId, "bq.view");
      const found = await versionsOf(tx, access.tenantId, projectId);
      const from = found?.versions.find((version) => version.id === fromId);
      const to = found?.versions.find((version) => version.id === toId);
      if (!from || !to) throw new NotFoundException("Version not found");
      const [fromContent, toContent] = await Promise.all([
        loadContent(tx, access.tenantId, from.id),
        loadContent(tx, access.tenantId, to.id),
      ]);
      const result = compareVersions(
        { content: fromContent, vatRatePercent: from.vatRatePercent.toFixed() },
        { content: toContent, vatRatePercent: to.vatRatePercent.toFixed() },
      );
      return bqCompareResponseSchema.parse({
        from: { id: from.id, versionNo: from.versionNo },
        to: { id: to.id, versionNo: to.versionNo },
        ...result,
      });
    });
  }

  /**
   * Original (approved baseline), revised (newest approved version) and pending (submitted
   * variations, each projected against its own base) contract sums, all grand totals with VAT.
   */
  contractSum(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      await this.access.load(scope, projectId, "bq.view");
      return bqContractSumResponseSchema.parse(
        await BqVersionsService.sums(tx, access.tenantId, projectId),
      );
    });
  }

  static async sums(tx: Tx, tenantId: string, projectId: string) {
    const found = await versionsOf(tx, tenantId, projectId);
    const empty = {
      vatRatePercent: null,
      draftTotalMinor: null,
      originalMinor: null,
      approvedVariationsMinor: null,
      revisedMinor: null,
      approvedCount: 0,
      pendingMinor: 0,
      pendingCount: 0,
      currentVersionNo: null,
      baselineApprovedAt: null,
    };
    if (!found?.versions.length) return { status: "no-bq" as const, ...empty };
    const baseline = found.versions[0]!;
    if (baseline.status !== "approved")
      return {
        status: "draft" as const,
        ...empty,
        vatRatePercent: baseline.vatRatePercent.toFixed(),
        draftTotalMinor: safeMinor(baseline.grandTotalMinor),
        currentVersionNo: baseline.versionNo,
      };
    const latest = latestApproved(found.versions)!;
    const byId = new Map(found.versions.map((version) => [version.id, version]));
    const [approvedCount, submitted] = await Promise.all([
      tx.variationOrder.count({ where: { tenantId, bqId: found.bq.id, status: "approved" } }),
      tx.variationOrder.findMany({
        where: { tenantId, bqId: found.bq.id, status: "submitted" },
        select: { baseVersionId: true, netMinor: true },
      }),
    ]);
    let pending = 0;
    for (const variation of submitted) {
      const base = byId.get(variation.baseVersionId)!;
      pending += projectedTotals(
        {
          subtotalMinor: safeMinor(base.subtotalMinor),
          grandTotalMinor: safeMinor(base.grandTotalMinor),
        },
        safeMinor(variation.netMinor),
        base.vatRatePercent.toFixed(),
      ).grandTotalEffectMinor;
    }
    const original = safeMinor(baseline.grandTotalMinor);
    const revised = safeMinor(latest.grandTotalMinor);
    return {
      status: "approved" as const,
      vatRatePercent: latest.vatRatePercent.toFixed(),
      draftTotalMinor: null,
      originalMinor: original,
      approvedVariationsMinor: revised - original,
      revisedMinor: revised,
      approvedCount,
      pendingMinor: pending,
      pendingCount: submitted.length,
      currentVersionNo: latest.versionNo,
      baselineApprovedAt: baseline.approvedAt?.toISOString() ?? null,
    };
  }

  /** Whether the caller may approve the draft baseline now, or why not (for the BQ page). */
  static async baselineApproval(
    scope: Scope,
    project: { status: string },
    effective: ReadonlySet<string>,
    version: BqVersionRow | null,
  ) {
    if (!version) return { allowed: false, refusal: "no-bq" as const };
    if (version.status !== "draft") return { allowed: false, refusal: "not-draft" as const };
    if (isProjectReadOnly(project.status as ProjectStatus))
      return { allowed: false, refusal: "read-only" as const };
    if (!effective.has("bq.approve_variation"))
      return { allowed: false, refusal: "permission" as const };
    const makers = await BqVersionsService.makersOf(scope.tx, scope.access.tenantId, version);
    if (makers.has(scope.access.userId)) return { allowed: false, refusal: "maker" as const };
    return { allowed: true, refusal: null };
  }
}
