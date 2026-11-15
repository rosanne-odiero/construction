import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  addCalendarDays,
  addCalendarMonths,
  dpiaApprovalContent,
  nairobiDate,
} from "@pm-buddy/domain";
import { DPIA_GO_LIVE_CONDITIONS } from "@pm-buddy/types";
import {
  auditEventsResponseSchema,
  biometricSwitchResponseSchema,
  biometricsOverviewResponseSchema,
  dpiaResponseSchema,
  projectDetailResponseSchema,
  projectResponseSchema,
  roleResponseSchema,
  siteResponseSchema,
  tenantCreatedResponseSchema,
  type BiometricsOverviewResponse,
  type DpiaDetail,
} from "@pm-buddy/validation";
import { PrismaPg } from "@prisma/adapter-pg";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { canonicalJson, sha256 } from "../src/modules/attendance/attendance-support.js";
import { BiometricsPlatform } from "../src/modules/biometrics/biometrics-support.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { Browser, notifications } from "./support.js";
import { testDatabaseUrls } from "./test-database.js";

/** A small valid PDF; the label keeps every file's SHA-256 distinct. */
const pdf = (label: string, extra = "") =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n${extra}% ${label} ${randomUUID()}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
  );
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const centre = { lat: -1.1489, lng: 36.9612 };
const today = nairobiDate();
const DPO_NAME = "Achieng Otieno (synthetic DPO)";
const DPO_NOTE = "Quarterly accuracy review by demographic group";
const WITHDRAW_REASON = "Vendor SDK found sending telemetry (synthetic)";

/**
 * D3.4 DPIA gate against the real database as the runtime role (pmb_app, forced RLS): biometric
 * capture stays off until the company's DPIA is approved in the app (signed PDF, DPO opinion,
 * controller decision, every go-live condition, review date) by a biometrics.approve holder with a
 * fresh step-up, and then only per site and method switched on under it. A lapsed or withdrawn DPIA
 * stops capture at once; a renewal keeps covered switches on. Every rule is checked again by the
 * database, including on biometric attendance records. Synthetic data only.
 */
