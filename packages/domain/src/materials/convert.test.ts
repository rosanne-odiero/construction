import { describe, expect, it } from "vitest";
import { STANDARD_UNIT_CODES } from "@pm-buddy/types";
import {
  checkConversionRule,
  convertQuantity,
  defineCustomUnit,
  divideHalfUp,
  findUnit,
  KENYAN_STARTER_CATALOGUE,
  Ratio,
  resolveConversion,
  STANDARD_UNITS,
  steelMassPerMetre,
  type ConversionContext,
  type ConversionRule,
  type MaterialAttributes,
  type UnitDefinition,
} from "../index.js";

/**
 * D5.1 acceptance: "conversions are unit-tested". Expected values are worked out by hand (shown in
 * comments) independently of the engine; a seeded generator adds property-style round trips.
 */

const ON = "2026-11-15";
const SUPPLIER = "60000000-0000-4000-8000-000000000001";
const OTHER_SUPPLIER = "60000000-0000-4000-8000-000000000002";
const plain: ConversionContext = { on: ON };

const rule = (
  id: string,
  from: [string, string],
  to: [string, string],
  extra: Partial<ConversionRule> = {},
): ConversionRule => ({
  id,
  supplierId: null,
  fromQuantity: from[0],
  fromUnit: from[1],
  toQuantity: to[0],
  toUnit: to[1],
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  ...extra,
});

const convert = (quantity: string, from: string, to: string, context = plain) => {
  const result = convertQuantity(quantity, from, to, context);
  if (!result.ok) throw new Error(`${quantity} ${from} → ${to} refused: ${result.reason}`);
  return result;
};
const refusal = (quantity: string, from: string, to: string, context = plain) => {
  const result = convertQuantity(quantity, from, to, context);
  return result.ok ? null : result.reason;
};

const steel = (diameterMm: number, extra: MaterialAttributes = {}): ConversionContext => ({
  on: ON,
  material: { category: "steel", attributes: { diameterMm, ...extra } },
});

/** mulberry32: a tiny seeded generator so the "property" cases are reproducible. */
function generator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randomQuantity = (next: () => number) => {
  const whole = String(Math.floor(next() * 1_000_000_000));
  const decimals = Math.floor(next() * 7);
  const fraction = Array.from({ length: decimals }, () => Math.floor(next() * 10)).join("");
  return fraction ? `${whole}.${fraction}` : whole;
};

