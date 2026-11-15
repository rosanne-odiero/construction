import { describe, expect, it } from "vitest";
import { above, decimalMinorToNumber, nonNegativeQuantity, positiveQuantity } from "./stores";

describe("stores input helpers", () => {
  it("trims typed quantities and refuses malformed ones without throwing", () => {
    expect(positiveQuantity("14 ")).toBe("14");
    expect(positiveQuantity(" 0.5")).toBe("0.5");
    for (const bad of ["0", "1e3", "-1", "1.1234567", "", "12,5", "١٢"])
      expect(positiveQuantity(bad), bad).toBeNull();
    expect(nonNegativeQuantity("0 ")).toBe("0");
    expect(above("abc", "1")).toBe(false);
    expect(above("2", "1.999999")).toBe(true);
  });

  it("rounds six-decimal minor units half away from zero for display", () => {
    expect(decimalMinorToNumber("2400000.5")).toBe(2_400_001);
    expect(decimalMinorToNumber("-2400000.5")).toBe(-2_400_001);
    expect(decimalMinorToNumber("-80000")).toBe(-80_000);
    expect(decimalMinorToNumber("not a number")).toBeNull();
  });
});
