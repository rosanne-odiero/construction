import { Injectable } from "@nestjs/common";
import { nairobiDate } from "@pm-buddy/domain";
import { QUALITY_READ_PERMISSIONS } from "@pm-buddy/types";
import {
  qualitySettingsResponseSchema,
  qualitySummaryResponseSchema,
  type UpdateQualitySettingsRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { AccessPolicy } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import { ConcreteService } from "./concrete.service.js";
import { QualityAccess, qualitySettings, versionConflict } from "./quality-access.js";

/** Company quality settings (config.manage) and a project's quality summary. */
@Injectable()
export class QualitySettingsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
    private readonly quality: QualityAccess,
    private readonly concrete: ConcreteService,
  ) {}

  getSettings(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const canEdit = scope.access.permissions.has("config.manage");
      if (!canEdit) {
        let reader = false;
        for (const permission of QUALITY_READ_PERMISSIONS)
          reader ||= await this.policy.holdsSomewhere(scope, permission);
        if (!reader) await this.policy.require(scope, "config.manage");
      }
      const settings = await qualitySettings(scope.tx, scope.access.tenantId);
      return qualitySettingsResponseSchema.parse({
        settings: {
          dlpMonths: settings.dlpMonths,
          cubeOverdueGraceDays: settings.cubeOverdueGraceDays,
          version: settings.version,
          updatedAt: settings.updatedAt?.toISOString() ?? null,
          permissions: { canEdit },
        },
      });
    });
  }

  updateSettings(principal: Principal, input: UpdateQualitySettingsRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.policy.require(scope, "config.manage");
        const { tenantId, userId } = scope.access;
        const current = await scope.tx.qualitySettings.findUnique({ where: { tenantId } });
        if ((current?.version ?? 0) !== input.version) throw versionConflict();
        const values = {
          dlpMonths: input.dlpMonths,
          cubeOverdueGraceDays: input.cubeOverdueGraceDays,
          updatedBy: userId,
        };
        if (current) {
          const changed = await scope.tx.qualitySettings.updateMany({
            where: { tenantId, version: input.version },
            data: { ...values, version: { increment: 1 } },
          });
          if (changed.count !== 1) throw versionConflict();
        } else {
          await scope.tx.qualitySettings.create({ data: { tenantId, ...values } });
        }
        await this.scope.audit(scope.tx, "quality.settings_updated", tenantId, {
          dlpMonths: input.dlpMonths,
          cubeOverdueGraceDays: input.cubeOverdueGraceDays,
          version: input.version + 1,
        });
        const settings = await qualitySettings(scope.tx, tenantId);
        return qualitySettingsResponseSchema.parse({
          settings: {
            dlpMonths: settings.dlpMonths,
            cubeOverdueGraceDays: settings.cubeOverdueGraceDays,
            version: settings.version,
            updatedAt: settings.updatedAt?.toISOString() ?? null,
            permissions: { canEdit: true },
          },
        });
      },
      true,
    );
  }

  summary(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.quality.load(scope, projectId);
      const { tenantId } = scope.access;
      const scoped = { tenantId, projectId };
      const { cubeOverdueGraceDays } = await qualitySettings(scope.tx, tenantId);
      const today = fromCalendarDate(nairobiDate());
      const [
        draft,
        submitted,
        signedOff,
        failed,
        cubesOverdue,
        cubesFailed,
        slumpFailed,
        open,
        fixed,
        openCritical,
        overdue,
        completions,
      ] = await Promise.all([
        scope.tx.inspection.count({ where: { ...scoped, status: "draft" } }),
        scope.tx.inspection.count({ where: { ...scoped, status: "submitted" } }),
        scope.tx.inspection.count({ where: { ...scoped, status: "signed_off" } }),
        scope.tx.inspection.count({ where: { ...scoped, result: "fail" } }),
        scope.tx.cubeSet.count({
          where: { ...scoped, ...this.concrete.overdueWhere(cubeOverdueGraceDays) },
        }),
        scope.tx.cubeSet.count({
          where: {
            ...scoped,
            results: { some: { ageDays: 28, outcome: "fail", supersededBy: { is: null } } },
          },
        }),
        scope.tx.slumpTest.count({
          where: { ...scoped, outcome: "fail", supersededBy: { is: null } },
        }),
        scope.tx.snag.count({ where: { ...scoped, status: "open" } }),
        scope.tx.snag.count({ where: { ...scoped, status: "fixed" } }),
        scope.tx.snag.count({
          where: { ...scoped, status: { not: "closed" }, severity: "critical" },
        }),
        scope.tx.snag.count({ where: { ...scoped, status: "open", dueOn: { lt: today } } }),
        scope.tx.projectCompletion.findMany({
          where: { ...scoped, status: { not: "withdrawn" } },
          select: { kind: true, status: true, dlpEndsOn: true },
        }),
      ]);
      const practical = completions.find((row) => row.kind === "practical");
      const final = completions.find((row) => row.kind === "final");
      return qualitySummaryResponseSchema.parse({
        inspections: { draft, submitted, signedOff, failed },
        cubes: { overdue: cubesOverdue, failed: cubesFailed },
        slumpFailed,
        snags: { open, fixed, openCritical, overdue },
        completion: {
          practical: practical?.status ?? null,
          final: final?.status ?? null,
          dlpEndsOn:
            practical?.status === "certified" && practical.dlpEndsOn
              ? toCalendarDate(practical.dlpEndsOn)
              : null,
        },
      });
    });
  }
}
