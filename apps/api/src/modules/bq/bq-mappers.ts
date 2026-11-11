import { createHash } from "node:crypto";
import type { BqBuildResult, BqMapping, BqResolutions, SheetAnalysis } from "@pm-buddy/domain";
import { sanitiseCellText } from "@pm-buddy/domain";
import type {
  BqImport,
  BqImportSummary,
  BqItemRateLink,
  BqItemWire,
  BqReport,
  BqSheetSummary,
  BqVersionWire,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";

export type BqImportRow = Prisma.BqImportGetPayload<object>;
export type BqVersionRow = Prisma.BqVersionGetPayload<object>;
export type BqItemRow = Prisma.BqItemGetPayload<object>;

/** Issues kept per code in a stored report; counts stay complete. */
export const REPORT_ISSUES_PER_CODE = 300;

export const safeMinor = (value: bigint | number): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError("Amount out of the safe integer range");
  return result;
};
const optionalMinor = (value: bigint | null): number | null =>
  value === null ? null : safeMinor(value);
const decimal = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : value.toFixed();

export type People = ReadonlyMap<string, string>;
const person = (people: People, id: string) => ({ id, displayName: people.get(id) ?? "—" });

export function toSheetSummary(analysis: SheetAnalysis, templateId: string | null): BqSheetSummary {
  return {
    index: analysis.index,
    name: sanitiseCellText(analysis.name, 100).text || `Sheet ${analysis.index + 1}`,
    hidden: analysis.hidden,
    usedRows: analysis.usedRows,
    usedColumns: analysis.usedColumns,
    kind: analysis.kind,
    kindConfidence: analysis.kindConfidence,
    headerRow: analysis.header?.row ?? null,
    headerConfidence: analysis.header?.confidence ?? null,
    headerSignature: analysis.header?.signature ?? null,
    proposedColumns: { ...analysis.header?.columns },
    billNumber: analysis.bill.number,
    billTitle: analysis.bill.title ? sanitiseCellText(analysis.bill.title, 200).text : null,
    firstDataRow: analysis.firstDataRow,
    lastDataRow: analysis.lastDataRow,
    itemRows: analysis.itemRows,
    templateId,
  };
}

export function toImportSummary(row: BqImportRow, people: People): BqImportSummary {
  return {
    id: row.id,
    status: row.status as BqImportSummary["status"],
    fileName: row.fileName,
    fileType: row.fileType as BqImportSummary["fileType"],
    fileSizeBytes: row.fileSizeBytes,
    fileSha256: row.fileSha256,
    scanStatus: row.scanStatus as BqImportSummary["scanStatus"],
    scanEngine: row.scanEngine,
    failureCode: row.failureCode as BqImportSummary["failureCode"],
    uploadedBy: person(people, row.uploadedBy),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    committedAt: row.committedAt?.toISOString() ?? null,
    bqVersionId: row.bqVersionId,
    version: row.version,
  };
}

export function toImport(row: BqImportRow, people: People): BqImport {
  return {
    ...toImportSummary(row, people),
    sheets: (row.sheets as unknown as BqSheetSummary[] | null) ?? null,
    mapping: (row.mapping as unknown as BqMapping | null) ?? null,
    resolutions: row.resolutions as unknown as BqResolutions,
    report: (row.report as unknown as BqReport | null) ?? null,
    committedBy: row.committedBy ? person(people, row.committedBy) : null,
  };
}

/** The stored validation report (issues capped per code; counts complete). */
export function toReport(
  result: BqBuildResult,
  vatRuleStatus: string,
  generatedAt: Date,
): BqReport {
  const total = Object.values(result.counts).reduce((sum, count) => sum + (count ?? 0), 0);
  return {
    issues: result.issues,
    counts: result.counts as Record<string, number>,
    unresolvedCounts: result.unresolvedCounts as Record<string, number>,
    truncated: result.issues.length < total,
    totals: result.totals,
    readiness: result.readiness,
    vatRuleStatus,
    generatedAt: generatedAt.toISOString(),
  };
}

/**
 * A digest of what a commit would write: the built bills, the totals and the readiness. Commit
 * recomputes it from the stored source, mapping and resolutions and refuses a stale validation.
 */
export function buildDigest(result: BqBuildResult): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ bills: result.bills, totals: result.totals, readiness: result.readiness }),
    )
    .digest("hex");
}

/** Display names for user IDs (rows keep IDs only; names are resolved per response). */
export async function peopleOf(
  tx: Prisma.TransactionClient,
  ids: readonly (string | null | undefined)[],
): Promise<People> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const users = await tx.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, displayName: true },
  });
  return new Map(users.map((user) => [user.id, user.displayName]));
}

export const personOf = person;

/**
 * A version on the wire. `current` marks the version in force (the newest approved one, or the
 * draft baseline while nothing is approved); `variationNumber` names the variation behind it.
 */
export function toVersion(
  row: BqVersionRow,
  extras: { people: People; current: boolean; variationNumber: string | null },
): BqVersionWire {
  return {
    id: row.id,
    versionNo: row.versionNo,
    status: row.status as BqVersionWire["status"],
    source: row.source as BqVersionWire["source"],
    parentVersionId: row.parentVersionId,
    variation:
      row.variationId && extras.variationNumber
        ? { id: row.variationId, number: extras.variationNumber }
        : null,
    createdBy: person(extras.people, row.createdBy),
    approvedBy: row.approvedBy ? person(extras.people, row.approvedBy) : null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    current: extras.current,
    vatRatePercent: row.vatRatePercent.toFixed(),
    vatRuleKey: row.vatRuleKey,
    vatRuleStatus: row.vatRuleStatus,
    rounding: row.rounding,
    subtotalMinor: safeMinor(row.subtotalMinor),
    vatMinor: safeMinor(row.vatMinor),
    grandTotalMinor: safeMinor(row.grandTotalMinor),
    billCount: row.billCount,
    itemCount: row.itemCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

export function toItem(row: BqItemRow, link: BqItemRateLink | null = null): BqItemWire {
  return {
    id: row.id,
    lineageId: row.lineageId,
    sectionId: row.sectionId,
    ref: row.ref,
    description: row.description,
    unit: row.unit as BqItemWire["unit"],
    unitRaw: row.unitRaw,
    quantity: decimal(row.quantity),
    rate: decimal(row.rate),
    amountMinor: safeMinor(row.amountMinor),
    sheetAmountMinor: optionalMinor(row.sheetAmountMinor),
    amountSource: row.amountSource as BqItemWire["amountSource"],
    overrideReason: row.overrideReason,
    kind: row.kind as BqItemWire["kind"],
    notes: row.notes,
    sourceSheet: row.sourceSheet,
    sourceRow: row.sourceRow,
    hasFormula: row.hasFormula,
    rateBuildUp: link,
  };
}

export const optionalMinorOf = optionalMinor;
