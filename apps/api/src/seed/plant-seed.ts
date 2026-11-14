import { randomUUID } from "node:crypto";
import type { INestApplicationContext } from "@nestjs/common";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import {
  createPlantRequestSchema,
  createSupplierRequestSchema,
  recordFuelRequestSchema,
  recordUsageRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { PrismaService } from "../infra/prisma.service.js";
import { AccessPolicy } from "../modules/identity/access-policy.js";
import type { Principal } from "../modules/identity/auth.service.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { PlantMaintenanceService } from "../modules/plant/plant-maintenance.service.js";
import { PlantOperatorsService } from "../modules/plant/plant-operators.js";
import { PlantRecordsService } from "../modules/plant/plant-records.service.js";
import { PlantRegisterService } from "../modules/plant/plant-register.service.js";
import { SuppliersService } from "../modules/procurement/suppliers.service.js";
import { seedPrincipal } from "./demo-procure-to-pay.js";

/**
 * D8.3 demo plant on RUI-HTS and KIT-BNG (synthetic), written through the real services as the
 * runtime role so every trigger applies: a hired excavator on the RUI-HTS Main plot with an
 * operator, four days of usage and fuel such that one full-tank window is over the standard (the
 * fuel variance alert: 182.0 L against 140.0 L expected, +30.0 %); an owned concrete mixer whose
 * service is due; an owned poker vibrator with an open major breakdown (under repair); a hired
 * roller on the KIT-BNG Bungalow plot that has stood idle since its hire began; scaffolding counted
 * by quantity; and a generator in the yard. Dates are relative to the seed day (Africa/Nairobi).
 * Idempotent: skipped when the company already has EX-01.
 */

export type PlantSeedSummary = {
  created: boolean;
  items: { code: string; status: string; alerts: string[] }[];
  fuelVarianceAlerts: number;
};

type SeedUsers = { ownerId: string; projectManagerId: string; siteAgentId: string };

const seedRequest = { headers: {} } as Request;
const HIRE_SUPPLIER = "Nairobi Plant Hire Ltd (synthetic)";

export async function seedPlant(
  app: INestApplicationContext,
  tenantId: string,
  users: SeedUsers,
): Promise<PlantSeedSummary> {
  const prisma = app.get(PrismaService);
  const db = app.get(TenantDatabase);
  const register = app.get(PlantRegisterService);
  const read = <T>(work: (tx: Parameters<Parameters<TenantDatabase["run"]>[1]>[0]) => Promise<T>) =>
    db.run({ userId: users.ownerId, tenantId, requestId: "seed" }, work);
  const today = nairobiDate();
  const day = (offset: number) => addCalendarDays(today, offset);
  const at = (offset: number, time: string) => `${day(offset)}T${time}:00+03:00`;
  const facts = await read(async (tx) => {
    const projects = await tx.project.findMany({
      where: { tenantId, code: { in: ["RUI-HTS", "KIT-BNG"] } },
      include: { sites: true },
    });
    const rui = projects.find((project) => project.code === "RUI-HTS")!;
    const kit = projects.find((project) => project.code === "KIT-BNG")!;
    const operator = await tx.labourer.findFirst({
      where: {
        tenantId,
        trade: { key: "machine_operator" },
        engagements: { some: { projectId: rui.id, endDate: null } },
      },
      select: { id: true },
    });
    return {
      ruiId: rui.id,
      mainSite: rui.sites.find((site) => site.name === "Main plot")!.id,
      kitSite: kit.sites.find((site) => site.name === "Bungalow plot")!.id,
      operatorId: operator?.id ?? null,
      existing: await tx.plantItem.findUnique({
        where: { tenantId_code: { tenantId, code: "EX-01" } },
        select: { id: true },
      }),
      supplier: await tx.supplier.findFirst({
        where: { tenantId, legalName: HIRE_SUPPLIER },
        select: { id: true },
      }),
    };
  });
  const [owner, agent] = await Promise.all(
    [users.ownerId, users.siteAgentId].map((id) => seedPrincipal(prisma, id, tenantId)),
  );
  if (facts.existing) return summarise(register, owner, false);

  let supplierId = facts.supplier?.id ?? null;
  if (!supplierId) {
    const suppliers = app.get(SuppliersService);
    const policy = app.get(AccessPolicy);
    supplierId = await read(async (tx) => {
      await tx.$queryRaw`SELECT tenant_id FROM tenants WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
      const access = await policy.load(tx, tenantId, users.ownerId);
      if (!access) throw new Error("Seed owner is not a member of the demo company");
      return suppliers.createInScope(
        { tx, access, principal: undefined as unknown as Principal },
        createSupplierRequestSchema.parse({
          legalName: HIRE_SUPPLIER,
          tradingName: "Nairobi Plant Hire",
          etimsStatus: "registered",
          etimsCheckedOn: "2026-11-01",
          creditDays: 30,
          notes: "Synthetic plant hire company for the demo.",
        }),
      );
    });
  }

  const create = (body: object) =>
    register.create(owner, createPlantRequestSchema.parse(body), seedRequest);
  const records = app.get(PlantRecordsService);
  const usage = (plantId: string, siteId: string, body: object) =>
    records.recordUsage(
      agent,
      plantId,
      recordUsageRequestSchema.parse({
        id: randomUUID(),
        siteId,
        capturedAt: new Date().toISOString(),
        ...body,
      }),
      `seed-${randomUUID()}`,
      seedRequest,
    );
  const fuel = (plantId: string, siteId: string, body: object) =>
    records.recordFuel(
      agent,
      plantId,
      recordFuelRequestSchema.parse({
        id: randomUUID(),
        siteId,
        capturedAt: new Date().toISOString(),
        source: "site_store",
        ...body,
      }),
      `seed-${randomUUID()}`,
      seedRequest,
    );

  // EX-01: a hired 20-tonne excavator (KES 18,000 a day) with a certified operator. Full-tank
  // fillings: 70.0 L at 2,450.0 h (baseline), 141.0 L at 2,460.0 h (+0.7 %, within the standard),
  // then 182.0 L at 2,470.0 h: 10.0 h × 14.00 L/h = 140.0 L expected, +30.0 % → over the standard.
  const excavator = await create({
    code: "EX-01",
    name: "Excavator 20 t",
    category: "excavator",
    makeModel: "Synthetic EX200",
    registration: "KDX 001X",
    ownership: "hired",
    supplierId,
    hireRateMinor: 1_800_000,
    hireRateUnit: "day",
    hireStartOn: day(-12),
    hireEndOn: day(30),
    meterType: "hours",
    fuelType: "diesel",
    standardConsumption: "14.00",
    openingOn: day(-12),
    openingReading: "2400",
    serviceEvery: "250",
    siteId: facts.mainSite,
  });
  const ex = excavator.item.id;
  if (facts.operatorId)
    await app.get(PlantOperatorsService).assign(
      owner,
      ex,
      {
        projectId: facts.ruiId,
        kind: "labourer",
        labourerId: facts.operatorId,
        fromOn: day(-12),
        certificateRef: "NITA/PLT/SYN-0042",
        certificateExpiresOn: day(300),
      },
      seedRequest,
    );
  const operator = facts.operatorId ? { operatorLabourerId: facts.operatorId } : {};
  await fuel(ex, facts.mainSite, {
    issuedAt: at(-4, "07:00"),
    litres: "70",
    meterReading: "2450",
    tankFilled: true,
  });
  await usage(ex, facts.mainSite, {
    usedOn: day(-4),
    dayStatus: "working",
    startReading: "2450",
    endReading: "2460",
    ...operator,
  });
  await fuel(ex, facts.mainSite, {
    issuedAt: at(-4, "18:00"),
    litres: "141",
    meterReading: "2460",
    tankFilled: true,
  });
  await usage(ex, facts.mainSite, {
    usedOn: day(-3),
    dayStatus: "working",
    startReading: "2460",
    endReading: "2470",
    ...operator,
  });
  await fuel(ex, facts.mainSite, {
    issuedAt: at(-3, "18:00"),
    litres: "182",
    meterReading: "2470",
    tankFilled: true,
  });
  await usage(ex, facts.mainSite, {
    usedOn: day(-2),
    dayStatus: "working",
    startReading: "2470",
    endReading: "2478",
    ...operator,
  });
  await usage(ex, facts.mainSite, {
    usedOn: day(-1),
    dayStatus: "idle",
    startReading: "2478",
    endReading: "2478",
  });

  // MX-01: an owned 350-litre mixer serviced every 100 hours; 92.0 h since registration → due.
  const mixer = await create({
    code: "MX-01",
    name: "Concrete mixer 350 L",
    category: "concrete_mixer",
    ownership: "owned",
    meterType: "hours",
    fuelType: "diesel",
    standardConsumption: "1.50",
    openingOn: day(-30),
    openingReading: "1000",
    serviceEvery: "100",
    serviceEveryDays: 90,
    siteId: facts.mainSite,
  });
  for (const [offset, start, end] of [
    [-3, "1080", "1086"],
    [-2, "1086", "1092"],
  ] as const)
    await usage(mixer.item.id, facts.mainSite, {
      usedOn: day(offset),
      dayStatus: "working",
      startReading: start,
      endReading: end,
    });

  // VB-01: an owned petrol poker vibrator (no meter) with an open major breakdown.
  const vibrator = await create({
    code: "VB-01",
    name: "Poker vibrator 45 mm",
    category: "vibrator",
    ownership: "owned",
    quantity: 2,
    meterType: "none",
    fuelType: "petrol",
    openingOn: day(-20),
    siteId: facts.mainSite,
  });
  await usage(vibrator.item.id, facts.mainSite, { usedOn: day(-2), dayStatus: "working" });
  await app.get(PlantMaintenanceService).report(
    agent,
    vibrator.item.id,
    {
      siteId: facts.mainSite,
      reportedAt: at(-1, "10:30"),
      severity: "major",
      description: "Drive shaft snapped during the column pour; poker head stuck",
    },
    seedRequest,
  );

  // RL-01: a hired vibrating roller on the KIT-BNG Bungalow plot, idle since its hire began.
  await create({
    code: "RL-01",
    name: "Vibrating roller 3 t",
    category: "roller",
    ownership: "hired",
    supplierId,
    hireRateMinor: 1_200_000,
    hireRateUnit: "day",
    hireStartOn: day(-8),
    hireEndOn: day(4),
    meterType: "hours",
    fuelType: "diesel",
    standardConsumption: "4.00",
    openingOn: day(-8),
    openingReading: "860",
    siteId: facts.kitSite,
  });

  // SCF-01: scaffold frames counted by quantity; GN-01: a generator waiting in the yard.
  await create({
    code: "SCF-01",
    name: "Scaffold frames 1.7 m",
    category: "scaffolding",
    ownership: "owned",
    quantity: 240,
    meterType: "none",
    fuelType: "none",
    openingOn: day(-40),
    siteId: facts.mainSite,
  });
  await create({
    code: "GN-01",
    name: "Generator 20 kVA",
    category: "generator",
    ownership: "owned",
    meterType: "hours",
    fuelType: "diesel",
    standardConsumption: "4.50",
    openingOn: day(-60),
    openingReading: "3120",
    serviceEvery: "250",
  });

  return summarise(register, owner, true);
}

async function summarise(
  register: PlantRegisterService,
  owner: Principal,
  created: boolean,
): Promise<PlantSeedSummary> {
  const list = await register.list(owner, { limit: 100, status: "active" }, seedRequest);
  return {
    created,
    items: list.items.map((item) => ({
      code: item.code,
      status: item.status,
      alerts: item.alerts.map((alert) => alert.kind),
    })),
    fuelVarianceAlerts: list.items.filter((item) =>
      item.alerts.some((alert) => alert.kind === "fuel_over_standard"),
    ).length,
  };
}
