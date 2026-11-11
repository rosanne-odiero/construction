import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import {
  checkProcurementTransition,
  REQUISITION_TRANSITIONS,
} from "@pm-buddy/domain";
import type { RequisitionAction, RequisitionStatus } from "@pm-buddy/types";
import {
  requisitionDetailResponseSchema,
  requisitionsResponseSchema,
  type CreateRequisitionRequest,
  type RequisitionLineInput,
  type UpdateRequisitionRequest,
} from "@pm-buddy/validation";
import { isCheckViolation } from "../../../common/database-errors.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { Scope } from "../../identity/access-policy.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { assertUsableUnit } from "../catalogue.service.js";
import { businessToday, CatalogueStore, nextId } from "../catalogue-store.js";
import { fromCalendarDate, peopleOf, personOf, toCalendarDate } from "../procurement-mappers.js";
import {
  invalidTransition,
  iso,
  isoOrNull,
  makerChecker,
  materialWire,
  nextNumber,
  p2pBadRequest,
  p2pConflict,
  p2pProblem,
  P2pAccess,
  p2pVersionConflict,
  personOrNull,
  projectRef,
  toBaseQuantity,
} from "./p2p-common.js";

type RequisitionRow = Prisma.RequisitionGetPayload<object>;

const PAST = {
  submit: "submitted",
  approve: "approved",
  reject: "rejected",
  reopen: "reopened",
  cancel: "cancelled",
} as const;

/**
 * Material requisitions (D5.2, WORKFLOWS "Requisition"): raised on a project by someone with
 * procurement.requisition, lines in any convertible unit (stored with the base quantity), an
 * optional BQ item tag from the newest approved BQ version; decided by someone else with
 * procurement.approve. Material edits after submission need a return to draft.
 */