describe("exact ratios", () => {
  it("parses decimals exactly and keeps fractions reduced", () => {
    expect(Ratio.fromDecimal("0.3048").toString()).toBe("381/1250");
    expect(Ratio.fromDecimal("12").toString()).toBe("12/1");
    expect(Ratio.fromDecimal("0.000001").toString()).toBe("1/1000000");
    expect(Ratio.fromDecimal("0").isZero()).toBe(true);
    for (const bad of ["-1", "1e3", "1,000", " 1", ".5", "1.", "abc", "", "Infinity", "NaN"])
      expect(() => Ratio.fromDecimal(bad), bad).toThrow(TypeError);
    expect(() => Ratio.of(-1)).toThrow(RangeError);
    expect(() => Ratio.of(1, 0)).toThrow(RangeError);
  });

  it("multiplies, divides, inverts and compares without rounding", () => {
    const foot = Ratio.fromDecimal("0.3048");
    expect(foot.times(foot.inverse()).equals(Ratio.ONE)).toBe(true);
    expect(Ratio.of(144, 162).toString()).toBe("8/9");
    expect(Ratio.of(2, 3).plus(Ratio.of(1, 6)).toString()).toBe("5/6");
    expect(Ratio.of(1, 3).compare(Ratio.of(2, 6))).toBe(0);
    expect(Ratio.of(1, 3).compare(Ratio.of(1, 2))).toBe(-1);
    expect(Ratio.of(3).distance(Ratio.of(5))).toEqual({ value: Ratio.of(2), below: true });
    expect(Ratio.of(1, 8).terminates()).toBe(true);
    expect(Ratio.of(1, 3).terminates()).toBe(false);
    expect(Ratio.parse(Ratio.of(381, 1250).toString()).equals(foot)).toBe(true);
    expect(() => Ratio.ONE.dividedBy(Ratio.of(0))).toThrow(RangeError);
  });

  it("rounds once, half-up, and says whether the result is exact", () => {
    expect(Ratio.of(1, 8).toDecimal(6)).toEqual({ value: "0.125", exact: true });
    expect(Ratio.of(2, 3).toDecimal(6)).toEqual({ value: "0.666667", exact: false });
    expect(Ratio.of(1, 3).toDecimal(6)).toEqual({ value: "0.333333", exact: false });
    expect(Ratio.of(5, 2).toDecimal(0)).toEqual({ value: "3", exact: false });
    expect(Ratio.of(8, 9).toDecimal(3)).toEqual({ value: "0.889", exact: false });
    expect(Ratio.of(7).toDecimal(6, true).value).toBe("7.000000");
    expect(divideHalfUp(5n, 2n)).toBe(3n);
    expect(divideHalfUp(7n, 3n)).toBe(2n);
    expect(divideHalfUp(5n, 3n)).toBe(2n);
    expect(() => divideHalfUp(-1n, 2n)).toThrow(RangeError);
  });

  it("keeps products exact however many factors are chained (property)", () => {
    const next = generator(20261115);
    for (let index = 0; index < 500; index += 1) {
      const factors = Array.from({ length: 1 + Math.floor(next() * 8) }, () =>
        Ratio.fromDecimal(randomQuantity(next).replace(/^0+(?=\d)/, "") || "1"),
      ).filter((factor) => !factor.isZero());
      const product = factors.reduce((acc, factor) => acc.times(factor), Ratio.ONE);
      const undone = factors.reduce((acc, factor) => acc.dividedBy(factor), product);
      expect(undone.equals(Ratio.ONE)).toBe(true);
    }
  });
});

