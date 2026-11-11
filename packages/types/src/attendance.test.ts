import { describe, expect, it } from "vitest";
import {
  ANOMALY_KINDS,
  ANOMALY_SEVERITY,
  CAPTURE_METHODS,
  DEFAULT_PERIOD_SETTINGS,
  DEMO_TIMESHEET_RULE,
  IMPLEMENTED_CAPTURE_METHODS,
  KENYA_PUBLIC_HOLIDAYS,
  MFA_REQUIRED_PERMISSIONS,
  PROJECT_ASSIGNABLE_PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  TENANT_LEVEL_PERMISSIONS,
  TIMESHEET_RULE_LIMITS,
  type Permission,
} from "./index.js";

const isoWeekday = (date: string) => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
};

describe("attendance vocabulary", () => {
  it("implements only the web manual capture method and reserves the others", () => {
    expect(IMPLEMENTED_CAPTURE_METHODS).toEqual(["web_manual"]);
    for (const method of ["qr_card", "face", "fingerprint", "terminal"])
      expect(CAPTURE_METHODS).toContain(method);
  });

  it("gives every anomaly kind a severity", () => {
    for (const kind of ANOMALY_KINDS) expect(ANOMALY_SEVERITY[kind]).toBeDefined();
    expect(ANOMALY_SEVERITY.two_sites).toBe("critical");
    expect(ANOMALY_SEVERITY.manual_override).toBe("info");
  });

  it("seeds the Q-C3 and Q-C4 demonstration values within the rule limits", () => {
    expect(DEMO_TIMESHEET_RULE.normalMinutes).toBe(480);
    expect(DEMO_TIMESHEET_RULE.otWeekdayMultiplier).toBe("1.50");
    expect(DEMO_TIMESHEET_RULE.otRestDayMultiplier).toBe("2.00");
    expect(DEMO_TIMESHEET_RULE.otHolidayMultiplier).toBe("2.00");
    expect(DEMO_TIMESHEET_RULE.sourceReference).toContain("COMPLIANCE-REVIEW");
    for (const key of [
      "normalMinutes",
      "defaultBreakMinutes",
      "breakAfterMinutes",
      "dayStartMinutes",
      "lateGraceMinutes",
      "halfDayThresholdMinutes",
      "maxPlausibleMinutes",
    ] as const) {
      expect(DEMO_TIMESHEET_RULE[key]).toBeGreaterThanOrEqual(TIMESHEET_RULE_LIMITS[key].min);
      expect(DEMO_TIMESHEET_RULE[key]).toBeLessThanOrEqual(TIMESHEET_RULE_LIMITS[key].max);
    }
    expect(DEFAULT_PERIOD_SETTINGS).toEqual({
      frequency: "weekly",
      weekEndsOn: 4,
      cutoffMinutes: 18 * 60,
      paydayWeekday: 5,
    });
  });
});

describe("Kenyan public holiday calendar", () => {
  it("lists unique, sorted 2026 and 2027 dates with sources", () => {
    const dates = KENYA_PUBLIC_HOLIDAYS.map((holiday) => holiday.date);
    expect(new Set(dates).size).toBe(dates.length);
    expect([...dates].sort()).toEqual(dates);
    for (const holiday of KENYA_PUBLIC_HOLIDAYS) {
      expect(holiday.date).toMatch(/^202[67]-\d{2}-\d{2}$/);
      expect(holiday.source.length).toBeGreaterThan(20);
      expect(holiday.nameSw.length).toBeGreaterThan(2);
    }
  });

  it("includes the gazetted 2026 Idd holidays and the fixed Part I days", () => {
    const on = (date: string) => KENYA_PUBLIC_HOLIDAYS.find((holiday) => holiday.date === date);
    expect(on("2026-03-20")?.nameEn).toBe("Idd-ul-Fitr");
    expect(on("2026-05-27")?.nameEn).toBe("Idd-ul-Adha");
    expect(on("2026-10-10")?.nameEn).toBe("Mazingira Day");
    expect(on("2026-12-12")?.nameEn).toBe("Jamhuri Day");
    expect(on("2027-03-26")?.nameEn).toBe("Good Friday");
  });

  it("moves Sunday holidays to Monday (s.4) and never lists a Sunday", () => {
    for (const holiday of KENYA_PUBLIC_HOLIDAYS) expect(isoWeekday(holiday.date)).not.toBe(7);
    const observed = KENYA_PUBLIC_HOLIDAYS.filter((holiday) => holiday.kind === "observed");
    expect(observed.map((holiday) => holiday.date)).toEqual([
      "2027-10-11",
      "2027-12-13",
      "2027-12-27",
    ]);
    for (const holiday of observed) expect(isoWeekday(holiday.date)).toBe(1);
    // Saturdays stay on Saturday (the Act has no Saturday rule).
    expect(isoWeekday("2026-12-12")).toBe(6);
  });
});

describe("attendance and timesheet permissions", () => {
  const added: Permission[] = [
    "attendance.confirm",
    "timesheets.submit",
    "timesheets.approve",
    "timesheets.manage_rules",
  ];

  it("are project-scoped, assignable and do not force MFA", () => {
    for (const permission of added) {
      expect(PROJECT_ASSIGNABLE_PERMISSIONS).toContain(permission);
      expect(TENANT_LEVEL_PERMISSIONS as readonly Permission[]).not.toContain(permission);
      expect(MFA_REQUIRED_PERMISSIONS as readonly Permission[]).not.toContain(permission);
    }
  });

  it("follow brief §3: foremen record, site agents confirm, PMs and finance approve periods", () => {
    const has = (role: keyof typeof SYSTEM_ROLE_PERMISSIONS, permission: Permission) =>
      SYSTEM_ROLE_PERMISSIONS[role].includes(permission);
    expect(added.every((permission) => has("owner", permission))).toBe(true);
    expect(has("foreman", "attendance.record")).toBe(true);
    expect(has("foreman", "attendance.confirm")).toBe(false);
    expect(has("site_agent", "attendance.record")).toBe(true);
    expect(has("site_agent", "attendance.confirm")).toBe(true);
    expect(has("site_agent", "timesheets.submit")).toBe(true);
    expect(has("site_agent", "timesheets.approve")).toBe(false);
    expect(has("project_manager", "attendance.confirm")).toBe(true);
    expect(has("project_manager", "timesheets.approve")).toBe(true);
    expect(has("project_manager", "timesheets.manage_rules")).toBe(true);
    expect(has("finance", "timesheets.approve")).toBe(true);
    expect(has("finance", "attendance.record")).toBe(false);
    for (const role of ["quantity_surveyor", "storekeeper", "client", "supplier"] as const)
      expect(added.some((permission) => has(role, permission))).toBe(false);
  });
});
