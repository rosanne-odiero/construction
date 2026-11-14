import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { calendarDaysBetween, isPlantClosed, nairobiDate } from "@pm-buddy/domain";
import {
  PLANT_ALERT_KINDS,
  PLANT_LIMITS,
  type PlantAlertKind,
  type PlantStatus,
} from "@pm-buddy/types";
import {
  hireIssues,
  meterIssues,
  plantAlertsResponseSchema,
  plantDetailResponseSchema,
  plantListResponseSchema,
  plantOptionsResponseSchema,
  plantSettingsResponseSchema,
  type ClosePlantRequest,
  type MovePlantRequest,
  type ParsedCreatePlantRequest,
  type ParsedUpdatePlantRequest,
  type PlantAlertEntry,
  type PlantAlertsQuery,
  type PlantItem,
  type PlantListQuery,
  type UpdatePlantSettingsRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { peopleOf, personOf } from "../procurement/procurement-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  breakdownCode,
  lockPlant,
  PlantAccess,
  plantProblem,
  plantSettings,
  requireRecentDate,
  requireWritable,
  versionConflict,
  type PlantCaller,
  type PlantSettingsValues,
} from "./plant-access.js";
import {
  decimal1,
  decimal2,
  loadPlantFacts,
  locationOf,
  optionalDate,
  plantInclude,
  summarisePlant,
  type PlantRow,
} from "./plant-model.js";
import { operatorState } from "./plant-mappers.js";

/** The register holds at most this many items per company for the in-memory summaries. */
const REGISTER_CAP = 2000;
const CLOSED_STATUSES = ["off_hire", "disposed"] as const;

/**
 * The company plant register (D8.3): items with their location, meter, service state, hire
 * summary and alerts; registration, edits, moves between the yard and project sites, closing
 * (off hire / disposed), the register form's options, the alerts list and the company settings.
 */
@Injectable()
export class PlantRegisterService {
  constructor(
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
    private readonly plant: PlantAccess,
  ) {}