describe("Biometric attendance DPIA gate (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let notificationSpy: ReturnType<typeof vi.spyOn>;
  let owner: Browser;
  let dpo: Browser;
  let manager: Browser;
  let outsider: Browser;
  let tenantId: string;
  let otherTenant: string;
  const projects: Record<"main" | "second" | "cancelled", string> = {
    main: "",
    second: "",
    cancelled: "",
  };
  const sites: Record<"main" | "second" | "cancelled" | "foreign", string> = {
    main: "",
    second: "",
    cancelled: "",
    foreign: "",
  };

  const ok = <T>(res: request.Response, parse: (body: unknown) => T, status = 200): T => {
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
  const stale = (browser = owner) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 10 * 60_000) },
    });
  const context = (browser: Browser, tenant = tenantId) => ({
    userId: browser.auth.user.id,
    tenantId: tenant,
    requestId: randomUUID(),
  });
  const sql = (browser: Browser, statement: string, tenant = tenantId) =>
    db.run(context(browser, tenant), (tx) => tx.$executeRawUnsafe(statement));
  const query = <T>(browser: Browser, statement: string, tenant = tenantId) =>
    db.run(context(browser, tenant), (tx) => tx.$queryRawUnsafe<T[]>(statement));
  /** Statements in one transaction as the schema owner (who meets the same triggers and RLS). */
  const ownerSql = async (statements: string[], user = owner) => {
    const schemaOwner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrls().migrationUrl }),
    });
    try {
      await schemaOwner.$transaction([
        schemaOwner.$executeRawUnsafe(
          `SELECT set_config('app.tenant_id', '${tenantId}', true), set_config('app.user_id', '${user.auth.user.id}', true)`,
        ),
        ...statements.map((statement) => schemaOwner.$executeRawUnsafe(statement)),
      ]);
    } finally {
      await schemaOwner.$disconnect();
    }
  };
  const allowed = async (site: string, method: string, on = today) =>
    (
      await query<{ allowed: boolean }>(
        owner,
        `SELECT app.biometric_capture_allowed('${tenantId}', '${site}', '${method}', '${on}') AS allowed`,
      )
    )[0]!.allowed;
  const overview = async (browser = owner): Promise<BiometricsOverviewResponse> =>
    ok(await browser.call("get", "biometrics"), (body) =>
      biometricsOverviewResponseSchema.parse(body),
    );
  const gate = (view: BiometricsOverviewResponse, site: string, method: string) =>
    view.sites.find((entry) => entry.id === site)!.methods.find((m) => m.method === method)!;
  const dpia = (res: request.Response, status = 200): DpiaDetail =>
    ok(res, (body) => dpiaResponseSchema.parse(body).dpia, status);
  const draftBody = (siteIds: string[], methods: string[] = ["face"]) => ({
    methods,
    siteIds,
    dpoName: DPO_NAME,
    dpoOpinion: "approve_with_conditions",
    dpoOpinionOn: addCalendarDays(today, -3),
    dpoNote: DPO_NOTE,
    controllerName: "Wanjiru Kamau",
    controllerRole: "Director",
    controllerDecision: "proceed",
    controllerDecisionOn: addCalendarDays(today, -1),
    controllerNote: null,
    residualRisk: "medium",
    odpcReference: null,
  });
  const approve = (record: DpiaDetail, reviewDue = addCalendarDays(today, 180)) =>
    owner.call("post", `biometrics/dpias/${record.id}/approve`, {
      version: record.version,
      documentSha256: record.document!.sha256,
      reviewDue,
      confirmations: [...DPIA_GO_LIVE_CONDITIONS],
    });
  /** A complete draft with its signed PDF, ready to approve. */
  const prepared = async (siteIds: string[], methods: string[] = ["face"]) => {
    const draft = dpia(
      await owner.call("post", "biometrics/dpias", draftBody(siteIds, methods)),
      201,
    );
    return dpia(
      await owner.upload(`biometrics/dpias/${draft.id}/document`, pdf("signed"), "DPIA.pdf"),
    );
  };
  const switchTo = (browser: Browser, site: string, method: string, enabled: boolean) =>
    browser.call("put", `biometrics/sites/${site}/methods/${method}`, { enabled });
  const biometricRecord = (site: string, project: string, method = "face", workDate = today) =>
    sql(
      owner,
      `INSERT INTO attendance_records (id, tenant_id, day_id, project_id, site_id, work_date,
         labourer_id, status, check_in_minutes, check_out_minutes, capture_method,
         match_confidence, created_by, updated_by)
       VALUES (gen_random_uuid(), '${tenantId}', gen_random_uuid(), '${project}', '${site}',
         '${workDate}', gen_random_uuid(), 'present', 420, 1020, '${method}', 0.98,
         '${owner.auth.user.id}', '${owner.auth.user.id}')`,
    );

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
    dpo = new Browser(app);
    manager = new Browser(app);
    outsider = new Browser(app);
    for (const browser of [owner, dpo, manager, outsider]) await browser.register();
    for (const browser of [owner, outsider]) await browser.enroll();
    tenantId = tenantCreatedResponseSchema.parse(
      (await owner.call("post", "tenants", { name: `Biometrics company ${randomUUID()}` })).body,
    ).tenant.id;
    otherTenant = tenantCreatedResponseSchema.parse(
      (await outsider.call("post", "tenants", { name: `Other biometrics company ${randomUUID()}` }))
        .body,
    ).tenant.id;
    const project = async (browser: Browser, name: string) => {
      await fresh(browser);
      return projectResponseSchema.parse((await browser.call("post", "projects", { name })).body)
        .project.id;
    };
    const site = async (browser: Browser, projectId: string, name: string) =>
      ok(
        await browser.call("post", `projects/${projectId}/sites`, {
          name,
          geofence: { kind: "radius", center: centre, radiusM: 60 },
        }),
        (body) => siteResponseSchema.parse(body).site.id,
        201,
      );
    projects.main = await project(owner, "Biometrics main project");
    projects.second = await project(owner, "Biometrics second project");
    projects.cancelled = await project(owner, "Biometrics project to cancel");
    sites.main = await site(owner, projects.main, "Main plot");
    sites.second = await site(owner, projects.second, "Second plot");
    sites.cancelled = await site(owner, projects.cancelled, "Cancelled plot");
    sites.foreign = await site(
      outsider,
      await project(outsider, "Foreign project"),
      "Foreign plot",
    );

    // The DPO prepares DPIAs (biometrics.manage, company-wide) but cannot approve or switch on.
    await fresh();
    const role = roleResponseSchema.parse(
      (
        await owner.call("post", "tenants/current/roles", {
          name: "Data protection officer",
          permissions: ["biometrics.manage"],
          tenantWide: true,
        })
      ).body,
    ).role;
    const join = async (member: Browser, roleKey: string, projectIds: string[] = []) => {
      await fresh();
      expect(
        (
          await owner.call("post", "tenants/current/invitations", {
            identifier: member.identifier,
            role: roleKey,
            projectIds,
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
    await join(dpo, role.id);
    await join(manager, "project_manager", [projects.main]);
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    vi.restoreAllMocks();
    await app?.close();
  });

  it("publishes every operation and refuses callers without a session, CSRF token or permission", async () => {
    const spec = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (spec.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((entry) => Object.values(entry).map((operation) => operation.operationId));
    for (const name of [
      "getBiometricsOverview",
      "createDpia",
      "getDpia",
      "updateDpia",
      "uploadDpiaDocument",
      "downloadDpiaDocument",
      "approveDpia",
      "rejectDpia",
      "withdrawDpia",
      "setBiometricSwitch",
    ])
      expect(operations, name).toContain(name);
    const anonymous = new Browser(app);
    await anonymous.initialize();
    problem(await anonymous.call("get", "biometrics"), 401);
    problem(await owner.call("post", "biometrics/dpias", draftBody([]), false), 403);
    // A project manager holds no biometrics permission.
    problem(await manager.call("get", "biometrics"), 403);
    problem(await manager.call("post", "biometrics/dpias", draftBody([])), 403);
    problem(await switchTo(manager, sites.main, "face", false), 403);
  });

  it("keeps biometric capture off everywhere until a DPIA is approved, in the API and the database", async () => {
    const view = await overview();
    expect(view.platformAvailable).toBe(true);
    expect(view.current).toBeNull();
    expect(view.permissions).toEqual({
      canPrepare: true,
      canApprove: true,
      canSwitchOn: true,
      canSwitchOff: true,
    });
    for (const site of [sites.main, sites.second])
      for (const method of ["face", "fingerprint", "terminal"])
        expect(gate(view, site, method)).toMatchObject({ on: false, reason: "no_dpia" });
    expect(view.sites.map((entry) => entry.id)).not.toContain(sites.foreign);
    await fresh();
    problem(await switchTo(owner, sites.main, "face", true), 409, "dpia-required");
    expect(await allowed(sites.main, "face")).toBe(false);
    await expect(biometricRecord(sites.main, projects.main)).rejects.toThrow(
      /not switched on for this site under an approved DPIA/,
    );
    // Switching on directly in the database is refused without an approved DPIA.
    await expect(
      sql(
        owner,
        `INSERT INTO biometric_switches (id, tenant_id, project_id, site_id, method, enabled,
           dpia_record_id, actor_id)
         VALUES (gen_random_uuid(), '${tenantId}', '${projects.main}', '${sites.main}', 'face',
           true, gen_random_uuid(), '${owner.auth.user.id}')`,
      ),
    ).rejects.toThrow(/switched on only under the approved DPIA in force/);
  });

  it("prepares a draft with the signed PDF and approves it only when complete, bound to the document", async () => {
    // The DPO prepares; the draft lists what still blocks approval.
    let draft = dpia(
      await dpo.call("post", "biometrics/dpias", {
        ...draftBody([]),
        methods: [],
        dpoName: null,
        controllerName: null,
        controllerDecision: null,
        residualRisk: null,
      }),
      201,
    );
    expect(draft).toMatchObject({ versionNo: 1, status: "draft", state: "draft", document: null });
    expect(draft.approvalGaps).toEqual([
      "document",
      "methods",
      "sites",
      "dpo",
      "controller",
      "residual_risk",
    ]);
    expect(draft.permissions).toEqual({
      canEdit: true,
      canApprove: false,
      canReject: false,
      canWithdraw: false,
    });
    problem(await dpo.call("post", "biometrics/dpias", draftBody([])), 409, "dpia-draft-exists");
    problem(
      await dpo.call("put", `biometrics/dpias/${draft.id}`, {
        ...draftBody([sites.main, sites.foreign]),
        version: draft.version,
      }),
      422,
      "unknown-site",
    );
    problem(
      await dpo.call("put", `biometrics/dpias/${draft.id}`, {
        ...draftBody([sites.main]),
        version: draft.version + 1,
      }),
      409,
      "version-conflict",
    );
    draft = dpia(
      await dpo.call("put", `biometrics/dpias/${draft.id}`, {
        ...draftBody([sites.main, sites.second, sites.cancelled]),
        dpoNote: null,
        residualRisk: "high",
        dpoOpinionOn: addCalendarDays(today, 1),
        version: draft.version,
      }),
    );
    expect(draft.sites.map((site) => site.id).sort()).toEqual(
      [sites.main, sites.second, sites.cancelled].sort(),
    );
    expect(draft.approvalGaps).toEqual([
      "document",
      "dpo_conditions",
      "signature_dates",
      "odpc_consultation",
    ]);

    // Only a PDF without active content is accepted as the signed DPIA.
    problem(
      await dpo.upload(`biometrics/dpias/${draft.id}/document`, jpeg, "scan.jpg"),
      415,
      "pdf-required",
    );
    problem(
      await dpo.upload(
        `biometrics/dpias/${draft.id}/document`,
        pdf("script", "3 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj\n"),
        "DPIA.pdf",
      ),
      422,
      "pdf-active-content",
    );
    const first = pdf("first signed copy");
    draft = dpia(await dpo.upload(`biometrics/dpias/${draft.id}/document`, first, "DPIA v1.pdf"));
    const signed = pdf("countersigned copy");
    draft = dpia(await dpo.upload(`biometrics/dpias/${draft.id}/document`, signed, "DPIA v1.pdf"));
    expect(draft.replacedDocuments).toBe(1);
    expect(draft.document).toMatchObject({ fileName: "DPIA v1.pdf", sizeBytes: signed.length });
    const download = await owner.download(`biometrics/dpias/${draft.id}/document`);
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toBe("application/pdf");
    expect(download.headers["cache-control"]).toBe("private, no-store");
    expect(Buffer.compare(download.body as Buffer, signed)).toBe(0);

    // The preparer cannot approve; the approver needs a fresh step-up.
    problem(await dpo.call("post", `biometrics/dpias/${draft.id}/approve`, {}), 400);
    await fresh(dpo);
    problem(
      await dpo.call("post", `biometrics/dpias/${draft.id}/approve`, {
        version: draft.version,
        documentSha256: draft.document!.sha256,
        reviewDue: addCalendarDays(today, 30),
        confirmations: [...DPIA_GO_LIVE_CONDITIONS],
      }),
      403,
    );
    await stale();
    problem(await approve(draft), 403, "step-up-required");
    await fresh();
    problem(await approve(draft), 422, "dpia-incomplete");

    draft = dpia(
      await dpo.call("put", `biometrics/dpias/${draft.id}`, {
        ...draftBody([sites.main, sites.second, sites.cancelled]),
        residualRisk: "high",
        odpcReference: "ODPC/PC/2026/014 (synthetic)",
        version: draft.version,
      }),
    );
    expect(draft.approvalGaps).toEqual([]);
    problem(
      await owner.call("post", `biometrics/dpias/${draft.id}/approve`, {
        version: draft.version,
        documentSha256: sha256("another file"),
        reviewDue: addCalendarDays(today, 30),
        confirmations: [...DPIA_GO_LIVE_CONDITIONS],
      }),
      409,
      "document-changed",
    );
    problem(
      await owner.call("post", `biometrics/dpias/${draft.id}/approve`, {
        version: draft.version,
        documentSha256: draft.document!.sha256,
        reviewDue: addCalendarDays(today, 30),
        confirmations: DPIA_GO_LIVE_CONDITIONS.slice(1),
      }),
      422,
      "conditions-unconfirmed",
    );
    problem(await approve(draft, today), 422, "review-date-invalid");
    problem(
      await approve(draft, addCalendarDays(addCalendarMonths(today, 12), 1)),
      422,
      "review-date-invalid",
    );
    // The database refuses the same approval written directly (no go-live conditions confirmed).
    await expect(
      sql(
        owner,
        `UPDATE dpia_records SET status = 'approved', version = version + 1,
           updated_by = '${owner.auth.user.id}', approved_by = '${owner.auth.user.id}',
           review_due = '${addCalendarDays(today, 30)}', approved_digest = '${"a".repeat(64)}'
         WHERE id = '${draft.id}'`,
      ),
    ).rejects.toThrow(/Every go-live condition must be confirmed/);
    await expect(
      sql(
        owner,
        `UPDATE dpia_records SET status = 'approved', version = version + 1,
           updated_by = '${owner.auth.user.id}', approved_by = '${owner.auth.user.id}',
           review_due = '${addCalendarDays(addCalendarMonths(today, 12), 1)}',
           conditions_confirmed = ARRAY['fallback_ready', 'accuracy_tested', 'vendor_assessed',
             'notices_reviewed', 'staff_trained', 'retention_set', 'hosting_recorded',
             'odpc_registered']::varchar[],
           approved_digest = '${"a".repeat(64)}'
         WHERE id = '${draft.id}'`,
      ),
    ).rejects.toThrow(/at most 12 months ahead/);
    await expect(
      sql(
        owner,
        `UPDATE dpia_records SET status = 'approved', version = version + 1,
           updated_by = '${owner.auth.user.id}', approved_by = '${dpo.auth.user.id}',
           review_due = '${addCalendarDays(today, 30)}',
           conditions_confirmed = ARRAY['fallback_ready', 'accuracy_tested', 'vendor_assessed',
             'notices_reviewed', 'staff_trained', 'retention_set', 'hosting_recorded',
             'odpc_registered']::varchar[],
           approved_digest = '${"a".repeat(64)}'
         WHERE id = '${draft.id}'`,
      ),
    ).rejects.toThrow(/approved by the signed-in user/);

    const reviewDue = addCalendarMonths(today, 12);
    const approved = dpia(await approve(draft, reviewDue));
    expect(approved).toMatchObject({
      status: "approved",
      state: "in_force",
      reviewDue,
      approvalGaps: [],
      permissions: { canEdit: false, canApprove: false, canReject: false, canWithdraw: true },
    });
    expect(approved.approval).toMatchObject({ by: { id: owner.auth.user.id }, reviewDue });
    expect([...approved.approval!.conditions].sort()).toEqual([...DPIA_GO_LIVE_CONDITIONS].sort());
    // The digest binds the approval to exactly what was reviewed, including the document.
    expect(approved.approval!.digest).toBe(
      sha256(
        canonicalJson(
          dpiaApprovalContent({
            ...draftBody([sites.main, sites.second, sites.cancelled]),
            residualRisk: "high",
            odpcReference: "ODPC/PC/2026/014 (synthetic)",
            methods: ["face"],
            dpoOpinion: "approve_with_conditions",
            controllerDecision: "proceed",
            versionNo: 1,
            documentSha256: draft.document!.sha256,
            reviewDue,
            conditions: DPIA_GO_LIVE_CONDITIONS,
          }),
        ),
      ),
    );

    // An approved DPIA never changes: not through the API, not in the database.
    problem(
      await dpo.call("put", `biometrics/dpias/${approved.id}`, {
        ...draftBody([sites.main]),
        version: approved.version,
      }),
      409,
      "dpia-not-draft",
    );
    problem(
      await dpo.upload(`biometrics/dpias/${approved.id}/document`, pdf("late"), "late.pdf"),
      409,
      "dpia-not-draft",
    );
    await expect(
      sql(
        owner,
        `UPDATE dpia_records SET dpo_name = 'Someone else', version = version + 1,
           updated_by = '${owner.auth.user.id}' WHERE id = '${approved.id}'`,
      ),
    ).rejects.toThrow(/Only a draft's content can change/);
    await expect(
      sql(
        owner,
        `UPDATE dpia_records SET review_due = '${addCalendarDays(reviewDue, 30)}',
           version = version + 1, updated_by = '${owner.auth.user.id}' WHERE id = '${approved.id}'`,
      ),
    ).rejects.toThrow(/This DPIA can no longer change/);
    await expect(
      sql(owner, `DELETE FROM dpia_records WHERE id = '${approved.id}'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      sql(owner, `DELETE FROM dpia_record_sites WHERE dpia_record_id = '${approved.id}'`),
    ).rejects.toThrow(/Only a draft DPIA's sites can change/);
    await expect(
      sql(
        owner,
        `INSERT INTO dpia_documents (id, tenant_id, dpia_record_id, file_name, content_type,
           size_bytes, sha256, object_key, scan_status, scan_engine, scanned_at, uploaded_by)
         SELECT id, tenant_id, '${approved.id}', 'x.pdf', 'application/pdf', 10,
           '${"b".repeat(64)}', 'tenants/x', 'clean', 'test', now(), '${owner.auth.user.id}'
         FROM (SELECT gen_random_uuid() AS id, '${tenantId}'::uuid AS tenant_id) s`,
      ),
    ).rejects.toThrow(/uploaded to a draft only/);
  });

  it("switches biometric capture on only per site and method under the DPIA in force", async () => {
    const view = await overview();
    expect(view.current).toMatchObject({ versionNo: 1, state: "in_force", siteCount: 3 });
    expect(gate(view, sites.main, "face")).toMatchObject({
      on: false,
      reason: "switched_off",
      inScope: true,
      switchedOn: false,
    });
    expect(gate(view, sites.main, "fingerprint")).toMatchObject({ reason: "not_in_scope" });

    // The DPO can switch off but never on; switching on needs a fresh step-up.
    await fresh(dpo);
    problem(await switchTo(dpo, sites.main, "face", true), 403);
    await stale();
    problem(await switchTo(owner, sites.main, "face", true), 403, "step-up-required");
    await fresh();
    const on = ok(
      await switchTo(owner, sites.main, "face", true),
      (body) => biometricSwitchResponseSchema.parse(body).site,
    );
    expect(on.methods.find((m) => m.method === "face")).toMatchObject({
      on: true,
      reason: null,
      switchedOn: true,
      lastChange: { enabled: true, by: { id: owner.auth.user.id }, carriedForward: false },
    });
    problem(await switchTo(owner, sites.main, "fingerprint", true), 409, "dpia-scope");
    problem(await switchTo(owner, "00000000-0000-4000-8000-000000000000", "face", true), 404);
    problem(await switchTo(owner, sites.foreign, "face", true), 404);
    // Asking for the current position records nothing.
    const count = async () =>
      (await query<{ n: bigint }>(owner, "SELECT count(*) AS n FROM biometric_switches"))[0]!.n;
    const before = await count();
    ok(await switchTo(owner, sites.main, "face", true), (body) => body);
    expect(await count()).toBe(before);
    ok(await switchTo(owner, sites.second, "face", true), (body) => body);

    // The database agrees, and lets a biometric record through only where the gate is open.
    expect(await allowed(sites.main, "face")).toBe(true);
    expect(await allowed(sites.main, "fingerprint")).toBe(false);
    expect(await allowed(sites.cancelled, "face")).toBe(false);
    await expect(biometricRecord(sites.main, projects.main)).rejects.toThrow(
      /timesheet period is locked/,
    );
    // Even with the gate open today, a backdated biometric record is refused: the gate checked is
    // the one in force on the record's own work date.
    await expect(
      biometricRecord(sites.main, projects.main, "face", addCalendarDays(today, -12)),
    ).rejects.toThrow(/written on its work date/);
    await expect(biometricRecord(sites.cancelled, projects.cancelled)).rejects.toThrow(
      /not switched on for this site/,
    );

    // A cancelled project is read-only: nothing is switched on there.
    await fresh();
    const cancelled = projectDetailResponseSchema.parse(
      (await owner.call("get", `projects/${projects.cancelled}`)).body,
    ).project;
    expect(
      (
        await owner.call("post", `projects/${projects.cancelled}/status`, {
          to: "cancelled",
          version: cancelled.version,
          reason: "Client withdrew (synthetic)",
        })
      ).status,
    ).toBe(200);
    problem(await switchTo(owner, sites.cancelled, "face", true), 409, "project-read-only");
    expect(gate(await overview(), sites.cancelled, "face").reason).toBe("project_closed");

    // The DPO switches a site off (always allowed, no step-up); the owner can switch it on again.
    await stale(dpo);
    const off = ok(
      await switchTo(dpo, sites.second, "face", false),
      (body) => biometricSwitchResponseSchema.parse(body).site,
    );
    expect(off.methods.find((m) => m.method === "face")).toMatchObject({
      on: false,
      reason: "switched_off",
      lastChange: { enabled: false, by: { id: dpo.auth.user.id } },
    });
    expect(await allowed(sites.second, "face")).toBe(false);
    await fresh();
    ok(await switchTo(owner, sites.second, "face", true), (body) => body);
    expect(await allowed(sites.second, "face")).toBe(true);

    // Switches are append-only, recorded as the signed-in user, ordered by the database.
    await expect(sql(owner, "UPDATE biometric_switches SET enabled = false")).rejects.toThrow(
      /permission denied/,
    );
    await expect(sql(owner, "DELETE FROM biometric_switches")).rejects.toThrow(/permission denied/);
    await expect(
      sql(
        owner,
        `INSERT INTO biometric_switches (id, tenant_id, project_id, site_id, method, enabled, actor_id)
         VALUES (gen_random_uuid(), '${tenantId}', '${projects.main}', '${sites.main}', 'face',
           false, '${dpo.auth.user.id}')`,
      ),
    ).rejects.toThrow(/recorded as the signed-in user/);
    await sql(
      owner,
      `INSERT INTO biometric_switches (id, tenant_id, seq, project_id, site_id, method, enabled, actor_id)
       VALUES (gen_random_uuid(), '${tenantId}', 1, '${projects.main}', '${sites.main}', 'face',
         false, '${owner.auth.user.id}')`,
    );
    // A forged early sequence number is replaced: the switch-off is the latest position.
    expect(await allowed(sites.main, "face")).toBe(false);
    await fresh();
    ok(await switchTo(owner, sites.main, "face", true), (body) => body);
    expect(await allowed(sites.main, "face")).toBe(true);
  });

  it("stops at once when the platform is off, and keeps switching off possible", async () => {
    const platform = vi.spyOn(app.get(BiometricsPlatform), "isAvailable").mockReturnValue(false);
    try {
      const view = await overview();
      expect(view.platformAvailable).toBe(false);
      expect(gate(view, sites.main, "face")).toMatchObject({
        on: false,
        reason: "platform_off",
        switchedOn: true,
      });
      await fresh();
      problem(await switchTo(owner, sites.main, "terminal", true), 409, "biometrics-unavailable");
    } finally {
      platform.mockRestore();
    }
    expect(gate(await overview(), sites.main, "face").on).toBe(true);
  });

  it("fails closed when the DPIA lapses, and a renewal keeps covered switches on", async () => {
    const current = (await overview()).current!;
    // Time passes: the review date is yesterday (the guard is lifted only to move the date).
    await ownerSql([
      "ALTER TABLE dpia_records DISABLE TRIGGER dpia_record_guard",
      `UPDATE dpia_records SET review_due = '${addCalendarDays(today, -1)}' WHERE id = '${current.id}'`,
      "ALTER TABLE dpia_records ENABLE TRIGGER dpia_record_guard",
    ]);
    let view = await overview();
    expect(view.current).toMatchObject({ id: current.id, state: "lapsed" });
    expect(gate(view, sites.main, "face")).toMatchObject({ on: false, reason: "dpia_lapsed" });
    expect(await allowed(sites.main, "face")).toBe(false);
    await expect(biometricRecord(sites.main, projects.main)).rejects.toThrow(
      /not switched on for this site/,
    );
    await fresh();
    problem(await switchTo(owner, sites.main, "face", true), 409, "dpia-lapsed");

    // The renewal covers the main site only: its switch carries forward, the second site's stops.
    const renewal = await prepared([sites.main]);
    expect(renewal.versionNo).toBe(2);
    await fresh();
    const approved = dpia(await approve(renewal));
    expect(approved.state).toBe("in_force");
    const previous = dpia(await owner.call("get", `biometrics/dpias/${current.id}`));
    expect(previous).toMatchObject({
      status: "superseded",
      state: "superseded",
      supersession: { by: { id: approved.id, versionNo: 2 } },
      permissions: { canWithdraw: false },
    });
    view = await overview();
    expect(view.current?.id).toBe(approved.id);
    expect(view.history.map((entry) => entry.versionNo)).toEqual([2, 1]);
    expect(gate(view, sites.main, "face")).toMatchObject({
      on: true,
      lastChange: { carriedForward: true, by: { id: owner.auth.user.id } },
    });
    expect(gate(view, sites.second, "face")).toMatchObject({ on: false, reason: "not_in_scope" });
    expect(await allowed(sites.main, "face")).toBe(true);
    expect(await allowed(sites.second, "face")).toBe(false);
    // In force through its review date, lapsed the day after (the database's own date check).
    expect(await allowed(sites.main, "face", approved.reviewDue!)).toBe(true);
    expect(await allowed(sites.main, "face", addCalendarDays(approved.reviewDue!, 1))).toBe(false);
    // A superseded version stays superseded: its successor must be the approved one.
    await expect(
      sql(
        owner,
        `UPDATE dpia_records SET status = 'superseded', superseded_by_id = '${current.id}',
           version = version + 1, updated_by = '${owner.auth.user.id}' WHERE id = '${approved.id}'`,
      ),
    ).rejects.toThrow(/superseded by a later version/);
  });

  it("stops everything at once when the approved DPIA is withdrawn; drafts can be closed unapproved", async () => {
    const view = await overview();
    const current = dpia(await owner.call("get", `biometrics/dpias/${view.current!.id}`));
    problem(
      await dpo.call("post", `biometrics/dpias/${current.id}/withdraw`, {
        version: current.version,
        reason: WITHDRAW_REASON,
      }),
      403,
    );
    await stale();
    problem(
      await owner.call("post", `biometrics/dpias/${current.id}/withdraw`, {
        version: current.version,
        reason: WITHDRAW_REASON,
      }),
      403,
      "step-up-required",
    );
    await fresh();
    const withdrawn = dpia(
      await owner.call("post", `biometrics/dpias/${current.id}/withdraw`, {
        version: current.version,
        reason: WITHDRAW_REASON,
      }),
    );
    expect(withdrawn).toMatchObject({
      status: "withdrawn",
      state: "withdrawn",
      withdrawal: { by: { id: owner.auth.user.id }, reason: WITHDRAW_REASON },
    });
    const after = await overview();
    expect(after.current).toBeNull();
    for (const method of ["face", "fingerprint", "terminal"])
      expect(gate(after, sites.main, method)).toMatchObject({ on: false, reason: "no_dpia" });
    expect(await allowed(sites.main, "face")).toBe(false);
    problem(await switchTo(owner, sites.main, "face", true), 409, "dpia-required");
    problem(
      await owner.call("post", `biometrics/dpias/${current.id}/withdraw`, {
        version: withdrawn.version,
        reason: WITHDRAW_REASON,
      }),
      409,
      "dpia-not-approved",
    );

    // A draft the controller will not proceed with is closed as not approved (final).
    let draft = dpia(
      await dpo.call("post", "biometrics/dpias", {
        ...draftBody([sites.main]),
        controllerDecision: "do_not_proceed",
      }),
      201,
    );
    expect(draft.approvalGaps).toContain("controller_declined");
    draft = dpia(
      await dpo.upload(`biometrics/dpias/${draft.id}/document`, pdf("declined"), "DPIA.pdf"),
    );
    // A rejection can never carry an approval it never had (written directly in the database,
    // with a signed document attached so only the rejection rule can refuse it).
    await expect(
      sql(
        owner,
        `UPDATE dpia_records SET status = 'rejected', version = version + 1,
           updated_by = '${owner.auth.user.id}', rejected_by = '${owner.auth.user.id}',
           reject_reason = 'Closed with a made-up approval (synthetic)',
           approved_by = '${owner.auth.user.id}', approved_at = now() - interval '30 days',
           approved_digest = '${"a".repeat(64)}', review_due = '${addCalendarDays(today, 200)}',
           conditions_confirmed = ARRAY['fallback_ready', 'accuracy_tested', 'vendor_assessed',
             'notices_reviewed', 'staff_trained', 'retention_set', 'hosting_recorded',
             'odpc_registered']::varchar[]
         WHERE id = '${draft.id}'`,
      ),
    ).rejects.toThrow(/dpia_records_state_check/);
    await fresh();
    const rejected = dpia(
      await owner.call("post", `biometrics/dpias/${draft.id}/reject`, {
        version: draft.version,
        reason: "The controller decided not to proceed (synthetic)",
      }),
    );
    expect(rejected).toMatchObject({
      status: "rejected",
      rejection: { by: { id: owner.auth.user.id } },
    });
    problem(
      await owner.call("post", `biometrics/dpias/${draft.id}/reject`, {
        version: rejected.version,
        reason: "The controller decided not to proceed (synthetic)",
      }),
      409,
      "dpia-not-draft",
    );
    // A new version can be started again; nothing switches on until it is approved.
    const next = dpia(await dpo.call("post", "biometrics/dpias", draftBody([sites.main])), 201);
    expect(next.versionNo).toBe(4);
    expect(gate(await overview(), sites.main, "face").reason).toBe("no_dpia");
  });

  it("isolates companies and keeps names, notes and reasons out of the audit log", async () => {
    const own = await overview();
    const record = own.history[0]!;
    await outsider.call("post", `tenants/${otherTenant}/select`, {});
    const foreign = await overview(outsider);
    expect(foreign.history).toEqual([]);
    expect(foreign.sites.map((site) => site.id)).toEqual([sites.foreign]);
    problem(await outsider.call("get", `biometrics/dpias/${record.id}`), 404);
    problem(await outsider.download(`biometrics/dpias/${record.id}/document`), 404);
    await fresh(outsider);
    problem(await switchTo(outsider, sites.main, "face", false), 404);
    expect(
      await query<{ id: string }>(outsider, "SELECT id FROM dpia_records", otherTenant),
    ).toEqual([]);
    await expect(
      sql(
        outsider,
        `INSERT INTO dpia_records (id, tenant_id, version_no, created_by, updated_by)
         VALUES (gen_random_uuid(), '${tenantId}', 99, '${outsider.auth.user.id}',
           '${outsider.auth.user.id}')`,
        otherTenant,
      ),
    ).rejects.toThrow(/row-level security/);

    await fresh();
    const events = auditEventsResponseSchema.parse(
      (await owner.call("get", "tenants/current/audit")).body,
    ).events;
    const actions = events.map((event) => event.action);
    for (const action of [
      "dpia.created",
      "dpia.updated",
      "dpia.document_uploaded",
      "dpia.document_downloaded",
      "dpia.approved",
      "dpia.rejected",
      "dpia.withdrawn",
      "biometrics.switched_on",
      "biometrics.switched_off",
    ])
      expect(actions, action).toContain(action);
    const text = JSON.stringify(events);
    for (const secret of [DPO_NAME, DPO_NOTE, WITHDRAW_REASON, "Wanjiru Kamau", "ODPC/PC/2026/014"])
      expect(text).not.toContain(secret);
  });
});
