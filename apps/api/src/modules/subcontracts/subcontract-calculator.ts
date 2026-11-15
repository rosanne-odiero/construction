import {
  computeSubcontractCertificate,
  nairobiDate,
  releaseWithinHeld,
  retentionStageAfter,
  scaled,
  subcontractLineValueMinor,
  suggestedClaim,
  sumQuantities,
  measurementBasis,
  type SubcontractCertificateFigures,
  type SubcontractTerms,
} from "@pm-buddy/domain";
import {
  SUBCONTRACT_RULE_VERSION,
  type ReleaseStage,
  type RetentionStage,
  type SubcontractLineBasis,
  type SubcontractVatTreatment,
} from "@pm-buddy/types";
import type { Prisma } from "../../generated/prisma/client.js";
import { minorOf, trimDecimal } from "../finance/spending-common.js";
import { requestDigest } from "../procurement/p2p/p2p-common.js";
import { toCalendarDate } from "../projects/project-mappers.js";
import { bqInForce, measurable } from "../progress/valuations/valuation-common.js";
import {
  advancesPaidBy,
  lastCertifiedLines,
  linesOf,
  measuredAt,
  otherClaims,
  type LineInForce,
  type Tx,
} from "./subcontracts-common.js";

export type SubcontractRow = Prisma.SubcontractGetPayload<object>;
export type CertificateRow = Prisma.SubcontractCertificateGetPayload<object>;

export const termsOf = (row: SubcontractRow): SubcontractTerms => ({
  retentionPercent: trimDecimal(row.retentionPercent),
  retentionLimitPercent:
    row.retentionLimitPercent === null ? null : trimDecimal(row.retentionLimitPercent),
  practicalReleasePercent: trimDecimal(row.practicalReleasePercent),
  vatPercent: trimDecimal(row.vatPercent),
  whtPercent: trimDecimal(row.whtPercent),
  advanceRecoveryPercent: trimDecimal(row.advanceRecoveryPercent),
});

export type CertificateProblem = { code: string; ref: string | null };

export type ComputedLine = {
  line: LineInForce;
  quantityToDate: string;
  previousQuantity: string;
  previousMinor: number;
  valueToDateMinor: number;
  measuredToDate: string | null;
  otherClaims: string;
  availableQuantity: string;
};

export type ComputedCertificate = {
  terms: SubcontractTerms;
  originalValueMinor: number;
  contractVersion: number;
  stage: RetentionStage;
  figures: SubcontractCertificateFigures;
  lines: ComputedLine[];
  problems: CertificateProblem[];
  warnings: CertificateProblem[];
  digest: string;
};

const refOf = (line: LineInForce) => line.row.bqItem.ref ?? line.row.description.slice(0, 30);

/**
 * A certificate computed now (rule KE-SUB-1): a draft's preview, what submission freezes and what
 * certification must find unchanged. Quantities to date are the preparer's claims (a line not
 * claimed carries its last certified quantity forward; a retention release carries every line).
 * Problems block submission; warnings do not.
 */
