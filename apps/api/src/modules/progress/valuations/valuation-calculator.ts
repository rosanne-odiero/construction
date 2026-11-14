import {
  computeCertificate,
  measurementBasis,
  recoveryWithinAdvances,
  releaseCertificate,
  retentionStageAfter,
  type CertificateFigures,
  type ContractTerms,
} from "@pm-buddy/domain";
import {
  VALUATION_LIMITS,
  VALUATION_RULE_VERSION,
  type AdjustmentKind,
  type BqItemKind,
  type MaterialsSource,
  type MeasurementBasis,
  type ReleaseStage,
  type RetentionStage,
  type ValuationKind,
} from "@pm-buddy/types";
import type { ValuationWarning } from "@pm-buddy/validation";
import type { Prisma } from "../../../generated/prisma/client.js";
import { minorOf, trimDecimal, type Tx } from "../../finance/spending-common.js";
import { requestDigest } from "../../procurement/p2p/p2p-common.js";
import { toCalendarDate } from "../../projects/project-mappers.js";
import { valuedInForce } from "../measurements/measurements.service.js";
import {
  approvedMeasurements,
  bqBaseline,
  bqInForce,
  decimalText,
  itemWithBill,
  measurable,
  settingsInForce,
} from "./valuation-common.js";

export type ValuationRow = Prisma.ValuationGetPayload<object>;

export type ItemLine = {
  kind: "item";
  bqVersionId: string;
  lineageId: string;
  billLineageId: string;
  itemKind: BqItemKind;
  ref: string | null;
  description: string;
  unit: string | null;
  basis: MeasurementBasis | null;
  itemQuantity: string | null;
  rate: string | null;
  itemAmountMinor: number;
  measurementId: string | null;
  measuredOn: string | null;
  quantityToDate: string | null;
  percentComplete: string | null;
  overMeasured: boolean;
  previousMinor: number;
  amountMinor: number;
};
export type MaterialsLine = {
  kind: "materials";
  source: MaterialsSource;
  description: string;
  unit: string | null;
  quantity: string;
  amountMinor: number;
  bqVersionId: string | null;
  lineageId: string | null;
  storeId: string | null;
  materialId: string | null;
  reference: string | null;
};
export type AdjustmentLine = {
  kind: "adjustment";
  adjustmentKind: AdjustmentKind;
  description: string;
  amountMinor: number;
};
export type Terms = ContractTerms & { settingsVersion: number; ruleVersion: string };

export type ComputedValuation = {
  bqVersion: { id: string; versionNo: number } | null;
  contractSum: { originalMinor: number; revisedMinor: number; revisedVersionNo: number } | null;
  terms: Terms;
  stage: RetentionStage;
  figures: CertificateFigures;
  items: ItemLine[];
  materials: MaterialsLine[];
  adjustments: AdjustmentLine[];
  warnings: ValuationWarning[];
  digest: string;
  /** Why this valuation cannot be submitted as it stands (null when it can). */
  problem:
    | { code: "bq-not-approved" }
    | { code: "no-certified-interim" }
    | { code: "nothing-to-release" }
    | { code: "release-exceeds-held" }
    | { code: "materials-exceed-remaining"; ref: string }
    | { code: "recovery-exceeds-advance" }
    | { code: "valuation-date-invalid" }
    | { code: "valuation-too-large" }
    | null;
};

/** Lines of a stored revision, as written at submission. */
export async function storedLines(tx: Tx, tenantId: string, valuationId: string, revision: number) {
  return tx.valuationLine.findMany({
    where: { tenantId, valuationId, revision },
    orderBy: { lineNo: "asc" },
  });
}
type StoredLine = Awaited<ReturnType<typeof storedLines>>[number];