describe("standard units", () => {
  it("defines exactly the catalogue's standard units, one base unit per dimension", () => {
    expect(STANDARD_UNITS.map((unit) => unit.code).sort()).toEqual([...STANDARD_UNIT_CODES].sort());
    for (const code of ["kg", "m", "m2", "m3", "nr"])
      expect(findUnit(code)?.perBase?.equals(Ratio.ONE), code).toBe(true);
    expect(findUnit("trip")).toMatchObject({ dimension: "trip", perBase: null });
    expect(findUnit("bag")).toMatchObject({ dimension: "package", perBase: null });
    expect(findUnit("bag_50kg")?.perBase?.toString()).toBe("50/1");
  });

  it("converts within a dimension by exact factors", () => {
    expect(convert("2.5", "t", "kg")).toMatchObject({ quantity: "2500", exact: true });
    expect(convert("1234.5678", "kg", "t")).toMatchObject({ quantity: "1.234568", exact: false });
    expect(convert("20", "bag_50kg", "t")).toMatchObject({ quantity: "1", exact: true });
    expect(convert("1", "t", "bag_50kg").quantity).toBe("20");
    expect(convert("3", "bag_25kg", "bag_50kg").quantity).toBe("1.5");
    expect(convert("10", "ft", "m")).toMatchObject({ quantity: "3.048", exact: true });
    // 1 / 0.3048 = 3.280839895… → 3.28084 (six places, half-up, trailing zero trimmed)
    expect(convert("1", "m", "ft")).toMatchObject({ quantity: "3.28084", exact: false });
    expect(convert("1500", "mm", "m").quantity).toBe("1.5");
    expect(convert("1000", "l", "m3").quantity).toBe("1");
    expect(convert("0.25", "m3", "l").quantity).toBe("250");
    expect(convert("3", "pair", "nr").quantity).toBe("6");
    expect(convert("1", "g", "t")).toMatchObject({ quantity: "0.000001", exact: true });
    expect(convert("0.4", "g", "t")).toMatchObject({ quantity: "0", exact: false });
  });

  it("returns identity for the same unit and zero for zero", () => {
    expect(convert("12.5", "kg", "kg")).toMatchObject({ quantity: "12.5", exact: true, steps: [] });
    expect(convert("0", "t", "kg")).toMatchObject({ quantity: "0", exact: true });
    expect(convert("0", "trip", "trip").quantity).toBe("0");
  });

  it("avoids binary floating point (0.1 + 0.2 style traps)", () => {
    expect(convert("0.1", "t", "kg").quantity).toBe("100");
    expect(convert("1.005", "t", "kg").quantity).toBe("1005");
    expect(convert("0.3", "ft", "m").quantity).toBe("0.09144");
    expect(convert("4.35", "t", "kg").quantity).toBe("4350");
  });

  it("handles very large values exactly", () => {
    expect(convert("1000000000000", "t", "kg")).toMatchObject({
      quantity: "1000000000000000",
      exact: true,
    });
    // 999,999,999,999.999999 kg = 999,999,999.999999999999 t → 1,000,000,000 at six places
    expect(convert("999999999999.999999", "kg", "t")).toMatchObject({
      quantity: "1000000000",
      exact: false,
    });
  });

  it("refuses negative, malformed, over-precise and oversized quantities", () => {
    expect(refusal("-1", "t", "kg")).toBe("negative-quantity");
    expect(refusal("-0.5", "t", "kg")).toBe("negative-quantity");
    for (const bad of ["1e5", "1,000", "abc", "", "1.", ".5", "NaN", "Infinity", "0x10"])
      expect(refusal(bad, "t", "kg"), bad).toBe("invalid-quantity");
    expect(refusal("1.1234567", "t", "kg")).toBe("invalid-quantity");
    expect(refusal("1000000000000.000001", "t", "kg")).toBe("quantity-too-large");
    expect(refusal("1000000000000", "t", "kg")).toBeNull();
  });

  it("refuses to cross dimensions without an explicit factor", () => {
    expect(refusal("1", "kg", "m")).toBe("no-conversion");
    expect(refusal("1", "m3", "t")).toBe("no-conversion");
    expect(refusal("1", "trip", "t")).toBe("no-conversion");
    expect(refusal("1", "bag", "kg")).toBe("no-conversion");
    expect(refusal("1", "roll", "sheet")).toBe("no-conversion");
    expect(resolveConversion("trip", "t", plain)).toEqual({
      ok: false,
      reason: "no-conversion",
      fromDimension: "trip",
      toDimension: "mass",
    });
    expect(refusal("1", "kg", "furlong")).toBe("unknown-unit");
    expect(resolveConversion("furlong", "kg", plain)).toMatchObject({
      ok: false,
      reason: "unknown-unit",
      fromDimension: null,
      toDimension: "mass",
    });
  });

  it("round-trips within a dimension (property, 2,000 seeded cases)", () => {
    const next = generator(4_449);
    const sized = STANDARD_UNITS.filter((unit) => unit.perBase);
    for (let index = 0; index < 2_000; index += 1) {
      const from = sized[Math.floor(next() * sized.length)]!;
      const peers = sized.filter((unit) => unit.dimension === from.dimension);
      const to = peers[Math.floor(next() * peers.length)]!;
      const quantity = randomQuantity(next);
      const there = convert(quantity, from.code, to.code);
      if (Ratio.fromDecimal(there.quantity).compare(Ratio.fromDecimal("1000000000000")) > 0) {
        // Results above the input limit (10¹²) are refused as inputs, never wrapped or floated.
        expect(refusal(there.quantity, to.code, from.code)).toBe("quantity-too-large");
        continue;
      }
      const back = convert(there.quantity, to.code, from.code);
      // The factors compose to exactly one…
      expect(there.ratio.times(back.ratio).equals(Ratio.ONE)).toBe(true);
      // …and the two roundings stay within half a unit in the sixth place, scaled by the factor.
      const tolerance = Ratio.of(1, 2_000_000).times(back.ratio.plus(Ratio.ONE));
      const error = Ratio.fromDecimal(back.quantity).distance(Ratio.fromDecimal(quantity)).value;
      expect(error.compare(tolerance), `${quantity} ${from.code}→${to.code}`).toBeLessThanOrEqual(
        0,
      );
      if (there.exact && back.exact)
        expect(back.quantity).toBe(Ratio.fromDecimal(quantity).toDecimal(6).value);
    }
  });
});