export async function computeSubcontractCertificateNow(
  tx: Tx,
  tenantId: string,
  certificate: CertificateRow,
  subcontract: SubcontractRow,
): Promise<ComputedCertificate> {
  const date = toCalendarDate(certificate.valuationDate);
  const terms = termsOf(subcontract);
  const lines = (await linesOf(tx, tenantId, subcontract.id)).filter((line) => line.inForce);
  const [claims, previous, prior, version] = await Promise.all([
    tx.subcontractCertificateClaim.findMany({ where: { tenantId, certificateId: certificate.id } }),
    lastCertifiedLines(tx, tenantId, subcontract.id),
    tx.subcontractCertificate.findMany({
      where: {
        tenantId,
        subcontractId: subcontract.id,
        status: "certified",
        id: { not: certificate.id },
      },
      orderBy: { certificateNumber: "asc" },
    }),
    bqInForce(tx, tenantId, subcontract.projectId),
  ]);
  const items = version
    ? await tx.bqItem.findMany({ where: { tenantId, versionId: version.id } })
    : [];
  const basisOf = new Map(
    items.map((item) => [item.lineageId, measurementBasis(measurable(item))]),
  );
  const others = await otherClaims(tx, tenantId, subcontract.projectId, subcontract.id);
  const measuredOwn = await measuredAt(tx, tenantId, subcontract.projectId, date);
  const laterDates = [
    ...new Set([...others.values()].map((entry) => entry.latest).filter((day) => day > date)),
  ];
  const measuredLater = new Map<string, Map<string, { quantity: string; measuredOn: string }>>();
  for (const day of laterDates)
    measuredLater.set(day, await measuredAt(tx, tenantId, subcontract.projectId, day));

  const problems: CertificateProblem[] = [];
  const warnings: CertificateProblem[] = [];
  const release = certificate.kind === "retention_release";
  const computedLines: ComputedLine[] = lines.map((line) => {
    const claim = claims.find((entry) => entry.lineId === line.row.id);
    const before = previous.get(line.row.id);
    const previousQuantity = before?.quantity ?? "0";
    const quantityToDate = release
      ? previousQuantity
      : claim
        ? trimDecimal(claim.quantityToDate)
        : previousQuantity;
    const lineage = line.row.bqItemLineageId;
    const measured = measuredOwn.get(lineage)?.quantity ?? null;
    const other = others.get(lineage);
    const otherQuantity = other?.quantity ?? "0";
    if (scaled(quantityToDate, 4) > scaled(line.quantity, 4))
      problems.push({ code: "claim-exceeds-line", ref: refOf(line) });
    const basis = basisOf.get(lineage);
    if (basis !== undefined && basis !== null && basis !== line.row.basis)
      problems.push({ code: "basis-changed", ref: refOf(line) });
    if (!release && scaled(quantityToDate, 4) > 0n) {
      const latest = other && other.latest > date ? other.latest : date;
      const measuredAtLatest =
        latest === date ? measured : (measuredLater.get(latest)?.get(lineage)?.quantity ?? null);
      const combined = scaled(sumQuantities([quantityToDate, otherQuantity]), 4);
      if (
        combined > scaled(measuredAtLatest ?? "0", 4) ||
        scaled(quantityToDate, 4) > scaled(measured ?? "0", 4)
      )
        problems.push({ code: "claim-exceeds-measured", ref: refOf(line) });
    }
    const valueToDateMinor = subcontractLineValueMinor(line.terms, quantityToDate);
    if (valueToDateMinor < (before?.valueMinor ?? 0))
      warnings.push({ code: "line-reduced", ref: refOf(line) });
    return {
      line,
      quantityToDate,
      previousQuantity,
      previousMinor: before?.valueMinor ?? 0,
      valueToDateMinor,
      measuredToDate: measured,
      otherClaims: otherQuantity,
      availableQuantity: suggestedClaim({
        lineQuantity: line.quantity,
        measured: measured ?? "0",
        otherClaims: otherQuantity,
      }),
    };
  });

  const workDoneMinor = computedLines.reduce((sum, line) => sum + line.valueToDateMinor, 0);
  const vatableWorkDoneMinor = computedLines
    .filter((line) => line.line.terms.vatTreatment === "standard")
    .reduce((sum, line) => sum + line.valueToDateMinor, 0);
  const releases = prior
    .filter((row) => row.kind === "retention_release" && row.releaseStage)
    .map((row) => row.releaseStage as ReleaseStage);
  const stage: RetentionStage = release
    ? (certificate.releaseStage as ReleaseStage)
    : retentionStageAfter(releases);
  const originalValueMinor = minorOf(subcontract.originalValueMinor ?? 0n);
  const figures = computeSubcontractCertificate({
    workDoneMinor,
    vatableWorkDoneMinor,
    originalValueMinor,
    stage,
    advancesPaidMinor: await advancesPaidBy(tx, tenantId, subcontract.id, date),
    previousCertifiedMinor: prior.reduce((sum, row) => sum + minorOf(row.amountDueMinor ?? 0n), 0),
    terms,
  });

  const last = prior.at(-1);
  if (date > nairobiDate() || (last && date < toCalendarDate(last.valuationDate)))
    problems.push({ code: "certificate-date-invalid", ref: null });
  if (!release && subcontract.status !== "active")
    problems.push({ code: "invalid-transition", ref: null });
  if (release) {
    if (!last) problems.push({ code: "no-certified-certificate", ref: null });
    else {
      const check = releaseWithinHeld(figures, minorOf(last.retentionHeldMinor ?? 0n));
      if (check !== "ok") problems.push({ code: check, ref: null });
    }
  }
  if (figures.amountDueMinor < 0) warnings.push({ code: "negative-amount", ref: null });

  const digest = requestDigest("subcontract.certificate", {
    certificateId: certificate.id,
    kind: certificate.kind,
    releaseStage: certificate.releaseStage,
    valuationDate: date,
    contractVersion: subcontract.contractVersion,
    originalValueMinor,
    terms,
    figures,
    lines: computedLines.map((line) => ({
      lineId: line.line.row.id,
      quantity: line.line.quantity,
      amountMinor: line.line.amountMinor,
      quantityToDate: line.quantityToDate,
      valueToDateMinor: line.valueToDateMinor,
      previousMinor: line.previousMinor,
    })),
  });
  return {
    terms,
    originalValueMinor,
    contractVersion: subcontract.contractVersion,
    stage,
    figures,
    lines: computedLines,
    problems,
    warnings,
    digest,
  };
}

