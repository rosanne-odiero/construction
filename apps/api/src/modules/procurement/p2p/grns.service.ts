import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { assessDeliveryLocation, nairobiDate, Ratio, type Geofence } from "@pm-buddy/domain";
import type { GrnLocationState, GrnSource, LocationError, VehicleRegFormat } from "@pm-buddy/types";
import {
  grnResponseSchema,
  grnsResponseSchema,
  receivableLposResponseSchema,
  type ParsedGrnRequest,
} from "@pm-buddy/validation";
import { isCheckViolation, isUniqueViolation } from "../../../common/database-errors.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { Scope } from "../../identity/access-policy.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { toGeofenceVersion } from "../../projects/project-mappers.js";
import { assertUsableUnit } from "../catalogue.service.js";
import { CatalogueStore, nextId } from "../catalogue-store.js";
import { peopleOf, personOf, supplierRef } from "../procurement-mappers.js";
import { LposService } from "./lpos.service.js";
import { toDocument } from "./p2p-documents.service.js";
import {
  invalidTransition,
  iso,
  isoOrNull,
  materialWire,
  nextNumber,
  p2pBadRequest,
  p2pConflict,
  P2pAccess,
  personOrNull,
  projectRef,
  qtyText,
  requestDigest,
  toBaseQuantity,
} from "./p2p-common.js";

type GrnRow = Prisma.GrnGetPayload<object>;
const RECEIVERS = ["stores.manage", "procurement.requisition"] as const;

/**
 * Goods Received Notes (D5.2, brief §5.3 and §15 E). Built for offline sync: the client chooses
 * the GRN's ID and sends an `Idempotency-Key`; a replay with the same key and payload returns the
 * original GRN (`replayed: true`), a changed payload under the key is 409 idempotency-key-reused,
 * and the same ID under another key is 409 grn-id-conflict. The device's capture time is a claim;
 * the server's receipt time is authoritative. The position is compared with the site geofence in
 * force (outside → flagged, never refused); photos are uploaded separately (resumable on a
 * device) and `evidenceComplete` shows whether both kinds arrived. GRNs never change; a mistaken
 * one is voided with a reason, unless an approved invoice relies on it.
 */
