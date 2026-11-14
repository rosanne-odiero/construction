import { Injectable, NotFoundException } from "@nestjs/common";
import { incidentCloseBlockers, type IncidentCloseBlocker } from "@pm-buddy/domain";
import type {
  CorrectiveActionStatus,
  IncidentKind,
  IncidentSeverity,
  IncidentStatus,
  RegulatorDecision,
} from "@pm-buddy/types";
import {
  incidentDetailResponseSchema,
  incidentsResponseSchema,
  type AddIncidentPhotosRequest,
  type CloseIncidentRequest,
  type IncidentPersonInput,
  type IncidentsQuery,
  type InvestigateIncidentRequest,
  type RegulatorDecisionRequest,
  type ReportIncidentRequest,
  type UpdateIncidentRequest,
  type VoidRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { changedFields, peopleOf } from "../procurement/procurement-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  labourerRefs,
  lockProject,
  notFuture,
  notFutureMoment,
  requireCompanyUsers,
  requireProjectLabourers,
  requireSite,
  requireSitePhotos,
  SafetyAccess,
  safetyProblem,
  searchNumber,
  versionConflict,
  type SafetyContext,
} from "./safety-access.js";
import {
  actionInclude,
  actionPeople,
  incidentInclude,
  incidentLabourers,
  incidentPeople,
  toCorrectiveAction,
  toIncident,
  toTreatment,
  treatmentInclude,
  treatmentLabourers,
  treatmentPeople,
} from "./safety-mappers.js";

type IncidentRecord = Prisma.SafetyIncidentGetPayload<object>;

const blockerMessages: Record<IncidentCloseBlocker, string> = {
  not_investigated: "Record the investigation first",
  actions_outstanding: "Every corrective action must be verified or cancelled",
  no_verified_action: "Verify a corrective action or give a reason why none is needed",
  regulator_decision_required: "Record the regulator decision first",
};

/**
 * Incidents and near misses (D8.2): reported on a site by a site.diary or safety.manage holder,
 * investigated (root cause) and closed by a safety.manage holder once every corrective action is
 * verified or cancelled and any required regulator decision is recorded. Closed incidents are
 * locked (database guard). People and injury codes are shown only to safety.manage holders, and
 * never written to the audit log (decision D-74).
 */
