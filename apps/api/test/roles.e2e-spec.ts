import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MFA_REQUIRED_PERMISSIONS,
  MFA_REQUIRED_ROLES,
  PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  TENANT_PERMISSIONS,
  TENANT_SYSTEM_ROLES,
  type Permission,
} from "@pm-buddy/types";
import {
  auditEventsResponseSchema,
  membersResponseSchema,
  permissionCatalogueResponseSchema,
  roleResponseSchema,
  rolesResponseSchema,
  tenantsResponseSchema,
  type Role,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity, digest } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { Browser, notifications } from "./support.js";

describe("Roles and permissions (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let ownerB: Browser;
  let admin: Browser;
  let clerk: Browser;
  let tenantA: string;
  let tenantB: string;
  let projectOne: string;
  let projectTwo: string;
  let siteClerk: string;
  let teamAdmin: string;
  let paymentsClerk: string;
  let notificationSpy: ReturnType<typeof vi.spyOn>;

  const as = (browser: Browser, tenantId: string, requestId: string) => ({
    userId: browser.auth.user.id,
    tenantId,
    requestId,
  });
  /** Simulates a step-up within the last five minutes without spending TOTP counters. */
  const fresh = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
  const roles = async (browser: Browser) => {
    const res = await browser.call("get", "tenants/current/roles");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return rolesResponseSchema.parse(res.body).roles;
  };
  const createRole = async (
    browser: Browser,
    body: { name: string; permissions: string[]; tenantWide?: boolean },
  ) => {
    const res = await browser.call("post", "tenants/current/roles", body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return roleResponseSchema.parse(res.body).role;
  };
  /** Invites `member` with `role`, then the member accepts the emailed token. */
  const join = async (
    inviter: Browser,
    member: Browser,
    role: string,
    projectIds: string[] = [],
  ) => {
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
    expect(token).toHaveLength(43);
    return member.call("post", "tenants/invitations/accept", { token });
  };
  const select = async (member: Browser, tenantId: string) => {
    const res = await member.call("post", `tenants/${tenantId}/select`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };
  const auditActions = async () => {
    await fresh(owner);
    const res = await owner.call("get", "tenants/current/audit");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return auditEventsResponseSchema.parse(res.body).events;
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
    owner = new Browser(app);
    ownerB = new Browser(app);
    await owner.register();
    await owner.enroll();
    await ownerB.register();
    await ownerB.enroll();
    const a = await owner.call("post", "tenants", { name: "Roles company A" });
    const b = await ownerB.call("post", "tenants", { name: "Roles company B" });
    expect([a.status, b.status]).toEqual([201, 201]);
    tenantA = (a.body as { tenant: { id: string } }).tenant.id;
    tenantB = (b.body as { tenant: { id: string } }).tenant.id;
    const one = await owner.call("post", "projects", { name: "Roles site one" });
    const two = await owner.call("post", "projects", { name: "Roles site two" });
    expect([one.status, two.status]).toEqual([201, 201]);
    projectOne = (one.body as { project: { id: string } }).project.id;
    projectTwo = (two.body as { project: { id: string } }).project.id;
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("serves the permission catalogue grouped by area to signed-in users only", async () => {
    const res = await owner.call("get", "permissions");
    expect(res.status).toBe(200);
    const catalogue = permissionCatalogueResponseSchema.parse(res.body);
    expect(catalogue.areas.map((area) => area.area)).toContain("payments");
    expect(catalogue.areas.flatMap((area) => area.permissions.map((entry) => entry.key))).toEqual([
      ...PERMISSIONS,
    ]);
    const visitor = new Browser(app);
    await visitor.initialize();
    expect((await visitor.call("get", "permissions")).status).toBe(401);
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "listPermissions",
      "listRoles",
      "createRole",
      "updateRole",
      "deleteRole",
      "changeMemberRole",
    ])
      expect(operations, id).toContain(id);
  });

  it("lists the immutable system roles with their default permissions", async () => {
    const listed = await roles(owner);
    const system = listed.filter((role) => role.kind === "system");
    expect(system.map((role) => role.id)).toEqual([...TENANT_SYSTEM_ROLES]);
    for (const role of system) {
      expect(role.permissions, role.id).toEqual([
        ...SYSTEM_ROLE_PERMISSIONS[role.id as keyof typeof SYSTEM_ROLE_PERMISSIONS],
      ]);
      expect(role.mfaRequired, role.id).toBe(MFA_REQUIRED_ROLES.includes(role.id));
      expect(role.assignable, role.id).toBe(true);
    }
    expect(system.find((role) => role.id === "owner")?.memberCount).toBe(1);
    expect(listed.some((role) => (role.id as string) === "platform_admin")).toBe(false);
    expect(
      (await owner.call("patch", "tenants/current/roles/owner", { name: "Boss" })).status,
    ).toBe(403);
    expect((await owner.call("delete", "tenants/current/roles/project_manager")).status).toBe(403);
    expect(
      (await owner.call("patch", "tenants/current/roles/platform_admin", { name: "Root" })).status,
    ).toBe(400);
  });

  it("creates, renames, changes and deletes custom roles with fresh step-up MFA and audit", async () => {
    await prisma.session.update({
      where: { id: owner.auth.session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) },
    });
    const stale = await owner.call("post", "tenants/current/roles", {
      name: "Site clerk",
      permissions: ["projects.view"],
    });
    expect(stale.status).toBe(403);
    const stepUp = await owner.call("post", "auth/mfa/step-up", { code: owner.code(30_000) });
    expect(stepUp.status, JSON.stringify(stepUp.body)).toBe(200);

    const clerkRole = await createRole(owner, {
      name: "Site clerk",
      permissions: ["projects.view", "bq.view"],
    });
    expect(clerkRole).toMatchObject({
      kind: "custom",
      name: "Site clerk",
      permissions: ["bq.view", "projects.view"],
      tenantWide: false,
      mfaRequired: false,
      memberCount: 0,
      assignable: true,
    });
    siteClerk = clerkRole.id;
    const duplicate = await owner.call("post", "tenants/current/roles", {
      name: "site CLERK",
      permissions: ["projects.view"],
    });
    expect(duplicate.status).toBe(409);

    const temporary = await createRole(owner, {
      name: "Temporary role",
      permissions: ["reports.view"],
    });
    const changed = await owner.call("patch", `tenants/current/roles/${temporary.id}`, {
      name: "Short-lived role",
      permissions: ["reports.view", "documents.manage"],
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(roleResponseSchema.parse(changed.body).role).toMatchObject({
      name: "Short-lived role",
      permissions: ["documents.manage", "reports.view"],
    });
    expect((await owner.call("patch", `tenants/current/roles/${temporary.id}`, {})).status).toBe(
      400,
    );
    expect(
      (await owner.call("patch", `tenants/current/roles/${temporary.id}`, { name: "Site Clerk" }))
        .status,
    ).toBe(409);
    expect((await owner.call("delete", `tenants/current/roles/${temporary.id}`)).status).toBe(200);
    expect((await roles(owner)).some((role) => role.id === temporary.id)).toBe(false);
    expect(
      (await owner.call("patch", `tenants/current/roles/${temporary.id}`, { name: "Gone" })).status,
    ).toBe(404);

    const events = await auditActions();
    const forRole = events.filter((event) => event.resourceId === temporary.id);
    expect(forRole.map((event) => event.action)).toEqual([
      "role.deleted",
      "role.updated",
      "role.created",
    ]);
    expect(forRole[1]!.metadata).toMatchObject({
      name: "Short-lived role",
      added: ["documents.manage"],
      removed: [],
    });
  });

  it("never lets a company grant platform.admin", async () => {
    for (const body of [
      { name: "Platform helper", permissions: ["platform.admin"] },
      { name: "Platform helper", permissions: ["projects.view", "platform.admin"] },
    ])
      expect((await owner.call("post", "tenants/current/roles", body)).status).toBe(400);
    expect(
      (
        await owner.call("patch", `tenants/current/roles/${siteClerk}`, {
          permissions: ["projects.view", "platform.admin"],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await owner.call("put", `tenants/current/members/${owner.auth.user.id}/role`, {
          role: "platform_admin",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await owner.call("post", "tenants/current/invitations", {
          identifier: "platform-helper@example.test",
          role: "platform_admin",
        })
      ).status,
    ).toBe(400);
    // The database refuses too, under the runtime role, whatever the API does.
    for (const permissions of [["platform.admin"], ["projects.view", "payments.steal"], []])
      await expect(
        db.run(as(owner, tenantA, "platform-permission"), (tx) =>
          tx.tenantRole.create({
            data: {
              tenantId: tenantA,
              name: "Direct insert",
              permissions,
              createdBy: owner.auth.user.id,
            },
          }),
        ),
      ).rejects.toThrow();
    await expect(
      db.run(as(owner, tenantA, "reserved-name"), (tx) =>
        tx.tenantRole.create({
          data: {
            tenantId: tenantA,
            name: "OWNER",
            permissions: ["projects.view"],
            createdBy: owner.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();
    // Every other catalogue permission is accepted by the API and the database constraint.
    const deputy = await createRole(owner, {
      name: "Full deputy",
      permissions: [...TENANT_PERMISSIONS],
      tenantWide: true,
    });
    expect(deputy.permissions).toEqual([...TENANT_PERMISSIONS].sort());
    expect(deputy.mfaRequired).toBe(true);
    expect((await owner.call("delete", `tenants/current/roles/${deputy.id}`)).status).toBe(200);
  });

  it("rejects privilege escalation by a delegated role manager", async () => {
    teamAdmin = (
      await createRole(owner, {
        name: "Team admin",
        permissions: ["roles.manage", "users.invite", "projects.view", "bq.view"],
      })
    ).id;
    paymentsClerk = (
      await createRole(owner, {
        name: "Payments clerk",
        permissions: ["projects.view", "payments.approve"],
      })
    ).id;
    admin = new Browser(app);
    await admin.register();
    await admin.enroll();
    expect((await join(owner, admin, teamAdmin)).status).toBe(200);
    await select(admin, tenantA);
    const companies = tenantsResponseSchema.parse((await admin.call("get", "tenants")).body);
    expect(companies.tenants).toEqual([
      {
        id: tenantA,
        name: "Roles company A",
        role: teamAdmin,
        roleName: "Team admin",
        tenantWide: false,
        permissions: ["bq.view", "projects.view", "roles.manage", "users.invite"],
      },
    ]);

    const attempt = (body: object) => admin.call("post", "tenants/current/roles", body);
    expect((await attempt({ name: "Approver", permissions: ["payments.approve"] })).status).toBe(
      403,
    );
    expect(
      (await attempt({ name: "Everywhere", permissions: ["projects.view"], tenantWide: true }))
        .status,
    ).toBe(403);
    const copy = await attempt({ name: "Clerk copy", permissions: ["projects.view", "bq.view"] });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    expect(
      (await admin.call("patch", `tenants/current/roles/${paymentsClerk}`, { name: "Renamed" }))
        .status,
    ).toBe(403);
    expect((await admin.call("delete", `tenants/current/roles/${paymentsClerk}`)).status).toBe(403);
    expect(
      (
        await admin.call("patch", `tenants/current/roles/${teamAdmin}`, {
          permissions: ["roles.manage", "users.invite", "projects.view", "payments.approve"],
        })
      ).status,
    ).toBe(403);
    const changeRole = (userId: string, role: string) =>
      admin.call("put", `tenants/current/members/${userId}/role`, { role });
    expect((await changeRole(owner.auth.user.id, "project_manager")).status).toBe(403);
    expect((await changeRole(admin.auth.user.id, "owner")).status).toBe(403);
    expect((await changeRole(admin.auth.user.id, paymentsClerk)).status).toBe(403);
    expect(
      (await admin.call("delete", `tenants/current/members/${owner.auth.user.id}`)).status,
    ).toBe(403);
    for (const role of ["finance", "owner", paymentsClerk])
      expect(
        (
          await admin.call("post", "tenants/current/invitations", {
            identifier: "escalation-target@example.test",
            role,
          })
        ).status,
        role,
      ).toBe(403);
    const visible = await roles(admin);
    const assignable = (id: string) => visible.find((role) => role.id === id)?.assignable;
    expect([assignable("owner"), assignable(paymentsClerk), assignable(siteClerk)]).toEqual([
      false,
      false,
      true,
    ]);
    // Nothing was changed by the rejected attempts.
    const members = membersResponseSchema.parse(
      (await owner.call("get", "tenants/current/members")).body,
    ).members;
    expect(members.find((member) => member.userId === owner.auth.user.id)?.role).toBe("owner");
    expect(members.find((member) => member.userId === admin.auth.user.id)).toMatchObject({
      role: teamAdmin,
      roleName: "Team admin",
    });
  });

  it("isolates custom roles between companies with RLS and composite tenant keys", async () => {
    await fresh(ownerB);
    expect((await roles(ownerB)).filter((role) => role.kind === "custom")).toEqual([]);
    expect(
      (await ownerB.call("patch", `tenants/current/roles/${siteClerk}`, { name: "Stolen" })).status,
    ).toBe(404);
    expect((await ownerB.call("delete", `tenants/current/roles/${siteClerk}`)).status).toBe(404);
    expect(
      (
        await ownerB.call("put", `tenants/current/members/${ownerB.auth.user.id}/role`, {
          role: siteClerk,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await ownerB.call("post", "tenants/current/invitations", {
          identifier: "cross-tenant@example.test",
          role: siteClerk,
        })
      ).status,
    ).toBe(404);

    await db.run(as(ownerB, tenantB, "role-rls-read"), async (tx) => {
      expect(await tx.tenantRole.findMany({ where: { tenantId: tenantA } })).toEqual([]);
      expect(await tx.tenantRole.findUnique({ where: { id: siteClerk } })).toBeNull();
      expect(
        await tx.tenantRole.updateMany({ where: { id: siteClerk }, data: { name: "Stolen" } }),
      ).toEqual({ count: 0 });
      expect(await tx.tenantRole.deleteMany({ where: { id: siteClerk } })).toEqual({ count: 0 });
    });
    await expect(
      db.run(as(ownerB, tenantB, "role-rls-write"), (tx) =>
        tx.tenantRole.create({
          data: {
            tenantId: tenantA,
            name: "Planted role",
            permissions: ["projects.view"],
            createdBy: ownerB.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();
    // Composite (tenant_id, custom_role_id) keys: company B rows cannot name company A's role.
    await expect(
      db.run(as(ownerB, tenantB, "role-fk-invitation"), (tx) =>
        tx.invitation.create({
          data: {
            tenantId: tenantB,
            identifier: "cross-tenant@example.test",
            role: "custom",
            customRoleId: siteClerk,
            createdBy: ownerB.auth.user.id,
            digest: digest(randomUUID()),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(as(ownerB, tenantB, "role-fk-membership"), (tx) =>
        tx.membership.update({
          where: { tenantId_userId: { tenantId: tenantB, userId: ownerB.auth.user.id } },
          data: { role: "custom", customRoleId: siteClerk },
        }),
      ),
    ).rejects.toThrow();
    const keys = await prisma.$queryRaw<{ name: string; columns: string[] }[]>`
      SELECT c.conname AS name, array_agg(a.attname ORDER BY k.ordinality)::text[] AS columns
      FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype = 'f' AND c.confrelid = 'tenant_roles'::regclass
      GROUP BY c.conname ORDER BY c.conname`;
    expect(keys).toEqual([
      {
        name: "invitations_tenant_id_custom_role_id_fkey",
        columns: ["tenant_id", "custom_role_id"],
      },
      {
        name: "memberships_tenant_id_custom_role_id_fkey",
        columns: ["tenant_id", "custom_role_id"],
      },
    ]);
    // No context: nothing. Before selecting a company: only the custom role the user holds.
    expect(await prisma.tenantRole.findMany()).toEqual([]);
    const own = await db.run(
      { userId: admin.auth.user.id, tenantId: null, requestId: "own" },
      (tx) => tx.tenantRole.findMany({ select: { id: true } }),
    );
    expect(own).toEqual([{ id: teamAdmin }]);
  });

  it("makes MFA mandatory for anyone holding a privileged permission", async () => {
    for (const permission of PERMISSIONS) {
      const [row] = await prisma.$queryRaw<{ required: boolean }[]>`
        SELECT app.permissions_require_mfa(ARRAY[${permission}]::text[]) AS required`;
      expect(row!.required, permission).toBe(
        (MFA_REQUIRED_PERMISSIONS as readonly Permission[]).includes(permission),
      );
    }
    for (const role of SYSTEM_ROLES) {
      const [row] = await prisma.$queryRaw<{ required: boolean }[]>`
        SELECT app.system_role_requires_mfa(${role}) AS required`;
      expect(row!.required, role).toBe(MFA_REQUIRED_ROLES.includes(role));
    }

    const payer = new Browser(app);
    await payer.register();
    expect((await join(owner, payer, paymentsClerk)).status).toBe(403);
    await payer.enroll();
    const token = notifications
      .get(payer.identifier)
      ?.at(-1)
      ?.text.match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
    expect((await payer.call("post", "tenants/invitations/accept", { token })).status).toBe(200);

    const relogin = new Browser(app);
    relogin.identifier = admin.identifier;
    await relogin.initialize();
    expect(((await relogin.login()).body as { mfaRequired: boolean }).mfaRequired).toBe(true);
    expect((await relogin.call("get", "tenants")).status).toBe(403);

    clerk = new Browser(app);
    await clerk.register();
    expect((await join(owner, clerk, siteClerk, [projectOne])).status).toBe(200);
    await select(clerk, tenantA);
    expect(
      ((await clerk.call("get", "auth/me")).body as { mfaRequired: boolean }).mfaRequired,
    ).toBe(false);
    const visible = await clerk.call("get", "projects");
    expect((visible.body as { projects: { id: string }[] }).projects.map((p) => p.id)).toEqual([
      projectOne,
    ]);

    expect(
      (
        await owner.call("patch", `tenants/current/roles/${siteClerk}`, {
          permissions: ["projects.view", "bq.view", "payments.approve"],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await owner.call("put", `tenants/current/members/${clerk.auth.user.id}/role`, {
          role: "finance",
        })
      ).status,
    ).toBe(409);
    // Database backstops for both paths.
    await expect(
      db.run(as(owner, tenantA, "role-mfa-backstop"), (tx) =>
        tx.tenantRole.update({
          where: { id: siteClerk },
          data: { permissions: ["bq.view", "payments.approve", "projects.view"] },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(as(owner, tenantA, "member-mfa-backstop"), (tx) =>
        tx.membership.update({
          where: { tenantId_userId: { tenantId: tenantA, userId: clerk.auth.user.id } },
          data: { role: "finance" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("changes a member's role explicitly and revokes their sessions in that company", async () => {
    const elsewhere = new Browser(app);
    elsewhere.identifier = clerk.identifier;
    await elsewhere.initialize();
    await elsewhere.login();
    const changed = await owner.call("put", `tenants/current/members/${clerk.auth.user.id}/role`, {
      role: "project_manager",
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect((await clerk.call("get", "projects")).status).toBe(401);
    expect((await elsewhere.call("get", "auth/me")).status).toBe(200);
    await clerk.initialize();
    await clerk.login();
    await select(clerk, tenantA);
    const companies = tenantsResponseSchema.parse((await clerk.call("get", "tenants")).body);
    expect(companies.tenants[0]).toMatchObject({
      role: "project_manager",
      roleName: null,
      permissions: [...SYSTEM_ROLE_PERMISSIONS.project_manager],
    });
    expect(
      (
        await owner.call("put", `tenants/current/members/${clerk.auth.user.id}/role`, {
          role: "project_manager",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await owner.call("put", `tenants/current/members/${owner.auth.user.id}/role`, {
          role: "project_manager",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await owner.call("put", `tenants/current/members/${randomUUID()}/role`, {
          role: "foreman",
        })
      ).status,
    ).toBe(404);
    const event = (await auditActions()).find(
      (entry) =>
        entry.action === "membership.role_changed" && entry.resourceId === clerk.auth.user.id,
    );
    expect(event?.metadata).toEqual({ from: siteClerk, to: "project_manager", sessionsRevoked: 1 });
  });

  it("applies role ∩ project assignment, while company-wide roles see every project", async () => {
    expect((await clerk.call("patch", `projects/${projectOne}`, { name: "Not yet" })).status).toBe(
      403,
    );
    expect(
      (await clerk.call("patch", `projects/${projectTwo}`, { name: "Not assigned" })).status,
    ).toBe(403);
    await fresh(owner);
    expect(
      (
        await owner.call("put", `projects/${projectOne}/members/${clerk.auth.user.id}`, {
          permissions: ["projects.view", "projects.manage"],
        })
      ).status,
    ).toBe(200);
    expect(
      (await clerk.call("patch", `projects/${projectOne}`, { name: "Roles site one (PM)" })).status,
    ).toBe(200);

    const viewerRole: Role = await createRole(owner, {
      name: "Company viewer",
      permissions: ["projects.view"],
      tenantWide: true,
    });
    const viewer = new Browser(app);
    await viewer.register();
    expect((await join(owner, viewer, viewerRole.id)).status).toBe(200);
    await select(viewer, tenantA);
    const all = await viewer.call("get", "projects");
    expect((all.body as { projects: { id: string }[] }).projects.map((p) => p.id)).toEqual([
      projectOne,
      projectTwo,
    ]);
    expect((await viewer.call("patch", `projects/${projectTwo}`, { name: "No" })).status).toBe(403);
    // A project-scoped role with no assignment sees nothing and cannot assign anyone.
    expect((await admin.call("get", "projects")).body).toEqual({ projects: [] });
    expect(
      (
        await admin.call("put", `projects/${projectOne}/members/${viewer.auth.user.id}`, {
          permissions: ["projects.view"],
        })
      ).status,
    ).toBe(403);
  });

  it("deletes a custom role only once no member or pending invitation uses it", async () => {
    expect((await owner.call("delete", `tenants/current/roles/${teamAdmin}`)).status).toBe(409);
    const pending = await owner.call("post", "tenants/current/invitations", {
      identifier: "pending-clerk@example.test",
      role: siteClerk,
    });
    expect(pending.status, JSON.stringify(pending.body)).toBe(201);
    const invitationId = (pending.body as { invitation: { id: string; roleName: string } })
      .invitation.id;
    expect((pending.body as { invitation: { roleName: string } }).invitation.roleName).toBe(
      "Site clerk",
    );
    expect((await owner.call("delete", `tenants/current/roles/${siteClerk}`)).status).toBe(409);
    await db.run(as(owner, tenantA, "expire-role-invite"), (tx) =>
      tx.invitation.update({
        where: { id: invitationId },
        data: { expiresAt: new Date(Date.now() - 1) },
      }),
    );
    expect((await owner.call("delete", `tenants/current/roles/${siteClerk}`)).status).toBe(200);
    expect(
      await db.run(as(owner, tenantA, "expired-invite-removed"), (tx) =>
        tx.invitation.count({ where: { id: invitationId } }),
      ),
    ).toBe(0);

    const clerkCopy = (await roles(owner)).find((role) => role.name === "Clerk copy")!;
    expect(
      (
        await owner.call("put", `tenants/current/members/${admin.auth.user.id}/role`, {
          role: clerkCopy.id,
        })
      ).status,
    ).toBe(200);
    expect((await owner.call("delete", `tenants/current/roles/${teamAdmin}`)).status).toBe(200);
    const remaining = await roles(owner);
    expect(remaining.find((role) => role.id === clerkCopy.id)?.memberCount).toBe(1);
    expect(remaining.some((role) => role.id === teamAdmin)).toBe(false);
  });
});
