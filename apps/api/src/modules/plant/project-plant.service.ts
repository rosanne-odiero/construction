import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { formatTenths, nairobiDate, plantDayEnd, plantDayStart } from "@pm-buddy/domain";
import type { OperatorKind } from "@pm-buddy/types";
import {
  projectPlantOptionsResponseSchema,
  projectPlantResponseSchema,
  type ProjectPlantOptionsQuery,
} from "@pm-buddy/validation";
import type { Request } from "express";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { approvedBqVersion } from "../finance/spending-common.js";
import { peopleOf } from "../procurement/procurement-mappers.js";
import { fromCalendarDate } from "../projects/project-mappers.js";
import { PlantAccess, plantSettings } from "./plant-access.js";
import { currentFuelIssues, tenthsOf } from "./plant-model.js";
import { plantStaff } from "./plant-mappers.js";
import { PlantRegisterService } from "./plant-register.service.js";

/**
 * A project's plant tab (D8.3): the items on its sites today with their alerts, whether today's
 * usage is logged and the fuel issued today, the active operators, and what the caller may do;
 * plus the people, cost codes and BQ items the site forms offer.
 */
@Injectable()
export class ProjectPlantService {
  constructor(
    private readonly scope: TenantScope,
    private readonly plant: PlantAccess,
    private readonly register: PlantRegisterService,
  ) {}

  tab(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.plant.caller(scope);
      const { tx, access } = scope;
      await this.requireProject(scope.tx, access.tenantId, projectId);
      if (!caller.canRead(projectId))
        throw new ForbiddenException(
          "Plant records need a site, stores, finance or project permission",
        );
      const settings = await plantSettings(tx, access.tenantId);
      const canSeeCost = caller.canSeeCostOn(projectId);
      const items = await this.register.summaries(
        scope,
        caller,
        settings,
        {
          tenantId: access.tenantId,
          projectId,
        },
        canSeeCost,
      );
      const today = nairobiDate();
      const ids = items.map((item) => item.id);
      const [usage, fuel, operators, sites] = await Promise.all([
        tx.plantUsageLog.findMany({
          where: {
            tenantId: access.tenantId,
            plantId: { in: ids },
            usedOn: fromCalendarDate(today),
          },
          select: { id: true, plantId: true, isVoid: true },
        }),
        currentFuelIssues(tx, access.tenantId, ids, new Date(plantDayStart(today))),
        tx.plantOperator.findMany({
          where: {
            tenantId: access.tenantId,
            projectId,
            plantId: { in: ids },
            fromOn: { lte: fromCalendarDate(today) },
            OR: [{ toOn: null }, { toOn: { gte: fromCalendarDate(today) } }],
          },
          include: { labourer: { select: { fullName: true } } },
        }),
        tx.site.findMany({
          where: { tenantId: access.tenantId, projectId },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        }),
      ]);
      const corrected = new Set(
        (
          await tx.plantUsageLog.findMany({
            where: { tenantId: access.tenantId, correctsId: { in: usage.map((row) => row.id) } },
            select: { correctsId: true },
          })
        ).map((row) => row.correctsId),
      );
      const people = await peopleOf(
        tx,
        operators.map((row) => row.userId),
      );
      const end = plantDayEnd(today);
      return projectPlantResponseSchema.parse({
        items: items.map((item) => ({
          ...item,
          today: {
            usageRecorded: usage.some(
              (row) => row.plantId === item.id && !row.isVoid && !corrected.has(row.id),
            ),
            litres: formatTenths(
              fuel
                .filter((row) => row.plantId === item.id && row.issuedAt.getTime() <= end)
                .reduce((total, row) => total + tenthsOf(row.litres)!, 0),
            ),
          },
          operators: operators
            .filter((row) => row.plantId === item.id)
            .map((row) => ({
              id: (row.labourerId ?? row.userId)!,
              name: row.labourer?.fullName ?? people.get(row.userId ?? "") ?? "—",
              kind: row.kind as OperatorKind,
            })),
        })),
        sites,
        permissions: {
          canRecordUsage: caller.canRecord(projectId),
          canRecordFuel: caller.canFuel(projectId),
          canReportBreakdown: caller.canRecord(projectId),
          canManage: caller.canManage(projectId),
          canSeeCost,
        },
      });
    });
  }

  options(principal: Principal, projectId: string, query: ProjectPlantOptionsQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.plant.caller(scope);
      const { tx, access } = scope;
      await this.requireProject(tx, access.tenantId, projectId);
      if (!caller.canRead(projectId))
        throw new ForbiddenException(
          "Plant records need a site, stores, finance or project permission",
        );
      const search = query.search?.trim();
      const bqSearch = query.bqSearch?.trim();
      const version = bqSearch ? await approvedBqVersion(tx, access.tenantId, projectId) : null;
      const [labourers, staff, costCodes, bqItems] = await Promise.all([
        tx.labourer.findMany({
          where: {
            tenantId: access.tenantId,
            engagements: { some: { projectId } },
            ...(search
              ? {
                  OR: [
                    { fullName: { contains: search, mode: "insensitive" } },
                    { workerNo: { contains: search, mode: "insensitive" } },
                  ],
                }
              : {}),
          },
          select: { id: true, workerNo: true, fullName: true },
          orderBy: { workerNo: "asc" },
          take: 30,
        }),
        plantStaff(scope, projectId),
        tx.costCode.findMany({
          where: { tenantId: access.tenantId, active: true },
          select: { id: true, code: true, name: true },
          orderBy: { code: "asc" },
          take: 200,
        }),
        version
          ? tx.bqItem.findMany({
              where: {
                tenantId: access.tenantId,
                versionId: version.id,
                kind: { in: ["measured", "preliminary", "daywork"] },
                OR: [
                  { ref: { contains: bqSearch!, mode: "insensitive" } },
                  { description: { contains: bqSearch!, mode: "insensitive" } },
                ],
              },
              select: { lineageId: true, ref: true, description: true },
              orderBy: { sortOrder: "asc" },
              take: 20,
            })
          : [],
      ]);
      return projectPlantOptionsResponseSchema.parse({
        labourers,
        staff,
        costCodes,
        bqItems: bqItems.map((item) => ({
          lineageId: item.lineageId,
          ref: item.ref,
          description: item.description.slice(0, 300),
        })),
      });
    });
  }

  private async requireProject(
    tx: Parameters<Parameters<TenantScope["run"]>[2]>[0]["tx"],
    tenantId: string,
    projectId: string,
  ) {
    const project = await tx.project.findUnique({
      where: { tenantId_id: { tenantId, id: projectId } },
      select: { id: true },
    });
    if (!project) throw new NotFoundException("Project not found");
  }
}
