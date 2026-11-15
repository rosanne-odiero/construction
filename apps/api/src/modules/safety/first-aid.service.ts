import { Injectable, NotFoundException } from "@nestjs/common";
import { addCalendarDays, certificateState, kitState, nairobiDate } from "@pm-buddy/domain";
import {
  firstAiderResponseSchema,
  firstAidKitResponseSchema,
  firstAidResponseSchema,
  treatmentResponseSchema,
  type AddFirstAiderRequest,
  type CreateFirstAidKitRequest,
  type FirstAidQuery,
  type LinkTreatmentRequest,
  type RecordKitCheckRequest,
  type RecordTreatmentRequest,
  type VoidRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { peopleOf } from "../procurement/procurement-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  labourerRefs,
  lockProject,
  notFuture,
  notFutureMoment,
  requireCompanyUsers,
  requireProjectLabourers,
  requireSite,
  SafetyAccess,
  safetyProblem,
  safetySettings,
  versionConflict,
  type SafetyContext,
} from "./safety-access.js";
import {
  firstAiderInclude,
  kitInclude,
  kitPeople,
  toFirstAider,
  toKit,
  toTreatment,
  treatmentInclude,
  treatmentLabourers,
  treatmentPeople,
} from "./safety-mappers.js";

/**
 * First aid (D8.2): kits per site with append-only checks (outcome and earliest expiry), trained
 * first-aiders per site with their certificate expiry, and treatments (coded injury, treatment and
 * referral; optionally linked to an open incident). Treatments are voided with a reason, never
 * edited; who was treated and how is shown only to safety.manage holders (decision D-74).
 */
@Injectable()
export class FirstAidService {
  constructor(
    private readonly scope: TenantScope,
    private readonly safety: SafetyAccess,
  ) {}

