import { describe, expect, it } from "vitest";
import {
  isPermission,
  MFA_REQUIRED_ROLES,
  PERMISSIONS,
  problemType,
  SYSTEM_ROLES,
} from "./index.js";

describe("permission catalogue", () => {
  it("uses unique module.action keys", () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const permission of PERMISSIONS) expect(permission).toMatch(/^[a-z]+\.[a-z_]+$/);
  });

  it("guards unknown permissions", () => {
    expect(isPermission("payments.approve")).toBe(true);
    expect(isPermission("payments.steal")).toBe(false);
  });
});

describe("roles", () => {
  it("requires MFA only for known system roles", () => {
    for (const role of MFA_REQUIRED_ROLES) expect(SYSTEM_ROLES).toContain(role);
  });
});

describe("problemType", () => {
  it("builds stable problem type URIs", () => {
    expect(problemType("step-up-required")).toBe("https://pm-buddy.dev/problems/step-up-required");
  });
});
