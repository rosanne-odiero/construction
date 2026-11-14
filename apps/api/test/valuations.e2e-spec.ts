import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import { BQ_ROUNDING, BQ_VAT_RULE } from "@pm-buddy/types";
import {
  approvalQueueResponseSchema,
  completionResponseSchema,
  contractSettingsResponseSchema,
  costToCompleteResponseSchema,
  earnedValueResponseSchema,
  measurementDetailResponseSchema,
  measurementItemsResponseSchema,
  measurementResponseSchema,
  measurementsResponseSchema,
  projectResponseSchema,
  projectValuationsResponseSchema,
  siteResponseSchema,
  sitePhotoResponseSchema,
  valuationResponseSchema,
  valuationsOverviewResponseSchema,
  budgetDetailResponseSchema,
  journalResponseSchema,
  type Measurement,
  type ValuationDetail,
} from "@pm-buddy/validation";
import { uuidv7 } from "../src/common/uuid.js";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { plainJpeg } from "./photo-fixtures.js";
import { Browser, notifications, origin } from "./support.js";
import { testDatabaseUrls } from "./test-database.js";

/**
 * D6.3 part A done-when, under the real runtime role (pmb_app, forced RLS): an interim payment
 * certificate generates correctly from measured progress. Hand-worked figures (KES minor units,
 * rule KE-VAL-1; the domain golden cases use the same BQ):
 *
 * BQ (approved baseline v1, excl. VAT): P1 site establishment lump sum 500,000.00; A concrete
 * 24 m³ @ 16,500 = 396,000.00; B blockwork 120 m² @ 1,450 = 174,000.00; PS1 provisional sum
 * 300,000.00 (never measured); D1 dayworks 100 hr @ 450 = 45,000.00. Original contract sum
 * 1,415,000.00. Settings: retention 10 % limited to 5 % of 1,415,000 = 70,750.00; VAT 16 %;
 * materials on site at 80 %; half released at practical completion.
 *
 * IPC-0001 (measured 90 days ago): P1 40 % = 200,000; A 10 m³ = 165,000; B 30.5 m² = 44,225;
 *   D1 12.5 hr = 5,625 → work 414,850.00; blocks on site 40,000 × 80 % = 32,000 → gross
 *   446,850.00; retention 44,685.00; advance +100,000.00 → net 502,165.00 = amount due;
 *   VAT 80,346.40; total 582,511.40.
 * IPC-0002 (70 days ago): P1 70 % = 350,000; A 24 m³ = 396,000; B 126 m² (over-measured, with a
 *   reason) = 182,700; D1 5,625 → gross 934,325.00; retention 93,432.50 limited to 70,750.00;
 *   recovery −50,000 (to date 50,000) → net 913,575.00; less 502,165.00 → due 411,410.00;
 *   VAT 65,825.60; total 477,235.60.
 * IPC-0003 practical-completion release: held 70,750 → 35,375 → due 35,375.00, VAT 5,660.00.
 * IPC-0004 final release: the remaining 35,375.00; retention held 0.
 * Synthetic data only.
 */
const today = nairobiDate();
const daysAgo = (days: number) => addCalendarDays(today, -days);
const SITE = { lat: -1.2921, lng: 36.8219 };

