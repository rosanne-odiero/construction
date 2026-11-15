import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  breakdownBlocks,
  breakdownResolutionAllowed,
  checkMeterReading,
  isPlantClosed,
  parseTenths,
  plantBusinessDate,
} from "@pm-buddy/domain";
import {
  PLANT_LIMITS,
  type BreakdownSeverity,
  type PlantOwnership,
  type PlantStatus,
} from "@pm-buddy/types";
import type {
  RecordServiceRequest,
  ReportBreakdownRequest,
  ResolveBreakdownRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  breakdownCode,
  lockPlant,
  PlantAccess,
  plantProblem,
  requireNotFutureMoment,
  requireRecentDate,
  requireWritable,
  versionConflict,
} from "./plant-access.js";
import { PlantRecordsService, meterHistory } from "./plant-records.service.js";
import { PlantRegisterService } from "./plant-register.service.js";
import type { PlantRow } from "./plant-model.js";

/**
 * Breakdowns and maintenance (D8.3): a breakdown reported at a site (major and unsafe ones put
 * the item under repair) is repaired, or sends hired plant off hire, or writes owned plant off;
 * service, repair and inspection records (append-only, voided with a reason) restart the service
 * interval. No independent sign-off (decision D-98), except that only plant.manage records the
 * repair of an unsafe breakdown.
 */
@Injectable()
export class PlantMaintenanceService {
  constructor(
    private readonly scope: TenantScope,
    private readonly plant: PlantAccess,
    private readonly register: PlantRegisterService,
    private readonly records: PlantRecordsService,
  ) {}