export const storedToLines = (rows: readonly StoredLine[]) => {
  const items: ItemLine[] = [];
  const materials: MaterialsLine[] = [];
  const adjustments: AdjustmentLine[] = [];
  for (const row of rows) {
    if (row.kind === "item")
      items.push({
        kind: "item",
        bqVersionId: row.bqVersionId!,
        lineageId: row.bqItemLineageId!,
        billLineageId: row.billLineageId!,
        itemKind: row.itemKind as BqItemKind,
        ref: row.ref,
        description: row.description,
        unit: row.unit,
        basis: row.basis as MeasurementBasis | null,
        itemQuantity: decimalText(row.itemQuantity),
        rate: decimalText(row.rate),
        itemAmountMinor: minorOf(row.itemAmountMinor ?? 0n),
        measurementId: row.measurementId,
        measuredOn: row.measuredOn ? toCalendarDate(row.measuredOn) : null,
        quantityToDate: decimalText(row.quantityToDate),
        percentComplete: row.percentComplete,
        overMeasured: row.overMeasured,
        previousMinor: minorOf(row.previousMinor),
        amountMinor: minorOf(row.amountMinor),
      });
    else if (row.kind === "materials")
      materials.push({
        kind: "materials",
        source: row.source as MaterialsSource,
        description: row.description,
        unit: row.unit,
        quantity: row.quantity === null ? "0" : trimDecimal(row.quantity),
        amountMinor: minorOf(row.amountMinor),
        bqVersionId: row.bqVersionId,
        lineageId: row.bqItemLineageId,
        storeId: row.storeId,
        materialId: row.materialId,
        reference: row.reference,
      });
    else
      adjustments.push({
        kind: "adjustment",
        adjustmentKind: row.adjustmentKind as AdjustmentKind,
        description: row.description,
        amountMinor: minorOf(row.amountMinor),
      });
  }
  return { items, materials, adjustments };
};

/** Frozen figures of a submitted or certified valuation. */
export const storedFigures = (row: ValuationRow): CertificateFigures => ({
  workDoneMinor: minorOf(row.workDoneMinor!),
  materialsGrossMinor: minorOf(row.materialsGrossMinor!),
  materialsMinor: minorOf(row.materialsMinor!),
  grossMinor: minorOf(row.grossMinor!),
  retentionStage: row.retentionStage as RetentionStage,
  retentionCapMinor: row.retentionCapMinor === null ? null : minorOf(row.retentionCapMinor),
  retentionComputedMinor: minorOf(row.retentionComputedMinor!),
  retentionHeldMinor: minorOf(row.retentionHeldMinor!),
  adjustmentsMinor: minorOf(row.adjustmentsMinor!),
  adjustmentsToDateMinor: minorOf(row.adjustmentsToDateMinor!),
  netToDateMinor: minorOf(row.netToDateMinor!),
  previousCertifiedMinor: minorOf(row.previousCertifiedMinor!),
  amountDueMinor: minorOf(row.amountDueMinor!),
  vatMinor: minorOf(row.vatMinor!),
  totalMinor: minorOf(row.totalMinor!),
});

export const storedTerms = (row: ValuationRow): Terms => ({
  retentionPercent: trimDecimal(row.retentionPercent!),
  retentionCapPercent:
    row.retentionCapPercent === null ? null : trimDecimal(row.retentionCapPercent),
  vatPercent: trimDecimal(row.vatPercent!),
  materialsPercent: trimDecimal(row.materialsPercent!),
  practicalReleasePercent: trimDecimal(row.practicalReleasePercent!),
  settingsVersion: row.settingsVersion!,
  ruleVersion: row.ruleVersion!,
});

/** Materials on hand in the project's stores at cost (net of VAT) at the end of `date`. */
export async function storesOnHand(tx: Tx, tenantId: string, projectId: string, date: string) {
  return tx.$queryRaw<
    {
      store_id: string;
      store_name: string;
      material_id: string;
      material_name: string;
      base_unit: string;
      quantity: string;
      value: bigint;
    }[]
  >`
    SELECT b.store_id, s.name AS store_name, b.material_id, m.name AS material_name, m.base_unit,
           b.balance_quantity::text AS quantity, round(b.balance_value_minor)::bigint AS value
      FROM (
        SELECT DISTINCT ON (e.store_id, e.material_id) e.store_id, e.material_id,
               e.balance_quantity, e.balance_value_minor
          FROM stock_ledger_entries e
         WHERE e.tenant_id = ${tenantId}::uuid AND e.project_id = ${projectId}::uuid
           AND e.business_date <= ${date}::date
         ORDER BY e.store_id, e.material_id, e.seq DESC
      ) b
      JOIN stores s ON s.tenant_id = ${tenantId}::uuid AND s.id = b.store_id
      JOIN materials m ON m.tenant_id = ${tenantId}::uuid AND m.id = b.material_id
     WHERE b.balance_quantity > 0 AND round(b.balance_value_minor) > 0
     ORDER BY s.name, m.name, b.store_id, b.material_id`;
}

