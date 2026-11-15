import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { invoiceNumberKey, nairobiDate, scaled } from "@pm-buddy/domain";
import {
  SUBCONTRACT_CERTIFY_PERMISSIONS,
  SUBCONTRACT_INVOICE_PERMISSIONS,
  SUBCONTRACT_PAY_PERMISSIONS,
  SUBCONTRACT_PREPARE_PERMISSIONS,
  SUBCONTRACT_RULE_VERSION,
  type ReleaseStage,
  type SubcontractCertificateKind,
  type SubcontractCertificateStatus,
  type SubcontractKind,
  type SubcontractLineBasis,
  type SubcontractPaymentMethod,
  type SubcontractStatus,
  type SubcontractVatTreatment,
} from "@pm-buddy/types";
import {
  subcontractCertificateResponseSchema,
  type MatchSubcontractInvoiceRequest,
  type RecordSubcontractPaymentRequest,
  type SetSubcontractClaimsRequest,
  type SubcontractCertificateDetail,
  type UpdateSubcontractCertificateRequest,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { minorOf, projectRef } from "../finance/spending-common.js";
import { nextId } from "../procurement/catalogue-store.js";
import { requestDigest } from "../procurement/p2p/p2p-common.js";
import { peopleOf, personOf, type People } from "../procurement/procurement-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  clearedColumns,
  computeSubcontractCertificateNow,
  frozenColumns,
  lineRows,
  storedFigures,
  storedLines,
  storedTerms,
  type ComputedCertificate,
} from "./subcontract-calculator.js";
import {
  SubcontractAccess,
  codes,
  invalidTransition,
  itemWire,
  lineInclude,
  linesOf,
  lockItemClaims,
  lockSubcontract,
  makerChecker,
  subcontractConflict,
  supplierRef,
  supplierSelect,
  versionConflict,
  type Tx,
} from "./subcontracts-common.js";

type CertificateRow = Prisma.SubcontractCertificateGetPayload<object>;
type SubcontractRecord = Prisma.SubcontractGetPayload<{
  include: { supplier: { select: typeof supplierSelect } };
}>;

const PROBLEM_TEXT: Record<string, string> = {
  "claim-exceeds-line": "A quantity to date is above the line's quantity",
  "claim-exceeds-measured":
    "A quantity to date is above what was measured and approved on its BQ item",
  "basis-changed": "A BQ item changed basis since it was let; vary the subcontract",
  "certificate-date-invalid": "The date is in the future or before the last certificate",
  "invalid-transition": "Interim certificates are for an active subcontract",
  "no-certified-certificate": "Retention is released only after a certified certificate",
  "nothing-to-release": "No retention is held",
  "release-exceeds-held": "This would release more retention than is held",
};
const problemOf = (computed: ComputedCertificate) => {
  const first = computed.problems[0];
  if (!first) return null;
  const text = PROBLEM_TEXT[first.code] ?? "This certificate cannot be submitted yet";
  return subcontractConflict(
    first.code as "claim-exceeds-line",
    first.ref ? `${text} (${first.ref})` : text,
  );
};

/**
 * Subcontract payment certificates (D6.3 part B; WORKFLOWS "Subcontract certificates";
 * ARCHITECTURE §4.16): a `bq.edit` holder prepares a certificate from the subcontractor's claims
 * against approved D6.3 measurements (decision D-144) and submits it, which freezes its lines and
 * figures (rule KE-SUB-1) with a digest; a `finance.manage` holder who never contributed certifies
 * it with step-up on that digest. Certification posts the work certified to the cost ledger once
 * (database trigger). Payments made outside PM-Buddy are recorded against it (payments.disburse +
 * step-up, never the certifier, never above what is payable) and the subcontractor's tax invoice
 * is matched to it (decision D-145).
 */