  list(principal: Principal, query: PlantListQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.plant.reader(scope);
      const { tenantId } = scope.access;
      const settings = await plantSettings(scope.tx, tenantId);
      const where: Prisma.PlantItemWhereInput = { tenantId };
      if (query.status === "active") where.status = { notIn: ["off_hire", "disposed"] };
      else if (query.status) where.status = query.status;
      if (query.category) where.category = query.category;
      if (query.ownership) where.ownership = query.ownership;
      if (query.projectId)
        where.projectId = caller.canRead(query.projectId)
          ? query.projectId
          : "00000000-0000-0000-0000-000000000000";
      const search = query.search?.trim();
      if (search)
        where.OR = [
          { code: { contains: search, mode: "insensitive" } },
          { name: { contains: search, mode: "insensitive" } },
          { makeModel: { contains: search, mode: "insensitive" } },
          { registration: { contains: search, mode: "insensitive" } },
        ];
      const items = await this.summaries(scope, caller, settings, where);
      const shown = query.attention ? items.filter((item) => item.alerts.length) : items;
      const offset = query.cursor ?? 0;
      return plantListResponseSchema.parse({
        items: shown.slice(offset, offset + query.limit),
        nextCursor: shown.length > offset + query.limit ? offset + query.limit : null,
        counts: {
          total: items.length,
          onSite: items.filter((item) => item.status === "on_site").length,
          available: items.filter((item) => item.status === "available").length,
          underRepair: items.filter((item) => item.status === "under_repair").length,
          hired: items.filter((item) => item.ownership === "hired" && !isPlantClosed(item.status))
            .length,
          attention: items.filter((item) => item.alerts.length).length,
        },
        permissions: {
          canRegister: caller.manageSomewhere,
          canEditSettings: scope.access.permissions.has("config.manage"),
        },
      });
    });
  }

  alerts(principal: Principal, query: PlantAlertsQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.plant.reader(scope);
      const settings = await plantSettings(scope.tx, scope.access.tenantId);
      const where: Prisma.PlantItemWhereInput = {
        tenantId: scope.access.tenantId,
        status: { notIn: ["off_hire", "disposed"] },
      };
      if (query.projectId)
        where.projectId = caller.canRead(query.projectId)
          ? query.projectId
          : "00000000-0000-0000-0000-000000000000";
      // Alerts of items on projects the caller cannot read belong to that project's team.
      const items = (await this.summaries(scope, caller, settings, where)).filter(
        (item) => !item.locationRestricted,
      );
      const all: PlantAlertEntry[] = items.flatMap((item) =>
        item.alerts.map((alert) => ({
          ...alert,
          plantId: item.id,
          code: item.code,
          name: item.name,
          category: item.category,
          location: item.location,
        })),
      );
      const severity = { critical: 0, warning: 1 } as const;
      all.sort(
        (a, b) =>
          severity[a.severity] - severity[b.severity] ||
          PLANT_ALERT_KINDS.indexOf(a.kind) - PLANT_ALERT_KINDS.indexOf(b.kind) ||
          a.code.localeCompare(b.code),
      );
      const counts = Object.fromEntries(
        PLANT_ALERT_KINDS.map((kind) => [kind, all.filter((alert) => alert.kind === kind).length]),
      ) as Record<PlantAlertKind, number>;
      const shown = query.kind ? all.filter((alert) => alert.kind === query.kind) : all;
      const offset = query.cursor ?? 0;
      return plantAlertsResponseSchema.parse({
        alerts: shown.slice(offset, offset + query.limit),
        nextCursor: shown.length > offset + query.limit ? offset + query.limit : null,
        counts,
      });
    });
  }

  detail(principal: Principal, plantId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.plant.reader(scope);
      return this.detailResponse(scope, caller, plantId);
    });
  }

  options(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.plant.reader(scope);
      if (!caller.manageSomewhere)
        throw new ForbiddenException("Permission required: plant.manage");
      const { tx, access } = scope;
      const managed = [...caller.projects.values()].filter((project) =>
        caller.canManage(project.id),
      );
      const [suppliers, lpos, sites] = await Promise.all([
        tx.supplier.findMany({
          where: { tenantId: access.tenantId, status: "active" },
          select: { id: true, code: true, legalName: true, tradingName: true },
          orderBy: { code: "asc" },
          take: 500,
        }),
        tx.lpo.findMany({
          where: {
            tenantId: access.tenantId,
            projectId: { in: managed.map((project) => project.id) },
            status: { notIn: ["draft", "cancelled"] },
          },
          select: { id: true, number: true, supplierId: true, projectId: true },
          orderBy: { number: "desc" },
          take: 500,
        }),
        tx.site.findMany({
          where: {
            tenantId: access.tenantId,
            projectId: { in: managed.map((project) => project.id) },
          },
          select: { id: true, name: true, projectId: true },
          orderBy: { name: "asc" },
        }),
      ]);
      const code = (projectId: string) => caller.projects.get(projectId)?.code ?? "—";
      return plantOptionsResponseSchema.parse({
        suppliers: suppliers.map((supplier) => ({
          id: supplier.id,
          code: supplier.code,
          name: supplier.tradingName ?? supplier.legalName,
        })),
        lpos: lpos.map((lpo) => ({
          id: lpo.id,
          number: lpo.number,
          supplierId: lpo.supplierId,
          projectCode: code(lpo.projectId),
        })),
        sites: sites
          .map((site) => ({
            projectId: site.projectId,
            projectCode: code(site.projectId),
            projectName: caller.projects.get(site.projectId)?.name ?? "—",
            siteId: site.id,
            siteName: site.name,
          }))
          .sort((a, b) => a.projectCode.localeCompare(b.projectCode)),
      });
    });
  }

  create(principal: Principal, input: ParsedCreatePlantRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.plant.reader(scope);
        if (!caller.manageSomewhere)
          throw new ForbiddenException("Permission required: plant.manage");
        const { tx, access } = scope;
        const { tenantId, userId } = access;
        const site = input.siteId ? await this.site(scope, input.siteId) : null;
        if (site) this.requireDestination(caller, site.projectId);
        requireRecentDate(input.openingOn, 3650);
        await this.checkHireRefs(scope, input.supplierId ?? null, input.lpoId ?? null);
        if (
          await tx.plantItem.findUnique({
            where: { tenantId_code: { tenantId, code: input.code } },
          })
        )
          throw plantProblem(409, "plant-code-taken", "This plant code is already in the register");
        // The register reads every item in service at once: past the cap it would drop some.
        if (
          (await tx.plantItem.count({
            where: { tenantId, status: { notIn: [...CLOSED_STATUSES] } },
          })) >= REGISTER_CAP
        )
          throw plantProblem(
            409,
            "plant-register-full",
            `The register holds at most ${REGISTER_CAP} items in service; off-hire or dispose of some first`,
          );
        const id = uuidv7();
        await tx.plantItem.create({
          data: {
            id,
            tenantId,
            code: input.code,
            name: input.name,
            category: input.category,
            ownership: input.ownership,
            quantity: input.quantity,
            makeModel: input.makeModel ?? null,
            registration: input.registration ?? null,
            ...this.hireData(input),
            meterType: input.meterType,
            fuelType: input.fuelType,
            standardConsumption: input.standardConsumption ?? null,
            openingOn: fromCalendarDate(input.openingOn),
            openingReading: input.openingReading ?? null,
            serviceEvery: input.serviceEvery ?? null,
            serviceEveryDays: input.serviceEveryDays ?? null,
            notes: input.notes ?? null,
            createdBy: userId,
            updatedBy: userId,
          },
        });
        if (site) {
          await tx.plantMove.create({
            data: {
              id: uuidv7(),
              tenantId,
              plantId: id,
              seq: 1,
              movedOn: fromCalendarDate(input.openingOn),
              toProjectId: site.projectId,
              toSiteId: site.id,
              movedBy: userId,
            },
          });
          await tx.plantItem.update({
            where: { tenantId_id: { tenantId, id } },
            data: {
              projectId: site.projectId,
              siteId: site.id,
              status: "on_site",
              updatedBy: userId,
              version: { increment: 1 },
            },
          });
        }
        await this.scope.audit(tx, "plant.registered", id, {
          code: input.code,
          category: input.category,
          ownership: input.ownership,
          meterType: input.meterType,
          fuelType: input.fuelType,
          supplierId: input.supplierId ?? null,
          siteId: site?.id ?? null,
        });
        return this.detailResponse(scope, caller, id);
      },
      true,
    );
  }

  update(principal: Principal, plantId: string, input: ParsedUpdatePlantRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.plant.reader(scope);
        const item = await this.writableItem(scope, caller, plantId, input.version);
        const issues = [
          ...hireIssues(item.ownership, input, item.meterType),
          ...meterIssues(item.meterType, item.fuelType, input),
        ];
        if (issues.length)
          throw plantProblem(422, "plant-rule", "These fields do not fit the item", {
            fields: issues,
          });
        await this.checkHireRefs(scope, input.supplierId ?? null, input.lpoId ?? null);
        const data = {
          name: input.name,
          category: input.category,
          quantity: input.quantity,
          makeModel: input.makeModel ?? null,
          registration: input.registration ?? null,
          ...this.hireData({ ...input, ownership: item.ownership }),
          standardConsumption: input.standardConsumption ?? null,
          serviceEvery: input.serviceEvery ?? null,
          serviceEveryDays: input.serviceEveryDays ?? null,
          notes: input.notes ?? null,
        };
        const before: Record<string, unknown> = {
          name: item.name,
          category: item.category,
          quantity: item.quantity,
          makeModel: item.makeModel,
          registration: item.registration,
          supplierId: item.supplierId,
          lpoId: item.lpoId,
          hireRateMinor: item.hireRateMinor === null ? null : Number(item.hireRateMinor),
          hireRateUnit: item.hireRateUnit,
          hireStartOn: optionalDate(item.hireStartOn),
          hireEndOn: optionalDate(item.hireEndOn),
          standardConsumption: decimal2(item.standardConsumption),
          serviceEvery: decimal1(item.serviceEvery),
          serviceEveryDays: item.serviceEveryDays,
          notes: item.notes,
        };
        const after: Record<string, unknown> = {
          ...data,
          hireRateMinor: data.hireRateMinor === null ? null : Number(data.hireRateMinor),
          hireStartOn: data.hireStartOn ? toCalendarDate(data.hireStartOn) : null,
          hireEndOn: data.hireEndOn ? toCalendarDate(data.hireEndOn) : null,
        };
        const changed = Object.keys(after).filter(
          (key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]),
        );
        const result = await scope.tx.plantItem.updateMany({
          where: { tenantId: scope.access.tenantId, id: plantId, version: input.version },
          data: { ...data, updatedBy: scope.access.userId, version: { increment: 1 } },
        });
        if (result.count !== 1) throw versionConflict();
        await this.scope.audit(scope.tx, "plant.updated", plantId, {
          code: item.code,
          changed,
          version: input.version + 1,
        });
        return this.detailResponse(scope, caller, plantId);
      },
      true,
    );
  }

  move(principal: Principal, plantId: string, input: MovePlantRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.plant.reader(scope);
        const { tx, access } = scope;
        await lockPlant(tx, access.tenantId, plantId);
        const item = await this.writableItem(scope, caller, plantId, input.version);
        const site = input.siteId ? await this.site(scope, input.siteId) : null;
        if ((site?.id ?? null) === item.siteId)
          throw plantProblem(409, "move-same-place", "The item is already there");
        if (site) this.requireDestination(caller, site.projectId);
        await this.recordMove(scope, item, site, input.movedOn, input.reason ?? null);
        const result = await tx.plantItem.updateMany({
          where: { tenantId: access.tenantId, id: plantId, version: input.version },
          data: {
            projectId: site?.projectId ?? null,
            siteId: site?.id ?? null,
            status:
              item.status === "under_repair" ? "under_repair" : site ? "on_site" : "available",
            updatedBy: access.userId,
            version: { increment: 1 },
          },
        });
        if (result.count !== 1) throw versionConflict();
        await this.scope.audit(tx, "plant.moved", plantId, {
          code: item.code,
          fromSiteId: item.siteId,
          toSiteId: site?.id ?? null,
          version: input.version + 1,
        });
        return this.detailResponse(scope, caller, plantId);
      },
      true,
    );
  }

  close(principal: Principal, plantId: string, input: ClosePlantRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.plant.reader(scope);
        const { tx, access } = scope;
        await lockPlant(tx, access.tenantId, plantId);
        const item = await this.writableItem(scope, caller, plantId, input.version);
        if ((input.action === "off_hire") !== (item.ownership === "hired"))
          throw plantProblem(
            409,
            "invalid-transition",
            "Hired plant goes off hire; owned plant is disposed of",
          );
        if (
          await tx.plantBreakdown.count({
            where: { tenantId: access.tenantId, plantId, status: "open" },
          })
        )
          throw plantProblem(
            409,
            "plant-has-open-breakdowns",
            "Resolve the open breakdowns first (a breakdown can send hired plant off hire)",
          );
        await this.closeItem(
          scope,
          item,
          input.action === "off_hire" ? "off_hire" : "disposed",
          input.closedOn,
          input.reason,
        );
        await this.scope.audit(tx, "plant.closed", plantId, {
          code: item.code,
          action: input.action,
          version: input.version + 1,
        });
        return this.detailResponse(scope, caller, plantId);
      },
      true,
    );
  }

  getSettings(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const canEdit = scope.access.permissions.has("config.manage");
      if (!canEdit) await this.plant.reader(scope);
      return this.settingsResponse(await plantSettings(scope.tx, scope.access.tenantId), canEdit);
    });
  }

  updateSettings(principal: Principal, input: UpdatePlantSettingsRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.policy.require(scope, "config.manage");
        const { tenantId, userId } = scope.access;
        const current = await scope.tx.plantSettings.findUnique({ where: { tenantId } });
        if ((current?.version ?? 0) !== input.version) throw versionConflict();
        const values = {
          fuelVariancePercent: input.fuelVariancePercent,
          fuelMinHours: input.fuelMinHours,
          fuelMinKm: input.fuelMinKm,
          idleHireDays: input.idleHireDays,
          hireEndingDays: input.hireEndingDays,
          serviceDueSoonPercent: input.serviceDueSoonPercent,
          certificateCategories: input.certificateCategories,
          updatedBy: userId,
        };
        if (current) {
          const changed = await scope.tx.plantSettings.updateMany({
            where: { tenantId, version: input.version },
            data: { ...values, version: { increment: 1 } },
          });
          if (changed.count !== 1) throw versionConflict();
        } else {
          await scope.tx.plantSettings.create({ data: { tenantId, ...values } });
        }
        const { updatedBy: _updatedBy, ...audited } = values;
        await this.scope.audit(scope.tx, "plant.settings_updated", tenantId, {
          ...audited,
          version: input.version + 1,
        });
        return this.settingsResponse(await plantSettings(scope.tx, tenantId), true);
      },
      true,
    );
  }

  // Shared with the other plant services --------------------------------------------------------

  /**
   * Every item matching `where`, summarised for the caller: all items in service (registration
   * stops at REGISTER_CAP of them), then the most recently closed ones up to the cap, so off-hired
   * and disposed plant never pushes plant in service out of the register.
   */
  async summaries(
    scope: Scope,
    caller: PlantCaller,
    settings: PlantSettingsValues,
    where: Prisma.PlantItemWhereInput,
    canSeeCost = caller.costSomewhere,
  ): Promise<PlantItem[]> {
    const inService = await scope.tx.plantItem.findMany({
      where: { AND: [where, { status: { notIn: [...CLOSED_STATUSES] } }] },
      include: plantInclude,
      orderBy: { code: "asc" },
      take: REGISTER_CAP,
    });
    const closed =
      inService.length < REGISTER_CAP
        ? await scope.tx.plantItem.findMany({
            where: { AND: [where, { status: { in: [...CLOSED_STATUSES] } }] },
            include: plantInclude,
            orderBy: [{ closedOn: "desc" }, { code: "asc" }],
            take: REGISTER_CAP - inService.length,
          })
        : [];
    const rows = [...inService, ...closed].sort((left, right) =>
      left.code.localeCompare(right.code),
    );
    const today = nairobiDate();
    const facts = await loadPlantFacts(scope.tx, scope.access.tenantId, rows, settings, today);
    return rows.map((row) =>
      summarisePlant(row, facts.get(row.id)!, settings, caller, canSeeCost, today),
    );
  }

  async itemRow(scope: Scope, plantId: string): Promise<PlantRow> {
    const row = await scope.tx.plantItem.findFirst({
      where: { tenantId: scope.access.tenantId, id: plantId },
      include: plantInclude,
    });
    if (!row) throw new NotFoundException("Plant item not found");
    return row;
  }

  /** An item that is not closed, at the version read, that the caller may manage. */
  private async writableItem(scope: Scope, caller: PlantCaller, plantId: string, version: number) {
    const item = await this.itemRow(scope, plantId);
    if (isPlantClosed(item.status as PlantStatus))
      throw plantProblem(409, "plant-closed", "Off-hired and disposed plant is final");
    if (!caller.canManageItem(item))
      throw new ForbiddenException("Permission required: plant.manage");
    if (item.version !== version) throw versionConflict();
    return item;
  }

  private async site(scope: Scope, siteId: string) {
    const site = await scope.tx.site.findFirst({
      where: { tenantId: scope.access.tenantId, id: siteId },
      select: { id: true, projectId: true, name: true },
    });
    if (!site) throw new NotFoundException("Site not found");
    return site;
  }

  /** plant.manage on a writable destination project. */
  private requireDestination(caller: PlantCaller, projectId: string) {
    if (!caller.holdsManage(projectId))
      throw new ForbiddenException("Permission required: plant.manage on the destination project");
    requireWritable(caller, projectId);
  }

  private async checkHireRefs(scope: Scope, supplierId: string | null, lpoId: string | null) {
    const { tx, access } = scope;
    if (supplierId) {
      const supplier = await tx.supplier.findFirst({
        where: { tenantId: access.tenantId, id: supplierId },
        select: { id: true },
      });
      if (!supplier) throw plantProblem(422, "supplier-not-found", "Supplier not found");
    }
    if (lpoId) {
      const lpo = await tx.lpo.findFirst({
        where: { tenantId: access.tenantId, id: lpoId },
        select: { supplierId: true },
      });
      if (!lpo || lpo.supplierId !== supplierId)
        throw plantProblem(422, "lpo-not-found", "This LPO is not one of the supplier's");
    }
  }

  private hireData(input: {
    ownership: string;
    supplierId?: string | null | undefined;
    lpoId?: string | null | undefined;
    hireRateMinor?: number | null | undefined;
    hireRateUnit?: string | null | undefined;
    hireStartOn?: string | null | undefined;
    hireEndOn?: string | null | undefined;
  }) {
    const hired = input.ownership === "hired";
    return {
      supplierId: hired ? (input.supplierId ?? null) : null,
      lpoId: hired ? (input.lpoId ?? null) : null,
      hireRateMinor: hired && input.hireRateMinor ? BigInt(input.hireRateMinor) : null,
      hireRateUnit: hired ? (input.hireRateUnit ?? null) : null,
      hireStartOn: hired && input.hireStartOn ? fromCalendarDate(input.hireStartOn) : null,
      hireEndOn: hired && input.hireEndOn ? fromCalendarDate(input.hireEndOn) : null,
    };
  }

  /**
   * Appends a move (the item row must be locked): dated on or after the previous move and the
   * opening date, within the back-dating window, and never stranding usage or fuel recorded at
   * the site it leaves after that date. Plant on a closed project can still be moved off it.
   */
  async recordMove(
    scope: Scope,
    item: PlantRow,
    site: { id: string; projectId: string } | null,
    movedOn: string,
    reason: string | null,
  ) {
    const { tx, access } = scope;
    requireRecentDate(movedOn, PLANT_LIMITS.maxBackdateDays);
    const last = await tx.plantMove.findFirst({
      where: { tenantId: access.tenantId, plantId: item.id },
      orderBy: { seq: "desc" },
    });
    if (
      movedOn < toCalendarDate(item.openingOn) ||
      (last && movedOn < toCalendarDate(last.movedOn))
    )
      throw plantProblem(
        409,
        "invalid-transition",
        "A move is dated on or after the previous move and the opening date",
      );
    if (item.siteId) {
      // Only rows still in force: voiding entries is how a late move is made possible.
      const [usage, fuel] = await Promise.all([
        tx.$queryRaw<{ count: bigint }[]>`
          SELECT count(*) AS count FROM plant_usage_logs u
          WHERE u.tenant_id = ${access.tenantId}::uuid AND u.plant_id = ${item.id}::uuid
            AND u.site_id = ${item.siteId}::uuid AND u.used_on > ${movedOn}::date AND NOT u.is_void
            AND NOT EXISTS (SELECT 1 FROM plant_usage_logs c
                             WHERE c.tenant_id = u.tenant_id AND c.corrects_id = u.id)`,
        tx.$queryRaw<{ count: bigint }[]>`
          SELECT count(*) AS count FROM plant_fuel_issues f
          WHERE f.tenant_id = ${access.tenantId}::uuid AND f.plant_id = ${item.id}::uuid
            AND f.site_id = ${item.siteId}::uuid
            AND app.plant_business_date(f.issued_at) > ${movedOn}::date AND NOT f.is_void
            AND NOT EXISTS (SELECT 1 FROM plant_fuel_issues c
                             WHERE c.tenant_id = f.tenant_id AND c.corrects_id = f.id)`,
      ]);
      if (Number(usage[0]?.count ?? 0) || Number(fuel[0]?.count ?? 0))
        throw plantProblem(
          409,
          "move-strands-records",
          "Usage or fuel is recorded at the current site after this date",
        );
    }
    await tx.plantMove.create({
      data: {
        id: uuidv7(),
        tenantId: access.tenantId,
        plantId: item.id,
        seq: (last?.seq ?? 0) + 1,
        movedOn: fromCalendarDate(movedOn),
        fromProjectId: item.projectId,
        fromSiteId: item.siteId,
        toProjectId: site?.projectId ?? null,
        toSiteId: site?.id ?? null,
        reason,
        movedBy: access.userId,
      },
    });
  }

  /**
   * Off hire or disposal (the item row must be locked): brings it back to the yard, ends its
   * operator assignments and closes it for good.
   */
  async closeItem(
    scope: Scope,
    item: PlantRow,
    status: "off_hire" | "disposed",
    closedOn: string,
    reason: string,
  ) {
    const { tx, access } = scope;
    requireRecentDate(closedOn, PLANT_LIMITS.maxBackdateDays);
    const hireStartOn = optionalDate(item.hireStartOn);
    if (closedOn < toCalendarDate(item.openingOn) || (hireStartOn && closedOn < hireStartOn))
      throw plantProblem(409, "invalid-transition", "Plant is closed on or after its start date");
    if (item.siteId) await this.recordMove(scope, item, null, closedOn, null);
    const operators = await tx.plantOperator.findMany({
      where: { tenantId: access.tenantId, plantId: item.id, endedBy: null },
    });
    for (const operator of operators) {
      const from = toCalendarDate(operator.fromOn);
      const end = closedOn < from ? from : closedOn;
      const to =
        operator.toOn && toCalendarDate(operator.toOn) < end ? toCalendarDate(operator.toOn) : end;
      await tx.plantOperator.update({
        where: { tenantId_id: { tenantId: access.tenantId, id: operator.id } },
        data: { toOn: fromCalendarDate(to), endedBy: access.userId, version: { increment: 1 } },
      });
    }
    const result = await tx.plantItem.updateMany({
      where: { tenantId: access.tenantId, id: item.id, version: item.version },
      data: {
        status,
        closedOn: fromCalendarDate(closedOn),
        statusReason: reason,
        projectId: null,
        siteId: null,
        updatedBy: access.userId,
        version: { increment: 1 },
      },
    });
    if (result.count !== 1) throw versionConflict();
  }

  async detailResponse(scope: Scope, caller: PlantCaller, plantId: string) {
    const { tx, access } = scope;
    const item = await this.itemRow(scope, plantId);
    const settings = await plantSettings(tx, access.tenantId);
    const today = nairobiDate();
    const facts = (await loadPlantFacts(tx, access.tenantId, [item], settings, today)).get(
      item.id,
    )!;
    const summary = summarisePlant(item, facts, settings, caller, caller.costSomewhere, today);
    const [moves, operators, breakdowns, services, resets] = await Promise.all([
      tx.plantMove.findMany({
        where: { tenantId: access.tenantId, plantId },
        include: {
          fromSite: { select: { name: true } },
          toSite: { select: { name: true } },
        },
        orderBy: { seq: "desc" },
      }),
      tx.plantOperator.findMany({
        where: { tenantId: access.tenantId, plantId },
        include: { labourer: { select: { id: true, workerNo: true, fullName: true } } },
        orderBy: [{ fromOn: "desc" }, { id: "asc" }],
      }),
      tx.plantBreakdown.findMany({
        where: { tenantId: access.tenantId, plantId },
        include: { site: { select: { name: true } } },
        orderBy: { number: "desc" },
        take: 50,
      }),
      tx.plantService.findMany({
        where: { tenantId: access.tenantId, plantId },
        orderBy: { servicedAt: "desc" },
        take: 50,
      }),
      tx.plantMeterReset.findMany({
        where: { tenantId: access.tenantId, plantId },
        orderBy: { resetAt: "desc" },
      }),
    ]);
    const visible = (projectId: string | null) => projectId === null || caller.canRead(projectId);
    const shownOperators = operators.filter((row) => visible(row.projectId));
    const shownBreakdowns = breakdowns.filter((row) => visible(row.projectId));
    const shownServices = services.filter((row) => visible(row.projectId));
    const people = await peopleOf(tx, [
      item.createdBy,
      ...moves.map((row) => row.movedBy),
      ...shownOperators.map((row) => row.userId),
      ...shownBreakdowns.flatMap((row) => [row.reportedBy, row.resolvedBy]),
      ...shownServices.map((row) => row.recordedBy),
      ...resets.map((row) => row.recordedBy),
    ]);
    const closed = isPlantClosed(item.status as PlantStatus);
    const manage = caller.canManageItem(item);
    const project = item.projectId;
    return plantDetailResponseSchema.parse({
      item: {
        ...summary,
        lpo: item.lpo ? { id: item.lpo.id, number: item.lpo.number } : null,
        hireEndOn: optionalDate(item.hireEndOn),
        standardConsumption: decimal2(item.standardConsumption),
        openingOn: toCalendarDate(item.openingOn),
        openingReading: decimal1(item.openingReading),
        serviceEvery: decimal1(item.serviceEvery),
        serviceEveryDays: item.serviceEveryDays,
        notes: item.notes,
        createdBy: personOf(people, item.createdBy),
        createdAt: item.createdAt.toISOString(),
      },
      moves: moves.map((row) => {
        const from = locationOf(
          caller,
          row.fromProjectId,
          row.fromSiteId,
          row.fromSite?.name ?? null,
        );
        const to = locationOf(caller, row.toProjectId, row.toSiteId, row.toSite?.name ?? null);
        return {
          id: row.id,
          seq: row.seq,
          movedOn: toCalendarDate(row.movedOn),
          from: from.location,
          to: to.location,
          restricted: from.restricted || to.restricted,
          reason: from.restricted || to.restricted ? null : row.reason,
          movedBy: personOf(people, row.movedBy),
          createdAt: row.createdAt.toISOString(),
        };
      }),
      operators: shownOperators.map((row) =>
        operatorState(
          row,
          item,
          settings,
          people,
          today,
          !closed && caller.canManage(row.projectId),
        ),
      ),
      breakdowns: shownBreakdowns.map((row) => {
        const open = row.status === "open" && !closed;
        const reportedOn = toCalendarDate(new Date(row.reportedAt.getTime() + 3 * 3_600_000));
        return {
          id: row.id,
          code: breakdownCode(row.number),
          projectId: row.projectId,
          siteId: row.siteId,
          siteName: row.site.name,
          reportedAt: row.reportedAt.toISOString(),
          severity: row.severity,
          description: row.description,
          status: row.status,
          reportedBy: personOf(people, row.reportedBy),
          resolvedOn: optionalDate(row.resolvedOn),
          resolutionNote: row.resolutionNote,
          repairedBy: row.repairedBy,
          costReference: row.costReference,
          resolvedBy: row.resolvedBy ? personOf(people, row.resolvedBy) : null,
          daysDown: Math.max(
            0,
            calendarDaysBetween(reportedOn, optionalDate(row.resolvedOn) ?? today),
          ),
          version: row.version,
          permissions: {
            canRepair:
              open &&
              (row.severity === "unsafe"
                ? caller.canManage(row.projectId)
                : caller.canRecord(row.projectId)),
            canOffHire: open && item.ownership === "hired" && caller.canManage(row.projectId),
            canWriteOff: open && item.ownership === "owned" && caller.canManage(row.projectId),
          },
        };
      }),
      services: shownServices.map((row) => ({
        id: row.id,
        servicedAt: row.servicedAt.toISOString(),
        kind: row.kind,
        meterReading: decimal1(row.meterReading),
        description: row.description,
        doneBy: row.doneBy,
        costReference: row.costReference,
        status: row.status,
        voidReason: row.voidReason,
        recordedBy: personOf(people, row.recordedBy),
        version: row.version,
        permissions: { canVoid: row.status === "recorded" && !closed && manage },
      })),
      resets: resets.map((row) => ({
        id: row.id,
        resetAt: row.resetAt.toISOString(),
        oldReading: decimal1(row.oldReading)!,
        newReading: decimal1(row.newReading)!,
        reason: row.reason,
        note: row.note,
        recordedBy: personOf(people, row.recordedBy),
      })),
      permissions: {
        canEdit: !closed && manage,
        canMove: !closed && manage,
        canClose: !closed && manage && facts.openBreakdowns.length === 0,
        canAssignOperator: !closed && project !== null && caller.canManage(project),
        canResetMeter: !closed && manage && item.meterType !== "none",
        canRecordUsage: !closed && project !== null && caller.canRecord(project),
        canRecordFuel:
          !closed && item.fuelType !== "none" && project !== null && caller.canFuel(project),
        canReportBreakdown: !closed && project !== null && caller.canRecord(project),
        canRecordService: !closed && (project !== null ? caller.canRecord(project) : manage),
        canSeeCost: caller.costSomewhere,
      },
    });
  }

  private settingsResponse(settings: PlantSettingsValues, canEdit: boolean) {
    return plantSettingsResponseSchema.parse({
      settings: {
        fuelVariancePercent: settings.fuelVariancePercent,
        fuelMinHours: settings.fuelMinHours,
        fuelMinKm: settings.fuelMinKm,
        idleHireDays: settings.idleHireDays,
        hireEndingDays: settings.hireEndingDays,
        serviceDueSoonPercent: settings.serviceDueSoonPercent,
        certificateCategories: settings.certificateCategories,
        version: settings.version,
        updatedAt: settings.updatedAt?.toISOString() ?? null,
        permissions: { canEdit },
      },
    });
  }
}
