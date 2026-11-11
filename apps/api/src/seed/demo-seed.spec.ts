import { describe, expect, it } from "vitest";
import {
  isOldEnoughToRegister,
  normaliseGeofence,
  normaliseIdNumber,
  normaliseKraPin,
  normalizeKenyanPhone,
  validateGeofence,
} from "@pm-buddy/domain";
import { assertSeedAllowed, DEMO_ACCOUNTS, DEMO_PROJECTS } from "./demo-seed.js";
import { DEMO_DAY_RATES_KES, DEMO_GANGS, DEMO_LABOURERS, demoIdentifiers } from "./labour-seed.js";

describe("development seed", () => {
  it("refuses to run in production", () => {
    expect(() => assertSeedAllowed("production")).toThrow(/NODE_ENV is production/);
    expect(() => assertSeedAllowed("development")).not.toThrow();
    expect(() => assertSeedAllowed(undefined)).not.toThrow();
  });

  it("uses synthetic identities only", () => {
    for (const account of DEMO_ACCOUNTS) expect(account.identifier).toMatch(/\.example\.test$/);
    for (const project of DEMO_PROJECTS) {
      if (project.clientEmail) expect(project.clientEmail).toMatch(/@([a-z-]+\.)?example\.test$/);
      // Ofcom reserves 07700 900000–900999 for fiction.
      if (project.clientPhone) expect(project.clientPhone).toMatch(/^\+447700900\d{3}$/);
    }
  });

  it("ships only valid geofences and complete WBS weights", () => {
    for (const project of DEMO_PROJECTS) {
      for (const site of project.sites)
        expect(validateGeofence(normaliseGeofence(site.geofence)), site.name).toEqual([]);
      const sum = (nodes: { weight: number }[]) =>
        nodes.reduce((total, node) => total + node.weight, 0);
      if (project.wbs.length) expect(sum(project.wbs), project.code).toBe(10_000);
      for (const node of project.wbs)
        if (node.children) expect(sum(node.children), node.code).toBe(10_000);
    }
  });

  it("seeds 40 synthetic adult labourers with synthetic identifiers", () => {
    expect(DEMO_LABOURERS).toHaveLength(40);
    expect(new Set(DEMO_LABOURERS.map((labourer) => labourer.fullName)).size).toBe(40);
    const projects = new Set(DEMO_PROJECTS.map((project) => project.code));
    const gangs = new Set<string>(DEMO_GANGS.map((gang) => gang.name));
    for (const [index, labourer] of DEMO_LABOURERS.entries()) {
      expect(isOldEnoughToRegister(labourer.dateOfBirth, "2026-11-11"), labourer.fullName).toBe(
        true,
      );
      for (const code of labourer.projects) expect(projects.has(code)).toBe(true);
      if (labourer.gang) expect(gangs.has(labourer.gang)).toBe(true);
      const ids = demoIdentifiers(index + 1);
      expect(normaliseIdNumber("national_id", ids.idNumber)).toMatch(/^9000\d{4}$/);
      expect(normalizeKenyanPhone(ids.phone)).toMatch(/^2547000000\d{2}$/);
      expect(normaliseKraPin(ids.kraPin)).toBe(ids.kraPin);
    }
    expect(DEMO_LABOURERS.filter((labourer) => labourer.doNotRehire)).toHaveLength(1);
    const expiries = DEMO_LABOURERS.flatMap((labourer) =>
      labourer.ncaExpiresInDays === undefined ? [] : [labourer.ncaExpiresInDays],
    );
    expect(expiries.filter((days) => days < 0).length).toBeGreaterThanOrEqual(2);
    expect(expiries.filter((days) => days >= 0 && days <= 30).length).toBeGreaterThanOrEqual(3);
    // Every gang has exactly one leader.
    for (const gang of DEMO_GANGS)
      expect(
        DEMO_LABOURERS.filter((labourer) => labourer.gang === gang.name && labourer.leads),
      ).toHaveLength(1);
    for (const kes of Object.values(DEMO_DAY_RATES_KES)) expect(Number.isInteger(kes)).toBe(true);
  });
});
