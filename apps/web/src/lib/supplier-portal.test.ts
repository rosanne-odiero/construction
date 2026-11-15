import { describe, expect, it } from "vitest";
import { newTimeOrderedId, statementPeriod, statementSearch } from "./supplier-portal";

describe("statementPeriod", () => {
  const today = "2026-11-14";

  it("defaults to the 90 days up to today, as the API does", () => {
    expect(statementPeriod({}, today)).toEqual({ from: "2026-08-17", to: today });
    expect(statementPeriod({ to: "2026-10-31" }, today)).toEqual({
      from: "2026-08-03",
      to: "2026-10-31",
    });
    // A start after today runs to that start (one day), never backwards.
    expect(statementPeriod({ from: "2026-12-01" }, today)).toEqual({
      from: "2026-12-01",
      to: "2026-12-01",
    });
  });

  it("refuses inverted, malformed and over-long periods", () => {
    expect(statementPeriod({ from: "2026-11-14", to: "2026-11-13" }, today)).toBeNull();
    expect(statementPeriod({ from: "14/11/2026" }, today)).toBeNull();
    // 1,096 days inclusive is the limit.
    expect(statementPeriod({ from: "2023-11-15", to: today }, today)).toEqual({
      from: "2023-11-15",
      to: today,
    });
    expect(statementPeriod({ from: "2023-11-14", to: today }, today)).toBeNull();
  });
});

describe("statementSearch", () => {
  it("keeps only the filters that are set, in a stable order", () => {
    expect(statementSearch({})).toBe("");
    expect(
      statementSearch({ locale: "sw", to: "2026-11-14", from: "2026-11-01", projectId: "p" }),
    ).toBe("?projectId=p&from=2026-11-01&to=2026-11-14&locale=sw");
  });
});

describe("newTimeOrderedId", () => {
  it("is a version 7 UUID that sorts by time", () => {
    const earlier = newTimeOrderedId(Date.UTC(2026, 10, 14, 6, 0, 0));
    const later = newTimeOrderedId(Date.UTC(2026, 10, 14, 6, 0, 1));
    expect(earlier).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(earlier.slice(0, 13)).toBe("01a1d8a4-2b00");
    expect(later > earlier).toBe(true);
  });
});
