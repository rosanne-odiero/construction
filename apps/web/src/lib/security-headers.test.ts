import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "../proxy";
import {
  HSTS,
  PERMISSIONS_POLICY,
  contentSecurityPolicy,
  createNonce,
  securityHeaders,
} from "./security-headers";

const directives = (policy: string) =>
  new Map(
    policy.split("; ").map((directive) => {
      const [name = "", ...values] = directive.split(" ");
      return [name, values] as const;
    }),
  );

describe("contentSecurityPolicy", () => {
  const nonce = createNonce();

  it("allows scripts only by nonce, with no plugins, base URL, framing or foreign forms", () => {
    const policy = directives(
      contentSecurityPolicy({ nonce, development: false, upgradeInsecureRequests: true }),
    );
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("script-src")).toEqual(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'none'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("frame-src")).toEqual(["'none'"]);
    expect(policy.get("form-action")).toEqual(["'self'"]);
    expect(policy.get("connect-src")).toEqual(["'self'"]);
    expect(policy.get("img-src")).toEqual(["'self'"]);
    expect(policy.get("font-src")).toEqual(["'self'"]);
    expect(policy.get("upgrade-insecure-requests")).toEqual([]);
    // Never in production: these would let injected markup run script.
    const scripts = policy.get("script-src")!.join(" ");
    expect(scripts).not.toContain("unsafe-inline");
    expect(scripts).not.toContain("unsafe-eval");
  });

  it("adds eval and the development map tiles only in development", () => {
    const policy = directives(
      contentSecurityPolicy({ nonce, development: true, upgradeInsecureRequests: false }),
    );
    expect(policy.get("script-src")).toContain("'unsafe-eval'");
    expect(policy.get("img-src")).toEqual(["'self'", "https://tile.openstreetmap.org"]);
    expect(policy.has("upgrade-insecure-requests")).toBe(false);
  });

  it("refuses a nonce that could inject directives or is too short", () => {
    for (const bad of ["", "abc", "AAAAAAAAAAAAAAAAAAAAAAAA; script-src *", "A".repeat(21)])
      expect(() =>
        contentSecurityPolicy({ nonce: bad, development: false, upgradeInsecureRequests: false }),
      ).toThrow();
  });

  it("creates a fresh 128-bit nonce each time", () => {
    const nonces = new Set(Array.from({ length: 50 }, createNonce));
    expect(nonces.size).toBe(50);
    for (const value of nonces) expect(Buffer.from(value, "base64")).toHaveLength(16);
  });
});

describe("securityHeaders", () => {
  it("sends HSTS for a year or more on every subdomain, in production only", () => {
    expect(new Map(securityHeaders(true)).get("Strict-Transport-Security")).toBe(HSTS);
    expect(HSTS).toMatch(/max-age=(\d+); includeSubDomains/);
    expect(Number(/max-age=(\d+)/.exec(HSTS)![1])).toBeGreaterThanOrEqual(31_536_000);
    expect(new Map(securityHeaders(false)).has("Strict-Transport-Security")).toBe(false);
  });

  it("keeps geolocation and passkeys for this origin and switches off the camera", () => {
    expect(PERMISSIONS_POLICY).toContain("geolocation=(self)");
    expect(PERMISSIONS_POLICY).toContain("publickey-credentials-get=(self)");
    expect(PERMISSIONS_POLICY).toContain("publickey-credentials-create=(self)");
    expect(PERMISSIONS_POLICY).toContain("camera=()");
    expect(PERMISSIONS_POLICY).toContain("microphone=()");
  });
});

describe("proxy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sends a different nonce on each response and hands it to the page render", () => {
    const first = proxy(new NextRequest("http://localhost/dashboard"));
    const second = proxy(new NextRequest("http://localhost/dashboard"));
    const nonceOf = (policy: string | null) => /'nonce-([^']+)'/.exec(policy ?? "")?.[1];
    const firstNonce = nonceOf(first.headers.get("Content-Security-Policy"));
    expect(firstNonce).toBeTruthy();
    expect(nonceOf(second.headers.get("Content-Security-Policy"))).not.toBe(firstNonce);
    // NextResponse.next forwards overridden request headers to the render as x-middleware-request-*.
    expect(first.headers.get("x-middleware-request-x-nonce")).toBe(firstNonce);
    expect(first.headers.get("X-Frame-Options")).toBe("DENY");
    expect(first.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(first.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(first.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  it("ignores a nonce supplied by the client", () => {
    const response = proxy(
      new NextRequest("http://localhost/sign-in", { headers: { "x-nonce": "attacker" } }),
    );
    expect(response.headers.get("x-middleware-request-x-nonce")).not.toBe("attacker");
  });

  it("upgrades insecure requests and sends HSTS only for HTTPS production pages", () => {
    vi.stubEnv("NODE_ENV", "production");
    const https = proxy(
      new NextRequest("http://web.internal/", { headers: { "x-forwarded-proto": "https" } }),
    );
    expect(https.headers.get("Content-Security-Policy")).toContain("upgrade-insecure-requests");
    expect(https.headers.get("Strict-Transport-Security")).toBe(HSTS);
    expect(https.headers.get("Content-Security-Policy")).not.toContain("unsafe-eval");
    const http = proxy(new NextRequest("http://localhost:3000/"));
    expect(http.headers.get("Content-Security-Policy")).not.toContain("upgrade-insecure-requests");
  });

  it("leaves /api to the API's own headers", () => {
    const [matcher] = config.matcher;
    const pattern = new RegExp(`^${matcher}$`);
    expect(pattern.test("/api/v1/auth/me")).toBe(false);
    for (const path of ["/", "/sign-in", "/projects/1", "/_next/static/chunks/app.js"])
      expect(pattern.test(path)).toBe(true);
  });
});
