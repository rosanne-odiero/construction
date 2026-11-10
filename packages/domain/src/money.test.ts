import { describe, expect, it } from "vitest";
import { fromMinor, lineAmountMinor, percentOfMinor, sumMinor, toMinor } from "./money.js";

describe("toMinor / fromMinor", () => {
  it("converts decimal strings to integer cents and back", () => {
    expect(toMinor("1250000.50")).toBe(125_000_050);
    expect(toMinor("0")).toBe(0);
    expect(toMinor("-286000")).toBe(-28_600_000);
    expect(fromMinor(125_000_050)).toBe("1250000.50");
    expect(fromMinor(-50)).toBe("-0.50");
  });

  it("refuses to silently round more than two decimal places", () => {
    expect(() => toMinor("1.005")).toThrow(RangeError);
  });

  it("rejects non-decimal input", () => {
    expect(() => toMinor("12,000")).toThrow(TypeError);
    expect(() => fromMinor(1.5)).toThrow(RangeError);
  });
});

describe("lineAmountMinor", () => {
  it("computes BQ line amounts exactly (58 m³ × KES 16,800 = KES 974,400)", () => {
    expect(lineAmountMinor("58", 1_680_000)).toBe(97_440_000);
    expect(lineAmountMinor("12.345", 1_650_000)).toBe(20_369_250);
  });

  it("applies the configured rounding mode at the cent", () => {
    expect(lineAmountMinor("0.325", 100, "half_up")).toBe(33);
    expect(lineAmountMinor("0.325", 100, "half_even")).toBe(32);
  });
});

describe("percentOfMinor", () => {
  it("computes VAT on the Ruiru Heights subtotal (16% of KES 70,050,050)", () => {
    expect(percentOfMinor(7_005_005_000, "16")).toBe(1_120_800_800);
  });

  it("rounds fractional cents", () => {
    expect(percentOfMinor(101, "16")).toBe(16);
    expect(percentOfMinor(1_000_000, "10")).toBe(100_000);
  });
});

describe("sumMinor", () => {
  it("sums integer cents", () => {
    expect(sumMinor([1, 2, 3])).toBe(6);
    expect(sumMinor([])).toBe(0);
  });

  it("throws instead of losing precision", () => {
    expect(() => sumMinor([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
  });
});
