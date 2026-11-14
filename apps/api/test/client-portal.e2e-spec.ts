import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import sharp from "sharp";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import { BQ_ROUNDING, BQ_VAT_RULE, portalFor } from "@pm-buddy/types";
import {
  clientDiariesResponseSchema,
  clientPayResponseSchema,
  cashFlowItemResponseSchema,
  clientPaymentsResponseSchema,
  clientPhotosResponseSchema,
  clientPortalOverviewResponseSchema,
  clientPortalProjectsResponseSchema,
  clientPreferencesResponseSchema,
  clientProgressResponseSchema,
  clientStatementResponseSchema,
  clientVariationDetailResponseSchema,
  clientVariationsResponseSchema,
  diaryResponseSchema,
  earnedValueResponseSchema,
  forecastResponseSchema,
  fxRatesResponseSchema,
  instructionResponseSchema,
  measurementResponseSchema,
  paymentInstructionsResponseSchema,
  projectResponseSchema,
  siteResponseSchema,
  sitePhotoResponseSchema,
  valuationResponseSchema,
  variationClientResponseSchema,
  variationResponseSchema,
  type ClientPaymentsResponse,
  type ValuationDetail,
  type VariationDetail,
} from "@pm-buddy/validation";
import { uuidv7 } from "../src/common/uuid.js";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { jpegWithExif } from "./photo-fixtures.js";
import { Browser, notifications, origin } from "./support.js";
import { testDatabaseUrls } from "./test-database.js";

/**
 * D7.1 client portal end to end under the real runtime role (pmb_app, forced RLS and the
 * restrictive client policies). Hand-worked figures (KES minor units, rule KE-VAL-1, default
 * contract settings: retention 10 % limited to 5 %, VAT 16 %):
 *
 * BQ (approved v1, excl. VAT): P1 site establishment lump sum 500,000.00; A concrete 24 m³ @
 * 16,500 = 396,000.00 → BAC 896,000.00. Measured: P1 40 % = 200,000; A 10 m³ = 165,000 → EV
 * 365,000.00 = 40.7 % of BAC (no baseline: planned "not available").
 * IPC-0001: work 365,000.00; retention 36,500.00 (limit 44,800); amount due 328,500.00; VAT
 * 52,560.00; total 381,060.00, certified under 30 days' terms → due 30 days after certification.
 * Receipt KES 200,000.00 (M-Pesa Paybill) → outstanding 181,060.00.
 * Synthetic data only.
 */
const today = nairobiDate();
const daysAgo = (days: number) => addCalendarDays(today, -days);
const SITE = { lat: -1.2921, lng: 36.8219 };
const HOUR = 3_600_000;
const exifTime = (date: Date) =>
  new Date(date.getTime() + 3 * HOUR)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ")
    .replace(/-/g, ":");

