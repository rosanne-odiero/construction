import { describe, expect, it } from "vitest";
import type { AccessIdentity } from "../../common/access-context.js";
import {
  ACCESS_LOG_LIMITS,
  accessEntry,
  clientIp,
  REDACTED,
  type AccessRequest,
} from "./access-entry.js";

const TENANT = "0193a7c0-0000-7000-8000-000000000001";
const USER = "0193a7c0-0000-7000-8000-000000000002";
const SESSION = "0193a7c0-0000-7000-8000-000000000003";
const PROJECT = "3F2504E0-4F89-41D3-9A0C-0305E82C3301";
const project = PROJECT.toLowerCase();
const occurredAt = new Date("2026-11-16T10:00:00.000Z");

const identity = (overrides: Partial<AccessIdentity> = {}): AccessIdentity => ({
  userId: USER,
  sessionId: SESSION,
  tenantId: TENANT,
  authMethod: "password",
  route: "/api/v1/projects/:id",
  params: { id: PROJECT },
  query: {},
  ...overrides,
});
const request = (overrides: Partial<AccessRequest> = {}): AccessRequest => ({
  identity: identity(),
  method: "get",
  status: 200,
  durationMs: 12.6,
  clientAddress: undefined,
  requestId: "req-12345678",
  occurredAt,
  ...overrides,
});

describe("access-log entries", () => {
  it("record who, the route template, the record IDs and the outcome", () => {
    expect(accessEntry(request())).toEqual({
      tenantId: TENANT,
      userId: USER,
      sessionId: SESSION,
      authMethod: "password",
      method: "GET",
      route: "/api/v1/projects/:id",
      params: { id: project },
      resourceIds: [project],
      status: 200,
      durationMs: 13,
      ipAddress: null,
      requestId: "req-12345678",
      occurredAt,
    });
  });

  it("keep UUID query values, never search text or other query values", () => {
    const entry = accessEntry(
      request({
        identity: identity({
          route: "/api/v1/projects",
          params: {},
          query: {
            search: "Mavuno Homes 0712345678",
            from: "2026-11-01",
            projectId: PROJECT,
            ids: [PROJECT],
            "bad key": PROJECT,
          },
        }),
      }),
    );
    expect(entry?.params).toEqual({ projectId: project });
    expect(entry?.resourceIds).toEqual([project]);
    expect(JSON.stringify(entry)).not.toMatch(/Mavuno|0712345678|2026-11-01/);
  });

  it("redact path values that are not simple IDs and bound how many are kept", () => {
    const many = Object.fromEntries(
      Array.from({ length: 15 }, (_, index) => [
        `p${index}`,
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ]),
    );
    const entry = accessEntry(
      request({ identity: identity({ params: { name: "Jane Wanjiru", splat: ["a"], ...many } }) }),
    )!;
    expect(entry.params["name"]).toBe(REDACTED);
    expect(entry.params["splat"]).toBe(REDACTED);
    expect(Object.keys(entry.params)).toHaveLength(ACCESS_LOG_LIMITS.maxParams);
    expect(entry.resourceIds).toHaveLength(8);
    expect(JSON.stringify(entry)).not.toContain("Wanjiru");
  });

  it("record nothing outside a company or for a malformed method or request ID", () => {
    expect(accessEntry(request({ identity: identity({ tenantId: null }) }))).toBeNull();
    expect(accessEntry(request({ requestId: "has spaces in it" }))).toBeNull();
    expect(accessEntry(request({ requestId: 12_345_678 }))).toBeNull();
    expect(accessEntry(request({ method: "TRACE" }))).toBeNull();
  });

  it("never name another company the person switches to", () => {
    const switching = (id: string) =>
      accessEntry(
        request({
          method: "post",
          identity: identity({ route: "/api/v1/tenants/:id/select", params: { id } }),
        }),
      );
    expect(switching(PROJECT)).toMatchObject({ params: { id: REDACTED }, resourceIds: [] });
    expect(switching(TENANT)).toMatchObject({ params: { id: TENANT }, resourceIds: [TENANT] });
  });

  it("keep only a valid client address, an IPv4-mapped one as IPv4", () => {
    expect(accessEntry(request({ clientAddress: "198.51.100.7" }))?.ipAddress).toBe("198.51.100.7");
    expect(clientIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(clientIp("2001:db8::1")).toBe("2001:db8::1");
    expect(clientIp("203.0.113.9, 10.0.0.1")).toBeNull();
    expect(clientIp(undefined)).toBeNull();
  });
});