describe("steel bars (d² / 162 kg/m, 12 m standard bars)", () => {
  const BS4449 = {
    8: "0.395",
    10: "0.617",
    12: "0.888",
    16: "1.579",
    20: "2.466",
    25: "3.854",
    32: "6.313",
  };

  it("uses d²/162 exactly and stays within 0.15 % of the BS 4449 nominal masses", () => {
    expect(steelMassPerMetre(12).toString()).toBe("8/9");
    const shown = Object.fromEntries(
      Object.keys(BS4449).map((d) => [d, steelMassPerMetre(Number(d)).toDecimal(3).value]),
    );
    expect(shown).toEqual({
      8: "0.395",
      10: "0.617",
      12: "0.889",
      16: "1.58",
      20: "2.469",
      25: "3.858",
      32: "6.321",
    });
    for (const [d, table] of Object.entries(BS4449)) {
      const formula = steelMassPerMetre(Number(d));
      const difference = formula
        .distance(Ratio.fromDecimal(table))
        .value.dividedBy(Ratio.fromDecimal(table));
      expect(difference.compare(Ratio.of(15, 10_000)), `Y${d}`).toBeLessThanOrEqual(0);
    }
    expect(() => steelMassPerMetre(0)).toThrow(RangeError);
    expect(() => steelMassPerMetre(12.5)).toThrow(RangeError);
  });

  it("converts bars, metres, kilograms and tonnes", () => {
    // Y12: one 12 m bar = 12 × 8/9 = 10.6666… kg
    expect(convert("1", "nr", "kg", steel(12))).toMatchObject({
      quantity: "10.666667",
      exact: false,
    });
    // 1 t of Y12 = 1,000 / (32/3) = 93.75 bars
    expect(convert("1", "t", "nr", steel(12))).toMatchObject({ quantity: "93.75", exact: true });
    // 1 t of Y16 = 1,000 / (256/162) = 632.8125 m
    expect(convert("1", "t", "m", steel(16))).toMatchObject({ quantity: "632.8125", exact: true });
    // 100 m of Y10 = 100 × 100/162 = 61.728395… kg
    expect(convert("100", "m", "kg", steel(10)).quantity).toBe("61.728395");
    // 50 bars of Y8 = 50 × 12 × 64/162 = 237.037037… kg
    expect(convert("50", "nr", "kg", steel(8)).quantity).toBe("237.037037");
    // 1 bar of Y32 in feet: 12 m / 0.3048 = 39.370078… ft
    expect(convert("1", "nr", "ft", steel(32)).quantity).toBe("39.370079");
    const steps = convert("1", "nr", "kg", steel(12)).steps;
    expect(steps.map((step) => [step.from, step.to, step.source, step.rule])).toEqual([
      ["nr", "m", "material_attribute", "piece_length"],
      ["m", "kg", "material_attribute", "steel_mass_per_metre"],
    ]);
  });

  it("uses a stated bar length, and a material's own kg/m over the formula", () => {
    expect(convert("1", "nr", "m", steel(12, { pieceLengthM: "6" })).quantity).toBe("6");
    const table: ConversionContext = {
      ...steel(12),
      rules: [rule("c-y12", ["1", "m"], ["0.888", "kg"])],
    };
    const result = convert("12", "m", "kg", table);
    expect(result).toMatchObject({ quantity: "10.656", exact: true });
    expect(result.steps).toMatchObject([{ source: "material", conversionId: "c-y12" }]);
  });

  it("has no mass factor without a valid bar diameter", () => {
    expect(refusal("1", "m", "kg", steel(14))).toBe("no-conversion");
    expect(
      refusal("1", "m", "kg", { on: ON, material: { category: "steel", attributes: {} } }),
    ).toBe("no-conversion");
    // A bar diameter on a non-steel material is ignored.
    expect(
      refusal("1", "m", "kg", {
        on: ON,
        material: { category: "plumbing", attributes: { diameterMm: 12 } },
      }),
    ).toBe("no-conversion");
  });
});

