import { randomBytes, randomInt } from "node:crypto";
import { Logger, type INestApplication } from "@nestjs/common";
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
  roleResponseSchema,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AppConfig } from "../src/config/app-config.js";
import {
  AuthSecurity,
  hashPassword,
  verifyPassword,
} from "../src/modules/identity/auth-security.service.js";
import { PIN_DAILY_FAILURES, PIN_GLOBAL_FAILURES } from "../src/modules/identity/pin.service.js";
import { Browser, notifications, password } from "./support.js";

const PIN = "274915";
const phone = () => `2547${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;
const radius = { kind: "radius", center: { lat: -1.1489, lng: 36.9612 }, radiusM: 40 } as const;

/** A well-formed token that matches nothing; fresh each time, so per-token limits never carry over. */
const unknownToken = () => randomBytes(32).toString("base64url");
const isBudgetAlert = (fields: unknown) =>
  typeof fields === "object" &&
  fields !== null &&
  (fields as { event?: string }).event === "pin_failure_budget_exceeded";

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
    // The platform-wide PIN failure count lives in Redis for an hour; start every run from zero.
    await app.get(AuthSecurity).forget(PIN_GLOBAL_FAILURES);
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
    expect((await attempt({ ...base, token: unknownToken() })).status).toBe(401);
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

  /** A labourer invited by the owner (the project manager's invitation limit is left alone). */
  const ownerInvitedLabourer = async (displayName: string) => {
    const number = phone();
    const invited = await owner.call("post", `projects/${p1}/labourers/invitations`, {
      identifier: number,
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    const joined = await (
      await browser()
    ).call("post", "auth/pin/join", {
      identifier: number,
      token: linkToken(number),
      displayName,
      pin: PIN,
    });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    return number;
  };
  const pinSignIn = async (identifier: string, pin: string) =>
    (await browser()).call("post", "auth/pin/login", { identifier, pin });

  it("peppers stored PINs and re-hashes an older, unpeppered PIN on its next correct sign-in", async () => {
    const number = await ownerInvitedLabourer("Wairimu Kibarua");
    const stored = await prisma.user.findUniqueOrThrow({ where: { identifier: number } });
    expect(stored.pinPepperVersion).toBe(1);
    // Without the server-side key the stored hash cannot be checked, even with the right PIN.
    expect(await verifyPassword(stored.pinHash!, PIN)).toBe(false);

    // A PIN hashed before the pepper existed still signs in, and is moved to the active key.
    await prisma.user.update({
      where: { id: stored.id },
      data: { pinHash: await hashPassword(PIN), pinPepperVersion: null },
    });
    expect((await pinSignIn(number, PIN)).status).toBe(200);
    const upgraded = await prisma.user.findUniqueOrThrow({ where: { id: stored.id } });
    expect(upgraded.pinPepperVersion).toBe(1);
    expect(await verifyPassword(upgraded.pinHash!, PIN)).toBe(false);
    expect((await pinSignIn(number, PIN)).status).toBe(200);
  });

  /** Statuses and codes of parallel wrong PINs for one number, sorted, so races show up as counts. */
  const parallelWrongPins = async (identifier: string, count: number) =>
    (await Promise.all(Array.from({ length: count }, () => pinSignIn(identifier, "802461"))))
      .map((res) => `${res.status} ${code(res) ?? ""}`.trim())
      .sort();
  const resetPin = async (identifier: string, pin: string) => {
    const forgot = await (await browser()).call("post", "auth/password/forgot", { identifier });
    expect(forgot.status).toBe(200);
    await vi.waitFor(() => expect(lastText(identifier)).toContain("/worker/pin?token="));
    const reset = await (
      await browser()
    ).call("post", "auth/pin/reset", { token: linkToken(identifier), pin });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
  };

  it("tightens PIN sign-in once wrong PINs across all numbers pass the hourly budget", async () => {
    const security = app.get(AuthSecurity);
    const budget = app.get(AppConfig).get("PIN_GLOBAL_FAILURES_PER_HOUR");
    const alert = vi.spyOn(Logger.prototype, "error");
    try {
      const mistyped = await ownerInvitedLabourer("Mutua Kibarua");
      const careful = await ownerInvitedLabourer("Atieno Kibarua");
      expect((await pinSignIn(mistyped, "802461")).status).toBe(401);
      while ((await security.counted(PIN_GLOBAL_FAILURES)) < budget - 1)
        await security.increment(PIN_GLOBAL_FAILURES, 3_600);
      expect(alert.mock.calls.filter(([fields]) => isBudgetAlert(fields))).toHaveLength(0);
      // The wrong PIN that reaches the budget (an unknown number) raises the alert, once.
      expect((await pinSignIn(phone(), "802461")).status).toBe(401);
      expect((await pinSignIn(phone(), "802461")).status).toBe(401);
      expect(alert.mock.calls.filter(([fields]) => isBudgetAlert(fields))).toHaveLength(1);

      // A typo from before the budget was spent does not count: the right PIN still works.
      expect((await pinSignIn(mistyped, PIN)).status).toBe(200);
      // Each number now gets one wrong PIN an hour; after it even the right PIN waits.
      expect((await pinSignIn(careful, PIN)).status).toBe(200);
      expect((await pinSignIn(careful, "802461")).status).toBe(401);
      const limited = await pinSignIn(careful, PIN);
      expect([limited.status, code(limited)]).toEqual([429, "pin-temporarily-limited"]);
      // Parallel guesses reserve their place first, so only one of them is ever checked.
      expect(await parallelWrongPins(mistyped, 6)).toEqual([
        "401 unauthorized",
        ...Array.from({ length: 5 }, () => "429 pin-temporarily-limited"),
      ]);
      // A PIN reset by SMS proves control of the phone and clears the hour's limit.
      await resetPin(careful, "530718");
      expect((await pinSignIn(careful, "530718")).status).toBe(200);
    } finally {
      alert.mockRestore();
      await security.forget(PIN_GLOBAL_FAILURES);
    }
  });

  it("counts only wrong PINs against the daily budget, which a PIN reset clears", async () => {
    // Invited by the owner: the project manager's invitation limit is left to the other tests.
    const number = phone();
    const invited = await owner.call("post", `projects/${p1}/labourers/invitations`, {
      identifier: number,
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    const joined = await (
      await browser()
    ).call("post", "auth/pin/join", {
      identifier: number,
      token: linkToken(number),
      displayName: "Njeri Kibarua",
      pin: PIN,
    });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    const security = app.get(AuthSecurity);
    const key = `pin-day:key:${number}`;
    const signIn = async (pin: string) =>
      (await browser()).call("post", "auth/pin/login", { identifier: number, pin });
    for (let count = 0; count < PIN_DAILY_FAILURES - 1; count++)
      await security.increment(key, 86_400);
    // A correct PIN is never blocked by an unspent budget and does not spend it.
    expect((await signIn(PIN)).status).toBe(200);
    expect(await security.counted(key)).toBe(PIN_DAILY_FAILURES - 1);
    // Parallel guesses reserve their place first, so only the last one left is checked.
    expect(await parallelWrongPins(number, 5)).toEqual([
      "401 unauthorized",
      ...Array.from({ length: 4 }, () => "429 pin-reset-required"),
    ]);
    expect(await security.counted(key)).toBe(PIN_DAILY_FAILURES);
    // Spent: even the right PIN needs a reset first, and the reset clears the budget.
    const blocked = await signIn(PIN);
    expect([blocked.status, code(blocked)]).toEqual([429, "pin-reset-required"]);
    await resetPin(number, "530718");
    expect(await security.counted(key)).toBe(0);
    expect((await signIn("530718")).status).toBe(200);
  });

  it("keeps PIN sessions to roles that hold only the labourer portal", async () => {
    await fresh(owner);
    const role = roleResponseSchema.parse(
      (
        await owner.call("post", "tenants/current/roles", {
          name: "Senior labourer",
          permissions: ["portal.worker", "projects.view", "bq.view"],
        })
      ).body,
    ).role;
    const number = phone();
    await fresh(owner);
    const invited = await owner.call("post", "tenants/current/invitations", {
      identifier: number,
      role: role.id,
      projectIds: [p1],
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    const token = lastText(number).match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
    const joined = await (
      await browser()
    ).call("post", "auth/pin/join", { identifier: number, token, displayName: "Wekesa", pin: PIN });
    expect(code(joined)).toBe("pin-session-limited");

    // A PIN session whose role later gains view permissions loses access too.
    const plain = roleResponseSchema.parse(
      (
        await owner.call("post", "tenants/current/roles", {
          name: "Site labourer",
          permissions: ["portal.worker"],
        })
      ).body,
    ).role;
    const second = phone();
    await fresh(owner);
    expect(
      (
        await owner.call("post", "tenants/current/invitations", {
          identifier: second,
          role: plain.id,
          projectIds: [p1],
        })
      ).status,
    ).toBe(201);
    const labourer = await browser();
    const res = await labourer.call("post", "auth/pin/join", {
      identifier: second,
      token: lastText(second).match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1],
      displayName: "Chebet",
      pin: PIN,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await labourer.call("get", "portal/worker")).status).toBe(200);
    await fresh(owner);
    expect(
      (
        await owner.call("patch", `tenants/current/roles/${plain.id}`, {
          permissions: ["portal.worker", "projects.view", "bq.view"],
        })
      ).status,
    ).toBe(200);
    expect(code(await labourer.call("get", "projects"))).toBe("pin-session-limited");
    expect(code(await labourer.call("get", `projects/${p1}`))).toBe("pin-session-limited");
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
      (await outsider.call("post", "auth/pin/join", { ...joinBody, token: unknownToken() })).status,
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
