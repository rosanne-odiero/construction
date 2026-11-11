import { describe, expect, it } from "vitest";
import {
  CONTRACT_TYPES,
  COUNTY_KEYS,
  countyName,
  isProjectAssignablePermission,
  KENYA_COUNTIES,
  MFA_REQUIRED_PERMISSIONS,
  PROJECT_ASSIGNABLE_PERMISSIONS,
  PROJECT_PERMISSIONS,
  PROJECT_STATUSES,
  type Permission,
} from "./index.js";

describe("project vocabulary", () => {
  it("lists Kenya's 47 counties once, in official code order", () => {
    expect(KENYA_COUNTIES).toHaveLength(47);
    expect(KENYA_COUNTIES.map((county) => county.code)).toEqual(
      Array.from({ length: 47 }, (_, index) => index + 1),
    );
    expect(new Set(COUNTY_KEYS).size).toBe(47);
    for (const key of COUNTY_KEYS) expect(key).toMatch(/^[a-z]+(-[a-z]+)*$/);
    expect(countyName("kiambu")).toBe("Kiambu");
    expect(countyName("muranga")).toBe("Murang'a");
    expect(countyName("nairobi")).toBe("Nairobi City");
  });

  it("uses unique snake_case contract types and statuses", () => {
    for (const values of [CONTRACT_TYPES, PROJECT_STATUSES]) {
      expect(new Set(values).size).toBe(values.length);
      for (const value of values) expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe("project-assignable permissions", () => {
  it("are project-scoped catalogue permissions without approval, payment or portal powers", () => {
    for (const permission of PROJECT_ASSIGNABLE_PERMISSIONS)
      expect(PROJECT_PERMISSIONS, permission).toContain(permission);
    for (const permission of MFA_REQUIRED_PERMISSIONS)
      expect(isProjectAssignablePermission(permission), permission).toBe(false);
    for (const excluded of [
      "payments.view",
      "finance.view_sensitive",
      "portal.client",
      "portal.supplier",
      "projects.create",
    ] satisfies Permission[])
      expect(isProjectAssignablePermission(excluded), excluded).toBe(false);
    for (const included of [
      "projects.view",
      "projects.manage",
      "bq.edit",
      "attendance.record",
      "payroll.prepare",
      "payroll.review",
      "procurement.approve",
      "stores.manage",
      "site.diary",
      "documents.manage",
      "reports.view",
      "finance.view",
    ] satisfies Permission[])
      expect(isProjectAssignablePermission(included), included).toBe(true);
  });
});