type Tx = {
  $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number>;
  $queryRaw: <T>(s: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
};

describe("Client portal (real runtime role)", () => {
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
  let clientTwo: Browser;
  let clientB: Browser;
  let tenantA: string;
  let tenantB: string;
  let projectId: string;
  let projectCode: string;
  let otherProjectId: string;
  let projectB: string;
  let siteId: string;
  const item = { P1: "", A: "" };
  let billLineage = "";
  let ipc1: ValuationDetail;
  let draft2: ValuationDetail;
  const photos = { verified: "", unverified: "", incident: "", other: "" };
  let approvedDiary = "";
  let draftDiary = "";
  let receiptId = "";

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
    requestId: "d71-direct",
  });
  const asUser = <T>(browser: Browser, work: (tx: Tx) => Promise<T>, tenantId = tenantA) =>
    db.run(context(browser, tenantId), work as never) as Promise<T>;
  const join = async (
    inviter: Browser,
    member: Browser,
    role: string,
    projectIds: string[],
    tenantId = tenantA,
  ) => {
    await fresh(inviter);
    ok(
      await inviter.call("post", "tenants/current/invitations", {
        identifier: member.identifier,
        role,
        projectIds,
      }),
      201,
    );
    const token = notifications
      .get(member.identifier)
      ?.at(-1)
      ?.text.match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
    ok(await member.call("post", "tenants/invitations/accept", { token }));
    ok(await member.call("post", `tenants/${tenantId}/select`, {}));
  };
  const portal = (path = "") => `portal/client/projects/${projectId}${path}`;
  const download = async (browser: Browser, path: string) => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/${path}`)
      .set("Cookie", [...browser.cookies].map(([key, value]) => `${key}=${value}`).join("; "))
      .set("Origin", origin)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    return res;
  };
  const upload = async (
    project: string,
    site: string,
    content: Buffer,
    caption: string,
    purpose?: "safety_incident",
  ) => {
    const res = await agent.upload(`projects/${project}/photos`, content, "IMG_0001.jpg", {
      siteId: site,
      caption,
      ...(purpose ? { purpose } : {}),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return sitePhotoResponseSchema.parse(res.body).photo;
  };
  const recordReceipt = (
    browser: Browser,
    body: Record<string, unknown>,
    key: string = `receipt-${randomUUID()}`,
  ) =>
    browser.call("post", `projects/${projectId}/client-payments`, body, true, {
      "Idempotency-Key": key,
    });
  const receiptBody = (overrides: Record<string, unknown> = {}) => ({
    id: uuidv7(),
    valuationId: ipc1.id,
    amountMinor: 20_000_000,
    receivedOn: today,
    method: "mpesa_paybill",
    reference: "SKD7Q3X9ZT",
    note: "Internal: matched on the M-Pesa statement line 14",
    ...overrides,
  });
  const vbase = () => `projects/${projectId}/bq`;
  const variation = (res: request.Response) => variationResponseSchema.parse(ok(res)).variation;
  const submitVariation = async (title: string, ref: string) => {
    const instruction = instructionResponseSchema.parse(
      ok(
        await qs.call("post", `${vbase()}/instructions`, {
          number: `AI-${ref}`,
          issuedOn: today,
          issuerName: "Arch. Wanjiku Mbugua (synthetic)",
          issuerRole: "architect",
          subject: `Instruction ${ref} (synthetic)`,
        }),
        201,
      ),
    ).instruction;
    let detail = variationResponseSchema.parse(
      ok(
        await qs.call("post", `${vbase()}/variations`, { instructionId: instruction.id, title }),
        201,
      ),
    ).variation;
    detail = variation(
      await qs.call("put", `${vbase()}/variations/${detail.id}/lines`, {
        version: detail.version,
        lines: [
          {
            action: "add",
            billLineageId: billLineage,
            newSection: { title: "Variations" },
            ref,
            description: "Parking slab 150 mm (synthetic)",
            unit: "m2",
            kind: "measured",
            quantity: "40",
            rate: "2850",
            note: "INTERNAL-NOTE: margin on this rate is thin",
          },
        ],
      }),
    );
    return variation(
      await qs.call("post", `${vbase()}/variations/${detail.id}/submit`, {
        version: detail.version,
      }),
    );
  };
  const send = (browser: Browser, target: VariationDetail, message?: string) =>
    browser.call("post", `${vbase()}/variations/${target.id}/client`, {
      version: target.version,
      snapshotDigest: target.snapshot!.digest,
      ...(message ? { message } : {}),
    });

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
    clientTwo = new Browser(app);
    clientB = new Browser(app);
    for (const browser of [owner, ownerB, finance, pm]) {
      await browser.register();
      await browser.enroll();
    }
    for (const browser of [qs, agent, client, clientTwo, clientB]) await browser.register();
    const a = await owner.call("post", "tenants", { name: "Client portal company A" });
    const b = await ownerB.call("post", "tenants", { name: "Client portal company B" });
    tenantA = (a.body as { tenant: { id: string } }).tenant.id;
    tenantB = (b.body as { tenant: { id: string } }).tenant.id;
    await fresh(owner);
    const created = projectResponseSchema.parse(
      ok(
        await owner.call("post", "projects", {
          name: "Client portal project (synthetic)",
          clientName: "Mavuno Homes Ltd (synthetic)",
          startDate: daysAgo(60),
          endDate: addCalendarDays(today, 200),
        }),
        201,
      ),
    ).project;
    projectId = created.id;
    projectCode = created.code;
    otherProjectId = projectResponseSchema.parse(
      ok(await owner.call("post", "projects", { name: "Second project (synthetic)" }), 201),
    ).project.id;
    await fresh(ownerB);
    projectB = projectResponseSchema.parse(
      ok(await ownerB.call("post", "projects", { name: "Company B project (synthetic)" }), 201),
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
    const otherSite = siteResponseSchema.parse(
      ok(
        await owner.call("post", `projects/${otherProjectId}/sites`, {
          name: "Other plot",
          geofence: { kind: "radius", center: SITE, radiusM: 200 },
        }),
        201,
      ),
    ).site.id;
    await join(owner, finance, "finance", []);
    await join(owner, pm, "project_manager", [projectId, otherProjectId]);
    await join(owner, qs, "quantity_surveyor", [projectId]);
    await join(owner, agent, "site_agent", [projectId, otherProjectId]);
    await join(owner, client, "client", [projectId]);
    await join(owner, clientTwo, "client", [otherProjectId]);
    await join(ownerB, clientB, "client", [projectB], tenantB);

    // The approved BQ, written by the owner and approved by the project manager.
    const bqId = uuidv7();
    const versionId = uuidv7();
    billLineage = uuidv7();
    const bills = { prelims: uuidv7(), sub: uuidv7() };
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
          subtotalMinor: 89_600_000n,
          vatMinor: 14_336_000n,
          grandTotalMinor: 103_936_000n,
          billCount: 2,
          itemCount: 2,
          createdBy: owner.auth.user.id,
          updatedBy: owner.auth.user.id,
        },
      });
      await tx.bqBill.create({
        data: {
          id: bills.prelims,
          tenantId: tenantA,
          versionId,
          number: "1",
          title: "Preliminaries",
          kind: "preliminaries",
          sortOrder: 0,
          totalMinor: 50_000_000n,
          sourceSheet: "Bill 1",
          lineageId: uuidv7(),
        },
      });
      await tx.bqBill.create({
        data: {
          id: bills.sub,
          tenantId: tenantA,
          versionId,
          number: "2",
          title: "Substructure",
          kind: "measured",
          sortOrder: 1,
          totalMinor: 39_600_000n,
          sourceSheet: "Bill 2",
          lineageId: billLineage,
        },
      });
      item.P1 = uuidv7();
      item.A = uuidv7();
      await tx.bqItem.create({
        data: {
          id: uuidv7(),
          tenantId: tenantA,
          versionId,
          billId: bills.prelims,
          lineageId: item.P1,
          ref: "P1",
          description: "Site establishment and hoarding (synthetic)",
          unit: "item",
          unitRaw: "item",
          amountMinor: 50_000_000n,
          sheetAmountMinor: 50_000_000n,
          amountSource: "lump_sum",
          kind: "preliminary",
          sortOrder: 0,
        },
      });
      await tx.bqItem.create({
        data: {
          id: uuidv7(),
          tenantId: tenantA,
          versionId,
          billId: bills.sub,
          lineageId: item.A,
          ref: "A",
          description: "Concrete class 25 in column bases (synthetic)",
          unit: "m3",
          unitRaw: "m3",
          quantity: "24",
          rate: "16500",
          amountMinor: 39_600_000n,
          amountSource: "computed",
          kind: "measured",
          sortOrder: 1,
        },
      });
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

    // Photos: verified (GPS on site, taken an hour ago), unverified (no metadata), an incident
    // photo, and a photo of the other project.
    const verified = await upload(
      projectId,
      siteId,
      await jpegWithExif({
        ...SITE,
        original: exifTime(new Date(Date.now() - HOUR)),
        offset: "+03:00",
        make: "TestCam",
      }),
      "Column bases cast",
    );
    expect(verified.verified).toBe(true);
    photos.verified = verified.id;
    photos.unverified = (await upload(projectId, siteId, await jpegWithExif(), "Blockwork")).id;
    photos.incident = (
      await upload(projectId, siteId, await jpegWithExif(), "Injured hand", "safety_incident")
    ).id;
    photos.other = (await upload(otherProjectId, otherSite, await jpegWithExif(), "Other")).id;

    // Measured progress (approved by the project manager) and IPC-0001 under 30 days' terms.
    for (const [lineage, quantity] of [
      [item.P1, "40"],
      [item.A, "10"],
    ] as const) {
      const measured = measurementResponseSchema.parse(
        ok(
          await agent.call("post", `projects/${projectId}/measurements`, {
            bqItemLineageId: lineage,
            measuredOn: daysAgo(10),
            quantityToDate: quantity,
            photoIds: [photos.verified],
          }),
          201,
        ),
      ).measurement;
      ok(await pm.call("post", `projects/${projectId}/measurements/${measured.id}/approve`, {}));
    }
    ok(
      await pm.call("put", `projects/${projectId}/client-settings`, {
        version: 0,
        clientApprovalRequired: false,
        paymentTermsDays: 30,
      }),
    );
    let valuation = valuationResponseSchema.parse(
      ok(
        await qs.call("post", `projects/${projectId}/valuations`, {
          kind: "interim",
          valuationDate: daysAgo(5),
        }),
        201,
      ),
    ).valuation;
    valuation = valuationResponseSchema.parse(
      ok(
        await qs.call("post", `valuations/${valuation.id}/submit`, { version: valuation.version }),
      ),
    ).valuation;
    await fresh(finance);
    ipc1 = valuationResponseSchema.parse(
      ok(
        await finance.call("post", `valuations/${valuation.id}/certify`, {
          version: valuation.version,
          digest: valuation.digest,
        }),
      ),
    ).valuation;
    expect(ipc1.figures).toMatchObject({
      workDoneMinor: 36_500_000,
      retentionHeldMinor: 3_650_000,
      amountDueMinor: 32_850_000,
      vatMinor: 5_256_000,
      totalMinor: 38_106_000,
    });
    // A later valuation still in preparation: never shown to the client.
    draft2 = valuationResponseSchema.parse(
      ok(
        await qs.call("post", `projects/${projectId}/valuations`, {
          kind: "interim",
          valuationDate: today,
        }),
        201,
      ),
    ).valuation;

    // Diaries: one approved (manual count), one draft with an internal note.
    const diary = async (date: string, text: string) =>
      diaryResponseSchema.parse(
        ok(
          await agent.call("post", `projects/${projectId}/diaries`, {
            siteId,
            date,
            workPerformed: text,
            weather: "Dry",
            delays: null,
            workforceCount: 12,
          }),
          201,
        ),
      ).diary;
    const first = await diary(daysAgo(3), "Column bases cast and cured");
    ok(
      await agent.call("post", `projects/${projectId}/diaries/${first.id}/actions`, {
        action: "submit",
        version: 1,
      }),
    );
    ok(
      await pm.call("post", `projects/${projectId}/diaries/${first.id}/actions`, {
        action: "approve",
        version: 2,
      }),
    );
    approvedDiary = first.id;
    draftDiary = (await diary(daysAgo(2), "DRAFT-ONLY internal note about a subcontractor")).id;
  }, 300_000);

  afterAll(async () => {
    await app?.close();
  });

  it("documents every D7.1 operation in OpenAPI", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "listClientProjects",
      "getClientProject",
      "getClientProgress",
      "listClientPhotos",
      "getClientPhotoImage",
      "listClientDiaries",
      "getClientStatement",
      "exportClientStatementPdf",
      "exportClientStatementExcel",
      "getClientCertificatePdf",
      "getClientPayInstructions",
      "requestClientStkPush",
      "listClientVariations",
      "getClientVariation",
      "decideClientVariation",
      "getClientPreferences",
      "updateClientPreferences",
      "listClientPayments",
      "recordClientPayment",
      "reverseClientPayment",
      "exportStaffClientStatementPdf",
      "exportStaffClientStatementExcel",
      "updateClientSettings",
      "getVariationClientRequests",
      "sendVariationToClient",
      "getPaymentInstructions",
      "updatePaymentInstructions",
      "listFxRates",
      "createFxRate",
    ])
      expect(operations, id).toContain(id);
  });

  it("keeps Paybill instructions with config.manage and a fresh step-up, versioned and audited", async () => {
    const body = {
      version: 0,
      paybillNumber: "174379",
      tillNumber: null,
      accountName: "Client portal company A (sandbox)",
      accountFormat: "project_certificate",
      bankInstructions: null,
    };
    refused(await finance.call("put", "client-portal/payment-instructions", body), 403);
    await stale(owner);
    refused(
      await owner.call("put", "client-portal/payment-instructions", body),
      403,
      "step-up-required",
    );
    await fresh(owner);
    refused(
      await owner.call("put", "client-portal/payment-instructions", {
        ...body,
        paybillNumber: null,
      }),
      400,
    );
    const saved = paymentInstructionsResponseSchema.parse(
      ok(await owner.call("put", "client-portal/payment-instructions", body)),
    );
    expect(saved.instructions).toMatchObject({ version: 1, paybillNumber: "174379" });
    refused(
      await owner.call("put", "client-portal/payment-instructions", body),
      409,
      "version-conflict",
    );
    expect(
      paymentInstructionsResponseSchema.parse(
        ok(await finance.call("get", "client-portal/payment-instructions")),
      ).permissions.canEdit,
    ).toBe(false);
    refused(await client.call("get", "client-portal/payment-instructions"), 403);
    // The database keeps every version: no edit, no delete, and only the next version.
    await expect(
      asUser(
        owner,
        (tx) => tx.$executeRaw`UPDATE client_payment_instructions SET paybill_number = '999999'`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(
        owner,
        (tx) => tx.$executeRaw`INSERT INTO client_payment_instructions
          (tenant_id, version, paybill_number, account_name, account_format, created_by)
          VALUES (${tenantA}::uuid, 5, '123456', 'Skipped version', 'project',
            ${owner.auth.user.id}::uuid)`,
      ),
    ).rejects.toThrow(/next version/);
    const audit = await asUser(
      owner,
      (tx) => tx.$queryRaw<
        { metadata: Record<string, unknown> }[]
      >`SELECT metadata FROM audit_events
        WHERE action = 'client_portal.payment_instructions_changed'`,
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("174379");
  });

  it("DONE-WHEN: the client views progress, sees how to pay and the outstanding balance; STK Push is refused until D4.2", async () => {
    // Finance records a part payment against IPC-0001.
    const view = clientPaymentsResponseSchema.parse(
      ok(await recordReceipt(finance, receiptBody())),
    );
    receiptId = view.payments[0]!.id;
    expect(view.totals).toMatchObject({
      certifiedMinor: 38_106_000,
      receivedMinor: 20_000_000,
      outstandingMinor: 18_106_000,
    });

    const list = clientPortalProjectsResponseSchema.parse(
      ok(await client.call("get", "portal/client/projects")),
    );
    expect(list.projects.map((row) => row.id)).toEqual([projectId]);
    expect(list.projects[0]!.balance.outstandingMinor).toBe(18_106_000);

    const overview = clientPortalOverviewResponseSchema.parse(
      ok(await client.call("get", portal())),
    );
    expect(overview.progress).toMatchObject({
      percentComplete: "40.7",
      plannedPercent: null,
      variancePoints: null,
      bqVersionNo: 1,
    });
    const dueDate = addCalendarDays(today, 30);
    expect(overview.nextDue).toMatchObject({
      number: "IPC-0001",
      dueDate,
      outstandingMinor: 18_106_000,
      overdue: false,
    });

    const progress = clientProgressResponseSchema.parse(
      ok(await client.call("get", portal("/progress"))),
    );
    expect(progress.figures).toMatchObject({
      bacMinor: 89_600_000,
      evMinor: 36_500_000,
      pvMinor: null,
      percentComplete: "40.7",
      plannedPercent: null,
    });
    expect(progress.curve.at(-1)).toMatchObject({ evMinor: 36_500_000, earnedPercent: "40.7" });
    // The client's S-curve never carries cost (no AC, CPI or cost to complete).
    expect(JSON.stringify(progress)).not.toMatch(
      /"acMinor"|"cpi"|"etcMinor"|costToComplete|"actual/i,
    );

    const pay = clientPayResponseSchema.parse(ok(await client.call("get", portal("/pay"))));
    expect(pay.instructions).toMatchObject({ paybillNumber: "174379" });
    expect(pay.certificates).toEqual([
      expect.objectContaining({
        number: "IPC-0001",
        state: "part_paid",
        outstandingMinor: 18_106_000,
        accountReference: `${projectCode}-0001`,
      }),
    ]);
    expect(pay.stk).toEqual({ available: false, reason: "provider-not-connected" });
    const stk = (body: object, key = `stk-${randomUUID()}`) =>
      client.call("post", portal(`/certificates/${ipc1.id}/stk-push`), body, true, {
        "Idempotency-Key": key,
      });
    refused(
      await client.call("post", portal(`/certificates/${ipc1.id}/stk-push`), {
        amountMinor: 1_000_000,
        phone: "0712345678",
      }),
      400,
      "idempotency-key-required",
    );
    refused(
      await stk({ amountMinor: 18_106_001, phone: "0712345678" }),
      422,
      "amount-exceeds-outstanding",
    );
    refused(
      await stk({ amountMinor: 1_000_000, phone: "0712345678" }),
      503,
      "stk-push-unavailable",
    );
    refused(
      await client.call(
        "post",
        portal(`/certificates/${draft2.id}/stk-push`),
        {
          amountMinor: 1_000_000,
          phone: "0712345678",
        },
        true,
        { "Idempotency-Key": `stk-${randomUUID()}` },
      ),
      404,
    );
    // Nothing was stored or marked paid by the attempt.
    const after = clientStatementResponseSchema.parse(
      ok(await client.call("get", portal("/statement"))),
    );
    expect(after.totals.receivedMinor).toBe(20_000_000);
  });

  it("shows certified certificates only, with due dates from the terms in force at certification", async () => {
    // Later terms (7 days, client approval required) never move IPC-0001's due date.
    ok(
      await pm.call("put", `projects/${projectId}/client-settings`, {
        version: 1,
        clientApprovalRequired: true,
        paymentTermsDays: 7,
      }),
    );
    refused(
      await pm.call("put", `projects/${projectId}/client-settings`, {
        version: 1,
        clientApprovalRequired: true,
        paymentTermsDays: 7,
      }),
      409,
      "version-conflict",
    );
    refused(
      await finance.call("put", `projects/${projectId}/client-settings`, {
        version: 2,
        clientApprovalRequired: false,
        paymentTermsDays: 7,
      }),
      403,
    );
    const statement = clientStatementResponseSchema.parse(
      ok(await client.call("get", portal("/statement"))),
    );
    expect(statement.paymentTermsDays).toBe(7);
    expect(statement.certificates.map((row) => [row.number, row.dueDate, row.state])).toEqual([
      ["IPC-0001", addCalendarDays(today, 30), "part_paid"],
    ]);
    expect(statement.certificates[0]).toMatchObject({
      amountDueMinor: 32_850_000,
      vatPercent: "16",
      vatMinor: 5_256_000,
      totalMinor: 38_106_000,
      receivedMinor: 20_000_000,
      outstandingMinor: 18_106_000,
    });
    expect(statement.entries.map((entry) => [entry.kind, entry.balanceMinor])).toEqual([
      ["certificate", 38_106_000],
      ["receipt", 18_106_000],
    ]);
    // The client sees the receipt's method and reference, never the staff note or recorder.
    expect(statement.receipts[0]).toMatchObject({
      method: "mpesa_paybill",
      reference: "SKD7Q3X9ZT",
    });
    expect(JSON.stringify(statement)).not.toMatch(/Internal: matched|recordedBy/);
    expect(JSON.stringify(statement)).not.toContain(finance.auth.user.id);
    expect(JSON.stringify(statement)).not.toContain(draft2.id);

    const pdf = await download(client, portal(`/certificates/${ipc1.id}/pdf?locale=sw`));
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    expect((await download(client, portal(`/certificates/${draft2.id}/pdf`))).status).toBe(404);
    // The staff export stays staff-only.
    expect((await download(client, `valuations/${ipc1.id}/export/pdf`)).status).toBe(403);
  });

  it("records receipts once, append-only, never past what is outstanding, and reverses them with a reason", async () => {
    const key = `receipt-${randomUUID()}`;
    const body = receiptBody({ amountMinor: 1_000_000, reference: '=HYPERLINK("http://x")' });
    const first = clientPaymentsResponseSchema.parse(ok(await recordReceipt(finance, body, key)));
    // A replay returns the same view; another payload under the key is refused.
    const replay = clientPaymentsResponseSchema.parse(ok(await recordReceipt(finance, body, key)));
    expect(replay.payments).toHaveLength(first.payments.length);
    refused(
      await recordReceipt(finance, { ...body, amountMinor: 1_000_001 }, key),
      409,
      "idempotency-key-reused",
    );
    refused(await recordReceipt(finance, body), 409, "payment-id-conflict");
    refused(
      await recordReceipt(finance, receiptBody({ amountMinor: 17_106_001 })),
      409,
      "receipt-exceeds-outstanding",
    );
    refused(
      await recordReceipt(finance, receiptBody({ receivedOn: addCalendarDays(today, 1) })),
      422,
      "receipt-date-invalid",
    );
    refused(
      await recordReceipt(finance, receiptBody({ valuationId: draft2.id })),
      409,
      "certificate-not-certified",
    );
    refused(await recordReceipt(pm, receiptBody()), 403);
    refused(await recordReceipt(client, receiptBody()), 403);
    refused(
      await finance.call("post", `projects/${projectId}/client-payments`, receiptBody()),
      400,
      "idempotency-key-required",
    );

    const hyperlink = first.payments.find((row) => row.amountMinor === 1_000_000)!;
    const reverse = (paymentId: string, reason: string, key = `reverse-${randomUUID()}`) =>
      finance.call(
        "post",
        `projects/${projectId}/client-payments/${paymentId}/reverse`,
        { id: uuidv7(), reason },
        true,
        { "Idempotency-Key": key },
      );
    refused(await reverse(hyperlink.id, "x"), 400);
    const reversed = clientPaymentsResponseSchema.parse(
      ok(await reverse(hyperlink.id, "+cmd|' /C calc'!A0 entered twice")),
    );
    expect(reversed.payments.find((row) => row.id === hyperlink.id)?.reversed).toBe(true);
    expect(reversed.totals.receivedMinor).toBe(20_000_000);
    refused(await reverse(hyperlink.id, "Again"), 409, "receipt-already-reversed");
    const reversal = reversed.payments.find((row) => row.kind === "reversal")!;
    refused(await reverse(reversal.id, "Reversing a reversal"), 409, "receipt-not-reversible");

    // The database repeats every rule for the runtime role.
    await expect(
      asUser(finance, (tx) => tx.$executeRaw`UPDATE client_payments SET amount_minor = 1`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(finance, (tx) => tx.$executeRaw`DELETE FROM client_payments`),
    ).rejects.toThrow(/permission denied/);
    const insert = (
      by: Browser,
      valuationId: string,
      amount: bigint,
      extra: Partial<{
        kind: string;
        reverses: string | null;
        reason: string | null;
        method: string | null;
        reference: string | null;
        recordedBy: string;
      }> = {},
    ) =>
      asUser(
        by,
        (tx) => tx.$executeRaw`INSERT INTO client_payments (id, tenant_id, project_id, valuation_id,
          kind, reverses_id, amount_minor, received_on, method, reference, reason, idempotency_key,
          request_digest, recorded_by)
          VALUES (${uuidv7()}::uuid, ${tenantA}::uuid, ${projectId}::uuid, ${valuationId}::uuid,
            ${extra.kind ?? "receipt"}, ${extra.reverses ?? null}::uuid, ${amount}, ${today}::date,
            ${extra.method === undefined ? "bank" : extra.method}, ${extra.reference === undefined ? "FT-0001" : extra.reference},
            ${extra.reason ?? null}, ${`direct-${randomUUID()}`}, ${"a".repeat(64)},
            ${extra.recordedBy ?? by.auth.user.id}::uuid)`,
      );
    await expect(insert(finance, ipc1.id, 18_106_001n)).rejects.toThrow(/past its total/);
    await expect(insert(finance, draft2.id, 100n)).rejects.toThrow(/certified certificates/);
    await expect(
      insert(finance, ipc1.id, 100n, { recordedBy: owner.auth.user.id }),
    ).rejects.toThrow(/signed-in user/);
    await expect(
      insert(finance, ipc1.id, 999n, {
        kind: "reversal",
        reverses: receiptId,
        reason: "Wrong amount",
        method: null,
        reference: null,
      }),
    ).rejects.toThrow(/in full/);
    // A client never writes receipts, even by direct SQL.
    await expect(insert(client, ipc1.id, 100n)).rejects.toThrow(/row-level security/);

    // The audit log holds identifiers and codes only.
    const audit = await asUser(
      owner,
      (tx) => tx.$queryRaw<{ action: string; metadata: Record<string, unknown> }[]>`
        SELECT action, metadata FROM audit_events WHERE action LIKE 'client_payment.%'`,
    );
    expect(audit.map((row) => row.action).sort()).toEqual([
      "client_payment.recorded",
      "client_payment.recorded",
      "client_payment.reversed",
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/SKD7Q3X9ZT|HYPERLINK|calc|Internal|20000000/);
  });

  it("exports the client statement in EN and SW, with text cells neutralised against formula injection", async () => {
    const xlsx = await download(client, portal("/statement/export/xlsx?locale=en"));
    expect(xlsx.status).toBe(200);
    const book = XLSX.read(xlsx.body as Buffer, { type: "buffer" });
    const sheet = book.Sheets[book.SheetNames[0]!]!;
    const cells = Object.entries(sheet)
      .filter(([key]) => !key.startsWith("!"))
      .map(([, cell]) => cell as { t: string; v: unknown; f?: string });
    expect(cells.some((cell) => cell.f)).toBe(false);
    const texts = cells.filter((cell) => cell.t === "s").map((cell) => String(cell.v));
    expect(texts).toContain('\'=HYPERLINK("http://x")');
    expect(
      texts.some(
        (value) =>
          value.includes("'+cmd") || value.startsWith("Reversed: '+cmd") || value.includes("+cmd"),
      ),
    ).toBe(true);
    for (const value of texts) expect(value).not.toMatch(/^[=+\-@]/);
    expect(cells.find((cell) => cell.t === "n" && cell.v === 181_060)).toBeTruthy();
    const sw = await download(client, portal("/statement/export/pdf?locale=sw"));
    expect(sw.status).toBe(200);
    expect((sw.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    const staff = await download(finance, `projects/${projectId}/client-payments/statement/xlsx`);
    expect(staff.status).toBe(200);
    expect((await download(clientTwo, portal("/statement/export/xlsx"))).status).toBe(404);
    expect(
      (await download(client, `projects/${projectId}/client-payments/statement/pdf`)).status,
    ).toBe(403);
  });

  it("shows general photos only, newest first, with their checks and limitations; thumbnails without metadata", async () => {
    const page = clientPhotosResponseSchema.parse(
      ok(await client.call("get", portal("/photos?limit=1"))),
    );
    expect(page.photos.map((row) => row.id)).toEqual([photos.unverified]);
    expect(page.nextCursor).toBe(photos.unverified);
    expect(page.counts).toEqual({ total: 2, verified: 1 });
    const next = clientPhotosResponseSchema.parse(
      ok(await client.call("get", portal(`/photos?limit=1&cursor=${page.nextCursor}`))),
    );
    expect(next.photos.map((row) => [row.id, row.verified, row.checks.location])).toEqual([
      [photos.verified, true, "inside"],
    ]);
    expect(page.photos[0]).toMatchObject({
      verified: false,
      capturedAt: null,
      checks: { location: "missing", time: "missing" },
    });
    const text = JSON.stringify([page, next]);
    expect(text).not.toContain(photos.incident);
    expect(text).not.toMatch(/"lat"|"lng"|uploadedBy|sha256|agent/);
    expect(text).not.toMatch(/latitude|longitude|"gps|"exif/i);
    expect(text).not.toContain(agent.auth.user.id);

    const image = await download(client, portal(`/photos/${photos.verified}/image`));
    expect(image.status).toBe(200);
    expect(image.headers["content-type"]).toContain("image/jpeg");
    const meta = await sharp(image.body as Buffer).metadata();
    expect(meta.exif).toBeUndefined();
    for (const hidden of [photos.incident, photos.other, randomUUID()])
      expect((await download(client, portal(`/photos/${hidden}/image`))).status).toBe(404);
    // The office photo routes stay closed to clients.
    expect((await client.call("get", `projects/${projectId}/photos`)).status).toBe(403);
  });

  it("shows approved diaries only, with the workforce as a count and nobody's identity", async () => {
    const diaries = clientDiariesResponseSchema.parse(
      ok(await client.call("get", portal("/diaries"))),
    );
    expect(diaries.diaries.map((row) => row.id)).toEqual([approvedDiary]);
    expect(diaries.diaries[0]).toMatchObject({ workforceCount: 12, workforce: null });
    const text = JSON.stringify(diaries);
    expect(text).not.toContain(draftDiary);
    expect(text).not.toContain("DRAFT-ONLY");
    for (const person of [agent, pm]) expect(text).not.toContain(person.auth.user.id);
  });

  it("sends a submitted variation to the client, holds internal approval for the client's decision, and binds it to the figures sent", async () => {
    let target = await submitVariation("Visitor parking slab (synthetic)", "V1");
    // Internal approval waits for the client on this project (terms v2).
    await fresh(owner);
    const blocked = await owner.call("post", `${vbase()}/variations/${target.id}/approve`, {
      version: target.version,
      snapshotDigest: target.snapshot!.digest,
    });
    refused(blocked, 409, "client-approval-required");
    expect(
      variation(await owner.call("get", `${vbase()}/variations/${target.id}`)).permissions
        .approvalBlocker,
    ).toBe("client");
    // The database holds it too, whoever writes.
    await expect(
      asUser(
        owner,
        (tx) => tx.$executeRaw`UPDATE variation_orders SET status = 'approved',
          decided_by = ${owner.auth.user.id}::uuid, decided_at = now(), version = version + 1
          WHERE id = ${target.id}::uuid`,
      ),
    ).rejects.toThrow(/client's approval/);

    refused(await send(agent, target), 403);
    refused(
      await qs.call("post", `${vbase()}/variations/${target.id}/client`, {
        version: target.version,
        snapshotDigest: "0".repeat(64),
      }),
      409,
      "variation-stale",
    );
    const sent = variationClientResponseSchema.parse(
      ok(await send(qs, target, "Please review the parking slab (synthetic)")),
    );
    expect(sent).toMatchObject({
      approvalRequired: true,
      clientMembers: 1,
      currentDecision: null,
      permissions: { canSend: false, sendBlocker: "already-sent" },
    });
    refused(await send(qs, target), 409, "already-sent");

    const list = clientVariationsResponseSchema.parse(
      ok(await client.call("get", portal("/variations"))),
    );
    expect(list.requests).toHaveLength(1);
    const requestId = list.requests[0]!.id;
    const detail = clientVariationDetailResponseSchema.parse(
      ok(await client.call("get", portal(`/variations/${requestId}`))),
    );
    expect(detail.request).toMatchObject({
      state: "awaiting_decision",
      outcome: "in_review",
      canDecide: true,
      netMinor: 11_400_000,
      grandTotalEffectMinor: 13_224_000,
    });
    expect(detail.request.view.lines).toEqual([
      expect.objectContaining({
        action: "add",
        ref: "V1",
        unit: "m2",
        quantity: "40",
        rate: "2850",
        newAmountMinor: 11_400_000,
      }),
    ]);
    // What the variation shows, nothing internal: no line notes, build-ups or people.
    expect(JSON.stringify(detail)).not.toMatch(/INTERNAL-NOTE|buildup|contributors/);
    expect(JSON.stringify(detail)).not.toContain(qs.auth.user.id);
    // The client reaches variations only through the portal.
    refused(await client.call("get", `${vbase()}/variations`), 403, "client-portal-only");
    refused(
      await client.call("get", `${vbase()}/variations/${target.id}`),
      403,
      "client-portal-only",
    );
    refused(await client.call("get", `${vbase()}/instructions`), 403, "client-portal-only");
    refused(await client.call("get", "rate-buildups"), 403, "client-portal-only");
    refused(
      await client.call("get", `${vbase()}/variations/${target.id}/client`),
      403,
      "client-portal-only",
    );

    const decide = (browser: Browser, body: object) =>
      browser.call("post", portal(`/variations/${requestId}/decision`), body);
    refused(
      await decide(client, { decision: "approved", clientDigest: "0".repeat(64) }),
      409,
      "variation-stale",
    );
    refused(
      await decide(client, { decision: "rejected", clientDigest: detail.request.clientDigest }),
      400,
    );
    refused(
      await decide(owner, { decision: "approved", clientDigest: detail.request.clientDigest }),
      403,
      "client-portal-only",
    );
    refused(
      await decide(clientTwo, { decision: "approved", clientDigest: detail.request.clientDigest }),
      404,
    );
    // Staff cannot record a decision behind the API either: only the project's client decides.
    await expect(
      asUser(
        owner,
        (tx) => tx.$executeRaw`INSERT INTO variation_client_decisions (id, tenant_id, project_id,
          request_id, variation_id, decision, client_digest, decided_by)
          VALUES (${uuidv7()}::uuid, ${tenantA}::uuid, ${projectId}::uuid, ${requestId}::uuid,
            ${target.id}::uuid, 'approved', ${detail.request.clientDigest},
            ${owner.auth.user.id}::uuid)`,
      ),
    ).rejects.toThrow(/assigned to the project/);
    const decided = clientVariationDetailResponseSchema.parse(
      ok(
        await decide(client, {
          decision: "approved",
          comment: "Approved; please keep the gate clear (synthetic)",
          clientDigest: detail.request.clientDigest,
        }),
      ),
    );
    expect(decided.request).toMatchObject({ state: "approved", canDecide: false });
    refused(
      await decide(client, {
        decision: "rejected",
        comment: "Changed my mind",
        clientDigest: detail.request.clientDigest,
      }),
      409,
      "already-decided",
    );
    await expect(
      asUser(
        client,
        (tx) => tx.$executeRaw`UPDATE variation_client_decisions SET decision = 'rejected'`,
      ),
    ).rejects.toThrow(/permission denied/);

    // Now the contractor approves internally (someone who did not prepare it, with step-up).
    target = variation(await owner.call("get", `${vbase()}/variations/${target.id}`));
    expect(target.permissions.approvalBlocker).toBeNull();
    await fresh(owner);
    const approved = variation(
      await owner.call("post", `${vbase()}/variations/${target.id}/approve`, {
        version: target.version,
        snapshotDigest: target.snapshot!.digest,
      }),
    );
    expect(approved.status).toBe("approved");
    const staffView = variationClientResponseSchema.parse(
      ok(await pm.call("get", `${vbase()}/variations/${target.id}/client`)),
    );
    expect(staffView.requests[0]).toMatchObject({
      state: "approved",
      decision: { decision: "approved", decidedBy: { id: client.auth.user.id } },
    });
    const after = clientVariationsResponseSchema.parse(
      ok(await client.call("get", portal("/variations"))),
    );
    expect(after.requests[0]).toMatchObject({ state: "approved", outcome: "approved" });
    const audit = await asUser(
      owner,
      (tx) => tx.$queryRaw<
        { metadata: Record<string, unknown> }[]
      >`SELECT metadata FROM audit_events
        WHERE action = 'client_portal.variation_decided'`,
    );
    expect(audit[0]!.metadata).toMatchObject({ decision: "approved", commentGiven: true });
    expect(JSON.stringify(audit)).not.toContain("gate clear");
  });

  it("withdraws a sending the contractor decides first; the client can no longer decide it", async () => {
    // The new BQ version made the first approval; a variation on it is current again.
    const target = await submitVariation("Extra soak pit (synthetic)", "V2");
    ok(await send(pm, target));
    const list = clientVariationsResponseSchema.parse(
      ok(await client.call("get", portal("/variations"))),
    );
    const sending = list.requests.find((row) => row.title === "Extra soak pit (synthetic)")!;
    expect(sending.state).toBe("awaiting_decision");
    const detail = clientVariationDetailResponseSchema.parse(
      ok(await client.call("get", portal(`/variations/${sending.id}`))),
    );
    await fresh(owner);
    ok(
      await owner.call("post", `${vbase()}/variations/${target.id}/reject`, {
        version: target.version,
        snapshotDigest: target.snapshot!.digest,
        reason: "Not needed after all (synthetic)",
      }),
    );
    const withdrawn = clientVariationsResponseSchema
      .parse(ok(await client.call("get", portal("/variations"))))
      .requests.find((row) => row.id === sending.id)!;
    expect(withdrawn).toMatchObject({ state: "withdrawn", outcome: "rejected" });
    refused(
      await client.call("post", portal(`/variations/${sending.id}/decision`), {
        decision: "approved",
        clientDigest: detail.request.clientDigest,
      }),
      409,
      "request-closed",
    );
    // The internal rejection reason never reaches the client.
    expect(JSON.stringify(withdrawn)).not.toContain("Not needed after all");
  });

  it("keeps each client to its assigned projects — in the API (even with the policies relaxed) and in the database", async () => {
    const apiKeepsThemApart = async () => {
      for (const path of [
        "",
        "/progress",
        "/photos",
        "/diaries",
        "/statement",
        "/pay",
        "/variations",
        `/photos/${photos.verified}/image`,
        `/certificates/${ipc1.id}/pdf`,
      ])
        expect((await clientTwo.call("get", portal(path))).status, path).toBe(404);
      for (const browser of [clientTwo, clientB])
        expect(
          clientPortalProjectsResponseSchema
            .parse(ok(await browser.call("get", "portal/client/projects")))
            .projects.map((row) => row.id),
        ).not.toContain(projectId);
      expect((await clientB.call("get", portal())).status).toBe(404);
      // Within its own project, the API filters too: certified certificates, general photos.
      const statement = clientStatementResponseSchema.parse(
        ok(await client.call("get", portal("/statement"))),
      );
      expect(statement.certificates.map((row) => row.id)).toEqual([ipc1.id]);
      const all = clientPhotosResponseSchema.parse(ok(await client.call("get", portal("/photos"))));
      expect(all.photos.map((row) => row.id)).not.toContain(photos.incident);
      expect((await client.call("get", portal(`/photos/${photos.incident}/image`))).status).toBe(
        404,
      );
    };
    await apiKeepsThemApart();
    const schemaOwner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrls().migrationUrl }),
    });
    const policies = await schemaOwner.$queryRaw<
      { tablename: string; policyname: string; qual: string; with_check: string }[]
    >`SELECT tablename, policyname, qual, with_check FROM pg_policies
      WHERE policyname LIKE '%client_portal' AND permissive = 'RESTRICTIVE'`;
    expect(policies.length).toBeGreaterThanOrEqual(39);
    try {
      for (const policy of policies)
        await schemaOwner.$executeRawUnsafe(
          `ALTER POLICY "${policy.policyname}" ON "${policy.tablename}" USING (true) WITH CHECK (true)`,
        );
      await apiKeepsThemApart();
    } finally {
      for (const policy of policies)
        await schemaOwner.$executeRawUnsafe(
          `ALTER POLICY "${policy.policyname}" ON "${policy.tablename}" USING (${policy.qual}) WITH CHECK (${policy.with_check})`,
        );
      await schemaOwner.$disconnect();
    }

    // The database repeats it: as the runtime role, the client reads only its project's rows,
    // certified certificates, general photos, variations sent to it — and none of the company's
    // working records.
    const seen = await asUser(
      client,
      (tx) =>
        tx.$queryRaw<{ table: string; total: bigint }[]>`
        SELECT 'projects' AS table, count(*) AS total FROM projects
        UNION ALL SELECT 'sites', count(*) FROM sites
        UNION ALL SELECT 'valuations', count(*) FROM valuations
        UNION ALL SELECT 'site_photos', count(*) FROM site_photos
        UNION ALL SELECT 'variation_orders', count(*) FROM variation_orders
        UNION ALL SELECT 'variation_lines', count(*) FROM variation_lines
        UNION ALL SELECT 'instructions', count(*) FROM instructions
        UNION ALL SELECT 'cost_entries', count(*) FROM cost_entries
        UNION ALL SELECT 'progress_measurements', count(*) FROM progress_measurements
        UNION ALL SELECT 'client_payments', count(*) FROM client_payments`,
    );
    expect(Object.fromEntries(seen.map((row) => [row.table, Number(row.total)]))).toEqual({
      projects: 1,
      sites: 1,
      valuations: 1,
      site_photos: 2,
      variation_orders: 2,
      variation_lines: 0,
      instructions: 0,
      cost_entries: 0,
      progress_measurements: 2,
      client_payments: 3,
    });
    const staffSees = await asUser(
      owner,
      (tx) => tx.$queryRaw<
        { projects: bigint; photos: bigint; valuations: bigint; instructions: bigint }[]
      >`
        SELECT (SELECT count(*) FROM projects) AS projects,
          (SELECT count(*) FROM site_photos) AS photos,
          (SELECT count(*) FROM valuations) AS valuations,
          (SELECT count(*) FROM instructions) AS instructions`,
    );
    expect(staffSees[0]).toMatchObject({
      projects: 2n,
      photos: 4n,
      valuations: 2n,
      instructions: 2n,
    });
    // Another company's client sees nothing of company A even inside it.
    await expect(
      asUser(
        clientTwo,
        (tx) =>
          tx.$queryRaw<
            { total: bigint }[]
          >`SELECT count(*) AS total FROM projects WHERE id = ${projectId}::uuid`,
      ),
    ).resolves.toEqual([{ total: 0n }]);
    // A client never writes the company's records (WITH CHECK) — not even a variation decision for
    // a project it is not assigned to.
    await expect(
      asUser(
        client,
        (tx) => tx.$executeRaw`UPDATE projects SET name = 'Renamed' WHERE id = ${projectId}::uuid`,
      ),
    ).rejects.toThrow(/row-level security|permission denied/);
    // Staff and other roles are not restricted by the client policies.
    expect(portalFor(["projects.view", "bq.view", "portal.client"])).toBe("client");
    // A custom role made only of client permissions is a client too (portalFor): the database
    // gives it exactly what the client role sees — no instructions, variation lines, rate
    // build-ups or costs, and only the variations sent to the client.
    await fresh(owner);
    const role = ok(
      await owner.call("post", "tenants/current/roles", {
        name: "Client (custom, synthetic)",
        permissions: ["projects.view", "bq.view", "portal.client"],
      }),
      201,
    ) as { role: { id: string } };
    const customClient = new Browser(app);
    await customClient.register();
    await join(owner, customClient, role.role.id, [projectId]);
    const customSeen = await asUser(
      customClient,
      (tx) =>
        tx.$queryRaw<{ table: string; total: bigint }[]>`
        SELECT 'projects' AS table, count(*) AS total FROM projects
        UNION ALL SELECT 'valuations', count(*) FROM valuations
        UNION ALL SELECT 'variation_orders', count(*) FROM variation_orders
        UNION ALL SELECT 'variation_lines', count(*) FROM variation_lines
        UNION ALL SELECT 'instructions', count(*) FROM instructions
        UNION ALL SELECT 'bq_item_rate_links', count(*) FROM bq_item_rate_links
        UNION ALL SELECT 'cost_entries', count(*) FROM cost_entries`,
    );
    expect(Object.fromEntries(customSeen.map((row) => [row.table, Number(row.total)]))).toEqual({
      projects: 1,
      valuations: 1,
      variation_orders: 2,
      variation_lines: 0,
      instructions: 0,
      bq_item_rate_links: 0,
      cost_entries: 0,
    });
  });

  it("converts amounts for display only, from dated rates finance entered, and keeps every document in KES", async () => {
    refused(
      await pm.call("post", "client-portal/fx-rates", {
        currency: "GBP",
        kesPerUnit: "170.10",
        rateDate: today,
        source: "Synthetic",
      }),
      403,
    );
    refused(
      await finance.call("post", "client-portal/fx-rates", {
        currency: "GBP",
        kesPerUnit: "170.10",
        rateDate: addCalendarDays(today, 1),
        source: "Synthetic",
      }),
      422,
      "fx-rate-invalid",
    );
    refused(
      await finance.call("post", "client-portal/fx-rates", {
        currency: "GBP",
        kesPerUnit: "0.5",
        rateDate: today,
        source: "Synthetic",
      }),
      400,
    );
    // An old USD rate (40 days) is never shown; today's GBP rate is.
    for (const [currency, kesPerUnit, rateDate] of [
      ["USD", "129.45", daysAgo(40)],
      ["GBP", "170.10", today],
    ] as const)
      ok(
        await finance.call("post", "client-portal/fx-rates", {
          currency,
          kesPerUnit,
          rateDate,
          source: "Synthetic demo rate (not a market quote)",
        }),
        201,
      );
    const rates = fxRatesResponseSchema.parse(
      ok(await finance.call("get", "client-portal/fx-rates")),
    );
    expect(rates.current.map((row) => [row.currency, row.rate?.kesPerUnit ?? null])).toEqual([
      ["USD", null],
      ["GBP", "170.1000"],
      ["EUR", null],
    ]);
    await expect(
      asUser(finance, (tx) => tx.$executeRaw`UPDATE fx_rates SET kes_per_unit = 1`),
    ).rejects.toThrow(/permission denied/);

    const prefs = clientPreferencesResponseSchema.parse(
      ok(await client.call("put", "portal/client/preferences", { displayCurrency: "GBP" })),
    );
    expect(prefs.displayCurrency).toBe("GBP");
    const statement = clientStatementResponseSchema.parse(
      ok(await client.call("get", portal("/statement"))),
    );
    expect(statement.display).toEqual({
      currency: "GBP",
      rate: {
        currency: "GBP",
        kesPerUnit: "170.1000",
        rateDate: today,
        source: "Synthetic demo rate (not a market quote)",
      },
    });
    // Amounts stay in KES; the stale USD rate gives "not available".
    expect(statement.totals.outstandingMinor).toBe(18_106_000);
    const usd = clientStatementResponseSchema.parse(
      ok(await client.call("get", portal("/statement?currency=USD"))),
    );
    expect(usd.display).toEqual({ currency: "USD", rate: null });
    // Preferences are personal: another user's row is invisible and unwritable.
    const others = await asUser(
      clientTwo,
      (tx) => tx.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total FROM client_preferences`,
    );
    expect(others).toEqual([{ total: 0n }]);
    refused(await owner.call("put", "portal/client/preferences", { displayCurrency: "EUR" }), 403);
  });

  it("feeds earned value's cash received and the forecast from the client ledger, without double counting", async () => {
    const ev = earnedValueResponseSchema.parse(
      ok(await finance.call("get", `projects/${projectId}/earned-value`)),
    );
    expect(ev.values.receivedMinor).toBe(20_000_000);
    const forecast = forecastResponseSchema.parse(
      ok(await finance.call("get", `spending/forecast?projectId=${projectId}`)),
    );
    expect(
      forecast.lines
        .filter((line) => line.document?.kind === "certificate")
        .map((line) => [line.kind, line.amountMinor, line.date, line.document?.label]),
    ).toEqual([["client_receipts", 18_106_000, addCalendarDays(today, 30), "IPC-0001"]]);
    expect(forecast.opening).toMatchObject({ basis: "derived", receivedSinceMinor: 20_000_000 });

    // D5.4's manual "in" lines for a certificate's payment are linked to it, once, and then
    // counted only through the certificate and its client receipts.
    const forecastNow = async () =>
      forecastResponseSchema.parse(
        ok(await finance.call("get", `spending/forecast?projectId=${projectId}`)),
      );
    const evReceived = async () =>
      earnedValueResponseSchema.parse(
        ok(await finance.call("get", `projects/${projectId}/earned-value`)),
      ).values.receivedMinor;
    const line = async (direction: "in" | "out", description: string, amountMinor: number) =>
      cashFlowItemResponseSchema.parse(
        ok(
          await finance.call("post", "cash-flow-items", {
            projectId,
            direction,
            description,
            expectedOn: addCalendarDays(today, 10),
            amountMinor,
          }),
          201,
        ),
      ).item;
    const link = (itemId: string, version: number, method?: string) =>
      finance.call("post", `projects/${projectId}/client-payments/cash-flow-items/${itemId}/link`, {
        valuationId: ipc1.id,
        version,
        ...(method ? { method } : {}),
      });
    const expected = await line("in", "Client instalment for IPC-0001 (synthetic)", 18_106_000);
    expect(
      (await forecastNow()).lines.filter((row) => row.document?.id === expected.id),
    ).toHaveLength(1);
    const linked = clientPaymentsResponseSchema.parse(
      ok(await link(expected.id, expected.version)),
    );
    expect(linked.cashFlowItems.map((row) => row.id)).not.toContain(expected.id);
    const afterLink = await forecastNow();
    expect(afterLink.lines.filter((row) => row.document?.id === expected.id)).toEqual([]);
    expect(
      afterLink.lines
        .filter((row) => row.document?.kind === "certificate")
        .map((row) => row.amountMinor),
    ).toEqual([18_106_000]);
    refused(await link(expected.id, expected.version + 1), 409, "cash-flow-item-not-linkable");

    // A line already received becomes a client receipt when linked: counted once.
    const paid = await line("in", "Client transfer for IPC-0001 (synthetic)", 1_000_000);
    const received = cashFlowItemResponseSchema.parse(
      ok(
        await finance.call("post", `cash-flow-items/${paid.id}/receive`, {
          version: paid.version,
          receivedOn: today,
          receivedMinor: 1_000_000,
          reference: "FT-CLIENT-0099",
        }),
      ),
    ).item;
    expect((await forecastNow()).opening.receivedSinceMinor).toBe(21_000_000);
    expect(await evReceived()).toBe(21_000_000);
    refused(await link(received.id, received.version), 422, "receipt-method-required");
    const converted = clientPaymentsResponseSchema.parse(
      ok(await link(received.id, received.version, "bank")),
    );
    expect(converted.totals.receivedMinor).toBe(21_000_000);
    expect(converted.payments.find((row) => row.reference === "FT-CLIENT-0099")).toMatchObject({
      amountMinor: 1_000_000,
      reference: "FT-CLIENT-0099",
      method: "bank",
    });
    const afterConvert = await forecastNow();
    expect(afterConvert.opening.receivedSinceMinor).toBe(21_000_000);
    expect(await evReceived()).toBe(21_000_000);
    expect(
      afterConvert.lines
        .filter((row) => row.document?.kind === "certificate")
        .map((row) => row.amountMinor),
    ).toEqual([17_106_000]);

    // The database repeats it: a received line is linked only with the client receipt it becomes.
    const unlinked = await line("in", "Client cheque (synthetic)", 500_000);
    ok(
      await finance.call("post", `cash-flow-items/${unlinked.id}/receive`, {
        version: unlinked.version,
        receivedOn: today,
        receivedMinor: 500_000,
      }),
    );
    await expect(
      asUser(
        finance,
        (tx) => tx.$executeRaw`UPDATE cash_flow_items SET valuation_id = ${ipc1.id}::uuid,
          version = version + 1 WHERE id = ${unlinked.id}::uuid`,
      ),
    ).rejects.toThrow(/client receipt it becomes/);

    // A received "out" line is money paid, never money received (the opening position).
    const deposit = await line("out", "Hoarding deposit (synthetic)", 500_000);
    ok(
      await finance.call("post", `cash-flow-items/${deposit.id}/receive`, {
        version: deposit.version,
        receivedOn: today,
        receivedMinor: 500_000,
      }),
    );
    const withOut = await forecastNow();
    // (The unlinked cheque above still counts as received: 21,000,000 + 500,000.)
    expect(withOut.opening.receivedSinceMinor).toBe(21_500_000);
    expect(withOut.opening.paidSinceMinor).toBe(afterConvert.opening.paidSinceMinor! + 500_000);
  });

  it("keeps closed and cancelled projects read-only", async () => {
    await fresh(owner);
    const p3 = projectResponseSchema.parse(
      ok(await owner.call("post", "projects", { name: "Cancelled project (synthetic)" }), 201),
    ).project;
    ok(
      await owner.call("post", `projects/${p3.id}/status`, {
        to: "cancelled",
        reason: "Client withdrew (synthetic)",
        version: p3.version,
      }),
    );
    refused(
      await owner.call("put", `projects/${p3.id}/client-settings`, {
        version: 0,
        clientApprovalRequired: true,
        paymentTermsDays: 14,
      }),
      409,
      "project-read-only",
    );
    await expect(
      asUser(
        owner,
        (tx) => tx.$executeRaw`INSERT INTO project_client_settings (tenant_id, project_id, version,
          client_approval_required, payment_terms_days, created_by)
          VALUES (${tenantA}::uuid, ${p3.id}::uuid, 1, true, 14, ${owner.auth.user.id}::uuid)`,
      ),
    ).rejects.toThrow(/read-only/);
    const view = clientPaymentsResponseSchema.parse(
      ok(await finance.call("get", `projects/${p3.id}/client-payments`)),
    ) as ClientPaymentsResponse;
    expect(view).toMatchObject({ readOnly: true, permissions: { canRecord: false } });
  });
});
