import { describe, expect, it } from "vitest";
import { FoundationApiError } from "./foundation-api";
import {
  expenseRetryPlan,
  forecastGeometry,
  minorToInput,
  parseKesInput,
  parseWholeNumber,
  percentLabel,
} from "./spending";

describe("spending input helpers", () => {
  it("trims typed amounts and refuses malformed ones without throwing", () => {
    expect(parseKesInput(" 1250 ")).toBe(125_000);
    expect(parseKesInput("1,250.5")).toBe(125_050);
    expect(parseKesInput("0.75")).toBe(75);
    expect(parseKesInput("0")).toBeNull();
    expect(parseKesInput("0", true)).toBe(0);
    for (const bad of [
      "",
      "1e3",
      "-5",
      "12.345",
      "1,25",
      "KES 5",
      "١٢",
      "Infinity",
      "99999999999999",
    ])
      expect(parseKesInput(bad), bad).toBeNull();
    expect(minorToInput(125_050)).toBe("1250.50");
    expect(minorToInput(125_000)).toBe("1250");
    expect(minorToInput(-75)).toBe("-0.75");
    expect(parseWholeNumber(" 80 ", 1, 100)).toBe(80);
    expect(parseWholeNumber("101", 1, 100)).toBeNull();
    expect(parseWholeNumber("8.5", 1, 100)).toBeNull();
  });

  it("never shows an undefined ratio as zero", () => {
    expect(percentLabel(null)).toBe("—");
    expect(percentLabel("79.9")).toBe("79.9%");
  });

  it("lays out the forecast chart without dividing by zero", () => {
    expect(forecastGeometry([]).bars).toEqual([]);
    const flat = forecastGeometry([
      { start: "2026-11-09", inMinor: 0, outMinor: 0, closingMinor: null },
    ]);
    expect(flat.line).toBeNull();
    expect(Number.isFinite(flat.zeroY)).toBe(true);
    const chart = forecastGeometry([
      { start: "2026-11-09", inMinor: 100, outMinor: 50, closingMinor: 50 },
      { start: "2026-11-16", inMinor: 0, outMinor: 100, closingMinor: -50 },
    ]);
    expect(chart.bars[0]!.inHeight).toBeGreaterThan(0);
    expect(chart.bars[1]!.inHeight).toBe(0);
    expect(chart.bars[1]!.outHeight).toBeGreaterThan(chart.bars[0]!.outHeight);
    expect(chart.points[1]!.y).toBeGreaterThan(chart.zeroY);
    expect(chart.line).toMatch(/^[\d.]+,[\d.]+ [\d.]+,[\d.]+$/);
  });
});

describe("expenseRetryPlan", () => {
  it("never renews the ID and key when they collide with an earlier recorded attempt", () => {
    expect(expenseRetryPlan(new FoundationApiError(409, "idempotency-key-reused"))).toBe(
      "recorded",
    );
    expect(expenseRetryPlan(new FoundationApiError(409, "expense-id-conflict"))).toBe("recorded");
    expect(expenseRetryPlan(new FoundationApiError(409, "float-insufficient"))).toBe("renew");
    expect(expenseRetryPlan(new FoundationApiError(422, "validation-failed"))).toBe("renew");
    expect(expenseRetryPlan(new FoundationApiError(503, "unavailable"))).toBe("keep");
    expect(expenseRetryPlan(new TypeError("Failed to fetch"))).toBe("keep");
  });
});