describe("lorry trips and supplier-specific factors", () => {
  const sand = (rules: ConversionRule[], supplierId: string | null = null): ConversionContext => ({
    on: ON,
    material: { category: "aggregates", attributes: {} },
    rules,
    supplierId,
  });
  const materialTrip = rule("m-trip", ["1", "trip"], ["7", "t"]);
  const supplierTrip = rule("s-trip", ["1", "trip"], ["10", "t"], { supplierId: SUPPLIER });
  const density = rule("m-density", ["1", "m3"], ["1.6", "t"]);

  it("needs a material or supplier factor for a trip", () => {
    expect(refusal("1", "trip", "t", sand([]))).toBe("no-conversion");
    expect(convert("3", "trip", "kg", sand([materialTrip]))).toMatchObject({
      quantity: "21000",
      exact: true,
    });
    expect(
      convert("3", "trip", "kg", sand([materialTrip])).steps.map((step) => step.source),
    ).toEqual(["material", "standard"]);
  });

  it("prefers the supplier's factor, for that supplier only", () => {
    const rules = [materialTrip, supplierTrip];
    expect(convert("3", "trip", "t", sand(rules, SUPPLIER)).quantity).toBe("30");
    expect(convert("3", "trip", "t", sand(rules, OTHER_SUPPLIER)).quantity).toBe("21");
    expect(convert("3", "trip", "t", sand(rules)).quantity).toBe("21");
    expect(convert("3", "trip", "t", sand(rules, SUPPLIER)).steps).toMatchObject([
      { source: "supplier", conversionId: "s-trip" },
    ]);
    // A supplier factor without a material factor is not used for other suppliers.
    expect(refusal("1", "trip", "t", sand([supplierTrip], OTHER_SUPPLIER))).toBe("no-conversion");
  });

  it("lets a supplier's trip definition replace the material's trip entirely", () => {
    const supplierVolume = rule("s-vol", ["1", "trip"], ["6", "m3"], { supplierId: SUPPLIER });
    const rules = [materialTrip, density, supplierVolume];
    // Supplier: 1 trip = 6 m³, × 1.6 t/m³ = 9.6 t (the material's 7 t trip is not theirs).
    expect(convert("1", "trip", "t", sand(rules, SUPPLIER))).toMatchObject({ quantity: "9.6" });
    expect(
      convert("1", "trip", "t", sand(rules, SUPPLIER)).steps.map((step) => step.conversionId),
    ).toEqual(["s-vol", "m-density"]);
    expect(convert("1", "trip", "t", sand(rules)).quantity).toBe("7");
    // The material's density still converts m³ for that supplier.
    expect(convert("2", "m3", "t", sand(rules, SUPPLIER)).quantity).toBe("3.2");
  });

  it("applies the factor in force on the business date (effective-dated, end exclusive)", () => {
    const rules = [
      rule("old", ["1", "trip"], ["7", "t"], { effectiveTo: "2026-06-01" }),
      rule("new", ["1", "trip"], ["8", "t"], { effectiveFrom: "2026-06-01" }),
    ];
    const at = (on: string) => convertQuantity("1", "trip", "t", { ...sand(rules), on });
    expect(at("2026-05-31")).toMatchObject({ ok: true, quantity: "7" });
    expect(at("2026-06-01")).toMatchObject({ ok: true, quantity: "8" });
    expect(at("2025-12-31")).toEqual({ ok: false, reason: "no-conversion" });
  });

  it("converts in both directions with the inverse factor", () => {
    // 15 t at 7 t per trip = 2.142857… trips
    expect(convert("15", "t", "trip", sand([materialTrip]))).toMatchObject({
      quantity: "2.142857",
      exact: false,
    });
    const there = convert("5", "trip", "t", sand([materialTrip, density]));
    const back = convert(there.quantity, "t", "trip", sand([materialTrip, density]));
    expect(back.quantity).toBe("5");
  });

  it("round-trips through trips, densities and supplier factors (property)", () => {
    const next = generator(7_000);
    const rules = [materialTrip, density, supplierTrip];
    const units = ["trip", "t", "kg", "m3", "l", "bag_50kg"];
    for (let index = 0; index < 1_000; index += 1) {
      const context = sand(rules, next() < 0.5 ? SUPPLIER : null);
      const from = units[Math.floor(next() * units.length)]!;
      const to = units[Math.floor(next() * units.length)]!;
      const quantity = randomQuantity(next);
      const forward = resolveConversion(from, to, context);
      const backward = resolveConversion(to, from, context);
      expect(forward.ok && backward.ok).toBe(true);
      if (forward.ok && backward.ok)
        expect(forward.ratio.times(backward.ratio).equals(Ratio.ONE), `${from}→${to}`).toBe(true);
      expect(convertQuantity(quantity, from, to, context).ok).toBe(true);
    }
  });
});

