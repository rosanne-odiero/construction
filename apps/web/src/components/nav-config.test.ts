import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isLiveRoute, navGroups } from "./nav-config";

const APP = join(import.meta.dirname, "..", "app");

/** Whether a URL path has a page under src/app (route groups and dynamic segments included). */
function hasPage(dir: string, segments: string[]): boolean {
  const entries = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (segments.length === 0)
    return (
      existsSync(join(dir, "page.tsx")) ||
      entries.some((entry) => /^\(.+\)$/.test(entry.name) && hasPage(join(dir, entry.name), []))
    );
  const [head, ...rest] = segments;
  return entries.some((entry) => {
    const path = join(dir, entry.name);
    if (/^\(.+\)$/.test(entry.name)) return hasPage(path, segments);
    if (entry.name === head || /^\[[^.\]]+\]$/.test(entry.name)) return hasPage(path, rest);
    return false;
  });
}

describe("sidebar", () => {
  it("links only to pages that exist", () => {
    const missing = navGroups
      .flatMap((group) => group.items)
      .filter((item) => !hasPage(APP, item.href.split("/").filter(Boolean)))
      .map((item) => item.href);
    expect(missing).toEqual([]);
  });

  it("treats the subcontract and piece-rate screens as live pages", () => {
    const id = "01a1db46-7d90-7436-b8e8-4582012ff940";
    for (const path of [
      "/subcontracts",
      `/subcontracts/${id}`,
      `/subcontracts/certificates/${id}`,
      `/subcontracts/piece-rate-jobs/${id}`,
      `/subcontracts/projects/${id}`,
      `/subcontracts/projects/${id}/piece-rate`,
      `/subcontracts/projects/${id}/piece-rate/output`,
    ])
      expect(isLiveRoute(path), path).toBe(true);
    expect(isLiveRoute(`/subcontracts/projects/${id}/other`)).toBe(false);
  });

  it("treats the dashboard and the reports centre as live pages, not prototypes", () => {
    for (const path of ["/dashboard", "/reports", "/reports/cost-ledger", "/reports/subscriptions"])
      expect(isLiveRoute(path)).toBe(true);
    expect(isLiveRoute("/reports/cost-ledger/extra")).toBe(false);
  });
});
