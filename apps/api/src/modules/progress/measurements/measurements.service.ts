import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Request } from "express";
import {
  checkMeasuredQuantity,
  measuredPercent,
  measuredValueMinor,
  measurementBasis,
  measurementsInForce,
  nairobiDate,
  percentText,
} from "@pm-buddy/domain";
import {
  MEASUREMENT_APPROVE_PERMISSIONS,
  MEASUREMENT_READ_PERMISSIONS,
  MEASUREMENT_RECORD_PERMISSIONS,
  VALUATION_LIMITS,
  type BqItemKind,
  type MeasurementBasis,
  type MeasurementState,
} from "@pm-buddy/types";
import {
  approvalQueueResponseSchema,
  measurementDetailResponseSchema,
  measurementItemsResponseSchema,
  measurementResponseSchema,
  measurementsResponseSchema,
  type MeasurementItem,
  type ParsedMeasurementRequest,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../../common/database-errors.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { Scope } from "../../identity/access-policy.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import {
  minorOf,
  projectRef,
  SpendingAccess,
  trimDecimal,
  type ProjectAccess,
} from "../../finance/spending-common.js";
import { requestDigest } from "../../procurement/p2p/p2p-common.js";
import { fromCalendarDate, toCalendarDate } from "../../projects/project-mappers.js";
import {
  approvedMeasurements,
  bqInForce,
  bqItemWire,
  decimalText,
  invalidTransition,
  itemWithBill,
  makerChecker,
  measurable,
  measurementInclude,
  measurementsWire,
  stateOf,
  valuationConflict,
  valuationDatabaseProblem,
  valuationProblem,
  type MeasurementAbilities,
  type MeasurementRow,
} from "../valuations/valuation-common.js";

/**
 * Progress measurement against BQ items (D5.3 minimal form, extended by D6.3; brief §5.2, §15 E
 * and G; ARCHITECTURE §4.10). A measurement is the quantity done to date of an item of the BQ in
 * force (or percent complete for a lump sum), on a business date not in the future, recorded by
 * someone with `site.diary` or `bq.edit` — recording IS the submission (rows are append-only
 * evidence, so there is no editable draft). Site photos of the project are its evidence (added
 * until it is reviewed). A `bq.edit` holder who did not measure it approves (with at least one
 * photo) or rejects it with a reason. A correction is a new row naming the measurement it
 * corrects (same item and date) with a reason; it needs its own review. Only approved
 * measurements count towards value of work done, earned value and valuations.
 */
