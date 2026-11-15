import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomBytes } from "node:crypto";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import { messages } from "@pm-buddy/i18n";
import { REPORT_DEFINITIONS, REPORT_IDS, REPORT_LIMITS, type ReportId } from "@pm-buddy/types";
import {
  costCodesResponseSchema,
  costLedgerResponseSchema,
  dashboardResponseSchema,
  invoiceDetailResponseSchema,
  journalResponseSchema,
  projectResponseSchema,
  projectSpendingResponseSchema,
  projectValuationsResponseSchema,
  reportModelSchema,
  reportsResponseSchema,
  reportSubscriptionResponseSchema,
  reportSubscriptionsResponseSchema,
  runDueResponseSchema,
  storesResponseSchema,
  supplierDetailResponseSchema,
  type ReportModel,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import type { Prisma } from "../src/generated/prisma/client.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { ReportsService } from "../src/modules/reports/reports.service.js";
import { ReportSchedulerService } from "../src/modules/reports/report-scheduler.service.js";
import { seedDemo, type SeedSummary } from "../src/seed/demo-seed.js";
import { Browser, notifications } from "./support.js";

/**
 * D8.1 dashboards and reports end to end under the real runtime role (pmb_app, forced RLS):
 * - company A is a private copy of the demo company (seedDemo with its own namespace), so every
 *   report has real data; its figures are checked against the source screens and independent SQL;
 * - company B is built by hand: cost journals worked out below, a formula in a counterparty name,
 *   and 5,001 audit events for the export limits.
 * Company B's journals (KES minor units), proposed by the owner and approved by finance:
 *   J1: accrued 125,000.00 (today − 10, counterparty "=HYPERLINK(…)"), paid 100,000.00 (today − 9),
 *       accrued 7,500.00 (today − 40, outside a 30-day period);
 *   J2: accrued −5,000.00 (today − 5).
 *   → last 30 days: 3 entries, accrued 120,000.00, paid 100,000.00; last 60 days: accrued 127,500.00.
 * Synthetic data only.
 */
const today = nairobiDate();
const NAMESPACE = `rpt-${randomBytes(4).toString("hex")}`;
const FORMULA = '=HYPERLINK("http://evil.example","x")';

describe("Dashboards and reports (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let scheduler: ReportSchedulerService;
  let notificationSpy: ReturnType<typeof vi.spyOn>;
  let seed: SeedSummary;
  const people: Record<string, Browser> = {};
  const projects: Record<string, string> = {};
  let supplier: Browser;
  let client: Browser;
  let ownerB: Browser;
  let financeB: Browser;
  let tenantB: string;
  let projectB: string;

  const ok = (res: request.Response, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as unknown;
  };
  const problem = (res: request.Response) => (res.body as { code?: string }).code;
  const refused = (res: request.Response, status: number, code?: string) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    if (code) expect(problem(res)).toBe(code);
  };
  const fresh = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
  const tenantA = () => seed.company.id;
  const asOwnerA = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    db.run({ userId: people["owner"]!.auth.user.id, tenantId: tenantA(), requestId: "d81" }, work);
  const signIn = async (identifier: string, password: string, totp: string | null) => {
    const browser = new Browser(app);
    browser.identifier = identifier;
    await browser.initialize();
    const login = await browser.call("post", "auth/login", { identifier, password });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    browser.auth = login.body as Browser["auth"];
    if (totp) {
      browser.mfaSecret = totp;
      const verified = await browser.call("post", "auth/mfa/step-up", { code: browser.code() });
      expect(verified.status, JSON.stringify(verified.body)).toBe(200);
      browser.auth = verified.body as Browser["auth"];
    }
    const selected = await browser.call("post", `tenants/${tenantA()}/select`, {});
    expect(selected.status, JSON.stringify(selected.body)).toBe(200);
    browser.auth = selected.body as Browser["auth"];
    return browser;
  };
  const join = async (
    owner: Browser,
    member: Browser,
    tenantId: string,
    role: string,
    projectIds: string[],
  ) => {
    await fresh(owner);
    ok(
      await owner.call("post", "tenants/current/invitations", {
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
  const query = (params: Record<string, string | undefined>) =>
    new URLSearchParams(
      Object.entries(params).filter((entry): entry is [string, string] => !!entry[1]),
    ).toString();
  const report = async (
    browser: Browser,
    id: ReportId,
    params: Record<string, string | undefined> = {},
  ): Promise<ReportModel> =>
    reportModelSchema.parse(ok(await browser.call("get", `reports/${id}?${query(params)}`)));
  const totalsOf = (model: ReportModel, key: string) => {
    const section = model.sections.find((entry) => entry.key === key)!;
    return Object.fromEntries(
      section.columns.map((column, index) => [column.key, section.totals?.[index] ?? null]),
    );
  };
  const columnOf = (model: ReportModel, key: string, column: string) => {
    const section = model.sections.find((entry) => entry.key === key)!;
    const index = section.columns.findIndex((entry) => entry.key === column);
    return section.rows.map((row) => row[index]);
  };
  const last = (days: number) => ({ from: addCalendarDays(today, 1 - days), to: today });
  const sheetRows = (content: Buffer, sheet = 0) => {
    const book = XLSX.read(content, { type: "buffer" });
    return XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[book.SheetNames[sheet]!]!, {
      header: 1,
      raw: true,
    });
  };
  const makeDue = (id: string, userId: string) =>
    db.run({ userId, tenantId: tenantA(), requestId: "d81-due" }, (tx) =>
      tx.reportSubscription.update({
        where: { tenantId_id: { tenantId: tenantA(), id } },
        data: { nextRunAt: new Date(Date.now() - 60_000) },
      }),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    db = app.get(TenantDatabase);
    scheduler = app.get(ReportSchedulerService);
    notificationSpy = vi
      .spyOn(app.get(AuthSecurity), "notify")
      .mockImplementation(async (identifier, subject, text) => {
        notifications.set(identifier, [
          ...(notifications.get(identifier) ?? []),
          { subject, text },
        ]);
      });

    // Company A: a private copy of the demo company.
    seed = await seedDemo(app, { namespace: NAMESPACE });
    for (const account of seed.accounts)
      people[account.role] = await signIn(
        account.identifier,
        account.password!,
        account.totp?.secret ?? null,
      );
    supplier = await signIn(
      seed.supplierPortal.account.identifier,
      seed.supplierPortal.account.password!,
      null,
    );
    const rows = await asOwnerA((tx) =>
      tx.project.findMany({ where: { tenantId: tenantA() }, select: { id: true, code: true } }),
    );
    for (const row of rows) projects[row.code] = row.id;
    client = new Browser(app);
    await client.register();
    await join(people["owner"]!, client, tenantA(), "client", [projects["RUI-HTS"]!]);

    // Company B: hand-built cost journals.
    ownerB = new Browser(app);
    financeB = new Browser(app);
    for (const browser of [ownerB, financeB]) {
      await browser.register();
      await browser.enroll();
    }
    const created = await ownerB.call("post", "tenants", { name: "Reports company B" });
    tenantB = (ok(created, 201) as { tenant: { id: string } }).tenant.id;
    await fresh(ownerB);
    projectB = projectResponseSchema.parse(
      ok(await ownerB.call("post", "projects", { name: "Reports project B (synthetic)" }), 201),
    ).project.id;
    await join(ownerB, financeB, tenantB, "finance", []);
    ok(await ownerB.call("post", "cost-codes/defaults", {}), 201);
    const codes = costCodesResponseSchema.parse(
      ok(await ownerB.call("get", "cost-codes?limit=50")),
    ).costCodes;
    const prelims = codes.find((code) => code.category === "preliminaries")!;
    const transport = codes.find((code) => code.category === "transport")!;
    const journal = async (lines: object[]) => {
      await fresh(ownerB);
      const proposed = journalResponseSchema.parse(
        ok(
          await ownerB.call("post", "cost-journals", {
            projectId: projectB,
            reason: "Reports test journal (synthetic)",
            lines,
          }),
          201,
        ),
      ).journal;
      await fresh(financeB);
      ok(
        await financeB.call("post", `cost-journals/${proposed.id}/approve`, {
          version: proposed.version,
        }),
      );
    };
    await journal([
      {
        measure: "accrued",
        category: "preliminaries",
        costCodeId: prelims.id,
        counterpartyKind: "other",
        counterpartyName: FORMULA,
        paymentReference: "RPT-1",
        occurredOn: addCalendarDays(today, -10),
        amountMinor: 12_500_000,
      },
      {
        measure: "paid",
        category: "preliminaries",
        costCodeId: prelims.id,
        counterpartyKind: "other",
        counterpartyName: "Site security (synthetic)",
        occurredOn: addCalendarDays(today, -9),
        amountMinor: 10_000_000,
      },
      {
        measure: "accrued",
        category: "transport",
        costCodeId: transport.id,
        counterpartyKind: "none",
        occurredOn: addCalendarDays(today, -40),
        amountMinor: 750_000,
      },
    ]);
    await journal([
      {
        measure: "accrued",
        category: "preliminaries",
        costCodeId: prelims.id,
        counterpartyKind: "none",
        occurredOn: addCalendarDays(today, -5),
        amountMinor: -500_000,
      },
    ]);
  }, 300_000);

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("documents every D8.1 operation in OpenAPI", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "getDashboard",
      "listReports",
      "getReportOptions",
      "getReport",
      "exportReportPdf",
      "exportReportExcel",
      "listReportSubscriptions",
      "createReportSubscription",
      "updateReportSubscription",
      "deleteReportSubscription",
      "runDueReportSubscriptions",
    ])
      expect(operations).toContain(id);
  });

  it("lists the reports each role may run, and only on the projects it is assigned to", async () => {
    const runnable = async (browser: Browser) =>
      reportsResponseSchema
        .parse(ok(await browser.call("get", "reports")))
        .reports.filter((entry) => entry.canRun)
        .map((entry) => entry.id);
    const all = REPORT_IDS.filter((id) => REPORT_DEFINITIONS[id].available);
    expect(await runnable(people["owner"]!)).toEqual(all);
    expect(await runnable(people["finance"]!)).toEqual(
      all.filter((id) => !["safety-actions", "audit-log"].includes(id)),
    );
    expect(await runnable(people["project_manager"]!)).toEqual(
      all.filter((id) => id !== "audit-log"),
    );
    expect(await runnable(people["site_agent"]!)).toEqual([
      "muster-roll",
      "stock",
      "lpo-register",
      "invoice-ageing",
      "supplier-payments",
      "petty-cash",
      "safety-actions",
    ]);
    // No reports.view: storekeepers, suppliers and clients may not open the reports centre.
    for (const browser of [people["storekeeper"]!, supplier, client])
      refused(await browser.call("get", "reports"), 403, "report-forbidden");

    // The project manager sees only the projects assigned to them (role ∩ assignment).
    const assigned = await asOwnerA((tx) =>
      tx.projectMembership.findMany({
        where: { tenantId: tenantA(), userId: people["project_manager"]!.auth.user.id },
        select: { projectId: true },
      }),
    );
    const pmReports = reportsResponseSchema.parse(
      ok(await people["project_manager"]!.call("get", "reports")),
    ).reports;
    const ledger = pmReports.find((entry) => entry.id === "cost-ledger")!;
    expect(ledger.projects.map((project) => project.id).sort()).toEqual(
      assigned.map((row) => row.projectId).sort(),
    );
    expect(assigned.length).toBeLessThan(Object.keys(projects).length);
  });

  it("never shows more than the source screen shows the same person", async () => {
    const ruiru = projects["RUI-HTS"]!;
    const agent = people["site_agent"]!;
    // Site agents: no payroll or cost data — the ledger screen shows them nothing, the report
    // refuses.
    expect(
      costLedgerResponseSchema.parse(
        ok(await agent.call("get", `spending/ledger?projectId=${ruiru}`)),
      ).totals.count,
    ).toBe(0);
    refused(
      await agent.call("get", `reports/cost-ledger?projectId=${ruiru}`),
      403,
      "report-forbidden",
    );
    refused(await agent.call("get", `reports/budget-vs-actual?projectId=${ruiru}`), 403);
    refused(await agent.call("get", `reports/payroll-register/options?projectId=${ruiru}`), 403);
    refused(await agent.call("get", "reports/audit-log"), 403, "report-forbidden");
    // Storekeepers, suppliers and clients: none.
    for (const browser of [people["storekeeper"]!, supplier, client])
      for (const id of ["stock", "cost-ledger", "petty-cash"] as const)
        refused(await browser.call("get", `reports/${id}?projectId=${ruiru}`), 403);
    // A project the project manager is not assigned to.
    await fresh(people["owner"]!);
    const unassigned = projectResponseSchema.parse(
      ok(
        await people["owner"]!.call("post", "projects", { name: "Not assigned (synthetic)" }),
        201,
      ),
    ).project.id;
    refused(
      await people["project_manager"]!.call("get", `reports/cost-ledger?projectId=${unassigned}`),
      403,
      "report-forbidden",
    );
    // Across projects, the project manager's cost ledger holds only assigned projects.
    const pmLedger = await report(people["project_manager"]!, "cost-ledger", last(366));
    const assigned = reportsResponseSchema
      .parse(ok(await people["project_manager"]!.call("get", "reports")))
      .reports.find((entry) => entry.id === "cost-ledger")!
      .projects.map((project) => project.code);
    for (const code of new Set(columnOf(pmLedger, "entries", "project")))
      expect(assigned).toContain(code);
    // Parameters the report does not take, missing ones and periods past the limit.
    refused(
      await people["owner"]!.call("get", `reports/cost-ledger?siteId=${ruiru}`),
      400,
      "report-parameter-invalid",
    );
    refused(await people["owner"]!.call("get", "reports/muster-roll"), 422, "project-required");
    refused(
      await people["owner"]!.call("get", `reports/muster-roll?projectId=${ruiru}`),
      422,
      "site-required",
    );
    refused(
      await people["owner"]!.call(
        "get",
        `reports/cost-ledger?${query({ projectId: ruiru, from: addCalendarDays(today, -366), to: today })}`,
      ),
      422,
      "period-too-long",
    );
    refused(
      await people["owner"]!.call(
        "get",
        `reports/cost-ledger?${query({ projectId: ruiru, from: today, to: addCalendarDays(today, 1) })}`,
      ),
      422,
      "period-invalid",
    );
    // The audit log asks for the same recent MFA check as the audit screen.
    await prisma.session.update({
      where: { id: people["owner"]!.auth.session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 10 * 60_000) },
    });
    refused(await people["owner"]!.call("get", "reports/audit-log"), 403, "step-up-required");
    await fresh(people["owner"]!);
    expect((await report(people["owner"]!, "audit-log")).sections[0]!.rowCount).toBeGreaterThan(0);
  });

  it("matches its source screens and independent sums on the demo company", async () => {
    const finance = people["finance"]!;
    const ruiru = projects["RUI-HTS"]!;
    const period = last(366);

    // Cost ledger = the ledger screen's totals for the same filters.
    const ledger = await report(finance, "cost-ledger", { projectId: ruiru, ...period });
    const screen = costLedgerResponseSchema.parse(
      ok(
        await finance.call(
          "get",
          `spending/ledger?${query({ projectId: ruiru, ...period, limit: "1" })}`,
        ),
      ),
    );
    expect(totalsOf(ledger, "entries")).toMatchObject({
      accrued: screen.totals.accruedMinor,
      paid: screen.totals.paidMinor,
    });
    expect(ledger.sections[0]!.rowCount).toBe(screen.totals.count);
    expect(totalsOf(ledger, "by-category")).toMatchObject({
      accrued: screen.totals.accruedMinor,
      paid: screen.totals.paidMinor,
    });

    // Budget against actual = the project spending page.
    const budget = await report(finance, "budget-vs-actual", { projectId: ruiru });
    const spending = projectSpendingResponseSchema.parse(
      ok(await finance.call("get", `spending/projects/${ruiru}`)),
    );
    expect(totalsOf(budget, "categories")).toMatchObject({
      budget: spending.totals.budgetMinor,
      committed: spending.totals.committedMinor,
      actual: spending.totals.actualMinor,
      paid: spending.totals.paidMinor,
      used: spending.totals.usedPercent,
    });

    // Valuations register = the project's valuations page (certified amounts).
    const valuations = await report(finance, "valuations-register", { projectId: ruiru });
    const page = projectValuationsResponseSchema.parse(
      ok(await finance.call("get", `projects/${ruiru}/valuations`)),
    );
    expect(totalsOf(valuations, "certificates")).toMatchObject({
      due: page.certified.amountDueMinor,
      vat: page.certified.vatMinor,
      total: page.certified.totalMinor,
    });
    expect(valuations.sections[0]!.rowCount).toBe(page.valuations.length);

    // Stock on hand = the stores screen's values for the project's stores.
    const stock = await report(finance, "stock", { projectId: ruiru, ...last(366) });
    const stores = storesResponseSchema.parse(ok(await finance.call("get", "stores")));
    expect(totalsOf(stock, "on-hand")["value"]).toBe(
      stores.stores
        .filter((store) => store.project.id === ruiru)
        .reduce((sum, store) => sum + store.valueMinor, 0),
    );

    // Payroll register = the batch's stored totals.
    const options = ok(
      await finance.call("get", `reports/payroll-register/options?projectId=${ruiru}`),
    ) as { batches: { id: string }[] };
    const batchId = options.batches[0]!.id;
    const payroll = await report(finance, "payroll-register", { projectId: ruiru, batchId });
    const batch = await asOwnerA((tx) =>
      tx.payrollBatch.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: tenantA(), id: batchId } },
      }),
    );
    expect(totalsOf(payroll, "lines")).toMatchObject({
      gross: Number(batch.grossMinor),
      net: Number(batch.netMinor),
    });
    expect(payroll.sections[0]!.rowCount).toBe(batch.lineCount);

    // Muster roll: days present = confirmed present + half of confirmed half days (SQL).
    const site = await asOwnerA((tx) =>
      tx.site.findFirstOrThrow({
        where: { tenantId: tenantA(), projectId: ruiru },
        orderBy: { name: "asc" },
      }),
    );
    const musterPeriod = last(31);
    const muster = await report(people["owner"]!, "muster-roll", {
      projectId: ruiru,
      siteId: site.id,
      ...musterPeriod,
    });
    const [counted] = await asOwnerA(
      (tx) =>
        tx.$queryRaw<{ halves: bigint; absent: bigint }[]>`
        SELECT COALESCE(sum(CASE r.status WHEN 'present' THEN 2 WHEN 'half_day' THEN 1 ELSE 0 END), 0)::bigint AS halves,
               count(*) FILTER (WHERE r.status = 'absent')::bigint AS absent
          FROM attendance_records r
          JOIN attendance_days d ON d.tenant_id = r.tenant_id AND d.id = r.day_id
         WHERE r.tenant_id = ${tenantA()}::uuid AND r.site_id = ${site.id}::uuid
           AND d.status = 'confirmed'
           AND r.work_date BETWEEN ${musterPeriod.from}::date AND ${musterPeriod.to}::date`,
    );
    const halves = Number(counted!.halves);
    expect(halves).toBeGreaterThan(0);
    expect(totalsOf(muster, "muster")["days"]).toBe(
      `${Math.floor(halves / 2)}${halves % 2 ? ".5" : ""}`,
    );
    expect(totalsOf(muster, "muster")["absent"]).toBe(String(Number(counted!.absent)));

    // Petty cash: closing at today = the float's book balance now.
    const petty = await report(finance, "petty-cash", { projectId: ruiru, ...last(366) });
    expect(petty.sections[0]!.rowCount).toBeGreaterThan(0);
    for (const row of petty.sections[0]!.rows) expect(row[9]).toBe(row[10]);

    // Supplier invoice ageing: outstanding = approved invoices less every payment (SQL).
    const ageing = await report(finance, "invoice-ageing");
    const [owed] = await asOwnerA(
      (tx) =>
        tx.$queryRaw<{ owed: bigint }[]>`
        SELECT COALESCE(sum(x.owed), 0)::bigint AS owed FROM (
          SELECT i.total_minor - COALESCE((SELECT sum(s.amount_minor) FROM invoice_settlements s
                   WHERE s.tenant_id = i.tenant_id AND s.invoice_id = i.id), 0) AS owed
            FROM supplier_invoices i
           WHERE i.tenant_id = ${tenantA()}::uuid
             AND i.status IN ('approved', 'partly_settled', 'settled')) x
         WHERE x.owed > 0`,
    );
    expect(totalsOf(ageing, "summary")["outstanding"]).toBe(Number(owed!.owed));
  });

  it("reports a re-approved invoice's supplier payments once: approved in full, paid once", async () => {
    // MQ-INV-2001 (demo): 9,744,000 approved, 4,000,000 paid today. A change of the supplier's
    // payout details makes it need a fresh approval, which authorises only what is still owed.
    const owner = people["owner"]!;
    const finance = people["finance"]!;
    const kit = projects["KIT-BNG"]!;
    const invoice = await asOwnerA((tx) =>
      tx.supplierInvoice.findFirstOrThrow({
        where: { tenantId: tenantA(), invoiceNumber: "MQ-INV-2001" },
      }),
    );
    const rowOf = async () => {
      const model = await report(finance, "supplier-payments", { projectId: kit, ...last(31) });
      const section = model.sections.find((entry) => entry.key === "invoices")!;
      const row = section.rows.find((entry) => entry[0] === "MQ-INV-2001")!;
      return Object.fromEntries(section.columns.map((column, index) => [column.key, row[index]]));
    };
    const before = await rowOf();
    expect(before).toMatchObject({
      approved: 9_744_000,
      toDate: 4_000_000,
      outstanding: 5_744_000,
    });
    await fresh(owner);
    const current = supplierDetailResponseSchema.parse(
      ok(await owner.call("get", `suppliers/${invoice.supplierId}`)),
    );
    const proposed = supplierDetailResponseSchema.parse(
      ok(
        await owner.call("post", `suppliers/${invoice.supplierId}/payout-details`, {
          replaces: current.payout.current!.id,
          mpesaKind: "till",
          tillNumber: "174379",
        }),
        201,
      ),
    );
    await fresh(finance);
    ok(
      await finance.call(
        "post",
        `suppliers/${invoice.supplierId}/payout-details/${proposed.payout.current!.id}/verify`,
        { method: "call_back_known_number", note: "Called the number on file (test)." },
      ),
    );
    await fresh(owner);
    const detail = invoiceDetailResponseSchema.parse(
      ok(await owner.call("get", `procurement/invoices/${invoice.id}`)),
    );
    const reapproved = invoiceDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/invoices/${invoice.id}/approve`, {
          version: detail.invoice.version,
          matchId: detail.payable!.matchId,
          payoutVersionId: proposed.payout.current!.id,
        }),
      ),
    );
    expect(reapproved.payable).toMatchObject({ current: true, authorisedMinor: 5_744_000 });
    // The report still shows the invoice approved in full and its payment once.
    expect(await rowOf()).toEqual(before);
  });

  it("builds the cost ledger from hand-computed journals and neutralises formulas in Excel", async () => {
    const last30 = await report(ownerB, "cost-ledger", { projectId: projectB, ...last(30) });
    expect(last30.sections[0]!.rowCount).toBe(3);
    expect(totalsOf(last30, "entries")).toMatchObject({ accrued: 12_000_000, paid: 10_000_000 });
    expect(columnOf(last30, "by-category", "category")).toEqual(["Preliminaries"]);
    const last60 = await report(ownerB, "cost-ledger", { ...last(60) });
    expect(totalsOf(last60, "entries")).toMatchObject({ accrued: 12_750_000, paid: 10_000_000 });
    expect(columnOf(last60, "entries", "counterparty")).toContain(FORMULA);

    const file = await ownerB.download(
      `reports/cost-ledger/export/xlsx?${query({ projectId: projectB, ...last(30) })}`,
    );
    expect(file.status).toBe(200);
    const cells = sheetRows(file.body as Buffer).flat();
    expect(cells).toContain(`'${FORMULA}`);
    expect(cells).not.toContain(FORMULA);
    // Money is a number of shillings: the totals row carries 120,000.00 accrued.
    expect(cells).toContain(120_000);
    expect(cells).toContain(-5_000);
    const pdf = await ownerB.download(
      `reports/cost-ledger/export/pdf?${query({ projectId: projectB, ...last(30), locale: "sw" })}`,
    );
    expect((pdf.body as Buffer).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("keeps companies apart", async () => {
    const ruiru = projects["RUI-HTS"]!;
    const list = reportsResponseSchema.parse(ok(await ownerB.call("get", "reports")));
    for (const entry of list.reports)
      for (const project of entry.projects) expect(project.id).toBe(projectB);
    refused(await ownerB.call("get", `reports/cost-ledger?projectId=${ruiru}`), 404);
    refused(await ownerB.call("get", `reports/stock/options?projectId=${ruiru}`), 404);
    refused(await people["owner"]!.call("get", `reports/cost-ledger?projectId=${projectB}`), 404);
    const site = await asOwnerA((tx) =>
      tx.site.findFirstOrThrow({ where: { tenantId: tenantA(), projectId: ruiru } }),
    );
    refused(
      await ownerB.call(
        "get",
        `reports/muster-roll?${query({ projectId: projectB, siteId: site.id })}`,
      ),
      422,
      "report-parameter-invalid",
    );
    const dashboard = dashboardResponseSchema.parse(ok(await ownerB.call("get", "dashboard")));
    expect(dashboard.projects?.map((row) => row.project.id)).toEqual([projectB]);
  });

  it("refuses a PDF above 5,000 rows (use Excel) and any report above the row limit", async () => {
    await db.run({ userId: ownerB.auth.user.id, tenantId: tenantB, requestId: "d81-bulk" }, (tx) =>
      tx.auditEvent.createMany({
        data: Array.from({ length: REPORT_LIMITS.pdfMaxRows + 1 }, (_, index) => ({
          tenantId: tenantB,
          actorId: ownerB.auth.user.id,
          requestId: "d81-bulk",
          action: "test.bulk_event",
          resourceId: `bulk-${index}`,
          metadata: { index },
        })),
      }),
    );
    await fresh(ownerB);
    const params = query({ action: "test.bulk", ...last(1) });
    refused(await ownerB.call("get", `reports/audit-log/export/pdf?${params}`), 422, "use-excel");
    const preview = await report(ownerB, "audit-log", { action: "test.bulk", ...last(1) });
    expect(preview.sections[0]!.rowCount).toBe(REPORT_LIMITS.pdfMaxRows + 1);
    expect(preview.sections[0]!.rows).toHaveLength(REPORT_LIMITS.previewRows);
    expect(preview.truncated).toBe(true);
    const xlsx = await ownerB.download(`reports/audit-log/export/xlsx?${params}`);
    expect(xlsx.status).toBe(200);
    expect(sheetRows(xlsx.body as Buffer).flat()).toContain("bulk-0");
    // Above the row limit (lowered here so the test stays small) nothing is built.
    const limits = REPORT_LIMITS as { maxRows: number };
    const original = limits.maxRows;
    limits.maxRows = REPORT_LIMITS.pdfMaxRows;
    try {
      refused(
        await ownerB.call("get", `reports/audit-log/export/xlsx?${params}`),
        422,
        "report-too-large",
      );
    } finally {
      limits.maxRows = original;
    }
  });

  it("DONE-WHEN: exports every report in the registry to PDF and Excel", async () => {
    const owner = people["owner"]!;
    await fresh(owner);
    const ruiru = projects["RUI-HTS"]!;
    const params = async (id: ReportId): Promise<Record<string, string | undefined>> => {
      const definition = REPORT_DEFINITIONS[id];
      const base: Record<string, string | undefined> = {};
      if (definition.project !== "none") base["projectId"] = ruiru;
      if (definition.period === "range") Object.assign(base, last(definition.maxPeriodDays));
      if (definition.site || definition.batch) {
        const options = ok(await owner.call("get", `reports/${id}/options?projectId=${ruiru}`)) as {
          sites: { id: string }[];
          batches: { id: string }[];
        };
        if (definition.site) base["siteId"] = options.sites[0]!.id;
        if (definition.batch) base["batchId"] = options.batches[0]!.id;
      }
      return base;
    };
    let exported = 0;
    for (const id of REPORT_IDS) {
      const definition = REPORT_DEFINITIONS[id];
      if (!definition.available) {
        // Shown as "not available yet", never as an empty report.
        refused(await owner.call("get", `reports/${id}`), 409, "report-not-available");
        refused(await owner.call("get", `reports/${id}/export/xlsx`), 409, "report-not-available");
        continue;
      }
      const values = await params(id);
      const model = await report(owner, id, values);
      expect(
        model.sections.reduce((total, section) => total + section.rowCount, 0),
        `${id} has rows on the demo data`,
      ).toBeGreaterThan(0);
      // Both formats, alternating the language (exports are rate limited per person).
      const languages = exported % 2 ? (["sw", "en"] as const) : (["en", "sw"] as const);
      {
        const [pdfLocale, locale] = languages;
        const pdf = await owner.download(
          `reports/${id}/export/pdf?${query({ ...values, locale: pdfLocale })}`,
        );
        expect(pdf.status, `${id} pdf ${pdfLocale}`).toBe(200);
        expect(pdf.headers["content-type"]).toContain("application/pdf");
        expect(pdf.headers["content-disposition"]).toContain(id);
        expect((pdf.body as Buffer).subarray(0, 5).toString("latin1")).toBe("%PDF-");
        const xlsx = await owner.download(
          `reports/${id}/export/xlsx?${query({ ...values, locale })}`,
        );
        expect(xlsx.status, `${id} xlsx ${locale}`).toBe(200);
        const content = xlsx.body as Buffer;
        expect(content.subarray(0, 2).toString("latin1")).toBe("PK");
        const book = XLSX.read(content, { type: "buffer" });
        expect(book.SheetNames).toHaveLength(model.sections.length);
        const first = sheetRows(content);
        // Known values: the title in the file's language and the first column's label.
        expect(first[0]?.[0]).toBe(messages(locale).reportExport.catalogue[id].title);
        if (locale === "en")
          expect(first.some((row) => row[0] === model.sections[0]!.columns[0]!.label)).toBe(true);
      }
      exported += 1;
    }
    expect(exported).toBe(REPORT_IDS.filter((id) => REPORT_DEFINITIONS[id].available).length);
    // A known figure in Excel: the cost ledger's accrued total, in shillings.
    const ledgerParams = { projectId: ruiru, ...last(366) };
    const ledger = await report(owner, "cost-ledger", ledgerParams);
    const accrued = totalsOf(ledger, "entries")["accrued"] as number;
    const file = await owner.download(`reports/cost-ledger/export/xlsx?${query(ledgerParams)}`);
    expect(sheetRows(file.body as Buffer).flat()).toContain(accrued / 100);
  }, 240_000);

  it("audits views and exports with the report, format and parameter IDs only", async () => {
    const events = await asOwnerA((tx) =>
      tx.auditEvent.findMany({
        where: { tenantId: tenantA(), action: { in: ["report.viewed", "report.exported"] } },
        select: { action: true, metadata: true },
      }),
    );
    expect(events.length).toBeGreaterThan(10);
    const allowed = [
      "report",
      "format",
      "projectId",
      "siteId",
      "storeId",
      "batchId",
      "actorId",
      "rows",
    ];
    for (const event of events) {
      const metadata = event.metadata as Record<string, unknown>;
      expect(Object.keys(metadata).every((key) => allowed.includes(key))).toBe(true);
      for (const [key, value] of Object.entries(metadata))
        if (key.endsWith("Id")) expect(value).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(events.some((event) => (event.metadata as { format?: string }).format === "pdf")).toBe(
      true,
    );
  });

  it("shows each role only its dashboard sections, omitted rather than zero", async () => {
    const dashboard = async (browser: Browser) =>
      dashboardResponseSchema.parse(ok(await browser.call("get", "dashboard")));
    const keys = (value: object) =>
      Object.keys(value)
        .filter((key) => !["today", "generatedAt"].includes(key))
        .sort();
    const owner = await dashboard(people["owner"]!);
    expect(keys(owner)).toEqual(
      [
        "attendance",
        "forecast",
        "invoices",
        "plant",
        "projects",
        "quality",
        "safety",
        "spendAlerts",
        "spending",
        "stock",
      ].sort(),
    );
    expect(owner.projects!.some((row) => row.certified)).toBe(true);
    const agent = await dashboard(people["site_agent"]!);
    expect(agent.spending).toBeUndefined();
    expect(agent.forecast).toBeUndefined();
    expect(agent.spendAlerts).toBeUndefined();
    expect(agent.projects!.every((row) => row.certified === undefined)).toBe(true);
    expect(agent.attendance).toBeDefined();
    const pm = await dashboard(people["project_manager"]!);
    expect(pm.forecast).toBeUndefined();
    expect(pm.spending).toBeDefined();
    const keeper = await dashboard(people["storekeeper"]!);
    expect(keeper.stock).toBeDefined();
    expect(keeper.spending).toBeUndefined();
    expect(keeper.attendance).toBeUndefined();
    expect(keys(await dashboard(supplier))).toEqual([]);
    // Figures: the spending totals add up the rows; today's headcount matches the records.
    const summary = owner.spending!;
    expect(summary.totals.actualMinor).toBe(
      summary.projects.reduce((sum, row) => sum + row.actualMinor, 0),
    );
    const present = await asOwnerA((tx) =>
      tx.attendanceRecord.count({
        where: {
          tenantId: tenantA(),
          workDate: new Date(`${today}T00:00:00Z`),
          status: "present",
          site: { project: { status: { notIn: ["closed", "cancelled"] } } },
        },
      }),
    );
    expect(owner.attendance!.present).toBe(present);
    // A project without a budget has no used percentage (unavailable, not 0).
    for (const row of summary.projects)
      if (row.budgetMinor === null) expect(row.usedPercent).toBeNull();
    // Reloading within a minute, with the same access, reuses the dashboard; another person's is
    // their own.
    expect((await dashboard(people["owner"]!)).generatedAt).toBe(owner.generatedAt);
    expect(keys(await dashboard(people["storekeeper"]!))).toEqual(keys(keeper));
  });

  it("subscribes, pauses, resumes and deletes; only the subscriber changes it", async () => {
    const pm = people["project_manager"]!;
    const ruiru = projects["RUI-HTS"]!;
    const body = {
      reportId: "budget-vs-actual",
      parameters: { projectId: ruiru },
      frequency: "monthly",
      dayOfMonth: 31,
      locale: "sw",
    };
    const created = reportSubscriptionResponseSchema.parse(
      ok(await pm.call("post", "reports/subscriptions", body), 201),
    ).subscription;
    expect(created.status).toBe("active");
    expect(new Date(created.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    refused(await pm.call("post", "reports/subscriptions", body), 409, "subscription-exists");
    // Only reports the subscriber may run now.
    refused(
      await people["site_agent"]!.call("post", "reports/subscriptions", {
        ...body,
        reportId: "cost-ledger",
      }),
      403,
    );
    refused(
      await pm.call("post", "reports/subscriptions", {
        ...body,
        reportId: "mpesa-reconciliation",
        parameters: {},
      }),
      409,
      "report-not-available",
    );
    // Someone else cannot pause it; the subscriber pauses, resumes and deletes it.
    refused(
      await people["finance"]!.call("patch", `reports/subscriptions/${created.id}`, {
        version: created.version,
        status: "paused",
      }),
      404,
    );
    const paused = reportSubscriptionResponseSchema.parse(
      ok(
        await pm.call("patch", `reports/subscriptions/${created.id}`, {
          version: created.version,
          status: "paused",
        }),
      ),
    ).subscription;
    expect(paused.status).toBe("paused");
    refused(
      await pm.call("patch", `reports/subscriptions/${created.id}`, {
        version: created.version,
        status: "active",
      }),
      409,
      "version-conflict",
    );
    const resumed = reportSubscriptionResponseSchema.parse(
      ok(
        await pm.call("patch", `reports/subscriptions/${created.id}`, {
          version: paused.version,
          status: "active",
        }),
      ),
    ).subscription;
    expect(resumed.status).toBe("active");
    // Their own list; the owner (config.manage) sees the company's.
    const mine = reportSubscriptionsResponseSchema.parse(
      ok(await pm.call("get", "reports/subscriptions")),
    );
    expect(mine.subscriptions.map((entry) => entry.id)).toEqual([created.id]);
    refused(await pm.call("get", "reports/subscriptions?scope=company"), 403);
    const company = reportSubscriptionsResponseSchema.parse(
      ok(await people["owner"]!.call("get", "reports/subscriptions?scope=company")),
    );
    expect(company.subscriptions.map((entry) => entry.id)).toContain(created.id);
    // The seed's subscriptions (owner weekly cost ledger, finance monthly ageing).
    expect(company.subscriptions.map((entry) => entry.report.id)).toEqual(
      expect.arrayContaining(["cost-ledger", "invoice-ageing"]),
    );
    const deleted = reportSubscriptionResponseSchema.parse(
      ok(
        await pm.call("post", `reports/subscriptions/${created.id}/delete`, {
          version: resumed.version,
        }),
      ),
    ).subscription;
    expect(deleted.status).toBe("deleted");
    expect(deleted.nextRunAt).toBeNull();
    refused(
      await pm.call("patch", `reports/subscriptions/${created.id}`, {
        version: deleted.version,
        status: "active",
      }),
      404,
    );
    // Only the subscriber changes a subscription, in the database too.
    await expect(
      db.run(
        { userId: people["owner"]!.auth.user.id, tenantId: tenantA(), requestId: "d81-sql" },
        (tx) =>
          tx.reportSubscription.updateMany({
            where: { tenantId: tenantA(), userId: people["finance"]!.auth.user.id },
            data: { status: "paused", version: { increment: 1 } },
          }),
      ),
    ).rejects.toThrow();
  });

  it("runs due subscriptions once, emailing a sign-in link without report data", async () => {
    const finance = people["finance"]!;
    const ruiru = projects["RUI-HTS"]!;
    const subscription = reportSubscriptionResponseSchema.parse(
      ok(
        await finance.call("post", "reports/subscriptions", {
          reportId: "cost-ledger",
          parameters: { projectId: ruiru },
          frequency: "weekly",
          weekday: 1,
          locale: "en",
        }),
        201,
      ),
    ).subscription;
    await makeDue(subscription.id, finance.auth.user.id);
    notifications.delete(finance.identifier);
    // The seed's subscriptions are not due; only this one runs.
    expect(await scheduler.runDue({ tenantId: tenantA() })).toEqual({
      claimed: 1,
      sent: 1,
      skipped: 0,
      failed: 0,
    });
    const email = notifications.get(finance.identifier)!.at(-1)!;
    expect(email.subject).toContain("Cost ledger");
    expect(email.text).toContain(`/reports/cost-ledger?projectId=${ruiru}&from=`);
    // No figures, names or other report data in the email.
    expect(email.text).not.toMatch(/KES|\d{1,3},\d{3}/);
    const ledger = await report(finance, "cost-ledger", { projectId: ruiru, ...last(366) });
    for (const row of ledger.sections[0]!.rows.slice(0, 50))
      for (const cell of row)
        if (typeof cell === "string" && cell.length > 6 && !/^\d{4}-/.test(cell))
          expect(email.text).not.toContain(cell);
    // Nothing is due any more: a second cycle claims nothing.
    expect(await scheduler.runDue({ tenantId: tenantA() })).toEqual({
      claimed: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
    });
    const listed = reportSubscriptionsResponseSchema.parse(
      ok(await finance.call("get", "reports/subscriptions")),
    );
    const view = listed.subscriptions.find((entry) => entry.id === subscription.id)!;
    expect(view.lastRun).toMatchObject({ outcome: "sent", reason: null });
    expect(new Date(view.nextRunAt!).getTime()).toBeGreaterThan(Date.now());

    // Two workers at once: exactly one claims it (FOR UPDATE SKIP LOCKED).
    await makeDue(subscription.id, finance.auth.user.id);
    const [a, b] = await Promise.all([
      scheduler.runOne(tenantA(), subscription.id),
      scheduler.runOne(tenantA(), subscription.id),
    ]);
    expect([a, b].filter((outcome) => outcome !== null)).toEqual(["sent"]);
    // Two cycles at once: one holds the advisory lock, the subscription runs once.
    await makeDue(subscription.id, finance.auth.user.id);
    const cycles = await Promise.all([
      scheduler.runDue({ tenantId: tenantA() }),
      scheduler.runDue({ tenantId: tenantA() }),
    ]);
    expect(cycles.reduce((sum, cycle) => sum + (cycle?.claimed ?? 0), 0)).toBe(1);
    const runs = await asOwnerA((tx) =>
      tx.reportSubscriptionRun.findMany({
        where: { tenantId: tenantA(), subscriptionId: subscription.id },
      }),
    );
    expect(runs).toHaveLength(3);
    expect(new Set(runs.map((run) => run.dueAt.toISOString())).size).toBe(3);

    // The claim is committed before the email is sent: while sending, the subscription is
    // already moved on (seen from another connection), so a slow or failed send never repeats.
    await makeDue(subscription.id, finance.auth.user.id);
    let nextWhileSending: Date | null = null;
    notificationSpy.mockImplementationOnce(async () => {
      nextWhileSending = (
        await asOwnerA((tx) =>
          tx.reportSubscription.findUniqueOrThrow({
            where: { tenantId_id: { tenantId: tenantA(), id: subscription.id } },
          }),
        )
      ).nextRunAt;
      throw new Error("smtp down");
    });
    // A failed delivery is recorded as failed, and the subscription moves on.
    expect(await scheduler.runDue({ tenantId: tenantA() })).toMatchObject({
      claimed: 1,
      failed: 1,
    });
    expect(nextWhileSending!.getTime()).toBeGreaterThan(Date.now());
    expect(await scheduler.runDue({ tenantId: tenantA() })).toMatchObject({ claimed: 0 });
    const failedRuns = await asOwnerA((tx) =>
      tx.reportSubscriptionRun.findMany({
        where: { tenantId: tenantA(), subscriptionId: subscription.id, outcome: "failed" },
      }),
    );
    expect(failedRuns.map((run) => run.reason)).toEqual(["delivery-failed"]);

    // One subscription's error never stops the others in the same cycle.
    const lpos = reportSubscriptionResponseSchema.parse(
      ok(
        await finance.call("post", "reports/subscriptions", {
          reportId: "lpo-register",
          parameters: { projectId: ruiru },
          frequency: "monthly",
          dayOfMonth: 1,
          locale: "en",
        }),
        201,
      ),
    ).subscription;
    await makeDue(subscription.id, finance.auth.user.id);
    await makeDue(lpos.id, finance.auth.user.id);
    const resolve = vi
      .spyOn(app.get(ReportsService), "resolve")
      .mockRejectedValueOnce(new Error("unexpected"));
    try {
      expect(await scheduler.runDue({ tenantId: tenantA() })).toEqual({
        claimed: 1,
        sent: 1,
        skipped: 0,
        failed: 1,
      });
    } finally {
      resolve.mockRestore();
    }
    // The one that failed is still due and runs in the next cycle.
    expect(await scheduler.runDue({ tenantId: tenantA() })).toMatchObject({ claimed: 1, sent: 1 });

    // Administrators can run the company's due subscriptions now; others cannot.
    refused(await finance.call("post", "reports/subscriptions/run-due", {}), 403);
    runDueResponseSchema.parse(
      ok(await people["owner"]!.call("post", "reports/subscriptions/run-due", {})),
    );
  });

  it("skips a run when the subscriber lost the permission or left, and keeps runs append-only", async () => {
    const agent = people["site_agent"]!;
    const pm = people["project_manager"]!;
    const ruiru = projects["RUI-HTS"]!;
    const site = await asOwnerA((tx) =>
      tx.site.findFirstOrThrow({ where: { tenantId: tenantA(), projectId: ruiru } }),
    );
    const muster = reportSubscriptionResponseSchema.parse(
      ok(
        await agent.call("post", "reports/subscriptions", {
          reportId: "muster-roll",
          parameters: { projectId: ruiru, siteId: site.id },
          frequency: "monthly",
          dayOfMonth: 1,
          locale: "sw",
        }),
        201,
      ),
    ).subscription;
    const budget = reportSubscriptionResponseSchema.parse(
      ok(
        await pm.call("post", "reports/subscriptions", {
          reportId: "budget-vs-actual",
          parameters: { projectId: ruiru },
          frequency: "weekly",
          weekday: 3,
          locale: "en",
        }),
        201,
      ),
    ).subscription;
    // The site agent becomes a foreman (no reports.view); the project manager leaves.
    await fresh(people["owner"]!);
    ok(
      await people["owner"]!.call("put", `tenants/current/members/${agent.auth.user.id}/role`, {
        role: "foreman",
      }),
    );
    ok(await people["owner"]!.call("delete", `tenants/current/members/${pm.auth.user.id}`));
    await makeDue(muster.id, agent.auth.user.id);
    await makeDue(budget.id, pm.auth.user.id);
    notifications.delete(agent.identifier);
    expect(await scheduler.runDue({ tenantId: tenantA() })).toEqual({
      claimed: 2,
      sent: 0,
      skipped: 2,
      failed: 0,
    });
    expect(notifications.get(agent.identifier)).toBeUndefined();
    const runs = await asOwnerA((tx) =>
      tx.reportSubscriptionRun.findMany({
        where: { tenantId: tenantA(), subscriptionId: { in: [muster.id, budget.id] } },
      }),
    );
    expect(
      Object.fromEntries(runs.map((run) => [run.subscriptionId, [run.outcome, run.reason]])),
    ).toEqual({
      [muster.id]: ["skipped", "permission-lost"],
      [budget.id]: ["skipped", "membership-ended"],
    });
    expect(runs.find((run) => run.subscriptionId === muster.id)!.periodFrom).not.toBeNull();
    // Runs are append-only for the runtime role, whoever asks.
    await expect(
      db.run({ userId: agent.auth.user.id, tenantId: tenantA(), requestId: "d81-sql" }, (tx) =>
        tx.reportSubscriptionRun.updateMany({
          where: { tenantId: tenantA(), id: runs[0]!.id },
          data: { outcome: "sent", reason: null },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run({ userId: agent.auth.user.id, tenantId: tenantA(), requestId: "d81-sql" }, (tx) =>
        tx.reportSubscriptionRun.deleteMany({ where: { tenantId: tenantA(), id: runs[0]!.id } }),
      ),
    ).rejects.toThrow();
    // Run audit events carry the report, outcome and reason only.
    const audits = await asOwnerA((tx) =>
      tx.auditEvent.findMany({
        where: { tenantId: tenantA(), action: "report.subscription_run" },
        select: { metadata: true },
      }),
    );
    expect(audits.length).toBeGreaterThan(0);
    for (const event of audits)
      expect(Object.keys(event.metadata as object).sort()).toEqual(["outcome", "reason", "report"]);
  });
});
