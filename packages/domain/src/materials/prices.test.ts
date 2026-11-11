import { describe, expect, it } from "vitest";
import {
  comparableUnitPrice,
  exactNetPrice,
  isKraPin,
  maskAccountNumber,
  maskKraPin,
  normaliseAccountNumber,
  normaliseKraPin,
  priceChange,
  splitVat,
  type ConversionContext,
} from "../index.js";

const ON = "2026-11-15";

describe("VAT split on recorded prices", () => {
  it("derives net from VAT-inclusive prices and gross from exclusive ones, rounding once", () => {
    expect(splitVat(116_000, "inclusive", "16")).toEqual({
      netMinor: 100_000,
      grossMinor: 116_000,
      ratePercent: "16",
    });
    // 100 × 100 / 116 = 86.2068… → 86
    expect(splitVat(100, "inclusive", "16").netMinor).toBe(86);
    // 87 × 100 / 116 = 75 exactly
    expect(splitVat(87, "inclusive", "16").netMinor).toBe(75);
    expect(splitVat(100_000, "exclusive", "16").grossMinor).toBe(116_000);
    // 99 × 1.16 = 114.84 → 115
    expect(splitVat(99, "exclusive", "16").grossMinor).toBe(115);
    // 25 × 1.16 = 29 exactly; 125 × 1.16 = 145
    expect(splitVat(125, "exclusive", "16").grossMinor).toBe(145);
    expect(splitVat(78_000, "not_applicable", "16")).toEqual({
      netMinor: 78_000,
      grossMinor: 78_000,
      ratePercent: null,
    });
    // A fractional rate (four decimals) stays exact: 1,000 × 100 / 108.5 = 921.658… → 922
    expect(splitVat(1_000, "inclusive", "8.5").netMinor).toBe(922);
  });

  it("refuses non-positive or fractional minor units", () => {
    expect(() => splitVat(0, "inclusive", "16")).toThrow(RangeError);
    expect(() => splitVat(-5, "exclusive", "16")).toThrow(RangeError);
    expect(() => splitVat(1.5, "exclusive", "16")).toThrow(RangeError);
  });
});

describe("comparable prices (net, per base unit)", () => {
  it("compares VAT-inclusive prices on the exact net, rounding only once", () => {
    // 80,000 and 90,000 minor VAT-inclusive: exact nets 68,965.517241… and 77,586.206896…
    expect(exactNetPrice(90_000, "inclusive", "16").toDecimal(6).value).toBe("77586.206897");
    expect(exactNetPrice(90_000, "exclusive", "16").toDecimal(0).value).toBe("90000");
    expect(exactNetPrice(90_000, "not_applicable", "16").toDecimal(0).value).toBe("90000");
    expect(() => exactNetPrice(0, "inclusive", "16")).toThrow(RangeError);
    const cement: ConversionContext = { on: ON, material: { category: "cement", attributes: {} } };
    const before = comparableUnitPrice(
      exactNetPrice(80_000, "inclusive", "16"),
      "bag_50kg",
      "bag_50kg",
      cement,
    );
    const after = comparableUnitPrice(
      exactNetPrice(90_000, "inclusive", "16"),
      "bag_50kg",
      "bag_50kg",
      cement,
    );
    expect(before).toMatchObject({ ok: true, valueMinor: "68965.517241" });
    expect(after).toMatchObject({ ok: true, valueMinor: "77586.206897" });
    // A gross 800 → 900 is +12.5 % net too (the cent-rounded nets would give 12.4989 %).
    expect(
      priceChange(
        (before as { valueMinor: string }).valueMinor,
        (after as { valueMinor: string }).valueMinor,
        "10",
      ),
    ).toEqual({ percent: "12.5", state: "above_threshold" });
  });

  it("expresses a price per base unit through the conversion engine", () => {
    const cement: ConversionContext = { on: ON, material: { category: "cement", attributes: {} } };
    // KES 15,600 per tonne = KES 780 per 50 kg bag
    expect(comparableUnitPrice(1_560_000, "t", "bag_50kg", cement)).toMatchObject({
      ok: true,
      valueMinor: "78000",
    });
    // KES 1,250 per Y12 bar; 1 kg = 3/32 bar → KES 117.1875 per kg
    const y12: ConversionContext = {
      on: ON,
      material: { category: "steel", attributes: { diameterMm: 12 } },
    };
    expect(comparableUnitPrice(125_000, "nr", "kg", y12)).toMatchObject({
      ok: true,
      valueMinor: "11718.75",
    });
    // KES 100 per kg of Y12 bought by the tonne
    expect(comparableUnitPrice(10_000_000, "t", "kg", y12)).toMatchObject({ valueMinor: "10000" });
    // KES 1 per tonne is 0.001 minor units per kg: kept to six places
    expect(comparableUnitPrice(1, "t", "kg", y12)).toMatchObject({ valueMinor: "0.001" });
  });

  it("is not comparable without a conversion (a trip without a factor)", () => {
    const sand: ConversionContext = {
      on: ON,
      material: { category: "aggregates", attributes: {} },
    };
    expect(comparableUnitPrice(2_800_000, "trip", "t", sand)).toEqual({ ok: false });
    const supplier = "60000000-0000-4000-8000-000000000001";
    const withTrip: ConversionContext = {
      ...sand,
      supplierId: supplier,
      rules: [
        {
          id: "s-trip",
          supplierId: supplier,
          fromUnit: "trip",
          fromQuantity: "1",
          toUnit: "t",
          toQuantity: "7",
          effectiveFrom: "2026-01-01",
          effectiveTo: null,
        },
      ],
    };
    // KES 28,000 per 7 t trip = KES 4,000 per tonne
    expect(comparableUnitPrice(2_800_000, "trip", "t", withTrip)).toMatchObject({
      ok: true,
      valueMinor: "400000",
    });
  });
});

