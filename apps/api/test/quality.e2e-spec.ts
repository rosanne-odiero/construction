import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addCalendarDays, addCalendarMonths, nairobiDate } from "@pm-buddy/domain";
import { CURRENT_CONSENT_NOTICE } from "@pm-buddy/types";
import {
  auditEventsResponseSchema,
  checklistTemplateResponseSchema,
  checklistTemplatesResponseSchema,
  completionResponseSchema,
  cubeSetResponseSchema,
  cubeSetsResponseSchema,
  diaryAttendanceResponseSchema,
  diaryResponseSchema,
  inspectionDetailResponseSchema,
  inspectionsResponseSchema,
  labourerResponseSchema,
  labourSetupResponseSchema,
  musterResponseSchema,
  projectResponseSchema,
  qualitySettingsResponseSchema,
  qualitySummaryResponseSchema,
  siteResponseSchema,
  sitePhotoResponseSchema,
  slumpTestResponseSchema,
  snagResponseSchema,
  snagsResponseSchema,
  tenantCreatedResponseSchema,
  type InspectionDetailResponse,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { jpegWithExif } from "./photo-fixtures.js";
import { Browser, notifications, origin } from "./support.js";

/**
 * D6.1 quality and the diary's attendance workforce against the real database as the runtime
 * role (pmb_app): versioned templates, inspections with independent sign-off and locking, snags
 * with independent verification, concrete cube and slump tests with corrections, practical
 * completion refused with open critical snags, the defects liability period, the attendance
 * snapshot, tenant isolation (RLS) and permission refusals (role ∩ assignment, a client refused).
 */
describe("Quality and the diary workforce (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let manager: Browser;
  let agent: Browser;
  let foreman: Browser;
  let client: Browser;
  let outsider: Browser;
  let tenantId: string;
  let otherTenant: string;
  let projectId: string;
  let siteId: string;
  let otherProject: string;
  let notificationSpy: ReturnType<typeof vi.spyOn>;
  const today = nairobiDate();
  const yesterday = addCalendarDays(today, -1);
  const base = (project = projectId) => `projects/${project}/quality`;
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
  const photo = async (browser: Browser, project = projectId, site = siteId) => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/projects/${project}/photos`)
      .set("Cookie", [...browser.cookies].map(([key, value]) => `${key}=${value}`).join("; "))
      .set("Origin", origin)
      .set("X-CSRF-Token", browser.csrf)
      .field("siteId", site)
      .attach("file", await jpegWithExif({ make: randomUUID().slice(0, 20) }), "IMG.jpg");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return sitePhotoResponseSchema.parse(res.body).photo.id;
  };
  const templates = async (browser = agent) =>
    ok(await browser.call("get", "quality/templates"), (body) =>
      checklistTemplatesResponseSchema.parse(body),
    );
  const inspection = (res: request.Response, status = 200) =>
    ok(res, (body) => inspectionDetailResponseSchema.parse(body), status);
  const startInspection = async (templateId: string, browser = agent) =>
    inspection(
      await browser.call("post", `${base()}/inspections`, {
        siteId,
        templateId,
        location: `Block A ${randomUUID().slice(0, 6)}`,
        inspectorType: "consultant",
        inspectorName: "Eng. Synthetic Consultant",
        inspectedOn: today,
      }),
      201,
    );
  const answer = (
    detail: InspectionDetailResponse,
    results: ("pass" | "fail" | "na" | "pending")[],
    browser = agent,
    photos: Record<number, string[]> = {},
  ) =>
    browser.call("patch", `${base()}/inspections/${detail.inspection.id}`, {
      version: detail.inspection.version,
      items: detail.items.map((item, index) => ({
        id: item.id,
        result: results[index] ?? "pass",
        note: results[index] === "fail" ? `Defect at item ${index + 1}: rework needed` : null,
        photoIds: photos[index] ?? [],
      })),
    });
  const act = (
    detail: InspectionDetailResponse,
    action: string,
    browser: Browser,
    reason?: string,
  ) =>
    browser.call("post", `${base()}/inspections/${detail.inspection.id}/actions`, {
      version: detail.inspection.version,
      action,
      ...(reason ? { reason } : {}),
    });
  const raise = async (severity: string, extra: object = {}, browser = agent) =>
    ok(
      await browser.call("post", `${base()}/snags`, {
        siteId,
        location: "Unit 4 kitchen",
        description: `Synthetic defect ${randomUUID().slice(0, 8)}`,
        severity,
        responsibleKind: "gang",
        responsibleName: "Masons gang A",
        dueOn: addCalendarDays(today, 7),
        ...extra,
      }),
      (body) => snagResponseSchema.parse(body).snag,
      201,
    );
  const snagAction = (
    snag: { id: string; version: number },
    action: string,
    browser: Browser,
    extra: object = {},
  ) =>
    browser.call("post", `${base()}/snags/${snag.id}/actions`, {
      version: snag.version,
      action,
      ...extra,
    });

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
    client = new Browser(app);
    outsider = new Browser(app);
    for (const browser of [owner, manager, agent, foreman, client, outsider])
      await browser.register();
    for (const browser of [owner, outsider, manager]) await browser.enroll();
    tenantId = tenantCreatedResponseSchema.parse(
      (await owner.call("post", "tenants", { name: `Quality company ${randomUUID()}` })).body,
    ).tenant.id;
    otherTenant = tenantCreatedResponseSchema.parse(
      (await outsider.call("post", "tenants", { name: `Other quality company ${randomUUID()}` }))
        .body,
    ).tenant.id;
    await fresh();
    projectId = projectResponseSchema.parse(
      (await owner.call("post", "projects", { name: "Quality project" })).body,
    ).project.id;
    otherProject = projectResponseSchema.parse(
      (await owner.call("post", "projects", { name: "Other quality project" })).body,
    ).project.id;
    siteId = await site(projectId, "Main plot");
    await join(manager, "project_manager", [
      "projects.view",
      "projects.manage",
      "quality.manage",
      "site.diary",
      "site.photos",
    ]);
    await join(agent, "site_agent", [
      "projects.view",
      "site.diary",
      "site.photos",
      "quality.manage",
    ]);
    // A foreman records and fixes but never signs off (no quality.manage in the role).
    await join(foreman, "foreman", ["projects.view", "site.diary", "site.photos"]);
    await join(client, "client", ["projects.view", "portal.client"]);
    await fresh(manager);
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("publishes every quality operation and refuses requests without a session or CSRF token", async () => {
    const spec = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (spec.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((entry) => Object.values(entry).map((operation) => operation.operationId));
    for (const name of [
      "listChecklistTemplates",
      "createChecklistTemplate",
      "loadStarterChecklistTemplates",
      "getChecklistTemplate",
      "reviseChecklistTemplate",
      "retireChecklistTemplate",
      "getQualitySettings",
      "updateQualitySettings",
      "getQualitySummary",
      "listInspections",
      "createInspection",
      "getInspection",
      "updateInspection",
      "transitionInspection",
      "listSnags",
      "createSnag",
      "getSnag",
      "updateSnag",
      "transitionSnag",
      "listCubeSets",
      "createCubeSet",
      "getCubeSet",
      "recordCubeResult",
      "correctCubeResult",
      "voidCubeSet",
      "listSlumpTests",
      "createSlumpTest",
      "getSlumpTest",
      "correctSlumpTest",
      "getCompletion",
      "proposeCompletion",
      "transitionCompletion",
      "getDiaryAttendance",
    ])
      expect(operations, name).toContain(name);
    expect((await new Browser(app).call("get", `${base()}/snags`, undefined, false)).status).toBe(
      401,
    );
    expect((await agent.call("post", `${base()}/snags`, {}, false)).status).toBe(403);
  });

  it("versions templates: starter set, revisions, retirement, and inspections from the current version only", async () => {
    // The client, and a member without a quality permission, cannot read company templates.
    expect((await client.call("get", "quality/templates")).status).toBe(403);
    problem(await foreman.call("post", "quality/templates/starter", { language: "en" }), 403);
    const loaded = await agent.call("post", "quality/templates/starter", { language: "sw" });
    expect(loaded.status, JSON.stringify(loaded.body)).toBe(201);
    expect(loaded.body).toEqual({ created: 7 });
    // Loading again skips existing names.
    expect(
      (await agent.call("post", "quality/templates/starter", { language: "sw" })).body,
    ).toEqual({ created: 0 });
    const list = await templates(foreman);
    expect(list.templates.map((entry) => entry.name)).toContain("Upimaji na uwekaji alama");
    expect(list.permissions.canCreate).toBe(false);

    const created = ok(
      await agent.call("post", "quality/templates", {
        name: "Column check",
        category: "columns_beams",
        items: [{ text: "Starter bars at the right spacing" }, { text: "Formwork plumb" }],
      }),
      (body) => checklistTemplateResponseSchema.parse(body),
      201,
    ).template;
    expect(created).toMatchObject({ version: 1, current: true, itemCount: 2 });
    const revised = ok(
      await agent.call("post", `quality/templates/${created.id}/versions`, {
        expectedVersion: 1,
        name: "Column check",
        category: "columns_beams",
        items: [
          { text: "Starter bars at the right spacing" },
          { text: "Formwork plumb" },
          { text: "Cover blocks fixed" },
        ],
      }),
      (body) => checklistTemplateResponseSchema.parse(body),
      201,
    );
    expect(revised.template).toMatchObject({ version: 2, lineageId: created.id, itemCount: 3 });
    expect(revised.history.map((entry) => entry.version)).toEqual([1]);
    // A stale revision is a version conflict; the old version stays readable but not usable.
    problem(
      await agent.call("post", `quality/templates/${created.id}/versions`, {
        expectedVersion: 1,
        name: "Column check",
        category: "columns_beams",
        items: [{ text: "Anything" }],
      }),
      409,
      "version-conflict",
    );
    problem(
      await agent.call("post", `${base()}/inspections`, {
        siteId,
        templateId: created.id,
        location: "Column C3",
        inspectorType: "internal",
        inspectedOn: today,
      }),
      409,
      "template-not-current",
    );
    const fromV2 = await startInspection(revised.template.id);
    expect(fromV2.items.map((item) => item.text)).toEqual([
      "Starter bars at the right spacing",
      "Formwork plumb",
      "Cover blocks fixed",
    ]);
    expect(fromV2.inspection).toMatchObject({
      template: { id: revised.template.id, version: 2 },
      status: "draft",
      code: "INS-0001",
    });
    // Retiring appends a version; no new inspections, but existing ones keep their version.
    const retired = ok(
      await agent.call("post", `quality/templates/${revised.template.id}/retire`, {
        expectedVersion: 2,
      }),
      (body) => checklistTemplateResponseSchema.parse(body),
      201,
    );
    expect(retired.template).toMatchObject({ version: 3, retired: true });
    problem(
      await agent.call("post", `${base()}/inspections`, {
        siteId,
        templateId: retired.template.id,
        location: "Column C4",
        inspectorType: "internal",
        inspectedOn: today,
      }),
      409,
      "template-retired",
    );
    expect((await templates()).templates.some((entry) => entry.lineageId === created.id)).toBe(
      false,
    );
    // Template versions are append-only for the runtime role.
    await expect(
      db.run(context(agent), (tx) =>
        tx.checklistTemplate.update({ where: { id: created.id }, data: { name: "Tampered" } }),
      ),
    ).rejects.toThrow();
  });

  it("signs off an inspection independently, locks it, and raises snags from failed items", async () => {
    const slab = (await templates()).templates.find((entry) => entry.category === "slab")!;
    let detail = await startInspection(slab.id);
    // Nothing answered yet: submission is refused.
    problem(await act(detail, "submit", agent), 409, "inspection-incomplete");
    // A failed item needs a note; another project's photo is refused.
    const strangerPhoto = await photo(owner, otherProject, await site(otherProject, "Yard"));
    problem(
      await answer(detail, ["pass"], agent, { 0: [strangerPhoto] }),
      422,
      "photo-not-in-project",
    );
    const failPhoto = await photo(agent);
    problem(
      await agent.call("patch", `${base()}/inspections/${detail.inspection.id}`, {
        version: detail.inspection.version,
        items: [{ id: detail.items[0]!.id, result: "fail", note: null, photoIds: [] }],
      }),
      200,
    );
    detail = inspection(await agent.call("get", `${base()}/inspections/${detail.inspection.id}`));
    problem(await act(detail, "submit", agent), 409, "inspection-incomplete");
    // Only the author edits a draft.
    problem(await answer(detail, ["pass"], manager), 403, "inspection-author-required");
    detail = inspection(await answer(detail, ["pass", "fail", "na"], agent, { 1: [failPhoto] }));
    expect(detail.inspection.itemCounts).toMatchObject({ pass: 4, fail: 1, na: 1, pending: 0 });
    expect(detail.items[1]!.photos.map((entry) => entry.id)).toEqual([failPhoto]);
    detail = inspection(await act(detail, "submit", agent));
    expect(detail.inspection).toMatchObject({ status: "submitted", result: "fail" });
    expect(detail.inspection.permissions).toMatchObject({ canSignOff: false, canEdit: false });

    // Maker-checker: the author (or a foreman without quality.manage) cannot sign it off.
    problem(await act(detail, "sign_off", agent), 403, "inspection-independent-review");
    problem(await act(detail, "sign_off", foreman), 403);
    const managerView = inspection(
      await manager.call("get", `${base()}/inspections/${detail.inspection.id}`),
    );
    expect(managerView.inspection.permissions).toMatchObject({
      canSignOff: true,
      canReturn: true,
      canRaiseSnags: true,
    });
    detail = inspection(await act(managerView, "sign_off", manager));
    expect(detail.inspection).toMatchObject({
      status: "signed_off",
      signedOffBy: { id: manager.auth.user.id },
    });
    // Locked: no edits through the API or in SQL, even for the author.
    problem(await answer(detail, ["pass", "pass", "pass"], agent), 409, "inspection-not-draft");
    problem(await act(detail, "return", manager, "Too late to return"), 409, "invalid-transition");
    await expect(
      db.run(context(agent), (tx) =>
        tx.inspection.update({
          where: { id: detail.inspection.id },
          data: { location: "Changed", version: { increment: 1 }, updatedBy: agent.auth.user.id },
        }),
      ),
    ).rejects.toThrow(/locked/);
    await expect(
      db.run(context(agent), (tx) =>
        tx.inspectionItem.update({
          where: { id: detail.items[1]!.id },
          data: { result: "pass", updatedBy: agent.auth.user.id },
        }),
      ),
    ).rejects.toThrow(/draft inspection/);
    await expect(
      db.run(context(agent), (tx) =>
        tx.inspectionItemPhoto.deleteMany({ where: { itemId: detail.items[1]!.id } }),
      ),
    ).rejects.toThrow(/draft inspection/);

    // Snags come from failed items only.
    problem(
      await agent.call("post", `${base()}/snags`, {
        siteId,
        location: "Slab bay 2",
        description: "Not actually failed",
        severity: "minor",
        responsibleKind: "gang",
        responsibleName: "Steel fixers",
        inspectionItemId: detail.items[0]!.id,
      }),
      409,
      "snag-item-not-failed",
    );
    const snag = await raise("major", {
      inspectionItemId: detail.items[1]!.id,
      photoIds: [failPhoto],
    });
    expect(snag).toMatchObject({
      code: "SNG-0001",
      phase: "construction",
      status: "open",
      inspection: { id: detail.inspection.id, code: detail.inspection.code },
    });
    expect(snag.photos.raised.map((entry) => entry.id)).toEqual([failPhoto]);
    const withSnags = inspection(
      await agent.call("get", `${base()}/inspections/${detail.inspection.id}`),
    );
    expect(withSnags.snags.map((entry) => entry.id)).toEqual([snag.id]);
    expect(withSnags.items[1]!.snagCount).toBe(1);

    // Return path: an independent reviewer returns a submitted inspection with a reason.
    let second = await startInspection(slab.id);
    second = inspection(await answer(second, []));
    second = inspection(await act(second, "submit", agent));
    expect(second.inspection.result).toBe("pass");
    problem(
      await act(second, "return", agent, "Self review"),
      403,
      "inspection-independent-review",
    );
    second = inspection(await act(second, "return", manager, "Photos of the cover blocks missing"));
    expect(second.inspection).toMatchObject({
      status: "draft",
      result: null,
      returnReason: "Photos of the cover blocks missing",
      returnedBy: { id: manager.auth.user.id },
    });
    // Flags are the caller's: the reviewer cannot edit it, its author can again.
    expect(second.inspection.permissions.canEdit).toBe(false);
    expect(
      inspection(await agent.call("get", `${base()}/inspections/${second.inspection.id}`))
        .inspection.permissions,
    ).toMatchObject({ canEdit: true, canSubmit: true, canSignOff: false });
    const list = ok(
      await agent.call("get", `${base()}/inspections?search=${second.inspection.code}`),
      (body) => inspectionsResponseSchema.parse(body),
    );
    expect(list.inspections.map((entry) => entry.id)).toEqual([second.inspection.id]);
    const failed = ok(
      await agent.call("get", `${base()}/inspections?result=fail&limit=1`),
      (body) => inspectionsResponseSchema.parse(body),
    );
    expect(failed.inspections.map((entry) => entry.id)).toEqual([detail.inspection.id]);
  });

  it("moves snags open → fixed → closed with an independent verifier, or reopens them", async () => {
    const snag = await raise("minor", {}, foreman);
    expect(snag.permissions).toEqual({
      canEdit: false,
      canFix: true,
      canClose: false,
      canReopen: false,
    });
    // Editing (which can change severity) needs quality.manage.
    problem(
      await foreman.call("patch", `${base()}/snags/${snag.id}`, {
        version: snag.version,
        severity: "minor",
      }),
      403,
    );
    problem(await snagAction(snag, "close", manager), 409, "invalid-transition");
    const fixPhoto = await photo(agent);
    const fixed = ok(
      await snagAction(snag, "fix", agent, {
        note: "Re-plastered and painted",
        photoIds: [fixPhoto],
      }),
      (body) => snagResponseSchema.parse(body).snag,
    );
    expect(fixed).toMatchObject({ status: "fixed", fixedBy: { id: agent.auth.user.id } });
    expect(fixed.photos.fixed.map((entry) => entry.id)).toEqual([fixPhoto]);
    // The fixer cannot verify their own fix.
    problem(await snagAction(fixed, "close", agent), 403, "snag-independent-verification");
    problem(await snagAction(fixed, "reopen", manager), 400);
    const reopened = ok(
      await snagAction(fixed, "reopen", manager, { reason: "Paint still flaking" }),
      (body) => snagResponseSchema.parse(body).snag,
    );
    expect(reopened).toMatchObject({
      status: "open",
      reopenCount: 1,
      lastReopenReason: "Paint still flaking",
      fixedBy: null,
      fixNote: null,
    });
    const refixed = ok(
      await snagAction(reopened, "fix", foreman),
      (body) => snagResponseSchema.parse(body).snag,
    );
    const closed = ok(
      await snagAction(refixed, "close", agent),
      (body) => snagResponseSchema.parse(body).snag,
    );
    expect(closed).toMatchObject({ status: "closed", closedBy: { id: agent.auth.user.id } });
    expect(closed.permissions).toEqual({
      canEdit: false,
      canFix: false,
      canClose: false,
      canReopen: false,
    });
    // Closed snags are final, in the API and in SQL.
    problem(
      await snagAction(closed, "reopen", manager, { reason: "Recurred" }),
      409,
      "invalid-transition",
    );
    await expect(
      db.run(context(manager), (tx) =>
        tx.snag.update({
          where: { id: closed.id },
          data: {
            status: "open",
            closedBy: null,
            closedAt: null,
            version: { increment: 1 },
            updatedBy: manager.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow(/final/);
    // A fixer cannot close in SQL either (the trigger repeats the independence rule).
    const other = await raise("minor");
    const otherFixed = ok(
      await snagAction(other, "fix", manager),
      (body) => snagResponseSchema.parse(body).snag,
    );
    await expect(
      db.run(context(manager), (tx) =>
        tx.snag.update({
          where: { id: otherFixed.id },
          data: {
            status: "closed",
            closedBy: manager.auth.user.id,
            version: { increment: 1 },
            updatedBy: manager.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow(/other than the fixer/);
    const list = ok(await agent.call("get", `${base()}/snags?status=active&limit=1`), (body) =>
      snagsResponseSchema.parse(body),
    );
    expect(list.snags).toHaveLength(1);
    expect(list.nextCursor).not.toBeNull();
    expect(list.counts.closed).toBe(1);
  });

  it("judges cube sets by KE-CUBE-1, flags overdue results and corrects results by reference", async () => {
    problem(
      await agent.call("post", `${base()}/cubes`, {
        siteId,
        element: "Future pour",
        concreteClass: "C25",
        castOn: addCalendarDays(today, 1),
      }),
      409,
      "quality-date-future",
    );
    const castOn = addCalendarDays(today, -30);
    let set = ok(
      await agent.call("post", `${base()}/cubes`, {
        siteId,
        element: "First floor slab bay 2",
        concreteClass: "C25",
        castOn,
        batchReference: "RMX-1001",
      }),
      (body) => cubeSetResponseSchema.parse(body),
      201,
    ).cubeSet;
    expect(set).toMatchObject({ code: "CUBE-0001", specifiedStrength: 25, outcome: null });
    expect(set.ages.map((age) => [age.ageDays, age.dueOn, age.state])).toEqual([
      [7, addCalendarDays(castOn, 7), "overdue"],
      [28, addCalendarDays(castOn, 28), "due"],
    ]);
    problem(
      await agent.call("post", `${base()}/cubes/${set.id}/results`, {
        ageDays: 7,
        testedOn: addCalendarDays(castOn, -1),
        strengths: ["18"],
      }),
      422,
      "cube-tested-before-cast",
    );
    const seven = ok(
      await foreman.call("post", `${base()}/cubes/${set.id}/results`, {
        ageDays: 7,
        testedOn: addCalendarDays(castOn, 7),
        strengths: ["15.2", "16.0", "15.4"],
      }),
      (body) => cubeSetResponseSchema.parse(body),
      201,
    );
    expect(seven.cubeSet.ages[0]!.result).toMatchObject({
      meanStrength: "15.53",
      outcome: "indicative_low",
      ruleVersion: "KE-CUBE-1",
    });
    // 28 days: mean 25.30 but one cube at 21.5 < 22 → fail.
    set = ok(
      await foreman.call("post", `${base()}/cubes/${set.id}/results`, {
        ageDays: 28,
        testedOn: addCalendarDays(castOn, 28),
        strengths: ["21.5", "27.0", "27.4"],
        laboratory: "Synthetic Materials Lab",
      }),
      (body) => cubeSetResponseSchema.parse(body),
      201,
    ).cubeSet;
    const original = set.ages[1]!.result!;
    expect(original).toMatchObject({
      meanStrength: "25.30",
      minStrength: "21.5",
      outcome: "fail",
      current: true,
    });
    expect(set.outcome).toBe("fail");
    problem(
      await foreman.call("post", `${base()}/cubes/${set.id}/results`, {
        ageDays: 28,
        testedOn: today,
        strengths: ["30"],
      }),
      409,
      "cube-result-exists",
    );
    // Corrections need quality.manage and a reason, reference the original and keep it.
    problem(
      await foreman.call("post", `${base()}/cubes/${set.id}/results/${original.id}/corrections`, {
        testedOn: addCalendarDays(castOn, 28),
        strengths: ["24.5", "27.0", "27.4"],
        reason: "Lab sheet transcription error",
      }),
      403,
    );
    const corrected = ok(
      await agent.call("post", `${base()}/cubes/${set.id}/results/${original.id}/corrections`, {
        testedOn: addCalendarDays(castOn, 28),
        strengths: ["24.5", "27.0", "27.4"],
        reason: "Lab sheet transcription error",
      }),
      (body) => cubeSetResponseSchema.parse(body),
      201,
    );
    expect(corrected.cubeSet.ages[1]!.result).toMatchObject({
      meanStrength: "26.30",
      outcome: "pass",
      supersedesId: original.id,
      correctionReason: "Lab sheet transcription error",
    });
    expect(corrected.history.find((entry) => entry.id === original.id)).toMatchObject({
      outcome: "fail",
      current: false,
    });
    problem(
      await agent.call("post", `${base()}/cubes/${set.id}/results/${original.id}/corrections`, {
        testedOn: today,
        strengths: ["30"],
        reason: "Second correction of the old one",
      }),
      409,
      "cube-result-superseded",
    );
    // Results are append-only, and the database re-checks the rule on insert.
    await expect(
      db.run(context(agent), (tx) =>
        tx.cubeResult.update({ where: { id: original.id }, data: { outcome: "pass" } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(context(agent), (tx) =>
        tx.cubeResult.create({
          data: {
            id: randomUUID(),
            tenantId,
            projectId,
            cubeSetId: set.id,
            ageDays: 28,
            testedOn: new Date(`${today}T00:00:00Z`),
            // A consistent mean and minimum with a forged outcome: 20.00 < 25 fails at 28 days.
            strengths: ["20.0", "20.0", "20.0"],
            meanStrength: "20.00",
            minStrength: "20.0",
            outcome: "pass",
            ruleVersion: "KE-CUBE-1",
            supersedesId: corrected.cubeSet.ages[1]!.result!.id,
            correctionReason: "Forged pass",
            recordedBy: agent.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow(/mean and outcome must follow rule KE-CUBE-1/);

    // An older set without results is overdue at both ages; a void set is never due.
    const old = ok(
      await agent.call("post", `${base()}/cubes`, {
        siteId,
        element: "Ground beam GB4",
        concreteClass: "C30",
        castOn: addCalendarDays(today, -40),
      }),
      (body) => cubeSetResponseSchema.parse(body),
      201,
    ).cubeSet;
    expect(old.ages.map((age) => age.state)).toEqual(["overdue", "overdue"]);
    const overdue = ok(await agent.call("get", `${base()}/cubes?filter=overdue`), (body) =>
      cubeSetsResponseSchema.parse(body),
    );
    expect(overdue.cubeSets.map((entry) => entry.id)).toEqual([old.id]);
    expect(overdue.counts).toEqual({ overdue: 1, failed: 0 });
    const voided = ok(
      await agent.call("post", `${base()}/cubes/${old.id}/void`, {
        version: old.version,
        reason: "Entered against the wrong pour",
      }),
      (body) => cubeSetResponseSchema.parse(body),
    ).cubeSet;
    expect(voided).toMatchObject({ status: "void", voidReason: "Entered against the wrong pour" });
    expect(voided.ages.map((age) => age.state)).toEqual(["not_due", "not_due"]);
    problem(
      await agent.call("post", `${base()}/cubes/${old.id}/results`, {
        ageDays: 7,
        testedOn: today,
        strengths: ["20"],
      }),
      409,
      "cube-set-void",
    );

    // Slump tests: within tolerance passes; a correction references the original.
    const slump = ok(
      await foreman.call("post", `${base()}/slump-tests`, {
        siteId,
        cubeSetId: set.id,
        testedOn: today,
        element: "First floor slab bay 2",
        concreteClass: "C25",
        targetMm: 75,
        toleranceMm: 20,
        measuredMm: 100,
      }),
      (body) => slumpTestResponseSchema.parse(body),
      201,
    ).slumpTest;
    expect(slump).toMatchObject({ code: "SLP-0001", outcome: "fail", deviationMm: 25 });
    const fixedSlump = ok(
      await agent.call("post", `${base()}/slump-tests/${slump.id}/corrections`, {
        testedOn: today,
        element: "First floor slab bay 2",
        concreteClass: "C25",
        targetMm: 75,
        toleranceMm: 20,
        measuredMm: 90,
        reason: "Reading misheard on site",
      }),
      (body) => slumpTestResponseSchema.parse(body),
      201,
    );
    expect(fixedSlump.slumpTest).toMatchObject({
      code: "SLP-0001",
      outcome: "pass",
      supersedesId: slump.id,
    });
    expect(fixedSlump.history.map((entry) => [entry.id, entry.current])).toEqual([
      [slump.id, false],
    ]);
    await expect(
      db.run(context(agent), (tx) =>
        tx.slumpTest.update({ where: { id: slump.id }, data: { measuredMm: 75 } }),
      ),
    ).rejects.toThrow();
  });

  it("refuses practical completion with open critical snags unless excepted, and runs the DLP", async () => {
    const critical = await raise("critical");
    // The site agent (no projects.manage) cannot propose.
    problem(
      await agent.call("post", `${base()}/completion`, {
        kind: "practical",
        completionDate: today,
      }),
      403,
    );
    problem(
      await manager.call("post", `${base()}/completion`, {
        kind: "practical",
        completionDate: today,
      }),
      409,
      "completion-open-critical-snags",
    );
    // An exception with a reason lets the proposal through; certifying is independent.
    let view = ok(
      await manager.call("post", `${base()}/completion`, {
        kind: "practical",
        completionDate: today,
        dlpMonths: 12,
        exceptionReason: "Client accepts the gate defect at handover",
      }),
      (body) => completionResponseSchema.parse(body),
      201,
    );
    let practical = view.practical!;
    expect(practical).toMatchObject({
      status: "proposed",
      openCriticalSnags: 1,
      dlpMonths: 12,
      dlpEndsOn: addCalendarMonths(today, 12),
    });
    problem(
      await manager.call("post", `${base()}/completion`, {
        kind: "practical",
        completionDate: today,
      }),
      409,
      "completion-exists",
    );
    problem(
      await manager.call("post", `${base()}/completion/${practical.id}/actions`, {
        version: practical.version,
        action: "certify",
      }),
      403,
      "completion-independent",
    );
    view = ok(
      await manager.call("post", `${base()}/completion/${practical.id}/actions`, {
        version: practical.version,
        action: "withdraw",
        reason: "Re-propose without the exception",
      }),
      (body) => completionResponseSchema.parse(body),
    );
    expect(view.practical).toBeNull();
    // Close the critical snag (fixed by the foreman, verified by the agent), then propose cleanly.
    const fixed = ok(
      await snagAction(critical, "fix", foreman),
      (body) => snagResponseSchema.parse(body).snag,
    );
    expect((await snagAction(fixed, "close", agent)).status).toBe(200);
    // Other open snags of lower severity do not block practical completion.
    view = ok(
      await manager.call("post", `${base()}/completion`, {
        kind: "practical",
        completionDate: today,
      }),
      (body) => completionResponseSchema.parse(body),
      201,
    );
    practical = view.practical!;
    expect(practical).toMatchObject({ dlpMonths: 6, openCriticalSnags: 0 });
    expect(practical.openSnags).toBeGreaterThan(0);
    // A critical snag raised before certification blocks it again.
    const late = await raise("critical");
    problem(
      await agent.call("post", `${base()}/completion/${practical.id}/actions`, {
        version: practical.version,
        action: "certify",
      }),
      409,
      "completion-open-critical-snags",
    );
    const lateFixed = ok(
      await snagAction(late, "fix", foreman),
      (body) => snagResponseSchema.parse(body).snag,
    );
    expect((await snagAction(lateFixed, "close", agent)).status).toBe(200);
    view = ok(
      await agent.call("post", `${base()}/completion/${practical.id}/actions`, {
        version: practical.version,
        action: "certify",
      }),
      (body) => completionResponseSchema.parse(body),
    );
    expect(view.practical).toMatchObject({
      status: "certified",
      certifiedBy: { id: agent.auth.user.id },
    });
    expect(view.dlp).toMatchObject({
      startsOn: today,
      endsOn: addCalendarMonths(today, 6),
      state: "running",
      defects: { open: 0, fixed: 0, closed: 0 },
    });
    // Certified completion is locked in SQL.
    await expect(
      db.run(context(manager), (tx) =>
        tx.projectCompletion.update({
          where: { id: practical.id },
          data: {
            status: "withdrawn",
            withdrawnBy: manager.auth.user.id,
            withdrawReason: "No",
            version: { increment: 1 },
          },
        }),
      ),
    ).rejects.toThrow(/locked/);
    // Defects reported now are DLP defects.
    const defect = await raise("major");
    expect(defect.phase).toBe("dlp");
    view = ok(await manager.call("get", `${base()}/completion`), (body) =>
      completionResponseSchema.parse(body),
    );
    expect(view.dlp!.defects.open).toBe(1);
    expect(view.readiness.finalBlockers).toEqual(
      expect.arrayContaining(["dlp_not_ended", "open_snags"]),
    );
    problem(
      await manager.call("post", `${base()}/completion`, {
        kind: "final",
        completionDate: today,
        exceptionReason: "Trying early",
      }),
      409,
      "completion-dlp-not-ended",
    );
    const summary = ok(await agent.call("get", `${base()}/summary`), (body) =>
      qualitySummaryResponseSchema.parse(body),
    );
    expect(summary.completion).toEqual({
      practical: "certified",
      final: null,
      dlpEndsOn: addCalendarMonths(today, 6),
    });
    expect(summary.cubes.failed).toBe(0);
  });

  it("takes the diary's workforce from attendance by trade, refreshes it at submission and keeps it once approved", async () => {
    await fresh();
    const setup = labourSetupResponseSchema.parse(
      (await owner.call("post", "labour/setup/defaults", {})).body,
    );
    const trade = (key: string) => setup.trades.find((entry) => entry.key === key)!;
    const level = setup.skillLevels.find((entry) => entry.key === "skilled")!.id;
    const workers: string[] = [];
    for (const key of ["mason", "mason", "general_labourer"]) {
      await fresh();
      const res = await owner.call("post", "labour/labourers", {
        fullName: `Mfanyakazi Ubora ${randomUUID().slice(0, 6)}`,
        dateOfBirth: "1990-05-17",
        gender: "female",
        tradeId: trade(key).id,
        skillLevelId: level,
        engagementType: "casual",
        rateBasis: "daily",
        idType: "national_id",
        idNumber: String(70_000_000 + Math.floor(Math.random() * 9_999_999)),
        projectId,
        engagementStartDate: addCalendarDays(today, -10),
        consent: {
          noticeVersion: CURRENT_CONSENT_NOTICE.version,
          language: "en",
          method: "signed",
          granted: true,
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      workers.push(labourerResponseSchema.parse(res.body).labourer.id);
    }
    const saveMuster = async (entries: object[]) => {
      const current = musterResponseSchema.parse(
        (
          await owner.call(
            "get",
            `attendance/projects/${projectId}/muster?siteId=${siteId}&date=${yesterday}`,
          )
        ).body,
      );
      const res = await owner.call("put", `attendance/projects/${projectId}/muster`, {
        siteId,
        date: yesterday,
        dayVersion: current.day?.version ?? 0,
        entries: entries.map((entry, index) => ({
          labourerId: workers[index],
          version:
            current.rows.find((row) => row.labourer.id === workers[index])?.record?.version ?? 0,
          ...entry,
        })),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    };
    await saveMuster([
      { status: "present", checkIn: "07:00", checkOut: "16:00" },
      { status: "half_day", checkIn: "07:00", checkOut: "12:00" },
      { status: "absent" },
    ]);
    const offer = ok(
      await agent.call(
        "get",
        `projects/${projectId}/diaries/attendance?siteId=${siteId}&date=${yesterday}`,
      ),
      (body) => diaryAttendanceResponseSchema.parse(body),
    );
    expect(offer).toMatchObject({
      musterStatus: "draft",
      total: 2,
      trades: [{ key: "mason", headcount: 2, halfDays: 1 }],
    });
    // The client cannot read attendance through the diary.
    expect(
      (
        await client.call(
          "get",
          `projects/${projectId}/diaries/attendance?siteId=${siteId}&date=${yesterday}`,
        )
      ).status,
    ).toBe(403);

    // A count sent with an attendance source is refused: the server takes the snapshot.
    problem(
      await agent.call("post", `projects/${projectId}/diaries`, {
        siteId,
        date: yesterday,
        workPerformed: "Slab curing",
        weather: null,
        delays: null,
        workforceCount: 40,
        workforceSource: "attendance",
      }),
      400,
    );
    let diary = ok(
      await agent.call("post", `projects/${projectId}/diaries`, {
        siteId,
        date: yesterday,
        workPerformed: "Slab curing and blockwork",
        weather: "Dry",
        delays: null,
        workforceCount: null,
        workforceSource: "attendance",
      }),
      (body) => diaryResponseSchema.parse(body).diary,
      201,
    );
    expect(diary).toMatchObject({
      workforceSource: "attendance",
      workforceCount: 2,
      workforce: { musterStatus: "draft", trades: [{ key: "mason", headcount: 2, halfDays: 1 }] },
    });
    const firstSnapshot = diary.workforce!.snapshotAt;

    // A forged attendance count is refused by the database.
    await expect(
      db.run(context(agent), (tx) =>
        tx.siteDiary.update({
          where: { id: diary.id },
          data: { workforceCount: 40, version: { increment: 1 } },
        }),
      ),
    ).rejects.toThrow(/match attendance/);

    // Attendance changes; submission refreshes the snapshot (two versions).
    await saveMuster([
      { status: "present", checkIn: "07:00", checkOut: "16:00" },
      { status: "half_day", checkIn: "07:00", checkOut: "12:00" },
      { status: "present", checkIn: "07:00", checkOut: "16:00" },
    ]);
    diary = ok(
      await agent.call("post", `projects/${projectId}/diaries/${diary.id}/actions`, {
        version: diary.version,
        action: "submit",
      }),
      (body) => diaryResponseSchema.parse(body).diary,
    );
    expect(diary).toMatchObject({ status: "submitted", version: 3, workforceCount: 3 });
    expect(diary.workforce!.trades.map((entry) => [entry.key, entry.headcount])).toEqual(
      expect.arrayContaining([
        ["mason", 2],
        ["general_labourer", 1],
      ]),
    );
    expect(diary.workforce!.snapshotAt >= firstSnapshot).toBe(true);
    diary = ok(
      await manager.call("post", `projects/${projectId}/diaries/${diary.id}/actions`, {
        version: diary.version,
        action: "approve",
      }),
      (body) => diaryResponseSchema.parse(body).diary,
    );
    // Approved diaries keep their snapshot, whatever attendance says later.
    await saveMuster([{ status: "absent" }, { status: "absent" }, { status: "absent" }]);
    const listed = (await agent.call("get", `projects/${projectId}/diaries?siteId=${siteId}`))
      .body as { diaries: { id: string; workforceCount: number | null }[] };
    expect(listed.diaries.find((entry) => entry.id === diary.id)?.workforceCount).toBe(3);
    await expect(
      db.run(context(agent), (tx) =>
        tx.siteDiary.update({
          where: { id: diary.id },
          data: { workforceSource: "manual", workforceCount: 3, version: { increment: 1 } },
        }),
      ),
    ).rejects.toThrow(/locked/);

    // A manual count stays possible, with its source.
    const manual = ok(
      await agent.call("post", `projects/${projectId}/diaries`, {
        siteId,
        date: addCalendarDays(today, -2),
        workPerformed: "Setting out",
        weather: null,
        delays: null,
        workforceCount: 6,
      }),
      (body) => diaryResponseSchema.parse(body).diary,
      201,
    );
    expect(manual).toMatchObject({ workforceSource: "manual", workforceCount: 6, workforce: null });
  });

  it("refuses clients and other companies, keeps settings to config.manage and audits safely", async () => {
    // A client assigned to the project sees nothing of the internal quality records.
    for (const path of ["summary", "inspections", "snags", "cubes", "slump-tests", "completion"])
      expect((await client.call("get", `${base()}/${path}`)).status, path).toBe(403);
    // RLS: another company sees 404s and no rows.
    expect((await outsider.call("get", `${base()}/snags`)).status).toBe(404);
    expect(
      await db.run(context(outsider, otherTenant), (tx) => tx.snag.count({ where: { projectId } })),
    ).toBe(0);
    expect(await prisma.inspection.count()).toBe(0);
    await expect(
      db.run(context(outsider, otherTenant), (tx) =>
        tx.qualitySettings.create({
          data: { tenantId, dlpMonths: 1, updatedBy: outsider.auth.user.id },
        }),
      ),
    ).rejects.toThrow();
    // Settings: readable by quality users, changed by config.manage only.
    const settings = ok(await agent.call("get", "quality/settings"), (body) =>
      qualitySettingsResponseSchema.parse(body),
    ).settings;
    expect(settings).toMatchObject({ dlpMonths: 6, cubeOverdueGraceDays: 2, version: 0 });
    expect(settings.permissions.canEdit).toBe(false);
    expect(
      (
        await agent.call("put", "quality/settings", {
          dlpMonths: 12,
          cubeOverdueGraceDays: 3,
          version: 0,
        })
      ).status,
    ).toBe(403);
    await fresh();
    const updated = ok(
      await owner.call("put", "quality/settings", {
        dlpMonths: 12,
        cubeOverdueGraceDays: 3,
        version: 0,
      }),
      (body) => qualitySettingsResponseSchema.parse(body),
    ).settings;
    expect(updated).toMatchObject({ dlpMonths: 12, version: 1 });

    const events = await db.run(context(), (tx) =>
      tx.auditEvent.findMany({
        where: { action: { startsWith: "quality." } },
        select: { action: true, metadata: true },
      }),
    );
    await fresh();
    expect(
      auditEventsResponseSchema
        .parse((await owner.call("get", "tenants/current/audit")).body)
        .events.some((event) => event.action.startsWith("quality.")),
    ).toBe(true);
    for (const action of [
      "quality.templates_loaded",
      "quality.template_created",
      "quality.template_revised",
      "quality.template_retired",
      "quality.inspection_created",
      "quality.inspection_updated",
      "quality.inspection_submitted",
      "quality.inspection_signed_off",
      "quality.inspection_returned",
      "quality.snag_raised",
      "quality.snag_fixed",
      "quality.snag_closed",
      "quality.snag_reopened",
      "quality.cube_set_recorded",
      "quality.cube_result_recorded",
      "quality.cube_result_corrected",
      "quality.cube_set_voided",
      "quality.slump_test_recorded",
      "quality.slump_test_corrected",
      "quality.completion_proposed",
      "quality.completion_withdrawn",
      "quality.completion_certified",
      "quality.settings_updated",
    ])
      expect(
        events.map((event) => event.action),
        action,
      ).toContain(action);
    // Free text (notes, descriptions, reasons, names) never reaches the audit log.
    const serialised = JSON.stringify(events);
    for (const text of [
      "Lab sheet transcription error",
      "Paint still flaking",
      "Client accepts the gate defect",
      "Photos of the cover blocks missing",
      "Synthetic defect",
      "Eng. Synthetic Consultant",
      "Re-plastered and painted",
      "Entered against the wrong pour",
    ])
      expect(serialised).not.toContain(text);
  });
});
