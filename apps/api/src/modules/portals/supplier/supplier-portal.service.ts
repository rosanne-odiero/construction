import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import {
  addCalendarDays,
  calendarDaysBetween,
  nairobiDate,
  Ratio,
  STATEMENT_INVOICE_STATUSES,
  supplierInvoiceStatus,
  supplierStatement,
  type ThreeWayMatchResult,
} from "@pm-buddy/domain";
import {
  SUPPLIER_PORTAL_LIMITS,
  type EtimsNumberFormat,
  type InvoiceSource,
  type InvoiceStatus,
  type LpoDeliveryState,
  type SettlementMethod,
  type SupplierInvoiceStatus,
  type VatTreatment,
} from "@pm-buddy/types";
import {
  portalDeliveriesResponseSchema,
  portalDocumentResponseSchema,
  portalInvoiceDetailResponseSchema,
  portalInvoicesResponseSchema,
  portalLpoDetailResponseSchema,
  portalLposResponseSchema,
  supplierPortalOverviewResponseSchema,
  supplierStatementResponseSchema,
  type ParsedSupplierInvoiceRequest,
  type PortalInvoice,
  type PortalLpo,
  type SupplierStatementResponse,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../../common/database-errors.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { Scope } from "../../identity/access-policy.js";
import { AuthSecurity } from "../../identity/auth-security.service.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { nextId } from "../../procurement/catalogue-store.js";
import { InvoicesService, type InvoiceRow } from "../../procurement/p2p/invoices.service.js";
import { LposService } from "../../procurement/p2p/lpos.service.js";
import { qtyText, requestDigest, sumQuantities } from "../../procurement/p2p/p2p-common.js";
import {
  P2pDocumentsService,
  type Target,
  type UploadedDocument,
} from "../../procurement/p2p/p2p-documents.service.js";
import { peopleOf, personOf, toCalendarDate } from "../../procurement/procurement-mappers.js";
import {
  SupplierPortalAccess,
  supplierPortalProblem,
  type Binding,
} from "./supplier-portal-access.js";

type LpoRow = Prisma.LpoGetPayload<object>;
type GrnRow = Prisma.GrnGetPayload<{
  include: { lines: { include: { lpoLine: { include: { material: true } } } } };
}>;

const ACCRUED: InvoiceStatus[] = [...STATEMENT_INVOICE_STATUSES];
/** Invoices billed but not yet accepted or refused: they hold quantities until decided. */
const PENDING: InvoiceStatus[] = ["draft", "submitted", "matched", "disputed"];
/** LPOs a supplier sees: approved, or cancelled after approval (an amendment). */
const visibleLpos = (tenantId: string, supplierId: string): Prisma.LpoWhereInput => ({
  tenantId,
  supplierId,
  approvedAt: { not: null },
  status: { in: ["approved", "cancelled"] },
});
/** Invoices a supplier sees: every one except a draft keyed by the company's staff. */
const visibleInvoices = (
  tenantId: string,
  supplierId: string,
): Prisma.SupplierInvoiceWhereInput => ({
  tenantId,
  supplierId,
  OR: [{ status: { not: "draft" } }, { submissions: { some: {} } }],
});
const STATUS_FILTER: Record<SupplierInvoiceStatus, Prisma.SupplierInvoiceWhereInput> = {
  submitted: { status: "submitted" },
  under_review: {
    OR: [{ status: "matched" }, { status: "draft", submissions: { some: {} } }],
  },
  disputed: { status: "disputed" },
  approved: { status: "approved" },
  partly_paid: { status: "partly_settled" },
  paid: { status: "settled" },
  cancelled: { status: "cancelled" },
};

const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);
const projectRef = (row: { id: string; code: string; name: string }) => ({
  id: row.id,
  code: row.code,
  name: row.name,
});
const materialRef = (row: { code: string; name: string; baseUnit: string }) => ({
  code: row.code,
  name: row.name,
  baseUnit: row.baseUnit,
});
const page = <T extends { id: string }>(rows: T[], limit: number) => ({
  items: rows.slice(0, limit),
  page: {
    hasMore: rows.length > limit,
    nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
  },
});

/**
 * The supplier's side of the supplier portal (D7.2, ARCHITECTURE §4.12): only the bound
 * supplier's approved LPOs, deliveries (GRNs without internal notes, photos, people or
 * positions), invoices with the status a supplier needs and the payments the company recorded,
 * and statements. A submitted invoice goes through `InvoicesService` — the same record, submit
 * and three-way match that staff use — and waits in the company's queue; a supplier never
 * approves, settles, reopens or edits it (API and database).
 */
