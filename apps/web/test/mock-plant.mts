/**
 * D8.3 plant and equipment for the mock API: the register, moves, operators, daily usage with the
 * monotonic meter, fuel issues with full-tank windows judged against the standard (the fuel
 * variance), breakdowns, services, meter resets, hire estimates, alerts and the company settings.
 * It computes with the shared domain rules (packages/domain) and returns the shared response
 * schemas, so the browser tests exercise the real wire contract. Dates are relative to today in
 * Nairobi. Synthetic data only.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  addCalendarDays,
  calendarDaysBetween,
  checkMeterReading,
  checkUsageReadings,
  expectedPlantStatus,
  formatTenths,
  fuelWindows,
  hireCharge,
  idleDays,
  latestReading,
  meterAdvance,
  nairobiDate,
  operatorCertificateState,
  parseHundredths,
  parseTenths,
  plantAlerts,
  plantBusinessDate,
  plantDayEnd,
  plantDayStart,
  serviceStatus,
  type FuelPoint,
  type MeterReading,
  type MeterReset,
} from "@pm-buddy/domain";
import {
  DEFAULT_PLANT_SETTINGS,
  PLANT_ALERT_KINDS,
  PLANT_COST_PERMISSIONS,
  PLANT_FUEL_PERMISSIONS,
  PLANT_LIMITS,
  PLANT_READ_PERMISSIONS,
  PLANT_RECORD_PERMISSIONS,
  type BreakdownSeverity,
  type PlantCategory,
  type PlantStatus,
} from "@pm-buddy/types";
import {
  assignOperatorRequestSchema,
  correctFuelRequestSchema,
  correctUsageRequestSchema,
  createPlantRequestSchema,
  movePlantRequestSchema,
  plantAlertsResponseSchema,
  plantDetailResponseSchema,
  plantFuelListResponseSchema,
  plantFuelResponseSchema,
  plantListResponseSchema,
  plantOptionsResponseSchema,
  plantSettingsResponseSchema,
  plantUsageListResponseSchema,
  plantUsageResponseSchema,
  projectPlantOptionsResponseSchema,
  projectPlantResponseSchema,
  recordFuelRequestSchema,
  recordServiceRequestSchema,
  recordUsageRequestSchema,
  reportBreakdownRequestSchema,
  resolveBreakdownRequestSchema,
  updatePlantRequestSchema,
  updatePlantSettingsRequestSchema,
  type PlantItem,
} from "@pm-buddy/validation";

type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };
type Person = { id: string; displayName: string };
type Project = {
  id: string;
  code: string;
  name: string;
  status: string;
  sites: { id: string; name: string }[];
  permissions: readonly string[];
};

function omit<T extends object, K extends keyof T>(value: T, keys: K[]): Omit<T, K> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key as K)),
  ) as Omit<T, K>;
}

export type PlantDeps = {
  projects: Project[];
  companyPermissions: readonly string[];
  actor: Person;
  suppliers: { id: string; code: string; name: string }[];
  labourers: (projectId: string) => { id: string; workerNo: string; fullName: string }[];
  staff: Person[];
  fail: (status: number, code: string) => Error;
  parse: <T>(schema: z.ZodType<T>, body: unknown) => T;
};

type Item = {
  id: string;
  code: string;
  name: string;
  category: PlantCategory;
  ownership: "owned" | "hired";
  quantity: number;
  makeModel: string | null;
  registration: string | null;
  supplierId: string | null;
  lpoId: string | null;
  hireRateMinor: number | null;
  hireRateUnit: "day" | "hour" | "month" | null;
  hireStartOn: string | null;
  hireEndOn: string | null;
  meterType: "hours" | "km" | "none";
  fuelType: "diesel" | "petrol" | "none";
  standardConsumption: string | null;
  openingOn: string;
  openingReading: string | null;
  serviceEvery: string | null;
  serviceEveryDays: number | null;
  status: PlantStatus;
  statusReason: string | null;
  closedOn: string | null;
  projectId: string | null;
  siteId: string | null;
  notes: string | null;
  version: number;
  createdBy: Person;
  createdAt: string;
};
type Usage = {
  id: string;
  plantId: string;
  projectId: string;
  siteId: string;
  usedOn: string;
  dayStatus: "working" | "idle" | "breakdown";
  startReading: string | null;
  endReading: string | null;
  operator: { id: string; name: string; kind: "labourer" | "staff" } | null;
  notes: string | null;
  correctsId: string | null;
  correctionReason: string | null;
  isVoid: boolean;
  key: string;
  recordedBy: Person;
  recordedAt: string;
};
type Fuel = {
  id: string;
  plantId: string;
  projectId: string;
  siteId: string;
  issuedAt: string;
  litres: string;
  meterReading: string | null;
  tankFilled: boolean;
  fuelType: "diesel" | "petrol";
  standardConsumption: string | null;
  source: "site_store" | "fuel_station" | "bowser" | "other";
  reference: string | null;
  notes: string | null;
  correctsId: string | null;
  correctionReason: string | null;
  isVoid: boolean;
  key: string;
  recordedBy: Person;
  recordedAt: string;
};
type Operator = {
  id: string;
  plantId: string;
  projectId: string;
  kind: "labourer" | "staff";
  person: { id: string; name: string; workerNo: string | null };
  fromOn: string;
  toOn: string | null;
  certificateRef: string | null;
  certificateExpiresOn: string | null;
  ended: boolean;
  version: number;
};
type Breakdown = {
  id: string;
  plantId: string;
  projectId: string;
  siteId: string;
  number: number;
  reportedAt: string;
  severity: BreakdownSeverity;
  description: string;
  status: "open" | "repaired" | "off_hire" | "written_off";
  reportedBy: Person;
  resolvedOn: string | null;
  resolutionNote: string | null;
  repairedBy: string | null;
  costReference: string | null;
  resolvedBy: Person | null;
  version: number;
};
type Service = {
  id: string;
  plantId: string;
  projectId: string | null;
  servicedAt: string;
  kind: "service" | "repair" | "inspection";
  meterReading: string | null;
  description: string;
  doneBy: string | null;
  costReference: string | null;
  status: "recorded" | "voided";
  voidReason: string | null;
  recordedBy: Person;
  version: number;
};
type Move = {
  id: string;
  plantId: string;
  seq: number;
  movedOn: string;
  from: { projectId: string; siteId: string } | null;
  to: { projectId: string; siteId: string } | null;
  reason: string | null;
  movedBy: Person;
  createdAt: string;
};
export type PlantState = {
  settings: Omit<z.infer<typeof updatePlantSettingsRequestSchema>, "version"> & {
    version: number;
    updatedAt: string | null;
  };
  items: Item[];
  moves: Move[];
  operators: Operator[];
  usage: Usage[];
  fuel: Fuel[];
  breakdowns: Breakdown[];
  services: Service[];
};

const now = () => new Date().toISOString();
const at = (offset: number, time: string) =>
  `${addCalendarDays(nairobiDate(), offset)}T${time}:00+03:00`;
const tenths = (value: string | null) => (value === null ? null : parseTenths(value));
const has = (permissions: readonly string[], list: readonly string[]) =>
  list.some((key) => permissions.includes(key));

/**
 * The mock company's plant on the Ruiru Main plot: a hired excavator whose latest full-tank window
 * is 30 % over its standard (182.0 L for 10.0 h at 14.00 L/h), a mixer whose service is due and a
 * generator in the yard.
 */
