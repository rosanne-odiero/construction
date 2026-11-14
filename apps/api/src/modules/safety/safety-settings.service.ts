import { Injectable } from "@nestjs/common";
import { addCalendarDays, certificateState, kitState, nairobiDate } from "@pm-buddy/domain";
import {
  SAFETY_READ_PERMISSIONS,
  SAFETY_RECORD_PERMISSIONS,
  SAFETY_WARNING_DAYS,
} from "@pm-buddy/types";
import {
  safetyOptionsResponseSchema,
  safetyOverviewResponseSchema,
  safetySettingsResponseSchema,
  safetySummaryResponseSchema,
  type UpdateSafetySettingsRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import type { Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import { kitNeedsAttention } from "./first-aid.service.js";
import { siteCoverage } from "./inductions.service.js";
import { regulatorPendingWhere } from "./incidents.service.js";
import {
  hasAny,
  projectStaff,
  SafetyAccess,
  safetySettings,
  versionConflict,
  type SafetySettingsValues,
} from "./safety-access.js";
import { kitInclude } from "./safety-mappers.js";

/**
 * Company safety settings (config.manage to change; any safety reader may read them), a project's
 * health and safety summary and form options, and the company overview across projects.
 */
@Injectable()
export class SafetySettingsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
    private readonly safety: SafetyAccess,
  ) {}

  getSettings(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const canEdit = scope.access.permissions.has("config.manage");
      if (!canEdit) {
        let reader = false;
        for (const permission of SAFETY_READ_PERMISSIONS)
          reader ||= await this.policy.holdsSomewhere(scope, permission);
        if (!reader) await this.policy.require(scope, "config.manage");
      }
      return this.settingsResponse(await safetySettings(scope.tx, scope.access.tenantId), canEdit);
    });
  }

  updateSettings(principal: Principal, input: UpdateSafetySettingsRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.policy.require(scope, "config.manage");
        const { tenantId, userId } = scope.access;
        const current = await scope.tx.safetySettings.findUnique({ where: { tenantId } });
        if ((current?.version ?? 0) !== input.version) throw versionConflict();
        const values = {
          inductionTopics: input.inductionTopics,
          inductionValidityDays: input.inductionValidityDays,
          inductionLookbackDays: input.inductionLookbackDays,
          kitCheckIntervalDays: input.kitCheckIntervalDays,
          ppeReplacementDays: input.ppeReplacementDays,
          updatedBy: userId,
        };
        if (current) {
          const changed = await scope.tx.safetySettings.updateMany({
            where: { tenantId, version: input.version },
            data: { ...values, version: { increment: 1 } },
          });
          if (changed.count !== 1) throw versionConflict();
        } else {
          await scope.tx.safetySettings.create({ data: { tenantId, ...values } });
        }
        // Counts and numbers only: topic wording is company text and stays out of the audit log.
        await this.scope.audit(scope.tx, "safety.settings_updated", tenantId, {
          inductionTopics: input.inductionTopics.length,
          inductionValidityDays: input.inductionValidityDays,
          inductionLookbackDays: input.inductionLookbackDays,
          kitCheckIntervalDays: input.kitCheckIntervalDays,
          ppeReplacementDays: input.ppeReplacementDays,
          version: input.version + 1,
        });
        return this.settingsResponse(await safetySettings(scope.tx, tenantId), true);
      },
      true,
    );
  }

  summary(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.safety.load(scope, projectId);
      const counts = await this.counts(scope, projectId);
      return safetySummaryResponseSchema.parse({
        ...counts,
        permissions: {
          canRecord: context.canRecord,
          canManage: context.canManage,
          canSeePersonal: context.canSeePersonal,
        },
      });
    });
  }

  options(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.safety.load(scope, projectId);
      const { tenantId } = scope.access;
      const [staff, gangs, settings] = await Promise.all([
        projectStaff(scope, projectId),
        scope.tx.gang.findMany({
          where: { tenantId, projectId, status: "active" },
          select: {
            id: true,
            name: true,
            siteId: true,
            _count: { select: { members: { where: { leftOn: null } } } },
          },
          orderBy: { name: "asc" },
        }),
        safetySettings(scope.tx, tenantId),
      ]);
      return safetyOptionsResponseSchema.parse({
        staff: staff
          .map((member) => ({
            id: member.id,
            displayName: member.displayName,
            canRecord: hasAny(member.effective, SAFETY_RECORD_PERMISSIONS),
            canManage: member.effective.has("safety.manage"),
          }))
          .sort((a, b) => a.displayName.localeCompare(b.displayName)),
        gangs: gangs.map((gang) => ({
          id: gang.id,
          name: gang.name,
          siteId: gang.siteId,
          members: gang._count.members,
        })),
        inductionTopics: settings.inductionTopics,
      });
    });
  }

  /** Projects the caller can read safety records on, with their headline counts. */
  overview(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const candidates = await scope.tx.project.findMany({
        where: {
          AND: [
            this.policy.projectWhere(scope, "projects.view"),
            { OR: SAFETY_READ_PERMISSIONS.map((key) => this.policy.projectWhere(scope, key)) },
          ],
        },
        select: { id: true, code: true, name: true, status: true },
        orderBy: { code: "asc" },
      });
      const projects = [];
      for (const project of candidates) {
        const counts = await this.counts(scope, project.id);
        projects.push({
          ...project,
          openIncidents: counts.incidents.reported + counts.incidents.investigated,
          overdueActions: counts.actions.overdue,
          flaggedLabourers: counts.inductions.flagged,
          ppeDue: counts.ppe.due,
          kitsAttention: counts.firstAid.kitsAttention,
        });
      }
      return safetyOverviewResponseSchema.parse({ projects });
    });
  }

  /** The headline counts of one project (summary and overview). */
  private async counts(scope: Scope, projectId: string) {
    const { tx, access } = scope;
    const tenantId = access.tenantId;
    const scoped = { tenantId, projectId };
    const settings = await safetySettings(tx, tenantId);
    const today = nairobiDate();
    const day = (offset: number) => fromCalendarDate(addCalendarDays(today, offset));
    const since90 = new Date(`${addCalendarDays(today, -89)}T00:00:00+03:00`);
    const incidentWhere = (extra: Prisma.SafetyIncidentWhereInput) => ({ ...scoped, ...extra });
    const [
      reported,
      investigated,
      regulatorPending,
      last90Days,
      nearMisses,
      open,
      overdue,
      awaiting,
      draftTalks,
      recentTalks,
      ppeDue,
      ppeSoon,
      kits,
      aiders,
    ] = await Promise.all([
      tx.safetyIncident.count({ where: incidentWhere({ status: "reported" }) }),
      tx.safetyIncident.count({ where: incidentWhere({ status: "investigated" }) }),
      tx.safetyIncident.count({ where: incidentWhere(regulatorPendingWhere) }),
      tx.safetyIncident.count({
        where: incidentWhere({ status: { not: "voided" }, occurredAt: { gte: since90 } }),
      }),
      tx.safetyIncident.count({
        where: incidentWhere({
          status: { not: "voided" },
          kind: "near_miss",
          occurredAt: { gte: since90 },
        }),
      }),
      tx.correctiveAction.count({ where: { ...scoped, status: "open" } }),
      tx.correctiveAction.count({ where: { ...scoped, status: "open", dueOn: { lt: day(0) } } }),
      tx.correctiveAction.count({ where: { ...scoped, status: "done" } }),
      tx.toolboxTalk.count({ where: { ...scoped, status: "draft" } }),
      tx.toolboxTalk.count({
        where: { ...scoped, status: "confirmed", heldOn: { gte: day(-29) } },
      }),
      tx.ppeIssue.count({
        where: { ...scoped, status: "issued", replacementDueOn: { lte: day(0) } },
      }),
      tx.ppeIssue.count({
        where: {
          ...scoped,
          status: "issued",
          replacementDueOn: { gt: day(0), lte: day(SAFETY_WARNING_DAYS.ppe) },
        },
      }),
      tx.firstAidKit.findMany({ where: { ...scoped, status: "active" }, include: kitInclude }),
      tx.firstAider.findMany({
        where: { ...scoped, status: "active" },
        select: { certificateExpiresOn: true },
      }),
    ]);
    const coverage = await siteCoverage(
      tx,
      tenantId,
      projectId,
      null,
      addCalendarDays(today, -(settings.inductionLookbackDays - 1)),
      today,
      settings.inductionValidityDays,
    );
    const flagged = new Set(coverage.filter((row) => row.flagged).map((row) => row.labourer.id))
      .size;
    return {
      incidents: {
        reported,
        investigated,
        regulatorPending,
        last90Days,
        nearMissesLast90Days: nearMisses,
      },
      actions: { open, overdue, awaitingVerification: awaiting },
      inductions: { flagged, lookbackDays: settings.inductionLookbackDays },
      talks: { draft: draftTalks, last30Days: recentTalks },
      ppe: { due: ppeDue, dueSoon: ppeSoon },
      firstAid: {
        kitsAttention: kits.filter((kit) => {
          const last = kit.checks[0] ?? null;
          return kitNeedsAttention(
            kitState(
              {
                status: "active",
                lastCheckedOn: last ? toCalendarDate(last.checkedOn) : null,
                expiresOn: last?.expiresOn ? toCalendarDate(last.expiresOn) : null,
              },
              settings.kitCheckIntervalDays,
              today,
            ),
          );
        }).length,
        certificatesExpired: aiders.filter(
          (aider) =>
            certificateState(toCalendarDate(aider.certificateExpiresOn), today) === "expired",
        ).length,
      },
    };
  }

  private settingsResponse(settings: SafetySettingsValues, canEdit: boolean) {
    return safetySettingsResponseSchema.parse({
      settings: {
        inductionTopics: settings.inductionTopics,
        inductionValidityDays: settings.inductionValidityDays,
        inductionLookbackDays: settings.inductionLookbackDays,
        kitCheckIntervalDays: settings.kitCheckIntervalDays,
        ppeReplacementDays: settings.ppeReplacementDays,
        version: settings.version,
        updatedAt: settings.updatedAt?.toISOString() ?? null,
        permissions: { canEdit },
      },
    });
  }
}