@Injectable()
export class SupplierPortalService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: SupplierPortalAccess,
    private readonly invoices: InvoicesService,
    private readonly lpos: LposService,
    private readonly documents: P2pDocumentsService,
    private readonly security: AuthSecurity,
  ) {}

  overview(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const binding = await this.access.binding(scope);
      const { tx, access } = scope;
      const [company, lpos, acknowledged, deliveries, invoices] = await Promise.all([
        tx.tenant.findUniqueOrThrow({
          where: { id: access.tenantId },
          select: { id: true, name: true },
        }),
        tx.lpo.findMany({
          where: visibleLpos(access.tenantId, binding.supplierId),
          select: {
            id: true,
            status: true,
            project: { select: { id: true, code: true, name: true } },
          },
        }),
        tx.lpoAcknowledgement.findMany({
          where: { tenantId: access.tenantId, supplierId: binding.supplierId },
          select: { lpoId: true },
        }),
        tx.grn.count({
          where: {
            tenantId: access.tenantId,
            status: "recorded",
            lpo: { supplierId: binding.supplierId },
          },
        }),
        tx.supplierInvoice.findMany({
          where: visibleInvoices(access.tenantId, binding.supplierId),
          select: {
            id: true,
            status: true,
            totalMinor: true,
            _count: { select: { submissions: true } },
          },
        }),
      ]);
      const acked = new Set(acknowledged.map((row) => row.lpoId));
      const open = lpos.filter((lpo) => lpo.status === "approved");
      const statuses = invoices.map((row) =>
        supplierInvoiceStatus(
          row.status as InvoiceStatus,
          row._count.submissions ? "supplier_portal" : "company",
        ),
      );
      const accrued = invoices.filter((row) => ACCRUED.includes(row.status as InvoiceStatus));
      const settled = await this.settledByInvoice(
        scope,
        accrued.map((row) => row.id),
      );
      const projects = new Map(lpos.map((lpo) => [lpo.project.id, projectRef(lpo.project)]));
      return supplierPortalOverviewResponseSchema.parse({
        company,
        supplier: binding.supplier,
        displayName: principal.user.displayName,
        projects: [...projects.values()].sort((left, right) => left.code.localeCompare(right.code)),
        counts: {
          openLpos: open.length,
          unacknowledgedLpos: open.filter((lpo) => !acked.has(lpo.id)).length,
          deliveries,
          invoicesUnderReview: statuses.filter(
            (status) => status === "submitted" || status === "under_review",
          ).length,
          invoicesDisputed: statuses.filter((status) => status === "disputed").length,
          invoicesAwaitingPayment: statuses.filter(
            (status) => status === "approved" || status === "partly_paid",
          ).length,
        },
        outstandingMinor: accrued.reduce(
          (sum, row) => sum + Number(row.totalMinor) - (settled.get(row.id) ?? 0),
          0,
        ),
        permissions: { canSubmitInvoices: open.length > 0 },
      });
    });
  }

  // LPOs ------------------------------------------------------------------------------------

  listLpos(
    principal: Principal,
    query: {
      projectId?: string;
      status?: "approved" | "cancelled";
      cursor?: string;
      limit: number;
    },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const binding = await this.access.binding(scope);
      const rows = await scope.tx.lpo.findMany({
        where: {
          ...visibleLpos(scope.access.tenantId, binding.supplierId),
          ...(query.projectId ? { projectId: query.projectId } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        orderBy: { id: "desc" },
        take: query.limit + 1,
      });
      const { items, page: info } = page(rows, query.limit);
      return portalLposResponseSchema.parse({
        lpos: await Promise.all(items.map((row) => this.lpoWire(scope, row))),
        page: info,
      });
    });
  }

  getLpo(principal: Principal, id: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const binding = await this.access.binding(scope);
      return this.lpoDetail(scope, binding, await this.lpoRow(scope, binding, id));
    });
  }

  /** Records the supplier's acknowledgement once (time and user); the LPO itself never changes. */
  acknowledge(principal: Principal, id: string, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const binding = await this.access.binding(scope);
        const { tx, access } = scope;
        const lpo = await this.lpoRow(scope, binding, id);
        if (lpo.status !== "approved")
          throw supplierPortalProblem(
            409,
            "lpo-not-approved",
            "Only an open, approved LPO is acknowledged",
          );
        const existing = await tx.lpoAcknowledgement.count({
          where: { tenantId: access.tenantId, lpoId: id },
        });
        if (existing)
          throw supplierPortalProblem(
            409,
            "lpo-already-acknowledged",
            "This LPO is already acknowledged",
          );
        await tx.lpoAcknowledgement.create({
          data: {
            tenantId: access.tenantId,
            lpoId: id,
            supplierId: binding.supplierId,
            portalUserId: binding.portalUserId,
            acknowledgedBy: access.userId,
          },
        });
        await this.scope.audit(tx, "supplier_portal.lpo_acknowledged", id, {
          projectId: lpo.projectId,
          portalUserId: binding.portalUserId,
        });
        return this.lpoDetail(scope, binding, lpo);
      },
      true,
    );
  }

  private async lpoRow(scope: Scope, binding: Binding, id: string): Promise<LpoRow> {
    const row = await scope.tx.lpo.findFirst({
      where: { ...visibleLpos(scope.access.tenantId, binding.supplierId), id },
    });
    if (!row) throw new NotFoundException("LPO not found");
    return row;
  }

  private async lpoWire(scope: Scope, row: LpoRow): Promise<PortalLpo> {
    const { tx, access } = scope;
    const [project, site, acknowledgement, deliveryState] = await Promise.all([
      tx.project.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: access.tenantId, id: row.projectId } },
        select: { id: true, code: true, name: true },
      }),
      row.deliverySiteId
        ? tx.site.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: row.deliverySiteId } },
            select: { id: true, name: true, address: true },
          })
        : null,
      tx.lpoAcknowledgement.findUnique({
        where: { tenantId_lpoId: { tenantId: access.tenantId, lpoId: row.id } },
      }),
      this.lpos.deliveryState(scope, row),
    ]);
    const people = acknowledgement
      ? await peopleOf(tx, [acknowledgement.acknowledgedBy])
      : new Map<string, string>();
    return {
      id: row.id,
      number: row.number,
      project: projectRef(project),
      deliverySite: site,
      deliveryDate: row.deliveryDate ? toCalendarDate(row.deliveryDate) : null,
      status: row.status as "approved" | "cancelled",
      deliveryState: deliveryState as LpoDeliveryState,
      approvedAt: iso(row.approvedAt!),
      cancelledAt: isoOrNull(row.cancelledAt),
      creditDays: row.creditDays,
      vatRatePercent: row.vatRatePercent.toFixed(),
      subtotalMinor: Number(row.subtotalMinor),
      vatMinor: Number(row.vatMinor),
      totalMinor: Number(row.totalMinor),
      acknowledgement: acknowledgement
        ? {
            acknowledgedAt: iso(acknowledgement.acknowledgedAt),
            acknowledgedBy: personOf(people, acknowledgement.acknowledgedBy),
          }
        : null,
    };
  }

  private async lpoDetail(scope: Scope, binding: Binding, row: LpoRow) {
    const { tx, access } = scope;
    const [lpo, lines, grns, invoiceRows, progress, pendingLines] = await Promise.all([
      this.lpoWire(scope, row),
      tx.lpoLine.findMany({
        where: { tenantId: access.tenantId, lpoId: row.id },
        include: { material: true },
        orderBy: { lineNo: "asc" },
      }),
      tx.grn.findMany({
        where: { tenantId: access.tenantId, lpoId: row.id },
        include: { lines: { include: { lpoLine: { include: { material: true } } } } },
        orderBy: { receivedAt: "asc" },
      }),
      tx.supplierInvoice.findMany({
        where: { ...visibleInvoices(access.tenantId, binding.supplierId), lpoId: row.id },
        orderBy: { id: "asc" },
      }),
      this.lpos.progress(scope, row.id),
      tx.supplierInvoiceLine.findMany({
        where: { tenantId: access.tenantId, lpoId: row.id, invoice: { status: { in: PENDING } } },
        select: { lpoLineId: true, baseQuantity: true },
      }),
    ]);
    const pending = new Map<string, Ratio>();
    for (const line of pendingLines)
      pending.set(
        line.lpoLineId,
        (pending.get(line.lpoLineId) ?? Ratio.of(0)).plus(sumQuantities([line.baseQuantity])),
      );
    const zero = Ratio.of(0);
    const deliveries = await Promise.all(grns.map((grn) => this.deliveryWire(scope, grn, lpo)));
    return portalLpoDetailResponseSchema.parse({
      lpo,
      terms: row.terms,
      lines: lines.map((line) => {
        const received = progress.received.get(line.id) ?? zero;
        const invoiced = progress.billed.get(line.id) ?? zero;
        const held = pending.get(line.id) ?? zero;
        const gap = received.distance(invoiced.plus(held));
        return {
          id: line.id,
          lineNo: line.lineNo,
          material: materialRef(line.material),
          quantity: line.quantity.toFixed(),
          unit: line.unit,
          baseQuantity: line.baseQuantity.toFixed(),
          priceUnit: line.priceUnit,
          unitPriceMinor: Number(line.unitPriceMinor),
          vatTreatment: line.vatTreatment as VatTreatment,
          netUnitPriceBaseMinor: line.netUnitPriceBaseMinor.toFixed(),
          netAmountMinor: Number(line.netAmountMinor),
          receivedBaseQuantity: qtyText(received),
          invoicedBaseQuantity: qtyText(invoiced),
          pendingBaseQuantity: qtyText(held),
          invoiceableBaseQuantity: qtyText(gap.below ? zero : gap.value),
        };
      }),
      deliveries: deliveries.map(({ lines: _lines, ...delivery }) => delivery),
      invoices: await Promise.all(invoiceRows.map((invoice) => this.invoiceWire(scope, invoice))),
      permissions: {
        canAcknowledge: row.status === "approved" && lpo.acknowledgement === null,
        canInvoice: row.status === "approved",
      },
    });
  }

  // Deliveries ------------------------------------------------------------------------------

  listDeliveries(
    principal: Principal,
    query: { projectId?: string; lpoId?: string; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const binding = await this.access.binding(scope);
      const { tx, access } = scope;
      const rows = await tx.grn.findMany({
        where: {
          tenantId: access.tenantId,
          lpo: visibleLpos(access.tenantId, binding.supplierId),
          ...(query.projectId ? { projectId: query.projectId } : {}),
          ...(query.lpoId ? { lpoId: query.lpoId } : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        include: { lines: { include: { lpoLine: { include: { material: true } } } } },
        orderBy: { id: "desc" },
        take: query.limit + 1,
      });
      const { items, page: info } = page(rows, query.limit);
      const lpoRows = await tx.lpo.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: [...new Set(items.map((row) => row.lpoId))] },
        },
      });
      const lpos = new Map(
        await Promise.all(
          lpoRows.map(async (row) => [row.id, await this.lpoWire(scope, row)] as const),
        ),
      );
      return portalDeliveriesResponseSchema.parse({
        deliveries: await Promise.all(
          items.map((grn) => this.deliveryWire(scope, grn, lpos.get(grn.lpoId)!)),
        ),
        page: info,
      });
    });
  }

  /** A GRN as the supplier sees it: counts and rejections, never notes, photos, GPS or names. */
  private async deliveryWire(scope: Scope, grn: GrnRow, lpo: PortalLpo) {
    const site = grn.siteId
      ? await scope.tx.site.findUnique({
          where: { tenantId_id: { tenantId: scope.access.tenantId, id: grn.siteId } },
          select: { id: true, name: true },
        })
      : null;
    return {
      id: grn.id,
      number: grn.number,
      lpo: { id: lpo.id, number: lpo.number },
      project: lpo.project,
      site,
      status: grn.status as "recorded" | "voided",
      receivedAt: iso(grn.receivedAt),
      deliveryNoteNumber: grn.deliveryNoteNumber,
      vehicleRegistration: grn.vehicleRegistration,
      lines: [...grn.lines]
        .sort((left, right) => left.lineNo - right.lineNo)
        .map((line) => ({
          lineNo: line.lineNo,
          lpoLineId: line.lpoLineId,
          material: materialRef(line.lpoLine.material),
          unit: line.unit,
          receivedQuantity: line.receivedQuantity.toFixed(),
          rejectedQuantity: line.rejectedQuantity.toFixed(),
          rejectionReason: line.rejectionReason,
          acceptedBaseQuantity: line.acceptedBaseQuantity.toFixed(),
        })),
    };
  }

  // Invoices --------------------------------------------------------------------------------

  listInvoices(
    principal: Principal,
    query: {
      projectId?: string;
      lpoId?: string;
      status?: SupplierInvoiceStatus;
      cursor?: string;
      limit: number;
    },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const binding = await this.access.binding(scope);
      const { tx, access } = scope;
      const rows = await tx.supplierInvoice.findMany({
        where: {
          AND: [
            visibleInvoices(access.tenantId, binding.supplierId),
            ...(query.status ? [STATUS_FILTER[query.status]] : []),
          ],
          ...(query.projectId ? { projectId: query.projectId } : {}),
          ...(query.lpoId ? { lpoId: query.lpoId } : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        orderBy: { id: "desc" },
        take: query.limit + 1,
      });
      const { items, page: info } = page(rows, query.limit);
      const open = await tx.lpo.count({
        where: { ...visibleLpos(access.tenantId, binding.supplierId), status: "approved" },
      });
      return portalInvoicesResponseSchema.parse({
        invoices: await Promise.all(items.map((row) => this.invoiceWire(scope, row))),
        page: info,
        permissions: { canSubmit: open > 0 },
      });
    });
  }

  getInvoice(principal: Principal, id: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const binding = await this.access.binding(scope);
      return this.invoiceDetail(scope, binding, await this.invoiceRow(scope, binding, id), false);
    });
  }

  /**
   * Submits an invoice against an approved LPO of the supplier's: the same draft → submitted →
   * three-way match the staff use, in one transaction, then the company's review queue. Offline-
   * ready: the client's invoice ID, the Idempotency-Key and the request digest (a replay returns
   * the original; a changed payload is 409 idempotency-key-reused). Rate-limited per user.
   */
  async submitInvoice(
    principal: Principal,
    input: ParsedSupplierInvoiceRequest,
    key: string,
    req: Request,
  ) {
    await this.security.limit(
      `supplier-invoice:${principal.user.id}`,
      SUPPLIER_PORTAL_LIMITS.submissionsPerHour,
      3_600,
    );
    const digest = requestDigest("supplier-portal.invoice", input);
    const replayOf = async (scope: Scope, binding: Binding) => {
      const replay = await scope.tx.supplierInvoiceSubmission.findUnique({
        where: {
          tenantId_idempotencyKey: { tenantId: scope.access.tenantId, idempotencyKey: key },
        },
      });
      if (!replay) return null;
      if (replay.requestDigest !== digest || replay.invoiceId !== input.id)
        throw supplierPortalProblem(
          409,
          "idempotency-key-reused",
          "This idempotency key was used for a different invoice",
        );
      return this.invoiceDetail(
        scope,
        binding,
        await this.invoiceRow(scope, binding, replay.invoiceId),
        true,
      );
    };
    try {
      return await this.scope.run(
        principal,
        req,
        async (scope) => {
          const binding = await this.access.binding(scope);
          const { tx, access } = scope;
          const replay = await replayOf(scope, binding);
          if (replay) return replay;
          if (
            await tx.supplierInvoice.count({ where: { tenantId: access.tenantId, id: input.id } })
          )
            throw supplierPortalProblem(
              409,
              "invoice-id-conflict",
              "An invoice with this ID was already submitted under another key",
            );
          const lpo = await this.lpoRow(scope, binding, input.lpoId);
          if (lpo.status !== "approved")
            throw supplierPortalProblem(
              409,
              "lpo-not-approved",
              "Invoices are submitted against open, approved LPOs",
            );
          if (input.invoiceDate > nairobiDate())
            throw supplierPortalProblem(
              422,
              "invoice-date-invalid",
              "The invoice date cannot be in the future",
            );
          const { id, lpoId: _lpoId, ...fields } = input;
          await this.invoices.record(scope, lpo, fields, id);
          await tx.supplierInvoiceSubmission.create({
            data: {
              id: nextId(),
              tenantId: access.tenantId,
              invoiceId: id,
              supplierId: binding.supplierId,
              portalUserId: binding.portalUserId,
              submittedBy: access.userId,
              idempotencyKey: key,
              requestDigest: digest,
            },
          });
          await this.invoices.submitRow(scope, await this.invoices.row(scope, id));
          await this.scope.audit(tx, "supplier_portal.invoice_submitted", id, {
            projectId: lpo.projectId,
            lpoId: lpo.id,
            portalUserId: binding.portalUserId,
            etims: input.etimsInvoiceNumber.format,
          });
          return this.invoiceDetail(scope, binding, await this.invoices.row(scope, id), false);
        },
        true,
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent replay won the race: answer with what it stored (or say what clashed).
      const replay = await this.scope.run(principal, req, async (scope) =>
        replayOf(scope, await this.access.binding(scope)),
      );
      if (replay) return replay;
      throw supplierPortalProblem(
        409,
        "invoice-id-conflict",
        "This invoice number or ID was submitted at the same time; reload and check your invoices",
      );
    }
  }

  /** Attaches the invoice document (PDF or photo) to the supplier's own submitted invoice. */
  async uploadDocument(
    principal: Principal,
    invoiceId: string,
    file: UploadedDocument | undefined,
    req: Request,
  ) {
    const result = await this.documents.upload(
      principal,
      { kind: "invoice", invoiceId },
      file,
      req,
      async (scope: Scope, target: Target) => {
        const binding = await this.access.binding(scope);
        if (target.kind !== "invoice") throw new NotFoundException("Invoice not found");
        const invoice = await this.invoiceRow(scope, binding, target.invoiceId);
        if (
          !(await this.invoices.fromPortal(scope, invoice.id)) ||
          ["cancelled", "settled"].includes(invoice.status)
        )
          throw supplierPortalProblem(
            409,
            "invoice-not-attachable",
            "Documents are attached to your own open invoices",
          );
        const mine = await scope.tx.procurementDocument.count({
          where: {
            tenantId: scope.access.tenantId,
            invoiceId: invoice.id,
            uploadedBy: scope.access.userId,
          },
        });
        if (mine >= SUPPLIER_PORTAL_LIMITS.documentsPerInvoice)
          throw supplierPortalProblem(
            409,
            "too-many-documents",
            `An invoice keeps at most ${SUPPLIER_PORTAL_LIMITS.documentsPerInvoice} documents from the supplier`,
          );
        return invoice.projectId;
      },
    );
    const document = result.document;
    return portalDocumentResponseSchema.parse({
      document: {
        id: document.id,
        contentType: document.contentType,
        sizeBytes: document.sizeBytes,
        scanStatus: document.scanStatus,
        uploadedAt: document.uploadedAt,
        uploadedBySupplier: true,
      },
    });
  }

  /** A document kept with one of the supplier's own invoices (never GRN photos or quotations). */
  async downloadDocument(principal: Principal, id: string, req: Request) {
    const row = await this.scope.run(principal, req, async (scope) => {
      const binding = await this.access.binding(scope);
      const document = await scope.tx.procurementDocument.findFirst({
        where: {
          tenantId: scope.access.tenantId,
          id,
          kind: "invoice",
          invoice: visibleInvoices(scope.access.tenantId, binding.supplierId),
        },
      });
      if (!document) throw new NotFoundException("Document not found");
      return document;
    });
    return this.documents.content(row);
  }

  private async invoiceRow(scope: Scope, binding: Binding, id: string): Promise<InvoiceRow> {
    const row = await scope.tx.supplierInvoice.findFirst({
      where: { ...visibleInvoices(scope.access.tenantId, binding.supplierId), id },
    });
    if (!row) throw new NotFoundException("Invoice not found");
    return row;
  }

  private async settledByInvoice(scope: Scope, invoiceIds: string[]) {
    if (!invoiceIds.length) return new Map<string, number>();
    const rows = await scope.tx.invoiceSettlement.groupBy({
      by: ["invoiceId"],
      where: { tenantId: scope.access.tenantId, invoiceId: { in: invoiceIds } },
      _sum: { amountMinor: true },
    });
    return new Map(rows.map((row) => [row.invoiceId, Number(row._sum.amountMinor ?? 0n)]));
  }

  private async invoiceWire(scope: Scope, row: InvoiceRow): Promise<PortalInvoice> {
    const { tx, access } = scope;
    const [project, lpo, portal, settled] = await Promise.all([
      tx.project.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: access.tenantId, id: row.projectId } },
        select: { id: true, code: true, name: true },
      }),
      tx.lpo.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: access.tenantId, id: row.lpoId } },
        select: { id: true, number: true },
      }),
      this.invoices.fromPortal(scope, row.id),
      this.invoices.settledMinor(scope, row.id),
    ]);
    const source: InvoiceSource = portal ? "supplier_portal" : "company";
    const status = supplierInvoiceStatus(row.status as InvoiceStatus, source)!;
    const accrued = ACCRUED.includes(row.status as InvoiceStatus);
    const outstanding = accrued ? Number(row.totalMinor) - settled : 0;
    const dueDate = toCalendarDate(row.dueDate);
    return {
      id: row.id,
      invoiceNumber: row.invoiceNumber,
      invoiceDate: toCalendarDate(row.invoiceDate),
      dueDate,
      lpo,
      project: projectRef(project),
      etimsInvoiceNumber: row.etimsInvoiceNumber,
      etimsFormat: row.etimsFormat as EtimsNumberFormat | null,
      status,
      source,
      subtotalMinor: Number(row.subtotalMinor),
      vatMinor: Number(row.vatMinor),
      totalMinor: Number(row.totalMinor),
      paidMinor: settled,
      outstandingMinor: outstanding,
      overdue: outstanding > 0 && dueDate < nairobiDate(),
      submittedAt: isoOrNull(row.submittedAt),
    };
  }

  private async invoiceDetail(scope: Scope, binding: Binding, row: InvoiceRow, replayed: boolean) {
    const { tx, access } = scope;
    const [invoice, lines, match, settlements, documents, portalUsers] = await Promise.all([
      this.invoiceWire(scope, row),
      tx.supplierInvoiceLine.findMany({
        where: { tenantId: access.tenantId, invoiceId: row.id },
        include: { lpoLine: { include: { material: true } } },
        orderBy: { lineNo: "asc" },
      }),
      this.invoices.latestMatch(scope, row.id),
      tx.invoiceSettlement.findMany({
        where: { tenantId: access.tenantId, invoiceId: row.id },
        orderBy: [{ paidOn: "asc" }, { recordedAt: "asc" }],
      }),
      tx.procurementDocument.findMany({
        where: { tenantId: access.tenantId, invoiceId: row.id, kind: "invoice" },
        orderBy: { uploadedAt: "asc" },
      }),
      tx.supplierPortalUser.findMany({
        where: { tenantId: access.tenantId, supplierId: binding.supplierId, userId: { not: null } },
        select: { userId: true },
      }),
    ]);
    const supplierUsers = new Set(portalUsers.map((user) => user.userId));
    const evidence = match ? (match.evidence as unknown as ThreeWayMatchResult) : null;
    const mine = documents.filter((document) => document.uploadedBy === access.userId).length;
    return portalInvoiceDetailResponseSchema.parse({
      invoice,
      lines: lines.map((line) => ({
        lineNo: line.lineNo,
        lpoLineId: line.lpoLineId,
        material: materialRef(line.lpoLine.material),
        quantity: line.quantity.toFixed(),
        unit: line.unit,
        unitPriceMinor: Number(line.unitPriceMinor),
        vatTreatment: line.vatTreatment as VatTreatment,
        netAmountMinor: Number(line.netAmountMinor),
      })),
      dispute:
        invoice.status === "disputed" && evidence
          ? {
              reasons: evidence.reasons,
              lines: evidence.lines
                .filter((line) => line.reasons.length > 0)
                .map((line) => ({ lineNo: line.lineNo, reasons: line.reasons })),
            }
          : null,
      payments: settlements.map((settlement) => ({
        id: settlement.id,
        amountMinor: Number(settlement.amountMinor),
        paidOn: toCalendarDate(settlement.paidOn),
        method: settlement.method as SettlementMethod,
        reference: settlement.externalReference,
      })),
      documents: documents.map((document) => ({
        id: document.id,
        contentType: document.contentType,
        sizeBytes: document.sizeBytes,
        scanStatus: document.scanStatus,
        uploadedAt: iso(document.uploadedAt),
        uploadedBySupplier: supplierUsers.has(document.uploadedBy),
      })),
      replayed,
      permissions: {
        canAttach:
          invoice.source === "supplier_portal" &&
          !["cancelled", "paid"].includes(invoice.status) &&
          mine < SUPPLIER_PORTAL_LIMITS.documentsPerInvoice,
      },
    });
  }

  // Statement -------------------------------------------------------------------------------

  statement(
    principal: Principal,
    query: { projectId?: string; from?: string; to?: string },
    req: Request,
  ) {
    return this.scope.run(principal, req, (scope) => this.statementOf(scope, query));
  }

  /**
   * The statement (rule D-105): accepted invoices (approved, partly paid or paid; by invoice
   * date) less the payments the company recorded (by paid date), for one project or the whole
   * company, with the opening balance before `from`. Defaults to the last 90 days.
   */
  async statementOf(
    scope: Scope,
    query: { projectId?: string; from?: string; to?: string },
  ): Promise<SupplierStatementResponse> {
    const binding = await this.access.binding(scope);
    const { tx, access } = scope;
    const today = nairobiDate();
    const to = query.to ?? (query.from && query.from > today ? query.from : today);
    const from =
      query.from ?? addCalendarDays(to, -(SUPPLIER_PORTAL_LIMITS.statementDefaultDays - 1));
    if (from > to || calendarDaysBetween(from, to) + 1 > SUPPLIER_PORTAL_LIMITS.statementMaxDays)
      throw supplierPortalProblem(
        422,
        "statement-period-invalid",
        `A statement runs from a date to the same or a later one, at most ${SUPPLIER_PORTAL_LIMITS.statementMaxDays} days`,
      );
    let project: { id: string; code: string; name: string } | null = null;
    if (query.projectId) {
      const lpo = await tx.lpo.findFirst({
        where: { ...visibleLpos(access.tenantId, binding.supplierId), projectId: query.projectId },
        select: { project: { select: { id: true, code: true, name: true } } },
      });
      if (!lpo) throw new NotFoundException("Project not found");
      project = projectRef(lpo.project);
    }
    const scoped = query.projectId ? { projectId: query.projectId } : {};
    const [company, rows] = await Promise.all([
      tx.tenant.findUniqueOrThrow({
        where: { id: access.tenantId },
        select: { id: true, name: true },
      }),
      tx.supplierInvoice.findMany({
        where: { ...visibleInvoices(access.tenantId, binding.supplierId), ...scoped },
        include: {
          project: { select: { id: true, code: true, name: true } },
          _count: { select: { submissions: true } },
        },
        orderBy: [{ invoiceDate: "asc" }, { id: "asc" }],
      }),
    ]);
    const accepted = rows.filter((row) => ACCRUED.includes(row.status as InvoiceStatus));
    const payments = accepted.length
      ? await tx.invoiceSettlement.findMany({
          where: { tenantId: access.tenantId, invoiceId: { in: accepted.map((row) => row.id) } },
          orderBy: [{ paidOn: "asc" }, { recordedAt: "asc" }],
        })
      : [];
    const numbers = new Map(accepted.map((row) => [row.id, row.invoiceNumber]));
    const result = supplierStatement({
      from,
      to,
      invoices: accepted.map((row) => ({
        id: row.id,
        invoiceNumber: row.invoiceNumber,
        date: toCalendarDate(row.invoiceDate),
        totalMinor: Number(row.totalMinor),
      })),
      payments: payments.map((payment) => ({
        id: payment.id,
        invoiceId: payment.invoiceId,
        invoiceNumber: numbers.get(payment.invoiceId)!,
        date: toCalendarDate(payment.paidOn),
        amountMinor: Number(payment.amountMinor),
        method: payment.method as SettlementMethod,
        reference: payment.externalReference,
      })),
    });
    const paidBy = new Map<string, number>();
    for (const payment of payments)
      paidBy.set(
        payment.invoiceId,
        (paidBy.get(payment.invoiceId) ?? 0) + Number(payment.amountMinor),
      );
    return supplierStatementResponseSchema.parse({
      company,
      supplier: binding.supplier,
      project,
      from,
      to,
      generatedAt: new Date().toISOString(),
      openingMinor: result.openingMinor,
      invoicedMinor: result.invoicedMinor,
      paidMinor: result.paidMinor,
      closingMinor: result.closingMinor,
      entries: result.entries.map(({ id: _id, ...entry }) => entry),
      outstanding: accepted
        .map((row) => {
          const paid = paidBy.get(row.id) ?? 0;
          const dueDate = toCalendarDate(row.dueDate);
          const outstanding = Number(row.totalMinor) - paid;
          return {
            invoiceId: row.id,
            invoiceNumber: row.invoiceNumber,
            project: projectRef(row.project),
            invoiceDate: toCalendarDate(row.invoiceDate),
            dueDate,
            totalMinor: Number(row.totalMinor),
            paidMinor: paid,
            outstandingMinor: outstanding,
            overdue: outstanding > 0 && dueDate < today,
          };
        })
        .filter((row) => row.outstandingMinor > 0),
      notAccepted: rows
        .filter(
          (row) => !ACCRUED.includes(row.status as InvoiceStatus) && row.status !== "cancelled",
        )
        .map((row) => ({
          invoiceId: row.id,
          invoiceNumber: row.invoiceNumber,
          invoiceDate: toCalendarDate(row.invoiceDate),
          totalMinor: Number(row.totalMinor),
          status: supplierInvoiceStatus(
            row.status as InvoiceStatus,
            row._count.submissions ? "supplier_portal" : "company",
          )!,
        })),
    });
  }
}
