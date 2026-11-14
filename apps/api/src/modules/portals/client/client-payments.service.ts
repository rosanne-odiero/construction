import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { nairobiDate, receiptFits } from "@pm-buddy/domain";
import {
  CLIENT_PAYMENT_READ_PERMISSIONS,
  CLIENT_PAYMENT_RECORD_PERMISSIONS,
  CLIENT_PORTAL_LIMITS,
  CLIENT_SETTINGS_PERMISSIONS,
} from "@pm-buddy/types";
import {
  clientPaymentsResponseSchema,
  type ClientPaymentsResponse,
  type RecordClientPaymentRequest,
  type ReverseClientPaymentRequest,
  type UpdateClientSettingsRequest,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../../common/database-errors.js";
import { loadClientLedger } from "../../finance/client-ledger.js";
import type { Scope } from "../../identity/access-policy.js";
import { AuthSecurity } from "../../identity/auth-security.service.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { requestDigest } from "../../procurement/p2p/p2p-common.js";
import { peopleOf, personOf } from "../../procurement/procurement-mappers.js";
import { certificateWire, receiptWire } from "./client-portal.service.js";
import { clientPortalProblem, staffProject } from "./client-portal-access.js";
import { clientProjectRef } from "./client-display.js";

/**
 * Client receipts and the project's client terms (D7.1, WORKFLOWS "Client receipts", rule
 * D-133): finance (`finance.manage`) records money received from the client against a certified
 * certificate — amount, date, method, reference — append-only and offline-ready (client ID +
 * Idempotency-Key + request digest), never more than is outstanding; a wrong receipt is reversed
 * in full by a new entry with a reason (shown to the client). The project manager
 * (`projects.manage`) sets whether variations wait for the client and the payment period.
 */
@Injectable()
export class ClientPaymentsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly security: AuthSecurity,
  ) {}

  view(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, (scope) => this.viewOf(scope, projectId));
  }

  async record(
    principal: Principal,
    projectId: string,
    input: RecordClientPaymentRequest & { note?: string },
    key: string,
    req: Request,
  ) {
    const digest = requestDigest("client-payment.receipt", { projectId, ...input });
    const clash = () =>
      clientPortalProblem(
        409,
        "payment-id-conflict",
        "This receipt clashed with one recorded at the same time; reload and check",
      );
    return this.idempotent(principal, req, key, digest, input.id, clash, async (scope) => {
      const { tx, access } = scope;
      const { readOnly } = await this.recorder(scope, projectId);
      if (readOnly)
        throw clientPortalProblem(409, "project-read-only", "Closed projects are read-only");
      if (input.receivedOn > nairobiDate())
        throw clientPortalProblem(
          422,
          "receipt-date-invalid",
          "Money is recorded as received today or earlier",
        );
      const valuation = await tx.valuation.findFirst({
        where: { tenantId: access.tenantId, projectId, id: input.valuationId },
        select: { id: true, status: true },
      });
      if (!valuation) throw new NotFoundException("Certificate not found");
      if (valuation.status !== "certified")
        throw clientPortalProblem(
          409,
          "certificate-not-certified",
          "Receipts are recorded against certified certificates",
        );
      // One receipt per certificate at a time (the database repeats it under the same lock).
      await tx.$queryRaw`SELECT id FROM valuations WHERE tenant_id = ${access.tenantId}::uuid
        AND id = ${valuation.id}::uuid FOR UPDATE`;
      const project = await tx.project.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: access.tenantId, id: projectId } },
        select: { code: true },
      });
      const ledger = await loadClientLedger(tx, access.tenantId, projectId, project.code);
      const certificate = ledger.certificates.find((row) => row.id === valuation.id)!;
      if (!receiptFits(input.amountMinor, certificate.outstandingMinor))
        throw clientPortalProblem(
          409,
          "receipt-exceeds-outstanding",
          "A receipt is no more than is outstanding on the certificate; record the rest against the next one",
        );
      if (
        ledger.payments.filter((row) => row.certificateId === valuation.id).length >=
        CLIENT_PORTAL_LIMITS.paymentsPerCertificate
      )
        throw clientPortalProblem(
          409,
          "too-many-client-payments",
          "This certificate has too many payment entries",
        );
      await tx.clientPayment.create({
        data: {
          id: input.id,
          tenantId: access.tenantId,
          projectId,
          valuationId: valuation.id,
          kind: "receipt",
          amountMinor: BigInt(input.amountMinor),
          receivedOn: new Date(`${input.receivedOn}T00:00:00.000Z`),
          method: input.method,
          reference: input.reference,
          note: input.note?.trim() ? input.note.trim() : null,
          idempotencyKey: key,
          requestDigest: digest,
          recordedBy: access.userId,
        },
      });
      // Identifiers and codes only (no amounts, references or notes) in the audit log.
      await this.scope.audit(tx, "client_payment.recorded", input.id, {
        projectId,
        valuationId: valuation.id,
        method: input.method,
      });
      return this.viewOf(scope, projectId);
    });
  }

  async reverse(
    principal: Principal,
    projectId: string,
    paymentId: string,
    input: ReverseClientPaymentRequest,
    key: string,
    req: Request,
  ) {
    const digest = requestDigest("client-payment.reversal", { projectId, paymentId, ...input });
    const clash = () =>
      clientPortalProblem(409, "receipt-already-reversed", "This receipt was already reversed");
    return this.idempotent(principal, req, key, digest, input.id, clash, async (scope) => {
      const { tx, access } = scope;
      const { readOnly } = await this.recorder(scope, projectId);
      if (readOnly)
        throw clientPortalProblem(409, "project-read-only", "Closed projects are read-only");
      const original = await tx.clientPayment.findFirst({
        where: { tenantId: access.tenantId, projectId, id: paymentId },
      });
      if (!original) throw new NotFoundException("Receipt not found");
      if (original.kind !== "receipt")
        throw clientPortalProblem(409, "receipt-not-reversible", "Only a receipt is reversed");
      await tx.$queryRaw`SELECT id FROM valuations WHERE tenant_id = ${access.tenantId}::uuid
        AND id = ${original.valuationId}::uuid FOR UPDATE`;
      if (
        await tx.clientPayment.count({
          where: { tenantId: access.tenantId, reversesId: original.id },
        })
      )
        throw clientPortalProblem(
          409,
          "receipt-already-reversed",
          "This receipt was already reversed",
        );
      const today = nairobiDate();
      await tx.clientPayment.create({
        data: {
          id: input.id,
          tenantId: access.tenantId,
          projectId,
          valuationId: original.valuationId,
          kind: "reversal",
          reversesId: original.id,
          amountMinor: original.amountMinor,
          receivedOn: new Date(`${today}T00:00:00.000Z`),
          reason: input.reason.trim(),
          idempotencyKey: key,
          requestDigest: digest,
          recordedBy: access.userId,
        },
      });
      await this.scope.audit(tx, "client_payment.reversed", input.id, {
        projectId,
        valuationId: original.valuationId,
        reversesId: original.id,
        reasonGiven: true,
      });
      return this.viewOf(scope, projectId);
    });
  }

  updateSettings(
    principal: Principal,
    projectId: string,
    input: UpdateClientSettingsRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const { readOnly } = await staffProject(scope, projectId, CLIENT_SETTINGS_PERMISSIONS);
        if (readOnly)
          throw clientPortalProblem(409, "project-read-only", "Closed projects are read-only");
        await tx.$queryRaw`SELECT id FROM projects WHERE tenant_id = ${access.tenantId}::uuid
          AND id = ${projectId}::uuid FOR UPDATE`;
        const latest = await tx.projectClientSettings.findFirst({
          where: { tenantId: access.tenantId, projectId },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        if ((latest?.version ?? 0) !== input.version)
          throw clientPortalProblem(
            409,
            "version-conflict",
            "These terms were changed by someone else. Reload and try again.",
          );
        await tx.projectClientSettings.create({
          data: {
            tenantId: access.tenantId,
            projectId,
            version: input.version + 1,
            clientApprovalRequired: input.clientApprovalRequired,
            paymentTermsDays: input.paymentTermsDays,
            createdBy: access.userId,
          },
        });
        await this.scope.audit(tx, "client_portal.terms_changed", projectId, {
          version: input.version + 1,
          clientApprovalRequired: input.clientApprovalRequired,
          paymentTermsDays: input.paymentTermsDays,
        });
        return this.viewOf(scope, projectId);
      },
      true,
    );
  }

  // Helpers -------------------------------------------------------------------------------------

  private async recorder(scope: Scope, projectId: string) {
    const found = await staffProject(scope, projectId, CLIENT_PAYMENT_READ_PERMISSIONS);
    if (!CLIENT_PAYMENT_RECORD_PERMISSIONS.some((permission) => found.effective.has(permission)))
      throw new ForbiddenException("Permission required: finance.manage");
    return found;
  }

  /**
   * Runs a receipt or reversal once per Idempotency-Key: a replay with the same payload returns the
   * current view; another payload under the key is 409 idempotency-key-reused; a different key
   * for an existing entry ID is 409 payment-id-conflict.
   */
  private async idempotent(
    principal: Principal,
    req: Request,
    key: string,
    digest: string,
    id: string,
    clash: () => Error,
    work: (scope: Scope) => Promise<ClientPaymentsResponse>,
  ): Promise<ClientPaymentsResponse> {
    await this.security.limit(`client-payment:${principal.user.id}`, 120, 3_600);
    const replay = async (scope: Scope) => {
      const stored = await scope.tx.clientPayment.findUnique({
        where: {
          tenantId_idempotencyKey: { tenantId: scope.access.tenantId, idempotencyKey: key },
        },
      });
      if (!stored) {
        if (await scope.tx.clientPayment.count({ where: { tenantId: scope.access.tenantId, id } }))
          throw clientPortalProblem(
            409,
            "payment-id-conflict",
            "An entry with this ID was recorded under another key",
          );
        return null;
      }
      if (stored.requestDigest !== digest || stored.id !== id)
        throw clientPortalProblem(
          409,
          "idempotency-key-reused",
          "This idempotency key was used for a different entry",
        );
      await this.recorder(scope, stored.projectId);
      return this.viewOf(scope, stored.projectId);
    };
    try {
      return await this.scope.run(
        principal,
        req,
        async (scope) => (await replay(scope)) ?? work(scope),
        true,
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent replay won the race: answer with what it stored (or say what clashed).
      const answer = await this.scope.run(principal, req, replay);
      if (answer) return answer;
      throw clash();
    }
  }

  private async viewOf(scope: Scope, projectId: string): Promise<ClientPaymentsResponse> {
    const { tx, access } = scope;
    const { project, effective, readOnly } = await staffProject(
      scope,
      projectId,
      CLIENT_PAYMENT_READ_PERMISSIONS,
    );
    const ledger = await loadClientLedger(tx, access.tenantId, projectId, project.code);
    const [people, clientMembers] = await Promise.all([
      peopleOf(tx, [...ledger.payments.map((row) => row.recordedBy), ledger.terms.createdBy]),
      tx.projectMembership.count({
        where: { tenantId: access.tenantId, projectId, permissions: { has: "portal.client" } },
      }),
    ]);
    return clientPaymentsResponseSchema.parse({
      project: clientProjectRef(project),
      clientName: project.clientName,
      today: ledger.today,
      certificates: ledger.certificates.map(certificateWire),
      payments: ledger.payments.map((row) => ({
        ...receiptWire(row),
        note: row.note,
        recordedBy: personOf(people, row.recordedBy),
        reversedBy: row.reversedBy,
      })),
      entries: ledger.statement.entries,
      totals: {
        certifiedMinor: ledger.statement.certifiedMinor,
        receivedMinor: ledger.statement.receivedMinor,
        outstandingMinor: ledger.statement.outstandingMinor,
        overdueMinor: ledger.statement.overdueMinor,
      },
      settings: {
        version: ledger.terms.version,
        clientApprovalRequired: ledger.terms.clientApprovalRequired,
        paymentTermsDays: ledger.terms.paymentTermsDays,
        updatedBy: ledger.terms.createdBy ? personOf(people, ledger.terms.createdBy) : null,
        updatedAt: ledger.terms.createdAt?.toISOString() ?? null,
      },
      clientMembers,
      readOnly,
      permissions: {
        canRecord:
          !readOnly &&
          CLIENT_PAYMENT_RECORD_PERMISSIONS.some((permission) => effective.has(permission)),
        canManageSettings:
          !readOnly && CLIENT_SETTINGS_PERMISSIONS.some((permission) => effective.has(permission)),
      },
    });
  }
}
