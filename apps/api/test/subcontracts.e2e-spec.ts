import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { addCalendarDays, invoiceNumberKey, nairobiDate } from "@pm-buddy/domain";
import { BQ_ROUNDING, BQ_VAT_RULE, CURRENT_CONSENT_NOTICE } from "@pm-buddy/types";
import {
  budgetDetailResponseSchema,
  completionResponseSchema,
  costLedgerResponseSchema,
  costToCompleteResponseSchema,
  gangDetailResponseSchema,
  labourerResponseSchema,
  labourSetupResponseSchema,
  measurementResponseSchema,
  outputResponseSchema,
  pieceRateJobOptionsResponseSchema,
  pieceRateJobResponseSchema,
  pieceRateJobsResponseSchema,
  pieceRateReconciliationResponseSchema,
  projectResponseSchema,
  projectSpendingResponseSchema,
  projectSubcontractsResponseSchema,
  siteResponseSchema,
  sitePhotoResponseSchema,
  subcontractCertificateResponseSchema,
  subcontractItemsResponseSchema,
  subcontractResponseSchema,
  subcontractsOverviewResponseSchema,
  supplierDetailResponseSchema,
  suppliersResponseSchema,
  type PieceRateJob,
  type SubcontractCertificateDetail,
  type SubcontractDetail,
} from "@pm-buddy/validation";
import { uuidv7 } from "../src/common/uuid.js";
import { AppModule } from "../src/app.module.js";
import type { Prisma } from "../src/generated/prisma/client.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { invoiceNumberTaken } from "../src/modules/procurement/p2p/invoices.service.js";
import { plainJpeg } from "./photo-fixtures.js";
import { Browser, notifications, origin } from "./support.js";

/**
 * D6.3 part B done-when, under the real runtime role (pmb_app, forced RLS): a subcontract
 * certificate generates correctly from measured progress, and piece-rate pay above measured
 * quantities is flagged. Hand-worked figures (KES minor units, rule KE-SUB-1; the domain golden
 * cases use the same terms):
 *
 * BQ (approved, excl. VAT): A internal plaster 450 m² @ 350; B aluminium windows 36 m² @ 9,500;
 * C blockwork 120 m² @ 1,450; L window sills lump sum 100,000; PS1 provisional sum 50,000 (never
 * let). Approved measurement 30 days ago: A 200 m², B 12 m², L 25 %, C 80 m².
 *
 * SC-0001 labour-only plastering (A 450 m² @ 280 = 126,000.00; retention 5 % limited to 5 % of
 *   the original value = 6,300.00; advance 20,000.00 recovered at 20 %; WHT 3 %; no VAT).
 *   SCC-0001 (A 200 m²): work 56,000.00; retention 2,800.00; recovery min(11,200, 20,000) =
 *   11,200.00; due 42,000.00; WHT 1,260.00; payable 40,740.00. Practical-completion release: half
 *   of 2,800 = 1,400.00 due, WHT 42.00, payable 1,358.00.
 * SC-0002 supply-and-fix windows (B 36 m² @ 8,200 = 295,200.00 and L 100 % for 40,000.00, VAT
 *   16 %; retention 10 % limited to 5 % of 335,200 = 16,760.00). SCC-0001 (B 12 m², L 25 %): work
 *   98,400 + 10,000 = 108,400.00; retention 10,840.00; due 97,560.00; VAT 15,609.60; payable
 *   113,169.60.
 * Piece-rate job PRJ-0001: gang, blockwork (C) @ 150.00/m², 100 m² agreed; 90 m² approved against
 *   80 m² measured → "piece-rate-above-measured" (10 m²).
 * Synthetic data only.
 */
const today = nairobiDate();
const daysAgo = (days: number) => addCalendarDays(today, -days);
const SITE = { lat: -1.2921, lng: 36.8219 };

