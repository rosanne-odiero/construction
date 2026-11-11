import { Injectable, NotFoundException } from "@nestjs/common";
import type { AnomalyKind, AnomalySeverity, AnomalyStatus } from "@pm-buddy/types";
import { anomaliesResponseSchema, anomalyResponseSchema, type Anomaly } from "@pm-buddy/validation";
import type { Request } from "express";
import type { z } from "zod";
import type { anomalyListQuerySchema, reviewAnomalyRequestSchema } from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  attendanceConflict,
  AttendanceAccess,
  AttendanceCommands,
  samePerson,
  versionConflict,
} from "./attendance-support.js";
import { actor, iso, optionalActor, type AnomalyRow } from "./attendance-mappers.js";

type Tx = Prisma.TransactionClient;

/**
 * The anomaly review queue (brief §5.5 anti-fraud): open findings per project with resolve/dismiss
 * and a reason, by someone holding attendance.review_anomalies who neither recorded nor last
 * changed the record. Corrections' manual overrides are decided through the correction instead.
 */
@Injectable()
export class AnomaliesService {
  constructor(
    private readonly commands: AttendanceCommands,
    private readonly access: AttendanceAccess,
  ) {}

  list(principal: Principal, query: z.output<typeof anomalyListQuerySchema>, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      const { tx, access } = scope;
      const visible = await this.access.projectIds(scope, "attendance.view");
      const reviewable = await this.access.projectIds(scope, "attendance.review_anomalies");
      const projectIds = query.projectId ? visible.filter((id) => id === query.projectId) : visible;
      const where: Prisma.AttendanceAnomalyWhereInput = {
        tenantId: access.tenantId,
        projectId: { in: projectIds },
        ...(query.status ? { status: query.status } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.from || query.to
          ? {
              workDate: {
                ...(query.from ? { gte: fromCalendarDate(query.from) } : {}),
                ...(query.to ? { lte: fromCalendarDate(query.to) } : {}),
              },
            }
          : {}),
      };
      const rows = await tx.attendanceAnomaly.findMany({
        where,
        orderBy: [{ workDate: "desc" }, { detectedAt: "desc" }],
        take: 500,
      });
      const open = await tx.attendanceAnomaly.count({
        where: { tenantId: access.tenantId, projectId: { in: projectIds }, status: "open" },
      });
      const critical = await tx.attendanceAnomaly.count({
        where: {
          tenantId: access.tenantId,
          projectId: { in: projectIds },
          status: "open",
          severity: "critical",
        },
      });
      const projects = await tx.project.findMany({
        where: { tenantId: access.tenantId, id: { in: visible } },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      });
      return anomaliesResponseSchema.parse({
        anomalies: await this.map(tx, access.tenantId, rows),
        counts: { open, critical },
        reviewableProjectIds: reviewable,
        projects,
      });
    });
  }

  review(
    principal: Principal,
    anomalyId: string,
    input: z.output<typeof reviewAnomalyRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "attendance.anomaly.review",
      { anomalyId, input },
      async (scope) => {
        const { tx, access } = scope;
        const row = await tx.attendanceAnomaly.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: anomalyId } },
        });
        if (!row) throw new NotFoundException("Anomaly not found");
        await this.access.project(scope, row.projectId, "attendance.review_anomalies");
        if (row.kind === "manual_override")
          throw attendanceConflict(
            "use-correction",
            "Approve or reject the correction instead; it decides this flag.",
          );
        if (row.version !== input.version) throw versionConflict();
        if (row.status !== "open")
          throw attendanceConflict("invalid-transition", "This anomaly was already closed.");
        const record = await tx.attendanceRecord.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: access.tenantId, id: row.recordId } },
          select: { createdBy: true, updatedBy: true },
        });
        if (record.createdBy === access.userId || record.updatedBy === access.userId)
          throw samePerson("Someone who recorded this attendance cannot review its anomaly.");
        const status: AnomalyStatus = input.decision === "resolve" ? "resolved" : "dismissed";
        const updated = await tx.attendanceAnomaly.updateMany({
          where: { tenantId: access.tenantId, id: row.id, version: input.version, status: "open" },
          data: {
            status,
            openMarker: null,
            reviewedBy: access.userId,
            reviewNote: input.note,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw versionConflict();
        await this.commands.audit(scope, `attendance.anomaly_${status}`, row.id, {
          kind: row.kind,
          recordId: row.recordId,
          reasonGiven: true,
        });
        const fresh = await tx.attendanceAnomaly.findUniqueOrThrow({ where: { id: row.id } });
        return anomalyResponseSchema.parse({
          anomaly: (await this.map(tx, access.tenantId, [fresh]))[0],
        });
      },
    );
  }

  private async map(tx: Tx, tenantId: string, rows: AnomalyRow[]): Promise<Anomaly[]> {
    if (!rows.length) return [];
    const records = await tx.attendanceRecord.findMany({
      where: { tenantId, id: { in: rows.map((row) => row.recordId) } },
      select: { id: true, updatedBy: true },
    });
    const labourers = await tx.labourer.findMany({
      where: { tenantId, id: { in: [...new Set(rows.map((row) => row.labourerId))] } },
      select: { id: true, workerNo: true, fullName: true },
    });
    const sites = await tx.site.findMany({
      where: { tenantId, id: { in: [...new Set(rows.map((row) => row.siteId))] } },
      select: { id: true, name: true },
    });
    const projects = await tx.project.findMany({
      where: { tenantId, id: { in: [...new Set(rows.map((row) => row.projectId))] } },
      select: { id: true, code: true },
    });
    const recordedBy = new Map(records.map((record) => [record.id, record.updatedBy]));
    const names = await displayNames(tx, [
      ...records.map((record) => record.updatedBy),
      ...rows.map((row) => row.reviewedBy),
    ]);
    return rows.map((row) => {
      const labourer = labourers.find((entry) => entry.id === row.labourerId);
      return {
        id: row.id,
        projectId: row.projectId,
        projectCode: projects.find((entry) => entry.id === row.projectId)?.code ?? "—",
        siteId: row.siteId,
        siteName: sites.find((entry) => entry.id === row.siteId)?.name ?? "—",
        recordId: row.recordId,
        labourerId: row.labourerId,
        workerNo: labourer?.workerNo ?? "—",
        fullName: labourer?.fullName ?? "—",
        date: toCalendarDate(row.workDate),
        kind: row.kind as AnomalyKind,
        severity: row.severity as AnomalySeverity,
        status: row.status as AnomalyStatus,
        details: row.details as Anomaly["details"],
        correctionId: row.correctionId,
        detectedAt: row.detectedAt.toISOString(),
        recordedBy: actor(names, recordedBy.get(row.recordId) ?? row.labourerId),
        reviewedBy: optionalActor(names, row.reviewedBy),
        reviewedAt: iso(row.reviewedAt),
        reviewNote: row.reviewNote,
        version: row.version,
      };
    });
  }
}
