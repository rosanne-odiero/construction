import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config/app-config.js";
import type { PrismaService } from "../../infra/prisma.service.js";
import type { AuthSecurity } from "./auth-security.service.js";
import type { AuthService } from "./auth.service.js";
import type { PinHasher } from "./pin-pepper.js";
import { PIN_GLOBAL_FAILURES, PinService } from "./pin.service.js";

/** A PinService whose every PIN is wrong, with rate-limit counters kept in memory. */
const wrongPins = (budget: number) => {
  const counts = new Map<string, number>();
  const security = {
    counted: async (key: string) => counts.get(key) ?? 0,
    increment: async (key: string) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return counts.get(key)!;
    },
    release: async () => {},
  };
  const service = new PinService(
    { $transaction: async () => null } as unknown as PrismaService,
    {} as never,
    { throttle: async () => {} } as unknown as AuthService,
    security as unknown as AuthSecurity,
    {} as never,
    {} as PinHasher,
    { get: () => budget } as unknown as AppConfig,
  );
  const guess = (ip: string, n: number) =>
    service
      .login(`+2547000${String(n).padStart(5, "0")}`, "802461", { ip } as Request, {} as Response)
      .catch(() => undefined);
  return { counts, guess };
};

describe("PIN sign-in's platform-wide failure count", () => {
  it("counts every wrong PIN, however many come from one client address", async () => {
    const { counts, guess } = wrongPins(1_000);
    for (let n = 0; n < 50; n++) await guess("198.51.100.7", n);
    for (let n = 50; n < 55; n++) await guess("203.0.113.9", n);
    // A cap per address would let one client spray guesses across numbers without an alert.
    expect(counts.get(PIN_GLOBAL_FAILURES)).toBe(55);
  });
});
