import { randomInt } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authResponseSchema,
  clientProjectResponseSchema,
  clientProjectsResponseSchema,
  diaryResponseSchema,
  projectResponseSchema,
  siteResponseSchema,
  tenantCreatedResponseSchema,
  workerPortalResponseSchema,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { Browser, notifications, password } from "./support.js";

const PIN = "274915";
const phone = () => `2547${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;
const radius = { kind: "radius", center: { lat: -1.1489, lng: 36.9612 }, radiusM: 40 } as const;

describe("Client, labourer and staff portals (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: Browser;
  let ownerB: Browser;
  let pm: Browser;
  let agent: Browser;
  let client: Browser;
  let tenantA: string;
  let p1: string;
  let p2: string;
  let otherCompanyProject: string;
  let site: string;
  let approved: string;
  let draft: string;
  let notificationSpy: ReturnType<typeof vi.spyOn>;

  const fresh = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
  const lastText = (identifier: string) => notifications.get(identifier)?.at(-1)?.text ?? "";
  const linkToken = (identifier: string) =>
    lastText(identifier).match(/token=([A-Za-z0-9_-]{43})/)?.[1] ?? "";
  const code = (res: request.Response) => (res.body as { code?: string }).code;
  const join = async (inviter: Browser, member: Browser, role: string, projectIds: string[]) => {
    await fresh(inviter);
    const invited = await inviter.call("post", "tenants/current/invitations", {
      identifier: member.identifier,
      role,
      projectIds,
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    const token = lastText(member.identifier).match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
    expect((await member.call("post", "tenants/invitations/accept", { token })).status).toBe(200);
    expect((await member.call("post", `tenants/${tenantA}/select`, {})).status).toBe(200);
  };
  const browser = async () => {
    const value = new Browser(app);
    await value.initialize();
    return value;
  };
  /** The PM invites a labourer to P1; returns the phone number and the token from the SMS link. */
  const inviteLabourer = async (number = phone()) => {
    const res = await pm.call("post", `projects/${p1}/labourers/invitations`, {
      identifier: number,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { number, token: linkToken(number) };
  };
  const joinAsLabourer = async () => {
    const { number, token } = await inviteLabourer();
    const labourer = await browser();
    const res = await labourer.call("post", "auth/pin/join", {
      identifier: number,
      token,
      displayName: "Otieno Kibarua",
      pin: PIN,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { labourer, number, auth: authResponseSchema.parse(res.body) };
  };

  beforeAll(async () => {
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({
      bufferLogs: true,
    });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    notificationSpy = vi
      .spyOn(app.get(AuthSecurity), "notify")
      .mockImplementation(async (identifier, subject, text) => {
        notifications.set(identifier, [
          ...(notifications.get(identifier) ?? []),
          { subject, text },
        ]);
      });
    [owner, ownerB, pm, agent, client] = [0, 1, 2, 3, 4].map(() => new Browser(app));
    for (const value of [owner, ownerB]) {
      await value.register();
      await value.enroll();
    }
    for (const value of [pm, agent, client]) await value.register();
    tenantA = tenantCreatedResponseSchema.parse(
      (await owner.call("post", "tenants", { name: "Portal company A" })).body,
    ).tenant.id;
    expect((await ownerB.call("post", "tenants", { name: "Portal company B" })).status).toBe(201);
    const project = async (who: Browser, name: string) =>
      projectResponseSchema.parse((await who.call("post", "projects", { name })).body).project.id;
    p1 = await project(owner, "Portal project one");
    p2 = await project(owner, "Portal project two");
    otherCompanyProject = await project(ownerB, "Other company project");
    site = siteResponseSchema.parse(
      (await owner.call("post", `projects/${p1}/sites`, { name: "Main plot", geofence: radius }))
        .body,
    ).site.id;
    expect(
      (
        await owner.call("post", `projects/${p1}/milestones`, {
          name: "Slab",
          dueDate: "2026-12-01",
        })
      ).status,
    ).toBe(201);
    await join(owner, pm, "project_manager", [p1]);
    await join(owner, agent, "site_agent", [p1]);
    await join(owner, client, "client", [p1]);
    const diary = async (date: string, text: string) =>
      diaryResponseSchema.parse(
        (
          await owner.call("post", `projects/${p1}/diaries`, {
            siteId: site,
            date,
            workPerformed: text,
            weather: "Dry",
            delays: null,
            workforceCount: 14,
          })
        ).body,
      ).diary;
    const first = await diary("2026-02-02", "Approved: columns cast");
    const submitted = await owner.call("post", `projects/${p1}/diaries/${first.id}/actions`, {
      action: "submit",
      version: 1,
    });
    expect(submitted.status).toBe(200);
    const done = await pm.call("post", `projects/${p1}/diaries/${first.id}/actions`, {
      action: "approve",
      version: 2,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    approved = first.id;
    draft = (await diary("2026-02-03", "Draft: internal note about the subcontractor")).id;
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("documents the portal and PIN operations", async () => {
    const spec = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (spec.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "listClientProjects",
      "getClientProject",
      "getWorkerPortal",
      "inviteLabourer",
      "signInWithPin",
      "joinWithPin",
      "resetPin",
    ])
      expect(operations).toContain(id);
  });

  it("lets only labour managers invite labourers, by phone, to their own projects", async () => {
    expect(
      (await agent.call("post", `projects/${p1}/labourers/invitations`, { identifier: phone() }))
        .status,
    ).toBe(403);
    expect(
      (await pm.call("post", `projects/${p2}/labourers/invitations`, { identifier: phone() }))
        .status,
    ).toBe(403);
    expect(
      (await ownerB.call("post", `projects/${p1}/labourers/invitations`, { identifier: phone() }))
        .status,
    ).toBe(404);
    const email = await pm.call("post", `projects/${p1}/labourers/invitations`, {
      identifier: "labourer@example.test",
    });
    expect(email.status).toBe(400);
    await fresh(owner);
    const general = await owner.call("post", "tenants/current/invitations", {
      identifier: "labourer@example.test",
      role: "labourer",
      projectIds: [],
    });
    expect(code(general)).toBe("labourer-phone-required");
    const { number, token } = await inviteLabourer();
    expect(lastText(number)).toContain(`/worker/join?token=${token}`);
  });

  it("creates a labourer account from the link, signs in to the worker portal only", async () => {
    const { number, token } = await inviteLabourer();
    const labourer = await browser();
    const attempt = (body: object) => labourer.call("post", "auth/pin/join", body);
    const base = { identifier: number, token, displayName: "Akinyi Kibarua", pin: PIN };
    expect(code(await attempt({ ...base, pin: "123456" }))).toBe("pin-too-weak");
    expect(code(await attempt({ ...base, pin: number.slice(-6) }))).toBe("pin-too-weak");
    expect((await attempt({ ...base, identifier: phone() })).status).toBe(401);
    expect((await attempt({ ...base, token: "x".repeat(43) })).status).toBe(401);
    expect(await prisma.user.count({ where: { identifier: number } })).toBe(0);

    const res = await attempt(base);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const auth = authResponseSchema.parse(res.body);
    expect(auth).toMatchObject({
      user: { identifier: number, verified: true },
      session: { tenantId: tenantA },
    });
    const portal = workerPortalResponseSchema.parse(
      (await labourer.call("get", "portal/worker")).body,
    );
    expect(portal).toMatchObject({
      displayName: "Akinyi Kibarua",
      company: { id: tenantA },
      attendance: null,
      pay: null,
    });
    expect(portal.assignments).toHaveLength(1);
    expect(portal.assignments[0]!.project.id).toBe(p1);
    expect(portal.assignments[0]!.sites.map((value) => value.id)).toEqual([site]);
    expect(JSON.stringify(portal)).not.toContain("contractSum");
    const membership = await prisma.$queryRaw<{ role: string; permissions: string[] }[]>`
      SELECT m.role, pm.permissions FROM users u
      JOIN memberships m ON m.user_id = u.id
      JOIN project_memberships pm ON pm.user_id = u.id AND pm.tenant_id = m.tenant_id
      WHERE u.identifier = ${number}`;
    expect(membership).toEqual([]); // forced RLS: invisible without a tenant context

    // The labourer role holds no project permissions: office endpoints show nothing or refuse.
    expect((await labourer.call("get", "projects")).body).toEqual({ projects: [] });
    for (const path of [`projects/${p1}`, `projects/${p1}/diaries`, "portal/client/projects"]) {
      const denied = await labourer.call("get", path);
      expect(denied.status, path).toBe(403);
    }
    expect((await labourer.call("post", "auth/mfa/enroll", {})).status).toBe(403);
    expect((await labourer.call("post", "tenants", { name: "Labourer company" })).status).toBe(403);
    expect((await attempt(base)).status).toBe(401); // the invitation is spent
    const again = await pm.call("post", `projects/${p1}/labourers/invitations`, {
      identifier: number,
    });
    expect(code(again)).toBe("already-member");
  });

  it("signs labourers in with phone and PIN, with lockout and no PIN path for password accounts", async () => {
    const { number } = await joinAsLabourer();
    const signIn = async (pin: string, identifier = number) =>
      (await browser()).call("post", "auth/pin/login", { identifier, pin });
    expect((await signIn("802461")).status).toBe(401);
    const ok = await signIn(PIN);
    expect(ok.status).toBe(200);
    expect((await signIn(PIN, "someone@example.test")).status).toBe(400);
    const staff = new Browser(app);
    staff.identifier = phone();
    await staff.register();
    expect((await signIn(PIN, staff.identifier)).status).toBe(401);
    expect((await signIn(PIN, phone())).status).toBe(401);
    for (let attempt = 0; attempt < 5; attempt++) expect((await signIn("802461")).status).toBe(401);
    expect((await signIn(PIN)).status).toBe(401); // locked for 15 minutes
  });

  it("resets a forgotten PIN through the SMS link and signs out every session", async () => {
    const { labourer, number } = await joinAsLabourer();
    const forgot = await (
      await browser()
    ).call("post", "auth/password/forgot", { identifier: number });
    expect(forgot.status).toBe(200);
    await vi.waitFor(() => expect(lastText(number)).toContain("/worker/pin?token="));
    const token = linkToken(number);
    const reset = (pin: string) => labourer.call("post", "auth/pin/reset", { token, pin });
    expect(code(await reset("111111"))).toBe("pin-too-weak");
    expect((await reset("530718")).status).toBe(200);
    expect((await labourer.call("get", "auth/me")).status).toBe(401);
    const login = (pin: string) =>
      labourer.call("post", "auth/pin/login", { identifier: number, pin });
    expect((await login(PIN)).status).toBe(401);
    expect((await login("530718")).status).toBe(200);
    expect((await reset("648203")).status).toBe(401); // single use
  });

  it("asks existing accounts to sign in and accept, and never lets a PIN session accept staff roles", async () => {
    const worker = new Browser(app);
    worker.identifier = phone();
    await worker.register();
    const res = await pm.call("post", `projects/${p1}/labourers/invitations`, {
      identifier: worker.identifier,
    });
    expect(res.status).toBe(201);
    const token = linkToken(worker.identifier);
    const outsider = await browser();
    const joinBody = { identifier: worker.identifier, token, displayName: "X", pin: PIN };
    expect(code(await outsider.call("post", "auth/pin/join", joinBody))).toBe("account-exists");
    expect(
      (await outsider.call("post", "auth/pin/join", { ...joinBody, token: "y".repeat(43) })).status,
    ).toBe(401);
    expect((await worker.call("post", "tenants/invitations/accept", { token })).status).toBe(200);

    const { labourer, number } = await joinAsLabourer();
    await fresh(ownerB);
    const staff = await ownerB.call("post", "tenants/current/invitations", {
      identifier: number,
      role: "site_agent",
      projectIds: [],
    });
    expect(staff.status).toBe(201);
    const staffToken = lastText(number).match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
    const accepted = await labourer.call("post", "tenants/invitations/accept", {
      token: staffToken,
    });
    expect(code(accepted)).toBe("pin-session-limited");

    // Promoted: the labourer sets a password and accepts as staff; the PIN still opens only the
    // labourer portal, even in the company where they are now staff.
    const forgot = await labourer.call("post", "auth/password/forgot", { identifier: number });
    expect(forgot.status).toBe(200);
    await vi.waitFor(() => expect(lastText(number)).toContain("/worker/pin?token="));
    const reset = await labourer.call("post", "auth/password/reset", {
      token: linkToken(number),
      password,
    });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    const promoted = new Browser(app);
    promoted.identifier = number;
    await promoted.initialize();
    await promoted.login();
    const staffAccept = await promoted.call("post", "tenants/invitations/accept", {
      token: staffToken,
    });
    expect(staffAccept.status).toBe(200);
    const companies = (await promoted.call("get", "tenants")).body as {
      tenants: { id: string; role: string }[];
    };
    const companyB = companies.tenants.find((value) => value.role === "site_agent")!.id;
    expect((await promoted.call("post", `tenants/${companyB}/select`, {})).status).toBe(200);
    expect((await promoted.call("get", "projects")).status).toBe(200);
    const viaPin = await browser();
    const pinLogin = await viaPin.call("post", "auth/pin/login", { identifier: number, pin: PIN });
    expect(pinLogin.status).toBe(200);
    expect((await viaPin.call("post", `tenants/${companyB}/select`, {})).status).toBe(200);
    expect(code(await viaPin.call("get", "projects"))).toBe("pin-session-limited");
    expect((await viaPin.call("post", `tenants/${tenantA}/select`, {})).status).toBe(200);
    expect((await viaPin.call("get", "portal/worker")).status).toBe(200);
  });

  it("serialises a double-submitted join into one account", async () => {
    const { number, token } = await inviteLabourer();
    const [a, b] = await Promise.all([browser(), browser()]);
    const body = { identifier: number, token, displayName: "Double", pin: PIN };
    const results = await Promise.all([
      a.call("post", "auth/pin/join", body),
      b.call("post", "auth/pin/join", body),
    ]);
    // One join wins. The other either waited on the lock (409 account-exists) or arrived after
    // the invitation was spent (401, as for any replay); neither creates a second account.
    const [won, lost] = results.map((res) => res.status).sort((x, y) => x - y);
    expect(won).toBe(200);
    expect([401, 409]).toContain(lost);
    expect(await prisma.user.count({ where: { identifier: number } })).toBe(1);
  });

  it("shows clients their assigned projects with approved diaries only", async () => {
    const list = clientProjectsResponseSchema.parse(
      (await client.call("get", "portal/client/projects")).body,
    );
    expect(list.company.id).toBe(tenantA);
    expect(list.projects.map((value) => value.id)).toEqual([p1]);
    expect(list.projects[0]!.milestones).toEqual({ total: 1, achieved: 0 });
    const detail = clientProjectResponseSchema.parse(
      (await client.call("get", `portal/client/projects/${p1}`)).body,
    );
    expect(detail.diaries.map((value) => value.id)).toEqual([approved]);
    expect(detail.diaries[0]).toMatchObject({ siteName: "Main plot", workforceCount: 14 });
    expect(JSON.stringify(detail)).not.toContain("internal note");
    expect(detail.diaries.map((value) => value.id)).not.toContain(draft);
    expect(JSON.stringify(detail)).not.toContain(pm.auth.user.id);
    expect(detail.milestones.map((value) => value.name)).toEqual(["Slab"]);

    expect((await client.call("get", `portal/client/projects/${p2}`)).status).toBe(403);
    expect((await client.call("get", `portal/client/projects/${otherCompanyProject}`)).status).toBe(
      404,
    );
    expect((await client.call("get", `projects/${p1}/diaries`)).status).toBe(403);
    expect((await client.call("get", "portal/worker")).status).toBe(403);
    expect((await pm.call("get", "portal/client/projects")).status).toBe(403);
    expect((await pm.call("get", `projects/${p1}/diaries`)).status).toBe(200);
    expect((await ownerB.call("get", `portal/client/projects/${p1}`)).status).toBe(404);
  });

  it("reports each member's portal through their role permissions", async () => {
    const tenants = async (who: Browser) =>
      (await who.call("get", "tenants")).body as {
        tenants: { id: string; role: string; permissions: string[] }[];
      };
    expect((await tenants(client)).tenants.find((value) => value.id === tenantA)?.role).toBe(
      "client",
    );
    const { labourer } = await joinAsLabourer();
    const labourerTenants = await tenants(labourer);
    expect(labourerTenants.tenants).toEqual([
      expect.objectContaining({ id: tenantA, role: "labourer", permissions: ["portal.worker"] }),
    ]);
  });
});
