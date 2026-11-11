import { describe, expect, it } from "vitest";
import {
  activeView,
  filtersFromSearchParams,
  isMasked,
  labourQuery,
  registryHref,
  sameFilters,
  viewFilters,
} from "./labour";

describe("labour registry filters", () => {
  it("reads valid filters and drops malformed ones", () => {
    expect(
      filtersFromSearchParams({
        status: "active",
        accreditation: "attention",
        tradeId: "not-a-uuid",
        search: "  wanjiku ",
        offset: "50",
      }),
    ).toEqual({ status: "active", accreditation: "attention", search: "wanjiku" });
    expect(filtersFromSearchParams({ status: ["active", "left"] })).toEqual({});
  });

  it("never takes an identifier-like search from the URL", () => {
    for (const search of ["23456789", "0712 345 678", "A012345678Z"])
      expect(filtersFromSearchParams({ search, status: "active" }), search).toEqual({
        status: "active",
      });
    expect(filtersFromSearchParams({ search: "WRK-0012" })).toEqual({ search: "WRK-0012" });
    expect(viewFilters({ search: "kamau", status: "active" })).toEqual({ status: "active" });
  });

  it("builds stable query strings and hrefs", () => {
    expect(labourQuery({ status: "active", search: "kamau" })).toBe("search=kamau&status=active");
    expect(registryHref({}, { worker: "abc" })).toBe("/labour?worker=abc");
    expect(registryHref({})).toBe("/labour");
    expect(sameFilters({ status: "active" }, { status: "active" })).toBe(true);
    expect(sameFilters({}, { status: "active" })).toBe(false);
  });

  it("finds the view matching the current filters", () => {
    const views = [
      { id: "all", name: "All", builtIn: true, filters: {} },
      { id: "active", name: "Active", builtIn: true, filters: { status: "active" as const } },
    ];
    expect(activeView(views, { status: "active" })?.id).toBe("active");
    expect(activeView(views, { status: "left" })).toBeNull();
    // Search text narrows a view; the view stays highlighted.
    expect(activeView(views, { status: "active", search: "kamau" })?.id).toBe("active");
  });

  it("treats only bullet masks as masked", () => {
    expect(isMasked("2547•••••001")).toBe(true);
    expect(isMasked(null)).toBe(true);
    expect(isMasked("254700000001")).toBe(false);
  });
});
