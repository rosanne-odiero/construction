import { Injectable, NotFoundException } from "@nestjs/common";
import {
  checkProcurementTransition,
  nairobiDate,
  snagDecisionIndependent,
  SNAG_TRANSITIONS,
} from "@pm-buddy/domain";
import type { SnagStatus } from "@pm-buddy/types";
import {
  snagResponseSchema,
  snagsResponseSchema,
  type CreateSnagRequest,
  type SnagActionRequest,
  type SnagsQuery,
  type UpdateSnagRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { peopleOf } from "../procurement/procurement-mappers.js";
import { fromCalendarDate } from "../projects/project-mappers.js";
import {
  lockProject,
  QualityAccess,
  qualityProblem,
  requireProjectPhotos,
  requireSite,
  versionConflict,
  type QualityContext,
} from "./quality-access.js";
import { snagInclude, snagPeople, toSnag } from "./quality-mappers.js";

/**
 * Snags and defects (D6.1): raised on a site (optionally from a failed inspection item) with a
 * severity, responsible party, due date and photos; open → fixed (recorded for the responsible
 * party) → closed by an independent quality.manage holder, or reopened with a reason. Snags raised
 * after practical completion was certified are defects liability period (DLP) snags.
 */
@Injectable()
export class SnagsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly quality: QualityAccess,
  ) {}

  list(principal: Principal, projectId: string, query: SnagsQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.quality.load(scope, projectId);
      const { tenantId } = scope.access;
      const where: Prisma.SnagWhereInput = {
        tenantId,
        projectId,
        ...(query.status === "active"
          ? { status: { in: ["open", "fixed"] } }
          : query.status
            ? { status: query.status }
            : {}),
        ...(query.severity ? { severity: query.severity } : {}),
        ...(query.phase ? { phase: query.phase } : {}),
        ...(query.cursor ? { number: { lt: query.cursor } } : {}),
      };
      const search = query.search?.trim();
      if (search) {
        const numbered = /^(?:SNG-?)?0*(\d{1,9})$/i.exec(search);
        where.OR = [
          { location: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
          { responsibleName: { contains: search, mode: "insensitive" } },
          ...(numbered ? [{ number: Number(numbered[1]) }] : []),
        ];
      }
      const scoped = { tenantId, projectId };
      const [rows, open, fixed, closed, openCritical, overdue, dlpOpen] = await Promise.all([
        scope.tx.snag.findMany({
          where,
          include: snagInclude,
          orderBy: { number: "desc" },
          take: query.limit + 1,
        }),
        scope.tx.snag.count({ where: { ...scoped, status: "open" } }),
        scope.tx.snag.count({ where: { ...scoped, status: "fixed" } }),
        scope.tx.snag.count({ where: { ...scoped, status: "closed" } }),
        scope.tx.snag.count({
          where: { ...scoped, severity: "critical", status: { not: "closed" } },
        }),
        scope.tx.snag.count({
          where: { ...scoped, status: "open", dueOn: { lt: fromCalendarDate(nairobiDate()) } },
        }),
        scope.tx.snag.count({ where: { ...scoped, phase: "dlp", status: { not: "closed" } } }),
      ]);
      const page = rows.slice(0, query.limit);
      const people = await peopleOf(scope.tx, page.flatMap(snagPeople));
      return snagsResponseSchema.parse({
        snags: page.map((row) => toSnag(row, people, context)),
        nextCursor: rows.length > query.limit ? page.at(-1)!.number : null,
        counts: { open, fixed, closed, openCritical, overdue, dlpOpen },
        permissions: { canCreate: context.canRecord },
      });
    });
  }

  get(principal: Principal, projectId: string, snagId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.quality.load(scope, projectId);
      return this.detail(scope, context, snagId);
    });
  }

  create(principal: Principal, projectId: string, input: CreateSnagRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.quality.recorder(scope, projectId);
        const { tenantId, userId } = scope.access;
        await requireSite(scope.tx, tenantId, projectId, input.siteId);
        if (input.inspectionItemId) {
          const item = await scope.tx.inspectionItem.findFirst({
            where: { tenantId, projectId, id: input.inspectionItemId },
            select: { result: true, inspection: { select: { status: true } } },
          });
          if (!item) throw new NotFoundException("Inspection item not found");
          if (item.result !== "fail" || item.inspection.status === "draft")
            throw qualityProblem(
              409,
              "snag-item-not-failed",
              "Snags are raised from failed items of submitted inspections",
            );
        }
        await requireProjectPhotos(scope.tx, tenantId, projectId, input.photoIds);
        await lockProject(scope.tx, tenantId, projectId);
        const [latest, practical] = await Promise.all([
          scope.tx.snag.findFirst({
            where: { tenantId, projectId },
            orderBy: { number: "desc" },
            select: { number: true },
          }),
          scope.tx.projectCompletion.findFirst({
            where: { tenantId, projectId, kind: "practical", status: "certified" },
            select: { id: true },
          }),
        ]);
        const id = uuidv7();
        const number = (latest?.number ?? 0) + 1;
        const phase = practical ? "dlp" : "construction";
        await scope.tx.snag.create({
          data: {
            id,
            tenantId,
            projectId,
            siteId: input.siteId,
            number,
            location: input.location,
            description: input.description,
            severity: input.severity,
            responsibleKind: input.responsibleKind,
            responsibleName: input.responsibleName,
            dueOn: input.dueOn ? fromCalendarDate(input.dueOn) : null,
            phase,
            inspectionItemId: input.inspectionItemId ?? null,
            raisedBy: userId,
            updatedBy: userId,
          },
        });
        if (input.photoIds.length)
          await scope.tx.snagPhoto.createMany({
            data: input.photoIds.map((photoId) => ({
              tenantId,
              projectId,
              snagId: id,
              photoId,
              stage: "raised",
              addedBy: userId,
            })),
          });
        await this.scope.audit(scope.tx, "quality.snag_raised", id, {
          projectId,
          siteId: input.siteId,
          number,
          severity: input.severity,
          phase,
          fromInspection: Boolean(input.inspectionItemId),
          photos: input.photoIds.length,
        });
        return this.detail(scope, context, id);
      },
      true,
    );
  }

  update(
    principal: Principal,
    projectId: string,
    snagId: string,
    input: UpdateSnagRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.quality.reviewer(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.load(scope, projectId, snagId, input.version);
        if (row.status !== "open")
          throw qualityProblem(409, "snag-not-open", "Only an open snag can be edited");
        const { version, dueOn, ...content } = input;
        const data: Prisma.SnagUncheckedUpdateManyInput = {
          ...Object.fromEntries(Object.entries(content).filter(([, value]) => value !== undefined)),
          ...(dueOn !== undefined ? { dueOn: dueOn ? fromCalendarDate(dueOn) : null } : {}),
        };
        const fields = Object.keys(data);
        const changed = await scope.tx.snag.updateMany({
          where: { tenantId, projectId, id: snagId, version },
          data: { ...data, updatedBy: userId, version: { increment: 1 } },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(scope.tx, "quality.snag_updated", snagId, {
          projectId,
          number: row.number,
          version: version + 1,
          fields,
          severity:
            input.severity && input.severity !== row.severity
              ? { from: row.severity, to: input.severity }
              : null,
        });
        return this.detail(scope, context, snagId);
      },
      true,
    );
  }

  action(
    principal: Principal,
    projectId: string,
    snagId: string,
    input: SnagActionRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context =
          input.action === "fix"
            ? await this.quality.recorder(scope, projectId)
            : await this.quality.reviewer(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.load(scope, projectId, snagId, input.version);
        const check = checkProcurementTransition(
          SNAG_TRANSITIONS,
          row.status as SnagStatus,
          input.action,
          input.reason,
        );
        if (!check.ok)
          throw qualityProblem(409, "invalid-transition", "This action is not available now");
        if (input.action !== "fix" && !snagDecisionIndependent(row, userId))
          throw qualityProblem(
            403,
            "snag-independent-verification",
            "Someone other than whoever recorded the fix must verify it",
          );
        const photoIds = input.photoIds ?? [];
        await requireProjectPhotos(scope.tx, tenantId, projectId, photoIds);
        const data: Prisma.SnagUncheckedUpdateManyInput =
          input.action === "fix"
            ? { status: "fixed", fixedBy: userId, fixNote: input.note ?? null }
            : input.action === "close"
              ? { status: "closed", closedBy: userId }
              : {
                  status: "open",
                  fixedBy: null,
                  fixedAt: null,
                  fixNote: null,
                  reopenCount: row.reopenCount + 1,
                  lastReopenReason: input.reason!,
                };
        const changed = await scope.tx.snag.updateMany({
          where: { tenantId, projectId, id: snagId, version: input.version },
          data: { ...data, updatedBy: userId, version: { increment: 1 } },
        });
        if (changed.count !== 1) throw versionConflict();
        if (photoIds.length)
          await scope.tx.snagPhoto.createMany({
            data: photoIds.map((photoId) => ({
              tenantId,
              projectId,
              snagId,
              photoId,
              stage: "fixed",
              addedBy: userId,
            })),
            skipDuplicates: true,
          });
        await this.scope.audit(
          scope.tx,
          {
            fix: "quality.snag_fixed",
            close: "quality.snag_closed",
            reopen: "quality.snag_reopened",
          }[input.action],
          snagId,
          {
            projectId,
            number: row.number,
            from: row.status,
            to: check.to,
            version: input.version + 1,
            photos: photoIds.length,
          },
        );
        return this.detail(scope, context, snagId);
      },
      true,
    );
  }

  private async load(scope: Scope, projectId: string, snagId: string, version: number) {
    const row = await scope.tx.snag.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: snagId },
    });
    if (!row) throw new NotFoundException("Snag not found");
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private async detail(scope: Scope, context: QualityContext, snagId: string) {
    const row = await scope.tx.snag.findFirst({
      where: { tenantId: scope.access.tenantId, projectId: context.project.id, id: snagId },
      include: snagInclude,
    });
    if (!row) throw new NotFoundException("Snag not found");
    const people = await peopleOf(scope.tx, snagPeople(row));
    return snagResponseSchema.parse({ snag: toSnag(row, people, context) });
  }
}