  overview(principal: Principal, projectId: string, query: FirstAidQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.safety.load(scope, projectId);
      const { tenantId } = scope.access;
      const site = query.siteId ? { siteId: query.siteId } : {};
      const scoped = { tenantId, projectId, ...site };
      const settings = await safetySettings(scope.tx, tenantId);
      const today = nairobiDate();
      const [kits, aiders, treatments, recent] = await Promise.all([
        scope.tx.firstAidKit.findMany({
          where: scoped,
          include: kitInclude,
          orderBy: [{ status: "asc" }, { label: "asc" }],
        }),
        scope.tx.firstAider.findMany({
          where: { ...scoped, status: "active" },
          include: firstAiderInclude,
          orderBy: { certificateExpiresOn: "asc" },
        }),
        scope.tx.firstAidTreatment.findMany({
          where: { ...scoped, ...(query.cursor ? { number: { lt: query.cursor } } : {}) },
          include: treatmentInclude,
          orderBy: { number: "desc" },
          take: query.limit + 1,
        }),
        scope.tx.firstAidTreatment.count({
          where: {
            ...scoped,
            status: "recorded",
            treatedAt: { gte: new Date(`${addCalendarDays(today, -29)}T00:00:00+03:00`) },
          },
        }),
      ]);
      const page = treatments.slice(0, query.limit);
      const [people, labourers] = await Promise.all([
        peopleOf(scope.tx, [
          ...kits.flatMap(kitPeople),
          ...aiders.map((aider) => aider.userId),
          ...page.flatMap(treatmentPeople),
        ]),
        labourerRefs(scope.tx, tenantId, [
          ...aiders.map((aider) => aider.labourerId),
          ...page.flatMap(treatmentLabourers),
        ]),
      ]);
      const kitRows = kits.map((kit) => toKit(kit, people, context, settings.kitCheckIntervalDays));
      return firstAidResponseSchema.parse({
        kits: kitRows,
        firstAiders: aiders.map((aider) => toFirstAider(aider, people, labourers, context)),
        treatments: page.map((row) => toTreatment(row, people, labourers, context)),
        nextCursor: treatments.length > query.limit ? page.at(-1)!.number : null,
        kitCheckIntervalDays: settings.kitCheckIntervalDays,
        counts: {
          kitsAttention: kitRows.filter((kit) => kitNeedsAttention(kit.state)).length,
          certificatesExpired: aiders.filter(
            (aider) =>
              certificateState(toCalendarDate(aider.certificateExpiresOn), today) === "expired",
          ).length,
          treatmentsLast30Days: recent,
        },
        permissions: {
          canRecord: context.canRecord,
          canManage: context.canManage,
          canSeePersonal: context.canSeePersonal,
        },
      });
    });
  }

  createKit(
    principal: Principal,
    projectId: string,
    input: CreateFirstAidKitRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.manager(scope, projectId);
        const { tenantId, userId } = scope.access;
        await requireSite(scope.tx, tenantId, projectId, input.siteId);
        const taken = await scope.tx.firstAidKit.findFirst({
          where: { tenantId, siteId: input.siteId, label: input.label },
          select: { id: true },
        });
        if (taken)
          throw safetyProblem(409, "kit-label-taken", "This site already has a kit with that name");
        const id = uuidv7();
        await scope.tx.firstAidKit.create({
          data: {
            id,
            tenantId,
            projectId,
            siteId: input.siteId,
            label: input.label,
            location: input.location,
            createdBy: userId,
            updatedBy: userId,
          },
        });
        await this.scope.audit(scope.tx, "safety.kit_added", id, {
          projectId,
          siteId: input.siteId,
        });
        return this.kit(scope, context, id);
      },
      true,
    );
  }

  checkKit(
    principal: Principal,
    projectId: string,
    kitId: string,
    input: RecordKitCheckRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.recorder(scope, projectId);
        const { tenantId, userId } = scope.access;
        const kit = await scope.tx.firstAidKit.findFirst({
          where: { tenantId, projectId, id: kitId },
          select: { status: true },
        });
        if (!kit) throw new NotFoundException("First-aid kit not found");
        if (kit.status !== "active")
          throw safetyProblem(409, "kit-retired", "A retired kit is no longer checked");
        notFuture(input.checkedOn);
        const id = uuidv7();
        await scope.tx.firstAidKitCheck.create({
          data: {
            id,
            tenantId,
            projectId,
            kitId,
            checkedOn: fromCalendarDate(input.checkedOn),
            outcome: input.outcome,
            expiresOn: input.expiresOn ? fromCalendarDate(input.expiresOn) : null,
            notes: input.notes,
            checkedBy: userId,
          },
        });
        await this.scope.audit(scope.tx, "safety.kit_checked", kitId, {
          projectId,
          checkId: id,
          checkedOn: input.checkedOn,
          outcome: input.outcome,
          expiresOn: input.expiresOn,
        });
        return this.kit(scope, context, kitId);
      },
      true,
    );
  }

  retireKit(
    principal: Principal,
    projectId: string,
    kitId: string,
    input: VoidRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.manager(scope, projectId);
        const { tenantId, userId } = scope.access;
        const kit = await scope.tx.firstAidKit.findFirst({
          where: { tenantId, projectId, id: kitId },
        });
        if (!kit) throw new NotFoundException("First-aid kit not found");
        if (kit.status !== "active")
          throw safetyProblem(409, "kit-retired", "This kit is already retired");
        const changed = await scope.tx.firstAidKit.updateMany({
          where: { tenantId, projectId, id: kitId, version: input.version },
          data: {
            status: "retired",
            retiredBy: userId,
            retiredReason: input.reason,
            updatedBy: userId,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(scope.tx, "safety.kit_retired", kitId, {
          projectId,
          version: input.version + 1,
        });
        return this.kit(scope, context, kitId);
      },
      true,
    );
  }

  addFirstAider(
    principal: Principal,
    projectId: string,
    input: AddFirstAiderRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.manager(scope, projectId);
        const { tenantId, userId } = scope.access;
        await requireSite(scope.tx, tenantId, projectId, input.siteId);
        if (input.labourerId)
          await requireProjectLabourers(scope.tx, tenantId, projectId, [input.labourerId]);
        if (input.userId) await requireCompanyUsers(scope.tx, tenantId, [input.userId]);
        const existing = await scope.tx.firstAider.findFirst({
          where: {
            tenantId,
            siteId: input.siteId,
            status: "active",
            ...(input.labourerId ? { labourerId: input.labourerId } : { userId: input.userId }),
          },
          select: { id: true },
        });
        if (existing)
          throw safetyProblem(
            409,
            "first-aider-exists",
            "This person is already a first-aider at the site",
          );
        const id = uuidv7();
        await scope.tx.firstAider.create({
          data: {
            id,
            tenantId,
            projectId,
            siteId: input.siteId,
            labourerId: input.labourerId ?? null,
            userId: input.userId ?? null,
            certificateExpiresOn: fromCalendarDate(input.certificateExpiresOn),
            certificateReference: input.certificateReference,
            createdBy: userId,
            updatedBy: userId,
          },
        });
        await this.scope.audit(scope.tx, "safety.first_aider_added", id, {
          projectId,
          siteId: input.siteId,
          labourerId: input.labourerId ?? null,
          userId: input.userId ?? null,
          certificateExpiresOn: input.certificateExpiresOn,
        });
        return this.firstAider(scope, context, id);
      },
      true,
    );
  }

  removeFirstAider(
    principal: Principal,
    projectId: string,
    firstAiderId: string,
    input: VoidRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.manager(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await scope.tx.firstAider.findFirst({
          where: { tenantId, projectId, id: firstAiderId },
        });
        if (!row) throw new NotFoundException("First-aider not found");
        if (row.status !== "active")
          throw safetyProblem(409, "invalid-transition", "This first-aider was already removed");
        const changed = await scope.tx.firstAider.updateMany({
          where: { tenantId, projectId, id: firstAiderId, version: input.version },
          data: {
            status: "removed",
            removedBy: userId,
            removedReason: input.reason,
            updatedBy: userId,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(scope.tx, "safety.first_aider_removed", firstAiderId, {
          projectId,
          version: input.version + 1,
        });
        return this.firstAider(scope, context, firstAiderId);
      },
      true,
    );
  }

  recordTreatment(
    principal: Principal,
    projectId: string,
    input: RecordTreatmentRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.recorder(scope, projectId);
        const { tenantId, userId } = scope.access;
        await requireSite(scope.tx, tenantId, projectId, input.siteId);
        notFutureMoment(input.treatedAt);
        if (input.labourerId)
          await requireProjectLabourers(scope.tx, tenantId, projectId, [input.labourerId]);
        if (input.firstAiderId) {
          const aider = await scope.tx.firstAider.findFirst({
            where: { tenantId, projectId, id: input.firstAiderId },
            select: { siteId: true, status: true },
          });
          if (!aider || aider.siteId !== input.siteId || aider.status !== "active")
            throw safetyProblem(
              422,
              "first-aider-not-on-site",
              "The first-aider must be one of the site's",
            );
        }
        if (input.incidentId) await this.requireOpenIncident(scope, projectId, input.incidentId);
        await lockProject(scope.tx, tenantId, projectId);
        const latest = await scope.tx.firstAidTreatment.findFirst({
          where: { tenantId, projectId },
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const id = uuidv7();
        const number = (latest?.number ?? 0) + 1;
        await scope.tx.firstAidTreatment.create({
          data: {
            id,
            tenantId,
            projectId,
            siteId: input.siteId,
            number,
            treatedAt: new Date(input.treatedAt),
            labourerId: input.labourerId ?? null,
            personName: input.personName ?? null,
            injuryType: input.injuryType,
            treatment: input.treatment,
            referral: input.referral,
            firstAiderId: input.firstAiderId ?? null,
            incidentId: input.incidentId ?? null,
            recordedBy: userId,
            updatedBy: userId,
          },
        });
        // No names, injuries or treatments in the audit log: references and the referral only.
        await this.scope.audit(scope.tx, "safety.treatment_recorded", id, {
          projectId,
          siteId: input.siteId,
          number,
          referral: input.referral,
          incidentId: input.incidentId ?? null,
        });
        return this.treatment(scope, context, id);
      },
      true,
    );
  }

  voidTreatment(
    principal: Principal,
    projectId: string,
    treatmentId: string,
    input: VoidRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.manager(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.loadTreatment(scope, projectId, treatmentId, input.version);
        const changed = await scope.tx.firstAidTreatment.updateMany({
          where: { tenantId, projectId, id: treatmentId, version: input.version },
          data: {
            status: "voided",
            voidedBy: userId,
            voidReason: input.reason,
            updatedBy: userId,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(scope.tx, "safety.treatment_voided", treatmentId, {
          projectId,
          number: row.number,
          version: input.version + 1,
        });
        return this.treatment(scope, context, treatmentId);
      },
      true,
    );
  }

  linkTreatment(
    principal: Principal,
    projectId: string,
    treatmentId: string,
    input: LinkTreatmentRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.manager(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.loadTreatment(scope, projectId, treatmentId, input.version);
        if (row.incidentId)
          throw safetyProblem(409, "treatment-linked", "This treatment is already linked");
        await this.requireOpenIncident(scope, projectId, input.incidentId);
        const changed = await scope.tx.firstAidTreatment.updateMany({
          where: { tenantId, projectId, id: treatmentId, version: input.version },
          data: { incidentId: input.incidentId, updatedBy: userId, version: { increment: 1 } },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(scope.tx, "safety.treatment_linked", treatmentId, {
          projectId,
          number: row.number,
          incidentId: input.incidentId,
          version: input.version + 1,
        });
        return this.treatment(scope, context, treatmentId);
      },
      true,
    );
  }

  private async requireOpenIncident(scope: Scope, projectId: string, incidentId: string) {
    const incident = await scope.tx.safetyIncident.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: incidentId },
      select: { status: true },
    });
    if (!incident) throw new NotFoundException("Incident not found");
    if (incident.status !== "reported" && incident.status !== "investigated")
      throw safetyProblem(409, "incident-not-open", "Closed and voided incidents are locked");
  }

  /** A recorded treatment whose incident (if any) is still open, at the version read. */
  private async loadTreatment(
    scope: Scope,
    projectId: string,
    treatmentId: string,
    version: number,
  ) {
    const row = await scope.tx.firstAidTreatment.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: treatmentId },
      include: { incident: { select: { status: true } } },
    });
    if (!row) throw new NotFoundException("Treatment not found");
    if (row.status !== "recorded")
      throw safetyProblem(409, "invalid-transition", "This treatment is voided");
    if (
      row.incident &&
      row.incident.status !== "reported" &&
      row.incident.status !== "investigated"
    )
      throw safetyProblem(409, "incident-not-open", "Closed and voided incidents are locked");
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private async kit(scope: Scope, context: SafetyContext, kitId: string) {
    const { tenantId } = scope.access;
    const [row, settings] = await Promise.all([
      scope.tx.firstAidKit.findFirst({
        where: { tenantId, projectId: context.project.id, id: kitId },
        include: kitInclude,
      }),
      safetySettings(scope.tx, tenantId),
    ]);
    if (!row) throw new NotFoundException("First-aid kit not found");
    const people = await peopleOf(scope.tx, kitPeople(row));
    return firstAidKitResponseSchema.parse({
      kit: toKit(row, people, context, settings.kitCheckIntervalDays),
    });
  }

  private async firstAider(scope: Scope, context: SafetyContext, firstAiderId: string) {
    const { tenantId } = scope.access;
    const row = await scope.tx.firstAider.findFirst({
      where: { tenantId, projectId: context.project.id, id: firstAiderId },
      include: firstAiderInclude,
    });
    if (!row) throw new NotFoundException("First-aider not found");
    const [people, labourers] = await Promise.all([
      peopleOf(scope.tx, [row.userId]),
      labourerRefs(scope.tx, tenantId, [row.labourerId]),
    ]);
    return firstAiderResponseSchema.parse({
      firstAider: toFirstAider(row, people, labourers, context),
    });
  }

  private async treatment(scope: Scope, context: SafetyContext, treatmentId: string) {
    const { tenantId } = scope.access;
    const row = await scope.tx.firstAidTreatment.findFirst({
      where: { tenantId, projectId: context.project.id, id: treatmentId },
      include: treatmentInclude,
    });
    if (!row) throw new NotFoundException("Treatment not found");
    const [people, labourers] = await Promise.all([
      peopleOf(scope.tx, treatmentPeople(row)),
      labourerRefs(scope.tx, tenantId, treatmentLabourers(row)),
    ]);
    return treatmentResponseSchema.parse({
      treatment: toTreatment(row, people, labourers, context),
    });
  }
}

/** Kits that need someone's attention: never checked, check overdue, expired or expiring. */
export const kitNeedsAttention = (state: ReturnType<typeof kitState>) =>
  state === "never_checked" || state === "check_due" || state === "expired" || state === "expiring";
