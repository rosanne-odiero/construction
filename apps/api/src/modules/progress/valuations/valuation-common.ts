import { ConflictException, HttpException } from "@nestjs/common";
import {
  measuredPercent,
  measuredValueMinor,
  measurementBasis,
  measurementState,
  type MeasurableItem,
} from "@pm-buddy/domain";
import {
  DEFAULT_CONTRACT_SETTINGS,
  type BqAmountSource,
  type BqItemKind,
  type MeasurementBasis,
  type MeasurementDecision,
  type MeasurementState,
  type MeasurementStatus,
} from "@pm-buddy/types";
import type { ContractSettings, Measurement } from "@pm-buddy/validation";
import { isCheckViolation } from "../../../common/database-errors.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { databaseMessage, minorOf, trimDecimal, type Tx } from "../../finance/spending-common.js";
import { peopleOf, personOf } from "../../procurement/procurement-mappers.js";
import { toCalendarDate } from "../../projects/project-mappers.js";

/** Stable problem codes of measurements and valuations (the web maps them to EN/SW messages). */
export type ValuationProblem =
  | "version-conflict"
  | "project-read-only"
  | "invalid-transition"
  | "maker-checker"
  | "bq-not-approved"
  | "bq-item-not-found"
  | "item-not-measurable"
  | "over-measure-reason-required"
  | "percent-over-100"
  | "measurement-future"
  | "measurement-not-found"
  | "measurement-not-pending"
  | "measurement-evidence-required"
  | "correction-date-mismatch"
  | "photo-not-in-project"
  | "too-many-photos"
  | "idempotency-key-required"
  | "idempotency-key-reused"
  | "measurement-id-conflict"
  | "valuation-open"
  | "valuation-stale"
  | "valuation-date-invalid"
  | "completion-not-certified"
  | "release-exists"
  | "nothing-to-release"
  | "release-exceeds-held"
  | "no-certified-interim"
  | "materials-exceed-remaining"
  | "recovery-exceeds-advance"
  | "too-many-materials"
  | "too-many-adjustments"
  | "valuation-too-large"
  | "export-too-large";

export const valuationProblem = (status: number, code: ValuationProblem, message: string) =>
  new HttpException({ code, message }, status);
export const valuationConflict = (code: ValuationProblem, message: string) =>
  new ConflictException({ code, message });
export const versionConflict = () =>
  valuationConflict(
    "version-conflict",
    "This record was changed by someone else. Reload and try again.",
  );
export const invalidTransition = (status: string) =>
  valuationConflict("invalid-transition", `Not possible while the record is ${status}`);
export const makerChecker = (message: string) => valuationProblem(403, "maker-checker", message);
export const readOnly = () =>
  valuationConflict("project-read-only", "Closed and cancelled projects are read-only");

/**
 * Maps the measurement and valuation trigger refusals (SQLSTATE 23514) to the API's problems, so
 * a rule the API missed still answers with a stable code (never a 500); null for other errors.
 */
export function valuationDatabaseProblem(error: unknown): Error | null {
  if (!isCheckViolation(error)) return null;
  const text = databaseMessage(error);
  if (/read-only/.test(text)) return readOnly();
  if (/other than its measurer|other than those who prepared/.test(text))
    return makerChecker("Someone independent must decide this");
  if (/approved with photo evidence/.test(text))
    return valuationConflict("measurement-evidence-required", "Add a site photo before approving");
  if (/waits for review|no longer reviewed/.test(text))
    return valuationConflict("measurement-not-pending", "This measurement is no longer pending");
  if (/at most six photos/.test(text))
    return valuationConflict("too-many-photos", "A measurement has at most six photos");
  if (/basis; provisional sums/.test(text))
    return valuationProblem(422, "item-not-measurable", "This item is not measured");
  if (/over-measure/.test(text))
    return valuationProblem(
      422,
      "over-measure-reason-required",
      "Give a reason for measuring more than the BQ quantity",
    );
  if (/same item and date/.test(text))
    return valuationProblem(
      422,
      "correction-date-mismatch",
      "A correction keeps the measured item and date",
    );
  if (/measurement is recorded by the signed-in user, not in the future/.test(text))
    return valuationProblem(422, "measurement-future", "Work cannot be measured in the future");
  if (/not in the future/.test(text))
    return valuationConflict(
      "valuation-date-invalid",
      "The date is in the future or before the last certificate",
    );
  if (/releases no more than is held/.test(text))
    return valuationConflict("release-exceeds-held", "This would release more than is held");
  if (/after the certified/.test(text))
    return valuationConflict(
      "completion-not-certified",
      "Retention is released after the completion is certified",
    );
  if (/never exceed what remains/.test(text))
    return valuationConflict(
      "materials-exceed-remaining",
      "Materials on site for an item cannot exceed what remains of it",
    );
  if (/never exceeds the advances/.test(text))
    return valuationConflict(
      "recovery-exceeds-advance",
      "Advance recovery cannot exceed the advances certified",
    );
  if (
    /nets off every certificate|BQ in force|contract settings in force|retention left|approved measurement|lines add up|stores at cost|exactly as submitted/.test(
      text,
    )
  )
    return valuationConflict("valuation-stale", "The valuation changed; reload and submit again");
  if (/at most 100 materials/.test(text))
    return valuationConflict("too-many-materials", "A valuation has at most 100 materials lines");
  if (/at most 50 adjustments/.test(text))
    return valuationConflict("too-many-adjustments", "A valuation has at most 50 adjustments");
  if (
    /never change|never edited|never deleted|only on an interim draft|status cannot change|only with their submission|contributors are only ever added|keeps its project/.test(
      text,
    )
  )
    return valuationConflict("invalid-transition", "Not possible in this state");
  if (/against an approved BQ version/.test(text))
    return valuationProblem(422, "bq-not-approved", "Work is measured against an approved BQ");
  if (/against a measured item/.test(text))
    return valuationProblem(422, "item-not-measurable", "Materials name a measured BQ item");
  if (/numbered one after another/.test(text)) return versionConflict();
  // Any other rule the database enforces (signed-in user, empty drafts, stamped times): a stable
  // conflict rather than a 500.
  return new ConflictException({ code: "conflict", message: "The database refused this change" });
}