/** Certified valuations of a project (oldest first), excluding `exceptId`. */
export async function certifiedOf(tx: Tx, tenantId: string, projectId: string, exceptId?: string) {
  return tx.valuation.findMany({
    where: {
      tenantId,
      projectId,
      status: "certified",
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    orderBy: { certificateNumber: "asc" },
  });
}

/**
 * Computes a valuation now from the database (packages/domain rule KE-VAL-1): the lines (items
 * valued from the approved measurements in force on the valuation date on the BQ in force,
 * materials on site, adjustments), the figures, warnings, what blocks a submission, and the
 * SHA-256 digest a certifier quotes. A retention release carries the last certificate forward.
 */
export async function computeValuation(
  tx: Tx,
  tenantId: string,
  valuation: ValuationRow,
): Promise<ComputedValuation> {
  const projectId = valuation.projectId;
  const date = toCalendarDate(valuation.valuationDate);
  const [current, baseline, settings, certified, pending] = await Promise.all([
    bqInForce(tx, tenantId, projectId),
    bqBaseline(tx, tenantId, projectId),
    settingsInForce(tx, tenantId, projectId),
    certifiedOf(tx, tenantId, projectId, valuation.id),
    tx.progressMeasurement.count({
      where: {
        tenantId,
        projectId,
        measuredOn: { lte: valuation.valuationDate },
        review: { is: null },
        correctedBy: { is: null },
      },
    }),
  ]);
  const terms: Terms = {
    retentionPercent: settings.retentionPercent,
    retentionCapPercent: settings.retentionCapPercent,
    vatPercent: settings.vatPercent,
    materialsPercent: settings.materialsPercent,
    practicalReleasePercent: settings.practicalReleasePercent,
    settingsVersion: settings.version,
    ruleVersion: VALUATION_RULE_VERSION,
  };
  const contractSum =
    current && baseline
      ? {
          originalMinor: minorOf(baseline.subtotalMinor),
          revisedMinor: minorOf(current.subtotalMinor),
          revisedVersionNo: current.versionNo,
        }
      : null;
  const previousCertifiedMinor = certified.reduce(
    (sum, row) => sum + minorOf(row.amountDueMinor!),
    0,
  );
  const adjustmentsBeforeMinor = certified.reduce(
    (sum, row) => sum + minorOf(row.adjustmentsMinor!),
    0,
  );
  const last = certified.at(-1) ?? null;
  const lastLines = last
    ? storedToLines(await storedLines(tx, tenantId, last.id, last.revision))
    : null;
  const warnings: ValuationWarning[] = [];
  if (pending) warnings.push({ code: "pending-measurements", count: pending });
  const kind = valuation.kind as ValuationKind;
  let problem: ComputedValuation["problem"] = null;
  if (last && date < toCalendarDate(last.valuationDate))
    problem = { code: "valuation-date-invalid" };

  let items: ItemLine[] = [];
  let materials: MaterialsLine[] = [];
  const adjustments: AdjustmentLine[] = [];
  let stage: RetentionStage;
  let figures: CertificateFigures;

  if (kind === "retention_release") {
    stage = valuation.releaseStage as ReleaseStage;
    if (!last || !lastLines) {
      problem ??= { code: "no-certified-interim" };
      figures = computeCertificate({
        workDoneMinor: 0,
        materialsGrossMinor: 0,
        adjustmentsMinor: 0,
        adjustmentsBeforeMinor,
        previousCertifiedMinor,
        stage,
        originalContractSumMinor: contractSum?.originalMinor ?? 0,
        terms,
      });
    } else {
      items = lastLines.items.map((line) => ({ ...line, previousMinor: line.amountMinor }));
      materials = lastLines.materials;
      const release = releaseCertificate({
        previous: {
          workDoneMinor: minorOf(last.workDoneMinor!),
          materialsGrossMinor: minorOf(last.materialsGrossMinor!),
          adjustmentsToDateMinor: minorOf(last.adjustmentsToDateMinor!),
          retentionHeldMinor: minorOf(last.retentionHeldMinor!),
        },
        previousCertifiedMinor,
        stage,
        originalContractSumMinor: contractSum?.originalMinor ?? 0,
        terms,
      });
      if (release.ok) figures = release.figures;
      else {
        problem ??= { code: release.problem };
        figures = computeCertificate({
          workDoneMinor: minorOf(last.workDoneMinor!),
          materialsGrossMinor: minorOf(last.materialsGrossMinor!),
          adjustmentsMinor: 0,
          adjustmentsBeforeMinor,
          previousCertifiedMinor,
          stage,
          originalContractSumMinor: contractSum?.originalMinor ?? 0,
          terms,
        });
      }
    }
  } else {
    stage = retentionStageAfter(
      certified
        .filter((row) => row.kind === "retention_release")
        .map((row) => row.releaseStage as ReleaseStage),
    );
    if (!current) problem ??= { code: "bq-not-approved" };
    const [bqItems, approved, inputs, inputAdjustments, stock] = await Promise.all([
      current
        ? tx.bqItem.findMany({
            where: { tenantId, versionId: current.id },
            include: itemWithBill,
            orderBy: [{ bill: { sortOrder: "asc" } }, { sortOrder: "asc" }],
          })
        : Promise.resolve([]),
      approvedMeasurements(tx, tenantId, projectId),
      tx.valuationMaterial.findMany({
        where: { tenantId, valuationId: valuation.id },
        orderBy: { createdAt: "asc" },
      }),
      tx.valuationAdjustment.findMany({
        where: { tenantId, valuationId: valuation.id },
        orderBy: { createdAt: "asc" },
      }),
      valuation.materialsFromStores
        ? storesOnHand(tx, tenantId, projectId, date)
        : Promise.resolve([]),
    ]);
    const inForce = valuedInForce(bqItems, approved, date);
    const previous = new Map(lastLines?.items.map((line) => [line.lineageId, line.amountMinor]));
    let omitted = 0;
    for (const item of bqItems) {
      const valued = inForce.get(item.lineageId);
      const previousMinor = previous.get(item.lineageId) ?? 0;
      if (!valued && previousMinor === 0) continue;
      const basis = measurementBasis(measurable(item));
      if (basis === null && previousMinor !== 0) omitted += 1;
      items.push({
        kind: "item",
        bqVersionId: item.versionId,
        lineageId: item.lineageId,
        billLineageId: item.bill.lineageId,
        itemKind: item.kind as BqItemKind,
        ref: item.ref,
        description: item.description,
        unit: item.unit,
        basis,
        itemQuantity: decimalText(item.quantity),
        rate: decimalText(item.rate),
        itemAmountMinor: minorOf(item.amountMinor),
        measurementId: valued?.id ?? null,
        measuredOn: valued ? toCalendarDate(valued.measuredOn) : null,
        quantityToDate: valued ? trimDecimal(valued.quantityToDate) : null,
        percentComplete: valued?.percentComplete ?? null,
        overMeasured:
          valued !== undefined &&
          basis === "quantity" &&
          item.quantity !== null &&
          valued.quantityToDate.greaterThan(item.quantity),
        previousMinor,
        amountMinor: valued?.valueMinor ?? 0,
      });
    }
    if (omitted) warnings.push({ code: "omitted-item", count: omitted });
    const basisChanged = new Set(
      approved
        .filter((row) => {
          const item = bqItems.find((candidate) => candidate.lineageId === row.itemLineageId);
          const basis = item ? measurementBasis(measurable(item)) : null;
          return basis !== null && (row.basis ?? "quantity") !== basis;
        })
        .map((row) => row.itemLineageId),
    );
    if (basisChanged.size) warnings.push({ code: "basis-changed", count: basisChanged.size });
    if (!items.some((line) => line.measurementId))
      warnings.push({ code: "no-measurements", count: 0 });

    materials = [
      ...inputs.map((input): MaterialsLine => ({
        kind: "materials",
        source: "manual",
        description: input.description,
        unit: input.unit,
        quantity: trimDecimal(input.quantity),
        amountMinor: minorOf(input.amountMinor),
        bqVersionId: current?.id ?? input.bqVersionId,
        lineageId: input.bqItemLineageId,
        storeId: null,
        materialId: null,
        reference: input.reference,
      })),
      ...stock.map((row): MaterialsLine => ({
        kind: "materials",
        source: "stores",
        description: `${row.material_name} · ${row.store_name}`,
        unit: row.base_unit,
        quantity: trimDecimal({ toFixed: () => row.quantity }),
        amountMinor: minorOf(row.value),
        bqVersionId: null,
        lineageId: null,
        storeId: row.store_id,
        materialId: row.material_id,
        reference: null,
      })),
    ];
    // Entered materials never take an item above what remains of it (no double billing once
    // the materials are built in and measured).
    const byItem = new Map<string, number>();
    for (const line of materials)
      if (line.lineageId)
        byItem.set(line.lineageId, (byItem.get(line.lineageId) ?? 0) + line.amountMinor);
    for (const [lineage, amount] of byItem) {
      const item = bqItems.find((candidate) => candidate.lineageId === lineage);
      const valued = inForce.get(lineage)?.valueMinor ?? 0;
      if (!item || amount + valued > minorOf(item.amountMinor)) {
        problem ??= {
          code: "materials-exceed-remaining",
          ref: item?.ref ?? item?.description ?? lineage,
        };
        break;
      }
    }
    for (const adjustment of inputAdjustments)
      adjustments.push({
        kind: "adjustment",
        adjustmentKind: adjustment.kind as AdjustmentKind,
        description: adjustment.description,
        amountMinor: minorOf(adjustment.amountMinor),
      });
    if (adjustments.length) {
      const earlier = await tx.$queryRaw<{ kind: string; amount: bigint }[]>`
        SELECT l.adjustment_kind AS kind, l.amount_minor AS amount
          FROM valuation_lines l
          JOIN valuations c ON c.tenant_id = l.tenant_id AND c.id = l.valuation_id
                           AND c.revision = l.revision
         WHERE l.tenant_id = ${tenantId}::uuid AND c.project_id = ${projectId}::uuid
           AND c.status = 'certified' AND l.kind = 'adjustment'`;
      if (
        !recoveryWithinAdvances([
          ...earlier.map((row) => ({
            kind: row.kind as AdjustmentKind,
            amountMinor: minorOf(row.amount),
          })),
          ...adjustments.map((line) => ({
            kind: line.adjustmentKind,
            amountMinor: line.amountMinor,
          })),
        ])
      )
        problem ??= { code: "recovery-exceeds-advance" };
    }
    figures = computeCertificate({
      workDoneMinor: items.reduce((sum, line) => sum + line.amountMinor, 0),
      materialsGrossMinor: materials.reduce((sum, line) => sum + line.amountMinor, 0),
      adjustmentsMinor: adjustments.reduce((sum, line) => sum + line.amountMinor, 0),
      adjustmentsBeforeMinor,
      previousCertifiedMinor,
      stage,
      originalContractSumMinor: contractSum?.originalMinor ?? 0,
      terms,
    });
  }
  if (figures.amountDueMinor < 0) warnings.push({ code: "negative-amount", count: 0 });
  // Cumulative figures: fewer materials on site than last time takes the difference back. Right
  // once they are built in and measured, wrong if they are still on site (check before submitting).
  const lastInterim = certified.filter((row) => row.kind === "interim").at(-1);
  if (
    kind === "interim" &&
    lastInterim &&
    figures.materialsGrossMinor < minorOf(lastInterim.materialsGrossMinor ?? 0n)
  )
    warnings.push({ code: "materials-reduced", count: 0 });
  if (items.length + materials.length + adjustments.length > VALUATION_LIMITS.linesPerValuation)
    problem ??= { code: "valuation-too-large" };

  const bqVersion = current ? { id: current.id, versionNo: current.versionNo } : null;
  const digest = requestDigest("valuation.certificate", {
    valuationId: valuation.id,
    kind,
    releaseStage: valuation.releaseStage,
    valuationDate: date,
    materialsFromStores: valuation.materialsFromStores,
    bqVersionId: bqVersion?.id ?? null,
    contractSum,
    terms,
    figures,
    items,
    materials,
    adjustments,
  });
  return {
    bqVersion,
    contractSum,
    terms,
    stage,
    figures,
    items,
    materials,
    adjustments,
    warnings,
    digest,
    problem,
  };
}

/** Rows for valuation_lines (items, then materials, then adjustments), numbered from 1. */
export function lineRows(
  tenantId: string,
  valuationId: string,
  revision: number,
  computed: Pick<ComputedValuation, "items" | "materials" | "adjustments">,
): Prisma.ValuationLineCreateManyInput[] {
  let lineNo = 0;
  const base = () => ({ tenantId, valuationId, revision, lineNo: (lineNo += 1) });
  return [
    ...computed.items.map((line) => ({
      ...base(),
      kind: "item",
      bqVersionId: line.bqVersionId,
      bqItemLineageId: line.lineageId,
      billLineageId: line.billLineageId,
      itemKind: line.itemKind,
      ref: line.ref,
      description: line.description,
      unit: line.unit,
      basis: line.basis,
      itemQuantity: line.itemQuantity,
      rate: line.rate,
      itemAmountMinor: BigInt(line.itemAmountMinor),
      measurementId: line.measurementId,
      measuredOn: line.measuredOn ? new Date(`${line.measuredOn}T00:00:00.000Z`) : null,
      quantityToDate: line.quantityToDate,
      percentComplete: line.percentComplete,
      overMeasured: line.overMeasured,
      previousMinor: BigInt(line.previousMinor),
      amountMinor: BigInt(line.amountMinor),
    })),
    ...computed.materials.map((line) => ({
      ...base(),
      kind: "materials",
      source: line.source,
      description: line.description,
      unit: line.unit,
      quantity: line.quantity,
      amountMinor: BigInt(line.amountMinor),
      bqVersionId: line.bqVersionId,
      bqItemLineageId: line.lineageId,
      storeId: line.storeId,
      materialId: line.materialId,
      reference: line.reference,
    })),
    ...computed.adjustments.map((line) => ({
      ...base(),
      kind: "adjustment",
      adjustmentKind: line.adjustmentKind,
      description: line.description,
      amountMinor: BigInt(line.amountMinor),
    })),
  ];
}

/** Header columns frozen at submission. */
export function frozenColumns(computed: ComputedValuation) {
  const { figures, terms, contractSum } = computed;
  return {
    bqVersionId: computed.bqVersion?.id ?? null,
    settingsVersion: terms.settingsVersion,
    ruleVersion: terms.ruleVersion,
    retentionPercent: terms.retentionPercent,
    retentionCapPercent: terms.retentionCapPercent,
    vatPercent: terms.vatPercent,
    materialsPercent: terms.materialsPercent,
    practicalReleasePercent: terms.practicalReleasePercent,
    originalContractSumMinor: BigInt(contractSum?.originalMinor ?? 0),
    revisedContractSumMinor: BigInt(contractSum?.revisedMinor ?? 0),
    workDoneMinor: BigInt(figures.workDoneMinor),
    materialsGrossMinor: BigInt(figures.materialsGrossMinor),
    materialsMinor: BigInt(figures.materialsMinor),
    grossMinor: BigInt(figures.grossMinor),
    retentionStage: figures.retentionStage,
    retentionCapMinor:
      figures.retentionCapMinor === null ? null : BigInt(figures.retentionCapMinor),
    retentionComputedMinor: BigInt(figures.retentionComputedMinor),
    retentionHeldMinor: BigInt(figures.retentionHeldMinor),
    adjustmentsMinor: BigInt(figures.adjustmentsMinor),
    adjustmentsToDateMinor: BigInt(figures.adjustmentsToDateMinor),
    netToDateMinor: BigInt(figures.netToDateMinor),
    previousCertifiedMinor: BigInt(figures.previousCertifiedMinor),
    amountDueMinor: BigInt(figures.amountDueMinor),
    vatMinor: BigInt(figures.vatMinor),
    totalMinor: BigInt(figures.totalMinor),
    lineCount: computed.items.length + computed.materials.length + computed.adjustments.length,
    digest: computed.digest,
  };
}

/** Columns cleared when a submitted valuation returns to draft. */
export const clearedColumns = {
  bqVersionId: null,
  settingsVersion: null,
  ruleVersion: null,
  retentionPercent: null,
  retentionCapPercent: null,
  vatPercent: null,
  materialsPercent: null,
  practicalReleasePercent: null,
  originalContractSumMinor: null,
  revisedContractSumMinor: null,
  workDoneMinor: null,
  materialsGrossMinor: null,
  materialsMinor: null,
  grossMinor: null,
  retentionStage: null,
  retentionCapMinor: null,
  retentionComputedMinor: null,
  retentionHeldMinor: null,
  adjustmentsMinor: null,
  adjustmentsToDateMinor: null,
  netToDateMinor: null,
  previousCertifiedMinor: null,
  amountDueMinor: null,
  vatMinor: null,
  totalMinor: null,
  lineCount: 0,
  digest: null,
  submittedBy: null,
  submittedAt: null,
} as const;
