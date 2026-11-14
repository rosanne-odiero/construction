import { randomInt, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import { CURRENT_CONSENT_NOTICE } from "@pm-buddy/types";
import {
  labourerResponseSchema,
  labourSetupResponseSchema,
  plantAlertsResponseSchema,
  plantDetailResponseSchema,
  plantFuelListResponseSchema,
  plantFuelResponseSchema,
  plantListResponseSchema,
  plantSettingsResponseSchema,
  plantUsageListResponseSchema,
  plantUsageResponseSchema,
  projectPlantResponseSchema,
  projectResponseSchema,
  siteResponseSchema,
  supplierDetailResponseSchema,
  tenantCreatedResponseSchema,
} from "@pm-buddy/validation";
import { PrismaPg } from "@prisma/adapter-pg";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { Browser, notifications } from "./support.js";
import { testDatabaseUrls } from "./test-database.js";

/**
 * D8.3 plant and equipment against the real database as the runtime role (pmb_app): the fuel
 * variance (the done-when) with hand-computed numbers, flagged above the tolerance and not within
 * it or below the minimum sample; meter readings kept monotonic in the API and in SQL with a
 * reasoned reset; append-only corrections and voids; moves, breakdowns (unsafe plant cannot work),
 * services, operators, hire tracking and closing; the permission matrix (clients, suppliers and
 * labourers refused; costs only for cost holders); tenant isolation; every guard refusing direct
 * SQL; and an audit log without free text.
 */
describe("Plant and equipment (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let manager: Browser;
  let agent: Browser;
  let foreman: Browser;
  let storekeeper: Browser;
  let surveyor: Browser;
  let client: Browser;
  let supplierUser: Browser;
  let worker: Browser;
  let outsider: Browser;
  let tenantId: string;
  let otherTenant: string;
  let projectId: string;
  let otherProject: string;
  let mainSite: string;
  let yardSite: string;
  let otherSite: string;
  let supplierId: string;
  const labourers: string[] = [];
  let notificationSpy: ReturnType<typeof vi.spyOn>;
  const today = nairobiDate();
  const day = (offset: number) => addCalendarDays(today, offset);
  const at = (offset: number, time: string) => `${day(offset)}T${time}:00+03:00`;
  const context = (browser = owner, tenant = tenantId) => ({
    userId: browser.auth.user.id,
    tenantId: tenant,
    requestId: randomUUID(),
  });
  const ok = <T>(res: request.Response, parse: (body: unknown) => T, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return parse(res.body);
  };
  const problem = (res: request.Response, status: number, code?: string) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    if (code) expect((res.body as { code?: string }).code).toBe(code);
  };
  const fresh = (browser = owner) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
  const join = async (member: Browser, role: string, permissions: string[]) => {
    await fresh();
    expect(
      (
        await owner.call("post", "tenants/current/invitations", {
          identifier: member.identifier,
          role,
        })
      ).status,
    ).toBe(201);
    const token = notifications
      .get(member.identifier)
      ?.at(-1)
      ?.text.match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
    expect((await member.call("post", "tenants/invitations/accept", { token })).status).toBe(200);
    expect((await member.call("post", `tenants/${tenantId}/select`, {})).status).toBe(200);
    await fresh();
    expect(
      (
        await owner.call("put", `projects/${projectId}/members/${member.auth.user.id}`, {
          permissions,
        })
      ).status,
    ).toBe(200);
  };
  const site = async (project: string, name: string) =>
    ok(
      await owner.call("post", `projects/${project}/sites`, {
        name,
        geofence: { kind: "radius", center: { lat: -1.1489, lng: 36.9612 }, radiusM: 60 },
      }),
      (body) => siteResponseSchema.parse(body).site.id,
      201,
    );
  const detail = (res: request.Response, status = 200) =>
    ok(res, (body) => plantDetailResponseSchema.parse(body), status);
  const register = async (body: object, browser = manager) =>
    detail(await browser.call("post", "plant", body), 201);
  const excavator = (code: string, extra: object = {}) => ({
    code,
    name: "Excavator 20 t (synthetic)",
    category: "excavator",
    ownership: "hired",
    supplierId,
    hireRateMinor: 1_500_000,
    hireRateUnit: "day",
    hireStartOn: day(-10),
    meterType: "hours",
    fuelType: "diesel",
    standardConsumption: "14.00",
    openingOn: day(-10),
    openingReading: "1200",
    siteId: mainSite,
    ...extra,
  });
  const key = () => `k-${randomUUID()}`;
  const usageCall = (browser: Browser, plantId: string, body: object, idem = key()) =>
    browser.call(
      "post",
      `plant/${plantId}/usage`,
      { id: randomUUID(), capturedAt: new Date().toISOString(), siteId: mainSite, ...body },
      true,
      { "Idempotency-Key": idem },
    );
  const usage = async (browser: Browser, plantId: string, body: object) =>
    ok(await usageCall(browser, plantId, body), (res) => plantUsageResponseSchema.parse(res), 201);
  const fuelCall = (browser: Browser, plantId: string, body: object, idem = key()) =>
    browser.call(
      "post",
      `plant/${plantId}/fuel`,
      {
        id: randomUUID(),
        capturedAt: new Date().toISOString(),
        siteId: mainSite,
        tankFilled: true,
        source: "site_store",
        ...body,
      },
      true,
      { "Idempotency-Key": idem },
    );
  const fuel = async (browser: Browser, plantId: string, body: object) =>
    ok(await fuelCall(browser, plantId, body), (res) => plantFuelResponseSchema.parse(res), 201);
  const reload = async (plantId: string, browser = manager) =>
    detail(await browser.call("get", `plant/${plantId}`));
  const sql = (browser: Browser, statement: string) =>
    db.run(context(browser), (tx) => tx.$executeRawUnsafe(statement));

  beforeAll(async () => {
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    db = app.get(TenantDatabase);
    notificationSpy = vi
      .spyOn(app.get(AuthSecurity), "notify")
      .mockImplementation(async (identifier, subject, text) => {
        notifications.set(identifier, [
          ...(notifications.get(identifier) ?? []),
          { subject, text },
        ]);
      });
    owner = new Browser(app);
    manager = new Browser(app);
    agent = new Browser(app);
    foreman = new Browser(app);
    storekeeper = new Browser(app);
    surveyor = new Browser(app);
    client = new Browser(app);
    supplierUser = new Browser(app);
    worker = new Browser(app);
    outsider = new Browser(app);
    for (const browser of [
      owner,
      manager,
      agent,
      foreman,
      storekeeper,
      surveyor,
      client,
      supplierUser,
      outsider,
    ])
      await browser.register();
    await worker.initialize();
    for (const browser of [owner, outsider, manager]) await browser.enroll();
    tenantId = tenantCreatedResponseSchema.parse(
      (await owner.call("post", "tenants", { name: `Plant company ${randomUUID()}` })).body,
    ).tenant.id;
    otherTenant = tenantCreatedResponseSchema.parse(
      (await outsider.call("post", "tenants", { name: `Other plant company ${randomUUID()}` }))
        .body,
    ).tenant.id;
    await fresh();
    projectId = projectResponseSchema.parse(
      (await owner.call("post", "projects", { name: "Plant project" })).body,
    ).project.id;
    await fresh();
    otherProject = projectResponseSchema.parse(
      (await owner.call("post", "projects", { name: "Another plant project" })).body,
    ).project.id;
    mainSite = await site(projectId, "Main plot");
    yardSite = await site(projectId, "Block B");
    otherSite = await site(otherProject, "Far site");
    await join(manager, "project_manager", [
      "projects.view",
      "projects.manage",
      "plant.manage",
      "site.diary",
      "finance.view",
      "labour.view",
    ]);
    // A site agent records usage, fuel and breakdowns but never manages the register or sees rates.
    await join(agent, "site_agent", ["projects.view", "site.diary", "labour.view"]);
    await join(foreman, "foreman", ["projects.view", "site.diary"]);
    // A storekeeper hands out diesel: fuel only.
    await join(storekeeper, "storekeeper", ["projects.view", "stores.manage"]);
    // A quantity surveyor reads plant and its costs (finance.view) but records nothing.
    await join(surveyor, "quantity_surveyor", ["projects.view", "bq.view", "finance.view"]);
    await join(client, "client", ["projects.view", "portal.client"]);
    await join(supplierUser, "supplier", ["projects.view"]);
    const number = `2547${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;
    await fresh();
    expect(
      (
        await owner.call("post", `projects/${projectId}/labourers/invitations`, {
          identifier: number,
        })
      ).status,
    ).toBe(201);
    const token = notifications
      .get(number)
      ?.at(-1)
      ?.text.match(/token=([A-Za-z0-9_-]{43})/)?.[1];
    expect(
      (
        await worker.call("post", "auth/pin/join", {
          identifier: number,
          token,
          displayName: "Synthetic Opareta",
          pin: "274915",
        })
      ).status,
    ).toBe(200);
    await fresh(manager);
    supplierId = supplierDetailResponseSchema.parse(
      ok(
        await owner.call("post", "suppliers", {
          legalName: "Plant Hire Kenya (synthetic)",
          etimsStatus: "registered",
          creditDays: 30,
        }),
        (body) => body,
        201,
      ),
    ).supplier.id;
    const setup = labourSetupResponseSchema.parse(
      (await owner.call("post", "labour/setup/defaults", {})).body,
    );
    const trade = setup.trades.find((entry) => entry.key === "machine_operator")!.id;
    const level = setup.skillLevels.find((entry) => entry.key === "skilled")!.id;
    for (let index = 0; index < 2; index += 1) {
      await fresh();
      const res = await owner.call("post", "labour/labourers", {
        fullName: `Mwendeshaji Mitambo ${randomUUID().slice(0, 6)}`,
        dateOfBirth: "1990-05-12",
        gender: "male",
        tradeId: trade,
        skillLevelId: level,
        engagementType: "casual",
        rateBasis: "daily",
        idType: "national_id",
        idNumber: String(70_000_000 + Math.floor(Math.random() * 9_999_999)),
        projectId,
        engagementStartDate: day(-60),
        consent: {
          noticeVersion: CURRENT_CONSENT_NOTICE.version,
          language: "en",
          method: "signed",
          granted: true,
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      labourers.push(labourerResponseSchema.parse(res.body).labourer.id);
    }
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("publishes every plant operation and refuses requests without a session or CSRF token", async () => {
    const spec = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (spec.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((entry) => Object.values(entry).map((operation) => operation.operationId));
    for (const name of [
      "listPlant",
      "listPlantAlerts",
      "getPlantSettings",
      "updatePlantSettings",
      "getPlantOptions",
      "registerPlant",
      "getPlant",
      "updatePlant",
      "movePlant",
      "closePlant",
      "assignPlantOperator",
      "endPlantOperator",
      "listPlantUsage",
      "recordPlantUsage",
      "correctPlantUsage",
      "listPlantFuel",
      "recordPlantFuel",
      "correctPlantFuel",
      "resetPlantMeter",
      "reportPlantBreakdown",
      "resolvePlantBreakdown",
      "recordPlantService",
      "voidPlantService",
      "getProjectPlant",
      "getProjectPlantOptions",
    ])
      expect(operations, name).toContain(name);
    expect((await new Browser(app).call("get", "plant", undefined, false)).status).toBe(401);
    expect((await manager.call("post", "plant", {}, false)).status).toBe(403);
  });

  it("flags fuel above the standard (the D8.3 done-when) and not within tolerance or below the minimum sample", async () => {
    // Plant records never post to the cost or stock ledgers (decision D-93).
    const ledgers = () =>
      db.run(context(), async (tx) => [
        await tx.costEntry.count(),
        await tx.stockLedgerEntry.count(),
      ]);
    const ledgersBefore = await ledgers();
    const item = await register(excavator("EX-01"));
    const id = item.item.id;
    expect(item.item).toMatchObject({ status: "on_site", meter: { reading: "1200.0" } });
    // Baseline full tank at 1,200.0 h (the tank level before it is unknown, so it is not judged).
    const baseline = await fuel(agent, id, {
      issuedAt: at(-3, "07:00"),
      litres: "50",
      meterReading: "1200",
    });
    expect(baseline.window).toBeNull();
    // 10.0 h later 182.0 L fill it: expected 10.0 h × 14.00 L/h = 140.0 L; the limit at 15 % is
    // 161.0 L; (182.0 − 140.0) ÷ 140.0 = +30.0 %, 18.20 L/h → over the standard.
    const over = await fuel(storekeeper, id, {
      issuedAt: at(-3, "17:00"),
      litres: "182",
      meterReading: "1210",
    });
    expect(over.window).toMatchObject({
      litres: "182.0",
      advance: "10.0",
      standardConsumption: "14.00",
      expectedLitres: "140.0",
      actualRate: "18.20",
      variancePercent: "30.0",
      state: "over_standard",
    });
    // 150.0 L for the next 10.0 h: +7.1 % (truncated), within the tolerance.
    const within = await fuel(agent, id, {
      issuedAt: at(-2, "17:00"),
      litres: "150",
      meterReading: "1220",
    });
    expect(within.window).toMatchObject({ variancePercent: "7.1", state: "within_standard" });
    // 300.0 L after only 5.0 h is short of the 10-hour sample: not judged, the window extends.
    const short = await fuel(agent, id, {
      issuedAt: at(-1, "09:00"),
      litres: "300",
      meterReading: "1225",
    });
    expect(short.window).toBeNull();
    const list = ok(await agent.call("get", `plant/${id}/fuel`), (body) =>
      plantFuelListResponseSchema.parse(body),
    );
    expect(list.windows.map((window) => [window.variancePercent, window.state])).toEqual([
      ["7.1", "within_standard"],
      ["30.0", "over_standard"],
    ]);
    expect(list.pending).toEqual({ issueCount: 1, litres: "300.0", advance: "5.0" });
    expect(list.rules).toEqual({ tolerancePercent: 15, minSample: 10, meterType: "hours" });
    const alerts = ok(await manager.call("get", "plant/alerts"), (body) =>
      plantAlertsResponseSchema.parse(body),
    );
    expect(
      alerts.alerts.filter((alert) => alert.plantId === id).map((alert) => alert.kind),
    ).toContain("fuel_over_standard");

    // Another item with one window at +10.0 % and one short sample: no fuel alert at all.
    const quiet = await register(excavator("EX-02"));
    for (const [time, litres, reading] of [
      ["07:00", "40", "1200"],
      ["17:00", "154", "1210"],
      ["18:00", "400", "1215"],
    ] as const)
      await fuel(agent, quiet.item.id, {
        issuedAt: at(-3, time),
        litres,
        meterReading: reading,
      });
    const quietAlerts = (await reload(quiet.item.id)).item.alerts.map((alert) => alert.kind);
    expect(quietAlerts).not.toContain("fuel_over_standard");
    // Fuel issued while the meter has not moved is flagged too (an estimate for review).
    const stuck = await fuel(agent, quiet.item.id, {
      issuedAt: at(-2, "08:00"),
      litres: "35",
      meterReading: "1215",
      tankFilled: false,
    });
    expect(stuck.entry.meterStatic).toBe(true);
    expect((await reload(quiet.item.id)).item.alerts).toContainEqual({
      kind: "fuel_meter_static",
      severity: "warning",
    });

    // A looser company tolerance (35 %) clears the first alert: only the rule decides.
    const settings = ok(await owner.call("get", "plant/settings"), (body) =>
      plantSettingsResponseSchema.parse(body),
    ).settings;
    const { permissions: _permissions, updatedAt: _updatedAt, ...values } = settings;
    problem(await agent.call("put", "plant/settings", values), 403);
    ok(await owner.call("put", "plant/settings", { ...values, fuelVariancePercent: 35 }), (body) =>
      plantSettingsResponseSchema.parse(body),
    );
    expect((await reload(id)).item.alerts.map((alert) => alert.kind)).not.toContain(
      "fuel_over_standard",
    );
    ok(await owner.call("put", "plant/settings", { ...values, version: 1 }), (body) =>
      plantSettingsResponseSchema.parse(body),
    );
    expect((await reload(id)).item.alerts.map((alert) => alert.kind)).toContain(
      "fuel_over_standard",
    );
    expect(await ledgers()).toEqual(ledgersBefore);
  });

  it("keeps meter readings monotonic in the API and in SQL, with a reasoned reset", async () => {
    const item = await register(excavator("EX-03"));
    const id = item.item.id;
    await usage(agent, id, {
      usedOn: day(-2),
      dayStatus: "working",
      startReading: "1200",
      endReading: "1208.5",
    });
    await fuel(agent, id, { issuedAt: at(-1, "12:00"), litres: "60", meterReading: "1212" });
    // Lower than the day before ended, or above a later fuelling the same day: refused.
    const lower = await usageCall(agent, id, {
      usedOn: day(-1),
      dayStatus: "working",
      startReading: "1208",
      endReading: "1215",
    });
    problem(lower, 409, "meter-out-of-order");
    expect((lower.body as { detail: string }).detail).toContain("earlier: 1208.5; later: none");
    problem(
      await usageCall(agent, id, {
        usedOn: day(-1),
        dayStatus: "working",
        startReading: "1213",
        endReading: "1218",
      }),
      409,
      "meter-out-of-order",
    );
    problem(
      await usageCall(agent, id, {
        usedOn: day(-1),
        dayStatus: "working",
        startReading: "1208.5",
        endReading: "1233",
      }),
      409,
      "meter-day-limit",
    );
    await usage(agent, id, {
      usedOn: day(-1),
      dayStatus: "working",
      startReading: "1208.5",
      endReading: "1216",
    });
    problem(
      await usageCall(foreman, id, {
        usedOn: day(-1),
        dayStatus: "idle",
        startReading: "1216",
        endReading: "1216",
      }),
      409,
      "usage-day-exists",
    );
    // The database refuses the same backwards reading, for the runtime role.
    await expect(
      db.run(context(agent), (tx) =>
        tx.plantUsageLog.create({
          data: {
            id: randomUUID(),
            tenantId,
            plantId: id,
            projectId,
            siteId: mainSite,
            usedOn: new Date(`${day(0)}T00:00:00.000Z`),
            dayStatus: "working",
            startReading: "1210",
            endReading: "1220",
            idempotencyKey: key(),
            requestDigest: "a".repeat(64),
            capturedAt: new Date(),
            recordedBy: agent.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow(/meter reading cannot be lower/);
    await expect(
      db.run(context(agent), (tx) =>
        tx.plantFuelIssue.create({
          data: {
            id: randomUUID(),
            tenantId,
            plantId: id,
            projectId,
            siteId: mainSite,
            issuedAt: new Date(at(-1, "10:00")),
            litres: "10",
            meterReading: "1300",
            tankFilled: true,
            fuelType: "diesel",
            standardConsumption: "14.00",
            source: "site_store",
            idempotencyKey: key(),
            requestDigest: "b".repeat(64),
            capturedAt: new Date(),
            recordedBy: agent.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow(/meter reading cannot be lower/);
    // A replaced meter: plant.manage records the reset with a reason after the last reading.
    const resetAt = new Date(Date.now() - 20 * 60_000).toISOString();
    problem(
      await agent.call("post", `plant/${id}/meter-resets`, {
        resetAt,
        oldReading: "1216",
        newReading: "0",
        reason: "meter_replaced",
        note: "Hour meter replaced after it stopped",
      }),
      403,
    );
    problem(
      await manager.call("post", `plant/${id}/meter-resets`, {
        resetAt: at(-1, "11:00"),
        oldReading: "1216",
        newReading: "0",
        reason: "meter_replaced",
        note: "Hour meter replaced after it stopped",
      }),
      409,
      "meter-reset-order",
    );
    problem(
      await manager.call("post", `plant/${id}/meter-resets`, {
        resetAt,
        oldReading: "1215",
        newReading: "0",
        reason: "meter_replaced",
        note: "Hour meter replaced after it stopped",
      }),
      409,
      "meter-out-of-order",
    );
    const reset = detail(
      await manager.call("post", `plant/${id}/meter-resets`, {
        resetAt,
        oldReading: "1216.5",
        newReading: "0",
        reason: "meter_replaced",
        note: "Hour meter replaced after it stopped",
      }),
      201,
    );
    expect(reset.resets).toHaveLength(1);
    // After the reset the new meter starts again from 0.0.
    const after = await fuel(agent, id, {
      issuedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      litres: "20",
      meterReading: "1.5",
    });
    expect(after.entry.meterReading).toBe("1.5");
    expect((await reload(id)).item.meter.reading).toBe("1.5");
    await expect(
      db.run(context(manager), (tx) =>
        tx.plantMeterReset.create({
          data: {
            id: randomUUID(),
            tenantId,
            plantId: id,
            resetAt: new Date(at(-1, "06:00")),
            oldReading: "5000",
            newReading: "0",
            reason: "other",
            note: "Back-dated in SQL",
            recordedBy: manager.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow(/after every reading/);
  });

  it("corrects and voids usage and fuel as new rows, never edits, and replays idempotently", async () => {
    const item = await register(excavator("EX-04"));
    const id = item.item.id;
    const idem = key();
    const body = {
      id: randomUUID(),
      capturedAt: new Date().toISOString(),
      siteId: mainSite,
      usedOn: day(-2),
      dayStatus: "working",
      startReading: "1200",
      endReading: "1207",
    };
    const first = await agent.call("post", `plant/${id}/usage`, body, true, {
      "Idempotency-Key": idem,
    });
    const entry = ok(first, (res) => plantUsageResponseSchema.parse(res), 201).entry;
    const replay = await agent.call("post", `plant/${id}/usage`, body, true, {
      "Idempotency-Key": idem,
    });
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(plantUsageResponseSchema.parse(replay.body)).toMatchObject({
      replayed: true,
      entry: { id: entry.id },
    });
    problem(
      await agent.call("post", `plant/${id}/usage`, { ...body, endReading: "1208" }, true, {
        "Idempotency-Key": idem,
      }),
      409,
      "idempotency-key-reused",
    );
    problem(
      await agent.call("post", `plant/${id}/usage`, body, true, { "Idempotency-Key": key() }),
      409,
      "usage-id-conflict",
    );
    problem(await agent.call("post", `plant/${id}/usage`, { ...body, id: randomUUID() }), 400);
    // Someone who neither manages plant nor recorded it cannot correct it.
    const correction = {
      action: "correct",
      id: randomUUID(),
      capturedAt: new Date().toISOString(),
      reason: "End reading was misread on the dashboard",
      siteId: mainSite,
      dayStatus: "working",
      startReading: "1200",
      endReading: "1206.5",
    };
    problem(
      await foreman.call("post", `plant/${id}/usage/${entry.id}/corrections`, correction, true, {
        "Idempotency-Key": key(),
      }),
      403,
    );
    const corrected = ok(
      await agent.call("post", `plant/${id}/usage/${entry.id}/corrections`, correction, true, {
        "Idempotency-Key": key(),
      }),
      (res) => plantUsageResponseSchema.parse(res),
      201,
    ).entry;
    expect(corrected).toMatchObject({
      state: "current",
      correctsId: entry.id,
      run: "6.5",
      correctionReason: "End reading was misread on the dashboard",
    });
    problem(
      await agent.call(
        "post",
        `plant/${id}/usage/${entry.id}/corrections`,
        { ...correction, id: randomUUID() },
        true,
        { "Idempotency-Key": key() },
      ),
      409,
      "record-superseded",
    );
    const history = ok(await manager.call("get", `plant/${id}/usage`), (res) =>
      plantUsageListResponseSchema.parse(res),
    );
    expect(history.entries.map((row) => [row.state, row.run])).toEqual([
      ["current", "6.5"],
      ["superseded", "7.0"],
    ]);
    expect(history.totals).toMatchObject({ workingDays30: 1, run30: "6.5" });
    // Fuel: a void is a new row too; the voided issue no longer counts.
    const issue = await fuel(agent, id, {
      issuedAt: at(-2, "12:00"),
      litres: "45",
      meterReading: "1203",
    });
    const voided = ok(
      await manager.call(
        "post",
        `plant/${id}/fuel/${issue.entry.id}/corrections`,
        {
          action: "void",
          id: randomUUID(),
          capturedAt: new Date().toISOString(),
          reason: "Recorded against the wrong machine",
        },
        true,
        { "Idempotency-Key": key() },
      ),
      (res) => plantFuelResponseSchema.parse(res),
      201,
    ).entry;
    expect(voided).toMatchObject({ state: "voided", correctsId: issue.entry.id });
    // The runtime role cannot rewrite or delete these ledgers; the schema owner meets the trigger.
    await expect(
      sql(agent, `UPDATE plant_usage_logs SET end_reading = 1300 WHERE id = '${entry.id}'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      sql(agent, `DELETE FROM plant_fuel_issues WHERE id = '${issue.entry.id}'`),
    ).rejects.toThrow(/permission denied/);
    const schemaOwner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrls().migrationUrl }),
    });
    try {
      for (const statement of [
        `UPDATE plant_usage_logs SET end_reading = 1300 WHERE id = '${entry.id}'`,
        `DELETE FROM plant_fuel_issues WHERE id = '${issue.entry.id}'`,
        `DELETE FROM plant_moves WHERE plant_id = '${id}'`,
      ])
        await expect(
          schemaOwner.$transaction([
            schemaOwner.$executeRawUnsafe(
              `SELECT set_config('app.tenant_id', '${tenantId}', true), set_config('app.user_id', '${manager.auth.user.id}', true)`,
            ),
            schemaOwner.$executeRawUnsafe(statement),
          ]),
        ).rejects.toThrow(/append-only/);
    } finally {
      await schemaOwner.$disconnect();
    }
  });

  it("lets site staff record, storekeepers fuel, cost holders see rates, and refuses everyone else", async () => {
    const item = await register(excavator("EX-05"));
    const id = item.item.id;
    // The register is company-level; rates and the estimate need a cost permission.
    const agentView = await reload(id, agent);
    expect(agentView.item.hire).toMatchObject({ rateMinor: null, estimateMinor: null });
    expect(agentView.permissions).toMatchObject({
      canEdit: false,
      canMove: false,
      canRecordUsage: true,
      canRecordFuel: true,
      canSeeCost: false,
    });
    // 11 calendar days on hire (day −10 to today) × KES 15,000 = KES 165,000 (an estimate).
    expect((await reload(id, surveyor)).item.hire).toMatchObject({
      daysOnHire: 11,
      rateMinor: 1_500_000,
      estimateMinor: 16_500_000,
    });
    problem(await agent.call("post", "plant", excavator("EX-99")), 403);
    problem(
      await agent.call("post", `plant/${id}/moves`, {
        version: item.item.version,
        siteId: yardSite,
        movedOn: today,
      }),
      403,
    );
    problem(
      await agent.call("patch", `plant/${id}`, {
        version: item.item.version,
        name: "Renamed",
        category: "excavator",
      }),
      403,
    );
    // The storekeeper issues fuel but does not log usage; the QS reads but records nothing.
    await fuel(storekeeper, id, { issuedAt: at(-1, "07:00"), litres: "30", meterReading: "1200" });
    problem(
      await usageCall(storekeeper, id, {
        usedOn: day(-1),
        dayStatus: "working",
        startReading: "1200",
        endReading: "1201",
      }),
      403,
    );
    problem(
      await fuelCall(surveyor, id, {
        issuedAt: at(-1, "08:00"),
        litres: "5",
        meterReading: "1200",
      }),
      403,
    );
    ok(await surveyor.call("get", "plant"), (body) => plantListResponseSchema.parse(body));
    const tab = ok(await storekeeper.call("get", `projects/${projectId}/plant`), (body) =>
      projectPlantResponseSchema.parse(body),
    );
    expect(tab.permissions).toEqual({
      canRecordUsage: false,
      canRecordFuel: true,
      canReportBreakdown: false,
      canManage: false,
      canSeeCost: false,
    });
    // Clients, suppliers and labourers never see plant; another company's IDs are unknown.
    for (const browser of [client, supplierUser])
      for (const path of ["plant", `plant/${id}`, `projects/${projectId}/plant`])
        expect((await browser.call("get", path)).status, path).toBe(403);
    expect((await worker.call("get", "plant")).status).toBe(403);
    expect((await outsider.call("get", `plant/${id}`)).status).toBe(404);
    expect((await outsider.call("get", `projects/${projectId}/plant`)).status).toBe(404);
    expect(
      await db.run(context(outsider, otherTenant), (tx) => tx.plantItem.count({ where: { id } })),
    ).toBe(0);
    await expect(
      db.run(context(outsider, otherTenant), (tx) =>
        tx.plantSettings.create({
          data: {
            tenantId,
            certificateCategories: [],
            updatedBy: outsider.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();
    // The manager has no assignment on the other project: plant there shows as restricted.
    const elsewhere = await register(excavator("EX-06", { siteId: otherSite }), owner);
    const restricted = await reload(elsewhere.item.id);
    expect(restricted.item).toMatchObject({ location: null, locationRestricted: true });
    expect(restricted.permissions.canMove).toBe(false);
    problem(
      await manager.call("post", `plant/${id}/moves`, {
        version: item.item.version,
        siteId: otherSite,
        movedOn: today,
      }),
      403,
    );
  });

  it("moves plant between sites, stops unsafe plant working, tracks services, operators and hire, and closes it", async () => {
    const created = await register(
      excavator("EX-07", { hireStartOn: day(-6), openingOn: day(-6), hireEndOn: day(3) }),
    );
    const id = created.item.id;
    // Never worked since the hire began six days ago, ending in three days.
    expect(created.item.alerts.map((alert) => alert.kind)).toEqual(
      expect.arrayContaining(["idle_on_hire", "hire_ending"]),
    );
    problem(
      await usageCall(agent, id, {
        siteId: yardSite,
        usedOn: day(-1),
        dayStatus: "working",
        startReading: "1200",
        endReading: "1205",
      }),
      409,
      "plant-not-on-site",
    );
    await usage(agent, id, {
      usedOn: day(-1),
      dayStatus: "working",
      startReading: "1200",
      endReading: "1205",
    });
    expect((await reload(id)).item.alerts.map((alert) => alert.kind)).not.toContain("idle_on_hire");
    // Move to Block B three days ago: refused, as it would strand yesterday's log on the Main plot.
    let current = await reload(id);
    problem(
      await manager.call("post", `plant/${id}/moves`, {
        version: current.item.version,
        siteId: yardSite,
        movedOn: day(-3),
      }),
      409,
      "move-strands-records",
    );
    current = detail(
      await manager.call("post", `plant/${id}/moves`, {
        version: current.item.version,
        siteId: yardSite,
        movedOn: today,
        reason: "Trenching for the drainage line",
      }),
    );
    expect(current.item.location).toMatchObject({ siteId: yardSite, siteName: "Block B" });
    expect(current.moves.map((move) => move.seq)).toEqual([2, 1]);
    problem(
      await manager.call("post", `plant/${id}/moves`, {
        version: current.item.version,
        siteId: mainSite,
        movedOn: day(-2),
      }),
      409,
      "invalid-transition",
    );

    // An unsafe breakdown: under repair, no working day, only plant.manage records the repair.
    current = detail(
      await agent.call("post", `plant/${id}/breakdowns`, {
        siteId: yardSite,
        reportedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        severity: "unsafe",
        description: "Hydraulic hose burst on the boom",
      }),
      201,
    );
    expect(current.item.status).toBe("under_repair");
    expect(current.item.alerts[0]).toEqual({ kind: "unsafe_breakdown", severity: "critical" });
    const breakdown = current.breakdowns[0]!;
    expect(breakdown).toMatchObject({ code: expect.stringMatching(/^BRK-\d{4}$/), status: "open" });
    problem(
      await usageCall(agent, id, {
        siteId: yardSite,
        usedOn: today,
        dayStatus: "working",
        startReading: "1205",
        endReading: "1207",
      }),
      409,
      "plant-unsafe",
    );
    await expect(
      db.run(context(agent), (tx) =>
        tx.plantUsageLog.create({
          data: {
            id: randomUUID(),
            tenantId,
            plantId: id,
            projectId,
            siteId: yardSite,
            usedOn: new Date(`${today}T00:00:00.000Z`),
            dayStatus: "working",
            startReading: "1205",
            endReading: "1207",
            idempotencyKey: key(),
            requestDigest: "e".repeat(64),
            capturedAt: new Date(),
            recordedBy: agent.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow(/unsafe breakdown/);
    problem(
      await agent.call("post", `plant/${id}/breakdowns/${breakdown.id}/resolve`, {
        version: breakdown.version,
        resolution: "repaired",
        resolvedOn: today,
      }),
      403,
    );
    current = detail(
      await manager.call("post", `plant/${id}/breakdowns/${breakdown.id}/resolve`, {
        version: breakdown.version,
        resolution: "repaired",
        resolvedOn: today,
        repairedBy: "Mobile mechanic (synthetic)",
        costReference: "INV-SYN-001",
      }),
    );
    expect(current.item.status).toBe("on_site");

    // Service intervals: 5.0 h run of a 5.5 h interval is due (last 10 %); 4.0 h is overdue.
    current = detail(
      await manager.call("patch", `plant/${id}`, {
        version: current.item.version,
        name: current.item.name,
        category: "excavator",
        supplierId,
        hireRateMinor: 1_500_000,
        hireRateUnit: "day",
        hireStartOn: day(-6),
        hireEndOn: day(3),
        standardConsumption: "14.00",
        serviceEvery: "5.5",
      }),
    );
    expect(current.item.service).toEqual({ state: "due", remaining: "0.5", dueOn: null });
    current = detail(
      await manager.call("patch", `plant/${id}`, {
        version: current.item.version,
        name: current.item.name,
        category: "excavator",
        supplierId,
        hireRateMinor: 1_500_000,
        hireRateUnit: "day",
        hireStartOn: day(-6),
        hireEndOn: day(3),
        standardConsumption: "14.00",
        serviceEvery: "4",
      }),
    );
    expect(current.item.service.state).toBe("overdue");
    expect(current.item.alerts.map((alert) => alert.kind)).toContain("service_overdue");
    current = detail(
      await agent.call("post", `plant/${id}/services`, {
        servicedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        kind: "service",
        meterReading: "1205",
        description: "250-hour service: oil and filters",
        doneBy: "Dealer workshop (synthetic)",
      }),
      201,
    );
    expect(current.item.service).toMatchObject({ state: "ok", remaining: "4.0" });

    // An operator without a certificate where the category needs one is flagged, not blocked.
    current = detail(
      await manager.call("post", `plant/${id}/operators`, {
        projectId,
        kind: "labourer",
        labourerId: labourers[0],
        fromOn: day(-1),
      }),
      201,
    );
    expect(current.operators[0]).toMatchObject({ certificateState: "missing", active: true });
    expect(current.item.alerts).toContainEqual({
      kind: "operator_certificate",
      severity: "critical",
    });
    problem(
      await manager.call("post", `plant/${id}/operators`, {
        projectId,
        kind: "labourer",
        labourerId: labourers[0],
        fromOn: today,
      }),
      409,
      "operator-overlap",
    );
    problem(
      await usageCall(agent, id, {
        siteId: yardSite,
        usedOn: today,
        dayStatus: "idle",
        startReading: "1205",
        endReading: "1205",
        operatorLabourerId: labourers[1],
      }),
      422,
      "operator-not-assigned",
    );

    // Off hire through a breakdown that sends it back: final, back in the yard, operators ended.
    current = detail(
      await agent.call("post", `plant/${id}/breakdowns`, {
        siteId: yardSite,
        reportedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        severity: "major",
        description: "Track tensioner cracked",
      }),
      201,
    );
    const second = current.breakdowns.find((entry) => entry.status === "open")!;
    problem(
      await manager.call("post", `plant/${id}/breakdowns/${second.id}/resolve`, {
        version: second.version,
        resolution: "written_off",
        resolvedOn: today,
        note: "Not ours to write off",
      }),
      409,
      "breakdown-resolution-invalid",
    );
    current = detail(
      await manager.call("post", `plant/${id}/breakdowns/${second.id}/resolve`, {
        version: second.version,
        resolution: "off_hire",
        resolvedOn: today,
        note: "Supplier collects it; replacement ordered",
      }),
    );
    expect(current.item).toMatchObject({
      status: "off_hire",
      closedOn: today,
      location: null,
      alerts: [],
    });
    expect(current.operators.every((operator) => !operator.permissions.canEnd)).toBe(true);
    expect(current.permissions).toMatchObject({ canEdit: false, canRecordUsage: false });
    problem(
      await usageCall(agent, id, {
        siteId: yardSite,
        usedOn: today,
        dayStatus: "idle",
        startReading: "1205",
        endReading: "1205",
      }),
      409,
      "plant-closed",
    );
    await expect(
      db.run(context(manager), (tx) =>
        tx.plantItem.updateMany({
          where: { id },
          data: {
            name: "Back from the dead",
            updatedBy: manager.auth.user.id,
            version: { increment: 1 },
          },
        }),
      ),
    ).rejects.toThrow(/final/);

    // Owned plant is disposed of; scaffolding has no meter and is counted by quantity.
    const scaffold = await register({
      code: "SCF-01",
      name: "Scaffold frames (synthetic)",
      category: "scaffolding",
      ownership: "owned",
      quantity: 120,
      meterType: "none",
      fuelType: "none",
      openingOn: day(-5),
      siteId: mainSite,
    });
    await usage(foreman, scaffold.item.id, { usedOn: day(-1), dayStatus: "working" });
    problem(
      await fuelCall(agent, scaffold.item.id, { issuedAt: at(-1, "08:00"), litres: "5" }),
      409,
      "plant-no-fuel",
    );
    problem(
      await manager.call("post", `plant/${scaffold.item.id}/close`, {
        version: scaffold.item.version,
        action: "off_hire",
        closedOn: today,
        reason: "Wrong action for owned plant",
      }),
      409,
      "invalid-transition",
    );
    const disposed = detail(
      await manager.call("post", `plant/${scaffold.item.id}/close`, {
        version: scaffold.item.version,
        action: "dispose",
        closedOn: today,
        reason: "Frames corroded beyond safe use",
      }),
    );
    expect(disposed.item).toMatchObject({ status: "disposed", location: null });
    expect(disposed.moves[0]).toMatchObject({ to: null });
  });

  it("refuses every plant rule in SQL under the runtime role", async () => {
    const item = await register(excavator("EX-08"));
    const id = item.item.id;
    const base = {
      tenantId,
      plantId: id,
      projectId,
      capturedAt: new Date(),
      recordedBy: agent.auth.user.id,
    };
    const refuse = (work: Parameters<TenantDatabase["run"]>[1], pattern: RegExp, browser = agent) =>
      expect(db.run(context(browser), work)).rejects.toThrow(pattern);
    await refuse(
      (tx) =>
        tx.plantUsageLog.create({
          data: {
            ...base,
            id: randomUUID(),
            siteId: yardSite,
            usedOn: new Date(`${day(-1)}T00:00:00.000Z`),
            dayStatus: "idle",
            startReading: "1200",
            endReading: "1200",
            idempotencyKey: key(),
            requestDigest: "c".repeat(64),
          },
        }),
      /not at this site/,
    );
    await refuse(
      (tx) =>
        tx.plantUsageLog.create({
          data: {
            ...base,
            id: randomUUID(),
            siteId: mainSite,
            usedOn: new Date(`${day(-1)}T00:00:00.000Z`),
            dayStatus: "working",
            startReading: "1200",
            endReading: "1225",
            idempotencyKey: key(),
            requestDigest: "c".repeat(64),
          },
        }),
      /24 hours/,
    );
    await refuse(
      (tx) =>
        tx.plantFuelIssue.create({
          data: {
            ...base,
            id: randomUUID(),
            siteId: mainSite,
            issuedAt: new Date(at(-1, "09:00")),
            litres: "40",
            meterReading: "1201",
            tankFilled: true,
            fuelType: "diesel",
            standardConsumption: "7.00",
            source: "site_store",
            idempotencyKey: key(),
            requestDigest: "d".repeat(64),
          },
        }),
      /standard consumption in force/,
    );
    await refuse(
      (tx) =>
        tx.plantFuelIssue.create({
          data: {
            ...base,
            id: randomUUID(),
            siteId: mainSite,
            issuedAt: new Date(at(-1, "09:00")),
            litres: "40",
            meterReading: "1201",
            tankFilled: true,
            fuelType: "diesel",
            standardConsumption: "14.00",
            source: "site_store",
            receivedByUserId: randomUUID(),
            idempotencyKey: key(),
            requestDigest: "d".repeat(64),
          },
        }),
      /not a member of the company/,
    );
    await refuse(
      (tx) =>
        tx.plantMove.create({
          data: {
            id: randomUUID(),
            tenantId,
            plantId: id,
            seq: 2,
            movedOn: new Date(`${today}T00:00:00.000Z`),
            fromProjectId: projectId,
            fromSiteId: yardSite,
            toProjectId: otherProject,
            toSiteId: otherSite,
            movedBy: manager.auth.user.id,
          },
        }),
      /starts where the item is/,
      manager,
    );
    // Forging the status or the site without the matching breakdown or move.
    await refuse(
      (tx) =>
        tx.plantItem.updateMany({
          where: { id },
          data: {
            status: "under_repair",
            updatedBy: manager.auth.user.id,
            version: { increment: 1 },
          },
        }),
      /status follows/,
      manager,
    );
    await refuse(
      (tx) =>
        tx.plantItem.updateMany({
          where: { id },
          data: {
            siteId: yardSite,
            updatedBy: manager.auth.user.id,
            version: { increment: 1 },
          },
        }),
      /recorded move/,
      manager,
    );
    await refuse(
      (tx) =>
        tx.plantItem.updateMany({
          where: { id },
          data: { code: "EX-80", updatedBy: manager.auth.user.id, version: { increment: 1 } },
        }),
      /fixed/,
      manager,
    );
    await refuse((tx) => tx.plantItem.deleteMany({ where: { id } }), /permission denied/, manager);
    await refuse(
      (tx) =>
        tx.plantOperator.create({
          data: {
            id: randomUUID(),
            tenantId,
            plantId: id,
            projectId,
            kind: "labourer",
            labourerId: labourers[0]!,
            fromOn: new Date(`${day(-5)}T00:00:00.000Z`),
            assignedBy: agent.auth.user.id,
          },
        }),
      /assigned by the signed-in user|already assigned/,
      manager,
    );
    // A resolved breakdown is final; numbering is in order.
    const reported = detail(
      await agent.call("post", `plant/${id}/breakdowns`, {
        siteId: mainSite,
        reportedAt: new Date(Date.now() - 60_000).toISOString(),
        severity: "minor",
        description: "Cab light not working",
      }),
      201,
    );
    expect(reported.item.status).toBe("on_site");
    const open = reported.breakdowns[0]!;
    detail(
      await agent.call("post", `plant/${id}/breakdowns/${open.id}/resolve`, {
        version: open.version,
        resolution: "repaired",
        resolvedOn: today,
      }),
    );
    await refuse(
      (tx) =>
        tx.plantBreakdown.updateMany({
          where: { id: open.id },
          data: { description: "Rewritten after the repair", version: { increment: 1 } },
        }),
      /final/,
      manager,
    );
    await refuse(
      (tx) =>
        tx.plantBreakdown.create({
          data: {
            id: randomUUID(),
            tenantId,
            plantId: id,
            projectId,
            siteId: mainSite,
            number: 999,
            reportedAt: new Date(),
            severity: "minor",
            description: "Out of order number",
            reportedBy: agent.auth.user.id,
          },
        }),
      /numbered in order/,
    );
    await refuse(
      (tx) =>
        tx.plantSettings.create({
          data: { tenantId, certificateCategories: ["excavator"], updatedBy: manager.auth.user.id },
        }),
      /signed-in user/,
    );
    // A major breakdown inserted without putting the item under repair fails at commit.
    await refuse(
      (tx) =>
        tx.plantBreakdown.create({
          data: {
            id: randomUUID(),
            tenantId,
            plantId: id,
            projectId,
            siteId: mainSite,
            number: Number(open.code.slice(4)) + 1,
            reportedAt: new Date(),
            severity: "major",
            description: "Engine seized",
            reportedBy: agent.auth.user.id,
          },
        }),
      /status follows/,
    );
  });

  it("answers a database refusal the API did not catch first with a problem, never a 500", async () => {
    const item = await register(excavator("EX-09"));
    // A temporary probe trigger refuses two service descriptions in the database only.
    const schemaOwner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrls().migrationUrl }),
    });
    const service = (description: string) =>
      manager.call("post", `plant/${item.item.id}/services`, {
        servicedAt: new Date(Date.now() - 60_000).toISOString(),
        kind: "inspection",
        meterReading: "1200",
        description,
      });
    try {
      await schemaOwner.$executeRawUnsafe(`CREATE FUNCTION app.test_plant_refusal_probe()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.description = 'Probe check refusal' THEN
            RAISE EXCEPTION 'probe check refusal' USING ERRCODE = '23514';
          ELSIF NEW.description = 'Probe privilege refusal' THEN
            RAISE EXCEPTION 'probe privilege refusal' USING ERRCODE = '42501';
          END IF;
          RETURN NEW;
        END $$`);
      await schemaOwner.$executeRawUnsafe(
        `CREATE TRIGGER plant_services_refusal_probe BEFORE INSERT ON plant_services
           FOR EACH ROW EXECUTE FUNCTION app.test_plant_refusal_probe()`,
      );
      const check = await service("Probe check refusal");
      problem(check, 409, "plant-rule");
      expect(JSON.stringify(check.body)).not.toContain("probe check refusal");
      const privilege = await service("Probe privilege refusal");
      problem(privilege, 403, "plant-rule");
      expect(JSON.stringify(privilege.body)).not.toContain("probe privilege refusal");
    } finally {
      await schemaOwner.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS plant_services_refusal_probe ON plant_services",
      );
      await schemaOwner.$executeRawUnsafe("DROP FUNCTION IF EXISTS app.test_plant_refusal_probe()");
      await schemaOwner.$disconnect();
    }
    detail(await service("Greased the boom pins"), 201);
  });

  it("writes audit events with IDs, codes and field names only", async () => {
    const events = await db.run(context(), (tx) =>
      tx.auditEvent.findMany({
        where: { action: { startsWith: "plant." } },
        select: { action: true, metadata: true },
      }),
    );
    for (const name of [
      "plant.registered",
      "plant.updated",
      "plant.moved",
      "plant.closed",
      "plant.operator_assigned",
      "plant.usage_recorded",
      "plant.usage_corrected",
      "plant.fuel_recorded",
      "plant.fuel_voided",
      "plant.meter_reset",
      "plant.breakdown_reported",
      "plant.breakdown_resolved",
      "plant.service_recorded",
      "plant.settings_updated",
    ])
      expect(
        events.map((event) => event.action),
        name,
      ).toContain(name);
    const serialised = JSON.stringify(events);
    for (const text of [
      "Hydraulic hose burst",
      "Hour meter replaced",
      "End reading was misread",
      "Recorded against the wrong machine",
      "Supplier collects it",
      "Mwendeshaji Mitambo",
      "Mobile mechanic",
      "Trenching for the drainage line",
    ])
      expect(serialised, text).not.toContain(text);
  });
});
