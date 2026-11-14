import { randomInt, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import { CURRENT_CONSENT_NOTICE, DEFAULT_PPE_REPLACEMENT_DAYS } from "@pm-buddy/types";
import {
  correctiveActionResponseSchema,
  correctiveActionsResponseSchema,
  firstAiderResponseSchema,
  firstAidKitResponseSchema,
  firstAidResponseSchema,
  gangDetailResponseSchema,
  incidentDetailResponseSchema,
  incidentsResponseSchema,
  inductionResponseSchema,
  inductionStatusResponseSchema,
  labourerResponseSchema,
  labourSetupResponseSchema,
  musterResponseSchema,
  ppeIssueResponseSchema,
  ppeIssuesResponseSchema,
  projectResponseSchema,
  safetyOptionsResponseSchema,
  safetyOverviewResponseSchema,
  safetySettingsResponseSchema,
  safetySummaryResponseSchema,
  siteResponseSchema,
  sitePhotoResponseSchema,
  tenantCreatedResponseSchema,
  toolboxTalkResponseSchema,
  treatmentResponseSchema,
  type CorrectiveAction,
  type IncidentDetailResponse,
} from "@pm-buddy/validation";
import { PrismaPg } from "@prisma/adapter-pg";
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
 * D8.2 health and safety against the real database as the runtime role (pmb_app): the incident →
 * investigation → corrective action → done → verified → closed flow, a closed incident locked in
 * the database for every caller, maker-checker on corrective actions in the API and in SQL,
 * induction flags read from attendance, toolbox talks locked once confirmed, the PPE register,
 * first aid, personal data restricted to safety.manage and absent from the audit log, tenant
 * isolation (RLS) and permission refusals (a client, a labourer and a QS refused).
 */
describe("Health and safety (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let manager: Browser;
  let agent: Browser;
  let foreman: Browser;
  let surveyor: Browser;
  let client: Browser;
  let worker: Browser;
  let outsider: Browser;
  let tenantId: string;
  let otherTenant: string;
  let projectId: string;
  let siteId: string;
  let otherSite: string;
  const labourers: string[] = [];
  let notificationSpy: ReturnType<typeof vi.spyOn>;
  const today = nairobiDate();
  const yesterday = addCalendarDays(today, -1);
  const base = (project = projectId) => `projects/${project}/safety`;
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
  const join = async (member: Browser, role: string, permissions: string[]) => {
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
    await fresh();
    expect(
      (
        await owner.call("put", `projects/${projectId}/members/${member.auth.user.id}`, {
          permissions,
        })
      ).status,
    ).toBe(200);
  };
  const site = async (project: string, name: string) =>
    ok(
      await owner.call("post", `projects/${project}/sites`, {
        name,
        geofence: { kind: "radius", center: { lat: -1.1489, lng: 36.9612 }, radiusM: 60 },
      }),
      (body) => siteResponseSchema.parse(body).site.id,
      201,
    );
  const photo = async (browser: Browser, target = siteId) => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/photos`)
      .set("Cookie", [...browser.cookies].map(([key, value]) => `${key}=${value}`).join("; "))
      .set("Origin", origin)
      .set("X-CSRF-Token", browser.csrf)
      .field("siteId", target)
      .attach("file", await jpegWithExif({ make: randomUUID().slice(0, 20) }), "IMG.jpg");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return sitePhotoResponseSchema.parse(res.body).photo.id;
  };
  const incident = (res: request.Response, status = 200) =>
    ok(res, (body) => incidentDetailResponseSchema.parse(body), status);
  const action = (res: request.Response, status = 200) =>
    ok(res, (body) => correctiveActionResponseSchema.parse(body).action, status);
  const report = async (extra: object = {}, browser = foreman) =>
    incident(
      await browser.call("post", `${base()}/incidents`, {
        siteId,
        kind: "injury",
        severity: "moderate",
        occurredAt: `${today}T08:15:00+03:00`,
        location: "Block A scaffold, second lift",
        description: `Synthetic slip on wet boards ${randomUUID().slice(0, 8)}`,
        immediateActions: "Area cordoned off and boards dried",
        firstAidGiven: true,
        people: [
          { role: "injured", labourerId: labourers[0], injuryType: "sprain", bodyPart: "foot" },
          { role: "witness", name: "Synthetic Witness Wanjiku" },
        ],
        ...extra,
      }),
      201,
    );
  const raise = async (
    detail: IncidentDetailResponse,
    ownerBrowser: Browser,
    dueOn = addCalendarDays(today, 7),
  ) =>
    action(
      await manager.call("post", `${base()}/corrective-actions`, {
        source: "incident",
        incidentId: detail.incident.id,
        description: `Fit toe boards and handrails ${randomUUID().slice(0, 6)}`,
        ownerId: ownerBrowser.auth.user.id,
        dueOn,
      }),
      201,
    );
  const act = (target: CorrectiveAction, verb: string, browser: Browser, extra: object = {}) =>
    browser.call("post", `${base()}/corrective-actions/${target.id}/actions`, {
      version: target.version,
      action: verb,
      ...extra,
    });
  const reload = async (detail: IncidentDetailResponse, browser = manager) =>
    incident(await browser.call("get", `${base()}/incidents/${detail.incident.id}`));

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
    agent = new Browser(app);
    foreman = new Browser(app);
    surveyor = new Browser(app);
    client = new Browser(app);
    worker = new Browser(app);
    outsider = new Browser(app);
    for (const browser of [owner, manager, agent, foreman, surveyor, client, outsider])
      await browser.register();
    await worker.initialize();
    for (const browser of [owner, outsider, manager]) await browser.enroll();
    tenantId = tenantCreatedResponseSchema.parse(
      (await owner.call("post", "tenants", { name: `Safety company ${randomUUID()}` })).body,
    ).tenant.id;
    otherTenant = tenantCreatedResponseSchema.parse(
      (await outsider.call("post", "tenants", { name: `Other safety company ${randomUUID()}` }))
        .body,
    ).tenant.id;
    await fresh();
    projectId = projectResponseSchema.parse(
      (await owner.call("post", "projects", { name: "Safety project" })).body,
    ).project.id;
    siteId = await site(projectId, "Main plot");
    otherSite = await site(projectId, "Materials yard");
    await join(manager, "project_manager", [
      "projects.view",
      "projects.manage",
      "safety.manage",
      "site.diary",
      "site.photos",
      "labour.view",
    ]);
    await join(agent, "site_agent", [
      "projects.view",
      "site.diary",
      "site.photos",
      "safety.manage",
      "labour.view",
    ]);
    // A foreman reports and records but never investigates, verifies or sees injury details.
    await join(foreman, "foreman", ["projects.view", "site.diary", "site.photos", "labour.view"]);
    // A quantity surveyor works on the project but holds no site permission.
    await join(surveyor, "quantity_surveyor", ["projects.view", "bq.view", "reports.view"]);
    await join(client, "client", ["projects.view", "portal.client"]);
    // A labourer joins from their invitation link with a PIN (the worker portal only).
    const number = `2547${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;
    await fresh();
    expect(
      (
        await owner.call("post", `projects/${projectId}/labourers/invitations`, {
          identifier: number,
        })
      ).status,
    ).toBe(201);
    const token = notifications
      .get(number)
      ?.at(-1)
      ?.text.match(/token=([A-Za-z0-9_-]{43})/)?.[1];
    const joined = await worker.call("post", "auth/pin/join", {
      identifier: number,
      token,
      displayName: "Synthetic Kibarua",
      pin: "274915",
    });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    await fresh(manager);

    const setup = labourSetupResponseSchema.parse(
      (await owner.call("post", "labour/setup/defaults", {})).body,
    );
    const trade = setup.trades.find((entry) => entry.key === "mason")!.id;
    const level = setup.skillLevels.find((entry) => entry.key === "skilled")!.id;
    for (let index = 0; index < 4; index += 1) {
      await fresh();
      const res = await owner.call("post", "labour/labourers", {
        fullName: `Mfanyakazi Usalama ${randomUUID().slice(0, 6)}`,
        dateOfBirth: "1991-03-09",
        gender: "male",
        tradeId: trade,
        skillLevelId: level,
        engagementType: "casual",
        rateBasis: "daily",
        idType: "national_id",
        idNumber: String(60_000_000 + Math.floor(Math.random() * 9_999_999)),
        projectId,
        engagementStartDate: addCalendarDays(today, -60),
        consent: {
          noticeVersion: CURRENT_CONSENT_NOTICE.version,
          language: "en",
          method: "signed",
          granted: true,
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      labourers.push(labourerResponseSchema.parse(res.body).labourer.id);
    }
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("publishes every safety operation and refuses requests without a session or CSRF token", async () => {
    const spec = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (spec.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((entry) => Object.values(entry).map((operation) => operation.operationId));
    for (const name of [
      "getSafetySettings",
      "updateSafetySettings",
      "getSafetyOverview",
      "getSafetySummary",
      "getSafetyOptions",
      "listInductions",
      "createInduction",
      "voidInduction",
      "getInductionStatus",
      "listToolboxTalks",
      "createToolboxTalk",
      "getToolboxTalk",
      "updateToolboxTalk",
      "transitionToolboxTalk",
      "listPpeIssues",
      "issuePpe",
      "returnPpe",
      "voidPpeIssue",
      "listIncidents",
      "reportIncident",
      "getIncident",
      "updateIncident",
      "investigateIncident",
      "recordRegulatorDecision",
      "closeIncident",
      "voidIncident",
      "addIncidentPhotos",
      "listCorrectiveActions",
      "createCorrectiveAction",
      "getCorrectiveAction",
      "updateCorrectiveAction",
      "transitionCorrectiveAction",
      "getFirstAid",
      "createFirstAidKit",
      "recordKitCheck",
      "retireFirstAidKit",
      "addFirstAider",
      "removeFirstAider",
      "recordTreatment",
      "voidTreatment",
      "linkTreatment",
    ])
      expect(operations, name).toContain(name);
    expect(
      (await new Browser(app).call("get", `${base()}/incidents`, undefined, false)).status,
    ).toBe(401);
    expect((await agent.call("post", `${base()}/incidents`, {}, false)).status).toBe(403);
  });

  it("runs incident → investigation → corrective actions → done → verified → closed, then locks it", async () => {
    const evidence = await photo(foreman);
    let detail = await report({ severity: "serious", photoIds: [evidence] });
    expect(detail.incident).toMatchObject({
      code: "INC-0001",
      status: "reported",
      kind: "injury",
      peopleCounts: { injured: 1, involved: 0, witness: 1 },
      regulator: { state: "required" },
      closeBlockers: ["not_investigated", "no_verified_action", "regulator_decision_required"],
    });
    // The reporter (no safety.manage) sees counts, not who was hurt or how.
    expect(detail.incident.people).toBeNull();
    expect(detail.incident.permissions).toMatchObject({
      canInvestigate: false,
      canSeePeople: false,
    });
    expect(detail.incident.photos.map((entry) => entry.id)).toEqual([evidence]);
    problem(
      await foreman.call("post", `${base()}/incidents/${detail.incident.id}/investigation`, {
        version: detail.incident.version,
        rootCauseCategory: "unsafe_condition",
        rootCause: "Boards were wet and had no toe boards",
      }),
      403,
    );
    detail = await reload(detail);
    expect(detail.incident.people?.map((person) => person.role)).toEqual(["injured", "witness"]);
    expect(detail.incident.people?.[0]).toMatchObject({ injuryType: "sprain", bodyPart: "foot" });

    // Corrective actions can be raised once reported; closing waits for the investigation.
    const toeBoards = await raise(detail, agent);
    const briefing = await raise(detail, manager);
    expect(toeBoards).toMatchObject({ code: "CA-0001", status: "open", source: "incident" });
    // The owner must be able to read safety records on the project.
    problem(
      await manager.call("post", `${base()}/corrective-actions`, {
        source: "incident",
        incidentId: detail.incident.id,
        description: "Owned by the quantity surveyor",
        ownerId: surveyor.auth.user.id,
        dueOn: addCalendarDays(today, 3),
      }),
      422,
      "staff-not-on-project",
    );
    detail = incident(
      await manager.call("post", `${base()}/incidents/${detail.incident.id}/investigation`, {
        version: detail.incident.version,
        rootCauseCategory: "unsafe_condition",
        rootCause: "Boards were wet after rain and the lift had no toe boards",
        contributingFactors: "Morning briefing skipped",
      }),
    );
    expect(detail.incident.status).toBe("investigated");
    problem(
      await manager.call("post", `${base()}/incidents/${detail.incident.id}/close`, {
        version: detail.incident.version,
      }),
      409,
      "incident-close-blocked",
    );

    // Done only by the owner; verified only by someone else.
    problem(await act(toeBoards, "done", manager), 403, "action-owner-only");
    let done = action(
      await act(toeBoards, "done", agent, { note: "Toe boards fitted on all lifts" }),
    );
    expect(done.permissions).toMatchObject({ canVerify: false, canReject: false });
    problem(await act(done, "verify", agent), 403, "action-independent-verification");
    // A rejection sends it back to the owner with a reason.
    const rejected = action(
      await act(done, "reject", manager, { reason: "Lift 3 still has no toe board" }),
    );
    expect(rejected).toMatchObject({ status: "open", rejectCount: 1, doneBy: null });
    done = action(await act(rejected, "done", agent));
    const verified = action(await act(done, "verify", manager));
    expect(verified).toMatchObject({
      status: "verified",
      verifiedBy: { id: manager.auth.user.id },
    });
    const managerDone = action(await act(briefing, "done", manager));
    problem(await act(managerDone, "verify", manager), 403, "action-independent-verification");
    action(await act(managerDone, "verify", agent));

    // A serious injury needs the regulator decision before closing (COMPLIANCE-REVIEW).
    detail = await reload(detail);
    expect(detail.incident.closeBlockers).toEqual(["regulator_decision_required"]);
    expect(detail.incident.permissions.canClose).toBe(false);
    problem(
      await manager.call("post", `${base()}/incidents/${detail.incident.id}/regulator`, {
        version: detail.incident.version,
        decision: "notified",
        notifiedOn: addCalendarDays(today, 1),
      }),
      409,
      "safety-date-future",
    );
    detail = incident(
      await manager.call("post", `${base()}/incidents/${detail.incident.id}/regulator`, {
        version: detail.incident.version,
        decision: "notified",
        notifiedOn: today,
        reference: "DOSH/SYN/0001",
      }),
    );
    expect(detail.incident.regulator).toMatchObject({ state: "notified", notifiedOn: today });
    // A first-aid treatment linked while the incident is open.
    const treatment = ok(
      await foreman.call("post", `${base()}/first-aid/treatments`, {
        siteId,
        treatedAt: `${today}T08:30:00+03:00`,
        labourerId: labourers[0],
        injuryType: "sprain",
        treatment: "cold_compress",
        referral: "clinic",
        incidentId: detail.incident.id,
      }),
      (body) => treatmentResponseSchema.parse(body).treatment,
      201,
    );
    expect(treatment).toMatchObject({ restricted: true, labourer: null, injuryType: null });
    detail = await reload(detail);
    expect(detail.treatments).toHaveLength(1);
    detail = incident(
      await manager.call("post", `${base()}/incidents/${detail.incident.id}/close`, {
        version: detail.incident.version,
        closureNote: "Toe boards fitted; briefing reinstated",
      }),
    );
    expect(detail.incident).toMatchObject({
      status: "closed",
      closeBlockers: [],
      actionCounts: { verified: 2, open: 0, done: 0 },
      closedBy: { id: manager.auth.user.id },
    });
    expect(detail.incident.permissions).toMatchObject({
      canEdit: false,
      canClose: false,
      canRaiseAction: false,
      canAddPhotos: false,
    });

    // Locked through the API…
    problem(
      await manager.call("patch", `${base()}/incidents/${detail.incident.id}`, {
        version: detail.incident.version,
        description: "Rewritten after closing the incident",
      }),
      409,
      "incident-not-open",
    );
    problem(
      await manager.call("post", `${base()}/corrective-actions`, {
        source: "incident",
        incidentId: detail.incident.id,
        description: "Late action on a closed incident",
        ownerId: agent.auth.user.id,
        dueOn: addCalendarDays(today, 3),
      }),
      409,
      "incident-not-open",
    );
    problem(
      await manager.call("post", `${base()}/first-aid/treatments/${treatment.id}/void`, {
        version: treatment.version,
        reason: "Entered twice by mistake",
      }),
      409,
      "incident-not-open",
    );
    // …and in the database, for the runtime role and the schema owner alike.
    const id = detail.incident.id;
    await expect(
      db.run(context(manager), (tx) =>
        tx.safetyIncident.updateMany({
          where: { id },
          data: { description: "Rewritten in SQL after closing", version: { increment: 1 } },
        }),
      ),
    ).rejects.toThrow(/locked/);
    await expect(
      db.run(context(manager), (tx) =>
        tx.safetyIncidentPerson.deleteMany({ where: { incidentId: id } }),
      ),
    ).rejects.toThrow(/open/);
    await expect(
      db.run(context(manager), (tx) =>
        tx.correctiveAction.updateMany({
          where: { incidentId: id },
          data: { description: "Changed after verification", version: { increment: 1 } },
        }),
      ),
    ).rejects.toThrow(/locked|final/);
    const schemaOwner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrls().migrationUrl }),
    });
    try {
      for (const statement of [
        `UPDATE safety_incidents SET location = 'Elsewhere', version = version + 1 WHERE id = '${id}'`,
        `UPDATE safety_incidents SET status = 'investigated', closed_by = NULL, closed_at = NULL, closure_note = NULL, version = version + 1 WHERE id = '${id}'`,
        `DELETE FROM safety_incidents WHERE id = '${id}'`,
      ])
        await expect(
          schemaOwner.$transaction([
            schemaOwner.$executeRawUnsafe(
              `SELECT set_config('app.tenant_id', '${tenantId}', true), set_config('app.user_id', '${manager.auth.user.id}', true)`,
            ),
            schemaOwner.$executeRawUnsafe(statement),
          ]),
        ).rejects.toThrow(/locked|cannot be deleted/);
    } finally {
      await schemaOwner.$disconnect();
    }
    // Corrections after closure are a new incident that refers to it.
    const followUp = await report({ followUpOfId: id, severity: "minor" });
    expect(followUp.incident.followUpOf).toEqual({ id, code: "INC-0001" });
  });

  it("enforces maker-checker on corrective actions in the database, even from another trigger", async () => {
    let detail = await report({ kind: "near_miss", severity: "moderate", people: [] }, agent);
    const target = await raise(detail, agent);
    // The owner verifying their own action directly in SQL.
    await expect(
      db.run(context(agent), (tx) =>
        tx.correctiveAction.updateMany({
          where: { id: target.id },
          data: {
            status: "done",
            doneBy: agent.auth.user.id,
            updatedBy: agent.auth.user.id,
            version: { increment: 1 },
          },
        }),
      ),
    ).resolves.toMatchObject({ count: 1 });
    await expect(
      db.run(context(agent), (tx) =>
        tx.correctiveAction.updateMany({
          where: { id: target.id },
          data: {
            status: "verified",
            verifiedBy: agent.auth.user.id,
            updatedBy: agent.auth.user.id,
            version: { increment: 1 },
          },
        }),
      ),
    ).rejects.toThrow(/Someone other than the owner/);
    // Someone other than the owner marking an open action done.
    const second = await raise(detail, agent);
    await expect(
      db.run(context(manager), (tx) =>
        tx.correctiveAction.updateMany({
          where: { id: second.id },
          data: {
            status: "done",
            doneBy: manager.auth.user.id,
            updatedBy: manager.auth.user.id,
            version: { increment: 1 },
          },
        }),
      ),
    ).rejects.toThrow(/owner/);
    // Closing in SQL with an action still open.
    detail = incident(
      await manager.call("post", `${base()}/incidents/${detail.incident.id}/investigation`, {
        version: detail.incident.version,
        rootCauseCategory: "procedure_not_followed",
        rootCause: "Materials stacked against the hoarding without a check",
      }),
    );
    const incidentId = detail.incident.id;
    await expect(
      db.run(context(manager), (tx) =>
        tx.safetyIncident.updateMany({
          where: { id: incidentId },
          data: {
            status: "closed",
            closedBy: manager.auth.user.id,
            updatedBy: manager.auth.user.id,
            version: { increment: 1 },
          },
        }),
      ),
    ).rejects.toThrow(/verified or cancelled/);
    // Closing a serious injury in SQL without a regulator decision (no action needed, with a reason).
    let serious = await report({ severity: "serious" }, agent);
    serious = incident(
      await manager.call("post", `${base()}/incidents/${serious.incident.id}/investigation`, {
        version: serious.incident.version,
        rootCauseCategory: "unsafe_condition",
        rootCause: "Unlit stair core after the slab above was cast",
      }),
    );
    expect(serious.incident.closeBlockers).toEqual([
      "no_verified_action",
      "regulator_decision_required",
    ]);
    await expect(
      db.run(context(manager), (tx) =>
        tx.safetyIncident.updateMany({
          where: { id: serious.incident.id },
          data: {
            status: "closed",
            closedBy: manager.auth.user.id,
            noActionReason: "Lights were fitted the same day",
            updatedBy: manager.auth.user.id,
            version: { increment: 1 },
          },
        }),
      ),
    ).rejects.toThrow(/regulator decision/);
    // The people of an open incident change only through its guard; a delete issued from another
    // trigger is checked like a direct one (only a cascade from a deleted incident skips it).
    const closed = (await db.run(context(), (tx) =>
      tx.safetyIncident.findFirst({ where: { status: "closed" } }),
    ))!;
    await expect(
      db.run(context(manager), async (tx) => {
        await tx.$executeRawUnsafe("CREATE TEMP TABLE people_probe (id int) ON COMMIT DROP");
        await tx.$executeRawUnsafe(
          `CREATE FUNCTION pg_temp.people_probe_delete() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             DELETE FROM safety_incident_people WHERE incident_id = '${closed.id}'::uuid;
             RETURN NEW;
           END $$`,
        );
        await tx.$executeRawUnsafe(
          "CREATE TRIGGER people_probe AFTER INSERT ON people_probe FOR EACH ROW EXECUTE FUNCTION pg_temp.people_probe_delete()",
        );
        await tx.$executeRawUnsafe("INSERT INTO people_probe VALUES (1)");
      }),
    ).rejects.toThrow(/People change only while the incident is open/);
    expect(
      await db.run(context(), (tx) =>
        tx.safetyIncidentPerson.count({ where: { incidentId: closed.id } }),
      ),
    ).toBe(2);
    // Voiding needs the outstanding actions cancelled first.
    problem(
      await manager.call("post", `${base()}/incidents/${incidentId}/void`, {
        version: detail.incident.version,
        reason: "Duplicate of an earlier report",
      }),
      409,
      "incident-actions-outstanding",
    );
  });

  it("flags labourers who worked at a site without an induction, read from attendance", async () => {
    // Yesterday: worker 0 and 1 present on the main plot, worker 2 absent; worker 3 at the yard.
    const muster = async (target: string, entries: { worker: number; status: string }[]) => {
      const current = musterResponseSchema.parse(
        (
          await owner.call(
            "get",
            `attendance/projects/${projectId}/muster?siteId=${target}&date=${yesterday}`,
          )
        ).body,
      );
      const res = await owner.call("put", `attendance/projects/${projectId}/muster`, {
        siteId: target,
        date: yesterday,
        dayVersion: current.day?.version ?? 0,
        entries: entries.map(({ worker: index, status }) => ({
          labourerId: labourers[index],
          version:
            current.rows.find((row) => row.labourer.id === labourers[index])?.record?.version ?? 0,
          status,
          ...(status === "present" ? { checkIn: "07:00", checkOut: "16:00" } : {}),
        })),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    };
    await fresh();
    await muster(siteId, [
      { worker: 0, status: "present" },
      { worker: 1, status: "present" },
      { worker: 2, status: "absent" },
    ]);
    await muster(otherSite, [{ worker: 3, status: "present" }]);
    const options = ok(await foreman.call("get", `${base()}/options`), (body) =>
      safetyOptionsResponseSchema.parse(body),
    );
    expect(options.inductionTopics.length).toBe(10);
    expect(options.staff.map((member) => member.id)).toContain(foreman.auth.user.id);
    expect(options.staff.map((member) => member.id)).not.toContain(surveyor.auth.user.id);
    const induct = (worker: number, inductedOn: string, target = siteId) =>
      foreman.call("post", `${base()}/inductions`, {
        siteId: target,
        personKind: "labourer",
        labourerId: labourers[worker],
        inductedOn,
        inductorId: agent.auth.user.id,
        topics: ["site_rules", "ppe", "emergency_procedures"],
        acknowledgement: "thumbprint",
      });
    const first = ok(
      await induct(0, addCalendarDays(today, -3)),
      (body) => inductionResponseSchema.parse(body).induction,
      201,
    );
    expect(first).toMatchObject({
      code: "IND-0001",
      state: "valid",
      validUntil: null,
      topicsTotal: 10,
      topics: [
        { key: "site_rules", label: null },
        { key: "emergency_procedures", label: null },
        { key: "ppe", label: null },
      ],
    });
    // Attendance is never blocked; the flag is raised instead. Worker 1 attended without one.
    let status = ok(
      await foreman.call("get", `${base()}/induction-status?siteId=${siteId}`),
      (body) => inductionStatusResponseSchema.parse(body),
    );
    const row = (index: number) =>
      status.rows.find((entry) => entry.labourer.id === labourers[index]);
    expect(status.counts).toMatchObject({ labourers: 4, valid: 1, none: 3, flagged: 1 });
    expect(status.rows[0]!.labourer.id).toBe(labourers[1]);
    expect(row(1)).toMatchObject({ state: "none", flagged: true, uninductedDays: [yesterday] });
    expect(row(0)).toMatchObject({ state: "valid", flagged: false });
    expect(row(2)).toMatchObject({ state: "none", flagged: false, uninductedDays: [] });
    // An induction at the other site does not cover the main plot; worker 3 is flagged at the yard.
    const yard = ok(
      await foreman.call("get", `${base()}/induction-status?siteId=${otherSite}&filter=flagged`),
      (body) => inductionStatusResponseSchema.parse(body),
    );
    expect(yard.rows.map((entry) => entry.labourer.id)).toEqual([labourers[3]]);
    // Inducted today: still flagged for yesterday's work, which happened before the induction.
    ok(await induct(1, today), (body) => inductionResponseSchema.parse(body), 201);
    status = ok(await foreman.call("get", `${base()}/induction-status?siteId=${siteId}`), (body) =>
      inductionStatusResponseSchema.parse(body),
    );
    expect(row(1)).toMatchObject({ state: "valid", flagged: true, uninductedDays: [yesterday] });
    const summary = ok(await agent.call("get", `${base()}/summary`), (body) =>
      safetySummaryResponseSchema.parse(body),
    );
    expect(summary.inductions.flagged).toBe(2);

    // A visitor; a topic not on the checklist; a future date; an inductor without a site role.
    ok(
      await foreman.call("post", `${base()}/inductions`, {
        siteId,
        personKind: "visitor",
        visitorName: "Eng. Synthetic Visitor",
        visitorOrganisation: "County works office",
        inductedOn: today,
        inductorId: foreman.auth.user.id,
        topics: ["site_rules"],
        acknowledgement: "signed",
      }),
      (body) => inductionResponseSchema.parse(body),
      201,
    );
    problem(
      await foreman.call("post", `${base()}/inductions`, {
        siteId,
        personKind: "labourer",
        labourerId: labourers[2],
        inductedOn: today,
        inductorId: foreman.auth.user.id,
        topics: ["juggling"],
        acknowledgement: "verbal",
      }),
      422,
      "induction-topic-unknown",
    );
    problem(await induct(2, addCalendarDays(today, 1)), 409, "safety-date-future");
    problem(
      await foreman.call("post", `${base()}/inductions`, {
        siteId,
        personKind: "labourer",
        labourerId: labourers[2],
        inductedOn: today,
        inductorId: surveyor.auth.user.id,
        topics: ["ppe"],
        acknowledgement: "verbal",
      }),
      422,
      "staff-not-on-project",
    );

    // A validity period makes old inductions expire (settings are config.manage only).
    await fresh();
    const settings = ok(await owner.call("get", "safety/settings"), (body) =>
      safetySettingsResponseSchema.parse(body),
    ).settings;
    ok(
      await owner.call("put", "safety/settings", {
        inductionTopics: settings.inductionTopics,
        inductionValidityDays: 30,
        inductionLookbackDays: 14,
        kitCheckIntervalDays: 30,
        ppeReplacementDays: { ...DEFAULT_PPE_REPLACEMENT_DAYS, gloves: 10 },
        version: settings.version,
      }),
      (body) => safetySettingsResponseSchema.parse(body),
    );
    ok(
      await induct(2, addCalendarDays(today, -45)),
      (body) => inductionResponseSchema.parse(body),
      201,
    );
    status = ok(await foreman.call("get", `${base()}/induction-status?siteId=${siteId}`), (body) =>
      inductionStatusResponseSchema.parse(body),
    );
    expect(row(2)).toMatchObject({
      state: "expired",
      validUntil: addCalendarDays(today, -16),
      flagged: false,
    });
    // Recorded inductions are voided with a reason, never edited (safety.manage only).
    problem(
      await foreman.call("post", `${base()}/inductions/${first.id}/void`, {
        version: first.version,
        reason: "Wrong labourer selected",
      }),
      403,
    );
    const voided = ok(
      await agent.call("post", `${base()}/inductions/${first.id}/void`, {
        version: first.version,
        reason: "Wrong labourer selected",
      }),
      (body) => inductionResponseSchema.parse(body).induction,
    );
    expect(voided).toMatchObject({ status: "voided", state: "none" });
    await expect(
      db.run(context(agent), (tx) =>
        tx.safetyInduction.updateMany({
          where: { id: first.id },
          data: { status: "recorded", version: { increment: 1 } },
        }),
      ),
    ).rejects.toThrow(/final/);
  });

  it("takes a toolbox talk's attendance from a gang and locks it once confirmed", async () => {
    await fresh();
    const gang = gangDetailResponseSchema.parse(
      (
        await owner.call("post", "labour/gangs", {
          projectId,
          name: `Masons ${randomUUID().slice(0, 4)}`,
          siteId,
        })
      ).body,
    ).gang;
    for (const index of [0, 1]) {
      const res = await owner.call("post", `labour/gangs/${gang.id}/members`, {
        labourerId: labourers[index],
        joinedOn: addCalendarDays(today, -5),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const talkPhoto = await photo(foreman);
    const talk = (res: request.Response, status = 200) =>
      ok(res, (body) => toolboxTalkResponseSchema.parse(body).talk, status);
    const content = {
      heldOn: today,
      topic: "Working at height: harness checks",
      durationMinutes: 15,
      presenterId: agent.auth.user.id,
      gangIds: [gang.id],
      labourerIds: [labourers[3]!],
    };
    let draft = talk(
      await foreman.call("post", `${base()}/talks`, { siteId, ...content, photoId: talkPhoto }),
      201,
    );
    expect(draft).toMatchObject({ code: "TBT-0001", status: "draft", attendeeCount: 3 });
    expect(draft.attendees.filter((entry) => entry.gang?.id === gang.id)).toHaveLength(2);
    draft = talk(
      await foreman.call("put", `${base()}/talks/${draft.id}`, {
        version: draft.version,
        ...content,
        labourerIds: [],
        otherAttendees: 2,
        photoId: talkPhoto,
      }),
    );
    expect(draft).toMatchObject({ attendeeCount: 2, otherAttendees: 2 });
    const confirmed = talk(
      await foreman.call("post", `${base()}/talks/${draft.id}/actions`, {
        version: draft.version,
        action: "confirm",
      }),
    );
    expect(confirmed).toMatchObject({ status: "confirmed", permissions: { canEdit: false } });
    problem(
      await foreman.call("put", `${base()}/talks/${draft.id}`, {
        version: confirmed.version,
        ...content,
      }),
      409,
      "invalid-transition",
    );
    await expect(
      db.run(context(foreman), (tx) =>
        tx.toolboxTalkAttendee.create({
          data: {
            tenantId,
            projectId,
            talkId: draft.id,
            labourerId: labourers[3]!,
            addedBy: foreman.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow(/draft/);
    await expect(
      db.run(context(foreman), (tx) =>
        tx.toolboxTalk.updateMany({
          where: { id: draft.id },
          data: { topic: "Edited after confirming", version: { increment: 1 } },
        }),
      ),
    ).rejects.toThrow(/locked/);
    // Confirming at once needs an attendee; a confirmed talk can raise a corrective action.
    problem(
      await foreman.call("post", `${base()}/talks`, {
        siteId,
        ...content,
        gangIds: [],
        labourerIds: [],
        confirm: true,
      }),
      409,
      "talk-no-attendees",
    );
    const fromTalk = action(
      await manager.call("post", `${base()}/corrective-actions`, {
        source: "toolbox_talk",
        toolboxTalkId: confirmed.id,
        description: "Replace two frayed harness lanyards",
        ownerId: foreman.auth.user.id,
        dueOn: addCalendarDays(today, 2),
      }),
      201,
    );
    expect(fromTalk.toolboxTalk).toEqual({ id: confirmed.id, code: "TBT-0001" });
  });

  it("keeps the PPE register: replacement dates from settings, replacements, returns and voids", async () => {
    const issue = (res: request.Response, status = 200) =>
      ok(res, (body) => ppeIssueResponseSchema.parse(body).issue, status);
    // Gloves were set to 10 days in the settings above.
    const gloves = issue(
      await foreman.call("post", `${base()}/ppe`, {
        siteId,
        labourerId: labourers[0],
        item: "gloves",
        size: "L",
        quantity: 2,
        issuedOn: addCalendarDays(today, -12),
      }),
      201,
    );
    expect(gloves).toMatchObject({
      replacementDueOn: addCalendarDays(today, -2),
      replacementState: "due",
      status: "issued",
    });
    const helmet = issue(
      await foreman.call("post", `${base()}/ppe`, {
        siteId,
        labourerId: labourers[1],
        item: "helmet",
        quantity: 1,
        issuedOn: today,
      }),
      201,
    );
    expect(helmet).toMatchObject({
      replacementDueOn: addCalendarDays(today, 1095),
      replacementState: "ok",
    });
    let list = ok(await foreman.call("get", `${base()}/ppe?status=due`), (body) =>
      ppeIssuesResponseSchema.parse(body),
    );
    expect(list.issues.map((entry) => entry.id)).toEqual([gloves.id]);
    expect(list.counts).toMatchObject({ issued: 2, due: 1 });
    // A replacement must follow the same item for the same labourer.
    problem(
      await foreman.call("post", `${base()}/ppe`, {
        siteId,
        labourerId: labourers[1],
        item: "gloves",
        quantity: 2,
        issuedOn: today,
        replacesIssueId: gloves.id,
      }),
      409,
      "ppe-replacement-invalid",
    );
    const replacement = issue(
      await foreman.call("post", `${base()}/ppe`, {
        siteId,
        labourerId: labourers[0],
        item: "gloves",
        size: "L",
        quantity: 2,
        issuedOn: today,
        replacesIssueId: gloves.id,
      }),
      201,
    );
    expect(replacement.replacesIssueId).toBe(gloves.id);
    list = ok(await foreman.call("get", `${base()}/ppe?labourerId=${labourers[0]}`), (body) =>
      ppeIssuesResponseSchema.parse(body),
    );
    expect(list.issues.find((entry) => entry.id === gloves.id)?.status).toBe("replaced");
    problem(
      await foreman.call("post", `${base()}/ppe/${helmet.id}/return`, {
        version: helmet.version,
        returnedOn: addCalendarDays(today, -1),
        condition: "good",
      }),
      409,
      "ppe-return-before-issue",
    );
    const returned = issue(
      await foreman.call("post", `${base()}/ppe/${helmet.id}/return`, {
        version: helmet.version,
        returnedOn: today,
        condition: "damaged",
      }),
    );
    expect(returned).toMatchObject({ status: "returned", replacementState: null });
    problem(
      await foreman.call("post", `${base()}/ppe/${replacement.id}/void`, {
        version: replacement.version,
        reason: "Issued to the wrong worker",
      }),
      403,
    );
    issue(
      await agent.call("post", `${base()}/ppe/${replacement.id}/void`, {
        version: replacement.version,
        reason: "Issued to the wrong worker",
      }),
    );
    await expect(
      db.run(context(agent), (tx) =>
        tx.ppeIssue.updateMany({
          where: { id: returned.id },
          data: { quantity: 3, updatedBy: agent.auth.user.id, version: { increment: 1 } },
        }),
      ),
    ).rejects.toThrow(/final/);
  });

  it("tracks first-aid kits, first-aiders and treatments, restricting who was treated", async () => {
    const kit = ok(
      await agent.call("post", `${base()}/first-aid/kits`, {
        siteId,
        label: "Site office kit",
        location: "Container office",
      }),
      (body) => firstAidKitResponseSchema.parse(body).kit,
      201,
    );
    expect(kit.state).toBe("never_checked");
    problem(
      await agent.call("post", `${base()}/first-aid/kits`, { siteId, label: "Site office kit" }),
      409,
      "kit-label-taken",
    );
    const checked = ok(
      await foreman.call("post", `${base()}/first-aid/kits/${kit.id}/checks`, {
        checkedOn: today,
        outcome: "restocked",
        expiresOn: addCalendarDays(today, 10),
      }),
      (body) => firstAidKitResponseSchema.parse(body).kit,
      201,
    );
    expect(checked).toMatchObject({ state: "expiring", nextCheckOn: addCalendarDays(today, 30) });
    const aider = ok(
      await agent.call("post", `${base()}/first-aid/first-aiders`, {
        siteId,
        labourerId: labourers[2],
        certificateExpiresOn: addCalendarDays(today, -1),
        certificateReference: "SJA-SYN-77",
      }),
      (body) => firstAiderResponseSchema.parse(body).firstAider,
      201,
    );
    expect(aider.certificateState).toBe("expired");
    problem(
      await agent.call("post", `${base()}/first-aid/first-aiders`, {
        siteId,
        labourerId: labourers[2],
        certificateExpiresOn: addCalendarDays(today, 300),
      }),
      409,
      "first-aider-exists",
    );
    const treatment = ok(
      await foreman.call("post", `${base()}/first-aid/treatments`, {
        siteId,
        treatedAt: new Date().toISOString(),
        personName: "Synthetic Delivery Driver",
        injuryType: "cut",
        treatment: "cleaned_dressed",
        referral: "none",
        firstAiderId: aider.id,
      }),
      (body) => treatmentResponseSchema.parse(body).treatment,
      201,
    );
    expect(treatment.firstAider?.displayName).toMatch(/Mfanyakazi Usalama/);
    const asForeman = ok(await foreman.call("get", `${base()}/first-aid`), (body) =>
      firstAidResponseSchema.parse(body),
    );
    const restricted = asForeman.treatments.find((entry) => entry.id === treatment.id)!;
    expect(restricted).toMatchObject({ restricted: true, personName: null, injuryType: null });
    expect(asForeman.counts).toMatchObject({ kitsAttention: 1, certificatesExpired: 1 });
    const asAgent = ok(await agent.call("get", `${base()}/first-aid`), (body) =>
      firstAidResponseSchema.parse(body),
    );
    expect(asAgent.treatments.find((entry) => entry.id === treatment.id)).toMatchObject({
      restricted: false,
      personName: "Synthetic Delivery Driver",
      injuryType: "cut",
    });
    // Linked to an open incident once; treatments are never edited in SQL.
    const open = await report({}, agent);
    const linked = ok(
      await agent.call("post", `${base()}/first-aid/treatments/${treatment.id}/link`, {
        version: treatment.version,
        incidentId: open.incident.id,
      }),
      (body) => treatmentResponseSchema.parse(body).treatment,
    );
    expect(linked.incident?.id).toBe(open.incident.id);
    await expect(
      db.run(context(agent), (tx) =>
        tx.firstAidTreatment.updateMany({
          where: { id: treatment.id },
          data: { injuryType: "burn", updatedBy: agent.auth.user.id, version: { increment: 1 } },
        }),
      ),
    ).rejects.toThrow(/fixed/);
  });

  it("lists corrective actions overdue first and filters an owner's own", async () => {
    const detail = await report({}, agent);
    const overdue = await raise(detail, foreman, addCalendarDays(today, -4));
    const later = await raise(detail, foreman, addCalendarDays(today, 20));
    const list = ok(await foreman.call("get", `${base()}/corrective-actions?mine=true`), (body) =>
      correctiveActionsResponseSchema.parse(body),
    );
    expect(list.actions[0]).toMatchObject({ id: overdue.id, overdue: true, daysOverdue: 4 });
    expect(list.actions.findIndex((entry) => entry.id === later.id)).toBeGreaterThan(0);
    expect(list.actions.every((entry) => entry.owner.id === foreman.auth.user.id)).toBe(true);
    expect(list.counts.overdue).toBeGreaterThanOrEqual(1);
    const page = ok(await foreman.call("get", `${base()}/corrective-actions?limit=1`), (body) =>
      correctiveActionsResponseSchema.parse(body),
    );
    expect(page.actions[0]!.overdue).toBe(true);
    expect(page.nextCursor).toBe(1);
    // The foreman owns the action and marks it done, but cannot raise or verify one.
    expect(overdue.permissions.canMarkDone).toBe(false);
    const own = action(await foreman.call("get", `${base()}/corrective-actions/${overdue.id}`));
    expect(own.permissions).toMatchObject({ canMarkDone: true, canVerify: false, canEdit: false });
    action(await act(own, "done", foreman));
  });

  it("refuses clients, labourers, office roles and other companies, and keeps names and injuries out of the audit", async () => {
    for (const path of [
      "summary",
      "incidents",
      "corrective-actions",
      "inductions",
      `induction-status?siteId=${siteId}`,
      "talks",
      "ppe",
      "first-aid",
    ]) {
      expect((await client.call("get", `${base()}/${path}`)).status, path).toBe(403);
      expect((await worker.call("get", `${base()}/${path}`)).status, path).toBe(403);
      expect((await surveyor.call("get", `${base()}/${path}`)).status, path).toBe(403);
    }
    expect((await client.call("get", "safety/overview")).body).toEqual({ projects: [] });
    expect((await worker.call("get", "safety/settings")).status).toBe(403);
    problem(
      await client.call("post", `${base()}/incidents`, {
        siteId,
        kind: "near_miss",
        severity: "minor",
        occurredAt: `${today}T08:00:00+03:00`,
        location: "Gate",
        description: "A client tries to report an incident",
        firstAidGiven: false,
        people: [],
      }),
      403,
    );
    // RLS: another company sees 404s and no rows.
    expect((await outsider.call("get", `${base()}/incidents`)).status).toBe(404);
    expect(
      await db.run(context(outsider, otherTenant), (tx) =>
        tx.safetyIncident.count({ where: { projectId } }),
      ),
    ).toBe(0);
    await expect(
      db.run(context(outsider, otherTenant), (tx) =>
        tx.safetySettings.create({
          data: {
            tenantId,
            inductionTopics: [{ key: "site_rules", label: null }],
            ppeReplacementDays: DEFAULT_PPE_REPLACEMENT_DAYS,
            updatedBy: outsider.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();
    // Settings are changed with config.manage only.
    const settings = ok(await agent.call("get", "safety/settings"), (body) =>
      safetySettingsResponseSchema.parse(body),
    ).settings;
    expect(settings.permissions.canEdit).toBe(false);
    expect(
      (await agent.call("put", "safety/settings", { ...settings, permissions: undefined })).status,
    ).toBe(400);
    const overview = ok(await manager.call("get", "safety/overview"), (body) =>
      safetyOverviewResponseSchema.parse(body),
    );
    expect(overview.projects.find((entry) => entry.id === projectId)).toMatchObject({
      openIncidents: expect.any(Number) as number,
    });
    const incidents = ok(await manager.call("get", `${base()}/incidents?status=closed`), (body) =>
      incidentsResponseSchema.parse(body),
    );
    expect(incidents.counts.closed).toBe(1);

    const events = await db.run(context(), (tx) =>
      tx.auditEvent.findMany({
        where: { action: { startsWith: "safety." } },
        select: { action: true, metadata: true },
      }),
    );
    for (const name of [
      "safety.incident_reported",
      "safety.incident_investigated",
      "safety.incident_regulator_decision",
      "safety.incident_closed",
      "safety.action_raised",
      "safety.action_done",
      "safety.action_verified",
      "safety.action_rejected",
      "safety.induction_recorded",
      "safety.induction_voided",
      "safety.talk_recorded",
      "safety.talk_updated",
      "safety.talk_confirmed",
      "safety.ppe_issued",
      "safety.ppe_returned",
      "safety.ppe_voided",
      "safety.kit_added",
      "safety.kit_checked",
      "safety.first_aider_added",
      "safety.treatment_recorded",
      "safety.treatment_linked",
      "safety.settings_updated",
    ])
      expect(
        events.map((event) => event.action),
        name,
      ).toContain(name);
    // No names, injuries, treatments or free text in the audit log.
    const serialised = JSON.stringify(events);
    for (const text of [
      "Synthetic Witness Wanjiku",
      "Synthetic Delivery Driver",
      "Eng. Synthetic Visitor",
      "Mfanyakazi Usalama",
      "sprain",
      "cold_compress",
      "cleaned_dressed",
      "Synthetic slip on wet boards",
      "Boards were wet",
      "Wrong labourer selected",
      "DOSH/SYN/0001",
    ])
      expect(serialised, text).not.toContain(text);
  });
});
