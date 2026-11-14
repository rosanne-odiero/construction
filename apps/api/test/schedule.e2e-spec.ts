import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaPg } from "@prisma/adapter-pg";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import {
  auditEventsResponseSchema,
  diaryResponseSchema,
  milestoneResponseSchema,
  projectResponseSchema,
  scheduleActivityResponseSchema,
  scheduleBaselineResponseSchema,
  scheduleBaselinesResponseSchema,
  scheduleDelayResponseSchema,
  scheduleDelaysResponseSchema,
  scheduleDependencyResponseSchema,
  scheduleResponseSchema,
  siteResponseSchema,
  tenantCreatedResponseSchema,
  type ScheduleItem,
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
 * D6.2 schedule against the real database as the runtime role (pmb_app): CRUD, CPM dates, cycle
 * refusal in the API and in SQL, optimistic versions, frozen baselines, variance, the versioned
 * delay log, tenant isolation (RLS) and permission refusals (role ∩ assignment).
 */
describe("Schedule (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let agent: Browser;
  let manager: Browser;
  let outsider: Browser;
  let tenantId: string;
  let otherTenant: string;
  let projectId: string;
  let otherProject: string;
  let notificationSpy: ReturnType<typeof vi.spyOn>;
  // The project starts ten days from today (Nairobi), so today's data date never moves the plan.
  const today = nairobiDate();
  const start = addCalendarDays(today, 10);
  const day = (offset: number) => addCalendarDays(start, offset);
  const ago = (days: number) => addCalendarDays(today, -days);
  const base = () => `projects/${projectId}/schedule`;
  const context = (browser = owner, tenant = tenantId) => ({
    userId: browser.auth.user.id,
    tenantId: tenant,
    requestId: randomUUID(),
  });
  const ok = <T>(res: request.Response, parse: (body: unknown) => T, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return parse(res.body);
  };
  const fresh = (browser = owner) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
  const schedule = async (query = "") =>
    ok(await owner.call("get", `${base()}${query}`), (body) => scheduleResponseSchema.parse(body));
  const activity = async (code: string, durationDays: number, extra: object = {}) =>
    ok(
      await owner.call("post", `${base()}/activities`, {
        code,
        name: `Activity ${code}`,
        durationDays,
        ...extra,
      }),
      (body) => scheduleActivityResponseSchema.parse(body).item,
      201,
    );
  const link = async (
    predecessor: { kind: "task" | "milestone"; id: string },
    successor: { kind: "task" | "milestone"; id: string },
    type = "FS",
    lagDays = 0,
  ) => owner.call("post", `${base()}/dependencies`, { predecessor, successor, type, lagDays });
  const task = (id: string) => ({ kind: "task" as const, id });
  const itemOf = (items: ScheduleItem[], code: string) =>
    items.find((item) => item.code === code || item.name === code)!;
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

  let ids: Record<string, string> = {};
  let milestoneId: string;

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
    agent = new Browser(app);
    manager = new Browser(app);
    outsider = new Browser(app);
    for (const browser of [owner, agent, manager, outsider]) await browser.register();
    for (const browser of [owner, outsider]) await browser.enroll();
    tenantId = tenantCreatedResponseSchema.parse(
      (await owner.call("post", "tenants", { name: `Schedule company ${randomUUID()}` })).body,
    ).tenant.id;
    otherTenant = tenantCreatedResponseSchema.parse(
      (await outsider.call("post", "tenants", { name: `Other schedule company ${randomUUID()}` }))
        .body,
    ).tenant.id;
    await fresh();
    const project = projectResponseSchema.parse(
      (await owner.call("post", "projects", { name: "Schedule project" })).body,
    ).project;
    projectId = project.id;
    expect(
      (
        await owner.call("patch", `projects/${projectId}`, {
          startDate: start,
          version: project.version,
        })
      ).status,
    ).toBe(200);
    await fresh();
    otherProject = projectResponseSchema.parse(
      (await owner.call("post", "projects", { name: "Unassigned schedule project" })).body,
    ).project.id;
    // A seven-day week without holidays keeps the expected dates simple calendar arithmetic.
    expect(
      (
        await owner.call("put", `${base()}/calendar`, {
          workingWeekdays: [1, 2, 3, 4, 5, 6, 7],
          includePublicHolidays: false,
          version: 0,
        })
      ).status,
    ).toBe(200);
    // Role ∩ assignment: the site agent's role lacks projects.manage even when assigned; the
    // project manager's role has it but the assignment does not.
    await join(agent, "site_agent", ["projects.view", "projects.manage", "site.diary"]);
    await join(manager, "project_manager", ["projects.view"]);
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("publishes the schedule API and refuses requests without a session or CSRF token", async () => {
    const spec = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (spec.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((entry) => Object.values(entry).map((operation) => operation.operationId));
    for (const name of [
      "getSchedule",
      "updateScheduleCalendar",
      "createScheduleActivity",
      "updateScheduleActivity",
      "recordScheduleProgress",
      "deleteScheduleActivity",
      "createScheduleDependency",
      "updateScheduleDependency",
      "deleteScheduleDependency",
      "listScheduleBaselines",
      "createScheduleBaseline",
      "getScheduleBaseline",
      "listScheduleDelays",
      "recordScheduleDelay",
      "getScheduleDelay",
      "amendScheduleDelay",
      "withdrawScheduleDelay",
    ])
      expect(operations).toContain(name);
    await request(app.getHttpServer()).get(`/api/v1/${base()}`).expect(401);
    expect(
      (
        await owner.call(
          "post",
          `${base()}/activities`,
          { code: "X1", name: "No CSRF", durationDays: 1 },
          false,
        )
      ).status,
    ).toBe(403);
  });

  it("creates activities and links, and computes CPM dates, float and the critical path", async () => {
    const empty = await schedule();
    expect(empty).toMatchObject({
      items: [],
      finish: null,
      baseline: null,
      start: { date: start, source: "project_start" },
      dataDate: today,
      progress: { ratio: null },
      projectVariance: { finishDays: null },
      permissions: { canEdit: true, canBaseline: true, canRecordDelay: true },
      calendar: {
        workingWeekdays: [1, 2, 3, 4, 5, 6, 7],
        includePublicHolidays: false,
        version: 1,
      },
    });
    const a = await activity("A", 5);
    const b = await activity("B", 3);
    const c = await activity("C", 2);
    const d = await activity("D", 4);
    ids = { A: a.id, B: b.id, C: c.id, D: d.id };
    expect(a).toMatchObject({
      planned: { start, finish: day(4) },
      progress: { basis: "physical", percentComplete: null },
      status: "not_started",
      version: 1,
      permissions: { canEdit: true, canRecordProgress: true, canDelete: true },
    });
    expect(
      (
        await owner.call("post", `${base()}/activities`, {
          code: "A",
          name: "Again",
          durationDays: 1,
        })
      ).body,
    ).toMatchObject({ code: "activity-code-taken" });

    milestoneId = milestoneResponseSchema.parse(
      (
        await owner.call("post", `projects/${projectId}/milestones`, {
          name: "Roof covered",
          dueDate: day(30),
        })
      ).body,
    ).milestone.id;
    const roof = { kind: "milestone" as const, id: milestoneId };
    for (const [res, status] of [
      [await link(task(a.id), task(b.id), "FS", 2), 201],
      [await link(task(a.id), task(c.id), "SS", 1), 201],
      [await link(task(b.id), roof), 201],
      [await link(roof, task(d.id)), 201],
    ] as const)
      expect(res.status, JSON.stringify(res.body)).toBe(status);

    const computed = await schedule();
    const items = computed.items;
    expect(itemOf(items, "B")).toMatchObject({ planned: { start: day(7), finish: day(9) } });
    expect(itemOf(items, "C")).toMatchObject({
      planned: { start: day(1), finish: day(2) },
      totalFloatDays: 11,
      critical: false,
    });
    expect(itemOf(items, "Roof covered")).toMatchObject({
      kind: "milestone",
      id: milestoneId,
      dueDate: day(30),
      planned: { start: day(9), finish: day(9) },
      critical: true,
      permissions: { canEdit: false, canRecordProgress: false, canDelete: false },
    });
    expect(itemOf(items, "Roof covered").activityId).not.toBeNull();
    expect(itemOf(items, "D")).toMatchObject({
      planned: { start: day(10), finish: day(13) },
      critical: true,
    });
    expect(computed.finish).toBe(day(13));
    expect(
      items
        .filter((item) => item.critical)
        .map((item) => item.code ?? item.name)
        .sort(),
    ).toEqual(["A", "B", "D", "Roof covered"]);
    expect(computed.dependencies.filter((dependency) => dependency.critical)).toHaveLength(3);
    expect(computed.progress.ratio).toBe(0);
  });

  it("refuses cycles in the API and in SQL, duplicates and links to cancelled milestones", async () => {
    const cycle = await link(task(ids.D!), task(ids.A!));
    expect(cycle.status).toBe(409);
    expect(cycle.body).toMatchObject({ code: "schedule-cycle" });
    expect((await link(task(ids.B!), task(ids.A!), "SS")).body).toMatchObject({
      code: "schedule-cycle",
    });
    expect((await link(task(ids.A!), task(ids.A!))).status).toBe(400);
    expect((await link(task(ids.A!), task(ids.B!), "SS")).body).toMatchObject({
      code: "dependency-exists",
    });
    expect((await link(task(ids.A!), task(ids.B!), "FS", -61)).status).toBe(400);
    // The database refuses the loop even when the API check is bypassed.
    await expect(
      db.run(context(), (tx) =>
        tx.scheduleDependency.create({
          data: {
            tenantId,
            projectId,
            predecessorId: ids.D!,
            successorId: ids.A!,
            type: "FS",
            createdBy: owner.auth.user.id,
            updatedBy: owner.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow(/cycle/);
    const cancelled = milestoneResponseSchema.parse(
      (
        await owner.call("post", `projects/${projectId}/milestones`, {
          name: "Cancelled marker",
          dueDate: day(5),
        })
      ).body,
    ).milestone;
    expect(
      (
        await owner.call("post", `projects/${projectId}/milestones/${cancelled.id}/status`, {
          to: "cancelled",
          reason: "Not needed",
          version: cancelled.version,
        })
      ).status,
    ).toBe(200);
    expect((await link(task(ids.A!), { kind: "milestone", id: cancelled.id })).body).toMatchObject({
      code: "milestone-cancelled",
    });
    expect((await link(task(ids.A!), task(randomUUID()))).status).toBe(404);
  });

  it("checks optimistic versions on activities and dependencies", async () => {
    const results = await Promise.all(
      ["First", "Second"].map((name) =>
        owner.call("patch", `${base()}/activities/${ids.C}`, { name, version: 1 }),
      ),
    );
    expect(results.map((res) => res.status).sort((x, y) => x - y)).toEqual([200, 409]);
    expect(results.find((res) => res.status === 409)!.body).toMatchObject({
      code: "version-conflict",
    });
    const current = await schedule();
    expect(itemOf(current.items, "C").version).toBe(2);
    expect(
      (await owner.call("patch", `${base()}/activities/${ids.C}`, { durationDays: 3, version: 1 }))
        .status,
    ).toBe(409);
    const dependency = current.dependencies.find(
      (entry) => entry.predecessor.id === ids.A && entry.successor.id === ids.C,
    )!;
    const changed = ok(
      await owner.call("patch", `${base()}/dependencies/${dependency.id}`, {
        lagDays: 2,
        version: dependency.version,
      }),
      (body) => scheduleDependencyResponseSchema.parse(body).dependency,
    );
    expect(changed).toMatchObject({ lagDays: 2, version: 2, type: "SS" });
    expect(
      (
        await owner.call("patch", `${base()}/dependencies/${dependency.id}`, {
          lagDays: 1,
          version: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (await owner.call("delete", `${base()}/dependencies/${dependency.id}?version=1`)).status,
    ).toBe(409);
    expect(
      (await owner.call("delete", `${base()}/dependencies/${dependency.id}?version=2`)).status,
    ).toBe(200);
    expect((await link(task(ids.A!), task(ids.C!), "SS", 1)).status).toBe(201);
  });

  it("freezes a baseline that SQL cannot change, and shows variance in working days", async () => {
    expect(
      (await owner.call("post", `${base()}/baselines`, { name: "Contract programme", reason: "" }))
        .status,
    ).toBe(400);
    const first = ok(
      await owner.call("post", `${base()}/baselines`, {
        name: "Contract programme",
        reason: "Agreed at the site handover meeting",
      }),
      (body) => scheduleBaselineResponseSchema.parse(body),
      201,
    );
    expect(first.baseline).toMatchObject({
      number: 1,
      current: true,
      itemCount: 5,
      dataDate: today,
      projectFinish: day(13),
      permissions: { canEdit: false, canDelete: false },
    });
    const frozen = await schedule();
    expect(frozen.items.every((item) => item.variance.finishDays === 0)).toBe(true);
    expect(frozen.projectVariance).toEqual({
      baselineFinish: day(13),
      finish: day(13),
      finishDays: 0,
    });

    // SQL cannot rewrite or remove a baseline: no privilege for the runtime role, and a trigger
    // refuses even the schema owner; items cannot be added after the baseline's transaction.
    const baselineId = first.baseline.id;
    await expect(
      db.run(context(), (tx) =>
        tx.scheduleBaseline.update({ where: { id: baselineId }, data: { name: "Tampered" } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(context(), (tx) => tx.scheduleBaseline.delete({ where: { id: baselineId } })),
    ).rejects.toThrow();
    await expect(
      db.run(context(), (tx) =>
        tx.scheduleBaselineItem.updateMany({
          where: { baselineId },
          data: { finishDate: new Date(`${day(40)}T00:00:00Z`) },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(context(), (tx) =>
        tx.scheduleBaselineItem.create({
          data: {
            tenantId,
            baselineId,
            kind: "task",
            refId: randomUUID(),
            name: "Smuggled",
            startDate: new Date(`${start}T00:00:00Z`),
            finishDate: new Date(`${start}T00:00:00Z`),
            durationDays: 1,
            critical: false,
          },
        }),
      ),
    ).rejects.toThrow(/written only with their baseline/);
    const schemaOwner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrls().migrationUrl }),
    });
    try {
      for (const statement of [
        `UPDATE schedule_baselines SET name = 'Tampered' WHERE id = '${baselineId}'`,
        `DELETE FROM schedule_baselines WHERE id = '${baselineId}'`,
        `UPDATE schedule_baseline_items SET critical = NOT critical WHERE baseline_id = '${baselineId}'`,
      ])
        await expect(
          schemaOwner.$transaction([
            schemaOwner.$executeRawUnsafe(
              `SELECT set_config('app.tenant_id', '${tenantId}', true)`,
            ),
            schemaOwner.$executeRawUnsafe(statement),
          ]),
        ).rejects.toThrow(/append-only/);
    } finally {
      await schemaOwner.$disconnect();
    }

    // The plan slips: A takes three days longer, pushing B, the milestone and D.
    const a = itemOf(frozen.items, "A");
    expect(
      (
        await owner.call("patch", `${base()}/activities/${a.id}`, {
          durationDays: 8,
          version: a.version,
        })
      ).status,
    ).toBe(200);
    const added = await activity("E", 2);
    const c = itemOf(frozen.items, "C");
    expect(
      (await owner.call("delete", `${base()}/activities/${c.id}?version=${c.version}`)).status,
    ).toBe(200);
    const slipped = await schedule();
    expect(itemOf(slipped.items, "A")).toMatchObject({
      baseline: { start, finish: day(4) },
      planned: { start, finish: day(7) },
      variance: { startDays: 0, finishDays: 3 },
    });
    expect(itemOf(slipped.items, "B").variance).toEqual({ startDays: 3, finishDays: 3 });
    expect(itemOf(slipped.items, "Roof covered").variance).toEqual({
      startDays: null,
      finishDays: 3,
    });
    expect(itemOf(slipped.items, "D").variance).toEqual({ startDays: 3, finishDays: 3 });
    // An activity added after the baseline has no baseline: variance is unavailable, not zero.
    expect(itemOf(slipped.items, "E")).toMatchObject({
      id: added.id,
      baseline: null,
      variance: { startDays: null, finishDays: null },
    });
    expect(slipped.removedSinceBaseline).toEqual([
      { kind: "task", id: c.id, code: "C", name: c.name },
    ]);
    expect(slipped.projectVariance).toEqual({
      baselineFinish: day(13),
      finish: day(16),
      finishDays: 3,
    });

    // Re-baselining appends a new current baseline and keeps the first for comparison.
    const second = ok(
      await owner.call("post", `${base()}/baselines`, {
        name: "Revised programme",
        reason: "Extension of time agreed for the redesign",
      }),
      (body) => scheduleBaselineResponseSchema.parse(body),
      201,
    );
    expect(second.baseline).toMatchObject({ number: 2, current: true, itemCount: 5 });
    const list = ok(await owner.call("get", `${base()}/baselines`), (body) =>
      scheduleBaselinesResponseSchema.parse(body),
    );
    expect(list.baselines.map((entry) => [entry.number, entry.current])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect((await schedule()).projectVariance.finishDays).toBe(0);
    const againstFirst = await schedule(`?baselineId=${baselineId}`);
    expect(againstFirst.baseline).toMatchObject({ number: 1, current: false });
    expect(againstFirst.currentBaselineId).toBe(second.baseline.id);
    expect(againstFirst.projectVariance.finishDays).toBe(3);
    expect((await owner.call("get", `${base()}?baselineId=${randomUUID()}`)).status).toBe(404);
    const stored = ok(await owner.call("get", `${base()}/baselines/${baselineId}`), (body) =>
      scheduleBaselineResponseSchema.parse(body),
    );
    expect(stored.items.find((item) => item.code === "A")).toMatchObject({
      start,
      finish: day(4),
      durationDays: 5,
      critical: true,
    });
  });

  it("records actual dates and progress with a defined basis", async () => {
    const current = await schedule();
    const e = itemOf(current.items, "E");
    const put = (body: object) => owner.call("put", `${base()}/activities/${e.id}/progress`, body);
    expect(
      (
        await put({
          version: e.version,
          actualStart: addCalendarDays(today, 1),
          actualFinish: null,
          basis: "physical",
        })
      ).body,
    ).toMatchObject({ code: "actual-date-future" });
    expect(
      (
        await put({
          version: e.version,
          actualStart: null,
          actualFinish: ago(1),
          basis: "physical",
        })
      ).body,
    ).toMatchObject({ code: "finish-without-start" });
    expect(
      (
        await put({
          version: e.version,
          actualStart: ago(3),
          actualFinish: null,
          basis: "physical",
          percentComplete: 100,
        })
      ).body,
    ).toMatchObject({ code: "progress-inconsistent" });
    expect(
      (
        await put({
          version: e.version,
          actualStart: null,
          actualFinish: null,
          basis: "physical",
          percentComplete: 10,
        })
      ).body,
    ).toMatchObject({ code: "progress-without-start" });
    const measured = ok(
      await put({
        version: e.version,
        actualStart: ago(3),
        actualFinish: null,
        basis: "quantity",
        quantityDone: "120",
        quantityTotal: "400",
        quantityUnit: "m2",
      }),
      (body) => scheduleActivityResponseSchema.parse(body).item,
    );
    expect(measured).toMatchObject({
      status: "in_progress",
      actualStart: ago(3),
      progress: {
        basis: "quantity",
        percentComplete: 30,
        quantityDone: "120",
        quantityTotal: "400",
      },
      permissions: { canDelete: false },
    });
    expect(
      (
        await put({
          version: e.version,
          actualStart: ago(3),
          actualFinish: null,
          basis: "physical",
          percentComplete: 40,
        })
      ).status,
    ).toBe(409);
    const done = ok(
      await put({
        version: measured.version!,
        actualStart: ago(3),
        actualFinish: ago(1),
        basis: "physical",
      }),
      (body) => scheduleActivityResponseSchema.parse(body).item,
    );
    expect(done).toMatchObject({
      status: "complete",
      planned: { start: ago(3), finish: ago(1) },
      progress: { basis: "physical", percentComplete: 100 },
      totalFloatDays: null,
      critical: false,
    });
    expect(
      (await owner.call("delete", `${base()}/activities/${e.id}?version=${done.version}`)).body,
    ).toMatchObject({ code: "activity-started" });
    // The database refuses a future actual date and a finish before the start.
    for (const data of [
      { actualStart: new Date(`${addCalendarDays(today, 2)}T00:00:00Z`) },
      { actualFinish: new Date(`${ago(10)}T00:00:00Z`) },
    ])
      await expect(
        db.run(context(), (tx) =>
          tx.scheduleActivity.update({
            where: { id: e.id },
            data: { ...data, version: done.version! + 1, updatedBy: owner.auth.user.id },
          }),
        ),
      ).rejects.toThrow();
    expect((await schedule()).progress.ratio).not.toBeNull();
  });

  it("keeps a versioned, append-only delay log with causes and a claim-support flag", async () => {
    const current = await schedule();
    const b = itemOf(current.items, "B");
    const site = siteResponseSchema.parse(
      (
        await owner.call("post", `projects/${projectId}/sites`, {
          name: "Main plot",
          geofence: { kind: "radius", center: { lat: -1.1489, lng: 36.9612 }, radiusM: 40 },
        })
      ).body,
    ).site;
    const diary = diaryResponseSchema.parse(
      (
        await owner.call("post", `projects/${projectId}/diaries`, {
          siteId: site.id,
          date: ago(4),
          workPerformed: "Trenches flooded; pumping all day",
          weather: "Heavy rain",
          delays: null,
          workforceCount: 12,
        })
      ).body,
    ).diary;
    const content = {
      cause: "weather",
      startDate: ago(5),
      endDate: ago(3),
      workingDaysLost: 2.5,
      description: "Long rains flooded the foundation trenches",
      siteDiaryId: diary.id,
      claimFlag: "excusable",
      activityIds: [b.id],
    };
    for (const [body, code] of [
      [{ ...content, workingDaysLost: 4 }, "delay-days-exceed-range"],
      [{ ...content, startDate: addCalendarDays(today, 1), endDate: null }, "delay-date-future"],
      [{ ...content, endDate: ago(6) }, "delay-dates-invalid"],
    ] as const)
      expect((await owner.call("post", `${base()}/delays`, body)).body).toMatchObject({ code });
    expect(
      (await owner.call("post", `${base()}/delays`, { ...content, activityIds: [randomUUID()] }))
        .status,
    ).toBe(404);
    const recorded = ok(
      await owner.call("post", `${base()}/delays`, content),
      (body) => scheduleDelayResponseSchema.parse(body),
      201,
    );
    expect(recorded.delay).toMatchObject({
      number: 1,
      version: 1,
      status: "recorded",
      cause: "weather",
      claimFlag: "excusable",
      workingDaysLost: 2.5,
      workingDaysInPeriod: 3,
      siteDiary: { id: diary.id, date: ago(4), siteId: site.id },
      activities: [{ id: b.id, code: "B" }],
      changeReason: null,
      permissions: { canAmend: true, canWithdraw: true },
    });
    const second = ok(
      await owner.call("post", `${base()}/delays`, {
        cause: "supplier_material",
        startDate: ago(2),
        endDate: null,
        workingDaysLost: 1,
        description: "Y12 steel delivery late",
        activityIds: [],
      }),
      (body) => scheduleDelayResponseSchema.parse(body).delay,
      201,
    );
    expect(second).toMatchObject({ number: 2, endDate: null, claimFlag: "not_assessed" });

    const delayId = recorded.delay.id;
    const amended = ok(
      await owner.call("post", `${base()}/delays/${delayId}/amend`, {
        ...content,
        workingDaysLost: 3,
        claimFlag: "compensable",
        version: 1,
        reason: "Engineer confirmed the third day",
      }),
      (body) => scheduleDelayResponseSchema.parse(body),
    );
    expect(amended.delay).toMatchObject({ id: delayId, number: 1, version: 2, workingDaysLost: 3 });
    expect(amended.history.map((entry) => entry.version)).toEqual([2, 1]);
    expect(amended.history[1]).toMatchObject({ workingDaysLost: 2.5, claimFlag: "excusable" });
    expect(
      (
        await owner.call("post", `${base()}/delays/${delayId}/amend`, {
          ...content,
          version: 1,
          reason: "Stale copy",
        })
      ).body,
    ).toMatchObject({ code: "version-conflict" });
    expect(
      (await owner.call("post", `${base()}/delays/${delayId}/amend`, { ...content, version: 2 }))
        .status,
    ).toBe(400);
    const withdrawn = ok(
      await owner.call("post", `${base()}/delays/${delayId}/withdraw`, {
        version: 2,
        reason: "Recorded against the wrong project",
      }),
      (body) => scheduleDelayResponseSchema.parse(body),
    );
    expect(withdrawn.delay).toMatchObject({
      status: "withdrawn",
      version: 3,
      permissions: { canAmend: false, canWithdraw: false },
    });
    expect(
      (
        await owner.call("post", `${base()}/delays/${delayId}/amend`, {
          ...content,
          version: 3,
          reason: "Try again",
        })
      ).body,
    ).toMatchObject({ code: "delay-withdrawn" });
    const log = ok(await owner.call("get", `${base()}/delays`), (body) =>
      scheduleDelaysResponseSchema.parse(body),
    );
    expect(log.delays.map((delay) => [delay.number, delay.status])).toEqual([
      [2, "recorded"],
      [1, "withdrawn"],
    ]);
    expect(log.totals).toEqual({
      count: 1,
      workingDaysLost: 1,
      byCause: [{ cause: "supplier_material", count: 1, workingDaysLost: 1 }],
    });
    // A delayed activity keeps its place in the log: it cannot be deleted.
    expect(
      (await owner.call("delete", `${base()}/activities/${b.id}?version=${b.version}`)).body,
    ).toMatchObject({ code: "activity-in-use" });
    // The log is append-only in SQL too.
    await expect(
      db.run(context(), (tx) =>
        tx.scheduleDelay.updateMany({ where: { delayId }, data: { description: "Tampered" } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(context(), (tx) =>
        tx.scheduleDelayActivity.deleteMany({ where: { activityId: b.id } }),
      ),
    ).rejects.toThrow();
    // A diary from another project cannot be cited.
    const otherSite = siteResponseSchema.parse(
      (
        await owner.call("post", `projects/${otherProject}/sites`, {
          name: "Other plot",
          geofence: { kind: "radius", center: { lat: -1.1489, lng: 36.9612 }, radiusM: 40 },
        })
      ).body,
    ).site;
    const otherDiary = diaryResponseSchema.parse(
      (
        await owner.call("post", `projects/${otherProject}/diaries`, {
          siteId: otherSite.id,
          date: ago(1),
          workPerformed: "Setting out",
          weather: null,
          delays: null,
          workforceCount: null,
        })
      ).body,
    ).diary;
    expect(
      (
        await owner.call("post", `${base()}/delays`, {
          ...content,
          siteDiaryId: otherDiary.id,
        })
      ).status,
    ).toBe(404);
  });

  it("enforces project permissions (role ∩ assignment) and the record flags follow them", async () => {
    for (const member of [agent, manager]) {
      const view = ok(await member.call("get", base()), (body) =>
        scheduleResponseSchema.parse(body),
      );
      expect(view.permissions).toEqual({
        canEdit: false,
        canBaseline: false,
        canRecordDelay: false,
      });
      expect(
        view.items.every((item) => !item.permissions.canEdit && !item.permissions.canDelete),
      ).toBe(true);
      expect(view.dependencies.every((dependency) => !dependency.permissions.canEdit)).toBe(true);
      const delays = ok(await member.call("get", `${base()}/delays`), (body) =>
        scheduleDelaysResponseSchema.parse(body),
      );
      expect(delays.permissions.canRecord).toBe(false);
      expect(delays.delays.every((delay) => !delay.permissions.canAmend)).toBe(true);
      const a = itemOf(view.items, "A");
      for (const [method, path, body] of [
        ["post", `${base()}/activities`, { code: "Z9", name: "Refused", durationDays: 1 }],
        ["patch", `${base()}/activities/${a.id}`, { name: "Refused", version: a.version }],
        [
          "put",
          `${base()}/activities/${a.id}/progress`,
          { version: a.version, actualStart: null, actualFinish: null, basis: "physical" },
        ],
        ["post", `${base()}/baselines`, { name: "Refused", reason: "Not allowed" }],
        [
          "post",
          `${base()}/delays`,
          {
            cause: "other",
            startDate: today,
            endDate: null,
            workingDaysLost: 0,
            description: "Refused",
            activityIds: [],
          },
        ],
        [
          "put",
          `${base()}/calendar`,
          { workingWeekdays: [1], includePublicHolidays: true, version: 1 },
        ],
      ] as const)
        expect((await member.call(method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    expect((await agent.call("get", `projects/${otherProject}/schedule`)).status).toBe(403);
  });

  it("isolates companies (RLS) and keeps closed projects read-only", async () => {
    expect((await outsider.call("get", base())).status).toBe(404);
    expect((await outsider.call("get", `${base()}/delays`)).status).toBe(404);
    expect(
      await db.run(context(outsider, otherTenant), (tx) =>
        tx.scheduleActivity.count({ where: { projectId } }),
      ),
    ).toBe(0);
    expect(await prisma.scheduleBaseline.count()).toBe(0);
    await expect(
      db.run(context(outsider, otherTenant), (tx) =>
        tx.scheduleActivity.create({
          data: {
            tenantId,
            projectId,
            kind: "task",
            code: "RLS",
            name: "Cross-company",
            durationDays: 1,
            progressBasis: "physical",
            createdBy: outsider.auth.user.id,
            updatedBy: outsider.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();

    await fresh();
    const closing = projectResponseSchema.parse(
      (await owner.call("post", "projects", { name: "Cancelled schedule project" })).body,
    ).project;
    const kept = ok(
      await owner.call("post", `projects/${closing.id}/schedule/activities`, {
        code: "K1",
        name: "Kept",
        durationDays: 2,
      }),
      (body) => scheduleActivityResponseSchema.parse(body).item,
      201,
    );
    expect(
      (
        await owner.call("post", `projects/${closing.id}/status`, {
          to: "cancelled",
          reason: "Client withdrew",
          version: closing.version,
        })
      ).status,
    ).toBe(200);
    const view = ok(await owner.call("get", `projects/${closing.id}/schedule`), (body) =>
      scheduleResponseSchema.parse(body),
    );
    expect(view.permissions.canEdit).toBe(false);
    expect(view.items[0]!.permissions).toEqual({
      canEdit: false,
      canRecordProgress: false,
      canDelete: false,
    });
    expect(
      (
        await owner.call("patch", `projects/${closing.id}/schedule/activities/${kept.id}`, {
          name: "Changed",
          version: kept.version,
        })
      ).body,
    ).toMatchObject({ code: "project-read-only" });
    await expect(
      db.run(context(), (tx) =>
        tx.scheduleActivity.update({
          where: { id: kept.id },
          data: { name: "Changed in SQL", version: 2, updatedBy: owner.auth.user.id },
        }),
      ),
    ).rejects.toThrow(/read-only/);
  });

  it("audits every change with codes and field names, never descriptions or reasons", async () => {
    const events = await db.run(context(), (tx) =>
      tx.auditEvent.findMany({
        where: { action: { startsWith: "schedule." } },
        select: { action: true, metadata: true },
      }),
    );
    await fresh();
    // The audit API serves the same events to auditors.
    expect(
      auditEventsResponseSchema
        .parse((await owner.call("get", "tenants/current/audit")).body)
        .events.some((event) => event.action.startsWith("schedule.")),
    ).toBe(true);
    for (const action of [
      "schedule.calendar_updated",
      "schedule.activity_created",
      "schedule.activity_updated",
      "schedule.activity_deleted",
      "schedule.progress_recorded",
      "schedule.dependency_created",
      "schedule.dependency_updated",
      "schedule.dependency_deleted",
      "schedule.milestone_linked",
      "schedule.baseline_created",
      "schedule.delay_recorded",
      "schedule.delay_amended",
      "schedule.delay_withdrawn",
    ])
      expect(
        events.some((event) => event.action === action),
        action,
      ).toBe(true);
    const text = JSON.stringify(events);
    for (const secret of [
      "Long rains",
      "Engineer confirmed",
      "wrong project",
      "Extension of time",
      "site handover",
    ])
      expect(text).not.toContain(secret);
  });
});
