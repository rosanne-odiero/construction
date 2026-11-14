import { randomUUID } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import sharp from "sharp";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import {
  approvalListResponseSchema,
  approvalResponseSchema,
  complianceHistoryResponseSchema,
  complianceRegisterResponseSchema,
  complianceTypeResponseSchema,
  complianceTypesResponseSchema,
  documentListResponseSchema,
  documentResponseSchema,
  documentsOverviewResponseSchema,
  drawingRegisterResponseSchema,
  instructionLogListResponseSchema,
  instructionLogResponseSchema,
  instructionOptionsResponseSchema,
  instructionResponseSchema,
  projectDetailResponseSchema,
  projectDocumentsSummaryResponseSchema,
  projectResponseSchema,
  scheduleDelayResponseSchema,
  sitePhotoResponseSchema,
  siteResponseSchema,
  tenantCreatedResponseSchema,
  type ComplianceRegisterResponse,
  type DocumentDetail,
  type Instruction,
} from "@pm-buddy/validation";
import { PrismaPg } from "@prisma/adapter-pg";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { jpegWithExif, plainJpeg } from "./photo-fixtures.js";
import { Browser, notifications, origin } from "./support.js";
import { testDatabaseUrls } from "./test-database.js";

/** A small valid PDF; the label keeps every file's SHA-256 distinct. */
const pdf = (label: string, extra = "") =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n${extra}% ${label} ${randomUUID()}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
  );

