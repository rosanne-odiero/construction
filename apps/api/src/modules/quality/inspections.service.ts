import { Injectable, NotFoundException } from "@nestjs/common";
import {
  checkProcurementTransition,
  inspectionOutcome,
  inspectionReviewIndependent,
  inspectionSubmitIssues,
  INSPECTION_TRANSITIONS,
} from "@pm-buddy/domain";
import type { InspectionItemResult } from "@pm-buddy/types";
import {
  inspectionDetailResponseSchema,
  inspectionsResponseSchema,
  type CreateInspectionRequest,
  type InspectionActionRequest,
  type InspectionsQuery,
  type UpdateInspectionRequest,
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
  futureDate,
  lockProject,
  QualityAccess,
  qualityProblem,
  requireProjectPhotos,
  requireSite,
  versionConflict,
  type QualityContext,
} from "./quality-access.js";
import {
  inspectionInclude,
  inspectionPeople,
  itemInclude,
  snagInclude,
  snagPeople,
  toInspection,
  toItem,
  toSnag,
} from "./quality-mappers.js";

type Links = Pick<UpdateInspectionRequest, "wbsNodeId" | "scheduleActivityId" | "bqItemLineageId">;

/**
 * Inspections (D6.1): a checklist made from the current version of a company template, recorded
 * against a site (and optionally a WBS node, schedule activity or BQ item). The author answers
 * each item pass / fail / N/A with notes and site photos, then submits; an independent
 * quality.manage holder signs it off (locked) or returns it with a reason. Failed items of a
 * submitted inspection can raise snags (SnagsService).
 */