export function initialPlant(
  ruiru: { projectId: string; siteId: string },
  supplier: { id: string; name: string },
  people: { owner: Person; agent: Person },
): PlantState {
  const today = nairobiDate();
  const day = (offset: number) => addCalendarDays(today, offset);
  const item = (values: Partial<Item> & Pick<Item, "code" | "name" | "category">): Item => ({
    id: randomUUID(),
    ownership: "owned",
    quantity: 1,
    makeModel: null,
    registration: null,
    supplierId: null,
    lpoId: null,
    hireRateMinor: null,
    hireRateUnit: null,
    hireStartOn: null,
    hireEndOn: null,
    meterType: "hours",
    fuelType: "diesel",
    standardConsumption: null,
    openingOn: day(-12),
    openingReading: null,
    serviceEvery: null,
    serviceEveryDays: null,
    status: "on_site",
    statusReason: null,
    closedOn: null,
    projectId: ruiru.projectId,
    siteId: ruiru.siteId,
    notes: null,
    version: 2,
    createdBy: people.owner,
    createdAt: now(),
    ...values,
  });
  const excavator = item({
    code: "EX-01",
    name: "Excavator 20 t",
    category: "excavator",
    ownership: "hired",
    supplierId: supplier.id,
    hireRateMinor: 1_800_000,
    hireRateUnit: "day",
    hireStartOn: day(-12),
    hireEndOn: day(30),
    standardConsumption: "14.00",
    openingReading: "2400.0",
    serviceEvery: "250.0",
  });
  const mixer = item({
    code: "MX-01",
    name: "Concrete mixer 350 L",
    category: "concrete_mixer",
    standardConsumption: "1.50",
    openingOn: day(-30),
    openingReading: "1000.0",
    serviceEvery: "100.0",
  });
  const generator = item({
    code: "GN-01",
    name: "Generator 20 kVA",
    category: "generator",
    standardConsumption: "4.50",
    openingOn: day(-60),
    openingReading: "3120.0",
    status: "available",
    projectId: null,
    siteId: null,
    version: 1,
  });
  const move = (target: Item): Move => ({
    id: randomUUID(),
    plantId: target.id,
    seq: 1,
    movedOn: target.openingOn,
    from: null,
    to: { projectId: ruiru.projectId, siteId: ruiru.siteId },
    reason: null,
    movedBy: people.owner,
    createdAt: now(),
  });
  const fuel = (offset: number, time: string, litres: string, reading: string): Fuel => ({
    id: randomUUID(),
    plantId: excavator.id,
    projectId: ruiru.projectId,
    siteId: ruiru.siteId,
    issuedAt: at(offset, time),
    litres,
    meterReading: reading,
    tankFilled: true,
    fuelType: "diesel",
    standardConsumption: "14.00",
    source: "site_store",
    reference: null,
    notes: null,
    correctsId: null,
    correctionReason: null,
    isVoid: false,
    key: randomUUID(),
    recordedBy: people.agent,
    recordedAt: now(),
  });
  const usage = (target: Item, offset: number, start: string, end: string): Usage => ({
    id: randomUUID(),
    plantId: target.id,
    projectId: ruiru.projectId,
    siteId: ruiru.siteId,
    usedOn: day(offset),
    dayStatus: "working",
    startReading: start,
    endReading: end,
    operator: null,
    notes: null,
    correctsId: null,
    correctionReason: null,
    isVoid: false,
    key: randomUUID(),
    recordedBy: people.agent,
    recordedAt: now(),
  });
  return {
    settings: {
      ...DEFAULT_PLANT_SETTINGS,
      certificateCategories: [...DEFAULT_PLANT_SETTINGS.certificateCategories],
      version: 0,
      updatedAt: null,
    },
    items: [excavator, generator, mixer],
    moves: [move(excavator), move(mixer)],
    operators: [],
    usage: [
      usage(excavator, -4, "2450.0", "2460.0"),
      usage(excavator, -3, "2460.0", "2470.0"),
      usage(excavator, -2, "2470.0", "2478.0"),
      usage(mixer, -3, "1080.0", "1086.0"),
      usage(mixer, -2, "1086.0", "1092.0"),
    ],
    fuel: [
      fuel(-4, "07:00", "70.0", "2450.0"),
      fuel(-4, "18:00", "141.0", "2460.0"),
      fuel(-3, "18:00", "182.0", "2470.0"),
    ],
    breakdowns: [],
    services: [],
  };
}