@Injectable()
export class MeasurementsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: SpendingAccess,
  ) {}

  private abilities(scope: Scope, project: ProjectAccess): MeasurementAbilities {
    return {
      userId: scope.access.userId,
      canRecord: this.access.can(project, MEASUREMENT_RECORD_PERMISSIONS),
      canApprove: this.access.can(project, MEASUREMENT_APPROVE_PERMISSIONS),
    };
  }

  private async reader(scope: Scope, projectId: string) {
    const project = await this.access.on(scope, projectId);
    if (!this.access.holds(project, MEASUREMENT_READ_PERMISSIONS))
      throw new ForbiddenException("No permission to see measurements on this project");
    return project;
  }

  list(
    principal: Principal,
    projectId: string,
    query: { bqItemLineageId?: string; state?: MeasurementState },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const project = await this.reader(scope, projectId);
      const rows = await scope.tx.progressMeasurement.findMany({
        where: {
          tenantId: scope.access.tenantId,
          projectId,
          ...(query.bqItemLineageId ? { itemLineageId: query.bqItemLineageId } : {}),
          ...(query.state === "pending" ? { review: { is: null }, correctedBy: { is: null } } : {}),
        },
        include: measurementInclude,
        orderBy: [{ measuredOn: "desc" }, { recordedAt: "desc" }],
        take: VALUATION_LIMITS.listSize,
      });
      const abilities = this.abilities(scope, project);
      const wired = await measurementsWire(scope.tx, rows, () => abilities);
      return measurementsResponseSchema.parse({
        measurements: query.state
          ? wired.filter((measurement) => measurement.state === query.state)
          : wired,
        permissions: { canRecord: abilities.canRecord, canApprove: abilities.canApprove },
      });
    });
  }

  get(principal: Principal, projectId: string, id: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const project = await this.reader(scope, projectId);
      const row = await this.row(scope, projectId, id);
      const history = await scope.tx.progressMeasurement.findMany({
        where: { tenantId: scope.access.tenantId, projectId, itemLineageId: row.itemLineageId },
        include: measurementInclude,
        orderBy: [{ measuredOn: "desc" }, { recordedAt: "desc" }],
        take: VALUATION_LIMITS.listSize,
      });
      const abilities = this.abilities(scope, project);
      const [measurement] = await measurementsWire(scope.tx, [row], () => abilities);
      return measurementDetailResponseSchema.parse({
        measurement,
        project: projectRef(project.project),
        history: await measurementsWire(scope.tx, history, () => abilities),
      });
    });
  }

  /**
   * The measurement sheet: items of the BQ in force with the approved measurement in force today
   * (valued on the BQ in force), the newest measurement and how many wait for review.
   */
  items(
    principal: Principal,
    projectId: string,
    query: { search?: string; billLineageId?: string; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const project = await this.reader(scope, projectId);
      const abilities = this.abilities(scope, project);
      const version = await bqInForce(tx, access.tenantId, projectId);
      const empty = {
        project: projectRef(project.project),
        bqVersion: null,
        bills: [],
        items: [],
        page: { hasMore: false, nextCursor: null },
        totals: {
          measurableMinor: 0,
          approvedValueMinor: 0,
          percentComplete: null,
          pendingCount: 0,
        },
        permissions: { canRecord: abilities.canRecord, canApprove: abilities.canApprove },
      };
      if (!version) return measurementItemsResponseSchema.parse(empty);
      const [allItems, approved, recent, bills] = await Promise.all([
        tx.bqItem.findMany({
          where: { tenantId: access.tenantId, versionId: version.id },
          include: itemWithBill,
          orderBy: [{ bill: { sortOrder: "asc" } }, { sortOrder: "asc" }],
        }),
        approvedMeasurements(tx, access.tenantId, projectId),
        tx.progressMeasurement.findMany({
          where: { tenantId: access.tenantId, projectId },
          include: measurementInclude,
          orderBy: [{ measuredOn: "desc" }, { recordedAt: "desc" }],
        }),
        tx.bqBill.findMany({
          where: { tenantId: access.tenantId, versionId: version.id },
          orderBy: { sortOrder: "asc" },
          select: { lineageId: true, number: true, title: true },
        }),
      ]);
      const inForce = valuedInForce(allItems, approved, nairobiDate());
      const latest = new Map<string, MeasurementRow>();
      const pending = new Map<string, number>();
      for (const row of recent) {
        if (!latest.has(row.itemLineageId)) latest.set(row.itemLineageId, row);
        if (stateOf(row) === "pending")
          pending.set(row.itemLineageId, (pending.get(row.itemLineageId) ?? 0) + 1);
      }
      let measurableMinor = 0;
      let approvedValueMinor = 0;
      for (const item of allItems) {
        if (measurementBasis(measurable(item)) === null) continue;
        measurableMinor += minorOf(item.amountMinor);
        approvedValueMinor += inForce.get(item.lineageId)?.valueMinor ?? 0;
      }
      const needle = query.search?.trim().toLowerCase();
      const filtered = allItems.filter(
        (item) =>
          (!query.billLineageId || item.bill.lineageId === query.billLineageId) &&
          (!needle ||
            (item.ref ?? "").toLowerCase().includes(needle) ||
            item.description.toLowerCase().includes(needle)),
      );
      const offset = query.cursor ? Number(query.cursor) : 0;
      const page = filtered.slice(offset, offset + query.limit);
      const items: MeasurementItem[] = page.map((item) => {
        const valued = inForce.get(item.lineageId);
        const newest = latest.get(item.lineageId);
        return {
          item: bqItemWire(item),
          kind: item.kind as BqItemKind,
          basis: measurementBasis(measurable(item)),
          quantity: decimalText(item.quantity),
          rate: decimalText(item.rate),
          amountMinor: minorOf(item.amountMinor),
          approved: valued
            ? {
                measurementId: valued.id,
                measuredOn: toCalendarDate(valued.measuredOn),
                quantityToDate: trimDecimal(valued.quantityToDate),
                valueMinor: valued.valueMinor,
                percentComplete: valued.percentComplete,
              }
            : null,
          latest: newest
            ? {
                measurementId: newest.id,
                state: stateOf(newest),
                measuredOn: toCalendarDate(newest.measuredOn),
                quantityToDate: trimDecimal(newest.quantityToDate),
              }
            : null,
          pendingCount: pending.get(item.lineageId) ?? 0,
        };
      });
      const hasMore = offset + query.limit < filtered.length;
      return measurementItemsResponseSchema.parse({
        ...empty,
        bqVersion: { id: version.id, versionNo: version.versionNo },
        bills,
        items,
        page: { hasMore, nextCursor: hasMore ? String(offset + query.limit) : null },
        totals: {
          measurableMinor,
          approvedValueMinor,
          percentComplete: percentText(BigInt(approvedValueMinor), BigInt(measurableMinor)),
          pendingCount: [...pending.values()].reduce((sum, count) => sum + count, 0),
        },
      });
    });
  }

  /** Pending measurements on projects where the caller reviews measurements. */
  queue(principal: Principal, projectId: string | undefined, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const projectIds = await this.access.projectIds(
        scope,
        MEASUREMENT_APPROVE_PERMISSIONS,
        projectId,
      );
      const rows = await tx.progressMeasurement.findMany({
        where: {
          tenantId: access.tenantId,
          projectId: { in: projectIds },
          review: { is: null },
          correctedBy: { is: null },
        },
        include: measurementInclude,
        orderBy: [{ measuredOn: "asc" }, { recordedAt: "asc" }],
        take: VALUATION_LIMITS.queueSize + 1,
      });
      const page = rows.slice(0, VALUATION_LIMITS.queueSize);
      const projects = new Map<string, ProjectAccess>();
      for (const id of new Set(page.map((row) => row.projectId)))
        projects.set(id, await this.access.on(scope, id));
      const wired = await measurementsWire(tx, page, (id) =>
        this.abilities(scope, projects.get(id)!),
      );
      return approvalQueueResponseSchema.parse({
        entries: wired.map((measurement) => ({
          project: projectRef(projects.get(measurement.projectId)!.project),
          measurement,
        })),
        truncated: rows.length > VALUATION_LIMITS.queueSize,
      });
    });
  }

  record(
    principal: Principal,
    projectId: string,
    input: ParsedMeasurementRequest,
    req: Request,
    key?: string,
  ) {
    const digest = requestDigest("progress.measurement", { projectId, ...input });
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          if (key) {
            const replay = await tx.progressMeasurement.findUnique({
              where: {
                tenantId_idempotencyKey: { tenantId: access.tenantId, idempotencyKey: key },
              },
              include: measurementInclude,
            });
            if (replay) {
              if (replay.requestDigest !== digest || (input.id && replay.id !== input.id))
                throw valuationConflict(
                  "idempotency-key-reused",
                  "This idempotency key was used for a different measurement",
                );
              const project = await this.reader(scope, replay.projectId);
              return this.response(scope, project, replay, true);
            }
          }
          if (input.id) {
            const clash = await tx.progressMeasurement.findUnique({
              where: { tenantId_id: { tenantId: access.tenantId, id: input.id } },
              select: { id: true },
            });
            if (clash)
              throw valuationConflict(
                "measurement-id-conflict",
                "A measurement with this ID was sent with another key",
              );
          }
          const project = await this.access.require(
            scope,
            projectId,
            MEASUREMENT_RECORD_PERMISSIONS,
            { writable: true },
          );
          if (input.measuredOn > nairobiDate())
            throw new BadRequestException({
              code: "measurement-future",
              message: "Work cannot be measured in the future",
            });
          const version = await bqInForce(tx, access.tenantId, projectId);
          if (!version)
            throw valuationConflict(
              "bq-not-approved",
              "The project has no approved BQ version yet",
            );
          const item = await tx.bqItem.findUnique({
            where: {
              tenantId_versionId_lineageId: {
                tenantId: access.tenantId,
                versionId: version.id,
                lineageId: input.bqItemLineageId,
              },
            },
          });
          if (!item)
            throw valuationProblem(
              422,
              "bq-item-not-found",
              "The BQ item is not in the BQ in force",
            );
          const basis = measurementBasis(measurable(item));
          const check = checkMeasuredQuantity(
            basis,
            decimalText(item.quantity),
            input.quantityToDate,
            input.overMeasureReason,
          );
          if (!check.ok)
            throw check.problem === "not-measured"
              ? valuationProblem(
                  422,
                  "item-not-measurable",
                  "Provisional sums, PC sums and contingencies are expended through variations, not measured",
                )
              : check.problem === "percent-over-100"
                ? valuationProblem(422, "percent-over-100", "A lump sum is at most 100 % complete")
                : valuationProblem(
                    422,
                    "over-measure-reason-required",
                    "Give a reason for measuring more than the BQ quantity",
                  );
          if (input.correctsMeasurementId) {
            const corrected = await tx.progressMeasurement.findUnique({
              where: {
                tenantId_id: { tenantId: access.tenantId, id: input.correctsMeasurementId },
              },
              include: { correctedBy: { select: { id: true } } },
            });
            if (
              !corrected ||
              corrected.projectId !== projectId ||
              corrected.itemLineageId !== item.lineageId
            )
              throw valuationProblem(
                404,
                "measurement-not-found",
                "The measurement to correct was not found",
              );
            if (corrected.correctedBy) throw invalidTransition("corrected");
            if (toCalendarDate(corrected.measuredOn) !== input.measuredOn)
              throw valuationProblem(
                422,
                "correction-date-mismatch",
                "A correction keeps the date of the measurement it corrects",
              );
          }
          await this.checkPhotos(scope, projectId, input.photoIds);
          const row = await tx.progressMeasurement.create({
            data: {
              ...(input.id ? { id: input.id } : {}),
              tenantId: access.tenantId,
              projectId,
              bqId: version.bqId,
              versionId: version.id,
              itemLineageId: item.lineageId,
              measuredOn: fromCalendarDate(input.measuredOn),
              quantityToDate: input.quantityToDate,
              basis,
              overMeasureReason: check.overMeasured ? input.overMeasureReason!.trim() : null,
              note: input.note ?? null,
              correctsId: input.correctsMeasurementId,
              correctionReason: input.correctsMeasurementId
                ? (input.correctionReason ?? null)
                : null,
              measuredBy: access.userId,
              idempotencyKey: key ?? null,
              requestDigest: key ? digest : null,
            },
          });
          if (input.photoIds.length)
            await tx.progressMeasurementPhoto.createMany({
              data: input.photoIds.map((photoId) => ({
                tenantId: access.tenantId,
                projectId,
                measurementId: row.id,
                photoId,
                addedBy: access.userId,
              })),
            });
          await this.scope.audit(tx, "progress.measured", row.id, {
            projectId,
            itemLineageId: item.lineageId,
            basis,
            correction: Boolean(input.correctsMeasurementId),
            overMeasured: check.overMeasured,
            photos: input.photoIds.length,
          });
          return this.response(scope, project, await this.row(scope, projectId, row.id), false);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw valuationConflict(
            "invalid-transition",
            "This measurement was already corrected or recorded",
          );
        throw valuationDatabaseProblem(error) ?? error;
      });
  }

  /** Adds evidence while the measurement waits for review (the measurer or a reviewer). */
  addPhotos(
    principal: Principal,
    projectId: string,
    id: string,
    photoIds: readonly string[],
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const project = await this.access.require(
            scope,
            projectId,
            [...MEASUREMENT_RECORD_PERMISSIONS, ...MEASUREMENT_APPROVE_PERMISSIONS],
            { writable: true },
          );
          const row = await this.row(scope, projectId, id);
          if (stateOf(row) !== "pending")
            throw valuationConflict(
              "measurement-not-pending",
              "Photos are added only while the measurement waits for review",
            );
          const fresh = photoIds.filter(
            (photoId) => !row.photos.some((link) => link.photoId === photoId),
          );
          if (row.photos.length + fresh.length > VALUATION_LIMITS.photosPerMeasurement)
            throw valuationConflict("too-many-photos", "A measurement has at most six photos");
          await this.checkPhotos(scope, projectId, fresh);
          if (fresh.length)
            await tx.progressMeasurementPhoto.createMany({
              data: fresh.map((photoId) => ({
                tenantId: access.tenantId,
                projectId,
                measurementId: id,
                photoId,
                addedBy: access.userId,
              })),
            });
          await this.scope.audit(tx, "progress.measurement_photos_added", id, {
            projectId,
            photos: fresh.length,
          });
          return this.response(scope, project, await this.row(scope, projectId, id), false);
        },
        true,
      )
      .catch((error: unknown) => {
        throw valuationDatabaseProblem(error) ?? error;
      });
  }

  /** Approval (with a photo) or rejection (reason) by a bq.edit holder who did not measure it. */
  decide(
    principal: Principal,
    projectId: string,
    id: string,
    decision: "approved" | "rejected",
    reason: string | null,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const project = await this.access.require(
            scope,
            projectId,
            MEASUREMENT_APPROVE_PERMISSIONS,
            { writable: true },
          );
          const row = await this.row(scope, projectId, id);
          if (stateOf(row) !== "pending")
            throw valuationConflict(
              "measurement-not-pending",
              "Only a measurement waiting for review is approved or rejected",
            );
          if (row.measuredBy === access.userId)
            throw makerChecker("Someone other than the measurer reviews a measurement");
          if (decision === "approved" && row.photos.length === 0)
            throw valuationConflict(
              "measurement-evidence-required",
              "Add at least one site photo before approving",
            );
          await tx.progressMeasurementReview.create({
            data: {
              tenantId: access.tenantId,
              projectId,
              measurementId: id,
              decision,
              reason,
              decidedBy: access.userId,
            },
          });
          await this.scope.audit(
            tx,
            decision === "approved"
              ? "progress.measurement_approved"
              : "progress.measurement_rejected",
            id,
            { projectId, itemLineageId: row.itemLineageId, reasonGiven: reason !== null },
          );
          return this.response(scope, project, await this.row(scope, projectId, id), false);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw valuationConflict(
            "measurement-not-pending",
            "This measurement was already reviewed",
          );
        throw valuationDatabaseProblem(error) ?? error;
      });
  }

  private async checkPhotos(scope: Scope, projectId: string, photoIds: readonly string[]) {
    if (!photoIds.length) return;
    const found = await scope.tx.sitePhoto.count({
      where: {
        tenantId: scope.access.tenantId,
        projectId,
        purpose: "general",
        id: { in: [...photoIds] },
      },
    });
    if (found !== new Set(photoIds).size)
      throw valuationProblem(
        422,
        "photo-not-in-project",
        "Every photo must be a site photo of this project",
      );
  }

  private async row(scope: Scope, projectId: string, id: string): Promise<MeasurementRow> {
    const row = await scope.tx.progressMeasurement.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
      include: measurementInclude,
    });
    if (!row || row.projectId !== projectId) throw new NotFoundException("Measurement not found");
    return row;
  }

  private async response(
    scope: Scope,
    project: ProjectAccess,
    row: MeasurementRow,
    replayed: boolean,
  ) {
    const abilities = this.abilities(scope, project);
    const [measurement] = await measurementsWire(scope.tx, [row], () => abilities);
    return measurementResponseSchema.parse({ measurement, replayed });
  }
}