describe("price change alerts", () => {
  it("reports the signed change to four places and alerts strictly above the threshold", () => {
    expect(priceChange("1000", "1100", "10")).toEqual({ percent: "10", state: "within_threshold" });
    expect(priceChange("1000", "1100.01", "10")).toEqual({
      percent: "10.001",
      state: "above_threshold",
    });
    expect(priceChange("1000", "900", "10")).toEqual({ percent: "-10", state: "within_threshold" });
    expect(priceChange("1000", "899.99", "10")).toEqual({
      percent: "-10.001",
      state: "above_threshold",
    });
    expect(priceChange("3", "4", "10")).toEqual({ percent: "33.3333", state: "above_threshold" });
    expect(priceChange("1000", "1000", "0")).toEqual({ percent: "0", state: "within_threshold" });
    expect(priceChange("1000", "1000.000001", "0")).toEqual({
      percent: "0",
      state: "above_threshold",
    });
    expect(priceChange("78000", "85800", "10")).toEqual({
      percent: "10",
      state: "within_threshold",
    });
    expect(priceChange("78000", "86000", "10")?.state).toBe("above_threshold");
    expect(priceChange("0", "100", "10")).toBeNull();
    expect(() => priceChange("-1", "100", "10")).toThrow(TypeError);
  });
});

describe("supplier identifiers", () => {
  it("normalises and validates KRA PINs", () => {
    expect(normaliseKraPin("p051 234 567q")).toBe("P051234567Q");
    expect(normaliseKraPin("A-123456789-Z")).toBe("A123456789Z");
    for (const bad of [
      "B051234567Q",
      "P05123456Q",
      "P0512345678",
      "P051234567",
      "P0512345679Q",
      "",
    ])
      expect(normaliseKraPin(bad), bad).toBeNull();
    expect(isKraPin("P051234567Q")).toBe(true);
    expect(isKraPin("p051234567q")).toBe(false);
    expect(maskKraPin("P051234567Q")).toBe("P•••••••67Q");
  });

  it("normalises and masks bank account numbers", () => {
    expect(normaliseAccountNumber("0123 4567 8912-34")).toBe("01234567891234");
    expect(normaliseAccountNumber("1234")).toBeNull();
    expect(normaliseAccountNumber("12345678901234567890123456789012")).toBeNull();
    expect(normaliseAccountNumber("ACC/001")).toBeNull();
    expect(maskAccountNumber("01234567891234")).toBe("••••1234");
    expect(maskAccountNumber("0123456789")).toBe("••••6789");
    // Shorter numbers show only two characters, never most of the number.
    expect(maskAccountNumber("123456789")).toBe("••••89");
    expect(maskAccountNumber("12345")).toBe("••••45");
  });
});