describe("factors from material attributes", () => {
  it("converts roofing sheets by length and cover width", () => {
    const box: ConversionContext = {
      on: ON,
      material: {
        category: "roofing",
        attributes: { gauge: 30, pieceLengthM: "3", coverWidthM: "0.9" },
      },
    };
    expect(convert("10", "nr", "m", box).quantity).toBe("30");
    expect(convert("10", "nr", "m2", box).quantity).toBe("27");
    expect(convert("100", "m2", "nr", box).quantity).toBe("37.037037");
    // Gauge alone gives no area or piece factor.
    expect(
      refusal("1", "m", "m2", {
        on: ON,
        material: { category: "roofing", attributes: { gauge: 28 } },
      }),
    ).toBe("no-conversion");
  });

  it("converts timber running metres and feet to m³ by section", () => {
    const timber: ConversionContext = {
      on: ON,
      material: { category: "timber", attributes: { sectionWidthMm: "50", sectionDepthMm: "100" } },
    };
    expect(convert("10", "m", "m3", timber)).toMatchObject({ quantity: "0.05", exact: true });
    // 100 ft = 30.48 m × 0.005 m² = 0.1524 m³
    expect(convert("100", "ft", "m3", timber)).toMatchObject({ quantity: "0.1524", exact: true });
    expect(convert("1", "m3", "m", timber).quantity).toBe("200");
  });

  it("converts BRC mesh sheets and rolls to m²", () => {
    const mesh: ConversionContext = {
      on: ON,
      material: {
        category: "brc_mesh",
        attributes: {
          meshType: "A142",
          sheetWidthM: "2.4",
          sheetLengthM: "4.8",
          rollLengthM: "48",
        },
      },
    };
    expect(convert("1", "sheet", "m2", mesh).quantity).toBe("11.52");
    expect(convert("1", "roll", "m2", mesh).quantity).toBe("115.2");
    expect(convert("230.4", "m2", "roll", mesh)).toMatchObject({ quantity: "2", exact: true });
    expect(convert("1", "roll", "sheet", mesh).quantity).toBe("10");
    expect(convert("1", "m2", "sheet", mesh)).toMatchObject({ quantity: "0.086806", exact: false });
  });

  it("converts walling stones per m² with a material factor", () => {
    const stones: ConversionContext = {
      on: ON,
      material: { category: "blocks_stones", attributes: {} },
      rules: [rule("cover", ["1", "m2"], ["12.5", "nr"])],
    };
    expect(convert("20", "m2", "nr", stones).quantity).toBe("250");
    expect(convert("1000", "nr", "m2", stones).quantity).toBe("80");
  });

  it("lets an explicit material factor shadow an attribute formula for the same unit pair", () => {
    const context: ConversionContext = {
      on: ON,
      material: { category: "roofing", attributes: { pieceLengthM: "3" } },
      rules: [rule("measured", ["1", "nr"], ["2.95", "m"])],
    };
    expect(convert("10", "nr", "m", context).quantity).toBe("29.5");
  });
});

