import { describe, expect, it } from "vitest";
import { buildupRate, normaliseGeofence, validateGeofence } from "@pm-buddy/domain";
import { assertSeedAllowed, DEMO_ACCOUNTS, DEMO_BUILDUP, DEMO_PROJECTS } from "./demo-seed.js";

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

  it("ships a build-up example that is clearly synthetic and fully priced", () => {
    expect(DEMO_BUILDUP.name).toMatch(/synthetic/i);
    expect(DEMO_BUILDUP.assumptions).toMatch(/^SYNTHETIC EXAMPLE VALUES/);
    expect(DEMO_BUILDUP.lines.some((line) => /lorry|trip/i.test(line.unit))).toBe(false);
    // 6.5×1.05×850 + 0.7×1.1×2,500 + 1.4×1.05×2,200 + 4.5×350 + 0.5×1,500 = KES 13,285.25
    expect(buildupRate(DEMO_BUILDUP.lines).rateMinor).toBe(1_328_525);
  });
});