export function handlePlant(
  deps: PlantDeps,
  state: PlantState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): Reply | null {
  const { fail, parse, actor } = deps;
  const today = nairobiDate();
  const project = (id: string | null) => deps.projects.find((entry) => entry.id === id) ?? null;
  const perms = (id: string | null) => project(id)?.permissions ?? [];
  const writable = (id: string | null) =>
    !["closed", "cancelled"].includes(project(id)?.status ?? "");
  const canRead = (id: string | null) =>
    perms(id).includes("projects.view") && has(perms(id), PLANT_READ_PERMISSIONS);
  const canRecord = (id: string | null) =>
    canRead(id) && writable(id) && has(perms(id), PLANT_RECORD_PERMISSIONS);
  const canFuel = (id: string | null) =>
    canRead(id) && writable(id) && has(perms(id), PLANT_FUEL_PERMISSIONS);
  const holdsManage = (id: string | null) => perms(id).includes("plant.manage");
  const canManage = (id: string | null) => holdsManage(id) && writable(id);
  const somewhere = (test: (id: string) => boolean) =>
    deps.projects.some((entry) => test(entry.id));
  const readSomewhere = somewhere(canRead);
  const manageSomewhere = somewhere(holdsManage);
  const costSomewhere = somewhere((id) => has(perms(id), PLANT_COST_PERMISSIONS));
  const canManageItem = (item: Item) =>
    item.projectId ? holdsManage(item.projectId) : manageSomewhere;
  const closedItem = (item: Item) => item.status === "off_hire" || item.status === "disposed";
  const supplierName = (id: string | null) =>
    deps.suppliers.find((entry) => entry.id === id)?.name ?? "—";
  const site = (projectId: string | null, siteId: string | null) =>
    project(projectId)?.sites.find((entry) => entry.id === siteId) ?? null;
  const location = (projectId: string | null, siteId: string | null) => {
    if (!projectId || !siteId) return { location: null, restricted: false };
    const entry = project(projectId);
    if (!entry || !canRead(projectId)) return { location: null, restricted: true };
    return {
      location: {
        projectId,
        projectCode: entry.code,
        projectName: entry.name,
        siteId,
        siteName: site(projectId, siteId)?.name ?? "—",
      },
      restricted: false,
    };
  };
  const superseded = (list: readonly { correctsId: string | null }[]) =>
    new Set(list.map((entry) => entry.correctsId).filter(Boolean));
  const currentUsage = (plantId: string) => {
    const corrected = superseded(state.usage);
    return state.usage.filter(
      (entry) => entry.plantId === plantId && !entry.isVoid && !corrected.has(entry.id),
    );
  };
  const currentFuel = (plantId: string) => {
    const corrected = superseded(state.fuel);
    return state.fuel.filter(
      (entry) => entry.plantId === plantId && !entry.isVoid && !corrected.has(entry.id),
    );
  };
  // The mock records no meter resets (the API e2e suite covers them).
  const noResets: MeterReset[] = [];
  const readings = (item: Item, excluded: string | null): MeterReading[] => [
    ...(item.openingReading
      ? [
          {
            at: plantDayStart(item.openingOn),
            tenths: tenths(item.openingReading)!,
            sourceId: null,
          },
        ]
      : []),
    ...currentUsage(item.id)
      .filter((entry) => entry.startReading && entry.id !== excluded)
      .flatMap((entry) => [
        {
          at: plantDayStart(entry.usedOn),
          tenths: tenths(entry.startReading)!,
          sourceId: entry.id,
        },
        { at: plantDayEnd(entry.usedOn), tenths: tenths(entry.endReading)!, sourceId: entry.id },
      ]),
    ...currentFuel(item.id)
      .filter((entry) => entry.meterReading && entry.id !== excluded)
      .map((entry) => ({
        at: Date.parse(entry.issuedAt),
        tenths: tenths(entry.meterReading)!,
        sourceId: entry.id,
      })),
    ...state.services
      .filter(
        (entry) => entry.plantId === item.id && entry.status === "recorded" && entry.meterReading,
      )
      .map((entry) => ({
        at: Date.parse(entry.servicedAt),
        tenths: tenths(entry.meterReading)!,
        sourceId: entry.id,
      })),
  ];
  const rules = (item: Item) => ({
    tolerancePercent: state.settings.fuelVariancePercent,
    minSampleTenths:
      (item.meterType === "km" ? state.settings.fuelMinKm : state.settings.fuelMinHours) * 10,
  });
  const points = (item: Item): FuelPoint[] =>
    currentFuel(item.id).map((entry) => ({
      id: entry.id,
      at: Date.parse(entry.issuedAt),
      litresTenths: tenths(entry.litres)!,
      meterTenths: tenths(entry.meterReading),
      tankFilled: entry.tankFilled,
      standardHundredths: entry.standardConsumption
        ? parseHundredths(entry.standardConsumption)
        : null,
    }));
  const analysis = (item: Item) => fuelWindows(points(item), noResets, rules(item));
  const windowWire = (window: ReturnType<typeof analysis>["windows"][number]) => ({
    fromId: window.fromId,
    toId: window.toId,
    fromAt: new Date(window.fromAt).toISOString(),
    toAt: new Date(window.toAt).toISOString(),
    issueCount: window.issueIds.length,
    litres: formatTenths(window.litresTenths),
    advance: formatTenths(window.advanceTenths),
    standardConsumption:
      window.standardHundredths === null ? null : (window.standardHundredths / 100).toFixed(2),
    expectedLitres: window.expectedTenths === null ? null : formatTenths(window.expectedTenths),
    actualRate:
      window.actualRateHundredths === null ? null : (window.actualRateHundredths / 100).toFixed(2),
    variancePercent:
      window.variancePercentTenths === null ? null : formatTenths(window.variancePercentTenths),
    state: window.state,
  });

  function summary(item: Item, canSeeCost = costSomewhere): PlantItem {
    const meterReadings = readings(item, null);
    const latest = latestReading(meterReadings, noResets);
    const lastService = state.services
      .filter(
        (entry) =>
          entry.plantId === item.id && entry.status === "recorded" && entry.kind === "service",
      )
      .sort((a, b) => b.servicedAt.localeCompare(a.servicedAt))[0];
    const base = lastService
      ? {
          at: Date.parse(lastService.servicedAt),
          tenths: tenths(lastService.meterReading),
          on: plantBusinessDate(Date.parse(lastService.servicedAt)),
        }
      : {
          at: plantDayStart(item.openingOn),
          tenths: tenths(item.openingReading),
          on: item.openingOn,
        };
    const service = serviceStatus({
      everyTenths: tenths(item.serviceEvery),
      everyDays: item.serviceEveryDays,
      runSinceTenths:
        latest && base.tenths !== null
          ? meterAdvance({ at: base.at, tenths: base.tenths }, latest, noResets)
          : null,
      lastOn: base.on,
      today,
      dueSoonPercent: state.settings.serviceDueSoonPercent,
    });
    const working =
      currentUsage(item.id)
        .filter((entry) => entry.dayStatus === "working")
        .map((entry) => entry.usedOn)
        .sort()
        .at(-1) ?? null;
    const hired = item.ownership === "hired" && item.hireStartOn !== null;
    const idle = hired ? idleDays(working, item.hireStartOn!, item.closedOn ?? today) : 0;
    const charge = hired
      ? hireCharge({
          rateMinor: item.hireRateMinor ?? 0,
          unit: item.hireRateUnit ?? "day",
          startOn: item.hireStartOn!,
          endOn: item.closedOn ?? today,
          hoursTenths: currentUsage(item.id).reduce(
            (total, entry) =>
              total +
              (entry.startReading ? tenths(entry.endReading)! - tenths(entry.startReading)! : 0),
            0,
          ),
        })
      : null;
    const fuel = analysis(item);
    const alertFrom = plantDayStart(addCalendarDays(today, -PLANT_LIMITS.fuelAlertDays));
    const open = state.breakdowns.filter(
      (entry) => entry.plantId === item.id && entry.status === "open",
    );
    const operators = state.operators.filter(
      (entry) =>
        entry.plantId === item.id &&
        entry.fromOn <= today &&
        (entry.toOn === null || entry.toOn >= today),
    );
    const { location: where, restricted } = location(item.projectId, item.siteId);
    return {
      id: item.id,
      code: item.code,
      name: item.name,
      category: item.category,
      ownership: item.ownership,
      quantity: item.quantity,
      makeModel: item.makeModel,
      registration: item.registration,
      meterType: item.meterType,
      fuelType: item.fuelType,
      status: item.status,
      statusReason: item.statusReason,
      closedOn: item.closedOn,
      location: where,
      locationRestricted: restricted,
      meter: {
        reading: latest ? formatTenths(latest.tenths) : null,
        readAt: latest ? new Date(latest.at).toISOString() : null,
      },
      service: {
        state: service.state,
        remaining: service.remainingTenths === null ? null : formatTenths(service.remainingTenths),
        dueOn: service.dueOn,
      },
      hire:
        hired && charge
          ? {
              supplier: { id: item.supplierId!, name: supplierName(item.supplierId) },
              startOn: item.hireStartOn!,
              endOn: item.hireEndOn,
              daysOnHire: charge.days,
              idleDays: idle,
              rateMinor: canSeeCost ? item.hireRateMinor : null,
              rateUnit: item.hireRateUnit ?? "day",
              estimateMinor: canSeeCost ? charge.estimateMinor : null,
            }
          : null,
      openBreakdowns: open.length,
      alerts: plantAlerts({
        ownership: item.ownership,
        status: item.status,
        today,
        hireEndOn: item.hireEndOn,
        hireEndingDays: state.settings.hireEndingDays,
        idleDays: idle,
        idleHireDays: state.settings.idleHireDays,
        service: service.state,
        openBreakdowns: open.map((entry) => entry.severity),
        fuelOverStandard: fuel.windows.some(
          (window) => window.toAt >= alertFrom && window.state === "over_standard",
        ),
        fuelMeterStatic: points(item).some(
          (point) => fuel.staticIssueIds.includes(point.id) && point.at >= alertFrom,
        ),
        operatorCertificates: operators.map((entry) =>
          operatorCertificateState({
            category: item.category,
            requiredCategories: state.settings.certificateCategories,
            certificateRef: entry.certificateRef,
            expiresOn: entry.certificateExpiresOn,
            today,
            warningDays: PLANT_LIMITS.certificateWarningDays,
          }),
        ),
      }),
      version: item.version,
    };
  }

  const findItem = (id: string) => {
    const item = state.items.find((entry) => entry.id === id);
    if (!item) throw fail(404, "not-found");
    return item;
  };
  const refreshStatus = (item: Item) => {
    if (closedItem(item)) return;
    const next = expectedPlantStatus({
      closed: null,
      siteId: item.siteId,
      openSeverities: state.breakdowns
        .filter((entry) => entry.plantId === item.id && entry.status === "open")
        .map((entry) => entry.severity),
    });
    if (next !== item.status) {
      item.status = next;
      item.version += 1;
    }
  };
  const present = (item: Item, siteId: string, day: string) => {
    const moves = state.moves.filter((entry) => entry.plantId === item.id);
    const before = moves.filter((entry) => entry.movedOn < day).sort((a, b) => b.seq - a.seq)[0];
    return (
      before?.to?.siteId === siteId ||
      moves.some(
        (entry) =>
          entry.movedOn === day && (entry.to?.siteId === siteId || entry.from?.siteId === siteId),
      )
    );
  };
  const recordSite = (item: Item, siteId: string, day: string, fuel = false) => {
    const owner = deps.projects.find((entry) =>
      entry.sites.some((candidate) => candidate.id === siteId),
    );
    if (!owner || !canRead(owner.id)) throw fail(404, "not-found");
    if (!writable(owner.id)) throw fail(409, "project-read-only");
    if (!(fuel ? canFuel(owner.id) : canRecord(owner.id))) throw fail(403, "forbidden");
    if (day > today) throw fail(409, "plant-date-future");
    if (calendarDaysBetween(day, today) > PLANT_LIMITS.maxBackdateDays)
      throw fail(409, "plant-date-too-old");
    if (!present(item, siteId, day)) throw fail(409, "plant-not-on-site");
    return owner.id;
  };
  const detail = (item: Item) => {
    const closed = closedItem(item);
    const manage = canManageItem(item);
    const facts = summary(item);
    const visible = (projectId: string | null) => projectId === null || canRead(projectId);
    return {
      body: {
        item: {
          ...facts,
          lpo: null,
          hireEndOn: item.hireEndOn,
          standardConsumption: item.standardConsumption,
          openingOn: item.openingOn,
          openingReading: item.openingReading,
          serviceEvery: item.serviceEvery,
          serviceEveryDays: item.serviceEveryDays,
          notes: item.notes,
          createdBy: item.createdBy,
          createdAt: item.createdAt,
        },
        moves: state.moves
          .filter((entry) => entry.plantId === item.id)
          .sort((a, b) => b.seq - a.seq)
          .map((entry) => {
            const from = location(entry.from?.projectId ?? null, entry.from?.siteId ?? null);
            const to = location(entry.to?.projectId ?? null, entry.to?.siteId ?? null);
            return {
              id: entry.id,
              seq: entry.seq,
              movedOn: entry.movedOn,
              from: from.location,
              to: to.location,
              restricted: from.restricted || to.restricted,
              reason: entry.reason,
              movedBy: entry.movedBy,
              createdAt: entry.createdAt,
            };
          }),
        operators: state.operators
          .filter((entry) => entry.plantId === item.id && visible(entry.projectId))
          .map((entry) => ({
            id: entry.id,
            projectId: entry.projectId,
            kind: entry.kind,
            labourer:
              entry.kind === "labourer"
                ? {
                    id: entry.person.id,
                    workerNo: entry.person.workerNo ?? "—",
                    fullName: entry.person.name,
                  }
                : null,
            user:
              entry.kind === "staff"
                ? { id: entry.person.id, displayName: entry.person.name }
                : null,
            fromOn: entry.fromOn,
            toOn: entry.toOn,
            certificateRef: entry.certificateRef,
            certificateExpiresOn: entry.certificateExpiresOn,
            certificateState: operatorCertificateState({
              category: item.category,
              requiredCategories: state.settings.certificateCategories,
              certificateRef: entry.certificateRef,
              expiresOn: entry.certificateExpiresOn,
              today,
              warningDays: PLANT_LIMITS.certificateWarningDays,
            }),
            active: entry.fromOn <= today && (entry.toOn === null || entry.toOn >= today),
            version: entry.version,
            permissions: { canEnd: !closed && !entry.ended && canManage(entry.projectId) },
          })),
        breakdowns: state.breakdowns
          .filter((entry) => entry.plantId === item.id && visible(entry.projectId))
          .sort((a, b) => b.number - a.number)
          .map((entry) => {
            const open = entry.status === "open" && !closed;
            return {
              ...entry,
              code: `BRK-${String(entry.number).padStart(4, "0")}`,
              siteName: site(entry.projectId, entry.siteId)?.name ?? "—",
              daysDown: Math.max(
                0,
                calendarDaysBetween(
                  plantBusinessDate(Date.parse(entry.reportedAt)),
                  entry.resolvedOn ?? today,
                ),
              ),
              permissions: {
                canRepair:
                  open &&
                  (entry.severity === "unsafe"
                    ? canManage(entry.projectId)
                    : canRecord(entry.projectId)),
                canOffHire: open && item.ownership === "hired" && canManage(entry.projectId),
                canWriteOff: open && item.ownership === "owned" && canManage(entry.projectId),
              },
            };
          })
          .map((entry) => omit(entry, ["plantId", "number"])),
        services: state.services
          .filter((entry) => entry.plantId === item.id && visible(entry.projectId))
          .map((entry) => ({
            ...omit(entry, ["plantId", "projectId"]),
            permissions: { canVoid: entry.status === "recorded" && !closed && manage },
          })),
        resets: [],
        permissions: {
          canEdit: !closed && manage,
          canMove: !closed && manage,
          canClose: !closed && manage && facts.openBreakdowns === 0,
          canAssignOperator: !closed && item.projectId !== null && canManage(item.projectId),
          canResetMeter: !closed && manage && item.meterType !== "none",
          canRecordUsage: !closed && item.projectId !== null && canRecord(item.projectId),
          canRecordFuel:
            !closed &&
            item.fuelType !== "none" &&
            item.projectId !== null &&
            canFuel(item.projectId),
          canReportBreakdown: !closed && item.projectId !== null && canRecord(item.projectId),
          canRecordService:
            !closed && (item.projectId !== null ? canRecord(item.projectId) : manage),
          canSeeCost: costSomewhere,
        },
      },
      schema: plantDetailResponseSchema,
    };
  };
  const usageWire = (entry: Usage) => {
    const replaced = state.usage.find((other) => other.correctsId === entry.id);
    const item = findItem(entry.plantId);
    return {
      id: entry.id,
      projectId: entry.projectId,
      siteId: entry.siteId,
      siteName: site(entry.projectId, entry.siteId)?.name ?? "—",
      state: replaced ? "superseded" : entry.isVoid ? "voided" : "current",
      correctsId: entry.correctsId,
      correctionReason: entry.correctionReason,
      supersededById: replaced?.id ?? null,
      recordedBy: entry.recordedBy,
      recordedAt: entry.recordedAt,
      permissions: {
        canCorrect:
          !closedItem(item) &&
          !replaced &&
          canRecord(entry.projectId) &&
          (holdsManage(entry.projectId) || entry.recordedBy.id === actor.id),
      },
      usedOn: entry.usedOn,
      dayStatus: entry.dayStatus,
      startReading: entry.startReading,
      endReading: entry.endReading,
      run: entry.startReading
        ? formatTenths(tenths(entry.endReading)! - tenths(entry.startReading)!)
        : null,
      operator: entry.operator,
      bqItem: null,
      costCode: null,
      notes: entry.notes,
    };
  };
  const fuelWire = (entry: Fuel, staticIds: readonly string[]) => {
    const replaced = state.fuel.find((other) => other.correctsId === entry.id);
    const item = findItem(entry.plantId);
    return {
      id: entry.id,
      projectId: entry.projectId,
      siteId: entry.siteId,
      siteName: site(entry.projectId, entry.siteId)?.name ?? "—",
      state: replaced ? "superseded" : entry.isVoid ? "voided" : "current",
      correctsId: entry.correctsId,
      correctionReason: entry.correctionReason,
      supersededById: replaced?.id ?? null,
      recordedBy: entry.recordedBy,
      recordedAt: entry.recordedAt,
      permissions: {
        canCorrect:
          !closedItem(item) &&
          !replaced &&
          canFuel(entry.projectId) &&
          (holdsManage(entry.projectId) || entry.recordedBy.id === actor.id),
      },
      issuedAt: entry.issuedAt,
      litres: entry.litres,
      meterReading: entry.meterReading,
      tankFilled: entry.tankFilled,
      fuelType: entry.fuelType,
      standardConsumption: entry.standardConsumption,
      source: entry.source,
      reference: entry.reference,
      receivedBy: null,
      notes: entry.notes,
      meterStatic: staticIds.includes(entry.id),
    };
  };
  const operatorOf = (
    item: Item,
    day: string,
    labourerId?: string | null,
    userId?: string | null,
  ) => {
    if (!labourerId && !userId) return null;
    const match = state.operators.find(
      (entry) =>
        entry.plantId === item.id &&
        entry.person.id === (labourerId ?? userId) &&
        entry.fromOn <= day &&
        (entry.toOn === null || entry.toOn >= day),
    );
    if (!match) throw fail(422, "operator-not-assigned");
    return { id: match.person.id, name: match.person.name, kind: match.kind };
  };
  const checkUsage = (
    item: Item,
    usedOn: string,
    input: { dayStatus: string; startReading?: string | null; endReading?: string | null },
    excluded: string | null,
  ) => {
    const metered = item.meterType !== "none";
    if (metered !== Boolean(input.startReading)) throw fail(422, "plant-not-metered");
    if (metered) {
      const start = tenths(input.startReading!)!;
      const end = tenths(input.endReading!)!;
      if (
        end - start >
        (item.meterType === "hours" ? PLANT_LIMITS.maxDayHoursTenths : PLANT_LIMITS.maxDayKmTenths)
      )
        throw fail(409, "meter-day-limit");
      if (!checkUsageReadings(readings(item, excluded), noResets, usedOn, start, end).ok)
        throw fail(409, "meter-out-of-order");
    }
    if (
      input.dayStatus === "working" &&
      state.breakdowns.some(
        (entry) =>
          entry.plantId === item.id && entry.status === "open" && entry.severity === "unsafe",
      )
    )
      throw fail(409, "plant-unsafe");
  };

  // Company routes ------------------------------------------------------------------------------
  if (path === "/plant/settings") {
    const canEdit = deps.companyPermissions.includes("config.manage");
    if (method === "PUT") {
      if (!canEdit) throw fail(403, "forbidden");
      const input = parse(updatePlantSettingsRequestSchema, body);
      if (input.version !== state.settings.version) throw fail(409, "version-conflict");
      state.settings = { ...input, version: input.version + 1, updatedAt: now() };
    } else if (!canEdit && !readSomewhere) throw fail(403, "forbidden");
    return {
      body: { settings: { ...state.settings, permissions: { canEdit } } },
      schema: plantSettingsResponseSchema,
    };
  }
  if (path.startsWith("/plant") && !readSomewhere) throw fail(403, "forbidden");
  if (path === "/plant" && method === "GET") {
    let items = state.items.map((item) => summary(item));
    const status = query.get("status");
    if (status === "active")
      items = items.filter((item) => item.status !== "off_hire" && item.status !== "disposed");
    else if (status) items = items.filter((item) => item.status === status);
    for (const key of ["category", "ownership"] as const) {
      const value = query.get(key);
      if (value) items = items.filter((item) => item[key] === value);
    }
    const projectId = query.get("projectId");
    if (projectId) items = items.filter((item) => item.location?.projectId === projectId);
    const search = query.get("search")?.trim().toLowerCase();
    if (search)
      items = items.filter((item) => `${item.code} ${item.name}`.toLowerCase().includes(search));
    items.sort((a, b) => a.code.localeCompare(b.code));
    const shown = query.get("attention") ? items.filter((item) => item.alerts.length) : items;
    const offset = Number(query.get("cursor") ?? 0);
    return {
      body: {
        items: shown.slice(offset, offset + 30),
        nextCursor: shown.length > offset + 30 ? offset + 30 : null,
        counts: {
          total: items.length,
          onSite: items.filter((item) => item.status === "on_site").length,
          available: items.filter((item) => item.status === "available").length,
          underRepair: items.filter((item) => item.status === "under_repair").length,
          hired: items.filter((item) => item.ownership === "hired").length,
          attention: items.filter((item) => item.alerts.length).length,
        },
        permissions: {
          canRegister: manageSomewhere,
          canEditSettings: deps.companyPermissions.includes("config.manage"),
        },
      },
      schema: plantListResponseSchema,
    };
  }
  if (path === "/plant/alerts" && method === "GET") {
    const alerts = state.items
      .filter((item) => !closedItem(item))
      .map((item) => summary(item))
      .filter((item) => !item.locationRestricted)
      .flatMap((item) =>
        item.alerts.map((alert) => ({
          ...alert,
          plantId: item.id,
          code: item.code,
          name: item.name,
          category: item.category,
          location: item.location,
        })),
      );
    const counts = Object.fromEntries(
      PLANT_ALERT_KINDS.map((kind) => [kind, alerts.filter((alert) => alert.kind === kind).length]),
    );
    return {
      body: { alerts: alerts.slice(0, Number(query.get("limit") ?? 30)), nextCursor: null, counts },
      schema: plantAlertsResponseSchema,
    };
  }
  if (path === "/plant/options" && method === "GET") {
    if (!manageSomewhere) throw fail(403, "forbidden");
    return {
      body: {
        suppliers: deps.suppliers,
        lpos: [],
        sites: deps.projects
          .filter((entry) => canManage(entry.id))
          .flatMap((entry) =>
            entry.sites.map((candidate) => ({
              projectId: entry.id,
              projectCode: entry.code,
              projectName: entry.name,
              siteId: candidate.id,
              siteName: candidate.name,
            })),
          ),
      },
      schema: plantOptionsResponseSchema,
    };
  }
  if (path === "/plant" && method === "POST") {
    if (!manageSomewhere) throw fail(403, "forbidden");
    const input = parse(createPlantRequestSchema, body);
    if (state.items.some((item) => item.code === input.code)) throw fail(409, "plant-code-taken");
    const owner = input.siteId
      ? deps.projects.find((entry) =>
          entry.sites.some((candidate) => candidate.id === input.siteId),
        )
      : null;
    if (input.siteId && (!owner || !canManage(owner.id))) throw fail(403, "forbidden");
    const item: Item = {
      id: randomUUID(),
      code: input.code,
      name: input.name,
      category: input.category,
      ownership: input.ownership,
      quantity: input.quantity,
      makeModel: input.makeModel ?? null,
      registration: input.registration ?? null,
      supplierId: input.supplierId ?? null,
      lpoId: input.lpoId ?? null,
      hireRateMinor: input.hireRateMinor ?? null,
      hireRateUnit: input.hireRateUnit ?? null,
      hireStartOn: input.hireStartOn ?? null,
      hireEndOn: input.hireEndOn ?? null,
      meterType: input.meterType,
      fuelType: input.fuelType,
      standardConsumption: input.standardConsumption ?? null,
      openingOn: input.openingOn,
      openingReading: input.openingReading ?? null,
      serviceEvery: input.serviceEvery ?? null,
      serviceEveryDays: input.serviceEveryDays ?? null,
      status: owner ? "on_site" : "available",
      statusReason: null,
      closedOn: null,
      projectId: owner?.id ?? null,
      siteId: owner ? input.siteId! : null,
      notes: input.notes ?? null,
      version: owner ? 2 : 1,
      createdBy: actor,
      createdAt: now(),
    };
    state.items.push(item);
    if (owner)
      state.moves.push({
        id: randomUUID(),
        plantId: item.id,
        seq: 1,
        movedOn: item.openingOn,
        from: null,
        to: { projectId: owner.id, siteId: item.siteId! },
        reason: null,
        movedBy: actor,
        createdAt: now(),
      });
    return { ...detail(item), status: 201 };
  }

  // Project routes ------------------------------------------------------------------------------
  const projectMatch = /^\/projects\/([^/]+)\/plant(\/options)?$/.exec(path);
  if (projectMatch && method === "GET") {
    const projectId = projectMatch[1]!;
    if (!project(projectId)) throw fail(404, "not-found");
    if (!canRead(projectId)) throw fail(403, "forbidden");
    if (projectMatch[2])
      return {
        body: {
          labourers: deps.labourers(projectId),
          staff: deps.staff,
          costCodes: [],
          bqItems: [],
        },
        schema: projectPlantOptionsResponseSchema,
      };
    const canSeeCost = has(perms(projectId), PLANT_COST_PERMISSIONS);
    return {
      body: {
        items: state.items
          .filter((item) => item.projectId === projectId)
          .map((item) => ({
            ...summary(item, canSeeCost),
            today: {
              usageRecorded: currentUsage(item.id).some((entry) => entry.usedOn === today),
              litres: formatTenths(
                currentFuel(item.id)
                  .filter((entry) => plantBusinessDate(Date.parse(entry.issuedAt)) === today)
                  .reduce((total, entry) => total + tenths(entry.litres)!, 0),
              ),
            },
            operators: state.operators
              .filter(
                (entry) =>
                  entry.plantId === item.id &&
                  entry.projectId === projectId &&
                  entry.fromOn <= today &&
                  (entry.toOn === null || entry.toOn >= today),
              )
              .map((entry) => ({ id: entry.person.id, name: entry.person.name, kind: entry.kind })),
          })),
        sites: project(projectId)!.sites,
        permissions: {
          canRecordUsage: canRecord(projectId),
          canRecordFuel: canFuel(projectId),
          canReportBreakdown: canRecord(projectId),
          canManage: canManage(projectId),
          canSeeCost,
        },
      },
      schema: projectPlantResponseSchema,
    };
  }

  // Item routes ---------------------------------------------------------------------------------
  const match = /^\/plant\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!match) return null;
  const item = findItem(match[1]!);
  const rest = match[2] ?? "";
  const open = () => {
    if (closedItem(item)) throw fail(409, "plant-closed");
  };
  const manageItem = (version?: number) => {
    open();
    if (!canManageItem(item)) throw fail(403, "forbidden");
    if (version !== undefined && version !== item.version) throw fail(409, "version-conflict");
  };
  if (rest === "" && method === "GET") return detail(item);
  if (rest === "" && method === "PATCH") {
    const input = parse(updatePlantRequestSchema, body);
    manageItem(input.version);
    Object.assign(item, {
      name: input.name,
      category: input.category,
      quantity: input.quantity,
      standardConsumption: input.standardConsumption ?? null,
      serviceEvery: input.serviceEvery ?? null,
      serviceEveryDays: input.serviceEveryDays ?? null,
      notes: input.notes ?? null,
      hireEndOn: item.ownership === "hired" ? (input.hireEndOn ?? null) : null,
      version: item.version + 1,
    });
    return detail(item);
  }
  if (rest === "moves" && method === "POST") {
    const input = parse(movePlantRequestSchema, body);
    manageItem(input.version);
    if ((input.siteId ?? null) === item.siteId) throw fail(409, "move-same-place");
    const owner = input.siteId
      ? deps.projects.find((entry) =>
          entry.sites.some((candidate) => candidate.id === input.siteId),
        )
      : null;
    if (input.siteId && (!owner || !canManage(owner.id))) throw fail(403, "forbidden");
    const moves = state.moves.filter((entry) => entry.plantId === item.id);
    if (moves.some((entry) => entry.movedOn > input.movedOn)) throw fail(409, "invalid-transition");
    state.moves.push({
      id: randomUUID(),
      plantId: item.id,
      seq: moves.length + 1,
      movedOn: input.movedOn,
      from:
        item.projectId && item.siteId ? { projectId: item.projectId, siteId: item.siteId } : null,
      to: owner ? { projectId: owner.id, siteId: input.siteId! } : null,
      reason: input.reason ?? null,
      movedBy: actor,
      createdAt: now(),
    });
    item.projectId = owner?.id ?? null;
    item.siteId = owner ? input.siteId! : null;
    if (item.status !== "under_repair") item.status = owner ? "on_site" : "available";
    item.version += 1;
    return detail(item);
  }
  if (rest === "operators" && method === "POST") {
    const input = parse(assignOperatorRequestSchema, body);
    open();
    if (!canManage(input.projectId)) throw fail(403, "forbidden");
    const person =
      input.kind === "labourer"
        ? deps.labourers(input.projectId).find((entry) => entry.id === input.labourerId)
        : deps.staff.find((entry) => entry.id === input.userId);
    if (!person)
      throw fail(
        422,
        input.kind === "labourer" ? "labourer-not-on-project" : "person-not-in-company",
      );
    const end = input.toOn ?? "9999-12-31";
    if (
      state.operators.some(
        (entry) =>
          entry.plantId === item.id &&
          entry.person.id === person.id &&
          entry.fromOn <= end &&
          (entry.toOn === null || entry.toOn >= input.fromOn),
      )
    )
      throw fail(409, "operator-overlap");
    state.operators.push({
      id: randomUUID(),
      plantId: item.id,
      projectId: input.projectId,
      kind: input.kind,
      person: {
        id: person.id,
        name: "fullName" in person ? person.fullName : person.displayName,
        workerNo: "workerNo" in person ? person.workerNo : null,
      },
      fromOn: input.fromOn,
      toOn: input.toOn ?? null,
      certificateRef: input.certificateRef ?? null,
      certificateExpiresOn: input.certificateExpiresOn ?? null,
      ended: false,
      version: 1,
    });
    return { ...detail(item), status: 201 };
  }
  if (rest === "usage" || rest === "fuel") {
    const usage = rest === "usage";
    if (method === "GET") {
      const fuel = analysis(item);
      const offset = Number(query.get("cursor") ?? 0);
      if (usage) {
        const rows = state.usage
          .filter((entry) => entry.plantId === item.id && canRead(entry.projectId))
          .sort(
            (a, b) => b.usedOn.localeCompare(a.usedOn) || b.recordedAt.localeCompare(a.recordedAt),
          );
        const recent = currentUsage(item.id).filter(
          (entry) => entry.usedOn >= addCalendarDays(today, -29),
        );
        return {
          body: {
            entries: rows.slice(offset, offset + 30).map(usageWire),
            nextCursor: rows.length > offset + 30 ? offset + 30 : null,
            totals: {
              workingDays30: recent.filter((entry) => entry.dayStatus === "working").length,
              idleDays30: recent.filter((entry) => entry.dayStatus === "idle").length,
              breakdownDays30: recent.filter((entry) => entry.dayStatus === "breakdown").length,
              run30:
                item.meterType === "none"
                  ? null
                  : formatTenths(
                      recent.reduce(
                        (total, entry) =>
                          total +
                          (entry.startReading
                            ? tenths(entry.endReading)! - tenths(entry.startReading)!
                            : 0),
                        0,
                      ),
                    ),
            },
          },
          schema: plantUsageListResponseSchema,
        };
      }
      const rows = state.fuel
        .filter((entry) => entry.plantId === item.id && canRead(entry.projectId))
        .sort(
          (a, b) =>
            b.issuedAt.localeCompare(a.issuedAt) || b.recordedAt.localeCompare(a.recordedAt),
        );
      return {
        body: {
          entries: rows
            .slice(offset, offset + 30)
            .map((entry) => fuelWire(entry, fuel.staticIssueIds)),
          nextCursor: rows.length > offset + 30 ? offset + 30 : null,
          windows: [...fuel.windows].reverse().map(windowWire),
          pending: {
            issueCount: fuel.pending.issueIds.length,
            litres: formatTenths(fuel.pending.litresTenths),
            advance: formatTenths(fuel.pending.advanceTenths),
          },
          rules: {
            tolerancePercent: state.settings.fuelVariancePercent,
            minSample:
              item.meterType === "km" ? state.settings.fuelMinKm : state.settings.fuelMinHours,
            meterType: item.meterType,
          },
        },
        schema: plantFuelListResponseSchema,
      };
    }
    if (method === "POST") {
      open();
      if (usage) {
        const input = parse(recordUsageRequestSchema, body);
        const projectId = recordSite(item, input.siteId, input.usedOn);
        if (
          state.usage.some(
            (entry) =>
              entry.plantId === item.id && entry.usedOn === input.usedOn && !entry.correctsId,
          )
        )
          throw fail(409, "usage-day-exists");
        checkUsage(item, input.usedOn, input, null);
        const entry: Usage = {
          id: input.id,
          plantId: item.id,
          projectId,
          siteId: input.siteId,
          usedOn: input.usedOn,
          dayStatus: input.dayStatus,
          startReading: input.startReading ?? null,
          endReading: input.endReading ?? null,
          operator: operatorOf(item, input.usedOn, input.operatorLabourerId, input.operatorUserId),
          notes: input.notes ?? null,
          correctsId: null,
          correctionReason: null,
          isVoid: false,
          key: randomUUID(),
          recordedBy: actor,
          recordedAt: now(),
        };
        state.usage.push(entry);
        return {
          status: 201,
          body: { entry: usageWire(entry), replayed: false },
          schema: plantUsageResponseSchema,
        };
      }
      if (item.fuelType === "none") throw fail(409, "plant-no-fuel");
      const input = parse(recordFuelRequestSchema, body);
      const at = Date.parse(input.issuedAt);
      if (at > Date.now() + 5 * 60_000) throw fail(409, "plant-date-future");
      const projectId = recordSite(item, input.siteId, plantBusinessDate(at), true);
      if ((item.meterType !== "none") !== Boolean(input.meterReading))
        throw fail(422, "plant-not-metered");
      if (
        input.meterReading &&
        !checkMeterReading(readings(item, null), noResets, at, tenths(input.meterReading)!).ok
      )
        throw fail(409, "meter-out-of-order");
      const entry: Fuel = {
        id: input.id,
        plantId: item.id,
        projectId,
        siteId: input.siteId,
        issuedAt: input.issuedAt,
        litres: input.litres,
        meterReading: input.meterReading ?? null,
        tankFilled: input.tankFilled,
        fuelType: item.fuelType,
        standardConsumption: item.standardConsumption,
        source: input.source,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        correctsId: null,
        correctionReason: null,
        isVoid: false,
        key: randomUUID(),
        recordedBy: actor,
        recordedAt: now(),
      };
      state.fuel.push(entry);
      const fuel = analysis(item);
      const window = fuel.windows.find((candidate) => candidate.toId === entry.id);
      return {
        status: 201,
        body: {
          entry: fuelWire(entry, fuel.staticIssueIds),
          replayed: false,
          window: window ? windowWire(window) : null,
        },
        schema: plantFuelResponseSchema,
      };
    }
  }
  const correction = /^(usage|fuel)\/([^/]+)\/corrections$/.exec(rest);
  if (correction && method === "POST") {
    open();
    const [, kind, recordId] = correction;
    const list: (Usage | Fuel)[] = kind === "usage" ? state.usage : state.fuel;
    const original = list.find((entry) => entry.id === recordId && entry.plantId === item.id);
    if (!original || !canRead(original.projectId)) throw fail(404, "not-found");
    if (list.some((entry) => entry.correctsId === original.id))
      throw fail(409, "record-superseded");
    const allowed =
      (kind === "usage" ? canRecord(original.projectId) : canFuel(original.projectId)) &&
      (holdsManage(original.projectId) || original.recordedBy.id === actor.id);
    if (!allowed) throw fail(403, "forbidden");
    if (kind === "usage") {
      const input = parse(correctUsageRequestSchema, body);
      const base = original as Usage;
      const entry: Usage =
        input.action === "void"
          ? {
              ...base,
              id: input.id,
              correctsId: base.id,
              correctionReason: input.reason,
              isVoid: true,
              recordedBy: actor,
              recordedAt: now(),
            }
          : (() => {
              checkUsage(item, base.usedOn, input, base.id);
              return {
                ...base,
                id: input.id,
                dayStatus: input.dayStatus,
                startReading: input.startReading ?? null,
                endReading: input.endReading ?? null,
                notes: input.notes ?? null,
                correctsId: base.id,
                correctionReason: input.reason,
                isVoid: false,
                recordedBy: actor,
                recordedAt: now(),
              };
            })();
      state.usage.push(entry);
      return {
        status: 201,
        body: { entry: usageWire(entry), replayed: false },
        schema: plantUsageResponseSchema,
      };
    }
    const input = parse(correctFuelRequestSchema, body);
    const base = original as Fuel;
    if (input.action === "correct" && input.meterReading) {
      if (
        !checkMeterReading(
          readings(item, base.id),
          noResets,
          Date.parse(input.issuedAt),
          tenths(input.meterReading)!,
        ).ok
      )
        throw fail(409, "meter-out-of-order");
    }
    const entry: Fuel =
      input.action === "void"
        ? {
            ...base,
            id: input.id,
            correctsId: base.id,
            correctionReason: input.reason,
            isVoid: true,
            recordedBy: actor,
            recordedAt: now(),
          }
        : {
            ...base,
            id: input.id,
            litres: input.litres,
            meterReading: input.meterReading ?? null,
            tankFilled: input.tankFilled,
            correctsId: base.id,
            correctionReason: input.reason,
            isVoid: false,
            recordedBy: actor,
            recordedAt: now(),
          };
    state.fuel.push(entry);
    const fuel = analysis(item);
    return {
      status: 201,
      body: { entry: fuelWire(entry, fuel.staticIssueIds), replayed: false, window: null },
      schema: plantFuelResponseSchema,
    };
  }
  if (rest === "breakdowns" && method === "POST") {
    open();
    const input = parse(reportBreakdownRequestSchema, body);
    const projectId = recordSite(
      item,
      input.siteId,
      plantBusinessDate(Date.parse(input.reportedAt)),
    );
    state.breakdowns.push({
      id: randomUUID(),
      plantId: item.id,
      projectId,
      siteId: input.siteId,
      number: state.breakdowns.length + 1,
      reportedAt: input.reportedAt,
      severity: input.severity,
      description: input.description,
      status: "open",
      reportedBy: actor,
      resolvedOn: null,
      resolutionNote: null,
      repairedBy: null,
      costReference: null,
      resolvedBy: null,
      version: 1,
    });
    refreshStatus(item);
    return { ...detail(item), status: 201 };
  }
  const resolve = /^breakdowns\/([^/]+)\/resolve$/.exec(rest);
  if (resolve && method === "POST") {
    open();
    const input = parse(resolveBreakdownRequestSchema, body);
    const breakdown = state.breakdowns.find(
      (entry) => entry.id === resolve[1] && entry.plantId === item.id,
    );
    if (!breakdown) throw fail(404, "not-found");
    if (breakdown.status !== "open") throw fail(409, "invalid-transition");
    if (breakdown.version !== input.version) throw fail(409, "version-conflict");
    const repaired = input.resolution === "repaired";
    const allowed =
      repaired && breakdown.severity !== "unsafe"
        ? canRecord(breakdown.projectId)
        : canManage(breakdown.projectId);
    if (!allowed) throw fail(403, "forbidden");
    if ((input.resolution === "off_hire") !== (item.ownership === "hired") && !repaired)
      throw fail(409, "breakdown-resolution-invalid");
    Object.assign(breakdown, {
      status: input.resolution,
      resolvedOn: input.resolvedOn,
      resolutionNote: input.note ?? null,
      repairedBy: input.repairedBy ?? null,
      costReference: input.costReference ?? null,
      resolvedBy: actor,
      version: breakdown.version + 1,
    });
    if (!repaired) {
      item.status = input.resolution === "off_hire" ? "off_hire" : "disposed";
      item.closedOn = input.resolvedOn;
      item.statusReason = input.note ?? null;
      item.projectId = null;
      item.siteId = null;
      item.version += 1;
    } else refreshStatus(item);
    return detail(item);
  }
  if (rest === "services" && method === "POST") {
    open();
    const input = parse(recordServiceRequestSchema, body);
    if (!(item.projectId ? canRecord(item.projectId) : manageSomewhere))
      throw fail(403, "forbidden");
    state.services.unshift({
      id: randomUUID(),
      plantId: item.id,
      projectId: item.projectId,
      servicedAt: input.servicedAt,
      kind: input.kind,
      meterReading: input.meterReading ?? null,
      description: input.description,
      doneBy: input.doneBy ?? null,
      costReference: input.costReference ?? null,
      status: "recorded",
      voidReason: null,
      recordedBy: actor,
      version: 1,
    });
    return { ...detail(item), status: 201 };
  }
  return null;
}