@Injectable()
export class InspectionsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly quality: QualityAccess,
  ) {}

  list(principal: Principal, projectId: string, query: InspectionsQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.quality.load(scope, projectId);
      const where: Prisma.InspectionWhereInput = {
        tenantId: scope.access.tenantId,
        projectId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.result ? { result: query.result } : {}),
        ...(query.cursor ? { number: { lt: query.cursor } } : {}),
      };
      const search = query.search?.trim();
      if (search) {
        const numbered = /^(?:INS-?)?0*(\d{1,9})$/i.exec(search);
        where.OR = [
          { location: { contains: search, mode: "insensitive" } },
          { template: { name: { contains: search, mode: "insensitive" } } },
          ...(numbered ? [{ number: Number(numbered[1]) }] : []),
        ];
      }
      const rows = await scope.tx.inspection.findMany({
        where,
        include: inspectionInclude,
        orderBy: { number: "desc" },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const people = await peopleOf(scope.tx, page.flatMap(inspectionPeople));
      return inspectionsResponseSchema.parse({
        inspections: page.map((row) => toInspection(row, people, context)),
        nextCursor: rows.length > query.limit ? page.at(-1)!.number : null,
        permissions: { canCreate: context.canRecord },
      });
    });
  }

  get(principal: Principal, projectId: string, inspectionId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.quality.load(scope, projectId);
      return this.detail(scope, context, inspectionId);
    });
  }

  create(principal: Principal, projectId: string, input: CreateInspectionRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.quality.recorder(scope, projectId);
        const { tenantId, userId } = scope.access;
        await requireSite(scope.tx, tenantId, projectId, input.siteId);
        futureDate(input.inspectedOn);
        const template = await scope.tx.checklistTemplate.findFirst({
          where: { tenantId, id: input.templateId },
          include: { items: { orderBy: { position: "asc" } } },
        });
        if (!template) throw new NotFoundException("Template not found");
        const newest = await scope.tx.checklistTemplate.findFirst({
          where: { tenantId, lineageId: template.lineageId },
          orderBy: { version: "desc" },
          select: { id: true, retired: true },
        });
        if (newest!.retired)
          throw qualityProblem(409, "template-retired", "This template has been retired");
        if (newest!.id !== template.id)
          throw qualityProblem(
            409,
            "template-not-current",
            "Use the current version of this template",
          );
        const links = await this.links(scope, projectId, input);
        await lockProject(scope.tx, tenantId, projectId);
        const latest = await scope.tx.inspection.findFirst({
          where: { tenantId, projectId },
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const id = uuidv7();
        const number = (latest?.number ?? 0) + 1;
        await scope.tx.inspection.create({
          data: {
            id,
            tenantId,
            projectId,
            siteId: input.siteId,
            number,
            templateId: template.id,
            category: template.category,
            location: input.location,
            inspectorType: input.inspectorType,
            inspectorName: input.inspectorName,
            inspectedOn: fromCalendarDate(input.inspectedOn),
            notes: input.notes,
            wbsNodeId: links.wbsNodeId ?? null,
            scheduleActivityId: links.scheduleActivityId ?? null,
            bqVersionId: links.bqVersionId ?? null,
            bqItemLineageId: links.bqItemLineageId ?? null,
            createdBy: userId,
            updatedBy: userId,
          },
        });
        await scope.tx.inspectionItem.createMany({
          data: template.items.map((item) => ({
            id: uuidv7(),
            tenantId,
            projectId,
            inspectionId: id,
            position: item.position,
            text: item.text,
            updatedBy: userId,
          })),
        });
        await this.scope.audit(scope.tx, "quality.inspection_created", id, {
          projectId,
          siteId: input.siteId,
          number,
          templateId: template.id,
          category: template.category,
          inspectorType: input.inspectorType,
        });
        return this.detail(scope, context, id);
      },
      true,
    );
  }

  update(
    principal: Principal,
    projectId: string,
    inspectionId: string,
    input: UpdateInspectionRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.quality.recorder(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.load(scope, projectId, inspectionId, input.version);
        this.author(row.createdBy, userId);
        if (row.status !== "draft")
          throw qualityProblem(409, "inspection-not-draft", "Only a draft inspection can change");
        if (input.inspectedOn) futureDate(input.inspectedOn);
        const data: Prisma.InspectionUncheckedUpdateManyInput = {
          updatedBy: userId,
          version: { increment: 1 },
        };
        const fields: string[] = [];
        if (input.location !== undefined) data.location = input.location;
        if (input.inspectorType !== undefined) data.inspectorType = input.inspectorType;
        if (input.inspectorName !== undefined) data.inspectorName = input.inspectorName;
        if (input.inspectedOn !== undefined) data.inspectedOn = fromCalendarDate(input.inspectedOn);
        if (input.notes !== undefined) data.notes = input.notes;
        const links = await this.links(scope, projectId, input);
        if (input.wbsNodeId !== undefined) data.wbsNodeId = links.wbsNodeId;
        if (input.scheduleActivityId !== undefined)
          data.scheduleActivityId = links.scheduleActivityId;
        if (input.bqItemLineageId !== undefined) {
          data.bqVersionId = links.bqVersionId;
          data.bqItemLineageId = links.bqItemLineageId;
        }
        for (const key of Object.keys(data))
          if (key !== "updatedBy" && key !== "version") fields.push(key);
        const items = input.items ?? [];
        if (items.length) {
          const known = new Set(
            (
              await scope.tx.inspectionItem.findMany({
                where: { tenantId, inspectionId },
                select: { id: true },
              })
            ).map((item) => item.id),
          );
          if (items.some((item) => !known.has(item.id)))
            throw qualityProblem(
              422,
              "inspection-item-unknown",
              "An item is not on this inspection",
            );
          await requireProjectPhotos(
            scope.tx,
            tenantId,
            projectId,
            items.flatMap((item) => item.photoIds),
          );
        }
        const changed = await scope.tx.inspection.updateMany({
          where: { tenantId, projectId, id: inspectionId, version: input.version },
          data,
        });
        if (changed.count !== 1) throw versionConflict();
        for (const item of items) {
          await scope.tx.inspectionItem.update({
            where: { id: item.id },
            data: { result: item.result, note: item.note, updatedBy: userId },
          });
          const current = await scope.tx.inspectionItemPhoto.findMany({
            where: { tenantId, itemId: item.id },
            select: { photoId: true },
          });
          const wanted = new Set(item.photoIds);
          const removed = current.filter((link) => !wanted.has(link.photoId));
          if (removed.length)
            await scope.tx.inspectionItemPhoto.deleteMany({
              where: {
                tenantId,
                itemId: item.id,
                photoId: { in: removed.map((link) => link.photoId) },
              },
            });
          const have = new Set(current.map((link) => link.photoId));
          const added = item.photoIds.filter((photoId) => !have.has(photoId));
          if (added.length)
            await scope.tx.inspectionItemPhoto.createMany({
              data: added.map((photoId) => ({ tenantId, projectId, itemId: item.id, photoId })),
            });
        }
        await this.scope.audit(scope.tx, "quality.inspection_updated", inspectionId, {
          projectId,
          number: row.number,
          version: input.version + 1,
          fields,
          itemsChanged: items.length,
        });
        return this.detail(scope, context, inspectionId);
      },
      true,
    );
  }

  action(
    principal: Principal,
    projectId: string,
    inspectionId: string,
    input: InspectionActionRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const review = input.action !== "submit";
        const context = review
          ? await this.quality.reviewer(scope, projectId)
          : await this.quality.recorder(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.load(scope, projectId, inspectionId, input.version);
        const check = checkProcurementTransition(
          INSPECTION_TRANSITIONS,
          row.status as "draft" | "submitted" | "signed_off",
          input.action,
          input.reason,
        );
        if (!check.ok)
          throw qualityProblem(409, "invalid-transition", "This action is not available now");
        let data: Prisma.InspectionUncheckedUpdateManyInput;
        let result: string | null = row.result;
        if (input.action === "submit") {
          this.author(row.createdBy, userId);
          const items = await scope.tx.inspectionItem.findMany({
            where: { tenantId, inspectionId },
            select: { result: true, note: true },
          });
          const typed = items.map((item) => ({
            result: item.result as InspectionItemResult,
            note: item.note,
          }));
          if (inspectionSubmitIssues(typed).length)
            throw qualityProblem(
              409,
              "inspection-incomplete",
              "Answer every item and explain every failed item before submitting",
            );
          result = inspectionOutcome(typed.map((item) => item.result));
          data = { status: "submitted", submittedBy: userId, result };
        } else {
          if (!inspectionReviewIndependent(row, userId))
            throw qualityProblem(
              403,
              "inspection-independent-review",
              "Someone who did not record or submit the inspection must review it",
            );
          data =
            input.action === "sign_off"
              ? { status: "signed_off", signedOffBy: userId }
              : {
                  status: "draft",
                  submittedBy: null,
                  submittedAt: null,
                  result: null,
                  returnedBy: userId,
                  returnReason: input.reason!,
                };
        }
        const changed = await scope.tx.inspection.updateMany({
          where: { tenantId, projectId, id: inspectionId, version: input.version },
          data: { ...data, updatedBy: userId, version: { increment: 1 } },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(
          scope.tx,
          {
            submit: "quality.inspection_submitted",
            sign_off: "quality.inspection_signed_off",
            return: "quality.inspection_returned",
          }[input.action],
          inspectionId,
          {
            projectId,
            number: row.number,
            from: row.status,
            to: check.to,
            result,
            version: input.version + 1,
          },
        );
        return this.detail(scope, context, inspectionId);
      },
      true,
    );
  }

  private author(createdBy: string, userId: string) {
    if (createdBy !== userId)
      throw qualityProblem(
        403,
        "inspection-author-required",
        "Only the inspection's author can change or submit it",
      );
  }

  private async load(scope: Scope, projectId: string, inspectionId: string, version?: number) {
    const row = await scope.tx.inspection.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: inspectionId },
    });
    if (!row) throw new NotFoundException("Inspection not found");
    if (version !== undefined && row.version !== version) throw versionConflict();
    return row;
  }

  /** Resolves optional WBS, schedule-activity and BQ links inside the project. */
  private async links(scope: Scope, projectId: string, input: Links) {
    const { tenantId } = scope.access;
    if (input.wbsNodeId) {
      const node = await scope.tx.wbsNode.findFirst({
        where: { tenantId, projectId, id: input.wbsNodeId },
        select: { id: true },
      });
      if (!node) throw new NotFoundException("WBS node not found");
    }
    if (input.scheduleActivityId) {
      const activity = await scope.tx.scheduleActivity.findFirst({
        where: { tenantId, projectId, id: input.scheduleActivityId, kind: "task" },
        select: { id: true },
      });
      if (!activity) throw new NotFoundException("Schedule activity not found");
    }
    let bqVersionId: string | null = null;
    if (input.bqItemLineageId) {
      const version = await scope.tx.bqVersion.findFirst({
        where: { tenantId, projectId, status: "approved" },
        orderBy: { versionNo: "desc" },
        select: { id: true },
      });
      const item = version
        ? await scope.tx.bqItem.findFirst({
            where: { tenantId, versionId: version.id, lineageId: input.bqItemLineageId },
            select: { id: true },
          })
        : null;
      if (!version || !item)
        throw qualityProblem(
          422,
          "bq-item-not-found",
          "The BQ item is not in the project's newest approved BQ version",
        );
      bqVersionId = version.id;
    }
    return {
      wbsNodeId: input.wbsNodeId ?? null,
      scheduleActivityId: input.scheduleActivityId ?? null,
      bqVersionId,
      bqItemLineageId: input.bqItemLineageId ?? null,
    };
  }

  async detail(scope: Scope, context: QualityContext, inspectionId: string) {
    const { tenantId } = scope.access;
    const row = await scope.tx.inspection.findFirst({
      where: { tenantId, projectId: context.project.id, id: inspectionId },
      include: inspectionInclude,
    });
    if (!row) throw new NotFoundException("Inspection not found");
    const [items, snags] = await Promise.all([
      scope.tx.inspectionItem.findMany({
        where: { tenantId, inspectionId },
        include: itemInclude,
        orderBy: { position: "asc" },
      }),
      scope.tx.snag.findMany({
        where: { tenantId, projectId: context.project.id, inspectionItem: { inspectionId } },
        include: snagInclude,
        orderBy: { number: "asc" },
      }),
    ]);
    const people = await peopleOf(scope.tx, [
      ...inspectionPeople(row),
      ...snags.flatMap(snagPeople),
    ]);
    return inspectionDetailResponseSchema.parse({
      inspection: toInspection(row, people, context),
      items: items.map(toItem),
      snags: snags.map((snag) => toSnag(snag, people, context)),
    });
  }
}
