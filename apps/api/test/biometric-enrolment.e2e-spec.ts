import { Logger, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import { CURRENT_CONSENT_NOTICE, DPIA_GO_LIVE_CONDITIONS } from "@pm-buddy/types";
import {
  biometricDeletionsResponseSchema,
  biometricEnrolmentResponseSchema,
  biometricEnrolmentsResponseSchema,
  biometricsOverviewResponseSchema,
  dpiaResponseSchema,
  labourerResponseSchema,
  labourSetupResponseSchema,
  projectResponseSchema,
  roleResponseSchema,
  siteResponseSchema,
  tenantCreatedResponseSchema,
  workerBiometricsResponseSchema,
  type BiometricEnrolment,
  type DpiaDetail,
  type WorkerBiometricsResponse,
} from "@pm-buddy/validation";
import { PrismaPg } from "@prisma/adapter-pg";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { KeyRotation } from "../src/keys/key-rotation.js";
import { BiometricRetentionService } from "../src/modules/biometrics/biometric-retention.service.js";
import { BiometricsPlatform } from "../src/modules/biometrics/biometrics-support.js";
import {
  generateTemplateKeyPair,
  TemplateOpener,
  TemplateSealer,
} from "../src/modules/biometrics/template-sealer.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { Browser, notifications } from "./support.js";
import { testDatabaseUrls } from "./test-database.js";

const pdf = (label: string) =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n% ${label} ${randomUUID()}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
  );
const today = nairobiDate();
const centre = { lat: -1.1489, lng: 36.9612 };
const DPO_PHONE = "+254 700 000 222";
/** The run's key pair (vitest.config.e2e.ts): the API seals with the public half only. */
const keys = {
  publicKey: process.env["BIOMETRIC_TEMPLATE_PUBLIC_KEYS"]!.split(":")[1]!,
  privateKey: process.env["E2E_BIOMETRIC_TEMPLATE_PRIVATE_KEY"]!,
};
const opener = new TemplateOpener(new Map([[1, Buffer.from(keys.privateKey, "hex")]]));
/** A synthetic template: an ISO/IEC 19794-2 style minutiae header, then random bytes. */
const template = (label = "", size = 96) =>
  Buffer.concat([Buffer.from(`FMR\0${label}`, "latin1"), randomBytes(size)]);
const encoded = (bytes: Buffer, quality = 82.5) => ({
  data: bytes.toString("base64"),
  algorithm: "Synthetic Minutiae",
  algorithmVersion: "1.0",
  qualityScore: quality,
});

/**
 * D3.4 second slice against the real database as the runtime role (pmb_app, forced RLS):
 * separate biometric consent per modality under the DPIA in force, enrolment with templates sealed
 * to a biometrics-only public key the API never holds the private half of, and deletion on
 * withdrawal, re-enrolment, request, retention, renewal and withdrawal of the DPIA, each logged by
 * the database and journalled once committed (the lines a restore replays). Synthetic data only.
 */
