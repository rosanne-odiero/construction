import { describe, expect, it } from "vitest";
import { formatDecimal, formatMinor } from "./bq-export.service.js";

describe("export number formatting", () => {
  it("formats minor units exactly with KES grouping", () => {
    expect(formatMinor(3_864_718_875)).toBe("38,647,188.75");
    expect(formatMinor(713)).toBe("7.13");
    expect(formatMinor(5)).toBe("0.05");
    expect(formatMinor(-28_600_000)).toBe("−286,000.00");
    expect(formatMinor(9_007_199_254_740_991)).toBe("90,071,992,547,409.91");
  });

  it("groups decimal quantities without changing their digits", () => {
    expect(formatDecimal("12345.5")).toBe("12,345.5");
    expect(formatDecimal("0.0001")).toBe("0.0001");
    expect(formatDecimal(null)).toBe("");
  });
});
