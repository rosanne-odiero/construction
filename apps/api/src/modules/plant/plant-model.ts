import {
  addCalendarDays,
  formatHundredths,
  formatTenths,
  fuelWindows,
  hireCharge,
  idleDays,
  meterAdvance,
  nairobiDate,
  operatorCertificateState,
  parseHundredths,
  parseTenths,
  plantAlerts,
  plantDayStart,
  serviceStatus,
  type FuelAnalysis,
  type FuelPoint,
  type FuelWindow,
  type MeterReset,
} from "@pm-buddy/domain";
import {
  PLANT_LIMITS,
  type BreakdownSeverity,
  type HireRateUnit,
  type MeterType,
  type OperatorCertificateState,
  type PlantCategory,
  type PlantOwnership,
  type PlantStatus,
} from "@pm-buddy/types";
import type { FuelWindowWire, PlantItem, PlantLocation } from "@pm-buddy/validation";
import { Prisma } from "../../generated/prisma/client.js";
import { toCalendarDate } from "../projects/project-mappers.js";
import type { PlantCaller, PlantSettingsValues } from "./plant-access.js";

type Tx = Prisma.TransactionClient;

export const plantInclude = {
  supplier: { select: { id: true, legalName: true, tradingName: true } },
  lpo: { select: { id: true, number: true } },
  site: { select: { name: true } },
} as const;
export type PlantRow = Prisma.PlantItemGetPayload<{ include: typeof plantInclude }>;

/** numeric(…,1) → tenths; numeric(…,2) → hundredths (exact: the database holds that scale). */
export const tenthsOf = (value: Prisma.Decimal | null): number | null =>
  value === null ? null : parseTenths(value.toFixed(1));
export const hundredthsOf = (value: Prisma.Decimal | null): number | null =>
  value === null ? null : parseHundredths(value.toFixed(2));
export const decimal1 = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : formatTenths(tenthsOf(value)!);
export const decimal2 = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : formatHundredths(hundredthsOf(value)!);
export const optionalDate = (value: Date | null) => (value ? toCalendarDate(value) : null);
const ids = (values: readonly string[]) => Prisma.join(values.map((id) => Prisma.sql`${id}::uuid`));

export const supplierName = (supplier: { legalName: string; tradingName: string | null }) =>
  supplier.tradingName ?? supplier.legalName;

export type PlantFacts = {
  latest: { at: number; tenths: number } | null;
  resets: MeterReset[];
  /** The last full service, else the opening reading and date. */
  serviceBase: { at: number; tenths: number | null; on: string };
  fuelPoints: FuelPoint[];
  fuel: FuelAnalysis;
  openBreakdowns: BreakdownSeverity[];
  lastWorkingOn: string | null;
  hoursOnHireTenths: number;
  operatorCertificates: OperatorCertificateState[];
};

const minSample = (meterType: string, settings: PlantSettingsValues) =>
  (meterType === "km" ? settings.fuelMinKm : settings.fuelMinHours) * 10;
export const fuelRules = (meterType: string, settings: PlantSettingsValues) => ({
  tolerancePercent: settings.fuelVariancePercent,
  minSampleTenths: minSample(meterType, settings),
});

/** Current fuel issues (not superseded, not void) issued since `since`. */
export async function currentFuelIssues(
  tx: Tx,
  tenantId: string,
  plantIds: readonly string[],
  since: Date,
) {
  if (!plantIds.length) return [];
  const [rows, corrected] = await Promise.all([
    tx.plantFuelIssue.findMany({
      where: { tenantId, plantId: { in: [...plantIds] }, issuedAt: { gte: since }, isVoid: false },
      orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
    }),
    tx.plantFuelIssue.findMany({
      where: { tenantId, plantId: { in: [...plantIds] }, correctsId: { not: null } },
      select: { correctsId: true },
    }),
  ]);
  const superseded = new Set(corrected.map((row) => row.correctsId));
  return rows.filter((row) => !superseded.has(row.id));
}

export const fuelPointOf = (row: {
  id: string;
  issuedAt: Date;
  litres: Prisma.Decimal;
  meterReading: Prisma.Decimal | null;
  tankFilled: boolean;
  standardConsumption: Prisma.Decimal | null;
}): FuelPoint => ({
  id: row.id,
  at: row.issuedAt.getTime(),
  litresTenths: tenthsOf(row.litres)!,
  meterTenths: tenthsOf(row.meterReading),
  tankFilled: row.tankFilled,
  standardHundredths: hundredthsOf(row.standardConsumption),
});