/** The project row locked for numbering and checks (FOR UPDATE; the tenant lock also applies). */
export const lockProject = (tx: Tx, tenantId: string, projectId: string) =>
  tx.$queryRaw`SELECT id FROM projects WHERE tenant_id = ${tenantId}::uuid AND id = ${projectId}::uuid FOR UPDATE`;

// BQ helpers ----------------------------------------------------------------------------------

/** The BQ in force (the newest approved version) with its subtotal, or null. */
export async function bqInForce(tx: Tx, tenantId: string, projectId: string) {
  return tx.bqVersion.findFirst({
    where: { tenantId, projectId, status: "approved" },
    orderBy: [{ approvedAt: { sort: "desc", nulls: "last" } }, { versionNo: "desc" }],
    select: { id: true, versionNo: true, bqId: true, subtotalMinor: true },
  });
}

/** The approved baseline (the first approved version): the original contract sum. */
export async function bqBaseline(tx: Tx, tenantId: string, projectId: string) {
  return tx.bqVersion.findFirst({
    where: { tenantId, projectId, status: "approved" },
    orderBy: { versionNo: "asc" },
    select: { id: true, versionNo: true, subtotalMinor: true },
  });
}

export async function contractSumOf(tx: Tx, tenantId: string, projectId: string) {
  const [current, baseline] = await Promise.all([
    bqInForce(tx, tenantId, projectId),
    bqBaseline(tx, tenantId, projectId),
  ]);
  if (!current || !baseline) return null;
  return {
    originalMinor: minorOf(baseline.subtotalMinor),
    revisedMinor: minorOf(current.subtotalMinor),
    revisedVersionNo: current.versionNo,
  };
}

export const itemWithBill = {
  bill: { select: { lineageId: true, number: true, title: true, sortOrder: true } },
} as const;
export type ItemRow = Prisma.BqItemGetPayload<{ include: typeof itemWithBill }>;

export const measurable = (item: {
  kind: string;
  amountSource: string;
  quantity: Prisma.Decimal | null;
  rate: Prisma.Decimal | null;
  amountMinor: bigint;
}): MeasurableItem => ({
  kind: item.kind as BqItemKind,
  amountSource: item.amountSource as BqAmountSource,
  quantity: item.quantity === null ? null : item.quantity.toFixed(),
  rate: item.rate === null ? null : item.rate.toFixed(),
  amountMinor: minorOf(item.amountMinor),
});

export const decimalText = (value: Prisma.Decimal | null) =>
  value === null ? null : trimDecimal(value);

export const bqItemWire = (item: ItemRow) => ({
  versionId: item.versionId,
  lineageId: item.lineageId,
  ref: item.ref,
  description: item.description,
  unit: item.unit,
  bill: { lineageId: item.bill.lineageId, number: item.bill.number, title: item.bill.title },
});

// Contract settings ---------------------------------------------------------------------------

export type SettingsValues = {
  retentionPercent: string;
  retentionCapPercent: string | null;
  vatPercent: string;
  materialsPercent: string;
  practicalReleasePercent: string;
  version: number;
  updatedAt: Date | null;
  updatedBy: string | null;
};

/** The contract settings in force (the newest version) or the defaults (version 0). */
export async function settingsInForce(
  tx: Tx,
  tenantId: string,
  projectId: string,
): Promise<SettingsValues> {
  const row = await tx.contractSettings.findFirst({
    where: { tenantId, projectId },
    orderBy: { version: "desc" },
  });
  if (!row) return { ...DEFAULT_CONTRACT_SETTINGS, version: 0, updatedAt: null, updatedBy: null };
  return {
    retentionPercent: trimDecimal(row.retentionPercent),
    retentionCapPercent:
      row.retentionCapPercent === null ? null : trimDecimal(row.retentionCapPercent),
    vatPercent: trimDecimal(row.vatPercent),
    materialsPercent: trimDecimal(row.materialsPercent),
    practicalReleasePercent: trimDecimal(row.practicalReleasePercent),
    version: row.version,
    updatedAt: row.createdAt,
    updatedBy: row.createdBy,
  };
}

