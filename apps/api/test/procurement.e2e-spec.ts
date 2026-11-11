import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KENYAN_STARTER_CATALOGUE, STANDARD_UNITS } from "@pm-buddy/domain";
import { PROCUREMENT_LIMITS } from "@pm-buddy/types";
import {
  conversionResponseSchema,
  conversionResultResponseSchema,
  loadDefaultsResponseSchema,
  materialDetailResponseSchema,
  materialResponseSchema,
  materialsResponseSchema,
  priceAlertsResponseSchema,
  priceResponseSchema,
  procurementSettingsResponseSchema,
  projectResponseSchema,
  supplierDetailResponseSchema,
  supplierRevealResponseSchema,
  suppliersResponseSchema,
  unitResponseSchema,
  unitsResponseSchema,
  type Material,
  type SupplierDetailResponse,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { Browser, notifications } from "./support.js";

/**
 * D5.1 catalogue, conversions, prices and suppliers end to end under the real runtime role
 * (pmb_app, forced RLS). Expected amounts are worked out by hand in the comments, independently
 * of the code under test. Identifiers are synthetic (all-zero KRA PINs; phones next to
 * Safaricom's Daraja sandbox test MSISDN).
 */
const PIN = "P000000999Z";
const PHONE = "254708374149";
const OTHER_PHONE = "254708374150";

describe("Catalogue, conversions, prices and suppliers (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let ownerB: Browser;
  let finance: Browser;
  let financeTwo: Browser;
  let financeThree: Browser;
  let pm: Browser;
  let pmNowhere: Browser;
  let foreman: Browser;
  let tenantA: string;
  let tenantB: string;
  let notificationSpy: ReturnType<typeof vi.spyOn>;
  let materials: Material[] = [];

  const fresh = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
  const stale = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 10 * 60_000) },
    });
  const join = async (member: Browser, role: string, projectIds: string[]) => {
    await fresh(owner);
    const invited = await owner.call("post", "tenants/current/invitations", {
      identifier: member.identifier,
      role,
      projectIds,
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    const token = notifications
      .get(member.identifier)
      ?.at(-1)
      ?.text.match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
    expect((await member.call("post", "tenants/invitations/accept", { token })).status).toBe(200);
    expect((await member.call("post", `tenants/${tenantA}/select`, {})).status).toBe(200);
  };
  const problem = (res: request.Response) => (res.body as { code?: string }).code;
  const ok = (res: request.Response, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as unknown;
  };
  const materialNamed = (name: string) => {
    const found = materials.find((material) => material.name === name);
    expect(found, name).toBeDefined();
    return found!;
  };
  const allMaterials = async (browser: Browser) => {
    const found: Material[] = [];
    let cursor: string | null = null;
    do {
      const res = await browser.call(
        "get",
        `materials?limit=50${cursor ? `&cursor=${cursor}` : ""}`,
      );
      const page = materialsResponseSchema.parse(ok(res));
      found.push(...page.materials);
      cursor = page.page.nextCursor;
    } while (cursor);
    return found;
  };
  const createSupplier = async (browser: Browser, body: object) =>
    supplierDetailResponseSchema.parse(ok(await browser.call("post", "suppliers", body), 201));
  const getSupplier = async (browser: Browser, id: string) =>
    supplierDetailResponseSchema.parse(ok(await browser.call("get", `suppliers/${id}`)));
  const calculate = (browser: Browser, query: string) =>
    browser.call("get", `conversions/calculate?${query}`);
  const recordPrice = (browser: Browser, materialId: string, body: object) =>
    browser.call("post", `materials/${materialId}/prices`, body);
  const context = (browser: Browser, tenantId = tenantA) => ({
    userId: browser.auth.user.id,
    tenantId,
    requestId: "d51-direct",
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
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
    ownerB = new Browser(app);
    finance = new Browser(app);
    financeTwo = new Browser(app);
    financeThree = new Browser(app);
    pm = new Browser(app);
    pmNowhere = new Browser(app);
    foreman = new Browser(app);
    for (const browser of [owner, ownerB, finance, financeTwo, financeThree]) {
      await browser.register();
      await browser.enroll();
    }
    for (const browser of [pm, pmNowhere, foreman]) await browser.register();
    const a = await owner.call("post", "tenants", { name: "Procurement company A" });
    const b = await ownerB.call("post", "tenants", { name: "Procurement company B" });
    expect([a.status, b.status]).toEqual([201, 201]);
    tenantA = (a.body as { tenant: { id: string } }).tenant.id;
    tenantB = (b.body as { tenant: { id: string } }).tenant.id;
    await fresh(owner);
    const project = projectResponseSchema.parse(
      ok(await owner.call("post", "projects", { name: "Procurement project (synthetic)" }), 201),
    ).project;
    await join(finance, "finance", []);
    await join(financeTwo, "finance", []);
    await join(financeThree, "finance", []);
    await join(pm, "project_manager", [project.id]);
    await join(pmNowhere, "project_manager", []);
    await join(foreman, "foreman", [project.id]);
  }, 180_000);

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("documents every D5.1 operation in OpenAPI", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "listMaterials",
      "createMaterial",
      "loadMaterialDefaults",
      "getMaterial",
      "updateMaterial",
      "createConversion",
      "endConversion",
      "recordPrice",
      "correctPrice",
      "listPriceAlerts",
      "calculateConversion",
      "listUnits",
      "createUnit",
      "updateUnit",
      "getProcurementSettings",
      "updateProcurementSettings",
      "listSuppliers",
      "createSupplier",
      "getSupplier",
      "updateSupplier",
      "revealSupplierValue",
      "proposePayoutDetails",
      "verifyPayoutDetails",
      "rejectPayoutDetails",
    ])
      expect(operations, id).toContain(id);
  });

  it("keeps the database's standard units in step with packages/domain", async () => {
    for (const unit of STANDARD_UNITS) {
      const [row] = await prisma.$queryRaw<{ dimension: string | null }[]>`
        SELECT app.standard_unit_dimension(${unit.code}) AS dimension`;
      expect(row!.dimension, unit.code).toBe(unit.dimension);
    }
    const [unknown] = await prisma.$queryRaw<{ dimension: string | null }[]>`
      SELECT app.standard_unit_dimension('furlong') AS dimension`;
    expect(unknown!.dimension).toBeNull();
  });

  it("loads the Kenyan starter catalogue idempotently and lists it with search, filters and pages", async () => {
    const first = loadDefaultsResponseSchema.parse(
      ok(await owner.call("post", "materials/defaults")),
    );
    const withFactors = KENYAN_STARTER_CATALOGUE.filter((entry) => entry.conversions.length);
    expect(first).toEqual({
      created: KENYAN_STARTER_CATALOGUE.length,
      existing: 0,
      conversions: withFactors.reduce((total, entry) => total + entry.conversions.length, 0),
    });
    const again = loadDefaultsResponseSchema.parse(
      ok(await owner.call("post", "materials/defaults")),
    );
    expect(again).toEqual({
      created: 0,
      existing: KENYAN_STARTER_CATALOGUE.length,
      conversions: 0,
    });

    const page = materialsResponseSchema.parse(ok(await owner.call("get", "materials?limit=5")));
    expect(page.materials.map((material) => material.code)).toEqual([
      "MAT-0001",
      "MAT-0002",
      "MAT-0003",
      "MAT-0004",
      "MAT-0005",
    ]);
    expect(page.page.hasMore).toBe(true);
    expect(page.permissions.canManage).toBe(true);
    materials = await allMaterials(owner);
    expect(materials).toHaveLength(KENYAN_STARTER_CATALOGUE.length);
    expect(new Set(materials.map((material) => material.id)).size).toBe(materials.length);

    const steel = materialsResponseSchema.parse(
      ok(await owner.call("get", "materials?category=steel")),
    );
    expect(steel.materials).toHaveLength(7);
    const y12 = materialsResponseSchema.parse(ok(await owner.call("get", "materials?search=y12")));
    expect(y12.materials.map((material) => material.attributes)).toEqual([
      { diameterMm: 12, pieceLengthM: "12" },
    ]);
    const swahili = materialsResponseSchema.parse(
      ok(await owner.call("get", "materials?search=saruji")),
    );
    expect(swahili.materials).toHaveLength(2);

    // The detail shows the standard factors from the attributes (d²/162 kg/m, 12 m bars).
    const detail = materialDetailResponseSchema.parse(
      ok(await owner.call("get", `materials/${y12.materials[0]!.id}`)),
    );
    expect(detail.standardConversions).toEqual([
      { from: "m", to: "kg", factor: "0.888888888889", ratio: "8/9", rule: "steel_mass_per_metre" },
      { from: "nr", to: "m", factor: "12", ratio: "12/1", rule: "piece_length" },
    ]);
    expect(detail.priceChangeAlertPercent).toBe("10");
  });

  it("adds materials and company units, refusing unknown or archived units, wrong attributes and duplicates", async () => {
    const unknownUnit = await owner.call("post", "materials", {
      name: "Murram",
      category: "aggregates",
      baseUnit: "furlong",
    });
    expect([unknownUnit.status, problem(unknownUnit)]).toEqual([422, "unit-unknown"]);
    const wrongAttribute = await owner.call("post", "materials", {
      name: "Murram",
      category: "aggregates",
      baseUnit: "t",
      attributes: { diameterMm: 12 },
    });
    expect(wrongAttribute.status).toBe(400);
    const duplicate = await owner.call("post", "materials", {
      name: "river SAND",
      category: "aggregates",
      baseUnit: "t",
    });
    expect([duplicate.status, problem(duplicate)]).toEqual([409, "material-name-taken"]);

    const standardCode = await owner.call("post", "units", {
      code: "kg",
      name: "Kilogram again",
      dimension: "mass",
      equalsQuantity: "1",
      equalsUnit: "kg",
    });
    expect(standardCode.status).toBe(409);
    const debe = unitResponseSchema.parse(
      ok(
        await owner.call("post", "units", {
          code: "debe",
          name: "Debe (20 l tin)",
          nameSw: "Debe (lita 20)",
          dimension: "volume",
          equalsQuantity: "20",
          equalsUnit: "l",
        }),
        201,
      ),
    ).unit;
    expect(debe).toMatchObject({
      code: "debe",
      sizeInBase: "0.02",
      baseUnit: "m3",
      standard: false,
    });
    const murram = materialResponseSchema.parse(
      ok(
        await owner.call("post", "materials", {
          name: "Murram (sold by the debe)",
          category: "aggregates",
          baseUnit: "debe",
        }),
        201,
      ),
    ).material;
    expect(murram.code).toBe(`MAT-${String(KENYAN_STARTER_CATALOGUE.length + 1).padStart(4, "0")}`);
    // 50 debes = 1 m³ exactly
    const converted = conversionResultResponseSchema.parse(
      ok(await calculate(owner, `from=debe&to=m3&quantity=50`)),
    );
    expect(converted.result).toMatchObject({ quantity: "1", exact: true });

    const archived = unitResponseSchema.parse(
      ok(await owner.call("patch", `units/${debe.id}`, { version: 1, status: "archived" })),
    ).unit;
    expect(archived.status).toBe("archived");
    const useArchived = await owner.call("post", "materials", {
      name: "Hardcore (debe)",
      category: "aggregates",
      baseUnit: "debe",
    });
    expect([useArchived.status, problem(useArchived)]).toEqual([409, "unit-archived"]);
    // A unit's definition never changes, even through direct SQL.
    await expect(
      db.run(
        context(owner),
        (tx) => tx.$executeRaw`UPDATE units SET equals_quantity = 25 WHERE id = ${debe.id}::uuid`,
      ),
    ).rejects.toThrow(/definition never changes/);

    const stale = await owner.call("patch", `materials/${murram.id}`, {
      version: 9,
      name: "X murram",
    });
    expect([stale.status, problem(stale)]).toEqual([409, "version-conflict"]);
    const renamed = materialResponseSchema.parse(
      ok(
        await owner.call("patch", `materials/${murram.id}`, {
          version: 1,
          nameSw: "Murram (debe)",
        }),
      ),
    ).material;
    expect(renamed).toMatchObject({ version: 2, nameSw: "Murram (debe)" });
    materials = await allMaterials(owner);
  });

  it("converts quantities exactly through the API and refuses what it cannot convert", async () => {
    const y12 = materialNamed("Steel bar Y12 (high yield, 12 m)");
    const sand = materialNamed("River sand");
    const result = async (query: string) =>
      conversionResultResponseSchema.parse(ok(await calculate(pm, query))).result;
    expect(await result("from=t&to=kg&quantity=2.5")).toMatchObject({
      quantity: "2500",
      exact: true,
    });
    // One 12 m Y12 bar = 12 × 144/162 = 10.6666… kg
    const bar = await result(`materialId=${y12.id}&from=nr&to=kg&quantity=1`);
    expect(bar).toMatchObject({ quantity: "10.666667", exact: false, ratio: "32/3" });
    expect(bar.steps.map((step) => step.rule)).toEqual(["piece_length", "steel_mass_per_metre"]);
    // Starter density: 1 m³ = 1.6 t (an assumption, labelled on the factor)
    expect(await result(`materialId=${sand.id}&from=m3&to=t&quantity=3`)).toMatchObject({
      quantity: "4.8",
    });
    const refused = async (query: string) => {
      const res = await calculate(pm, query);
      return [res.status, problem(res)];
    };
    expect(await refused(`materialId=${sand.id}&from=trip&to=t&quantity=1`)).toEqual([
      422,
      "no-conversion",
    ]);
    expect(await refused("from=kg&to=m&quantity=1")).toEqual([422, "no-conversion"]);
    expect(await refused("from=t&to=kg&quantity=-1")).toEqual([422, "negative-quantity"]);
    expect(await refused("from=t&to=kg&quantity=1e3")).toEqual([422, "invalid-quantity"]);
    expect(await refused("from=t&to=kg&quantity=1000000000001")).toEqual([
      422,
      "quantity-too-large",
    ]);
    expect(await refused("from=t&to=furlong&quantity=1")).toEqual([422, "unit-unknown"]);
  });

  it("keeps factors effective-dated: a new factor ends the old one, overlaps are refused (API and database)", async () => {
    const ballast = materialNamed("Ballast 20 mm");
    const base = `materials/${ballast.id}/conversions`;
    const standard = await owner.call("post", base, {
      fromUnit: "t",
      fromQuantity: "1",
      toUnit: "kg",
      toQuantity: "990",
    });
    expect([standard.status, problem(standard)]).toEqual([409, "standard-conversion-exists"]);
    const same = await owner.call("post", base, {
      fromUnit: "trip",
      fromQuantity: "1",
      toUnit: "trip",
      toQuantity: "2",
    });
    expect([same.status, problem(same)]).toEqual([400, "same-unit"]);

    const first = conversionResponseSchema.parse(
      ok(
        await owner.call("post", base, {
          fromUnit: "trip",
          fromQuantity: "1",
          toUnit: "t",
          toQuantity: "7",
          effectiveFrom: "2026-01-01",
          note: "7-tonne lorry (test)",
        }),
        201,
      ),
    ).conversion;
    expect(first).toMatchObject({ factor: "7", ratio: "7/1", effectiveTo: null, inForce: true });
    const second = conversionResponseSchema.parse(
      ok(
        await owner.call("post", base, {
          fromUnit: "t",
          fromQuantity: "8",
          toUnit: "trip",
          toQuantity: "1",
          effectiveFrom: "2026-06-01",
        }),
        201,
      ),
    ).conversion;
    // 8 t = 1 trip, stored as written; the exact factor is 1/8 trip per tonne.
    expect(second).toMatchObject({ fromUnit: "t", toUnit: "trip", ratio: "1/8", factor: "0.125" });
    const detail = materialDetailResponseSchema.parse(
      ok(await owner.call("get", `materials/${ballast.id}`)),
    );
    expect(detail.conversions.find((entry) => entry.id === first.id)).toMatchObject({
      effectiveTo: "2026-06-01",
      inForce: false,
      endedBy: { id: owner.auth.user.id },
    });
    const on = async (date: string) =>
      conversionResultResponseSchema.parse(
        ok(await calculate(owner, `materialId=${ballast.id}&from=trip&to=t&quantity=1&on=${date}`)),
      ).result.quantity;
    expect(await on("2026-05-31")).toBe("7");
    expect(await on("2026-06-01")).toBe("8");
    const backdated = await owner.call("post", base, {
      fromUnit: "trip",
      fromQuantity: "1",
      toUnit: "t",
      toQuantity: "9",
      effectiveFrom: "2026-03-01",
    });
    expect([backdated.status, problem(backdated)]).toEqual([409, "conversion-overlap"]);
    const endEarly = await owner.call("post", `${base}/${second.id}/end`, {
      effectiveTo: "2026-05-01",
    });
    expect([endEarly.status, problem(endEarly)]).toEqual([400, "conversion-end-invalid"]);
    const endFirst = await owner.call("post", `${base}/${first.id}/end`, {
      effectiveTo: "2026-07-01",
    });
    expect([endFirst.status, problem(endFirst)]).toEqual([409, "conversion-ended"]);

    const ended = conversionResponseSchema.parse(
      ok(await owner.call("post", `${base}/${second.id}/end`, { effectiveTo: "2027-01-01" })),
    ).conversion;
    expect(ended).toMatchObject({ effectiveTo: "2027-01-01", endedBy: { id: owner.auth.user.id } });
    const after = await calculate(
      owner,
      `materialId=${ballast.id}&from=trip&to=t&quantity=1&on=2027-01-01`,
    );
    expect([after.status, problem(after)]).toEqual([422, "no-conversion"]);

    // The database refuses overlapping factors, same-dimension factors and edits, as pmb_app.
    const insert = (from: string, to: string, effectiveFrom: string) =>
      db.run(
        context(owner),
        (tx) =>
          tx.$executeRaw`INSERT INTO unit_conversions (id, tenant_id, material_id, from_unit,
          from_quantity, to_unit, to_quantity, pair_key, effective_from, created_by)
        VALUES (gen_random_uuid(), ${tenantA}::uuid, ${ballast.id}::uuid, ${from}, 1, ${to}, 9,
          'x', ${effectiveFrom}::date, ${owner.auth.user.id}::uuid)`,
      );
    await expect(insert("trip", "t", "2026-08-01")).rejects.toThrow(/in force on these dates/);
    await expect(insert("t", "kg", "2026-08-01")).rejects.toThrow(/standard factor/);
    await expect(
      db.run(
        context(owner),
        (tx) =>
          tx.$executeRaw`UPDATE unit_conversions SET to_quantity = 9 WHERE id = ${second.id}::uuid`,
      ),
    ).rejects.toThrow(/never edited/);
    await expect(
      db.run(
        context(owner),
        (tx) => tx.$executeRaw`DELETE FROM unit_conversions WHERE id = ${second.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("records prices, compares them net of VAT per base unit and raises alerts above the threshold", async () => {
    const cement = materialNamed("Cement 42.5N (50 kg bag)");
    const y12 = materialNamed("Steel bar Y12 (high yield, 12 m)");
    const sand = materialNamed("River sand");
    const supplier = await createSupplier(owner, { legalName: "Prices Test Hardware Ltd" });
    const supplierId = supplier.supplier.id;
    const record = async (materialId: string, body: object) =>
      priceResponseSchema.parse(
        ok(await recordPrice(owner, materialId, { supplierId, ...body }), 201),
      ).price;
    const cementPrice = (unitPriceMinor: number, effectiveOn: string) =>
      record(cement.id, {
        unit: "bag_50kg",
        unitPriceMinor,
        vatTreatment: "inclusive",
        effectiveOn,
      });

    // KES 780 incl. VAT → net 78,000 × 100/116 = 67,241.38 → 67,241 (stored to the cent); the
    // comparison uses the exact net, rounded once to six places: 67,241.37931
    const p1 = await cementPrice(78_000, "2026-09-01");
    expect(p1).toMatchObject({
      netUnitPriceMinor: 67_241,
      grossUnitPriceMinor: 78_000,
      vatRatePercent: "16",
      comparable: { unit: "bag_50kg", unitPriceMinor: "67241.37931" },
      alertState: "first_price",
      change: null,
      source: "manual",
    });
    // KES 800 → net 68,966 (exact 68,965.517241); the change is 800 / 780 − 1 = 2.5641 %, not
    // the 2.5654 % that the cent-rounded nets would give
    const p2 = await cementPrice(80_000, "2026-10-15");
    expect(p2).toMatchObject({
      netUnitPriceMinor: 68_966,
      alertState: "within_threshold",
      change: { previousPriceId: p1.id, percent: "2.5641" },
    });
    // KES 900 → net 77,586; 900 / 800 − 1 = 12.5 % > 10 % (cent-rounded nets: 12.4989 %)
    const p3 = await cementPrice(90_000, "2026-11-05");
    expect(p3).toMatchObject({
      netUnitPriceMinor: 77_586,
      alertState: "above_threshold",
      alertThresholdPercent: "10",
      change: { previousPriceId: p2.id, percent: "12.5" },
    });
    const alerts = priceAlertsResponseSchema.parse(ok(await pm.call("get", "price-alerts")));
    expect(alerts.alerts.map((alert) => alert.id)).toEqual([p3.id]);
    expect(
      materialsResponseSchema.parse(ok(await owner.call("get", "materials?search=42.5N")))
        .materials[0],
    ).toMatchObject({ alertCount: 1, latestPrice: { id: p3.id, alertState: "above_threshold" } });

    // A correction is a new row; the corrected price no longer counts. KES 820 → 820 / 800 − 1 =
    // 2.5 %
    const corrected = priceResponseSchema.parse(
      ok(
        await owner.call("post", `materials/${cement.id}/prices/${p3.id}/corrections`, {
          supplierId,
          unit: "bag_50kg",
          unitPriceMinor: 82_000,
          vatTreatment: "inclusive",
          effectiveOn: "2026-11-05",
          reason: "Typed 900 instead of 820",
        }),
        201,
      ),
    ).price;
    expect(corrected).toMatchObject({
      correctsPriceId: p3.id,
      alertState: "within_threshold",
      change: { previousPriceId: p2.id, percent: "2.5" },
    });
    const twice = await owner.call("post", `materials/${cement.id}/prices/${p3.id}/corrections`, {
      supplierId,
      unit: "bag_50kg",
      unitPriceMinor: 81_000,
      vatTreatment: "inclusive",
      effectiveOn: "2026-11-05",
      reason: "Again",
    });
    expect([twice.status, problem(twice)]).toEqual([409, "price-already-corrected"]);
    expect(
      priceAlertsResponseSchema.parse(ok(await pm.call("get", "price-alerts"))).alerts,
    ).toEqual([]);
    const history = materialDetailResponseSchema.parse(
      ok(await owner.call("get", `materials/${cement.id}`)),
    );
    expect(history.prices.find((price) => price.id === p3.id)?.correctedById).toBe(corrected.id);

    // Steel by the tonne (VAT-exclusive) and by the bar compare per kg: KES 100,000/t = 10,000
    // minor per kg; KES 1,100 per bar = 110,000 × 3/32 = 10,312.5 per kg (+3.125 %).
    const tonne = await record(y12.id, {
      unit: "t",
      unitPriceMinor: 10_000_000,
      vatTreatment: "exclusive",
      effectiveOn: "2026-10-01",
    });
    expect(tonne).toMatchObject({
      grossUnitPriceMinor: 11_600_000,
      comparable: { unit: "kg", unitPriceMinor: "10000" },
    });
    const perBar = await record(y12.id, {
      unit: "nr",
      unitPriceMinor: 110_000,
      vatTreatment: "exclusive",
      effectiveOn: "2026-10-20",
    });
    expect(perBar).toMatchObject({
      comparable: { unitPriceMinor: "10312.5" },
      change: { percent: "3.125" },
      alertState: "within_threshold",
    });
    expect(perBar.comparable?.steps.map((step) => step.rule)).toEqual([
      "steel_mass_per_metre",
      "piece_length",
    ]);

    // The company lowers its threshold to 2 % (config.manage); KES 1,070 per bar = 10,031.25
    // per kg, −2.7273 % → alert. The project manager may not change the threshold.
    const pmSettings = await pm.call("put", "procurement/settings", {
      priceChangeAlertPercent: "2",
      version: 0,
    });
    expect(pmSettings.status).toBe(403);
    const settings = procurementSettingsResponseSchema.parse(
      ok(
        await owner.call("put", "procurement/settings", {
          priceChangeAlertPercent: "2",
          version: 0,
        }),
      ),
    ).settings;
    expect(settings).toMatchObject({ priceChangeAlertPercent: "2", version: 1 });
    const cheaper = await record(y12.id, {
      unit: "nr",
      unitPriceMinor: 107_000,
      vatTreatment: "exclusive",
      effectiveOn: "2026-11-01",
    });
    expect(cheaper).toMatchObject({
      comparable: { unitPriceMinor: "10031.25" },
      change: { percent: "-2.7273" },
      alertState: "above_threshold",
      alertThresholdPercent: "2",
    });
    ok(
      await owner.call("put", "procurement/settings", {
        priceChangeAlertPercent: "10",
        version: 1,
      }),
    );

    // A trip price without the supplier's trip factor cannot be compared.
    const trip = await record(sand.id, {
      unit: "trip",
      unitPriceMinor: 2_800_000,
      vatTreatment: "not_applicable",
      effectiveOn: "2026-10-01",
    });
    expect(trip).toMatchObject({
      comparable: null,
      alertState: "not_comparable",
      vatRatePercent: null,
    });

    // The base unit is fixed once a material has prices.
    const rebased = await owner.call("patch", `materials/${cement.id}`, {
      version: cement.version,
      baseUnit: "kg",
    });
    expect([rebased.status, problem(rebased)]).toEqual([409, "base-unit-fixed"]);

    // Prices are append-only and VAT amounts are re-checked by the database.
    await expect(
      db.run(
        context(owner),
        (tx) =>
          tx.$executeRaw`UPDATE material_prices SET unit_price_minor = 1 WHERE id = ${p1.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.run(
        context(owner),
        (tx) => tx.$executeRaw`DELETE FROM material_prices WHERE id = ${p1.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.run(
        context(owner),
        (tx) =>
          tx.$executeRaw`INSERT INTO material_prices (id, tenant_id, material_id, supplier_id, unit,
          unit_price_minor, vat_treatment, vat_rate_percent, net_unit_price_minor,
          gross_unit_price_minor, effective_on, source, alert_state, alert_threshold_percent,
          recorded_by)
        VALUES (gen_random_uuid(), ${tenantA}::uuid, ${cement.id}::uuid, ${supplierId}::uuid,
          'bag_50kg', 78000, 'inclusive', 16, 78000, 78000, '2026-11-10', 'manual',
          'not_comparable', 10, ${owner.auth.user.id}::uuid)`,
      ),
    ).rejects.toThrow(/material_prices_amount_check/);
  });

  it("stores KRA PINs and phones encrypted, unique per company by blind index, masked unless revealed", async () => {
    const created = await createSupplier(owner, {
      legalName: "Encrypted Identifiers Ltd",
      tradingName: "Encrypted Hardware",
      kraPin: "p000 000 999z",
      etimsStatus: "registered",
      creditDays: 30,
      creditLimitMinor: 50_000_000,
      contacts: [{ name: "Wanjiku Test", role: "Sales", phone: "0708 374 149", primary: true }],
    });
    const supplierId = created.supplier.id;
    expect(created.supplier).toMatchObject({
      code: expect.stringMatching(/^SUP-\d{4}$/),
      kraPinMasked: "P•••••••99Z",
      etimsStatus: "registered",
      primaryContact: { name: "Wanjiku Test", phoneMasked: "2547•••••149" },
      payout: { status: "none", usableForPayment: false },
    });
    expect(JSON.stringify(created)).not.toContain(PIN);
    expect(JSON.stringify(created)).not.toContain(PHONE);
    const stored = await db.run(context(owner), (tx) =>
      tx.supplier.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: tenantA, id: supplierId } },
      }),
    );
    expect(Buffer.from(stored.kraPinEnc!).includes(Buffer.from(PIN))).toBe(false);
    expect(stored.kraPinBidx).toMatch(/^[0-9a-f]{64}$/);
    const contact = await db.run(context(owner), (tx) =>
      tx.supplierContact.findFirstOrThrow({ where: { tenantId: tenantA, supplierId } }),
    );
    expect(Buffer.from(contact.phoneEnc!).includes(Buffer.from(PHONE))).toBe(false);
    expect(contact.phoneChangedBy).toBe(owner.auth.user.id);

    // Unique per company through the blind index (any spelling), not across companies.
    const duplicate = await owner.call("post", "suppliers", {
      legalName: "Copycat Ltd",
      kraPin: "P000000999Z",
    });
    expect([duplicate.status, problem(duplicate)]).toEqual([409, "kra-pin-taken"]);
    const other = await createSupplier(owner, {
      legalName: "Another PIN Ltd",
      kraPin: "A000000998Z",
    });
    const clash = await owner.call("patch", `suppliers/${other.supplier.id}`, {
      version: other.supplier.version,
      kraPin: PIN,
    });
    expect([clash.status, problem(clash)]).toEqual([409, "kra-pin-taken"]);
    await fresh(ownerB);
    expect(
      (await ownerB.call("post", "suppliers", { legalName: "B Hardware", kraPin: PIN })).status,
    ).toBe(201);

    // Reveal: KRA PIN and phone for managers and finance; nobody else. Audited without values.
    const reveal = async (browser: Browser, body: object) =>
      browser.call("post", `suppliers/${supplierId}/reveal`, body);
    expect(
      supplierRevealResponseSchema.parse(ok(await reveal(owner, { field: "kraPin" }))),
    ).toEqual({
      field: "kraPin",
      value: PIN,
    });
    expect(
      supplierRevealResponseSchema.parse(
        ok(await reveal(finance, { field: "contactPhone", contactId: contact.id })),
      ).value,
    ).toBe(PHONE);
    expect((await reveal(pm, { field: "kraPin" })).status).toBe(403);
    expect((await reveal(foreman, { field: "kraPin" })).status).toBe(403);
    const noPin = await owner.call(
      "post",
      `suppliers/${(await createSupplier(owner, { legalName: "No PIN Ltd" })).supplier.id}/reveal`,
      {
        field: "kraPin",
      },
    );
    expect([noPin.status, problem(noPin)]).toEqual([409, "nothing-to-reveal"]);

    // Exact-match lookups by KRA PIN or phone (blind index), for revealers only.
    const byPin = suppliersResponseSchema.parse(
      ok(await owner.call("get", `suppliers?kraPin=p000000999z`)),
    );
    expect(byPin.suppliers.map((supplier) => supplier.id)).toEqual([supplierId]);
    const byPhone = suppliersResponseSchema.parse(
      ok(await finance.call("get", "suppliers?phone=0708374149")),
    );
    expect(byPhone.suppliers.map((supplier) => supplier.id)).toEqual([supplierId]);
    expect((await pm.call("get", "suppliers?kraPin=P000000999Z")).status).toBe(403);
    const masked = suppliersResponseSchema.parse(
      ok(await pm.call("get", "suppliers?search=Encrypted")),
    );
    expect(masked.suppliers[0]).toMatchObject({
      kraPinMasked: "P•••••••99Z",
      primaryContact: { phoneMasked: "2547•••••149" },
    });

    // A contact's phone is replaced only when sent (the client only ever sees it masked).
    const view = await getSupplier(owner, supplierId);
    const replaced = supplierDetailResponseSchema.parse(
      ok(
        await owner.call("patch", `suppliers/${supplierId}`, {
          version: view.supplier.version,
          contacts: [{ id: contact.id, name: "Wanjiku Test", phone: OTHER_PHONE, primary: true }],
        }),
      ),
    );
    expect(replaced.contacts[0]).toMatchObject({ id: contact.id, phoneMasked: "2547•••••150" });
    const kept = supplierDetailResponseSchema.parse(
      ok(
        await owner.call("patch", `suppliers/${supplierId}`, {
          version: replaced.supplier.version,
          contacts: [{ id: contact.id, name: "Wanjiku W. Test", primary: true }],
        }),
      ),
    );
    expect(kept.contacts[0]).toMatchObject({
      name: "Wanjiku W. Test",
      phoneMasked: "2547•••••150",
    });
    // A status reason shorter than the database allows (three characters) is a 400, not a 500.
    for (const body of [
      { status: "blocked", statusReason: "ab" },
      { status: "on_hold", statusReason: "🧱🧱" },
    ]) {
      const short = await owner.call("patch", `suppliers/${supplierId}`, {
        version: kept.supplier.version,
        ...body,
      });
      expect(short.status, JSON.stringify(body)).toBe(400);
    }
    expect(
      supplierRevealResponseSchema.parse(
        ok(await reveal(owner, { field: "contactPhone", contactId: contact.id })),
      ).value,
    ).toBe(OTHER_PHONE);
    const changes = await db.run(context(owner), (tx) =>
      tx.supplierPhoneChange.findMany({
        where: { tenantId: tenantA, supplierId },
        orderBy: { changedAt: "asc" },
      }),
    );
    expect(changes.map((change) => [change.action, change.changedBy])).toEqual([
      ["set", owner.auth.user.id],
      ["set", owner.auth.user.id],
    ]);

    // A ciphertext is bound to its row: copied to another supplier it does not open.
    await db.run(
      context(owner),
      (tx) =>
        tx.$executeRaw`UPDATE suppliers SET kra_pin_enc = (SELECT kra_pin_enc FROM suppliers
        WHERE id = ${supplierId}::uuid), kra_pin_bidx = ${"0".repeat(64)}, kra_pin_masked = 'P•••••••00Z'
        WHERE id = ${other.supplier.id}::uuid`,
    );
    const moved = await owner.call("post", `suppliers/${other.supplier.id}/reveal`, {
      field: "kraPin",
    });
    expect([moved.status, problem(moved)]).toEqual([409, "sensitive-value-unreadable"]);

    // Reveals are rate-limited per user: 20 per 10 minutes.
    for (let index = 0; index < 20; index += 1)
      expect((await reveal(financeThree, { field: "kraPin" })).status).toBe(200);
    expect((await reveal(financeThree, { field: "kraPin" })).status).toBe(429);
  });

  it("requires an independent verification of payout details (maker-checker in the API and the database)", async () => {
    let detail: SupplierDetailResponse = await createSupplier(owner, {
      legalName: "Payout Details Ltd",
      contacts: [{ name: "Juma Test", phone: PHONE, primary: true }],
    });
    const supplierId = detail.supplier.id;
    const base = `suppliers/${supplierId}/payout-details`;
    const paybill = { mpesaKind: "paybill", paybillNumber: "600000", accountReference: "JENGA-01" };

    await stale(owner);
    const noStepUp = await owner.call("post", base, { replaces: null, ...paybill });
    expect([noStepUp.status, problem(noStepUp)]).toEqual([403, "step-up-required"]);
    expect((await pm.call("post", base, { replaces: null, ...paybill })).status).toBe(403);
    await fresh(owner);
    detail = supplierDetailResponseSchema.parse(
      ok(await owner.call("post", base, { replaces: null, ...paybill }), 201),
    );
    const v1 = detail.payout.current!;
    expect(v1).toMatchObject({
      versionNo: 1,
      status: "pending",
      usableForPayment: false,
      contactChangeWarning: true,
      canDecide: false,
      contributors: [{ id: owner.auth.user.id }],
    });
    expect(detail.supplier.payout).toEqual({
      status: "pending",
      usableForPayment: false,
      mpesaKind: "paybill",
      hasBank: false,
    });

    // The proposer cannot verify (owner holds payments.approve); nor can someone without it.
    await fresh(owner);
    const self = await owner.call("post", `${base}/${v1.id}/verify`, {
      method: "other",
      note: "Self check",
    });
    expect([self.status, problem(self)]).toEqual([403, "maker-checker"]);
    expect(
      (await pm.call("post", `${base}/${v1.id}/verify`, { method: "other", note: "PM check" }))
        .status,
    ).toBe(403);
    await stale(finance);
    const financeStale = await finance.call("post", `${base}/${v1.id}/verify`, {
      method: "call_back_known_number",
      note: "Called",
    });
    expect([financeStale.status, problem(financeStale)]).toEqual([403, "step-up-required"]);
    expect((await getSupplier(finance, supplierId)).payout.current?.canDecide).toBe(true);
    await fresh(finance);
    detail = supplierDetailResponseSchema.parse(
      ok(
        await finance.call("post", `${base}/${v1.id}/verify`, {
          method: "call_back_known_number",
          note: "Called the number on file; confirmed Paybill 600000",
        }),
      ),
    );
    expect(detail.payout.current).toMatchObject({
      status: "verified",
      usableForPayment: true,
      verifiedBy: { id: finance.auth.user.id },
      verificationMethod: "call_back_known_number",
    });
    expect(detail.supplier.payout.usableForPayment).toBe(true);

    // A verification is never edited; versions are never deleted (runtime role).
    await expect(
      db.run(
        context(finance),
        (tx) =>
          tx.$executeRaw`UPDATE supplier_payout_versions SET paybill_number = '600001' WHERE id = ${v1.id}::uuid`,
      ),
    ).rejects.toThrow(/never change/);
    await expect(
      db.run(
        context(finance),
        (tx) => tx.$executeRaw`DELETE FROM supplier_payout_versions WHERE id = ${v1.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);

    // A stale proposal is refused; a new one supersedes the verified details at once.
    await fresh(owner);
    const staleProposal = await owner.call("post", base, { replaces: null, ...paybill });
    expect([staleProposal.status, problem(staleProposal)]).toEqual([409, "payout-stale"]);
    const bank = {
      mpesaKind: "none",
      bank: {
        bankName: "Test Bank",
        branch: "Ruiru",
        accountName: "Payout Details Ltd",
        accountNumber: "0000 0000 0123",
      },
    };
    detail = supplierDetailResponseSchema.parse(
      ok(await owner.call("post", base, { replaces: v1.id, ...bank }), 201),
    );
    const v2 = detail.payout.current!;
    expect(v2).toMatchObject({
      versionNo: 2,
      status: "pending",
      usableForPayment: false,
      bank: { accountNumberMasked: "••••0123" },
    });
    expect(detail.payout.history[0]).toMatchObject({
      id: v1.id,
      status: "superseded",
      usableForPayment: false,
    });
    expect(detail.supplier.payout.usableForPayment).toBe(false);
    expect(JSON.stringify(detail)).not.toContain("000000000123");

    // The database refuses self-verification and decisions recorded for someone else.
    await expect(
      db.run(
        context(owner),
        (tx) =>
          tx.$executeRaw`UPDATE supplier_payout_versions SET status = 'verified',
          verified_by = ${owner.auth.user.id}::uuid, verified_at = now(),
          verification_method = 'other', verification_note = 'Self-verified' WHERE id = ${v2.id}::uuid`,
      ),
    ).rejects.toThrow(/supplier_payout_versions_state_check/);
    await expect(
      db.run(
        context(finance),
        (tx) =>
          tx.$executeRaw`UPDATE supplier_payout_versions SET status = 'verified',
          verified_by = ${financeTwo.auth.user.id}::uuid, verified_at = now(),
          verification_method = 'other', verification_note = 'For a colleague' WHERE id = ${v2.id}::uuid`,
      ),
    ).rejects.toThrow(/decided by the signed-in user/);

    // Changing the "known number" while a proposal is pending makes that person a contributor.
    const contactId = detail.contacts[0]!.id;
    await fresh(owner);
    ok(
      await owner.call("patch", `suppliers/${supplierId}`, {
        version: detail.supplier.version,
        contacts: [{ id: contactId, name: "Juma Test", primary: true }],
      }),
    );
    expect((await getSupplier(owner, supplierId)).payout.current?.contributors).toHaveLength(1);
    // A phone change written by another person (here directly as the runtime role) makes the
    // writer a contributor and flags the proposal, so they can no longer verify it.
    await db.run(
      context(finance),
      (tx) =>
        tx.$executeRaw`UPDATE supplier_contacts SET phone_enc = NULL, phone_bidx = NULL,
        phone_masked = NULL WHERE id = ${contactId}::uuid`,
    );
    const flagged = (await getSupplier(finance, supplierId)).payout.current!;
    expect(flagged.contributors.map((person) => person.id)).toEqual([
      owner.auth.user.id,
      finance.auth.user.id,
    ]);
    expect(flagged).toMatchObject({ contactChangeWarning: true, canDecide: false });
    await fresh(finance);
    const contributor = await finance.call("post", `${base}/${v2.id}/verify`, {
      method: "other",
      note: "Checked",
    });
    expect([contributor.status, problem(contributor)]).toEqual([403, "maker-checker"]);
    await fresh(financeTwo);
    const verified = supplierDetailResponseSchema.parse(
      ok(
        await financeTwo.call("post", `${base}/${v2.id}/verify`, {
          method: "bank_confirmation_letter",
          note: "Bank letter dated 10/11/2026 seen",
        }),
      ),
    );
    expect(verified.payout.current).toMatchObject({ status: "verified", usableForPayment: true });

    // Bank account numbers are revealed only to company-wide finance.view_sensitive holders.
    expect(
      supplierRevealResponseSchema.parse(
        ok(
          await financeTwo.call("post", `suppliers/${supplierId}/reveal`, {
            field: "accountNumber",
            payoutId: v2.id,
          }),
        ),
      ).value,
    ).toBe("000000000123");
    expect(
      (
        await pm.call("post", `suppliers/${supplierId}/reveal`, {
          field: "accountNumber",
          payoutId: v2.id,
        })
      ).status,
    ).toBe(403);

    // Two verifiers at once: exactly one succeeds.
    await fresh(owner);
    const v3 = supplierDetailResponseSchema.parse(
      ok(
        await owner.call("post", base, {
          replaces: v2.id,
          mpesaKind: "till",
          tillNumber: "174379",
        }),
        201,
      ),
    ).payout.current!;
    await fresh(financeTwo);
    await fresh(financeThree);
    const results = await Promise.all(
      [financeTwo, financeThree].map((browser) =>
        browser.call("post", `${base}/${v3.id}/verify`, {
          method: "in_person_documents",
          note: "Seen in person",
        }),
      ),
    );
    expect(results.map((res) => res.status).sort((left, right) => left - right)).toEqual([
      200, 409,
    ]);
    expect(results.map(problem)).toContain("payout-not-pending");

    // Rejection needs a reason and leaves no usable details.
    await fresh(owner);
    const v4 = supplierDetailResponseSchema.parse(
      ok(await owner.call("post", base, { replaces: v3.id, ...paybill }), 201),
    ).payout.current!;
    expect((await financeTwo.call("post", `${base}/${v4.id}/reject`, { reason: "" })).status).toBe(
      400,
    );
    const rejected = supplierDetailResponseSchema.parse(
      ok(
        await financeTwo.call("post", `${base}/${v4.id}/reject`, {
          reason: "Paybill belongs to another business",
        }),
      ),
    );
    expect(rejected.payout.current).toBeNull();
    expect(rejected.supplier.payout).toMatchObject({ status: "none", usableForPayment: false });
    expect(rejected.payout.history[0]).toMatchObject({
      id: v4.id,
      status: "rejected",
      rejectedBy: { id: financeTwo.auth.user.id },
    });
    const again = await financeTwo.call("post", `${base}/${v4.id}/verify`, {
      method: "other",
      note: "Late",
    });
    expect([again.status, problem(again)]).toEqual([409, "payout-not-pending"]);

    // A short account number shows only its last two characters (the database accepts that mask).
    await fresh(owner);
    const short = supplierDetailResponseSchema.parse(
      ok(
        await owner.call("post", base, {
          replaces: null,
          mpesaKind: "none",
          bank: { ...bank.bank, accountNumber: "123456" },
        }),
        201,
      ),
    ).payout.current!;
    expect(short.bank).toMatchObject({ accountNumberMasked: "••••56" });
  });

  it("refuses catalogue and supplier actions without the permission", async () => {
    // Foreman: no procurement, stores or finance permission. PM with no assignment: none in effect.
    for (const browser of [foreman, pmNowhere]) {
      expect((await browser.call("get", "materials")).status).toBe(403);
      expect((await browser.call("get", "suppliers")).status).toBe(403);
      expect(
        (await browser.call("get", "conversions/calculate?from=t&to=kg&quantity=1")).status,
      ).toBe(403);
    }
    // PM (procurement.requisition on a project): reads, but does not manage.
    expect((await pm.call("get", "materials")).status).toBe(200);
    expect((await pm.call("get", "suppliers")).status).toBe(200);
    expect((await pm.call("get", "units")).status).toBe(200);
    expect(
      (
        await pm.call("post", "materials", {
          name: "PM material",
          category: "other",
          baseUnit: "nr",
        })
      ).status,
    ).toBe(403);
    expect((await pm.call("post", "materials/defaults")).status).toBe(403);
    expect((await pm.call("post", "suppliers", { legalName: "PM supplier" })).status).toBe(403);
    expect(
      (await pm.call("post", "units", { code: "karai", name: "Karai", dimension: "package" }))
        .status,
    ).toBe(403);
    const cement = materialNamed("Cement 42.5N (50 kg bag)");
    expect(
      (
        await pm.call("post", `materials/${cement.id}/conversions`, {
          fromUnit: "bag",
          fromQuantity: "1",
          toUnit: "kg",
          toQuantity: "50",
        })
      ).status,
    ).toBe(403);
    // Finance reads (finance.view) but does not manage suppliers.
    expect((await finance.call("get", "materials")).status).toBe(200);
    expect(
      (await finance.call("post", "suppliers", { legalName: "Finance supplier" })).status,
    ).toBe(403);
  });

  it("keeps company B out of company A's catalogue and suppliers (API, RLS and composite keys)", async () => {
    const cement = materialNamed("Cement 42.5N (50 kg bag)");
    const aSuppliers = suppliersResponseSchema.parse(
      ok(await owner.call("get", "suppliers")),
    ).suppliers;
    const aSupplier = aSuppliers[0]!;
    await fresh(ownerB);
    expect((await ownerB.call("get", `materials/${cement.id}`)).status).toBe(404);
    expect((await ownerB.call("get", `suppliers/${aSupplier.id}`)).status).toBe(404);
    expect(
      (await ownerB.call("post", `suppliers/${aSupplier.id}/reveal`, { field: "kraPin" })).status,
    ).toBe(404);
    expect(
      (
        await ownerB.call("post", `materials/${cement.id}/prices`, {
          supplierId: aSupplier.id,
          unit: "bag_50kg",
          unitPriceMinor: 1,
          vatTreatment: "not_applicable",
          effectiveOn: "2026-11-10",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await ownerB.call(
          "get",
          `conversions/calculate?materialId=${cement.id}&from=t&to=kg&quantity=1`,
        )
      ).status,
    ).toBe(404);
    const bMaterials = materialsResponseSchema.parse(
      ok(await ownerB.call("get", "materials")),
    ).materials;
    expect(bMaterials).toEqual([]);
    const bSuppliers = suppliersResponseSchema.parse(
      ok(await ownerB.call("get", "suppliers")),
    ).suppliers;
    expect(bSuppliers.map((supplier) => supplier.legalName)).toEqual(["B Hardware"]);

    // Under B's context the runtime role sees none of A's rows and cannot point at them.
    const counts = await db.run(context(ownerB, tenantB), async (tx) => ({
      materials: await tx.material.count({ where: { tenantId: tenantA } }),
      suppliers: await tx.supplier.count({ where: { tenantId: tenantA } }),
      contacts: await tx.supplierContact.count({ where: { tenantId: tenantA } }),
      payouts: await tx.supplierPayoutVersion.count({ where: { tenantId: tenantA } }),
      prices: await tx.materialPrice.count({ where: { tenantId: tenantA } }),
      conversions: await tx.unitConversion.count({ where: { tenantId: tenantA } }),
      units: await tx.unit.count({ where: { tenantId: tenantA } }),
      changes: await tx.supplierPhoneChange.count({ where: { tenantId: tenantA } }),
    }));
    expect(counts).toEqual({
      materials: 0,
      suppliers: 0,
      contacts: 0,
      payouts: 0,
      prices: 0,
      conversions: 0,
      units: 0,
      changes: 0,
    });
    const bSupplier = bSuppliers[0]!;
    // B's row pointing at A's material: the composite key cannot match.
    await expect(
      db.run(
        context(ownerB, tenantB),
        (tx) =>
          tx.$executeRaw`INSERT INTO unit_conversions (id, tenant_id, material_id, supplier_id, from_unit,
          from_quantity, to_unit, to_quantity, pair_key, effective_from, created_by)
        VALUES (gen_random_uuid(), ${tenantB}::uuid, ${cement.id}::uuid, ${bSupplier.id}::uuid,
          'trip', 1, 't', 7, 'x', '2026-11-10', ${ownerB.auth.user.id}::uuid)`,
      ),
    ).rejects.toThrow();
    // A row claiming A's tenant from B's context fails the RLS WITH CHECK.
    await expect(
      db.run(
        context(ownerB, tenantB),
        (tx) =>
          tx.$executeRaw`INSERT INTO suppliers (id, tenant_id, code, legal_name, created_by, updated_by)
        VALUES (gen_random_uuid(), ${tenantA}::uuid, 'SUP-9999', 'Smuggled Ltd',
          ${ownerB.auth.user.id}::uuid, ${ownerB.auth.user.id}::uuid)`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("audits procurement changes with field names and IDs only, never identifiers or amounts", async () => {
    const events = await db.run(context(owner), (tx) =>
      tx.auditEvent.findMany({ where: { tenantId: tenantA }, orderBy: { sequence: "asc" } }),
    );
    const actions = new Set(events.map((event) => event.action));
    for (const action of [
      "materials.defaults_loaded",
      "material.created",
      "material.updated",
      "unit.created",
      "unit.updated",
      "unit_conversion.created",
      "unit_conversion.ended",
      "material_price.recorded",
      "material_price.corrected",
      "procurement.settings_updated",
      "supplier.created",
      "supplier.updated",
      "supplier.revealed",
      "supplier.lookup",
      "supplier.payout_proposed",
      "supplier.payout_verified",
      "supplier.payout_rejected",
    ])
      expect(actions, action).toContain(action);
    const metadata = JSON.stringify(events.map((event) => event.metadata));
    for (const secret of [
      PIN,
      PHONE,
      OTHER_PHONE,
      "000000000123",
      "Typed 900",
      "Called the number",
    ])
      expect(metadata, secret).not.toContain(secret);
  });

  it("caps a company's own units so conversion searches stay small", async () => {
    const limit = PROCUREMENT_LIMITS.customUnitsPerTenant;
    const own = unitsResponseSchema
      .parse(ok(await ownerB.call("get", "units")))
      .units.filter((unit) => !unit.standard).length;
    const userId = ownerB.auth.user.id;
    // Fill company B up to one below the limit directly, then create the last one through the API.
    await db.run(
      context(ownerB, tenantB),
      (tx) => tx.$executeRaw`INSERT INTO units (id, tenant_id, code, name, dimension,
        equals_quantity, equals_unit, created_by, updated_by)
        SELECT gen_random_uuid(), ${tenantB}::uuid, 'cap' || n, 'Cap unit ' || n, 'mass', n, 'kg',
          ${userId}::uuid, ${userId}::uuid
        FROM generate_series(1, ${limit - own - 1}::int) AS n`,
    );
    const unit = (code: string) => ({
      code,
      name: `Unit ${code}`,
      dimension: "mass",
      equalsQuantity: "3",
      equalsUnit: "kg",
    });
    expect((await ownerB.call("post", "units", unit("caplast"))).status).toBe(201);
    const over = await ownerB.call("post", "units", unit("capover"));
    expect([over.status, problem(over)]).toEqual([409, "unit-limit"]);
    // Every company unit counts, archived or not (archived units still resolve for old records).
    const listed = unitsResponseSchema.parse(ok(await ownerB.call("get", "units"))).units;
    expect(listed.filter((entry) => !entry.standard)).toHaveLength(limit);
    // Company A is unaffected.
    expect((await owner.call("post", "units", unit("capa"))).status).toBe(201);
  });
});
