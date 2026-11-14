import { describe, expect, it } from "vitest";
import {
  curveGeometry,
  exceedsQuantity,
  itemLabel,
  parseQuantityInput,
  ratioLabel,
  valuationAccess,
} from "./valuations";

describe("valuation helpers", () => {
  it("parses quantities as typed and refuses what the API would refuse", () => {
    expect(parseQuantityInput(" 12.50 ")).toBe("12.5");
    expect(parseQuantityInput("1,250")).toBe("1250");
    expect(parseQuantityInput("0")).toBe("0");
    expect(parseQuantityInput("12.12345")).toBeNull();
    expect(parseQuantityInput("-1")).toBeNull();
    expect(parseQuantityInput("1e3")).toBeNull();
    expect(parseQuantityInput("")).toBeNull();
    expect(parseQuantityInput("100", true)).toBe("100");
    expect(parseQuantityInput("100.5", true)).toBeNull();
  });

  it("flags an over-measure exactly", () => {
    expect(exceedsQuantity("120.0001", "120")).toBe(true);
    expect(exceedsQuantity("120", "120")).toBe(false);
    expect(exceedsQuantity("99", null)).toBe(false);
  });

  it("shows tabs from the same permission lists as the API", () => {
    expect(valuationAccess(["site.diary", "bq.view"])).toEqual({
      measurements: true,
      certificates: false,
      earnedValue: false,
    });
    expect(valuationAccess(["bq.edit", "finance.view"])).toEqual({
      measurements: true,
      certificates: true,
      earnedValue: true,
    });
    expect(valuationAccess(["bq.view", "portal.client"]).measurements).toBe(false);
  });

  it("draws only the series that have values and labels unavailable ratios", () => {
    const geometry = curveGeometry([
      { weekEnd: "2026-03-08", pvMinor: 0, evMinor: 0, acMinor: 0 },
      { weekEnd: "2026-03-15", pvMinor: 100, evMinor: 80, acMinor: 60 },
      { weekEnd: "2026-03-22", pvMinor: 200, evMinor: null, acMinor: null },
    ]);
    expect(geometry.top).toBe(200);
    expect(geometry.lines.find((line) => line.key === "pv")?.points?.split(" ")).toHaveLength(3);
    expect(geometry.lines.find((line) => line.key === "ev")?.points?.split(" ")).toHaveLength(2);
    expect(curveGeometry([]).lines.every((line) => line.points === null)).toBe(true);
    expect(ratioLabel(null)).toBe("—");
    expect(ratioLabel("1.17")).toBe("1.17");
    expect(itemLabel({ ref: "A", description: "Concrete", bill: { number: "2" } })).toBe("2 · A");
    expect(itemLabel({ ref: null, description: "Lump sum" })).toBe("Lump sum");
  });
});
