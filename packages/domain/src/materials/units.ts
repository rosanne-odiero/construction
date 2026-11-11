import {
  DIMENSION_BASE_UNITS,
  SIZED_DIMENSIONS,
  type SizedDimension,
  type StandardUnitCode,
  type UnitDimension,
} from "@pm-buddy/types";
import { Ratio } from "./ratio.js";

/**
 * A unit and its size. `perBase` is how many of the dimension's base unit one unit holds (a tonne
 * is 1,000 kg, a foot is 0.3048 m exactly); it is null for lorry trips and packages, which have no
 * universal size (brief §15 G) and convert only through explicit material or supplier factors.
 */
export interface UnitDefinition {
  code: string;
  dimension: UnitDimension;
  perBase: Ratio | null;
  standard: boolean;
}

const sized = (code: StandardUnitCode, dimension: SizedDimension, perBase: Ratio) => ({
  code,
  dimension,
  perBase,
  standard: true,
});
const unsized = (code: StandardUnitCode, dimension: "trip" | "package") => ({
  code,
  dimension,
  perBase: null,
  standard: true,
});

/**
 * Standard units. Exact definitions: 1 t = 1,000 kg; 1 g = 1/1,000 kg; a cement bag is 50 kg (and
 * a 25 kg bag for lime, adhesives and the like); 1 ft = 0.3048 m (international foot); 1 l =
 * 1/1,000 m³; a pair is 2 pieces.
 */
export const STANDARD_UNITS: readonly UnitDefinition[] = [
  sized("kg", "mass", Ratio.ONE),
  sized("g", "mass", Ratio.of(1, 1000)),
  sized("t", "mass", Ratio.of(1000)),
  sized("bag_50kg", "mass", Ratio.of(50)),
  sized("bag_25kg", "mass", Ratio.of(25)),
  sized("mm", "length", Ratio.of(1, 1000)),
  sized("m", "length", Ratio.ONE),
  sized("ft", "length", Ratio.fromDecimal("0.3048")),
  sized("m2", "area", Ratio.ONE),
  sized("m3", "volume", Ratio.ONE),
  sized("l", "volume", Ratio.of(1, 1000)),
  sized("nr", "count", Ratio.ONE),
  sized("pair", "count", Ratio.of(2)),
  unsized("trip", "trip"),
  unsized("bag", "package"),
  unsized("sheet", "package"),
  unsized("roll", "package"),
  unsized("bundle", "package"),
  unsized("packet", "package"),
  unsized("box", "package"),
  unsized("drum", "package"),
  unsized("tin", "package"),
  unsized("set", "package"),
];

const STANDARD_BY_CODE = new Map(STANDARD_UNITS.map((unit) => [unit.code, unit]));

/** A company-defined unit, e.g. a 20-litre "debe": `1 debe = 20 l`. Package units have no size. */
export interface CustomUnitInput {
  code: string;
  dimension: UnitDimension;
  /** For sized dimensions: one unit equals `equalsQuantity` of the standard unit `equalsUnit`. */
  equalsQuantity: string | null;
  equalsUnit: string | null;
}

export const isSizedDimension = (dimension: UnitDimension): dimension is SizedDimension =>
  (SIZED_DIMENSIONS as readonly string[]).includes(dimension);

export type CustomUnitIssue =
  "standard-code" | "size-required" | "size-not-allowed" | "size-unit-invalid" | "size-invalid";

/** Checks a company unit; returns the problem or its definition. */
export function defineCustomUnit(
  input: CustomUnitInput,
): { ok: true; unit: UnitDefinition } | { ok: false; issue: CustomUnitIssue } {
  if (STANDARD_BY_CODE.has(input.code)) return { ok: false, issue: "standard-code" };
  if (!isSizedDimension(input.dimension)) {
    if (input.equalsQuantity !== null || input.equalsUnit !== null)
      return { ok: false, issue: "size-not-allowed" };
    return {
      ok: true,
      unit: { code: input.code, dimension: input.dimension, perBase: null, standard: false },
    };
  }
  if (input.equalsQuantity === null || input.equalsUnit === null)
    return { ok: false, issue: "size-required" };
  const reference = STANDARD_BY_CODE.get(input.equalsUnit);
  if (!reference?.perBase || reference.dimension !== input.dimension)
    return { ok: false, issue: "size-unit-invalid" };
  let size: Ratio;
  try {
    size = Ratio.fromDecimal(input.equalsQuantity);
  } catch {
    return { ok: false, issue: "size-invalid" };
  }
  if (size.isZero()) return { ok: false, issue: "size-invalid" };
  return {
    ok: true,
    unit: {
      code: input.code,
      dimension: input.dimension,
      perBase: size.times(reference.perBase),
      standard: false,
    },
  };
}

/** Looks up a unit among the standard units and the company's units. */
export function findUnit(
  code: string,
  customUnits: readonly UnitDefinition[] = [],
): UnitDefinition | undefined {
  return STANDARD_BY_CODE.get(code) ?? customUnits.find((unit) => unit.code === code);
}

/**
 * The class two units must share to convert by standard factors alone: the dimension for sized
 * units, the unit itself for trips and packages.
 */
export function unitClass(unit: UnitDefinition): string {
  return unit.perBase ? `dim:${unit.dimension}` : `unit:${unit.code}`;
}

/** The unordered class pair an explicit conversion connects (one factor per pair per scope). */
export function classPairKey(from: UnitDefinition, to: UnitDefinition): string {
  return [unitClass(from), unitClass(to)].sort().join("|");
}

export const baseUnitOf = (dimension: SizedDimension) => DIMENSION_BASE_UNITS[dimension];