describe("company units", () => {
  it("defines sized and package units and refuses invalid definitions", () => {
    const debe = defineCustomUnit({
      code: "debe",
      dimension: "volume",
      equalsQuantity: "20",
      equalsUnit: "l",
    });
    expect(debe.ok && debe.unit.perBase?.toString()).toBe("1/50");
    const karai = defineCustomUnit({
      code: "karai",
      dimension: "package",
      equalsQuantity: null,
      equalsUnit: null,
    });
    expect(karai).toMatchObject({ ok: true, unit: { perBase: null } });
    expect(
      defineCustomUnit({ code: "kg", dimension: "mass", equalsQuantity: "1", equalsUnit: "kg" }),
    ).toEqual({ ok: false, issue: "standard-code" });
    expect(
      defineCustomUnit({ code: "sack", dimension: "mass", equalsQuantity: null, equalsUnit: null }),
    ).toEqual({ ok: false, issue: "size-required" });
    expect(
      defineCustomUnit({
        code: "crate",
        dimension: "package",
        equalsQuantity: "1",
        equalsUnit: "nr",
      }),
    ).toEqual({ ok: false, issue: "size-not-allowed" });
    expect(
      defineCustomUnit({ code: "sack", dimension: "mass", equalsQuantity: "90", equalsUnit: "l" }),
    ).toEqual({ ok: false, issue: "size-unit-invalid" });
    expect(
      defineCustomUnit({ code: "sack", dimension: "mass", equalsQuantity: "0", equalsUnit: "kg" }),
    ).toEqual({ ok: false, issue: "size-invalid" });
    expect(
      defineCustomUnit({ code: "sack", dimension: "mass", equalsQuantity: "-3", equalsUnit: "kg" }),
    ).toEqual({ ok: false, issue: "size-invalid" });
  });

  it("converts with company units like standard ones", () => {
    const debe = defineCustomUnit({
      code: "debe",
      dimension: "volume",
      equalsQuantity: "20",
      equalsUnit: "l",
    });
    const customUnits = [debe.ok ? debe.unit : null].filter(Boolean) as UnitDefinition[];
    expect(convert("50", "debe", "m3", { on: ON, customUnits })).toMatchObject({
      quantity: "1",
      exact: true,
    });
    expect(convert("1", "m3", "debe", { on: ON, customUnits }).quantity).toBe("50");
    expect(refusal("1", "debe", "m3")).toBe("unknown-unit");
  });

  it("stays fast and exact with thousands of company units", () => {
    // u0000 = 1 kg … u2999 = 3,000 kg; one supplier trip carries 7 × u0999 (7 t).
    const customUnits = Array.from({ length: 3_000 }, (_, index) => {
      const defined = defineCustomUnit({
        code: `u${String(index).padStart(4, "0")}`,
        dimension: "mass",
        equalsQuantity: String(index + 1),
        equalsUnit: "kg",
      });
      if (!defined.ok) throw new Error(defined.issue);
      return defined.unit;
    });
    const context: ConversionContext = {
      on: ON,
      customUnits,
      supplierId: SUPPLIER,
      rules: [rule("trip", ["1", "trip"], ["7", "u0999"], { supplierId: SUPPLIER })],
    };
    const started = Date.now();
    expect(refusal("1", "kg", "trip", { on: ON, customUnits })).toBe("no-conversion");
    // 2 trips = 14 × 1,000 kg; one trip is 3,500 × u0001 (2 kg).
    expect(convert("2", "trip", "kg", context)).toMatchObject({ quantity: "14000", exact: true });
    expect(convert("1", "trip", "u0001", context).quantity).toBe("3500");
    expect(convert("1", "trip", "t", context).steps.map((step) => step.to)).toEqual(["u0999", "t"]);
    // Measured before pruning: about 1.4 s for one refusal at this size (quadratic).
    expect(Date.now() - started).toBeLessThan(300);
  });
});

