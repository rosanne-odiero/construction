import { describe, expect, it } from "vitest";
import {
  nairobiMoment,
  parseOptionalWhole,
  parseTimeInput,
  parseWholeNumber,
  safetyAccess,
  safetyHref,
} from "./safety";

describe("safety screens", () => {
  it("reads a time of day typed on site, trimmed", () => {
    expect(parseTimeInput(" 7:05 ")).toBe("07:05");
    expect(parseTimeInput("14.30")).toBe("14:30");
    for (const bad of ["24:00", "7:60", "7", "", "07:5", "seven"])
      expect(parseTimeInput(bad)).toBeNull();
  });

  it("turns a Nairobi date and time into an ISO moment with the +03:00 offset", () => {
    expect(nairobiMoment("14/11/2026", "08:15")).toBe("2026-11-14T08:15:00+03:00");
    expect(nairobiMoment("31/02/2026", "08:15")).toBeNull();
    expect(nairobiMoment("14/11/2026", "")).toBeNull();
  });

  it("parses whole numbers within bounds and treats an empty optional field as not given", () => {
    expect(parseWholeNumber(" 12 ", 1, 20)).toBe(12);
    expect(parseWholeNumber("21", 1, 20)).toBeNull();
    expect(parseWholeNumber("1.5", 1, 20)).toBeNull();
    expect(parseOptionalWhole("", 5, 240)).toBeUndefined();
    expect(parseOptionalWhole("3", 5, 240)).toBeNull();
    expect(parseOptionalWhole("15", 5, 240)).toBe(15);
  });

  it("applies the API's read rules: site and project staff, never portal-only roles", () => {
    expect(safetyAccess(["projects.view", "site.diary"])).toEqual({
      read: true,
      record: true,
      manage: false,
    });
    expect(safetyAccess(["projects.view", "portal.client"]).read).toBe(false);
    expect(safetyAccess(["projects.view", "reports.view", "bq.view"]).read).toBe(false);
    expect(safetyAccess(["portal.worker"]).read).toBe(false);
    expect(safetyAccess(["projects.view", "projects.manage", "safety.manage"])).toMatchObject({
      read: true,
      manage: true,
    });
  });

  it("keeps the view and filters in the project URL", () => {
    expect(safetyHref("p1", "incidents")).toBe("/projects/p1?tab=safety");
    expect(safetyHref("p1", "actions", { status: "overdue", search: undefined })).toBe(
      "/projects/p1?tab=safety&view=actions&status=overdue",
    );
  });
});
