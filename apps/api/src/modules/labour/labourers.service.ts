import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import {
  isOldEnoughToRegister,
  nairobiDate,
  normaliseIdNumber,
  normaliseKraPin,
  normalizeKenyanPhone,
  summariseAccreditation,
} from "@pm-buddy/domain";
import {
  CURRENT_CONSENT_NOTICE,
  ID_DOCUMENT_TYPES,
  type SensitiveLabourField,
} from "@pm-buddy/types";
import {
  labourersResponseSchema,
  revealResponseSchema,
  type LabourerListQuery,
  type LabourerWarning,
  type RegisterLabourerInput,
  type UpdateLabourerInput,
} from "@pm-buddy/validation";
import type { z } from "zod";
import type {
  createEngagementRequestSchema,
  doNotRehireRequestSchema,
  endEngagementRequestSchema,
  labourerStatusRequestSchema,
  revealRequestSchema,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import { AuthService, type Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import { loadLabourers, toSummary } from "./labour-mappers.js";
import {
  inProjects,
  isEmpty,
  LabourAccess,
  labourBadRequest,
  labourConflict,
  LabourCrypto,
  requireStepUp,
  rethrowLabourDbError,
  uuidv7,
  versionConflict,
  type LabourerColumn,
} from "./labour-support.js";
import { LabourerReader } from "./labourer-reader.js";

type Tx = Prisma.TransactionClient;
type DoNotRehireRequest = z.output<typeof doNotRehireRequestSchema>;
type StatusRequest = z.output<typeof labourerStatusRequestSchema>;
type EngagementRequest = z.output<typeof createEngagementRequestSchema>;
type EndEngagementRequest = z.output<typeof endEngagementRequestSchema>;
type RevealRequest = z.output<typeof revealRequestSchema>;

const COLUMNS: Record<SensitiveLabourField, LabourerColumn> = {
  idNumber: "id_number_enc",
  phone: "phone_enc",
  kraPin: "kra_pin_enc",
  nssfNumber: "nssf_number_enc",
  shaNumber: "sha_number_enc",
  nextOfKin: "next_of_kin_enc",
};
const ROW_FIELDS: Record<SensitiveLabourField, keyof Prisma.LabourerGetPayload<object>> = {
  idNumber: "idNumberEnc",
  phone: "phoneEnc",
  kraPin: "kraPinEnc",
  nssfNumber: "nssfNumberEnc",
  shaNumber: "shaNumberEnc",
  nextOfKin: "nextOfKinEnc",
};

/** Names of the fields an input changes: audit summaries never carry values. */
const changedFields = (input: object) =>
  Object.entries(input)
    .filter(([key, value]) => key !== "version" && value !== undefined)
    .map(([key]) => key)
    .sort();

const underAge = () =>
  labourBadRequest(
    "under-minimum-age",
    "Registration is blocked: workers must be 18 or older (Africa/Nairobi date).",
  );

/**
 * The labourer registry (D3.1, brief §5.4): list, register with consent, read, update, status,
 * engagements, reveal of encrypted identifiers (labour.view_sensitive + step-up, audited) and the
 * do-not-rehire flag (labour.do_not_rehire + step-up, audited, reason encrypted).
 */
@Injectable()
export class LabourersService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: LabourAccess,
    private readonly crypto: LabourCrypto,
    private readonly reader: LabourerReader,
    private readonly auth: AuthService,
  ) {}

  list(principal: Principal, query: LabourerListQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      await this.access.requireSomewhere(scope, "labour.view");
      const visibility = await this.reader.visibility(scope);
      const { visible, flags } = visibility;
      const manage = await this.access.projectsWith(scope, "labour.manage");
      const dnr = await this.access.projectsWith(scope, "labour.do_not_rehire");
      const permissions = {
        canRegister: !isEmpty(manage),
        canFlag: !isEmpty(dnr),
        canConfigure: access.permissions.has("config.manage"),
      };
      const context = await this.reader.context(scope, visibility);
      const empty = () =>
        labourersResponseSchema.parse({
          labourers: [],
          total: 0,
          today: context.today,
          alertDays: context.alertDays,
          permissions,
        });

      const filters: Prisma.LabourerWhereInput[] = [{ tenantId: access.tenantId }];
      if (visible !== "all")
        filters.push({ engagements: { some: { projectId: { in: [...visible] } } } });
      if (query.status) filters.push({ status: query.status });
      if (query.tradeId) filters.push({ tradeId: query.tradeId });
      if (query.skillLevelId) filters.push({ skillLevelId: query.skillLevelId });
      if (query.projectId) {
        if (!inProjects(visible, query.projectId)) return empty();
        filters.push({ engagements: { some: { projectId: query.projectId, endDate: null } } });
      }
      if (query.gangId)
        filters.push({ gangMembers: { some: { gangId: query.gangId, leftOn: null } } });
      if (query.doNotRehire) {
        if (isEmpty(flags)) throw new ForbiddenException("Only managers see do-not-rehire flags");
        filters.push({ doNotRehire: true });
        if (flags !== "all")
          filters.push({ engagements: { some: { projectId: { in: [...flags] } } } });
      }
      if (query.consent === "withdrawn")
        filters.push({ consents: { none: { granted: true, withdrawnAt: null } } });
      if (query.consent === "outdated")
        filters.push({
          consents: {
            some: { granted: true, withdrawnAt: null },
            none: {
              granted: true,
              withdrawnAt: null,
              noticeVersion: CURRENT_CONSENT_NOTICE.version,
            },
          },
        });
      if (query.search) filters.push({ OR: this.searchFilters(access.tenantId, query.search) });

      const rows = await loadLabourers(tx, access.tenantId, { AND: filters });
      // Accreditation states depend on today's date and the alert lead time, so that filter runs
      // here (fine for thousands of labourers per company; see IMPLEMENTATION_STATUS).
      const summaries = rows
        .map((row) =>
          toSummary(row, { ...context, canSeeFlag: LabourerReader.canSeeFlag(row, flags) }),
        )
        .filter((summary) => {
          if (!query.accreditation) return true;
          const status = summary.accreditation.status;
          return query.accreditation === "attention"
            ? status === "expiring" || status === "expired"
            : status === query.accreditation;
        });
      return labourersResponseSchema.parse({
        labourers: summaries.slice(query.offset, query.offset + query.limit),
        total: summaries.length,
        today: context.today,
        alertDays: context.alertDays,
        permissions,
      });
    });
  }

  get(principal: Principal, labourerId: string, req: Request) {
    return this.scope.run(principal, req, (scope) => this.reader.detail(scope, labourerId));
  }

  register(principal: Principal, input: RegisterLabourerInput, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const tenantId = access.tenantId;
          const today = nairobiDate();
          const projectId = input.projectId ?? null;
          if (projectId) {
            await this.access.requireOnProject(scope, "labour.manage", projectId);
            await this.assertProjectOpen(tx, tenantId, projectId);
          } else await this.access.requireCompanyWide(scope, "labour.manage");
          // Brief §6: the age is checked on today's date in Africa/Nairobi (the database repeats it).
          if (!isOldEnoughToRegister(input.dateOfBirth, today)) throw underAge();
          const startDate = input.engagementStartDate ?? today;
          if (startDate > today)
            throw labourBadRequest("date-in-future", "The start date cannot be in the future.");
          if (projectId && !isOldEnoughToRegister(input.dateOfBirth, startDate)) throw underAge();
          if (input.consent.noticeVersion !== CURRENT_CONSENT_NOTICE.version)
            throw labourBadRequest(
              "notice-not-current",
              "Show the current consent notice before registering.",
            );
          const skillLevel = await this.activeConfig(
            tx,
            tenantId,
            input.tradeId,
            input.skillLevelId,
          );

          // Duplicate and do-not-rehire checks run on blind indexes only.
          const idIndex = this.crypto.idIndex(tenantId, input.idType, input.idNumber);
          const phoneIndex = input.phone ? this.crypto.index(tenantId, "phone", input.phone) : null;
          const kraIndex = input.kraPin
            ? this.crypto.index(tenantId, "kra_pin", input.kraPin)
            : null;
          const sameId = await tx.labourer.findFirst({
            where: { tenantId, idNumberBidx: idIndex },
            select: { id: true, workerNo: true, doNotRehire: true },
          });
          if (sameId) {
            const match = {
              labourerId: sameId.id,
              workerNo: sameId.workerNo,
              matchedOn: "id" as const,
            };
            throw sameId.doNotRehire
              ? labourConflict(
                  "do-not-rehire-match",
                  "This ID number belongs to a worker flagged do not rehire.",
                  match,
                )
              : labourConflict(
                  "duplicate-identity",
                  "This ID number is already registered. Engage the existing worker instead.",
                  match,
                );
          }
          if (kraIndex) {
            const sameKra = await tx.labourer.findFirst({
              where: { tenantId, kraPinBidx: kraIndex },
              select: { id: true, workerNo: true, doNotRehire: true },
            });
            if (sameKra) {
              const match = {
                labourerId: sameKra.id,
                workerNo: sameKra.workerNo,
                matchedOn: "kraPin" as const,
              };
              throw sameKra.doNotRehire
                ? labourConflict(
                    "do-not-rehire-match",
                    "This KRA PIN belongs to a worker flagged do not rehire.",
                    match,
                  )
                : labourConflict("kra-pin-taken", "Another worker has this KRA PIN.", match);
            }
          }
          const flagged = phoneIndex
            ? await tx.labourer.findMany({
                where: { tenantId, doNotRehire: true, phoneBidx: phoneIndex },
                select: { id: true, workerNo: true },
                orderBy: { workerNo: "asc" },
              })
            : [];
          if (flagged.length) {
            if (!input.doNotRehireOverride)
              throw labourConflict(
                "do-not-rehire-match",
                "This phone number belongs to a worker flagged do not rehire.",
                { labourerId: flagged[0]!.id, workerNo: flagged[0]!.workerNo, matchedOn: "phone" },
              );
            if (projectId)
              await this.access.requireOnProject(scope, "labour.do_not_rehire", projectId);
            else await this.access.requireCompanyWide(scope, "labour.do_not_rehire");
          }
          const sharedPhone =
            phoneIndex !== null &&
            (await tx.labourer.count({ where: { tenantId, phoneBidx: phoneIndex } })) >
              flagged.length;

          const id = uuidv7();
          const workerNo = await this.nextWorkerNo(tx, tenantId);
          await tx.labourer.create({
            data: {
              id,
              tenantId,
              workerNo,
              fullName: input.fullName,
              dateOfBirth: fromCalendarDate(input.dateOfBirth),
              // Overwritten by the database with today's Africa/Nairobi date.
              registeredOn: fromCalendarDate(today),
              gender: input.gender,
              homeCounty: input.homeCounty ?? null,
              tradeId: input.tradeId,
              skillLevelId: input.skillLevelId,
              engagementType: input.engagementType,
              rateBasis: input.rateBasis,
              idType: input.idType,
              idNumberEnc: this.crypto.seal(tenantId, id, "id_number_enc", input.idNumber),
              idNumberBidx: idIndex,
              ...this.identifiers(tenantId, id, input),
              createdBy: access.userId,
            },
          });
          await tx.labourerConsent.create({
            data: {
              tenantId,
              labourerId: id,
              kind: "registration_data",
              noticeVersion: input.consent.noticeVersion,
              noticeDigest: CURRENT_CONSENT_NOTICE.digests[input.consent.language],
              language: input.consent.language,
              method: input.consent.method,
              witnessName: input.consent.witnessName ?? null,
              granted: true,
              capturedBy: access.userId,
            },
          });
          if (projectId)
            await tx.labourEngagement.create({
              data: {
                tenantId,
                labourerId: id,
                projectId,
                startDate: fromCalendarDate(startDate),
                createdBy: access.userId,
              },
            });
          if (input.accreditation)
            await tx.labourerAccreditation.create({
              data: {
                tenantId,
                labourerId: id,
                category: input.accreditation.category,
                cardNumber: input.accreditation.cardNumber,
                issuedOn: input.accreditation.issuedOn
                  ? fromCalendarDate(input.accreditation.issuedOn)
                  : null,
                expiresOn: fromCalendarDate(input.accreditation.expiresOn),
                createdBy: access.userId,
              },
            });
          for (const match of flagged) {
            await this.recordOverride(scope, match.id, {
              context: "registration",
              projectId,
              relatedLabourerId: id,
              reason: input.doNotRehireOverride!.reason,
            });
          }
          await this.scope.audit(tx, "labourer.registered", id, {
            workerNo,
            projectId,
            recorded: changedFields({
              homeCounty: input.homeCounty ?? undefined,
              phone: input.phone ?? undefined,
              kraPin: input.kraPin ?? undefined,
              nssfNumber: input.nssfNumber ?? undefined,
              shaNumber: input.shaNumber ?? undefined,
              nextOfKin: input.nextOfKin ?? undefined,
              accreditation: input.accreditation,
            }),
            consent: {
              noticeVersion: input.consent.noticeVersion,
              language: input.consent.language,
              method: input.consent.method,
            },
            doNotRehireOverride: flagged.length > 0,
          });

          const warnings: LabourerWarning[] = [];
          if (sharedPhone) warnings.push("phone-shared");
          if (flagged.length) warnings.push("do-not-rehire-overridden");
          const accreditation = summariseAccreditation(
            input.accreditation ? [{ expiresOn: input.accreditation.expiresOn }] : [],
            skillLevel.accreditationExpected,
            today,
            (await this.reader.context(scope)).alertDays,
          );
          if (accreditation.status === "missing") warnings.push("accreditation-missing");
          if (accreditation.status === "expiring") warnings.push("accreditation-expiring");
          if (accreditation.status === "expired") warnings.push("accreditation-expired");
          return this.detailOrMinimal(scope, id, warnings);
        },
        true,
      )
      .catch((error: unknown) => rethrowLabourDbError(error, "duplicate-identity"));
  }

  update(principal: Principal, labourerId: string, input: UpdateLabourerInput, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const tenantId = access.tenantId;
          const { row, effective } = await this.access.labourer(scope, labourerId);
          const starts = await tx.labourEngagement.findMany({
            where: { tenantId, labourerId },
            select: { startDate: true },
          });
          this.access.demand(scope, effective, "labour.manage");
          if (row.version !== input.version) throw versionConflict();
          const data: Prisma.LabourerUncheckedUpdateManyInput = {};
          if (input.fullName !== undefined) data.fullName = input.fullName;
          if (input.gender !== undefined) data.gender = input.gender;
          if (input.homeCounty !== undefined) data.homeCounty = input.homeCounty;
          if (input.engagementType !== undefined) data.engagementType = input.engagementType;
          if (input.rateBasis !== undefined) data.rateBasis = input.rateBasis;
          if (input.tradeId !== undefined || input.skillLevelId !== undefined) {
            await this.activeConfig(
              tx,
              tenantId,
              input.tradeId ?? row.tradeId,
              input.skillLevelId ?? row.skillLevelId,
              { trade: input.tradeId !== undefined, skillLevel: input.skillLevelId !== undefined },
            );
            if (input.tradeId) data.tradeId = input.tradeId;
            if (input.skillLevelId) data.skillLevelId = input.skillLevelId;
          }
          if (input.dateOfBirth !== undefined) {
            const earliest = [
              toCalendarDate(row.registeredOn),
              ...starts.map((engagement) => toCalendarDate(engagement.startDate)),
            ].sort()[0]!;
            if (!isOldEnoughToRegister(input.dateOfBirth, earliest)) throw underAge();
            data.dateOfBirth = fromCalendarDate(input.dateOfBirth);
          }
          if (input.idType && input.idNumber) {
            const idIndex = this.crypto.idIndex(tenantId, input.idType, input.idNumber);
            const other = await tx.labourer.findFirst({
              where: { tenantId, idNumberBidx: idIndex, id: { not: labourerId } },
              select: { id: true, workerNo: true },
            });
            if (other)
              throw labourConflict(
                "duplicate-identity",
                "Another worker is registered with this ID number.",
                { labourerId: other.id, workerNo: other.workerNo, matchedOn: "id" },
              );
            data.idType = input.idType;
            data.idNumberEnc = this.crypto.seal(
              tenantId,
              labourerId,
              "id_number_enc",
              input.idNumber,
            );
            data.idNumberBidx = idIndex;
          }
          if (input.kraPin) {
            const kraIndex = this.crypto.index(tenantId, "kra_pin", input.kraPin);
            const other = await tx.labourer.findFirst({
              where: { tenantId, kraPinBidx: kraIndex, id: { not: labourerId } },
              select: { id: true, workerNo: true },
            });
            if (other)
              throw labourConflict("kra-pin-taken", "Another worker has this KRA PIN.", {
                labourerId: other.id,
                workerNo: other.workerNo,
                matchedOn: "kraPin",
              });
          }
          Object.assign(data, this.identifiers(tenantId, labourerId, input));
          const updated = await tx.labourer.updateMany({
            where: { tenantId, id: labourerId, version: input.version },
            data: { ...data, version: { increment: 1 } },
          });
          if (!updated.count) throw versionConflict();
          await this.scope.audit(tx, "labourer.updated", labourerId, {
            fields: changedFields(input),
          });
          const warnings: LabourerWarning[] = [];
          if (input.phone) {
            const shared = await tx.labourer.count({
              where: {
                tenantId,
                phoneBidx: this.crypto.index(tenantId, "phone", input.phone),
                id: { not: labourerId },
              },
            });
            if (shared) warnings.push("phone-shared");
          }
          return this.reader.detail(scope, labourerId, warnings);
        },
        true,
      )
      .catch((error: unknown) => rethrowLabourDbError(error, "duplicate-identity"));
  }

  changeStatus(principal: Principal, labourerId: string, input: StatusRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const tenantId = access.tenantId;
          const { row, effective } = await this.access.labourer(scope, labourerId);
          const openEngagements = await tx.labourEngagement.findMany({
            where: { tenantId, labourerId, endDate: null },
          });
          const consents = await tx.labourerConsent.findMany({ where: { tenantId, labourerId } });
          this.access.demand(scope, effective, "labour.manage");
          if (row.version !== input.version) throw versionConflict();
          if (row.status === input.to)
            throw labourConflict("invalid-status-change", `The worker is already ${input.to}.`);
          const reason = input.reason?.trim() || null;
          let override = false;
          if (input.to === "active") {
            if (!consents.some((consent) => consent.granted && !consent.withdrawnAt))
              throw labourConflict(
                "consent-not-active",
                "Record the worker's consent before reactivating them.",
              );
            if (row.doNotRehire) {
              if (!input.doNotRehireOverride)
                throw labourConflict(
                  "do-not-rehire-match",
                  "This worker is flagged do not rehire.",
                  {
                    labourerId,
                    workerNo: row.workerNo,
                    matchedOn: "id",
                  },
                );
              this.access.demand(scope, effective, "labour.do_not_rehire");
              await this.recordOverride(scope, labourerId, {
                context: "reactivation",
                projectId: null,
                relatedLabourerId: null,
                reason: input.doNotRehireOverride.reason,
              });
              override = true;
            }
          }
          let ended = 0;
          if (input.to === "left") {
            const today = nairobiDate();
            for (const engagement of openEngagements) {
              await this.access.requireOnProject(scope, "labour.manage", engagement.projectId);
              await this.endOpenEngagement(scope, engagement, today, reason ?? "Worker left");
              ended += 1;
            }
          }
          const updated = await tx.labourer.updateMany({
            where: { tenantId, id: labourerId, version: input.version },
            data: { status: input.to, version: { increment: 1 } },
          });
          if (!updated.count) throw versionConflict();
          await this.scope.audit(tx, "labourer.status_changed", labourerId, {
            from: row.status,
            to: input.to,
            reasonGiven: reason !== null,
            engagementsEnded: ended,
            doNotRehireOverride: override,
          });
          return this.reader.detail(scope, labourerId);
        },
        true,
      )
      .catch((error: unknown) => rethrowLabourDbError(error, "labour-rule"));
  }

  /** The full value of one encrypted field: labour.view_sensitive, fresh MFA, audited. */
  reveal(principal: Principal, labourerId: string, input: RevealRequest, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { row, effective } = await this.access.labourer(scope, labourerId);
      this.access.demand(scope, effective, "labour.view_sensitive");
      requireStepUp(this.auth, principal);
      const stored = row[ROW_FIELDS[input.field]] as Uint8Array | null;
      let value: string | { name: string; relationship: string; phone: string | null } | null =
        null;
      if (stored) {
        const plain = this.crypto.open(
          scope.access.tenantId,
          labourerId,
          COLUMNS[input.field],
          stored,
        );
        value = input.field === "nextOfKin" ? (JSON.parse(plain) as typeof value) : plain;
      }
      // The audit records which field was revealed and why, never the value.
      await this.scope.audit(scope.tx, "labourer.sensitive_revealed", labourerId, {
        field: input.field,
        purpose: input.purpose,
        recorded: stored !== null,
      });
      return revealResponseSchema.parse({
        field: input.field,
        value,
        revealedAt: new Date().toISOString(),
      });
    });
  }

  setDoNotRehire(
    principal: Principal,
    labourerId: string,
    input: DoNotRehireRequest,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const { row, effective } = await this.access.labourer(scope, labourerId);
          this.access.demand(scope, effective, "labour.do_not_rehire");
          requireStepUp(this.auth, principal);
          if (row.version !== input.version) throw versionConflict();
          if (row.doNotRehire === input.flagged)
            throw labourConflict(
              "do-not-rehire-unchanged",
              input.flagged ? "The worker is already flagged." : "The worker is not flagged.",
            );
          const eventId = uuidv7();
          await tx.doNotRehireEvent.create({
            data: {
              id: eventId,
              tenantId: access.tenantId,
              labourerId,
              action: input.flagged ? "set" : "clear",
              reasonEnc: this.crypto.sealReason(access.tenantId, eventId, input.reason),
              actorId: access.userId,
            },
          });
          const updated = await tx.labourer.updateMany({
            where: { tenantId: access.tenantId, id: labourerId, version: input.version },
            data: {
              doNotRehire: input.flagged,
              doNotRehireAt: input.flagged ? new Date() : null,
              doNotRehireBy: input.flagged ? access.userId : null,
              version: { increment: 1 },
            },
          });
          if (!updated.count) throw versionConflict();
          // The reason is encrypted in the do-not-rehire history; the audit only notes one was given.
          await this.scope.audit(
            tx,
            input.flagged ? "labourer.do_not_rehire_set" : "labourer.do_not_rehire_cleared",
            labourerId,
            { reasonGiven: true },
          );
          return this.reader.detail(scope, labourerId);
        },
        true,
      )
      .catch((error: unknown) => rethrowLabourDbError(error, "labour-rule"));
  }

  /**
   * Engages an existing labourer on a project (rehire). Needs labour.manage on the project, an
   * active consent, 18 on the start date, and for a do-not-rehire worker labour.do_not_rehire with a
   * recorded override reason. A worker who had left becomes active again.
   */
  engage(principal: Principal, labourerId: string, input: EngagementRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const tenantId = access.tenantId;
          await this.access.requireOnProject(scope, "labour.manage", input.projectId);
          await this.assertProjectOpen(tx, tenantId, input.projectId);
          const row = await tx.labourer.findUnique({
            where: { tenantId_id: { tenantId, id: labourerId } },
          });
          if (!row) throw new NotFoundException("Labourer not found");
          const consents = await tx.labourerConsent.findMany({ where: { tenantId, labourerId } });
          const openEngagements = await tx.labourEngagement.findMany({
            where: { tenantId, labourerId, endDate: null },
          });
          const today = nairobiDate();
          const startDate = input.startDate ?? today;
          if (startDate > today)
            throw labourBadRequest("date-in-future", "The start date cannot be in the future.");
          if (!isOldEnoughToRegister(toCalendarDate(row.dateOfBirth), startDate)) throw underAge();
          if (!consents.some((consent) => consent.granted && !consent.withdrawnAt))
            throw labourConflict(
              "consent-not-active",
              "Record the worker's consent before engaging them.",
            );
          if (openEngagements.some((engagement) => engagement.projectId === input.projectId))
            throw labourConflict(
              "already-engaged",
              "The worker is already engaged on this project.",
            );
          if (row.doNotRehire) {
            if (!input.doNotRehireOverride)
              throw labourConflict("do-not-rehire-match", "This worker is flagged do not rehire.", {
                labourerId,
                workerNo: row.workerNo,
                matchedOn: "id",
              });
            await this.access.requireOnProject(scope, "labour.do_not_rehire", input.projectId);
            await this.recordOverride(scope, labourerId, {
              context: "engagement",
              projectId: input.projectId,
              relatedLabourerId: null,
              reason: input.doNotRehireOverride.reason,
            });
          }
          const reactivated = row.status !== "active";
          if (reactivated)
            await tx.labourer.update({
              where: { tenantId_id: { tenantId, id: labourerId } },
              data: { status: "active", version: { increment: 1 } },
            });
          await tx.labourEngagement.create({
            data: {
              tenantId,
              labourerId,
              projectId: input.projectId,
              startDate: fromCalendarDate(startDate),
              createdBy: access.userId,
            },
          });
          await this.scope.audit(tx, "labourer.engaged", labourerId, {
            projectId: input.projectId,
            startDate,
            reactivated,
            doNotRehireOverride: row.doNotRehire,
          });
          return this.reader.detail(
            scope,
            labourerId,
            row.doNotRehire ? ["do-not-rehire-overridden"] : [],
          );
        },
        true,
      )
      .catch((error: unknown) => rethrowLabourDbError(error, "already-engaged"));
  }

  endEngagement(
    principal: Principal,
    labourerId: string,
    engagementId: string,
    input: EndEngagementRequest,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const engagement = await tx.labourEngagement.findFirst({
            where: { tenantId: access.tenantId, id: engagementId, labourerId },
          });
          if (!engagement) throw new NotFoundException("Engagement not found");
          await this.access.requireOnProject(scope, "labour.manage", engagement.projectId);
          if (engagement.endDate)
            throw labourConflict("engagement-ended", "This engagement has already ended.");
          if (input.endDate > nairobiDate())
            throw labourBadRequest("date-in-future", "The end date cannot be in the future.");
          await this.endOpenEngagement(
            scope,
            engagement,
            input.endDate,
            input.reason?.trim() || null,
          );
          await this.scope.audit(tx, "labourer.engagement_ended", labourerId, {
            projectId: engagement.projectId,
            endDate: input.endDate,
            reasonGiven: Boolean(input.reason?.trim()),
          });
          return this.reader.detail(scope, labourerId);
        },
        true,
      )
      .catch((error: unknown) => rethrowLabourDbError(error, "labour-rule"));
  }

  /** Ends an engagement and the gang memberships it supported on that project. */
  private async endOpenEngagement(
    scope: Scope,
    engagement: { id: string; labourerId: string; projectId: string; startDate: Date },
    endDate: string,
    reason: string | null,
  ) {
    const { tx, access } = scope;
    if (endDate < toCalendarDate(engagement.startDate))
      throw labourBadRequest("end-before-start", "The end date is before the start date.");
    const memberships = await tx.gangMembership.findMany({
      where: {
        tenantId: access.tenantId,
        projectId: engagement.projectId,
        labourerId: engagement.labourerId,
        leftOn: null,
      },
    });
    for (const membership of memberships) {
      if (endDate < toCalendarDate(membership.joinedOn))
        throw labourBadRequest(
          "end-before-start",
          "The end date is before the worker joined their gang.",
        );
      await tx.gang.updateMany({
        where: {
          tenantId: access.tenantId,
          id: membership.gangId,
          leaderLabourerId: engagement.labourerId,
        },
        data: { leaderLabourerId: null, version: { increment: 1 } },
      });
      await tx.gangMembership.update({
        where: { id: membership.id },
        data: { leftOn: fromCalendarDate(endDate), removedBy: access.userId },
      });
    }
    await tx.labourEngagement.update({
      where: { id: engagement.id },
      data: {
        endDate: fromCalendarDate(endDate),
        endReason: reason,
        endedBy: access.userId,
        endedAt: new Date(),
      },
    });
  }

  /** An override of the do-not-rehire flag, with its encrypted reason (audited separately). */
  private async recordOverride(
    scope: Scope,
    flaggedLabourerId: string,
    override: {
      context: "registration" | "engagement" | "reactivation";
      projectId: string | null;
      relatedLabourerId: string | null;
      reason: string;
    },
  ) {
    const { tx, access } = scope;
    const eventId = uuidv7();
    await tx.doNotRehireEvent.create({
      data: {
        id: eventId,
        tenantId: access.tenantId,
        labourerId: flaggedLabourerId,
        action: "override",
        context: override.context,
        projectId: override.projectId,
        relatedLabourerId: override.relatedLabourerId,
        reasonEnc: this.crypto.sealReason(access.tenantId, eventId, override.reason),
        actorId: access.userId,
      },
    });
    await this.scope.audit(tx, "labourer.do_not_rehire_overridden", flaggedLabourerId, {
      context: override.context,
      projectId: override.projectId,
      relatedLabourerId: override.relatedLabourerId,
      reasonGiven: true,
    });
  }

  /** Optional identifiers: absent leaves a field, null clears it, a value is encrypted afresh. */
  private identifiers(
    tenantId: string,
    labourerId: string,
    input: Pick<
      RegisterLabourerInput,
      "phone" | "kraPin" | "nssfNumber" | "shaNumber" | "nextOfKin"
    >,
  ) {
    const data: Prisma.LabourerUncheckedUpdateManyInput = {};
    const seal = (column: LabourerColumn, value: string) =>
      this.crypto.seal(tenantId, labourerId, column, value);
    if (input.phone !== undefined) {
      data.phoneEnc = input.phone ? seal("phone_enc", input.phone) : null;
      data.phoneBidx = input.phone ? this.crypto.index(tenantId, "phone", input.phone) : null;
    }
    if (input.kraPin !== undefined) {
      data.kraPinEnc = input.kraPin ? seal("kra_pin_enc", input.kraPin) : null;
      data.kraPinBidx = input.kraPin ? this.crypto.index(tenantId, "kra_pin", input.kraPin) : null;
    }
    if (input.nssfNumber !== undefined)
      data.nssfNumberEnc = input.nssfNumber ? seal("nssf_number_enc", input.nssfNumber) : null;
    if (input.shaNumber !== undefined)
      data.shaNumberEnc = input.shaNumber ? seal("sha_number_enc", input.shaNumber) : null;
    if (input.nextOfKin !== undefined)
      data.nextOfKinEnc = input.nextOfKin
        ? seal(
            "next_of_kin_enc",
            JSON.stringify({
              name: input.nextOfKin.name,
              relationship: input.nextOfKin.relationship,
              phone: input.nextOfKin.phone ?? null,
            }),
          )
        : null;
    return data as {
      phoneEnc?: Uint8Array<ArrayBuffer> | null;
      phoneBidx?: string | null;
      kraPinEnc?: Uint8Array<ArrayBuffer> | null;
      kraPinBidx?: string | null;
      nssfNumberEnc?: Uint8Array<ArrayBuffer> | null;
      shaNumberEnc?: Uint8Array<ArrayBuffer> | null;
      nextOfKinEnc?: Uint8Array<ArrayBuffer> | null;
    };
  }

  /** The trade and skill level exist in the company and (when newly chosen) are active. */
  private async activeConfig(
    tx: Tx,
    tenantId: string,
    tradeId: string,
    skillLevelId: string,
    check = { trade: true, skillLevel: true },
  ) {
    const trade = await tx.trade.findFirst({ where: { tenantId, id: tradeId } });
    const skillLevel = await tx.skillLevel.findFirst({ where: { tenantId, id: skillLevelId } });
    if (!trade) throw new NotFoundException("Trade not found");
    if (!skillLevel) throw new NotFoundException("Skill level not found");
    if (check.trade && !trade.active)
      throw labourBadRequest("trade-inactive", "This trade is no longer in use.");
    if (check.skillLevel && !skillLevel.active)
      throw labourBadRequest("skill-level-inactive", "This skill level is no longer in use.");
    return skillLevel;
  }

  private async assertProjectOpen(tx: Tx, tenantId: string, projectId: string) {
    const project = await tx.project.findUnique({
      where: { tenantId_id: { tenantId, id: projectId } },
      select: { status: true },
    });
    if (!project) throw new NotFoundException("Project not found");
    if (project.status === "closed" || project.status === "cancelled")
      throw labourConflict("project-read-only", "Closed and cancelled projects are read-only.");
  }

  /** The next free WRK-NNNN number (the company lock serialises concurrent registrations). */
  private async nextWorkerNo(tx: Tx, tenantId: string): Promise<string> {
    const [row] = await tx.$queryRaw<{ next: bigint }[]>`
      SELECT COALESCE(MAX(substring(worker_no FROM 5)::bigint), 0) + 1 AS next
      FROM labourers WHERE tenant_id = ${tenantId}::uuid`;
    return `WRK-${String(row?.next ?? 1n).padStart(4, "0")}`;
  }

  /**
   * After registering without a project, a project-scoped caller could not view the labourer; a
   * company-wide caller always can, and registration without a project needs a company-wide role.
   */
  private detailOrMinimal(scope: Scope, labourerId: string, warnings: LabourerWarning[]) {
    return this.reader.detail(scope, labourerId, warnings);
  }

  /** Exact-match search on blind indexes (full ID, phone or KRA PIN), plus name and worker no. */
  private searchFilters(tenantId: string, search: string): Prisma.LabourerWhereInput[] {
    const contains = { contains: search, mode: "insensitive" as const };
    const filters: Prisma.LabourerWhereInput[] = [{ fullName: contains }, { workerNo: contains }];
    const ids = ID_DOCUMENT_TYPES.flatMap((type) => {
      const normalised = normaliseIdNumber(type, search);
      return normalised ? [this.crypto.idIndex(tenantId, type, normalised)] : [];
    });
    if (ids.length) filters.push({ idNumberBidx: { in: ids } });
    const phone = normalizeKenyanPhone(search);
    if (phone) filters.push({ phoneBidx: this.crypto.index(tenantId, "phone", phone) });
    const kra = normaliseKraPin(search);
    if (kra) filters.push({ kraPinBidx: this.crypto.index(tenantId, "kra_pin", kra) });
    return filters;
  }
}