  report(principal: Principal, plantId: string, input: ReportBreakdownRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.plant.reader(scope);
        const { tx, access } = scope;
        await lockPlant(tx, access.tenantId, plantId);
        const item = await this.openItem(scope, plantId);
        requireNotFutureMoment(input.reportedAt);
        const projectId = await this.records.recordSite(
          scope,
          caller,
          item,
          input.siteId,
          plantBusinessDate(Date.parse(input.reportedAt)),
          "record",
        );
        const latest = await tx.plantBreakdown.aggregate({
          where: { tenantId: access.tenantId },
          _max: { number: true },
        });
        const number = (latest._max.number ?? 0) + 1;
        const id = uuidv7();
        await tx.plantBreakdown.create({
          data: {
            id,
            tenantId: access.tenantId,
            plantId,
            projectId,
            siteId: input.siteId,
            number,
            reportedAt: new Date(input.reportedAt),
            severity: input.severity,
            description: input.description,
            reportedBy: access.userId,
          },
        });
        if (breakdownBlocks(input.severity) && item.status !== "under_repair")
          await this.setStatus(scope, item, "under_repair");
        await this.scope.audit(tx, "plant.breakdown_reported", id, {
          plantId,
          code: item.code,
          breakdown: breakdownCode(number),
          severity: input.severity,
          projectId,
        });
        return this.register.detailResponse(scope, caller, plantId);
      },
      true,
    );
  }

  resolve(
    principal: Principal,
    plantId: string,
    breakdownId: string,
    input: ResolveBreakdownRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.plant.reader(scope);
        const { tx, access } = scope;
        await lockPlant(tx, access.tenantId, plantId);
        const item = await this.openItem(scope, plantId);
        const row = await tx.plantBreakdown.findFirst({
          where: { tenantId: access.tenantId, plantId, id: breakdownId },
        });
        if (!row || !caller.canRead(row.projectId))
          throw new NotFoundException("Breakdown not found");
        if (row.status !== "open")
          throw plantProblem(409, "invalid-transition", "This breakdown is already resolved");
        if (row.version !== input.version) throw versionConflict();
        requireWritable(caller, row.projectId);
        const repaired = input.resolution === "repaired";
        const allowed =
          repaired && row.severity !== "unsafe"
            ? caller.canRecord(row.projectId)
            : caller.canManage(row.projectId);
        if (!allowed)
          throw new ForbiddenException(
            repaired
              ? "Permission required: plant.manage records the repair of an unsafe breakdown"
              : "Permission required: plant.manage",
          );
        if (!breakdownResolutionAllowed(item.ownership as PlantOwnership, input.resolution))
          throw plantProblem(
            409,
            "breakdown-resolution-invalid",
            "Hired plant goes off hire; owned plant is written off",
          );
        requireRecentDate(input.resolvedOn, PLANT_LIMITS.maxBackdateDays);
        if (input.resolvedOn < plantBusinessDate(row.reportedAt.getTime()))
          throw plantProblem(
            409,
            "invalid-transition",
            "A breakdown is resolved after it was reported",
          );
        const others = await tx.plantBreakdown.findMany({
          where: { tenantId: access.tenantId, plantId, status: "open", id: { not: breakdownId } },
          select: { severity: true },
        });
        if (!repaired && others.length)
          throw plantProblem(
            409,
            "plant-has-open-breakdowns",
            "Resolve the item's other open breakdowns first",
          );
        const changed = await tx.plantBreakdown.updateMany({
          where: { tenantId: access.tenantId, id: breakdownId, version: input.version },
          data: {
            status: input.resolution,
            resolvedOn: fromCalendarDate(input.resolvedOn),
            resolutionNote: input.note ?? null,
            repairedBy: input.repairedBy ?? null,
            costReference: input.costReference ?? null,
            resolvedBy: access.userId,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw versionConflict();
        if (!repaired) {
          await this.register.closeItem(
            scope,
            item,
            input.resolution === "off_hire" ? "off_hire" : "disposed",
            input.resolvedOn,
            input.note!,
          );
        } else if (
          item.status === "under_repair" &&
          !others.some((other) => breakdownBlocks(other.severity as BreakdownSeverity))
        ) {
          await this.setStatus(scope, item, item.siteId ? "on_site" : "available");
        }
        await this.scope.audit(tx, "plant.breakdown_resolved", breakdownId, {
          plantId,
          code: item.code,
          breakdown: breakdownCode(row.number),
          resolution: input.resolution,
          version: input.version + 1,
        });
        return this.register.detailResponse(scope, caller, plantId);
      },
      true,
    );
  }

  recordService(principal: Principal, plantId: string, input: RecordServiceRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.plant.reader(scope);
        const { tx, access } = scope;
        await lockPlant(tx, access.tenantId, plantId);
        const item = await this.openItem(scope, plantId);
        if (item.projectId) requireWritable(caller, item.projectId);
        const allowed = item.projectId ? caller.canRecord(item.projectId) : caller.manageSomewhere;
        if (!allowed)
          throw new ForbiddenException("Permission required: site.diary or plant.manage");
        requireNotFutureMoment(input.servicedAt);
        const at = Date.parse(input.servicedAt);
        const day = plantBusinessDate(at);
        requireRecentDate(day, PLANT_LIMITS.maxBackdateDays);
        if (day < toCalendarDate(item.openingOn))
          throw plantProblem(
            409,
            "invalid-transition",
            "A service is not before the item was registered",
          );
        const metered = item.meterType !== "none";
        if (metered !== Boolean(input.meterReading))
          throw plantProblem(
            422,
            "plant-not-metered",
            metered ? "Enter the meter reading at the service" : "This item has no meter",
          );
        if (metered) {
          const history = await meterHistory(tx, access.tenantId, plantId, null);
          const check = checkMeterReading(
            history.readings,
            history.resets,
            at,
            parseTenths(input.meterReading!)!,
          );
          if (!check.ok)
            throw plantProblem(
              409,
              "meter-out-of-order",
              "A meter reading cannot be lower than an earlier one or higher than a later one",
            );
        }
        const id = uuidv7();
        await tx.plantService.create({
          data: {
            id,
            tenantId: access.tenantId,
            plantId,
            projectId: item.projectId,
            siteId: item.siteId,
            servicedAt: new Date(input.servicedAt),
            kind: input.kind,
            meterReading: input.meterReading ?? null,
            description: input.description,
            doneBy: input.doneBy ?? null,
            costReference: input.costReference ?? null,
            recordedBy: access.userId,
          },
        });
        await this.scope.audit(tx, "plant.service_recorded", id, {
          plantId,
          code: item.code,
          kind: input.kind,
        });
        return this.register.detailResponse(scope, caller, plantId);
      },
      true,
    );
  }

  voidService(
    principal: Principal,
    plantId: string,
    serviceId: string,
    input: { version: number; reason: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.plant.reader(scope);
        const { tx, access } = scope;
        await lockPlant(tx, access.tenantId, plantId);
        const item = await this.openItem(scope, plantId);
        const row = await tx.plantService.findFirst({
          where: { tenantId: access.tenantId, plantId, id: serviceId },
        });
        if (!row || (row.projectId !== null && !caller.canRead(row.projectId)))
          throw new NotFoundException("Service record not found");
        if (!caller.canManageItem(item))
          throw new ForbiddenException("Permission required: plant.manage");
        if (row.status !== "recorded")
          throw plantProblem(409, "invalid-transition", "This service record is already void");
        if (row.version !== input.version) throw versionConflict();
        const changed = await tx.plantService.updateMany({
          where: { tenantId: access.tenantId, id: serviceId, version: input.version },
          data: {
            status: "voided",
            voidedBy: access.userId,
            voidReason: input.reason,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(tx, "plant.service_voided", serviceId, {
          plantId,
          code: item.code,
          version: input.version + 1,
        });
        return this.register.detailResponse(scope, caller, plantId);
      },
      true,
    );
  }

  private async openItem(scope: Scope, plantId: string) {
    const item = await this.register.itemRow(scope, plantId);
    if (isPlantClosed(item.status as PlantStatus))
      throw plantProblem(409, "plant-closed", "Off-hired and disposed plant is final");
    return item;
  }

  private async setStatus(scope: Scope, item: PlantRow, status: PlantStatus) {
    const changed = await scope.tx.plantItem.updateMany({
      where: { tenantId: scope.access.tenantId, id: item.id, version: item.version },
      data: { status, updatedBy: scope.access.userId, version: { increment: 1 } },
    });
    if (changed.count !== 1) throw versionConflict();
  }
}