describe("Measurement and valuations (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let ownerB: Browser;
  let finance: Browser;
  let pm: Browser;
  let qs: Browser;
  let agent: Browser;
  let client: Browser;
  let supplierUser: Browser;
  let consultant: Browser;
  let tenantA: string;
  let projectId: string;
  let siteId: string;
  const item = { P1: "", A: "", B: "", PS1: "", D1: "" };
  const photos: string[] = [];
  let ipc1: ValuationDetail;
  let ipc2: ValuationDetail;

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
  const refused = (res: request.Response, status: number, code?: string) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    if (code) expect(problem(res)).toBe(code);
  };
  const context = (browser: Browser, tenantId = tenantA) => ({
    userId: browser.auth.user.id,
    tenantId,
    requestId: "d63-direct",
  });
  type Raw = { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> };
  const raw = (browser: Browser, work: (tx: Raw) => Promise<number>) =>
    db.run(context(browser), (tx) => work(tx as unknown as Raw));
  const base = () => `projects/${projectId}/measurements`;
  const measure = (browser: Browser, body: Record<string, unknown>) =>
    browser.call("post", base(), body);
  const record = async (browser: Browser, body: Record<string, unknown>) =>
    measurementResponseSchema.parse(ok(await measure(browser, body), 201)).measurement;
  const decide = async (browser: Browser, measurement: Measurement, action = "approve") =>
    browser.call(
      "post",
      `${base()}/${measurement.id}/${action}`,
      action === "reject" ? { reason: "Not measured on site (synthetic)" } : {},
    );
  const approved = async (browser: Browser, measurement: Measurement) =>
    measurementResponseSchema.parse(ok(await decide(browser, measurement))).measurement;
  const uploadPhoto = async (purpose?: "safety_incident") => {
    const upload = request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/photos`)
      .set("Cookie", [...agent.cookies].map(([key, value]) => `${key}=${value}`).join("; "))
      .set("Origin", origin)
      .set("X-CSRF-Token", agent.csrf)
      .field("siteId", siteId);
    if (purpose) upload.field("purpose", purpose);
    const res = await upload.attach("file", await plainJpeg(), "IMG_0001.jpg");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return sitePhotoResponseSchema.parse(res.body).photo.id;
  };
  const act = async (
    browser: Browser,
    v: ValuationDetail,
    path: string,
    body: Record<string, unknown> = {},
  ) => browser.call("post", `valuations/${v.id}${path}`, { version: v.version, ...body });
  const acted = async (
    browser: Browser,
    v: ValuationDetail,
    path: string,
    body: Record<string, unknown> = {},
  ) => valuationResponseSchema.parse(ok(await act(browser, v, path, body))).valuation;
  const certify = async (v: ValuationDetail) => {
    await fresh(finance);
    return acted(finance, v, "/certify", { digest: v.digest });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    db = app.get(TenantDatabase);
    vi.spyOn(app.get(AuthSecurity), "notify").mockImplementation(
      async (identifier, subject, text) => {
        notifications.set(identifier, [
          ...(notifications.get(identifier) ?? []),
          { subject, text },
        ]);
      },
    );
    owner = new Browser(app);
    ownerB = new Browser(app);
    finance = new Browser(app);
    pm = new Browser(app);
    qs = new Browser(app);
    agent = new Browser(app);
    client = new Browser(app);
    supplierUser = new Browser(app);
    consultant = new Browser(app);
    for (const browser of [owner, ownerB, finance, pm]) {
      await browser.register();
      await browser.enroll();
    }
    for (const browser of [qs, agent, client, supplierUser, consultant]) await browser.register();
    const a = await owner.call("post", "tenants", { name: "Valuations company A" });
    const b = await ownerB.call("post", "tenants", { name: "Valuations company B" });
    expect([a.status, b.status]).toEqual([201, 201]);
    tenantA = (a.body as { tenant: { id: string } }).tenant.id;
    await fresh(owner);
    projectId = projectResponseSchema.parse(
      ok(
        await owner.call("post", "projects", {
          name: "Valuations project (synthetic)",
          startDate: daysAgo(120),
          endDate: addCalendarDays(today, 200),
        }),
        201,
      ),
    ).project.id;
    siteId = siteResponseSchema.parse(
      ok(
        await owner.call("post", `projects/${projectId}/sites`, {
          name: "Main plot",
          geofence: { kind: "radius", center: SITE, radiusM: 200 },
        }),
        201,
      ),
    ).site.id;
    await join(finance, "finance", []);
    await join(pm, "project_manager", [projectId]);
    await join(qs, "quantity_surveyor", [projectId]);
    await join(agent, "site_agent", [projectId]);
    await join(client, "client", [projectId]);
    await join(supplierUser, "supplier", [projectId]);
    await join(consultant, "consultant", [projectId]);

    // The approved BQ, written by the owner and approved by the project manager (as the demo seed
    // does), so every figure above is exact.
    const bqId = uuidv7();
    const versionId = uuidv7();
    const bills = { prelims: uuidv7(), sub: uuidv7(), prov: uuidv7() };
    const rows = [
      [
        "P1",
        "prelims",
        "preliminary",
        "lump_sum",
        "Site establishment and hoarding",
        "item",
        null,
        null,
        50_000_000n,
      ],
      [
        "A",
        "sub",
        "measured",
        "computed",
        "Concrete class 25 in column bases",
        "m3",
        "24",
        "16500",
        39_600_000n,
      ],
      [
        "B",
        "sub",
        "measured",
        "computed",
        "Blockwork 200 mm in foundations",
        "m2",
        "120",
        "1450",
        17_400_000n,
      ],
      [
        "PS1",
        "prov",
        "provisional_sum",
        "lump_sum",
        "Provisional sum for landscaping",
        "item",
        null,
        null,
        30_000_000n,
      ],
      [
        "D1",
        "prov",
        "daywork",
        "computed",
        "Dayworks: general labour",
        "hr",
        "100",
        "450",
        4_500_000n,
      ],
    ] as const;
    await db.run(context(owner), async (tx) => {
      await tx.bq.create({
        data: { id: bqId, tenantId: tenantA, projectId, name: "BQ", createdBy: owner.auth.user.id },
      });
      await tx.bqVersion.create({
        data: {
          id: versionId,
          tenantId: tenantA,
          projectId,
          bqId,
          versionNo: 1,
          status: "draft",
          source: "import",
          vatRatePercent: BQ_VAT_RULE.defaultRatePercent,
          vatRuleKey: BQ_VAT_RULE.key,
          vatRuleStatus: BQ_VAT_RULE.status,
          rounding: BQ_ROUNDING,
          subtotalMinor: 141_500_000n,
          vatMinor: 22_640_000n,
          grandTotalMinor: 164_140_000n,
          billCount: 3,
          itemCount: 5,
          createdBy: owner.auth.user.id,
          updatedBy: owner.auth.user.id,
        },
      });
      const totals = { prelims: 50_000_000n, sub: 57_000_000n, prov: 34_500_000n };
      for (const [index, [key, title, kind]] of (
        [
          ["prelims", "Preliminaries", "preliminaries"],
          ["sub", "Substructure", "measured"],
          ["prov", "Provisional sums and dayworks", "provisional"],
        ] as const
      ).entries())
        await tx.bqBill.create({
          data: {
            id: bills[key],
            tenantId: tenantA,
            versionId,
            number: String(index + 1),
            title,
            kind,
            sortOrder: index,
            totalMinor: totals[key],
            sourceSheet: `Bill ${index + 1}`,
            lineageId: uuidv7(),
          },
        });
      for (const [
        index,
        [ref, bill, kind, source, description, unit, quantity, rate, amount],
      ] of rows.entries()) {
        const lineageId = uuidv7();
        item[ref] = lineageId;
        await tx.bqItem.create({
          data: {
            id: uuidv7(),
            tenantId: tenantA,
            versionId,
            billId: bills[bill],
            lineageId,
            ref,
            description: `${description} (synthetic)`,
            unit,
            unitRaw: unit,
            quantity,
            rate,
            amountMinor: amount,
            sheetAmountMinor: source === "lump_sum" ? amount : null,
            amountSource: source,
            kind,
            sortOrder: index,
          },
        });
      }
    });
    await db.run(context(pm), (tx) =>
      tx.bqVersion.updateMany({
        where: { tenantId: tenantA, id: versionId, status: "draft" },
        data: {
          status: "approved",
          approvedBy: pm.auth.user.id,
          approvedAt: new Date(),
          version: { increment: 1 },
        },
      }),
    );
    for (let index = 0; index < 4; index += 1) photos.push(await uploadPhoto());
  }, 300_000);

  afterAll(async () => {
    await app?.close();
  });

  it("documents every D6.3 operation in OpenAPI", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "listProgressMeasurements",
      "listMeasurementItems",
      "recordProgressMeasurement",
      "getProgressMeasurement",
      "addMeasurementPhotos",
      "approveProgressMeasurement",
      "rejectProgressMeasurement",
      "listPendingMeasurements",
      "listProjectValuations",
      "createValuation",
      "updateContractSettings",
      "getEarnedValue",
      "getCostToComplete",
      "listValuationProjects",
      "getValuation",
      "updateValuation",
      "addValuationMaterial",
      "removeValuationMaterial",
      "addValuationAdjustment",
      "removeValuationAdjustment",
      "submitValuation",
      "certifyValuation",
      "returnValuation",
      "cancelValuation",
      "exportValuationPdf",
      "exportValuationExcel",
    ])
      expect(operations, id).toContain(id);
  });

  it("records measurements with evidence, refuses what cannot be measured, and reviews them independently", async () => {
    const on = daysAgo(90);
    // Not measured: provisional sums; a lump sum above 100 %; above the BQ quantity without a reason.
    refused(
      await measure(agent, { bqItemLineageId: item.PS1, measuredOn: on, quantityToDate: "50" }),
      422,
      "item-not-measurable",
    );
    refused(
      await measure(agent, { bqItemLineageId: item.P1, measuredOn: on, quantityToDate: "100.5" }),
      422,
      "percent-over-100",
    );
    refused(
      await measure(agent, { bqItemLineageId: item.A, measuredOn: on, quantityToDate: "30" }),
      422,
      "over-measure-reason-required",
    );
    refused(
      await measure(agent, {
        bqItemLineageId: item.A,
        measuredOn: addCalendarDays(today, 1),
        quantityToDate: "1",
      }),
      400,
      "measurement-future",
    );
    // Clients, suppliers and consultants neither record nor read measurements.
    for (const outsider of [client, supplierUser, consultant]) {
      refused(
        await outsider.call("post", base(), {
          bqItemLineageId: item.A,
          measuredOn: on,
          quantityToDate: "1",
        }),
        403,
      );
      refused(await outsider.call("get", base()), 403);
    }

    // The site agent measures (offline-ready: client ID + Idempotency-Key, replay returns it).
    const key = randomUUID();
    const body = {
      id: randomUUID(),
      bqItemLineageId: item.P1,
      measuredOn: on,
      quantityToDate: "40",
      photoIds: [photos[0]],
    };
    const first = await agent.call("post", base(), body, true, { "Idempotency-Key": key });
    const p1 = measurementResponseSchema.parse(ok(first, 201));
    expect(p1).toMatchObject({
      replayed: false,
      measurement: {
        state: "pending",
        basis: "percent",
        valueMinor: 20_000_000,
        percentComplete: "40.0",
      },
    });
    const replay = await agent.call("post", base(), body, true, { "Idempotency-Key": key });
    expect(measurementResponseSchema.parse(ok(replay, 201))).toMatchObject({
      replayed: true,
      measurement: { id: body.id },
    });
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    refused(
      await agent.call("post", base(), { ...body, quantityToDate: "41" }, true, {
        "Idempotency-Key": key,
      }),
      409,
      "idempotency-key-reused",
    );
    // An incident photo (D8.2, restricted to safety readers) is never measurement evidence.
    const incidentPhoto = await uploadPhoto("safety_incident");
    refused(
      await measure(agent, {
        bqItemLineageId: item.A,
        measuredOn: on,
        quantityToDate: "1",
        photoIds: [incidentPhoto],
      }),
      422,
      "photo-not-in-project",
    );
    await expect(
      raw(
        agent,
        (tx) => tx.$executeRaw`
          INSERT INTO progress_measurement_photos (tenant_id, project_id, measurement_id, photo_id,
            added_by)
          VALUES (${tenantA}::uuid, ${projectId}::uuid, ${p1.measurement.id}::uuid,
            ${incidentPhoto}::uuid, ${agent.auth.user.id}::uuid)`,
      ),
    ).rejects.toThrow(/general site photo/);

    // A wrong figure corrected before review: the original is withdrawn, the correction counts.
    const wrong = await record(agent, {
      bqItemLineageId: item.A,
      measuredOn: on,
      quantityToDate: "10.5",
      photoIds: [photos[1]],
    });
    refused(
      await agent.call("post", base(), {
        bqItemLineageId: item.A,
        measuredOn: daysAgo(89),
        quantityToDate: "10",
        correctsMeasurementId: wrong.id,
        correctionReason: "Typed 10.5 instead of 10",
      }),
      422,
      "correction-date-mismatch",
    );
    const a = await record(agent, {
      bqItemLineageId: item.A,
      measuredOn: on,
      quantityToDate: "10",
      correctsMeasurementId: wrong.id,
      correctionReason: "Typed 10.5 instead of 10",
      photoIds: [photos[1]],
    });
    refused(await decide(qs, wrong), 409, "measurement-not-pending");

    // Evidence is required before approval, and nobody reviews their own measurement.
    const b = await record(agent, {
      bqItemLineageId: item.B,
      measuredOn: on,
      quantityToDate: "30.5",
    });
    refused(await decide(qs, b), 409, "measurement-evidence-required");
    ok(await agent.call("post", `${base()}/${b.id}/photos`, { photoIds: [photos[2]] }));
    const d1 = await record(qs, {
      bqItemLineageId: item.D1,
      measuredOn: on,
      quantityToDate: "12.5",
      photoIds: [photos[3]],
    });
    refused(await decide(qs, d1), 403, "maker-checker");
    // The site agent cannot approve (no bq.edit); the database repeats maker-checker.
    refused(await decide(agent, p1.measurement), 403);
    await expect(
      raw(
        qs,
        (tx) => tx.$executeRaw`INSERT INTO progress_measurement_reviews (id, tenant_id,
        project_id, measurement_id, decision, decided_by)
        VALUES (gen_random_uuid(), ${tenantA}::uuid, ${projectId}::uuid, ${d1.id}::uuid,
                'approved', ${qs.auth.user.id}::uuid)`,
      ),
    ).rejects.toThrow(/other than its measurer/);

    // A rejected measurement never counts.
    const extra = await record(agent, {
      bqItemLineageId: item.A,
      measuredOn: daysAgo(88),
      quantityToDate: "11",
    });
    const rejected = measurementResponseSchema.parse(
      ok(await decide(qs, extra, "reject")),
    ).measurement;
    expect(rejected).toMatchObject({ state: "rejected", review: { decision: "rejected" } });

    for (const measurement of [p1.measurement, a, b]) await approved(qs, measurement);
    expect(await approved(pm, d1)).toMatchObject({ state: "approved", valueMinor: 562_500 });

    // A review never changes, even for the runtime role.
    await expect(
      raw(
        qs,
        (tx) => tx.$executeRaw`UPDATE progress_measurement_reviews SET decision = 'rejected'
        WHERE measurement_id = ${a.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);

    const sheet = measurementItemsResponseSchema.parse(
      ok(await agent.call("get", `${base()}/items`)),
    );
    expect(sheet.totals).toMatchObject({
      measurableMinor: 111_500_000,
      approvedValueMinor: 41_485_000,
      percentComplete: "37.2",
      pendingCount: 0,
    });
    expect(sheet.items.find((row) => row.item.lineageId === item.PS1)).toMatchObject({
      basis: null,
      approved: null,
    });
    const detail = measurementDetailResponseSchema.parse(
      ok(await agent.call("get", `${base()}/${a.id}`)),
    );
    expect(detail.history.map((entry) => entry.state)).toEqual([
      "rejected",
      "approved",
      "withdrawn",
    ]);
    const list = measurementsResponseSchema.parse(ok(await agent.call("get", base())));
    expect(list.permissions).toEqual({ canRecord: true, canApprove: false });
  });

  it("generates IPC-0001 from measured progress, certified independently on the digest seen", async () => {
    // Contract settings: finance only, versioned.
    refused(
      await qs.call("put", `projects/${projectId}/contract-settings`, {
        version: 0,
        retentionPercent: "10",
        retentionCapPercent: "5",
        vatPercent: "16",
        materialsPercent: "80",
        practicalReleasePercent: "50",
      }),
      403,
    );
    const settingsBody = {
      version: 0,
      retentionPercent: "10",
      retentionCapPercent: "5",
      vatPercent: "16",
      materialsPercent: "80",
      practicalReleasePercent: "50",
    };
    expect(
      contractSettingsResponseSchema.parse(
        ok(await finance.call("put", `projects/${projectId}/contract-settings`, settingsBody)),
      ).settings,
    ).toMatchObject({ version: 1, materialsPercent: "80", retentionCapPercent: "5" });
    refused(
      await finance.call("put", `projects/${projectId}/contract-settings`, settingsBody),
      409,
      "version-conflict",
    );

    // The QS prepares: blocks on site against B, an advance entered by the owner.
    refused(
      await agent.call("post", `projects/${projectId}/valuations`, {
        kind: "interim",
        valuationDate: daysAgo(85),
      }),
      403,
    );
    let draft = valuationResponseSchema.parse(
      ok(
        await qs.call("post", `projects/${projectId}/valuations`, {
          kind: "interim",
          valuationDate: daysAgo(85),
        }),
        201,
      ),
    ).valuation;
    expect(draft).toMatchObject({ number: "VAL-0001", status: "draft", preview: true });
    refused(
      await qs.call("post", `projects/${projectId}/valuations`, {
        kind: "interim",
        valuationDate: daysAgo(85),
      }),
      409,
      "valuation-open",
    );
    draft = await acted(qs, draft, "/materials", {
      bqItemLineageId: item.B,
      description: "Blocks delivered, not yet laid",
      unit: "nr",
      quantity: "400",
      amountMinor: 4_000_000,
    });
    refused(
      await act(qs, draft, "/materials", {
        bqItemLineageId: item.PS1,
        description: "Plants",
        quantity: "1",
        amountMinor: 100,
      }),
      422,
      "item-not-measurable",
    );
    draft = await acted(owner, draft, "/adjustments", {
      kind: "advance",
      description: "Mobilisation advance (synthetic)",
      amountMinor: 10_000_000,
    });
    expect(draft.figures).toMatchObject({ amountDueMinor: 50_216_500, workDoneMinor: 41_485_000 });

    let submitted = await acted(qs, draft, "/submit");
    expect(submitted).toMatchObject({ status: "submitted", preview: false, revision: 1 });
    expect(submitted.figures).toEqual({
      workDoneMinor: 41_485_000,
      materialsGrossMinor: 4_000_000,
      materialsMinor: 3_200_000,
      grossMinor: 44_685_000,
      retentionStage: "none",
      retentionCapMinor: 7_075_000,
      retentionComputedMinor: 4_468_500,
      retentionHeldMinor: 4_468_500,
      adjustmentsMinor: 10_000_000,
      adjustmentsToDateMinor: 10_000_000,
      netToDateMinor: 50_216_500,
      previousCertifiedMinor: 0,
      amountDueMinor: 50_216_500,
      vatMinor: 8_034_640,
      totalMinor: 58_251_140,
    });
    expect(submitted.contractSum).toEqual({
      originalMinor: 141_500_000,
      revisedMinor: 141_500_000,
      revisedVersionNo: 1,
    });
    expect(submitted.terms).toMatchObject({ settingsVersion: 1, ruleVersion: "KE-VAL-1" });
    expect(
      submitted.lines.items.map((line) => [
        line.bqItem.ref,
        line.toDateMinor,
        line.thisPeriodMinor,
      ]),
    ).toEqual([
      ["P1", 20_000_000, 20_000_000],
      ["A", 16_500_000, 16_500_000],
      ["B", 4_422_500, 4_422_500],
      ["D1", 562_500, 562_500],
    ]);
    expect(submitted.permissions).toMatchObject({ canEdit: false, canSubmit: false });

    // Maker-checker: the owner contributed (the advance), so cannot certify; step-up is needed.
    await fresh(owner);
    refused(
      await act(owner, submitted, "/certify", { digest: submitted.digest }),
      403,
      "maker-checker",
    );
    refused(await act(qs, submitted, "/certify", { digest: submitted.digest }), 403);
    await stale(finance);
    refused(
      await act(finance, submitted, "/certify", { digest: submitted.digest }),
      403,
      "step-up-required",
    );
    await fresh(finance);
    refused(
      await act(finance, submitted, "/certify", { digest: "0".repeat(64) }),
      409,
      "valuation-stale",
    );
    // The certifier sees exactly what was submitted: a settings change since makes it stale.
    ok(
      await finance.call("put", `projects/${projectId}/contract-settings`, {
        ...settingsBody,
        version: 1,
      }),
    );
    refused(
      await act(finance, submitted, "/certify", { digest: submitted.digest }),
      409,
      "valuation-stale",
    );
    // The runtime role cannot certify it behind the API either (a contributor, then a forgery).
    await expect(
      raw(
        owner,
        (tx) => tx.$executeRaw`UPDATE valuations SET status = 'certified',
        certified_by = ${owner.auth.user.id}::uuid, certificate_number = 1, version = version + 1
        WHERE id = ${submitted.id}::uuid`,
      ),
    ).rejects.toThrow(/other than those who prepared/);
    await expect(
      raw(
        finance,
        (tx) => tx.$executeRaw`UPDATE valuations SET status = 'certified',
        certified_by = ${finance.auth.user.id}::uuid, certificate_number = 1,
        amount_due_minor = amount_due_minor + 100, total_minor = total_minor + 100
        WHERE id = ${submitted.id}::uuid`,
      ),
    ).rejects.toThrow(/exactly as submitted|valuations_check/);
    const returned = await acted(finance, submitted, "/return", {
      reason: "Settings re-issued; resubmit",
    });
    expect(returned).toMatchObject({
      status: "draft",
      returnReason: "Settings re-issued; resubmit",
    });
    submitted = await acted(qs, returned, "/submit");
    expect(submitted).toMatchObject({ revision: 2, terms: { settingsVersion: 2 } });
    ipc1 = await certify(submitted);
    expect(ipc1).toMatchObject({
      status: "certified",
      certificateNumber: "IPC-0001",
      amountDueMinor: 50_216_500,
      totalMinor: 58_251_140,
      certifiedBy: { id: finance.auth.user.id },
    });

    // A certified certificate never changes and its lines are append-only, for everyone.
    await expect(
      raw(
        finance,
        (tx) =>
          tx.$executeRaw`UPDATE valuations SET notes = 'tampered' WHERE id = ${ipc1.id}::uuid`,
      ),
    ).rejects.toThrow(/certified valuation never changes/);
    await expect(
      raw(finance, (tx) => tx.$executeRaw`DELETE FROM valuations WHERE id = ${ipc1.id}::uuid`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      raw(
        finance,
        (tx) =>
          tx.$executeRaw`UPDATE valuation_lines SET amount_minor = 1 WHERE valuation_id = ${ipc1.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      raw(
        finance,
        (tx) => tx.$executeRaw`INSERT INTO valuation_lines (tenant_id, valuation_id,
        revision, line_no, kind, adjustment_kind, description, amount_minor)
        VALUES (${tenantA}::uuid, ${ipc1.id}::uuid, 2, 99, 'adjustment', 'other', 'Extra', 1)`,
      ),
    ).rejects.toThrow(/only with their submission/);
    const schemaOwner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrls().migrationUrl }),
    });
    try {
      for (const statement of [
        `UPDATE valuations SET amount_due_minor = 1 WHERE id = '${ipc1.id}'`,
        `DELETE FROM valuations WHERE id = '${ipc1.id}'`,
        `DELETE FROM valuation_lines WHERE valuation_id = '${ipc1.id}'`,
      ])
        await expect(
          schemaOwner.$transaction([
            schemaOwner.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantA}', true)`),
            schemaOwner.$executeRawUnsafe(statement),
          ]),
        ).rejects.toThrow(/never changes|never deleted|lines never change/);
    } finally {
      await schemaOwner.$disconnect();
    }
    refused(
      await act(finance, ipc1, "/cancel", { reason: "Try to cancel a certificate" }),
      409,
      "invalid-transition",
    );

    // The certificate as A4 PDF and Excel, for valuation readers only.
    const pdf = await finance.download(`valuations/${ipc1.id}/export/pdf?locale=sw`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    const xlsx = await qs.download(`valuations/${ipc1.id}/export/xlsx`);
    expect(xlsx.status).toBe(200);
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe("PK");
    expect((await client.download(`valuations/${ipc1.id}/export/pdf`)).status).toBe(403);
  });

  it("nets IPC-0002 off IPC-0001, limits retention, and refuses double-billed materials and over-recovery", async () => {
    const on = daysAgo(70);
    const p1 = await record(agent, {
      bqItemLineageId: item.P1,
      measuredOn: on,
      quantityToDate: "70",
      photoIds: [photos[0]],
    });
    const a = await record(agent, {
      bqItemLineageId: item.A,
      measuredOn: on,
      quantityToDate: "24",
      photoIds: [photos[1]],
    });
    const b = await record(agent, {
      bqItemLineageId: item.B,
      measuredOn: on,
      quantityToDate: "126",
      overMeasureReason: "Remeasured with the client's QS: extra wall to the septic tank",
      photoIds: [photos[2]],
    });
    expect(b).toMatchObject({
      overMeasured: true,
      valueMinor: 18_270_000,
      percentComplete: "105.0",
    });
    for (const measurement of [p1, a, b]) await approved(qs, measurement);

    let draft = valuationResponseSchema.parse(
      ok(
        await qs.call("post", `projects/${projectId}/valuations`, {
          kind: "interim",
          valuationDate: daysAgo(65),
        }),
        201,
      ),
    ).valuation;
    expect(draft.number).toBe("VAL-0002");
    // IPC-0001 had entered materials and no stock: the next draft keeps stores off, and warns that
    // valuing fewer materials than last time takes the difference back.
    expect(draft.materialsFromStores).toBe(false);
    expect(draft.warnings.map((warning) => warning.code)).toContain("materials-reduced");
    // The blocks are now built in: keeping them as materials on site would bill them twice.
    refused(
      await act(qs, draft, "/materials", {
        bqItemLineageId: item.B,
        description: "Blocks delivered, not yet laid",
        quantity: "400",
        amountMinor: 4_000_000,
      }),
      409,
      "materials-exceed-remaining",
    );
    // A line entered by mistake is removed (draft inputs are never edited).
    draft = await acted(qs, draft, "/materials", {
      bqItemLineageId: item.D1,
      description: "Hired compactor on site",
      quantity: "1",
      amountMinor: 100_000,
    });
    draft = valuationResponseSchema.parse(
      ok(
        await qs.call(
          "delete",
          `valuations/${draft.id}/materials/${draft.inputs.materials[0]!.id}?version=${draft.version}`,
        ),
      ),
    ).valuation;
    expect(draft.inputs.materials).toEqual([]);
    // Recovery may never exceed the advance (100,000.00).
    refused(
      await act(qs, draft, "/adjustments", {
        kind: "advance_recovery",
        description: "Recover the advance",
        amountMinor: -15_000_000,
      }),
      409,
      "recovery-exceeds-advance",
    );
    draft = await acted(qs, draft, "/adjustments", {
      kind: "other",
      description: "Entered by mistake",
      amountMinor: 1_000,
    });
    draft = valuationResponseSchema.parse(
      ok(
        await qs.call(
          "delete",
          `valuations/${draft.id}/adjustments/${draft.inputs.adjustments[0]!.id}?version=${draft.version}`,
        ),
      ),
    ).valuation;
    expect(draft.inputs.adjustments).toEqual([]);
    draft = await acted(qs, draft, "/adjustments", {
      kind: "advance_recovery",
      description: "Recover half the advance",
      amountMinor: -5_000_000,
    });
    const submitted = await acted(qs, draft, "/submit");
    ipc2 = await certify(submitted);
    expect(ipc2).toMatchObject({ certificateNumber: "IPC-0002", amountDueMinor: 41_141_000 });
    expect(ipc2.figures).toMatchObject({
      workDoneMinor: 93_432_500,
      materialsGrossMinor: 0,
      grossMinor: 93_432_500,
      retentionCapMinor: 7_075_000,
      retentionComputedMinor: 7_075_000,
      retentionHeldMinor: 7_075_000,
      adjustmentsToDateMinor: 5_000_000,
      netToDateMinor: 91_357_500,
      previousCertifiedMinor: 50_216_500,
      amountDueMinor: 41_141_000,
      vatMinor: 6_582_560,
      totalMinor: 47_723_560,
    });
    const lineOf = (ref: string) => ipc2.lines.items.find((line) => line.bqItem.ref === ref)!;
    expect(lineOf("B")).toMatchObject({
      overMeasured: true,
      previousMinor: 4_422_500,
      toDateMinor: 18_270_000,
      thisPeriodMinor: 13_847_500,
    });
    expect(lineOf("D1")).toMatchObject({ previousMinor: 562_500, thisPeriodMinor: 0 });
  });

  it("releases half the retention at practical completion and the rest at final completion", async () => {
    refused(
      await qs.call("post", `projects/${projectId}/valuations`, {
        kind: "retention_release",
        releaseStage: "practical",
        valuationDate: daysAgo(55),
      }),
      409,
      "completion-not-certified",
    );
    const completion = async (body: Record<string, unknown>) =>
      completionResponseSchema.parse(
        ok(await pm.call("post", `projects/${projectId}/quality/completion`, body), 201),
      );
    const certifyCompletion = async (id: string, version: number) =>
      ok(
        await agent.call("post", `projects/${projectId}/quality/completion/${id}/actions`, {
          version,
          action: "certify",
        }),
      );
    let view = await completion({ kind: "practical", completionDate: daysAgo(60), dlpMonths: 1 });
    await certifyCompletion(view.practical!.id, view.practical!.version);

    let release = valuationResponseSchema.parse(
      ok(
        await qs.call("post", `projects/${projectId}/valuations`, {
          kind: "retention_release",
          releaseStage: "practical",
          valuationDate: daysAgo(55),
        }),
        201,
      ),
    ).valuation;
    refused(
      await act(qs, release, "/adjustments", {
        kind: "other",
        description: "Not on a release",
        amountMinor: 1,
      }),
      409,
      "invalid-transition",
    );
    release = await certify(await acted(qs, release, "/submit"));
    expect(release).toMatchObject({ certificateNumber: "IPC-0003", amountDueMinor: 3_537_500 });
    expect(release.figures).toMatchObject({
      workDoneMinor: 93_432_500,
      retentionStage: "practical",
      retentionHeldMinor: 3_537_500,
      vatMinor: 566_000,
      totalMinor: 4_103_500,
    });
    refused(
      await qs.call("post", `projects/${projectId}/valuations`, {
        kind: "retention_release",
        releaseStage: "practical",
        valuationDate: today,
      }),
      409,
      "release-exists",
    );

    view = await completion({ kind: "final", completionDate: today });
    await certifyCompletion(view.final!.id, view.final!.version);
    let final = valuationResponseSchema.parse(
      ok(
        await qs.call("post", `projects/${projectId}/valuations`, {
          kind: "retention_release",
          releaseStage: "final",
          valuationDate: today,
        }),
        201,
      ),
    ).valuation;
    final = await certify(await acted(qs, final, "/submit"));
    expect(final).toMatchObject({ certificateNumber: "IPC-0004", amountDueMinor: 3_537_500 });
    expect(final.figures.retentionHeldMinor).toBe(0);

    const project = projectValuationsResponseSchema.parse(
      ok(await finance.call("get", `projects/${projectId}/valuations`)),
    );
    expect(project.retention).toMatchObject({
      heldMinor: 0,
      releasedMinor: 7_075_000,
      stage: "final",
    });
    expect(
      project.retention.ledger.map((entry) => [entry.certificateNumber, entry.movementMinor]),
    ).toEqual([
      ["IPC-0001", 4_468_500],
      ["IPC-0002", 2_606_500],
      ["IPC-0003", -3_537_500],
      ["IPC-0004", -3_537_500],
    ]);
    // Every certified amount adds up to the net valuation: 934,325 − 0 + 50,000 = 984,325.00.
    expect(project.certified).toMatchObject({ count: 4, amountDueMinor: 98_432_500 });
    expect(project.permissions.canRelease).toEqual({ practical: false, final: false });
  });

  it("reports earned value and cost to complete; undefined ratios stay unavailable", async () => {
    let evm = earnedValueResponseSchema.parse(
      ok(await finance.call("get", `projects/${projectId}/earned-value`)),
    );
    // BAC excludes the provisional sum: 500,000 + 396,000 + 174,000 + 45,000 = 1,115,000.00.
    expect(evm.figures).toMatchObject({
      bacMinor: 111_500_000,
      evMinor: 93_432_500,
      acMinor: 0,
      pvMinor: null,
      cpi: null,
      spi: null,
      eacMinor: null,
      percentComplete: "83.7",
    });
    expect(evm.values).toMatchObject({
      earnedMinor: 93_432_500,
      certifiedNetMinor: 98_432_500,
      invoicedMinor: null,
    });

    // 800,000.00 of cost on item A (a maker-checked journal), and a budget from the BQ.
    const journal = journalResponseSchema.parse(
      ok(
        await finance.call("post", "cost-journals", {
          projectId,
          reason: "Concrete subcontract cost (synthetic)",
          lines: [
            {
              measure: "accrued",
              category: "subcontract",
              bqItemLineageId: item.A,
              counterpartyKind: "other",
              counterpartyName: "Concrete gang (synthetic)",
              occurredOn: daysAgo(60),
              amountMinor: 80_000_000,
            },
          ],
        }),
        201,
      ),
    );
    await fresh(owner);
    ok(
      await owner.call("post", `cost-journals/${journal.journal.id}/approve`, {
        version: journal.journal.version,
      }),
    );
    let budget = budgetDetailResponseSchema.parse(
      ok(
        await pm.call("post", "budgets", { projectId, name: "Budget from BQ", source: "bq" }),
        201,
      ),
    );
    budget = budgetDetailResponseSchema.parse(
      ok(
        await pm.call("post", `budgets/${budget.budget.id}/submit`, {
          version: budget.budget.version,
        }),
      ),
    );
    await fresh(finance);
    ok(
      await finance.call("post", `budgets/${budget.budget.id}/approve`, {
        version: budget.budget.version,
        digest: budget.budget.digest,
      }),
    );

    // A baseline with one task linked to item A; the other measured items spread over it.
    await fresh(pm);
    ok(
      await pm.call("post", `projects/${projectId}/schedule/activities`, {
        code: "S01",
        name: "Column bases",
        bqItemLineageId: item.A,
        durationDays: 5,
      }),
      201,
    );
    ok(
      await pm.call("post", `projects/${projectId}/schedule/baselines`, {
        name: "Contract programme",
        reason: "Agreed with the client (synthetic)",
      }),
      201,
    );

    evm = earnedValueResponseSchema.parse(
      ok(await qs.call("get", `projects/${projectId}/earned-value`)),
    );
    // AC 800,000; CPI 934,325 ÷ 800,000 = 1.17; EAC = 1,115,000 × 800,000 ÷ 934,325 = 954,699.92;
    // ETC 154,699.92; VAC 160,300.08 (the forecast margin at contract rates).
    expect(evm.figures).toMatchObject({
      acMinor: 80_000_000,
      cvMinor: 13_432_500,
      cpi: "1.17",
      eacMinor: 95_469_992,
      etcMinor: 15_469_992,
      vacMinor: 16_030_008,
    });
    expect(evm.baseline).not.toBeNull();
    expect(evm.notes).toMatchObject({ itemsLinkedToBaseline: 1, itemsSpreadOverBaseline: 3 });
    expect(evm.figures.pvMinor).not.toBeNull();
    expect(evm.figures.spi).not.toBeNull();
    expect(evm.curve.at(-1)!.pvMinor).toBe(111_500_000);
    expect(evm.curve.filter((point) => point.evMinor !== null).at(-1)!.evMinor).toBe(93_432_500);

    const cost = costToCompleteResponseSchema.parse(
      ok(await finance.call("get", `projects/${projectId}/cost-to-complete`)),
    );
    const substructure = cost.bills.find((bill) => bill.bill.title === "Substructure")!;
    // Bill: contract 570,000; EV 578,700; budget 570,000; actual 800,000 → earned 578,700,
    // CPI 0.72, nothing left to spend: ETC 0, EAC 800,000, VAC −230,000.
    expect(substructure).toMatchObject({
      contractMinor: 57_000_000,
      evMinor: 57_870_000,
      budgetMinor: 57_000_000,
      actualMinor: 80_000_000,
      earnedBudgetMinor: 57_870_000,
      cpi: "0.72",
      etcMinor: 0,
      eacMinor: 80_000_000,
      vacMinor: -23_000_000,
      basis: "cpi",
    });
    const items = costToCompleteResponseSchema.parse(
      ok(
        await finance.call(
          "get",
          `projects/${projectId}/cost-to-complete?billLineageId=${substructure.bill.lineageId}`,
        ),
      ),
    );
    expect(items.items.find((row) => row.item.ref === "A")).toMatchObject({
      percentComplete: "100.0",
      earnedBudgetMinor: 39_600_000,
      cpi: "0.50",
      etcMinor: 0,
      vacMinor: -40_400_000,
    });
  });

  it("keeps clients, suppliers, consultants, site agents and other companies out of certificates", async () => {
    for (const outsider of [client, supplierUser, consultant, agent]) {
      refused(await outsider.call("get", `projects/${projectId}/valuations`), 403);
      refused(await outsider.call("get", `valuations/${ipc1.id}`), 403);
      refused(await outsider.call("get", `projects/${projectId}/earned-value`), 403);
      refused(await outsider.call("get", `projects/${projectId}/cost-to-complete`), 403);
      refused(await act(outsider, ipc2, "/certify", { digest: ipc2.digest }), 403);
    }
    // The QS reads certificates and earned value but never certifies.
    ok(await qs.call("get", `valuations/${ipc1.id}`));
    // Another company sees nothing: 404, never 403.
    refused(await ownerB.call("get", `valuations/${ipc1.id}`), 404);
    refused(await ownerB.call("get", `projects/${projectId}/valuations`), 404);
    refused(await ownerB.call("get", `projects/${projectId}/earned-value`), 404);
    refused(await ownerB.call("get", `projects/${projectId}/measurements`), 404);
    const overviewB = valuationsOverviewResponseSchema.parse(
      ok(await ownerB.call("get", "valuations")),
    );
    expect(overviewB.projects).toEqual([]);
    // The site agent sees the project to measure, without certificate figures.
    const overview = valuationsOverviewResponseSchema.parse(
      ok(await agent.call("get", "valuations")),
    );
    expect(overview.projects).toEqual([
      expect.objectContaining({
        canReadValuations: false,
        canMeasure: true,
        certifiedMinor: null,
        latestCertificate: null,
      }),
    ]);
    const queue = approvalQueueResponseSchema.parse(
      ok(await qs.call("get", "measurements/pending")),
    );
    expect(queue.entries).toEqual([]);
    // Audit events carry IDs, numbers and counts, never amounts or free text.
    const events = await db.run(context(owner), (tx) =>
      tx.auditEvent.findMany({
        where: { tenantId: tenantA, action: { startsWith: "valuation." } },
        select: { action: true, metadata: true },
      }),
    );
    expect(events.length).toBeGreaterThan(10);
    for (const event of events) {
      const text = JSON.stringify(event.metadata);
      expect(text, event.action).not.toMatch(
        /Minor|amount|Mobilisation|Recover|Settings re-issued/,
      );
    }
  });
});
