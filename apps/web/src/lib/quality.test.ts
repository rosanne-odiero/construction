import { describe, expect, it } from "vitest";
import {
  parseStrengths,
  parseWhole,
  qualityAccess,
  qualityHref,
  slumpToleranceFor,
} from "./quality";

describe("quality input helpers", () => {
  it("reads cube strengths typed on site and refuses anything else", () => {
    expect(parseStrengths(" 27.5, 28  26.8;30 ")).toEqual(["27.5", "28", "26.8", "30"]);
    for (const text of ["", " , ", "27.55", "-1", "150.1", "abc", "1 2 3 4 5 6 7", "1e2"])
      expect(parseStrengths(text), text).toBeNull();
    expect(parseStrengths("150")).toEqual(["150"]);
  });

  it("parses trimmed whole numbers within bounds", () => {
    expect(parseWhole(" 75 ", 10, 250)).toBe(75);
    for (const text of ["", "7.5", "-5", "251", "5", "1e2", " "])
      expect(parseWhole(text, 10, 250), text).toBeNull();
    expect(slumpToleranceFor(" 75")).toBe(20);
    expect(slumpToleranceFor("x")).toBeNull();
  });

  it("applies the API's read and write rules and keeps filters in the URL", () => {
    expect(qualityAccess(["projects.view", "portal.client"])).toEqual({
      read: false,
      record: false,
      review: false,
      propose: false,
    });
    expect(qualityAccess(["projects.view", "site.diary"])).toMatchObject({
      read: true,
      record: true,
      review: false,
    });
    expect(qualityHref("p1", "inspections")).toBe("/projects/p1?tab=quality");
    expect(qualityHref("p1", "snags", { status: "open", search: undefined })).toBe(
      "/projects/p1?tab=quality&view=snags&status=open",
    );
  });
});