export type ValuedMeasurement = {
  id: string;
  measuredOn: Date;
  quantityToDate: Prisma.Decimal;
  valueMinor: number;
  percentComplete: string | null;
  basis: MeasurementBasis;
};

type ItemFacts = Parameters<typeof measurable>[0] & { lineageId: string };

/**
 * The approved measurement in force per item on `asOf`, valued on the given items (the BQ in
 * force): only measurements in the item's current basis count (a D5.3 measurement is by
 * quantity); items that are not measured are left out.
 */
export function valuedInForce(
  items: readonly ItemFacts[],
  approved: readonly {
    id: string;
    itemLineageId: string;
    measuredOn: Date;
    recordedAt: Date;
    quantityToDate: Prisma.Decimal;
    basis: string | null;
  }[],
  asOf: string,
): Map<string, ValuedMeasurement> {
  const byLineage = new Map(items.map((item) => [item.lineageId, measurable(item)]));
  const eligible = approved
    .filter((row) => {
      const item = byLineage.get(row.itemLineageId);
      const basis = item ? measurementBasis(item) : null;
      return basis !== null && (row.basis ?? "quantity") === basis;
    })
    .map((row) => ({
      row,
      id: row.id,
      lineageId: row.itemLineageId,
      measuredOn: toCalendarDate(row.measuredOn),
      recordedAt: row.recordedAt.toISOString(),
      state: "approved" as const,
    }));
  const result = new Map<string, ValuedMeasurement>();
  for (const [lineage, { row }] of measurementsInForce(eligible, asOf)) {
    const item = byLineage.get(lineage)!;
    const quantity = row.quantityToDate.toFixed();
    result.set(lineage, {
      id: row.id,
      measuredOn: row.measuredOn,
      quantityToDate: row.quantityToDate,
      valueMinor: measuredValueMinor(item, quantity),
      percentComplete: measuredPercent(item, quantity),
      basis: measurementBasis(item)!,
    });
  }
  return result;
}
