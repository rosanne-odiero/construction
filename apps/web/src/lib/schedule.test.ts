import { describe, expect, it } from "vitest";
import {
  barGeometry,
  dependencyPath,
  ganttRange,
  monthStarts,
  parseDaysLost,
  restDays,
  scheduleAccess,
  varianceView,
  weekStarts,
  withCitedDiaries,
  ZOOMS,
} from "./schedule";

const range = { start: "2026-02-27", end: "2026-04-03", days: 36 };

describe("gantt geometry", () => {
  it("spans the plan, the baseline, actual dates and today with padding", () => {
    const item = {
      planned: { start: "2026-03-02", finish: "2026-03-20" },
      baseline: { start: "2026-03-02", finish: "2026-03-25" },
      actualStart: "2026-02-28",
      actualFinish: null,
    };
    expect(
      ganttRange({
        dataDate: "2026-03-10",
        start: { date: "2026-03-02", source: "project_start" },
        items: [item as never],
      }),
    ).toEqual({ start: "2026-02-25", end: "2026-04-01", days: 36 });
  });

  it("draws whole days inclusive at each zoom", () => {
    expect(barGeometry(range, "2026-03-02", "2026-03-06", "week")).toEqual({
      x: 3 * ZOOMS.week,
      width: 5 * ZOOMS.week,
    });
    expect(barGeometry(range, "2026-03-02", "2026-03-02", "month")).toEqual({
      x: 3 * ZOOMS.month,
      width: ZOOMS.month,
    });
  });

  it("lists month starts, Mondays and rest days", () => {
    expect(monthStarts(range)).toEqual(["2026-03-01", "2026-04-01"]);
    expect(weekStarts(range).slice(0, 2)).toEqual(["2026-03-02", "2026-03-09"]);
    expect(restDays(range, [1, 2, 3, 4, 5, 6]).slice(0, 2)).toEqual(["2026-03-01", "2026-03-08"]);
  });

  it("routes each dependency type from the right end to the right end", () => {
    const from = { x: 0, width: 50, y: 10 };
    const to = { x: 100, width: 40, y: 46 };
    expect(dependencyPath("FS", from, to)).toBe("M 50 10 H 56 V 28 H 94 V 46 H 100");
    expect(dependencyPath("SS", from, to)).toMatch(/^M 0 10 .* H 100$/);
    expect(dependencyPath("FF", from, to)).toMatch(/^M 50 10 .* H 140$/);
    expect(dependencyPath("SF", from, to)).toMatch(/^M 0 10 .* H 140$/);
  });
});

describe("display helpers", () => {
  it("reads variance as unavailable, on baseline, late or early", () => {
    expect(varianceView(null)).toEqual({ kind: "unavailable" });
    expect(varianceView(0)).toEqual({ kind: "on", days: 0 });
    expect(varianceView(4)).toEqual({ kind: "late", days: 4 });
    expect(varianceView(-2)).toEqual({ kind: "early", days: 2 });
  });

  it("accepts whole and half working days lost only", () => {
    expect(parseDaysLost("2.5")).toBe(2.5);
    expect(parseDaysLost(" 3 ")).toBe(3);
    expect(parseDaysLost("1,5")).toBe(1.5);
    expect(parseDaysLost("1.25")).toBeUndefined();
    expect(parseDaysLost("1.3")).toBeUndefined();
    expect(parseDaysLost("-1")).toBeUndefined();
    expect(parseDaysLost("")).toBeUndefined();
  });
});

describe("diaries a delay can cite", () => {
  it("keeps every diary a delay already cites, even beyond the recent ones", () => {
    const recent = [{ id: "d-new", date: "2026-11-10", site: "Main plot" }];
    const delays = [
      { siteDiary: { id: "d-old", date: "2026-03-02", siteId: "s-1" } },
      { siteDiary: { id: "d-new", date: "2026-11-10", siteId: "s-1" } },
      { siteDiary: null },
    ];
    expect(withCitedDiaries(recent, delays, new Map([["s-1", "Main plot"]]))).toEqual([
      { id: "d-new", date: "2026-11-10", site: "Main plot" },
      { id: "d-old", date: "2026-03-02", site: "Main plot" },
    ]);
    // When the diary list could not be read, the cited diaries are still offered.
    expect(withCitedDiaries([], delays, new Map()).map((diary) => diary.id)).toEqual([
      "d-new",
      "d-old",
    ]);
  });
});

describe("who sees the schedule tab", () => {
  it("hides the schedule from portal-only roles and the delay log from outside parties", () => {
    // Client and supplier roles: project view (and BQ view) plus their portal.
    expect(scheduleAccess(["projects.view", "bq.view", "portal.client"])).toEqual({
      schedule: false,
      delays: false,
    });
    expect(scheduleAccess(["projects.view"])).toEqual({ schedule: false, delays: false });
    // A consultant follows the programme but not the contractor's claim positions.
    expect(scheduleAccess(["projects.view", "bq.view", "reports.view"])).toEqual({
      schedule: true,
      delays: false,
    });
    // Company finance: compensable delays are money, so it reads the log.
    expect(
      scheduleAccess(["projects.view", "finance.view", "finance.manage", "reports.view"]),
    ).toEqual({ schedule: true, delays: true });
    expect(scheduleAccess(["projects.view", "site.diary"])).toEqual({
      schedule: true,
      delays: true,
    });
  });
});