export const resetOf = (row: {
  id: string;
  resetAt: Date;
  oldReading: Prisma.Decimal;
  newReading: Prisma.Decimal;
}): MeterReset => ({
  id: row.id,
  at: row.resetAt.getTime(),
  oldTenths: tenthsOf(row.oldReading)!,
  newTenths: tenthsOf(row.newReading)!,
});

/**
 * Everything the register needs to summarise a page of items, in a fixed number of queries: the
 * latest meter reading, resets, the service base, fuel windows, open breakdowns, the last working
 * day, metered hours on hire and current operators.
 */
export async function loadPlantFacts(
  tx: Tx,
  tenantId: string,
  items: readonly PlantRow[],
  settings: PlantSettingsValues,
  today = nairobiDate(),
): Promise<Map<string, PlantFacts>> {
  const result = new Map<string, PlantFacts>();
  if (!items.length) return result;
  const plantIds = items.map((item) => item.id);
  const since = new Date(plantDayStart(addCalendarDays(today, -PLANT_LIMITS.fuelLookbackDays)));
  const [latest, resets, services, fuelRows, breakdowns, working, hours, operators] =
    await Promise.all([
      tx.$queryRaw<{ plant_id: string; read_at: Date; reading: Prisma.Decimal }[]>`
        SELECT p.id AS plant_id, r.read_at, r.reading FROM plant_items p
        CROSS JOIN LATERAL (
          SELECT m.read_at, m.reading FROM app.plant_meter_readings(p.tenant_id, p.id, NULL) m
          ORDER BY m.read_at DESC, m.reading DESC LIMIT 1
        ) r
        WHERE p.tenant_id = ${tenantId}::uuid AND p.id IN (${ids(plantIds)})`,
      tx.plantMeterReset.findMany({
        where: { tenantId, plantId: { in: plantIds } },
        orderBy: { resetAt: "asc" },
      }),
      tx.plantService.findMany({
        where: { tenantId, plantId: { in: plantIds }, status: "recorded", kind: "service" },
        orderBy: { servicedAt: "desc" },
        select: { plantId: true, servicedAt: true, meterReading: true },
      }),
      currentFuelIssues(tx, tenantId, plantIds, since),
      tx.plantBreakdown.findMany({
        where: { tenantId, plantId: { in: plantIds }, status: "open" },
        select: { plantId: true, severity: true },
      }),
      tx.$queryRaw<{ plant_id: string; last: Date }[]>`
        SELECT u.plant_id, max(u.used_on) AS last FROM plant_usage_logs u
        WHERE u.tenant_id = ${tenantId}::uuid AND u.plant_id IN (${ids(plantIds)})
          AND u.day_status = 'working' AND NOT u.is_void
          AND NOT EXISTS (SELECT 1 FROM plant_usage_logs c
                           WHERE c.tenant_id = u.tenant_id AND c.corrects_id = u.id)
        GROUP BY u.plant_id`,
      tx.$queryRaw<{ plant_id: string; run: Prisma.Decimal | null }[]>`
        SELECT u.plant_id,
               sum(app.plant_usage_run(u.tenant_id, u.plant_id, u.used_on, u.start_reading,
                                       u.end_reading)) AS run
          FROM plant_usage_logs u
        JOIN plant_items p ON p.tenant_id = u.tenant_id AND p.id = u.plant_id
        WHERE u.tenant_id = ${tenantId}::uuid AND u.plant_id IN (${ids(plantIds)})
          AND p.hire_start_on IS NOT NULL AND u.used_on >= p.hire_start_on
          AND (p.closed_on IS NULL OR u.used_on <= p.closed_on)
          AND NOT u.is_void AND u.start_reading IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM plant_usage_logs c
                           WHERE c.tenant_id = u.tenant_id AND c.corrects_id = u.id)
        GROUP BY u.plant_id`,
      tx.plantOperator.findMany({
        where: {
          tenantId,
          plantId: { in: plantIds },
          fromOn: { lte: new Date(`${today}T00:00:00.000Z`) },
          OR: [{ toOn: null }, { toOn: { gte: new Date(`${today}T00:00:00.000Z`) } }],
        },
        select: { plantId: true, certificateRef: true, certificateExpiresOn: true },
      }),
    ]);
  // Grouped once (a filter per item was quadratic on a large register).
  const byPlant = <T>(rows: readonly T[], plantOf: (row: T) => string) => {
    const groups = new Map<string, T[]>();
    for (const row of rows) {
      const group = groups.get(plantOf(row));
      if (group) group.push(row);
      else groups.set(plantOf(row), [row]);
    }
    return groups;
  };
  const resetsOf = byPlant(resets, (row) => row.plantId);
  const latestOf = new Map(latest.map((row) => [row.plant_id, row]));
  const servicesOf = byPlant(services, (row) => row.plantId);
  const fuelOf = byPlant(fuelRows, (row) => row.plantId);
  const breakdownsOf = byPlant(breakdowns, (row) => row.plantId);
  const workingOf = new Map(working.map((row) => [row.plant_id, row]));
  const hoursOf = new Map(hours.map((row) => [row.plant_id, row]));
  const operatorsOf = byPlant(operators, (row) => row.plantId);
  for (const item of items) {
    const itemResets = (resetsOf.get(item.id) ?? []).map(resetOf);
    const last = latestOf.get(item.id);
    // Ordered newest first: the latest service.
    const service = servicesOf.get(item.id)?.[0];
    const points = (fuelOf.get(item.id) ?? []).map(fuelPointOf);
    result.set(item.id, {
      latest: last ? { at: last.read_at.getTime(), tenths: tenthsOf(last.reading)! } : null,
      resets: itemResets,
      serviceBase: service
        ? {
            at: service.servicedAt.getTime(),
            tenths: tenthsOf(service.meterReading),
            on: toCalendarDate(new Date(service.servicedAt.getTime() + 3 * 3_600_000)),
          }
        : {
            at: plantDayStart(toCalendarDate(item.openingOn)),
            tenths: tenthsOf(item.openingReading),
            on: toCalendarDate(item.openingOn),
          },
      fuelPoints: points,
      fuel: fuelWindows(points, itemResets, fuelRules(item.meterType, settings)),
      openBreakdowns: (breakdownsOf.get(item.id) ?? []).map(
        (row) => row.severity as BreakdownSeverity,
      ),
      lastWorkingOn: (() => {
        const row = workingOf.get(item.id);
        return row ? toCalendarDate(row.last) : null;
      })(),
      hoursOnHireTenths: tenthsOf(hoursOf.get(item.id)?.run ?? null) ?? 0,
      operatorCertificates: (operatorsOf.get(item.id) ?? []).map((row) =>
        operatorCertificateState({
          category: item.category as PlantCategory,
          requiredCategories: settings.certificateCategories,
          certificateRef: row.certificateRef,
          expiresOn: optionalDate(row.certificateExpiresOn),
          today,
          warningDays: PLANT_LIMITS.certificateWarningDays,
        }),
      ),
    });
  }
  return result;
}

