import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { isPlantClosed, nairobiDate, operatorCertificateState } from "@pm-buddy/domain";
import { PLANT_LIMITS, type PlantCategory, type PlantStatus } from "@pm-buddy/types";
import type { AssignOperatorRequest } from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  lockPlant,
  PlantAccess,
  plantProblem,
  plantSettings,
  versionConflict,
} from "./plant-access.js";
import { optionalDate } from "./plant-model.js";
import { PlantRegisterService } from "./plant-register.service.js";

/**
 * Operator assignments (D8.3): a labourer engaged on the project or a staff member, for a period,
 * with the certificate the category may need (flagged, never blocking; COMPLIANCE-REVIEW
 * CR-PLT-01). Assigned and ended by plant.manage on the project.
 */
@Injectable()
export class PlantOperatorsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly plant: PlantAccess,
    private readonly register: PlantRegisterService,
  ) {}

  assign(principal: Principal, plantId: string, input: AssignOperatorRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.plant.reader(scope);
        const { tx, access } = scope;
        await lockPlant(tx, access.tenantId, plantId);
        const item = await this.register.itemRow(scope, plantId);
        if (isPlantClosed(item.status as PlantStatus))
          throw plantProblem(409, "plant-closed", "Off-hired and disposed plant is final");
        if (!caller.projects.has(input.projectId) && !caller.tenantWide)
          throw new NotFoundException("Project not found");
        if (!caller.canManage(input.projectId)) {
          if (caller.holdsManage(input.projectId))
            throw plantProblem(
              409,
              "project-read-only",
              "Closed and cancelled projects are read-only",
            );
          throw new ForbiddenException("Permission required: plant.manage");
        }
        if (input.kind === "labourer") {
          const engaged = await tx.labourEngagement.count({
            where: {
              tenantId: access.tenantId,
              projectId: input.projectId,
              labourerId: input.labourerId!,
            },
          });
          if (!engaged)
            throw plantProblem(
              422,
              "labourer-not-on-project",
              "The labourer is not engaged on this project",
            );
        } else {
          const member = await tx.membership.count({
            where: { tenantId: access.tenantId, userId: input.userId! },
          });
          if (!member)
            throw plantProblem(
              422,
              "person-not-in-company",
              "This person is not a member of the company",
            );
        }
        const others = await tx.plantOperator.findMany({
          where: {
            tenantId: access.tenantId,
            plantId,
            labourerId: input.labourerId ?? null,
            userId: input.userId ?? null,
          },
          select: { fromOn: true, toOn: true },
        });
        const end = input.toOn ?? "9999-12-31";
        if (
          others.some(
            (row) =>
              toCalendarDate(row.fromOn) <= end &&
              (row.toOn === null || toCalendarDate(row.toOn) >= input.fromOn),
          )
        )
          throw plantProblem(
            409,
            "operator-overlap",
            "This operator is already assigned for that period",
          );
        const id = uuidv7();
        await tx.plantOperator.create({
          data: {
            id,
            tenantId: access.tenantId,
            plantId,
            projectId: input.projectId,
            kind: input.kind,
            labourerId: input.labourerId ?? null,
            userId: input.userId ?? null,
            fromOn: fromCalendarDate(input.fromOn),
            toOn: input.toOn ? fromCalendarDate(input.toOn) : null,
            certificateRef: input.certificateRef ?? null,
            certificateExpiresOn: input.certificateExpiresOn
              ? fromCalendarDate(input.certificateExpiresOn)
              : null,
            assignedBy: access.userId,
          },
        });
        const settings = await plantSettings(tx, access.tenantId);
        const state = operatorCertificateState({
          category: item.category as PlantCategory,
          requiredCategories: settings.certificateCategories,
          certificateRef: input.certificateRef ?? null,
          expiresOn: input.certificateExpiresOn ?? null,
          today: nairobiDate(),
          warningDays: PLANT_LIMITS.certificateWarningDays,
        });
        await this.scope.audit(tx, "plant.operator_assigned", id, {
          plantId,
          code: item.code,
          projectId: input.projectId,
          kind: input.kind,
          labourerId: input.labourerId ?? null,
          userId: input.userId ?? null,
          certificateState: state,
        });
        return this.register.detailResponse(scope, caller, plantId);
      },
      true,
    );
  }

  end(
    principal: Principal,
    plantId: string,
    assignmentId: string,
    input: { version: number; toOn: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.plant.reader(scope);
        const { tx, access } = scope;
        await lockPlant(tx, access.tenantId, plantId);
        const row = await tx.plantOperator.findFirst({
          where: { tenantId: access.tenantId, plantId, id: assignmentId },
        });
        if (!row || !caller.canRead(row.projectId))
          throw new NotFoundException("Operator assignment not found");
        if (!caller.holdsManage(row.projectId))
          throw new ForbiddenException("Permission required: plant.manage");
        if (row.endedBy !== null)
          throw plantProblem(409, "invalid-transition", "This assignment has already ended");
        if (row.version !== input.version) throw versionConflict();
        const fromOn = toCalendarDate(row.fromOn);
        const toOn = optionalDate(row.toOn);
        if (input.toOn < fromOn || (toOn !== null && input.toOn > toOn))
          throw plantProblem(
            409,
            "invalid-transition",
            "An assignment ends on or after its start and not after its planned end",
          );
        const changed = await tx.plantOperator.updateMany({
          where: { tenantId: access.tenantId, id: assignmentId, version: input.version },
          data: {
            toOn: fromCalendarDate(input.toOn),
            endedBy: access.userId,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(tx, "plant.operator_ended", assignmentId, {
          plantId,
          projectId: row.projectId,
          version: input.version + 1,
        });
        return this.register.detailResponse(scope, caller, plantId);
      },
      true,
    );
  }
}