@Injectable()
export class GrnsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: P2pAccess,
    private readonly store: CatalogueStore,
    private readonly lpos: LposService,
  ) {}

  list(
    principal: Principal,
    query: { projectId?: string; lpoId?: string; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const projectIds = await this.access.visibleProjectIds(scope, query.projectId);
      const rows = await scope.tx.grn.findMany({
        where: {
          tenantId: scope.access.tenantId,
          projectId: { in: projectIds },
          ...(query.lpoId ? { lpoId: query.lpoId } : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        orderBy: { id: "desc" },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const wired = await Promise.all(page.map((row) => this.wire(scope, row)));
      return grnsResponseSchema.parse({
        grns: wired.map(({ lines: _lines, photos: _photos, ...grn }) => grn),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
        },
      });
    });
  }

  /** Approved LPOs the caller may receive against, with what each line has accepted so far. */
  receivable(principal: Principal, projectId: string | undefined, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const candidates = await tx.lpo.findMany({
        where: {
          tenantId: access.tenantId,
          status: "approved",
          ...(projectId ? { projectId } : {}),
        },
        orderBy: { number: "asc" },
        take: 200,
      });
      const lpos = [];
      for (const lpo of candidates) {
        const project = await this.access.on(scope, lpo.projectId);
        if (!RECEIVERS.some((permission) => project.permissions.has(permission))) continue;
        const [lines, sites, supplier, progress] = await Promise.all([
          tx.lpoLine.findMany({
            where: { tenantId: access.tenantId, lpoId: lpo.id },
            include: { material: true },
            orderBy: { lineNo: "asc" },
          }),
          tx.site.findMany({
            where: { tenantId: access.tenantId, projectId: lpo.projectId },
            select: { id: true, name: true },
            orderBy: { name: "asc" },
          }),
          this.store.supplier(scope, lpo.supplierId),
          this.lpos.progress(scope, lpo.id),
        ]);
        lpos.push({
          id: lpo.id,
          number: lpo.number,
          project: projectRef(project.project),
          deliverySite: sites.find((site) => site.id === lpo.deliverySiteId) ?? null,
          supplier: supplierRef(supplier),
          deliveryDate: lpo.deliveryDate ? lpo.deliveryDate.toISOString().slice(0, 10) : null,
          sites,
          lines: lines.map((line) => ({
            id: line.id,
            lineNo: line.lineNo,
            material: materialWire(line.material),
            quantity: line.quantity.toFixed(),
            unit: line.unit,
            baseQuantity: line.baseQuantity.toFixed(),
            receivedBaseQuantity: qtyText(progress.received.get(line.id) ?? Ratio.of(0)),
          })),
        });
      }
      return receivableLposResponseSchema.parse({ lpos });
    });
  }

  get(principal: Principal, id: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const row = await this.row(scope, id);
      await this.access.viewer(scope, row.projectId);
      return this.response(scope, row, false);
    });
  }

  create(principal: Principal, input: ParsedGrnRequest, key: string, req: Request) {
    const digest = requestDigest("grn.create", input);
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const lpo = await this.lpos.row(scope, input.lpoId);
          const project = await this.access.require(scope, lpo.projectId, RECEIVERS, {
            writable: true,
          });
          const replay = await tx.grn.findUnique({
            where: { tenantId_idempotencyKey: { tenantId: access.tenantId, idempotencyKey: key } },
          });
          if (replay) {
            if (replay.requestDigest !== digest || replay.id !== input.id)
              throw p2pConflict(
                "idempotency-key-reused",
                "This idempotency key was used for a different delivery",
              );
            return this.response(scope, replay, true);
          }
          const clash = await tx.grn.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: input.id } },
          });
          if (clash)
            throw p2pConflict("grn-id-conflict", "A GRN with this ID was sent with another key");
          if (lpo.status !== "approved")
            throw p2pConflict(
              "lpo-not-approved",
              "Goods are received only against an approved LPO",
            );
          const siteId = input.siteId ?? lpo.deliverySiteId;
          if (siteId) {
            const site = await tx.site.findUnique({
              where: { tenantId_id: { tenantId: access.tenantId, id: siteId } },
            });
            if (!site || site.projectId !== project.project.id)
              throw p2pBadRequest("site-not-in-project", "The site is not part of this project");
          }
          const lpoLines = await tx.lpoLine.findMany({
            where: { tenantId: access.tenantId, lpoId: lpo.id },
            include: { material: true },
          });
          const byId = new Map(lpoLines.map((line) => [line.id, line]));
          if (input.lines.some((line) => !byId.has(line.lpoLineId)))
            throw p2pBadRequest("line-not-on-order", "A line is not on this LPO");
          const units = await this.store.customUnits(scope);
          const capturedOn = nairobiDate(new Date(input.capturedAt));
          const { received: before } = await this.lpos.progress(scope, lpo.id);
          const lines = [];
          for (const [index, line] of input.lines.entries()) {
            const ordered = byId.get(line.lpoLineId)!;
            const unit = line.unit ?? ordered.unit;
            assertUsableUnit(unit, units);
            const received = Ratio.fromDecimal(line.receivedQuantity);
            const rejected = Ratio.fromDecimal(line.rejectedQuantity);
            if (rejected.compare(received) > 0)
              throw p2pBadRequest("invalid-quantity", "Rejected quantities cannot exceed received");
            const accepted = received.distance(rejected).value;
            const converted = accepted.isZero()
              ? { baseQuantity: "0", ratio: "0/1", steps: [] }
              : await toBaseQuantity(
                  this.store,
                  scope,
                  ordered.material,
                  lpo.supplierId,
                  capturedOn,
                  qtyText(accepted),
                  unit,
                  units,
                );
            const total = (before.get(ordered.id) ?? Ratio.of(0)).plus(
              Ratio.fromDecimal(converted.baseQuantity),
            );
            lines.push({
              id: nextId(),
              tenantId: access.tenantId,
              grnId: input.id,
              lpoId: lpo.id,
              lpoLineId: ordered.id,
              lineNo: index + 1,
              unit,
              receivedQuantity: line.receivedQuantity,
              rejectedQuantity: line.rejectedQuantity,
              rejectionReason: line.rejectionReason ?? null,
              acceptedBaseQuantity: converted.baseQuantity,
              overDelivery: total.compare(Ratio.fromDecimal(ordered.baseQuantity.toFixed())) > 0,
              conversion: JSON.parse(
                JSON.stringify({ ratio: converted.ratio, steps: converted.steps }),
              ) as Prisma.InputJsonValue,
            });
          }
          const fix = input.location
            ? {
                lat: input.location.latitude,
                lng: input.location.longitude,
                accuracyM: input.location.accuracyM,
              }
            : null;
          const geofenceRow = siteId
            ? await tx.siteGeofence.findFirst({
                where: { tenantId: access.tenantId, siteId, effectiveFrom: { lte: new Date() } },
                orderBy: { version: "desc" },
              })
            : null;
          const geofence: Geofence | null = geofenceRow
            ? (toGeofenceVersion(geofenceRow).geofence as Geofence)
            : null;
          const location = assessDeliveryLocation(fix, geofence);
          const overDelivery = lines.some((line) => line.overDelivery);
          const row = await tx.grn.create({
            data: {
              id: input.id,
              tenantId: access.tenantId,
              projectId: lpo.projectId,
              lpoId: lpo.id,
              siteId,
              number: await nextNumber(tx, access.tenantId, "grn"),
              idempotencyKey: key,
              requestDigest: digest,
              capturedAt: new Date(input.capturedAt),
              receivedByName: input.receivedByName,
              recordedBy: access.userId,
              vehicleRegistration: input.vehicleRegistration.value,
              vehicleRegistrationFormat: input.vehicleRegistration.format,
              deliveryNoteNumber: input.deliveryNoteNumber ?? null,
              latitude: fix ? fix.lat.toFixed(6) : null,
              longitude: fix ? fix.lng.toFixed(6) : null,
              accuracyM: fix ? fix.accuracyM.toFixed(1) : null,
              locationState: location.state,
              lowAccuracy: location.lowAccuracy,
              locationError: fix ? null : input.locationError,
              geofenceVersion:
                location.state === "inside" || location.state === "outside"
                  ? geofenceRow!.version
                  : null,
              overDelivery,
              lineCount: lines.length,
              source: input.source,
              notes: input.notes ?? null,
            },
          });
          await tx.grnLine.createMany({ data: lines });
          // Coordinates, the vehicle and the receiver's name stay out of the audit log.
          await this.scope.audit(tx, "grn.recorded", row.id, {
            projectId: lpo.projectId,
            lpoId: lpo.id,
            lines: lines.length,
            locationState: location.state,
            overDelivery,
            source: input.source,
          });
          return this.response(scope, row, false);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw p2pConflict("grn-id-conflict", "This GRN was recorded by another request");
        throw error;
      });
  }

  void(principal: Principal, id: string, input: { reason: string }, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.row(scope, id);
          await this.access.require(scope, row.projectId, ["stores.manage"]);
          if (row.status !== "recorded") throw invalidTransition(row.status);
          const relied = await tx.invoicePayable.count({
            where: { tenantId: access.tenantId, match: { grnIds: { has: id } } },
          });
          if (relied)
            throw p2pConflict(
              "grn-supports-approved-invoice",
              "An approved invoice relies on this GRN; record a return or credit instead",
            );
          await tx.grn.update({
            where: { tenantId_id: { tenantId: access.tenantId, id } },
            data: {
              status: "voided",
              voidedBy: access.userId,
              voidedAt: new Date(),
              voidReason: input.reason,
            },
          });
          await this.scope.audit(tx, "grn.voided", id, { lpoId: row.lpoId, reasonGiven: true });
          return this.response(scope, await this.row(scope, id), false);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isCheckViolation(error))
          throw p2pConflict(
            "grn-supports-approved-invoice",
            "An approved invoice relies on this GRN; record a return or credit instead",
          );
        throw error;
      });
  }

  // Helpers ---------------------------------------------------------------------------------

  async row(scope: Scope, id: string): Promise<GrnRow> {
    const row = await scope.tx.grn.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("GRN not found");
    return row;
  }

  private async response(scope: Scope, row: GrnRow, replayed: boolean) {
    const project = await this.access.on(scope, row.projectId);
    const grn = await this.wire(scope, row);
    const receiver = RECEIVERS.some((permission) => project.permissions.has(permission));
    return grnResponseSchema.parse({
      grn,
      replayed,
      permissions: {
        canVoid: project.permissions.has("stores.manage") && row.status === "recorded",
        canAddPhotos: receiver && row.status === "recorded" && grn.photos.length < 10,
      },
    });
  }

  private async wire(scope: Scope, row: GrnRow) {
    const { tx, access } = scope;
    const [project, site, lpo, lines, photos] = await Promise.all([
      tx.project.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: access.tenantId, id: row.projectId } },
        select: { id: true, code: true, name: true },
      }),
      row.siteId
        ? tx.site.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: row.siteId } },
            select: { id: true, name: true },
          })
        : null,
      tx.lpo.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: access.tenantId, id: row.lpoId } },
        include: { supplier: true },
      }),
      tx.grnLine.findMany({
        where: { tenantId: access.tenantId, grnId: row.id },
        include: { lpoLine: { include: { material: true } } },
        orderBy: { lineNo: "asc" },
      }),
      tx.procurementDocument.findMany({
        where: { tenantId: access.tenantId, grnId: row.id },
        orderBy: { uploadedAt: "asc" },
      }),
    ]);
    const people = await peopleOf(tx, [
      row.recordedBy,
      row.voidedBy,
      ...photos.map((photo) => photo.uploadedBy),
    ]);
    return {
      id: row.id,
      number: row.number,
      project: projectRef(project),
      site,
      lpo: { id: lpo.id, number: lpo.number },
      supplier: supplierRef(lpo.supplier),
      status: row.status as "recorded" | "voided",
      capturedAt: iso(row.capturedAt),
      receivedAt: iso(row.receivedAt),
      receivedByName: row.receivedByName,
      recordedBy: personOf(people, row.recordedBy),
      vehicleRegistration: row.vehicleRegistration,
      vehicleRegistrationFormat: row.vehicleRegistrationFormat as VehicleRegFormat,
      deliveryNoteNumber: row.deliveryNoteNumber,
      location: {
        state: row.locationState as GrnLocationState,
        latitude: row.latitude === null ? null : row.latitude.toNumber(),
        longitude: row.longitude === null ? null : row.longitude.toNumber(),
        accuracyM: row.accuracyM === null ? null : row.accuracyM.toNumber(),
        lowAccuracy: row.lowAccuracy,
        error: row.locationError as LocationError | null,
        geofenceVersion: row.geofenceVersion,
      },
      overDelivery: row.overDelivery,
      source: row.source as GrnSource,
      notes: row.notes,
      photos: photos.map((photo) => toDocument(photo, people)),
      evidenceComplete:
        photos.some((photo) => photo.kind === "delivery_note") &&
        photos.some((photo) => photo.kind === "goods"),
      voidedAt: isoOrNull(row.voidedAt),
      voidedBy: personOrNull(people, row.voidedBy),
      voidReason: row.voidReason,
      lines: lines.map((line) => ({
        id: line.id,
        lineNo: line.lineNo,
        lpoLineId: line.lpoLineId,
        material: materialWire(line.lpoLine.material),
        unit: line.unit,
        receivedQuantity: line.receivedQuantity.toFixed(),
        rejectedQuantity: line.rejectedQuantity.toFixed(),
        rejectionReason: line.rejectionReason,
        acceptedBaseQuantity: line.acceptedBaseQuantity.toFixed(),
        overDelivery: line.overDelivery,
      })),
    };
  }
}
