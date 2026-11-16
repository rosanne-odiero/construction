import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import { projectResponseSchema, reportModelSchema } from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import type { AccessEvent, Prisma } from "../src/generated/prisma/client.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AccessLogRetention } from "../src/modules/access-log/access-log.retention.js";
import { AccessLogWriter } from "../src/modules/access-log/access-log.writer.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { Browser, notifications } from "./support.js";

const DAY = 86_400_000;

describe("Access log: who accessed what and when (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let writer: AccessLogWriter;
  let owner: Browser;
  let ownerB: Browser;
  let agent: Browser;
  let tenantA: string;
  let tenantB: string;
  let projectId: string;
  let notificationSpy: ReturnType<typeof vi.spyOn>;

  const fresh = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
  const inTenant = <T>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    db.run({ userId: owner.auth.user.id, tenantId, requestId: "access-log-e2e" }, work);
  /** The company's written entries, oldest first. */
  const entries = async (tenantId: string, where: Prisma.AccessEventWhereInput = {}) => {
    await writer.flush();
    return inTenant(tenantId, (tx) =>
      tx.accessEvent.findMany({ where: { tenantId, ...where }, orderBy: { occurredAt: "asc" } }),
    );
  };
  /** The entry of one request, once its response has finished and the writer has written it. */
  const entryOf = async (tenantId: string, res: request.Response) => {
    const requestId = res.headers["x-request-id"] as string;
    expect(requestId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    let found: AccessEvent | undefined;
    await vi.waitFor(async () => {
      [found] = await entries(tenantId, { requestId });
      expect(found).toBeDefined();
    });
    return found!;
  };
  const report = async (params: Record<string, string>) => {
    const res = await owner.call("get", `reports/access-log?${new URLSearchParams(params)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const section = reportModelSchema.parse(res.body).sections[0]!;
    const at = (key: string) => section.columns.findIndex((column) => column.key === key);
    return {
      model: reportModelSchema.parse(res.body),
      rows: section.rows.map((row) => ({
        request: row[at("request")],
        records: row[at("records")],
        outcome: String(row[at("outcome")]),
        actor: row[at("actor")],
      })),
    };
  };
  const period = () => ({ from: addCalendarDays(nairobiDate(), -1), to: nairobiDate() });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    db = app.get(TenantDatabase);
    writer = app.get(AccessLogWriter);
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
    agent = new Browser(app);
    for (const browser of [owner, ownerB]) {
      await browser.register();
      await browser.enroll();
    }
    await agent.register();
    const a = await owner.call("post", "tenants", { name: "Access log company A" });
    const b = await ownerB.call("post", "tenants", { name: "Access log company B" });
    expect([a.status, b.status]).toEqual([201, 201]);
    tenantA = (a.body as { tenant: { id: string } }).tenant.id;
    tenantB = (b.body as { tenant: { id: string } }).tenant.id;
    await fresh(owner);
    const invited = await owner.call("post", "tenants/current/invitations", {
      identifier: agent.identifier,
      role: "site_agent",
      projectIds: [],
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    const token = notifications
      .get(agent.identifier)
      ?.at(-1)
      ?.text.match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
    expect((await agent.call("post", "tenants/invitations/accept", { token })).status).toBe(200);
    expect((await agent.call("post", `tenants/${tenantA}/select`, {})).status).toBe(200);
    await fresh(owner);
    const created = await owner.call("post", "projects", { name: "Access log (synthetic)" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    projectId = projectResponseSchema.parse(created.body).project.id;
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("records who read which record, when and with what outcome, under the client's request ID", async () => {
    const before = Date.now();
    const res = await owner.call("get", `projects/${projectId}`);
    expect(res.status).toBe(200);
    const entry = await entryOf(tenantA, res);
    expect(entry).toMatchObject({
      userId: owner.auth.user.id,
      sessionId: owner.auth.session.id,
      authMethod: "password",
      method: "GET",
      route: "/api/v1/projects/:id",
      params: { id: projectId },
      resourceIds: [projectId],
      status: 200,
      // No TRUST_PROXY here, so no client address is trusted or kept.
      ipAddress: null,
    });
    expect(entry.occurredAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(entry.occurredAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("keeps record IDs from the query, never search text, and records refusals", async () => {
    const search = await owner.call("get", "projects?search=Mavuno%20Homes%200712345678");
    expect(search.status).toBe(200);
    const listed = await entryOf(tenantA, search);
    expect(listed).toMatchObject({ route: "/api/v1/projects", params: {}, resourceIds: [] });
    expect(JSON.stringify(listed)).not.toMatch(/Mavuno|0712345678/);

    const refused = await agent.call("get", `reports/access-log?actorId=${owner.auth.user.id}`);
    expect(refused.status).toBe(403);
    expect(await entryOf(tenantA, refused)).toMatchObject({
      userId: agent.auth.user.id,
      route: "/api/v1/reports/:reportId",
      params: { reportId: "access-log", actorId: owner.auth.user.id },
      resourceIds: [owner.auth.user.id],
      status: 403,
    });
  });

  it("records nothing for a request without a signed-in session", async () => {
    const anonymous = await request(app.getHttpServer())
      .get(`/api/v1/projects/${projectId}`)
      .set("X-Request-Id", "anonymous-access-0001");
    expect(anonymous.status).toBe(401);
    // A later signed-in request is written, so the anonymous one had its chance first.
    await entryOf(tenantA, await owner.call("get", "projects"));
    expect(await entries(tenantA, { requestId: "anonymous-access-0001" })).toEqual([]);
  });

  it("shares the request ID with the audit events of the same request", async () => {
    await fresh(owner);
    const created = await owner.call("post", "projects", { name: "Audited access (synthetic)" });
    expect(created.status).toBe(201);
    const entry = await entryOf(tenantA, created);
    expect(entry).toMatchObject({ method: "POST", route: "/api/v1/projects", status: 201 });
    const audit = await inTenant(tenantA, (tx) =>
      tx.auditEvent.findMany({ where: { tenantId: tenantA, requestId: entry.requestId } }),
    );
    expect(audit.map((event) => event.action)).toContain("project.created");
  });

  it("keeps companies apart and lets nobody change or delete an entry", async () => {
    const entryB = await entryOf(tenantB, await ownerB.call("get", "projects"));
    expect(entryB.userId).toBe(ownerB.auth.user.id);
    expect(
      await inTenant(tenantA, (tx) => tx.accessEvent.count({ where: { tenantId: tenantB } })),
    ).toBe(0);
    const { id: _id, ...copy } = entryB;
    await expect(
      inTenant(tenantA, (tx) =>
        tx.accessEvent.create({
          data: { ...copy, params: {}, requestId: "forged-entry-0001" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      inTenant(tenantB, (tx) =>
        tx.accessEvent.update({ where: { id: entryB.id }, data: { status: 200 } }),
      ),
    ).rejects.toThrow();
    await expect(
      inTenant(tenantB, (tx) => tx.accessEvent.deleteMany({ where: { id: entryB.id } })),
    ).rejects.toThrow();
    await expect(
      inTenant(tenantB, (tx) => tx.$executeRaw`TRUNCATE access_events`),
    ).rejects.toThrow();
    expect(await entries(tenantB, { id: entryB.id })).toHaveLength(1);
  });

  it("purges only entries older than 365 days", async () => {
    const base = {
      tenantId: tenantA,
      userId: owner.auth.user.id,
      sessionId: owner.auth.session.id,
      authMethod: "password",
      method: "GET",
      route: "/api/v1/projects",
      status: 200,
      durationMs: 1,
    };
    const [expired, kept] = await inTenant(tenantA, async (tx) => [
      await tx.accessEvent.create({
        data: {
          ...base,
          requestId: "retention-old-0001",
          occurredAt: new Date(Date.now() - 366 * DAY),
        },
      }),
      await tx.accessEvent.create({
        data: {
          ...base,
          requestId: "retention-new-0001",
          occurredAt: new Date(Date.now() - 364 * DAY),
        },
      }),
    ]);
    // Even an expired entry is out of the runtime role's reach; only the purge function deletes.
    await expect(
      inTenant(tenantA, (tx) => tx.accessEvent.deleteMany({ where: { id: expired!.id } })),
    ).rejects.toThrow();
    expect(await app.get(AccessLogRetention).purge()).toBeGreaterThanOrEqual(1);
    const left = await entries(tenantA, { id: { in: [expired!.id, kept!.id] } });
    expect(left.map((row) => row.id)).toEqual([kept!.id]);
  });

  it("answers who accessed a record in the access-log report, after a recent MFA check", async () => {
    await entryOf(tenantA, await owner.call("get", `projects/${projectId}`));
    await prisma.session.update({
      where: { id: owner.auth.session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 10 * 60_000) },
    });
    const stale = await owner.call("get", `reports/access-log?recordId=${projectId}`);
    expect(stale.status).toBe(403);
    expect((stale.body as { code?: string }).code).toBe("step-up-required");
    await fresh(owner);

    const byRecord = await report({ recordId: projectId, ...period() });
    expect(byRecord.rows.length).toBeGreaterThan(0);
    for (const row of byRecord.rows) expect(row.records).toContain(projectId);
    expect(
      byRecord.rows.some(
        (row) => row.request === "GET projects/:id" && row.outcome === "200 allowed",
      ),
    ).toBe(true);
    expect(byRecord.model.parameters.find((line) => line.key === "record")?.value).toBe(projectId);

    const byAgent = await report({ actorId: agent.auth.user.id, ...period() });
    expect(byAgent.rows.length).toBeGreaterThan(0);
    // Only the agent's requests: the owner's reads of the project are not among them.
    expect(byAgent.rows.some((row) => row.request === "GET projects/:id")).toBe(false);
    expect(
      byAgent.rows.some(
        (row) => row.request === "GET reports/:reportId" && row.outcome === "403 refused",
      ),
    ).toBe(true);
  });
});
