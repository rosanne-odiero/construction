import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { navGroups } from "./nav-config";

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
});