describe("Biometric consent, enrolment and template deletion (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let enroller: Browser;
  let supervisor: Browser;
  let dpo: Browser;
  let outsider: Browser;
  let tenantId: string;
  let otherTenant: string;
  const projects = { main: "", second: "" };
  const sites = { main: "", second: "" };
  const workers: Record<string, string> = {};
  const phones: Record<string, string> = {};
  const responses: string[] = [];
  const logged: string[] = [];
  /** A biometric journal line as the log spy records it. */
  const line = (text: string) => JSON.stringify([text]);
  /** The last enrolment of the canary test, re-sealed by the key rotation test. */
  const canaryEnrolment = { id: "", bytes: Buffer.alloc(0) };

  const ok = <T>(res: request.Response, parse: (body: unknown) => T, status = 200): T => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    responses.push(JSON.stringify(res.body));
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
  const context = (browser: Browser, tenant = tenantId) => ({
    userId: browser.auth.user.id,
    tenantId: tenant,
    requestId: randomUUID(),
  });
  const sql = (browser: Browser, statement: string, tenant = tenantId) =>
    db.run(context(browser, tenant), (tx) => tx.$executeRawUnsafe(statement));
  const query = <T>(browser: Browser, statement: string, tenant = tenantId) =>
    db.run(context(browser, tenant), (tx) => tx.$queryRawUnsafe<T[]>(statement));
  /** One transaction as the schema owner, in the company's context (same triggers and RLS). */
  const asSchemaOwner = async <T>(statements: string[], read?: string): Promise<T[]> => {
    const schemaOwner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrls().migrationUrl }),
    });
    try {
      return await schemaOwner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.tenant_id', '${tenantId}', true), set_config('app.user_id', '${owner.auth.user.id}', true)`,
        );
        for (const statement of statements) await tx.$executeRawUnsafe(statement);
        return read ? tx.$queryRawUnsafe<T[]>(read) : [];
      });
    } finally {
      await schemaOwner.$disconnect();
    }
  };
  const dpia = (res: request.Response, status = 200): DpiaDetail =>
    ok(res, (body) => dpiaResponseSchema.parse(body).dpia, status);
  const worker = (res: request.Response, status = 200): WorkerBiometricsResponse =>
    ok(res, (body) => workerBiometricsResponseSchema.parse(body), status);
  const view = async (key: string, browser = owner) =>
    worker(await browser.call("get", `biometrics/labourers/${workers[key]}`));
  const modality = (response: WorkerBiometricsResponse, name: "face" | "fingerprint") =>
    response.modalities.find((entry) => entry.modality === name)!;
  const consent = (
    browser: Browser,
    key: string,
    body: Partial<{
      modality: string;
      granted: boolean;
      language: string;
      method: string;
      witnessName: string;
      noticeVersion: string;
    }> = {},
  ) => {
    const name = body.modality ?? "face";
    return browser.call("post", `biometrics/labourers/${workers[key]}/consents`, {
      modality: name,
      noticeVersion: `biometric-${name}-2026-11-v1`,
      language: "en",
      method: "signed",
      granted: true,
      ...body,
    });
  };
  const withdraw = (browser: Browser, key: string, name = "face") =>
    browser.call("post", `biometrics/labourers/${workers[key]}/consents/withdraw`, {
      modality: name,
      method: "witnessed_verbal",
      witnessName: "Shahidi Majaribio",
    });
  const enrol = (
    browser: Browser,
    key: string,
    templates: Buffer[],
    options: Partial<{ id: string; site: string; method: string; modality: string }> = {},
  ) =>
    browser.call("post", "biometrics/enrolments", {
      id: options.id ?? randomUUID(),
      labourerId: workers[key],
      siteId: options.site ?? sites.main,
      method: options.method ?? "face",
      modality: options.modality ?? "face",
      templates: templates.map((bytes) => encoded(bytes)),
    });
  const enrolment = (res: request.Response, status = 201): BiometricEnrolment =>
    ok(res, (body) => biometricEnrolmentResponseSchema.parse(body).enrolment, status);
  const switchTo = async (site: string, method: string, enabled: boolean) => {
    await fresh();
    expect(
      (await owner.call("put", `biometrics/sites/${site}/methods/${method}`, { enabled })).status,
    ).toBe(200);
  };
  const templateRows = (enrolmentId: string) =>
    asSchemaOwner<{ id: string; template_enc: Uint8Array; key_version: number }>(
      [],
      `SELECT id, template_enc, key_version FROM biometric_templates
        WHERE enrolment_id = '${enrolmentId}' ORDER BY ordinal`,
    );
  const deletionLog = async (browser = owner) =>
    ok(await browser.call("get", "biometrics/deletions"), (body) =>
      biometricDeletionsResponseSchema.parse(body),
    ).deletions;
  const sms = (key: string) => notifications.get(phones[key]!) ?? [];
  /** A complete, signed draft covering `methods` on both sites. */
  const approveDpia = async (methods: string[], browser = owner) => {
    const draft = dpia(
      await browser.call("post", "biometrics/dpias", {
        methods,
        siteIds: [sites.main, sites.second],
        dpoName: "Achieng Otieno (synthetic DPO)",
        dpoPhone: DPO_PHONE,
        dpoOpinion: "approve",
        dpoOpinionOn: addCalendarDays(today, -2),
        dpoNote: null,
        controllerName: "Wanjiru Kamau",
        controllerRole: "Director",
        controllerDecision: "proceed",
        controllerDecisionOn: addCalendarDays(today, -1),
        controllerNote: null,
        residualRisk: "medium",
        odpcReference: null,
      }),
      201,
    );
    const signed = dpia(
      await browser.upload(`biometrics/dpias/${draft.id}/document`, pdf("signed"), "DPIA.pdf"),
    );
    await fresh(browser);
    return dpia(
      await browser.call("post", `biometrics/dpias/${signed.id}/approve`, {
        version: signed.version,
        documentSha256: signed.document!.sha256,
        reviewDue: addCalendarDays(today, 180),
        confirmations: [...DPIA_GO_LIVE_CONDITIONS],
      }),
    );
  };

  beforeAll(async () => {
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ bufferLogs: true });
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
    for (const level of ["log", "warn", "error", "debug", "verbose"] as const)
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      });
    owner = new Browser(app);
    enroller = new Browser(app);
    supervisor = new Browser(app);
    dpo = new Browser(app);
    outsider = new Browser(app);
    for (const browser of [owner, enroller, supervisor, dpo, outsider]) await browser.register();
    for (const browser of [owner, outsider]) await browser.enroll();
    tenantId = tenantCreatedResponseSchema.parse(
      (await owner.call("post", "tenants", { name: `Enrolment company ${randomUUID()}` })).body,
    ).tenant.id;
    otherTenant = tenantCreatedResponseSchema.parse(
      (await outsider.call("post", "tenants", { name: `Other enrolment company ${randomUUID()}` }))
        .body,
    ).tenant.id;
    const project = async (name: string) => {
      await fresh();
      return projectResponseSchema.parse((await owner.call("post", "projects", { name })).body)
        .project.id;
    };
    const site = async (projectId: string, name: string) =>
      ok(
        await owner.call("post", `projects/${projectId}/sites`, {
          name,
          geofence: { kind: "radius", center: centre, radiusM: 60 },
        }),
        (body) => siteResponseSchema.parse(body).site.id,
        201,
      );
    projects.main = await project("Enrolment main project");
    projects.second = await project("Enrolment second project");
    sites.main = await site(projects.main, "Main plot");
    sites.second = await site(projects.second, "Second plot");

    const role = async (name: string, permissions: string[], tenantWide: boolean) => {
      await fresh();
      return roleResponseSchema.parse(
        (await owner.call("post", "tenants/current/roles", { name, permissions, tenantWide })).body,
      ).role.id;
    };
    const join = async (member: Browser, roleKey: string, projectIds: string[] = []) => {
      await fresh();
      const invited = await owner.call("post", "tenants/current/invitations", {
        identifier: member.identifier,
        role: roleKey,
        projectIds,
      });
      expect(invited.status, JSON.stringify(invited.body)).toBe(201);
      const token = notifications
        .get(member.identifier)
        ?.at(-1)
        ?.text.match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
      expect((await member.call("post", "tenants/invitations/accept", { token })).status).toBe(200);
      expect((await member.call("post", `tenants/${tenantId}/select`, {})).status).toBe(200);
    };
    // A trained enrolment officer on the main project only (DPIA §7.1).
    await join(
      enroller,
      await role("Enrolment officer", ["biometrics.enrol", "labour.view"], false),
      [projects.main],
    );
    // A site agent records withdrawals (labour.consent) but cannot enrol.
    await join(supervisor, "site_agent", [projects.main]);
    await join(dpo, await role("Data protection officer", ["biometrics.manage"], true));

    const setup = labourSetupResponseSchema.parse(
      (await owner.call("post", "labour/setup/defaults", {})).body,
    );
    const trade = setup.trades.find((entry) => entry.key === "general_labourer")!.id;
    const level = setup.skillLevels.find((entry) => entry.key === "unskilled")!.id;
    let seq = Math.floor(Math.random() * 1_000_000);
    const register = async (key: string, projectId: string) => {
      seq += 1;
      const n = String(seq).padStart(7, "0");
      phones[key] = `2547${n.slice(-8).padStart(8, "1")}`;
      const res = await owner.call("post", "labour/labourers", {
        fullName: `Mfanyakazi Bayometriki ${key}`,
        dateOfBirth: "1991-03-09",
        gender: "female",
        tradeId: trade,
        skillLevelId: level,
        engagementType: "casual",
        rateBasis: "daily",
        idType: "national_id",
        idNumber: `7${n}`,
        phone: `0${phones[key]!.slice(3)}`,
        projectId,
        engagementStartDate: addCalendarDays(today, -40),
        consent: {
          noticeVersion: CURRENT_CONSENT_NOTICE.version,
          language: "en",
          method: "signed",
          granted: true,
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      workers[key] = labourerResponseSchema.parse(res.body).labourer.id;
    };
    for (const key of ["amina", "baraka", "chebet", "daudi"]) await register(key, projects.main);
    await register("elim", projects.second);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  it("publishes every operation and refuses callers without a session or the permission", async () => {
    const spec = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (spec.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((entry) => Object.values(entry).map((operation) => operation.operationId));
    for (const name of [
      "getWorkerBiometrics",
      "recordBiometricConsent",
      "withdrawBiometricConsent",
      "enrolBiometric",
      "listBiometricEnrolments",
      "deleteBiometricEnrolment",
      "listBiometricDeletions",
      "runBiometricRetention",
    ])
      expect(operations, name).toContain(name);
    const anonymous = new Browser(app);
    await anonymous.initialize();
    problem(await anonymous.call("get", `biometrics/labourers/${workers["amina"]}`), 401);
    problem(await enroller.call("get", "biometrics/enrolments"), 403);
    problem(await enroller.call("post", "biometrics/retention/run", {}), 403);
    // The other company never sees these workers.
    problem(await outsider.call("get", `biometrics/labourers/${workers["amina"]}`), 404);
    // The enrolment officer sees only workers of their project.
    problem(await enroller.call("get", `biometrics/labourers/${workers["elim"]}`), 404);
  });

  it("records consent only under a DPIA in force covering the modality, one decision at a time", async () => {
    let amina = await view("amina", enroller);
    expect(amina.dpia).toBeNull();
    expect(amina.permissions).toEqual({ canConsent: true, canWithdraw: true, canDelete: false });
    for (const entry of amina.modalities)
      expect(entry).toMatchObject({ blocked: "no_dpia", consent: { status: "none" } });
    problem(await consent(enroller, "amina"), 409, "dpia-required");

    await approveDpia(["face"]);
    amina = await view("amina", enroller);
    expect(amina.dpia).toMatchObject({ versionNo: 1, state: "in_force", dpoPhone: DPO_PHONE });
    expect(modality(amina, "face").blocked).toBeNull();
    expect(modality(amina, "fingerprint").blocked).toBe("not_in_scope");
    problem(await consent(enroller, "amina", { modality: "fingerprint" }), 409, "dpia-scope");
    // Only the current biometric notice of the modality.
    problem(
      await consent(enroller, "amina", { noticeVersion: CURRENT_CONSENT_NOTICE.version }),
      400,
      "notice-not-current",
    );
    // A site agent may take withdrawals but not consent.
    problem(await consent(supervisor, "amina"), 403);

    amina = worker(await consent(enroller, "amina"));
    expect(modality(amina, "face")).toMatchObject({
      consent: { status: "granted", current: true },
      enrolment: null,
    });
    expect(modality(amina, "face").decisions[0]).toMatchObject({
      granted: true,
      noticeVersion: "biometric-face-2026-11-v1",
      language: "en",
      method: "signed",
      dpiaVersionNo: 1,
      capturedBy: { id: enroller.auth.user.id },
    });
    // Confirmed to the worker's own phone, naming the DPO's number (DPIA §7.4).
    expect(sms("amina").at(-1)!.text).toMatch(/said YES to using your face/);
    expect(sms("amina").at(-1)!.text).toContain(DPO_PHONE);
    problem(await consent(enroller, "amina"), 409, "consent-recorded");
    problem(await consent(enroller, "amina", { granted: false }), 409, "consent-recorded");

    // A refusal, read aloud in Kiswahili with a witness, is recorded with no reason asked.
    const baraka = worker(
      await consent(enroller, "baraka", {
        granted: false,
        language: "sw",
        method: "witnessed_verbal",
        witnessName: "Shahidi Majaribio",
      }),
    );
    expect(modality(baraka, "face").consent).toEqual({ status: "refused", current: false });
    expect(sms("baraka").at(-1)!.text).toMatch(/ulisema HAPANA kutumia uso/);

    // Registration-data consent is separate: the labour screens are unchanged.
    const detail = labourerResponseSchema.parse(
      (await owner.call("get", `labour/labourers/${workers["amina"]}`)).body,
    ).labourer;
    expect(detail.consent.status).toBe("granted");
    expect(detail.consents.map((entry) => entry.kind)).toEqual(["registration_data"]);

    // The database repeats the rules: a biometric consent names an approved DPIA in force.
    const insert = (kind: string, dpiaId: string) =>
      sql(
        enroller,
        `INSERT INTO labourer_consents (id, tenant_id, labourer_id, kind, notice_version,
           notice_digest, language, method, granted, captured_by, dpia_record_id)
         VALUES (gen_random_uuid(), '${tenantId}', '${workers["chebet"]}', '${kind}',
           'biometric-face-2026-11-v1', '${"a".repeat(64)}', 'en', 'signed', true,
           '${enroller.auth.user.id}', ${dpiaId})`,
      );
    await expect(insert("biometric_face", "NULL")).rejects.toThrow(
      /DPIA in force for its modality/,
    );
    await expect(insert("biometric_face", `'${randomUUID()}'`)).rejects.toThrow(
      /DPIA in force for its modality/,
    );
    const audit = await query<{ metadata: unknown }>(
      owner,
      `SELECT metadata FROM audit_events WHERE tenant_id = '${tenantId}'
        AND action = 'biometrics.consent_recorded'`,
    );
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toMatch(/Shahidi|Mfanyakazi/);
  });

  it("enrols only where capture is on, with consent and an engagement today, and seals the templates", async () => {
    const samples = [template("left"), template("right")];
    problem(await enrol(enroller, "amina", samples), 409, "biometrics-unavailable");
    await switchTo(sites.main, "face", true);
    await switchTo(sites.second, "face", true);
    problem(await enrol(enroller, "baraka", samples), 409, "consent-required");
    // Not engaged on the site's project, even with consent and the gate open there.
    problem(await enrol(owner, "amina", samples, { site: sites.second }), 409, "not-engaged");
    // The officer holds biometrics.enrol on the main project only.
    problem(await enrol(enroller, "amina", samples, { site: sites.second }), 403);
    problem(await enrol(enroller, "amina", samples, { method: "fingerprint" }), 400);
    // Images are refused: templates only (DPIA §2.1).
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)]);
    problem(await enrol(enroller, "amina", [jpeg]), 422, "raw-image-refused");
    // An installation without a template key enrols nobody, and the overview says so.
    const platform = app.get(BiometricsPlatform) as { sealer: BiometricsPlatform["sealer"] };
    const sealer = platform.sealer;
    platform.sealer = null;
    try {
      problem(await enrol(enroller, "amina", samples), 409, "template-key-missing");
      expect(
        ok(await owner.call("get", "biometrics"), (body) =>
          biometricsOverviewResponseSchema.parse(body),
        ).templateKeyConfigured,
      ).toBe(false);
    } finally {
      platform.sealer = sealer;
    }

    const id = randomUUID();
    const enrolled = enrolment(await enrol(enroller, "amina", samples, { id }));
    expect(enrolled).toMatchObject({
      id,
      labourer: { id: workers["amina"] },
      modality: "face",
      method: "face",
      site: { id: sites.main },
      status: "active",
      state: "active",
      templates: 2,
      algorithm: "Synthetic Minutiae",
      deletionDueOn: null,
      deletion: null,
    });
    // A retry with the same ID returns the same enrolment; another use of the ID is refused.
    expect(enrolment(await enrol(enroller, "amina", samples, { id })).id).toBe(id);
    problem(await enrol(enroller, "baraka", samples, { id }), 409, "enrolment-conflict");

    // Sealed to the public key, bound to the row: only the private key opens it, only there.
    const rows = await templateRows(id);
    expect(rows.map((row) => row.key_version)).toEqual([1, 1]);
    rows.forEach((row, index) =>
      expect(
        opener.open({ tenantId, templateId: row.id }, Uint8Array.from(row.template_enc)),
      ).toEqual(samples[index]),
    );
    expect(() =>
      opener.open({ tenantId, templateId: rows[1]!.id }, Uint8Array.from(rows[0]!.template_enc)),
    ).toThrow(/could not be opened/);
    // The runtime role cannot read a template at all, nor change one.
    await expect(
      query(enroller, `SELECT template_enc FROM biometric_templates WHERE enrolment_id = '${id}'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      sql(
        enroller,
        `UPDATE biometric_templates SET quality_score = 1 WHERE enrolment_id = '${id}'`,
      ),
    ).rejects.toThrow(/permission denied/);
    // Templates are deleted only with their enrolment, and stored only when it is made.
    await expect(
      sql(enroller, `DELETE FROM biometric_templates WHERE enrolment_id = '${id}'`),
    ).rejects.toThrow(/deleted only together with their enrolment/);
    await expect(
      asSchemaOwner([
        `INSERT INTO biometric_templates (id, tenant_id, enrolment_id, ordinal, template_enc,
           quality_score, key_version)
         SELECT gen_random_uuid(), tenant_id, enrolment_id, 3, template_enc, 50, 1
           FROM biometric_templates WHERE enrolment_id = '${id}' AND ordinal = 1`,
      ]),
    ).rejects.toThrow(/stored once, when it is made/);
    // And an enrolment without consent is refused by the database too.
    await expect(
      sql(
        enroller,
        `INSERT INTO biometric_enrolments (id, tenant_id, labourer_id, modality, capture_method,
           consent_id, dpia_record_id, project_id, site_id, template_count, algorithm,
           algorithm_version, enrolled_by)
         SELECT gen_random_uuid(), tenant_id, '${workers["baraka"]}', 'face', 'face', consent_id,
           dpia_record_id, project_id, site_id, 1, 'X1', '1', '${enroller.auth.user.id}'
           FROM biometric_enrolments WHERE id = '${id}'`,
      ),
    ).rejects.toThrow(/consent for its modality/);
  });

  it("re-enrolment replaces the previous enrolment, and withdrawal deletes the templates at once", async () => {
    const before = (await view("amina")).modalities[0]!.enrolment!;
    const replacement = biometricEnrolmentResponseSchema.parse(
      (await enrol(enroller, "amina", [template("again")])).body,
    );
    expect(replacement.replaced).toBe(before.id);
    expect(await templateRows(before.id)).toEqual([]);
    expect((await deletionLog())[0]).toMatchObject({
      enrolmentId: before.id,
      reason: "re_enrolled",
      templates: 2,
      deletedBy: { id: enroller.auth.user.id },
      dueOn: null,
    });
    expect(logged).toContain(
      line(`Biometric templates deleted: company ${tenantId}, enrolment ${before.id}, re_enrolled`),
    );

    // Withdrawing directly in the database without deleting the templates is refused at commit.
    await expect(
      sql(
        supervisor,
        `UPDATE labourer_consents SET withdrawn_at = now(), withdrawn_by = '${supervisor.auth.user.id}',
           withdrawal_method = 'signed'
         WHERE labourer_id = '${workers["amina"]}' AND kind = 'biometric_face'`,
      ),
    ).rejects.toThrow(/deletes the templates it allowed/);

    // A site agent records the worker's withdrawal: the face templates are deleted with it.
    const amina = worker(await withdraw(supervisor, "amina"));
    expect(modality(amina, "face")).toMatchObject({
      consent: { status: "withdrawn" },
      enrolment: null,
    });
    expect(modality(amina, "face").deletions[0]).toMatchObject({
      enrolmentId: replacement.enrolment.id,
      reason: "consent_withdrawn",
      deletedBy: { id: supervisor.auth.user.id },
    });
    expect(await templateRows(replacement.enrolment.id)).toEqual([]);
    expect(logged).toEqual(
      expect.arrayContaining([
        line(
          `Biometric consent withdrawn: company ${tenantId}, labourer ${workers["amina"]}, face`,
        ),
        line(
          `Biometric templates deleted: company ${tenantId}, enrolment ${replacement.enrolment.id}, consent_withdrawn`,
        ),
      ]),
    );
    expect(sms("amina").at(-1)!.text).toMatch(/stopped using your face/);
    problem(await withdraw(supervisor, "amina"), 409, "consent-not-granted");
  });

  it("deletes templates after the retention period that follows the last engagement, never while engaged", async () => {
    for (const key of ["chebet", "daudi"]) {
      worker(await consent(enroller, key));
      enrolment(await enrol(enroller, key, [template(key)]));
    }
    // The database never lets a retention deletion take an engaged worker's templates.
    const engaged = (await view("daudi")).modalities[0]!.enrolment!.id;
    await expect(
      asSchemaOwner([
        `DELETE FROM biometric_templates WHERE enrolment_id = '${engaged}'`,
        `UPDATE biometric_enrolments SET status = 'deleted', deletion_reason = 'engagement_ended',
           deletion_due_on = '${today}' WHERE id = '${engaged}'`,
      ]),
    ).rejects.toThrow(/not due for deletion/);
    const end = async (key: string, endDate: string) => {
      const detail = labourerResponseSchema.parse(
        (await owner.call("get", `labour/labourers/${workers[key]}`)).body,
      ).labourer;
      const res = await owner.call(
        "post",
        `labour/labourers/${workers[key]}/engagements/${detail.engagements[0]!.id}/end`,
        { endDate, reason: "Contract finished" },
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    };
    // Chebet's work ended 35 days ago (30 days' retention: due 4 days ago); Daudi's 5 days ago.
    await end("chebet", addCalendarDays(today, -35));
    await end("daudi", addCalendarDays(today, -5));
    const listed = ok(await dpo.call("get", "biometrics/enrolments"), (body) =>
      biometricEnrolmentsResponseSchema.parse(body),
    );
    expect(listed.retention).toEqual({ daysAfterEngagement: 30, jobEnabled: false });
    const state = (key: string) =>
      listed.enrolments.find((entry) => entry.labourer.id === workers[key])!;
    expect(state("chebet")).toMatchObject({
      state: "deletion_due",
      deletionDueOn: addCalendarDays(today, -4),
    });
    expect(state("daudi")).toMatchObject({
      state: "active",
      deletionDueOn: addCalendarDays(today, 26),
    });

    // The retention job (the system actor) deletes only what is due, across companies.
    const job = await app.get(BiometricRetentionService).runDue();
    expect(job?.deleted).toBeGreaterThanOrEqual(1);
    const log = await deletionLog(dpo);
    const chebet = log.find((entry) => entry.labourer.id === workers["chebet"]);
    expect(chebet).toMatchObject({
      reason: "engagement_ended",
      dueOn: addCalendarDays(today, -4),
      deletedBy: null,
      templates: 1,
    });
    expect(logged).toContain(
      line(
        `Biometric templates deleted: company ${tenantId}, enrolment ${chebet!.enrolmentId}, engagement_ended`,
      ),
    );
    expect(log.some((entry) => entry.labourer.id === workers["daudi"])).toBe(false);
    // Running it again for the company (biometrics.manage) finds nothing more.
    expect(ok(await dpo.call("post", "biometrics/retention/run", {}), (body) => body)).toEqual({
      deleted: 0,
    });
  });

  it("deletes templates on the worker's request, and only the database writes the deletion log", async () => {
    const daudi = (await view("daudi")).modalities[0]!.enrolment!;
    problem(
      await enroller.call("post", `biometrics/enrolments/${daudi.id}/delete`, {
        reason: "request",
      }),
      403,
    );
    const deleted = enrolment(
      await dpo.call("post", `biometrics/enrolments/${daudi.id}/delete`, { reason: "request" }),
      200,
    );
    expect(deleted).toMatchObject({
      status: "deleted",
      state: "deleted",
      deletion: { reason: "request", by: { id: dpo.auth.user.id } },
      algorithm: "Synthetic Minutiae",
    });
    problem(
      await dpo.call("post", `biometrics/enrolments/${daudi.id}/delete`, { reason: "request" }),
      409,
      "enrolment-deleted",
    );
    await expect(
      sql(
        owner,
        `INSERT INTO biometric_deletions (id, tenant_id, enrolment_id, labourer_id, modality,
           reason, template_count, deleted_by, deleted_at)
         VALUES (gen_random_uuid(), '${tenantId}', '${daudi.id}', '${workers["daudi"]}', 'face',
           'request', 1, '${owner.auth.user.id}', now())`,
      ),
    ).rejects.toThrow(/written by the database/);
    await expect(
      sql(owner, `DELETE FROM biometric_deletions WHERE enrolment_id = '${daudi.id}'`),
    ).rejects.toThrow(/permission denied/);
  });

  it("holds templates while the DPIA has lapsed, deletes what a renewal stops covering, and all on withdrawal", async () => {
    // Fingerprint comes into scope with a renewal; Baraka now agrees to fingerprint.
    let current = await approveDpia(["face", "fingerprint"]);
    expect(current.versionNo).toBe(2);
    await switchTo(sites.main, "fingerprint", true);
    worker(await consent(enroller, "baraka", { modality: "fingerprint" }));
    const fingerprint = enrolment(
      await enrol(enroller, "baraka", [template("thumb"), template("index")], {
        method: "fingerprint",
        modality: "fingerprint",
      }),
    );
    worker(await consent(enroller, "amina"));
    const face = enrolment(await enrol(enroller, "amina", [template("face")]));

    // Time passes: the review date is yesterday (the guard is lifted only to move the date).
    await asSchemaOwner([
      "ALTER TABLE dpia_records DISABLE TRIGGER dpia_record_guard",
      `UPDATE dpia_records SET review_due = '${addCalendarDays(today, -1)}' WHERE id = '${current.id}'`,
      "ALTER TABLE dpia_records ENABLE TRIGGER dpia_record_guard",
    ]);
    const lapsed = await view("amina");
    expect(modality(lapsed, "face")).toMatchObject({
      blocked: "dpia_lapsed",
      enrolment: { id: face.id, state: "held" },
    });
    problem(await consent(enroller, "chebet"), 409, "dpia-lapsed");
    problem(await enrol(enroller, "amina", [template()]), 409, "dpia-lapsed");
    const overview = ok(await owner.call("get", "biometrics"), (body) =>
      biometricsOverviewResponseSchema.parse(body),
    );
    expect(overview.enrolments).toMatchObject({ face: 1, fingerprint: 1, held: 2, deletionDue: 0 });
    expect(overview.consentsThisMonth.face).toMatchObject({ refused: 1, withdrawn: 1 });
    expect(overview.templateKeyConfigured).toBe(true);

    // A renewal covering face only deletes the fingerprint templates in the same transaction.
    current = await approveDpia(["face"]);
    expect(current.versionNo).toBe(3);
    expect(await templateRows(fingerprint.id)).toEqual([]);
    expect((await view("baraka")).modalities[1]!.deletions[0]).toMatchObject({
      enrolmentId: fingerprint.id,
      reason: "out_of_scope",
    });
    expect(logged).toContain(
      line(
        `Biometric templates deleted: company ${tenantId}, enrolment ${fingerprint.id}, out_of_scope`,
      ),
    );
    expect((await view("amina")).modalities[0]!.enrolment).toMatchObject({
      id: face.id,
      state: "active",
    });

    // The database refuses to end the DPIA while templates it covered remain.
    await expect(
      asSchemaOwner([
        `UPDATE dpia_records SET status = 'withdrawn', withdrawn_by = '${owner.auth.user.id}',
           withdraw_reason = 'Synthetic direct withdrawal attempt', version = version + 1
         WHERE id = '${current.id}'`,
      ]),
    ).rejects.toThrow(/no approved DPIA covers must be deleted/);

    // Withdrawing the DPIA deletes every template now.
    await fresh();
    const withdrawn = dpia(
      await owner.call("post", `biometrics/dpias/${current.id}/withdraw`, {
        version: current.version,
        reason: "The company stops biometric attendance (synthetic)",
      }),
    );
    expect(withdrawn.status).toBe("withdrawn");
    expect(await templateRows(face.id)).toEqual([]);
    expect((await view("amina")).modalities[0]!.deletions[0]).toMatchObject({
      enrolmentId: face.id,
      reason: "dpia_withdrawn",
    });
    expect(logged).toEqual(
      expect.arrayContaining([
        line(`Biometric DPIA withdrawn: company ${tenantId}, DPIA ${current.id}`),
        line(
          `Biometric templates deleted: company ${tenantId}, enrolment ${face.id}, dpia_withdrawn`,
        ),
      ]),
    );
    // Withdrawal of consent is never blocked, even without a DPIA.
    worker(await withdraw(supervisor, "amina"));
  });

  it("keeps companies apart and never lets a template or its bytes out", async () => {
    const mine = await query<{ n: bigint }>(
      owner,
      `SELECT count(*) AS n FROM biometric_enrolments`,
    );
    expect(Number(mine[0]!.n)).toBeGreaterThan(0);
    const theirs = await query<{ n: bigint }>(
      outsider,
      `SELECT count(*) AS n FROM biometric_enrolments`,
      otherTenant,
    );
    expect(Number(theirs[0]!.n)).toBe(0);
    expect(
      ok(await outsider.call("get", "biometrics/deletions"), (body) =>
        biometricDeletionsResponseSchema.parse(body),
      ).deletions,
    ).toEqual([]);

    // A canary inside a template never shows up in a response, the audit log or a log line.
    const canary = `CANARY-${randomUUID()}`;
    await approveDpia(["face"]);
    await switchTo(sites.main, "face", true);
    worker(await consent(enroller, "baraka"));
    const bytes = template(canary);
    const sealed = enrolment(await enrol(enroller, "baraka", [bytes]));
    // The first 33 bytes ("FMR", NUL and most of the canary) encode to 44 aligned characters.
    const encodedCanary = bytes.toString("base64").slice(0, 44);
    const audit = await query<{ metadata: unknown }>(
      owner,
      `SELECT metadata FROM audit_events WHERE tenant_id = '${tenantId}'`,
    );
    for (const haystack of [JSON.stringify(audit), responses.join("\n"), logged.join("\n")]) {
      expect(haystack).not.toContain(canary);
      expect(haystack).not.toContain(encodedCanary);
    }
    const [stored] = await templateRows(sealed.id);
    expect(Buffer.from(stored!.template_enc).toString("latin1")).not.toContain(canary);
    canaryEnrolment.id = sealed.id;
    canaryEnrolment.bytes = bytes;
  });

  it("re-seals templates onto a new key version with the operator's private keys (keys:rotate)", async () => {
    const next = generateTemplateKeyPair();
    const hex = (value: string) => Buffer.from(value, "hex");
    const schemaOwner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrls().migrationUrl }),
    });
    try {
      const rotation = new KeyRotation(schemaOwner, {
        biometric: {
          sealer: new TemplateSealer(
            new Map([
              [1, hex(keys.publicKey)],
              [2, hex(next.publicKey)],
            ]),
            2,
          ),
          opener: new TemplateOpener(new Map([[1, hex(keys.privateKey)]])),
        },
      });
      await rotation.assertOwner();
      expect(await rotation.biometricStatus(tenantId)).toEqual({
        "biometric_templates.template_enc": { v1: 1 },
      });
      const options = { operator: "Synthetic Operator", tenantId };
      expect(await rotation.rewrapBiometric({ ...options, dryRun: true })).toMatchObject({
        kind: "biometric",
        targetVersion: 2,
        checked: 1,
        rewrapped: 0,
      });
      expect(await rotation.rewrapBiometric(options)).toMatchObject({
        checked: 1,
        rewrapped: 1,
        failed: 0,
        status: "completed",
      });
    } finally {
      await schemaOwner.$disconnect();
    }
    const [row] = await templateRows(canaryEnrolment.id);
    expect(row!.key_version).toBe(2);
    expect(
      new TemplateOpener(new Map([[2, Buffer.from(next.privateKey, "hex")]])).open(
        { tenantId, templateId: row!.id },
        Uint8Array.from(row!.template_enc),
      ),
    ).toEqual(canaryEnrolment.bytes);
    // Only the schema owner may re-seal: the runtime role holds no UPDATE on templates.
    await expect(
      sql(owner, `UPDATE biometric_templates SET key_version = 1 WHERE id = '${row!.id}'`),
    ).rejects.toThrow(/permission denied/);
  });

  /** Direct SQL as the runtime role, as any future path (a kiosk sync, a job) could run it. */
  const direct = {
    enrol: (consentId: string, dpiaId: string) =>
      `INSERT INTO biometric_enrolments (id, tenant_id, labourer_id, modality, capture_method,
         consent_id, dpia_record_id, project_id, site_id, template_count, algorithm,
         algorithm_version, enrolled_by)
       VALUES ('${randomUUID()}', '${tenantId}', '${workers["amina"]}', 'face', 'face',
         '${consentId}', '${dpiaId}', '${projects.main}', '${sites.main}', 2,
         'Synthetic Minutiae', '1.0', '${enroller.auth.user.id}')`,
    withdrawConsent: (key: string) =>
      `UPDATE labourer_consents SET withdrawn_at = now(), withdrawn_by = '${supervisor.auth.user.id}',
         withdrawal_method = 'signed'
       WHERE labourer_id = '${workers[key]}' AND kind = 'biometric_face' AND granted
         AND withdrawn_at IS NULL`,
    withdrawDpia: (dpiaId: string) =>
      `UPDATE dpia_records SET status = 'withdrawn', withdrawn_by = '${owner.auth.user.id}',
         withdraw_reason = 'Synthetic direct withdrawal attempt', version = version + 1
       WHERE id = '${dpiaId}'`,
  };
  const approvedDpiaId = async () =>
    (
      await query<{ id: string }>(owner, "SELECT id FROM dpia_records WHERE status = 'approved'")
    )[0]!.id;

  it("checks at commit only in the changed row's company context, whatever the session set", async () => {
    // Each change breaks a rule a commit-time check enforces; those checks read through row-level
    // security, so clearing or switching the company context before COMMIT must fail, not pass.
    const held = (await view("baraka")).modalities[0]!.enrolment!;
    const dpiaId = await approvedDpiaId();
    worker(await consent(enroller, "amina"));
    const [granted] = await query<{ id: string }>(
      owner,
      `SELECT id FROM labourer_consents WHERE labourer_id = '${workers["amina"]}'
         AND kind = 'biometric_face' AND granted AND withdrawn_at IS NULL`,
    );
    const changes: [Browser, string][] = [
      // Consent withdrawn, templates kept.
      [supervisor, direct.withdrawConsent("baraka")],
      // Templates deleted, enrolment still active (and no deletion log row).
      [owner, `DELETE FROM biometric_templates WHERE enrolment_id = '${held.id}'`],
      // An enrolment stored without its two templates.
      [enroller, direct.enrol(granted!.id, dpiaId)],
      // The DPIA withdrawn while its templates remain.
      [owner, direct.withdrawDpia(dpiaId)],
    ];
    for (const [browser, change] of changes)
      for (const reset of ["''", `'${otherTenant}'`])
        await expect(
          db.run(context(browser), async (tx) => {
            await tx.$executeRawUnsafe(change);
            await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', ${reset}, true)`);
          }),
        ).rejects.toThrow(/checked in their company's context/);
    expect((await view("baraka")).modalities[0]).toMatchObject({
      consent: { status: "granted" },
      enrolment: { id: held.id, state: "active" },
    });
    expect(await templateRows(held.id)).toHaveLength(1);
    expect(await approvedDpiaId()).toBe(dpiaId);
  });

  it("an enrolment in progress holds off a withdrawal of its consent or of the DPIA", async () => {
    const dpiaId = await approvedDpiaId();
    const [granted] = await query<{ id: string }>(
      owner,
      `SELECT id FROM labourer_consents WHERE labourer_id = '${workers["amina"]}'
         AND kind = 'biometric_face' AND granted AND withdrawn_at IS NULL`,
    );
    let inserted!: () => void;
    const insertedSignal = new Promise<void>((resolve) => (inserted = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    // The enrolment's transaction stays open (and is rolled back) while the withdrawals try.
    const enrolling = db
      .run(
        context(enroller),
        async (tx) => {
          try {
            await tx.$executeRawUnsafe(direct.enrol(granted!.id, dpiaId));
          } finally {
            inserted();
          }
          await released;
          throw new Error("Rolled back on purpose");
        },
        30_000,
      )
      .catch((error: unknown) => error);
    await insertedSignal;
    const attempt = (browser: Browser, change: string) =>
      db.run(context(browser), async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1s'");
        await tx.$executeRawUnsafe(change);
      });
    try {
      // Without the enrolment's share locks both would commit at once, past the enrolment.
      await expect(attempt(supervisor, direct.withdrawConsent("amina"))).rejects.toThrow(
        /lock timeout/,
      );
      await expect(attempt(owner, direct.withdrawDpia(dpiaId))).rejects.toThrow(/lock timeout/);
    } finally {
      release();
    }
    expect(String(await enrolling)).toMatch(/Rolled back on purpose/);
    expect(modality(await view("amina"), "face")).toMatchObject({
      consent: { status: "granted" },
      enrolment: null,
    });
  });
});
