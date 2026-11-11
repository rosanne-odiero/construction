import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  auditEventsResponseSchema,
  diariesResponseSchema,
  diaryResponseSchema,
  projectResponseSchema,
  siteResponseSchema,
  tenantCreatedResponseSchema,
  type SiteDiary,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { Browser, notifications } from "./support.js";

describe("Site diary foundation (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let reviewer: Browser;
  let foreman: Browser;
  let outsider: Browser;
  let tenantId: string;
  let otherTenant: string;
  let projectId: string;
  let otherProject: string;
  let siteId: string;
  let notificationSpy: ReturnType<typeof vi.spyOn>;
  const content = {
    workPerformed: "Ground floor slab cast",
    weather: null,
    delays: null,
    workforceCount: null,
  };
  const path = () => `projects/${projectId}/diaries`;
  const context = (browser = owner, tenant = tenantId) => ({
    userId: browser.auth.user.id,
    tenantId: tenant,
    requestId: randomUUID(),
  });
  const created = (res: request.Response, status = 201) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return diaryResponseSchema.parse(res.body).diary;
  };
  const fresh = () =>
    prisma.session.update({
      where: { id: owner.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
  const action = (browser: Browser, diary: SiteDiary, actionName: string, reason?: string) =>
    browser.call("post", `${path()}/${diary.id}/actions`, {
      version: diary.version,
      action: actionName,
      ...(reason ? { reason } : {}),
    });
  const create = async (date: string) =>
    created(await owner.call("post", path(), { ...content, date, siteId }));

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
    outsider = new Browser(app);
    reviewer = new Browser(app);
    foreman = new Browser(app);
    for (const browser of [owner, outsider, reviewer, foreman]) await browser.register();
    for (const browser of [owner, outsider]) await browser.enroll();
    tenantId = tenantCreatedResponseSchema.parse(
      (await owner.call("post", "tenants", { name: "Diary company" })).body,
    ).tenant.id;
    otherTenant = tenantCreatedResponseSchema.parse(
      (await outsider.call("post", "tenants", { name: "Other diary company" })).body,
    ).tenant.id;
    projectId = projectResponseSchema.parse(
      (await owner.call("post", "projects", { name: "Diary project" })).body,
    ).project.id;
    otherProject = projectResponseSchema.parse(
      (await owner.call("post", "projects", { name: "Unassigned project" })).body,
    ).project.id;
    siteId = siteResponseSchema.parse(
      (
        await owner.call("post", `projects/${projectId}/sites`, {
          name: "Main plot",
          geofence: { kind: "radius", center: { lat: -1.1489, lng: 36.9612 }, radiusM: 40 },
        })
      ).body,
    ).site.id;
    for (const [member, role] of [
      [reviewer, "site_agent"],
      [foreman, "foreman"],
    ] as const) {
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
      expect(
        (
          await owner.call("put", `projects/${projectId}/members/${member.auth.user.id}`, {
            permissions:
              role === "foreman"
                ? ["projects.view", "site.diary"]
                : ["projects.view", "site.diary", "quality.manage"],
          })
        ).status,
      ).toBe(200);
    }
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("publishes the diary API and denies unauthenticated/CSRF-less requests", async () => {
    const spec = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (spec.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((entry) => Object.values(entry).map((operation) => operation.operationId));
    for (const name of [
      "listSiteDiaries",
      "createSiteDiary",
      "updateSiteDiary",
      "transitionSiteDiary",
    ])
      expect(operations).toContain(name);
    await request(app.getHttpServer()).get(`/api/v1/${path()}`).expect(401);
    expect(
      (await owner.call("post", path(), { ...content, date: "2026-01-01", siteId }, false)).status,
    ).toBe(403);
  });

  it("persists manual workforce and rejects duplicates, future days and mismatched sites", async () => {
    const diary = await create("2026-01-01");
    expect(diary).toMatchObject({
      status: "draft",
      workforceCount: null,
      workforceSource: "manual",
      version: 1,
    });
    expect(
      (await owner.call("post", path(), { ...content, siteId, date: diary.date })).status,
    ).toBe(409);
    expect(
      (await owner.call("post", path(), { ...content, siteId, date: "2099-01-01" })).status,
    ).toBe(409);
    expect(
      (
        await owner.call("post", `projects/${otherProject}/diaries`, {
          ...content,
          siteId,
          date: "2026-01-01",
        })
      ).status,
    ).toBe(404);
    expect(
      (await owner.call("post", path(), { ...content, siteId, date: "2026-02-30" })).status,
    ).toBe(400);
    expect(
      (await owner.call("post", path(), { ...content, siteId, date: "2026-01-02", tenantId }))
        .status,
    ).toBe(400);
    const loaded = diariesResponseSchema.parse((await owner.call("get", path())).body);
    expect(loaded.diaries).toContainEqual(diary);
  });

  it("checks role and project assignment, and hides other tenants and projects", async () => {
    const diary = await create("2026-01-02");
    expect((await outsider.call("get", path())).status).toBe(404);
    expect(
      (await outsider.call("patch", `${path()}/${diary.id}`, { ...content, version: 1 })).status,
    ).toBe(404);
    expect((await reviewer.call("get", `projects/${otherProject}/diaries`)).status).toBe(403);
    expect(
      (
        await owner.call("patch", `projects/${otherProject}/diaries/${diary.id}`, {
          ...content,
          version: 1,
        })
      ).status,
    ).toBe(404);
    expect(
      (await reviewer.call("patch", `${path()}/${diary.id}`, { ...content, version: 1 })).status,
    ).toBe(403);
    expect((await action(reviewer, diary, "submit")).status).toBe(403);
    const submitted = created(await action(owner, diary, "submit"), 200);
    expect((await action(owner, submitted, "approve")).status).toBe(403);
    expect((await action(foreman, submitted, "approve")).status).toBe(403);
  });

  it("serializes concurrent edits and enforces expected versions", async () => {
    const diary = await create("2026-01-03");
    const results = await Promise.all(
      [0, 9].map((workforceCount) =>
        owner.call("patch", `${path()}/${diary.id}`, {
          ...content,
          version: 1,
          workforceCount,
        }),
      ),
    );
    expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([200, 409]);
    const saved = diaryResponseSchema.parse(
      results.find((result) => result.status === 200)!.body,
    ).diary;
    expect(saved.version).toBe(2);
    expect([0, 9]).toContain(saved.workforceCount);
    expect((await action(owner, diary, "submit")).status).toBe(409);
    expect((await action(owner, saved, "approve")).status).toBe(409);
  });

  it("supports rejection, author correction and independent approval with immutable SQL backstops", async () => {
    let diary = await create("2026-01-04");
    diary = created(await action(owner, diary, "submit"), 200);
    expect(
      (await owner.call("patch", `${path()}/${diary.id}`, { ...content, version: diary.version }))
        .status,
    ).toBe(409);
    expect((await action(reviewer, diary, "reject")).status).toBe(400);
    const submitted = diary;
    diary = created(await action(reviewer, diary, "reject", "Include curing activities"), 200);
    expect(diary.reviewedBy).toBe(reviewer.auth.user.id);
    expect(diary.reviewReason).toBe("Include curing activities");
    expect((await action(reviewer, submitted, "approve")).status).toBe(409);
    diary = created(await action(owner, diary, "reopen"), 200);
    expect(diary).toMatchObject({
      status: "draft",
      reviewReason: null,
      reviewedBy: null,
      submittedAt: null,
    });
    diary = created(
      await owner.call("patch", `${path()}/${diary.id}`, {
        ...content,
        workPerformed: "Slab curing completed",
        workforceCount: 0,
        version: diary.version,
      }),
      200,
    );
    diary = created(await action(owner, diary, "submit"), 200);
    diary = created(await action(reviewer, diary, "approve"), 200);
    expect(diary).toMatchObject({ status: "approved", version: 7, workforceCount: 0 });
    expect(diary.reviewedAt).not.toBeNull();
    for (const operation of ["reopen", "reject", "submit", "approve"])
      expect(
        (await action(owner, diary, operation, operation === "reject" ? "Change it" : undefined))
          .status,
      ).toBe(409);
    await expect(
      db.run(context(), (tx) =>
        tx.siteDiary.update({
          where: { id: diary.id },
          data: { workPerformed: "Tampered", version: { increment: 1 } },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(context(), (tx) => tx.siteDiary.delete({ where: { id: diary.id } })),
    ).rejects.toThrow();
    const saved = await db.run(context(), (tx) =>
      tx.siteDiary.findUniqueOrThrow({ where: { id: diary.id } }),
    );
    expect(saved.workPerformed).toBe("Slab curing completed");
  });

  it("forces RLS, composite site references and lifecycle checks for direct SQL", async () => {
    const diary = await create("2026-01-05");
    expect(await prisma.siteDiary.count()).toBe(0);
    expect(
      await db.run(context(outsider, otherTenant), (tx) =>
        tx.siteDiary.count({ where: { id: diary.id } }),
      ),
    ).toBe(0);
    const raw = {
      ...content,
      tenantId,
      projectId,
      siteId,
      date: new Date("2026-01-06T00:00:00Z"),
      createdBy: owner.auth.user.id,
    };
    for (const data of [
      { ...raw, tenantId: otherTenant },
      { ...raw, projectId: otherProject },
      { ...raw, status: "approved" },
      { ...raw, date: new Date("2099-01-01T00:00:00Z") },
      { ...raw, workforceCount: -1 },
    ])
      await expect(db.run(context(), (tx) => tx.siteDiary.create({ data }))).rejects.toThrow();
    await expect(
      db.run(context(), (tx) =>
        tx.siteDiary.update({
          where: { id: diary.id },
          data: { date: new Date("2026-01-07T00:00:00Z"), version: 2 },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(context(), (tx) =>
        tx.siteDiary.update({
          where: { id: diary.id },
          data: { workPerformed: "Missing version" },
        }),
      ),
    ).rejects.toThrow();
    const submitted = created(await action(owner, diary, "submit"), 200);
    await expect(
      db.run(context(), (tx) =>
        tx.siteDiary.update({
          where: { id: diary.id },
          data: { workPerformed: "Cannot change submitted work", version: 3 },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(context(), (tx) =>
        tx.siteDiary.update({
          where: { id: diary.id },
          data: {
            status: "approved",
            reviewedBy: owner.auth.user.id,
            reviewedAt: new Date(),
            version: submitted.version + 1,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("paginates without duplicating diaries and refuses invalid query shapes", async () => {
    const first = diariesResponseSchema.parse((await owner.call("get", `${path()}?limit=2`)).body);
    expect(first.diaries).toHaveLength(2);
    expect(first.nextCursor).toBe(first.diaries.at(-1)?.id);
    const second = diariesResponseSchema.parse(
      (await owner.call("get", `${path()}?limit=2&cursor=${first.nextCursor}`)).body,
    );
    expect(second.diaries).toHaveLength(2);
    expect(second.diaries.some((row) => first.diaries.some((other) => row.id === other.id))).toBe(
      false,
    );
    expect((await owner.call("get", `${path()}?limit=101`)).status).toBe(400);
    expect((await owner.call("get", `${path()}?cursor=invalid`)).status).toBe(400);
  });

  it("records safe audit summaries without diary content", async () => {
    await fresh();
    const events = auditEventsResponseSchema.parse(
      (await owner.call("get", "tenants/current/audit")).body,
    ).events;
    const actions = events.filter((event) => event.action.startsWith("diary."));
    for (const action of [
      "diary.created",
      "diary.updated",
      "diary.submitted",
      "diary.rejected",
      "diary.reopened",
      "diary.approved",
    ])
      expect(
        actions.some((event) => event.action === action),
        action,
      ).toBe(true);
    expect(JSON.stringify(actions)).not.toContain("Ground floor slab");
    expect(JSON.stringify(actions)).not.toContain("Include curing");
  });

  it("applies assignment revocation immediately", async () => {
    await fresh();
    expect(
      (await owner.call("delete", `projects/${projectId}/members/${reviewer.auth.user.id}`)).status,
    ).toBe(200);
    expect((await reviewer.call("get", path())).status).toBe(403);
    const diary = await create("2026-01-08");
    const submitted = created(await action(owner, diary, "submit"), 200);
    expect((await action(reviewer, submitted, "approve")).status).toBe(403);
  });

  it("refuses API and SQL writes once the project is cancelled", async () => {
    await fresh();
    const cancelled = projectResponseSchema.parse(
      (await owner.call("post", "projects", { name: "Cancelled diary project" })).body,
    ).project;
    const site = siteResponseSchema.parse(
      (
        await owner.call("post", `projects/${cancelled.id}/sites`, {
          name: "Cancelled plot",
          geofence: { kind: "radius", center: { lat: -1.1489, lng: 36.9612 }, radiusM: 40 },
        })
      ).body,
    ).site;
    const diary = created(
      await owner.call("post", `projects/${cancelled.id}/diaries`, {
        ...content,
        siteId: site.id,
        date: "2026-01-09",
      }),
    );
    expect(
      (
        await owner.call("post", `projects/${cancelled.id}/status`, {
          to: "cancelled",
          version: cancelled.version,
          reason: "Cancelled for diary test",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await owner.call("post", `projects/${cancelled.id}/diaries`, {
          ...content,
          siteId: site.id,
          date: "2026-01-10",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await owner.call("patch", `projects/${cancelled.id}/diaries/${diary.id}`, {
          ...content,
          version: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await owner.call("post", `projects/${cancelled.id}/diaries/${diary.id}/actions`, {
          action: "submit",
          version: 1,
        })
      ).status,
    ).toBe(409);
    expect((await owner.call("get", `projects/${cancelled.id}/diaries`)).status).toBe(200);
    await expect(
      db.run(context(), (tx) =>
        tx.siteDiary.update({
          where: { id: diary.id },
          data: { workPerformed: "Closed project write", version: 2 },
        }),
      ),
    ).rejects.toThrow();
  });
});
