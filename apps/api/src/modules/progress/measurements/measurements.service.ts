import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Request } from "express";
import { isProjectReadOnly, nairobiDate } from "@pm-buddy/domain";
import type { MeasurementStatus, ProjectStatus } from "@pm-buddy/types";
import {
  measurementResponseSchema,
  measurementsResponseSchema,
  type ParsedMeasurementRequest,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../../common/database-errors.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../../identity/access-policy.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";

type MeasurementRow = Prisma.ProgressMeasurementGetPayload<{ include: { item: true } }>;

/** Who may read measurements: the BQ readers and the stores readers (consumption variance). */
const MEASUREMENT_READERS = [
  "bq.view",
  "bq.edit",
  "stores.manage",
  "procurement.requisition",
  "procurement.approve",
  "finance.view",
] as const;

const problem = (status: number, code: string, message: string) =>
  new HttpException({ code, message }, status);

/**
 * Minimal progress measurement (D5.3 for consumption variance; ERD §4 ProgressMeasurement; D6.3
 * adds submission and approval, photo evidence, percent complete, earned value and valuations).
 * A measurement is the quantity completed to date of a BQ item (by lineage, against the BQ in
 * force), on a business date that is not in the future, by someone with bq.edit on the project.
 * Rows are never changed: a correction is a new row naming the one it corrects, with a reason.
 * The variance report uses the latest uncorrected measurement of each item.
 */
@Injectable()
export class MeasurementsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
  ) {}

  list(principal: Principal, projectId: string, lineageId: string | undefined, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const effective = await this.policy.requireAny(scope, MEASUREMENT_READERS, { projectId });
      const project = await this.project(scope, projectId);
      const rows = await scope.tx.progressMeasurement.findMany({
        where: {
          tenantId: scope.access.tenantId,
          projectId,
          ...(lineageId ? { itemLineageId: lineageId } : {}),
        },
        include: { item: true },
        orderBy: [{ measuredOn: "desc" }, { recordedAt: "desc" }],
        take: 500,
      });
      return measurementsResponseSchema.parse({
        measurements: await this.wire(scope, rows),
        permissions: {
          canRecord:
            effective.has("bq.edit") && !isProjectReadOnly(project.status as ProjectStatus),
        },
      });
    });
  }

  record(principal: Principal, projectId: string, input: ParsedMeasurementRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          await this.policy.require(scope, "bq.edit", { projectId });
          const project = await this.project(scope, projectId);
          if (isProjectReadOnly(project.status as ProjectStatus))
            throw problem(409, "project-read-only", "Closed and cancelled projects are read-only");
          if (input.measuredOn > nairobiDate())
            throw new BadRequestException({
              code: "measurement-future",
              message: "Work cannot be measured in the future",
            });
          const version = await tx.bqVersion.findFirst({
            where: { tenantId: access.tenantId, projectId, status: "approved" },
            orderBy: { versionNo: "desc" },
          });
          if (!version)
            throw problem(409, "bq-not-approved", "The project has no approved BQ version yet");
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
            throw problem(422, "bq-item-not-found", "The BQ item is not in the BQ in force");
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
              throw problem(
                404,
                "measurement-not-found",
                "The measurement to correct was not found",
              );
            if (corrected.correctedBy)
              throw new ConflictException({
                code: "invalid-transition",
                message: "This measurement was already corrected",
              });
          }
          const row = await tx.progressMeasurement.create({
            data: {
              tenantId: access.tenantId,
              projectId,
              bqId: version.bqId,
              versionId: version.id,
              itemLineageId: item.lineageId,
              measuredOn: new Date(`${input.measuredOn}T00:00:00.000Z`),
              quantityToDate: input.quantityToDate,
              note: input.note ?? null,
              correctsId: input.correctsMeasurementId,
              correctionReason: input.correctsMeasurementId
                ? (input.correctionReason ?? null)
                : null,
              measuredBy: access.userId,
            },
            include: { item: true },
          });
          await this.scope.audit(tx, "progress.measured", row.id, {
            projectId,
            itemLineageId: item.lineageId,
            correction: Boolean(input.correctsMeasurementId),
          });
          const [measurement] = await this.wire(scope, [row]);
          return measurementResponseSchema.parse({ measurement });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw new ConflictException({
            code: "invalid-transition",
            message: "This measurement was already corrected",
          });
        throw error;
      });
  }

  private async project(scope: Scope, projectId: string) {
    const project = await scope.tx.project.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: projectId } },
    });
    if (!project) throw new NotFoundException("Project not found");
    return project;
  }

  private async wire(scope: Scope, rows: MeasurementRow[]) {
    const ids = rows.map((row) => row.id);
    const corrections = await scope.tx.progressMeasurement.findMany({
      where: { tenantId: scope.access.tenantId, correctsId: { in: ids } },
      select: { correctsId: true },
    });
    const corrected = new Set(corrections.map((entry) => entry.correctsId));
    const users = await scope.tx.user.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.measuredBy))] } },
      select: { id: true, displayName: true },
    });
    const names = new Map(users.map((user) => [user.id, user.displayName]));
    return rows.map((row) => ({
      id: row.id,
      bqItem: {
        versionId: row.item.versionId,
        lineageId: row.item.lineageId,
        ref: row.item.ref,
        description: row.item.description,
        unit: row.item.unit,
      },
      measuredOn: row.measuredOn.toISOString().slice(0, 10),
      quantityToDate: row.quantityToDate.toFixed(),
      status: row.status as MeasurementStatus,
      note: row.note,
      measuredBy: { id: row.measuredBy, displayName: names.get(row.measuredBy) ?? "—" },
      recordedAt: row.recordedAt.toISOString(),
      correctsMeasurementId: row.correctsId,
      correctionReason: row.correctionReason,
      corrected: corrected.has(row.id),
    }));
  }
}
