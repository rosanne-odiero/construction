import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addCalendarDays, latestAllowedBirthDate, nairobiDate } from "@pm-buddy/domain";
import { CURRENT_CONSENT_NOTICE } from "@pm-buddy/types";
import {
  accreditationAlertsResponseSchema,
  auditEventsResponseSchema,
  gangDetailResponseSchema,
  gangsResponseSchema,
  labourerResponseSchema,
  labourersResponseSchema,
  labourRateResponseSchema,
  labourRatesResponseSchema,
  labourSetupResponseSchema,
  labourViewsResponseSchema,
  projectResponseSchema,
  resolvedRateResponseSchema,
  revealResponseSchema,
  siteResponseSchema,
  type LabourerDetail,
  type LabourSetupResponse,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import type { Prisma } from "../src/generated/prisma/client.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import {
  FieldCipher,
  FieldCipherError,
  parseFieldKeys,
} from "../src/modules/labour/field-cipher.js";
import { LabourCrypto, uuidv7 } from "../src/modules/labour/labour-support.js";
import { Browser, notifications } from "./support.js";

type Method = "get" | "post" | "patch" | "put" | "delete";
const ruiru = { lat: -1.1489, lng: 36.9612 };
/** A syntactically valid ciphertext envelope for direct inserts (never decrypted). */
const envelope = () => Uint8Array.from([1, 1, ...Array.from({ length: 29 }, (_, i) => i + 7)]);
const hex64 = (n: number) => n.toString(16).padStart(64, "0");