/** The fuel windows of the alert period. */
const recentWindows = (fuel: FuelAnalysis, today: string) => {
  const from = plantDayStart(addCalendarDays(today, -PLANT_LIMITS.fuelAlertDays));
  return fuel.windows.filter((window) => window.toAt >= from);
};
export const recentStaticIssues = (facts: PlantFacts, today: string) => {
  const from = plantDayStart(addCalendarDays(today, -PLANT_LIMITS.fuelAlertDays));
  return facts.fuelPoints.filter(
    (point) => facts.fuel.staticIssueIds.includes(point.id) && point.at >= from,
  );
};

export function locationOf(
  caller: PlantCaller,
  projectId: string | null,
  siteId: string | null,
  siteName: string | null,
): { location: PlantLocation | null; restricted: boolean } {
  if (!projectId || !siteId) return { location: null, restricted: false };
  const project = caller.projects.get(projectId);
  if (!project || !caller.canRead(projectId)) return { location: null, restricted: true };
  return {
    location: {
      projectId,
      projectCode: project.code,
      projectName: project.name,
      siteId,
      siteName: siteName ?? "—",
    },
    restricted: false,
  };
}

/** One item as the register shows it (rates and estimates only with `canSeeCost`). */
export function summarisePlant(
  item: PlantRow,
  facts: PlantFacts,
  settings: PlantSettingsValues,
  caller: PlantCaller,
  canSeeCost: boolean,
  today = nairobiDate(),
): PlantItem {
  const meterType = item.meterType as MeterType;
  const runSince =
    meterType !== "none" && facts.latest && facts.serviceBase.tenths !== null
      ? meterAdvance(
          { at: facts.serviceBase.at, tenths: facts.serviceBase.tenths },
          facts.latest,
          facts.resets,
        )
      : null;
  const service = serviceStatus({
    everyTenths: tenthsOf(item.serviceEvery),
    everyDays: item.serviceEveryDays,
    runSinceTenths: runSince,
    lastOn: facts.serviceBase.on,
    today,
    dueSoonPercent: settings.serviceDueSoonPercent,
  });
  const hireStartOn = optionalDate(item.hireStartOn);
  const closedOn = optionalDate(item.closedOn);
  const hired = item.ownership === "hired" && hireStartOn !== null && item.supplier !== null;
  const idle = hired ? idleDays(facts.lastWorkingOn, hireStartOn, closedOn ?? today) : 0;
  const charge = hired
    ? hireCharge({
        rateMinor: Number(item.hireRateMinor ?? 0n),
        unit: item.hireRateUnit as HireRateUnit,
        startOn: hireStartOn,
        endOn: closedOn ?? today,
        hoursTenths: facts.hoursOnHireTenths,
      })
    : null;
  const status = item.status as PlantStatus;
  const alerts = plantAlerts({
    ownership: item.ownership as PlantOwnership,
    status,
    today,
    hireEndOn: optionalDate(item.hireEndOn),
    hireEndingDays: settings.hireEndingDays,
    idleDays: idle,
    idleHireDays: settings.idleHireDays,
    service: service.state,
    openBreakdowns: facts.openBreakdowns,
    // The latest judged window decides (D-93): a later window back within the standard clears it.
    fuelOverStandard:
      recentWindows(facts.fuel, today)
        .filter((window) => window.state !== "short_sample")
        .reduce<(typeof facts.fuel.windows)[number] | null>(
          (latest, window) => (!latest || window.toAt > latest.toAt ? window : latest),
          null,
        )?.state === "over_standard",
    fuelMeterStatic: recentStaticIssues(facts, today).length > 0,
    operatorCertificates: facts.operatorCertificates,
  });
  const { location, restricted } = locationOf(
    caller,
    item.projectId,
    item.siteId,
    item.site?.name ?? null,
  );
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    category: item.category as PlantCategory,
    ownership: item.ownership as PlantOwnership,
    quantity: item.quantity,
    makeModel: item.makeModel,
    registration: item.registration,
    meterType,
    fuelType: item.fuelType as PlantItem["fuelType"],
    status,
    statusReason: item.statusReason,
    closedOn,
    location,
    locationRestricted: restricted,
    meter: {
      reading: facts.latest ? formatTenths(facts.latest.tenths) : null,
      readAt: facts.latest ? new Date(facts.latest.at).toISOString() : null,
    },
    service: {
      state: service.state,
      remaining: service.remainingTenths === null ? null : formatTenths(service.remainingTenths),
      dueOn: service.dueOn,
    },
    hire:
      hired && charge
        ? {
            supplier: { id: item.supplier!.id, name: supplierName(item.supplier!) },
            startOn: hireStartOn,
            endOn: optionalDate(item.hireEndOn),
            daysOnHire: charge.days,
            idleDays: idle,
            rateMinor: canSeeCost ? Number(item.hireRateMinor) : null,
            rateUnit: item.hireRateUnit as HireRateUnit,
            estimateMinor: canSeeCost ? charge.estimateMinor : null,
          }
        : null,
    openBreakdowns: facts.openBreakdowns.length,
    alerts,
    version: item.version,
  };
}

export function windowWire(window: FuelWindow): FuelWindowWire {
  return {
    fromId: window.fromId,
    toId: window.toId,
    fromAt: new Date(window.fromAt).toISOString(),
    toAt: new Date(window.toAt).toISOString(),
    issueCount: window.issueIds.length,
    litres: formatTenths(window.litresTenths),
    advance: formatTenths(window.advanceTenths),
    standardConsumption:
      window.standardHundredths === null ? null : formatHundredths(window.standardHundredths),
    expectedLitres: window.expectedTenths === null ? null : formatTenths(window.expectedTenths),
    actualRate:
      window.actualRateHundredths === null ? null : formatHundredths(window.actualRateHundredths),
    variancePercent:
      window.variancePercentTenths === null ? null : formatTenths(window.variancePercentTenths),
    state: window.state,
  };
}
