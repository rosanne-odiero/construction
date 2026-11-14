import { describe, expect, it } from "vitest";
import type { Permission } from "@pm-buddy/types";
import { ReportCaller, type ReportProject } from "./reports-access.js";

const project = (id: string, effective: Permission[], status = "active"): ReportProject => ({
  id,
  code: id.toUpperCase(),
  name: id,
  status: status as ReportProject["status"],
  effective: new Set(effective),
});
const caller = (
  projects: ReportProject[],
  role: Permission[] = ["reports.view", "projects.view"],
  tenantWide = false,
) => new ReportCaller("user", tenantWide, new Set(role), new Map(projects.map((p) => [p.id, p])));

describe("ReportCaller.fingerprint (the dashboard cache key)", () => {
  it("is the same for the same access, whatever the order", () => {
    expect(
      caller([project("a", ["projects.view", "reports.view"]), project("b", ["projects.view"])])
        .fingerprint,
    ).toBe(
      caller(
        [project("b", ["projects.view"]), project("a", ["reports.view", "projects.view"])],
        ["projects.view", "reports.view"],
      ).fingerprint,
    );
  });

  it("changes with any change of access, so a cached dashboard is never reused after one", () => {
    const base = caller([project("a", ["projects.view", "reports.view"])]).fingerprint;
    for (const changed of [
      caller([project("a", ["projects.view"])]),
      caller([project("a", ["projects.view", "reports.view"]), project("b", ["projects.view"])]),
      caller([project("a", ["projects.view", "reports.view"], "closed")]),
      caller([project("a", ["projects.view", "reports.view"])], ["reports.view"]),
      caller([project("a", ["projects.view", "reports.view"])], undefined, true),
    ])
      expect(changed.fingerprint).not.toBe(base);
  });
});