/** A zip with the given entries (deflated), optionally lying about the uncompressed size. */
function zip(entries: { name: string; data: string; claim?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(entry.data);
    const body = deflateRawSync(raw);
    const name = Buffer.from(entry.name);
    const size = entry.claim ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(8, 10);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(size, 24);
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
const officeParts = (main: string, extra: { name: string; data: string }[] = []) =>
  zip([
    { name: "[Content_Types].xml", data: `<Types/><!-- ${randomUUID()} -->` },
    { name: main, data: "<document/>" },
    ...extra,
  ]);

/** Metres → degrees near Ruiru (the sites' geofence centre). */
const centre = { lat: -1.1489, lng: 36.9612 };
const exifNow = () =>
  new Date(Date.now() - 30 * 60_000 + 3 * 3_600_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ")
    .replace(/-/g, ":");

/**
 * D8.4 documents and compliance register against the real database as the runtime role (pmb_app):
 * versioned documents with exactly one current version (a superseded drawing is never current —
 * the done-when), uploads checked by content, confidential categories, the compliance register
 * with derived Nairobi-date statuses (an expiring item raises a reminder and an expired one shows
 * expired — the done-when), renewals, company items, exports, the consultant instructions log,
 * approval requests with independent responses, tenant isolation, every database guard refusing
 * direct SQL, downloads audited and an audit log without free text.
 */
describe("Documents and compliance register (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let manager: Browser;
  let surveyor: Browser;
  let consultant: Browser;
  let agent: Browser;
  let foreman: Browser;
  let storekeeper: Browser;
  let client: Browser;
  let finance: Browser;
  let outsider: Browser;
  let tenantId: string;
  let otherTenant: string;
  let projectId: string;
  let otherProject: string;
  let closedProject: string;
  let foreignProject: string;
  let siteId: string;
  let notificationSpy: ReturnType<typeof vi.spyOn>;
  const today = nairobiDate();
  const day = (offset: number) => addCalendarDays(today, offset);
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
  const invite = async (member: Browser, role: string) => {
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
  };
  const assign = async (member: Browser, project: string, permissions: string[]) => {
    await fresh();
    expect(
      (
        await owner.call("put", `projects/${project}/members/${member.auth.user.id}`, {
          permissions,
        })
      ).status,
    ).toBe(200);
  };
  const join = async (member: Browser, role: string, permissions: string[]) => {
    await invite(member, role);
    for (const project of [projectId, otherProject, closedProject])
      await assign(member, project, permissions);
  };
  const base = (project = projectId) => `projects/${project}`;
  const document = (res: request.Response, status = 200) =>
    ok(res, (body) => documentResponseSchema.parse(body).document, status);
  const upload = (
    browser: Browser,
    fields: Record<string, string>,
    content: Buffer = pdf(fields["title"] ?? "file"),
    name = "file.pdf",
    project = projectId,
  ) => browser.upload(`${base(project)}/documents`, content, name, fields);
  const drawing = async (number: string, revision = "A", browser = manager) =>
    document(
      await upload(browser, {
        category: "drawing",
        title: `Ground floor plan ${number} (synthetic)`,
        drawingNumber: number,
        discipline: "architectural",
        revision,
        issuePurpose: "for_construction",
      }),
      201,
    );
  const newVersion = (
    browser: Browser,
    doc: DocumentDetail,
    revision: string,
    content: Buffer = pdf(`${doc.title} ${revision}`),
    extra: Record<string, string> = {},
  ) =>
    browser.upload(`${base(doc.projectId)}/documents/${doc.id}/versions`, content, "next.pdf", {
      revision,
      changeNote: `Revised to ${revision} (synthetic)`,
      basedOnVersionId: doc.current.id,
      ...extra,
    });
  const register = async (browser = manager, project = projectId) =>
    ok(await browser.call("get", `${base(project)}/compliance`), (body) =>
      complianceRegisterResponseSchema.parse(body),
    );
  const item = (register: ComplianceRegisterResponse, key: string) =>
    register.items.find((entry) => entry.type.key === key)!;
  const record = (browser: Browser, body: object, project: string | null = projectId) =>
    browser.call("post", project ? `${base(project)}/compliance` : "documents/compliance", body);
  const instruction = (
    browser: Browser,
    body: object,
    key = `k-${randomUUID()}`,
    id = randomUUID(),
  ) =>
    browser.call(
      "post",
      `${base()}/instructions`,
      {
        id,
        kind: "architect_instruction",
        issuerName: "Arch. Wanjiru Kamau (synthetic)",
        issuerRole: "architect",
        issuerFirm: "Kamau Associates (synthetic)",
        issuedOn: day(-3),
        receivedOn: day(-2),
        subject: "Revise the staircase balustrade (synthetic)",
        costImplication: true,
        ...body,
      },
      true,
      { "Idempotency-Key": key },
    );
  const respond = (browser: Browser, id: string, kind: string, version: number, body?: string) =>
    browser.call("post", `${base()}/instructions/${id}/responses`, {
      kind,
      version,
      ...(body ? { body } : {}),
    });
  const sql = (browser: Browser, statement: string, tenant = tenantId) =>
    db.run(context(browser, tenant), (tx) => tx.$executeRawUnsafe(statement));
  /** Statements in one transaction as the schema owner (who meets the same triggers and RLS). */
  const ownerSql = async (statements: string | string[], user = manager) => {
    const schemaOwner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrls().migrationUrl }),
    });
    try {
      await schemaOwner.$transaction([
        schemaOwner.$executeRawUnsafe(
          `SELECT set_config('app.tenant_id', '${tenantId}', true), set_config('app.user_id', '${user.auth.user.id}', true)`,
        ),
        ...[statements].flat().map((statement) => schemaOwner.$executeRawUnsafe(statement)),
      ]);
    } finally {
      await schemaOwner.$disconnect();
    }
  };

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
    surveyor = new Browser(app);
    consultant = new Browser(app);
    agent = new Browser(app);
    foreman = new Browser(app);
    storekeeper = new Browser(app);
    client = new Browser(app);
    finance = new Browser(app);
    outsider = new Browser(app);
    for (const browser of [
      owner,
      manager,
      surveyor,
      consultant,
      agent,
      foreman,
      storekeeper,
      client,
      finance,
      outsider,
    ])
      await browser.register();
    for (const browser of [owner, outsider, manager, finance]) await browser.enroll();
    tenantId = tenantCreatedResponseSchema.parse(
      (await owner.call("post", "tenants", { name: `Documents company ${randomUUID()}` })).body,
    ).tenant.id;
    otherTenant = tenantCreatedResponseSchema.parse(
      (await outsider.call("post", "tenants", { name: `Other documents company ${randomUUID()}` }))
        .body,
    ).tenant.id;
    const project = async (browser: Browser, name: string) => {
      await fresh(browser);
      return projectResponseSchema.parse((await browser.call("post", "projects", { name })).body)
        .project.id;
    };
    projectId = await project(owner, "Documents project");
    otherProject = await project(owner, "Another documents project");
    closedProject = await project(owner, "Documents project to cancel");
    foreignProject = await project(outsider, "Foreign documents project");
    siteId = ok(
      await owner.call("post", `${base()}/sites`, {
        name: "Main plot",
        geofence: { kind: "radius", center: centre, radiusM: 60 },
      }),
      (body) => siteResponseSchema.parse(body).site.id,
      201,
    );
    await join(manager, "project_manager", [
      "projects.view",
      "projects.manage",
      "documents.manage",
      "bq.edit",
      "finance.view",
      "site.diary",
      "site.photos",
    ]);
    await join(surveyor, "quantity_surveyor", [
      "projects.view",
      "bq.view",
      "bq.edit",
      "documents.manage",
      "finance.view",
    ]);
    // The architect: documents.manage without commercial (finance) keys.
    await join(consultant, "consultant", ["projects.view", "bq.view", "documents.manage"]);
    await join(agent, "site_agent", ["projects.view", "site.diary", "site.photos"]);
    await join(foreman, "foreman", ["projects.view", "site.diary"]);
    await join(storekeeper, "storekeeper", ["projects.view", "stores.manage"]);
    await join(client, "client", ["projects.view", "bq.view", "portal.client"]);
    // Finance is company-wide (finance.view and finance.manage everywhere).
    await invite(finance, "finance");
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("publishes every documents operation and refuses requests without a session or CSRF token", async () => {
    const spec = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (spec.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((entry) => Object.values(entry).map((operation) => operation.operationId));
    for (const name of [
      "listDocuments",
      "getDrawingRegister",
      "getProjectDocumentsSummary",
      "createDocument",
      "getDocument",
      "updateDocument",
      "withdrawDocument",
      "addDocumentVersion",
      "downloadDocumentVersion",
      "getComplianceRegister",
      "recordComplianceItem",
      "exportComplianceRegisterPdf",
      "exportComplianceRegisterExcel",
      "getComplianceItem",
      "listInstructionsLog",
      "getInstructionOptions",
      "recordInstruction",
      "getInstructionLogEntry",
      "updateInstructionLogEntry",
      "respondToInstruction",
      "attachToInstruction",
      "listApprovalRequests",
      "raiseApprovalRequest",
      "getApprovalRequest",
      "respondToApprovalRequest",
      "cancelApprovalRequest",
      "getDocumentsOverview",
      "listComplianceTypes",
      "createComplianceType",
      "updateComplianceType",
      "recordCompanyComplianceItem",
      "getCompanyComplianceItem",
    ])
      expect(operations, name).toContain(name);
    const anonymous = new Browser(app);
    await anonymous.initialize();
    problem(await anonymous.call("get", `${base()}/documents`), 401);
    problem(await manager.call("post", `${base()}/approvals`, { kind: "other" }, false), 403);
  });

  it("keeps exactly one current version: a superseded drawing is never returned or shown as current (done-when)", async () => {
    const first = await drawing("A-101");
    expect(first).toMatchObject({
      category: "drawing",
      drawingNumber: "A-101",
      discipline: "architectural",
      confidential: false,
      versionCount: 1,
      current: { versionNo: 1, revision: "A", state: "current", contentType: "application/pdf" },
      nextRevision: "B",
      permissions: { canUpload: true, canEdit: true, canWithdraw: true },
    });
    const revA = first.versions[0]!;
    const second = document(await newVersion(manager, first, "B"), 201);
    expect(second.current).toMatchObject({ versionNo: 2, revision: "B", state: "current" });
    expect(second.versions.map((version) => [version.revision, version.state])).toEqual([
      ["B", "current"],
      ["A", "superseded"],
    ]);
    expect(second.versions[1]).toMatchObject({
      id: revA.id,
      supersededBy: { id: second.current.id, revision: "B" },
    });
    expect(second.versions[1]!.supersededAt).not.toBeNull();

    // Lists, the drawing register and the summary only ever show B as current.
    const list = ok(await foreman.call("get", `${base()}/documents?category=drawing`), (body) =>
      documentListResponseSchema.parse(body),
    );
    const row = list.documents.find((entry) => entry.id === first.id)!;
    expect(row.current).toMatchObject({ id: second.current.id, revision: "B", state: "current" });
    const drawings = ok(await agent.call("get", `${base()}/documents/drawings`), (body) =>
      drawingRegisterResponseSchema.parse(body),
    );
    const listed = drawings.drawings.filter((entry) => entry.drawingNumber === "A-101");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.current.revision).toBe("B");
    expect(JSON.stringify(drawings)).not.toContain(revA.id);

    // The superseded file stays downloadable and is always labelled superseded.
    const old = await foreman.download(
      `${base()}/documents/${first.id}/versions/${revA.id}/content`,
    );
    expect(old.status).toBe(200);
    expect(old.headers["x-document-version-state"]).toBe("superseded");
    expect(old.headers["content-disposition"]).toMatch(
      /^attachment; filename=".*_rev-A_SUPERSEDED\.pdf"/,
    );
    expect(old.headers["x-content-type-options"]).toBe("nosniff");
    expect((old.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    const current = await foreman.download(
      `${base()}/documents/${first.id}/versions/${second.current.id}/content`,
    );
    expect(current.headers["x-document-version-state"]).toBe("current");
    expect(current.headers["content-disposition"]).not.toContain("SUPERSEDED");

    // The database refuses to make the superseded version current again, or two current ones.
    await expect(
      sql(
        manager,
        `UPDATE document_versions SET is_current = true, superseded_at = NULL, superseded_by_id = NULL WHERE id = '${revA.id}'`,
      ),
    ).rejects.toThrow(/never changes|supersedes/);
    await expect(
      sql(
        manager,
        `UPDATE document_versions SET is_current = false, superseded_at = now(), superseded_by_id = '${revA.id}' WHERE id = '${second.current.id}'`,
      ),
    ).rejects.toThrow(/exactly one current version|superseded by the next/);
    // Even with the guard switched off (rolled back with the failed transaction), the partial
    // unique index allows only one current version per document.
    await expect(
      ownerSql([
        "ALTER TABLE document_versions DISABLE TRIGGER document_version_guard",
        `UPDATE document_versions SET is_current = true, superseded_at = NULL, superseded_by_id = NULL WHERE id = '${revA.id}'`,
      ]),
    ).rejects.toThrow(/document_versions_one_current|duplicate key/);
    const reloaded = document(await manager.call("get", `${base()}/documents/${first.id}`));
    expect(reloaded.versions.filter((version) => version.state === "current")).toHaveLength(1);
  });

  it("orders revisions, refuses stale, duplicate and out-of-order uploads, and caps versions", async () => {
    const plan = await drawing("S-201", "P1");
    const p2 = document(await newVersion(manager, plan, "P2"), 201);
    problem(await newVersion(manager, p2, "P2"), 409, "revision-exists");
    problem(await newVersion(manager, p2, "p1"), 409, "revision-exists");
    problem(await newVersion(manager, p2, "P0"), 409, "revision-not-after");
    problem(await newVersion(manager, p2, "rev c/1"), 400);
    // Stale: based on the version before the current one.
    problem(await newVersion(manager, plan, "P3"), 409, "version-stale");
    const sameFile = pdf("same file");
    const a = document(await newVersion(manager, p2, "A", sameFile), 201);
    expect(a.current).toMatchObject({ revision: "A", versionNo: 3 });
    problem(await newVersion(manager, a, "B", sameFile), 409, "version-duplicate");
    // A change note is required for a new version.
    problem(
      await manager.upload(`${base()}/documents/${a.id}/versions`, pdf("x"), "x.pdf", {
        revision: "B",
        basedOnVersionId: a.current.id,
      }),
      400,
    );
    // Drawing numbers are unique per project (case-insensitive) and drawings need a discipline.
    problem(
      await upload(manager, {
        category: "drawing",
        title: "Duplicate number (synthetic)",
        drawingNumber: "s-201",
        discipline: "structural",
        revision: "A",
      }),
      409,
      "drawing-number-taken",
    );
    problem(
      await upload(manager, { category: "drawing", title: "No number (synthetic)", revision: "A" }),
      400,
    );
    // A document keeps at most 50 versions: versions 2–50 added directly (in order), then the API
    // refuses a 51st (409 version-limit) and so does the database.
    const capped = document(
      await upload(manager, {
        category: "specification",
        title: "Fifty versions (synthetic)",
        revision: "1",
      }),
      201,
    );
    const insertVersions = (from: number, to: number) =>
      sql(
        manager,
        `WITH v AS (SELECT gen_random_uuid() AS id, n FROM generate_series(${from}, ${to}) AS n)
         INSERT INTO document_versions (id, tenant_id, project_id, document_id, version_no, revision, change_note, file_name, content_type, size_bytes, sha256, object_key, scan_status, scan_engine, scanned_at, uploaded_by)
         SELECT v.id, '${tenantId}', '${projectId}', '${capped.id}', v.n, 'V' || v.n, 'Version ' || v.n, 'x.pdf', 'application/pdf', 10, encode(sha256(v.id::text::bytea), 'hex'),
           'tenants/${tenantId}/projects/${projectId}/documents/${capped.id}/' || v.id, 'clean', 'test', now(), '${manager.auth.user.id}'
         FROM v ORDER BY v.n`,
      );
    await insertVersions(2, 50);
    const fifty = document(await manager.call("get", `${base()}/documents/${capped.id}`));
    expect([fifty.versionCount, fifty.current.versionNo]).toEqual([50, 50]);
    problem(await newVersion(manager, fifty, "V51"), 409, "version-limit");
    await expect(insertVersions(51, 51)).rejects.toThrow(/document_versions_check/);
  });

  it("accepts files by their content only and refuses CAD, old Office, macros, PDF scripts and unsafe archives", async () => {
    const fields = (title: string, category = "specification") => ({
      category,
      title,
      revision: "1",
    });
    const accepted: [Buffer, string, string][] = [
      [
        officeParts("word/document.xml"),
        "spec.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
      [
        officeParts("xl/workbook.xml"),
        "schedule.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
      // A chart's data workbook, embedded as Word does, is a plain workbook and is accepted.
      [
        officeParts("word/document.xml", [
          { name: "word/embeddings/Microsoft_Excel_Worksheet.xlsx", data: "x" },
        ]),
        "report-with-chart.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
      [await plainJpeg(), "photo.jpg", "image/jpeg"],
      [
        await sharp({ create: { width: 8, height: 8, channels: 3, background: "#3366aa" } })
          .png()
          .toBuffer(),
        "plan.png",
        "image/png",
      ],
      [
        await sharp({ create: { width: 8, height: 8, channels: 3, background: "#aa6633" } })
          .webp()
          .toBuffer(),
        "plan.webp",
        "image/webp",
      ],
    ];
    for (const [content, name, type] of accepted) {
      const created = document(
        await upload(manager, fields(`Accepted ${name} (synthetic)`), content, name),
        201,
      );
      expect(created.current.contentType, name).toBe(type);
    }
    // The stored name is reduced to a safe stem plus the detected type's extension.
    const renamed = document(
      await upload(
        manager,
        fields("Renamed file (synthetic)"),
        pdf("renamed"),
        "../../evil<script>.exe",
      ),
      201,
    );
    expect(renamed.current.fileName).toBe("evil_script.pdf");
    const refused: [Buffer, string, number, string][] = [
      [
        Buffer.concat([Buffer.from("AC1032"), Buffer.alloc(64)]),
        "plan.dwg",
        415,
        "unsupported-file-type",
      ],
      [
        Buffer.from("  0\r\nSECTION\r\n  2\r\nHEADER\r\n"),
        "plan.dxf",
        415,
        "unsupported-file-type",
      ],
      [
        Buffer.concat([
          Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
          Buffer.alloc(512),
        ]),
        "old.doc",
        415,
        "unsupported-file-type",
      ],
      [Buffer.from("MZ\x90\x00 not a pdf at all"), "drawing.pdf", 415, "unsupported-file-type"],
      [
        Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\n"),
        "truncated.pdf",
        415,
        "unsupported-file-type",
      ],
      [
        pdf("script", "3 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj\n"),
        "script.pdf",
        422,
        "pdf-active-content",
      ],
      [
        pdf("launch", "3 0 obj << /S /Launch /F (cmd.exe) >> endobj\n"),
        "launch.pdf",
        422,
        "pdf-active-content",
      ],
      // Names spelled with #xx hex escapes are decoded first: /J#61vaScript is /JavaScript.
      [
        pdf("escaped", "3 0 obj << /S /J#61vaScript /#4AS (app.alert(1)) >> endobj\n"),
        "escaped.pdf",
        422,
        "pdf-active-content",
      ],
      // A macro-enabled workbook embedded in a document (Word's default name for one).
      [
        officeParts("word/document.xml", [
          { name: "word/embeddings/Microsoft_Excel_Macro-Enabled_Worksheet.xlsm", data: "x" },
        ]),
        "embedded-macro.docx",
        422,
        "macro-document",
      ],
      [
        officeParts("word/document.xml", [{ name: "word/vbaProject.bin", data: "macro" }]),
        "macro.docx",
        422,
        "macro-document",
      ],
      [
        officeParts("xl/workbook.xml", [{ name: "xl/activeX/activeX1.bin", data: "x" }]),
        "activex.xlsx",
        422,
        "macro-document",
      ],
      [zip([{ name: "readme.txt", data: "hello" }]), "archive.docx", 415, "unsupported-file-type"],
      [
        zip([
          { name: "[Content_Types].xml", data: "<Types/>" },
          { name: "word/document.xml", data: "x", claim: 200 * 1024 * 1024 },
        ]),
        "bomb.docx",
        422,
        "unsafe-archive",
      ],
    ];
    for (const [content, name, status, code] of refused)
      problem(
        await upload(manager, fields(`Refused ${name} (synthetic)`), content, name),
        status,
        code,
      );
    // One byte over 25 MB: refused while the body is read, before anything is stored.
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1, 0x20);
    pdf("big").copy(oversized);
    problem(await upload(manager, fields("Too large (synthetic)"), oversized, "big.pdf"), 413);
    problem(
      await manager.call("post", `${base()}/documents`, {
        category: "other",
        title: "No file",
        revision: "A",
      }),
      400,
    );
  });

  it("keeps contracts, BQs and insurance away from everyone who cannot see commercial terms", async () => {
    const contract = document(
      await upload(surveyor, {
        category: "contract",
        title: "Main contract — contract sum KES 48,250,000 (synthetic)",
        reference: "JBC-2026-014",
        revision: "Signed",
      }),
      201,
    );
    expect(contract.confidential).toBe(true);
    const path = `${base()}/documents/${contract.id}`;
    const download = `${path}/versions/${contract.current.id}/content`;
    for (const reader of [consultant, agent, foreman]) {
      const list = ok(
        await reader.call("get", `${base()}/documents?status=all&limit=100`),
        (body) => documentListResponseSchema.parse(body),
      );
      expect(list.documents.map((entry) => entry.id)).not.toContain(contract.id);
      expect(list.counts.contract).toBe(0);
      expect(list.permissions.canSeeConfidential).toBe(false);
      const filtered = ok(
        await reader.call("get", `${base()}/documents?category=contract`),
        (body) => documentListResponseSchema.parse(body),
      );
      expect(filtered.documents).toEqual([]);
      problem(await reader.call("get", path), 404);
      expect((await reader.download(download)).status).toBe(404);
    }
    // The consultant manages documents but may not upload commercial ones.
    problem(
      await upload(consultant, {
        category: "insurance",
        title: "CAR policy (synthetic)",
        revision: "1",
      }),
      403,
      "confidential-category",
    );
    for (const reader of [surveyor, manager, finance, owner]) {
      expect(document(await reader.call("get", path)).title).toContain("contract sum");
      expect((await reader.download(download)).status).toBe(200);
    }
    // The consultant uploads drawings; the foreman reads them but cannot upload.
    expect((await drawing("A-301", "A", consultant)).createdBy.id).toBe(consultant.auth.user.id);
    problem(
      await upload(foreman, {
        category: "drawing",
        title: "Sketch",
        drawingNumber: "SK-1",
        discipline: "other",
        revision: "A",
      }),
      403,
    );
  });

  it("refuses clients, storekeepers and other companies, and keeps the tables isolated", async () => {
    for (const reader of [client, storekeeper])
      for (const path of [
        `${base()}/documents`,
        `${base()}/compliance`,
        `${base()}/instructions`,
        `${base()}/approvals`,
        `${base()}/documents/summary`,
      ])
        problem(await reader.call("get", path), 403);
    problem(await client.call("get", "documents"), 403);
    for (const path of [
      `${base()}/documents`,
      `${base()}/compliance`,
      `${base()}/instructions`,
      `${base()}/approvals`,
    ])
      problem(await outsider.call("get", path), 404);
    problem(await manager.call("get", `${base(foreignProject)}/documents`), 404);
    await db.run(context(outsider, otherTenant), async (tx) => {
      expect(await tx.document.count()).toBe(0);
      expect(await tx.documentVersion.count()).toBe(0);
      expect(await tx.complianceRecord.count()).toBe(0);
      expect(await tx.instructionResponse.count()).toBe(0);
      expect(await tx.instructionAttachment.count()).toBe(0);
      expect(await tx.approvalRequest.count()).toBe(0);
      expect(await tx.approvalResponse.count()).toBe(0);
      expect(await tx.complianceType.count({ where: { tenantId } })).toBe(0);
    });
    // Writing A's tenant ID, or pointing B's rows at A's project, is refused.
    await expect(
      sql(
        outsider,
        `INSERT INTO documents (id, tenant_id, project_id, category, title, created_by, updated_by) VALUES (gen_random_uuid(), '${tenantId}', '${projectId}', 'other', 'Cross tenant', '${outsider.auth.user.id}', '${outsider.auth.user.id}')`,
        otherTenant,
      ),
    ).rejects.toThrow();
    await expect(
      sql(
        outsider,
        `INSERT INTO documents (id, tenant_id, project_id, category, title, created_by, updated_by) VALUES (gen_random_uuid(), '${otherTenant}', '${projectId}', 'other', 'Cross project', '${outsider.auth.user.id}', '${outsider.auth.user.id}')`,
        otherTenant,
      ),
    ).rejects.toThrow();
    // Row-level security's WITH CHECK on its own: a company setting with A's tenant ID, written in
    // B's context (its guard looks nothing up, so only the policy can refuse it).
    await expect(
      sql(
        outsider,
        `INSERT INTO compliance_types (id, tenant_id, key, label, scope, expires, created_by, updated_by) VALUES (gen_random_uuid(), '${tenantId}', 'custom_999', 'Cross tenant item', 'project', true, '${outsider.auth.user.id}', '${outsider.auth.user.id}')`,
        otherTenant,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("raises a reminder for an expiring item and shows an expired one as expired (done-when)", async () => {
    const first = await register();
    expect(first.today).toBe(today);
    expect(first.items.map((entry) => entry.type.key).sort()).toEqual(
      [
        "car_insurance",
        "county_building_approval",
        "nca_contractor_registration",
        "nca_levy",
        "nca_project_registration",
        "nema_licence",
        "osh_workplace_registration",
        "site_signboard",
        "wiba_insurance",
      ].sort(),
    );
    expect(first.counts.missing).toBe(9);
    expect(first.items.every((entry) => entry.type.complianceReview)).toBe(true);
    const car = item(first, "car_insurance");
    const county = item(first, "county_building_approval");
    const levy = item(first, "nca_levy");
    const policy = document(
      await upload(manager, {
        category: "insurance",
        title: "CAR policy (synthetic)",
        revision: "2026",
      }),
      201,
    );
    const expiring = ok(
      await record(manager, {
        typeId: car.type.id,
        kind: "record",
        referenceNo: "CAR/2026/0042",
        issuer: "Jubilee Allianz (synthetic)",
        issuedOn: day(-355),
        expiresOn: day(10),
        evidenceVersionId: policy.current.id,
        supersedesId: null,
      }),
      (body) => complianceHistoryResponseSchema.parse(body),
      201,
    );
    expect(expiring.item).toMatchObject({ status: "expiring", daysLeft: 10, remindFrom: day(-20) });
    const expired = ok(
      await record(manager, {
        typeId: county.type.id,
        kind: "record",
        referenceNo: "NCC/BP/2025/118",
        issuer: "Nairobi City County (synthetic)",
        issuedOn: day(-400),
        expiresOn: day(-1),
        supersedesId: null,
      }),
      (body) => complianceHistoryResponseSchema.parse(body),
      201,
    );
    expect(expired.item).toMatchObject({ status: "expired", daysLeft: -1 });
    ok(
      await record(manager, {
        typeId: levy.type.id,
        kind: "not_applicable",
        reason: "Contract value below the levy threshold (synthetic; COMPLIANCE-REVIEW)",
        supersedesId: null,
      }),
      (body) => complianceHistoryResponseSchema.parse(body),
      201,
    );
    const after = await register();
    expect(after.counts).toMatchObject({ expiring: 1, expired: 1, not_applicable: 1, missing: 6 });
    expect(after.reminders[0]).toMatchObject({
      kind: "compliance_expired",
      type: { key: "county_building_approval" },
      expiresOn: day(-1),
    });
    expect(after.reminders.find((entry) => entry.type?.key === "car_insurance")).toMatchObject({
      kind: "compliance_expiring",
      daysLeft: 10,
      expiresOn: day(10),
    });
    expect(after.reminders.some((entry) => entry.type?.key === "nca_levy")).toBe(false);
    // The project summary and the company-wide list carry the same reminders.
    const summary = ok(await agent.call("get", `${base()}/documents/summary`), (body) =>
      projectDocumentsSummaryResponseSchema.parse(body),
    ).summary;
    expect(summary.compliance).toMatchObject({ expiring: 1, expired: 1 });
    expect(summary.reminders.map((entry) => entry.kind)).toContain("compliance_expiring");
    const overview = ok(await manager.call("get", "documents"), (body) =>
      documentsOverviewResponseSchema.parse(body),
    );
    const mine = overview.reminders.filter((entry) => entry.project?.id === projectId);
    expect(mine.map((entry) => [entry.kind, entry.type?.key])).toEqual(
      expect.arrayContaining([
        ["compliance_expired", "county_building_approval"],
        ["compliance_expiring", "car_insurance"],
      ]),
    );
    // Evidence in a confidential category is restricted for the consultant.
    expect(item(await register(consultant), "car_insurance").current?.evidence).toEqual({
      restricted: true,
    });
    expect(item(await register(manager), "car_insurance").current?.evidence).toMatchObject({
      restricted: false,
      title: "CAR policy (synthetic)",
    });

    // The reminder window boundary through the type's own setting (10 days left).
    await fresh();
    const types = ok(await owner.call("get", "documents/compliance-types"), (body) =>
      complianceTypesResponseSchema.parse(body),
    );
    const carType = types.types.find((entry) => entry.key === "car_insurance")!;
    const nine = ok(
      await owner.call("patch", `documents/compliance-types/${carType.id}`, {
        reminderDays: 9,
        version: carType.version,
      }),
      (body) => complianceTypeResponseSchema.parse(body).type,
    );
    expect(item(await register(), "car_insurance").status).toBe("valid");
    ok(
      await owner.call("patch", `documents/compliance-types/${carType.id}`, {
        reminderDays: 10,
        version: nine.version,
      }),
      (body) => complianceTypeResponseSchema.parse(body).type,
    );
    expect(item(await register(), "car_insurance").status).toBe("expiring");
  });

  it("renews items append-only, checks dates, records company items once and configures types", async () => {
    const current = await register();
    const car = item(current, "car_insurance");
    problem(
      await record(manager, {
        typeId: car.type.id,
        kind: "record",
        expiresOn: day(400),
        supersedesId: null,
      }),
      409,
      "compliance-stale",
    );
    const renewed = ok(
      await record(manager, {
        typeId: car.type.id,
        kind: "record",
        referenceNo: "CAR/2027/0042",
        issuedOn: today,
        expiresOn: day(365),
        supersedesId: car.current!.id,
      }),
      (body) => complianceHistoryResponseSchema.parse(body),
      201,
    );
    expect(renewed.item.status).toBe("valid");
    expect(renewed.records.map((entry) => [entry.referenceNo, entry.state])).toEqual([
      ["CAR/2027/0042", "current"],
      ["CAR/2026/0042", "superseded"],
    ]);
    const osh = item(current, "osh_workplace_registration");
    for (const [body, code] of [
      [{ issuedOn: day(-10) }, "compliance-expiry-required"],
      [{ issuedOn: day(1), expiresOn: day(300) }, "compliance-issued-future"],
      [{ issuedOn: day(-1), expiresOn: day(-2) }, "compliance-expiry-before-issue"],
    ] as const)
      problem(
        await record(manager, { typeId: osh.type.id, kind: "record", supersedesId: null, ...body }),
        422,
        code,
      );
    problem(
      await record(manager, { typeId: osh.type.id, kind: "not_applicable", supersedesId: null }),
      400,
    );
    // Company items are recorded once by config.manage and shown on every project.
    const nca = item(current, "nca_contractor_registration");
    problem(
      await record(
        manager,
        { typeId: nca.type.id, kind: "record", expiresOn: day(200), supersedesId: null },
        null,
      ),
      403,
    );
    problem(
      await record(manager, {
        typeId: nca.type.id,
        kind: "record",
        expiresOn: day(200),
        supersedesId: null,
      }),
      409,
      "invalid-transition",
    );
    ok(
      await record(
        owner,
        {
          typeId: nca.type.id,
          kind: "record",
          referenceNo: "NCA1/12345 (synthetic)",
          issuedOn: day(-100),
          expiresOn: day(200),
          supersedesId: null,
        },
        null,
      ),
      (body) => complianceHistoryResponseSchema.parse(body),
      201,
    );
    for (const project of [projectId, otherProject])
      expect(item(await register(manager, project), "nca_contractor_registration")).toMatchObject({
        status: "valid",
        current: { referenceNo: "NCA1/12345 (synthetic)" },
      });
    // Types: add one, retire it, and a retired type takes no records.
    await fresh();
    problem(
      await manager.call("post", "documents/compliance-types", {
        label: "Fire certificate",
        scope: "project",
        expires: true,
      }),
      403,
    );
    const fire = ok(
      await owner.call("post", "documents/compliance-types", {
        label: "Fire safety certificate (synthetic)",
        scope: "project",
        expires: true,
        reminderDays: 45,
      }),
      (body) => complianceTypeResponseSchema.parse(body).type,
      201,
    );
    expect(fire).toMatchObject({ key: "custom_1", starter: false, complianceReview: false });
    expect(item(await register(), "custom_1").status).toBe("missing");
    ok(
      await owner.call("patch", `documents/compliance-types/${fire.id}`, {
        active: false,
        version: fire.version,
      }),
      (body) => complianceTypeResponseSchema.parse(body),
    );
    expect((await register()).items.some((entry) => entry.type.key === "custom_1")).toBe(false);
    problem(
      await record(manager, {
        typeId: fire.id,
        kind: "record",
        expiresOn: day(100),
        supersedesId: null,
      }),
      409,
      "compliance-type-retired",
    );
    problem(
      await owner.call("patch", `documents/compliance-types/${fire.id}`, {
        label: "x".repeat(5),
        version: 1,
      }),
      409,
      "version-conflict",
    );
  });

  it("exports the register to PDF and Excel in English and Kiswahili, audited", async () => {
    const pdfFile = await agent.download(`${base()}/compliance/export/pdf?locale=en`);
    expect(pdfFile.status).toBe(200);
    expect(pdfFile.headers["content-type"]).toContain("application/pdf");
    expect(pdfFile.headers["content-disposition"]).toMatch(
      /attachment; filename=".*compliance-register.*\.pdf"/,
    );
    expect((pdfFile.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    for (const [locale, title, status] of [
      ["en", "Compliance register", "Expired"],
      ["sw", "Rejista ya utii wa sheria", "Kimeisha muda"],
    ] as const) {
      const file = await manager.download(`${base()}/compliance/export/xlsx?locale=${locale}`);
      expect(file.status).toBe(200);
      const book = XLSX.read(file.body as Buffer, { type: "buffer" });
      const rows = XLSX.utils.sheet_to_json<string[]>(book.Sheets[book.SheetNames[0]!]!, {
        header: 1,
      });
      const text = JSON.stringify(rows);
      expect(text).toContain(title);
      expect(text).toContain(status);
      expect(text).toContain("CAR/2027/0042");
    }
    problem(await client.call("get", `${base()}/compliance/export/pdf`), 403);
    const events = await db.run(context(), (tx) =>
      tx.auditEvent.count({ where: { action: "compliance.exported", resourceId: projectId } }),
    );
    expect(events).toBeGreaterThanOrEqual(3);
  });

  it("logs instructions offline-ready and moves them only through responses", async () => {
    const key = `k-${randomUUID()}`;
    const id = randomUUID();
    const created = ok(
      await instruction(manager, { number: "AI-001" }, key, id),
      (body) => instructionLogResponseSchema.parse(body),
      201,
    );
    expect(created.instruction).toMatchObject({
      id,
      number: "AI-001",
      kind: "architect_instruction",
      status: "received",
      costImplication: true,
      timeImplication: false,
      receivedOn: day(-2),
      permissions: { moves: ["acknowledge", "action", "close"] },
    });
    // A replay returns the original; a changed payload or a reused ID is refused.
    const replay = await instruction(manager, { number: "AI-001" }, key, id);
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    problem(
      await instruction(manager, { number: "AI-001", subject: "Changed (synthetic)" }, key, id),
      409,
      "idempotency-key-reused",
    );
    problem(
      await instruction(manager, { number: "AI-002" }, `k-${randomUUID()}`, id),
      409,
      "instruction-id-conflict",
    );
    problem(await instruction(manager, { number: "AI-001" }), 409, "instruction-number-taken");
    problem(
      await instruction(manager, { number: "AI-003", receivedOn: day(1), issuedOn: day(-1) }),
      422,
      "instruction-date-future",
    );
    problem(
      await instruction(manager, { number: "AI-003", delayId: randomUUID() }),
      422,
      "delay-not-found",
    );
    problem(
      await manager.call("post", `${base()}/instructions`, {
        id: randomUUID(),
        number: "AI-009",
        kind: "other",
        issuerName: "Someone (synthetic)",
        issuerRole: "other",
        issuedOn: today,
        receivedOn: today,
        subject: "Without a key (synthetic)",
      }),
      400,
      "idempotency-key-required",
    );
    // The site agent records a site instruction received on site (site.diary).
    const site = ok(
      await instruction(agent, {
        number: "SI-001",
        kind: "site_instruction",
        issuerRole: "engineer",
        timeImplication: true,
        costImplication: false,
      }),
      (body) => instructionLogResponseSchema.parse(body).instruction,
      201,
    );
    // The D2.3 register sees the same instruction as open; options suggest the next numbers.
    const bqRegister = await surveyor.call("get", `${base()}/bq/instructions`);
    expect(bqRegister.status).toBe(200);
    expect(
      (bqRegister.body as { instructions: { number: string; status: string }[] }).instructions.find(
        (entry) => entry.number === "AI-001",
      )?.status,
    ).toBe("open");
    const options = ok(await manager.call("get", `${base()}/instructions/options`), (body) =>
      instructionOptionsResponseSchema.parse(body),
    );
    expect(options.nextNumbers).toMatchObject({
      architect_instruction: "AI-002",
      site_instruction: "SI-002",
    });

    // received → acknowledged → actioned → closed, with notes; closing needs documents.manage/bq.edit.
    let entry = created.instruction;
    problem(await respond(agent, entry.id, "action", entry.version), 422, "note-required");
    entry = ok(
      await respond(agent, entry.id, "acknowledge", entry.version),
      (body) => instructionLogResponseSchema.parse(body).instruction,
    );
    expect(entry.status).toBe("acknowledged");
    problem(
      await respond(agent, entry.id, "acknowledge", entry.version),
      409,
      "invalid-transition",
    );
    problem(
      await respond(agent, entry.id, "note", entry.version - 1, "Stale"),
      409,
      "version-conflict",
    );
    entry = ok(
      await respond(
        agent,
        entry.id,
        "note",
        entry.version,
        "Called the architect for the detail (synthetic)",
      ),
      (body) => instructionLogResponseSchema.parse(body).instruction,
    );
    entry = ok(
      await respond(
        agent,
        entry.id,
        "action",
        entry.version,
        "Balustrade revised on site (synthetic)",
      ),
      (body) => instructionLogResponseSchema.parse(body).instruction,
    );
    expect(entry.status).toBe("actioned");
    problem(await respond(foreman, entry.id, "close", entry.version), 403);
    entry = ok(
      await respond(manager, entry.id, "close", entry.version),
      (body) => instructionLogResponseSchema.parse(body).instruction,
    );
    expect(entry.status).toBe("closed");
    expect(
      entry.responseList.map((response) => [response.kind, response.fromStatus, response.toStatus]),
    ).toEqual([
      ["acknowledge", "received", "acknowledged"],
      ["note", "acknowledged", "acknowledged"],
      ["action", "acknowledged", "actioned"],
      ["close", "actioned", "closed"],
    ]);
    // A closed instruction is locked until reopened with a reason.
    problem(
      await respond(agent, entry.id, "note", entry.version, "Late note"),
      409,
      "instruction-closed",
    );
    problem(
      await manager.call("patch", `${base()}/instructions/${entry.id}`, {
        subject: "Edited (synthetic)",
        version: entry.version,
      }),
      409,
      "instruction-closed",
    );
    problem(await respond(manager, entry.id, "reopen", entry.version), 422, "note-required");
    entry = ok(
      await respond(
        manager,
        entry.id,
        "reopen",
        entry.version,
        "Balustrade height still wrong (synthetic)",
      ),
      (body) => instructionLogResponseSchema.parse(body).instruction,
    );
    expect(entry.status).toBe("received");
    // Closing straight from received needs a note.
    problem(await respond(manager, site.id, "close", site.version), 422, "note-required");

    // A consultant records an instruction they issue and cannot acknowledge or action it.
    const own = ok(
      await instruction(consultant, { number: "AI-010", issuedByMe: true }),
      (body) => instructionLogResponseSchema.parse(body).instruction,
      201,
    );
    expect(own.issuedBy?.id).toBe(consultant.auth.user.id);
    expect(own.permissions.moves).not.toContain("acknowledge");
    problem(
      await respond(consultant, own.id, "acknowledge", own.version),
      409,
      "instruction-issuer-cannot-respond",
    );
    problem(
      await instruction(manager, { number: "AI-011", issuedByMe: true }),
      422,
      "invalid-transition",
    );
    expect(
      ok(
        await respond(manager, own.id, "acknowledge", own.version),
        (body) => instructionLogResponseSchema.parse(body).instruction,
      ).status,
    ).toBe("acknowledged");

    // A D6.2 delay is linked by its identity; flags and the delay are edited while open.
    await fresh();
    const delay = ok(
      await owner.call("post", `${base()}/schedule/delays`, {
        cause: "client_instruction",
        startDate: day(-6),
        endDate: day(-4),
        workingDaysLost: 1,
        description: "Waiting for the revised balustrade detail (synthetic)",
        activityIds: [],
      }),
      (body) => scheduleDelayResponseSchema.parse(body).delay,
      201,
    );
    const linked = ok(
      await manager.call("patch", `${base()}/instructions/${site.id}`, {
        delayId: delay.id,
        version: site.version,
      }),
      (body) => instructionLogResponseSchema.parse(body).instruction,
    );
    expect(linked.delay).toMatchObject({
      id: delay.id,
      number: delay.number,
      cause: "client_instruction",
    });
    const list = ok(await foreman.call("get", `${base()}/instructions?flag=time`), (body) =>
      instructionLogListResponseSchema.parse(body),
    );
    expect(list.instructions.map((row) => row.number)).toEqual(["SI-001"]);
    expect(list.counts).toMatchObject({ received: 2, acknowledged: 1, time: 1 });
    problem(await client.call("get", `${base()}/instructions/${site.id}`), 403);
  });

  it("attaches document versions and verified site photos to instructions only", async () => {
    const target = ok(
      await instruction(manager, {
        number: "EI-001",
        kind: "engineer_instruction",
        issuerRole: "engineer",
      }),
      (body) => instructionLogResponseSchema.parse(body).instruction,
      201,
    );
    const sketch = await drawing("SK-101");
    const attachTo = (browser: Browser, body: object) =>
      browser.call("post", `${base()}/instructions/${target.id}/attachments`, body);
    const withDocument = ok(
      await attachTo(agent, { documentVersionId: sketch.current.id }),
      (body) => instructionLogResponseSchema.parse(body).instruction,
    );
    expect(withDocument.attachmentList[0]).toMatchObject({
      kind: "document_version",
      document: { versionId: sketch.current.id, revision: "A", state: "current" },
      restricted: false,
    });
    problem(
      await attachTo(agent, { documentVersionId: sketch.current.id }),
      409,
      "attachment-exists",
    );
    const photo = async (content: Buffer) =>
      ok(
        await request(app.getHttpServer())
          .post(`/api/v1/${base()}/photos`)
          .set("Cookie", [...agent.cookies].map(([name, value]) => `${name}=${value}`).join("; "))
          .set("Origin", origin)
          .set("X-CSRF-Token", agent.csrf)
          .field("siteId", siteId)
          .attach("file", content, "site.jpg"),
        (body) => sitePhotoResponseSchema.parse(body).photo,
        201,
      );
    const verified = await photo(
      await jpegWithExif({ ...centre, original: exifNow(), offset: "+03:00", make: "TestCam" }),
    );
    expect(verified.verified).toBe(true);
    const unverified = await photo(await plainJpeg());
    expect(unverified.verified).toBe(false);
    ok(await attachTo(agent, { photoId: verified.id }), (body) =>
      instructionLogResponseSchema.parse(body),
    );
    problem(await attachTo(agent, { photoId: unverified.id }), 422, "photo-not-verified");
    problem(await attachTo(agent, { photoId: randomUUID() }), 422, "attachment-not-found");
    problem(
      await attachTo(agent, { photoId: verified.id, documentVersionId: sketch.current.id }),
      400,
    );
    // The database refuses an unverified photo too.
    await expect(
      sql(
        agent,
        `INSERT INTO instruction_attachments (id, tenant_id, project_id, instruction_id, kind, photo_id, added_by) VALUES (gen_random_uuid(), '${tenantId}', '${projectId}', '${target.id}', 'site_photo', '${unverified.id}', '${agent.auth.user.id}')`,
      ),
    ).rejects.toThrow(/verified general site photos/);
    // A contract attached by the QS is restricted for the site agent.
    const contract = document(
      await upload(surveyor, {
        category: "contract",
        title: "Variation letter (synthetic)",
        revision: "1",
      }),
      201,
    );
    ok(await attachTo(surveyor, { documentVersionId: contract.current.id }), (body) =>
      instructionLogResponseSchema.parse(body),
    );
    problem(
      await attachTo(agent, { documentVersionId: contract.current.id }),
      422,
      "attachment-not-found",
    );
    const seen = ok(
      await agent.call("get", `${base()}/instructions/${target.id}`),
      (body) => instructionLogResponseSchema.parse(body).instruction,
    );
    expect(seen.attachmentList.find((entry) => entry.restricted)).toMatchObject({
      document: null,
      restricted: true,
    });
    expect(JSON.stringify(seen)).not.toContain("Variation letter");
  });

  it("answers approval requests independently, on the file sent, and flags overdue ones", async () => {
    const shop = document(
      await upload(surveyor, {
        category: "submittal",
        title: "Steel staircase shop drawing (synthetic)",
        revision: "1",
        issuePurpose: "for_approval",
      }),
      201,
    );
    const raise = (browser: Browser, body: object) =>
      browser.call("post", `${base()}/approvals`, {
        kind: "shop_drawing",
        title: "Staircase shop drawing (synthetic)",
        documentVersionId: shop.current.id,
        addressedTo: "Arch. Wanjiru Kamau, Kamau Associates (synthetic)",
        sentOn: day(-10),
        dueOn: day(-3),
        ...body,
      });
    const approval = (res: request.Response, status = 200) =>
      ok(res, (body) => approvalResponseSchema.parse(body).approval, status);
    const first = approval(await raise(manager, {}), 201);
    expect(first).toMatchObject({
      code: "APR-0001",
      status: "pending",
      overdue: true,
      daysOverdue: 3,
    });
    expect(first.document).toMatchObject({
      restricted: false,
      versionId: shop.current.id,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // The overdue request appears in the summary and the company-wide list.
    const summary = ok(await manager.call("get", `${base()}/documents/summary`), (body) =>
      projectDocumentsSummaryResponseSchema.parse(body),
    ).summary;
    expect(summary.approvals).toMatchObject({ pending: 1, overdue: 1 });
    const overview = ok(await finance.call("get", "documents"), (body) =>
      documentsOverviewResponseSchema.parse(body),
    );
    expect(overview.reminders.find((entry) => entry.kind === "approval_overdue")).toMatchObject({
      approval: { code: "APR-0001" },
      dueOn: day(-3),
      daysLeft: -3,
    });
    const answer = (browser: Browser, target: typeof first, body: object) =>
      browser.call("post", `${base()}/approvals/${target.id}/response`, {
        decision: "approved_with_comments",
        comments: "Add a handrail bracket every 1.2 m (synthetic)",
        respondedOn: today,
        channel: "in_app",
        documentSha256: target.document.restricted ? "" : target.document.sha256,
        version: target.version,
        ...body,
      });
    // Never the raiser, never the uploader; always on the file sent.
    problem(await answer(manager, first, {}), 403, "approval-raiser-cannot-respond");
    problem(await answer(surveyor, first, {}), 403, "approval-uploader-cannot-respond");
    problem(
      await answer(consultant, first, { documentSha256: "0".repeat(64) }),
      409,
      "approval-digest-mismatch",
    );
    problem(
      await answer(consultant, first, { respondedOn: day(-11) }),
      422,
      "approval-date-invalid",
    );
    problem(await answer(consultant, first, { decision: "rejected", comments: undefined }), 400);
    const decided = approval(await answer(consultant, first, {}));
    expect(decided).toMatchObject({
      status: "approved_with_comments",
      overdue: false,
      response: { channel: "in_app", responder: { id: consultant.auth.user.id } },
    });
    problem(await answer(consultant, decided, {}), 409, "approval-not-pending");
    // The version's approval is shown with the document.
    expect(
      document(await manager.call("get", `${base()}/documents/${shop.id}`)).current.approval,
    ).toMatchObject({
      code: "APR-0001",
      status: "approved_with_comments",
    });

    // A paper response from an external consultant: anyone with documents.manage, with the scan.
    const second = approval(
      await raise(manager, {
        title: "Balustrade sample (synthetic)",
        kind: "material_sample",
        dueOn: day(5),
      }),
      201,
    );
    expect(second).toMatchObject({ code: "APR-0002", overdue: false });
    const scan = document(
      await upload(manager, {
        category: "correspondence",
        title: "Signed response APR-0002 (synthetic)",
        revision: "1",
      }),
      201,
    );
    problem(
      await answer(manager, second, { channel: "paper", responderName: "Arch. Kamau (synthetic)" }),
      400,
    );
    problem(
      await answer(manager, second, {
        channel: "paper",
        responderName: "Arch. Kamau (synthetic)",
        evidenceVersionId: shop.current.id,
      }),
      422,
      "approval-evidence-invalid",
    );
    const paper = approval(
      await answer(manager, second, {
        channel: "paper",
        decision: "resubmit",
        comments: "Use galvanised steel (synthetic)",
        responderName: "Arch. Wanjiru Kamau (synthetic)",
        responderFirm: "Kamau Associates (synthetic)",
        evidenceVersionId: scan.current.id,
      }),
    );
    expect(paper).toMatchObject({
      status: "resubmit",
      response: {
        channel: "paper",
        responder: null,
        responderName: "Arch. Wanjiru Kamau (synthetic)",
        recordedBy: { id: manager.auth.user.id },
      },
      permissions: { canResubmit: true },
    });
    // A resubmission needs the current version of an active document, once.
    const revised = document(
      await newVersion(
        surveyor,
        document(await manager.call("get", `${base()}/documents/${shop.id}`)),
        "2",
      ),
      201,
    );
    problem(
      await raise(manager, { resubmissionOfId: second.id }),
      409,
      "approval-document-not-current",
    );
    const third = approval(
      await raise(manager, {
        resubmissionOfId: second.id,
        documentVersionId: revised.current.id,
        sentOn: today,
        dueOn: day(7),
      }),
      201,
    );
    expect(third).toMatchObject({ code: "APR-0003", resubmissionOf: { code: "APR-0002" } });
    problem(
      await raise(manager, {
        resubmissionOfId: second.id,
        documentVersionId: revised.current.id,
        sentOn: today,
        dueOn: day(7),
      }),
      409,
      "approval-resubmission-invalid",
    );
    problem(
      await raise(manager, {
        resubmissionOfId: first.id,
        documentVersionId: revised.current.id,
        sentOn: today,
        dueOn: day(7),
      }),
      409,
      "approval-resubmission-invalid",
    );
    // Cancel: the raiser only, while pending.
    problem(
      await consultant.call("post", `${base()}/approvals/${third.id}/cancel`, {
        reason: "Not mine",
        version: third.version,
      }),
      403,
    );
    const cancelled = approval(
      await manager.call("post", `${base()}/approvals/${third.id}/cancel`, {
        reason: "Sent the wrong sheet (synthetic)",
        version: third.version,
      }),
    );
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancellation: { by: { id: manager.auth.user.id } },
    });
    problem(
      await answer(consultant, cancelled, { documentSha256: revised.versions[0]!.sha256 }),
      409,
      "approval-not-pending",
    );
    const list = ok(await agent.call("get", `${base()}/approvals?status=decided`), (body) =>
      approvalListResponseSchema.parse(body),
    );
    expect(list.approvals.map((row) => row.code).sort()).toEqual(["APR-0001", "APR-0002"]);
    expect(list.counts).toMatchObject({ pending: 0, decided: 2, cancelled: 1 });
  });

  it("records a paper response only with a new scan: another document, uploaded after the request, used once", async () => {
    const approval = (res: request.Response, status = 200) =>
      ok(res, (body) => approvalResponseSchema.parse(body).approval, status);
    const sample = document(
      await upload(surveyor, {
        category: "submittal",
        title: "Tile sample board (synthetic)",
        revision: "1",
        issuePurpose: "for_approval",
      }),
      201,
    );
    const older = document(
      await upload(manager, {
        category: "correspondence",
        title: "Earlier letter from the architect (synthetic)",
        revision: "1",
      }),
      201,
    );
    const raise = (versionId: string, title: string) =>
      manager.call("post", `${base()}/approvals`, {
        kind: "material_sample",
        title,
        documentVersionId: versionId,
        addressedTo: "Arch. Wanjiru Kamau (synthetic)",
        sentOn: day(-2),
        dueOn: day(5),
      });
    const first = approval(await raise(sample.current.id, "Tile sample (synthetic)"), 201);
    const paper = (target: typeof first, evidenceVersionId: string) =>
      manager.call("post", `${base()}/approvals/${target.id}/response`, {
        decision: "approved",
        respondedOn: today,
        channel: "paper",
        responderName: "Arch. Wanjiru Kamau (synthetic)",
        documentSha256: target.document.restricted ? "" : target.document.sha256,
        version: target.version,
        evidenceVersionId,
      });
    // A file uploaded before the request was raised is not the consultant's answer to it …
    problem(await paper(first, older.current.id), 422, "approval-evidence-invalid");
    // … nor is a revision of the document under review, even one uploaded afterwards.
    const revised = document(await newVersion(surveyor, sample, "2"), 201);
    problem(await paper(first, revised.current.id), 422, "approval-evidence-invalid");
    const second = approval(
      await raise(revised.current.id, "Tile sample, revision 2 (synthetic)"),
      201,
    );
    const scan = document(
      await upload(manager, {
        category: "correspondence",
        title: "Signed response to the tile sample, scan (synthetic)",
        revision: "1",
      }),
      201,
    );
    expect(approval(await paper(first, scan.current.id)).status).toBe("approved");
    // One scan answers one request.
    problem(await paper(second, scan.current.id), 422, "approval-evidence-invalid");
    // The database repeats the rules under the runtime role.
    const insert = (evidenceVersionId: string) =>
      sql(
        manager,
        `INSERT INTO approval_responses (id, tenant_id, project_id, request_id, decision, responded_on, channel, responder_name, evidence_version_id, reviewed_sha256, recorded_by)
         VALUES (gen_random_uuid(), '${tenantId}', '${projectId}', '${second.id}', 'approved', '${today}', 'paper', 'Arch. Wanjiru Kamau (synthetic)', '${evidenceVersionId}', '${second.document.restricted ? "" : second.document.sha256}', '${manager.auth.user.id}')`,
      );
    await expect(insert(older.current.id)).rejects.toThrow(/new scan of the signed response/);
    await expect(insert(sample.current.id)).rejects.toThrow(/new scan of the signed response/);
    await expect(insert(scan.current.id)).rejects.toThrow(/approval_responses_one_per_evidence/);
  });

  it("withdraws documents with a reason, finally, and keeps closed projects read-only", async () => {
    const draft = await drawing("A-901");
    problem(
      await manager.call("post", `${base()}/documents/${draft.id}/withdraw`, {
        reason: "No",
        version: draft.version,
      }),
      400,
    );
    const withdrawn = document(
      await manager.call("post", `${base()}/documents/${draft.id}/withdraw`, {
        reason: "Drawing cancelled by the architect (synthetic)",
        version: draft.version,
      }),
    );
    expect(withdrawn).toMatchObject({
      status: "withdrawn",
      withdrawal: { reason: "Drawing cancelled by the architect (synthetic)" },
      permissions: { canUpload: false },
    });
    problem(await newVersion(manager, withdrawn, "B"), 409, "document-withdrawn");
    problem(
      await manager.call("patch", `${base()}/documents/${draft.id}`, {
        title: "Renamed",
        version: withdrawn.version,
      }),
      409,
      "document-withdrawn",
    );
    expect(
      (
        await manager.download(
          `${base()}/documents/${draft.id}/versions/${draft.current.id}/content`,
        )
      ).status,
    ).toBe(200);
    const register = ok(await manager.call("get", `${base()}/documents/drawings`), (body) =>
      drawingRegisterResponseSchema.parse(body),
    );
    expect(register.drawings.map((entry) => entry.drawingNumber)).not.toContain("A-901");
    // A cancelled project is readable but every change is refused (API and database).
    const kept = await drawing("A-001", "A");
    const onClosed = document(
      await upload(
        manager,
        { category: "other", title: "Before cancelling (synthetic)", revision: "1" },
        pdf("closed"),
        "c.pdf",
        closedProject,
      ),
      201,
    );
    await fresh();
    const project = projectDetailResponseSchema.parse(
      (await owner.call("get", `projects/${closedProject}`)).body,
    ).project;
    expect(
      (
        await owner.call("post", `projects/${closedProject}/status`, {
          to: "cancelled",
          version: project.version,
          reason: "Client withdrew (synthetic)",
        })
      ).status,
    ).toBe(200);
    problem(
      await upload(
        manager,
        { category: "other", title: "After cancelling", revision: "1" },
        pdf("after"),
        "a.pdf",
        closedProject,
      ),
      409,
      "project-read-only",
    );
    problem(await newVersion(manager, onClosed, "2"), 409, "project-read-only");
    problem(
      await manager.call(
        "post",
        `${base(closedProject)}/instructions`,
        {
          id: randomUUID(),
          number: "X-1",
          kind: "other",
          issuerName: "Someone (synthetic)",
          issuerRole: "other",
          issuedOn: today,
          receivedOn: today,
          subject: "On a cancelled project",
        },
        true,
        { "Idempotency-Key": `k-${randomUUID()}` },
      ),
      409,
      "project-read-only",
    );
    expect(
      document(await manager.call("get", `${base(closedProject)}/documents/${onClosed.id}`))
        .permissions,
    ).toMatchObject({ canUpload: false, canEdit: false });
    await expect(
      sql(
        manager,
        `UPDATE documents SET title = 'Sneaky edit', version = version + 1, updated_by = '${manager.auth.user.id}' WHERE id = '${onClosed.id}'`,
      ),
    ).rejects.toThrow(/read-only/);
    expect(kept.status).toBe("active");
  });

  it("refuses every document rule in SQL under the runtime role", async () => {
    const doc = await drawing("Q-101");
    const userId = manager.auth.user.id;
    // No deletes, no rewrites, no identity changes, nothing after withdrawal.
    await expect(sql(manager, `DELETE FROM documents WHERE id = '${doc.id}'`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      sql(manager, `DELETE FROM document_versions WHERE document_id = '${doc.id}'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      sql(
        manager,
        `UPDATE documents SET category = 'contract', drawing_number = NULL, discipline = NULL, version = version + 1, updated_by = '${userId}' WHERE id = '${doc.id}'`,
      ),
    ).rejects.toThrow(/project and category/);
    await expect(
      sql(
        manager,
        `UPDATE document_versions SET sha256 = repeat('b', 64) WHERE id = '${doc.current.id}'`,
      ),
    ).rejects.toThrow(/never changes/);
    // A document without a version is refused at commit.
    await expect(
      sql(
        manager,
        `INSERT INTO documents (id, tenant_id, project_id, category, title, created_by, updated_by) VALUES (gen_random_uuid(), '${tenantId}', '${projectId}', 'other', 'Empty document', '${userId}', '${userId}')`,
      ),
    ).rejects.toThrow(/first version/);
    // Uploads by someone else's name are refused.
    await expect(
      sql(
        manager,
        `INSERT INTO document_versions (id, tenant_id, project_id, document_id, version_no, revision, change_note, file_name, content_type, size_bytes, sha256, object_key, scan_status, scan_engine, scanned_at, uploaded_by)
         SELECT v, '${tenantId}', '${projectId}', '${doc.id}', 2, 'B', 'Forged', 'x.pdf', 'application/pdf', 10, repeat('c', 64),
           'tenants/${tenantId}/projects/${projectId}/documents/${doc.id}/' || v, 'clean', 'test', now(), '${surveyor.auth.user.id}'
         FROM gen_random_uuid() AS v`,
      ),
    ).rejects.toThrow(/signed-in user/);
    // Compliance records: append-only, superseding exactly the current record.
    const car = item(await register(), "car_insurance");
    await expect(
      sql(
        manager,
        `UPDATE compliance_records SET reference_no = 'X' WHERE id = '${car.current!.id}'`,
      ),
    ).rejects.toThrow(/never changes/);
    await expect(
      sql(manager, `DELETE FROM compliance_records WHERE id = '${car.current!.id}'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      sql(
        manager,
        `INSERT INTO compliance_records (id, tenant_id, type_id, project_id, kind, expires_on, recorded_by) VALUES (gen_random_uuid(), '${tenantId}', '${car.type.id}', '${projectId}', 'record', '${day(50)}', '${userId}')`,
      ),
    ).rejects.toThrow(/supersedes exactly the current record/);
    await expect(
      sql(
        manager,
        `UPDATE compliance_records SET is_current = false, superseded_at = now() WHERE id = '${car.current!.id}'`,
      ),
    ).rejects.toThrow(/one current record/);
    const company = item(await register(), "wiba_insurance");
    await expect(
      sql(
        manager,
        `INSERT INTO compliance_records (id, tenant_id, type_id, project_id, kind, expires_on, recorded_by) VALUES (gen_random_uuid(), '${tenantId}', '${company.type.id}', '${projectId}', 'record', '${day(50)}', '${userId}')`,
      ),
    ).rejects.toThrow(/company items on none/);
    // Instructions: the status moves only with a response; responses are append-only.
    const open = ok(
      await instruction(manager, { number: "AI-500" }),
      (body) => instructionLogResponseSchema.parse(body).instruction,
      201,
    );
    await expect(
      sql(
        manager,
        `UPDATE instructions SET status = 'closed', version = version + 1, updated_by = '${userId}' WHERE id = '${open.id}'`,
      ),
    ).rejects.toThrow(/latest response/);
    await expect(
      sql(
        manager,
        `INSERT INTO instruction_responses (id, tenant_id, instruction_id, kind, from_status, to_status, recorded_by) VALUES (gen_random_uuid(), '${tenantId}', '${open.id}', 'acknowledge', 'acknowledged', 'actioned', '${userId}')`,
      ),
    ).rejects.toThrow(/starts from the instruction/);
    await expect(
      sql(
        manager,
        `INSERT INTO instruction_responses (id, tenant_id, instruction_id, kind, from_status, to_status, recorded_by) VALUES (gen_random_uuid(), '${tenantId}', '${open.id}', 'acknowledge', 'received', 'acknowledged', '${userId}')`,
      ),
    ).rejects.toThrow(/latest response/);
    const responded = ok(
      await respond(manager, open.id, "close", open.version, "Superseded by AI-501 (synthetic)"),
      (body) => instructionLogResponseSchema.parse(body).instruction,
    );
    await expect(
      sql(
        manager,
        `UPDATE instruction_responses SET body = 'x' WHERE instruction_id = '${open.id}'`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      sql(
        manager,
        `UPDATE instructions SET subject = 'Edited while closed', version = version + 1, updated_by = '${userId}' WHERE id = '${responded.id}'`,
      ),
    ).rejects.toThrow(/locked/);
    await expect(sql(manager, `DELETE FROM instructions WHERE id = '${open.id}'`)).rejects.toThrow(
      /permission denied/,
    );
    // D2.3's "open" is no longer a stored status (the log's four statuses only).
    await expect(
      sql(
        manager,
        `UPDATE instructions SET status = 'open', version = version + 1, updated_by = '${userId}' WHERE id = '${open.id}'`,
      ),
    ).rejects.toThrow(/cannot move from closed to open/);
    // Approval requests: numbered in order, decided only by a response, independent responders.
    const shop = document(
      await upload(surveyor, {
        category: "submittal",
        title: "Formwork method statement (synthetic)",
        revision: "1",
      }),
      201,
    );
    const pending = ok(
      await manager.call("post", `${base()}/approvals`, {
        kind: "method_statement",
        title: "Formwork method statement (synthetic)",
        documentVersionId: shop.current.id,
        addressedTo: "Eng. Otieno (synthetic)",
        sentOn: today,
        dueOn: day(14),
      }),
      (body) => approvalResponseSchema.parse(body).approval,
      201,
    );
    await expect(
      sql(
        manager,
        `UPDATE approval_requests SET status = 'approved', version = version + 1 WHERE id = '${pending.id}'`,
      ),
    ).rejects.toThrow(/only by its response/);
    await expect(
      sql(
        manager,
        `INSERT INTO approval_requests (id, tenant_id, project_id, number, kind, title, document_version_id, addressed_to, sent_on, due_on, raised_by) VALUES (gen_random_uuid(), '${tenantId}', '${projectId}', 99, 'other', 'Out of order', '${shop.current.id}', 'Someone', '${today}', '${today}', '${userId}')`,
      ),
    ).rejects.toThrow(/numbered in order/);
    const sha = pending.document.restricted ? "" : pending.document.sha256;
    await expect(
      sql(
        manager,
        `INSERT INTO approval_responses (id, tenant_id, project_id, request_id, decision, responded_on, channel, responder_user_id, responder_name, reviewed_sha256, recorded_by) VALUES (gen_random_uuid(), '${tenantId}', '${projectId}', '${pending.id}', 'approved', '${today}', 'in_app', '${userId}', 'Me', '${sha}', '${userId}')`,
      ),
    ).rejects.toThrow(/neither raised it nor uploaded/);
    await expect(
      sql(
        consultant,
        `INSERT INTO approval_responses (id, tenant_id, project_id, request_id, decision, responded_on, channel, responder_user_id, responder_name, reviewed_sha256, recorded_by) VALUES (gen_random_uuid(), '${tenantId}', '${projectId}', '${pending.id}', 'approved', '${today}', 'in_app', '${consultant.auth.user.id}', 'Consultant', repeat('0', 64), '${consultant.auth.user.id}')`,
      ),
    ).rejects.toThrow(/file sent/);
    await expect(
      sql(manager, `DELETE FROM approval_requests WHERE id = '${pending.id}'`),
    ).rejects.toThrow(/permission denied/);
    // The schema owner meets the same append-only triggers.
    await expect(
      ownerSql(`DELETE FROM document_versions WHERE document_id = '${doc.id}'`),
    ).rejects.toThrow(/never deleted/);
    await expect(
      ownerSql(`DELETE FROM instruction_responses WHERE instruction_id = '${open.id}'`),
    ).rejects.toThrow(/append-only/);
  });

  it("answers a database refusal the API did not catch first with a problem, never a 500", async () => {
    const doc = await drawing("P-101");
    const schemaOwner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrls().migrationUrl }),
    });
    const rename = (title: string, version: number) =>
      manager.call("patch", `${base()}/documents/${doc.id}`, { title, version });
    try {
      await schemaOwner.$executeRawUnsafe(`CREATE FUNCTION app.test_documents_refusal_probe()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.title = 'Probe check refusal' THEN
            RAISE EXCEPTION 'probe check refusal' USING ERRCODE = '23514';
          ELSIF NEW.title = 'Probe privilege refusal' THEN
            RAISE EXCEPTION 'probe privilege refusal' USING ERRCODE = '42501';
          END IF;
          RETURN NEW;
        END $$`);
      await schemaOwner.$executeRawUnsafe(
        `CREATE TRIGGER documents_refusal_probe BEFORE UPDATE ON documents
           FOR EACH ROW EXECUTE FUNCTION app.test_documents_refusal_probe()`,
      );
      const check = await rename("Probe check refusal", doc.version);
      problem(check, 409, "documents-rule");
      expect(JSON.stringify(check.body)).not.toContain("probe check refusal");
      const privilege = await rename("Probe privilege refusal", doc.version);
      problem(privilege, 403, "documents-rule");
      expect(JSON.stringify(privilege.body)).not.toContain("probe privilege refusal");
    } finally {
      await schemaOwner.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS documents_refusal_probe ON documents",
      );
      await schemaOwner.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS app.test_documents_refusal_probe()",
      );
      await schemaOwner.$disconnect();
    }
    expect(
      document(await rename("Ground floor plan P-101 rev (synthetic)", doc.version)).version,
    ).toBe(doc.version + 1);
  });

  it("keeps the BQ register working on the same instructions", async () => {
    // D2.3: closing in the BQ register closes the log's instruction through a response.
    const created = await surveyor.call("post", `${base()}/bq/instructions`, {
      number: "AI-700",
      issuedOn: day(-1),
      issuerName: "Arch. Wanjiru Kamau (synthetic)",
      issuerRole: "architect",
      subject: "Window schedule revised (synthetic)",
    });
    const bq = ok(created, (body) => instructionResponseSchema.parse(body).instruction, 201);
    expect(bq.status).toBe("open");
    const logged = ok(
      await manager.call("get", `${base()}/instructions/${bq.id}`),
      (body) => instructionLogResponseSchema.parse(body).instruction,
    );
    expect(logged).toMatchObject({
      kind: "architect_instruction",
      status: "received",
      receivedOn: day(-1),
    });
    // The register's edit dialog always sends every field with the status and version.
    const dialog = (row: Instruction, extra: Record<string, unknown>) => ({
      number: row.number,
      issuedOn: row.issuedOn,
      issuerName: row.issuerName,
      issuerRole: row.issuerRole,
      subject: row.subject,
      description: row.description ?? "",
      attachments: row.attachments,
      status: row.status,
      version: row.version,
      ...extra,
    });
    const save = async (row: Instruction, extra: Record<string, unknown>, status = 200) =>
      ok(
        await surveyor.call("patch", `${base()}/bq/instructions/${row.id}`, dialog(row, extra)),
        (body) => instructionResponseSchema.parse(body).instruction,
        status,
      );
    const closed = await save(bq, { status: "closed" });
    expect(closed.status).toBe("closed");
    const after = ok(
      await manager.call("get", `${base()}/instructions/${bq.id}`),
      (body) => instructionLogResponseSchema.parse(body).instruction,
    );
    expect(after.status).toBe("closed");
    expect(after.responseList.at(-1)).toMatchObject({
      kind: "close",
      fromStatus: "received",
      toStatus: "closed",
    });
    // Saving a closed instruction unchanged changes nothing (no 500 from the database's lock).
    expect(await save(closed, {})).toMatchObject({ status: "closed", version: closed.version });
    problem(
      await surveyor.call(
        "patch",
        `${base()}/bq/instructions/${bq.id}`,
        dialog(closed, { subject: "Edited while closed" }),
      ),
      409,
      "instruction-closed",
    );
    // Reopening from the dialog (every field sent, none changed) works …
    const reopened = await save(closed, { status: "open" });
    expect(reopened.status).toBe("open");
    // … and so does reopening with an edit in the same save: the reopen, then the edit.
    const closedAgain = await save(reopened, { status: "closed" });
    const edited = await save(closedAgain, {
      status: "open",
      subject: "Window schedule revised again (synthetic)",
    });
    expect(edited).toMatchObject({
      status: "open",
      subject: "Window schedule revised again (synthetic)",
      version: closedAgain.version + 2,
    });
    // A D2.3 instruction dated in the future (D2.3 did not refuse it; the backfill copied the date
    // into the date received) can still be answered, closed and corrected.
    const legacy = ok(
      await surveyor.call("post", `${base()}/bq/instructions`, {
        number: "AI-702",
        issuedOn: day(-1),
        issuerName: "Arch. Wanjiru Kamau (synthetic)",
        issuerRole: "architect",
        subject: "Dated ahead before the log (synthetic)",
      }),
      (body) => instructionResponseSchema.parse(body).instruction,
      201,
    );
    await ownerSql([
      "ALTER TABLE instructions DISABLE TRIGGER instruction_guard",
      `UPDATE instructions SET issued_on = '${day(5)}', received_on = '${day(5)}' WHERE id = '${legacy.id}'`,
      // Runs the commit-time checks now, so the guard can be enabled again in this transaction.
      "SET CONSTRAINTS ALL IMMEDIATE",
      "ALTER TABLE instructions ENABLE TRIGGER instruction_guard",
    ]);
    const future = ok(
      await manager.call("get", `${base()}/instructions/${legacy.id}`),
      (body) => instructionLogResponseSchema.parse(body).instruction,
    );
    ok(await respond(manager, legacy.id, "acknowledge", future.version), () => null);
    const ahead = ok(
      await surveyor.call("get", `${base()}/bq/instructions/${legacy.id}`),
      (body) => instructionResponseSchema.parse(body).instruction,
    );
    expect(ahead.issuedOn).toBe(day(5));
    const corrected = await save(ahead, { issuedOn: day(-2) });
    expect(corrected.issuedOn).toBe(day(-2));
    expect(
      ok(
        await manager.call("get", `${base()}/instructions/${legacy.id}`),
        (body) => instructionLogResponseSchema.parse(body).instruction,
      ).receivedOn,
    ).toBe(day(-2));
    expect((await save(corrected, { status: "closed" })).status).toBe("closed");
    problem(
      await surveyor.call("post", `${base()}/bq/instructions`, {
        number: "AI-701",
        issuedOn: day(2),
        issuerName: "Arch. Wanjiru Kamau (synthetic)",
        issuerRole: "architect",
        subject: "Future (synthetic)",
      }),
      422,
    );
  });

  it("audits downloads and writes events with IDs and codes only", async () => {
    const events = await db.run(context(), (tx) =>
      tx.auditEvent.findMany({
        where: {
          OR: [
            { action: { startsWith: "document." } },
            { action: { startsWith: "compliance." } },
            { action: { startsWith: "instruction." } },
            { action: { startsWith: "approval." } },
          ],
        },
        select: { action: true, metadata: true },
      }),
    );
    for (const name of [
      "document.created",
      "document.version_added",
      "document.updated",
      "document.withdrawn",
      "document.downloaded",
      "compliance.recorded",
      "compliance.type_created",
      "compliance.type_updated",
      "compliance.exported",
      "instruction.recorded",
      "instruction.updated",
      "instruction.responded",
      "instruction.attachment_added",
      "approval.raised",
      "approval.responded",
      "approval.cancelled",
    ])
      expect(
        events.map((event) => event.action),
        name,
      ).toContain(name);
    expect(
      events
        .filter((event) => event.action === "document.downloaded")
        .map((event) => (event.metadata as { state: string }).state),
    ).toEqual(expect.arrayContaining(["current", "superseded"]));
    const serialised = JSON.stringify(events);
    for (const text of [
      "contract sum KES 48,250,000",
      "CAR/2026/0042",
      "Jubilee Allianz",
      "Contract value below the levy threshold",
      "Revise the staircase balustrade",
      "Called the architect",
      "Add a handrail bracket",
      "Sent the wrong sheet",
      "Drawing cancelled by the architect",
      "Kamau Associates",
    ])
      expect(serialised, text).not.toContain(text);
  });
});