export async function settingsWire(tx: Tx, values: SettingsValues): Promise<ContractSettings> {
  const people = await peopleOf(tx, [values.updatedBy]);
  return {
    retentionPercent: values.retentionPercent,
    retentionCapPercent: values.retentionCapPercent,
    vatPercent: values.vatPercent,
    materialsPercent: values.materialsPercent,
    practicalReleasePercent: values.practicalReleasePercent,
    version: values.version,
    updatedAt: values.updatedAt?.toISOString() ?? null,
    updatedBy: values.updatedBy ? personOf(people, values.updatedBy) : null,
  };
}

// Measurements ----------------------------------------------------------------------------------

export const measurementInclude = {
  item: true,
  photos: {
    include: { photo: { select: { id: true, verified: true, caption: true } } },
    orderBy: { addedAt: "asc" },
  },
  review: true,
  correctedBy: { select: { id: true, review: { select: { decision: true } } } },
} as const satisfies Prisma.ProgressMeasurementInclude;

export type MeasurementRow = Prisma.ProgressMeasurementGetPayload<{
  include: typeof measurementInclude;
}>;

export const stateOf = (row: MeasurementRow): MeasurementState =>
  measurementState({
    decision: (row.review?.decision as MeasurementDecision | undefined) ?? null,
    correctedBy: row.correctedBy
      ? {
          decision: (row.correctedBy.review?.decision as MeasurementDecision | undefined) ?? null,
        }
      : null,
  });

/** What the caller may do with measurements on a project. */
export type MeasurementAbilities = {
  userId: string;
  canRecord: boolean;
  canApprove: boolean;
};

/** Measurements on the wire with their state, value and the caller's permissions. */
export async function measurementsWire(
  tx: Tx,
  rows: readonly MeasurementRow[],
  abilities: (projectId: string) => MeasurementAbilities,
): Promise<Measurement[]> {
  const people = await peopleOf(
    tx,
    rows.flatMap((row) => [row.measuredBy, row.review?.decidedBy ?? null]),
  );
  return rows.map((row) => {
    const can = abilities(row.projectId);
    const state = stateOf(row);
    const item = measurable(row.item);
    const quantity = row.quantityToDate.toFixed();
    const basis = (row.basis as MeasurementBasis | null) ?? null;
    const currentBasis = measurementBasis(item);
    const valued = currentBasis !== null && (basis ?? "quantity") === currentBasis;
    const pending = state === "pending";
    const own = row.measuredBy === can.userId;
    return {
      id: row.id,
      projectId: row.projectId,
      bqItem: {
        versionId: row.item.versionId,
        lineageId: row.item.lineageId,
        ref: row.item.ref,
        description: row.item.description,
        unit: row.item.unit,
      },
      measuredOn: toCalendarDate(row.measuredOn),
      quantityToDate: trimDecimal(row.quantityToDate),
      status: row.status as MeasurementStatus,
      state,
      basis,
      itemQuantity: decimalText(row.item.quantity),
      itemAmountMinor: minorOf(row.item.amountMinor),
      valueMinor: valued ? measuredValueMinor(item, quantity) : 0,
      percentComplete: valued ? measuredPercent(item, quantity) : null,
      overMeasured: row.overMeasureReason !== null,
      overMeasureReason: row.overMeasureReason,
      note: row.note,
      measuredBy: personOf(people, row.measuredBy),
      recordedAt: row.recordedAt.toISOString(),
      correctsMeasurementId: row.correctsId,
      correctionReason: row.correctionReason,
      corrected: row.correctedBy !== null,
      photos: row.photos.map((link) => ({
        id: link.photo.id,
        verified: link.photo.verified,
        caption: link.photo.caption,
      })),
      review: row.review
        ? {
            decision: row.review.decision as MeasurementDecision,
            reason: row.review.reason,
            decidedBy: personOf(people, row.review.decidedBy),
            decidedAt: row.review.decidedAt.toISOString(),
          }
        : null,
      permissions: {
        canApprove: can.canApprove && pending && !own && row.photos.length > 0,
        canReject: can.canApprove && pending && !own,
        canCorrect: can.canRecord && row.correctedBy === null && state !== "superseded",
        canAddPhotos: can.canRecord && pending && row.photos.length < 6,
      },
    };
  });
}

/** Approved measurements of a project that are not superseded: the input of measurementsInForce. */
export async function approvedMeasurements(tx: Tx, tenantId: string, projectId: string) {
  return tx.progressMeasurement.findMany({
    where: {
      tenantId,
      projectId,
      review: { is: { decision: "approved" } },
      NOT: { correctedBy: { is: { review: { is: { decision: "approved" } } } } },
    },
    select: {
      id: true,
      itemLineageId: true,
      measuredOn: true,
      recordedAt: true,
      quantityToDate: true,
      basis: true,
    },
  });
}
export type ApprovedMeasurement = Awaited<ReturnType<typeof approvedMeasurements>>[number];
