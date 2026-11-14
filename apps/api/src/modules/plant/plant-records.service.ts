import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  addCalendarDays,
  checkMeterReading,
  checkUsageReadings,
  formatTenths,
  fuelWindows,
  isPlantClosed,
  nairobiDate,
  parseTenths,
  plantBusinessDate,
  plantDayStart,
  type MeterReading,
  type MeterReset,
} from "@pm-buddy/domain";
import { PLANT_LIMITS, type OperatorKind, type PlantStatus } from "@pm-buddy/types";
import {
  plantFuelListResponseSchema,
  plantFuelResponseSchema,
  plantUsageListResponseSchema,
  plantUsageResponseSchema,
  type ParsedCorrectFuelRequest,
  type ParsedCorrectUsageRequest,
  type ParsedRecordFuelRequest,
  type ParsedRecordUsageRequest,
  type PlantRecordsQuery,
  type RecordMeterResetRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { approvedBqVersion } from "../finance/spending-common.js";
import { requestDigest } from "../procurement/p2p/p2p-common.js";
import { peopleOf, personOf } from "../procurement/procurement-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  lockPlant,
  PlantAccess,
  plantProblem,
  plantSettings,
  requireNotFutureMoment,
  requireRecentDate,
  requireWritable,
  type PlantCaller,
} from "./plant-access.js";
import {
  currentFuelIssues,
  decimal1,
  decimal2,
  fuelPointOf,
  fuelRules,
  resetOf,
  tenthsOf,
  windowWire,
  type PlantRow,
} from "./plant-model.js";
import { PlantRegisterService } from "./plant-register.service.js";

type Tx = Prisma.TransactionClient;
type UsageRow = Prisma.PlantUsageLogGetPayload<object>;
type FuelRow = Prisma.PlantFuelIssueGetPayload<object>;

const DAY_LIMIT_TENTHS = { hours: PLANT_LIMITS.maxDayHoursTenths, km: PLANT_LIMITS.maxDayKmTenths };

/** Every current reading of an item (the database's own list) and its resets. */
export async function meterHistory(
  tx: Tx,
  tenantId: string,
  plantId: string,
  excluded: string | null,
): Promise<{ readings: MeterReading[]; resets: MeterReset[] }> {
  const [rows, resets] = await Promise.all([
    tx.$queryRaw<{ read_at: Date; reading: Prisma.Decimal }[]>`
      SELECT read_at, reading FROM app.plant_meter_readings(${tenantId}::uuid, ${plantId}::uuid, ${excluded}::uuid)`,
    tx.plantMeterReset.findMany({ where: { tenantId, plantId } }),
  ]);
  return {
    readings: rows.map((row) => ({
      at: row.read_at.getTime(),
      tenths: tenthsOf(row.reading)!,
      sourceId: null,
    })),
    resets: resets.map(resetOf),
  };
}

/** 409 meter-out-of-order naming the neighbouring readings (numbers only) in the detail. */
const outOfOrder = (previous: number | null, next: number | null) =>
  plantProblem(
    409,
    "meter-out-of-order",
    `A meter reading cannot be lower than an earlier one or higher than a later one (earlier: ${
      previous === null ? "none" : formatTenths(previous)
    }; later: ${next === null ? "none" : formatTenths(next)})`,
  );

/**
 * Daily usage, fuel issues and meter resets (D8.3). Usage logs and fuel issues are append-only
 * (decision D-91): a correction or void is a new row naming the row it replaces, once, with a
 * reason, by plant.manage or whoever recorded it. Every reading keeps the meter monotonic in time
 * (D-92). Both are offline-ready: a client-generated ID and an Idempotency-Key; a replay returns
 * the original. Nothing posts to the stores or cost ledgers (D-93).
 */
