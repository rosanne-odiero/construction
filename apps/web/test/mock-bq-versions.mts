/**
 * D2.3 BQ version endpoints of the Playwright mock API: version history, baseline approval,
 * comparison, contract sums and BQ item build-up links. Uses the real packages/domain functions
 * (compareVersions, projectedTotals, unitsCompatible) over the mock's lineage-addressed content.
 */
import {
  compareVersions,
  projectedTotals,
  unitsCompatible,
  variationTotals,
} from "@pm-buddy/domain";
import {
  approveBaselineRequestSchema,
  bqCompareResponseSchema,
  bqContractSumResponseSchema,
  bqItemLinkResponseSchema,
  bqVersionResponseSchema,
  bqVersionsResponseSchema,
  linkBuildupRequestSchema,
  type Project,
} from "@pm-buddy/validation";
import {
  currentVersion,
  latestApproved,
  linkWire,
  totalsOf,
  VAT,
  versionWire,
  type BqDeps,
  type BqState,
  type MockVariation,
  type ProjectBq,
  type Reply,
} from "./mock-bq-model.mts";

const readOnly = (project: Project) =>
  project.status === "closed" || project.status === "cancelled";

/** The pending effect of a submitted variation, projected against its own base version. */
export function variationEffect(entry: ProjectBq, baseVersionId: string, netMinor: number) {
  const base = entry.versions.find((version) => version.id === baseVersionId)!;
  const totals = totalsOf(base);
  return projectedTotals(
    { subtotalMinor: totals.subtotalMinor, grandTotalMinor: totals.grandTotalMinor },
    netMinor,
    VAT,
  );
}

export function handleVersions(
  deps: BqDeps,
  state: BqState,
  method: string,
  rest: string,
  query: URLSearchParams,
  body: unknown,
  projectBq: () => { project: Project; entry: ProjectBq },
): Reply | null {
  if (rest === "bq/versions" && method === "GET") {
    const { entry } = projectBq();
    return {
      body: {
        versions: [...entry.versions].reverse().map((version) => versionWire(entry, version)),
      },
      schema: bqVersionsResponseSchema,
    };
  }
  if (rest === "bq/versions/compare" && method === "GET") {
    const { entry } = projectBq();
    const from = entry.versions.find((version) => version.id === query.get("from"));
    const to = entry.versions.find((version) => version.id === query.get("to"));
    if (!from || !to) throw deps.fail(404, "not-found");
    return {
      body: {
        from: { id: from.id, versionNo: from.versionNo },
        to: { id: to.id, versionNo: to.versionNo },
        ...compareVersions(
          { content: from.content, vatRatePercent: VAT },
          { content: to.content, vatRatePercent: VAT },
        ),
      },
      schema: bqCompareResponseSchema,
    };
  }
  const approve = /^bq\/versions\/([^/]+)\/approve$/.exec(rest);
  if (approve && method === "POST") {
    const { project, entry } = projectBq();
    const input = deps.parse(approveBaselineRequestSchema, body);
    if (!deps.permissions().includes("bq.approve_variation")) throw deps.fail(403, "forbidden");
    deps.requireStepUp();
    if (readOnly(project)) throw deps.fail(409, "project-read-only");
    const version = entry.versions.find((candidate) => candidate.id === approve[1]);
    if (!version) throw deps.fail(404, "not-found");
    if (version.status !== "draft") throw deps.fail(409, "bq-not-draft");
    if (version.version !== input.version) throw deps.fail(409, "version-conflict");
    const source = entry.imports.find((candidate) => candidate.record.id === version.importId);
    const makers = [
      version.createdBy.id,
      version.updatedBy.id,
      source?.record.uploadedBy.id,
      source?.record.committedBy?.id,
    ];
    if (makers.includes(deps.actor.id)) throw deps.fail(403, "maker-checker");
    Object.assign(version, {
      status: "approved",
      approvedBy: deps.actor,
      approvedAt: new Date().toISOString(),
      version: version.version + 1,
    });
    return { body: { version: versionWire(entry, version) }, schema: bqVersionResponseSchema };
  }
  if (rest === "bq/contract-sum" && method === "GET") {
    const { entry } = projectBq();
    const baseline = entry.versions[0];
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
    let sums;
    if (!baseline) sums = { status: "no-bq", ...empty };
    else if (baseline.status !== "approved")
      sums = {
        status: "draft",
        ...empty,
        vatRatePercent: VAT,
        draftTotalMinor: totalsOf(baseline).grandTotalMinor,
        currentVersionNo: 1,
      };
    else {
      const latest = latestApproved(entry)!;
      const original = totalsOf(baseline).grandTotalMinor;
      const revised = totalsOf(latest).grandTotalMinor;
      const submitted = entry.variations.filter((variation) => variation.status === "submitted");
      sums = {
        status: "approved",
        vatRatePercent: VAT,
        draftTotalMinor: null,
        originalMinor: original,
        approvedVariationsMinor: revised - original,
        revisedMinor: revised,
        approvedCount: entry.variations.filter((variation) => variation.status === "approved")
          .length,
        pendingMinor: submitted.reduce(
          (sum, variation) =>
            sum +
            variationEffect(entry, variation.baseVersionId, netOf(variation)).grandTotalEffectMinor,
          0,
        ),
        pendingCount: submitted.length,
        currentVersionNo: latest.versionNo,
        baselineApprovedAt: baseline.approvedAt,
      };
    }
    return { body: sums, schema: bqContractSumResponseSchema };
  }
  const link = /^bq\/items\/([^/]+)\/rate-buildup$/.exec(rest);
  if (link) {
    const { project, entry } = projectBq();
    const lineageId = link[1]!;
    const version = currentVersion(entry);
    const item = version?.content.items.find((candidate) => candidate.lineageId === lineageId);
    const respond = () => {
      const wire = linkWire(state, entry.links.get(lineageId));
      return {
        body: { link: wire ? { itemLineageId: lineageId, ...wire } : null },
        schema: bqItemLinkResponseSchema,
      };
    };
    if (method === "GET") {
      if (!item) throw deps.fail(404, "not-found");
      return respond();
    }
    if (!deps.permissions().includes("bq.edit")) throw deps.fail(403, "forbidden");
    if (readOnly(project)) throw deps.fail(409, "project-read-only");
    if (version?.status !== "approved") throw deps.fail(409, "bq-not-approved");
    if (!item) throw deps.fail(404, "not-found");
    if (method === "DELETE") {
      if (!entry.links.delete(lineageId)) throw deps.fail(404, "not-found");
      return respond();
    }
    if (method === "PUT") {
      const input = deps.parse(linkBuildupRequestSchema, body);
      const buildup = state.buildups.find((candidate) =>
        candidate.versions.some((entryVersion) => entryVersion.id === input.buildupVersionId),
      );
      const chosen = buildup?.versions.find((candidate) => candidate.id === input.buildupVersionId);
      if (!buildup || !chosen) throw deps.fail(404, "not-found");
      const check = unitsCompatible({ unit: item.unit, unitRaw: item.unitRaw }, chosen.unit);
      if (!check.ok) throw deps.fail(422, check.error);
      entry.links.set(lineageId, {
        buildupId: buildup.id,
        buildupVersionId: chosen.id,
        linkedAt: new Date().toISOString(),
        linkedBy: deps.actor,
      });
      return respond();
    }
  }
  return null;
}

/** A variation's net (additions − omissions), from its priced lines. */
export const netOf = (variation: MockVariation) => variationTotals(variation.priced).netMinor;
