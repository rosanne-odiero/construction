import { describe, expect, it, vi } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { AppConfig } from "../../config/app-config.js";
import type { PrismaService } from "../../infra/prisma.service.js";
import type { RedisService } from "../../infra/redis.service.js";
import type { AuthSecurity } from "../identity/auth-security.service.js";
import type { AuthService } from "../identity/auth.service.js";
import type { PinService } from "../identity/pin.service.js";
import type { TenantDatabase } from "../identity/tenant-database.service.js";
import type { PortalsService } from "./portals.service.js";
import { UssdService } from "./ussd.service.js";

function fixture() {
  const saved = new Map<string, string>();
  const sessionId = "22000000-0000-4000-8000-000000000001";
  const companyId = "23000000-0000-4000-8000-000000000001";
  const redis = {
    ping: vi.fn().mockResolvedValue(undefined),
    client: {
      get: vi.fn(async (key: string) => saved.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        saved.set(key, value);
        return "OK";
      }),
      ttl: vi.fn().mockResolvedValue(180),
      del: vi.fn(async (key: string) => Number(saved.delete(key))),
      eval: vi.fn().mockResolvedValue(1),
    },
  };
  const security = {
    limit: vi.fn().mockResolvedValue(undefined),
    encrypt: vi.fn(async (value: string) => value),
    decrypt: vi.fn(async (value: string) => value),
  };
  const pins = { authenticate: vi.fn().mockResolvedValue({ id: sessionId, userId: companyId }) };
  const prisma = {
    session: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const auth = {
    sessionPrincipal: vi.fn().mockResolvedValue({ user: { id: companyId } }),
    requireMfa: vi.fn(),
  };
  const db = {
    run: vi.fn().mockResolvedValue([
      {
        role: "labourer",
        customRoleId: null,
        tenant: { id: companyId, name: "Company\n1. forged option" },
      },
    ]),
  };
  const portals = {
    worker: vi.fn().mockResolvedValue({
      attendance: { daysWorked: 1.5 },
      pay: {
        lines: [
          {
            project: "Assigned project",
            from: "2026-11-01",
            to: "2026-11-07",
            grossMinor: "420000",
            netMinor: "400000",
          },
        ],
        advancesOutstandingMinor: "150000",
      },
    }),
  };
  const service = new UssdService(
    { get: () => "*384*123#" } as unknown as AppConfig,
    redis as unknown as RedisService,
    security as unknown as AuthSecurity,
    pins as unknown as PinService,
    prisma as unknown as PrismaService,
    auth as unknown as AuthService,
    db as unknown as TenantDatabase,
    portals as unknown as PortalsService,
  );
  const call = (text: string) =>
    service.handle(
      {
        sessionId: "provider-session",
        serviceCode: "*384*123#",
        phoneNumber: "+254712345678",
        text,
      },
      { headers: {} } as Request,
    );
  const menu = async (language = "1") => {
    let response = "";
    for (const text of [
      "",
      language,
      `${language}*12345678`,
      `${language}*12345678*274915`,
      `${language}*12345678*274915*1`,
    ])
      response = await call(text);
    return response;
  };
  return { saved, redis, security, pins, prisma, auth, portals, call, menu };
}

describe("USSD self-service results", () => {
  it.each([
    ["1", "1", "1.5"],
    ["1", "2", "KES 4,000.00"],
    ["1", "3", "not proof of payment"],
    ["2", "4", "KES 1,500.00"],
  ])(
    "returns an explicit result in language %s for choice %s",
    async (language, choice, expected) => {
      const { call, menu, security, pins, prisma, portals } = fixture();
      expect(await menu(language)).toMatch(/^CON /);
      const response = await call(`${language}*12345678*274915*1*${choice}`);
      expect(response).toMatch(/^END /);
      expect(response).toContain(expected);
      expect(response.length).toBeLessThanOrEqual(160);
      if (choice === "2") {
        expect(response).toContain("01/11/2026 - 07/11/2026");
        expect(response).toContain("not payment");
        expect(response).not.toContain("4,200");
      }
      expect(pins.authenticate).toHaveBeenCalledOnce();
      expect(portals.worker).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.anything(),
        "12345678",
      );
      expect(security.encrypt.mock.calls.every(([value]) => !value.includes("274915"))).toBe(true);
      expect(prisma.session.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { revokedAt: expect.any(Date) },
        }),
      );
      expect(await call(`${language}*12345678*274915*1*${choice}`)).toContain("expired");
    },
  );

  it("does not extend an expired Redis deadline or expose financial data after invalid session authentication", async () => {
    const { call, redis, portals, auth, menu } = fixture();
    await call("");
    redis.client.ttl.mockResolvedValue(0);
    expect(await call("1")).toMatch(/^END /);
    expect(portals.worker).not.toHaveBeenCalled();
    redis.client.ttl.mockResolvedValue(180);
    await menu();
    portals.worker.mockClear();
    auth.sessionPrincipal.mockRejectedValueOnce(new UnauthorizedException());
    expect(await call("1*12345678*274915*1*2")).toContain("Unable to verify");
    expect(portals.worker).not.toHaveBeenCalled();
  });
});
