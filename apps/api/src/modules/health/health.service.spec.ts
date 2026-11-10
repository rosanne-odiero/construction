import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config/app-config.js";
import type { PrismaService } from "../../infra/prisma.service.js";
import type { RedisService } from "../../infra/redis.service.js";
import type { StorageService } from "../../infra/storage.service.js";
import { HealthService } from "./health.service.js";

function makeService({
  production = false,
  database = async () => 1,
  redis = async () => undefined,
  storage = async () => undefined,
}: {
  production?: boolean;
  database?: () => Promise<unknown>;
  redis?: () => Promise<unknown>;
  storage?: (signal?: AbortSignal) => Promise<unknown>;
} = {}) {
  const values: Record<string, unknown> = {
    HEALTH_CHECK_TIMEOUT_MS: 100,
    OTEL_SERVICE_NAME: "pm-buddy-api",
    APP_VERSION: "0.1.0-test",
    GIT_SHA: "abc1234",
  };
  const config = {
    get: (key: string) => values[key],
    isProduction: production,
  } as unknown as AppConfig;
  const prisma = { $queryRaw: () => database() } as unknown as PrismaService;
  return new HealthService(
    config,
    prisma,
    { ping: redis } as unknown as RedisService,
    { ping: storage } as unknown as StorageService,
  );
}

describe("HealthService", () => {
  it("reports liveness with identity and uptime", () => {
    const live = makeService().live();
    expect(live).toMatchObject({
      status: "ok",
      service: "pm-buddy-api",
      version: "0.1.0-test",
      commit: "abc1234",
    });
    expect(live.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("is ready when every dependency is up", async () => {
    const ready = await makeService().ready();
    expect(ready.status).toBe("ok");
    expect(Object.values(ready.checks).every((c) => c.status === "up")).toBe(true);
  });

  it("degrades and explains which dependency is down", async () => {
    const ready = await makeService({
      redis: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:56379");
      },
    }).ready();
    expect(ready.status).toBe("degraded");
    expect(ready.checks.redis).toMatchObject({
      status: "down",
      error: "connect ECONNREFUSED 127.0.0.1:56379",
    });
    expect(ready.checks.database.status).toBe("up");
  });

  it("times out slow dependencies and aborts the probe", async () => {
    let aborted = false;
    const ready = await makeService({
      storage: (signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            resolve(undefined);
          });
        }),
    }).ready();
    expect(ready.checks.storage).toMatchObject({ status: "down", error: "timed out after 100 ms" });
    expect(aborted).toBe(true);
  });

  it("scrubs credentials from error messages", async () => {
    const check = await makeService().check(async () => {
      throw new Error("cannot connect to postgresql://pmb_app:pmb_app_dev@db:5432/pmb");
    });
    expect(check.error).toBe("cannot connect to postgresql://***@db:5432/pmb");
  });

  it("omits error details in production", async () => {
    const check = await makeService({ production: true }).check(async () => {
      throw new Error("internal hostname db-primary.internal");
    });
    expect(check).toMatchObject({ status: "down" });
    expect(check.error).toBeUndefined();
  });
});
