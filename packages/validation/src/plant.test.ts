import { describe, expect, it } from "vitest";
import {
  assignOperatorRequestSchema,
  correctUsageRequestSchema,
  createPlantRequestSchema,
  recordFuelRequestSchema,
  recordUsageRequestSchema,
  resolveBreakdownRequestSchema,
  updatePlantSettingsRequestSchema,
} from "./plant.js";

const id = "31000000-0000-4000-8000-000000000001";
const other = "31000000-0000-4000-8000-000000000002";
const capturedAt = "2026-11-14T08:00:00+03:00";

describe("plant contracts", () => {
  const owned = {
    code: " mx-01 ",
    name: "Concrete mixer 350 L",
    category: "concrete_mixer",
    ownership: "owned",
    meterType: "hours",
    fuelType: "diesel",
    standardConsumption: "1.5",
    openingOn: "2026-11-01",
    openingReading: "120",
  };

  it("normalises codes and decimals and keeps owned plant free of hire terms", () => {
    const parsed = createPlantRequestSchema.parse(owned);
    expect(parsed).toMatchObject({
      code: "MX-01",
      standardConsumption: "1.50",
      openingReading: "120.0",
      quantity: 1,
    });
    expect(createPlantRequestSchema.safeParse({ ...owned, supplierId: id }).success).toBe(false);
    expect(createPlantRequestSchema.safeParse({ ...owned, openingReading: "1.25" }).success).toBe(
      false,
    );
    expect(createPlantRequestSchema.safeParse({ ...owned, code: "MX 01" }).success).toBe(false);
  });

  it("needs a supplier, rate and start for hired plant, and an hour meter for hourly rates", () => {
    const hired = {
      ...owned,
      ownership: "hired",
      supplierId: id,
      hireRateMinor: 1_500_000,
      hireRateUnit: "day",
      hireStartOn: "2026-11-01",
      hireEndOn: "2026-11-30",
    };
    expect(createPlantRequestSchema.safeParse(hired).success).toBe(true);
    for (const bad of [
      { supplierId: null },
      { hireRateMinor: 0 },
      { hireStartOn: null },
      { hireEndOn: "2026-10-31" },
      { hireRateUnit: "hour", meterType: "km" },
    ])
      expect(
        createPlantRequestSchema.safeParse({ ...hired, ...bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
  });

  it("ties the opening reading, standard and service interval to the meter and fuel types", () => {
    const scaffold = {
      code: "SCF-01",
      name: "Scaffold frames",
      category: "scaffolding",
      ownership: "owned",
      meterType: "none",
      fuelType: "none",
      openingOn: "2026-11-01",
      quantity: 120,
    };
    expect(createPlantRequestSchema.safeParse(scaffold).success).toBe(true);
    for (const bad of [
      { openingReading: "0" },
      { standardConsumption: "1.00" },
      { serviceEvery: "250" },
    ])
      expect(createPlantRequestSchema.safeParse({ ...scaffold, ...bad }).success).toBe(false);
    expect(
      createPlantRequestSchema.safeParse({ ...owned, standardConsumption: null }).success,
    ).toBe(false);
    expect(createPlantRequestSchema.safeParse({ ...owned, openingReading: null }).success).toBe(
      false,
    );
  });

  it("checks a day's readings and refuses two operators or two cost tags", () => {
    const usage = {
      id,
      siteId: other,
      usedOn: "2026-11-13",
      dayStatus: "working",
      startReading: "1200",
      endReading: "1208.5",
      capturedAt,
    };
    expect(recordUsageRequestSchema.parse(usage)).toMatchObject({
      startReading: "1200.0",
      endReading: "1208.5",
    });
    for (const bad of [
      { endReading: "1199.9" },
      { endReading: null },
      { operatorLabourerId: id, operatorUserId: other },
      { bqItemLineageId: id, costCodeId: other },
    ])
      expect(recordUsageRequestSchema.safeParse({ ...usage, ...bad }).success).toBe(false);
    expect(
      correctUsageRequestSchema.safeParse({
        action: "void",
        id,
        reason: "Wrong machine",
        capturedAt,
      }).success,
    ).toBe(true);
    expect(
      correctUsageRequestSchema.safeParse({ action: "void", id, reason: "", capturedAt }).success,
    ).toBe(false);
    expect(
      correctUsageRequestSchema.safeParse({
        ...usage,
        action: "correct",
        reason: "Typed the end reading wrong",
        endReading: "1100",
      }).success,
    ).toBe(false);
  });

  it("limits a fuel issue to 0.1–2,000.0 litres", () => {
    const fuel = {
      id,
      siteId: other,
      issuedAt: capturedAt,
      litres: "182",
      meterReading: "1210",
      tankFilled: true,
      source: "site_store",
      capturedAt,
    };
    expect(recordFuelRequestSchema.parse(fuel).litres).toBe("182.0");
    for (const litres of ["0", "2000.1", "12.25", "-5"])
      expect(recordFuelRequestSchema.safeParse({ ...fuel, litres }).success, litres).toBe(false);
  });

  it("needs a reason to send plant back or write it off, and a certificate for its expiry", () => {
    const base = { version: 1, resolvedOn: "2026-11-14" };
    expect(
      resolveBreakdownRequestSchema.safeParse({ ...base, resolution: "repaired" }).success,
    ).toBe(true);
    expect(
      resolveBreakdownRequestSchema.safeParse({ ...base, resolution: "off_hire" }).success,
    ).toBe(false);
    expect(
      assignOperatorRequestSchema.safeParse({
        projectId: id,
        kind: "labourer",
        labourerId: other,
        fromOn: "2026-11-01",
        certificateExpiresOn: "2027-01-01",
      }).success,
    ).toBe(false);
    expect(
      assignOperatorRequestSchema.safeParse({
        projectId: id,
        kind: "staff",
        labourerId: other,
        fromOn: "2026-11-01",
      }).success,
    ).toBe(false);
    expect(
      updatePlantSettingsRequestSchema.safeParse({
        fuelVariancePercent: 15,
        fuelMinHours: 10,
        fuelMinKm: 100,
        idleHireDays: 3,
        hireEndingDays: 7,
        serviceDueSoonPercent: 10,
        certificateCategories: ["excavator", "excavator"],
        version: 0,
      }).success,
    ).toBe(false);
  });
});
