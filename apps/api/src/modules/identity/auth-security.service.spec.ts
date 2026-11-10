import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../config/app-config.js";
import type { RedisService } from "../../infra/redis.service.js";
import { AuthSecurity, cookie } from "./auth-security.service.js";

function config(values: Record<string, unknown> = {}, production = false): AppConfig {
  const defaults: Record<string, unknown> = {
    WEB_ORIGIN: "http://localhost:3000",
    AUTH_NOTIFICATION_TRANSPORT: "disabled",
    AUTH_MFA_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    ...values,
  };
  return {
    isProduction: production,
    get: (name: string) => defaults[name],
  } as unknown as AppConfig;
}
const redis = {
  ping: vi.fn().mockResolvedValue(undefined),
  client: { eval: vi.fn().mockResolvedValue(1) },
} as unknown as RedisService;
const req = (headers: Request["headers"]): Request => ({ headers }) as Request;
const response = () => ({ cookie: vi.fn(), setHeader: vi.fn() }) as unknown as Response;

describe("Browser authentication security", () => {
  it("fails closed on missing production keys and development notification transports", () => {
    expect(() => new AuthSecurity(config({}, true), redis)).toThrow("Production requires");
    expect(
      () =>
        new AuthSecurity(
          config(
            {
              AUTH_MFA_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
              AUTH_SIGNING_PRIVATE_KEY: "placeholder",
              AUTH_NOTIFICATION_TRANSPORT: "development",
            },
            true,
          ),
          redis,
        ),
    ).toThrow("forbidden in production");
  });

  it("uses production Secure, HttpOnly, SameSite cookies with exact host/path scopes", async () => {
    const keys = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const pem = await exportPKCS8(keys.privateKey);
    const service = new AuthSecurity(
      config(
        {
          WEB_ORIGIN: "https://app.example.test",
          AUTH_SIGNING_PRIVATE_KEY: Buffer.from(pem).toString("base64"),
          AUTH_MFA_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
        },
        true,
      ),
      redis,
    );
    await service.onModuleInit();
    const res = response();
    service.setCookie(res, "at", "access", 1000);
    service.setCookie(res, "rt", "refresh", 2000);
    service.setCookie(res, "csrf", "csrf", 3000);
    const cookieMock = (res as unknown as { cookie: ReturnType<typeof vi.fn> }).cookie;
    expect(cookieMock).toHaveBeenNthCalledWith(1, "__Host-pmb_at", "access", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 1000,
    });
    expect(cookieMock).toHaveBeenNthCalledWith(2, "__Secure-pmb_rt", "refresh", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/api/v1/auth",
      maxAge: 2000,
    });
    expect(cookieMock).toHaveBeenNthCalledWith(3, "__Host-pmb_csrf", "csrf", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 3000,
    });
    const token = await service.accessToken("user-id", "session-id", 2);
    expect(await service.accessClaims(req({ cookie: `__Host-pmb_at=${token}` }))).toEqual({
      userId: "user-id",
      sessionId: "session-id",
      generation: 2,
    });
  });

  it("binds CSRF to a signed encrypted cookie and rejects missing, tampered, foreign-origin or unicode values", async () => {
    const service = new AuthSecurity(config(), redis);
    await service.onModuleInit();
    const { csrfToken } = await service.csrf(req({}), response());
    const headers = {
      origin: "http://localhost:3000",
      cookie: `pmb_csrf=${csrfToken}`,
      "x-csrf-token": csrfToken,
    };
    await expect(service.assertCsrf(req(headers))).resolves.toBeUndefined();
    await expect(
      service.assertCsrf(req({ ...headers, origin: "https://evil.example" })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.assertCsrf(req({ ...headers, "sec-fetch-site": "cross-site" })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.assertCsrf(req({ ...headers, "x-csrf-token": undefined })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.assertCsrf(req({ ...headers, "x-csrf-token": "é".repeat(csrfToken.length) })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.assertCsrf(req({ ...headers, cookie: "pmb_csrf=forged", "x-csrf-token": "forged" })),
    ).rejects.toMatchObject({ status: 403 });
    const otherPurpose = await service.encrypt("secret", "totp:user");
    await expect(
      service.assertCsrf(
        req({
          ...headers,
          cookie: `pmb_csrf=${otherPurpose}`,
          "x-csrf-token": otherPurpose,
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects expired encrypted CSRF tokens and accepts neither unsigned nor wrong-key access credentials", async () => {
    const service = new AuthSecurity(config(), redis);
    await service.onModuleInit();
    const expired = await service.encrypt("nonce", "csrf", "-1s");
    await expect(
      service.assertCsrf(
        req({
          origin: "http://localhost:3000",
          cookie: `pmb_csrf=${expired}`,
          "x-csrf-token": expired,
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(service.accessClaims(req({ cookie: "pmb_at=unsigned" }))).rejects.toMatchObject({
      status: 401,
    });
    const other = new AuthSecurity(config(), redis);
    await other.onModuleInit();
    const token = await other.accessToken("u", "s", 1);
    await expect(service.accessClaims(req({ cookie: `pmb_at=${token}` }))).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects ambiguous duplicate cookies rather than choosing an attacker-controlled value", () => {
    expect(cookie(req({ cookie: "pmb_at=one; pmb_at=two" }), "pmb_at")).toBeUndefined();
    expect(cookie(req({ cookie: "other=x; pmb_at=one" }), "pmb_at")).toBe("one");
  });

  it("fails explicitly when no notification provider is approved", async () => {
    const service = new AuthSecurity(config(), redis);
    await service.onModuleInit();
    await expect(
      service.notify("user@example.test", "Test", "No external delivery"),
    ).rejects.toMatchObject({ status: 503 });
  });
});
