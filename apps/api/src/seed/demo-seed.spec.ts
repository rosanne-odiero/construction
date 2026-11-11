import { describe, expect, it } from "vitest";
import { normaliseGeofence, validateGeofence } from "@pm-buddy/domain";
import { assertSeedAllowed, DEMO_ACCOUNTS, DEMO_PROJECTS } from "./demo-seed.js";

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
});