@Injectable()
export class SubcontractCertificatesService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: SubcontractAccess,
  ) {}

  create(
    principal: Principal,
    subcontractId: string,
    input: {
      kind: SubcontractCertificateKind;
      releaseStage: ReleaseStage | null;
      valuationDate: string;
      notes?: string | null;
    },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const subcontract = await this.subcontract(scope, subcontractId);
        await this.access.require(scope, subcontract.projectId, SUBCONTRACT_PREPARE_PERMISSIONS, {
          writable: true,
        });
        await lockSubcontract(tx, access.tenantId, subcontractId);
        const status = subcontract.status as SubcontractStatus;
        const open = await tx.subcontractCertificate.findFirst({
          where: {
            tenantId: access.tenantId,
            subcontractId,
            status: { in: ["draft", "submitted"] },
          },
        });
        if (open)
          throw subcontractConflict(
            "certificate-open",
            `${codes.certificate(open.number, false)} is still being prepared`,
          );
        const certified = await tx.subcontractCertificate.findMany({
          where: { tenantId: access.tenantId, subcontractId, status: "certified" },
          orderBy: { certificateNumber: "asc" },
        });
        const last = certified.at(-1);
        if (
          input.valuationDate > nairobiDate() ||
          (last && input.valuationDate < toCalendarDate(last.valuationDate))
        )
          throw subcontractConflict(
            "certificate-date-invalid",
            "A certificate is dated on or after the last one and not in the future",
          );
        if (input.kind === "interim" && status !== "active") throw invalidTransition(status);
        if (input.kind === "retention_release") {
          const stage = input.releaseStage!;
          if (!["active", "completed", "terminated"].includes(status))
            throw invalidTransition(status);
          const completion = await tx.projectCompletion.findFirst({
            where: {
              tenantId: access.tenantId,
              projectId: subcontract.projectId,
              kind: stage,
              status: "certified",
            },
          });
          if (!completion)
            throw subcontractConflict(
              "completion-not-certified",
              `Retention is released after the ${stage} completion is certified`,
            );
          if (input.valuationDate < toCalendarDate(completion.completionDate))
            throw subcontractConflict(
              "certificate-date-invalid",
              "A release is dated on or after the completion",
            );
          if (
            certified.some(
              (row) =>
                row.kind === "retention_release" &&
                (row.releaseStage === stage ||
                  (stage === "practical" && row.releaseStage === "final")),
            )
          )
            throw subcontractConflict("release-exists", "This retention was already released");
          if (!last)
            throw subcontractConflict(
              "no-certified-certificate",
              "Retention is released only after a certified certificate",
            );
          if (minorOf(last.retentionHeldMinor ?? 0n) <= 0)
            throw subcontractConflict("nothing-to-release", "No retention is held");
        }
        const highest = await tx.subcontractCertificate.aggregate({
          where: { tenantId: access.tenantId, subcontractId },
          _max: { number: true },
        });
        const id = nextId();
        const number = (highest._max.number ?? 0) + 1;
        await tx.subcontractCertificate.create({
          data: {
            id,
            tenantId: access.tenantId,
            projectId: subcontract.projectId,
            subcontractId,
            number,
            kind: input.kind,
            releaseStage: input.releaseStage,
            valuationDate: fromCalendarDate(input.valuationDate),
            notes: input.notes ?? null,
            contributors: [access.userId],
            createdBy: access.userId,
            updatedBy: access.userId,
          },
        });
        await this.scope.audit(tx, "subcontract.certificate_created", id, {
          projectId: subcontract.projectId,
          subcontractId,
          number,
          kind: input.kind,
        });
        return this.response(scope, id, false);
      },
      true,
      30_000,
    );
  }

  get(principal: Principal, id: string, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => this.response(scope, id, false),
      false,
      30_000,
    );
  }

  update(
    principal: Principal,
    id: string,
    input: UpdateSubcontractCertificateRequest,
    req: Request,
  ) {
    return this.edit(principal, id, input.version, req, async (scope, row) => {
      if (input.valuationDate !== undefined && input.valuationDate > nairobiDate())
        throw subcontractConflict(
          "certificate-date-invalid",
          "A certificate is not dated in the future",
        );
      await scope.tx.subcontractCertificate.update({
        where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
        data: {
          ...(input.valuationDate ? { valuationDate: fromCalendarDate(input.valuationDate) } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
      });
      await this.scope.audit(scope.tx, "subcontract.certificate_updated", id, {
        projectId: row.projectId,
        fields: Object.keys(input).filter((key) => key !== "version"),
      });
    });
  }

  /** The quantities to date claimed on lines of a draft interim (replaces those given). */
  setClaims(principal: Principal, id: string, input: SetSubcontractClaimsRequest, req: Request) {
    return this.edit(principal, id, input.version, req, async (scope, row) => {
      const { tx, access } = scope;
      if (row.kind !== "interim") throw invalidTransition("a retention release");
      const lines = (await linesOf(tx, access.tenantId, row.subcontractId)).filter(
        (line) => line.inForce,
      );
      for (const claim of input.claims) {
        const line = lines.find((entry) => entry.row.id === claim.lineId);
        if (!line) throw new NotFoundException("Line not found on this subcontract");
        if (scaled(claim.quantityToDate, 4) > scaled(line.quantity, 4))
          throw subcontractConflict(
            "claim-exceeds-line",
            `${PROBLEM_TEXT["claim-exceeds-line"]} (${line.row.bqItem.ref ?? line.row.description})`,
          );
        await tx.subcontractCertificateClaim.upsert({
          where: {
            tenantId_certificateId_lineId: {
              tenantId: access.tenantId,
              certificateId: id,
              lineId: claim.lineId,
            },
          },
          create: {
            tenantId: access.tenantId,
            subcontractId: row.subcontractId,
            certificateId: id,
            lineId: claim.lineId,
            quantityToDate: claim.quantityToDate,
            enteredBy: access.userId,
          },
          update: { quantityToDate: claim.quantityToDate, enteredBy: access.userId },
        });
      }
      await this.scope.audit(tx, "subcontract.certificate_claims_set", id, {
        projectId: row.projectId,
        lines: input.claims.length,
      });
    });
  }

  /** Freezes the lines and figures (next revision) with the digest the certifier will quote. */
  submit(principal: Principal, id: string, version: number, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.row(scope, id);
        await this.access.require(scope, row.projectId, SUBCONTRACT_PREPARE_PERMISSIONS, {
          writable: true,
        });
        await lockSubcontract(tx, access.tenantId, row.subcontractId);
        if (row.status !== "draft") throw invalidTransition(row.status);
        if (row.version !== version) throw versionConflict();
        const subcontract = await this.subcontract(scope, row.subcontractId);
        await this.lockItems(tx, access.tenantId, row.subcontractId);
        const computed = await computeSubcontractCertificateNow(
          tx,
          access.tenantId,
          row,
          subcontract,
        );
        const problem = problemOf(computed);
        if (problem) throw problem;
        const revision = row.revision + 1;
        await tx.subcontractCertificate.update({
          where: { tenantId_id: { tenantId: access.tenantId, id } },
          data: {
            ...frozenColumns(computed),
            status: "submitted",
            revision,
            submittedBy: access.userId,
            submittedAt: new Date(),
            returnReason: null,
            updatedBy: access.userId,
            updatedAt: new Date(),
            version: { increment: 1 },
          },
        });
        await tx.subcontractCertificateLine.createMany({
          data: lineRows(access.tenantId, id, revision, computed),
        });
        await this.scope.audit(tx, "subcontract.certificate_submitted", id, {
          projectId: row.projectId,
          subcontractId: row.subcontractId,
          number: row.number,
          revision,
          lines: computed.lines.length,
        });
        return this.response(scope, id, false);
      },
      true,
      30_000,
    );
  }

  /**
   * Certification: finance.manage + step-up, never a contributor, on the digest the certifier
   * saw; the certificate is recomputed and must still match it (409 certificate-stale).
   */
  certify(
    principal: Principal,
    id: string,
    input: { version: number; digest: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.row(scope, id);
        await this.access.require(scope, row.projectId, SUBCONTRACT_CERTIFY_PERMISSIONS, {
          stepUp: true,
          writable: true,
        });
        await lockSubcontract(tx, access.tenantId, row.subcontractId);
        if (row.status !== "submitted") throw invalidTransition(row.status);
        if (row.version !== input.version) throw versionConflict();
        if (row.contributors.includes(access.userId))
          throw makerChecker("Someone who prepared this certificate cannot certify it");
        const subcontract = await this.subcontract(scope, row.subcontractId);
        await this.lockItems(tx, access.tenantId, row.subcontractId);
        const computed = await computeSubcontractCertificateNow(
          tx,
          access.tenantId,
          row,
          subcontract,
        );
        if (
          row.digest !== input.digest ||
          computed.digest !== row.digest ||
          computed.problems.length
        )
          throw subcontractConflict(
            "certificate-stale",
            "The certificate changed since it was submitted; return it and submit again",
          );
        const highest = await tx.subcontractCertificate.aggregate({
          where: { tenantId: access.tenantId, subcontractId: row.subcontractId },
          _max: { certificateNumber: true },
        });
        const certificateNumber = (highest._max.certificateNumber ?? 0) + 1;
        await tx.subcontractCertificate.update({
          where: { tenantId_id: { tenantId: access.tenantId, id } },
          data: {
            status: "certified",
            certificateNumber,
            certifiedBy: access.userId,
            certifiedAt: new Date(),
            version: { increment: 1 },
          },
        });
        await this.scope.audit(tx, "subcontract.certificate_certified", id, {
          projectId: row.projectId,
          subcontractId: row.subcontractId,
          number: row.number,
          certificateNumber,
          kind: row.kind,
        });
        return this.response(scope, id, false);
      },
      true,
      30_000,
    );
  }

  /** Return (certifier, reason) to draft, or cancel (preparer or certifier, reason). */
  decide(
    principal: Principal,
    id: string,
    action: "return" | "cancel",
    input: { version: number; reason: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.row(scope, id);
        await this.access.require(
          scope,
          row.projectId,
          action === "return"
            ? SUBCONTRACT_CERTIFY_PERMISSIONS
            : [...SUBCONTRACT_PREPARE_PERMISSIONS, ...SUBCONTRACT_CERTIFY_PERMISSIONS],
          { writable: true },
        );
        const allowed: SubcontractCertificateStatus[] =
          action === "return" ? ["submitted"] : ["draft", "submitted"];
        if (!allowed.includes(row.status as SubcontractCertificateStatus))
          throw invalidTransition(row.status);
        if (row.version !== input.version) throw versionConflict();
        await tx.subcontractCertificate.update({
          where: { tenantId_id: { tenantId: access.tenantId, id } },
          data:
            action === "return"
              ? {
                  ...clearedColumns,
                  status: "draft",
                  returnReason: input.reason,
                  version: { increment: 1 },
                }
              : {
                  status: "cancelled",
                  cancelledBy: access.userId,
                  cancelledAt: new Date(),
                  cancelReason: input.reason,
                  version: { increment: 1 },
                },
        });
        await this.scope.audit(
          tx,
          action === "return"
            ? "subcontract.certificate_returned"
            : "subcontract.certificate_cancelled",
          id,
          { projectId: row.projectId, number: row.number, reasonGiven: true },
        );
        return this.response(scope, id, false);
      },
      true,
    );
  }

  /**
   * Records a payment made outside PM-Buddy against a certified certificate (payments.disburse +
   * step-up; never the certifier; never above what is still payable). Idempotent: the same key
   * and payload return the original; a changed payload is 409 idempotency-key-reused.
   */
  pay(
    principal: Principal,
    id: string,
    input: RecordSubcontractPaymentRequest,
    idempotencyKey: string,
    req: Request,
  ) {
    const digest = requestDigest(`subcontract.payment:${id}`, input);
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const replay = await tx.subcontractPayment.findUnique({
          where: { tenantId_idempotencyKey: { tenantId: access.tenantId, idempotencyKey } },
        });
        if (replay) {
          if (replay.certificateId !== id || replay.requestDigest !== digest)
            throw subcontractConflict(
              "idempotency-key-reused",
              "This idempotency key was used for a different payment",
            );
          return this.response(scope, id, true);
        }
        const row = await this.row(scope, id);
        await this.access.require(scope, row.projectId, SUBCONTRACT_PAY_PERMISSIONS, {
          writable: true,
          stepUp: true,
        });
        await lockSubcontract(tx, access.tenantId, row.subcontractId);
        await tx.$queryRaw`SELECT id FROM subcontract_certificates WHERE tenant_id = ${access.tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
        if (row.status !== "certified") throw invalidTransition(row.status);
        if (row.certifiedBy === access.userId)
          throw makerChecker("The person who certified a certificate cannot record its payment");
        const paid = await tx.subcontractPayment.aggregate({
          where: { tenantId: access.tenantId, certificateId: id },
          _sum: { amountMinor: true },
        });
        const outstanding = minorOf(row.payableMinor ?? 0n) - minorOf(paid._sum.amountMinor ?? 0n);
        if (input.amountMinor > outstanding)
          throw subcontractConflict(
            "payment-exceeds-payable",
            "This is more than is still payable on the certificate",
          );
        // A correcting certificate's negative payable nets off what is left to pay on the
        // subcontract, so earlier certificates are never paid in full past it.
        const [payable, paidOnSubcontract] = await Promise.all([
          tx.subcontractCertificate.aggregate({
            where: {
              tenantId: access.tenantId,
              subcontractId: row.subcontractId,
              status: "certified",
            },
            _sum: { payableMinor: true },
          }),
          tx.subcontractPayment.aggregate({
            where: { tenantId: access.tenantId, subcontractId: row.subcontractId },
            _sum: { amountMinor: true },
          }),
        ]);
        if (
          input.amountMinor >
          minorOf(payable._sum.payableMinor ?? 0n) -
            minorOf(paidOnSubcontract._sum.amountMinor ?? 0n)
        )
          throw subcontractConflict(
            "payment-exceeds-payable",
            "This is more than is still payable on the subcontract after its correcting certificates",
          );
        if (input.paidOn > nairobiDate() || input.paidOn < toCalendarDate(row.valuationDate))
          throw subcontractConflict(
            "payment-date-invalid",
            "A payment is dated between the certificate date and today",
          );
        const referenceKey = invoiceNumberKey(input.reference);
        if (
          await tx.subcontractPayment.findUnique({
            where: {
              tenantId_method_referenceKey: {
                tenantId: access.tenantId,
                method: input.method,
                referenceKey,
              },
            },
          })
        )
          throw subcontractConflict(
            "payment-reference-taken",
            "This payment reference is already recorded",
          );
        const paymentId = nextId();
        await tx.subcontractPayment.create({
          data: {
            id: paymentId,
            tenantId: access.tenantId,
            projectId: row.projectId,
            subcontractId: row.subcontractId,
            certificateId: id,
            amountMinor: BigInt(input.amountMinor),
            paidOn: fromCalendarDate(input.paidOn),
            method: input.method,
            reference: input.reference,
            referenceKey,
            idempotencyKey,
            requestDigest: digest,
            recordedBy: access.userId,
          },
        });
        await this.scope.audit(tx, "subcontract.payment_recorded", paymentId, {
          projectId: row.projectId,
          subcontractId: row.subcontractId,
          certificateId: id,
          method: input.method,
        });
        return this.response(scope, id, false);
      },
      true,
    );
  }

  /** Matches the subcontractor's tax invoice to a certified certificate (posts nothing). */
  matchInvoice(
    principal: Principal,
    id: string,
    input: MatchSubcontractInvoiceRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.row(scope, id);
        await this.access.require(scope, row.projectId, SUBCONTRACT_INVOICE_PERMISSIONS, {
          writable: true,
        });
        if (row.status !== "certified") throw invalidTransition(row.status);
        const subcontract = await this.subcontract(scope, row.subcontractId);
        const amountMinor = minorOf(row.amountDueMinor ?? 0n) + minorOf(row.vatMinor ?? 0n);
        if (amountMinor <= 0)
          throw subcontractConflict(
            "invoice-amount-mismatch",
            "Nothing is due on this certificate, so there is nothing to invoice",
          );
        if (
          await tx.subcontractInvoice.findUnique({
            where: { tenantId_certificateId: { tenantId: access.tenantId, certificateId: id } },
          })
        )
          throw subcontractConflict(
            "invoice-exists",
            "An invoice is already matched to this certificate",
          );
        const key = invoiceNumberKey(input.invoiceNumber);
        const taken =
          (await tx.supplierInvoice.count({
            where: {
              tenantId: access.tenantId,
              supplierId: subcontract.supplierId,
              invoiceNumberKey: key,
              status: { not: "cancelled" },
            },
          })) +
          (await tx.subcontractInvoice.count({
            where: {
              tenantId: access.tenantId,
              supplierId: subcontract.supplierId,
              invoiceNumberKey: key,
            },
          }));
        if (taken)
          throw subcontractConflict(
            "invoice-number-taken",
            "This invoice number is already used for this supplier",
          );
        const invoiceId = nextId();
        await tx.subcontractInvoice.create({
          data: {
            id: invoiceId,
            tenantId: access.tenantId,
            subcontractId: row.subcontractId,
            certificateId: id,
            supplierId: subcontract.supplierId,
            invoiceNumber: input.invoiceNumber,
            invoiceNumberKey: key,
            invoiceDate: fromCalendarDate(input.invoiceDate),
            etimsNumber: input.etimsNumber ?? null,
            amountMinor: BigInt(amountMinor),
            recordedBy: access.userId,
          },
        });
        await this.scope.audit(tx, "subcontract.invoice_matched", invoiceId, {
          projectId: row.projectId,
          certificateId: id,
          etims: Boolean(input.etimsNumber),
        });
        return this.response(scope, id, false);
      },
      true,
    );
  }

  // Helpers ------------------------------------------------------------------------------------

  async row(scope: Scope, id: string): Promise<CertificateRow> {
    const row = await scope.tx.subcontractCertificate.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("Certificate not found");
    return row;
  }

  private async subcontract(scope: Scope, id: string): Promise<SubcontractRecord> {
    const row = await scope.tx.subcontract.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
      include: { supplier: { select: supplierSelect } },
    });
    if (!row) throw new NotFoundException("Subcontract not found");
    return row;
  }

  /** The claim locks of every item of the subcontract, in lineage order (as the database). */
  private async lockItems(tx: Tx, tenantId: string, subcontractId: string) {
    const lines = await tx.subcontractLine.findMany({
      where: { tenantId, subcontractId },
      select: { bqItemLineageId: true },
      distinct: ["bqItemLineageId"],
      orderBy: { bqItemLineageId: "asc" },
    });
    for (const line of lines) await lockItemClaims(tx, tenantId, line.bqItemLineageId);
  }

  private edit(
    principal: Principal,
    id: string,
    version: number,
    req: Request,
    work: (scope: Scope, row: CertificateRow) => Promise<void>,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.row(scope, id);
        await this.access.require(scope, row.projectId, SUBCONTRACT_PREPARE_PERMISSIONS, {
          writable: true,
        });
        if (row.status !== "draft") throw invalidTransition(row.status);
        if (row.version !== version) throw versionConflict();
        await work(scope, row);
        await tx.subcontractCertificate.update({
          where: { tenantId_id: { tenantId: access.tenantId, id } },
          data: { updatedBy: access.userId, updatedAt: new Date(), version: { increment: 1 } },
        });
        return this.response(scope, id, false);
      },
      true,
      30_000,
    );
  }

  private async response(scope: Scope, id: string, replayed: boolean) {
    return subcontractCertificateResponseSchema.parse({
      certificate: await this.detailOf(scope, id),
      replayed,
    });
  }

  /** The certificate as seen by a reader: frozen figures once submitted, a preview before. */
  async detailOf(scope: Scope, id: string): Promise<SubcontractCertificateDetail> {
    const { tx, access } = scope;
    const row = await this.row(scope, id);
    const project = await this.access.reader(scope, row.projectId);
    const subcontract = await this.subcontract(scope, row.subcontractId);
    const frozen = row.payableMinor !== null;
    const computed = frozen
      ? null
      : await computeSubcontractCertificateNow(tx, access.tenantId, row, subcontract);
    const [payments, invoice, lineRecords] = await Promise.all([
      tx.subcontractPayment.findMany({
        where: { tenantId: access.tenantId, certificateId: id },
        orderBy: { recordedAt: "asc" },
      }),
      tx.subcontractInvoice.findUnique({
        where: { tenantId_certificateId: { tenantId: access.tenantId, certificateId: id } },
      }),
      tx.subcontractLine.findMany({
        where: { tenantId: access.tenantId, subcontractId: row.subcontractId },
        include: lineInclude,
      }),
    ]);
    const recordOf = new Map(lineRecords.map((line) => [line.id, line]));
    const people: People = await peopleOf(tx, [
      row.createdBy,
      row.submittedBy,
      row.certifiedBy,
      row.cancelledBy,
      ...payments.map((payment) => payment.recordedBy),
      invoice?.recordedBy ?? null,
    ]);
    const figures = computed ? computed.figures : storedFigures(row);
    const terms = computed ? computed.terms : storedTerms(row);
    const lines = computed
      ? computed.lines.map((line) => ({
          lineId: line.line.row.id,
          lineNo: line.line.row.lineNo,
          bqItem: itemWire(line.line.row.bqItem),
          basis: line.line.row.basis as SubcontractLineBasis,
          description: line.line.row.description,
          unit: line.line.row.unit,
          rateMinor: line.line.terms.rateMinor,
          lineQuantity: line.line.quantity,
          lineAmountMinor: line.line.amountMinor,
          vatTreatment: line.line.row.vatTreatment as SubcontractVatTreatment,
          measuredToDate: line.measuredToDate,
          otherClaims: line.otherClaims,
          availableQuantity: line.availableQuantity,
          quantityToDate: line.quantityToDate,
          previousQuantity: line.previousQuantity,
          previousMinor: line.previousMinor,
          valueToDateMinor: line.valueToDateMinor,
          thisPeriodMinor: line.valueToDateMinor - line.previousMinor,
        }))
      : (await storedLines(tx, access.tenantId, id, row.revision)).map((line) => ({
          lineId: line.lineId,
          lineNo: line.lineNo,
          bqItem: itemWire(recordOf.get(line.lineId)!.bqItem),
          basis: line.basis,
          description: line.description,
          unit: line.unit,
          rateMinor: line.rateMinor,
          lineQuantity: line.lineQuantity,
          lineAmountMinor: line.lineAmountMinor,
          vatTreatment: line.vatTreatment,
          measuredToDate: line.measuredToDate,
          otherClaims: "0",
          availableQuantity: line.quantityToDate,
          quantityToDate: line.quantityToDate,
          previousQuantity: line.previousQuantity,
          previousMinor: line.previousMinor,
          valueToDateMinor: line.valueToDateMinor,
          thisPeriodMinor: line.valueToDateMinor - line.previousMinor,
        }));
    const paidMinor = payments.reduce((sum, payment) => sum + minorOf(payment.amountMinor), 0);
    const status = row.status as SubcontractCertificateStatus;
    const prepare = this.access.can(project, SUBCONTRACT_PREPARE_PERMISSIONS);
    const certify = this.access.can(project, SUBCONTRACT_CERTIFY_PERMISSIONS);
    const payableMinor = figures.payableMinor;
    return {
      id: row.id,
      number: row.number,
      code: codes.certificate(row.certificateNumber ?? row.number, row.certificateNumber !== null),
      certificateNumber: row.certificateNumber,
      kind: row.kind as SubcontractCertificateKind,
      releaseStage: (row.releaseStage as ReleaseStage | null) ?? null,
      status,
      valuationDate: toCalendarDate(row.valuationDate),
      workDoneMinor: figures.workDoneMinor,
      amountDueMinor: figures.amountDueMinor,
      payableMinor,
      paidMinor,
      certifiedAt: row.certifiedAt?.toISOString() ?? null,
      project: projectRef(project.project),
      subcontract: {
        id: subcontract.id,
        code: codes.subcontract(subcontract.number),
        title: subcontract.title,
        kind: subcontract.kind as SubcontractKind,
        status: subcontract.status as SubcontractStatus,
        contractVersion: subcontract.contractVersion,
        supplier: supplierRef(subcontract.supplier),
      },
      notes: row.notes,
      revision: row.revision,
      ruleVersion: row.ruleVersion ?? SUBCONTRACT_RULE_VERSION,
      terms: {
        ...terms,
        advanceLimitMinor: minorOf(subcontract.advanceLimitMinor),
        paymentTermsDays: subcontract.paymentTermsDays,
        paymentTermsNote: subcontract.paymentTermsNote,
      },
      originalValueMinor: computed
        ? computed.originalValueMinor
        : minorOf(row.originalValueMinor ?? 0n),
      figures,
      lines,
      digest: row.digest,
      currentDigest: computed?.digest ?? row.digest!,
      problems: computed?.problems ?? [],
      warnings: computed?.warnings ?? [],
      payments: payments.map((payment) => ({
        id: payment.id,
        amountMinor: minorOf(payment.amountMinor),
        paidOn: toCalendarDate(payment.paidOn),
        method: payment.method as SubcontractPaymentMethod,
        reference: payment.reference,
        recordedBy: personOf(people, payment.recordedBy),
        recordedAt: payment.recordedAt.toISOString(),
      })),
      invoice: invoice
        ? {
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            invoiceDate: toCalendarDate(invoice.invoiceDate),
            etimsNumber: invoice.etimsNumber,
            amountMinor: minorOf(invoice.amountMinor),
            recordedBy: personOf(people, invoice.recordedBy),
            recordedAt: invoice.recordedAt.toISOString(),
          }
        : null,
      outstandingMinor: status === "certified" ? payableMinor - paidMinor : 0,
      createdBy: personOf(people, row.createdBy),
      createdAt: row.createdAt.toISOString(),
      submittedBy: row.submittedBy ? personOf(people, row.submittedBy) : null,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      certifiedBy: row.certifiedBy ? personOf(people, row.certifiedBy) : null,
      cancelledBy: row.cancelledBy ? personOf(people, row.cancelledBy) : null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelReason: row.cancelReason,
      returnReason: row.returnReason,
      version: row.version,
      permissions: {
        canEdit: prepare && status === "draft",
        canSubmit: prepare && status === "draft",
        canCertify: certify && status === "submitted" && !row.contributors.includes(access.userId),
        canReturn: certify && status === "submitted",
        canCancel: (prepare || certify) && (status === "draft" || status === "submitted"),
        canPay:
          this.access.can(project, SUBCONTRACT_PAY_PERMISSIONS) &&
          status === "certified" &&
          payableMinor - paidMinor > 0 &&
          row.certifiedBy !== access.userId,
        canMatchInvoice:
          this.access.can(project, SUBCONTRACT_INVOICE_PERMISSIONS) &&
          status === "certified" &&
          invoice === null &&
          figures.amountDueMinor + figures.vatMinor > 0,
        canExport: true,
      },
    };
  }
}
