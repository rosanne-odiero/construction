import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity, digest } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { RedisService } from "../src/infra/redis.service.js";
import { SYSTEM_ROLE_PERMISSIONS } from "@pm-buddy/types";
import { membersResponseSchema, tenantsResponseSchema } from "@pm-buddy/validation";
import { Browser, notifications, origin, password, type AuthResponse } from "./support.js";

describe("Identity, tenancy and project permissions (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let ownerA: Browser;
  let ownerB: Browser;
  let client: Browser;
  let tenantA: string;
  let tenantB: string;
  let projectA: string;
  let projectB: string;
  let security: AuthSecurity;
  let realNotify: AuthSecurity["notify"];
  let notificationSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    db = app.get(TenantDatabase);
    security = app.get(AuthSecurity);
    realNotify = security.notify.bind(security);
    notificationSpy = vi
      .spyOn(security, "notify")
      .mockImplementation(async (identifier, subject, text) => {
        const previous = notifications.get(identifier) ?? [];
        notifications.set(identifier, [...previous, { subject, text }]);
      });
    ownerA = new Browser(app);
    ownerB = new Browser(app);
    client = new Browser(app);
    await ownerA.register();
    await ownerA.enroll();
    await ownerB.register();
    await ownerB.enroll();
    await client.register();
    const companyA = await ownerA.call("post", "tenants", { name: "Company A" });
    expect(companyA.status, JSON.stringify(companyA.body)).toBe(201);
    tenantA = (companyA.body as { tenant: { id: string } }).tenant.id;
    const companyB = await ownerB.call("post", "tenants", { name: "Company B" });
    expect(companyB.status, JSON.stringify(companyB.body)).toBe(201);
    tenantB = (companyB.body as { tenant: { id: string } }).tenant.id;
    const a = await ownerA.call("post", "projects", { name: "Site A" });
    const b = await ownerB.call("post", "projects", { name: "Site B" });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    projectA = (a.body as { project: { id: string } }).project.id;
    projectB = (b.body as { project: { id: string } }).project.id;
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("uses a non-owner, non-superuser role without BYPASSRLS", async () => {
    const [role] = await prisma.$queryRaw<
      { role: string; rolsuper: boolean; rolbypassrls: boolean; owner: string }[]
    >`
      SELECT current_user AS role, r.rolsuper, r.rolbypassrls, pg_get_userbyid(c.relowner) AS owner
      FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.relname='projects'`;
    expect(role).toMatchObject({
      role: "pmb_app",
      rolsuper: false,
      rolbypassrls: false,
      owner: "pmb_migrator",
    });
  });

  it("serves the shared tenant, member and sign-out response contracts", async () => {
    const tenants = await ownerA.call("get", "tenants");
    expect(tenants.status).toBe(200);
    expect(tenantsResponseSchema.parse(tenants.body).tenants).toEqual([
      {
        id: tenantA,
        name: "Company A",
        role: "owner",
        roleName: null,
        tenantWide: true,
        permissions: [...SYSTEM_ROLE_PERMISSIONS.owner],
      },
    ]);
    const members = await ownerA.call("get", "tenants/current/members");
    expect(members.status).toBe(200);
    expect(membersResponseSchema.parse(members.body).members[0]!.userId).toBe(ownerA.auth.user.id);
    const another = new Browser(app);
    another.identifier = client.identifier;
    await another.initialize();
    await another.login();
    expect((await another.call("post", "auth/logout", {})).status).toBe(200);
    expect((await another.call("get", "auth/me")).status).toBe(401);
  });

  it("enforces canonical shared permissions at the database boundary", async () => {
    for (const retired of ["project.read", "project.update"]) {
      await expect(
        db.run(
          {
            userId: ownerA.auth.user.id,
            tenantId: tenantA,
            requestId: "retired-permission-test",
          },
          (tx) =>
            tx.projectMembership.create({
              data: {
                tenantId: tenantA,
                projectId: projectA,
                userId: ownerA.auth.user.id,
                permissions: [retired],
              },
            }),
        ),
      ).rejects.toThrow();
    }
    await db.run(
      { userId: ownerA.auth.user.id, tenantId: tenantA, requestId: "canonical-permission-test" },
      async (tx) => {
        const created = await tx.projectMembership.create({
          data: {
            tenantId: tenantA,
            projectId: projectA,
            userId: ownerA.auth.user.id,
            permissions: ["projects.view", "projects.manage"],
          },
        });
        expect(created.permissions).toEqual(["projects.view", "projects.manage"]);
        await tx.projectMembership.delete({
          where: {
            tenantId_projectId_userId: {
              tenantId: tenantA,
              projectId: projectA,
              userId: ownerA.auth.user.id,
            },
          },
        });
      },
    );
  });

  it("forces RLS and policies on every tenant_id table discovered from the database", async () => {
    const tables = await prisma.$queryRaw<
      { table_name: string; enabled: boolean; forced: boolean; policies: bigint }[]
    >`
      SELECT c.relname AS table_name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
        (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id'
      )`;
    expect(tables.length).toBeGreaterThanOrEqual(7);
    for (const table of tables) {
      expect(table, table.table_name).toMatchObject({ enabled: true, forced: true });
      expect(table.policies).toBeGreaterThan(0n);
    }
  });

  it("fails closed without context on every tenant table", async () => {
    expect(() => db.current()).toThrow("Missing authenticated database context");
    expect(await prisma.tenant.findMany()).toEqual([]);
    expect(await prisma.membership.findMany()).toEqual([]);
    expect(await prisma.project.findMany()).toEqual([]);
    expect(await prisma.projectMembership.findMany()).toEqual([]);
    expect(await prisma.invitation.findMany()).toEqual([]);
    expect(await prisma.auditEvent.findMany()).toEqual([]);
    await expect(
      prisma.project.create({ data: { tenantId: tenantA, name: "Forbidden" } }),
    ).rejects.toThrow();
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='tenant_id'`;
    for (const { table_name } of tables) {
      expect(table_name).toMatch(/^[a-z_]+$/);
      const [row] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) FROM "${table_name}"`,
      );
      expect(row!.count, `${table_name} must fail closed`).toBe(0n);
    }
  });

  it("returns only selected tenant projects and does not trust body tenant IDs", async () => {
    const res = await ownerA.call("get", "projects");
    expect(res.status).toBe(200);
    expect((res.body as { projects: { id: string }[] }).projects.map((p) => p.id)).toEqual([
      projectA,
    ]);
    const forged = await ownerA.call("post", "projects", { name: "Forged", tenantId: tenantB });
    expect(forged.status).toBe(400);
    const invisible = await ownerA.call("patch", `projects/${projectB}`, { name: "No" });
    expect(invisible.status).toBe(404);
    expect((await ownerA.call("post", `tenants/${tenantB}/select`, {})).status).toBe(404);
  });

  it("rejects cross-tenant SQL reads, writes and composite references", async () => {
    await db.run(
      { userId: ownerA.auth.user.id, tenantId: tenantA, requestId: "rls-test" },
      async (tx) => {
        expect(await tx.project.findMany({ where: { tenantId: tenantB } })).toEqual([]);
        expect(
          await tx.project.updateMany({ where: { id: projectB }, data: { name: "No" } }),
        ).toEqual({ count: 0 });
      },
    );
    await expect(
      db.run({ userId: ownerA.auth.user.id, tenantId: tenantA, requestId: "rls-write" }, (tx) =>
        tx.project.create({ data: { tenantId: tenantB, name: "Cross" } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run({ userId: ownerA.auth.user.id, tenantId: tenantA, requestId: "fk-test" }, (tx) =>
        tx.projectMembership.create({
          data: {
            tenantId: tenantA,
            projectId: projectB,
            userId: ownerA.auth.user.id,
            permissions: ["projects.view"],
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(
        { userId: ownerA.auth.user.id, tenantId: tenantA, requestId: "invitation-fk-test" },
        async (tx) => {
          const invitation = await tx.invitation.create({
            data: {
              tenantId: tenantA,
              identifier: client.identifier,
              role: "client",
              createdBy: ownerA.auth.user.id,
              digest: digest(randomUUID()),
              expiresAt: new Date(Date.now() + 60_000),
            },
          });
          return tx.invitationProject.create({
            data: { tenantId: tenantA, invitationId: invitation.id, projectId: projectB },
          });
        },
      ),
    ).rejects.toThrow();
  });

  it("does not leak transaction-local tenant/user context after commit, rollback or concurrency", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const expected = index % 2 ? tenantA : tenantB;
        const userId = index % 2 ? ownerA.auth.user.id : ownerB.auth.user.id;
        return db.run(
          { userId, tenantId: expected, requestId: `parallel-${index}` },
          async (tx) => {
            expect(db.current().tenantId).toBe(expected);
            const projects = await tx.project.findMany();
            expect(projects.every((p) => p.tenantId === expected)).toBe(true);
            return projects.length;
          },
        );
      }),
    );
    expect(results.every((count) => count === 1)).toBe(true);
    await expect(
      db.run(
        { userId: ownerA.auth.user.id, tenantId: tenantA, requestId: "rollback" },
        async (tx) => {
          await tx.project.create({ data: { tenantId: tenantA, name: "Must roll back" } });
          throw new Error("Intentional rollback");
        },
      ),
    ).rejects.toThrow("Intentional rollback");
    const [context] = await prisma.$queryRaw<{ tenant: string | null; user_id: string | null }[]>`
      SELECT app.current_tenant_id()::text AS tenant, app.current_user_id()::text AS user_id`;
    expect(context).toEqual({ tenant: null, user_id: null });
    expect(await prisma.project.findMany()).toEqual([]);
  });

  it("requires signed CSRF, same Origin, and HttpOnly host-only cookies", async () => {
    expect((await ownerA.call("post", "projects", { name: "No" }, false)).status).toBe(403);
    const cookieHeader = [...ownerA.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    await request(app.getHttpServer())
      .post("/api/v1/projects")
      .set("Cookie", cookieHeader)
      .set("X-CSRF-Token", ownerA.csrf)
      .set("Origin", "https://evil.example")
      .send({ name: "No" })
      .expect(403);
    const res = await ownerA.call("get", "auth/csrf");
    const values = res.headers["set-cookie"] as unknown as string[];
    expect(values[0]).toContain("HttpOnly");
    expect(values[0]).toContain("SameSite=Lax");
    expect(values[0]).not.toContain("Domain=");
    const tampered = `${ownerA.csrf.slice(0, -3)}aaa`;
    await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .set("Cookie", `pmb_csrf=${tampered}`)
      .set("X-CSRF-Token", tampered)
      .set("Origin", origin)
      .send({ identifier: "csrf@example.test", password, displayName: "No" })
      .expect(403);
  });

  it("stores only Argon2id passwords and encrypted TOTP secrets", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ownerA.auth.user.id } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(user.passwordHash).not.toContain(password);
    expect(user.mfaSecret).not.toContain(ownerA.mfaSecret);
    expect(await security.decrypt(user.mfaSecret!, `totp:${user.id}`)).toBe(ownerA.mfaSecret);
    await expect(
      security.decrypt(user.mfaSecret!, `totp:${ownerB.auth.user.id}`),
    ).rejects.toThrow();
  });

  it("requires MFA to create a company and enforces MFA on privileged login", async () => {
    expect((await client.call("post", "tenants", { name: "No MFA" })).status).toBe(403);
    const another = new Browser(app);
    another.identifier = ownerA.identifier;
    await another.initialize();
    const res = await another.login();
    expect((res.body as AuthResponse).mfaRequired).toBe(true);
    expect((await another.call("get", "tenants")).status).toBe(403);
    expect((await another.call("get", "projects")).status).toBe(403);
  });

  it("rejects replayed TOTP codes, including concurrent submissions", async () => {
    const replay = await ownerA.call("post", "auth/mfa/step-up", { code: ownerA.enrollmentCode });
    expect(replay.status).toBe(401);
    const code = ownerA.code(30_000);
    const res = await ownerA.call("post", "auth/mfa/step-up", { code });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await ownerA.call("post", "auth/mfa/step-up", { code })).status).toBe(401);
  });

  it("makes recovery codes single use and rotates credentials", async () => {
    const code = ownerB.auth.recoveryCodes![0]!;
    const previousAccess = ownerB.cookies.get("pmb_at");
    const res = await ownerB.call("post", "auth/mfa/recover", { code });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ownerB.cookies.get("pmb_at")).not.toBe(previousAccess);
    expect((await ownerB.call("post", "auth/mfa/recover", { code })).status).toBe(401);
  });

  it("allows only one concurrent use of a TOTP counter", async () => {
    const code = ownerB.code(30_000);
    const responses = await Promise.all([
      ownerB.call("post", "auth/mfa/step-up", { code }),
      ownerB.call("post", "auth/mfa/step-up", { code }),
    ]);
    expect(responses.map((res) => res.status).sort((a, b) => a - b)).toEqual([200, 401]);
  });

  it("rotates refresh tokens and revokes the family on replay", async () => {
    const browser = new Browser(app);
    browser.identifier = client.identifier;
    await browser.initialize();
    await browser.login();
    const old = browser.cookies.get("pmb_rt")!;
    const oldAccess = browser.cookies.get("pmb_at")!;
    const refreshed = await browser.call("post", "auth/refresh", {});
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(browser.cookies.get("pmb_rt")).not.toBe(old);
    const rotated = browser.cookies.get("pmb_at")!;
    const persisted = await prisma.refreshToken.findUniqueOrThrow({
      where: { digest: digest(old) },
    });
    expect(persisted.usedAt).not.toBeNull();
    await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Cookie", `pmb_at=${oldAccess}`)
      .expect(401);
    browser.cookies.set("pmb_rt", old);
    expect((await browser.call("post", "auth/refresh", {})).status).toBe(401);
    await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Cookie", `pmb_at=${rotated}`)
      .expect(401);
  });

  it("lists and revokes only the caller's sessions", async () => {
    const listing = await client.call("get", "auth/sessions");
    expect(listing.status).toBe(200);
    const sessions = (listing.body as { sessions: { id: string; current: boolean }[] }).sessions;
    expect(sessions.some((session) => session.current)).toBe(true);
    expect(sessions.some((session) => session.id === ownerA.auth.session.id)).toBe(false);
    expect((await client.call("delete", `auth/sessions/${ownerA.auth.session.id}`)).status).toBe(
      404,
    );
    const another = new Browser(app);
    another.identifier = client.identifier;
    await another.initialize();
    await another.login();
    expect((await client.call("delete", `auth/sessions/${another.auth.session.id}`)).status).toBe(
      200,
    );
    expect((await another.call("get", "auth/me")).status).toBe(401);
  });

  it("accepts only recipient-bound, unexpired, single-use invitations and scopes project permissions", async () => {
    const invite = await ownerA.call("post", "tenants/current/invitations", {
      identifier: client.identifier,
      role: "client",
      projectIds: [projectA],
    });
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);
    expect(invite.body).not.toHaveProperty("token");
    const text = notifications.get(client.identifier)?.at(-1)?.text;
    const token = text?.match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toHaveLength(43);
    expect((await ownerB.call("post", "tenants/invitations/accept", { token })).status).toBe(404);
    expect((await client.call("post", "tenants/invitations/accept", { token })).status).toBe(200);
    expect((await client.call("post", "tenants/invitations/accept", { token })).status).toBe(404);
    const selected = await client.call("post", `tenants/${tenantA}/select`, {});
    expect(selected.status, JSON.stringify(selected.body)).toBe(200);
    expect((selected.body as AuthResponse).session.tenantId).toBe(tenantA);
    const list = await client.call("get", "projects");
    expect(
      (list.body as { projects: { id: string }[] }).projects.map((project) => project.id),
    ).toEqual([projectA]);
    expect((await client.call("post", "projects", { name: "Denied" })).status).toBe(403);
    expect((await client.call("patch", `projects/${projectA}`, { name: "Denied" })).status).toBe(
      403,
    );
    expect((await client.call("get", "tenants/current/members")).status).toBe(403);
    expect(
      (
        await ownerA.call("put", `projects/${projectA}/members/${client.auth.user.id}`, {
          permissions: ["projects.view", "projects.manage"],
        })
      ).status,
    ).toBe(200);
    // Effective project permissions are role ∩ assignment: a client's role has no
    // projects.manage, so the assignment cannot widen it (the positive path is in roles.e2e-spec).
    expect(
      (await client.call("patch", `projects/${projectA}`, { name: "Denied edit" })).status,
    ).toBe(403);
    expect(
      (await client.call("patch", `projects/${projectB}`, { name: "Other tenant" })).status,
    ).toBe(404);
    expect(
      (
        await ownerA.call("put", `projects/${projectA}/members/${client.auth.user.id}`, {
          permissions: [],
        })
      ).status,
    ).toBe(200);
    const empty = await client.call("get", "projects");
    expect((empty.body as { projects: unknown[] }).projects).toEqual([]);
  });

  it("rejects privileged role acceptance without enrolled and verified MFA", async () => {
    const target = new Browser(app);
    await target.register();
    const res = await ownerA.call("post", "tenants/current/invitations", {
      identifier: target.identifier,
      role: "finance",
    });
    expect(res.status).toBe(201);
    const token = notifications
      .get(target.identifier)
      ?.at(-1)
      ?.text.match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
    expect((await target.call("post", "tenants/invitations/accept", { token })).status).toBe(403);
    await target.enroll();
    expect((await target.call("post", "tenants/invitations/accept", { token })).status).toBe(200);
  });

  it("rejects expired invitations", async () => {
    const target = new Browser(app);
    await target.register();
    const res = await ownerA.call("post", "tenants/current/invitations", {
      identifier: target.identifier,
      role: "client",
    });
    expect(res.status).toBe(201);
    const id = (res.body as { invitation: { id: string } }).invitation.id;
    const token = notifications
      .get(target.identifier)
      ?.at(-1)
      ?.text.match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
    await db.run(
      { userId: ownerA.auth.user.id, tenantId: tenantA, requestId: "expire-invite" },
      (tx) =>
        tx.invitation.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1) } }),
    );
    expect((await target.call("post", "tenants/invitations/accept", { token })).status).toBe(404);
  });

  it("removes members, revokes active tenant sessions and preserves the last owner", async () => {
    expect(
      (await ownerA.call("delete", `tenants/current/members/${ownerA.auth.user.id}`)).status,
    ).toBe(409);
    expect(
      (await ownerA.call("delete", `tenants/current/members/${client.auth.user.id}`)).status,
    ).toBe(200);
    expect((await client.call("get", "projects")).status).toBe(401);
    const remaining = await db.run(
      { userId: ownerA.auth.user.id, tenantId: tenantA, requestId: "removed-test" },
      (tx) => tx.projectMembership.count({ where: { userId: client.auth.user.id } }),
    );
    expect(remaining).toBe(0);
  });

  it("produces hash-chained append-only audited changes", async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        db.run(
          {
            userId: ownerA.auth.user.id,
            tenantId: tenantA,
            requestId: `audit-concurrent-${index}`,
          },
          (tx) =>
            tx.auditEvent.create({
              data: {
                tenantId: tenantA,
                actorId: ownerA.auth.user.id,
                action: "integration.concurrent",
                resourceId: randomUUID(),
                requestId: `audit-concurrent-${index}`,
                metadata: { index },
              },
            }),
        ),
      ),
    );
    const response = await ownerA.call("get", "tenants/current/audit");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const events = (
      response.body as { events: { hash: string; previousHash: string; action: string }[] }
    ).events.reverse();
    expect(events.length).toBeGreaterThan(5);
    expect(events[0]!.previousHash).toBe("0".repeat(64));
    for (let i = 0; i < events.length; i++) {
      expect(events[i]!.hash).toMatch(/^[a-f0-9]{64}$/);
      if (i) expect(events[i]!.previousHash).toBe(events[i - 1]!.hash);
    }
    expect(events.map((event) => event.action)).toContain("membership.removed");
    const [integrity] = await db.run(
      { userId: ownerA.auth.user.id, tenantId: tenantA, requestId: "audit-integrity" },
      (tx) => tx.$queryRaw<{ invalid: bigint }[]>`
        SELECT count(*) AS invalid FROM audit_events a WHERE a.hash <> encode(digest(convert_to(
          jsonb_build_object(
            'id', a.id, 'tenant_id', a.tenant_id, 'actor_id', a.actor_id, 'action', a.action,
            'resource_id', a.resource_id, 'request_id', a.request_id, 'metadata', a.metadata,
            'created_at', a.created_at, 'sequence', a.sequence, 'previous_hash', a.previous_hash
          )::text, 'UTF8'), 'sha256'), 'hex')`,
    );
    expect(integrity!.invalid).toBe(0n);
    await expect(
      db.run(
        { userId: ownerA.auth.user.id, tenantId: tenantA, requestId: "audit-mutation" },
        (tx) => tx.auditEvent.updateMany({ data: { action: "forged" } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run({ userId: ownerA.auth.user.id, tenantId: tenantA, requestId: "audit-delete" }, (tx) =>
        tx.auditEvent.deleteMany(),
      ),
    ).rejects.toThrow();
    await expect(prisma.$executeRaw`TRUNCATE TABLE audit_events`).rejects.toThrow();
  });

  it("locks an account after five failed passwords without exposing account existence", async () => {
    const target = new Browser(app);
    await target.register();
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await target.call("post", "auth/login", {
            identifier: target.identifier,
            password: "Wrong password 123",
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (await target.call("post", "auth/login", { identifier: target.identifier, password })).status,
    ).toBe(401);
    const user = await prisma.user.findUniqueOrThrow({ where: { identifier: target.identifier } });
    expect(user.failedLogins).toBe(5);
    expect(user.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("supports phone-first verification, denies unverified login and consumes verification codes only once", async () => {
    const target = new Browser(app);
    target.identifier = `2547${String(Date.now()).slice(-8)}`;
    await target.initialize();
    const res = await target.call("post", "auth/register", {
      identifier: target.identifier,
      password,
      displayName: "Phone-first user",
    });
    expect(res.status).toBe(201);
    expect(
      (await target.call("post", "auth/login", { identifier: target.identifier, password })).status,
    ).toBe(401);
    const code = notifications
      .get(target.identifier)
      ?.at(-1)
      ?.text.match(/Verification code: (\d{6})/)?.[1];
    expect(
      (await target.call("post", "auth/verify", { identifier: target.identifier, code, password }))
        .status,
    ).toBe(200);
    expect(
      (await target.call("post", "auth/verify", { identifier: target.identifier, code, password }))
        .status,
    ).toBe(401);
    expect(
      (await target.call("post", "auth/login", { identifier: `+${target.identifier}`, password }))
        .status,
    ).toBe(200);
  });

  it("caps verification attempts and rejects expired verification credentials", async () => {
    const target = new Browser(app);
    await target.initialize();
    expect(
      (
        await target.call("post", "auth/register", {
          identifier: target.identifier,
          password,
          displayName: "Verification failure user",
        })
      ).status,
    ).toBe(201);
    const code = notifications
      .get(target.identifier)
      ?.at(-1)
      ?.text.match(/Verification code: (\d{6})/)?.[1];
    const wrong = code === "000000" ? "999999" : "000000";
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await target.call("post", "auth/verify", {
            identifier: target.identifier,
            code: wrong,
            password,
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (await target.call("post", "auth/verify", { identifier: target.identifier, code, password }))
        .status,
    ).toBe(401);
    expect(
      (await target.call("post", "auth/verification/resend", { identifier: target.identifier }))
        .status,
    ).toBe(200);
    const newCode = notifications
      .get(target.identifier)
      ?.at(-1)
      ?.text.match(/Verification code: (\d{6})/)?.[1];
    const user = await prisma.user.findUniqueOrThrow({ where: { identifier: target.identifier } });
    await prisma.authChallenge.updateMany({
      where: { userId: user.id, purpose: "verify", consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expect(
      (
        await target.call("post", "auth/verify", {
          identifier: target.identifier,
          code: newCode,
          password,
        })
      ).status,
    ).toBe(401);
  });

  it("rejects expired sessions and stale MFA for sensitive tenant actions", async () => {
    const target = new Browser(app);
    await target.register();
    await target.enroll();
    await prisma.session.update({
      where: { id: target.auth.session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) },
    });
    expect((await target.call("post", "tenants", { name: "Stale MFA" })).status).toBe(403);
    await prisma.session.update({
      where: { id: target.auth.session.id },
      data: { idleExpiresAt: new Date(Date.now() - 1) },
    });
    expect((await target.call("get", "auth/me")).status).toBe(401);
    expect((await target.call("post", "auth/refresh", {})).status).toBe(401);
  });

  it("resets passwords with single-use tokens and revokes every existing session", async () => {
    const target = new Browser(app);
    await target.register();
    const res = await target.call("post", "auth/password/forgot", {
      identifier: target.identifier,
    });
    expect(res.status).toBe(200);
    const token = notifications
      .get(target.identifier)
      ?.at(-1)
      ?.text.match(/Password reset token: ([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toHaveLength(43);
    const nextPassword = "Changed construction foundation! 441";
    expect(
      (await target.call("post", "auth/password/reset", { token, password: nextPassword })).status,
    ).toBe(200);
    expect((await target.call("get", "auth/me")).status).toBe(401);
    expect(
      (await target.call("post", "auth/password/reset", { token, password: nextPassword })).status,
    ).toBe(401);
    expect(
      (
        await target.call("post", "auth/login", {
          identifier: target.identifier,
          password: nextPassword,
        })
      ).status,
    ).toBe(200);
  });

  it("rate-limits atomically in Valkey and fails explicitly when the dependency is unavailable", async () => {
    const key = `integration:${randomUUID()}`;
    await security.limit(key, 1, 60);
    await expect(security.limit(key, 1, 60)).rejects.toMatchObject({ status: 429 });
    const redis = app.get(RedisService);
    const spy = vi.spyOn(redis, "ping").mockRejectedValueOnce(new Error("offline"));
    await expect(security.limit(`outage:${randomUUID()}`, 1, 60)).rejects.toMatchObject({
      status: 503,
    });
    spy.mockRestore();
  });

  it("registers, verifies and logs in through the real loopback Mailpit development transport", async () => {
    const target = new Browser(app);
    await target.initialize();
    notificationSpy.mockImplementationOnce(realNotify);
    const registered = await target.call("post", "auth/register", {
      identifier: target.identifier,
      password,
      displayName: "Real local notification test",
    });
    expect(registered.status).toBe(201);
    // Delivery happens after the response (notifyLater), so wait for the message to arrive.
    let result: { messages: { ID: string; Subject: string }[] } = { messages: [] };
    for (let attempt = 0; attempt < 50 && result.messages.length === 0; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 100));
      const response = await fetch(
        `http://localhost:8025/api/v1/search?query=${encodeURIComponent(target.identifier)}`,
      );
      expect(response.ok).toBe(true);
      result = (await response.json()) as typeof result;
    }
    expect(result.messages[0]!.Subject).toContain("[DEVELOPMENT ONLY]");
    const delivered = await fetch(`http://localhost:8025/api/v1/message/${result.messages[0]!.ID}`);
    const message = (await delivered.json()) as { Text: string };
    const code = message.Text.match(/Verification code: (\d{6})/)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    expect(
      (await target.call("post", "auth/verify", { identifier: target.identifier, code, password }))
        .status,
    ).toBe(200);
    await target.login();
  });

  it("prevents account pre-hijacking: verifying needs the latest registration's password", async () => {
    const attacker = new Browser(app);
    const victim = new Browser(app);
    victim.identifier = attacker.identifier;
    const attackerPassword = "Attacker controlled password 4471";
    await attacker.initialize();
    await victim.initialize();
    expect(
      (
        await attacker.call("post", "auth/register", {
          identifier: attacker.identifier,
          password: attackerPassword,
          displayName: "Squatter",
        })
      ).status,
    ).toBe(201);
    const attackerCode = notifications
      .get(attacker.identifier)!
      .at(-1)!
      .text.match(/(\d{6})/)![1];
    expect(
      (
        await victim.call("post", "auth/register", {
          identifier: victim.identifier,
          password,
          displayName: "Real owner",
        })
      ).status,
    ).toBe(201);
    const code = notifications
      .get(victim.identifier)!
      .at(-1)!
      .text.match(/(\d{6})/)![1];
    const identifier = victim.identifier;
    // The squatter's earlier code is invalidated, and the victim's code alone isn't enough.
    expect(
      (
        await attacker.call("post", "auth/verify", {
          identifier,
          code: attackerCode,
          password: attackerPassword,
        })
      ).status,
    ).toBe(401);
    expect(
      (await attacker.call("post", "auth/verify", { identifier, code, password: attackerPassword }))
        .status,
    ).toBe(401);
    expect((await victim.call("post", "auth/verify", { identifier, code, password })).status).toBe(
      200,
    );
    expect(
      (await attacker.call("post", "auth/login", { identifier, password: attackerPassword }))
        .status,
    ).toBe(401);
    await victim.login();
  });

  it("answers registration the same way whether or not the account exists, even if delivery fails", async () => {
    const visitor = new Browser(app);
    await visitor.initialize();
    const register = (identifier: string) =>
      visitor.call("post", "auth/register", { identifier, password, displayName: "Probe" });
    const fresh = await register(`${randomUUID()}@example.test`);
    const existing = await register(ownerA.identifier);
    expect([fresh.status, existing.status]).toEqual([201, 201]);
    expect(existing.body).toEqual(fresh.body);
    expect(notifications.get(ownerA.identifier)!.at(-1)!.subject).toBe("Registration attempt");
    notificationSpy.mockRejectedValueOnce(new Error("provider down"));
    const failedDelivery = await register(`${randomUUID()}@example.test`);
    expect(failedDelivery.status).toBe(201);
    expect(failedDelivery.body).toEqual(fresh.body);
  });

  it("signs out with only the refresh cookie once the access token has expired", async () => {
    const user = new Browser(app);
    await user.register();
    const sessionId = user.auth.session.id;
    user.cookies.delete("pmb_at");
    const res = await user.call("post", "auth/logout", {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(user.cookies.get("pmb_rt")).toBe("");
    const session = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.revokedAt).not.toBeNull();
    // Even with no credentials at all, sign-out succeeds and clears cookies.
    const anonymous = new Browser(app);
    await anonymous.initialize();
    expect((await anonymous.call("post", "auth/logout", {})).status).toBe(200);
  });

  it("locks two-step verification after five wrong codes and revokes the session", async () => {
    const user = new Browser(app);
    await user.register();
    await user.enroll();
    const wrong = () => user.call("post", "auth/mfa/step-up", { code: user.code(15 * 60_000) });
    for (let attempt = 1; attempt <= 4; attempt += 1) expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(429);
    expect(notifications.get(user.identifier)!.at(-1)!.subject).toBe(
      "Two-step verification locked",
    );
    expect((await user.call("get", "auth/me")).status).toBe(401);
    await user.initialize(); // locking signs the user out, which also clears the CSRF cookie
    await user.login();
    const locked = await user.call("post", "auth/mfa/step-up", { code: user.code(30_000) });
    expect(locked.status).toBe(429);
    await prisma.user.update({
      where: { identifier: user.identifier },
      data: { mfaLockedUntil: new Date(Date.now() - 1000) },
    });
    // The locked attempt was rejected before the code was checked, so the code is still unused.
    const unlocked = await user.call("post", "auth/mfa/step-up", { code: user.code(30_000) });
    expect(unlocked.status, JSON.stringify(unlocked.body)).toBe(200);
  });

  it("rate-limits by account rather than one shared IP when no trusted proxy is configured", async () => {
    const visitor = new Browser(app);
    await visitor.initialize();
    // Behind the web app's /api rewrite every request has the same source address. Before the fix,
    // 41 sign-ins a minute from that address blocked sign-in for everyone.
    const statuses = await Promise.all(
      Array.from({ length: 45 }, () =>
        visitor
          .call("post", "auth/login", { identifier: `${randomUUID()}@example.test`, password })
          .then((res) => res.status),
      ),
    );
    expect(statuses.every((status) => status === 401)).toBe(true);
    const target = `${randomUUID()}@example.test`;
    const attempts: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      attempts.push(
        (await visitor.call("post", "auth/login", { identifier: target, password })).status,
      );
    }
    expect(attempts.at(-1)).toBe(429);
  });
});
