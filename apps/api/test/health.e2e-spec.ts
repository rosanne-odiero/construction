import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  liveResponseSchema,
  problemDetailsSchema,
  readyResponseSchema,
} from "@pm-buddy/validation";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";

// Requires the local services: `pnpm services:up && pnpm db:migrate` (CI does the same).
describe("API (e2e)", () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("runs against the isolated test database, as the restricted app role", async () => {
    const [row] = await app.get(PrismaService).$queryRaw<{ db: string; role: string }[]>`
      SELECT current_database() AS db, current_user AS role`;
    expect(row).toEqual({ db: "pmb_test", role: "pmb_app" });
  });

  it("GET /api/v1/health/live reports the process is up", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/health/live").expect(200);
    expect(liveResponseSchema.parse(res.body).status).toBe("ok");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("GET /api/v1/health/ready checks database, Valkey and storage", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/health/ready");
    const body = readyResponseSchema.parse(res.body);
    expect(body.checks, JSON.stringify(body.checks)).toMatchObject({
      database: { status: "up" },
      redis: { status: "up" },
      storage: { status: "up" },
    });
    expect(res.status).toBe(200);
  });

  it("answers unknown routes with problem+json and echoes a safe request ID", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/does-not-exist")
      .set("X-Request-Id", "trace-abc-12345")
      .expect(404)
      .expect("Content-Type", /application\/problem\+json/);
    const problem = problemDetailsSchema.parse(res.body);
    expect(problem).toMatchObject({ status: 404, code: "not-found", traceId: "trace-abc-12345" });
    expect(res.headers["x-request-id"]).toBe("trace-abc-12345");
  });

  it("sets locked-down security headers on API responses", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/health/live");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toBe(
      "default-src 'none';frame-ancestors 'none'",
    );
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("serves Swagger UI under a CSP that still allows its same-origin scripts", async () => {
    const res = await request(app.getHttpServer()).get("/api/docs").expect(200);
    const csp = res.headers["content-security-policy"];
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("publishes the OpenAPI document", async () => {
    const res = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    expect(res.body.info.title).toBe("PM-Buddy API");
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(["/api/v1/health/live", "/api/v1/health/ready"]),
    );
  });
});