/** The frozen columns written at submission. */
export function frozenColumns(computed: ComputedCertificate) {
  const { figures, terms } = computed;
  return {
    ruleVersion: SUBCONTRACT_RULE_VERSION,
    contractVersion: computed.contractVersion,
    retentionPercent: terms.retentionPercent,
    retentionLimitPercent: terms.retentionLimitPercent,
    practicalReleasePercent: terms.practicalReleasePercent,
    vatPercent: terms.vatPercent,
    whtPercent: terms.whtPercent,
    advanceRecoveryPercent: terms.advanceRecoveryPercent,
    originalValueMinor: BigInt(computed.originalValueMinor),
    workDoneMinor: BigInt(figures.workDoneMinor),
    vatableWorkDoneMinor: BigInt(figures.vatableWorkDoneMinor),
    retentionStage: figures.retentionStage,
    retentionLimitMinor:
      figures.retentionLimitMinor === null ? null : BigInt(figures.retentionLimitMinor),
    retentionComputedMinor: BigInt(figures.retentionComputedMinor),
    retentionHeldMinor: BigInt(figures.retentionHeldMinor),
    advancesPaidMinor: BigInt(figures.advancesPaidMinor),
    recoveredToDateMinor: BigInt(figures.recoveredToDateMinor),
    netToDateMinor: BigInt(figures.netToDateMinor),
    previousCertifiedMinor: BigInt(figures.previousCertifiedMinor),
    amountDueMinor: BigInt(figures.amountDueMinor),
    vatMinor: BigInt(figures.vatMinor),
    whtMinor: BigInt(figures.whtMinor),
    payableMinor: BigInt(figures.payableMinor),
    lineCount: computed.lines.length,
    digest: computed.digest,
  };
}

/** A returned certificate goes back to draft without figures. */
export const clearedColumns = {
  ruleVersion: null,
  contractVersion: null,
  retentionPercent: null,
  retentionLimitPercent: null,
  practicalReleasePercent: null,
  vatPercent: null,
  whtPercent: null,
  advanceRecoveryPercent: null,
  originalValueMinor: null,
  workDoneMinor: null,
  vatableWorkDoneMinor: null,
  retentionStage: null,
  retentionLimitMinor: null,
  retentionComputedMinor: null,
  retentionHeldMinor: null,
  advancesPaidMinor: null,
  recoveredToDateMinor: null,
  netToDateMinor: null,
  previousCertifiedMinor: null,
  amountDueMinor: null,
  vatMinor: null,
  whtMinor: null,
  payableMinor: null,
  lineCount: 0,
  digest: null,
  submittedAt: null,
} as const;

