import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import { KENYA_STATUTORY_SEED, PROJECT_ASSIGNABLE_PERMISSIONS } from "@pm-buddy/types";
import {
  auditEventsResponseSchema,
  geofenceHistoryResponseSchema,
  milestoneResponseSchema,
  milestonesResponseSchema,
  projectDetailResponseSchema,
  projectResponseSchema,
  projectsResponseSchema,
  projectTeamResponseSchema,
  roleResponseSchema,
  siteResponseSchema,
  sitesResponseSchema,
  wbsNodeResponseSchema,
  wbsResponseSchema,
  type GeofenceInput,
  type Project,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import type { Prisma } from "../src/generated/prisma/client.js";
import { configureApp } from "../src/app.setup.js";
import { BatchBuilder } from "../src/modules/payroll/batch-builder.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { DEMO_ACCOUNTS, DEMO_COMPANY, seedDemo } from "../src/seed/demo-seed.js";
import { Browser, notifications } from "./support.js";

type Method = "get" | "post" | "patch" | "put" | "delete";
/** Metres → degrees near Ruiru (latitude −1.15°). */
const ruiru = { lat: -1.1489, lng: 36.9612 };
const at = (east: number, north: number) => ({
  lat: Math.round((ruiru.lat + north / 111_195) * 1e6) / 1e6,
  lng: Math.round((ruiru.lng + east / 111_173) * 1e6) / 1e6,
});
const plot: GeofenceInput = {
  kind: "polygon",
  vertices: [at(0, 0), at(60, 0), at(70, 20), at(60, 45), at(0, 45)],
};
const yard: GeofenceInput = { kind: "radius", center: at(30, -40), radiusM: 40 };
const fullDetails = {
  clientName: "Mavuno Homes Ltd",
  clientEmail: "projects@mavuno-homes.example.test",
  clientPhone: "0712 345 678",
  contractSumMinor: 8_640_000_000,
  contractType: "lump_sum",
  startDate: "2026-03-02",
  endDate: "2027-04-30",
  county: "kiambu",
  town: "Ruiru",
  latitude: ruiru.lat,
  longitude: ruiru.lng,
};

describe("Projects, sites, geofences, WBS and milestones (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let ownerB: Browser;
  let pm: Browser;
  let agent: Browser;
  let tenantA: string;
  let tenantB: string;
  let rui: Project;
  let auto: Project;
  let bProject: Project;
  let mainSite: string;
  let nodes: Record<string, string>;
  let milestone: string;
  let notificationSpy: ReturnType<typeof vi.spyOn>;

  /** Simulates a step-up within the last five minutes without spending TOTP counters. */
  const fresh = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
  const as = (browser: Browser, tenantId: string, requestId: string) => ({
    userId: browser.auth.user.id,
    tenantId,
    requestId,
  });
  const join = async (
    inviter: Browser,
    member: Browser,
    role: string,
    projectIds: string[] = [],
  ) => {
    await fresh(inviter);
    const invited = await inviter.call("post", "tenants/current/invitations", {
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
    const selected = await member.call("post", `tenants/${tenantA}/select`, {});
    expect(selected.status, JSON.stringify(selected.body)).toBe(200);
  };
  const detail = async (browser: Browser, projectId: string) => {
    const res = await browser.call("get", `projects/${projectId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return projectDetailResponseSchema.parse(res.body);
  };
  const project = (res: request.Response) => projectResponseSchema.parse(res.body).project;
  const problem = (res: request.Response) => (res.body as { code?: string }).code;
  const issues = (res: request.Response) =>
    ((res.body as { errors?: { message: string }[] }).errors ?? []).map((error) => error.message);
  const auditEvents = async () => {
    await fresh(owner);
    const res = await owner.call("get", "tenants/current/audit");
    expect(res.status).toBe(200);
    return auditEventsResponseSchema.parse(res.body).events;
  };
  const transition = (browser: Browser, target: Project, to: string, reason?: string) =>
    browser.call("post", `projects/${target.id}/status`, {
      to,
      version: target.version,
      ...(reason ? { reason } : {}),
    });

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
    pm = new Browser(app);
    agent = new Browser(app);
    for (const browser of [owner, ownerB]) {
      await browser.register();
      await browser.enroll();
    }
    await pm.register();
    await agent.register();
    const a = await owner.call("post", "tenants", { name: "Projects company A" });
    const b = await ownerB.call("post", "tenants", { name: "Projects company B" });
    expect([a.status, b.status]).toEqual([201, 201]);
    tenantA = (a.body as { tenant: { id: string } }).tenant.id;
    tenantB = (b.body as { tenant: { id: string } }).tenant.id;
    await join(owner, pm, "project_manager");
    await join(owner, agent, "site_agent");
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("documents every projects operation in OpenAPI", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "listProjects",
      "createProject",
      "getProject",
      "updateProject",
      "changeProjectStatus",
      "listSites",
      "createSite",
      "updateSite",
      "changeGeofence",
      "listGeofenceVersions",
      "getWbs",
      "createWbsNode",
      "updateWbsNode",
      "reorderWbs",
      "deleteWbsNode",
      "listMilestones",
      "createMilestone",
      "updateMilestone",
      "changeMilestoneStatus",
      "deleteMilestone",
      "getProjectTeam",
      "assignProjectMember",
      "removeProjectMember",
    ])
      expect(operations, id).toContain(id);
  });

  it("creates planning projects with chosen or automatic codes, unique per company", async () => {
    await fresh(owner);
    auto = project(await owner.call("post", "projects", { name: "Auto-coded project" }));
    expect(auto).toMatchObject({
      code: "PRJ-001",
      status: "planning",
      version: 1,
      currency: "KES",
      contractSumMinor: null,
      county: null,
    });
    const created = await owner.call("post", "projects", {
      code: "rui-hts",
      name: "Ruiru Heights Apartments",
      ...fullDetails,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    rui = project(created);
    expect(rui).toMatchObject({
      code: "RUI-HTS",
      clientPhone: "254712345678",
      contractSumMinor: 8_640_000_000,
      startDate: "2026-03-02",
      county: "kiambu",
      latitude: -1.1489,
    });
    const duplicate = await owner.call("post", "projects", { code: "RUI-HTS", name: "Copy" });
    expect([duplicate.status, problem(duplicate)]).toEqual([409, "project-code-taken"]);
    expect(project(await owner.call("post", "projects", { name: "Second auto" })).code).toBe(
      "PRJ-002",
    );
    await fresh(ownerB);
    bProject = project(
      await ownerB.call("post", "projects", { code: "RUI-HTS", name: "Company B Ruiru" }),
    );
    expect(bProject.code).toBe("RUI-HTS");

    for (const body of [
      { name: "Bad dates", startDate: "2026-05-01", endDate: "2026-04-30" },
      { name: "Forged", tenantId: tenantB },
      { name: "Floaty", contractSumMinor: 10.5 },
      { name: "Abroad", county: "london" },
      { name: "London site", latitude: 51.5, longitude: -0.12 },
    ])
      expect((await owner.call("post", "projects", body)).status, JSON.stringify(body)).toBe(400);
    expect((await pm.call("post", "projects", { name: "Not allowed" })).status).toBe(403);
    await prisma.session.update({
      where: { id: owner.auth.session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) },
    });
    const stale = await owner.call("post", "projects", { name: "Stale MFA" });
    expect([stale.status, problem(stale)]).toEqual([403, "step-up-required"]);
    const event = (await auditEvents()).find(
      (entry) => entry.action === "project.created" && entry.resourceId === rui.id,
    );
    expect(event?.metadata).toMatchObject({ code: "RUI-HTS" });
    expect(JSON.stringify(event?.metadata)).not.toMatch(/mavuno|254712345678|8640000000/i);
  });

  it("lists by status and search, only projects the caller may view", async () => {
    const list = async (browser: Browser, query = "") => {
      const res = await browser.call("get", `projects${query}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return projectsResponseSchema.parse(res.body).projects.map((entry) => entry.code);
    };
    expect(await list(owner, "?search=ruiru")).toEqual(["RUI-HTS"]);
    expect(await list(owner, "?search=PRJ")).toEqual(["PRJ-001", "PRJ-002"]);
    expect(await list(owner, "?status=planning")).toEqual(["PRJ-001", "RUI-HTS", "PRJ-002"]);
    expect(await list(owner, "?status=active")).toEqual([]);
    expect((await owner.call("get", "projects?status=archived")).status).toBe(400);
    expect(await list(pm)).toEqual([]);
    expect(await list(agent)).toEqual([]);
    expect(await list(ownerB)).toEqual(["RUI-HTS"]);
  });

  it("updates details with optimistic versions and audits field names only", async () => {
    const read = await detail(owner, rui.id);
    expect(read.permissions).toContain("projects.manage");
    expect(read.activationGaps).toEqual(["site_with_geofence"]);
    expect(read.history).toEqual([]);
    const updated = await owner.call("patch", `projects/${rui.id}`, {
      version: 1,
      town: "Ruiru East",
      clientEmail: "Site.Office@Mavuno-Homes.example.test",
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    rui = project(updated);
    expect(rui).toMatchObject({
      version: 2,
      town: "Ruiru East",
      clientEmail: "site.office@mavuno-homes.example.test",
    });
    const stale = await owner.call("patch", `projects/${rui.id}`, { version: 1, town: "Ruiru" });
    expect([stale.status, problem(stale)]).toEqual([409, "version-conflict"]);
    const backwards = await owner.call("patch", `projects/${rui.id}`, {
      version: 2,
      endDate: "2026-01-01",
    });
    expect([backwards.status, problem(backwards)]).toEqual([400, "end-before-start"]);
    expect((await owner.call("patch", `projects/${rui.id}`, { version: 2 })).status).toBe(400);
    const event = (await auditEvents()).find(
      (entry) => entry.action === "project.updated" && entry.resourceId === rui.id,
    );
    expect(event?.metadata).toEqual({ fields: ["clientEmail", "town"], version: 2 });
  });

  it("validates geofences and versions every change without altering earlier versions", async () => {
    const created = await owner.call("post", `projects/${rui.id}/sites`, {
      name: "Main plot",
      address: "Off Kamiti Road",
      geofence: plot,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const site = siteResponseSchema.parse(created.body).site;
    mainSite = site.id;
    expect(site.geofence).toMatchObject({ version: 1, geofence: plot });
    expect(site.geofence.areaM2).toBeGreaterThan(2_500);
    expect(site.geofence.areaM2).toBeLessThan(3_100);

    const reject = async (geofence: unknown, issue: string) => {
      const res = await owner.call("post", `projects/${rui.id}/sites`, { name: "Bad", geofence });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(issues(res)).toContain(issue);
    };
    await reject(
      { kind: "polygon", vertices: [at(0, 0), at(50, 50), at(50, 0), at(0, 50)] },
      "self_intersecting",
    );
    await reject(
      { kind: "polygon", vertices: [at(0, 0), at(50, 0), at(50, 50), at(0, 0)] },
      "closing_vertex_repeated",
    );
    await reject(
      { kind: "radius", center: { lat: 51.5, lng: -0.12 }, radiusM: 100 },
      "coordinate_out_of_bounds",
    );
    await reject(
      { kind: "polygon", vertices: [at(0, 0), at(5, 0), at(5, 5), at(0, 5)] },
      "area_too_small",
    );
    await reject({ kind: "radius", center: ruiru, radiusM: 6_000 }, "radius_out_of_range");
    const sameName = await owner.call("post", `projects/${rui.id}/sites`, {
      name: "Main plot",
      geofence: yard,
    });
    expect([sameName.status, problem(sameName)]).toEqual([409, "site-name-taken"]);

    const history = async (query = "") => {
      const res = await owner.call("get", `projects/${rui.id}/sites/${mainSite}/geofences${query}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return geofenceHistoryResponseSchema.parse(res.body).versions;
    };
    const [v1] = await history();
    const changed = await owner.call("put", `projects/${rui.id}/sites/${mainSite}/geofence`, {
      geofence: yard,
      currentVersion: 1,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(siteResponseSchema.parse(changed.body).site.geofence).toMatchObject({
      version: 2,
      geofence: yard,
    });
    const raced = await owner.call("put", `projects/${rui.id}/sites/${mainSite}/geofence`, {
      geofence: plot,
      currentVersion: 1,
    });
    expect([raced.status, problem(raced)]).toEqual([409, "version-conflict"]);
    const versions = await history();
    expect(versions.map((version) => version.version)).toEqual([2, 1]);
    expect(versions[1]).toEqual(v1);
    expect(Date.parse(versions[0]!.effectiveFrom)).toBeGreaterThan(Date.parse(v1!.effectiveFrom));
    expect(await history(`?at=${encodeURIComponent(v1!.effectiveFrom)}`)).toEqual([v1]);
    expect(
      (await history(`?at=${encodeURIComponent(versions[0]!.effectiveFrom)}`))[0]?.version,
    ).toBe(2);
    const before = new Date(Date.parse(v1!.effectiveFrom) - 1_000).toISOString();
    expect(await history(`?at=${encodeURIComponent(before)}`)).toEqual([]);
    expect(
      (await owner.call("get", `projects/${rui.id}/sites/${mainSite}/geofences?at=yesterday`))
        .status,
    ).toBe(400);

    // The runtime role cannot rewrite or delete a past version, even directly.
    await expect(
      db.run(as(owner, tenantA, "geofence-update"), (tx) =>
        tx.siteGeofence.updateMany({
          where: { siteId: mainSite, version: 1 },
          data: { radiusM: 500 },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(as(owner, tenantA, "geofence-delete"), (tx) =>
        tx.siteGeofence.deleteMany({ where: { siteId: mainSite } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(as(owner, tenantA, "site-delete"), (tx) =>
        tx.site.deleteMany({ where: { id: mainSite } }),
      ),
    ).rejects.toThrow();
    expect(await history()).toEqual(versions);

    const renamed = await owner.call("patch", `projects/${rui.id}/sites/${mainSite}`, {
      name: "Main plot (north)",
      version: 1,
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    const staleRename = await owner.call("patch", `projects/${rui.id}/sites/${mainSite}`, {
      address: "Elsewhere",
      version: 1,
    });
    expect(problem(staleRename)).toBe("version-conflict");
    const sites = sitesResponseSchema.parse(
      (await owner.call("get", `projects/${rui.id}/sites`)).body,
    ).sites;
    expect(sites.map((entry) => [entry.name, entry.version, entry.geofence.version])).toEqual([
      ["Main plot (north)", 2, 2],
    ]);
    const event = (await auditEvents()).find(
      (entry) => entry.action === "site.geofence_changed" && entry.resourceId === mainSite,
    );
    expect(event?.metadata).toEqual({
      projectId: rui.id,
      previousVersion: 1,
      version: 2,
      kind: "radius",
    });
  });

  it("enforces the project lifecycle and rejects invalid transitions", async () => {
    await fresh(owner);
    let lifecycle = project(
      await owner.call("post", "projects", { name: "Lifecycle project", ...fullDetails }),
    );
    const refuse = async (to: string, status: number, code: string, reason?: string) => {
      const res = await transition(owner, lifecycle, to, reason);
      expect([res.status, problem(res)], `${lifecycle.status}→${to}`).toEqual([status, code]);
    };
    await refuse("active", 409, "activation-incomplete");
    expect((await detail(owner, auto.id)).activationGaps).toEqual([
      "client_name",
      "contract_sum",
      "contract_type",
      "start_date",
      "end_date",
      "county",
      "town",
      "site_with_geofence",
    ]);
    await refuse("completed", 409, "invalid-transition");
    await refuse("closed", 409, "invalid-transition");
    await refuse("cancelled", 400, "reason-required");
    expect(
      (
        await owner.call("post", `projects/${lifecycle.id}/sites`, {
          name: "Lifecycle site",
          geofence: yard,
        })
      ).status,
    ).toBe(201);
    const next = async (to: string, reason?: string) => {
      const res = await transition(owner, lifecycle, to, reason);
      expect(res.status, `${lifecycle.status}→${to}: ${JSON.stringify(res.body)}`).toBe(200);
      lifecycle = project(res);
      expect(lifecycle.status).toBe(to);
    };
    await next("active");
    const codeChange = await owner.call("patch", `projects/${lifecycle.id}`, {
      version: lifecycle.version,
      code: "NEW-CODE",
    });
    expect([codeChange.status, problem(codeChange)]).toEqual([409, "project-code-fixed"]);
    const cleared = await owner.call("patch", `projects/${lifecycle.id}`, {
      version: lifecycle.version,
      clientName: null,
    });
    expect([cleared.status, problem(cleared)]).toEqual([409, "activation-details-required"]);
    await refuse("on_hold", 400, "reason-required");
    await refuse("planning", 409, "invalid-transition");
    await next("on_hold", "Awaiting the client's second instalment");
    await refuse("completed", 409, "invalid-transition");
    const stale = await owner.call("post", `projects/${lifecycle.id}/status`, {
      to: "active",
      version: lifecycle.version - 1,
    });
    expect(problem(stale)).toBe("version-conflict");
    await next("active");
    await next("completed");
    await next("closed");
    for (const to of ["active", "planning", "cancelled", "on_hold"])
      await refuse(to, 409, "invalid-transition");
    const readOnly = await owner.call("patch", `projects/${lifecycle.id}`, {
      version: lifecycle.version,
      name: "Renamed",
    });
    expect([readOnly.status, problem(readOnly)]).toEqual([409, "project-read-only"]);
    const siteOnClosed = await owner.call("post", `projects/${lifecycle.id}/sites`, {
      name: "Late site",
      geofence: yard,
    });
    expect(problem(siteOnClosed)).toBe("project-read-only");
    const wbsOnClosed = await owner.call("post", `projects/${lifecycle.id}/wbs`, {
      code: "1",
      name: "Too late",
    });
    expect(problem(wbsOnClosed)).toBe("project-read-only");

    const read = await detail(owner, lifecycle.id);
    expect(read.history.map((change) => `${change.from}→${change.to}`)).toEqual([
      "completed→closed",
      "active→completed",
      "on_hold→active",
      "active→on_hold",
      "planning→active",
    ]);
    expect(read.history[3]).toMatchObject({
      reason: "Awaiting the client's second instalment",
      changedBy: { id: owner.auth.user.id, displayName: "Foundation test user" },
    });
    const event = (await auditEvents()).find(
      (entry) =>
        entry.action === "project.status_changed" &&
        entry.resourceId === lifecycle.id &&
        (entry.metadata as { to?: string }).to === "on_hold",
    );
    expect(event?.metadata).toEqual({
      from: "active",
      to: "on_hold",
      action: "suspend",
      reasonGiven: true,
    });

    // Database backstops: lifecycle trigger and append-only history.
    await expect(
      db.run(as(owner, tenantA, "skip-to-closed"), (tx) =>
        tx.project.update({ where: { id: auto.id }, data: { status: "closed" } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(as(owner, tenantA, "reopen-closed"), (tx) =>
        tx.project.update({ where: { id: lifecycle.id }, data: { name: "Reopened" } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(as(owner, tenantA, "history-rewrite"), (tx) =>
        tx.projectStatusChange.updateMany({
          where: { projectId: lifecycle.id },
          data: { reason: "Rewritten" },
        }),
      ),
    ).rejects.toThrow();

    const activated = await transition(owner, rui, "active");
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    rui = project(activated);
  });

  it("lets a site agent view an assigned project but not manage it", async () => {
    await fresh(owner);
    const assigned = await owner.call("put", `projects/${rui.id}/members/${agent.auth.user.id}`, {
      permissions: ["projects.view", "projects.manage", "site.diary"],
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(
      projectsResponseSchema
        .parse((await agent.call("get", "projects")).body)
        .projects.map((entry) => entry.id),
    ).toEqual([rui.id]);
    const read = await detail(agent, rui.id);
    expect(read.permissions).toEqual(["projects.view", "site.diary"]);
    for (const path of ["sites", "wbs", "milestones", "team"])
      expect((await agent.call("get", `projects/${rui.id}/${path}`)).status, path).toBe(200);
    const denied: [Method, string, object][] = [
      ["patch", `projects/${rui.id}`, { version: rui.version, name: "Agent rename" }],
      [
        "post",
        `projects/${rui.id}/status`,
        { to: "on_hold", reason: "Agent hold", version: rui.version },
      ],
      ["post", `projects/${rui.id}/sites`, { name: "Agent site", geofence: yard }],
      [
        "put",
        `projects/${rui.id}/sites/${mainSite}/geofence`,
        { geofence: plot, currentVersion: 2 },
      ],
      ["patch", `projects/${rui.id}/sites/${mainSite}`, { name: "Agent", version: 2 }],
      ["post", `projects/${rui.id}/wbs`, { code: "9", name: "Agent node" }],
      ["post", `projects/${rui.id}/milestones`, { name: "Agent milestone", dueDate: "2027-01-01" }],
      ["put", `projects/${rui.id}/members/${pm.auth.user.id}`, { permissions: ["projects.view"] }],
    ];
    for (const [method, path, body] of denied)
      expect((await agent.call(method, path, body)).status, `${method} ${path}`).toBe(403);
    expect((await agent.call("get", `projects/${auto.id}`)).status).toBe(403);

    await fresh(owner);
    expect(
      (
        await owner.call("put", `projects/${rui.id}/members/${pm.auth.user.id}`, {
          permissions: ["projects.view", "projects.manage"],
        })
      ).status,
    ).toBe(200);
    expect((await detail(pm, rui.id)).permissions).toEqual(["projects.view", "projects.manage"]);
    const renamed = await pm.call("patch", `projects/${rui.id}`, {
      version: rui.version,
      description: "4-storey apartment block, 16 units",
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    rui = project(renamed);
  });

  it("requires sibling WBS weights to sum to 100 % before progress can be computed", async () => {
    const add = async (code: string, weightBasisPoints: number, parentId: string | null = null) => {
      const res = await pm.call("post", `projects/${rui.id}/wbs`, {
        code,
        name: `Node ${code}`,
        weightBasisPoints,
        parentId,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return wbsNodeResponseSchema.parse(res.body).node;
    };
    const tree = async () => {
      const res = await pm.call("get", `projects/${rui.id}/wbs`);
      expect(res.status).toBe(200);
      return wbsResponseSchema.parse(res.body);
    };
    const one = await add("1", 1_000);
    const two = await add("2", 2_000);
    const three = await add("3", 4_500);
    let wbs = await tree();
    expect(wbs.weights).toEqual({
      complete: false,
      groups: [{ parentId: null, sumBasisPoints: 7_500, complete: false }],
    });
    expect(wbs.progress).toBeNull();
    const threeOne = await add("3.1", 5_000, three.id);
    const threeTwo = await add("3.2", 5_000, three.id);
    const four = await add("4", 2_500);
    wbs = await tree();
    expect(wbs.weights.complete).toBe(true);
    expect(wbs.weights.groups).toEqual([
      { parentId: null, sumBasisPoints: 10_000, complete: true },
      { parentId: three.id, sumBasisPoints: 10_000, complete: true },
    ]);
    // Complete weights alone do not make progress available: there are no measurements yet.
    expect(wbs.progress).toBeNull();
    nodes = { one: one.id, two: two.id, three: three.id, threeOne: threeOne.id, four: four.id };

    expect(
      (
        await pm.call("post", `projects/${rui.id}/wbs`, {
          code: "5",
          name: "Too heavy",
          weightBasisPoints: 10_001,
        })
      ).status,
    ).toBe(400);
    const duplicate = await pm.call("post", `projects/${rui.id}/wbs`, { code: "1", name: "Again" });
    expect(problem(duplicate)).toBe("wbs-code-taken");
    const lighter = await pm.call("patch", `projects/${rui.id}/wbs/${threeTwo.id}`, {
      weightBasisPoints: 4_000,
      version: threeTwo.version,
    });
    expect(lighter.status, JSON.stringify(lighter.body)).toBe(200);
    wbs = await tree();
    expect(wbs.weights.complete).toBe(false);
    expect(wbs.weights.groups[1]).toEqual({
      parentId: three.id,
      sumBasisPoints: 9_000,
      complete: false,
    });
    const staleWeight = await pm.call("patch", `projects/${rui.id}/wbs/${threeTwo.id}`, {
      weightBasisPoints: 5_000,
      version: threeTwo.version,
    });
    expect(problem(staleWeight)).toBe("version-conflict");
    const cycle = await pm.call("patch", `projects/${rui.id}/wbs/${three.id}`, {
      parentId: threeOne.id,
      version: three.version,
    });
    expect([cycle.status, problem(cycle)]).toEqual([409, "wbs-cycle"]);
    await expect(
      db.run(as(pm, tenantA, "wbs-cycle"), (tx) =>
        tx.wbsNode.update({ where: { id: three.id }, data: { parentId: threeOne.id } }),
      ),
    ).rejects.toThrow();

    const reorder = await pm.call("put", `projects/${rui.id}/wbs/order`, {
      parentId: null,
      nodeIds: [four.id, three.id, two.id, one.id],
    });
    expect(reorder.status, JSON.stringify(reorder.body)).toBe(200);
    wbs = await tree();
    expect(wbs.nodes.filter((node) => node.parentId === null).map((node) => node.code)).toEqual([
      "4",
      "3",
      "2",
      "1",
    ]);
    const partial = await pm.call("put", `projects/${rui.id}/wbs/order`, {
      parentId: null,
      nodeIds: [four.id, three.id],
    });
    expect(problem(partial)).toBe("wbs-order-mismatch");
    const withChildren = await pm.call("delete", `projects/${rui.id}/wbs/${three.id}`);
    expect(problem(withChildren)).toBe("wbs-has-children");

    let parent: string | null = four.id;
    for (let depth = 2; depth <= 6; depth++)
      parent = (await add(`4.${"1.".repeat(depth - 2)}1`, 10_000, parent)).id;
    const tooDeep = await pm.call("post", `projects/${rui.id}/wbs`, {
      code: "4-deep",
      name: "Seventh level",
      parentId: parent,
    });
    expect([tooDeep.status, problem(tooDeep)]).toEqual([409, "wbs-too-deep"]);
  });

  it("moves milestones through their explicit lifecycle", async () => {
    const create = await pm.call("post", `projects/${rui.id}/milestones`, {
      name: "Substructure complete",
      dueDate: "2026-06-15",
      wbsNodeId: nodes["two"],
    });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    let current = milestoneResponseSchema.parse(create.body).milestone;
    milestone = current.id;
    expect(current).toMatchObject({ status: "planned", actualDate: null, wbsNodeId: nodes["two"] });
    const duplicate = await pm.call("post", `projects/${rui.id}/milestones`, {
      name: "Substructure complete",
      dueDate: "2026-07-01",
    });
    expect(problem(duplicate)).toBe("milestone-name-taken");
    const move = async (body: Record<string, unknown>, status = 200, code?: string) => {
      const res = await pm.call("post", `projects/${rui.id}/milestones/${milestone}/status`, {
        version: current.version,
        ...body,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(status);
      if (code) expect(problem(res)).toBe(code);
      if (status === 200) current = milestoneResponseSchema.parse(res.body).milestone;
    };
    await move({ to: "achieved" }, 400, "actual-date-required");
    // A future date within the planning range (2000–2099; later years are a validation error).
    await move({ to: "achieved", actualDate: "2098-01-01" }, 400, "actual-date-future");
    await move({ to: "achieved", actualDate: "2999-01-01" }, 400, "validation-error");
    await move({ to: "achieved", actualDate: "2026-06-26" });
    expect(current).toMatchObject({ status: "achieved", actualDate: "2026-06-26" });
    await move({ to: "cancelled", reason: "Not allowed" }, 409, "invalid-transition");
    await move({ to: "in_progress" }, 400, "reason-required");
    await move({ to: "in_progress", reason: "Cracks found in the ground beam" });
    expect(current).toMatchObject({ status: "in_progress", actualDate: null });
    await move({ to: "cancelled", reason: "Merged into the frame milestone" });
    await move({ to: "planned" }, 409, "invalid-transition");
    const deleted = await pm.call("delete", `projects/${rui.id}/milestones/${milestone}`);
    expect(problem(deleted)).toBe("milestone-not-planned");
    await expect(
      db.run(as(pm, tenantA, "milestone-revive"), (tx) =>
        tx.milestone.update({ where: { id: milestone }, data: { status: "planned" } }),
      ),
    ).rejects.toThrow();

    const second = milestoneResponseSchema.parse(
      (
        await pm.call("post", `projects/${rui.id}/milestones`, {
          name: "Roof covered",
          dueDate: "2027-01-31",
          wbsNodeId: nodes["one"],
        })
      ).body,
    ).milestone;
    const inUse = await pm.call("delete", `projects/${rui.id}/wbs/${nodes["one"]}`);
    expect([inUse.status, problem(inUse)]).toEqual([409, "wbs-in-use"]);
    const edited = await pm.call("patch", `projects/${rui.id}/milestones/${second.id}`, {
      dueDate: "2027-02-14",
      wbsNodeId: null,
      version: second.version,
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect((await pm.call("delete", `projects/${rui.id}/milestones/${second.id}`)).status).toBe(
      200,
    );
    expect((await pm.call("delete", `projects/${rui.id}/wbs/${nodes["one"]}`)).status).toBe(200);
    const listed = milestonesResponseSchema.parse(
      (await pm.call("get", `projects/${rui.id}/milestones`)).body,
    ).milestones;
    expect(listed.map((entry) => [entry.name, entry.status])).toEqual([
      ["Substructure complete", "cancelled"],
    ]);
  });

  it("assigns and removes team members within the escalation guard", async () => {
    await fresh(owner);
    const widened = await owner.call("put", `projects/${rui.id}/members/${pm.auth.user.id}`, {
      permissions: [
        "projects.view",
        "projects.manage",
        "bq.edit",
        "attendance.record",
        "stores.manage",
      ],
    });
    expect(widened.status, JSON.stringify(widened.body)).toBe(200);
    expect(
      (
        await owner.call("put", `projects/${rui.id}/members/${pm.auth.user.id}`, {
          permissions: ["payments.approve"],
        })
      ).status,
    ).toBe(400);
    const team = projectTeamResponseSchema.parse(
      (await owner.call("get", `projects/${rui.id}/team`)).body,
    );
    expect(team.canAssign).toBe(true);
    expect(team.grantable).toEqual([...PROJECT_ASSIGNABLE_PERMISSIONS]);
    const member = (id: string) => team.members.find((entry) => entry.userId === id);
    expect(member(owner.auth.user.id)).toMatchObject({
      companyWide: true,
      assignment: null,
      role: "owner",
    });
    expect(member(pm.auth.user.id)).toMatchObject({
      role: "project_manager",
      companyWide: false,
      assignment: [
        "projects.view",
        "projects.manage",
        "bq.edit",
        "attendance.record",
        "stores.manage",
      ],
      // Role ∩ assignment: a project manager's role has neither attendance.record nor stores.manage.
      effective: ["projects.view", "projects.manage", "bq.edit"],
    });
    expect(member(agent.auth.user.id)?.effective).toEqual(["projects.view", "site.diary"]);

    await fresh(owner);
    const leadRole = roleResponseSchema.parse(
      (
        await owner.call("post", "tenants/current/roles", {
          name: "Team lead",
          permissions: ["users.invite", "projects.view", "projects.manage", "bq.view"],
        })
      ).body,
    ).role;
    const lead = new Browser(app);
    await lead.register();
    await lead.enroll();
    await join(owner, lead, leadRole.id, [rui.id]);
    const leadTeam = projectTeamResponseSchema.parse(
      (await lead.call("get", `projects/${rui.id}/team`)).body,
    );
    expect(leadTeam.canAssign).toBe(true);
    expect(leadTeam.grantable).toEqual(["projects.view", "projects.manage", "bq.view"]);
    expect(leadTeam.candidates.map((candidate) => candidate.userId)).not.toContain(pm.auth.user.id);

    const leadAssign = (userId: string, permissions: string[]) =>
      lead.call("put", `projects/${rui.id}/members/${userId}`, { permissions });
    await fresh(lead);
    // Keeps site.diary (unchanged), adds bq.view and removes projects.manage: both held.
    expect(
      (await leadAssign(agent.auth.user.id, ["projects.view", "site.diary", "bq.view"])).status,
    ).toBe(200);
    // Adding bq.edit or removing site.diary needs permissions the lead does not hold.
    expect(
      (await leadAssign(agent.auth.user.id, ["projects.view", "site.diary", "bq.view", "bq.edit"]))
        .status,
    ).toBe(403);
    expect((await leadAssign(agent.auth.user.id, ["projects.view", "bq.view"])).status).toBe(403);
    expect(
      (await lead.call("delete", `projects/${rui.id}/members/${pm.auth.user.id}`)).status,
    ).toBe(403);
    expect(
      (await lead.call("delete", `projects/${rui.id}/members/${agent.auth.user.id}`)).status,
    ).toBe(403);
    expect(
      (
        await lead.call("put", `projects/${auto.id}/members/${agent.auth.user.id}`, {
          permissions: ["projects.view"],
        })
      ).status,
    ).toBe(403);
    await prisma.session.update({
      where: { id: lead.auth.session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) },
    });
    expect((await leadAssign(agent.auth.user.id, ["projects.view", "site.diary"])).status).toBe(
      403,
    );

    await fresh(owner);
    expect(
      (await owner.call("delete", `projects/${rui.id}/members/${agent.auth.user.id}`)).status,
    ).toBe(200);
    expect(
      (await owner.call("delete", `projects/${rui.id}/members/${agent.auth.user.id}`)).status,
    ).toBe(404);
    expect((await agent.call("get", `projects/${rui.id}`)).status).toBe(403);
    const after = projectTeamResponseSchema.parse(
      (await owner.call("get", `projects/${rui.id}/team`)).body,
    );
    expect(after.members.map((entry) => entry.userId)).not.toContain(agent.auth.user.id);
    expect(after.candidates.map((entry) => entry.userId)).toContain(agent.auth.user.id);
    const event = (await auditEvents()).find((entry) => entry.action === "project.member_removed");
    expect(event?.metadata).toEqual({
      userId: agent.auth.user.id,
      permissions: ["projects.view", "bq.view", "site.diary"],
    });
  });

  it("applies the project escalation guard to invitations too", async () => {
    await fresh(owner);
    const role = roleResponseSchema.parse(
      (
        await owner.call("post", "tenants/current/roles", {
          name: "Inviting lead",
          permissions: ["users.invite", "projects.view", "projects.manage", "bq.view"],
        })
      ).body,
    ).role;
    const lead = new Browser(app);
    await lead.register();
    await lead.enroll();
    await join(owner, lead, role.id, [rui.id]);
    // The lead's assignment on the project is narrower than the role.
    await fresh(owner);
    const narrowed = await owner.call("put", `projects/${rui.id}/members/${lead.auth.user.id}`, {
      permissions: ["projects.view", "projects.manage"],
    });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    const newcomer = new Browser(app);
    await newcomer.register();
    const invite = () =>
      lead.call("post", "tenants/current/invitations", {
        identifier: newcomer.identifier,
        role: role.id,
        projectIds: [rui.id],
      });
    // Accepting would grant bq.view on the project, which the lead doesn't hold there.
    await fresh(lead);
    const refused = await invite();
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    await fresh(owner);
    expect(
      (
        await owner.call("put", `projects/${rui.id}/members/${lead.auth.user.id}`, {
          permissions: ["projects.view", "projects.manage", "bq.view"],
        })
      ).status,
    ).toBe(200);
    await fresh(lead);
    const allowed = await invite();
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
  });

  it("keeps automatic codes working after a very large PRJ- code", async () => {
    await fresh(owner);
    const huge = await owner.call("post", "projects", {
      code: "PRJ-9999999999999999",
      name: "Huge code",
    });
    expect(huge.status, JSON.stringify(huge.body)).toBe(201);
    const next = await owner.call("post", "projects", { name: "After huge code" });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(project(next).code).toMatch(/^PRJ-\d{3,12}$/);
  });

  it("refuses a too-short optional reason with a 400, not a server error", async () => {
    await fresh(owner);
    let target = project(
      await owner.call("post", "projects", { name: "Short reason", ...fullDetails }),
    );
    expect(
      (
        await owner.call("post", `projects/${target.id}/sites`, {
          name: "Short reason site",
          geofence: yard,
        })
      ).status,
    ).toBe(201);
    target = (await detail(owner, target.id)).project;
    expect((await transition(owner, target, "active", "ok")).status).toBe(400);
    const activated = await transition(owner, target, "active", "Site handed over");
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
  });

  it("isolates company B from company A's projects, sites, WBS and milestones", async () => {
    const aMilestone = milestonesResponseSchema.parse(
      (await owner.call("get", `projects/${rui.id}/milestones`)).body,
    ).milestones[0]!;
    const guesses: [Method, string, object?][] = [
      ["get", `projects/${rui.id}`],
      ["patch", `projects/${rui.id}`, { version: rui.version, name: "Hijacked" }],
      [
        "post",
        `projects/${rui.id}/status`,
        { to: "on_hold", reason: "Hijack", version: rui.version },
      ],
      ["get", `projects/${rui.id}/sites`],
      ["post", `projects/${rui.id}/sites`, { name: "Hijack", geofence: yard }],
      [
        "put",
        `projects/${rui.id}/sites/${mainSite}/geofence`,
        { geofence: plot, currentVersion: 2 },
      ],
      ["get", `projects/${rui.id}/sites/${mainSite}/geofences`],
      ["get", `projects/${rui.id}/wbs`],
      ["get", `projects/${rui.id}/milestones`],
      ["get", `projects/${rui.id}/team`],
      // Company B's own project with company A's IDs.
      ["patch", `projects/${bProject.id}/sites/${mainSite}`, { name: "Hijack", version: 2 }],
      [
        "put",
        `projects/${bProject.id}/sites/${mainSite}/geofence`,
        { geofence: plot, currentVersion: 2 },
      ],
      ["get", `projects/${bProject.id}/sites/${mainSite}/geofences`],
      ["patch", `projects/${bProject.id}/wbs/${nodes["two"]}`, { name: "Hijack", version: 1 }],
      ["delete", `projects/${bProject.id}/wbs/${nodes["two"]}`],
      ["post", `projects/${bProject.id}/wbs`, { code: "1", name: "Child", parentId: nodes["two"] }],
      [
        "post",
        `projects/${bProject.id}/milestones`,
        { name: "M", dueDate: "2027-01-01", wbsNodeId: nodes["two"] },
      ],
      [
        "patch",
        `projects/${bProject.id}/milestones/${aMilestone.id}`,
        { name: "Hijack", version: aMilestone.version },
      ],
      [
        "post",
        `projects/${bProject.id}/milestones/${aMilestone.id}/status`,
        { to: "planned", version: 1 },
      ],
      ["delete", `projects/${bProject.id}/milestones/${aMilestone.id}`],
      [
        "put",
        `projects/${bProject.id}/members/${pm.auth.user.id}`,
        { permissions: ["projects.view"] },
      ],
    ];
    await fresh(ownerB);
    for (const [method, path, body] of guesses) {
      const res = await ownerB.call(method, path, body);
      expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBe(404);
    }
    expect(
      projectsResponseSchema
        .parse((await ownerB.call("get", "projects")).body)
        .projects.map((p) => p.id),
    ).toEqual([bProject.id]);

    const inB = as(ownerB, tenantB, "cross-tenant");
    await db.run(inB, async (tx) => {
      expect(await tx.site.findMany({ where: { id: mainSite } })).toEqual([]);
      expect(await tx.siteGeofence.findMany({ where: { siteId: mainSite } })).toEqual([]);
      expect(await tx.wbsNode.findMany({ where: { projectId: rui.id } })).toEqual([]);
      expect(await tx.milestone.findMany({ where: { projectId: rui.id } })).toEqual([]);
      expect(await tx.projectStatusChange.findMany({ where: { projectId: rui.id } })).toEqual([]);
      expect(
        await tx.site.updateMany({ where: { id: mainSite }, data: { name: "Hijack" } }),
      ).toEqual({
        count: 0,
      });
    });
    const userB = ownerB.auth.user.id;
    const attempts: [string, (tx: Prisma.TransactionClient) => Promise<unknown>][] = [
      [
        "site in A's tenant",
        (tx) =>
          tx.site.create({
            data: { tenantId: tenantA, projectId: rui.id, name: "X", createdBy: userB },
          }),
      ],
      [
        "site on A's project",
        (tx) =>
          tx.site.create({
            data: { tenantId: tenantB, projectId: rui.id, name: "X", createdBy: userB },
          }),
      ],
      [
        "geofence on A's site",
        (tx) =>
          tx.siteGeofence.create({
            data: {
              tenantId: tenantB,
              siteId: mainSite,
              kind: "radius",
              centerLat: -1.1,
              centerLng: 36.9,
              radiusM: 50,
              areaM2: 7_854,
              perimeterM: 314.2,
              createdBy: userB,
            },
          }),
      ],
      [
        "WBS child of A's node",
        (tx) =>
          tx.wbsNode.create({
            data: {
              tenantId: tenantB,
              projectId: bProject.id,
              parentId: nodes["two"]!,
              code: "X",
              name: "X",
              createdBy: userB,
            },
          }),
      ],
      [
        "milestone on A's node",
        (tx) =>
          tx.milestone.create({
            data: {
              tenantId: tenantB,
              projectId: bProject.id,
              wbsNodeId: nodes["two"]!,
              name: "X",
              dueDate: new Date(),
              createdBy: userB,
            },
          }),
      ],
      [
        "status history on A's project",
        (tx) =>
          tx.projectStatusChange.create({
            data: {
              tenantId: tenantB,
              projectId: rui.id,
              fromStatus: "active",
              toStatus: "on_hold",
              changedBy: userB,
            },
          }),
      ],
    ];
    for (const [label, write] of attempts)
      await expect(db.run(inB, write), label).rejects.toThrow();

    // Within one company, a milestone cannot point at another project's WBS node either.
    const crossProject = await owner.call("post", `projects/${auto.id}/milestones`, {
      name: "Borrowed node",
      dueDate: "2027-01-01",
      wbsNodeId: nodes["two"],
    });
    expect(crossProject.status).toBe(404);
    await expect(
      db.run(as(owner, tenantA, "cross-project"), (tx) =>
        tx.milestone.create({
          data: {
            tenantId: tenantA,
            projectId: auto.id,
            wbsNodeId: nodes["two"]!,
            name: "Borrowed node",
            dueDate: new Date(),
            createdBy: owner.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("seeds the demo company, labour registry and attendance idempotently", async () => {
    const counts = async (tenantId: string, userId: string) =>
      db.run({ tenantId, userId, requestId: "seed-counts" }, async (tx) => ({
        members: await tx.membership.count({ where: { tenantId } }),
        projects: await tx.project.count({ where: { tenantId } }),
        sites: await tx.site.count({ where: { tenantId } }),
        geofences: await tx.siteGeofence.count({ where: { tenantId } }),
        wbs: await tx.wbsNode.count({ where: { tenantId } }),
        milestones: await tx.milestone.count({ where: { tenantId } }),
        history: await tx.projectStatusChange.count({ where: { tenantId } }),
        assignments: await tx.projectMembership.count({ where: { tenantId } }),
        buildups: await tx.rateBuildup.count({ where: { tenantId } }),
        buildupLines: await tx.rateBuildupLine.count({ where: { tenantId } }),
        materials: await tx.material.count({ where: { tenantId } }),
        conversions: await tx.unitConversion.count({ where: { tenantId } }),
        suppliers: await tx.supplier.count({ where: { tenantId } }),
        prices: await tx.materialPrice.count({ where: { tenantId } }),
        alerts: await tx.materialPrice.count({
          where: { tenantId, alertState: "above_threshold" },
        }),
        payouts: await tx.supplierPayoutVersion.findMany({
          where: { tenantId },
          select: { status: true },
          orderBy: { status: "asc" },
        }),
        labourers: await tx.labourer.count({ where: { tenantId } }),
        consents: await tx.labourerConsent.count({ where: { tenantId } }),
        engagements: await tx.labourEngagement.count({ where: { tenantId } }),
        accreditations: await tx.labourerAccreditation.count({ where: { tenantId } }),
        gangs: await tx.gang.count({ where: { tenantId } }),
        gangMembers: await tx.gangMembership.count({ where: { tenantId } }),
        doNotRehire: await tx.labourer.count({ where: { tenantId, doNotRehire: true } }),
        trades: await tx.trade.count({ where: { tenantId } }),
        attendanceDays: await tx.attendanceDay.count({ where: { tenantId } }),
        attendanceRecords: await tx.attendanceRecord.count({ where: { tenantId } }),
        periods: await tx.timesheetPeriod.count({ where: { tenantId } }),
        timesheetLines: await tx.timesheetLine.count({ where: { tenantId } }),
        anomalies: await tx.attendanceAnomaly.count({ where: { tenantId } }),
        adjustments: await tx.timesheetAdjustment.count({ where: { tenantId } }),
        rules: await tx.timesheetRuleVersion.count({ where: { tenantId } }),
        holidays: await tx.publicHoliday.count({ where: { tenantId } }),
        requisitions: await tx.requisition.count({ where: { tenantId } }),
        quotations: await tx.quotation.count({ where: { tenantId } }),
        lpos: await tx.lpo.findMany({ where: { tenantId }, select: { status: true } }),
        grns: await tx.grn.count({ where: { tenantId } }),
        invoices: await tx.supplierInvoice.findMany({
          where: { tenantId },
          select: { invoiceNumber: true, status: true },
          orderBy: { invoiceNumber: "asc" },
        }),
        payables: await tx.invoicePayable.count({ where: { tenantId } }),
        settlements: await tx.invoiceSettlement.count({ where: { tenantId } }),
        stores: await tx.store.count({ where: { tenantId } }),
        stockEntries: await tx.stockLedgerEntry.count({ where: { tenantId } }),
        movements: await tx.stockMovement.count({ where: { tenantId } }),
        transfers: await tx.stockTransfer.findMany({
          where: { tenantId },
          select: { status: true },
          orderBy: { number: "asc" },
        }),
        stockTakes: await tx.stockTake.findMany({ where: { tenantId }, select: { status: true } }),
        measurements: await tx.progressMeasurement.count({ where: { tenantId } }),
        mappings: await tx.buildupLineMaterial.count({ where: { tenantId } }),
        costCodes: await tx.costCode.count({ where: { tenantId } }),
        budgets: await tx.budget.findMany({ where: { tenantId }, select: { status: true } }),
        budgetLines: await tx.budgetLine.count({ where: { tenantId } }),
        costEntries: await tx.costEntry.count({ where: { tenantId } }),
        floats: await tx.pettyCashFloat.count({ where: { tenantId } }),
        floatEntries: await tx.pettyCashEntry.count({ where: { tenantId } }),
        expenses: await tx.pettyCashExpense.findMany({
          where: { tenantId },
          select: { status: true },
          orderBy: { number: "asc" },
        }),
        receipts: await tx.pettyCashReceipt.count({ where: { tenantId } }),
        topUps: await tx.pettyCashTopUp.findMany({
          where: { tenantId },
          select: { status: true },
          orderBy: { number: "asc" },
        }),
        counts: await tx.pettyCashCount.findMany({ where: { tenantId }, select: { status: true } }),
        journals: await tx.costJournal.findMany({ where: { tenantId }, select: { status: true } }),
        cashFlowItems: await tx.cashFlowItem.count({ where: { tenantId } }),
        templates: await tx.checklistTemplate.count({ where: { tenantId } }),
        inspections: await tx.inspection.findMany({
          where: { tenantId },
          select: { status: true, result: true },
          orderBy: [{ status: "asc" }, { result: "asc" }],
        }),
        snags: await tx.snag.findMany({
          where: { tenantId },
          select: { status: true, phase: true },
          orderBy: [{ phase: "asc" }, { status: "asc" }],
        }),
        cubeResults: await tx.cubeResult.count({ where: { tenantId } }),
        slumpTests: await tx.slumpTest.count({ where: { tenantId } }),
        completions: await tx.projectCompletion.findMany({
          where: { tenantId },
          select: { kind: true, status: true, dlpMonths: true },
        }),
        incidents: await tx.safetyIncident.findMany({
          where: { tenantId },
          select: { kind: true, status: true },
          orderBy: { number: "asc" },
        }),
        correctiveActions: await tx.correctiveAction.findMany({
          where: { tenantId },
          select: { status: true },
          orderBy: { number: "asc" },
        }),
        toolboxTalks: await tx.toolboxTalk.findMany({
          where: { tenantId },
          select: { status: true },
          orderBy: { number: "asc" },
        }),
        firstAidKits: await tx.firstAidKit.count({ where: { tenantId } }),
        treatments: await tx.firstAidTreatment.count({ where: { tenantId } }),
        plantItems: await tx.plantItem.findMany({
          where: { tenantId },
          select: { code: true, status: true },
          orderBy: { code: "asc" },
        }),
        plantUsage: await tx.plantUsageLog.count({ where: { tenantId } }),
        plantFuel: await tx.plantFuelIssue.count({ where: { tenantId } }),
        plantBreakdowns: await tx.plantBreakdown.count({ where: { tenantId, status: "open" } }),
      }));
    const first = await seedDemo(app);
    expect(first.company.name).toBe(DEMO_COMPANY);
    const ownerId = (
      await prisma.user.findUniqueOrThrow({ where: { identifier: DEMO_ACCOUNTS[0]!.identifier } })
    ).id;
    const afterFirst = await counts(first.company.id, ownerId);
    const { attendanceDays, attendanceRecords, periods, timesheetLines, anomalies, ...registry } =
      afterFirst;
    expect(registry).toEqual({
      // D5.3 adds the storekeeper, assigned to Ruiru Heights and Kitengela.
      members: 5,
      // D6.1 adds JUJ-DPX (handed over: activated and completed), assigned to the PM and agent.
      projects: 4,
      sites: 4,
      geofences: 4,
      wbs: 16,
      milestones: 11,
      history: 4,
      assignments: 7,
      buildups: 1,
      buildupLines: 5,
      // D5.1: the starter catalogue (21 materials, 6 factors) plus 2 supplier trip factors; three
      // suppliers; 8 prices with one alert (cement KES 800 → 900: +12.5 %); one Paybill
      // verified by the finance user and one Till/bank proposal pending.
      materials: 21,
      conversions: 8,
      // D8.3 adds the plant hire company.
      suppliers: 4,
      // D5.2 adds six quotation prices (three suppliers × two lines), none above the threshold;
      // D5.3 three cement quotations.
      prices: 17,
      alerts: 1,
      payouts: [{ status: "pending" }, { status: "verified" }],
      labourers: 40,
      consents: 40,
      engagements: 40,
      accreditations: 18,
      gangs: 6,
      gangMembers: 39,
      doNotRehire: 1,
      trades: 15,
      adjustments: 1,
      rules: 1,
      holidays: 23,
      // D5.2: REQ → RFQ (3 quotations) → approved LPO → partial GRN → one invoice matched,
      // approved and settled, one blocked by the three-way match (ballast not yet delivered).
      // D5.3: a second REQ → RFQ → LPO → GRN for 120 bags of cement.
      requisitions: 2,
      quotations: 6,
      lpos: [{ status: "approved" }, { status: "approved" }],
      grns: 2,
      invoices: [
        { invoiceNumber: "MQ-INV-1001", status: "settled" },
        { invoiceNumber: "MQ-INV-1002", status: "disputed" },
      ],
      payables: 1,
      settlements: 1,
      // D5.3: two stores; 3 receipts, 3 issue lines, a return, wastage and two transfers (out,
      // in, out); a disputed and an in-transit transfer; a submitted stock take; one measurement
      // and the build-up's three material lines mapped.
      stores: 2,
      stockEntries: 11,
      movements: 3,
      transfers: [{ status: "disputed" }, { status: "dispatched" }],
      stockTakes: [{ status: "submitted" }],
      measurements: 1,
      mappings: 3,
      // D5.4: the default cost codes; an approved budget (3 BQ items + 4 cost-code lines); a float
      // with a paid and a requested top-up, five approved expenses (one with an M-Pesa charge)
      // and two waiting, an approved count and journal, three forecast lines. Cost entries: the
      // invoice accrual and settlement payment, 5 × 2 expense entries + 2 for the charge, 2 for
      // the count shortage and 2 journal lines.
      costCodes: 11,
      budgets: [{ status: "approved" }],
      budgetLines: 7,
      costEntries: 18,
      floats: 1,
      floatEntries: 9,
      expenses: [
        ...Array.from({ length: 5 }, () => ({ status: "approved" })),
        { status: "submitted" },
        { status: "submitted" },
      ],
      receipts: 6,
      topUps: [{ status: "paid" }, { status: "requested" }],
      counts: [{ status: "approved" }],
      journals: [{ status: "approved" }],
      cashFlowItems: 3,
      // D6.1: the seven starter templates; on RUI-HTS a signed-off and a failed (signed-off)
      // inspection and one awaiting sign-off, on JUJ-DPX a signed-off pre-handover inspection;
      // snags in every state, two reported in the DLP; four cube sets with six results; three
      // slump tests; JUJ-DPX's practical completion certified with a six-month DLP.
      templates: 7,
      inspections: [
        { status: "signed_off", result: "fail" },
        { status: "signed_off", result: "pass" },
        { status: "signed_off", result: "pass" },
        { status: "submitted", result: "pass" },
      ],
      snags: [
        { status: "closed", phase: "construction" },
        { status: "closed", phase: "construction" },
        { status: "closed", phase: "construction" },
        { status: "fixed", phase: "construction" },
        { status: "open", phase: "construction" },
        { status: "open", phase: "construction" },
        { status: "fixed", phase: "dlp" },
        { status: "open", phase: "dlp" },
      ],
      cubeResults: 5,
      slumpTests: 3,
      completions: [{ kind: "practical", status: "certified", dlpMonths: 6 }],
      // D8.2: on RUI-HTS a closed near miss and an investigated injury; three corrective actions
      // (two verified, one overdue); two confirmed toolbox talks and a draft; two kits; a treatment.
      incidents: [
        { kind: "near_miss", status: "closed" },
        { kind: "injury", status: "investigated" },
      ],
      correctiveActions: [{ status: "verified" }, { status: "verified" }, { status: "open" }],
      toolboxTalks: [{ status: "confirmed" }, { status: "confirmed" }, { status: "draft" }],
      firstAidKits: 2,
      treatments: 1,
      plantItems: [
        { code: "EX-01", status: "on_site" },
        { code: "GN-01", status: "available" },
        { code: "MX-01", status: "on_site" },
        { code: "RL-01", status: "on_site" },
        { code: "SCF-01", status: "on_site" },
        { code: "VB-01", status: "under_repair" },
      ],
      plantUsage: 7,
      plantFuel: 3,
      plantBreakdowns: 1,
    });
    // One fuel variance alert, one service due, one open breakdown and one idle hired item.
    const plantAlerts = Object.fromEntries(
      first.plant.items.map((item) => [item.code, item.alerts]),
    );
    expect(plantAlerts).toEqual({
      "EX-01": ["fuel_over_standard"],
      "GN-01": [],
      "MX-01": ["service_due"],
      "RL-01": ["idle_on_hire", "hire_ending"],
      "SCF-01": [],
      "VB-01": ["breakdown_open"],
    });
    expect(first.plant.fuelVarianceAlerts).toBe(1);
    expect(first.safety).toMatchObject({
      flaggedLabourers: 2,
      actions: { total: 3, verified: 2, overdue: 1 },
    });
    expect(first.safety.ppeDue).toBeGreaterThan(0);
    expect(first.quality).toMatchObject({
      failedCubeSets: 1,
      overdueCubeSets: 1,
      practicalCompletion: addCalendarDays(nairobiDate(), -75),
    });
    // Every spend-alert kind shows on the demo.
    expect(
      Object.entries(first.spending.alerts)
        .filter(([, total]) => total > 0)
        .map(([kind]) => kind)
        .sort(),
    ).toEqual(["budget_threshold", "duplicate_payment", "missing_documents", "unusual_spend"]);
    expect(first.stores).toMatchObject({ varianceAlerts: 1, lowStock: 2 });
    // Nine weeks of muster rolls on two projects: past periods approved (with their snapshot
    // lines), the last complete one awaiting approval and the current one open.
    // The test database is reused between runs, so the first call may find the data already there.
    expect(first.attendance).toMatchObject({ adjustments: 1, holidays: 23 });
    expect(attendanceRecords).toBe(first.attendance.records);
    expect(attendanceRecords).toBeGreaterThan(1000);
    expect(attendanceDays).toBeGreaterThan(100);
    expect(timesheetLines).toBeGreaterThan(0);
    expect(anomalies).toBeGreaterThan(first.attendance.openAnomalies);
    expect(periods).toBe(first.attendance.periods);
    const states = await db.run(
      { tenantId: first.company.id, userId: ownerId, requestId: "seed-counts" },
      async (tx) => ({
        periods: await tx.timesheetPeriod.groupBy({
          by: ["status"],
          where: { tenantId: first.company.id },
          _count: true,
        }),
        unapprovedLines: await tx.timesheetLine.count({
          where: { tenantId: first.company.id, period: { status: { not: "approved" } } },
        }),
        open: await tx.attendanceAnomaly.findMany({
          where: { tenantId: first.company.id, status: "open" },
          select: { kind: true },
          distinct: ["kind"],
        }),
        adjustment: await tx.timesheetAdjustment.findFirstOrThrow({
          where: { tenantId: first.company.id },
          select: { status: true, requestedBy: true, decidedBy: true },
        }),
      }),
    );
    const byStatus = Object.fromEntries(states.periods.map((row) => [row.status, row._count]));
    // Past weeks approved, the last complete week of each project submitted, and the current
    // week open (none when the seed ran after Thursday's cut-off).
    expect(byStatus["approved"]).toBe(first.attendance.approvedPeriods);
    expect(byStatus["submitted"]).toBe(2);
    expect([0, 2]).toContain(byStatus["open"] ?? 0);
    expect(byStatus["rejected"]).toBeUndefined();
    expect(states.unapprovedLines).toBe(0);
    expect(states.open.map((row) => row.kind)).toEqual(
      expect.arrayContaining(["two_sites", "excess_hours"]),
    );
    expect(states.adjustment.status).toBe("approved");
    expect(states.adjustment.decidedBy).not.toBe(states.adjustment.requestedBy);
    // A database seeded before the storekeeper joined the team: the next seed assigns them.
    const keeperId = (
      await prisma.user.findUniqueOrThrow({
        where: {
          identifier: DEMO_ACCOUNTS.find((account) => account.key === "storekeeper")!.identifier,
        },
      })
    ).id;
    const unassigned = await db.run(
      { tenantId: first.company.id, userId: ownerId, requestId: "seed-older-db" },
      (tx) => tx.projectMembership.deleteMany({ where: { userId: keeperId } }),
    );
    expect(unassigned.count).toBe(2);
    const second = await seedDemo(app);
    expect((await counts(first.company.id, ownerId)).assignments).toBe(afterFirst.assignments);
    expect(second.company).toEqual({ ...first.company, created: false });
    expect(second.accounts.every((account) => !account.created && account.password === null)).toBe(
      true,
    );
    expect(second.accounts.find((account) => account.role === "owner")?.totp?.uri).toMatch(
      /^otpauth:\/\/totp\/PM-Buddy:owner%40jenga-bora\.example\.test\?/,
    );
    expect(second.projects.map((entry) => [entry.code, entry.status, entry.created])).toEqual([
      ["RUI-HTS", "active", false],
      ["KIT-BNG", "active", false],
      ["SYO-TWN", "planning", false],
      ["JUJ-DPX", "completed", false],
    ]);
    expect(second.buildups).toEqual([
      {
        code: "CONC-C25-SYN",
        name: "Concrete class 25 (1:2:4), per m³ (synthetic example)",
        rateMinor: 1_328_525,
        created: false,
      },
    ]);
    expect(second.procurement).toEqual({
      materials: { created: 0, existing: 21 },
      suppliers: [
        { code: "SUP-0001", name: "Mlolongo Quarry (synthetic)", created: false },
        { code: "SUP-0002", name: "Athi River Steel (synthetic)", created: false },
        { code: "SUP-0003", name: "Kitengela Hardware (synthetic)", created: false },
      ],
    });
    expect(second.labour).toMatchObject({ labourersCreated: 0, labourersTotal: 40, rates: 0 });
    expect(second.attendance).toEqual({ ...first.attendance, created: false });
    // Payroll (D4.1): unverified statutory rules, minimum wages, allowances, piece-rate output,
    // two advances, one submitted and three draft batches; the submitted snapshot matches its digest.
    expect(first.payroll).toMatchObject({
      ruleVersions: KENYA_STATUTORY_SEED.length,
      minimumWages: 18,
      allowances: 3,
      outputs: 2,
      advances: 2,
      submittedBatches: 1,
      draftBatches: 3,
    });
    expect(second.payroll).toEqual({ ...first.payroll, created: false });
    await db.run(
      { tenantId: first.company.id, userId: ownerId, requestId: "seed-payroll" },
      async (tx) => {
        expect(
          await tx.statutoryRuleVersion.count({
            where: { tenantId: first.company.id, status: { not: "unverified" } },
          }),
        ).toBe(0);
        const submitted = await tx.payrollBatch.findFirstOrThrow({
          where: { tenantId: first.company.id, status: "submitted" },
        });
        expect(submitted.unverifiedRules).toBe(true);
        const stored = await app
          .get(BatchBuilder)
          .storedSnapshot(tx, first.company.id, submitted.id);
        expect(stored.digest).toBe(submitted.digest);
      },
    );
    expect(second.spending).toEqual({ ...first.spending, created: false });
    expect(second.procureToPay).toEqual({
      created: false,
      requisition: "REQ-0001",
      rfq: "RFQ-0001",
      lpo: "LPO-0001",
      grn: "GRN-0001",
      invoices: [
        { number: "MQ-INV-1001", status: "settled" },
        { number: "MQ-INV-1002", status: "disputed" },
      ],
    });
    expect(second.quality).toEqual({ ...first.quality, created: false });
    expect(second.safety).toEqual({ ...first.safety, created: false });
    expect(second.plant).toEqual({ ...first.plant, created: false });
    expect(await counts(first.company.id, ownerId)).toEqual(afterFirst);
    // Seeds a whole company twice (about 7 s alone); parallel e2e files can triple that.
  }, 90_000);
});