@Injectable()
export class PlantRecordsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly plant: PlantAccess,
    private readonly register: PlantRegisterService,
  ) {}

  // Usage ---------------------------------------------------------------------------------------

  listUsage(principal: Principal, plantId: string, query: PlantRecordsQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.plant.reader(scope);
      const item = await this.register.itemRow(scope, plantId);
      const { tx, access } = scope;
      const where: Prisma.PlantUsageLogWhereInput = {
        tenantId: access.tenantId,
        plantId,
        projectId: { in: [...caller.projects.keys()].filter((id) => caller.canRead(id)) },
      };
      const offset = query.cursor ?? 0;
      const [rows, corrections, recent] = await Promise.all([
        tx.plantUsageLog.findMany({
          where,
          orderBy: [{ usedOn: "desc" }, { recordedAt: "desc" }],
          skip: offset,
          take: query.limit + 1,
        }),
        tx.plantUsageLog.findMany({
          where: { tenantId: access.tenantId, plantId, correctsId: { not: null } },
          select: { id: true, correctsId: true },
        }),
        tx.plantUsageLog.findMany({
          where: {
            ...where,
            usedOn: { gte: fromCalendarDate(addCalendarDays(nairobiDate(), -29)) },
            isVoid: false,
          },
        }),
      ]);
      const supersededBy = new Map(corrections.map((row) => [row.correctsId!, row.id]));
      const current = recent.filter((row) => !supersededBy.has(row.id));
      const runs = current
        .map((row) =>
          row.startReading && row.endReading
            ? tenthsOf(row.endReading)! - tenthsOf(row.startReading)!
            : null,
        )
        .filter((run): run is number => run !== null);
      const page = rows.slice(0, query.limit);
      const wires = await this.usageWires(scope, caller, item, page, supersededBy);
      return plantUsageListResponseSchema.parse({
        entries: wires,
        nextCursor: rows.length > query.limit ? offset + query.limit : null,
        totals: {
          workingDays30: current.filter((row) => row.dayStatus === "working").length,
          idleDays30: current.filter((row) => row.dayStatus === "idle").length,
          breakdownDays30: current.filter((row) => row.dayStatus === "breakdown").length,
          run30: item.meterType === "none" ? null : formatTenths(runs.reduce((a, b) => a + b, 0)),
        },
      });
    });
  }

  recordUsage(
    principal: Principal,
    plantId: string,
    input: ParsedRecordUsageRequest,
    key: string,
    req: Request,
  ) {
    const digest = requestDigest("plant.usage", { plantId, ...input });
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const replay = await this.usageReplay(scope, key, digest, input.id);
        if (replay) return replay;
        const caller = await this.plant.reader(scope);
        const { tx, access } = scope;
        await lockPlant(tx, access.tenantId, plantId);
        const item = await this.openItem(scope, plantId);
        const projectId = await this.recordSite(
          scope,
          caller,
          item,
          input.siteId,
          input.usedOn,
          "record",
        );
        const existing = await tx.plantUsageLog.findFirst({
          where: {
            tenantId: access.tenantId,
            plantId,
            usedOn: fromCalendarDate(input.usedOn),
            correctsId: null,
          },
          select: { id: true },
        });
        if (existing)
          throw plantProblem(
            409,
            "usage-day-exists",
            "This day is already logged for the item; correct that entry instead",
          );
        await this.checkUsage(scope, item, projectId, input, null);
        await tx.plantUsageLog.create({
          data: await this.withBq(
            scope,
            projectId,
            this.usageData(scope, item, projectId, input, key, digest, input.usedOn),
            input.bqItemLineageId,
          ),
        });
        await this.scope.audit(tx, "plant.usage_recorded", input.id, {
          plantId,
          code: item.code,
          projectId,
          siteId: input.siteId,
          usedOn: input.usedOn,
          dayStatus: input.dayStatus,
        });
        return this.usageResponse(scope, caller, item, input.id, false);
      },
      true,
    );
  }

  correctUsage(
    principal: Principal,
    plantId: string,
    logId: string,
    input: ParsedCorrectUsageRequest,
    key: string,
    req: Request,
  ) {
    const digest = requestDigest("plant.usage_correction", { plantId, logId, ...input });
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const replay = await this.usageReplay(scope, key, digest, input.id);
        if (replay) return replay;
        const caller = await this.plant.reader(scope);
        const { tx, access } = scope;
        await lockPlant(tx, access.tenantId, plantId);
        const item = await this.openItem(scope, plantId);
        const original = await tx.plantUsageLog.findFirst({
          where: { tenantId: access.tenantId, plantId, id: logId },
        });
        if (!original || !caller.canRead(original.projectId))
          throw new NotFoundException("Usage entry not found");
        await this.requireCorrector(scope, caller, original, "usage");
        const usedOn = toCalendarDate(original.usedOn);
        let projectId = original.projectId;
        if (input.action === "void") {
          if (original.isVoid)
            throw plantProblem(409, "record-already-void", "This entry is already void");
          requireWritable(caller, projectId);
          await tx.plantUsageLog.create({
            data: {
              ...original,
              id: input.id,
              correctsId: logId,
              correctionReason: input.reason,
              isVoid: true,
              idempotencyKey: key,
              requestDigest: digest,
              capturedAt: new Date(input.capturedAt),
              recordedBy: access.userId,
              recordedAt: new Date(),
            },
          });
        } else {
          projectId = await this.recordSite(scope, caller, item, input.siteId, usedOn, "record");
          await this.checkUsage(scope, item, projectId, input, logId, usedOn);
          await tx.plantUsageLog.create({
            data: {
              ...(await this.withBq(
                scope,
                projectId,
                this.usageData(scope, item, projectId, input, key, digest, usedOn),
                input.bqItemLineageId,
              )),
              correctsId: logId,
              correctionReason: input.reason,
            },
          });
        }
        await this.scope.audit(
          tx,
          input.action === "void" ? "plant.usage_voided" : "plant.usage_corrected",
          input.id,
          { plantId, code: item.code, projectId, correctsId: logId },
        );
        return this.usageResponse(scope, caller, item, input.id, false);
      },
      true,
    );
  }

  // Fuel ----------------------------------------------------------------------------------------

  listFuel(principal: Principal, plantId: string, query: PlantRecordsQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.plant.reader(scope);
      const item = await this.register.itemRow(scope, plantId);
      const { tx, access } = scope;
      const readable = [...caller.projects.keys()].filter((id) => caller.canRead(id));
      const offset = query.cursor ?? 0;
      const settings = await plantSettings(tx, access.tenantId);
      const since = new Date(
        plantDayStart(addCalendarDays(nairobiDate(), -PLANT_LIMITS.fuelLookbackDays)),
      );
      const [rows, corrections, current, resets] = await Promise.all([
        tx.plantFuelIssue.findMany({
          where: { tenantId: access.tenantId, plantId, projectId: { in: readable } },
          orderBy: [{ issuedAt: "desc" }, { recordedAt: "desc" }],
          skip: offset,
          take: query.limit + 1,
        }),
        tx.plantFuelIssue.findMany({
          where: { tenantId: access.tenantId, plantId, correctsId: { not: null } },
          select: { id: true, correctsId: true },
        }),
        currentFuelIssues(tx, access.tenantId, [plantId], since),
        tx.plantMeterReset.findMany({ where: { tenantId: access.tenantId, plantId } }),
      ]);
      const analysis = fuelWindows(
        current.map(fuelPointOf),
        resets.map(resetOf),
        fuelRules(item.meterType, settings),
      );
      const readableIssue = new Set(
        current.filter((row) => readable.includes(row.projectId)).map((row) => row.id),
      );
      const supersededBy = new Map(corrections.map((row) => [row.correctsId!, row.id]));
      const page = rows.slice(0, query.limit);
      const pending = analysis.pending;
      return plantFuelListResponseSchema.parse({
        entries: await this.fuelWires(scope, caller, page, supersededBy, analysis.staticIssueIds),
        nextCursor: rows.length > query.limit ? offset + query.limit : null,
        windows: analysis.windows
          .filter((window) => readableIssue.has(window.toId))
          .reverse()
          .map(windowWire),
        pending: {
          issueCount: pending.issueIds.length,
          litres: formatTenths(pending.litresTenths),
          advance: formatTenths(pending.advanceTenths),
        },
        rules: {
          tolerancePercent: settings.fuelVariancePercent,
          minSample: item.meterType === "km" ? settings.fuelMinKm : settings.fuelMinHours,
          meterType: item.meterType,
        },
      });
    });
  }

  recordFuel(
    principal: Principal,
    plantId: string,
    input: ParsedRecordFuelRequest,
    key: string,
    req: Request,
  ) {
    const digest = requestDigest("plant.fuel", { plantId, ...input });
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const replay = await this.fuelReplay(scope, key, digest, input.id);
        if (replay) return replay;
        const caller = await this.plant.reader(scope);
        const { tx, access } = scope;
        await lockPlant(tx, access.tenantId, plantId);
        const item = await this.openItem(scope, plantId);
        const projectId = await this.checkFuel(scope, caller, item, input, null);
        await tx.plantFuelIssue.create({
          data: this.fuelData(scope, item, projectId, input, key, digest),
        });
        const window = await this.closedWindow(scope, item, input.id);
        await this.scope.audit(tx, "plant.fuel_recorded", input.id, {
          plantId,
          code: item.code,
          projectId,
          siteId: input.siteId,
          tankFilled: input.tankFilled,
          windowState: window?.state ?? null,
        });
        return this.fuelResponse(scope, caller, item, input.id, false);
      },
      true,
    );
  }

  correctFuel(
    principal: Principal,
    plantId: string,
    issueId: string,
    input: ParsedCorrectFuelRequest,
    key: string,
    req: Request,
  ) {
    const digest = requestDigest("plant.fuel_correction", { plantId, issueId, ...input });
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const replay = await this.fuelReplay(scope, key, digest, input.id);
        if (replay) return replay;
        const caller = await this.plant.reader(scope);
        const { tx, access } = scope;
        await lockPlant(tx, access.tenantId, plantId);
        const item = await this.openItem(scope, plantId);
        const original = await tx.plantFuelIssue.findFirst({
          where: { tenantId: access.tenantId, plantId, id: issueId },
        });
        if (!original || !caller.canRead(original.projectId))
          throw new NotFoundException("Fuel issue not found");
        await this.requireCorrector(scope, caller, original, "fuel");
        let projectId = original.projectId;
        if (input.action === "void") {
          if (original.isVoid)
            throw plantProblem(409, "record-already-void", "This entry is already void");
          requireWritable(caller, projectId);
          await tx.plantFuelIssue.create({
            data: {
              ...original,
              id: input.id,
              correctsId: issueId,
              correctionReason: input.reason,
              isVoid: true,
              idempotencyKey: key,
              requestDigest: digest,
              capturedAt: new Date(input.capturedAt),
              recordedBy: access.userId,
              recordedAt: new Date(),
            },
          });
        } else {
          projectId = await this.checkFuel(scope, caller, item, input, issueId);
          await tx.plantFuelIssue.create({
            data: {
              ...this.fuelData(scope, item, projectId, input, key, digest),
              correctsId: issueId,
              correctionReason: input.reason,
            },
          });
        }
        await this.scope.audit(
          tx,
          input.action === "void" ? "plant.fuel_voided" : "plant.fuel_corrected",
          input.id,
          { plantId, code: item.code, projectId, correctsId: issueId },
        );
        return this.fuelResponse(scope, caller, item, input.id, false);
      },
      true,
    );
  }

  // Meter resets --------------------------------------------------------------------------------

  resetMeter(principal: Principal, plantId: string, input: RecordMeterResetRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.plant.reader(scope);
        const { tx, access } = scope;
        await lockPlant(tx, access.tenantId, plantId);
        const item = await this.openItem(scope, plantId);
        if (!caller.canManageItem(item))
          throw new ForbiddenException("Permission required: plant.manage");
        if (item.meterType === "none")
          throw plantProblem(409, "plant-not-metered", "This item has no meter");
        requireNotFutureMoment(input.resetAt);
        const at = Date.parse(input.resetAt);
        const history = await meterHistory(tx, access.tenantId, plantId, null);
        if (history.readings.some((reading) => reading.at >= at))
          throw plantProblem(
            409,
            "meter-reset-order",
            "A meter reset comes after every reading already recorded",
          );
        const check = checkMeterReading(
          history.readings,
          history.resets,
          at - 1,
          parseTenths(input.oldReading)!,
        );
        if (!check.ok) throw outOfOrder(check.previous, check.next);
        const id = uuidv7();
        await tx.plantMeterReset.create({
          data: {
            id,
            tenantId: access.tenantId,
            plantId,
            resetAt: new Date(input.resetAt),
            oldReading: input.oldReading,
            newReading: input.newReading,
            reason: input.reason,
            note: input.note,
            recordedBy: access.userId,
          },
        });
        await this.scope.audit(tx, "plant.meter_reset", id, {
          plantId,
          code: item.code,
          reason: input.reason,
        });
        return this.register.detailResponse(scope, caller, plantId);
      },
      true,
    );
  }

  // Helpers -------------------------------------------------------------------------------------

  private async openItem(scope: Scope, plantId: string) {
    const item = await this.register.itemRow(scope, plantId);
    if (isPlantClosed(item.status as PlantStatus))
      throw plantProblem(409, "plant-closed", "Off-hired and disposed plant is final");
    return item;
  }

  /**
   * The site's project, where the caller may record (usage and breakdowns) or issue fuel, and
   * where the item was on that day.
   */
  async recordSite(
    scope: Scope,
    caller: PlantCaller,
    item: PlantRow,
    siteId: string,
    day: string,
    kind: "record" | "fuel",
  ): Promise<string> {
    const { tx, access } = scope;
    const site = await tx.site.findFirst({
      where: { tenantId: access.tenantId, id: siteId },
      select: { projectId: true },
    });
    if (!site || !caller.canRead(site.projectId)) throw new NotFoundException("Site not found");
    requireWritable(caller, site.projectId);
    if (!(kind === "fuel" ? caller.canFuel(site.projectId) : caller.canRecord(site.projectId)))
      throw new ForbiddenException(
        kind === "fuel"
          ? "One of plant.manage, site.diary or stores.manage is required on the project"
          : "Permission required: site.diary or plant.manage on the project",
      );
    requireRecentDate(day, PLANT_LIMITS.maxBackdateDays);
    if (day < toCalendarDate(item.openingOn))
      throw plantProblem(409, "plant-not-on-site", "The item was not registered yet on that day");
    const [present] = await tx.$queryRaw<{ present: boolean }[]>`
      SELECT app.plant_present(${access.tenantId}::uuid, ${item.id}::uuid, ${siteId}::uuid, ${day}::date) AS present`;
    if (!present?.present)
      throw plantProblem(409, "plant-not-on-site", "The item was not at this site on that day");
    return site.projectId;
  }

  private async requireCorrector(
    scope: Scope,
    caller: PlantCaller,
    original: { id: string; projectId: string; recordedBy: string },
    kind: "usage" | "fuel",
  ) {
    const { tx, access } = scope;
    const later =
      kind === "usage"
        ? await tx.plantUsageLog.count({
            where: { tenantId: access.tenantId, correctsId: original.id },
          })
        : await tx.plantFuelIssue.count({
            where: { tenantId: access.tenantId, correctsId: original.id },
          });
    if (later)
      throw plantProblem(
        409,
        "record-superseded",
        "This entry was already corrected; correct the newest one",
      );
    const allowed =
      (kind === "usage"
        ? caller.canRecord(original.projectId)
        : caller.canFuel(original.projectId)) &&
      (caller.holdsManage(original.projectId) || original.recordedBy === access.userId);
    if (!allowed) {
      requireWritable(caller, original.projectId);
      throw new ForbiddenException(
        "Only plant.manage or whoever recorded the entry may correct it",
      );
    }
  }

  private async checkUsage(
    scope: Scope,
    item: PlantRow,
    projectId: string,
    input: {
      usedOn?: string;
      dayStatus: string;
      startReading?: string | null | undefined;
      endReading?: string | null | undefined;
      operatorLabourerId?: string | null | undefined;
      operatorUserId?: string | null | undefined;
      bqItemLineageId?: string | null | undefined;
      costCodeId?: string | null | undefined;
    },
    excluded: string | null,
    usedOn = input.usedOn!,
  ) {
    const { tx, access } = scope;
    const metered = item.meterType !== "none";
    if (metered !== Boolean(input.startReading))
      throw plantProblem(
        422,
        "plant-not-metered",
        metered
          ? "Enter the start and end readings"
          : "This item has no meter; leave readings empty",
      );
    if (metered) {
      const start = parseTenths(input.startReading!)!;
      const end = parseTenths(input.endReading!)!;
      if (end - start > DAY_LIMIT_TENTHS[item.meterType as "hours" | "km"])
        throw plantProblem(
          409,
          "meter-day-limit",
          item.meterType === "hours"
            ? "One day's usage cannot exceed 24 hours"
            : "One day's usage cannot exceed 1,500 km",
        );
      const history = await meterHistory(tx, access.tenantId, item.id, excluded);
      const check = checkUsageReadings(history.readings, history.resets, usedOn, start, end);
      if (!check.ok) throw outOfOrder(check.previous, check.next);
    }
    if (input.dayStatus === "working") {
      const unsafe = await tx.plantBreakdown.findMany({
        where: { tenantId: access.tenantId, plantId: item.id, status: "open", severity: "unsafe" },
        select: { reportedAt: true },
      });
      if (unsafe.some((row) => plantBusinessDate(row.reportedAt.getTime()) <= usedOn))
        throw plantProblem(
          409,
          "plant-unsafe",
          "This item has an open unsafe breakdown and must not be used",
        );
    }
    for (const [labourerId, userId] of [
      [input.operatorLabourerId ?? null, null],
      [null, input.operatorUserId ?? null],
    ] as const) {
      if (!labourerId && !userId) continue;
      const assigned = await tx.plantOperator.count({
        where: {
          tenantId: access.tenantId,
          plantId: item.id,
          ...(labourerId ? { labourerId } : { userId: userId! }),
          fromOn: { lte: fromCalendarDate(usedOn) },
          OR: [{ toOn: null }, { toOn: { gte: fromCalendarDate(usedOn) } }],
        },
      });
      if (!assigned)
        throw plantProblem(
          422,
          "operator-not-assigned",
          "This operator was not assigned to the item on that day",
        );
    }
    if (input.bqItemLineageId) {
      const version = await approvedBqVersion(tx, access.tenantId, projectId);
      const bqItem = version
        ? await tx.bqItem.findUnique({
            where: {
              tenantId_versionId_lineageId: {
                tenantId: access.tenantId,
                versionId: version.id,
                lineageId: input.bqItemLineageId,
              },
            },
            select: { id: true },
          })
        : null;
      if (!bqItem)
        throw plantProblem(404, "bq-item-not-found", "BQ item not found on the approved BQ");
    }
    if (input.costCodeId) {
      const code = await tx.costCode.findFirst({
        where: { tenantId: access.tenantId, id: input.costCodeId, active: true },
        select: { id: true },
      });
      if (!code) throw plantProblem(422, "cost-code-not-found", "Cost code not found or inactive");
    }
  }

  private usageData(
    scope: Scope,
    item: PlantRow,
    projectId: string,
    input: ParsedRecordUsageRequest | Extract<ParsedCorrectUsageRequest, { action: "correct" }>,
    key: string,
    digest: string,
    usedOn: string,
  ): Prisma.PlantUsageLogUncheckedCreateInput {
    return {
      id: input.id,
      tenantId: scope.access.tenantId,
      plantId: item.id,
      projectId,
      siteId: input.siteId,
      usedOn: fromCalendarDate(usedOn),
      dayStatus: input.dayStatus,
      startReading: input.startReading ?? null,
      endReading: input.endReading ?? null,
      operatorLabourerId: input.operatorLabourerId ?? null,
      operatorUserId: input.operatorUserId ?? null,
      bqVersionId: null,
      bqItemLineageId: null,
      costCodeId: input.costCodeId ?? null,
      notes: input.notes ?? null,
      idempotencyKey: key,
      requestDigest: digest,
      capturedAt: new Date(input.capturedAt),
      recordedBy: scope.access.userId,
    };
  }

  private async withBq(
    scope: Scope,
    projectId: string,
    data: Prisma.PlantUsageLogUncheckedCreateInput,
    lineageId: string | null | undefined,
  ) {
    if (!lineageId) return data;
    const version = await approvedBqVersion(scope.tx, scope.access.tenantId, projectId);
    return { ...data, bqVersionId: version!.id, bqItemLineageId: lineageId };
  }

  private async usageReplay(scope: Scope, key: string, digest: string, id: string) {
    const { tx, access } = scope;
    const replay = await tx.plantUsageLog.findUnique({
      where: { tenantId_idempotencyKey: { tenantId: access.tenantId, idempotencyKey: key } },
    });
    if (replay) {
      if (replay.requestDigest !== digest || replay.id !== id)
        throw plantProblem(
          409,
          "idempotency-key-reused",
          "This idempotency key was used for a different entry",
        );
      const caller = await this.plant.reader(scope);
      if (!caller.canRead(replay.projectId)) throw new NotFoundException("Usage entry not found");
      const item = await this.register.itemRow(scope, replay.plantId);
      return this.usageResponse(scope, caller, item, replay.id, true);
    }
    const clash = await tx.plantUsageLog.findUnique({
      where: { tenantId_id: { tenantId: access.tenantId, id } },
      select: { id: true },
    });
    if (clash)
      throw plantProblem(
        409,
        "usage-id-conflict",
        "An entry with this ID was sent with another key",
      );
    return null;
  }

  private async usageResponse(
    scope: Scope,
    caller: PlantCaller,
    item: PlantRow,
    id: string,
    replayed: boolean,
  ) {
    const { tx, access } = scope;
    const row = await tx.plantUsageLog.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: access.tenantId, id } },
    });
    const corrections = await tx.plantUsageLog.findMany({
      where: { tenantId: access.tenantId, correctsId: id },
      select: { id: true, correctsId: true },
    });
    const [entry] = await this.usageWires(
      scope,
      caller,
      item,
      [row],
      new Map(corrections.map((correction) => [correction.correctsId!, correction.id])),
    );
    return plantUsageResponseSchema.parse({ entry, replayed });
  }

  private async usageWires(
    scope: Scope,
    caller: PlantCaller,
    item: PlantRow,
    rows: UsageRow[],
    supersededBy: Map<string, string>,
  ) {
    const { tx, access } = scope;
    const [people, labourers, sites, costCodes, bqItems] = await Promise.all([
      peopleOf(
        tx,
        rows.flatMap((row) => [row.recordedBy, row.operatorUserId]),
      ),
      tx.labourer.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: rows.map((row) => row.operatorLabourerId).filter((id): id is string => !!id) },
        },
        select: { id: true, fullName: true },
      }),
      tx.site.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: [...new Set(rows.map((row) => row.siteId))] },
        },
        select: { id: true, name: true },
      }),
      tx.costCode.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: rows.map((row) => row.costCodeId).filter((id): id is string => !!id) },
        },
        select: { id: true, code: true, name: true },
      }),
      tx.bqItem.findMany({
        where: {
          tenantId: access.tenantId,
          OR: rows
            .filter((row) => row.bqVersionId && row.bqItemLineageId)
            .map((row) => ({ versionId: row.bqVersionId!, lineageId: row.bqItemLineageId! })),
        },
        select: { versionId: true, lineageId: true, ref: true, description: true },
      }),
    ]);
    const closed = isPlantClosed(item.status as PlantStatus);
    return rows.map((row) => {
      const superseded = supersededBy.get(row.id) ?? null;
      const state = superseded ? "superseded" : row.isVoid ? "voided" : "current";
      const labourer = labourers.find((entry) => entry.id === row.operatorLabourerId);
      const bq = bqItems.find(
        (entry) => entry.versionId === row.bqVersionId && entry.lineageId === row.bqItemLineageId,
      );
      const code = costCodes.find((entry) => entry.id === row.costCodeId);
      const start = tenthsOf(row.startReading);
      const end = tenthsOf(row.endReading);
      return {
        id: row.id,
        projectId: row.projectId,
        siteId: row.siteId,
        siteName: sites.find((site) => site.id === row.siteId)?.name ?? "—",
        state,
        correctsId: row.correctsId,
        correctionReason: row.correctionReason,
        supersededById: superseded,
        recordedBy: personOf(people, row.recordedBy),
        recordedAt: row.recordedAt.toISOString(),
        permissions: {
          canCorrect:
            !closed &&
            superseded === null &&
            caller.canRecord(row.projectId) &&
            (caller.holdsManage(row.projectId) || row.recordedBy === access.userId),
        },
        usedOn: toCalendarDate(row.usedOn),
        dayStatus: row.dayStatus,
        startReading: decimal1(row.startReading),
        endReading: decimal1(row.endReading),
        run: start !== null && end !== null ? formatTenths(end - start) : null,
        operator: row.operatorLabourerId
          ? {
              id: row.operatorLabourerId,
              name: labourer?.fullName ?? "—",
              kind: "labourer" as OperatorKind,
            }
          : row.operatorUserId
            ? {
                id: row.operatorUserId,
                name: personOf(people, row.operatorUserId).displayName,
                kind: "staff" as OperatorKind,
              }
            : null,
        bqItem: bq ? { lineageId: bq.lineageId, ref: bq.ref, description: bq.description } : null,
        costCode: code ? { id: code.id, code: code.code, name: code.name } : null,
        notes: row.notes,
      };
    });
  }

  private async checkFuel(
    scope: Scope,
    caller: PlantCaller,
    item: PlantRow,
    input: ParsedRecordFuelRequest | Extract<ParsedCorrectFuelRequest, { action: "correct" }>,
    excluded: string | null,
  ): Promise<string> {
    const { tx, access } = scope;
    if (item.fuelType === "none")
      throw plantProblem(409, "plant-no-fuel", "This item does not use fuel");
    requireNotFutureMoment(input.issuedAt);
    const at = Date.parse(input.issuedAt);
    const projectId = await this.recordSite(
      scope,
      caller,
      item,
      input.siteId,
      plantBusinessDate(at),
      "fuel",
    );
    const metered = item.meterType !== "none";
    if (metered !== Boolean(input.meterReading))
      throw plantProblem(
        422,
        "plant-not-metered",
        metered
          ? "Enter the meter reading at fuelling"
          : "This item has no meter; leave the reading empty",
      );
    if (metered) {
      const history = await meterHistory(tx, access.tenantId, item.id, excluded);
      const check = checkMeterReading(
        history.readings,
        history.resets,
        at,
        parseTenths(input.meterReading!)!,
      );
      if (!check.ok) throw outOfOrder(check.previous, check.next);
    }
    if (input.receivedByLabourerId) {
      const engaged = await tx.labourEngagement.count({
        where: { tenantId: access.tenantId, projectId, labourerId: input.receivedByLabourerId },
      });
      if (!engaged)
        throw plantProblem(
          422,
          "labourer-not-on-project",
          "The receiver is not engaged on this project",
        );
    }
    if (input.receivedByUserId) {
      const member = await tx.membership.count({
        where: { tenantId: access.tenantId, userId: input.receivedByUserId },
      });
      if (!member)
        throw plantProblem(
          422,
          "person-not-in-company",
          "The receiver is not a member of the company",
        );
    }
    return projectId;
  }

  private fuelData(
    scope: Scope,
    item: PlantRow,
    projectId: string,
    input: ParsedRecordFuelRequest | Extract<ParsedCorrectFuelRequest, { action: "correct" }>,
    key: string,
    digest: string,
  ): Prisma.PlantFuelIssueUncheckedCreateInput {
    return {
      id: input.id,
      tenantId: scope.access.tenantId,
      plantId: item.id,
      projectId,
      siteId: input.siteId,
      issuedAt: new Date(input.issuedAt),
      litres: input.litres,
      meterReading: input.meterReading ?? null,
      tankFilled: input.tankFilled,
      fuelType: item.fuelType,
      standardConsumption: item.standardConsumption,
      source: input.source,
      reference: input.reference ?? null,
      receivedByLabourerId: input.receivedByLabourerId ?? null,
      receivedByUserId: input.receivedByUserId ?? null,
      notes: input.notes ?? null,
      idempotencyKey: key,
      requestDigest: digest,
      capturedAt: new Date(input.capturedAt),
      recordedBy: scope.access.userId,
    };
  }

  /** The item's fuel windows over the look-back period. */
  private async fuelAnalysis(scope: Scope, item: PlantRow) {
    const { tx, access } = scope;
    const settings = await plantSettings(tx, access.tenantId);
    const since = new Date(
      plantDayStart(addCalendarDays(nairobiDate(), -PLANT_LIMITS.fuelLookbackDays)),
    );
    const [current, resets] = await Promise.all([
      currentFuelIssues(tx, access.tenantId, [item.id], since),
      tx.plantMeterReset.findMany({ where: { tenantId: access.tenantId, plantId: item.id } }),
    ]);
    return fuelWindows(
      current.map(fuelPointOf),
      resets.map(resetOf),
      fuelRules(item.meterType, settings),
    );
  }

  /** The fuel window the issue closed, if any (for the response and the audit). */
  private async closedWindow(scope: Scope, item: PlantRow, issueId: string) {
    return (
      (await this.fuelAnalysis(scope, item)).windows.find((window) => window.toId === issueId) ??
      null
    );
  }

  private async fuelReplay(scope: Scope, key: string, digest: string, id: string) {
    const { tx, access } = scope;
    const replay = await tx.plantFuelIssue.findUnique({
      where: { tenantId_idempotencyKey: { tenantId: access.tenantId, idempotencyKey: key } },
    });
    if (replay) {
      if (replay.requestDigest !== digest || replay.id !== id)
        throw plantProblem(
          409,
          "idempotency-key-reused",
          "This idempotency key was used for a different entry",
        );
      const caller = await this.plant.reader(scope);
      if (!caller.canRead(replay.projectId)) throw new NotFoundException("Fuel issue not found");
      const item = await this.register.itemRow(scope, replay.plantId);
      return this.fuelResponse(scope, caller, item, replay.id, true);
    }
    const clash = await tx.plantFuelIssue.findUnique({
      where: { tenantId_id: { tenantId: access.tenantId, id } },
      select: { id: true },
    });
    if (clash)
      throw plantProblem(
        409,
        "fuel-id-conflict",
        "A fuel issue with this ID was sent with another key",
      );
    return null;
  }

  private async fuelResponse(
    scope: Scope,
    caller: PlantCaller,
    item: PlantRow,
    id: string,
    replayed: boolean,
  ) {
    const { tx, access } = scope;
    const row = await tx.plantFuelIssue.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: access.tenantId, id } },
    });
    const corrections = await tx.plantFuelIssue.findMany({
      where: { tenantId: access.tenantId, correctsId: id },
      select: { id: true, correctsId: true },
    });
    const analysis = await this.fuelAnalysis(scope, item);
    const window = analysis.windows.find((entry) => entry.toId === id) ?? null;
    const [entry] = await this.fuelWires(
      scope,
      caller,
      [row],
      new Map(corrections.map((correction) => [correction.correctsId!, correction.id])),
      analysis.staticIssueIds,
    );
    return plantFuelResponseSchema.parse({
      entry,
      replayed,
      window: window ? windowWire(window) : null,
    });
  }

  private async fuelWires(
    scope: Scope,
    caller: PlantCaller,
    rows: FuelRow[],
    supersededBy: Map<string, string>,
    staticIds: readonly string[],
  ) {
    const { tx, access } = scope;
    const [people, labourers, sites, items] = await Promise.all([
      peopleOf(
        tx,
        rows.flatMap((row) => [row.recordedBy, row.receivedByUserId]),
      ),
      tx.labourer.findMany({
        where: {
          tenantId: access.tenantId,
          id: {
            in: rows.map((row) => row.receivedByLabourerId).filter((id): id is string => !!id),
          },
        },
        select: { id: true, fullName: true },
      }),
      tx.site.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: [...new Set(rows.map((row) => row.siteId))] },
        },
        select: { id: true, name: true },
      }),
      tx.plantItem.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: [...new Set(rows.map((row) => row.plantId))] },
        },
        select: { id: true, status: true },
      }),
    ]);
    return rows.map((row) => {
      const superseded = supersededBy.get(row.id) ?? null;
      const closed = isPlantClosed(
        (items.find((entry) => entry.id === row.plantId)?.status ?? "available") as PlantStatus,
      );
      return {
        id: row.id,
        projectId: row.projectId,
        siteId: row.siteId,
        siteName: sites.find((site) => site.id === row.siteId)?.name ?? "—",
        state: superseded ? "superseded" : row.isVoid ? "voided" : "current",
        correctsId: row.correctsId,
        correctionReason: row.correctionReason,
        supersededById: superseded,
        recordedBy: personOf(people, row.recordedBy),
        recordedAt: row.recordedAt.toISOString(),
        permissions: {
          canCorrect:
            !closed &&
            superseded === null &&
            caller.canFuel(row.projectId) &&
            (caller.holdsManage(row.projectId) || row.recordedBy === access.userId),
        },
        issuedAt: row.issuedAt.toISOString(),
        litres: decimal1(row.litres)!,
        meterReading: decimal1(row.meterReading),
        tankFilled: row.tankFilled,
        fuelType: row.fuelType,
        standardConsumption: decimal2(row.standardConsumption),
        source: row.source,
        reference: row.reference,
        receivedBy: row.receivedByLabourerId
          ? {
              id: row.receivedByLabourerId,
              name:
                labourers.find((entry) => entry.id === row.receivedByLabourerId)?.fullName ?? "—",
              kind: "labourer" as OperatorKind,
            }
          : row.receivedByUserId
            ? {
                id: row.receivedByUserId,
                name: personOf(people, row.receivedByUserId).displayName,
                kind: "staff" as OperatorKind,
              }
            : null,
        notes: row.notes,
        meterStatic: staticIds.includes(row.id),
      };
    });
  }
}
