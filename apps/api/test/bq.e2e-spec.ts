import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import {
  auditEventsResponseSchema,
  bqBillResponseSchema,
  bqImportResponseSchema,
  bqImportsResponseSchema,
  bqPreviewResponseSchema,
  bqResponseSchema,
  bqSearchResponseSchema,
  bqSheetRowsResponseSchema,
  bqTemplateResponseSchema,
  bqTemplatesResponseSchema,
  projectResponseSchema,
  type BqImport,
  type Project,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { StorageService } from "../src/infra/storage.service.js";
import { BqImportsService } from "../src/modules/bq/bq-imports.service.js";
import { BqVersionWriter } from "../src/modules/bq/bq-version-writer.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { Browser, notifications } from "./support.js";

/** Synthetic fixtures from test/fixtures/bq/generate.mts; totals computed there independently. */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/bq/${name}`, import.meta.url));
const MULTI = {
  bills: { "1": 343_000_000, "2": 859_500_213, "3": 1_612_503_990, "4": 516_650_000 },
  subtotal: 3_331_654_203,
  vat: 533_064_672,
  grand: 3_864_718_875,
  items: 39,
  sections: 10,
};
const SINGLE = { subtotal: 287_938_388, vat: 46_070_142, grand: 334_008_530, items: 10 };

/** A minimal zip that looks like an xlsx package but holds no readable workbook. */
function junkWorkbook(): Buffer {
  const entries = [
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    { name: "xl/workbook.xml", data: Buffer.from("not really a workbook") },
  ];
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const body = deflateRawSync(entry.data);
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    // Correct checksums: this must be a well-formed archive whose workbook is unreadable.
    local.writeUInt32LE(crc32(entry.data) >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(8, 10);
    head.writeUInt32LE(crc32(entry.data) >>> 0, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(entry.data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe("BQ import, viewer and exports (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let ownerB: Browser;
  let qs: Browser;
  let agent: Browser;
  let pm: Browser;
  let tenantA: string;
  let tenantB: string;
  let main: Project;
  let alt: Project;
  let legacy: Project;
  let messy: Project;
  let other: Project;
  let lifecycle: Project;
  let bProject: Project;
  let firstImport: BqImport;
  let templateId: string;
  let notificationSpy: ReturnType<typeof vi.spyOn>;

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
  const createProject = async (browser: Browser, name: string, extra: object = {}) => {
    await fresh(browser);
    const res = await browser.call("post", "projects", { name, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return projectResponseSchema.parse(res.body).project;
  };
  const problem = (res: request.Response) => (res.body as { code?: string }).code;
  const imported = (res: request.Response) => bqImportResponseSchema.parse(res.body).import;
  const base = (project: Project) => `projects/${project.id}/bq`;
  const upload = async (browser: Browser, project: Project, file: string, name = file) =>
    browser.upload(`${base(project)}/imports`, fixture(file), name);
  const saveMapping = async (browser: Browser, project: Project, current: BqImport) => {
    const res = await browser.call("put", `${base(project)}/imports/${current.id}/mapping`, {
      mapping: current.mapping,
      version: current.version,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return imported(res);
  };
  const validate = async (browser: Browser, project: Project, current: BqImport) => {
    const res = await browser.call("post", `${base(project)}/imports/${current.id}/validate`, {
      version: current.version,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return imported(res);
  };
  const commit = (browser: Browser, project: Project, current: BqImport) =>
    browser.call("post", `${base(project)}/imports/${current.id}/commit`, {
      version: current.version,
    });
  const toValidated = async (browser: Browser, project: Project, file: string) => {
    const res = await upload(browser, project, file);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const parsed = imported(res);
    expect(parsed.status).toBe("parsed");
    return validate(browser, project, await saveMapping(browser, project, parsed));
  };
  const resolve = (browser: Browser, project: Project, current: BqImport, resolutions: object) =>
    browser.call("put", `${base(project)}/imports/${current.id}/resolutions`, {
      resolutions,
      version: current.version,
    });
  const getBq = async (browser: Browser, project: Project) => {
    const res = await browser.call("get", base(project));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return bqResponseSchema.parse(res.body);
  };
  const auditEvents = async () => {
    await fresh(owner);
    const res = await owner.call("get", "tenants/current/audit");
    expect(res.status).toBe(200);
    return auditEventsResponseSchema.parse(res.body).events;
  };

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
    qs = new Browser(app);
    agent = new Browser(app);
    pm = new Browser(app);
    for (const browser of [owner, ownerB]) {
      await browser.register();
      await browser.enroll();
    }
    for (const browser of [qs, agent, pm]) await browser.register();
    const a = await owner.call("post", "tenants", { name: "BQ company A" });
    const b = await ownerB.call("post", "tenants", { name: "BQ company B" });
    expect([a.status, b.status]).toEqual([201, 201]);
    tenantA = (a.body as { tenant: { id: string } }).tenant.id;
    tenantB = (b.body as { tenant: { id: string } }).tenant.id;
    main = await createProject(owner, "Ruiru Heights (synthetic)", {
      contractSumMinor: MULTI.grand,
    });
    alt = await createProject(owner, "Syokimau Townhouses (synthetic)");
    legacy = await createProject(owner, "Legacy XLS (synthetic)");
    messy = await createProject(owner, "Kitengela Bungalow (synthetic)");
    other = await createProject(owner, "Other project");
    lifecycle = await createProject(owner, "Import lifecycle");
    bProject = await createProject(ownerB, "Company B project");
    await join(qs, "quantity_surveyor", [main.id, alt.id, legacy.id, messy.id, lifecycle.id]);
    await join(agent, "site_agent", [main.id]);
    await join(pm, "project_manager", [other.id]);
  }, 120_000);

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("documents every BQ operation in OpenAPI", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "getBq",
      "getBqBill",
      "searchBq",
      "exportBqExcel",
      "exportBqPdf",
      "listBqImports",
      "uploadBq",
      "getBqImport",
      "parseBqImport",
      "getBqImportRows",
      "saveBqMapping",
      "applyBqTemplate",
      "validateBqImport",
      "resolveBqImport",
      "previewBqImport",
      "commitBqImport",
      "abandonBqImport",
      "downloadBqSource",
      "listBqTemplates",
      "createBqTemplate",
      "deleteBqTemplate",
    ])
      expect(operations, id).toContain(id);
  });

  it("imports the multi-bill workbook end to end with totals to the cent", async () => {
    const content = fixture("kenyan-multi-bill.xlsx");
    const res = await upload(qs, main, "kenyan-multi-bill.xlsx");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain("bq-imports/");
    const parsed = imported(res);
    expect(parsed).toMatchObject({
      status: "parsed",
      fileName: "kenyan-multi-bill.xlsx",
      fileType: "xlsx",
      fileSizeBytes: content.length,
      fileSha256: createHash("sha256").update(content).digest("hex"),
      scanStatus: "not_scanned",
      scanEngine: "development-noop",
    });
    expect(parsed.sheets!.map((sheet) => [sheet.name, sheet.kind])).toEqual([
      ["BILL 1 - PRELIMS", "bill"],
      ["BILL 2 - SUBSTRUCTURE", "bill"],
      ["BILL 3 - SUPERSTRUCTURE", "bill"],
      ["BILL 4 - PC & PROV SUMS", "bill"],
      ["GRAND SUMMARY", "summary"],
    ]);
    expect(parsed.sheets![1]).toMatchObject({
      headerRow: 6,
      headerConfidence: 1,
      billNumber: "2",
      billTitle: "SUBSTRUCTURE",
      proposedColumns: { ref: 0, description: 1, unit: 2, quantity: 3, rate: 4, amount: 5 },
    });
    expect(parsed.mapping!.sheets.map((sheet) => sheet.billNumber)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "",
    ]);

    // The original is stored privately under a generated, tenant/project-scoped key.
    const row = await db.run(
      { userId: qs.auth.user.id, tenantId: tenantA, requestId: "bq-key" },
      (tx) =>
        tx.bqImport.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: tenantA, id: parsed.id } },
        }),
    );
    expect(row.sourceKey).toBe(
      `tenants/${tenantA}/projects/${main.id}/bq-imports/${parsed.id}/source.xlsx`,
    );
    expect((await app.get(StorageService).get(row.sourceKey, 20_000_000)).equals(content)).toBe(
      true,
    );

    const rows = await qs.call(
      "get",
      `${base(main)}/imports/${parsed.id}/sheets/1/rows?from=5&count=4`,
    );
    expect(rows.status).toBe(200);
    const window = bqSheetRowsResponseSchema.parse(rows.body);
    expect(window.rows[1]).toMatchObject({
      row: 6,
      cells: ["ITEM", "DESCRIPTION", "UNIT", "QTY", "RATE", "AMOUNT"],
    });

    const mapped = await saveMapping(qs, main, parsed);
    expect(mapped.status).toBe("mapped");
    const validated = await validate(qs, main, mapped);
    expect(validated.status).toBe("validated");
    const report = validated.report!;
    expect(report.readiness).toEqual({ blocking: 0, unacceptedWarnings: [], canCommit: true });
    expect(report.counts).toEqual({ "lump-sum": 11, "percentage-line": 4 });
    expect(report.totals).toMatchObject({
      billCount: 4,
      sectionCount: MULTI.sections,
      itemCount: MULTI.items,
      subtotalMinor: MULTI.subtotal,
      vatRatePercent: "16",
      vatMinor: MULTI.vat,
      grandTotalMinor: MULTI.grand,
      sheet: { subtotalMinor: MULTI.subtotal, vatMinor: MULTI.vat, grandTotalMinor: MULTI.grand },
      contractSumMinor: MULTI.grand,
    });
    expect(report.vatRuleStatus).toBe("compliance_review");

    const preview = bqPreviewResponseSchema.parse(
      (await qs.call("get", `${base(main)}/imports/${validated.id}/preview`)).body,
    );
    expect(preview.existingDraft).toBeNull();
    expect(Object.fromEntries(preview.bills.map((bill) => [bill.number, bill.totalMinor]))).toEqual(
      MULTI.bills,
    );
    // Preview changes nothing.
    expect((await getBq(qs, main)).bq).toBeNull();

    const committed = await commit(qs, main, validated);
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    firstImport = imported(committed);
    expect(firstImport.status).toBe("committed");
    expect(firstImport.bqVersionId).toEqual(expect.any(String));

    const view = await getBq(qs, main);
    expect(view.permissions).toEqual({
      canImport: true,
      canExport: true,
      canEdit: true,
      canApprove: false,
    });
    // The quantity surveyor cannot approve the baseline (D2.3: bq.approve_variation).
    expect(view.baselineApproval).toEqual({ allowed: false, refusal: "permission" });
    expect(view.bq!.version).toMatchObject({
      versionNo: 1,
      status: "draft",
      source: "import",
      vatRatePercent: "16",
      vatRuleKey: "bq.vat.rate",
      vatRuleStatus: "compliance_review",
      rounding: "half_up_line",
      subtotalMinor: MULTI.subtotal,
      vatMinor: MULTI.vat,
      grandTotalMinor: MULTI.grand,
      billCount: 4,
      itemCount: MULTI.items,
    });
    expect(
      Object.fromEntries(view.bq!.bills.map((bill) => [bill.number, bill.totalMinor])),
    ).toEqual(MULTI.bills);
    expect(view.bq!.bills.map((bill) => bill.kind)).toEqual([
      "preliminaries",
      "measured",
      "measured",
      "provisional",
    ]);
    expect(view.bq!.byKind).toEqual({
      measured: 2_472_004_203,
      preliminaries: 343_000_000,
      provisionalSums: 53_000_000,
      pcSums: 222_000_000,
      pcAttendanceProfit: 16_650_000,
      contingencies: 200_000_000,
      dayworks: 25_000_000,
    });
    expect(view.bq!.source).toMatchObject({
      fileName: "kenyan-multi-bill.xlsx",
      overrides: [],
      accepted: [],
    });

    const billTwo = view.bq!.bills.find((bill) => bill.number === "2")!;
    expect(billTwo.sections.map((section) => section.title)).toEqual([
      "EXCAVATION AND EARTHWORKS",
      "CONCRETE WORK",
      "REINFORCEMENT",
    ]);
    const detail = bqBillResponseSchema.parse(
      (await qs.call("get", `${base(main)}/bills/${billTwo.id}`)).body,
    );
    expect(detail.items).toHaveLength(15);
    expect(
      detail.items.find((item) => item.description === "Galvanised binding wire"),
    ).toMatchObject({
      ref: "G",
      unit: "kg",
      quantity: "1.5",
      rate: "4.75",
      amountMinor: 713,
      sheetAmountMinor: 713,
      amountSource: "computed",
    });
    expect(detail.items.find((item) => item.unitRaw === "Cu.m")).toMatchObject({
      unit: "m3",
      quantity: "145.5",
    });
    expect(
      detail.items.find((item) => item.description.includes("ground beams"))?.amountMinor,
    ).toBe(97_440_000);
    const billFour = view.bq!.bills.find((bill) => bill.number === "4")!;
    const pc = bqBillResponseSchema.parse(
      (await qs.call("get", `${base(main)}/bills/${billFour.id}`)).body,
    );
    expect(
      pc.items.map((item) => [item.ref, item.kind, item.amountSource, item.amountMinor]),
    ).toEqual([
      ["A", "pc_sum", "lump_sum", 128_000_000],
      ["B", "pc_profit", "percentage", 6_400_000],
      ["C", "pc_attendance", "percentage", 3_200_000],
      ["D", "pc_sum", "lump_sum", 94_000_000],
      ["E", "pc_profit", "percentage", 4_700_000],
      ["F", "pc_attendance", "percentage", 2_350_000],
      ["G", "provisional_sum", "lump_sum", 35_000_000],
      ["H", "provisional_sum", "lump_sum", 18_000_000],
      ["J", "daywork", "lump_sum", 25_000_000],
      ["K", "contingency", "lump_sum", 200_000_000],
    ]);

    const search = bqSearchResponseSchema.parse(
      (await qs.call("get", `${base(main)}/search?q=binding`)).body,
    );
    expect(search.items.map((item) => [item.billNumber, item.ref])).toEqual([["2", "G"]]);
    expect(
      bqSearchResponseSchema.parse((await qs.call("get", `${base(main)}/search?q=zzzz`)).body)
        .items,
    ).toEqual([]);

    // Audit metadata: counts and field names, never amounts, descriptions or file names.
    const events = (await auditEvents()).filter((event) => event.action.startsWith("bq."));
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "bq.import.uploaded",
        "bq.import.parsed",
        "bq.import.mapped",
        "bq.import.validated",
        "bq.import.committed",
      ]),
    );
    const metadata = JSON.stringify(events.map((event) => event.metadata));
    for (const secret of [String(MULTI.grand), "Galvanised", "kenyan-multi-bill", "974400"])
      expect(metadata).not.toContain(secret);
  });

  it("imports the single-sheet layout with other column names and exports Excel and PDF safely", async () => {
    const res = await upload(qs, alt, "single-sheet-alt-columns.xlsx");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const parsed = imported(res);
    expect(parsed.sheets![0]).toMatchObject({
      kind: "bill",
      headerRow: 3,
      proposedColumns: {
        description: 0,
        quantity: 1,
        unit: 2,
        rate: 3,
        amount: 4,
        ref: 5,
        notes: 6,
      },
    });
    const mapping = structuredClone(parsed.mapping!);
    mapping.sheets[0]!.billTitle = "Main works";
    const mappedRes = await qs.call("put", `${base(alt)}/imports/${parsed.id}/mapping`, {
      mapping,
      version: parsed.version,
    });
    expect(mappedRes.status, JSON.stringify(mappedRes.body)).toBe(200);
    const validated = await validate(qs, alt, imported(mappedRes));
    expect(validated.report!.counts).toEqual({ "contract-sum-unset": 1 });
    expect(validated.report!.totals).toMatchObject({
      subtotalMinor: SINGLE.subtotal,
      vatMinor: SINGLE.vat,
      grandTotalMinor: SINGLE.grand,
      itemCount: SINGLE.items,
      sheet: { vatMinor: SINGLE.vat, grandTotalMinor: SINGLE.grand },
    });
    expect((await commit(qs, alt, validated)).status).toBe(200);
    const view = await getBq(qs, alt);
    expect(view.bq!.bills.map((bill) => [bill.number, bill.title, bill.totalMinor])).toEqual([
      ["1", "Main works", SINGLE.subtotal],
    ]);
    expect(view.bq!.bills[0]!.sections.map((section) => section.title)).toEqual([
      "SITE CLEARANCE",
      "Foundations",
      "WALLING AND FINISHES",
    ]);
    const items = bqBillResponseSchema.parse(
      (await qs.call("get", `${base(alt)}/bills/${view.bq!.bills[0]!.id}`)).body,
    ).items;
    expect(items.find((item) => item.ref === "2.1")).toMatchObject({
      unit: "m3",
      unitRaw: "m³",
      quantity: "42.75",
      rate: "15850.5",
      amountMinor: 67_760_888,
    });
    expect(items.find((item) => item.ref === "2.3")).toMatchObject({
      description: "=2+3 risk allowance (synthetic formula-injection probe)",
      notes: "+check with the QS",
    });

    const excel = await qs.download(`${base(alt)}/export/xlsx`);
    expect(excel.status).toBe(200);
    expect(excel.headers["content-type"]).toContain("spreadsheetml");
    expect(excel.headers["content-disposition"]).toMatch(
      /^attachment; filename="PRJ-\d+-BQ-v1-draft\.xlsx"/,
    );
    const book = XLSX.read(excel.body as Buffer, { type: "buffer", cellFormula: true });
    expect(book.SheetNames).toEqual(["Summary", "Bill 1"]);
    const summary = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets["Summary"]!, { header: 1 });
    const total = summary.find((row) => row[0] === "Grand total");
    expect(total?.[2]).toBe(SINGLE.grand / 100);
    const sheet = book.Sheets["Bill 1"]!;
    const cells = Object.entries(sheet).filter(([address]) => !address.startsWith("!"));
    expect(cells.every(([, cell]) => !(cell as XLSX.CellObject).f)).toBe(true);
    const probe = cells.find(([, cell]) =>
      String((cell as XLSX.CellObject).v).includes("risk allowance"),
    );
    expect(probe?.[1]).toMatchObject({
      t: "s",
      v: "'=2+3 risk allowance (synthetic formula-injection probe)",
    });
    expect(cells.some(([, cell]) => (cell as XLSX.CellObject).v === "'+check with the QS")).toBe(
      true,
    );
    for (const [, cell] of cells) {
      const value = (cell as XLSX.CellObject).v;
      if (typeof value === "string") expect(value).not.toMatch(/^[=+\-@\t\r]/);
    }
    const amounts = cells.filter(([, cell]) => (cell as XLSX.CellObject).t === "n");
    expect(amounts.some(([, cell]) => (cell as XLSX.CellObject).v === 677_608.88)).toBe(true);

    const pdf = await qs.download(`${base(alt)}/export/pdf?locale=sw`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect((pdf.body as Buffer).length).toBeGreaterThan(2_000);
    expect(pdf.headers["content-disposition"]).toMatch(/filename="PRJ-\d+-BQ-v1-draft\.pdf"/);
  });

  it("imports the legacy .xls copy with the same totals", async () => {
    const validated = await toValidated(qs, legacy, "kenyan-multi-bill.xls");
    expect(validated.fileType).toBe("xls");
    expect(validated.report!.totals.grandTotalMinor).toBe(MULTI.grand);
    expect((await commit(qs, legacy, validated)).status).toBe(200);
    const view = await getBq(qs, legacy);
    expect(view.bq!.version.grandTotalMinor).toBe(MULTI.grand);
    expect(
      Object.fromEntries(view.bq!.bills.map((bill) => [bill.number, bill.totalMinor])),
    ).toEqual(MULTI.bills);
  });

  it("blocks the commit on errors and needs warnings accepted with a reason", async () => {
    const validated = await toValidated(qs, messy, "messy.xlsx");
    const report = validated.report!;
    expect(report.readiness).toEqual({
      blocking: 2,
      unacceptedWarnings: ["formula-cell", "missing-unit", "page-total-mismatch"],
      canCommit: false,
    });
    expect(report.issues.find((issue) => issue.code === "amount-mismatch")).toMatchObject({
      row: 23,
      column: "F",
      ref: "C",
      values: { sheet: "947400.00", computed: "974400.00" },
      actions: ["computed", "sheet", "exclude"],
    });
    expect(report.issues.find((issue) => issue.code === "duplicate-ref")).toMatchObject({
      row: 10,
      ref: "B",
    });
    expect(report.issues.find((issue) => issue.code === "page-total-mismatch")).toMatchObject({
      row: 25,
      values: { sheet: "3316950.00", computed: "4027950.00" },
    });
    expect(report.issues.find((issue) => issue.code === "formula-cell")?.row).toBe(12);
    expect(report.issues.find((issue) => issue.code === "missing-unit")?.row).toBe(11);

    const blocked = await commit(qs, messy, validated);
    expect([blocked.status, problem(blocked)]).toEqual([409, "commit-blocked"]);

    const noReason = await resolve(qs, messy, validated, {
      rows: [{ sheetIndex: 0, row: 23, action: "sheet" }],
      accepted: [],
    });
    expect([noReason.status, problem(noReason)]).toEqual([400, "invalid-resolution"]);
    const notOffered = await resolve(qs, messy, validated, {
      rows: [{ sheetIndex: 0, row: 11, action: "computed" }],
      accepted: [],
    });
    expect([notOffered.status, problem(notOffered)]).toEqual([400, "invalid-resolution"]);
    const infoAccepted = await resolve(qs, messy, validated, {
      rows: [],
      accepted: [{ code: "contract-sum-unset", reason: "Not a warning" }],
    });
    expect([infoAccepted.status, problem(infoAccepted)]).toEqual([400, "invalid-resolution"]);
    const shortReason = await resolve(qs, messy, validated, {
      rows: [],
      accepted: [{ code: "formula-cell", reason: "ok" }],
    });
    expect(shortReason.status).toBe(400);

    const rows = [
      { sheetIndex: 0, row: 10, action: "exclude" },
      {
        sheetIndex: 0,
        row: 23,
        action: "sheet",
        reason: "QS confirmed the typed amount in writing",
      },
    ];
    const partly = await resolve(qs, messy, validated, { rows, accepted: [] });
    expect(partly.status, JSON.stringify(partly.body)).toBe(200);
    const partial = imported(partly);
    expect(partial.report!.readiness).toMatchObject({ blocking: 0, canCommit: false });
    expect((await commit(qs, messy, partial)).status).toBe(409);

    const accepted = [
      { code: "formula-cell", reason: "Amounts are recomputed from quantity × rate" },
      { code: "missing-unit", reason: "The QS will add the unit in a revision" },
      { code: "page-total-mismatch", reason: "Page totals on the sheet are not used" },
    ];
    const done = await resolve(qs, messy, partial, { rows, accepted });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const ready = imported(done);
    expect(ready.report!.readiness).toEqual({
      blocking: 0,
      unacceptedWarnings: [],
      canCommit: true,
    });
    expect((await commit(qs, messy, ready)).status).toBe(200);

    const view = await getBq(qs, messy);
    expect(view.bq!.version).toMatchObject({
      itemCount: 7,
      subtotalMinor: 390_670_000,
      vatMinor: 62_507_200,
      grandTotalMinor: 453_177_200,
    });
    expect(view.bq!.source!.accepted.map((entry) => entry.code)).toEqual([
      "formula-cell",
      "missing-unit",
      "page-total-mismatch",
    ]);
    expect(view.bq!.source!.overrides).toEqual([
      {
        sheet: "BILL 2",
        row: 10,
        ref: "B",
        action: "exclude",
        reason: null,
        codes: ["duplicate-ref"],
      },
      {
        sheet: "BILL 2",
        row: 23,
        ref: "C",
        action: "sheet",
        reason: "QS confirmed the typed amount in writing",
        codes: ["amount-mismatch"],
      },
    ]);
    const items = bqBillResponseSchema.parse(
      (await qs.call("get", `${base(messy)}/bills/${view.bq!.bills[0]!.id}`)).body,
    ).items;
    expect(items.find((item) => item.sourceRow === 23)).toMatchObject({
      amountSource: "sheet_override",
      amountMinor: 94_740_000,
      sheetAmountMinor: 94_740_000,
      overrideReason: "QS confirmed the typed amount in writing",
    });
    expect(items.some((item) => item.sourceRow === 10)).toBe(false);
  });

  it("re-importing while still a draft replaces the draft and keeps the earlier import records", async () => {
    const validated = await toValidated(qs, main, "single-sheet-alt-columns.xlsx");
    expect(validated.report!.readiness.unacceptedWarnings).toEqual(["contract-sum-mismatch"]);
    const accepted = imported(
      await resolve(qs, main, validated, {
        rows: [],
        accepted: [
          { code: "contract-sum-mismatch", reason: "Revised scope; contract to be amended" },
        ],
      }),
    );
    const preview = bqPreviewResponseSchema.parse(
      (await qs.call("get", `${base(main)}/imports/${accepted.id}/preview`)).body,
    );
    expect(preview.existingDraft).toMatchObject({
      versionNo: 1,
      grandTotalMinor: MULTI.grand,
      itemCount: MULTI.items,
      sourceFileName: "kenyan-multi-bill.xlsx",
    });
    expect(preview.differences.map((entry) => [entry.billNumber, entry.change])).toEqual([
      ["1", "changed"],
      ["2", "removed"],
      ["3", "removed"],
      ["4", "removed"],
    ]);
    expect((await commit(qs, main, accepted)).status).toBe(200);

    const view = await getBq(qs, main);
    expect(view.bq!.version).toMatchObject({
      versionNo: 1,
      version: 2,
      status: "draft",
      grandTotalMinor: SINGLE.grand,
    });
    expect(view.bq!.bills).toHaveLength(1);
    const list = bqImportsResponseSchema.parse(
      (await qs.call("get", `${base(main)}/imports`)).body,
    ).imports;
    expect(list.map((entry) => [entry.id, entry.status])).toEqual([
      [accepted.id, "committed"],
      [firstImport.id, "superseded"],
    ]);
    const counts = await db.run(
      { userId: qs.auth.user.id, tenantId: tenantA, requestId: "bq-count" },
      async (tx) => ({
        versions: await tx.bqVersion.count({ where: { projectId: main.id } }),
        items: await tx.bqItem.count({ where: { versionId: view.bq!.version.id } }),
      }),
    );
    expect(counts).toEqual({ versions: 1, items: SINGLE.items });
  });

  it("rolls the whole commit back when it fails part-way", async () => {
    const before = await getBq(qs, main);
    const validated = await toValidated(qs, main, "kenyan-multi-bill.xlsx");
    const writer = app.get(BqVersionWriter);
    const original = writer.writeItems.bind(writer);
    const failing = vi.spyOn(writer, "writeItems").mockImplementationOnce(async (tx, rows) => {
      await original(tx, rows);
      throw new Error("Injected failure after the first item chunk");
    });
    const failed = await commit(qs, main, validated);
    expect(failed.status).toBe(500);
    expect(failing).toHaveBeenCalledTimes(1);
    failing.mockRestore();

    const after = await getBq(qs, main);
    expect(after.bq!.version).toEqual(before.bq!.version);
    expect(after.bq!.bills).toEqual(before.bq!.bills);
    const unchanged = imported(await qs.call("get", `${base(main)}/imports/${validated.id}`));
    expect(unchanged).toMatchObject({
      status: "validated",
      version: validated.version,
      bqVersionId: null,
    });
    const list = bqImportsResponseSchema.parse(
      (await qs.call("get", `${base(main)}/imports`)).body,
    ).imports;
    expect(list.filter((entry) => entry.status === "committed")).toHaveLength(1);
    const events = await auditEvents();
    expect(
      events.some(
        (event) => event.action === "bq.import.committed" && event.resourceId === validated.id,
      ),
    ).toBe(false);

    // The import is resumable: the same commit succeeds afterwards.
    const retried = await commit(qs, main, validated);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    const view = await getBq(qs, main);
    expect(view.bq!.version).toMatchObject({
      versionNo: 1,
      version: 3,
      grandTotalMinor: MULTI.grand,
    });
  });

  it("is a resumable state machine that refuses invalid transitions and stale versions", async () => {
    const parse = vi
      .spyOn(app.get(BqImportsService), "parse")
      .mockRejectedValueOnce(new Error("crash"));
    const crashed = await upload(qs, lifecycle, "kenyan-multi-bill.xlsx");
    expect(crashed.status).toBe(500);
    parse.mockRestore();
    const left = bqImportsResponseSchema.parse(
      (await qs.call("get", `${base(lifecycle)}/imports`)).body,
    ).imports[0]!;
    expect(left.status).toBe("uploaded");
    const resumed = await qs.call("post", `${base(lifecycle)}/imports/${left.id}/parse`, {});
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    const parsed = imported(resumed);
    expect(parsed.status).toBe("parsed");

    const path = `${base(lifecycle)}/imports/${parsed.id}`;
    const states = [
      await qs.call("post", `${path}/parse`, {}),
      await qs.call("post", `${path}/validate`, { version: parsed.version }),
      await qs.call("post", `${path}/commit`, { version: parsed.version }),
      await qs.call("put", `${path}/resolutions`, {
        resolutions: { rows: [], accepted: [] },
        version: parsed.version,
      }),
      await qs.call("get", `${path}/preview`),
    ];
    for (const res of states)
      expect([res.status, problem(res)]).toEqual([409, "invalid-import-state"]);
    const stale = await qs.call("put", `${path}/mapping`, {
      mapping: parsed.mapping,
      version: parsed.version + 5,
    });
    expect([stale.status, problem(stale)]).toEqual([409, "version-conflict"]);
    const outside = structuredClone(parsed.mapping!);
    outside.sheets[0]!.sheetIndex = 9;
    const badSheet = await qs.call("put", `${path}/mapping`, {
      mapping: outside,
      version: parsed.version,
    });
    expect([badSheet.status, problem(badSheet)]).toEqual([400, "mapping-invalid"]);
    const noDescription = structuredClone(parsed.mapping!);
    delete noDescription.sheets[0]!.columns.description;
    expect(
      (await qs.call("put", `${path}/mapping`, { mapping: noDescription, version: parsed.version }))
        .status,
    ).toBe(400);

    const mapped = await saveMapping(qs, lifecycle, parsed);
    const abandoned = await qs.call("post", `${path}/abandon`, { version: mapped.version });
    expect(abandoned.status).toBe(200);
    expect(imported(abandoned).status).toBe("abandoned");
    const after = imported(abandoned);
    expect(
      (await qs.call("put", `${path}/mapping`, { mapping: after.mapping, version: after.version }))
        .status,
    ).toBe(409);
    expect((await qs.call("post", `${path}/abandon`, { version: after.version })).status).toBe(409);

    // A commit re-checks what validation saw: a contract sum set afterwards makes the report stale.
    const ready = await toValidated(qs, lifecycle, "single-sheet-alt-columns.xlsx");
    await db.run({ userId: qs.auth.user.id, tenantId: tenantA, requestId: "bq-stale" }, (tx) =>
      tx.project.updateMany({
        where: { tenantId: tenantA, id: lifecycle.id },
        data: { contractSumMinor: 100_000_000n },
      }),
    );
    const staleCommit = await commit(qs, lifecycle, ready);
    expect([staleCommit.status, problem(staleCommit)]).toEqual([409, "validation-stale"]);
    const revalidated = await validate(qs, lifecycle, ready);
    expect(revalidated.report!.issues.map((issue) => issue.code)).toContain(
      "contract-sum-mismatch",
    );
    expect(
      (
        await qs.call("post", `${base(lifecycle)}/imports/${ready.id}/abandon`, {
          version: revalidated.version,
        })
      ).status,
    ).toBe(200);
    // The database refuses the same moves even when the API is bypassed.
    await expect(
      db.run({ userId: qs.auth.user.id, tenantId: tenantA, requestId: "bq-guard" }, (tx) =>
        tx.bqImport.update({
          where: { tenantId_id: { tenantId: tenantA, id: parsed.id } },
          data: { status: "mapped" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("saves, matches, applies and deletes company mapping templates", async () => {
    const created = await qs.call("post", `${base(main)}/templates`, {
      name: "Synthetic QS layout",
      importId: firstImport.id,
      sheetIndex: 1,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const template = bqTemplateResponseSchema.parse(created.body).template;
    templateId = template.id;
    expect(template).toMatchObject({
      signature: "item|description|unit|qty|rate|amount",
      columns: { ref: 0, description: 1, unit: 2, quantity: 3, rate: 4, amount: 5 },
      dataOffset: 2,
    });
    const duplicate = await qs.call("post", `${base(main)}/templates`, {
      name: "Synthetic QS layout",
      importId: firstImport.id,
      sheetIndex: 1,
    });
    expect([duplicate.status, problem(duplicate)]).toEqual([409, "template-name-taken"]);
    const listed = bqTemplatesResponseSchema.parse(
      (await qs.call("get", `${base(alt)}/templates`)).body,
    );
    expect(listed.templates.map((entry) => entry.id)).toContain(template.id);

    // A new upload with the same header layout is matched at parse time and the template applies.
    const res = await upload(qs, lifecycle, "kenyan-multi-bill.xlsx");
    const parsed = imported(res);
    expect(parsed.sheets!.slice(0, 4).map((sheet) => sheet.templateId)).toEqual(
      Array(4).fill(template.id),
    );
    expect(parsed.mapping!.templateId).toBe(template.id);
    const applied = await qs.call(
      "post",
      `${base(lifecycle)}/imports/${parsed.id}/apply-template`,
      {
        templateId: template.id,
        version: parsed.version,
      },
    );
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(imported(applied)).toMatchObject({
      status: "mapped",
      mapping: { templateId: template.id },
    });
    const single = imported(await upload(qs, lifecycle, "single-sheet-alt-columns.xlsx"));
    const notApplicable = await qs.call(
      "post",
      `${base(lifecycle)}/imports/${single.id}/apply-template`,
      {
        templateId: template.id,
        version: single.version,
      },
    );
    expect([notApplicable.status, problem(notApplicable)]).toEqual([
      409,
      "template-not-applicable",
    ]);

    const temporary = bqTemplateResponseSchema.parse(
      (
        await qs.call("post", `${base(main)}/templates`, {
          name: "Temporary",
          importId: firstImport.id,
          sheetIndex: 2,
        })
      ).body,
    ).template;
    expect((await qs.call("delete", `${base(main)}/templates/${temporary.id}`)).status).toBe(200);
    expect((await qs.call("delete", `${base(main)}/templates/${temporary.id}`)).status).toBe(404);
  });

  it("checks bq.view and bq.import on the project (role ∩ assignment)", async () => {
    const view = await getBq(agent, main);
    expect(view.permissions).toEqual({
      canImport: false,
      canExport: true,
      canEdit: false,
      canApprove: false,
    });
    expect(view.openImports).toBe(0);
    expect((await upload(agent, main, "kenyan-multi-bill.xlsx")).status).toBe(403);
    for (const path of [
      `${base(main)}/imports`,
      `${base(main)}/imports/${firstImport.id}`,
      `${base(main)}/imports/${firstImport.id}/source`,
      `${base(main)}/templates`,
    ])
      expect((await agent.call("get", path)).status, path).toBe(403);
    expect((await agent.download(`${base(main)}/export/xlsx`)).status).toBe(200);

    // A project manager assigned to another project only.
    expect((await pm.call("get", base(main))).status).toBe(403);
    expect((await upload(pm, main, "kenyan-multi-bill.xlsx")).status).toBe(403);
    expect((await upload(pm, other, "kenyan-multi-bill.xlsx")).status).toBe(201);

    // No session: refused before the body is read.
    const anonymous = await request(app.getHttpServer())
      .post(`/api/v1/${base(main)}/imports`)
      .set("Origin", "http://localhost:3000")
      .attach("file", fixture("kenyan-multi-bill.xlsx"), "kenyan-multi-bill.xlsx");
    expect([401, 403]).toContain(anonymous.status);

    // The owner (company-wide role) may download the source; it matches the upload exactly.
    await fresh(owner);
    const source = await owner.download(`${base(main)}/imports/${firstImport.id}/source`);
    expect(source.status).toBe(200);
    expect((source.body as Buffer).equals(fixture("kenyan-multi-bill.xlsx"))).toBe(true);
    expect(source.headers["content-disposition"]).toContain('filename="kenyan-multi-bill.xlsx"');
  });

  it("isolates imports, files, templates and BQs between companies", async () => {
    const view = await getBq(qs, main);
    const billId = view.bq!.bills[0]!.id;
    for (const path of [
      base(main),
      `${base(main)}/imports/${firstImport.id}`,
      `${base(bProject)}/imports/${firstImport.id}`,
      `${base(bProject)}/imports/${firstImport.id}/source`,
      `${base(bProject)}/bills/${billId}`,
    ])
      expect((await ownerB.call("get", path)).status, path).toBe(404);
    const templates = bqTemplatesResponseSchema.parse(
      (await ownerB.call("get", `${base(bProject)}/templates`)).body,
    );
    expect(templates.templates).toEqual([]);
    expect((await ownerB.call("delete", `${base(bProject)}/templates/${templateId}`)).status).toBe(
      404,
    );
    const created = await ownerB.call("post", `${base(bProject)}/templates`, {
      name: "Stolen",
      importId: firstImport.id,
      sheetIndex: 1,
    });
    expect(created.status).toBe(404);
    expect(
      (
        await ownerB.call("post", `${base(bProject)}/imports/${firstImport.id}/commit`, {
          version: 1,
        })
      ).status,
    ).toBe(404);

    await db.run(
      { userId: ownerB.auth.user.id, tenantId: tenantB, requestId: "bq-rls" },
      async (tx) => {
        expect(await tx.bqImport.findMany()).toEqual([]);
        expect(await tx.bq.count()).toBe(0);
        expect(await tx.bqVersion.count()).toBe(0);
        expect(await tx.bqBill.count()).toBe(0);
        expect(await tx.bqItem.count()).toBe(0);
        expect(await tx.bqMappingTemplate.count()).toBe(0);
      },
    );
    // Writing into company A's rows from company B's context, or pointing at them, is refused.
    await expect(
      db.run({ userId: ownerB.auth.user.id, tenantId: tenantB, requestId: "bq-rls-write" }, (tx) =>
        tx.bqMappingTemplate.create({
          data: {
            id: crypto.randomUUID(),
            tenantId: tenantA,
            name: "Cross",
            signature: "x",
            columns: { description: 0 },
            dataOffset: 1,
            createdBy: ownerB.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run({ userId: ownerB.auth.user.id, tenantId: tenantB, requestId: "bq-fk" }, (tx) =>
        tx.bq.create({
          data: {
            id: crypto.randomUUID(),
            tenantId: tenantB,
            projectId: main.id,
            name: "Cross",
            createdBy: ownerB.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("refuses unsafe uploads before anything is stored", async () => {
    const count = () =>
      db.run({ userId: qs.auth.user.id, tenantId: tenantA, requestId: "bq-uploads" }, (tx) =>
        tx.bqImport.count({ where: { projectId: lifecycle.id } }),
      );
    const before = await count();
    const cases: [Buffer, string, number, string][] = [
      [fixture("zip-bomb.xlsx"), "zip-bomb.xlsx", 422, "unsafe-archive"],
      [fixture("not-excel.xlsx"), "not-excel.xlsx", 415, "unsupported-file-type"],
      [fixture("kenyan-multi-bill.xls"), "renamed.xlsx", 415, "unsupported-file-type"],
      [fixture("kenyan-multi-bill.xlsx"), "renamed.xls", 415, "unsupported-file-type"],
      [Buffer.from("item,description\n1,two\n"), "bq.csv", 415, "unsupported-file-type"],
      [Buffer.alloc(0), "empty.xlsx", 400, "empty-file"],
    ];
    for (const [content, name, status, code] of cases) {
      const res = await qs.upload(`${base(lifecycle)}/imports`, content, name);
      expect([res.status, problem(res)], name).toEqual([status, code]);
    }
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0x20);
    fixture("kenyan-multi-bill.xlsx").copy(oversized);
    const tooBig = await qs.upload(`${base(lifecycle)}/imports`, oversized, "huge.xlsx");
    expect([tooBig.status, problem(tooBig)]).toEqual([413, "payload-too-large"]);
    const noFile = await qs.call("post", `${base(lifecycle)}/imports`, {});
    expect([noFile.status, problem(noFile)]).toEqual([400, "file-required"]);
    expect(await count()).toBe(before);
    const refused = (await auditEvents()).filter((event) => event.action === "bq.import.refused");
    expect(refused.map((event) => (event.metadata as { reason: string }).reason)).toEqual(
      expect.arrayContaining(["unsafe-archive", "unsupported-file-type", "empty-file"]),
    );

    // A package that passes the checks but cannot be read is recorded as failed (terminal).
    const junk = await qs.upload(`${base(lifecycle)}/imports`, junkWorkbook(), "junk.xlsx");
    expect(junk.status, JSON.stringify(junk.body)).toBe(201);
    const failed = imported(junk);
    expect(failed.status).toBe("failed");
    expect(["workbook-unreadable", "no-sheets"]).toContain(failed.failureCode);
    expect(
      (await qs.call("post", `${base(lifecycle)}/imports/${failed.id}/parse`, {})).status,
    ).toBe(409);
  });

  it("protects committed imports and BQ content in the database", async () => {
    const context = { userId: qs.auth.user.id, tenantId: tenantA, requestId: "bq-db" };
    const view = await getBq(qs, messy);
    const versionId = view.bq!.version.id;
    const committed = (await getBq(qs, main)).bq!.source!.importId;
    await expect(
      db.run(context, (tx) =>
        tx.bqImport.update({
          where: { tenantId_id: { tenantId: tenantA, id: committed } },
          data: { mapping: { sheets: [], templateId: null } },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(context, (tx) =>
        tx.bqImport.update({
          where: { tenantId_id: { tenantId: tenantA, id: firstImport.id } },
          data: { sourceKey: "elsewhere" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(
        context,
        (tx) => tx.$executeRaw`DELETE FROM bq_imports WHERE id = ${firstImport.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    // A computed line must stay quantity × rate rounded half-up.
    await expect(
      db.run(
        context,
        (tx) =>
          tx.$executeRaw`UPDATE bq_items SET amount_minor = amount_minor + 1
          WHERE version_id = ${versionId}::uuid AND amount_source = 'computed'`,
      ),
    ).rejects.toThrow();
    // A bill total that no longer matches its items is refused when the transaction commits.
    await expect(
      db.run(
        context,
        (tx) =>
          tx.$executeRaw`UPDATE bq_bills SET total_minor = total_minor + 100 WHERE version_id = ${versionId}::uuid`,
      ),
    ).rejects.toThrow();
    // Only a draft's content can change.
    await expect(
      db.run(context, async (tx) => {
        await tx.$executeRaw`UPDATE bq_versions SET status = 'approved' WHERE id = ${versionId}::uuid`;
        await tx.$executeRaw`UPDATE bq_items SET notes = 'changed' WHERE version_id = ${versionId}::uuid`;
      }),
    ).rejects.toThrow();
    const unchanged = await getBq(qs, messy);
    expect(unchanged.bq!.version).toEqual(view.bq!.version);
  });
});