@Injectable()
export class IncidentsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly safety: SafetyAccess,
  ) {}

  list(principal: Principal, projectId: string, query: IncidentsQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.safety.load(scope, projectId);
      const { tenantId } = scope.access;
      const scoped = { tenantId, projectId };
      const where: Prisma.SafetyIncidentWhereInput = {
        ...scoped,
        ...(query.siteId ? { siteId: query.siteId } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.status === "open"
          ? { status: { in: ["reported", "investigated"] } }
          : query.status
            ? { status: query.status }
            : {}),
        ...(query.cursor ? { number: { lt: query.cursor } } : {}),
      };
      const search = query.search?.trim();
      if (search) {
        const number = searchNumber(search, "INC");
        where.OR = [
          { location: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
          ...(number !== null ? [{ number }] : []),
        ];
      }
      const [rows, reported, investigated, closed, regulatorPending] = await Promise.all([
        scope.tx.safetyIncident.findMany({
          where,
          include: incidentInclude,
          orderBy: { number: "desc" },
          take: query.limit + 1,
        }),
        scope.tx.safetyIncident.count({ where: { ...scoped, status: "reported" } }),
        scope.tx.safetyIncident.count({ where: { ...scoped, status: "investigated" } }),
        scope.tx.safetyIncident.count({ where: { ...scoped, status: "closed" } }),
        scope.tx.safetyIncident.count({ where: { ...scoped, ...regulatorPendingWhere } }),
      ]);
      const page = rows.slice(0, query.limit);
      const [people, labourers] = await Promise.all([
        peopleOf(scope.tx, page.flatMap(incidentPeople)),
        labourerRefs(scope.tx, tenantId, page.flatMap(incidentLabourers)),
      ]);
      return incidentsResponseSchema.parse({
        incidents: page.map((row) => toIncident(row, people, labourers, context)),
        nextCursor: rows.length > query.limit ? page.at(-1)!.number : null,
        counts: { reported, investigated, closed, regulatorPending },
        permissions: { canReport: context.canRecord },
      });
    });
  }

  get(principal: Principal, projectId: string, incidentId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.safety.load(scope, projectId);
      return this.detail(scope, context, incidentId);
    });
  }

  report(principal: Principal, projectId: string, input: ReportIncidentRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.recorder(scope, projectId);
        const { tenantId, userId } = scope.access;
        await requireSite(scope.tx, tenantId, projectId, input.siteId);
        notFutureMoment(input.occurredAt);
        await this.checkPeople(scope, projectId, input.people);
        await requireSitePhotos(
          scope.tx,
          tenantId,
          projectId,
          input.siteId,
          input.photoIds,
          "safety_incident",
        );
        if (input.followUpOfId) {
          const original = await scope.tx.safetyIncident.findFirst({
            where: { tenantId, projectId, id: input.followUpOfId },
            select: { status: true },
          });
          if (original?.status !== "closed")
            throw safetyProblem(
              422,
              "incident-follow-up-invalid",
              "A follow-up refers to a closed incident of this project",
            );
        }
        await lockProject(scope.tx, tenantId, projectId);
        const latest = await scope.tx.safetyIncident.findFirst({
          where: { tenantId, projectId },
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const id = uuidv7();
        const number = (latest?.number ?? 0) + 1;
        await scope.tx.safetyIncident.create({
          data: {
            id,
            tenantId,
            projectId,
            siteId: input.siteId,
            number,
            kind: input.kind,
            severity: input.severity,
            occurredAt: new Date(input.occurredAt),
            location: input.location,
            description: input.description,
            immediateActions: input.immediateActions,
            firstAidGiven: input.firstAidGiven,
            followUpOfId: input.followUpOfId ?? null,
            reportedBy: userId,
            updatedBy: userId,
          },
        });
        await this.writePeople(scope, projectId, id, input.people);
        if (input.photoIds.length)
          await scope.tx.safetyIncidentPhoto.createMany({
            data: input.photoIds.map((photoId) => ({
              tenantId,
              projectId,
              incidentId: id,
              photoId,
              addedBy: userId,
            })),
          });
        // IDs, codes and counts only: never names, descriptions or injury details.
        await this.scope.audit(scope.tx, "safety.incident_reported", id, {
          projectId,
          siteId: input.siteId,
          number,
          kind: input.kind,
          severity: input.severity,
          people: input.people.length,
          photos: input.photoIds.length,
          followUp: Boolean(input.followUpOfId),
        });
        return this.detail(scope, context, id);
      },
      true,
    );
  }

  update(
    principal: Principal,
    projectId: string,
    incidentId: string,
    input: UpdateIncidentRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.manager(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.loadOpen(scope, projectId, incidentId, input.version);
        if (input.occurredAt) notFutureMoment(input.occurredAt);
        const kind = (input.kind ?? row.kind) as IncidentKind;
        const people =
          input.people ??
          (await scope.tx.safetyIncidentPerson.findMany({
            where: { tenantId, incidentId },
            select: { role: true },
          }));
        const injured = people.some((person) => person.role === "injured");
        if (kind === "injury" && !injured)
          throw safetyProblem(
            422,
            "injured-person-required",
            "An injury names at least one injured person",
          );
        if (kind === "near_miss" && injured)
          throw safetyProblem(422, "near-miss-without-injury", "A near miss has no injured person");
        if (input.people) await this.checkPeople(scope, projectId, input.people);
        const { version } = input;
        const data: Prisma.SafetyIncidentUncheckedUpdateManyInput = {
          kind: input.kind,
          severity: input.severity,
          location: input.location,
          description: input.description,
          immediateActions: input.immediateActions,
          firstAidGiven: input.firstAidGiven,
          ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}),
        };
        const changed = await scope.tx.safetyIncident.updateMany({
          where: { tenantId, projectId, id: incidentId, version },
          data: { ...data, updatedBy: userId, version: { increment: 1 } },
        });
        if (changed.count !== 1) throw versionConflict();
        if (input.people) {
          await scope.tx.safetyIncidentPerson.deleteMany({ where: { tenantId, incidentId } });
          await this.writePeople(scope, projectId, incidentId, input.people);
        }
        await this.scope.audit(scope.tx, "safety.incident_updated", incidentId, {
          projectId,
          number: row.number,
          version: version + 1,
          fields: changedFields(input),
          people: input.people?.length ?? null,
          severity:
            input.severity && input.severity !== row.severity
              ? { from: row.severity, to: input.severity }
              : null,
        });
        return this.detail(scope, context, incidentId);
      },
      true,
    );
  }

  investigate(
    principal: Principal,
    projectId: string,
    incidentId: string,
    input: InvestigateIncidentRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.manager(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.loadOpen(scope, projectId, incidentId, input.version);
        // Saving the investigation unchanged keeps its author (the database refuses re-stamping).
        if (
          row.status === "investigated" &&
          row.rootCauseCategory === input.rootCauseCategory &&
          row.rootCause === input.rootCause &&
          row.contributingFactors === input.contributingFactors
        )
          return this.detail(scope, context, incidentId);
        const changed = await scope.tx.safetyIncident.updateMany({
          where: { tenantId, projectId, id: incidentId, version: input.version },
          data: {
            status: "investigated",
            rootCauseCategory: input.rootCauseCategory,
            rootCause: input.rootCause,
            contributingFactors: input.contributingFactors,
            investigatedBy: userId,
            updatedBy: userId,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(scope.tx, "safety.incident_investigated", incidentId, {
          projectId,
          number: row.number,
          from: row.status,
          rootCauseCategory: input.rootCauseCategory,
          revised: row.status === "investigated",
          version: input.version + 1,
        });
        return this.detail(scope, context, incidentId);
      },
      true,
    );
  }

  regulator(
    principal: Principal,
    projectId: string,
    incidentId: string,
    input: RegulatorDecisionRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.manager(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.loadOpen(scope, projectId, incidentId, input.version);
        if (input.notifiedOn) notFuture(input.notifiedOn);
        const notified = input.decision === "notified";
        const next = {
          regulatorDecision: input.decision,
          regulatorNotifiedOn: notified ? input.notifiedOn! : null,
          regulatorReference: notified ? (input.reference ?? null) : null,
          regulatorReason: notified ? null : input.reason!,
        };
        // Recording the same decision again keeps its author (the database refuses re-stamping).
        if (
          row.regulatorDecision === next.regulatorDecision &&
          (row.regulatorNotifiedOn ? toCalendarDate(row.regulatorNotifiedOn) : null) ===
            next.regulatorNotifiedOn &&
          row.regulatorReference === next.regulatorReference &&
          row.regulatorReason === next.regulatorReason
        )
          return this.detail(scope, context, incidentId);
        const changed = await scope.tx.safetyIncident.updateMany({
          where: { tenantId, projectId, id: incidentId, version: input.version },
          data: {
            regulatorDecision: input.decision,
            regulatorNotifiedOn: notified ? fromCalendarDate(input.notifiedOn!) : null,
            regulatorReference: notified ? (input.reference ?? null) : null,
            regulatorReason: notified ? null : input.reason!,
            regulatorDecidedBy: userId,
            updatedBy: userId,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(scope.tx, "safety.incident_regulator_decision", incidentId, {
          projectId,
          number: row.number,
          decision: input.decision,
          notifiedOn: input.notifiedOn ?? null,
          version: input.version + 1,
        });
        return this.detail(scope, context, incidentId);
      },
      true,
    );
  }

  close(
    principal: Principal,
    projectId: string,
    incidentId: string,
    input: CloseIncidentRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.manager(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.loadOpen(scope, projectId, incidentId, input.version);
        const actions = await scope.tx.correctiveAction.findMany({
          where: { tenantId, incidentId },
          select: { status: true },
        });
        const blockers = incidentCloseBlockers(
          {
            status: row.status as IncidentStatus,
            kind: row.kind as IncidentKind,
            severity: row.severity as IncidentSeverity,
            regulatorDecision: row.regulatorDecision as RegulatorDecision | null,
          },
          actions.map((action) => ({ status: action.status as CorrectiveActionStatus })),
          input.noActionReason,
        );
        if (blockers.length)
          throw safetyProblem(
            409,
            "incident-close-blocked",
            blockers.map((blocker) => blockerMessages[blocker]).join("; "),
            { blockers },
          );
        const verified = actions.some((action) => action.status === "verified");
        const changed = await scope.tx.safetyIncident.updateMany({
          where: { tenantId, projectId, id: incidentId, version: input.version },
          data: {
            status: "closed",
            closedBy: userId,
            closureNote: input.closureNote,
            // A reason for no action is kept only when no action was verified.
            noActionReason: verified ? null : input.noActionReason,
            updatedBy: userId,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(scope.tx, "safety.incident_closed", incidentId, {
          projectId,
          number: row.number,
          actions: actions.length,
          verifiedActions: actions.filter((action) => action.status === "verified").length,
          noActionReason: !verified,
          version: input.version + 1,
        });
        return this.detail(scope, context, incidentId);
      },
      true,
    );
  }

  void(
    principal: Principal,
    projectId: string,
    incidentId: string,
    input: VoidRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.manager(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.loadOpen(scope, projectId, incidentId, input.version);
        const outstanding = await scope.tx.correctiveAction.count({
          where: { tenantId, incidentId, status: { in: ["open", "done"] } },
        });
        if (outstanding)
          throw safetyProblem(
            409,
            "incident-actions-outstanding",
            "Cancel the open corrective actions before voiding",
          );
        const changed = await scope.tx.safetyIncident.updateMany({
          where: { tenantId, projectId, id: incidentId, version: input.version },
          data: {
            status: "voided",
            voidedBy: userId,
            voidReason: input.reason,
            updatedBy: userId,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(scope.tx, "safety.incident_voided", incidentId, {
          projectId,
          number: row.number,
          from: row.status,
          version: input.version + 1,
        });
        return this.detail(scope, context, incidentId);
      },
      true,
    );
  }

  addPhotos(
    principal: Principal,
    projectId: string,
    incidentId: string,
    input: AddIncidentPhotosRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.recorder(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.loadOpen(scope, projectId, incidentId, input.version);
        await requireSitePhotos(
          scope.tx,
          tenantId,
          projectId,
          row.siteId,
          input.photoIds,
          "safety_incident",
        );
        const existing = await scope.tx.safetyIncidentPhoto.findMany({
          where: { tenantId, incidentId },
          select: { photoId: true },
        });
        const known = new Set(existing.map((link) => link.photoId));
        const added = input.photoIds.filter((photoId) => !known.has(photoId));
        if (existing.length + added.length > 6)
          throw safetyProblem(409, "invalid-transition", "An incident holds at most six photos");
        const changed = await scope.tx.safetyIncident.updateMany({
          where: { tenantId, projectId, id: incidentId, version: input.version },
          data: { updatedBy: userId, version: { increment: 1 } },
        });
        if (changed.count !== 1) throw versionConflict();
        if (added.length)
          await scope.tx.safetyIncidentPhoto.createMany({
            data: added.map((photoId) => ({
              tenantId,
              projectId,
              incidentId,
              photoId,
              addedBy: userId,
            })),
          });
        await this.scope.audit(scope.tx, "safety.incident_photos_added", incidentId, {
          projectId,
          number: row.number,
          photos: added.length,
          version: input.version + 1,
        });
        return this.detail(scope, context, incidentId);
      },
      true,
    );
  }

  /** Labourers must be engaged on the project and staff must be company members. */
  private async checkPeople(scope: Scope, projectId: string, people: IncidentPersonInput[]) {
    const { tenantId } = scope.access;
    await requireProjectLabourers(
      scope.tx,
      tenantId,
      projectId,
      people.flatMap((person) => (person.labourerId ? [person.labourerId] : [])),
    );
    await requireCompanyUsers(
      scope.tx,
      tenantId,
      people.flatMap((person) => (person.userId ? [person.userId] : [])),
    );
  }

  private async writePeople(
    scope: Scope,
    projectId: string,
    incidentId: string,
    people: IncidentPersonInput[],
  ) {
    if (!people.length) return;
    const { tenantId, userId } = scope.access;
    await scope.tx.safetyIncidentPerson.createMany({
      data: people.map((person) => ({
        id: uuidv7(),
        tenantId,
        projectId,
        incidentId,
        role: person.role,
        labourerId: person.labourerId ?? null,
        userId: person.userId ?? null,
        name: person.name ?? null,
        injuryType: person.injuryType ?? null,
        bodyPart: person.bodyPart ?? null,
        addedBy: userId,
      })),
    });
  }

  /** An open incident at the version the caller read (closed and voided ones are locked). */
  private async loadOpen(
    scope: Scope,
    projectId: string,
    incidentId: string,
    version: number,
  ): Promise<IncidentRecord> {
    const row = await scope.tx.safetyIncident.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: incidentId },
    });
    if (!row) throw new NotFoundException("Incident not found");
    if (row.status === "closed" || row.status === "voided")
      throw safetyProblem(409, "incident-not-open", "Closed and voided incidents are locked");
    if (row.version !== version) throw versionConflict();
    return row;
  }

  async detail(scope: Scope, context: SafetyContext, incidentId: string) {
    const { tenantId } = scope.access;
    const row = await scope.tx.safetyIncident.findFirst({
      where: { tenantId, projectId: context.project.id, id: incidentId },
      include: incidentInclude,
    });
    if (!row) throw new NotFoundException("Incident not found");
    const [actions, treatments] = await Promise.all([
      scope.tx.correctiveAction.findMany({
        where: { tenantId, incidentId },
        include: actionInclude,
        orderBy: { number: "asc" },
      }),
      scope.tx.firstAidTreatment.findMany({
        where: { tenantId, incidentId },
        include: treatmentInclude,
        orderBy: { number: "asc" },
      }),
    ]);
    const [people, labourers] = await Promise.all([
      peopleOf(scope.tx, [
        ...incidentPeople(row),
        ...actions.flatMap(actionPeople),
        ...treatments.flatMap(treatmentPeople),
      ]),
      labourerRefs(scope.tx, tenantId, [
        ...incidentLabourers(row),
        ...treatments.flatMap(treatmentLabourers),
      ]),
    ]);
    return incidentDetailResponseSchema.parse({
      incident: toIncident(row, people, labourers, context),
      correctiveActions: actions.map((action) => toCorrectiveAction(action, people, context)),
      treatments: treatments.map((treatment) => toTreatment(treatment, people, labourers, context)),
    });
  }
}

/** Open incidents that need a regulator decision and have none yet. */
export const regulatorPendingWhere: Prisma.SafetyIncidentWhereInput = {
  status: { in: ["reported", "investigated"] },
  regulatorDecision: null,
  OR: [
    { kind: "dangerous_occurrence" },
    { kind: "injury", severity: { in: ["serious", "fatal"] } },
  ],
};