describe("Subcontracts and piece-rate jobs (real runtime role)", () => {
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
  let tenantB: string;
  let projectId: string;
  let siteId: string;
  const item = { A: "", B: "", C: "", L: "", PS1: "" };
  const supplier = { plaster: "", windows: "", plain: "" };
  const photos: string[] = [];
  let sc1: SubcontractDetail;
  let sc2: SubcontractDetail;
  let sc3: SubcontractDetail;
  let scc1: SubcontractCertificateDetail;
  let scc2: SubcontractCertificateDetail;
  let job: PieceRateJob;

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
    requestId: "d63b-direct",
  });
  type Raw = {
    $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number>;
    $queryRaw: <T>(s: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
    $queryRawUnsafe: <T>(query: string) => Promise<T>;
  };
  const raw = <T>(browser: Browser, work: (tx: Raw) => Promise<T>) =>
    db.run(context(browser), (tx) => work(tx as unknown as Raw));
  const uploadPhoto = async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/photos`)
      .set("Cookie", [...agent.cookies].map(([key, value]) => `${key}=${value}`).join("; "))
      .set("Origin", origin)
      .set("X-CSRF-Token", agent.csrf)
      .field("siteId", siteId)
      .attach("file", await plainJpeg(), "IMG_0001.jpg");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return sitePhotoResponseSchema.parse(res.body).photo.id;
  };
  const measured = async (lineage: string, quantityToDate: string, photo: string) => {
    const recorded = measurementResponseSchema.parse(
      ok(
        await agent.call("post", `projects/${projectId}/measurements`, {
          bqItemLineageId: lineage,
          measuredOn: daysAgo(30),
          quantityToDate,
          photoIds: [photo],
        }),
        201,
      ),
    ).measurement;
    ok(await qs.call("post", `projects/${projectId}/measurements/${recorded.id}/approve`, {}));
  };

  // Subcontracts.
  const parseSc = (res: request.Response, status = 200) =>
    subcontractResponseSchema.parse(ok(res, status)).subcontract;
  const getSc = async (browser: Browser, sc: SubcontractDetail) =>
    parseSc(await browser.call("get", `subcontracts/${sc.id}`));
  const scAct = (
    browser: Browser,
    sc: SubcontractDetail,
    path: string,
    body: Record<string, unknown> = {},
  ) => browser.call("post", `subcontracts/${sc.id}${path}`, { version: sc.version, ...body });
  const newSubcontract = (browser: Browser, body: Record<string, unknown>) =>
    browser.call("post", `subcontracts/projects/${projectId}`, {
      startDate: daysAgo(60),
      endDate: addCalendarDays(today, 90),
      ...body,
    });
  const addLine = (browser: Browser, sc: SubcontractDetail, body: Record<string, unknown>) =>
    scAct(browser, sc, "/lines", { vatTreatment: "standard", ...body });
  /** Submitted by the preparer, approved (step-up, digest) by the owner and activated. */
  const approveAndActivate = async (sc: SubcontractDetail) => {
    let current = parseSc(await scAct(pm, sc, "/submit"));
    await fresh(owner);
    current = parseSc(await scAct(owner, current, "/approve", { digest: current.digest }));
    return parseSc(await scAct(pm, current, "/activate"));
  };

  // Certificates.
  const parseScc = (res: request.Response, status = 200) =>
    subcontractCertificateResponseSchema.parse(ok(res, status)).certificate;
  const sccAct = (
    browser: Browser,
    scc: SubcontractCertificateDetail,
    path: string,
    body: Record<string, unknown> = {},
  ) =>
    browser.call("post", `subcontract-certificates/${scc.id}${path}`, {
      version: scc.version,
      ...body,
    });
  const claim = (
    browser: Browser,
    scc: SubcontractCertificateDetail,
    claims: { lineId: string; quantityToDate: string }[],
  ) =>
    browser.call("put", `subcontract-certificates/${scc.id}/claims`, {
      version: scc.version,
      claims,
    });
  const lineOf = (sc: SubcontractDetail, lineage: string) =>
    sc.lines.find((line) => line.bqItem.lineageId === lineage)!;
  const pay = (
    browser: Browser,
    scc: SubcontractCertificateDetail,
    body: Record<string, unknown>,
    key: string = randomUUID(),
  ) =>
    browser.call(
      "post",
      `subcontract-certificates/${scc.id}/payments`,
      { method: "bank_transfer", paidOn: today, ...body },
      true,
      { "Idempotency-Key": key },
    );
  /** Cost to complete for the bill "Finishes and openings" (items A, B and C). */
  const costToComplete = async () => {
    const all = costToCompleteResponseSchema.parse(
      ok(await finance.call("get", `projects/${projectId}/cost-to-complete`)),
    );
    const bill = all.bills.find((row) => row.bill.title === "Finishes and openings")!;
    return costToCompleteResponseSchema.parse(
      ok(
        await finance.call(
          "get",
          `projects/${projectId}/cost-to-complete?billLineageId=${bill.bill.lineageId}`,
        ),
      ),
    );
  };
  const spendingView = async () =>
    projectSpendingResponseSchema.parse(
      ok(await finance.call("get", `spending/projects/${projectId}`)),
    );
  const ledger = async (query = "") =>
    costLedgerResponseSchema.parse(
      ok(
        await finance.call(
          "get",
          `spending/ledger?projectId=${projectId}&category=subcontract&limit=200${query}`,
        ),
      ),
    );

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
    const a = await owner.call("post", "tenants", { name: "Subcontracts company A" });
    const b = await ownerB.call("post", "tenants", { name: "Subcontracts company B" });
    expect([a.status, b.status]).toEqual([201, 201]);
    tenantA = (a.body as { tenant: { id: string } }).tenant.id;
    tenantB = (b.body as { tenant: { id: string } }).tenant.id;
    await fresh(owner);
    projectId = projectResponseSchema.parse(
      ok(
        await owner.call("post", "projects", {
          name: "Subcontracts project (synthetic)",
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

    // The approved BQ (written by the owner, approved by the project manager, as the seed does).
    const bqId = uuidv7();
    const versionId = uuidv7();
    const bills = { prelims: uuidv7(), finishes: uuidv7(), prov: uuidv7() };
    const rows = [
      [
        "L",
        "prelims",
        "preliminary",
        "lump_sum",
        "Window sills and flashings",
        "item",
        null,
        null,
        10_000_000n,
      ],
      [
        "A",
        "finishes",
        "measured",
        "computed",
        "Internal plaster 15 mm to walls",
        "m2",
        "450",
        "350",
        15_750_000n,
      ],
      [
        "B",
        "finishes",
        "measured",
        "computed",
        "Aluminium casement windows",
        "m2",
        "36",
        "9500",
        34_200_000n,
      ],
      [
        "C",
        "finishes",
        "measured",
        "computed",
        "Blockwork 200 mm walling",
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
        "Provisional sum for signage",
        "item",
        null,
        null,
        5_000_000n,
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
          subtotalMinor: 82_350_000n,
          vatMinor: 13_176_000n,
          grandTotalMinor: 95_526_000n,
          billCount: 3,
          itemCount: 5,
          createdBy: owner.auth.user.id,
          updatedBy: owner.auth.user.id,
        },
      });
      const totals = { prelims: 10_000_000n, finishes: 67_350_000n, prov: 5_000_000n };
      for (const [index, [key, title, kind]] of (
        [
          ["prelims", "Preliminaries", "preliminaries"],
          ["finishes", "Finishes and openings", "measured"],
          ["prov", "Provisional sums", "provisional"],
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
    await measured(item.A, "200", photos[0]!);
    await measured(item.B, "12", photos[1]!);
    await measured(item.L, "25", photos[2]!);
    await measured(item.C, "80", photos[3]!);

    // A budget from the BQ (D5.4), so cost to complete has a basis.
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

    // Subcontractors are D5.1 suppliers flagged as such (decision D-140).
    for (const [key, name, isSubcontractor] of [
      ["plaster", "Plaster Masters (synthetic)", true],
      ["windows", "Alu Fabricators (synthetic)", true],
      ["plain", "Hardware Depot (synthetic)", false],
    ] as const)
      supplier[key] = supplierDetailResponseSchema.parse(
        ok(
          await owner.call("post", "suppliers", {
            legalName: name,
            etimsStatus: "registered",
            creditDays: 30,
            isSubcontractor,
          }),
          201,
        ),
      ).supplier.id;
  }, 300_000);

  afterAll(async () => {
    await app?.close();
  });

  it("documents every D6.3 part B operation in OpenAPI", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "listSubcontractProjects",
      "listProjectSubcontracts",
      "listSubcontractItems",
      "createSubcontract",
      "getSubcontract",
      "updateSubcontract",
      "addSubcontractLine",
      "removeSubcontractLine",
      "submitSubcontract",
      "approveSubcontract",
      "returnSubcontract",
      "activateSubcontract",
      "completeSubcontract",
      "terminateSubcontract",
      "cancelSubcontract",
      "createSubcontractVariation",
      "approveSubcontractVariation",
      "rejectSubcontractVariation",
      "requestSubcontractAdvance",
      "approveSubcontractAdvance",
      "rejectSubcontractAdvance",
      "cancelSubcontractAdvance",
      "paySubcontractAdvance",
      "createSubcontractCertificate",
      "exportSubcontractStatementPdf",
      "exportSubcontractStatementExcel",
      "getSubcontractCertificate",
      "updateSubcontractCertificate",
      "setSubcontractClaims",
      "submitSubcontractCertificate",
      "certifySubcontractCertificate",
      "returnSubcontractCertificate",
      "cancelSubcontractCertificate",
      "recordSubcontractPayment",
      "matchSubcontractInvoice",
      "exportSubcontractCertificatePdf",
      "exportSubcontractCertificateExcel",
      "listPieceRateJobs",
      "pieceRateJobOptions",
      "createPieceRateJob",
      "getPieceRateReconciliation",
      "getPieceRateJob",
      "approvePieceRateJob",
      "rejectPieceRateJob",
      "closePieceRateJob",
      "requestPieceRateExtension",
      "approvePieceRateExtension",
      "rejectPieceRateExtension",
      "recordPieceRateJobOutput",
    ])
      expect(operations, id).toContain(id);
  });

  it("lets subcontracts to flagged suppliers on BQ items at their own rates, within the BQ, approved independently", async () => {
    // Only suppliers flagged as subcontractors take subcontracts.
    const flagged = suppliersResponseSchema.parse(
      ok(await owner.call("get", "suppliers?subcontractor=true")),
    );
    expect(flagged.suppliers.map((row) => row.id).sort()).toEqual(
      [supplier.plaster, supplier.windows].sort(),
    );
    refused(
      await newSubcontract(pm, {
        supplierId: supplier.plain,
        kind: "labour_only",
        title: "Not a subcontractor",
      }),
      409,
      "subcontractor-not-eligible",
    );
    // Outsiders neither read nor prepare subcontracts.
    for (const outsider of [client, supplierUser, consultant, agent]) {
      refused(await outsider.call("get", `subcontracts/projects/${projectId}`), 403);
      refused(
        await newSubcontract(outsider, {
          supplierId: supplier.plaster,
          kind: "labour_only",
          title: "Outsider",
        }),
        403,
      );
    }

    sc1 = parseSc(
      await newSubcontract(pm, {
        supplierId: supplier.plaster,
        kind: "labour_only",
        title: "Internal plastering (labour only)",
        retentionPercent: "5",
        retentionLimitPercent: "5",
        vatPercent: "0",
        whtPercent: "3",
        advanceLimitMinor: 2_000_000,
        advanceRecoveryPercent: "20",
        paymentTermsDays: 14,
      }),
      201,
    );
    expect(sc1).toMatchObject({ code: "SC-0001", status: "draft", valueMinor: 0 });
    refused(await scAct(pm, sc1, "/submit"), 409, "subcontract-empty");
    // Provisional sums are never let; a lump sum takes a lump sum, a measured item a rate.
    refused(
      await addLine(pm, sc1, { bqItemLineageId: item.PS1, quantity: "100", lumpSumMinor: 100 }),
      422,
      "item-not-measurable",
    );
    refused(
      await addLine(pm, sc1, { bqItemLineageId: item.A, quantity: "450", lumpSumMinor: 100 }),
      422,
      "item-not-measurable",
    );
    // Never above the BQ quantity without a reason.
    refused(
      await addLine(pm, sc1, { bqItemLineageId: item.A, quantity: "450.5", rateMinor: 28_000 }),
      409,
      "over-bq-quantity",
    );
    sc1 = parseSc(
      await addLine(pm, sc1, {
        bqItemLineageId: item.A,
        quantity: "450",
        rateMinor: 28_000,
        description: "=2+3 internal plaster (synthetic formula-injection probe)",
      }),
    );
    expect(lineOf(sc1, item.A)).toMatchObject({
      basis: "quantity",
      quantity: "450",
      rateMinor: 28_000,
      amountMinor: 12_600_000,
      bqQuantity: "450",
      rateAboveBq: false,
      measuredToDate: "200",
    });
    refused(
      await addLine(pm, sc1, { bqItemLineageId: item.A, quantity: "1", rateMinor: 28_000 }),
      409,
      "line-exists",
    );

    // Submitted with its digest; approved with step-up on that digest, never by its preparer.
    sc1 = parseSc(await scAct(pm, sc1, "/submit"));
    expect(sc1).toMatchObject({ status: "submitted", valueMinor: 12_600_000 });
    await fresh(pm);
    refused(await scAct(pm, sc1, "/approve", { digest: sc1.digest }), 403, "maker-checker");
    refused(await scAct(qs, sc1, "/approve", { digest: sc1.digest }), 403);
    await stale(owner);
    refused(await scAct(owner, sc1, "/approve", { digest: sc1.digest }), 403, "step-up-required");
    await fresh(owner);
    refused(
      await scAct(owner, sc1, "/approve", { digest: "0".repeat(64) }),
      409,
      "subcontract-stale",
    );
    sc1 = parseSc(await scAct(owner, sc1, "/approve", { digest: sc1.digest }));
    expect(sc1).toMatchObject({
      status: "approved",
      contractVersion: 1,
      originalValueMinor: 12_600_000,
      committedMinor: 12_600_000,
      approvedBy: { id: owner.auth.user.id },
    });
    refused(
      await pm.call("patch", `subcontracts/${sc1.id}`, { version: sc1.version, title: "Changed" }),
      409,
      "invalid-transition",
    );
    sc1 = parseSc(await scAct(pm, sc1, "/activate"));
    expect(sc1.status).toBe("active");

    // A supply-and-fix subcontract with a share of a lump sum, VAT at 16 %.
    sc2 = parseSc(
      await newSubcontract(pm, {
        supplierId: supplier.windows,
        kind: "supply_and_fix",
        title: "Aluminium windows (supply and fix)",
        retentionPercent: "10",
        retentionLimitPercent: "5",
        vatPercent: "16",
        whtPercent: "0",
      }),
      201,
    );
    sc2 = parseSc(
      await addLine(pm, sc2, { bqItemLineageId: item.B, quantity: "36", rateMinor: 820_000 }),
    );
    sc2 = parseSc(
      await addLine(pm, sc2, { bqItemLineageId: item.L, quantity: "100", lumpSumMinor: 4_000_000 }),
    );
    expect(lineOf(sc2, item.L)).toMatchObject({
      basis: "percent",
      unit: "%",
      amountMinor: 4_000_000,
    });
    sc2 = await approveAndActivate(sc2);
    expect(sc2).toMatchObject({ code: "SC-0002", valueMinor: 33_520_000, status: "active" });

    // A second subcontract on item A goes above the BQ only with a reason.
    sc3 = parseSc(
      await newSubcontract(pm, {
        supplierId: supplier.windows,
        kind: "labour_only",
        title: "Plaster patching",
        vatPercent: "0",
        advanceLimitMinor: 100_000,
        advanceRecoveryPercent: "50",
      }),
      201,
    );
    refused(
      await addLine(pm, sc3, { bqItemLineageId: item.A, quantity: "10", rateMinor: 30_000 }),
      409,
      "over-bq-quantity",
    );
    sc3 = parseSc(
      await addLine(pm, sc3, {
        bqItemLineageId: item.A,
        quantity: "10",
        rateMinor: 30_000,
        overQuantityReason: "Remedial patching after services (synthetic)",
      }),
    );
    const items = subcontractItemsResponseSchema.parse(
      ok(await qs.call("get", `subcontracts/projects/${projectId}/items`)),
    );
    expect(items.items.find((row) => row.lineageId === item.A)).toMatchObject({
      letQuantity: "450",
      availableQuantity: "0",
    });
    expect(items.items.some((row) => row.lineageId === item.PS1)).toBe(false);

    // Cost to complete: SC-0002's uncertified value on B is committed, so ETC is never below it.
    const ctc = await costToComplete();
    expect(ctc.items.find((row) => row.item.lineageId === item.B)).toMatchObject({
      committedMinor: 29_520_000,
      etcMinor: 29_520_000,
      basis: "committed",
    });
  });

  it("records advances maker-checked, paid outside PM-Buddy, never above the agreed advance", async () => {
    refused(
      await pm.call("post", `subcontracts/${sc1.id}/advances`, {
        amountMinor: 2_000_001,
        reason: "Mobilisation",
      }),
      409,
      "advance-exceeds-limit",
    );
    sc1 = parseSc(
      await pm.call("post", `subcontracts/${sc1.id}/advances`, {
        amountMinor: 2_000_000,
        reason: "Mobilisation advance (synthetic)",
      }),
      201,
    );
    let advance = sc1.advances[0]!;
    expect(advance).toMatchObject({ code: "ADV-01", status: "requested", amountMinor: 2_000_000 });
    refused(
      await pm.call("post", `subcontracts/${sc1.id}/advances`, {
        amountMinor: 1,
        reason: "Over the limit",
      }),
      409,
      "advance-exceeds-limit",
    );
    // Approved by payments.approve with step-up, never the requester; paid by a third person.
    refused(
      await pm.call("post", `subcontracts/advances/${advance.id}/approve`, {
        version: advance.version,
      }),
      403,
    );
    await stale(finance);
    refused(
      await finance.call("post", `subcontracts/advances/${advance.id}/approve`, {
        version: advance.version,
      }),
      403,
      "step-up-required",
    );
    await fresh(finance);
    sc1 = parseSc(
      await finance.call("post", `subcontracts/advances/${advance.id}/approve`, {
        version: advance.version,
      }),
    );
    advance = sc1.advances[0]!;
    expect(advance.status).toBe("approved");
    const payAdvance = (browser: Browser, paidOn = daysAgo(40)) =>
      browser.call("post", `subcontracts/advances/${advance.id}/pay`, {
        version: advance.version,
        paidOn,
        method: "bank_transfer",
        reference: "EFT-ADV-0001",
      });
    refused(await payAdvance(finance), 403, "maker-checker");
    await fresh(owner);
    refused(await payAdvance(owner, addCalendarDays(today, 1)), 409, "payment-date-invalid");
    sc1 = parseSc(await payAdvance(owner));
    expect(sc1.advances[0]).toMatchObject({ status: "paid", paidOn: daysAgo(40) });
    expect(sc1.position).toMatchObject({
      advancesPaidMinor: 2_000_000,
      advancesRecoveredMinor: 0,
      advancesOutstandingMinor: 2_000_000,
    });
    // The advance is cash paid to the subcontractor: one paid entry, no BQ item.
    const entries = (await ledger("&source=subcontract_advance")).entries;
    expect(entries).toEqual([
      expect.objectContaining({
        measure: "paid",
        category: "subcontract",
        amountMinor: 2_000_000,
        bqItem: null,
        document: expect.objectContaining({ kind: "subcontract_advance", id: sc1.id }),
      }),
    ]);
  });

  it("certifies a subcontract certificate from measured progress (KE-SUB-1), posts it once, and never pays the same measured quantity twice", async () => {
    refused(await sccOpen(pm, sc1, addCalendarDays(today, 1)), 409, "certificate-date-invalid");
    scc1 = parseScc(await sccOpen(pm, sc1, daysAgo(20)), 201);
    expect(scc1).toMatchObject({ code: "SCV-0001", status: "draft", kind: "interim" });
    // A second certificate for the same subcontract waits until this one is certified.
    refused(await sccOpen(qs, sc1, daysAgo(20)), 409, "certificate-open");
    const line = lineOf(sc1, item.A);
    refused(
      await claim(pm, scc1, [{ lineId: line.id, quantityToDate: "450.5" }]),
      409,
      "claim-exceeds-line",
    );
    scc1 = parseScc(await claim(pm, scc1, [{ lineId: line.id, quantityToDate: "201" }]));
    expect(scc1.lines[0]).toMatchObject({ measuredToDate: "200", quantityToDate: "201" });
    expect(scc1.problems.map((entry) => entry.code)).toContain("claim-exceeds-measured");
    refused(await sccAct(pm, scc1, "/submit"), 409, "claim-exceeds-measured");
    scc1 = parseScc(await claim(qs, scc1, [{ lineId: line.id, quantityToDate: "200" }]));
    scc1 = parseScc(await sccAct(pm, scc1, "/submit"));
    expect(scc1).toMatchObject({ status: "submitted", ruleVersion: "KE-SUB-1" });
    expect(scc1.figures).toEqual({
      workDoneMinor: 5_600_000,
      vatableWorkDoneMinor: 5_600_000,
      retentionStage: "none",
      retentionLimitMinor: 630_000,
      retentionComputedMinor: 280_000,
      retentionHeldMinor: 280_000,
      advancesPaidMinor: 2_000_000,
      recoveredToDateMinor: 1_120_000,
      advancesOutstandingMinor: 880_000,
      netToDateMinor: 4_200_000,
      previousCertifiedMinor: 0,
      amountDueMinor: 4_200_000,
      vatMinor: 0,
      whtMinor: 126_000,
      payableMinor: 4_074_000,
    });

    // Certified by finance with step-up on the digest it saw, never by a contributor.
    refused(await sccAct(pm, scc1, "/certify", { digest: scc1.digest }), 403);
    await stale(finance);
    refused(
      await sccAct(finance, scc1, "/certify", { digest: scc1.digest }),
      403,
      "step-up-required",
    );
    await fresh(finance);
    refused(
      await sccAct(finance, scc1, "/certify", { digest: "f".repeat(64) }),
      409,
      "certificate-stale",
    );
    scc1 = parseScc(await sccAct(finance, scc1, "/certify", { digest: scc1.digest }));
    expect(scc1).toMatchObject({
      status: "certified",
      code: "SCC-0001",
      certificateNumber: 1,
      payableMinor: 4_074_000,
      certifiedBy: { id: finance.auth.user.id },
    });
    refused(
      await sccAct(finance, scc1, "/cancel", { reason: "Too late" }),
      409,
      "invalid-transition",
    );

    // Posted once to the cost ledger: the work certified this period, on the line's BQ item.
    const posted = (await ledger("&source=subcontract_certificate")).entries;
    expect(posted).toEqual([
      expect.objectContaining({
        measure: "accrued",
        category: "subcontract",
        amountMinor: 5_600_000,
        purpose: "accrual",
        bqItem: expect.objectContaining({ lineageId: item.A }),
        supplier: expect.objectContaining({ id: supplier.plaster }),
        document: expect.objectContaining({ kind: "subcontract_certificate", label: "SCC-0001" }),
      }),
    ]);

    // The same measured quantity is never paid to two subcontracts: SC-0003's 10 m² on A has no
    // measured quantity left (200 measured, 200 certified to SC-0001).
    sc3 = await approveAndActivate(sc3);
    let other = parseScc(await sccOpen(pm, sc3, daysAgo(19)), 201);
    other = parseScc(
      await claim(pm, other, [{ lineId: lineOf(sc3, item.A).id, quantityToDate: "10" }]),
    );
    expect(other.lines[0]).toMatchObject({ otherClaims: "200", availableQuantity: "0" });
    refused(await sccAct(pm, other, "/submit"), 409, "claim-exceeds-measured");
    other = parseScc(await sccAct(pm, other, "/cancel", { reason: "Nothing measured left" }));
    expect(other.status).toBe("cancelled");
    // An advance still requested or approved keeps the subcontract open: once closed, no
    // certificate is left to recover it from.
    sc3 = parseSc(
      await pm.call("post", `subcontracts/${sc3.id}/advances`, {
        amountMinor: 100_000,
        reason: "Patching materials (synthetic)",
      }),
      201,
    );
    const terminate = async () =>
      scAct(owner, await getSc(owner, sc3), "/terminate", { reason: "Closing early (synthetic)" });
    await fresh(owner);
    refused(await terminate(), 409, "subcontract-has-open-items");
    await fresh(finance);
    sc3 = parseSc(
      await finance.call("post", `subcontracts/advances/${sc3.advances[0]!.id}/approve`, {
        version: sc3.advances[0]!.version,
      }),
    );
    refused(await terminate(), 409, "subcontract-has-open-items");
    await expect(
      raw(
        owner,
        (tx) => tx.$executeRaw`
          UPDATE subcontracts SET status = 'terminated', closed_by = ${owner.auth.user.id}::uuid,
                 close_reason = 'Closed directly (test)', version = version + 1
           WHERE tenant_id = ${tenantA}::uuid AND id = ${sc3.id}::uuid`,
      ),
    ).rejects.toThrow(/no certificate, variation or advance open/);
    sc3 = parseSc(
      await finance.call("post", `subcontracts/advances/${sc3.advances[0]!.id}/cancel`, {
        version: sc3.advances[0]!.version,
        reason: "Patching needs no materials",
      }),
    );
    expect(sc3.advances[0]!.status).toBe("cancelled");
    await fresh(owner);
    sc3 = parseSc(
      await scAct(owner, await getSc(owner, sc3), "/terminate", {
        reason: "Patching done by the plasterer (synthetic)",
      }),
    );
    expect(sc3).toMatchObject({ status: "terminated", committedMinor: 0 });

    // Two certificates raced for the same subcontract: exactly one is opened.
    const raced = await Promise.all([sccOpen(pm, sc2, daysAgo(18)), sccOpen(qs, sc2, daysAgo(18))]);
    expect(raced.map((res) => res.status).sort((x, y) => x - y)).toEqual([201, 409]);
    expect(problem(raced.find((res) => res.status === 409)!)).toBe("certificate-open");
    scc2 = parseScc(
      raced.find((res) => res.status === 201)!,
      201,
    );
    scc2 = parseScc(
      await claim(pm, scc2, [
        { lineId: lineOf(sc2, item.B).id, quantityToDate: "12" },
        { lineId: lineOf(sc2, item.L).id, quantityToDate: "25" },
      ]),
    );
    scc2 = parseScc(await sccAct(pm, scc2, "/submit"));
    expect(scc2.figures).toMatchObject({
      workDoneMinor: 10_840_000,
      retentionHeldMinor: 1_084_000,
      amountDueMinor: 9_756_000,
      vatMinor: 1_560_960,
      whtMinor: 0,
      payableMinor: 11_316_960,
    });
    await fresh(finance);
    scc2 = parseScc(await sccAct(finance, scc2, "/certify", { digest: scc2.digest }));
    expect(
      (await ledger("&source=subcontract_certificate")).entries
        .map((entry) => entry.amountMinor)
        .sort((x, y) => x - y),
    ).toEqual([1_000_000, 5_600_000, 9_840_000]);
  });

  it("records payments outside PM-Buddy and matches the tax invoice without double counting", async () => {
    // Never the certifier, never above what is payable; the key makes a retry safe.
    await fresh(finance);
    refused(await pay(finance, scc1, { amountMinor: 1, reference: "EFT-1" }), 403, "maker-checker");
    await fresh(owner);
    refused(
      await pay(owner, scc1, { amountMinor: 4_074_001, reference: "EFT-1" }),
      409,
      "payment-exceeds-payable",
    );
    const cashBefore = (await spendingView()).cashPaidMinor;
    const key = randomUUID();
    const first = await pay(owner, scc1, { amountMinor: 2_000_000, reference: "EFT-0001" }, key);
    scc1 = parseScc(first);
    const replay = await pay(owner, scc1, { amountMinor: 2_000_000, reference: "EFT-0001" }, key);
    expect(subcontractCertificateResponseSchema.parse(ok(replay)).replayed).toBe(true);
    refused(
      await pay(owner, scc1, { amountMinor: 2_000_001, reference: "EFT-0001" }, key),
      409,
      "idempotency-key-reused",
    );
    refused(
      await pay(owner, scc1, { amountMinor: 1, reference: "eft 0001" }),
      409,
      "payment-reference-taken",
    );
    scc1 = parseScc(await pay(owner, scc1, { amountMinor: 2_074_000, reference: "EFT-0002" }));
    expect(scc1).toMatchObject({ paidMinor: 4_074_000, outstandingMinor: 0 });
    // The cost part of the cash (its share of the amount due), adding up to the due exactly.
    const paid = (await ledger("&source=subcontract_payment")).entries;
    expect(paid.map((entry) => entry.amountMinor).sort((x, y) => x - y)).toEqual([
      2_061_856, 2_138_144,
    ]);
    // Cash paid is the cash (4,074,000), not the cost share the ledger holds (4,200,000).
    expect((await spendingView()).cashPaidMinor - cashBefore).toBe(4_074_000);

    // The subcontractor's tax invoice is matched to the certificate; it posts nothing, so the
    // work is never accrued twice. Its number is never also a procure-to-pay invoice.
    const before = (await ledger()).totals;
    refused(
      await qs.call("post", `subcontract-certificates/${scc1.id}/invoice`, {
        invoiceNumber: "PM/INV/001",
        invoiceDate: daysAgo(15),
      }),
      403,
    );
    scc1 = parseScc(
      await finance.call("post", `subcontract-certificates/${scc1.id}/invoice`, {
        invoiceNumber: "PM/INV/001",
        invoiceDate: daysAgo(15),
        etimsNumber: "KRAMW0000001",
      }),
    );
    expect(scc1.invoice).toMatchObject({ invoiceNumber: "PM/INV/001", amountMinor: 4_200_000 });
    expect((await ledger()).totals).toEqual(before);
    refused(
      await finance.call("post", `subcontract-certificates/${scc1.id}/invoice`, {
        invoiceNumber: "PM/INV/002",
        invoiceDate: daysAgo(15),
      }),
      409,
      "invoice-exists",
    );
    await expect(
      raw(
        finance,
        (tx) => tx.$executeRaw`
          INSERT INTO supplier_invoices (id, tenant_id, project_id, lpo_id, supplier_id,
            invoice_number, invoice_number_key, invoice_date, due_date, vat_rate_percent,
            vat_rule_status, subtotal_minor, vat_minor, total_minor, computed_subtotal_minor,
            computed_vat_minor, created_by, updated_by)
          VALUES (${uuidv7()}::uuid, ${tenantA}::uuid, ${projectId}::uuid, ${uuidv7()}::uuid,
            ${supplier.plaster}::uuid, 'PM-INV-001', 'PMINV001', ${today}::date, ${today}::date,
            16, 'compliance_review', 100, 16, 116, 100, 16, ${finance.auth.user.id}::uuid,
            ${finance.auth.user.id}::uuid)`,
      ),
    ).rejects.toThrow(/matched to a subcontract certificate/);
    // The procure-to-pay check refuses the number first (409 invoice-number-taken, not a 500).
    const taken = (supplierId: string, number: string) =>
      raw(finance, (tx) =>
        invoiceNumberTaken(
          tx as unknown as Prisma.TransactionClient,
          tenantA,
          supplierId,
          invoiceNumberKey(number),
          null,
        ),
      );
    expect(await taken(supplier.plaster, "PM-INV-001")).toBe(true);
    expect(await taken(supplier.windows, "PM-INV-001")).toBe(false);

    // The statement: certified, paid, retention held and advances outstanding.
    sc1 = await getSc(finance, sc1);
    expect(sc1.position).toEqual({
      certifiedWorkMinor: 5_600_000,
      certifiedDueMinor: 4_200_000,
      vatMinor: 0,
      whtMinor: 126_000,
      payableMinor: 4_074_000,
      paidMinor: 4_074_000,
      outstandingMinor: 0,
      retentionHeldMinor: 280_000,
      advancesPaidMinor: 2_000_000,
      advancesRecoveredMinor: 1_120_000,
      advancesOutstandingMinor: 880_000,
    });
  });

  it("varies a subcontract append-only and counts its uncertified value as committed", async () => {
    // Never below what was certified, never above the BQ without a reason, one pending at a time.
    const line = lineOf(sc1, item.A);
    refused(
      await pm.call("post", `subcontracts/${sc1.id}/variations`, {
        reason: "Cut the scope",
        changes: [{ lineId: line.id, quantityChange: "-251" }],
      }),
      409,
      "line-below-certified",
    );
    refused(
      await pm.call("post", `subcontracts/${sc1.id}/variations`, {
        reason: "More walls",
        changes: [{ lineId: line.id, quantityChange: "5" }],
      }),
      409,
      "over-bq-quantity",
    );
    sc1 = parseSc(
      await pm.call("post", `subcontracts/${sc1.id}/variations`, {
        reason: "Stair core plaster omitted (synthetic)",
        changes: [{ lineId: line.id, quantityChange: "-50" }],
      }),
      201,
    );
    let variation = sc1.variations[0]!;
    expect(variation).toMatchObject({
      code: "SCVO-01",
      status: "pending",
      valueChangeMinor: -1_400_000,
    });
    refused(
      await pm.call("post", `subcontracts/${sc1.id}/variations`, {
        reason: "Another",
        changes: [{ lineId: line.id, quantityChange: "-1" }],
      }),
      409,
      "subcontract-variation-open",
    );
    const decide = (browser: Browser, digest = variation.digest) =>
      browser.call("post", `subcontracts/${sc1.id}/variations/${variation.id}/approve`, {
        version: variation.version,
        digest,
      });
    await fresh(pm);
    refused(await decide(pm), 403, "maker-checker");
    await fresh(owner);
    refused(await decide(owner, "a".repeat(64)), 409, "subcontract-variation-stale");
    sc1 = parseSc(await decide(owner));
    variation = sc1.variations[0]!;
    expect(variation).toMatchObject({ status: "approved", resultingVersion: 2 });
    expect(sc1).toMatchObject({ contractVersion: 2, valueMinor: 11_200_000 });
    expect(lineOf(sc1, item.A)).toMatchObject({
      quantity: "400",
      originalQuantity: "450",
      amountMinor: 11_200_000,
      certifiedQuantity: "200",
      certifiedMinor: 5_600_000,
    });

    // Committed = value in force − certified, per line (terminated SC-0003 commits nothing).
    const list = projectSubcontractsResponseSchema.parse(
      ok(await finance.call("get", `subcontracts/projects/${projectId}`)),
    );
    expect(list.subcontracts.map((row) => [row.code, row.committedMinor])).toEqual([
      ["SC-0003", 0],
      ["SC-0002", 22_680_000],
      ["SC-0001", 5_600_000],
    ]);
    expect(list.totals).toMatchObject({
      committedMinor: 28_280_000,
      certifiedWorkMinor: 16_440_000,
      retentionHeldMinor: 1_364_000,
      advancesOutstandingMinor: 880_000,
    });
    // The D5.4 budget view counts it under subcontract, next to the accrued certificates.
    const spending = projectSpendingResponseSchema.parse(
      ok(await finance.call("get", `spending/projects/${projectId}`)),
    );
    expect(spending.categories.find((row) => row.category === "subcontract")).toMatchObject({
      committedMinor: 28_280_000,
      actualMinor: 16_440_000,
      paidMinor: 6_200_000,
    });
    const ctc = await costToComplete();
    expect(ctc.items.find((row) => row.item.lineageId === item.A)).toMatchObject({
      actualMinor: 5_600_000,
      committedMinor: 5_600_000,
    });
    expect(ctc.totals.committedMinor).toBe(28_280_000);
  });

  it("releases half the retention at practical completion and posts no second accrual", async () => {
    refused(
      await pm.call("post", `subcontracts/${sc1.id}/certificates`, {
        kind: "retention_release",
        releaseStage: "practical",
        valuationDate: daysAgo(4),
      }),
      409,
      "completion-not-certified",
    );
    const completion = completionResponseSchema.parse(
      ok(
        await pm.call("post", `projects/${projectId}/quality/completion`, {
          kind: "practical",
          completionDate: daysAgo(5),
          dlpMonths: 1,
        }),
        201,
      ),
    );
    ok(
      await agent.call(
        "post",
        `projects/${projectId}/quality/completion/${completion.practical!.id}/actions`,
        { version: completion.practical!.version, action: "certify" },
      ),
    );
    const before = (await ledger("&source=subcontract_certificate")).entries.length;
    let release = parseScc(
      await pm.call("post", `subcontracts/${sc1.id}/certificates`, {
        kind: "retention_release",
        releaseStage: "practical",
        valuationDate: daysAgo(4),
      }),
      201,
    );
    release = parseScc(await sccAct(pm, release, "/submit"));
    expect(release.figures).toMatchObject({
      workDoneMinor: 5_600_000,
      retentionStage: "practical",
      retentionHeldMinor: 140_000,
      amountDueMinor: 140_000,
      whtMinor: 4_200,
      payableMinor: 135_800,
    });
    await fresh(finance);
    release = parseScc(await sccAct(finance, release, "/certify", { digest: release.digest }));
    expect(release).toMatchObject({ status: "certified", code: "SCC-0002" });
    expect((await ledger("&source=subcontract_certificate")).entries).toHaveLength(before);
    refused(
      await pm.call("post", `subcontracts/${sc1.id}/certificates`, {
        kind: "retention_release",
        releaseStage: "practical",
        valuationDate: today,
      }),
      409,
      "release-exists",
    );
  });

  it("links piece-rate output to approved jobs at the job's rate, caps it, and flags pay above measured quantities", async () => {
    // Labour: two labourers in a blockwork gang (D4.1).
    const setup = labourSetupResponseSchema.parse(
      (await owner.call("post", "labour/setup/defaults", {})).body,
    );
    const trade = setup.trades.find((row) => row.key === "general_labourer")!.id;
    const level = setup.skillLevels.find((row) => row.key === "unskilled")!.id;
    const workers: string[] = [];
    for (const [index, name] of ["Mfanyakazi Kwanza", "Mfanyakazi Pili"].entries()) {
      const res = await owner.call("post", "labour/labourers", {
        fullName: `${name} (synthetic)`,
        dateOfBirth: "1990-05-01",
        gender: "male",
        tradeId: trade,
        skillLevelId: level,
        engagementType: "piece_rate",
        rateBasis: "daily",
        idType: "national_id",
        idNumber: `8${String(index + 1).padStart(7, "0")}`,
        projectId,
        engagementStartDate: daysAgo(60),
        consent: {
          noticeVersion: CURRENT_CONSENT_NOTICE.version,
          language: "en",
          method: "signed",
          granted: true,
        },
      });
      workers.push(labourerResponseSchema.parse(ok(res, 201)).labourer.id);
    }
    const gangId = gangDetailResponseSchema.parse(
      ok(await pm.call("post", "labour/gangs", { projectId, name: "Blockwork gang" }), 201),
    ).gang.id;
    for (const labourerId of workers)
      ok(
        await pm.call("post", `labour/gangs/${gangId}/members`, {
          labourerId,
          joinedOn: daysAgo(60),
        }),
        201,
      );
    const options = pieceRateJobOptionsResponseSchema.parse(
      ok(await pm.call("get", `payroll/projects/${projectId}/piece-rate-jobs/options`)),
    );
    expect(options.items.find((row) => row.lineageId === item.C)?.units[0]).toEqual({
      unit: "m2",
      factor: "1",
    });
    expect(options.items.some((row) => row.lineageId === item.L)).toBe(false);
    expect(options.gangs).toEqual([expect.objectContaining({ id: gangId, members: 2 })]);

    // A job: the agreed rate and quantity on a BQ item for a gang, in the item's unit.
    const create = (body: Record<string, unknown>, browser: Browser = pm) =>
      browser.call("post", `payroll/projects/${projectId}/piece-rate-jobs`, {
        bqItemLineageId: item.C,
        gangId,
        description: "Blockwork 200 mm walling, block B",
        unit: "m2",
        rateMinor: 15_000,
        agreedQuantity: "100",
        startDate: daysAgo(30),
        endDate: addCalendarDays(today, 30),
        ...body,
      });
    refused(await create({ unit: "bag" }), 400, "unit-not-convertible");
    refused(await create({ bqItemLineageId: item.L }), 409);
    refused(await create({}, agent), 403);
    job = pieceRateJobResponseSchema.parse(ok(await create({}), 201)).job;
    expect(job).toMatchObject({ code: "PRJ-0001", status: "pending", rateMinor: 15_000 });
    const decideJob = (browser: Browser, target: PieceRateJob, action: string, body = {}) =>
      browser.call("post", `payroll/piece-rate-jobs/${target.id}/${action}`, {
        version: target.version,
        ...body,
      });
    const recordOn = (target: PieceRateJob, body: Record<string, unknown>, key?: string) =>
      agent.call(
        "post",
        `payroll/piece-rate-jobs/${target.id}/outputs`,
        body,
        true,
        key ? { "Idempotency-Key": key } : {},
      );
    refused(await recordOn(job, { workDate: daysAgo(10), quantity: "1" }), 409, "job-not-approved");
    refused(await decideJob(pm, job, "approve"), 409, "same-person");
    refused(await decideJob(agent, job, "approve"), 403);
    // The database refuses the creator's own approval too.
    await expect(
      raw(
        pm,
        (tx) => tx.$executeRaw`
          UPDATE piece_rate_jobs SET status = 'approved', decided_by = ${pm.auth.user.id}::uuid,
            decided_at = now(), version = version + 1
           WHERE id = ${job.id}::uuid`,
      ),
    ).rejects.toThrow(/other than its creator/);
    job = pieceRateJobResponseSchema.parse(ok(await decideJob(finance, job, "approve"))).job;
    expect(job.status).toBe("approved");

    // Output against the job sends only the day and quantity: the rate is the job's.
    refused(await recordOn(job, { workDate: daysAgo(10), quantity: "10", rateMinor: 99_999 }), 400);
    refused(await recordOn(job, { workDate: daysAgo(31), quantity: "10" }), 409, "job-dates");
    const key = randomUUID();
    let view = pieceRateJobResponseSchema.parse(
      ok(await recordOn(job, { workDate: daysAgo(10), quantity: "60" }, key), 201),
    );
    const replay = pieceRateJobResponseSchema.parse(
      ok(await recordOn(job, { workDate: daysAgo(10), quantity: "60" }, key), 201),
    );
    expect(replay.outputs).toHaveLength(1);
    expect(view.outputs[0]).toMatchObject({
      rateMinor: 15_000,
      amountMinor: 900_000,
      unit: "m2",
      gang: { id: gangId },
      job: { id: job.id, code: "PRJ-0001" },
      status: "pending",
    });
    // Two outputs racing past the agreed quantity: exactly one is recorded.
    const raced = await Promise.all([
      recordOn(job, { workDate: daysAgo(9), quantity: "30" }),
      recordOn(job, { workDate: daysAgo(8), quantity: "30" }),
    ]);
    expect(raced.map((res) => res.status).sort((x, y) => x - y)).toEqual([201, 409]);
    expect(problem(raced.find((res) => res.status === 409)!)).toBe("job-quantity-exceeded");
    refused(
      await recordOn(job, { workDate: daysAgo(7), quantity: "10.001" }),
      409,
      "job-quantity-exceeded",
    );
    // The database holds the cap and the job's terms for any output naming the job.
    const outputSql = (rate: number, quantity: string) =>
      raw(
        agent,
        (tx) => tx.$executeRaw`
          INSERT INTO piece_rate_outputs (id, tenant_id, project_id, work_date, gang_id, bq_item_id,
            job_id, description, unit, quantity, rate_minor, amount_minor, recorded_by)
          SELECT ${uuidv7()}::uuid, tenant_id, project_id, ${daysAgo(7)}::date, gang_id,
                 bq_item_id, job_id, description, unit, ${quantity}::numeric, ${rate},
                 round(${quantity}::numeric * ${rate}), ${agent.auth.user.id}::uuid
            FROM piece_rate_outputs WHERE job_id = ${job.id}::uuid LIMIT 1`,
      );
    await expect(outputSql(20_000, "1")).rejects.toThrow(/takes the job's rate/);
    await expect(outputSql(15_000, "10.5")).rejects.toThrow(/never exceeds its agreed quantity/);

    // Approval is unchanged (D4.1): someone other than the recorder; equal gang shares.
    view = pieceRateJobResponseSchema.parse(
      ok(await pm.call("get", `payroll/piece-rate-jobs/${job.id}`)),
    );
    for (const output of view.outputs) {
      refused(
        await agent.call("post", `payroll/outputs/${output.id}/approve`, {
          version: output.version,
        }),
        403,
      );
      const approved = outputResponseSchema.parse(
        ok(
          await pm.call("post", `payroll/outputs/${output.id}/approve`, {
            version: output.version,
          }),
        ),
      ).output;
      expect(approved.shares).toHaveLength(2);
      expect(approved.shares.reduce((sum, share) => sum + share.amountMinor, 0)).toBe(
        approved.amountMinor,
      );
    }

    // Reconciliation: 90 m² paid against 80 m² measured is flagged, never netted silently.
    const reconciliation = pieceRateReconciliationResponseSchema.parse(
      ok(await qs.call("get", `payroll/projects/${projectId}/piece-rate-reconciliation`)),
    );
    expect(reconciliation.items.find((row) => row.bqItem.lineageId === item.C)).toMatchObject({
      measured: "80",
      pieceRateQuantity: "90",
      pieceRateAmountMinor: 1_350_000,
      excessPieceRate: "10",
      flags: ["piece-rate-above-measured"],
      jobs: [expect.objectContaining({ id: job.id })],
    });
    expect(reconciliation.flagged).toBe(1);
    for (const outsider of [client, supplierUser, consultant])
      refused(
        await outsider.call("get", `payroll/projects/${projectId}/piece-rate-reconciliation`),
        403,
      );

    // More than the agreed quantity needs an approved extension (never by its requester).
    job = pieceRateJobResponseSchema.parse(
      ok(
        await pm.call("post", `payroll/piece-rate-jobs/${job.id}/extensions`, {
          quantity: "20",
          reason: "Extra wall to the store (synthetic)",
        }),
        201,
      ),
    ).job;
    const extension = job.extensions[0]!;
    const decideExtension = (browser: Browser) =>
      browser.call("post", `payroll/piece-rate-jobs/${job.id}/extensions/${extension.id}/approve`, {
        version: extension.version,
      });
    refused(await decideExtension(pm), 409, "same-person");
    job = pieceRateJobResponseSchema.parse(ok(await decideExtension(finance))).job;
    expect(job).toMatchObject({ quantityInForce: "120", approvedQuantity: "90" });
    view = pieceRateJobResponseSchema.parse(
      ok(await recordOn(job, { workDate: daysAgo(6), quantity: "25" }), 201),
    );
    expect(view.job).toMatchObject({ pendingQuantity: "25", remainingQuantity: "5" });
    const list = pieceRateJobsResponseSchema.parse(
      ok(await agent.call("get", `payroll/projects/${projectId}/piece-rate-jobs`)),
    );
    expect(list.jobs.map((row) => row.code)).toEqual(["PRJ-0001"]);
    expect(list.permissions).toMatchObject({ canCreate: false, canRecord: true });
  });

  it("holds every subcontract rule in the database for the runtime role", async () => {
    const certifiedLine = lineOf(sc1, item.A);
    const statements: [Browser, (tx: Raw) => Promise<number>, RegExp][] = [
      [
        pm,
        (tx) =>
          tx.$executeRaw`UPDATE subcontracts SET retention_percent = 1 WHERE id = ${sc1.id}::uuid`,
        /terms never change/,
      ],
      [
        pm,
        (tx) => tx.$executeRaw`DELETE FROM subcontracts WHERE id = ${sc1.id}::uuid`,
        /never deleted|permission denied/,
      ],
      // Who submitted, approved and started it never changes, whatever else is updated.
      [
        pm,
        (tx) =>
          tx.$executeRaw`UPDATE subcontracts SET activated_by = ${finance.auth.user.id}::uuid WHERE id = ${sc1.id}::uuid`,
        /keeps its submission and approval/,
      ],
      [
        pm,
        (tx) =>
          tx.$executeRaw`UPDATE subcontracts SET submitted_by = ${finance.auth.user.id}::uuid WHERE id = ${sc1.id}::uuid`,
        /keeps its submission and approval/,
      ],
      [
        pm,
        (tx) =>
          tx.$executeRaw`UPDATE subcontract_lines SET quantity = 1 WHERE id = ${certifiedLine.id}::uuid`,
        /never change|permission denied/,
      ],
      [
        pm,
        (tx) => tx.$executeRaw`DELETE FROM subcontract_lines WHERE id = ${certifiedLine.id}::uuid`,
        /only from a draft|permission denied/,
      ],
      [
        pm,
        (tx) =>
          tx.$executeRaw`DELETE FROM subcontract_variations WHERE subcontract_id = ${sc1.id}::uuid`,
        /never deleted|permission denied/,
      ],
      [
        finance,
        (tx) =>
          tx.$executeRaw`UPDATE subcontract_advances SET amount_minor = 1 WHERE subcontract_id = ${sc1.id}::uuid`,
        /keeps its amount/,
      ],
      [
        finance,
        (tx) =>
          tx.$executeRaw`UPDATE subcontract_certificates SET amount_due_minor = 1 WHERE id = ${scc1.id}::uuid`,
        /certified subcontract certificate never changes/,
      ],
      [
        finance,
        (tx) =>
          tx.$executeRaw`UPDATE subcontract_certificate_lines SET quantity_to_date = 1 WHERE certificate_id = ${scc1.id}::uuid`,
        /never change|permission denied/,
      ],
      [
        finance,
        (tx) =>
          tx.$executeRaw`UPDATE subcontract_invoices SET amount_minor = 1 WHERE certificate_id = ${scc1.id}::uuid`,
        /never changes|permission denied/,
      ],
      [
        finance,
        (tx) =>
          tx.$executeRaw`DELETE FROM subcontract_payments WHERE certificate_id = ${scc1.id}::uuid`,
        /never changes|permission denied/,
      ],
    ];
    for (const [browser, work, message] of statements)
      await expect(raw(browser, work), String(message)).rejects.toThrow(message);

    // A payment: never by the certifier, never above what the certificate made payable.
    const paymentSql = (browser: Browser, amount: number) =>
      raw(
        browser,
        (tx) => tx.$executeRaw`
          INSERT INTO subcontract_payments (id, tenant_id, project_id, subcontract_id,
            certificate_id, amount_minor, paid_on, method, reference, reference_key,
            idempotency_key, request_digest, recorded_by)
          VALUES (${uuidv7()}::uuid, ${tenantA}::uuid, ${projectId}::uuid, ${sc2.id}::uuid,
            ${scc2.id}::uuid, ${amount}, ${today}::date, 'cheque', ${`CHQ-${amount}`},
            ${`CHQ${amount}`}, ${randomUUID()}, ${"0".repeat(64)},
            ${browser.auth.user.id}::uuid)`,
      );
    await expect(paymentSql(finance, 1)).rejects.toThrow(/other than the certifier/);
    await expect(paymentSql(owner, 11_316_961)).rejects.toThrow(
      /never exceed what the certificate made payable/,
    );
    // A certified certificate posts once: a copy of its accrual is refused.
    await expect(
      raw(
        finance,
        (tx) => tx.$executeRaw`
          INSERT INTO cost_entries (id, tenant_id, project_id, measure, category, bq_version_id,
            bq_item_lineage_id, counterparty_kind, supplier_id, counterparty_name,
            payment_reference, amount_minor, occurred_on, source, purpose,
            subcontract_certificate_id, subcontract_line_id, recorded_by, business_date)
          SELECT ${uuidv7()}::uuid, tenant_id, project_id, measure, category, bq_version_id,
                 bq_item_lineage_id, counterparty_kind, supplier_id, counterparty_name,
                 payment_reference, amount_minor, occurred_on, source, purpose,
                 subcontract_certificate_id, subcontract_line_id, ${finance.auth.user.id}::uuid,
                 business_date
            FROM cost_entries WHERE subcontract_certificate_id = ${scc1.id}::uuid`,
      ),
    ).rejects.toThrow(/subcontract_line_once|duplicate key/);
    // An advance above the agreed limit and a claim on a certified certificate.
    await expect(
      raw(
        pm,
        (tx) => tx.$executeRaw`
          INSERT INTO subcontract_advances (id, tenant_id, project_id, subcontract_id, number,
            amount_minor, reason, requested_by)
          VALUES (${uuidv7()}::uuid, ${tenantA}::uuid, ${projectId}::uuid, ${sc1.id}::uuid, 2,
            1, 'More', ${pm.auth.user.id}::uuid)`,
      ),
    ).rejects.toThrow(/never exceed the advance agreed/);
    await expect(
      raw(
        pm,
        (tx) => tx.$executeRaw`
          INSERT INTO subcontract_certificate_claims (tenant_id, subcontract_id, certificate_id,
            line_id, quantity_to_date, entered_by)
          VALUES (${tenantA}::uuid, ${sc2.id}::uuid, ${scc2.id}::uuid,
            ${lineOf(sc2, item.B).id}::uuid, 30, ${pm.auth.user.id}::uuid)`,
      ),
    ).rejects.toThrow(/only on an interim draft|duplicate key/);
    // Another company's rows are invisible (forced RLS).
    const seen = await db.run(context(ownerB, tenantB), (tx) =>
      Promise.all([
        tx.subcontract.count({ where: { id: sc1.id } }),
        tx.subcontractCertificate.count({ where: { id: scc1.id } }),
        tx.pieceRateJob.count({ where: { id: job.id } }),
      ]),
    );
    expect(seen).toEqual([0, 0, 0]);
  });

  it("exports certificates and the statement (EN/SW), neutralising formulas, for readers only", async () => {
    const pdf = await finance.download(`subcontract-certificates/${scc1.id}/export/pdf?locale=sw`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    const xlsx = await qs.download(`subcontract-certificates/${scc1.id}/export/xlsx`);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers["content-disposition"]).toMatch(/SCC-0001/);
    const book = XLSX.read(xlsx.body as Buffer, { type: "buffer", cellFormula: true });
    const cells = book.SheetNames.flatMap((name) =>
      Object.entries(book.Sheets[name]!).filter(([address]) => !address.startsWith("!")),
    );
    expect(cells.every(([, cell]) => !(cell as XLSX.CellObject).f)).toBe(true);
    expect(
      cells.some(
        ([, cell]) =>
          (cell as XLSX.CellObject).v ===
          "'=2+3 internal plaster (synthetic formula-injection probe)",
      ),
    ).toBe(true);
    for (const [, cell] of cells) {
      const value = (cell as XLSX.CellObject).v;
      if (typeof value === "string") expect(value).not.toMatch(/^[=+\-@\t\r]/);
    }
    expect(cells.some(([, cell]) => (cell as XLSX.CellObject).v === 40_740)).toBe(true);

    const statement = await finance.download(`subcontracts/${sc1.id}/statement/xlsx?locale=sw`);
    expect(statement.status).toBe(200);
    const sheet = XLSX.read(statement.body as Buffer, { type: "buffer" });
    const values = XLSX.utils
      .sheet_to_json<unknown[]>(sheet.Sheets[sheet.SheetNames[0]!]!, { header: 1 })
      .flat();
    // Certified work 56,000; SCC-0001 due 42,000 and payable 40,740; retention held 1,400 after
    // the release; advances outstanding 8,800.
    for (const figure of [56_000, 42_000, 40_740, 1_400, 8_800])
      expect(values, String(figure)).toContain(figure);
    const statementPdf = await pm.download(`subcontracts/${sc1.id}/statement/pdf`);
    expect((statementPdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    // A client member does not even see the rows (restrictive RLS), so they are not found.
    for (const [outsider, status] of [
      [client, 404],
      [agent, 403],
    ] as const) {
      expect(
        (await outsider.download(`subcontract-certificates/${scc1.id}/export/pdf`)).status,
      ).toBe(status);
      expect((await outsider.download(`subcontracts/${sc1.id}/statement/xlsx`)).status).toBe(
        status,
      );
    }
  });

  it("keeps subcontracts and piece-rate jobs inside the company and the project's roles", async () => {
    refused(await ownerB.call("get", `subcontracts/${sc1.id}`), 404);
    refused(await ownerB.call("get", `subcontract-certificates/${scc1.id}`), 404);
    refused(await ownerB.call("get", `payroll/piece-rate-jobs/${job.id}`), 404);
    refused(await ownerB.call("get", `subcontracts/projects/${projectId}`), 404);
    const overview = subcontractsOverviewResponseSchema.parse(
      ok(await ownerB.call("get", "subcontracts")),
    );
    expect(overview.projects).toEqual([]);
    const mine = subcontractsOverviewResponseSchema.parse(
      ok(await finance.call("get", "subcontracts")),
    );
    expect(mine.projects).toEqual([
      expect.objectContaining({ subcontracts: 3, live: 2, certifiedWorkMinor: 16_440_000 }),
    ]);
    expect(mine.subcontractors.map((row) => row.id).sort()).toEqual(
      [supplier.plaster, supplier.windows].sort(),
    );
    // Quantity surveyors prepare and read but neither approve nor certify.
    refused(await sccAct(qs, scc2, "/return", { reason: "Not certified by a QS" }), 403);
    for (const outsider of [client, consultant]) {
      refused(
        await outsider.call("get", `subcontracts/${sc1.id}`),
        outsider === client ? 404 : 403,
      );
      refused(await outsider.call("get", `payroll/projects/${projectId}/piece-rate-jobs`), 403);
    }
    // Client members (D7.1) and supplier-role members (D7.2 portal) do not even see that
    // subcontract rows exist (restrictive RLS policies), so the record is simply not found.
    refused(await supplierUser.call("get", `subcontracts/${sc1.id}`), 404);
    refused(await supplierUser.call("get", `subcontract-certificates/${scc1.id}`), 404);
    refused(await supplierUser.call("get", `payroll/projects/${projectId}/piece-rate-jobs`), 403);

    // In the database, supplier-role members read no piece-rate job, and client members (D7.1)
    // read none of the subcontract and piece-rate tables.
    const tables = [
      "subcontracts",
      "subcontract_lines",
      "subcontract_variations",
      "subcontract_line_changes",
      "subcontract_advances",
      "subcontract_certificates",
      "subcontract_certificate_claims",
      "subcontract_certificate_lines",
      "subcontract_payments",
      "subcontract_invoices",
      "piece_rate_jobs",
      "piece_rate_job_extensions",
    ];
    const count = (browser: Browser, table: string) =>
      raw(browser, async (tx) =>
        Number(
          (
            await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM ${table}`)
          )[0]!.n,
        ),
      );
    for (const table of tables) {
      const seen = await count(owner, table);
      if (table !== "piece_rate_job_extensions") expect(seen, table).toBeGreaterThan(0);
      expect(await count(client, table), table).toBe(0);
      if (table.startsWith("piece_rate")) expect(await count(supplierUser, table), table).toBe(0);
    }
  });

  it("nets a correcting certificate off what is left to pay on the subcontract", async () => {
    // L is re-measured down from 25 % to 15 %, so SC-0002's next certificate is negative.
    const photo = await uploadPhoto();
    const lower = measurementResponseSchema.parse(
      ok(
        await agent.call("post", `projects/${projectId}/measurements`, {
          bqItemLineageId: item.L,
          measuredOn: daysAgo(3),
          quantityToDate: "15",
          photoIds: [photo],
        }),
        201,
      ),
    ).measurement;
    ok(await qs.call("post", `projects/${projectId}/measurements/${lower.id}/approve`, {}));
    let credit = parseScc(await sccOpen(pm, sc2, daysAgo(2)), 201);
    credit = parseScc(
      await claim(pm, credit, [
        { lineId: lineOf(sc2, item.B).id, quantityToDate: "12" },
        { lineId: lineOf(sc2, item.L).id, quantityToDate: "15" },
      ]),
    );
    credit = parseScc(await sccAct(pm, credit, "/submit"));
    await fresh(finance);
    credit = parseScc(await sccAct(finance, credit, "/certify", { digest: credit.digest }));
    const negative = credit.payableMinor!;
    expect(negative).toBeLessThan(0);
    refused(await pay(owner, credit, { amountMinor: 1, reference: "EFT-CR-1" }), 409);

    // SCC-0002 alone made 11,316,960 payable, but the credit nets off what is left to pay.
    await fresh(owner);
    const left = 11_316_960 + negative;
    refused(
      await pay(owner, scc2, { amountMinor: 11_316_960, reference: "EFT-SC2-1" }),
      409,
      "payment-exceeds-payable",
    );
    scc2 = parseScc(await pay(owner, scc2, { amountMinor: left, reference: "EFT-SC2-2" }));
    refused(
      await pay(owner, scc2, { amountMinor: 1, reference: "EFT-SC2-3" }),
      409,
      "payment-exceeds-payable",
    );
    // The database holds the same limit for the runtime role.
    await expect(
      raw(
        owner,
        (tx) => tx.$executeRaw`
          INSERT INTO subcontract_payments (id, tenant_id, project_id, subcontract_id,
            certificate_id, amount_minor, paid_on, method, reference, reference_key,
            idempotency_key, request_digest, recorded_by)
          VALUES (${uuidv7()}::uuid, ${tenantA}::uuid, ${projectId}::uuid, ${sc2.id}::uuid,
            ${scc2.id}::uuid, 1, ${today}::date, 'cheque', 'CHQ-NET-1', 'CHQNET1',
            ${randomUUID()}, ${"0".repeat(64)}, ${owner.auth.user.id}::uuid)`,
      ),
    ).rejects.toThrow(/subcontract's certified certificates made payable/);
    sc2 = await getSc(finance, sc2);
    expect(sc2.position).toMatchObject({ paidMinor: left, outstandingMinor: 0 });
  });

  it("approves a variation only as it was raised, recomputing its digest", async () => {
    sc2 = parseSc(
      await pm.call("post", `subcontracts/${sc2.id}/variations`, {
        reason: "One window fewer (synthetic)",
        changes: [{ lineId: lineOf(sc2, item.B).id, quantityChange: "-1" }],
      }),
      201,
    );
    const variation = sc2.variations.find((row) => row.status === "pending")!;
    // A change slipped into the pending variation after it was raised (here by its maker, as the
    // runtime role) is not what the approver saw.
    await raw(
      pm,
      (tx) => tx.$executeRaw`
        INSERT INTO subcontract_line_changes (tenant_id, subcontract_id, variation_id, line_id,
          quantity_change, amount_change_minor)
        VALUES (${tenantA}::uuid, ${sc2.id}::uuid, ${variation.id}::uuid,
          ${lineOf(sc2, item.L).id}::uuid, -1, -40000)`,
    );
    await fresh(owner);
    refused(
      await owner.call("post", `subcontracts/${sc2.id}/variations/${variation.id}/approve`, {
        version: variation.version,
        digest: variation.digest,
      }),
      409,
      "subcontract-variation-stale",
    );
    // Its value change no longer adds up either, so the database refuses to decide it at all.
  });

  /** Opens a draft interim certificate on a subcontract. */
  function sccOpen(browser: Browser, sc: SubcontractDetail, valuationDate: string) {
    return browser.call("post", `subcontracts/${sc.id}/certificates`, { valuationDate });
  }
});
