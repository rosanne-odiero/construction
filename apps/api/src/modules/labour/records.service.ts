import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { nairobiDate } from "@pm-buddy/domain";
import { CURRENT_CONSENT_NOTICE } from "@pm-buddy/types";
import { accreditationAlertsResponseSchema, type AccreditationAlert } from "@pm-buddy/validation";
import type { z } from "zod";
import type {
  accreditationAlertsQuerySchema,
  createAccreditationRequestSchema,
  recordConsentRequestSchema,
  updateAccreditationRequestSchema,
  withdrawConsentRequestSchema,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import { accreditationSummary, loadLabourers } from "./labour-mappers.js";
import {
  inProjects,
  LabourAccess,
  labourBadRequest,
  labourConflict,
  rethrowLabourDbError,
  versionConflict,
} from "./labour-support.js";
import { LabourerReader } from "./labourer-reader.js";

type CreateAccreditation = z.output<typeof createAccreditationRequestSchema>;
type UpdateAccreditation = z.output<typeof updateAccreditationRequestSchema>;
type RecordConsent = z.output<typeof recordConsentRequestSchema>;
type WithdrawConsent = z.output<typeof withdrawConsentRequestSchema>;
type AlertsQuery = z.output<typeof accreditationAlertsQuerySchema>;

/**
 * NCA accreditation cards with expiry alerts, and consent records (recording a newer notice
 * version, withdrawal) for registered labourers (D3.1).
 */
@Injectable()
export class LabourRecordsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: LabourAccess,
    private readonly reader: LabourerReader,
  ) {}

  addAccreditation(
    principal: Principal,
    labourerId: string,
    input: CreateAccreditation,
    req: Request,
  ) {
    return this.mutate(principal, req, async (scope) => {
      const { effective } = await this.access.labourer(scope, labourerId);
      this.access.demand(scope, effective, "labour.manage");
      const row = await scope.tx.labourerAccreditation.create({
        data: {
          tenantId: scope.access.tenantId,
          labourerId,
          category: input.category,
          cardNumber: input.cardNumber,
          issuedOn: input.issuedOn ? fromCalendarDate(input.issuedOn) : null,
          expiresOn: fromCalendarDate(input.expiresOn),
          createdBy: scope.access.userId,
        },
      });
      await this.scope.audit(scope.tx, "labourer.accreditation_added", labourerId, {
        accreditationId: row.id,
        category: row.category,
        expiresOn: input.expiresOn,
      });
      return this.reader.detail(scope, labourerId);
    });
  }

  updateAccreditation(
    principal: Principal,
    labourerId: string,
    accreditationId: string,
    input: UpdateAccreditation,
    req: Request,
  ) {
    return this.mutate(principal, req, async (scope) => {
      const { tx, access } = scope;
      const { effective } = await this.access.labourer(scope, labourerId);
      this.access.demand(scope, effective, "labour.manage");
      const card = await tx.labourerAccreditation.findFirst({
        where: { tenantId: access.tenantId, id: accreditationId, labourerId },
      });
      if (!card) throw new NotFoundException("Accreditation not found");
      const { version, ...fields } = input;
      const issuedOn =
        fields.issuedOn === undefined
          ? card.issuedOn
          : fields.issuedOn && fromCalendarDate(fields.issuedOn);
      const expiresOn = fields.expiresOn ? fromCalendarDate(fields.expiresOn) : card.expiresOn;
      if (issuedOn && expiresOn < issuedOn)
        throw labourBadRequest("end-before-start", "The expiry date is before the issue date.");
      const updated = await tx.labourerAccreditation.updateMany({
        where: { tenantId: access.tenantId, id: accreditationId, version },
        data: {
          ...(fields.category ? { category: fields.category } : {}),
          ...(fields.cardNumber ? { cardNumber: fields.cardNumber } : {}),
          issuedOn,
          expiresOn,
          version: { increment: 1 },
        },
      });
      if (!updated.count) throw versionConflict();
      await this.scope.audit(tx, "labourer.accreditation_updated", labourerId, {
        accreditationId,
        fields: Object.keys(fields)
          .filter((key) => fields[key as keyof typeof fields] !== undefined)
          .sort(),
      });
      return this.reader.detail(scope, labourerId);
    });
  }

  removeAccreditation(
    principal: Principal,
    labourerId: string,
    accreditationId: string,
    req: Request,
  ) {
    return this.mutate(principal, req, async (scope) => {
      const { tx, access } = scope;
      const { effective } = await this.access.labourer(scope, labourerId);
      this.access.demand(scope, effective, "labour.manage");
      const removed = await tx.labourerAccreditation.deleteMany({
        where: { tenantId: access.tenantId, id: accreditationId, labourerId },
      });
      if (!removed.count) throw new NotFoundException("Accreditation not found");
      await this.scope.audit(tx, "labourer.accreditation_removed", labourerId, {
        accreditationId,
      });
      return this.reader.detail(scope, labourerId);
    });
  }

  /** Records consent to the current notice (re-consent after a new version, or after withdrawal). */
  recordConsent(principal: Principal, labourerId: string, input: RecordConsent, req: Request) {
    return this.mutate(principal, req, async (scope) => {
      const { tx, access } = scope;
      const { effective } = await this.access.labourer(scope, labourerId);
      const consents = await tx.labourerConsent.findMany({
        where: { tenantId: access.tenantId, labourerId },
      });
      this.access.demand(scope, effective, "labour.consent");
      if (input.noticeVersion !== CURRENT_CONSENT_NOTICE.version)
        throw labourBadRequest("notice-not-current", "Show the current consent notice.");
      if (
        consents.some(
          (consent) =>
            consent.granted &&
            !consent.withdrawnAt &&
            consent.noticeVersion === input.noticeVersion,
        )
      )
        throw labourConflict(
          "consent-current",
          "The worker's consent to this notice is already recorded.",
        );
      const consent = await tx.labourerConsent.create({
        data: {
          tenantId: access.tenantId,
          labourerId,
          kind: "registration_data",
          noticeVersion: input.noticeVersion,
          noticeDigest: CURRENT_CONSENT_NOTICE.digests[input.language],
          language: input.language,
          method: input.method,
          witnessName: input.witnessName ?? null,
          granted: true,
          capturedBy: access.userId,
        },
      });
      await this.scope.audit(tx, "labourer.consent_recorded", labourerId, {
        consentId: consent.id,
        noticeVersion: input.noticeVersion,
        language: input.language,
        method: input.method,
      });
      return this.reader.detail(scope, labourerId);
    });
  }

  /**
   * Withdraws every active registration-data consent. The records stay as evidence; new
   * engagements and reactivation are refused until consent is recorded again. Retention and
   * erasure of the worker's data follow the reviewed policy (COMPLIANCE-REVIEW: CR-DP-03, CR-DP-06).
   */
  withdrawConsent(principal: Principal, labourerId: string, input: WithdrawConsent, req: Request) {
    return this.mutate(principal, req, async (scope) => {
      const { tx, access } = scope;
      const { effective } = await this.access.labourer(scope, labourerId);
      const consents = await tx.labourerConsent.findMany({
        where: { tenantId: access.tenantId, labourerId },
      });
      this.access.demand(scope, effective, "labour.consent");
      const active = consents.filter((consent) => consent.granted && !consent.withdrawnAt);
      if (!active.length)
        throw labourConflict("consent-withdrawn", "There is no active consent to withdraw.");
      const now = new Date();
      for (const consent of active)
        await tx.labourerConsent.update({
          where: { id: consent.id },
          data: {
            withdrawnAt: now,
            withdrawnBy: access.userId,
            withdrawalMethod: input.method,
            withdrawalWitness: input.witnessName ?? null,
          },
        });
      await this.scope.audit(tx, "labourer.consent_withdrawn", labourerId, {
        consents: active.length,
        method: input.method,
      });
      return this.reader.detail(scope, labourerId);
    });
  }

  /** NCA accreditation alerts for active labourers the caller can see (computed on read). */
  alerts(principal: Principal, query: AlertsQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const visible = await this.access.requireSomewhere(scope, "labour.view");
      const context = await this.reader.context(scope);
      const filters: Prisma.LabourerWhereInput[] = [
        { tenantId: access.tenantId, status: "active" },
      ];
      if (visible !== "all")
        filters.push({ engagements: { some: { projectId: { in: [...visible] } } } });
      if (query.projectId) {
        if (!inProjects(visible, query.projectId))
          return accreditationAlertsResponseSchema.parse({
            alerts: [],
            alertDays: context.alertDays,
            today: context.today,
          });
        filters.push({ engagements: { some: { projectId: query.projectId, endDate: null } } });
      }
      const rows = await loadLabourers(tx, access.tenantId, { AND: filters });
      const alerts: AccreditationAlert[] = [];
      for (const row of rows) {
        const summary = accreditationSummary(row, context.today, context.alertDays);
        if (
          summary.status !== "expired" &&
          summary.status !== "expiring" &&
          summary.status !== "missing"
        )
          continue;
        const card = row.accreditations[0] ?? null;
        alerts.push({
          labourerId: row.id,
          workerNo: row.workerNo,
          fullName: row.fullName,
          kind: summary.status,
          accreditationId: card?.id ?? null,
          category: (card?.category ?? null) as AccreditationAlert["category"],
          expiresOn: card ? toCalendarDate(card.expiresOn) : null,
          daysLeft: summary.daysLeft,
        });
      }
      const order = { expired: 0, expiring: 1, missing: 2 } as const;
      alerts.sort(
        (a, b) =>
          order[a.kind] - order[b.kind] ||
          (a.daysLeft ?? 0) - (b.daysLeft ?? 0) ||
          a.workerNo.localeCompare(b.workerNo),
      );
      return accreditationAlertsResponseSchema.parse({
        alerts,
        alertDays: context.alertDays,
        today: nairobiDate(),
      });
    });
  }

  private mutate<T>(
    principal: Principal,
    req: Request,
    operation: (scope: Scope) => Promise<T>,
  ): Promise<T> {
    return this.scope
      .run(principal, req, operation, true)
      .catch((error: unknown) => rethrowLabourDbError(error, "labour-rule"));
  }
}