describe("Labour registry (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let crypto: LabourCrypto;
  let owner: Browser;
  let ownerB: Browser;
  let pm: Browser;
  let agent: Browser;
  let tenantA: string;
  let tenantB: string;
  let p1: string;
  let p2: string;
  let p1Site: string;
  let p2Site: string;
  let setup: LabourSetupResponse;
  let setupB: LabourSetupResponse;
  let seq = 0;
  const today = nairobiDate();
  const registered: Record<string, LabourerDetail> = {};
  const plaintexts: string[] = [];
  let notificationSpy: ReturnType<typeof vi.spyOn>;

  const fresh = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
  const stale = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) },
    });
  const as = (browser: Browser, tenantId: string, requestId: string) => ({
    userId: browser.auth.user.id,
    tenantId,
    requestId,
  });
  const problem = (res: request.Response) => (res.body as { code?: string }).code;
  const match = (res: request.Response) => (res.body as { match?: Record<string, string> }).match;
  const trade = (key: string, from = setup) => from.trades.find((entry) => entry.key === key)!.id;
  const level = (key: string, from = setup) =>
    from.skillLevels.find((entry) => entry.key === key)!.id;
  const labourer = (res: request.Response) => labourerResponseSchema.parse(res.body).labourer;
  const auditEvents = async () => {
    await fresh(owner);
    const res = await owner.call("get", "tenants/current/audit");
    expect(res.status).toBe(200);
    return auditEventsResponseSchema.parse(res.body).events;
  };

  /** A synthetic person: unique ID number, phone and KRA PIN from a running sequence. */
  const person = (overrides: Record<string, unknown> = {}) => {
    seq += 1;
    const n = String(seq).padStart(7, "0");
    return {
      fullName: `Mtihani Worker ${seq}`,
      dateOfBirth: "1990-05-17",
      gender: "male",
      tradeId: trade("general_labourer"),
      skillLevelId: level("unskilled"),
      engagementType: "casual",
      rateBasis: "daily",
      idType: "national_id",
      idNumber: `9${n}`,
      phone: `071${n}`,
      kraPin: `A9${n.padStart(8, "0")}Z`,
      projectId: p1,
      consent: {
        noticeVersion: CURRENT_CONSENT_NOTICE.version,
        language: "en",
        method: "signed",
        granted: true,
      },
      ...overrides,
    };
  };
  const register = async (browser: Browser, body: Record<string, unknown>) => {
    const res = await browser.call("post", "labour/labourers", body);
    if (res.status === 201) {
      const created = labourer(res);
      registered[created.workerNo] = created;
      for (const key of ["idNumber", "phone", "kraPin", "nssfNumber", "shaNumber"])
        if (typeof body[key] === "string") plaintexts.push(String(body[key]).replace(/\s/g, ""));
    }
    return res;
  };
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
  const site = async (projectId: string, name: string, east: number) => {
    const res = await owner.call("post", `projects/${projectId}/sites`, {
      name,
      geofence: {
        kind: "radius",
        center: { lat: ruiru.lat, lng: Math.round((ruiru.lng + east / 111_173) * 1e6) / 1e6 },
        radiusM: 50,
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return siteResponseSchema.parse(res.body).site.id;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    db = app.get(TenantDatabase);
    crypto = app.get(LabourCrypto);
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
    agent = new Browser(app);
    for (const browser of [owner, ownerB]) {
      await browser.register();
      await browser.enroll();
    }
    await pm.register();
    await agent.register();
    const a = await owner.call("post", "tenants", { name: "Labour company A" });
    const b = await ownerB.call("post", "tenants", { name: "Labour company B" });
    expect([a.status, b.status]).toEqual([201, 201]);
    tenantA = (a.body as { tenant: { id: string } }).tenant.id;
    tenantB = (b.body as { tenant: { id: string } }).tenant.id;
    await fresh(owner);
    p1 = projectResponseSchema.parse(
      (await owner.call("post", "projects", { code: "LAB-ONE", name: "Labour project one" })).body,
    ).project.id;
    p2 = projectResponseSchema.parse(
      (await owner.call("post", "projects", { code: "LAB-TWO", name: "Labour project two" })).body,
    ).project.id;
    p1Site = await site(p1, "Main plot", 0);
    p2Site = await site(p2, "Second plot", 500);
    await join(pm, "project_manager", [p1]);
    await join(agent, "site_agent", [p1]);
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("documents every labour operation in OpenAPI", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "getLabourSetup",
      "installLabourDefaults",
      "createTrade",
      "updateTrade",
      "createSkillLevel",
      "updateSkillLevel",
      "updateLabourSettings",
      "listLabourRates",
      "createLabourRate",
      "cancelLabourRate",
      "listLabourers",
      "registerLabourer",
      "getLabourer",
      "updateLabourer",
      "changeLabourerStatus",
      "revealLabourerField",
      "setDoNotRehire",
      "resolveLabourerRate",
      "engageLabourer",
      "endEngagement",
      "addAccreditation",
      "updateAccreditation",
      "removeAccreditation",
      "recordConsent",
      "withdrawConsent",
      "listAccreditationAlerts",
      "listLabourViews",
      "createLabourView",
      "deleteLabourView",
      "listGangs",
      "createGang",
      "getGang",
      "updateGang",
      "addGangMember",
      "leaveGang",
    ])
      expect(operations, id).toContain(id);
  });

  it("configures trades, skill levels and settings with config.manage only", async () => {
    expect((await pm.call("post", "labour/setup/defaults", {})).status).toBe(403);
    const installed = await owner.call("post", "labour/setup/defaults", {});
    expect(installed.status, JSON.stringify(installed.body)).toBe(200);
    setup = labourSetupResponseSchema.parse(installed.body);
    expect(setup.trades).toHaveLength(15);
    expect(setup.skillLevels.map((entry) => entry.key)).toEqual([
      "skilled",
      "semi_skilled",
      "unskilled",
      "site_supervisor",
    ]);
    expect(setup.settings).toEqual({ accreditationAlertDays: 30, version: 0 });
    // Idempotent: a second install adds nothing.
    const again = labourSetupResponseSchema.parse(
      (await owner.call("post", "labour/setup/defaults", {})).body,
    );
    expect(again.trades).toHaveLength(15);
    const agentView = await agent.call("get", "labour/setup");
    expect(agentView.status).toBe(200);
    const agentSetup = labourSetupResponseSchema.parse(agentView.body);
    expect(agentSetup.canConfigure).toBe(false);
    // A site agent holds no labour.manage; a PM manages labour only on assigned projects.
    expect(agentSetup.manageableProjects).toEqual([]);
    const pmSetup = labourSetupResponseSchema.parse((await pm.call("get", "labour/setup")).body);
    expect(pmSetup.manageableProjects.map((project) => project.id)).toEqual([p1]);
    expect(setup.manageableProjects.map((project) => project.id).sort()).toEqual([p1, p2].sort());

    const tiler = await owner.call("post", "labour/trades", {
      key: "Scaffolder",
      nameEn: "Scaffolder",
      nameSw: "Fundi jukwaa",
    });
    expect(tiler.status, JSON.stringify(tiler.body)).toBe(201);
    const duplicate = await owner.call("post", "labour/trades", {
      key: "mason",
      nameEn: "Mason 2",
      nameSw: "Mwashi 2",
    });
    expect([duplicate.status, problem(duplicate)]).toEqual([409, "trade-key-taken"]);
    expect(
      (await pm.call("post", "labour/trades", { key: "x_y", nameEn: "X", nameSw: "X" })).status,
    ).toBe(403);
    const scaffolder = (tiler.body as { trade: { id: string; version: number } }).trade;
    const deactivated = await owner.call("patch", `labour/trades/${scaffolder.id}`, {
      active: false,
      version: 1,
    });
    expect(deactivated.status).toBe(200);
    const stalePatch = await owner.call("patch", `labour/trades/${scaffolder.id}`, {
      nameEn: "Old",
      version: 1,
    });
    expect([stalePatch.status, problem(stalePatch)]).toEqual([409, "version-conflict"]);
    const inactive = await register(owner, person({ tradeId: scaffolder.id }));
    expect([inactive.status, problem(inactive)]).toEqual([400, "trade-inactive"]);

    const levelRes = await owner.call("post", "labour/skill-levels", {
      key: "apprentice",
      nameEn: "Apprentice",
      nameSw: "Mwanafunzi",
      ncaCategory: "semi_skilled",
      accreditationExpected: false,
    });
    expect(levelRes.status).toBe(201);
    expect(
      (
        await owner.call("post", "labour/skill-levels", {
          key: "bad",
          nameEn: "Bad",
          nameSw: "Bad",
          ncaCategory: "expert",
          accreditationExpected: false,
        })
      ).status,
    ).toBe(400);

    const settings = await owner.call("put", "labour/settings", {
      accreditationAlertDays: 45,
      version: 0,
    });
    expect(labourSetupResponseSchema.parse(settings.body).settings).toEqual({
      accreditationAlertDays: 45,
      version: 1,
    });
    const staleSettings = await owner.call("put", "labour/settings", {
      accreditationAlertDays: 20,
      version: 0,
    });
    expect([staleSettings.status, problem(staleSettings)]).toEqual([409, "version-conflict"]);
    expect(
      (await owner.call("put", "labour/settings", { accreditationAlertDays: 0, version: 1 }))
        .status,
    ).toBe(400);
    await owner.call("put", "labour/settings", { accreditationAlertDays: 30, version: 1 });

    setupB = labourSetupResponseSchema.parse(
      (await ownerB.call("post", "labour/setup/defaults", {})).body,
    );
    expect(setupB.trades.map((entry) => entry.id)).not.toContain(trade("mason"));
  });

  it("registers with consent and stores identifiers only as ciphertext and blind indexes", async () => {
    const body = person({
      fullName: "Wanjiku Mtihani Kamau",
      gender: "female",
      tradeId: trade("mason"),
      skillLevelId: level("skilled"),
      idNumber: "9 800 0001",
      phone: "0799 000 001",
      kraPin: "a980000001z",
      nssfNumber: "NSSF 9800 0001",
      shaNumber: "SHA98000001",
      homeCounty: "kiambu",
      nextOfKin: { name: "Mama Mtihani", relationship: "Mother", phone: "0799000002" },
      consent: {
        noticeVersion: CURRENT_CONSENT_NOTICE.version,
        language: "sw",
        method: "witnessed_verbal",
        witnessName: "Kevin Mtihani",
        granted: true,
      },
      accreditation: {
        category: "nca_skilled_worker",
        cardNumber: "nca/sw/0001",
        expiresOn: addCalendarDays(today, 400),
      },
    });
    const res = await register(pm, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const created = labourer(res);
    expect(created).toMatchObject({
      workerNo: "WRK-0001",
      fullName: "Wanjiku Mtihani Kamau",
      status: "active",
      idType: "national_id",
      idNumberMasked: "•••••001",
      phoneMasked: "2547•••••001",
      kraPinMasked: "•••••01Z",
      nssfNumberMasked: "•••••001",
      nextOfKinRecorded: true,
      registeredOn: today,
      consent: { status: "granted", noticeVersion: CURRENT_CONSENT_NOTICE.version, current: true },
      accreditation: { status: "valid" },
      projects: [{ projectId: p1, code: "LAB-ONE", startDate: today }],
      doNotRehire: false,
    });
    expect(created.consents[0]).toMatchObject({
      language: "sw",
      method: "witnessed_verbal",
      witnessName: "Kevin Mtihani",
      capturedBy: { id: pm.auth.user.id },
    });
    plaintexts.push("98000001", "254799000001", "A980000001Z", "NSSF98000001", "SHA98000001");
    const json = JSON.stringify(res.body);
    for (const value of ["98000001", "254799000001", "A980000001Z", "NSSF98000001", "Mama Mtihani"])
      expect(json).not.toContain(value);

    // The raw columns, read directly as the runtime role, contain no plaintext.
    const [row] = await db.run(
      as(owner, tenantA, "raw-columns"),
      (tx) =>
        tx.$queryRaw<
          {
            id_number_enc: Uint8Array;
            phone_enc: Uint8Array;
            kra_pin_enc: Uint8Array;
            nssf_number_enc: Uint8Array;
            sha_number_enc: Uint8Array;
            next_of_kin_enc: Uint8Array;
            id_number_bidx: string;
            phone_bidx: string;
            plain: string;
          }[]
        >`SELECT id_number_enc, phone_enc, kra_pin_enc, nssf_number_enc, sha_number_enc,
          next_of_kin_enc, id_number_bidx, phone_bidx, row_to_json(labourers)::text AS plain
        FROM labourers WHERE id = ${created.id}::uuid`,
    );
    expect(row).toBeDefined();
    for (const column of [
      row!.id_number_enc,
      row!.phone_enc,
      row!.kra_pin_enc,
      row!.nssf_number_enc,
      row!.sha_number_enc,
      row!.next_of_kin_enc,
    ]) {
      const bytes = Buffer.from(column);
      expect(bytes[0]).toBe(1);
      expect(bytes[1]).toBe(1);
      for (const value of ["98000001", "254799000001", "0799000001", "A980000001Z", "Mtihani"])
        expect(bytes.includes(Buffer.from(value))).toBe(false);
    }
    expect(row!.id_number_bidx).toMatch(/^[0-9a-f]{64}$/);
    for (const value of ["98000001", "254799000001", "A980000001Z", "NSSF98000001", "Mama Mtihani"])
      expect(row!.plain).not.toContain(value);
    // The stored ciphertext decrypts with the configured keys for this row only.
    expect(crypto.open(tenantA, created.id, "id_number_enc", row!.id_number_enc)).toBe("98000001");
    registered[created.workerNo] = created;
  });

  it("refuses anyone under 18 on today's Africa/Nairobi date (boundary)", async () => {
    const eighteenToday = latestAllowedBirthDate(today);
    const ok = await register(owner, person({ dateOfBirth: eighteenToday }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(labourer(ok).age).toBe(18);
    const tooYoung = await register(
      owner,
      person({ dateOfBirth: addCalendarDays(eighteenToday, 1) }),
    );
    expect([tooYoung.status, problem(tooYoung)]).toEqual([400, "under-minimum-age"]);
    const startedAsMinor = await register(
      owner,
      person({ dateOfBirth: eighteenToday, engagementStartDate: addCalendarDays(today, -1) }),
    );
    expect([startedAsMinor.status, problem(startedAsMinor)]).toEqual([400, "under-minimum-age"]);
    const correction = await owner.call("patch", `labour/labourers/${labourer(ok).id}`, {
      version: labourer(ok).version,
      dateOfBirth: addCalendarDays(eighteenToday, 2),
    });
    expect([correction.status, problem(correction)]).toEqual([400, "under-minimum-age"]);
  });

  it("enforces the age, consent and ciphertext rules in the database when the API is bypassed", async () => {
    const inB = as(ownerB, tenantB, "db-invariants");
    const base = (id: string, overrides: Partial<Prisma.LabourerUncheckedCreateInput> = {}) =>
      ({
        id,
        tenantId: tenantB,
        workerNo: `WRK-${String(9000 + seq++).padStart(4, "0")}`,
        fullName: "Direct Insert",
        dateOfBirth: new Date("1990-01-01T00:00:00Z"),
        gender: "male",
        tradeId: trade("mason", setupB),
        skillLevelId: level("skilled", setupB),
        engagementType: "casual",
        idType: "national_id",
        idNumberEnc: envelope(),
        idNumberBidx: hex64(seq),
        registeredOn: new Date("2000-01-01T00:00:00Z"),
        createdBy: ownerB.auth.user.id,
        ...overrides,
      }) satisfies Prisma.LabourerUncheckedCreateInput;
    const consent = (labourerId: string) => ({
      tenantId: tenantB,
      labourerId,
      kind: "registration_data",
      noticeVersion: CURRENT_CONSENT_NOTICE.version,
      noticeDigest: CURRENT_CONSENT_NOTICE.digests.en,
      language: "en",
      method: "signed",
      granted: true,
      capturedBy: ownerB.auth.user.id,
    });
    const underAgeId = uuidv7();
    await expect(
      db.run(inB, async (tx) => {
        await tx.labourer.create({
          data: base(underAgeId, {
            dateOfBirth: new Date(`${addCalendarDays(latestAllowedBirthDate(today), 1)}T00:00:00Z`),
          }),
        });
        await tx.labourerConsent.create({ data: consent(underAgeId) });
      }),
    ).rejects.toThrow();
    // Without a consent record the transaction cannot commit (deferred constraint trigger).
    await expect(
      db.run(inB, (tx) => tx.labourer.create({ data: base(uuidv7()) })),
    ).rejects.toThrow();
    // Plaintext instead of the ciphertext envelope is refused.
    const plainId = uuidv7();
    await expect(
      db.run(inB, async (tx) => {
        await tx.labourer.create({
          data: base(plainId, { idNumberEnc: Uint8Array.from(Buffer.from("23456789")) }),
        });
        await tx.labourerConsent.create({ data: consent(plainId) });
      }),
    ).rejects.toThrow();
    // A client-supplied registration date is replaced by the database's Africa/Nairobi date.
    const validId = uuidv7();
    await db.run(inB, async (tx) => {
      await tx.labourer.create({
        data: base(validId, {
          idNumberEnc: crypto.seal(tenantB, validId, "id_number_enc", "90009000"),
        }),
      });
      await tx.labourerConsent.create({ data: consent(validId) });
    });
    const stored = await db.run(inB, (tx) =>
      tx.labourer.findUniqueOrThrow({ where: { tenantId_id: { tenantId: tenantB, id: validId } } }),
    );
    expect(stored.registeredOn.toISOString().slice(0, 10)).toBe(today);
    await expect(
      db.run(inB, (tx) =>
        tx.labourer.update({
          where: { tenantId_id: { tenantId: tenantB, id: validId } },
          data: { dateOfBirth: new Date(`${addCalendarDays(today, -365)}T00:00:00Z`) },
        }),
      ),
    ).rejects.toThrow();
    // The runtime role can neither delete a labourer nor a consent record.
    await expect(
      db.run(inB, (tx) => tx.$executeRaw`DELETE FROM labourers WHERE id = ${validId}::uuid`),
    ).rejects.toThrow();
    await expect(
      db.run(
        inB,
        (tx) => tx.$executeRaw`DELETE FROM labourer_consents WHERE labourer_id = ${validId}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      db.run(
        inB,
        (tx) =>
          tx.$executeRaw`UPDATE labourer_consents SET language = 'sw' WHERE labourer_id = ${validId}::uuid`,
      ),
    ).rejects.toThrow();
    // A do-not-rehire flag cannot be set without a recorded reason.
    await expect(
      db.run(inB, (tx) =>
        tx.labourer.update({
          where: { tenantId_id: { tenantId: tenantB, id: validId } },
          data: {
            doNotRehire: true,
            doNotRehireAt: new Date(),
            doNotRehireBy: ownerB.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("fails to decrypt with the wrong key, another row or a tampered value", async () => {
    const created = registered["WRK-0001"]!;
    const raw = await db.run(as(owner, tenantA, "decrypt"), (tx) =>
      tx.labourer.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: tenantA, id: created.id } },
        select: { idNumberEnc: true },
      }),
    );
    const otherRow = Object.values(registered).find((entry) => entry.id !== created.id)!;
    expect(() => crypto.open(tenantA, otherRow.id, "id_number_enc", raw.idNumberEnc)).toThrow(
      FieldCipherError,
    );
    expect(() => crypto.open(tenantB, created.id, "id_number_enc", raw.idNumberEnc)).toThrow(
      FieldCipherError,
    );
    expect(() => crypto.open(tenantA, created.id, "phone_enc", raw.idNumberEnc)).toThrow(
      FieldCipherError,
    );
    const tampered = Uint8Array.from(raw.idNumberEnc);
    tampered[20]! ^= 0xff;
    expect(() => crypto.open(tenantA, created.id, "id_number_enc", tampered)).toThrow(
      FieldCipherError,
    );
    const stranger = new FieldCipher(
      parseFieldKeys(`1:${"ab".repeat(32)}`, undefined, "cd".repeat(32)),
    );
    expect(() =>
      stranger.decrypt(
        { tenantId: tenantA, table: "labourers", column: "id_number_enc", rowId: created.id },
        raw.idNumberEnc,
      ),
    ).toThrow(FieldCipherError);
  });

  it("masks by default; revealing needs labour.view_sensitive and fresh step-up and is audited", async () => {
    const target = registered["WRK-0001"]!;
    const list = await agent.call("get", "labour/labourers");
    expect(list.status).toBe(200);
    const rows = labourersResponseSchema.parse(list.body).labourers;
    expect(rows.find((row) => row.id === target.id)).toMatchObject({
      idNumberMasked: "•••••001",
      doNotRehire: null,
    });
    for (const value of plaintexts) expect(JSON.stringify(list.body)).not.toContain(value);

    const forbidden = await pm.call("post", `labour/labourers/${target.id}/reveal`, {
      field: "idNumber",
      purpose: "identity_verification",
    });
    expect(forbidden.status).toBe(403);
    await stale(owner);
    const stepUp = await owner.call("post", `labour/labourers/${target.id}/reveal`, {
      field: "idNumber",
      purpose: "identity_verification",
    });
    expect([stepUp.status, problem(stepUp)]).toEqual([403, "step-up-required"]);
    await fresh(owner);
    const revealed = await owner.call("post", `labour/labourers/${target.id}/reveal`, {
      field: "idNumber",
      purpose: "identity_verification",
    });
    expect(revealed.status, JSON.stringify(revealed.body)).toBe(200);
    expect(revealResponseSchema.parse(revealed.body)).toMatchObject({
      field: "idNumber",
      value: "98000001",
    });
    expect(revealed.headers["cache-control"]).toContain("no-store");
    const kin = await owner.call("post", `labour/labourers/${target.id}/reveal`, {
      field: "nextOfKin",
      purpose: "emergency_contact",
    });
    expect(revealResponseSchema.parse(kin.body).value).toEqual({
      name: "Mama Mtihani",
      relationship: "Mother",
      phone: "254799000002",
    });
    const sha = await owner.call("post", `labour/labourers/${target.id}/reveal`, {
      field: "shaNumber",
      purpose: "statutory_filing",
    });
    expect(revealResponseSchema.parse(sha.body).value).toBe("SHA98000001");
    const events = (await auditEvents()).filter(
      (event) => event.action === "labourer.sensitive_revealed" && event.resourceId === target.id,
    );
    expect(events.map((event) => event.metadata)).toEqual(
      expect.arrayContaining([
        { field: "idNumber", purpose: "identity_verification", recorded: true },
        { field: "nextOfKin", purpose: "emergency_contact", recorded: true },
      ]),
    );
    expect(
      (
        await owner.call("post", `labour/labourers/${target.id}/reveal`, {
          field: "idNumber",
          purpose: "curiosity",
        })
      ).status,
    ).toBe(400);
  });

  it("finds exact identifiers through blind indexes and refuses duplicates", async () => {
    const target = registered["WRK-0001"]!;
    for (const search of ["98000001", "0799 000 001", "A980000001Z"]) {
      const found = labourersResponseSchema.parse(
        (await owner.call("get", `labour/labourers?search=${encodeURIComponent(search)}`)).body,
      );
      expect(
        found.labourers.map((row) => row.id),
        search,
      ).toEqual([target.id]);
    }
    const sameId = await register(owner, person({ idNumber: "98000001" }));
    expect([sameId.status, problem(sameId)]).toEqual([409, "duplicate-identity"]);
    expect(match(sameId)).toEqual({ labourerId: target.id, workerNo: "WRK-0001", matchedOn: "id" });
    const sameKra = await register(owner, person({ kraPin: "A980000001Z" }));
    expect([sameKra.status, problem(sameKra)]).toEqual([409, "kra-pin-taken"]);
    const sharedPhone = await register(owner, person({ phone: "0799000001" }));
    expect(sharedPhone.status).toBe(201);
    expect(labourerResponseSchema.parse(sharedPhone.body).warnings).toContain("phone-shared");
    // Two simultaneous registrations of one ID: exactly one succeeds.
    const twin = person();
    const results = await Promise.all([
      register(owner, twin),
      register(owner, { ...twin, phone: "0700999999", kraPin: null }),
    ]);
    expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([201, 409]);
  });

  it("flags do-not-rehire with a reason, step-up and audit; blocks or overrides matches", async () => {
    const flagged = labourer(await register(owner, person({ fullName: "Flagged Mtihani" })));
    const notEnrolled = await pm.call("put", `labour/labourers/${flagged.id}/do-not-rehire`, {
      flagged: true,
      reason: "Repeated safety violations on site (synthetic test)",
      version: flagged.version,
    });
    expect([notEnrolled.status, problem(notEnrolled)]).toEqual([403, "mfa-required"]);
    await pm.enroll();
    await stale(pm);
    const noStepUp = await pm.call("put", `labour/labourers/${flagged.id}/do-not-rehire`, {
      flagged: true,
      reason: "Repeated safety violations on site (synthetic test)",
      version: flagged.version,
    });
    expect([noStepUp.status, problem(noStepUp)]).toEqual([403, "step-up-required"]);
    const agentFlag = await agent.call("put", `labour/labourers/${flagged.id}/do-not-rehire`, {
      flagged: true,
      reason: "Repeated safety violations on site (synthetic test)",
      version: flagged.version,
    });
    expect(agentFlag.status).toBe(403);
    await fresh(pm);
    const set = await pm.call("put", `labour/labourers/${flagged.id}/do-not-rehire`, {
      flagged: true,
      reason: "Repeated safety violations on site (synthetic test)",
      version: flagged.version,
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(labourer(set).doNotRehireDetail).toMatchObject({
      flagged: true,
      setBy: { id: pm.auth.user.id },
      reason: "Repeated safety violations on site (synthetic test)",
    });
    const again = await pm.call("put", `labour/labourers/${flagged.id}/do-not-rehire`, {
      flagged: true,
      reason: "Repeated safety violations on site (synthetic test)",
      version: labourer(set).version,
    });
    expect([again.status, problem(again)]).toEqual([409, "do-not-rehire-unchanged"]);
    // Only managers see the flag; a site agent sees null.
    const agentDetail = labourer(await agent.call("get", `labour/labourers/${flagged.id}`));
    expect(agentDetail.doNotRehire).toBeNull();
    expect(agentDetail.doNotRehireDetail).toBeNull();
    expect((await agent.call("get", "labour/labourers?doNotRehire=true")).status).toBe(403);
    const view = labourersResponseSchema.parse(
      (await pm.call("get", "labour/labourers?doNotRehire=true")).body,
    );
    expect(view.labourers.map((row) => row.id)).toEqual([flagged.id]);

    // The flagged person's ID: blocked outright (engage the existing record instead).
    const flaggedRaw = await db.run(as(owner, tenantA, "flagged"), (tx) =>
      tx.labourer.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: tenantA, id: flagged.id } },
        select: { idNumberEnc: true, phoneEnc: true },
      }),
    );
    const flaggedId = crypto.open(tenantA, flagged.id, "id_number_enc", flaggedRaw.idNumberEnc);
    const flaggedPhoneNumber = crypto.open(tenantA, flagged.id, "phone_enc", flaggedRaw.phoneEnc!);
    const sameId = await register(pm, person({ idNumber: flaggedId }));
    expect([sameId.status, problem(sameId)]).toEqual([409, "do-not-rehire-match"]);
    expect(match(sameId)).toMatchObject({ labourerId: flagged.id, matchedOn: "id" });
    // A new registration with the flagged person's phone: blocked unless overridden with a reason.
    const samePhone = person({ phone: flaggedPhoneNumber, kraPin: null });
    const blocked = await register(pm, samePhone);
    expect([blocked.status, problem(blocked)]).toEqual([409, "do-not-rehire-match"]);
    expect(match(blocked)).toMatchObject({ labourerId: flagged.id, matchedOn: "phone" });
    const overridden = await register(pm, {
      ...samePhone,
      doNotRehireOverride: { reason: "Different person sharing a family phone (verified)" },
    });
    expect(overridden.status, JSON.stringify(overridden.body)).toBe(201);
    expect(labourerResponseSchema.parse(overridden.body).warnings).toContain(
      "do-not-rehire-overridden",
    );
    // Engaging the flagged worker on another project needs labour.do_not_rehire and a reason.
    await fresh(owner);
    const engage = await owner.call("post", `labour/labourers/${flagged.id}/engagements`, {
      projectId: p2,
    });
    expect([engage.status, problem(engage)]).toEqual([409, "do-not-rehire-match"]);
    const engaged = await owner.call("post", `labour/labourers/${flagged.id}/engagements`, {
      projectId: p2,
      doNotRehireOverride: { reason: "Owner approved a second chance after review" },
    });
    expect(engaged.status, JSON.stringify(engaged.body)).toBe(201);
    const history = await db.run(as(owner, tenantA, "dnr-history"), (tx) =>
      tx.doNotRehireEvent.findMany({
        where: { tenantId: tenantA, labourerId: flagged.id },
        orderBy: { createdAt: "asc" },
      }),
    );
    expect(history.map((event) => [event.action, event.context])).toEqual([
      ["set", null],
      ["override", "registration"],
      ["override", "engagement"],
    ]);
    for (const event of history)
      expect(Buffer.from(event.reasonEnc).includes(Buffer.from("safety"))).toBe(false);
    // The history is append-only, and an engagement of a flagged worker needs an override row.
    await expect(
      db.run(
        as(owner, tenantA, "dnr-delete"),
        (tx) =>
          tx.$executeRaw`DELETE FROM do_not_rehire_events WHERE labourer_id = ${flagged.id}::uuid`,
      ),
    ).rejects.toThrow();
    const audit = await auditEvents();
    const actions = audit
      .filter((event) => event.resourceId === flagged.id)
      .map((event) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining(["labourer.do_not_rehire_set", "labourer.do_not_rehire_overridden"]),
    );
    expect(JSON.stringify(audit)).not.toMatch(/safety violations|second chance|family phone/);
    // Clearing needs a reason too.
    await fresh(pm);
    const latest = labourer(await pm.call("get", `labour/labourers/${flagged.id}`));
    const cleared = await pm.call("put", `labour/labourers/${flagged.id}/do-not-rehire`, {
      flagged: false,
      reason: "Appeal upheld by the project manager",
      version: latest.version,
    });
    expect(labourer(cleared).doNotRehireDetail).toMatchObject({ flagged: false, reason: null });
  });

  it("records consent versions and withdrawal; withdrawal blocks new engagements", async () => {
    const worker = labourer(await register(owner, person()));
    const withdraw = await agent.call("post", `labour/labourers/${worker.id}/consents/withdraw`, {
      method: "witnessed_verbal",
      witnessName: "Kevin Mtihani",
    });
    expect(withdraw.status, JSON.stringify(withdraw.body)).toBe(200);
    expect(labourer(withdraw).consent).toEqual({
      status: "withdrawn",
      noticeVersion: CURRENT_CONSENT_NOTICE.version,
      current: false,
    });
    const twice = await agent.call("post", `labour/labourers/${worker.id}/consents/withdraw`, {
      method: "signed",
    });
    expect([twice.status, problem(twice)]).toEqual([409, "consent-withdrawn"]);
    const engage = await owner.call("post", `labour/labourers/${worker.id}/engagements`, {
      projectId: p2,
    });
    expect([engage.status, problem(engage)]).toEqual([409, "consent-not-active"]);
    const withdrawn = labourersResponseSchema.parse(
      (await owner.call("get", "labour/labourers?consent=withdrawn")).body,
    );
    expect(withdrawn.labourers.map((row) => row.id)).toContain(worker.id);
    const recorded = await agent.call("post", `labour/labourers/${worker.id}/consents`, {
      noticeVersion: CURRENT_CONSENT_NOTICE.version,
      language: "en",
      method: "signed",
      granted: true,
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(labourer(recorded).consents).toHaveLength(2);
    const duplicate = await agent.call("post", `labour/labourers/${worker.id}/consents`, {
      noticeVersion: CURRENT_CONSENT_NOTICE.version,
      language: "sw",
      method: "signed",
      granted: true,
    });
    expect([duplicate.status, problem(duplicate)]).toEqual([409, "consent-current"]);
    for (const consent of [
      { noticeVersion: "registration-2020-v0", language: "en", method: "signed", granted: true },
      {
        noticeVersion: CURRENT_CONSENT_NOTICE.version,
        language: "en",
        method: "witnessed_verbal",
        granted: true,
      },
      {
        noticeVersion: CURRENT_CONSENT_NOTICE.version,
        language: "en",
        method: "signed",
        granted: false,
      },
    ])
      expect(
        (await agent.call("post", `labour/labourers/${worker.id}/consents`, consent)).status,
      ).toBe(400);
    const noConsent = await register(owner, { ...person(), consent: undefined });
    expect(noConsent.status).toBe(400);
    expect(
      (await owner.call("post", `labour/labourers/${worker.id}/engagements`, { projectId: p2 }))
        .status,
    ).toBe(201);
  });

  it("keeps rates effective-dated: no overwrite, no backdating, scheduled ones cancellable", async () => {
    const mason = trade("mason");
    const create = (browser: Browser, body: Record<string, unknown>) =>
      browser.call("post", "labour/rates", { basis: "daily", ...body });
    const company = await create(owner, {
      tradeId: mason,
      rateMinor: 150_000,
      effectiveFrom: today,
    });
    expect(company.status, JSON.stringify(company.body)).toBe(201);
    const rate = labourRateResponseSchema.parse(company.body);
    expect(rate.rate).toMatchObject({ scope: "company_trade", inForce: true, effectiveTo: null });
    expect(rate.minimumWage).toEqual({ status: "not_configured", reference: "CR-PAY-09" });
    const sameDay = await create(owner, {
      tradeId: mason,
      rateMinor: 160_000,
      effectiveFrom: today,
    });
    expect([sameDay.status, problem(sameDay)]).toEqual([409, "rate-exists"]);
    const backdated = await create(owner, {
      tradeId: mason,
      rateMinor: 160_000,
      effectiveFrom: addCalendarDays(today, -1),
    });
    expect([backdated.status, problem(backdated)]).toEqual([400, "rate-backdated"]);
    const next = await create(owner, {
      tradeId: mason,
      rateMinor: 165_000,
      effectiveFrom: addCalendarDays(today, 7),
    });
    expect(labourRateResponseSchema.parse(next.body).rate).toMatchObject({
      scheduled: true,
      inForce: false,
    });
    const listed = labourRatesResponseSchema.parse((await owner.call("get", "labour/rates")).body);
    expect(listed.rates.find((entry) => entry.id === rate.rate.id)?.effectiveTo).toBe(
      addCalendarDays(today, 6),
    );
    expect(
      (
        await pm.call("post", "labour/rates", {
          basis: "daily",
          tradeId: mason,
          rateMinor: 1,
          effectiveFrom: today,
        })
      ).status,
    ).toBe(403);
    const inForce = await owner.call("delete", `labour/rates/${rate.rate.id}`);
    expect([inForce.status, problem(inForce)]).toEqual([409, "rate-in-force"]);
    const scheduledId = labourRateResponseSchema.parse(next.body).rate.id;
    expect((await owner.call("delete", `labour/rates/${scheduledId}`)).status).toBe(200);
    // The runtime role cannot rewrite or delete a rate in force, nor insert a backdated one.
    const inA = as(owner, tenantA, "rate-rules");
    await expect(
      db.run(
        inA,
        (tx) =>
          tx.$executeRaw`UPDATE labour_rates SET rate_minor = 1 WHERE id = ${rate.rate.id}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      db.run(
        inA,
        (tx) => tx.$executeRaw`DELETE FROM labour_rates WHERE id = ${rate.rate.id}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      db.run(inA, (tx) =>
        tx.labourRate.create({
          data: {
            tenantId: tenantA,
            tradeId: mason,
            basis: "daily",
            rateMinor: 1n,
            effectiveFrom: new Date(`${addCalendarDays(today, -3)}T00:00:00Z`),
            createdBy: owner.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();

    // Project and labourer rates, then resolution on a date.
    const worker = registered["WRK-0001"]!;
    const project = await create(pm, {
      projectId: p1,
      tradeId: mason,
      rateMinor: 155_000,
      effectiveFrom: today,
    });
    expect(project.status, JSON.stringify(project.body)).toBe(201);
    const resolve = async (query: string) =>
      resolvedRateResponseSchema.parse(
        (await pm.call("get", `labour/labourers/${worker.id}/rate?${query}`)).body,
      );
    expect((await resolve(`projectId=${p1}`)).rate).toMatchObject({
      scope: "project_trade",
      rateMinor: 155_000,
    });
    const own = await create(pm, {
      projectId: p1,
      labourerId: worker.id,
      rateMinor: 175_000,
      effectiveFrom: today,
    });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect((await resolve(`projectId=${p1}`)).rate).toMatchObject({
      scope: "labourer",
      rateMinor: 175_000,
    });
    expect((await resolve(`projectId=${p1}&date=${addCalendarDays(today, -1)}`)).rate).toBeNull();
    expect((await resolve(`projectId=${p1}&basis=hourly`)).rate).toBeNull();
    expect(
      (await pm.call("get", `labour/labourers/${worker.id}/rate?projectId=${p2}`)).status,
    ).toBe(403);
    expect((await agent.call("get", `labour/rates?projectId=${p1}`)).status).toBe(403);
  });

  it("alerts on expired and expiring NCA accreditation with the configured lead time", async () => {
    const skilled = labourer(
      await register(owner, person({ tradeId: trade("welder"), skillLevelId: level("skilled") })),
    );
    const expired = labourer(
      await register(
        owner,
        person({ tradeId: trade("electrician"), skillLevelId: level("skilled") }),
      ),
    );
    expect(
      (
        await owner.call("post", `labour/labourers/${skilled.id}/accreditations`, {
          category: "nca_skilled_worker",
          cardNumber: "NCA-T-1001",
          issuedOn: addCalendarDays(today, -355),
          expiresOn: addCalendarDays(today, 10),
        })
      ).status,
    ).toBe(201);
    const added = await owner.call("post", `labour/labourers/${expired.id}/accreditations`, {
      category: "nca_skilled_worker",
      cardNumber: "NCA-T-1002",
      expiresOn: addCalendarDays(today, -3),
    });
    expect(labourer(added).accreditation).toMatchObject({ status: "expired", daysLeft: -3 });
    const backwards = await owner.call("post", `labour/labourers/${expired.id}/accreditations`, {
      category: "nca_skilled_worker",
      cardNumber: "NCA-T-1003",
      issuedOn: today,
      expiresOn: addCalendarDays(today, -1),
    });
    expect(backwards.status).toBe(400);
    const alerts = accreditationAlertsResponseSchema.parse(
      (await agent.call("get", "labour/accreditation-alerts")).body,
    );
    expect(alerts.alertDays).toBe(30);
    const kinds = Object.fromEntries(alerts.alerts.map((alert) => [alert.labourerId, alert.kind]));
    expect(kinds[skilled.id]).toBe("expiring");
    expect(kinds[expired.id]).toBe("expired");
    expect(alerts.alerts[0]!.kind).toBe("expired");
    const attention = labourersResponseSchema.parse(
      (await owner.call("get", "labour/labourers?accreditation=attention")).body,
    );
    expect(attention.labourers.map((row) => row.id)).toEqual(
      expect.arrayContaining([skilled.id, expired.id]),
    );
    const settings = labourSetupResponseSchema.parse(
      (await owner.call("get", "labour/setup")).body,
    ).settings;
    await owner.call("put", "labour/settings", {
      accreditationAlertDays: 5,
      version: settings.version,
    });
    const shorter = accreditationAlertsResponseSchema.parse(
      (await owner.call("get", "labour/accreditation-alerts")).body,
    );
    expect(shorter.alerts.find((alert) => alert.labourerId === skilled.id)).toBeUndefined();
    const renewed = labourer(
      await owner.call("post", `labour/labourers/${expired.id}/accreditations`, {
        category: "nca_skilled_worker",
        cardNumber: "NCA-T-1004",
        expiresOn: addCalendarDays(today, 365),
      }),
    );
    expect(renewed.accreditation.status).toBe("valid");
    const card = renewed.accreditations.find((entry) => entry.cardNumber === "NCA-T-1002")!;
    const removed = await owner.call(
      "delete",
      `labour/labourers/${expired.id}/accreditations/${card.id}`,
    );
    expect(labourer(removed).accreditations).toHaveLength(1);
    await owner.call("put", "labour/settings", {
      accreditationAlertDays: 30,
      version: settings.version + 1,
    });
  });

  it("runs gangs with a member as leader and a dated membership history", async () => {
    const created = await pm.call("post", "labour/gangs", {
      projectId: p1,
      name: "Gang A: masonry",
      siteId: p1Site,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const gang = gangDetailResponseSchema.parse(created.body).gang;
    expect(gang).toMatchObject({ siteId: p1Site, siteName: "Main plot", leader: null });
    const otherSite = await pm.call("post", "labour/gangs", {
      projectId: p1,
      name: "Wrong site",
      siteId: p2Site,
    });
    expect([otherSite.status, problem(otherSite)]).toEqual([400, "site-not-in-project"]);
    const taken = await pm.call("post", "labour/gangs", { projectId: p1, name: "Gang A: masonry" });
    expect([taken.status, problem(taken)]).toEqual([409, "gang-name-taken"]);
    expect(
      (await pm.call("post", "labour/gangs", { projectId: p2, name: "Not mine" })).status,
    ).toBe(403);
    expect(
      (await agent.call("post", "labour/gangs", { projectId: p1, name: "Agent" })).status,
    ).toBe(403);

    const lead = labourer(await register(pm, person({ tradeId: trade("foreman") })));
    const member = labourer(await register(pm, person()));
    const onP2 = labourer(await register(owner, person({ projectId: p2 })));
    const add = (labourerId: string) =>
      pm.call("post", `labour/gangs/${gang.id}/members`, { labourerId });
    const notLeader = await pm.call("patch", `labour/gangs/${gang.id}`, {
      leaderLabourerId: lead.id,
      version: gang.version,
    });
    expect([notLeader.status, problem(notLeader)]).toEqual([409, "leader-not-member"]);
    expect((await add(lead.id)).status).toBe(201);
    expect((await add(member.id)).status).toBe(201);
    const notEngaged = await owner.call("post", `labour/gangs/${gang.id}/members`, {
      labourerId: onP2.id,
    });
    expect([notEngaged.status, problem(notEngaged)]).toEqual([409, "not-engaged"]);
    const led = await pm.call("patch", `labour/gangs/${gang.id}`, {
      leaderLabourerId: lead.id,
      version: gang.version,
    });
    expect(gangDetailResponseSchema.parse(led.body).gang.leader?.labourerId).toBe(lead.id);
    const second = gangDetailResponseSchema.parse(
      (await pm.call("post", "labour/gangs", { projectId: p1, name: "Gang B: steel" })).body,
    ).gang;
    const twice = await pm.call("post", `labour/gangs/${second.id}/members`, {
      labourerId: member.id,
    });
    expect([twice.status, problem(twice)]).toEqual([409, "already-in-gang"]);
    const detail = gangDetailResponseSchema.parse(led.body);
    const leadership = detail.members.find((entry) => entry.labourerId === lead.id)!;
    const leaderLeaves = await pm.call(
      "post",
      `labour/gangs/${gang.id}/members/${leadership.membershipId}/leave`,
      {},
    );
    expect([leaderLeaves.status, problem(leaderLeaves)]).toEqual([409, "leader-must-change"]);
    const membership = detail.members.find((entry) => entry.labourerId === member.id)!;
    const left = await pm.call(
      "post",
      `labour/gangs/${gang.id}/members/${membership.membershipId}/leave`,
      { leftOn: today },
    );
    const afterLeave = gangDetailResponseSchema.parse(left.body);
    expect(
      afterLeave.members.find((entry) => entry.membershipId === membership.membershipId),
    ).toMatchObject({ leftOn: today, current: false });
    expect(afterLeave.gang.memberCount).toBe(1);
    expect(
      (await pm.call("post", `labour/gangs/${second.id}/members`, { labourerId: member.id }))
        .status,
    ).toBe(201);
    // Ending the leader's engagement closes the membership and clears the leader.
    const leadDetail = labourer(await pm.call("get", `labour/labourers/${lead.id}`));
    const ended = await pm.call(
      "post",
      `labour/labourers/${lead.id}/engagements/${leadDetail.engagements[0]!.id}/end`,
      { endDate: today, reason: "Contract finished" },
    );
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(labourer(ended).gangHistory[0]).toMatchObject({ leftOn: today });
    const gangNow = gangDetailResponseSchema.parse(
      (await agent.call("get", `labour/gangs/${gang.id}`)).body,
    );
    expect(gangNow).toMatchObject({ canManage: false, gang: { leader: null, memberCount: 0 } });
    const archive = await agent.call("patch", `labour/gangs/${gang.id}`, {
      status: "archived",
      version: gangNow.gang.version,
    });
    expect(archive.status).toBe(403);
    const archived = await pm.call("patch", `labour/gangs/${gang.id}`, {
      status: "archived",
      version: gangNow.gang.version,
    });
    expect(archived.status).toBe(200);
    const list = gangsResponseSchema.parse((await agent.call("get", "labour/gangs")).body);
    expect(list.gangs.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["Gang A: masonry", "Gang B: steel"]),
    );
    expect(list.manageableProjectIds).toEqual([]);
    // The database refuses a member who is not engaged, and a second open gang on a project.
    await expect(
      db.run(as(owner, tenantA, "gang-rules"), (tx) =>
        tx.gangMembership.create({
          data: {
            tenantId: tenantA,
            projectId: p1,
            gangId: second.id,
            labourerId: onP2.id,
            joinedOn: new Date(`${today}T00:00:00Z`),
            addedBy: owner.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("scopes labourers to the caller's projects and permissions", async () => {
    const onlyP2 = labourer(await register(owner, person({ projectId: p2 })));
    const agentList = labourersResponseSchema.parse(
      (await agent.call("get", "labour/labourers?limit=500")).body,
    );
    expect(agentList.labourers.map((row) => row.id)).not.toContain(onlyP2.id);
    expect(agentList.permissions).toEqual({
      canRegister: false,
      canFlag: false,
      canConfigure: false,
    });
    expect((await agent.call("get", `labour/labourers/${onlyP2.id}`)).status).toBe(404);
    expect((await pm.call("get", `labour/labourers/${onlyP2.id}`)).status).toBe(404);
    expect((await agent.call("post", "labour/labourers", person())).status).toBe(403);
    expect((await pm.call("post", "labour/labourers", person({ projectId: p2 }))).status).toBe(403);
    expect(
      (await pm.call("post", "labour/labourers", person({ projectId: undefined }))).status,
    ).toBe(403);
    const target = registered["WRK-0001"]!;
    const current = labourer(await agent.call("get", `labour/labourers/${target.id}`));
    expect(current.permissions).toEqual({
      canManage: false,
      canReveal: false,
      canFlag: false,
      canConsent: true,
    });
    expect(
      (
        await agent.call("patch", `labour/labourers/${target.id}`, {
          version: current.version,
          fullName: "Hijack",
        })
      ).status,
    ).toBe(403);
    const ownerList = labourersResponseSchema.parse(
      (await owner.call("get", `labour/labourers?projectId=${p2}&limit=500`)).body,
    );
    expect(ownerList.labourers.map((row) => row.id)).toContain(onlyP2.id);
    expect(ownerList.permissions).toEqual({ canRegister: true, canFlag: true, canConfigure: true });
    const paged = labourersResponseSchema.parse(
      (await owner.call("get", "labour/labourers?limit=2&offset=1")).body,
    );
    expect(paged.labourers).toHaveLength(2);
    expect(paged.total).toBeGreaterThan(5);
  });

  it("updates details with versions, re-encrypting corrected identifiers", async () => {
    const worker = labourer(await register(pm, person()));
    const updated = await pm.call("patch", `labour/labourers/${worker.id}`, {
      version: worker.version,
      fullName: "Corrected Mtihani Name",
      idType: "passport",
      idNumber: "ak 9900001",
      phone: null,
      tradeId: trade("plumber"),
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(labourer(updated)).toMatchObject({
      fullName: "Corrected Mtihani Name",
      idType: "passport",
      idNumberMasked: "•••••001",
      phoneMasked: null,
      version: worker.version + 1,
    });
    const found = labourersResponseSchema.parse(
      (await pm.call("get", "labour/labourers?search=AK9900001")).body,
    );
    expect(found.labourers.map((row) => row.id)).toEqual([worker.id]);
    const stalePatch = await pm.call("patch", `labour/labourers/${worker.id}`, {
      version: worker.version,
      fullName: "Stale",
    });
    expect([stalePatch.status, problem(stalePatch)]).toEqual([409, "version-conflict"]);
    const duplicate = await pm.call("patch", `labour/labourers/${worker.id}`, {
      version: worker.version + 1,
      idType: "national_id",
      idNumber: "98000001",
    });
    expect([duplicate.status, problem(duplicate)]).toEqual([409, "duplicate-identity"]);
    const event = (await auditEvents()).find(
      (entry) => entry.action === "labourer.updated" && entry.resourceId === worker.id,
    );
    expect(event?.metadata).toEqual({
      fields: ["fullName", "idNumber", "idType", "phone", "tradeId"],
    });
  });

  it("changes status: leaving ends engagements; reactivating needs consent", async () => {
    const worker = labourer(await register(pm, person()));
    const left = await pm.call("post", `labour/labourers/${worker.id}/status`, {
      to: "left",
      reason: "Moved to another contractor",
      version: worker.version,
    });
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect(labourer(left)).toMatchObject({ status: "left", projects: [] });
    expect(labourer(left).engagements[0]).toMatchObject({ open: false, endDate: today });
    const back = await pm.call("post", `labour/labourers/${worker.id}/engagements`, {
      projectId: p1,
    });
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    expect(labourer(back).status).toBe("active");
    const same = await pm.call("post", `labour/labourers/${worker.id}/status`, {
      to: "active",
      version: labourer(back).version,
    });
    expect([same.status, problem(same)]).toEqual([409, "invalid-status-change"]);
  });

  it("keeps saved views private per user and hides the do-not-rehire view from non-managers", async () => {
    const saved = await owner.call("post", "labour/views", {
      name: "Masons on site",
      filters: { tradeId: trade("mason"), status: "active" },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const viewId = (saved.body as { view: { id: string } }).view.id;
    const duplicate = await owner.call("post", "labour/views", {
      name: "Masons on site",
      filters: {},
    });
    expect([duplicate.status, problem(duplicate)]).toEqual([409, "view-name-taken"]);
    expect(
      (await owner.call("post", "labour/views", { name: "Paged", filters: { limit: 5 } })).status,
    ).toBe(400);
    const ownerViews = labourViewsResponseSchema.parse(
      (await owner.call("get", "labour/views")).body,
    );
    expect(ownerViews.views.map((view) => view.id)).toEqual([
      "all",
      "active",
      "attention",
      "doNotRehire",
      viewId,
    ]);
    const pmViews = labourViewsResponseSchema.parse((await pm.call("get", "labour/views")).body);
    expect(pmViews.views.map((view) => view.id)).toEqual([
      "all",
      "active",
      "attention",
      "doNotRehire",
    ]);
    const agentViews = labourViewsResponseSchema.parse(
      (await agent.call("get", "labour/views")).body,
    );
    expect(agentViews.views.map((view) => view.id)).toEqual(["all", "active", "attention"]);
    expect((await pm.call("delete", `labour/views/${viewId}`)).status).toBe(404);
    const otherUser = await db.run(as(pm, tenantA, "views"), (tx) =>
      tx.labourSavedView.findMany({ where: { id: viewId } }),
    );
    expect(otherUser).toEqual([]);
    expect((await owner.call("delete", `labour/views/${viewId}`)).status).toBe(200);
  });

  it("isolates company B from company A's labour data on every new table", async () => {
    const worker = registered["WRK-0001"]!;
    const full = labourer(await owner.call("get", `labour/labourers/${worker.id}`));
    const gangs = gangsResponseSchema.parse((await owner.call("get", "labour/gangs")).body).gangs;
    const gang = gangs[0]!;
    const gangDetail = gangDetailResponseSchema.parse(
      (await owner.call("get", `labour/gangs/${gang.id}`)).body,
    );
    const rates = labourRatesResponseSchema.parse(
      (await owner.call("get", `labour/rates?projectId=${p1}`)).body,
    ).rates;
    const view = await owner.call("post", "labour/views", { name: "A only", filters: {} });
    const viewId = (view.body as { view: { id: string } }).view.id;
    await fresh(ownerB);
    const guesses: [Method, string, object?][] = [
      ["get", `labour/labourers/${worker.id}`],
      ["patch", `labour/labourers/${worker.id}`, { version: full.version, fullName: "Hijack" }],
      ["post", `labour/labourers/${worker.id}/status`, { to: "inactive", version: full.version }],
      [
        "post",
        `labour/labourers/${worker.id}/reveal`,
        { field: "idNumber", purpose: "payroll_setup" },
      ],
      [
        "put",
        `labour/labourers/${worker.id}/do-not-rehire`,
        { flagged: true, reason: "Cross-company hijack attempt", version: full.version },
      ],
      [
        "post",
        `labour/labourers/${worker.id}/accreditations`,
        { category: "nca_skilled_worker", cardNumber: "X-1", expiresOn: "2030-01-01" },
      ],
      [
        "patch",
        `labour/labourers/${worker.id}/accreditations/${full.accreditations[0]!.id}`,
        { cardNumber: "X-2", version: 1 },
      ],
      ["delete", `labour/labourers/${worker.id}/accreditations/${full.accreditations[0]!.id}`],
      [
        "post",
        `labour/labourers/${worker.id}/consents`,
        {
          noticeVersion: CURRENT_CONSENT_NOTICE.version,
          language: "en",
          method: "signed",
          granted: true,
        },
      ],
      ["post", `labour/labourers/${worker.id}/consents/withdraw`, { method: "signed" }],
      ["post", `labour/labourers/${worker.id}/engagements`, { projectId: p1 }],
      [
        "post",
        `labour/labourers/${worker.id}/engagements/${full.engagements[0]!.id}/end`,
        { endDate: today },
      ],
      ["get", `labour/labourers/${worker.id}/rate?projectId=${p1}`],
      ["get", `labour/gangs/${gang.id}`],
      ["patch", `labour/gangs/${gang.id}`, { name: "Hijack", version: gang.version }],
      ["post", `labour/gangs/${gang.id}/members`, { labourerId: worker.id }],
      ["post", `labour/gangs/${gang.id}/members/${gangDetail.members[0]!.membershipId}/leave`, {}],
      ["post", "labour/gangs", { projectId: p1, name: "Hijack gang" }],
      ["delete", `labour/rates/${rates[0]!.id}`],
      [
        "post",
        "labour/rates",
        {
          projectId: p1,
          tradeId: trade("mason"),
          basis: "daily",
          rateMinor: 1,
          effectiveFrom: today,
        },
      ],
      ["patch", `labour/trades/${trade("mason")}`, { nameEn: "Hijack", version: 1 }],
      ["patch", `labour/skill-levels/${level("skilled")}`, { nameEn: "Hijack", version: 1 }],
      ["delete", `labour/views/${viewId}`],
    ];
    for (const [method, path, body] of guesses) {
      const res = await ownerB.call(method, path, body);
      expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBe(404);
    }
    // Company B's register with A's trade: A's IDs are invisible.
    const foreignTrade = await ownerB.call("post", "labour/labourers", {
      ...person({ projectId: undefined }),
      tradeId: trade("mason"),
      skillLevelId: level("skilled", setupB),
    });
    expect(foreignTrade.status).toBe(404);
    const bList = labourersResponseSchema.parse(
      (await ownerB.call("get", "labour/labourers")).body,
    );
    expect(bList.labourers.map((row) => row.id)).not.toContain(worker.id);
    expect(
      labourersResponseSchema.parse(
        (await ownerB.call("get", "labour/labourers?search=98000001")).body,
      ).labourers,
    ).toEqual([]);
    expect(
      gangsResponseSchema.parse((await ownerB.call("get", "labour/gangs")).body).gangs,
    ).toEqual([]);

    const inB = as(ownerB, tenantB, "cross-tenant-labour");
    await db.run(inB, async (tx) => {
      expect(await tx.labourer.findMany({ where: { id: worker.id } })).toEqual([]);
      expect(await tx.trade.findMany({ where: { tenantId: tenantA } })).toEqual([]);
      expect(await tx.skillLevel.findMany({ where: { tenantId: tenantA } })).toEqual([]);
      expect(await tx.labourSettings.findMany({ where: { tenantId: tenantA } })).toEqual([]);
      expect(await tx.labourEngagement.findMany({ where: { labourerId: worker.id } })).toEqual([]);
      expect(await tx.labourerConsent.findMany({ where: { labourerId: worker.id } })).toEqual([]);
      expect(await tx.labourerAccreditation.findMany({ where: { labourerId: worker.id } })).toEqual(
        [],
      );
      expect(await tx.doNotRehireEvent.findMany({ where: { tenantId: tenantA } })).toEqual([]);
      expect(await tx.labourRate.findMany({ where: { tenantId: tenantA } })).toEqual([]);
      expect(await tx.gang.findMany({ where: { id: gang.id } })).toEqual([]);
      expect(await tx.gangMembership.findMany({ where: { gangId: gang.id } })).toEqual([]);
      expect(await tx.labourSavedView.findMany({ where: { id: viewId } })).toEqual([]);
      expect(
        await tx.labourer.updateMany({ where: { id: worker.id }, data: { fullName: "Hijack" } }),
      ).toEqual({ count: 0 });
    });
    const userB = ownerB.auth.user.id;
    const bLabourer = await db.run(inB, (tx) =>
      tx.labourer.findFirstOrThrow({ where: { tenantId: tenantB }, select: { id: true } }),
    );
    const attempts: [string, (tx: Prisma.TransactionClient) => Promise<unknown>][] = [
      [
        "trade in A",
        (tx) =>
          tx.trade.create({
            data: { tenantId: tenantA, key: "x_trade", nameEn: "X", nameSw: "X", createdBy: userB },
          }),
      ],
      [
        "skill level in A",
        (tx) =>
          tx.skillLevel.create({
            data: {
              tenantId: tenantA,
              key: "x_level",
              nameEn: "X",
              nameSw: "X",
              ncaCategory: "skilled",
              createdBy: userB,
            },
          }),
      ],
      [
        "settings of A",
        (tx) => tx.labourSettings.create({ data: { tenantId: tenantA, updatedBy: userB } }),
      ],
      [
        "labourer in A",
        (tx) =>
          tx.labourer.create({
            data: {
              id: uuidv7(),
              tenantId: tenantA,
              workerNo: "WRK-8888",
              fullName: "Cross Tenant",
              dateOfBirth: new Date("1990-01-01T00:00:00Z"),
              gender: "male",
              tradeId: trade("mason"),
              skillLevelId: level("skilled"),
              engagementType: "casual",
              idType: "national_id",
              idNumberEnc: envelope(),
              idNumberBidx: hex64(8888),
              registeredOn: new Date(),
              createdBy: userB,
            },
          }),
      ],
      [
        "B labourer with A's trade",
        (tx) =>
          tx.labourer.update({
            where: { tenantId_id: { tenantId: tenantB, id: bLabourer.id } },
            data: { tradeId: trade("mason") },
          }),
      ],
      [
        "engagement of A's labourer",
        (tx) =>
          tx.labourEngagement.create({
            data: {
              tenantId: tenantB,
              labourerId: worker.id,
              projectId: p1,
              startDate: new Date(),
              createdBy: userB,
            },
          }),
      ],
      [
        "B engagement on A's project",
        (tx) =>
          tx.labourEngagement.create({
            data: {
              tenantId: tenantB,
              labourerId: bLabourer.id,
              projectId: p1,
              startDate: new Date(),
              createdBy: userB,
            },
          }),
      ],
      [
        "consent for A's labourer",
        (tx) =>
          tx.labourerConsent.create({
            data: {
              tenantId: tenantB,
              labourerId: worker.id,
              kind: "registration_data",
              noticeVersion: CURRENT_CONSENT_NOTICE.version,
              noticeDigest: CURRENT_CONSENT_NOTICE.digests.en,
              language: "en",
              method: "signed",
              granted: true,
              capturedBy: userB,
            },
          }),
      ],
      [
        "accreditation for A's labourer",
        (tx) =>
          tx.labourerAccreditation.create({
            data: {
              tenantId: tenantB,
              labourerId: worker.id,
              category: "nca_skilled_worker",
              cardNumber: "XX-1",
              expiresOn: new Date(),
              createdBy: userB,
            },
          }),
      ],
      [
        "do-not-rehire event on A's labourer",
        (tx) =>
          tx.doNotRehireEvent.create({
            data: {
              tenantId: tenantB,
              labourerId: worker.id,
              action: "set",
              reasonEnc: envelope(),
              actorId: userB,
            },
          }),
      ],
      [
        "rate with A's trade",
        (tx) =>
          tx.labourRate.create({
            data: {
              tenantId: tenantB,
              tradeId: trade("mason"),
              basis: "daily",
              rateMinor: 1n,
              effectiveFrom: new Date(`${today}T00:00:00Z`),
              createdBy: userB,
            },
          }),
      ],
      [
        "gang on A's project",
        (tx) =>
          tx.gang.create({
            data: { tenantId: tenantB, projectId: p1, name: "XX", createdBy: userB },
          }),
      ],
      [
        "membership in A's gang",
        (tx) =>
          tx.gangMembership.create({
            data: {
              tenantId: tenantB,
              projectId: p1,
              gangId: gang.id,
              labourerId: bLabourer.id,
              joinedOn: new Date(),
              addedBy: userB,
            },
          }),
      ],
      [
        "saved view for A's member",
        (tx) =>
          tx.labourSavedView.create({
            data: { tenantId: tenantA, userId: owner.auth.user.id, name: "XX", filters: {} },
          }),
      ],
      [
        "saved view for another user",
        (tx) =>
          tx.labourSavedView.create({
            data: { tenantId: tenantB, userId: owner.auth.user.id, name: "XX", filters: {} },
          }),
      ],
    ];
    for (const [label, write] of attempts)
      await expect(db.run(inB, write), label).rejects.toThrow();
  });

  it("keeps plaintext identifiers out of the audit log", async () => {
    const events = await auditEvents();
    const labourEvents = events.filter(
      (event) =>
        event.action.startsWith("labourer.") ||
        event.action.startsWith("labour.") ||
        event.action.startsWith("gang."),
    );
    expect(labourEvents.length).toBeGreaterThan(20);
    const serialised = JSON.stringify(labourEvents);
    for (const value of plaintexts) expect(serialised).not.toContain(value);
    expect(serialised).not.toMatch(/Mama Mtihani|Kevin Mtihani/);
    const registration = events.find(
      (event) =>
        event.action === "labourer.registered" && event.resourceId === registered["WRK-0001"]!.id,
    );
    expect(registration?.metadata).toEqual({
      workerNo: "WRK-0001",
      projectId: p1,
      recorded: [
        "accreditation",
        "homeCounty",
        "kraPin",
        "nextOfKin",
        "nssfNumber",
        "phone",
        "shaNumber",
      ],
      consent: {
        noticeVersion: CURRENT_CONSENT_NOTICE.version,
        language: "sw",
        method: "witnessed_verbal",
      },
      doNotRehireOverride: false,
    });
  });
});
