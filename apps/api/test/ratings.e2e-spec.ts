import { randomInt } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaPg } from "@prisma/adapter-pg";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import { CURRENT_CONSENT_NOTICE } from "@pm-buddy/types";
import {
  labourerRatingsResponseSchema,
  labourerResponseSchema,
  labourSetupResponseSchema,
  musterResponseSchema,
  projectResponseSchema,
  ratingProjectsResponseSchema,
  ratingResponseSchema,
  ratingSheetResponseSchema,
  siteResponseSchema,
  workerRatingsResponseSchema,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { Browser, notifications } from "./support.js";
import { testDatabaseUrls } from "./test-database.js";

const PIN = "274915";
const phone = () => `2547${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;
const ruiru = { lat: -1.1489, lng: 36.9612 };
const scores = (punctuality: number, quality: number, safety: number, teamwork: number) => ({
  punctuality,
  quality,
  safety,
  teamwork,
});

describe("Worker ratings (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let ownerB: Browser;
  let pm: Browser;
  let agent: Browser;
  let foreman: Browser;
  let qs: Browser;
  let outsider: Browser;
  let finance: Browser;
  let tenantA: string;
  let tenantB: string;
  let p1: string;
  let p2: string;
  let p3: string;
  let main: string;
  let yard: string;
  let second: string;
  let seq = 0;
  let notificationSpy: ReturnType<typeof vi.spyOn>;
  const workers: Record<string, string> = {};
  const w1Phone = phone();
  const sharedPhone = phone();

  const today = nairobiDate();
  const threeDaysAgo = addCalendarDays(today, -3);
  const weekAgo = addCalendarDays(today, -7);

  const fresh = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
  const as = (browser: Browser, tenantId: string, requestId = "e2e-ratings") => ({
    userId: browser.auth.user.id,
    tenantId,
    requestId,
  });
  const problem = (res: request.Response) => (res.body as { code?: string }).code;
  const ok = (res: request.Response, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as unknown;
  };

  const join = async (member: Browser, role: string, projectIds: string[]) => {
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
    ok(await member.call("post", `tenants/${tenantA}/select`, {}));
  };
  const site = async (projectId: string, name: string, east: number) =>
    siteResponseSchema.parse(
      ok(
        await owner.call("post", `projects/${projectId}/sites`, {
          name,
          geofence: {
            kind: "radius",
            center: { lat: ruiru.lat, lng: Math.round((ruiru.lng + east / 111_173) * 1e6) / 1e6 },
            radiusM: 50,
          },
        }),
        201,
      ),
    ).site.id;
  const register = async (
    key: string,
    projectId: string,
    setup: { trade: string; level: string },
    extra: Record<string, unknown> = {},
  ) => {
    seq += 1;
    const res = await owner.call("post", "labour/labourers", {
      fullName: `Mfanyakazi Tathmini ${key}`,
      dateOfBirth: "1991-03-11",
      gender: "female",
      tradeId: setup.trade,
      skillLevelId: setup.level,
      engagementType: "casual",
      rateBasis: "daily",
      idType: "national_id",
      idNumber: `8${String(seq).padStart(7, "0")}`,
      projectId,
      engagementStartDate: addCalendarDays(today, -40),
      consent: {
        noticeVersion: CURRENT_CONSENT_NOTICE.version,
        language: "sw",
        method: "signed",
        granted: true,
      },
      ...extra,
    });
    workers[key] = labourerResponseSchema.parse(ok(res, 201)).labourer.id;
  };
  /**
   * The owner records a muster day (saved, not submitted: ratings only need the record). Entries
   * carry the versions just read, so a day can be saved again with changed statuses.
   */
  const muster = async (
    projectId: string,
    siteId: string,
    date: string,
    entries: { labourerId: string | undefined }[],
  ) => {
    const current = musterResponseSchema.parse(
      ok(
        await owner.call(
          "get",
          `attendance/projects/${projectId}/muster?siteId=${siteId}&date=${date}`,
        ),
      ),
    );
    const versions = new Map(current.rows.map((row) => [row.labourer.id, row.record?.version]));
    ok(
      await owner.call("put", `attendance/projects/${projectId}/muster`, {
        siteId,
        date,
        dayVersion: current.day?.version ?? 0,
        entries: entries.map((entry) => ({
          ...entry,
          version: versions.get(entry.labourerId!) ?? 0,
        })),
      }),
    );
  };
  const present = (key: string) => ({
    labourerId: workers[key],
    version: 0,
    status: "present",
    checkIn: "07:00",
    checkOut: "16:00",
  });
  const halfDay = (key: string) => ({
    labourerId: workers[key],
    version: 0,
    status: "half_day",
    checkIn: "07:00",
    checkOut: "11:30",
  });
  const absent = (key: string) => ({ labourerId: workers[key], version: 0, status: "absent" });
  const rate = (
    browser: Browser,
    projectId: string,
    key: string,
    workDate = today,
    values = scores(4, 4, 5, 3),
    comment?: string,
  ) =>
    browser.call("post", `labour/projects/${projectId}/ratings`, {
      labourerId: workers[key],
      workDate,
      scores: values,
      ...(comment === undefined ? {} : { comment }),
    });
  const rated = (res: request.Response) => ratingResponseSchema.parse(ok(res, 201)).rating;
  /** As the schema owner: moves a rating's given-at time back a day (time passing). */
  const givenYesterday = async (ratingId: string) => {
    const schemaOwner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrls().migrationUrl }),
    });
    try {
      await schemaOwner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `ALTER TABLE labourer_ratings DISABLE TRIGGER labourer_rating_guard`,
        );
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        await tx.$executeRaw`UPDATE labourer_ratings SET rated_at = rated_at - interval '1 day'
          WHERE id = ${ratingId}::uuid`;
        await tx.$executeRawUnsafe(
          `ALTER TABLE labourer_ratings ENABLE TRIGGER labourer_rating_guard`,
        );
      });
    } finally {
      await schemaOwner.$disconnect();
    }
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
    [owner, ownerB, pm, agent, foreman, qs, outsider, finance] = Array.from(
      { length: 8 },
      () => new Browser(app),
    );
    for (const browser of [owner, ownerB, finance]) {
      await browser.register();
      await browser.enroll();
    }
    for (const browser of [pm, agent, foreman, qs, outsider]) await browser.register();
    const a = await owner.call("post", "tenants", { name: "Ratings company A" });
    const b = await ownerB.call("post", "tenants", { name: "Ratings company B" });
    tenantA = (ok(a, 201) as { tenant: { id: string } }).tenant.id;
    tenantB = (ok(b, 201) as { tenant: { id: string } }).tenant.id;
    await fresh(owner);
    const project = async (code: string, name: string) =>
      projectResponseSchema.parse(ok(await owner.call("post", "projects", { code, name }), 201))
        .project;
    p1 = (await project("RAT-ONE", "Ratings one")).id;
    p2 = (await project("RAT-TWO", "Ratings two")).id;
    const third = await project("RAT-THR", "Ratings three");
    p3 = third.id;
    main = await site(p1, "Main plot", 0);
    yard = await site(p1, "Yard", 300);
    second = await site(p2, "Second plot", 900);
    await join(pm, "project_manager", [p1]);
    await join(agent, "site_agent", [p1, p3]);
    await join(foreman, "foreman", [p1]);
    await join(qs, "quantity_surveyor", [p1]);
    await join(outsider, "site_agent", [p2]);
    await join(finance, "finance", []);

    const setup = labourSetupResponseSchema.parse(
      ok(await owner.call("post", "labour/setup/defaults", {})),
    );
    const general = {
      trade: setup.trades.find((trade) => trade.key === "general_labourer")!.id,
      level: setup.skillLevels.find((level) => level.key === "unskilled")!.id,
    };
    await register("W1", p1, general, { phone: w1Phone });
    for (const key of ["W2", "W3", "W4"]) await register(key, p1, general);
    await register("W5", p2, general);
    // W6 and W7 share one (family) phone: a portal account with it is linked to neither.
    for (const key of ["W6", "W7"]) await register(key, p1, general, { phone: sharedPhone });
    ok(
      await owner.call("post", `labour/labourers/${workers.W4}/engagements`, {
        projectId: p2,
        startDate: addCalendarDays(today, -40),
      }),
      201,
    );
    await muster(p1, main, today, [present("W1"), halfDay("W2"), absent("W3")]);
    await muster(p1, yard, today, [present("W4")]);
    await muster(p1, main, threeDaysAgo, [present("W1")]);
    await muster(p1, main, weekAgo, [present("W1")]);
    await muster(p2, second, today, [present("W5")]);
    await fresh(owner);
    ok(
      await owner.call("post", `projects/${p3}/status`, {
        to: "cancelled",
        version: third.version,
        reason: "Cancelled for the ratings test",
      }),
    );
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("documents every rating operation in OpenAPI", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "listRatingProjects",
      "getRatingSheet",
      "createRating",
      "updateRating",
      "listLabourerRatings",
      "getWorkerRatings",
    ])
      expect(operations, id).toContain(id);
  });

  it("lists the open projects a rater may rate in, with the seven-day window", async () => {
    const projects = ratingProjectsResponseSchema.parse(
      ok(await agent.call("get", "labour/ratings/projects")),
    );
    expect(projects.window).toEqual({ from: addCalendarDays(today, -6), to: today });
    // The cancelled project is left out; project two is not the agent's. W1, W2 (half day) and W4
    // (on the yard) worked on project one today; W3 was absent.
    expect(projects.projects.map((row) => [row.id, row.workingToday])).toEqual([[p1, 3]]);
    expect((await qs.call("get", "labour/ratings/projects")).status).toBe(403);
    expect((await finance.call("get", "labour/ratings/projects")).status).toBe(403);
  });

  it("shows the day's sheet: everyone who worked (present or half day), on any site", async () => {
    const sheet = ratingSheetResponseSchema.parse(
      ok(await foreman.call("get", `labour/projects/${p1}/ratings`)),
    );
    expect(sheet).toMatchObject({ date: today, canRate: true, project: { readOnly: false } });
    expect(
      sheet.workers.map((row) => [row.labourer.id, row.attendance, row.sites, row.rating]),
    ).toEqual([
      [workers.W1, "present", ["Main plot"], null],
      [workers.W2, "half_day", ["Main plot"], null],
      [workers.W4, "present", ["Yard"], null],
    ]);
    const old = ratingSheetResponseSchema.parse(
      ok(await foreman.call("get", `labour/projects/${p1}/ratings?date=${weekAgo}`)),
    );
    expect(old.workers.map((row) => row.labourer.id)).toEqual([workers.W1]);
    expect(old.canRate).toBe(false);
    expect(
      problem(
        await foreman.call(
          "get",
          `labour/projects/${p1}/ratings?date=${addCalendarDays(today, 1)}`,
        ),
      ),
    ).toBe("date-in-future");
    expect((await qs.call("get", `labour/projects/${p1}/ratings`)).status).toBe(403);
    expect((await outsider.call("get", `labour/projects/${p1}/ratings`)).status).toBe(403);
    expect((await ownerB.call("get", `labour/projects/${p1}/ratings`)).status).toBe(404);
  });

  it("rates a worked day once, inside the window, for the people who run the site", async () => {
    const first = rated(await rate(agent, p1, "W1", today, scores(5, 4, 4, 4), "  Kazi nzuri  "));
    expect(first).toMatchObject({
      labourerId: workers.W1,
      workDate: today,
      scores: scores(5, 4, 4, 4),
      average: 4.3,
      comment: "Kazi nzuri",
      ratedBy: { id: agent.auth.user.id },
      changedAt: null,
      version: 1,
      canChange: true,
    });
    expect(problem(await rate(foreman, p1, "W1"))).toBe("already-rated");
    expect(rated(await rate(foreman, p1, "W2")).ratedBy.id).toBe(foreman.auth.user.id);
    expect(rated(await rate(pm, p1, "W4")).scores).toEqual(scores(4, 4, 5, 3));
    expect(rated(await rate(agent, p1, "W1", threeDaysAgo, scores(3, 3, 2, 4))).average).toBe(3);

    expect(problem(await rate(agent, p1, "W3"))).toBe("not-worked"); // absent
    expect(problem(await rate(agent, p1, "W5"))).toBe("not-worked"); // worked on project two
    expect(problem(await rate(agent, p1, "W1", weekAgo))).toBe("rating-window");
    expect(problem(await rate(agent, p1, "W1", addCalendarDays(today, 1)))).toBe("date-in-future");
    expect((await rate(agent, p1, "W2", today, scores(6, 4, 4, 4))).status).toBe(400);
    expect((await rate(qs, p1, "W2")).status).toBe(403);
    expect((await rate(outsider, p1, "W2")).status).toBe(403);
    expect((await rate(ownerB, p1, "W2")).status).toBe(404);
    expect(problem(await rate(agent, p3, "W2"))).toBe("project-read-only");
    const cancelled = ratingSheetResponseSchema.parse(
      ok(await agent.call("get", `labour/projects/${p3}/ratings`)),
    );
    expect(cancelled).toMatchObject({ canRate: false, project: { readOnly: true } });
  });

  it("lets only the rater correct a rating, on the day they gave it, versioned", async () => {
    const sheet = ratingSheetResponseSchema.parse(
      ok(await agent.call("get", `labour/projects/${p1}/ratings`)),
    );
    const mine = sheet.workers.find((row) => row.labourer.id === workers.W1)!.rating!;
    const theirs = sheet.workers.find((row) => row.labourer.id === workers.W2)!.rating!;
    expect([mine.canChange, theirs.canChange]).toEqual([true, false]);

    const changed = ratingResponseSchema.parse(
      ok(
        await agent.call("patch", `labour/ratings/${mine.id}`, {
          version: 1,
          scores: scores(5, 5, 4, 4),
          comment: "",
        }),
      ),
    ).rating;
    expect(changed).toMatchObject({ version: 2, comment: null, average: 4.5 });
    expect(changed.changedAt).not.toBeNull();
    const stale = { version: 1, scores: scores(1, 1, 1, 1) };
    expect(problem(await agent.call("patch", `labour/ratings/${mine.id}`, stale))).toBe(
      "version-conflict",
    );
    for (const someoneElse of [foreman, pm])
      expect(
        problem(
          await someoneElse.call("patch", `labour/ratings/${mine.id}`, { ...stale, version: 2 }),
        ),
      ).toBe("rating-locked");
    expect((await qs.call("patch", `labour/ratings/${mine.id}`, stale)).status).toBe(403);

    const earlier = labourerRatingsResponseSchema
      .parse(
        ok(await agent.call("get", `labour/labourers/${workers.W1}/ratings?to=${threeDaysAgo}`)),
      )
      .ratings.at(0)!;
    await givenYesterday(earlier.id);
    expect(
      problem(
        await agent.call("patch", `labour/ratings/${earlier.id}`, {
          version: earlier.version,
          scores: scores(5, 5, 5, 5),
        }),
      ),
    ).toBe("rating-locked");
  });

  it("enforces the rules in the database as well", async () => {
    const rows = await db.run(as(agent, tenantA), (tx) =>
      tx.labourerRating.findMany({ where: { labourerId: workers.W1, workDate: new Date(today) } }),
    );
    const id = rows[0]!.id;
    await expect(
      db.run(
        as(agent, tenantA),
        (tx) =>
          tx.$executeRaw`UPDATE labourer_ratings SET labourer_id = ${workers.W2}::uuid,
          version = version + 1 WHERE id = ${id}::uuid`,
      ),
    ).rejects.toThrow(/keeps its worker/);
    await expect(
      db.run(
        as(pm, tenantA),
        (tx) =>
          tx.$executeRaw`UPDATE labourer_ratings SET quality = 1, version = version + 1
          WHERE id = ${id}::uuid`,
      ),
    ).rejects.toThrow(/Only the rater/);
    await expect(
      db.run(
        as(agent, tenantA),
        (tx) => tx.$executeRaw`DELETE FROM labourer_ratings WHERE id = ${id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    const insert = (by: Browser, ratedBy: string, labourer: string) =>
      db.run(
        as(by, tenantA),
        (tx) =>
          tx.$executeRaw`INSERT INTO labourer_ratings (id, tenant_id, project_id, labourer_id,
          work_date, punctuality, quality, safety, teamwork, rated_by)
          VALUES (gen_random_uuid(), ${tenantA}::uuid, ${p1}::uuid, ${labourer}::uuid,
          ${today}::date, 3, 3, 3, 3, ${ratedBy}::uuid)`,
      );
    await expect(insert(agent, agent.auth.user.id, workers.W3!)).rejects.toThrow(
      /recorded as working/,
    );
    await expect(insert(pm, agent.auth.user.id, workers.W3!)).rejects.toThrow(/signed-in user/);
  });

  it("counts a rating only while attendance still records its day as worked", async () => {
    const history = async () =>
      labourerRatingsResponseSchema.parse(
        ok(await owner.call("get", `labour/labourers/${workers.W2}/ratings`)),
      );
    const before = await history();
    expect(before.summary.count).toBe(1);
    const rating = before.ratings[0]!;
    expect(rating.ratedBy.id).toBe(foreman.auth.user.id);

    // The day's muster (still a draft) is saved again with the worker absent.
    await muster(p1, main, today, [absent("W2")]);
    expect(await history()).toMatchObject({ summary: { count: 0 }, ratings: [] });
    const sheet = ratingSheetResponseSchema.parse(
      ok(await foreman.call("get", `labour/projects/${p1}/ratings`)),
    );
    expect(sheet.workers.map((row) => row.labourer.id)).not.toContain(workers.W2);
    const change = { version: rating.version, scores: scores(1, 1, 1, 1), comment: "Hakuja" };
    expect(problem(await foreman.call("patch", `labour/ratings/${rating.id}`, change))).toBe(
      "not-worked",
    );
    await expect(
      db.run(
        as(foreman, tenantA),
        (tx) =>
          tx.$executeRaw`UPDATE labourer_ratings SET quality = 1, version = version + 1
          WHERE id = ${rating.id}::uuid`,
      ),
    ).rejects.toThrow(/recorded as working/);

    // Restoring the day brings the rating back as it was.
    await muster(p1, main, today, [halfDay("W2")]);
    const after = await history();
    expect(after.summary.count).toBe(1);
    expect(after.ratings[0]).toMatchObject({
      id: rating.id,
      version: rating.version,
      scores: rating.scores,
    });
  });

  it("shows a worker's ratings only on projects where the caller views labour", async () => {
    const all = labourerRatingsResponseSchema.parse(
      ok(await owner.call("get", `labour/labourers/${workers.W1}/ratings`)),
    );
    expect(all.summary).toMatchObject({ count: 2, average: 3.8 });
    expect(all.summary.criteria).toEqual({
      punctuality: 4,
      quality: 4,
      safety: 3,
      teamwork: 4,
    });
    expect(all.ratings.map((row) => row.workDate)).toEqual([today, threeDaysAgo]);
    expect(all.canRate).toBe(true);
    const ranged = labourerRatingsResponseSchema.parse(
      ok(
        await owner.call(
          "get",
          `labour/labourers/${workers.W1}/ratings?from=${today}&projectId=${p1}&limit=1`,
        ),
      ),
    );
    expect([ranged.summary.count, ranged.ratings.length]).toEqual([1, 1]);
    const forFinance = labourerRatingsResponseSchema.parse(
      ok(await finance.call("get", `labour/labourers/${workers.W1}/ratings`)),
    );
    expect([forFinance.summary.count, forFinance.canRate]).toEqual([2, false]);
    // W4 is engaged on both projects but was rated on project one only.
    const fromProjectTwo = labourerRatingsResponseSchema.parse(
      ok(await outsider.call("get", `labour/labourers/${workers.W4}/ratings`)),
    );
    expect([fromProjectTwo.summary.count, fromProjectTwo.ratings]).toEqual([0, []]);
    expect((await outsider.call("get", `labour/labourers/${workers.W1}/ratings`)).status).toBe(404);
    expect((await ownerB.call("get", `labour/labourers/${workers.W1}/ratings`)).status).toBe(404);
    expect((await qs.call("get", `labour/labourers/${workers.W1}/ratings`)).status).toBe(404);
  });

  it("keeps companies apart and audits ratings without their comments", async () => {
    const counts = await Promise.all([
      db.run(as(owner, tenantA), (tx) => tx.labourerRating.count()),
      db.run(as(ownerB, tenantB), (tx) => tx.labourerRating.count()),
    ]);
    expect(counts).toEqual([4, 0]);
    const events = await db.run(as(owner, tenantA), (tx) =>
      tx.auditEvent.findMany({
        where: { tenantId: tenantA, action: { in: ["labourer.rated", "labourer.rating_changed"] } },
        select: { action: true, metadata: true },
      }),
    );
    expect(events.filter((event) => event.action === "labourer.rated")).toHaveLength(4);
    const change = events.find((event) => event.action === "labourer.rating_changed");
    expect(change?.metadata).toMatchObject({ ...scores(5, 5, 4, 4), comment: false, version: 2 });
    expect(JSON.stringify(events)).not.toContain("Kazi nzuri");
  });

  it("shows workers their own ratings, without who gave them", async () => {
    const invite = async (number: string) => {
      ok(
        await pm.call("post", `projects/${p1}/labourers/invitations`, { identifier: number }),
        201,
      );
      const token =
        notifications
          .get(number)
          ?.at(-1)
          ?.text.match(/token=([A-Za-z0-9_-]{43})/)?.[1] ?? "";
      const labourer = new Browser(app);
      await labourer.initialize();
      ok(
        await labourer.call("post", "auth/pin/join", {
          identifier: number,
          token,
          displayName: "Mfanyakazi",
          pin: PIN,
        }),
      );
      return labourer;
    };
    const worker = await invite(w1Phone);
    const linked = workerRatingsResponseSchema.parse(
      ok(await worker.call("get", "portal/worker/ratings")),
    );
    expect(linked.linked).toBe(true);
    expect(linked.summary.count).toBe(2);
    expect(linked.ratings.map((row) => [row.workDate, row.project.id])).toEqual([
      [today, p1],
      [threeDaysAgo, p1],
    ]);
    expect(JSON.stringify(linked)).not.toContain(agent.auth.user.id);
    // Nor does the worker see a rating whose day attendance no longer records as worked.
    await muster(p1, main, threeDaysAgo, [absent("W1")]);
    const aside = workerRatingsResponseSchema.parse(
      ok(await worker.call("get", "portal/worker/ratings")),
    );
    expect([aside.summary.count, aside.ratings.map((row) => row.workDate)]).toEqual([1, [today]]);
    const stranger = workerRatingsResponseSchema.parse(
      ok(await (await invite(phone())).call("get", "portal/worker/ratings")),
    );
    expect(stranger).toMatchObject({ linked: false, ratings: [], summary: { count: 0 } });
    const shared = workerRatingsResponseSchema.parse(
      ok(await (await invite(sharedPhone)).call("get", "portal/worker/ratings")),
    );
    expect(shared).toMatchObject({ linked: false, ratings: [] });
    expect((await agent.call("get", "portal/worker/ratings")).status).toBe(403);
  });
});
