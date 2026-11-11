import { describe, expect, it } from "vitest";
import {
  CONSENT_NOTICE_VERSIONS,
  CURRENT_CONSENT_NOTICE,
  DEFAULT_SKILL_LEVELS,
  DEFAULT_TRADES,
  LABOUR_CONSENT_NOTICES,
  MFA_REQUIRED_PERMISSIONS,
  MINIMUM_LABOURER_AGE_YEARS,
  PROJECT_ASSIGNABLE_PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  TENANT_LEVEL_PERMISSIONS,
  type Permission,
} from "./index.js";

describe("labour vocabulary", () => {
  it("blocks anyone under 18", () => {
    expect(MINIMUM_LABOURER_AGE_YEARS).toBe(18);
  });

  it("ships the brief's fifteen trades and the NCA-aligned skill levels with unique keys", () => {
    expect(DEFAULT_TRADES).toHaveLength(15);
    expect(new Set(DEFAULT_TRADES.map((trade) => trade.key)).size).toBe(15);
    for (const trade of DEFAULT_TRADES) {
      expect(trade.key).toMatch(/^[a-z][a-z0-9_]{1,39}$/);
      expect(trade.nameEn.length).toBeGreaterThan(1);
      expect(trade.nameSw.length).toBeGreaterThan(1);
    }
    expect(DEFAULT_SKILL_LEVELS.map((level) => level.ncaCategory)).toEqual([
      "skilled",
      "semi_skilled",
      "unskilled",
      "supervisor",
    ]);
  });

  it("keeps every consent notice version registered and the latest current", () => {
    expect(LABOUR_CONSENT_NOTICES.map((notice) => notice.version)).toEqual([
      ...CONSENT_NOTICE_VERSIONS,
    ]);
    expect(CURRENT_CONSENT_NOTICE).toBe(LABOUR_CONSENT_NOTICES.at(-1));
    for (const notice of LABOUR_CONSENT_NOTICES) {
      expect(notice.digests.en).toMatch(/^[0-9a-f]{64}$/);
      expect(notice.digests.sw).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("labour permissions", () => {
  const labour: Permission[] = [
    "labour.view",
    "labour.manage",
    "labour.view_sensitive",
    "labour.do_not_rehire",
    "labour.consent",
  ];

  it("are project-scoped, assignable and do not force MFA enrolment", () => {
    for (const permission of labour) {
      expect(PROJECT_ASSIGNABLE_PERMISSIONS).toContain(permission);
      expect(TENANT_LEVEL_PERMISSIONS as readonly Permission[]).not.toContain(permission);
      expect(MFA_REQUIRED_PERMISSIONS as readonly Permission[]).not.toContain(permission);
    }
  });

  it("follow brief §3: managers flag and capture consent, finance reveals for statutory work", () => {
    const has = (role: keyof typeof SYSTEM_ROLE_PERMISSIONS, permission: Permission) =>
      SYSTEM_ROLE_PERMISSIONS[role].includes(permission);
    expect(labour.every((permission) => has("owner", permission))).toBe(true);
    expect(has("project_manager", "labour.do_not_rehire")).toBe(true);
    expect(has("project_manager", "labour.consent")).toBe(true);
    expect(has("project_manager", "labour.view_sensitive")).toBe(false);
    expect(has("site_agent", "labour.consent")).toBe(true);
    expect(has("site_agent", "labour.manage")).toBe(false);
    expect(has("foreman", "labour.consent")).toBe(true);
    expect(has("foreman", "labour.do_not_rehire")).toBe(false);
    expect(has("finance", "labour.view_sensitive")).toBe(true);
    for (const role of ["quantity_surveyor", "storekeeper", "client", "supplier"] as const)
      expect(
        labour.some((permission) => has(role, permission)),
        role,
      ).toBe(false);
  });
});