@Injectable()
export class RequisitionsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: P2pAccess,
    private readonly store: CatalogueStore,
  ) {}

  list(
    principal: Principal,
    query: { projectId?: string; status?: RequisitionStatus; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const projectIds = await this.access.visibleProjectIds(scope, query.projectId);
      const rows = await scope.tx.requisition.findMany({
        where: {
          tenantId: scope.access.tenantId,
          projectId: { in: projectIds },
          ...(query.status ? { status: query.status } : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        orderBy: { id: "desc" },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const canCreate =
        scope.access.permissions.has("procurement.requisition") &&
        (await this.access.visibleProjectIds(scope)).length > 0;
      return requisitionsResponseSchema.parse({
        requisitions: await this.summaries(scope, page),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
        },
        permissions: { canCreate },
      });
    });
  }

  get(principal: Principal, id: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const row = await this.row(scope, id);
      await this.access.viewer(scope, row.projectId);
      return this.detail(scope, id);
    });
  }

  create(principal: Principal, input: CreateRequisitionRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.access.require(scope, input.projectId, ["procurement.requisition"], {
          writable: true,
        });
        await this.assertSite(scope, input.projectId, input.siteId);
        const id = nextId();
        await tx.requisition.create({
          data: {
            id,
            tenantId: access.tenantId,
            projectId: input.projectId,
            siteId: input.siteId,
            number: await nextNumber(tx, access.tenantId, "requisition"),
            neededBy: fromCalendarDate(input.neededBy),
            notes: input.notes ?? null,
            lineCount: input.lines.length,
            createdBy: access.userId,
            updatedBy: access.userId,
          },
        });
        await this.writeLines(scope, id, input.projectId, input.lines);
        await this.scope.audit(tx, "requisition.created", id, {
          projectId: input.projectId,
          lines: input.lines.length,
        });
        return this.detail(scope, id);
      },
      true,
    );
  }

  update(principal: Principal, id: string, input: UpdateRequisitionRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.row(scope, id);
        await this.access.require(scope, row.projectId, ["procurement.requisition"], {
          writable: true,
        });
        if (row.status !== "draft") throw invalidTransition(row.status);
        if (row.version !== input.version) throw p2pVersionConflict();
        if (input.siteId !== undefined) await this.assertSite(scope, row.projectId, input.siteId);
        if (input.lines) {
          await tx.requisitionLine.deleteMany({ where: { tenantId: access.tenantId, requisitionId: id } });
          await this.writeLines(scope, id, row.projectId, input.lines);
        }
        const updated = await tx.requisition.updateMany({
          where: { tenantId: access.tenantId, id, version: input.version },
          data: {
            ...(input.siteId !== undefined ? { siteId: input.siteId } : {}),
            ...(input.neededBy ? { neededBy: fromCalendarDate(input.neededBy) } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            ...(input.lines ? { lineCount: input.lines.length } : {}),
            version: { increment: 1 },
            updatedBy: access.userId,
            updatedAt: new Date(),
          },
        });
        if (!updated.count) throw p2pVersionConflict();
        await this.scope.audit(tx, "requisition.updated", id, {
          fields: Object.keys(input).filter((key) => key !== "version"),
        });
        return this.detail(scope, id);
      },
      true,
    );
  }

  /** submit, approve, reject, reopen or cancel (permissions and maker-checker per action). */
  transition(
    principal: Principal,
    id: string,
    action: Exclude<RequisitionAction, "order" | "unorder">,
    input: { version: number; reason?: string },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const row = await this.row(scope, id);
          const decides = action === "approve" || action === "reject";
          const project = await this.access.on(scope, row.projectId);
          const allowed = decides
            ? project.permissions.has("procurement.approve")
            : project.permissions.has("procurement.requisition") ||
              (action === "cancel" && project.permissions.has("procurement.approve"));
          if (!allowed)
            throw new ForbiddenException(
              `Permission required: ${decides ? "procurement.approve" : "procurement.requisition"}`,
            );
          this.access.writable(project);
          const check = checkProcurementTransition(
            REQUISITION_TRANSITIONS,
            row.status as RequisitionStatus,
            action,
            input.reason,
          );
          if (!check.ok) {
            if (check.error === "reason_required")
              throw p2pBadRequest("reason-required", "A reason of at least 3 characters is required");
            throw invalidTransition(row.status);
          }
          if (row.version !== input.version) throw p2pVersionConflict();
          if (decides && row.contributors.includes(access.userId))
            throw makerChecker("Someone who raised or edited this requisition cannot decide on it");
          if (action === "reopen" && row.status === "approved") {
            const quoted = await tx.rfqRequisition.count({
              where: { tenantId: access.tenantId, requisitionId: id },
            });
            if (quoted)
              throw p2pConflict(
                "requisition-on-rfq",
                "This requisition went to an RFQ; cancel the RFQ and raise a new requisition",
              );
          }
          const now = new Date();
          const data: Prisma.RequisitionUpdateManyMutationInput = {
            status: check.to,
            version: { increment: 1 },
            updatedBy: access.userId,
            updatedAt: now,
          };
          if (action === "submit") Object.assign(data, { submittedBy: access.userId, submittedAt: now });
          if (decides)
            Object.assign(data, {
              decidedBy: access.userId,
              decidedAt: now,
              rejectionReason: action === "reject" ? input.reason!.trim() : null,
            });
          if (action === "reopen")
            Object.assign(data, {
              submittedBy: null,
              submittedAt: null,
              decidedBy: null,
              decidedAt: null,
              rejectionReason: null,
            });
          if (action === "cancel")
            Object.assign(data, {
              cancelledBy: access.userId,
              cancelledAt: now,
              cancelReason: input.reason!.trim(),
            });
          const updated = await tx.requisition.updateMany({
            where: { tenantId: access.tenantId, id, version: input.version },
            data,
          });
          if (!updated.count) throw p2pVersionConflict();
          await this.scope.audit(tx, `requisition.${PAST[action]}`, id, {
            projectId: row.projectId,
            from: row.status,
            to: check.to,
            reasonGiven: Boolean(input.reason),
          });
          return this.detail(scope, id);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isCheckViolation(error) && (action === "approve" || action === "reject"))
          throw makerChecker("Someone who raised or edited this requisition cannot decide on it");
        throw error;
      });
  }

  // Helpers ---------------------------------------------------------------------------------

  async row(scope: Scope, id: string): Promise<RequisitionRow> {
    const row = await scope.tx.requisition.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("Requisition not found");
    return row;
  }

  private async assertSite(scope: Scope, projectId: string, siteId: string | null) {
    if (!siteId) return;
    const site = await scope.tx.site.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: siteId } },
    });
    if (!site || site.projectId !== projectId)
      throw p2pBadRequest("site-not-in-project", "The site is not part of this project");
  }

  private async writeLines(
    scope: Scope,
    requisitionId: string,
    projectId: string,
    lines: readonly RequisitionLineInput[],
  ) {
    const { tx, access } = scope;
    const units = await this.store.customUnits(scope);
    const on = businessToday();
    let baseline: string | null | undefined;
    for (const [index, line] of lines.entries()) {
      const material = await this.store.material(scope, line.materialId);
      if (material.status !== "active")
        throw p2pConflict("material-archived", `${material.code} is archived`);
      assertUsableUnit(line.unit, units);
      const converted = await toBaseQuantity(
        this.store,
        scope,
        material,
        null,
        on,
        line.quantity,
        line.unit,
        units,
      );
      if (!/[1-9]/.test(converted.baseQuantity))
        throw p2pProblem(422, "invalid-quantity", "The quantity rounds to nothing in the base unit");
      let bqVersionId: string | null = null;
      if (line.bqItemLineageId) {
        if (baseline === undefined) {
          const version = await tx.bqVersion.findFirst({
            where: { tenantId: access.tenantId, projectId, status: "approved" },
            orderBy: { versionNo: "desc" },
            select: { id: true },
          });
          baseline = version?.id ?? null;
        }
        const item = baseline
          ? await tx.bqItem.findFirst({
              where: { tenantId: access.tenantId, versionId: baseline, lineageId: line.bqItemLineageId },
              select: { id: true },
            })
          : null;
        if (!item)
          throw p2pProblem(
            422,
            "bq-item-not-found",
            "The BQ item is not in the project's newest approved BQ version",
          );
        bqVersionId = baseline;
      }
      await tx.requisitionLine.create({
        data: {
          id: nextId(),
          tenantId: access.tenantId,
          requisitionId,
          lineNo: index + 1,
          materialId: material.id,
          quantity: line.quantity,
          unit: line.unit,
          baseQuantity: converted.baseQuantity,
          baseUnit: material.baseUnit,
          conversion: JSON.parse(
            JSON.stringify({ ratio: converted.ratio, steps: converted.steps }),
          ) as Prisma.InputJsonValue,
          bqVersionId,
          bqItemLineageId: bqVersionId ? line.bqItemLineageId : null,
          note: line.note ?? null,
        },
      });
    }
  }

  private async summaries(scope: Scope, rows: RequisitionRow[]) {
    const { tx, access } = scope;
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const [projects, sites, links, people] = await Promise.all([
      tx.project.findMany({
        where: { tenantId: access.tenantId, id: { in: [...new Set(rows.map((row) => row.projectId))] } },
        select: { id: true, code: true, name: true },
      }),
      tx.site.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: rows.map((row) => row.siteId).filter((id): id is string => Boolean(id)) },
        },
        select: { id: true, name: true },
      }),
      tx.rfqRequisition.findMany({
        where: { tenantId: access.tenantId, requisitionId: { in: ids }, releasedAt: null },
        include: {
          rfq: {
            select: {
              id: true,
              number: true,
              status: true,
              lpos: {
                where: { status: { not: "cancelled" } },
                select: { id: true, number: true, status: true },
              },
            },
          },
        },
      }),
      peopleOf(
        tx,
        rows.flatMap((row) => [row.createdBy, row.submittedBy, row.decidedBy]),
      ),
    ]);
    const projectOf = new Map(projects.map((project) => [project.id, projectRef(project)]));
    const siteOf = new Map(sites.map((site) => [site.id, site]));
    const linkOf = new Map(links.map((link) => [link.requisitionId, link.rfq]));
    return rows.map((row) => {
      const rfq = linkOf.get(row.id);
      return {
        id: row.id,
        number: row.number,
        project: projectOf.get(row.projectId)!,
        site: row.siteId ? (siteOf.get(row.siteId) ?? null) : null,
        status: row.status as RequisitionStatus,
        neededBy: toCalendarDate(row.neededBy),
        notes: row.notes,
        lineCount: row.lineCount,
        version: row.version,
        createdAt: iso(row.createdAt),
        createdBy: personOf(people, row.createdBy),
        submittedAt: isoOrNull(row.submittedAt),
        submittedBy: personOrNull(people, row.submittedBy),
        decidedAt: isoOrNull(row.decidedAt),
        decidedBy: personOrNull(people, row.decidedBy),
        rejectionReason: row.rejectionReason,
        cancelledAt: isoOrNull(row.cancelledAt),
        cancelReason: row.cancelReason,
        rfq: rfq ? { id: rfq.id, number: rfq.number, status: rfq.status } : null,
        lpo: rfq?.lpos[0] ?? null,
      };
    });
  }

  async detail(scope: Scope, id: string) {
    const { tx, access } = scope;
    const row = await this.row(scope, id);
    const [summary] = await this.summaries(scope, [row]);
    const lines = await tx.requisitionLine.findMany({
      where: { tenantId: access.tenantId, requisitionId: id },
      include: { material: true, bqItem: { select: { ref: true, description: true } } },
      orderBy: { lineNo: "asc" },
    });
    const people = await peopleOf(tx, row.contributors);
    const project = await this.access.on(scope, row.projectId);
    const requester = project.permissions.has("procurement.requisition");
    const approver = project.permissions.has("procurement.approve");
    return requisitionDetailResponseSchema.parse({
      requisition: summary,
      lines: lines.map((line) => ({
        id: line.id,
        lineNo: line.lineNo,
        material: materialWire(line.material),
        quantity: line.quantity.toFixed(),
        unit: line.unit,
        baseQuantity: line.baseQuantity.toFixed(),
        bqItem:
          line.bqVersionId && line.bqItemLineageId && line.bqItem
            ? {
                versionId: line.bqVersionId,
                lineageId: line.bqItemLineageId,
                ref: line.bqItem.ref,
                description: line.bqItem.description,
              }
            : null,
        note: line.note,
      })),
      contributors: row.contributors.map((person) => personOf(people, person)),
      permissions: {
        canEdit: requester && ["draft", "rejected", "submitted"].includes(row.status),
        canDecide:
          approver && row.status === "submitted" && !row.contributors.includes(access.userId),
        canCancel: (requester || approver) && ["draft", "submitted"].includes(row.status),
        canCreateRfq:
          access.permissions.has("procurement.manage_suppliers") &&
          row.status === "approved" &&
          summary?.rfq === null,
      },
    });
  }
}
