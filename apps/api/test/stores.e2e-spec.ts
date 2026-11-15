import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nairobiDate } from "@pm-buddy/domain";
import {
  buildupMaterialsResponseSchema,
  buildupResponseSchema,
  bqImportResponseSchema,
  bqVersionsResponseSchema,
  issueOptionsResponseSchema,
  ledgerResponseSchema,
  lpoDetailResponseSchema,
  materialsResponseSchema,
  movementResponseSchema,
  projectResponseSchema,
  requisitionDetailResponseSchema,
  rfqDetailResponseSchema,
  siteResponseSchema,
  stockTakeResponseSchema,
  storeDetailResponseSchema,
  storesResponseSchema,
  supplierDetailResponseSchema,
  transferResponseSchema,
  varianceResponseSchema,
  type BqImport,
  type StoreDetailResponse,
  measurementResponseSchema,
  sitePhotoResponseSchema,
  valuationResponseSchema,
  type ValuationDetail,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { Browser, notifications } from "./support.js";
import { plainJpeg } from "./photo-fixtures.js";

/**
 * D5.3 stores end to end under the real runtime role (pmb_app, forced RLS): GRN receipts into the
 * site's store and their reversal on void, issues to a BQ item, returns (never more than
 * outstanding), wastage, reversals, offline replays, transfers in transit with a disputed receipt,
 * two simultaneous issues of the last stock (API and direct SQL), a stock take counted during
 * movements and approved independently, and the consumption VARIANCE ALERT firing on test data.
 * Figures are worked out by hand in comments (cement KES 800.00, sand KES 4,000.00, ballast
 * KES 2,200.00 per base unit, net of VAT). Synthetic data only.
 */
const today = nairobiDate();
const inDays = (days: number) => {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const fixture = (name: string) => readFileSync(new URL(`./fixtures/bq/${name}`, import.meta.url));
const SITE = { lat: -1.2921, lng: 36.8219 };
const now = () => new Date().toISOString();

describe("Stores (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let ownerB: Browser;
  let pm: Browser;
  let keeper: Browser;
  let foreman: Browser;
  let tenantA: string;
  let tenantB: string;
  let projectId: string;
  let otherProjectId: string;
  let siteId: string;
  let otherSiteId: string;
  let storeId: string;
  let otherStoreId: string;
  let notificationSpy: ReturnType<typeof vi.spyOn>;
  const material = { cement: "", sand: "", ballast: "" };
  let supplierId: string;
  let lpo: ReturnType<typeof lpoDetailResponseSchema.parse>;
  const item = { columnBases: "", excavation: "", versionId: "" };
  let buildupId: string;
  let issueA: string;

  const fresh = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
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
  const refused = (res: request.Response, status: number, code?: string) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    if (code) expect(problem(res)).toBe(code);
  };
  const context = (browser: Browser, tenantId = tenantA) => ({
    userId: browser.auth.user.id,
    tenantId,
    requestId: "d53-direct",
  });
  const keyed = (browser: Browser, path: string, body: object, key: string = randomUUID()) =>
    browser.call("post", path, body, true, { "Idempotency-Key": key });
  const store = async (browser: Browser, id = storeId): Promise<StoreDetailResponse> =>
    storeDetailResponseSchema.parse(ok(await browser.call("get", `stores/${id}`)));
  const balance = async (id: string, materialId: string) =>
    (await store(owner, id)).balances.find((row) => row.material.id === materialId);
  const lastBalance = async (materialId: string) => {
    const ledger = ledgerResponseSchema.parse(
      ok(await owner.call("get", `stores/${storeId}/ledger?materialId=${materialId}&limit=1`)),
    );
    return [ledger.entries[0]!.balanceQuantity, ledger.entries[0]!.balanceValueMinor];
  };
  const issue = (browser: Browser, lines: object[], extra: object = {}, key?: string) =>
    keyed(
      browser,
      "stock-movements/issues",
      {
        id: randomUUID(),
        storeId,
        capturedAt: now(),
        bqItemLineageId: item.columnBases,
        issuedToName: "Concrete gang (synthetic)",
        lines,
        ...extra,
      },
      key,
    );
  const grn = (lines: object[]) =>
    keyed(keeper, "procurement/grns", {
      id: randomUUID(),
      lpoId: lpo.lpo.id,
      capturedAt: now(),
      receivedByName: "Grace (synthetic)",
      vehicleRegistration: "KDA 123A",
      location: { latitude: SITE.lat, longitude: SITE.lng, accuracyM: 8 },
      lines,
    });
  const lpoLine = (materialId: string) =>
    lpo.lines.find((line) => line.material.id === materialId)!.id;

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
    pm = new Browser(app);
    keeper = new Browser(app);
    foreman = new Browser(app);
    for (const browser of [owner, ownerB, pm]) {
      await browser.register();
      await browser.enroll();
    }
    for (const browser of [keeper, foreman]) await browser.register();
    const a = await owner.call("post", "tenants", { name: "Stores company A" });
    const b = await ownerB.call("post", "tenants", { name: "Stores company B" });
    expect([a.status, b.status]).toEqual([201, 201]);
    tenantA = (a.body as { tenant: { id: string } }).tenant.id;
    tenantB = (b.body as { tenant: { id: string } }).tenant.id;
    await fresh(owner);
    projectId = projectResponseSchema.parse(
      ok(await owner.call("post", "projects", { name: "Stores project (synthetic)" }), 201),
    ).project.id;
    otherProjectId = projectResponseSchema.parse(
      ok(await owner.call("post", "projects", { name: "Second site project (synthetic)" }), 201),
    ).project.id;
    const site = async (project: string, name: string) =>
      siteResponseSchema.parse(
        ok(
          await owner.call("post", `projects/${project}/sites`, {
            name,
            geofence: { kind: "radius", center: SITE, radiusM: 200 },
          }),
          201,
        ),
      ).site.id;
    siteId = await site(projectId, "Main yard");
    otherSiteId = await site(otherProjectId, "Kitengela plot");
    await join(pm, "project_manager", [projectId]);
    await join(keeper, "storekeeper", [projectId, otherProjectId]);
    await join(foreman, "foreman", [projectId]);
    ok(await owner.call("post", "materials/defaults", {}));
    const materials = materialsResponseSchema.parse(
      ok(await owner.call("get", "materials?limit=200")),
    ).materials;
    const named = (name: string) => materials.find((entry) => entry.name === name)!.id;
    material.cement = named("Cement 42.5N (50 kg bag)");
    material.sand = named("River sand");
    material.ballast = named("Ballast 20 mm");
    supplierId = supplierDetailResponseSchema.parse(
      ok(
        await owner.call("post", "suppliers", {
          legalName: "Stores supplier (synthetic)",
          etimsStatus: "registered",
          creditDays: 30,
        }),
        201,
      ),
    ).supplier.id;
    // One quotation is enough for these tests.
    ok(
      await owner.call("put", "procurement/settings", {
        version: 0,
        priceChangeAlertPercent: "10",
        minQuotes: 1,
      }),
    );
    // Requisition (storekeeper) → approval (PM) → RFQ → LPO (approved by the PM with step-up).
    let requisition = requisitionDetailResponseSchema.parse(
      ok(
        await keeper.call("post", "procurement/requisitions", {
          projectId,
          siteId,
          neededBy: inDays(7),
          lines: [
            { materialId: material.cement, quantity: "200", unit: "bag_50kg" },
            { materialId: material.sand, quantity: "30", unit: "t" },
            { materialId: material.ballast, quantity: "10", unit: "t" },
          ],
        }),
        201,
      ),
    );
    requisition = requisitionDetailResponseSchema.parse(
      ok(
        await keeper.call("post", `procurement/requisitions/${requisition.requisition.id}/submit`, {
          version: requisition.requisition.version,
        }),
      ),
    );
    ok(
      await pm.call("post", `procurement/requisitions/${requisition.requisition.id}/approve`, {
        version: requisition.requisition.version,
      }),
    );
    let rfq = rfqDetailResponseSchema.parse(
      ok(
        await owner.call("post", "procurement/rfqs", {
          requisitionIds: [requisition.requisition.id],
          supplierIds: [supplierId],
        }),
        201,
      ),
    );
    const prices: Record<string, [string, number]> = {
      [material.cement]: ["bag_50kg", 80_000],
      [material.sand]: ["t", 400_000],
      [material.ballast]: ["t", 220_000],
    };
    rfq = rfqDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/rfqs/${rfq.rfq.id}/quotations`, {
          supplierId,
          quotedOn: today,
          validUntil: inDays(30),
          deliveryDays: 2,
          lines: rfq.lines.map((line) => ({
            requisitionLineId: line.requisitionLineId,
            priceUnit: prices[line.material.id]![0],
            unitPriceMinor: prices[line.material.id]![1],
            vatTreatment: "exclusive",
          })),
        }),
        201,
      ),
    );
    lpo = lpoDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/rfqs/${rfq.rfq.id}/award`, {
          version: rfq.rfq.version,
          quotationId: rfq.quotations[0]!.id,
          deliverySiteId: siteId,
        }),
        201,
      ),
    );
    lpo = lpoDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/lpos/${lpo.lpo.id}/submit`, {
          version: lpo.lpo.version,
        }),
      ),
    );
    await fresh(pm);
    lpo = lpoDetailResponseSchema.parse(
      ok(
        await pm.call("post", `procurement/lpos/${lpo.lpo.id}/approve`, {
          version: lpo.lpo.version,
        }),
      ),
    );
    // BQ: imported by the owner, baseline approved by the PM; a concrete build-up linked.
    const base = `projects/${projectId}/bq`;
    const uploaded = await owner.upload(
      `${base}/imports`,
      fixture("kenyan-multi-bill.xlsx"),
      "kenyan-multi-bill.xlsx",
    );
    let current: BqImport = bqImportResponseSchema.parse(ok(uploaded, 201)).import;
    current = bqImportResponseSchema.parse(
      ok(
        await owner.call("put", `${base}/imports/${current.id}/mapping`, {
          mapping: current.mapping,
          version: current.version,
        }),
      ),
    ).import;
    current = bqImportResponseSchema.parse(
      ok(
        await owner.call("post", `${base}/imports/${current.id}/validate`, {
          version: current.version,
        }),
      ),
    ).import;
    const warnings = current.report!.readiness.unacceptedWarnings;
    if (warnings.length)
      current = bqImportResponseSchema.parse(
        ok(
          await owner.call("put", `${base}/imports/${current.id}/resolutions`, {
            resolutions: {
              rows: [],
              accepted: warnings.map((code) => ({ code, reason: "Synthetic test fixture" })),
            },
            version: current.version,
          }),
        ),
      ).import;
    ok(
      await owner.call("post", `${base}/imports/${current.id}/commit`, {
        version: current.version,
      }),
    );
    const [draft] = bqVersionsResponseSchema.parse(
      ok(await pm.call("get", `${base}/versions`)),
    ).versions;
    await fresh(pm);
    ok(await pm.call("post", `${base}/versions/${draft!.id}/approve`, { version: draft!.version }));
    buildupId = buildupResponseSchema.parse(
      ok(
        await owner.call("post", "rate-buildups", {
          code: "CONC-STORES",
          name: "Concrete class 25 (synthetic stores test)",
          unit: "m3",
          lines: [
            {
              kind: "material",
              resourceName: "Cement, 50 kg bag",
              unit: "bag (50 kg)",
              quantity: "6.5",
              wastePercent: "5",
              unitCostMinor: 80_000,
            },
            {
              kind: "material",
              resourceName: "River sand",
              unit: "t",
              quantity: "0.7",
              wastePercent: "10",
              unitCostMinor: 400_000,
            },
            {
              kind: "material",
              resourceName: "Ballast 20 mm",
              unit: "t",
              quantity: "1.4",
              wastePercent: "5",
              unitCostMinor: 220_000,
            },
            {
              kind: "labour",
              resourceName: "Mason and helpers",
              unit: "hr",
              quantity: "4",
              wastePercent: null,
              unitCostMinor: 35_000,
            },
          ],
        }),
        201,
      ),
    ).buildup.id;
  }, 300_000);

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("receives a GRN into its site's store at the LPO's net price; a void posts reversing entries", async () => {
    ok(
      await grn([
        { lpoLineId: lpoLine(material.cement), receivedQuantity: "120" },
        { lpoLineId: lpoLine(material.sand), receivedQuantity: "30" },
        { lpoLineId: lpoLine(material.ballast), receivedQuantity: "10" },
      ]),
      201,
    );
    const list = storesResponseSchema.parse(ok(await owner.call("get", "stores")));
    const created = list.stores.find((entry) => entry.site.id === siteId)!;
    storeId = created.id;
    // 120 × 800.00 + 30 × 4,000.00 + 10 × 2,200.00 = KES 238,000.00.
    expect(created).toMatchObject({
      name: "Main yard store",
      valueMinor: 23_800_000,
      materialCount: 3,
    });
    expect(list.sitesWithoutStore.map((entry) => entry.site.id)).toEqual([otherSiteId]);
    const voided = await grn([{ lpoLineId: lpoLine(material.cement), receivedQuantity: "30" }]);
    const voidedId = (voided.body as { grn: { id: string } }).grn.id;
    expect((await balance(storeId, material.cement))!.quantity).toBe("150");
    ok(
      await keeper.call("post", `procurement/grns/${voidedId}/void`, {
        reason: "Duplicate entry (test)",
      }),
    );
    const cement = (await balance(storeId, material.cement))!;
    expect(cement).toMatchObject({
      quantity: "120",
      valueMinor: 9_600_000,
      averageUnitCostMinor: "80000",
    });
    const ledger = ledgerResponseSchema.parse(
      ok(await owner.call("get", `stores/${storeId}/ledger?materialId=${material.cement}`)),
    );
    expect(
      ledger.entries.map((entry) => [
        entry.kind,
        entry.quantity,
        entry.valueMinor,
        entry.balanceQuantity,
      ]),
    ).toEqual([
      ["receipt", "-30", "-2400000", "120"],
      ["receipt", "30", "2400000", "150"],
      ["receipt", "120", "9600000", "120"],
    ]);
    expect(ledger.entries[0]!.reversesEntryId).toBe(ledger.entries[1]!.id);
    expect(ledger.entries[2]!.source).toMatchObject({ type: "grn" });
    // The ledger and balances cannot be edited or deleted, even by direct SQL as pmb_app.
    const sql = (statement: (tx: never) => Promise<unknown>) =>
      db.run(context(keeper), statement as never);
    await expect(
      sql(
        ((tx: { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> }) =>
          tx.$executeRaw`UPDATE stock_ledger_entries SET quantity = 999 WHERE store_id = ${storeId}::uuid`) as never,
      ),
    ).rejects.toThrow(/append-only|permission denied/);
    await expect(
      sql(
        ((tx: { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> }) =>
          tx.$executeRaw`DELETE FROM stock_ledger_entries WHERE store_id = ${storeId}::uuid`) as never,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      sql(
        ((tx: { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> }) =>
          tx.$executeRaw`UPDATE stock_balances SET quantity = 1000 WHERE store_id = ${storeId}::uuid`) as never,
      ),
    ).rejects.toThrow(/only with its next ledger entry/);
  });

  it("issues to a BQ item, returns no more than outstanding, records wastage and reverses mistakes", async () => {
    const options = issueOptionsResponseSchema.parse(
      ok(await keeper.call("get", `stores/${storeId}/issue-options`)),
    );
    const find = (text: string) =>
      options.bqItems.find((entry) => entry.description.startsWith(text))!;
    item.columnBases = find("Reinforced concrete class 25 in column bases").lineageId;
    item.excavation = find("Excavate for column bases").lineageId;
    item.versionId = find("Reinforced concrete class 25 in column bases").versionId;
    expect(options.stock.map((entry) => entry.quantity).sort()).toEqual(["10", "120", "30"]);
    expect(options.bqItemsTruncated).toBe(false);
    // The storekeeper (no bq.view) searches the whole BQ on the server, not a truncated list.
    const searched = issueOptionsResponseSchema.parse(
      ok(await keeper.call("get", `stores/${storeId}/issue-options?bqSearch=column%20BASES`)),
    );
    expect(searched.bqItems.map((entry) => entry.lineageId)).toEqual(
      expect.arrayContaining([item.columnBases, item.excavation]),
    );
    expect(
      searched.bqItems.every((entry) =>
        `${entry.ref ?? ""} ${entry.description}`.toLowerCase().includes("column bases"),
      ),
    ).toBe(true);
    expect(searched.bqItems.length).toBeLessThan(options.bqItems.length);
    // An issue needs a BQ item of the BQ in force or a gang of the project.
    refused(
      await issue(keeper, [{ materialId: material.cement, quantity: "1", unit: "bag_50kg" }], {
        bqItemLineageId: null,
      }),
      400,
    );
    refused(
      await issue(keeper, [{ materialId: material.cement, quantity: "1", unit: "bag_50kg" }], {
        bqItemLineageId: randomUUID(),
      }),
      422,
      "bq-item-not-found",
    );
    refused(
      await issue(keeper, [{ materialId: material.cement, quantity: "1", unit: "bag_50kg" }], {
        gangId: randomUUID(),
      }),
      400,
      "gang-not-in-project",
    );
    refused(
      await issue(keeper, [{ materialId: material.cement, quantity: "121", unit: "bag_50kg" }]),
      409,
      "insufficient-stock",
    );
    // 60 bags to the column bases: 60 × 800.00 = KES 48,000.00 at the average.
    const first = movementResponseSchema.parse(
      ok(
        await issue(keeper, [
          { materialId: material.cement, quantity: "60", unit: "bag_50kg" },
          { materialId: material.sand, quantity: "7", unit: "t" },
        ]),
        201,
      ),
    );
    issueA = first.movement.id;
    expect(first.movement).toMatchObject({
      number: "ISS-0001",
      kind: "issue",
      totalValueMinor: 7_600_000,
    });
    expect(first.permissions).toEqual({ canReverse: true, canReturn: true });
    // The PM (no stores.manage) sees the same issue without the storekeeper's actions.
    expect(
      movementResponseSchema.parse(ok(await pm.call("get", `stock-movements/${issueA}`)))
        .permissions,
    ).toEqual({ canReverse: false, canReturn: false });
    const cementLine = first.movement.lines.find((line) => line.material.id === material.cement)!;
    const ret = (quantity: string) =>
      keyed(keeper, "stock-movements/returns", {
        id: randomUUID(),
        issueId: issueA,
        capturedAt: now(),
        lines: [{ issueLineId: cementLine.id, quantity }],
      });
    const returned = movementResponseSchema.parse(ok(await ret("10"), 201));
    expect(returned.movement).toMatchObject({
      number: "RTN-0001",
      kind: "return",
      returnOf: { id: issueA },
    });
    refused(await ret("50.5"), 409, "return-exceeds-issued");
    const after = movementResponseSchema.parse(
      ok(await keeper.call("get", `stock-movements/${issueA}`)),
    );
    expect(after.movement.lines.find((line) => line.id === cementLine.id)).toMatchObject({
      returnedBaseQuantity: "10",
      returnableBaseQuantity: "50",
    });
    // An issue is reversed only after its returns.
    refused(
      await keeper.call("post", `stock-movements/${issueA}/reverse`, {
        reason: "Wrong item (test)",
      }),
      409,
      "movement-has-returns",
    );
    ok(
      await keyed(keeper, "stock-movements/wastage", {
        id: randomUUID(),
        storeId,
        capturedAt: now(),
        reason: "weather",
        notes: "Two bags split in the rain (test)",
        lines: [{ materialId: material.cement, quantity: "2", unit: "bag_50kg" }],
      }),
      201,
    );
    movementResponseSchema.parse(
      ok(
        await issue(keeper, [{ materialId: material.cement, quantity: "30", unit: "bag_50kg" }]),
        201,
      ),
    );
    // A mistaken issue is reversed with a reason: the stock comes back, nothing is edited.
    const mistaken = movementResponseSchema.parse(
      ok(
        await issue(keeper, [{ materialId: material.cement, quantity: "5", unit: "bag_50kg" }]),
        201,
      ),
    );
    const reversed = movementResponseSchema.parse(
      ok(
        await keeper.call("post", `stock-movements/${mistaken.movement.id}/reverse`, {
          reason: "Entered twice (test)",
        }),
      ),
    );
    expect(reversed.movement).toMatchObject({
      status: "reversed",
      reversalReason: "Entered twice (test)",
    });
    expect(reversed.permissions).toEqual({ canReverse: false, canReturn: false });
    // 120 − 60 + 10 − 2 − 30 − 5 + 5 = 38 bags, all at KES 800.00.
    expect(await balance(storeId, material.cement)).toMatchObject({
      quantity: "38",
      valueMinor: 3_040_000,
    });
    // The audit log names the records, never quantities, values or notes.
    const events = await db.run(context(owner), (tx) =>
      tx.auditEvent.findMany({ where: { tenantId: tenantA, action: { startsWith: "stock." } } }),
    );
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "stock.issued",
        "stock.returned",
        "stock.wasted",
        "stock.movement_reversed",
      ]),
    );
    const text = JSON.stringify(events.map((event) => event.metadata));
    expect(text).not.toMatch(/rain|Entered twice|"quantity"|valueMinor|Concrete gang/);
  });

  it("replays offline submissions once and refuses a reused key or ID", async () => {
    const key = randomUUID();
    const body = {
      id: randomUUID(),
      storeId,
      capturedAt: now(),
      bqItemLineageId: item.excavation,
      issuedToName: "Offline device (synthetic)",
      lines: [{ materialId: material.cement, quantity: "1", unit: "bag_50kg" }],
    };
    const first = await keyed(keeper, "stock-movements/issues", body, key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await keyed(keeper, "stock-movements/issues", body, key);
    expect(again.status).toBe(201);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    expect((again.body as { movement: { id: string; number: string } }).movement).toMatchObject({
      id: body.id,
      number: (first.body as { movement: { number: string } }).movement.number,
    });
    expect(movementResponseSchema.parse(again.body).replayed).toBe(true);
    // Posted once: 38 − 1 = 37.
    expect((await balance(storeId, material.cement))!.quantity).toBe("37");
    refused(
      await keyed(
        keeper,
        "stock-movements/issues",
        { ...body, lines: [{ ...body.lines[0], quantity: "2" }] },
        key,
      ),
      409,
      "idempotency-key-reused",
    );
    refused(await keyed(keeper, "stock-movements/issues", body), 409, "movement-id-conflict");
    refused(
      await keeper.call("post", "stock-movements/issues", body),
      400,
      "idempotency-key-required",
    );
    // Put it back so the stock-take figures below stay simple.
    ok(
      await keeper.call("post", `stock-movements/${body.id}/reverse`, {
        reason: "Offline test done",
      }),
    );
    expect((await balance(storeId, material.cement))!.quantity).toBe("38");
  });

  it("transfers between sites: in transit, short receipt disputed, independent resolution, cancel", async () => {
    otherStoreId = storeDetailResponseSchema.parse(
      ok(await keeper.call("post", "stores", { siteId: otherSiteId }), 201),
    ).store.id;
    refused(await keeper.call("post", "stores", { siteId: otherSiteId }), 409, "store-exists");
    const dispatch = (quantity: string, key = randomUUID()) =>
      keyed(
        keeper,
        "stock-transfers",
        {
          id: randomUUID(),
          fromStoreId: storeId,
          toStoreId: otherStoreId,
          capturedAt: now(),
          lines: [{ materialId: material.sand, quantity, unit: "t" }],
        },
        key,
      );
    const sent = transferResponseSchema.parse(ok(await dispatch("5"), 201));
    expect(sent.transfer).toMatchObject({ status: "dispatched", dispatchedValueMinor: 2_000_000 });
    // 30 − 7 − 5 = 18 t in the yard; 5 t in transit to Kitengela.
    expect((await balance(storeId, material.sand))!.quantity).toBe("18");
    expect((await store(owner, otherStoreId)).inTransit).toEqual([
      expect.objectContaining({ direction: "in", valueMinor: 2_000_000 }),
    ]);
    refused(await dispatch("100"), 409, "insufficient-stock");
    const line = sent.transfer.lines[0]!;
    const receiveKey = randomUUID();
    const receive = (body: object, key = receiveKey) =>
      keyed(owner, `stock-transfers/${sent.transfer.id}/receive`, body, key);
    refused(
      await receive(
        { capturedAt: now(), lines: [{ lineId: line.id, receivedQuantity: "4.5" }] },
        randomUUID(),
      ),
      400,
      "difference-reason-required",
    );
    const receiptBody = {
      capturedAt: now(),
      lines: [
        {
          lineId: line.id,
          receivedQuantity: "4.5",
          differenceReason: "Spillage on the road (test)",
        },
      ],
    };
    const received = transferResponseSchema.parse(ok(await receive(receiptBody)));
    // 0.5 t short at KES 4,000.00 = KES 2,000.00 lost in transit.
    expect(received.transfer).toMatchObject({ status: "disputed", transitLossValueMinor: 200_000 });
    expect(received.transfer.lines[0]).toMatchObject({
      receivedBaseQuantity: "4.5",
      differenceBaseQuantity: "-0.5",
    });
    const replay = await receive(receiptBody);
    expect([replay.status, transferResponseSchema.parse(replay.body).replayed]).toEqual([
      200,
      true,
    ]);
    expect((await balance(otherStoreId, material.sand))!.quantity).toBe("4.5");
    // Resolution: procurement.approve, by someone who neither sent nor received it.
    refused(
      await keeper.call("post", `stock-transfers/${sent.transfer.id}/resolve`, {
        version: received.transfer.version,
        reason: "Accept the loss",
      }),
      403,
    );
    refused(
      await owner.call("post", `stock-transfers/${sent.transfer.id}/resolve`, {
        version: received.transfer.version,
        reason: "Accept the loss",
      }),
      403,
      "maker-checker",
    );
    const resolved = transferResponseSchema.parse(
      ok(
        await pm.call("post", `stock-transfers/${sent.transfer.id}/resolve`, {
          version: received.transfer.version,
          reason: "Spillage accepted",
        }),
      ),
    );
    expect(resolved.transfer.status).toBe("resolved");
    // A transfer still in transit can be cancelled: the stock goes back.
    const second = transferResponseSchema.parse(ok(await dispatch("1"), 201));
    expect((await balance(storeId, material.sand))!.quantity).toBe("17");
    ok(
      await keeper.call("post", `stock-transfers/${second.transfer.id}/cancel`, {
        version: second.transfer.version,
        reason: "Lorry broke down",
      }),
    );
    expect(await balance(storeId, material.sand)).toMatchObject({
      quantity: "18",
      valueMinor: 7_200_000,
    });
  });

  it("never lets two simultaneous issues of the last stock both succeed (API and direct SQL)", async () => {
    // API: two issues of all 18 t of sand at once.
    const results = await Promise.all([
      issue(keeper, [{ materialId: material.sand, quantity: "18", unit: "t" }], {
        bqItemLineageId: item.excavation,
      }),
      issue(keeper, [{ materialId: material.sand, quantity: "18", unit: "t" }], {
        bqItemLineageId: item.excavation,
      }),
    ]);
    expect(results.map((res) => res.status).sort((left, right) => left - right)).toEqual([
      201, 409,
    ]);
    expect(problem(results.find((res) => res.status === 409)!)).toBe("insufficient-stock");
    // Nothing on hand (an empty position is not listed); the ledger's running balance is zero.
    expect(await balance(storeId, material.sand)).toBeUndefined();
    expect(await lastBalance(material.sand)).toEqual(["0", "0"]);
    // SQL as pmb_app, bypassing the API (and its company lock): the balance row lock and the
    // never-negative rule still let only one of two concurrent issues of the last 10 t through.
    const race = (number: string) =>
      db.run(context(keeper), async (tx) => {
        const movementId = randomUUID();
        const lineId = randomUUID();
        await tx.stockMovement.create({
          data: {
            id: movementId,
            tenantId: tenantA,
            projectId,
            storeId,
            kind: "issue",
            number,
            bqVersionId: item.versionId,
            bqItemLineageId: item.excavation,
            issuedToName: "Race (synthetic)",
            idempotencyKey: randomUUID(),
            requestDigest: "a".repeat(64),
            capturedAt: new Date(),
            businessDate: new Date(),
            source: "web",
            lineCount: 1,
            recordedBy: keeper.auth.user.id,
          },
        });
        await tx.stockMovementLine.create({
          data: {
            id: lineId,
            tenantId: tenantA,
            movementId,
            lineNo: 1,
            materialId: material.ballast,
            quantity: "10",
            unit: "t",
            baseQuantity: "10",
            conversion: {},
          },
        });
        await tx.stockLedgerEntry.create({
          data: {
            id: randomUUID(),
            tenantId: tenantA,
            projectId,
            storeId,
            materialId: material.ballast,
            baseUnit: "t",
            seq: 0n,
            kind: "issue",
            quantity: "-10",
            unitCostMinor: "220000",
            valueMinor: "-2200000",
            balanceQuantity: "0",
            balanceValueMinor: "0",
            businessDate: new Date(),
            recordedBy: keeper.auth.user.id,
            movementId,
            movementLineId: lineId,
            bqVersionId: item.versionId,
            bqItemLineageId: item.excavation,
          },
        });
        await tx.$queryRaw`SELECT pg_sleep(0.3)::text AS slept`;
      });
    const raced = await Promise.allSettled([race("ISS-9001"), race("ISS-9002")]);
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = raced.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/below zero/);
    expect(await lastBalance(material.ballast)).toEqual(["0", "0"]);
  });

  it("counts stock during movements and posts variances only after independent approval", async () => {
    refused(await pm.call("post", "stock-takes", { storeId }), 403);
    const created = stockTakeResponseSchema.parse(
      ok(
        await keeper.call("post", "stock-takes", { storeId, materialIds: [material.cement] }),
        201,
      ),
    );
    const take = created.stockTake;
    expect(take.lines[0]).toMatchObject({ snapshotQuantity: "38", countedQuantity: null });
    refused(await keeper.call("post", "stock-takes", { storeId }), 409, "stock-take-open");
    // Work goes on during the count: 3 bags issued after the sheet was started.
    ok(
      await issue(keeper, [{ materialId: material.cement, quantity: "3", unit: "bag_50kg" }], {
        bqItemLineageId: item.excavation,
      }),
      201,
    );
    const countKey = randomUUID();
    const countBody = {
      capturedAt: now(),
      counts: [{ id: randomUUID(), lineId: take.lines[0]!.id, countedQuantity: "34" }],
    };
    const counted = stockTakeResponseSchema.parse(
      ok(await keyed(keeper, `stock-takes/${take.id}/counts`, countBody, countKey)),
    );
    // Expected is the system quantity when counted (38 − 3 = 35), so only 1 bag is missing.
    expect(counted.stockTake.lines[0]).toMatchObject({
      expectedQuantity: "35",
      movementsSinceSnapshot: "-3",
      varianceQuantity: "-1",
      varianceValueMinor: -80_000,
    });
    const replay = await keyed(keeper, `stock-takes/${take.id}/counts`, countBody, countKey);
    expect([replay.status, stockTakeResponseSchema.parse(replay.body).replayed]).toEqual([
      200,
      true,
    ]);
    // The owner recounts the line: now a contributor, so not the approver.
    const recount = stockTakeResponseSchema.parse(
      ok(
        await keyed(owner, `stock-takes/${take.id}/counts`, {
          capturedAt: now(),
          counts: [{ id: randomUUID(), lineId: take.lines[0]!.id, countedQuantity: "34" }],
        }),
      ),
    );
    const submitted = stockTakeResponseSchema.parse(
      ok(
        await keeper.call("post", `stock-takes/${take.id}/submit`, {
          version: recount.stockTake.version,
        }),
      ),
    );
    expect(submitted.stockTake.status).toBe("submitted");
    expect(submitted.permissions.canApprove).toBe(false);
    refused(
      await keeper.call("post", `stock-takes/${take.id}/approve`, {
        version: submitted.stockTake.version,
      }),
      403,
    );
    refused(
      await owner.call("post", `stock-takes/${take.id}/approve`, {
        version: submitted.stockTake.version,
      }),
      403,
      "maker-checker",
    );
    // The database refuses a contributor as approver too.
    await expect(
      db.run(
        context(owner),
        (tx) =>
          tx.$executeRaw`UPDATE stock_takes SET status = 'approved', approved_by = ${owner.auth.user.id}::uuid,
          approved_at = now() WHERE id = ${take.id}::uuid`,
      ),
    ).rejects.toThrow(/stock_takes_state_check|check constraint/);
    const viewForPm = stockTakeResponseSchema.parse(
      ok(await pm.call("get", `stock-takes/${take.id}`)),
    );
    expect(viewForPm.permissions).toMatchObject({ canApprove: true, canCount: false });
    const approved = stockTakeResponseSchema.parse(
      ok(
        await pm.call("post", `stock-takes/${take.id}/approve`, {
          version: submitted.stockTake.version,
        }),
      ),
    );
    expect(approved.stockTake.status).toBe("approved");
    expect(approved.stockTake.lines[0]!.adjustmentEntryId).not.toBeNull();
    expect(await balance(storeId, material.cement)).toMatchObject({
      quantity: "34",
      valueMinor: 2_720_000,
    });
    const ledger = ledgerResponseSchema.parse(
      ok(await owner.call("get", `stores/${storeId}/ledger?kind=adjustment`)),
    );
    expect(
      ledger.entries.map((entry) => [entry.quantity, entry.valueMinor, entry.source.number]),
    ).toEqual([["-1", "-80000", take.number]]);
  });

  it("fires a variance alert when cement issued exceeds what the measured concrete needs", async () => {
    ok(
      await owner.call("put", `projects/${projectId}/bq/items/${item.columnBases}/rate-buildup`, {
        buildupVersionId: buildupResponseSchema.parse(
          ok(await owner.call("get", `rate-buildups/${buildupId}`)),
        ).current.id,
      }),
    );
    const mappings = buildupMaterialsResponseSchema.parse(
      ok(await owner.call("get", `rate-buildups/${buildupId}/versions/1/materials`)),
    );
    expect(mappings.lines.map((line) => [line.resourceName, line.mapping])).toEqual([
      ["Cement, 50 kg bag", null],
      ["River sand", null],
      ["Ballast 20 mm", null],
    ]);
    const map = (lineNo: number, materialId: string, unit: string) =>
      owner.call(
        "put",
        `rate-buildups/${buildupId}/versions/1/materials/${mappings.lines[lineNo - 1]!.lineId}`,
        { materialId, unit },
      );
    refused(
      await keeper.call(
        "put",
        `rate-buildups/${buildupId}/versions/1/materials/${mappings.lines[0]!.lineId}`,
        { materialId: material.cement, unit: "bag_50kg" },
      ),
      403,
    );
    // A bag is not a mass of sand: no conversion without a factor.
    refused(await map(2, material.sand, "bag"), 422, "no-conversion");
    ok(await map(1, material.cement, "bag_50kg"));
    ok(await map(2, material.sand, "t"));
    const variance = async (browser = owner) =>
      varianceResponseSchema.parse(
        ok(await browser.call("get", `stores/variance?projectId=${projectId}`)),
      );
    // Before anything is measured the variance is unavailable, never zero; the unmapped line says so.
    let report = await variance();
    const forItem = () => report.rows.filter((row) => row.bqItem.lineageId === item.columnBases);
    expect(
      forItem()
        .map((row) => [row.material?.name ?? row.buildup?.resourceName ?? "", row.state])
        .sort((left, right) => left[0]!.localeCompare(right[0]!)),
    ).toEqual([
      ["Ballast 20 mm", "not_mapped"],
      ["Cement 42.5N (50 kg bag)", "no_measurement"],
      ["River sand", "no_measurement"],
    ]);
    expect(forItem().find((row) => row.state === "no_measurement")!.theoreticalQuantity).toBeNull();
    refused(
      await keeper.call("post", `projects/${projectId}/measurements`, {
        bqItemLineageId: item.columnBases,
        measuredOn: today,
        quantityToDate: "10",
      }),
      403,
    );
    refused(
      await pm.call("post", `projects/${projectId}/measurements`, {
        bqItemLineageId: item.columnBases,
        measuredOn: inDays(1),
        quantityToDate: "10",
      }),
      400,
      "measurement-future",
    );
    const photo = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/photos`)
      .set("Cookie", [...pm.cookies].map(([key, value]) => `${key}=${value}`).join("; "))
      .set("Origin", "http://localhost:3000")
      .set("X-CSRF-Token", pm.csrf)
      .field("siteId", siteId)
      .attach("file", await plainJpeg(), "IMG_0001.jpg");
    expect(photo.status, JSON.stringify(photo.body)).toBe(201);
    const cast = measurementResponseSchema.parse(
      ok(
        await pm.call("post", `projects/${projectId}/measurements`, {
          bqItemLineageId: item.columnBases,
          measuredOn: today,
          quantityToDate: "10",
          note: "Column bases cast (synthetic)",
          photoIds: [sitePhotoResponseSchema.parse(photo.body).photo.id],
        }),
        201,
      ),
    ).measurement;
    report = await variance();
    const cement = forItem().find((row) => row.material?.id === material.cement)!;
    // Theoretical 10 m³ × 6.5 bags × 1.05 = 68.25; actual 60 + 30 (+5 −5 reversed) − 10 returned
    // = 80; limit 68.25 × 1.10 = 75.075; variance 11.75 bags = 17.2 %.
    expect(cement).toMatchObject({
      state: "alert",
      measurement: { quantityToDate: "10", measuredOn: today },
      buildup: { code: "CONC-STORES", quantityPerUnit: "6.5", wastePercent: "5" },
      mapping: { unit: "bag_50kg", basePerUnitDecimal: "1" },
      theoreticalQuantity: "68.25",
      limitQuantity: "75.075",
      issuedQuantity: "90",
      returnedQuantity: "10",
      actualQuantity: "80",
      varianceQuantity: "11.75",
      variancePercent: "17.2",
      canMeasure: true,
    });
    // Sand: 10 × 0.7 × 1.10 = 7.7 t needed, 7 t used: within.
    expect(forItem().find((row) => row.material?.id === material.sand)).toMatchObject({
      state: "within",
      theoreticalQuantity: "7.7",
      actualQuantity: "7",
      variancePercent: "-9.1",
    });
    expect(report.counts.alert).toBe(1);
    expect(report.thresholdPercent).toBe("10");
    // The threshold is a company setting (config.manage): at 20 % the same figures are within.
    const settings = (await owner.call("get", "stores/settings")).body as {
      settings: { version: number | null };
    };
    refused(
      await keeper.call("put", "stores/settings", {
        version: settings.settings.version,
        varianceThresholdPercent: "20",
      }),
      403,
    );
    const updated = ok(
      await owner.call("put", "stores/settings", {
        version: settings.settings.version,
        varianceThresholdPercent: "20",
      }),
    ) as { settings: { version: number } };
    expect(forItemOf(await variance(), item.columnBases, material.cement)!.state).toBe("within");
    ok(
      await owner.call("put", "stores/settings", {
        version: updated.settings.version,
        varianceThresholdPercent: "10",
      }),
    );
    expect(forItemOf(await variance(pm), item.columnBases, material.cement)!.state).toBe("alert");
    // The storekeeper sees the same alert but may not record measurements.
    expect(forItemOf(await variance(keeper), item.columnBases, material.cement)!.canMeasure).toBe(
      false,
    );
    // A correction that is rejected leaves the approved original in force (as in valuations).
    ok(await owner.call("post", `projects/${projectId}/measurements/${cast.id}/approve`, {}));
    const correction = measurementResponseSchema.parse(
      ok(
        await pm.call("post", `projects/${projectId}/measurements`, {
          bqItemLineageId: item.columnBases,
          measuredOn: today,
          quantityToDate: "4",
          correctsMeasurementId: cast.id,
          correctionReason: "Recounted the bases (synthetic)",
        }),
        201,
      ),
    ).measurement;
    ok(
      await owner.call("post", `projects/${projectId}/measurements/${correction.id}/reject`, {
        reason: "The bases were counted right the first time",
      }),
    );
    expect(forItemOf(await variance(), item.columnBases, material.cement)).toMatchObject({
      state: "alert",
      measurement: { quantityToDate: "10" },
    });
  });

  it("keeps companies apart and refuses the unpermitted", async () => {
    const asB = await ownerB.call("get", `stores/${storeId}`);
    expect(asB.status).toBe(404);
    expect(storesResponseSchema.parse(ok(await ownerB.call("get", "stores"))).stores).toEqual([]);
    refused(
      await keyed(ownerB, "stock-movements/issues", {
        id: randomUUID(),
        storeId,
        capturedAt: now(),
        bqItemLineageId: item.columnBases,
        issuedToName: "Intruder (synthetic)",
        lines: [{ materialId: material.cement, quantity: "1", unit: "bag_50kg" }],
      }),
      404,
    );
    expect((await ownerB.call("get", `stock-movements/${issueA}`)).status).toBe(404);
    expect((await ownerB.call("get", `stores/variance?projectId=${projectId}`)).status).toBe(200);
    expect(
      varianceResponseSchema.parse((await ownerB.call("get", "stores/variance")).body).rows,
    ).toEqual([]);
    // Company B's context cannot see or write company A's stock rows.
    const seen = await db.run(context(ownerB, tenantB), (tx) =>
      tx.stockLedgerEntry.count({ where: { storeId } }),
    );
    expect(seen).toBe(0);
    await expect(
      db.run(context(ownerB, tenantB), (tx) =>
        tx.stockReorderLevel.create({
          data: {
            tenantId: tenantA,
            storeId,
            materialId: material.cement,
            reorderLevel: "1",
            updatedBy: ownerB.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|violates/);
    // A foreman has no stores permission; a PM cannot issue or count.
    refused(await foreman.call("get", `stores/${storeId}`), 403);
    expect(storesResponseSchema.parse(ok(await foreman.call("get", "stores"))).stores).toEqual([]);
    refused(
      await issue(pm, [{ materialId: material.cement, quantity: "1", unit: "bag_50kg" }]),
      403,
    );
    const forPm = await store(pm);
    expect(forPm.permissions).toEqual({
      canIssue: false,
      canWaste: false,
      canTransfer: false,
      canCount: false,
      canEditReorderLevels: false,
      canEdit: false,
    });
    expect((await store(keeper)).permissions.canIssue).toBe(true);
    // Reorder levels: 34 bags at a level of 40 is low stock.
    const levels = storeDetailResponseSchema.parse(
      ok(
        await keeper.call("put", `stores/${storeId}/reorder-levels`, {
          levels: [{ materialId: material.cement, reorderLevel: "40" }],
        }),
      ),
    );
    expect(levels.balances.find((row) => row.material.id === material.cement)).toMatchObject({
      reorderLevel: "40",
      low: true,
    });
    expect(storesResponseSchema.parse(ok(await owner.call("get", "stores"))).lowStock).toEqual([
      expect.objectContaining({ quantity: "34", reorderLevel: "40" }),
    ]);
  });

  it("refuses to void a GRN whose goods were already used (stock never goes negative)", async () => {
    const third = await grn([{ lpoLineId: lpoLine(material.cement), receivedQuantity: "40" }]);
    expect(third.status, JSON.stringify(third.body)).toBe(201);
    // 34 + 40 = 74; 70 issued leaves 4 < 40.
    ok(
      await issue(keeper, [{ materialId: material.cement, quantity: "70", unit: "bag_50kg" }], {
        bqItemLineageId: item.excavation,
      }),
      201,
    );
    const voidId = (third.body as { grn: { id: string } }).grn.id;
    refused(
      await keeper.call("post", `procurement/grns/${voidId}/void`, {
        reason: "Entered in error (test)",
      }),
      409,
      "grn-stock-consumed",
    );
    expect((await balance(storeId, material.cement))!.quantity).toBe("4");
  });

  it("voids a mistaken receipt at its own value, so the store's value is restored exactly", async () => {
    // A second order for cement at KES 1,000 a bag; the store holds 4 bags at KES 800.
    let requisition = requisitionDetailResponseSchema.parse(
      ok(
        await keeper.call("post", "procurement/requisitions", {
          projectId,
          siteId,
          neededBy: inDays(7),
          lines: [{ materialId: material.cement, quantity: "100", unit: "bag_50kg" }],
        }),
        201,
      ),
    );
    requisition = requisitionDetailResponseSchema.parse(
      ok(
        await keeper.call("post", `procurement/requisitions/${requisition.requisition.id}/submit`, {
          version: requisition.requisition.version,
        }),
      ),
    );
    ok(
      await pm.call("post", `procurement/requisitions/${requisition.requisition.id}/approve`, {
        version: requisition.requisition.version,
      }),
    );
    let rfq = rfqDetailResponseSchema.parse(
      ok(
        await owner.call("post", "procurement/rfqs", {
          requisitionIds: [requisition.requisition.id],
          supplierIds: [supplierId],
        }),
        201,
      ),
    );
    rfq = rfqDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/rfqs/${rfq.rfq.id}/quotations`, {
          supplierId,
          quotedOn: today,
          validUntil: inDays(30),
          deliveryDays: 2,
          lines: rfq.lines.map((line) => ({
            requisitionLineId: line.requisitionLineId,
            priceUnit: "bag_50kg",
            unitPriceMinor: 100_000,
            vatTreatment: "exclusive",
          })),
        }),
        201,
      ),
    );
    let second = lpoDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/rfqs/${rfq.rfq.id}/award`, {
          version: rfq.rfq.version,
          quotationId: rfq.quotations[0]!.id,
          deliverySiteId: siteId,
        }),
        201,
      ),
    );
    second = lpoDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/lpos/${second.lpo.id}/submit`, {
          version: second.lpo.version,
        }),
      ),
    );
    await fresh(pm);
    second = lpoDetailResponseSchema.parse(
      ok(
        await pm.call("post", `procurement/lpos/${second.lpo.id}/approve`, {
          version: second.lpo.version,
        }),
      ),
    );
    const before = (await balance(storeId, material.cement))!;
    expect(before).toMatchObject({ quantity: "4", valueMinor: 320_000 });
    const mistaken = await keyed(keeper, "procurement/grns", {
      id: randomUUID(),
      lpoId: second.lpo.id,
      capturedAt: now(),
      receivedByName: "Grace (synthetic)",
      vehicleRegistration: "KDA 123A",
      location: { latitude: SITE.lat, longitude: SITE.lng, accuracyM: 8 },
      lines: [{ lpoLineId: second.lines[0]!.id, receivedQuantity: "100" }],
    });
    expect(mistaken.status, JSON.stringify(mistaken.body)).toBe(201);
    expect((await balance(storeId, material.cement))!).toMatchObject({
      quantity: "104",
      valueMinor: 10_320_000,
    });
    ok(
      await keeper.call(
        "post",
        `procurement/grns/${(mistaken.body as { grn: { id: string } }).grn.id}/void`,
        { reason: "Recorded against the wrong order (test)" },
      ),
    );
    // Out at the KES 1,000 it came in at, not the KES 992.31 average: 4 bags worth KES 3,200 again.
    expect((await balance(storeId, material.cement))!).toMatchObject({
      quantity: "4",
      valueMinor: 320_000,
      averageUnitCostMinor: "80000",
    });
  });

  it("counts a store with more materials than one sheet takes in turns, never failing", async () => {
    // 301 materials with a reorder level in the other site's store: one sheet takes 300.
    const ids = Array.from({ length: 301 }, () => randomUUID());
    await db.run(context(owner), (tx) =>
      tx.material.createMany({
        data: ids.map((id, index) => ({
          id,
          tenantId: tenantA,
          code: `MAT-${90_000 + index}`,
          name: `Cycle count item ${String(index).padStart(3, "0")} (test)`,
          category: "other",
          baseUnit: "nr",
          createdBy: owner.auth.user.id,
          updatedBy: owner.auth.user.id,
        })),
      }),
    );
    for (const batch of [ids.slice(0, 200), ids.slice(200)])
      ok(
        await keeper.call("put", `stores/${otherStoreId}/reorder-levels`, {
          levels: batch.map((materialId) => ({ materialId, reorderLevel: "1" })),
        }),
      );
    const started = stockTakeResponseSchema.parse(
      ok(await keeper.call("post", "stock-takes", { storeId: otherStoreId }), 201),
    );
    expect(started.stockTake.lineCount).toBe(300);
    expect(started.uncoveredMaterials).toBeGreaterThanOrEqual(1);
    // Never counted: by name, so the last test material waits for the next turn.
    expect(started.stockTake.lines.map((line) => line.material.id)).not.toContain(ids[300]);
    ok(
      await keeper.call("post", `stock-takes/${started.stockTake.id}/cancel`, {
        version: started.stockTake.version,
        reason: "Test of counting in turns",
      }),
    );
  });

  it("values stock at cost on interim certificates, carries the choice forward and certifies taking it back", async () => {
    // Independent of the valuation code: KE-VAL-1 percentages, half away from zero.
    const pct = (amount: number, percent: number) =>
      Math.sign(amount) * Math.floor((Math.abs(amount) * percent + 50) / 100);
    const today = nairobiDate();
    let onHand = 0;
    for (const store of storesResponseSchema
      .parse(ok(await owner.call("get", "stores")))
      .stores.filter((entry) => entry.project.id === projectId))
      onHand += storeDetailResponseSchema
        .parse(ok(await owner.call("get", `stores/${store.id}`)))
        .balances.filter((balance) => Number(balance.quantity) > 0)
        .reduce((sum, balance) => sum + balance.valueMinor, 0);
    expect(onHand).toBeGreaterThan(0);
    const valuation = (res: request.Response, status = 200) =>
      valuationResponseSchema.parse(ok(res, status)).valuation;
    const create = (body: object) =>
      pm.call("post", `projects/${projectId}/valuations`, {
        kind: "interim",
        valuationDate: today,
        ...body,
      });
    const certify = async (draft: ValuationDetail) => {
      const submitted = valuation(
        await pm.call("post", `valuations/${draft.id}/submit`, { version: draft.version }),
      );
      await fresh(owner);
      return valuation(
        await owner.call("post", `valuations/${submitted.id}/certify`, {
          version: submitted.version,
          digest: submitted.digest,
        }),
      );
    };

    // IPC-0001: the approved 10 m³ of column bases at the BQ rate (KES 16,500) and the stock at cost.
    const work = 16_500_000;
    const first = valuation(await create({ materialsFromStores: true }), 201);
    expect(first.materialsFromStores).toBe(true);
    const cap = pct(first.contractSum!.originalMinor, 5);
    const retention = Math.min(pct(work + onHand, 10), cap);
    const due = work + onHand - retention;
    const ipc1 = await certify(first);
    expect(ipc1.figures).toMatchObject({
      workDoneMinor: work,
      materialsGrossMinor: onHand,
      materialsMinor: onHand,
      grossMinor: work + onHand,
      retentionHeldMinor: retention,
      amountDueMinor: due,
      vatMinor: pct(due, 16),
    });
    expect(ipc1.lines.materials.every((line) => line.source === "stores")).toBe(true);

    // The next interim keeps the stock unless asked otherwise (valuations are cumulative).
    const carried = valuation(await create({}), 201);
    expect(carried.materialsFromStores).toBe(true);
    expect(carried.figures).toMatchObject({ materialsGrossMinor: onHand, amountDueMinor: 0 });
    valuation(
      await pm.call("post", `valuations/${carried.id}/cancel`, {
        version: carried.version,
        reason: "Nothing new to value",
      }),
    );

    // Leaving the stock out takes it back: a warned, negative certificate with negative VAT.
    const back = valuation(await create({ materialsFromStores: false }), 201);
    expect(back.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["materials-reduced", "negative-amount"]),
    );
    const ipc2 = await certify(back);
    const held = Math.min(pct(work, 10), cap);
    const takenBack = work - held - due;
    expect(takenBack).toBeLessThan(0);
    expect(ipc2.figures).toMatchObject({
      workDoneMinor: work,
      materialsGrossMinor: 0,
      grossMinor: work,
      retentionHeldMinor: held,
      previousCertifiedMinor: due,
      amountDueMinor: takenBack,
      vatMinor: pct(takenBack, 16),
      totalMinor: takenBack + pct(takenBack, 16),
    });
  });

  it("documents every stores operation in OpenAPI", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "listStores",
      "createStore",
      "getStore",
      "updateStore",
      "listStockLedger",
      "setReorderLevels",
      "getIssueOptions",
      "listTransferTargets",
      "getStoresSettings",
      "updateStoresSettings",
      "getConsumptionVariance",
      "listStockMovements",
      "createStockIssue",
      "createStockReturn",
      "recordWastage",
      "getStockMovement",
      "reverseStockMovement",
      "listStockTransfers",
      "dispatchStockTransfer",
      "getStockTransfer",
      "receiveStockTransfer",
      "resolveStockTransfer",
      "cancelStockTransfer",
      "listStockTakes",
      "createStockTake",
      "getStockTake",
      "recordStockCounts",
      "submitStockTake",
      "approveStockTake",
      "returnStockTake",
      "cancelStockTake",
      "listBuildupMaterials",
      "mapBuildupMaterial",
      "unmapBuildupMaterial",
      "listProgressMeasurements",
      "recordProgressMeasurement",
    ])
      expect(operations, id).toContain(id);
  });
});

function forItemOf(
  report: ReturnType<typeof varianceResponseSchema.parse>,
  lineageId: string,
  materialId: string,
) {
  return report.rows.find(
    (row) => row.bqItem.lineageId === lineageId && row.material?.id === materialId,
  );
}
