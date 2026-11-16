import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../infra/prisma.service.js";
import type { TenantDatabase } from "../identity/tenant-database.service.js";
import { ACCESS_LOG_LIMITS, type AccessEntry } from "./access-entry.js";
import { AccessLogWriter } from "./access-log.writer.js";

const A = "0193a7c0-0000-7000-8000-00000000000a";
const B = "0193a7c0-0000-7000-8000-00000000000b";
const entry = (tenantId: string, index: number): AccessEntry => ({
  tenantId,
  userId: "0193a7c0-0000-7000-8000-000000000002",
  sessionId: "0193a7c0-0000-7000-8000-000000000003",
  authMethod: "password",
  method: "GET",
  route: "/api/v1/projects/:id",
  params: {},
  resourceIds: [],
  status: 200,
  durationMs: index,
  ipAddress: "203.0.113.9",
  requestId: `request-${String(index).padStart(8, "0")}`,
  occurredAt: new Date(),
});

function writer(createMany: ReturnType<typeof vi.fn>) {
  const run = vi.fn(
    (_context: { tenantId: string }, operation: (tx: unknown) => Promise<unknown>) =>
      operation({ accessEvent: { createMany } }),
  );
  const instance = new AccessLogWriter(
    { run } as unknown as TenantDatabase,
    { beforeDisconnect: vi.fn() } as unknown as PrismaService,
  );
  return { instance, run };
}

describe("AccessLogWriter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes one transaction per company and keeps entries the database refused", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const createMany = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("connection to 203.0.113.9 refused"), { code: "P1001" }),
      )
      .mockResolvedValue({ count: 1 });
    const { instance, run } = writer(createMany);
    for (const [tenantId, index] of [
      [A, 1],
      [B, 2],
      [A, 3],
    ] as const)
      instance.record(entry(tenantId, index));

    await instance.flush();
    expect(instance.pending).toBe(3);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("P1001");
    expect(logged).not.toContain("203.0.113.9");

    await instance.flush();
    expect(instance.pending).toBe(0);
    expect(run.mock.calls.map(([context]) => context.tenantId)).toEqual([A, A, B]);
    const written = createMany.mock.calls
      .slice(1)
      .map(([input]) => (input as { data: AccessEntry[] }).data.map((row) => row.durationMs));
    expect(written).toEqual([[1, 3], [2]]);
  });

  it("drops and counts entries past its capacity and after shutdown, never their content", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { instance } = writer(vi.fn().mockRejectedValue(new Error("down")));
    for (let index = 0; index < ACCESS_LOG_LIMITS.maxQueued + 5; index += 1)
      instance.record(entry(A, index));
    await instance.flush();
    expect(instance.pending).toBe(ACCESS_LOG_LIMITS.maxQueued);

    await instance.close();
    instance.record(entry(A, 1));
    expect(instance.pending).toBe(0);
    const logged = error.mock.calls.flat().join(" ");
    expect(logged).toMatch(/dropped \d+ entries/);
    expect(logged).not.toMatch(/203\.0\.113\.9|request-/);
    const total = [...logged.matchAll(/dropped (\d+) entries/g)].reduce(
      (sum, match) => sum + Number(match[1]),
      0,
    );
    expect(total).toBe(ACCESS_LOG_LIMITS.maxQueued + 6);
  });
});