/** Rows for subcontract_certificate_lines, numbered from 1. */
export function lineRows(
  tenantId: string,
  certificateId: string,
  revision: number,
  computed: ComputedCertificate,
) {
  return computed.lines.map((line, index) => ({
    tenantId,
    certificateId,
    revision,
    lineNo: index + 1,
    lineId: line.line.row.id,
    bqItemLineageId: line.line.row.bqItemLineageId,
    basis: line.line.row.basis,
    description: line.line.row.description,
    unit: line.line.row.unit,
    rateMinor: line.line.row.rateMinor,
    lineQuantity: line.line.quantity,
    lineAmountMinor: BigInt(line.line.amountMinor),
    vatTreatment: line.line.row.vatTreatment,
    measuredToDate: line.measuredToDate,
    quantityToDate: line.quantityToDate,
    previousQuantity: line.previousQuantity,
    previousMinor: BigInt(line.previousMinor),
    valueToDateMinor: BigInt(line.valueToDateMinor),
  }));
}

/** The figures stored on a submitted or certified certificate. */
export const storedFigures = (row: CertificateRow): SubcontractCertificateFigures => ({
  workDoneMinor: minorOf(row.workDoneMinor!),
  vatableWorkDoneMinor: minorOf(row.vatableWorkDoneMinor!),
  retentionStage: row.retentionStage as RetentionStage,
  retentionLimitMinor: row.retentionLimitMinor === null ? null : minorOf(row.retentionLimitMinor),
  retentionComputedMinor: minorOf(row.retentionComputedMinor!),
  retentionHeldMinor: minorOf(row.retentionHeldMinor!),
  advancesPaidMinor: minorOf(row.advancesPaidMinor!),
  recoveredToDateMinor: minorOf(row.recoveredToDateMinor!),
  advancesOutstandingMinor: minorOf(row.advancesPaidMinor!) - minorOf(row.recoveredToDateMinor!),
  netToDateMinor: minorOf(row.netToDateMinor!),
  previousCertifiedMinor: minorOf(row.previousCertifiedMinor!),
  amountDueMinor: minorOf(row.amountDueMinor!),
  vatMinor: minorOf(row.vatMinor!),
  whtMinor: minorOf(row.whtMinor!),
  payableMinor: minorOf(row.payableMinor!),
});

export const storedTerms = (row: CertificateRow): SubcontractTerms => ({
  retentionPercent: trimDecimal(row.retentionPercent!),
  retentionLimitPercent:
    row.retentionLimitPercent === null ? null : trimDecimal(row.retentionLimitPercent),
  practicalReleasePercent: trimDecimal(row.practicalReleasePercent!),
  vatPercent: trimDecimal(row.vatPercent!),
  whtPercent: trimDecimal(row.whtPercent!),
  advanceRecoveryPercent: trimDecimal(row.advanceRecoveryPercent!),
});

export type StoredLine = {
  lineId: string;
  lineNo: number;
  bqItemLineageId: string;
  basis: SubcontractLineBasis;
  description: string;
  unit: string | null;
  rateMinor: number | null;
  lineQuantity: string;
  lineAmountMinor: number;
  vatTreatment: SubcontractVatTreatment;
  measuredToDate: string | null;
  quantityToDate: string;
  previousQuantity: string;
  previousMinor: number;
  valueToDateMinor: number;
};

export async function storedLines(
  tx: Tx,
  tenantId: string,
  certificateId: string,
  revision: number,
): Promise<StoredLine[]> {
  const rows = await tx.subcontractCertificateLine.findMany({
    where: { tenantId, certificateId, revision },
    orderBy: { lineNo: "asc" },
  });
  return rows.map((row) => ({
    lineId: row.lineId,
    lineNo: row.lineNo,
    bqItemLineageId: row.bqItemLineageId,
    basis: row.basis as SubcontractLineBasis,
    description: row.description,
    unit: row.unit,
    rateMinor: row.rateMinor === null ? null : minorOf(row.rateMinor),
    lineQuantity: trimDecimal(row.lineQuantity),
    lineAmountMinor: minorOf(row.lineAmountMinor),
    vatTreatment: row.vatTreatment as SubcontractVatTreatment,
    measuredToDate: row.measuredToDate === null ? null : trimDecimal(row.measuredToDate),
    quantityToDate: trimDecimal(row.quantityToDate),
    previousQuantity: trimDecimal(row.previousQuantity),
    previousMinor: minorOf(row.previousMinor),
    valueToDateMinor: minorOf(row.valueToDateMinor),
  }));
}
