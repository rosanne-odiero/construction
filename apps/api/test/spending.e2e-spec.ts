import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addCalendarDays, nairobiDate, settlementCostMinor } from "@pm-buddy/domain";
import {
  bqImportResponseSchema,
  bqItemSearchResponseSchema,
  bqVersionsResponseSchema,
  budgetDetailResponseSchema,
  budgetsResponseSchema,
  costCodeResponseSchema,
  costCodesResponseSchema,
  costLedgerResponseSchema,
  countResponseSchema,
  expenseResponseSchema,
  floatResponseSchema,
  forecastResponseSchema,
  invoiceDetailResponseSchema,
  journalResponseSchema,
  lpoDetailResponseSchema,
  materialsResponseSchema,
  projectResponseSchema,
  projectSpendingResponseSchema,
  requisitionDetailResponseSchema,
  rfqDetailResponseSchema,
  siteResponseSchema,
  smsParseResponseSchema,
  spendAlertsResponseSchema,
  storesResponseSchema,
  supplierDetailResponseSchema,
  topUpResponseSchema,
  type BqImport,
  type CostEntry,
  type InvoiceDetailResponse,
  type LpoDetailResponse,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { Browser, notifications } from "./support.js";
import { testDatabaseUrls } from "./test-database.js";

/**
 * D5.4 spending end to end under the real runtime role (pmb_app, forced RLS). Figures are worked
 * out by hand (KES minor units; VAT 16 % exclusive):
 * - LPO: 100 bags of cement at 800.00 (for BQ item X) + 10 t of sand at 4,000.00 = 120,000.00 net
 *   (13,920,000 minor incl. VAT). GRN: 60 bags and 10 t. 20 bags are issued to BQ item Y
 *   (1,600,000 at the stores' average). Invoice: 60 × 800 + 10 × 4,000 = 88,000.00 net,
 *   VAT 14,080.00, total 102,080.00.
 * - Committed = approved LPO not yet invoiced: cement 80,000 − 48,000 = 32,000.00 (item X);
 *   sand 40,000 − 40,000 = 0.
 * - Settlement 30,000.00 (cash incl. VAT) costs 30,000 × 88,000 ÷ 102,080 = 25,862.07 net;
 *   the rest (72,080.00) costs 62,137.93, so paid cost adds up to exactly 88,000.00.
 * Synthetic data only.
 */
const today = nairobiDate();
const inDays = (days: number) => addCalendarDays(today, days);
const fixture = (name: string) => readFileSync(new URL(`./fixtures/bq/${name}`, import.meta.url));
const ETIMS = "KRACU0400000078/2231";
const SITE = { lat: -1.2921, lng: 36.8219 };
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const smsDate = `${today.slice(8, 10)}/${today.slice(5, 7)}/${today.slice(2, 4)}`;
const TILL_SMS = `SKC3D4E5F6 Confirmed. Ksh850.00 paid to MWANGI HARDWARE (SYNTHETIC). on ${smsDate} at 2:15 PM.New M-PESA balance is Ksh2,630.50. Transaction cost, Ksh0.00.`;

describe("Spending and cash flow (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let ownerB: Browser;
  let finance: Browser;
  let financeTwo: Browser;
  let pm: Browser;
  let agent: Browser;
  let client: Browser;
  let supplierUser: Browser;
  let tenantA: string;
  let tenantB: string;
  let projectId: string;
  let siteId: string;
  let notificationSpy: ReturnType<typeof vi.spyOn>;
  const material = { cement: "", sand: "" };
  const item = { x: "", y: "" };
  let supplierId: string;
  let lpo: LpoDetailResponse;
  let invoice: InvoiceDetailResponse;
  let floatId: string;
  let expenseA: string;
  let pettyCodeId: string | undefined;

  const fresh = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
  /** MFA verified at sign-in but not recently: step-up is required again. */
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
    requestId: "d54-direct",
  });
  const keyed = (browser: Browser, path: string, body: object, key: string = randomUUID()) =>
    browser.call("post", path, body, true, { "Idempotency-Key": key });
  const spending = async (browser: Browser = finance) =>
    projectSpendingResponseSchema.parse(
      ok(await browser.call("get", `spending/projects/${projectId}`)),
    );
  const ledger = async (query = "") =>
    costLedgerResponseSchema.parse(
      ok(await finance.call("get", `spending/ledger?projectId=${projectId}&limit=200${query}`)),
    );
  const floatOf = async (browser: Browser = finance) =>
    floatResponseSchema.parse(ok(await browser.call("get", `petty-cash/floats/${floatId}`))).float;
  const expense = (browser: Browser, body: object, key: string = randomUUID()) =>
    keyed(
      browser,
      "petty-cash/expenses",
      {
        id: randomUUID(),
        floatId,
        capturedAt: new Date().toISOString(),
        spentOn: today,
        category: "petty_cash",
        counterpartyKind: "other",
        paymentMethod: "cash",
        payeeName: "Site shop (synthetic)",
        costCodeId: pettyCodeId,
        description: "Site sundries (synthetic)",
        ...body,
      },
      key,
    );

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
    pm = new Browser(app);
    agent = new Browser(app);
    client = new Browser(app);
    supplierUser = new Browser(app);
    for (const browser of [owner, ownerB, finance, financeTwo, pm]) {
      await browser.register();
      await browser.enroll();
    }
    for (const browser of [agent, client, supplierUser]) await browser.register();
    const a = await owner.call("post", "tenants", { name: "Spending company A" });
    const b = await ownerB.call("post", "tenants", { name: "Spending company B" });
    expect([a.status, b.status]).toEqual([201, 201]);
    tenantA = (a.body as { tenant: { id: string } }).tenant.id;
    tenantB = (b.body as { tenant: { id: string } }).tenant.id;
    await fresh(owner);
    projectId = projectResponseSchema.parse(
      ok(await owner.call("post", "projects", { name: "Spending project (synthetic)" }), 201),
    ).project.id;
    siteId = siteResponseSchema.parse(
      ok(
        await owner.call("post", `projects/${projectId}/sites`, {
          name: "Main yard",
          geofence: { kind: "radius", center: SITE, radiusM: 200 },
        }),
        201,
      ),
    ).site.id;
    await join(finance, "finance", []);
    await join(financeTwo, "finance", []);
    await join(pm, "project_manager", [projectId]);
    await join(agent, "site_agent", [projectId]);
    await join(client, "client", [projectId]);
    await join(supplierUser, "supplier", [projectId]);

    // An approved BQ (imported by the owner, approved by the PM).
    const base = `projects/${projectId}/bq`;
    let current: BqImport = bqImportResponseSchema.parse(
      ok(
        await owner.upload(
          `${base}/imports`,
          fixture("kenyan-multi-bill.xlsx"),
          "kenyan-multi-bill.xlsx",
        ),
        201,
      ),
    ).import;
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
    const items = bqItemSearchResponseSchema.parse(
      ok(await finance.call("get", `spending/projects/${projectId}/bq-items`)),
    ).items;
    expect(items.length).toBeGreaterThan(2);
    item.x = items[0]!.lineageId;
    item.y = items[1]!.lineageId;

    // A supplier with verified payout details; one quotation is enough.
    ok(await owner.call("post", "materials/defaults", {}));
    const materials = materialsResponseSchema.parse(
      ok(await owner.call("get", "materials?limit=200")),
    ).materials;
    material.cement = materials.find((entry) => entry.name === "Cement 42.5N (50 kg bag)")!.id;
    material.sand = materials.find((entry) => entry.name === "River sand")!.id;
    supplierId = supplierDetailResponseSchema.parse(
      ok(
        await owner.call("post", "suppliers", {
          legalName: "Spending supplier (synthetic)",
          etimsStatus: "registered",
          creditDays: 30,
        }),
        201,
      ),
    ).supplier.id;
    await fresh(owner);
    const proposed = supplierDetailResponseSchema.parse(
      ok(
        await owner.call("post", `suppliers/${supplierId}/payout-details`, {
          replaces: null,
          mpesaKind: "paybill",
          paybillNumber: "600000",
          accountReference: "D54-TEST",
        }),
        201,
      ),
    );
    await fresh(financeTwo);
    ok(
      await financeTwo.call(
        "post",
        `suppliers/${supplierId}/payout-details/${proposed.payout.current!.id}/verify`,
        { method: "call_back_known_number", note: "Called the number on file (test)." },
      ),
    );
    ok(
      await owner.call("put", "procurement/settings", {
        version: 0,
        priceChangeAlertPercent: "10",
        minQuotes: 1,
      }),
    );
    let requisition = requisitionDetailResponseSchema.parse(
      ok(
        await agent.call("post", "procurement/requisitions", {
          projectId,
          siteId,
          neededBy: inDays(7),
          lines: [
            {
              materialId: material.cement,
              quantity: "100",
              unit: "bag_50kg",
              bqItemLineageId: item.x,
            },
            { materialId: material.sand, quantity: "10", unit: "t" },
          ],
        }),
        201,
      ),
    );
    requisition = requisitionDetailResponseSchema.parse(
      ok(
        await agent.call("post", `procurement/requisitions/${requisition.requisition.id}/submit`, {
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
          deliveryDate: inDays(10),
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
    expect(lpo.lpo.totalMinor).toBe(13_920_000);
    const line = (id: string) => lpo.lines.find((entry) => entry.material.id === id)!.id;
    ok(
      await keyed(agent, "procurement/grns", {
        id: randomUUID(),
        lpoId: lpo.lpo.id,
        siteId,
        capturedAt: new Date().toISOString(),
        receivedByName: "Grace (synthetic)",
        vehicleRegistration: "KDA 123A",
        location: { latitude: SITE.lat, longitude: SITE.lng, accuracyM: 8 },
        lines: [
          { lpoLineId: line(material.cement), receivedQuantity: "60" },
          { lpoLineId: line(material.sand), receivedQuantity: "10" },
        ],
      }),
      201,
    );
    // 20 bags of cement to BQ item Y: material issues re-allocate cost, they never add it.
    const storeId = storesResponseSchema.parse(ok(await owner.call("get", "stores"))).stores[0]!.id;
    ok(
      await keyed(owner, "stock-movements/issues", {
        id: randomUUID(),
        storeId,
        capturedAt: new Date().toISOString(),
        bqItemLineageId: item.y,
        issuedToName: "Concrete gang (synthetic)",
        lines: [{ materialId: material.cement, quantity: "20", unit: "bag_50kg" }],
      }),
      201,
    );
  }, 300_000);

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("documents every D5.4 operation in OpenAPI", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "getSpendingSummary",
      "getSpendingSettings",
      "updateSpendingSettings",
      "getProjectSpending",
      "listBillSpending",
      "searchSpendingBqItems",
      "listCostEntries",
      "getCashFlowForecast",
      "listSpendAlerts",
      "listCostCodes",
      "createCostCode",
      "loadDefaultCostCodes",
      "updateCostCode",
      "listBudgets",
      "createBudget",
      "getBudget",
      "updateBudget",
      "listBudgetLines",
      "addBudgetLine",
      "updateBudgetLine",
      "removeBudgetLine",
      "submitBudget",
      "approveBudget",
      "returnBudget",
      "cancelBudget",
      "listCostJournals",
      "createCostJournal",
      "createReversalJournal",
      "getCostJournal",
      "approveCostJournal",
      "rejectCostJournal",
      "listFloats",
      "createFloat",
      "listFloatCustodians",
      "getFloat",
      "updateFloat",
      "listFloatLedger",
      "parseMpesaSms",
      "listExpenses",
      "createExpense",
      "getExpense",
      "uploadExpenseReceipt",
      "downloadReceipt",
      "approveExpense",
      "rejectExpense",
      "listTopUps",
      "requestTopUp",
      "approveTopUp",
      "rejectTopUp",
      "payTopUp",
      "cancelTopUp",
      "listCounts",
      "recordCount",
      "approveCount",
      "returnCount",
      "listCashFlowItems",
      "createCashFlowItem",
      "updateCashFlowItem",
      "receiveCashFlowItem",
      "cancelCashFlowItem",
    ])
      expect(operations, id).toContain(id);
  });

  it("accrues an approved invoice's subtotal once and posts only the cost part of each settlement; issues re-allocate cost", async () => {
    const line = (id: string) => lpo.lines.find((entry) => entry.material.id === id)!.id;
    invoice = invoiceDetailResponseSchema.parse(
      ok(
        await finance.call("post", "procurement/invoices", {
          lpoId: lpo.lpo.id,
          invoiceNumber: "D54-INV-1",
          invoiceDate: today,
          etimsInvoiceNumber: ETIMS,
          subtotalMinor: 8_800_000,
          vatMinor: 1_408_000,
          totalMinor: 10_208_000,
          lines: [
            {
              lpoLineId: line(material.cement),
              quantity: "60",
              unitPriceMinor: 80_000,
              vatTreatment: "exclusive",
            },
            {
              lpoLineId: line(material.sand),
              quantity: "10",
              unitPriceMinor: 400_000,
              vatTreatment: "exclusive",
            },
          ],
        }),
        201,
      ),
    );
    invoice = invoiceDetailResponseSchema.parse(
      ok(
        await finance.call("post", `procurement/invoices/${invoice.invoice.id}/submit`, {
          version: invoice.invoice.version,
        }),
      ),
    );
    expect(invoice.invoice.status).toBe("matched");
    // Nothing is accrued before approval.
    expect((await ledger()).entries).toEqual([]);
    await fresh(owner);
    invoice = invoiceDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/invoices/${invoice.invoice.id}/approve`, {
          version: invoice.invoice.version,
          matchId: invoice.match!.id,
          payoutVersionId: invoice.payee!.id,
        }),
      ),
    );
    let entries = (await ledger()).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: "supplier_invoice",
      purpose: "accrual",
      measure: "accrued",
      category: "materials",
      amountMinor: 8_800_000,
      bqItem: null,
      costCode: null,
      counterpartyKind: "supplier",
      supplier: { id: supplierId },
      paymentReference: "D54-INV-1",
      site: { id: siteId },
      document: { kind: "supplier_invoice", label: "D54-INV-1" },
    });

    await fresh(financeTwo);
    ok(
      await keyed(financeTwo, `procurement/invoices/${invoice.invoice.id}/settlements`, {
        method: "bank_transfer",
        externalReference: "D54-FT-0001",
        amountMinor: 3_000_000,
        paidOn: today,
      }),
      201,
    );
    entries = (await ledger("&measure=paid")).entries;
    const first = settlementCostMinor({
      subtotalMinor: 8_800_000,
      totalMinor: 10_208_000,
      settledBeforeMinor: 0,
      amountMinor: 3_000_000,
    });
    expect(first).toBe(2_586_207);
    expect(
      entries.map((entry) => [entry.purpose, entry.amountMinor, entry.paymentReference]),
    ).toEqual([["payment", 2_586_207, "D54-FT-0001"]]);
    // A settlement is stamped when inserted under the invoice lock, not at its transaction's start,
    // so overlapping payments apportion cost in the order they were recorded (rolled back).
    class Rollback extends Error {
      constructor(readonly lagSeconds: number) {
        super("rollback");
      }
    }
    type Raw = {
      $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number>;
      $queryRaw: <T>(s: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
    };
    const stamped = await db
      .run(context(financeTwo), async (tx) => {
        const raw = tx as unknown as Raw;
        await raw.$executeRaw`SELECT pg_sleep(0.4)`;
        const id = randomUUID();
        await raw.$executeRaw`
          INSERT INTO invoice_settlements (id, tenant_id, invoice_id, payable_id, method,
            external_reference, reference_key, amount_minor, paid_on, idempotency_key,
            request_digest, recorded_by)
          SELECT ${id}::uuid, tenant_id, invoice_id, payable_id, method, 'D54-STAMP-1',
                 'D54STAMP1', 1, paid_on, ${randomUUID()}, repeat('a', 64), recorded_by
            FROM invoice_settlements
           WHERE invoice_id = ${invoice.invoice.id}::uuid AND external_reference = 'D54-FT-0001'`;
        const [row] = await raw.$queryRaw<{ lag: number }[]>`
          SELECT extract(epoch FROM recorded_at - now())::float8 AS lag
            FROM invoice_settlements WHERE id = ${id}::uuid`;
        throw new Rollback(row!.lag);
      })
      .catch((error: unknown) => error);
    expect(stamped).toBeInstanceOf(Rollback);
    expect((stamped as Rollback).lagSeconds).toBeGreaterThan(0.3);

    const view = await spending();
    expect(view.totals).toMatchObject({
      budgetMinor: null,
      actualMinor: 8_800_000,
      committedMinor: 3_200_000,
      paidMinor: 2_586_207,
      usedPercent: null,
      level: "unavailable",
    });
    expect(view.cashPaidMinor).toBe(3_000_000);
    expect(view.categories.find((row) => row.category === "materials")).toMatchObject({
      actualMinor: 8_800_000,
      committedMinor: 3_200_000,
      paidMinor: 2_586_207,
    });
    expect(view.materials).toEqual({
      accruedMinor: 8_800_000,
      issuedMinor: 1_600_000,
      notIssuedMinor: 7_200_000,
      transferredInMinor: 0,
      transferredOutMinor: 0,
    });
    // The issue moved 16,000.00 onto item Y without adding cost: bills + not-on-items = total.
    const onBills = view.bills.reduce((sum, bill) => sum + bill.actualMinor, 0);
    expect(onBills).toBe(1_600_000);
    expect(view.notOnBqItems.actualMinor).toBe(7_200_000);
    expect(onBills + view.notOnBqItems.actualMinor).toBe(view.totals.actualMinor);
    expect(view.bills.reduce((sum, bill) => sum + bill.committedMinor, 0)).toBe(3_200_000);
    // The procurement commitments view shows the same open commitment (shared computation).
    const commitments = ok(
      await finance.call("get", `procurement/commitments?projectId=${projectId}`),
    ) as {
      totals: { openCommitmentMinor: number };
    };
    expect(commitments.totals.openCommitmentMinor).toBe(view.totals.committedMinor);

    // The rest in two payments, one of 0.03: on its own it would cost round(0.0259) = 0.03, but
    // the cumulative apportionment gives 0.02, so the paid cost adds up to exactly the subtotal
    // (rounding each payment separately would end at 88,000.01).
    for (const [reference, amountMinor] of [
      ["D54-FT-0002", 3],
      ["D54-FT-0003", 7_207_997],
    ] as const)
      ok(
        await keyed(financeTwo, `procurement/invoices/${invoice.invoice.id}/settlements`, {
          method: "bank_transfer",
          externalReference: reference,
          amountMinor,
          paidOn: today,
        }),
        201,
      );
    expect(
      (await ledger("&measure=paid")).entries.map((entry) => entry.amountMinor).reverse(),
    ).toEqual([2_586_207, 2, 6_213_791]);
    const totals = (await ledger()).totals;
    expect(totals).toMatchObject({ accruedMinor: 8_800_000, paidMinor: 8_800_000, count: 4 });
  });

  it("keeps the cost ledger append-only: corrections are reversal journals, maker-checked and posted once", async () => {
    const [accrual] = (await ledger("&source=supplier_invoice")).entries;
    type Raw = { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> };
    await expect(
      db.run(
        context(finance),
        (tx) =>
          (tx as unknown as Raw)
            .$executeRaw`UPDATE cost_entries SET amount_minor = 1 WHERE id = ${accrual!.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.run(
        context(finance),
        (tx) =>
          (tx as unknown as Raw)
            .$executeRaw`DELETE FROM cost_entries WHERE id = ${accrual!.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    // A forged entry that does not match its source is refused even with the right tags.
    await expect(
      db.run(
        context(finance),
        (tx) =>
          (tx as unknown as Raw).$executeRaw`INSERT INTO cost_entries (id, tenant_id, project_id,
          site_id, measure, category, counterparty_kind, supplier_id, counterparty_name,
          payment_reference, amount_minor, occurred_on, source, purpose, invoice_id, recorded_by,
          business_date)
          SELECT gen_random_uuid(), tenant_id, project_id, site_id, measure, category,
                 counterparty_kind, supplier_id, counterparty_name, payment_reference, 1,
                 occurred_on, source, purpose, invoice_id, ${finance.auth.user.id}::uuid, business_date
            FROM cost_entries WHERE id = ${accrual!.id}::uuid`,
      ),
    ).rejects.toThrow(/invoice accrual posts|invoice_once|duplicate key/);
    const schemaOwner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrls().migrationUrl }),
    });
    try {
      for (const statement of [
        `UPDATE cost_entries SET amount_minor = 1 WHERE id = '${accrual!.id}'`,
        `DELETE FROM cost_entries WHERE id = '${accrual!.id}'`,
      ])
        await expect(
          schemaOwner.$transaction([
            schemaOwner.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantA}', true)`),
            schemaOwner.$executeRawUnsafe(statement),
          ]),
        ).rejects.toThrow(/append-only/);
    } finally {
      await schemaOwner.$disconnect();
    }

    // Reversal: proposed by finance, never approved by its author; step-up for the approver.
    refused(
      await pm.call("post", "cost-journals/reversal", {
        entryId: accrual!.id,
        reason: "Wrong project",
      }),
      403,
    );
    let journal = journalResponseSchema.parse(
      ok(
        await finance.call("post", "cost-journals/reversal", {
          entryId: accrual!.id,
          reason: "Posted to the wrong project (test)",
        }),
        201,
      ),
    );
    expect(journal.journal.lines[0]).toMatchObject({
      amountMinor: -8_800_000,
      reversesEntryId: accrual!.id,
      postedEntryId: null,
    });
    expect(journal.permissions.canApprove).toBe(false);
    refused(
      await finance.call("post", "cost-journals/reversal", {
        entryId: accrual!.id,
        reason: "Again",
      }),
      409,
      "entry-already-reversed",
    );
    await fresh(finance);
    refused(
      await finance.call("post", `cost-journals/${journal.journal.id}/approve`, {
        version: journal.journal.version,
      }),
      403,
      "maker-checker",
    );
    await stale(financeTwo);
    refused(
      await financeTwo.call("post", `cost-journals/${journal.journal.id}/approve`, {
        version: journal.journal.version,
      }),
      403,
      "step-up-required",
    );
    await fresh(financeTwo);
    journal = journalResponseSchema.parse(
      ok(
        await financeTwo.call("post", `cost-journals/${journal.journal.id}/approve`, {
          version: journal.journal.version,
        }),
      ),
    );
    expect(journal.journal.status).toBe("approved");
    const reversalId = journal.journal.lines[0]!.postedEntryId!;
    const entries = (await ledger()).entries;
    const reversal = entries.find((entry) => entry.id === reversalId)!;
    expect(reversal).toMatchObject({
      purpose: "reversal",
      amountMinor: -8_800_000,
      reversesEntryId: accrual!.id,
      measure: "accrued",
    });
    expect(entries.find((entry) => entry.id === accrual!.id)!.reversedByEntryId).toBe(reversalId);
    refused(
      await finance.call("post", "cost-journals/reversal", {
        entryId: reversalId,
        reason: "Undo the undo",
      }),
      409,
      "entry-is-reversal",
    );
    // An adjustment journal re-posts the cost (so later figures are unchanged), maker-checked.
    const codes = costCodesResponseSchema.parse(
      ok(await finance.call("post", "cost-codes/defaults", {}), 201) &&
        ok(await finance.call("get", "cost-codes?limit=50")),
    );
    const materials = codes.costCodes.find((code) => code.code === "MAT-01")!;
    pettyCodeId = codes.costCodes.find((code) => code.code === "PC-01")!.id;
    journal = journalResponseSchema.parse(
      ok(
        await financeTwo.call("post", "cost-journals", {
          projectId,
          reason: "Re-post the materials invoice (test)",
          lines: [
            {
              measure: "accrued",
              category: "materials",
              costCodeId: materials.id,
              counterpartyKind: "supplier",
              supplierId,
              paymentReference: "D54-INV-1",
              occurredOn: today,
              amountMinor: 8_800_000,
            },
          ],
        }),
        201,
      ),
    );
    await fresh(finance);
    ok(
      await finance.call("post", `cost-journals/${journal.journal.id}/approve`, {
        version: journal.journal.version,
      }),
    );
    expect((await ledger()).totals).toMatchObject({
      accruedMinor: 8_800_000,
      paidMinor: 8_800_000,
    });
  });

  it("prepares a budget from the BQ, approves it independently on the digest seen, and freezes it", async () => {
    // The site agent cannot prepare budgets; the PM (bq.edit) can, but not approve.
    refused(
      await agent.call("post", "budgets", { projectId, name: "Agent budget", source: "bq" }),
      403,
    );
    let budget = budgetDetailResponseSchema.parse(
      ok(
        await pm.call("post", "budgets", { projectId, name: "Baseline budget", source: "bq" }),
        201,
      ),
    );
    expect(budget.budget).toMatchObject({ versionNo: 1, status: "draft" });
    expect(budget.budget.lineCount).toBeGreaterThan(2);
    refused(
      await pm.call("post", "budgets", { projectId, name: "Second", source: "empty" }),
      409,
      "budget-open",
    );
    const codes = costCodesResponseSchema.parse(
      ok(await pm.call("get", "cost-codes?search=PC-01")),
    ).costCodes;
    budget = budgetDetailResponseSchema.parse(
      ok(
        await pm.call("post", `budgets/${budget.budget.id}/lines`, {
          version: budget.budget.version,
          costCodeId: codes[0]!.id,
          amountMinor: 200_000,
        }),
        201,
      ),
    );
    refused(
      await pm.call("post", `budgets/${budget.budget.id}/lines`, {
        version: budget.budget.version,
        costCodeId: codes[0]!.id,
        amountMinor: 1,
      }),
      409,
      "budget-line-exists",
    );
    // A cost-code line takes its code's category, so a code in use keeps it (API and database);
    // an unused code can still be recategorised.
    const allCodes = costCodesResponseSchema.parse(
      ok(await finance.call("get", "cost-codes?limit=50")),
    ).costCodes;
    const used = allCodes.find((code) => code.id === codes[0]!.id)!;
    refused(
      await finance.call("patch", `cost-codes/${used.id}`, {
        version: used.version,
        category: "materials",
      }),
      409,
      "cost-code-in-use",
    );
    const unused = allCodes.find((code) => code.code === "PRE-02")!;
    const moved = costCodeResponseSchema.parse(
      ok(
        await finance.call("patch", `cost-codes/${unused.id}`, {
          version: unused.version,
          category: "labour",
        }),
      ),
    ).costCode;
    ok(
      await finance.call("patch", `cost-codes/${unused.id}`, {
        version: moved.version,
        category: "preliminaries",
      }),
    );
    type RawCode = { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> };
    await expect(
      db.run(
        context(finance),
        (tx) =>
          (tx as unknown as RawCode)
            .$executeRaw`UPDATE cost_codes SET category = 'materials' WHERE id = ${used.id}::uuid`,
      ),
    ).rejects.toThrow(/in use keeps its category/);
    expect(budget.totals.byCategory).toContainEqual({
      category: "petty_cash",
      amountMinor: 200_000,
    });
    budget = budgetDetailResponseSchema.parse(
      ok(
        await pm.call("post", `budgets/${budget.budget.id}/submit`, {
          version: budget.budget.version,
        }),
      ),
    );
    expect(budget.budget.status).toBe("submitted");
    expect(budget.budget.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(budget.permissions.canApprove).toBe(false);
    refused(
      await pm.call("post", `budgets/${budget.budget.id}/approve`, {
        version: budget.budget.version,
        digest: budget.budget.digest,
      }),
      403,
    );
    // Submitted lines are frozen in the API and the database.
    refused(
      await pm.call("post", `budgets/${budget.budget.id}/lines`, {
        version: budget.budget.version,
        costCodeId: codes[0]!.id,
        amountMinor: 5,
      }),
      409,
      "invalid-transition",
    );
    type Raw = { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> };
    await expect(
      db.run(
        context(pm),
        (tx) =>
          (tx as unknown as Raw)
            .$executeRaw`UPDATE budget_lines SET amount_minor = 1 WHERE budget_id = ${budget.budget.id}::uuid`,
      ),
    ).rejects.toThrow(/only while the budget is a draft/);
    await fresh(finance);
    refused(
      await finance.call("post", `budgets/${budget.budget.id}/approve`, {
        version: budget.budget.version,
        digest: "0".repeat(64),
      }),
      409,
      "budget-stale",
    );
    budget = budgetDetailResponseSchema.parse(
      ok(
        await finance.call("post", `budgets/${budget.budget.id}/approve`, {
          version: budget.budget.version,
          digest: budget.budget.digest,
        }),
      ),
    );
    expect(budget.budget).toMatchObject({ status: "approved", current: true });
    await expect(
      db.run(
        context(finance),
        (tx) =>
          (tx as unknown as Raw)
            .$executeRaw`UPDATE budgets SET name = 'Tampered' WHERE id = ${budget.budget.id}::uuid`,
      ),
    ).rejects.toThrow(/approved budget never changes/);
    const list = budgetsResponseSchema.parse(
      ok(await pm.call("get", `budgets?projectId=${projectId}`)),
    );
    expect(list.budgets.map((entry) => [entry.versionNo, entry.status, entry.current])).toEqual([
      [1, "approved", true],
    ]);
    expect(list.permissions.canCreate).toBe(true);

    const view = await spending();
    expect(view.budget).toMatchObject({ id: budget.budget.id, versionNo: 1 });
    expect(view.totals.budgetMinor).toBe(budget.budget.totalMinor);
    expect(view.categories.find((row) => row.category === "petty_cash")).toMatchObject({
      budgetMinor: 200_000,
      actualMinor: 0,
      usedPercent: "0.0",
      level: "within",
    });
    // Categories without a budget line show no budget (unavailable), never zero.
    expect(view.categories.find((row) => row.category === "plant")).toMatchObject({
      budgetMinor: null,
      usedPercent: null,
      level: "unavailable",
    });
    const billWithY = view.bills.find((bill) => bill.actualMinor === 1_600_000)!;
    const billItems = ok(
      await finance.call(
        "get",
        `spending/projects/${projectId}/bills/${billWithY.bill.lineageId}/items?limit=200`,
      ),
    ) as {
      items: {
        item: { lineageId: string };
        actualMinor: number;
        budgetMinor: number | null;
        contractAmountMinor: number;
      }[];
    };
    const y = billItems.items.find((row) => row.item.lineageId === item.y)!;
    expect(y.actualMinor).toBe(1_600_000);
    expect(y.budgetMinor).toBe(y.contractAmountMinor);
  });

  it("runs a petty-cash float: top-ups maker-checked, offline replay, SMS draft, duplicates and no overdraft", async () => {
    // The custodian must hold finance.petty_cash on the project: the client does not.
    await fresh(finance);
    refused(
      await finance.call("post", "petty-cash/floats", {
        siteId,
        name: "Main yard float",
        custodianUserId: client.auth.user.id,
        limitMinor: 5_000_000,
      }),
      422,
      "custodian-not-eligible",
    );
    floatId = floatResponseSchema.parse(
      ok(
        await finance.call("post", "petty-cash/floats", {
          siteId,
          name: "Main yard float",
          custodianUserId: agent.auth.user.id,
          limitMinor: 5_000_000,
        }),
        201,
      ),
    ).float.id;
    refused(await expense(agent, { amountMinor: 100 }), 409, "float-insufficient");
    refused(
      await agent.call("post", "petty-cash/top-ups", {
        floatId,
        amountMinor: 5_000_001,
        reason: "Too much",
      }),
      409,
      "float-limit-exceeded",
    );
    let topUp = topUpResponseSchema.parse(
      ok(
        await agent.call("post", "petty-cash/top-ups", {
          floatId,
          amountMinor: 3_000_000,
          reason: "Weekly float (test)",
        }),
        201,
      ),
    ).topUp;
    refused(
      await agent.call("post", `petty-cash/top-ups/${topUp.id}/approve`, {
        version: topUp.version,
      }),
      403,
    );
    await fresh(finance);
    topUp = topUpResponseSchema.parse(
      ok(
        await finance.call("post", `petty-cash/top-ups/${topUp.id}/approve`, {
          version: topUp.version,
        }),
      ),
    ).topUp;
    expect(topUp.permissions.canPay).toBe(false);
    refused(
      await finance.call("post", `petty-cash/top-ups/${topUp.id}/pay`, {
        version: topUp.version,
        method: "mpesa",
        reference: "SKZ9Y8X7W6",
        paidOn: today,
      }),
      403,
      "maker-checker",
    );
    await fresh(financeTwo);
    topUp = topUpResponseSchema.parse(
      ok(
        await financeTwo.call("post", `petty-cash/top-ups/${topUp.id}/pay`, {
          version: topUp.version,
          method: "mpesa",
          reference: "SKZ9Y8X7W6",
          paidOn: today,
        }),
      ),
    ).topUp;
    expect(topUp.status).toBe("paid");
    expect((await floatOf(agent)).balanceMinor).toBe(3_000_000);

    // A pasted SMS fills a draft only; it never confirms settlement.
    const parsed = smsParseResponseSchema.parse(
      ok(await agent.call("post", "petty-cash/sms/parse", { text: TILL_SMS })),
    );
    expect(parsed.confirmsSettlement).toBe(false);
    expect(parsed.result).toMatchObject({
      ok: true,
      draft: {
        kind: "till",
        code: "SKC3D4E5F6",
        amountMinor: 85_000,
        counterpartyName: "MWANGI HARDWARE (SYNTHETIC)",
        occurredOn: today,
      },
    });
    expect(parsed.duplicates).toEqual([]);

    // Offline-ready: client ID + Idempotency-Key; a replay returns the original.
    const id = randomUUID();
    const key = randomUUID();
    const body = {
      id,
      capturedAt: new Date().toISOString(),
      amountMinor: 85_000,
      category: "materials",
      bqItemLineageId: item.y,
      costCodeId: undefined,
      payeeName: "MWANGI HARDWARE (SYNTHETIC)",
      paymentMethod: "mpesa",
      mpesaCode: "SKC3D4E5F6",
      parsedFromSms: true,
      smsKind: "till",
      description: "Binding wire for the slab (test)",
    };
    const recorded = expenseResponseSchema.parse(ok(await expense(agent, body, key), 201));
    expenseA = recorded.expense.id;
    const replay = await expense(agent, body, key);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(expenseResponseSchema.parse(ok(replay, 201))).toMatchObject({
      replayed: true,
      expense: { id, number: recorded.expense.number },
    });
    refused(
      await expense(agent, { ...body, amountMinor: 85_001 }, key),
      409,
      "idempotency-key-reused",
    );
    refused(await expense(agent, body, randomUUID()), 409, "expense-id-conflict");
    // One M-Pesa transaction is one expense; the parser now names the duplicate.
    refused(await expense(agent, { ...body, id: randomUUID() }), 409, "mpesa-code-duplicate");
    expect(
      smsParseResponseSchema.parse(
        ok(await agent.call("post", "petty-cash/sms/parse", { text: TILL_SMS })),
      ).duplicates,
    ).toEqual([{ kind: "expense", id, label: recorded.expense.number, status: "submitted" }]);
    // Only the custodian records expenses.
    refused(await expense(finance, { amountMinor: 100 }), 403, "not-custodian");
    ok(
      await expense(agent, {
        amountMinor: 125_000,
        chargeMinor: 1_300,
        costCodeId: costCodesResponseSchema.parse(
          ok(await agent.call("get", "cost-codes?search=PC-01")),
        ).costCodes[0]!.id,
        payeeName: "WANJIKU TESTNAME",
        payeePhoneMasked: "0712***001",
        paymentMethod: "mpesa",
        mpesaCode: "SKA1B2C3D4",
        description: "Water for curing (test)",
      }),
      201,
    );
    expect((await floatOf()).balanceMinor).toBe(3_000_000 - 85_000 - 126_300);

    // Two simultaneous spends that together overdraw the float: exactly one succeeds.
    const costCode = costCodesResponseSchema.parse(
      ok(await agent.call("get", "cost-codes?search=PC-01")),
    ).costCodes[0]!.id;
    const results = await Promise.all(
      [1, 2].map(() =>
        expense(agent, {
          amountMinor: 1_600_000,
          costCodeId: costCode,
          payeeName: "Lorry hire (synthetic)",
          category: "transport",
        }),
      ),
    );
    expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([201, 409]);
    expect(problem(results.find((res) => res.status === 409)!)).toBe("float-insufficient");
    const big = expenseResponseSchema.parse(
      results.find((res) => res.status === 201)!.body,
    ).expense;
    expect((await floatOf()).balanceMinor).toBe(1_188_700);
    // The database refuses any balance change that is not the next ledger entry, and below zero.
    type Raw = { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> };
    await expect(
      db.run(
        context(finance),
        (tx) =>
          (tx as unknown as Raw)
            .$executeRaw`UPDATE petty_cash_floats SET balance_minor = 99999999 WHERE id = ${floatId}::uuid`,
      ),
    ).rejects.toThrow(/next ledger entry/);
    await expect(
      db.run(
        context(finance),
        (tx) =>
          (tx as unknown as Raw)
            .$executeRaw`UPDATE petty_cash_floats SET balance_minor = -1 WHERE id = ${floatId}::uuid`,
      ),
    ).rejects.toThrow(/petty_cash_floats_check|next ledger entry/);

    // Approval needs a receipt and someone who neither recorded nor holds the float.
    refused(
      await pm.call("post", `petty-cash/expenses/${expenseA}/approve`, {
        version: recorded.expense.version,
      }),
      409,
      "receipt-required",
    );
    ok(await agent.upload(`petty-cash/expenses/${expenseA}/receipts`, PNG, "receipt.png"), 201);
    refused(
      await agent.call("post", `petty-cash/expenses/${expenseA}/approve`, {
        version: recorded.expense.version,
      }),
      403,
    );
    const approved = expenseResponseSchema.parse(
      ok(
        await pm.call("post", `petty-cash/expenses/${expenseA}/approve`, {
          version: recorded.expense.version,
        }),
      ),
    );
    expect(approved.expense.status).toBe("approved");
    const posted = (await ledger("&source=petty_cash_expense")).entries;
    expect(
      posted.map((entry: CostEntry) => [
        entry.purpose,
        entry.measure,
        entry.amountMinor,
        entry.category,
        entry.bqItem?.lineageId,
        entry.paymentReference,
      ]),
    ).toEqual([
      ["payment", "paid", 85_000, "materials", item.y, "SKC3D4E5F6"],
      ["accrual", "accrued", 85_000, "materials", item.y, "SKC3D4E5F6"],
    ]);
    // Rejection puts the cash back on the book.
    ok(
      await pm.call("post", `petty-cash/expenses/${big.id}/reject`, {
        version: big.version,
        reason: "Lorry hire goes through an LPO",
      }),
    );
    expect((await floatOf()).balanceMinor).toBe(2_788_700);
  });

  it("keeps a top-up's requester, approver, payer and the float's custodian apart", async () => {
    type Raw = { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> };
    const topUpOf = (res: request.Response, status = 200) =>
      topUpResponseSchema.parse(ok(res, status)).topUp;
    // Finance asks for cash for the site agent's float; a second finance user approves it.
    await fresh(finance);
    let asked = topUpOf(
      await finance.call("post", "petty-cash/top-ups", {
        floatId,
        amountMinor: 100_000,
        reason: "Asked for by finance (test)",
      }),
      201,
    );
    await fresh(financeTwo);
    asked = topUpOf(
      await financeTwo.call("post", `petty-cash/top-ups/${asked.id}/approve`, {
        version: asked.version,
      }),
    );
    // The requester never records the payment, even holding payments.disburse.
    const [mine] = (
      ok(await finance.call("get", `petty-cash/top-ups?floatId=${floatId}`)) as {
        topUps: { id: string; permissions: { canPay: boolean } }[];
      }
    ).topUps.filter((entry) => entry.id === asked.id);
    expect(mine?.permissions.canPay).toBe(false);
    refused(
      await finance.call("post", `petty-cash/top-ups/${asked.id}/pay`, {
        version: asked.version,
        method: "mpesa",
        reference: "SKP1Q2R3S4",
        paidOn: today,
      }),
      403,
      "maker-checker",
    );
    await expect(
      db.run(
        context(finance),
        (tx) =>
          (tx as unknown as Raw).$executeRaw`
            UPDATE petty_cash_top_ups SET status = 'paid', paid_by = ${finance.auth.user.id}::uuid,
              paid_at = now(), paid_on = ${today}::date, method = 'mpesa',
              reference = 'SKP1Q2R3S4', reference_key = 'SKP1Q2R3S4', version = version + 1
             WHERE id = ${asked.id}::uuid`,
      ),
    ).rejects.toThrow(/petty_cash_top_ups_check/);
    ok(
      await finance.call("post", `petty-cash/top-ups/${asked.id}/cancel`, {
        version: asked.version,
        reason: "Test over",
      }),
    );

    // The owner holds every permission; as a float's custodian they neither decide nor pay its top-ups.
    await fresh(owner);
    const yard = siteResponseSchema.parse(
      ok(
        await owner.call("post", `projects/${projectId}/sites`, {
          name: "Owner's yard",
          geofence: { kind: "radius", center: SITE, radiusM: 100 },
        }),
        201,
      ),
    ).site.id;
    await fresh(finance);
    const ownFloat = floatResponseSchema.parse(
      ok(
        await finance.call("post", "petty-cash/floats", {
          siteId: yard,
          name: "Owner's float",
          custodianUserId: owner.auth.user.id,
          limitMinor: 1_000_000,
        }),
        201,
      ),
    ).float.id;
    let own = topUpOf(
      await finance.call("post", "petty-cash/top-ups", {
        floatId: ownFloat,
        amountMinor: 200_000,
        reason: "Owner's float (test)",
      }),
      201,
    );
    await fresh(owner);
    const flags = (
      ok(await owner.call("get", `petty-cash/top-ups?floatId=${ownFloat}`)) as {
        topUps: { permissions: { canApprove: boolean; canReject: boolean } }[];
      }
    ).topUps[0]!.permissions;
    expect(flags).toMatchObject({ canApprove: false, canReject: false });
    refused(
      await owner.call("post", `petty-cash/top-ups/${own.id}/approve`, { version: own.version }),
      403,
      "maker-checker",
    );
    await expect(
      db.run(
        context(owner),
        (tx) =>
          (tx as unknown as Raw).$executeRaw`
            UPDATE petty_cash_top_ups SET status = 'approved', decided_by = ${owner.auth.user.id}::uuid,
              decided_at = now(), version = version + 1
             WHERE id = ${own.id}::uuid`,
      ),
    ).rejects.toThrow(/custodian does not decide or pay/);
    await fresh(financeTwo);
    own = topUpOf(
      await financeTwo.call("post", `petty-cash/top-ups/${own.id}/approve`, {
        version: own.version,
      }),
    );
    await fresh(owner);
    refused(
      await owner.call("post", `petty-cash/top-ups/${own.id}/pay`, {
        version: own.version,
        method: "mpesa",
        reference: "SKO1W2N3E4",
        paidOn: today,
      }),
      403,
      "maker-checker",
    );
    await expect(
      db.run(
        context(owner),
        (tx) =>
          (tx as unknown as Raw).$executeRaw`
            UPDATE petty_cash_top_ups SET status = 'paid', paid_by = ${owner.auth.user.id}::uuid,
              paid_at = now(), paid_on = ${today}::date, method = 'mpesa',
              reference = 'SKO1W2N3E4', reference_key = 'SKO1W2N3E4', version = version + 1
             WHERE id = ${own.id}::uuid`,
      ),
    ).rejects.toThrow(/custodian does not decide or pay/);
    ok(
      await finance.call("post", `petty-cash/top-ups/${own.id}/cancel`, {
        version: own.version,
        reason: "Test over",
      }),
    );
  });

  it("reconciles a count against the book balance and posts the variance after an independent approval", async () => {
    refused(await client.call("post", "petty-cash/counts", { floatId, countedMinor: 1 }), 403);
    let count = countResponseSchema.parse(
      ok(
        await agent.call("post", "petty-cash/counts", {
          floatId,
          countedMinor: 2_700_000,
          note: "Counted with the PM present",
        }),
        201,
      ),
    ).count;
    expect(count).toMatchObject({
      bookMinor: 2_788_700,
      varianceMinor: -88_700,
      status: "submitted",
    });
    refused(
      await agent.call("post", "petty-cash/counts", { floatId, countedMinor: 1 }),
      409,
      "count-open",
    );
    refused(
      await agent.call("post", `petty-cash/counts/${count.id}/approve`, { version: count.version }),
      403,
    );
    count = countResponseSchema.parse(
      ok(
        await pm.call("post", `petty-cash/counts/${count.id}/approve`, { version: count.version }),
      ),
    ).count;
    expect(count.status).toBe("approved");
    expect((await floatOf()).balanceMinor).toBe(2_700_000);
    const variance = (await ledger("&source=petty_cash_count")).entries;
    expect(variance.map((entry) => [entry.measure, entry.category, entry.amountMinor])).toEqual([
      ["paid", "petty_cash", 88_700],
      ["accrued", "petty_cash", 88_700],
    ]);
  });

  it("forecasts weekly cash flow and raises every kind of spend alert", async () => {
    // Approve the charged M-Pesa expense (petty cash 1,250.00 + fees 13.00).
    const submitted = (
      ok(await pm.call("get", `petty-cash/expenses?floatId=${floatId}&status=submitted`)) as {
        expenses: { id: string; version: number; mpesaCode: string | null }[];
      }
    ).expenses.find((entry) => entry.mpesaCode === "SKA1B2C3D4")!;
    ok(await agent.upload(`petty-cash/expenses/${submitted.id}/receipts`, PNG, "receipt.png"), 201);
    ok(
      await pm.call("post", `petty-cash/expenses/${submitted.id}/approve`, {
        version: submitted.version,
      }),
    );
    const fees = (await ledger("&category=fees")).entries;
    expect(fees.map((entry) => [entry.purpose, entry.amountMinor])).toEqual([
      ["charge_payment", 1_300],
      ["charge_accrual", 1_300],
    ]);
    // Petty cash now 1,250.00 + 887.00 shortage = 2,137.00 against a 2,000.00 budget: over.
    // A second 850.00 to the same shop without a receipt, and an expense far above the usual.
    ok(
      await finance.call("put", "spending/settings", {
        version: 0,
        budgetAlertPercent: 80,
        unusualSpendMultiplier: "2",
        unusualSpendMinSamples: 3,
        duplicateWindowDays: 3,
        forecastWeeks: 8,
        openingCashMinor: 50_000_000,
        openingCashOn: today,
      }),
    );
    const costCode = costCodesResponseSchema.parse(
      ok(await agent.call("get", "cost-codes?search=PC-01")),
    ).costCodes[0]!.id;
    ok(
      await expense(agent, {
        amountMinor: 85_000,
        costCodeId: costCode,
        payeeName: "Mwangi Hardware (synthetic)",
        category: "materials",
        description: "More binding wire (test)",
      }),
      201,
    );
    const unusual = expenseResponseSchema.parse(
      ok(
        await expense(agent, {
          amountMinor: 1_000_000,
          costCodeId: costCode,
          payeeName: "Generator repair (synthetic)",
          category: "plant",
          description: "Generator repair (test)",
        }),
        201,
      ),
    ).expense;
    const alerts = spendAlertsResponseSchema.parse(
      ok(await finance.call("get", `spending/alerts?projectId=${projectId}&limit=200`)),
    );
    const kinds = new Set(alerts.alerts.map((alert) => alert.kind));
    expect([...kinds].sort()).toEqual([
      "budget_threshold",
      "duplicate_payment",
      "missing_documents",
      "unusual_spend",
    ]);
    expect(
      alerts.alerts.find(
        (alert) => alert.kind === "budget_threshold" && alert.scope?.category === "petty_cash",
      ),
    ).toMatchObject({
      severity: "critical",
      figures: {
        usedMinor: 213_700,
        budgetMinor: 200_000,
        usedPercent: "106.8",
        thresholdPercent: 80,
      },
    });
    expect(alerts.alerts.find((alert) => alert.kind === "unusual_spend")).toMatchObject({
      records: [{ id: unusual.id }],
      typical: { medianMinor: "85000", multiplier: "2", samples: 3 },
    });
    expect(alerts.alerts.find((alert) => alert.kind === "duplicate_payment")).toMatchObject({
      rule: "same_counterparty_amount",
      severity: "warning",
      records: [{ id: expenseA }, { amountMinor: 85_000 }],
    });
    expect(alerts.counts.missing_documents).toBeGreaterThanOrEqual(2);

    // Forecast: expected receipt, invoice due (paid), LPO commitment, top-up asked for.
    ok(
      await finance.call("post", "cash-flow-items", {
        projectId,
        direction: "in",
        description: "Client instalment 2 (synthetic)",
        expectedOn: inDays(14),
        amountMinor: 5_000_000,
      }),
      201,
    );
    ok(
      await agent.call("post", "petty-cash/top-ups", {
        floatId,
        amountMinor: 1_000_000,
        reason: "Next week (test)",
      }),
      201,
    );
    const project = forecastResponseSchema.parse(
      ok(await pm.call("get", `spending/forecast?projectId=${projectId}`)),
    );
    expect(project.weeks).toHaveLength(8);
    expect(project.opening.basis).toBe("derived");
    expect(project.opening.paidSinceMinor).toBe(10_208_000 + 3_000_000);
    const byKind = (kind: string) => project.lines.filter((line) => line.kind === kind);
    expect(byKind("client_receipts").map((line) => [line.amountMinor, line.date])).toEqual([
      [5_000_000, inDays(14)],
    ]);
    expect(
      byKind("lpo_commitments").map((line) => [line.amountMinor, line.date, line.basis]),
    ).toEqual([[13_920_000 - 10_208_000, inDays(40), "estimated"]]);
    expect(byKind("petty_cash_top_ups").map((line) => line.amountMinor)).toEqual([1_000_000]);
    expect(byKind("supplier_invoices")).toEqual([]);
    refused(await pm.call("get", "spending/forecast"), 403);
    const company = forecastResponseSchema.parse(
      ok(await finance.call("get", "spending/forecast")),
    );
    expect(company.opening).toMatchObject({ basis: "entered", enteredMinor: 50_000_000 });
    expect(company.weeks[0]!.closingMinor).toBe(
      company.opening.amountMinor! + company.weeks[0]!.netMinor,
    );
  });

  it("keeps clients, suppliers, site agents and other companies out of spending records", async () => {
    for (const outsider of [client, supplierUser]) {
      for (const path of [
        `spending/projects/${projectId}`,
        `budgets?projectId=${projectId}`,
        `spending/forecast?projectId=${projectId}`,
        `spending/alerts?projectId=${projectId}`,
        `petty-cash/floats/${floatId}`,
        `petty-cash/expenses/${expenseA}`,
      ])
        refused(await outsider.call("get", path), 403);
      refused(await outsider.call("post", "petty-cash/sms/parse", { text: TILL_SMS }), 403);
      // Company settings (opening cash) and cost codes are internal too.
      refused(await outsider.call("get", "spending/settings"), 403);
      refused(await outsider.call("get", "cost-codes"), 403);
      expect(
        costLedgerResponseSchema.parse(ok(await outsider.call("get", "spending/ledger"))).entries,
      ).toEqual([]);
      expect(
        (ok(await outsider.call("get", "petty-cash/floats")) as { floats: unknown[] }).floats,
      ).toEqual([]);
    }
    // The site agent sees petty cash, never the budget or the cost ledger.
    refused(await agent.call("get", `spending/projects/${projectId}`), 403);
    // The custodian tags expenses with cost codes but never sees the company's settings.
    ok(await agent.call("get", "cost-codes?search=PC"));
    refused(await agent.call("get", "spending/settings"), 403);
    // A project-level finance reader sees the rules but not the company's opening cash.
    expect(
      (ok(await pm.call("get", "spending/settings")) as { settings: object }).settings,
    ).toMatchObject({
      budgetAlertPercent: 80,
      openingCashMinor: null,
      openingCashOn: null,
    });
    expect(
      costLedgerResponseSchema.parse(ok(await agent.call("get", "spending/ledger"))).entries,
    ).toEqual([]);
    expect((await floatOf(agent)).id).toBe(floatId);
    // Company B: 404 on company A's records, and RLS shows nothing.
    refused(await ownerB.call("get", `spending/projects/${projectId}`), 404);
    refused(await ownerB.call("get", `petty-cash/floats/${floatId}`), 404);
    const seen = await db.run(context(ownerB, tenantB), async (tx) => ({
      entries: await tx.costEntry.count(),
      floats: await tx.pettyCashFloat.count(),
      expenses: await tx.pettyCashExpense.count(),
    }));
    expect(seen).toEqual({ entries: 0, floats: 0, expenses: 0 });
    // No amounts, codes, payees or free text in the audit log.
    const events = await db.run(context(owner), (tx) =>
      tx.auditEvent.findMany({ where: { action: { startsWith: "petty_cash." } } }),
    );
    expect(events.length).toBeGreaterThan(5);
    const text = JSON.stringify(events.map((event) => event.metadata));
    for (const secret of ["SKC3D4E5F6", "85000", "MWANGI", "0712", "SKZ9Y8X7W6", "Lorry hire goes"])
      expect(text).not.toContain(secret);
  });
});
