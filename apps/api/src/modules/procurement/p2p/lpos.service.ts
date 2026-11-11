import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { checkProcurementTransition, LPO_TRANSITIONS, Ratio } from "@pm-buddy/domain";
import type { LpoAction, LpoDeliveryState, LpoStatus } from "@pm-buddy/types";
import {
  lpoDetailResponseSchema,
  lposResponseSchema,
  type UpdateLpoRequest,
} from "@pm-buddy/validation";
import { isCheckViolation } from "../../../common/database-errors.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { Scope } from "../../identity/access-policy.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { fromCalendarDate, peopleOf, personOf, toCalendarDate } from "../procurement-mappers.js";
import {
  invalidTransition,
  iso,
  isoOrNull,
  makerChecker,
  materialWire,
  p2pBadRequest,
  p2pConflict,
  P2pAccess,
  p2pVersionConflict,
  personOrNull,
  projectRef,
  qtyText,
  sumQuantities,
} from "./p2p-common.js";

type LpoRow = Prisma.LpoGetPayload<object>;
const ACCRUED = ["approved", "partly_settled", "settled"];

const PAST = { submit: "submitted", approve: "approved", return: "returned", cancel: "cancelled" };

/**
 * LPOs (D5.2): drafted by the award, edited (delivery site, date, terms) and submitted by
 * procurement, approved with step-up by a different person with procurement.approve on the
 * project. An approved LPO is a commitment and never changes; an amendment is a cancellation
 * (only while nothing was received or invoiced) and a reissue from the reopened RFQ.
 */
