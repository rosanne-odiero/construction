import { describe, expect, it } from "vitest";
import { ageOn, meetsMinimumAge } from "./age.js";

describe("ageOn", () => {
  it("counts the birthday itself", () => {
    expect(ageOn("2008-11-10", "2026-11-10")).toBe(18);
    expect(ageOn("2008-11-11", "2026-11-10")).toBe(17);
  });

  it("handles leap-day birthdays", () => {
    expect(ageOn("2008-02-29", "2026-02-28")).toBe(17);
    expect(ageOn("2008-02-29", "2026-03-01")).toBe(18);
  });

  it("rejects non ISO dates", () => {
    expect(() => ageOn("14/03/2009", "2026-11-10")).toThrow(TypeError);
  });
});

describe("meetsMinimumAge", () => {
  it("blocks registration of anyone under 18 by default", () => {
    expect(meetsMinimumAge("2009-03-14", "2026-11-10")).toBe(false);
    expect(meetsMinimumAge("1990-01-01", "2026-11-10")).toBe(true);
  });

  it("uses the configured minimum", () => {
    expect(meetsMinimumAge("2009-03-14", "2026-11-10", 16)).toBe(true);
  });
});