describe("explicit factor checks", () => {
  it("refuses same-unit, same-dimension, unknown and non-positive factors", () => {
    const check = (from: [string, string], to: [string, string]) =>
      checkConversionRule({
        fromQuantity: from[0],
        fromUnit: from[1],
        toQuantity: to[0],
        toUnit: to[1],
      });
    expect(check(["1", "t"], ["1", "t"])).toEqual({ ok: false, issue: "same-unit" });
    expect(check(["1", "t"], ["990", "kg"])).toEqual({
      ok: false,
      issue: "standard-conversion-exists",
    });
    expect(check(["1", "bag_50kg"], ["45", "kg"])).toEqual({
      ok: false,
      issue: "standard-conversion-exists",
    });
    expect(check(["1", "m"], ["3", "ft"])).toEqual({
      ok: false,
      issue: "standard-conversion-exists",
    });
    expect(check(["1", "trip"], ["7", "furlong"])).toEqual({ ok: false, issue: "unknown-unit" });
    expect(check(["0", "trip"], ["7", "t"])).toEqual({ ok: false, issue: "invalid-quantity" });
    expect(check(["1", "trip"], ["-7", "t"])).toEqual({ ok: false, issue: "invalid-quantity" });
    expect(check(["1", "trip"], ["7.1234567", "t"])).toEqual({
      ok: false,
      issue: "invalid-quantity",
    });
    const ok = check(["1", "trip"], ["7", "t"]);
    expect(ok.ok && ok.pairKey).toBe("dim:mass|unit:trip");
    expect(ok.ok && ok.ratio.toString()).toBe("7/1");
    // The pair is unordered: t → trip names the same pair.
    const reversed = check(["7", "t"], ["1", "trip"]);
    expect(reversed.ok && reversed.pairKey).toBe("dim:mass|unit:trip");
    expect(check(["1", "roll"], ["10", "sheet"])).toMatchObject({
      ok: true,
      pairKey: "unit:roll|unit:sheet",
    });
  });
});

describe("Kenyan starter catalogue", () => {
  it("uses known base units and valid, assumption-labelled factors (never a lorry trip)", () => {
    const names = new Set<string>();
    for (const material of KENYAN_STARTER_CATALOGUE) {
      expect(findUnit(material.baseUnit), material.name).toBeDefined();
      expect(names.has(material.name.toLowerCase()), material.name).toBe(false);
      names.add(material.name.toLowerCase());
      for (const conversion of material.conversions) {
        expect(checkConversionRule(conversion).ok, `${material.name}: ${conversion.note}`).toBe(
          true,
        );
        expect([conversion.fromUnit, conversion.toUnit]).not.toContain("trip");
        expect(conversion.note.length).toBeGreaterThan(5);
      }
    }
    expect(
      KENYAN_STARTER_CATALOGUE.filter((material) => material.category === "steel"),
    ).toHaveLength(7);
  });

  it("converts every starter material's pieces to its base unit where a factor exists", () => {
    const y12 = KENYAN_STARTER_CATALOGUE.find((material) =>
      material.name.startsWith("Steel bar Y12"),
    )!;
    const context: ConversionContext = { on: ON, material: y12 };
    expect(convert("1", "nr", y12.baseUnit, context).quantity).toBe("10.666667");
    const cable = KENYAN_STARTER_CATALOGUE.find((material) => material.category === "electrical")!;
    const rules = cable.conversions.map((conversion, index) =>
      rule(
        `d${index}`,
        [conversion.fromQuantity, conversion.fromUnit],
        [conversion.toQuantity, conversion.toUnit],
      ),
    );
    expect(convert("3", "roll", "m", { on: ON, material: cable, rules }).quantity).toBe("300");
  });
});