@Injectable()
export class LposService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: P2pAccess,
  ) {}

  list(
    principal: Principal,
    query: {
      projectId?: string;
      status?: LpoStatus;
      supplierId?: string;
      cursor?: string;
      limit: number;
    },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const projectIds = await this.access.visibleProjectIds(scope, query.projectId);
      const rows = await scope.tx.lpo.findMany({
        where: {
          tenantId: scope.access.tenantId,
          projectId: { in: projectIds },
          ...(query.status ? { status: query.status } : {}),
          ...(query.supplierId ? { supplierId: query.supplierId } : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        orderBy: { id: "desc" },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      return lposResponseSchema.parse({
        lpos: await Promise.all(page.map((row) => this.summary(scope, row))),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
        },
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

  update(principal: Principal, id: string, input: UpdateLpoRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.row(scope, id);
        await this.access.require(scope, row.projectId, ["procurement.manage_suppliers"], {
          writable: true,
        });
        if (row.status !== "draft") throw invalidTransition(row.status);
        if (row.version !== input.version) throw p2pVersionConflict();
        if (input.deliverySiteId) {
          const site = await tx.site.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: input.deliverySiteId } },
          });
          if (!site || site.projectId !== row.projectId)
            throw p2pBadRequest("site-not-in-project", "The site is not part of this project");
        }
        await this.bump(scope, row, {
          ...(input.deliverySiteId !== undefined ? { deliverySiteId: input.deliverySiteId } : {}),
          ...(input.deliveryDate !== undefined
            ? { deliveryDate: input.deliveryDate ? fromCalendarDate(input.deliveryDate) : null }
            : {}),
          ...(input.terms !== undefined ? { terms: input.terms } : {}),
        });
        await this.scope.audit(tx, "lpo.updated", id, {
          fields: Object.keys(input).filter((key) => key !== "version"),
        });
        return this.detail(scope, id);
      },
      true,
    );
  }

  transition(
    principal: Principal,
    id: string,
    action: LpoAction,
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
          const deciding = action === "approve" || action === "return";
          const project = await this.access.on(scope, row.projectId);
          const permission = deciding ? "procurement.approve" : "procurement.manage_suppliers";
          if (!project.permissions.has(permission))
            throw new ForbiddenException(`Permission required: ${permission}`);
          if (action === "approve") this.access.stepUp(scope);
          if (action !== "cancel") this.access.writable(project);
          const check = checkProcurementTransition(
            LPO_TRANSITIONS,
            row.status as LpoStatus,
            action,
            input.reason,
          );
          if (!check.ok) {
            if (check.error === "reason_required")
              throw p2pBadRequest("reason-required", "A reason of at least 3 characters is required");
            throw invalidTransition(row.status);
          }
          if (row.version !== input.version) throw p2pVersionConflict();
          if (deciding && row.contributors.includes(access.userId))
            throw makerChecker("Someone who prepared this LPO cannot approve or return it");
          if (action === "cancel" && row.status === "approved") {
            const [grns, invoices] = await Promise.all([
              tx.grn.count({ where: { tenantId: access.tenantId, lpoId: id, status: "recorded" } }),
              tx.supplierInvoice.count({
                where: { tenantId: access.tenantId, lpoId: id, status: { not: "cancelled" } },
              }),
            ]);
            if (grns || invoices)
              throw p2pConflict(
                "lpo-has-deliveries",
                "Goods were received or invoiced against this LPO; it cannot be cancelled",
              );
          }
          const now = new Date();
          const data: Prisma.LpoUpdateManyMutationInput = { status: check.to };
          if (action === "submit")
            Object.assign(data, { submittedBy: access.userId, submittedAt: now, returnReason: null });
          if (action === "approve") Object.assign(data, { approvedBy: access.userId, approvedAt: now });
          if (action === "return")
            Object.assign(data, { submittedBy: null, submittedAt: null, returnReason: input.reason });
          if (action === "cancel")
            Object.assign(data, {
              cancelledBy: access.userId,
              cancelledAt: now,
              cancelReason: input.reason,
            });
          await this.bump(scope, row, data);
          const links = await tx.rfqRequisition.findMany({
            where: { tenantId: access.tenantId, rfqId: row.rfqId, releasedAt: null },
            select: { requisitionId: true },
          });
          const requisitionIds = links.map((link) => link.requisitionId);
          if (action === "approve")
            await this.moveRequisitions(scope, requisitionIds, "approved", "ordered");
          if (action === "cancel") {
            if (row.status === "approved")
              await this.moveRequisitions(scope, requisitionIds, "ordered", "approved");
            const rfq = await tx.rfq.findUniqueOrThrow({
              where: { tenantId_id: { tenantId: access.tenantId, id: row.rfqId } },
            });
            const reopened = await tx.rfq.updateMany({
              where: { tenantId: access.tenantId, id: rfq.id, version: rfq.version, status: "awarded" },
              data: {
                status: "open",
                version: { increment: 1 },
                updatedBy: access.userId,
                updatedAt: now,
              },
            });
            if (!reopened.count) throw p2pVersionConflict();
          }
          await this.scope.audit(tx, `lpo.${PAST[action]}`, id, {
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
        if (isCheckViolation(error) && (action === "approve" || action === "return"))
          throw makerChecker("Someone who prepared this LPO cannot approve or return it");
        throw error;
      });
  }

  // Helpers ---------------------------------------------------------------------------------

  private async moveRequisitions(scope: Scope, ids: string[], from: string, to: string) {
    const rows = await scope.tx.requisition.findMany({
      where: { tenantId: scope.access.tenantId, id: { in: ids }, status: from },
    });
    for (const row of rows) {
      const moved = await scope.tx.requisition.updateMany({
        where: { tenantId: scope.access.tenantId, id: row.id, version: row.version },
        data: {
          status: to,
          version: { increment: 1 },
          updatedBy: scope.access.userId,
          updatedAt: new Date(),
        },
      });
      if (!moved.count) throw p2pVersionConflict();
      await this.scope.audit(scope.tx, `requisition.${to === "ordered" ? "ordered" : "unordered"}`, row.id, {
        projectId: row.projectId,
      });
    }
  }

  async row(scope: Scope, id: string): Promise<LpoRow> {
    const row = await scope.tx.lpo.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("LPO not found");
    return row;
  }

  private async bump(scope: Scope, row: LpoRow, data: Prisma.LpoUpdateManyMutationInput) {
    const updated = await scope.tx.lpo.updateMany({
      where: { tenantId: scope.access.tenantId, id: row.id, version: row.version },
      data: { ...data, version: { increment: 1 }, updatedBy: scope.access.userId, updatedAt: new Date() },
    });
    if (!updated.count) throw p2pVersionConflict();
  }

  /** Accepted (recorded GRNs) and billed (approved invoices) base quantities per LPO line. */
  async progress(scope: Scope, lpoId: string) {
    const { tx, access } = scope;
    const [received, billed] = await Promise.all([
      tx.grnLine.findMany({
        where: { tenantId: access.tenantId, lpoId, grn: { status: "recorded" } },
        select: { lpoLineId: true, acceptedBaseQuantity: true },
      }),
      tx.supplierInvoiceLine.findMany({
        where: { tenantId: access.tenantId, lpoId, invoice: { status: { in: ACCRUED } } },
        select: { lpoLineId: true, baseQuantity: true },
      }),
    ]);
    const sum = <T extends { lpoLineId: string }>(rows: T[], pick: (row: T) => { toFixed(): string }) => {
      const totals = new Map<string, Ratio>();
      for (const row of rows)
        totals.set(
          row.lpoLineId,
          (totals.get(row.lpoLineId) ?? Ratio.of(0)).plus(sumQuantities([pick(row)])),
        );
      return totals;
    };
    return {
      received: sum(received, (row) => row.acceptedBaseQuantity),
      billed: sum(billed, (row) => row.baseQuantity),
    };
  }

  async deliveryState(scope: Scope, row: LpoRow): Promise<LpoDeliveryState> {
    const lines = await scope.tx.lpoLine.findMany({
      where: { tenantId: scope.access.tenantId, lpoId: row.id },
      select: { id: true, baseQuantity: true },
    });
    const { received } = await this.progress(scope, row.id);
    return deliveryStateOf(lines, received);
  }

  async summary(scope: Scope, row: LpoRow) {
    const { tx, access } = scope;
    const [project, site, rfq, replaces, people, deliveryState] = await Promise.all([
      tx.project.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: access.tenantId, id: row.projectId } },
        select: { id: true, code: true, name: true },
      }),
      row.deliverySiteId
        ? tx.site.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: row.deliverySiteId } },
            select: { id: true, name: true },
          })
        : null,
      tx.rfq.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: access.tenantId, id: row.rfqId } },
        select: { id: true, number: true },
      }),
      row.replacesLpoId
        ? tx.lpo.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: row.replacesLpoId } },
            select: { id: true, number: true },
          })
        : null,
      peopleOf(tx, [row.createdBy, row.submittedBy, row.approvedBy]),
      this.deliveryState(scope, row),
    ]);
    const supplier = await tx.supplier.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: access.tenantId, id: row.supplierId } },
      select: { code: true },
    });
    return {
      id: row.id,
      number: row.number,
      project: projectRef(project),
      deliverySite: site,
      supplier: {
        id: row.supplierId,
        code: supplier.code,
        name: row.supplierName,
        kraPinMasked: row.supplierKraPinMasked,
        etimsStatus: row.supplierEtimsStatus as "registered" | "unknown" | "not_registered",
      },
      status: row.status as LpoStatus,
      deliveryState,
      rfq,
      quotationId: row.quotationId,
      replacesLpo: replaces,
      deliveryDate: row.deliveryDate ? toCalendarDate(row.deliveryDate) : null,
      terms: row.terms,
      creditDays: row.creditDays,
      vatRatePercent: row.vatRatePercent.toFixed(),
      subtotalMinor: Number(row.subtotalMinor),
      vatMinor: Number(row.vatMinor),
      totalMinor: Number(row.totalMinor),
      version: row.version,
      createdAt: iso(row.createdAt),
      createdBy: personOf(people, row.createdBy),
      submittedAt: isoOrNull(row.submittedAt),
      submittedBy: personOrNull(people, row.submittedBy),
      approvedAt: isoOrNull(row.approvedAt),
      approvedBy: personOrNull(people, row.approvedBy),
      returnReason: row.returnReason,
      cancelledAt: isoOrNull(row.cancelledAt),
      cancelReason: row.cancelReason,
    };
  }

  async detail(scope: Scope, id: string) {
    const { tx, access } = scope;
    const row = await this.row(scope, id);
    const [summary, lines, grns, invoices, progress, project, people] = await Promise.all([
      this.summary(scope, row),
      tx.lpoLine.findMany({
        where: { tenantId: access.tenantId, lpoId: id },
        include: {
          material: true,
          requisitionLine: {
            select: {
              bqVersionId: true,
              bqItemLineageId: true,
              bqItem: { select: { ref: true, description: true } },
            },
          },
        },
        orderBy: { lineNo: "asc" },
      }),
      tx.grn.findMany({
        where: { tenantId: access.tenantId, lpoId: id },
        orderBy: { receivedAt: "asc" },
        select: { id: true, number: true, status: true, receivedAt: true, locationState: true },
      }),
      tx.supplierInvoice.findMany({
        where: { tenantId: access.tenantId, lpoId: id },
        orderBy: { createdAt: "asc" },
        select: { id: true, invoiceNumber: true, status: true, totalMinor: true, computedSubtotalMinor: true },
      }),
      this.progress(scope, id),
      this.access.on(scope, row.projectId),
      peopleOf(tx, row.contributors),
    ]);
    const committed = row.status === "approved" ? Number(row.subtotalMinor) : 0;
    const accrued = invoices
      .filter((invoice) => ACCRUED.includes(invoice.status))
      .reduce((sum, invoice) => sum + Number(invoice.computedSubtotalMinor), 0);
    const can = (permission: Parameters<typeof project.permissions.has>[0]) =>
      project.permissions.has(permission);
    return lpoDetailResponseSchema.parse({
      lpo: summary,
      lines: lines.map((line) => {
        const requisition = line.requisitionLine;
        return {
          id: line.id,
          lineNo: line.lineNo,
          requisitionLineId: line.requisitionLineId,
          material: materialWire(line.material),
          quantity: line.quantity.toFixed(),
          unit: line.unit,
          baseQuantity: line.baseQuantity.toFixed(),
          priceUnit: line.priceUnit,
          unitPriceMinor: Number(line.unitPriceMinor),
          vatTreatment: line.vatTreatment,
          netUnitPriceBaseMinor: line.netUnitPriceBaseMinor.toFixed(),
          netAmountMinor: Number(line.netAmountMinor),
          bqItem:
            requisition.bqVersionId && requisition.bqItemLineageId && requisition.bqItem
              ? {
                  versionId: requisition.bqVersionId,
                  lineageId: requisition.bqItemLineageId,
                  ref: requisition.bqItem.ref,
                  description: requisition.bqItem.description,
                }
              : null,
          receivedBaseQuantity: qtyText(progress.received.get(line.id) ?? Ratio.of(0)),
          invoicedBaseQuantity: qtyText(progress.billed.get(line.id) ?? Ratio.of(0)),
        };
      }),
      grns: grns.map((grn) => ({ ...grn, receivedAt: iso(grn.receivedAt) })),
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        totalMinor: Number(invoice.totalMinor),
      })),
      commitment: {
        committedMinor: committed,
        accruedMinor: accrued,
        openMinor: Math.max(0, committed - accrued),
      },
      contributors: row.contributors.map((person) => personOf(people, person)),
      permissions: {
        canManage: can("procurement.manage_suppliers") && row.status !== "cancelled",
        canApprove:
          can("procurement.approve") &&
          row.status === "submitted" &&
          !row.contributors.includes(access.userId),
        canReceive:
          (can("stores.manage") || can("procurement.requisition")) && row.status === "approved",
        canInvoice:
          (can("finance.manage") || can("procurement.manage_suppliers")) &&
          row.status === "approved",
      },
    });
  }
}

/** none: nothing accepted; over: a line above its order; complete: every line reached; else partial. */
export function deliveryStateOf(
  lines: readonly { id: string; baseQuantity: { toFixed(): string } }[],
  received: ReadonlyMap<string, Ratio>,
): LpoDeliveryState {
  let any = false;
  let all = true;
  for (const line of lines) {
    const ordered = Ratio.fromDecimal(line.baseQuantity.toFixed());
    const got = received.get(line.id) ?? Ratio.of(0);
    if (!got.isZero()) any = true;
    const comparison = got.compare(ordered);
    if (comparison > 0) return "over";
    if (comparison < 0) all = false;
  }
  if (!any) return "none";
  return all ? "complete" : "partial";
}
