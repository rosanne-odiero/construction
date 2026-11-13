import {
  CONVERSION_ROUNDING,
  PROCUREMENT_LIMITS,
  type ConversionSource,
  type DerivedConversionRule,
  type MaterialCategory,
  type UnitDimension,
} from "@pm-buddy/types";
import { derivedEdges, type ConversionEdge, type MaterialAttributes } from "./attributes.js";
import { parseUnsignedDecimal, Ratio } from "./ratio.js";
import { classPairKey, findUnit, STANDARD_UNITS, unitClass, type UnitDefinition } from "./units.js";

/**
 * Unit conversion engine (D5.1, brief §5.3 and §15 G; ARCHITECTURE §4.4).
 *
 * Resolution order: supplier-specific factors, then material-specific factors, then standard ones
 * (exact SI and imperial factors within a dimension, and formulas from the material's attributes
 * such as d²/162 kg/m for steel). A path with fewer explicit (cross-dimension) steps wins; among
 * equally short paths the more specific source wins. A factor for a pair of unit classes shadows
 * less specific factors for the same pair, and a supplier that defines a trip or package unit
 * defines it completely (its "trip" is not the material's "trip"). Crossing dimensions always
 * needs an explicit or attribute factor: there is no universal lorry trip, bag or density.
 *
 * Arithmetic is exact (rational factors on BigInt); a converted quantity is rounded once, half-up,
 * to six decimal places (`CONVERSION_ROUNDING`).
 */

/** An explicit factor as stored: `fromQuantity fromUnit = toQuantity toUnit`, effective-dated. */
export interface ConversionRule {
  id: string;
  /** Null for a material-wide factor; set for one supplier's factor. */
  supplierId: string | null;
  fromUnit: string;
  fromQuantity: string;
  toUnit: string;
  toQuantity: string;
  /** Business dates (YYYY-MM-DD, Africa/Nairobi); `effectiveTo` is exclusive. */
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface ConversionContext {
  customUnits?: readonly UnitDefinition[];
  material?: { category: MaterialCategory; attributes: MaterialAttributes } | null;
  /** The material's explicit factors (material-wide and per supplier). */
  rules?: readonly ConversionRule[];
  /** Use this supplier's factors first. */
  supplierId?: string | null;
  /** The business date the factors must be in force on (YYYY-MM-DD). */
  on: string;
}

export interface ConversionStep {
  from: string;
  to: string;
  /** Exact factor as "numerator/denominator": 1 `from` = factor × `to`. */
  ratio: string;
  /** The factor rounded to 12 decimal places, for display. */
  factor: string;
  source: ConversionSource;
  conversionId: string | null;
  rule: DerivedConversionRule | null;
}

export type ConversionRefusal = "unknown-unit" | "no-conversion" | "path-too-long";
export type QuantityRefusal = "invalid-quantity" | "negative-quantity" | "quantity-too-large";

export type ConversionPath =
  | { ok: true; ratio: Ratio; steps: ConversionStep[] }
  | {
      ok: false;
      reason: ConversionRefusal;
      fromDimension: UnitDimension | null;
      toDimension: UnitDimension | null;
    };

export type ConvertedQuantity =
  | {
      ok: true;
      /** Rounded half-up to six decimal places, trailing zeros removed. */
      quantity: string;
      /** False when rounding changed the value. */
      exact: boolean;
      ratio: Ratio;
      steps: ConversionStep[];
    }
  | { ok: false; reason: ConversionRefusal | QuantityRefusal };

const RANK: Record<ConversionSource, number> = {
  supplier: 0,
  material: 1,
  material_attribute: 2,
  standard: 3,
};
const CROSS_COST = 1_000_000;
const RANK_COST = 1_000;
const MAX_QUANTITY = Ratio.fromDecimal(PROCUREMENT_LIMITS.maxQuantity);

export const ruleInForce = (rule: ConversionRule, on: string) =>
  rule.effectiveFrom <= on && (rule.effectiveTo === null || on < rule.effectiveTo);

const ruleEdge = (rule: ConversionRule, source: "material" | "supplier"): ConversionEdge => ({
  from: rule.fromUnit,
  to: rule.toUnit,
  ratio: Ratio.fromQuantities(rule.fromQuantity, rule.toQuantity),
  source,
  conversionId: rule.id,
  rule: null,
});

/** The factors that apply in `context`, after more specific factors shadow less specific ones. */
export function applicableEdges(context: ConversionContext): ConversionEdge[] {
  const units = context.customUnits ?? [];
  const known = (edge: ConversionEdge) =>
    findUnit(edge.from, units) !== undefined && findUnit(edge.to, units) !== undefined;
  const pairOf = (edge: ConversionEdge) =>
    classPairKey(findUnit(edge.from, units)!, findUnit(edge.to, units)!);
  const inForce = (context.rules ?? []).filter((rule) => ruleInForce(rule, context.on));

  let edges = context.material
    ? derivedEdges(context.material.category, context.material.attributes).filter(known)
    : [];
  const overlay = (upper: ConversionEdge[], shadowUnits: boolean) => {
    const pairs = new Set(upper.map(pairOf));
    const unsizedUnits = new Set(
      upper
        .flatMap((edge) => [edge.from, edge.to])
        .filter((code) => findUnit(code, units)?.perBase === null),
    );
    edges = [
      ...edges.filter(
        (edge) =>
          !pairs.has(pairOf(edge)) &&
          !(shadowUnits && (unsizedUnits.has(edge.from) || unsizedUnits.has(edge.to))),
      ),
      ...upper,
    ];
  };
  overlay(
    inForce
      .filter((rule) => rule.supplierId === null)
      .map((rule) => ruleEdge(rule, "material"))
      .filter(known),
    false,
  );
  if (context.supplierId)
    overlay(
      inForce
        .filter((rule) => rule.supplierId === context.supplierId)
        .map((rule) => ruleEdge(rule, "supplier"))
        .filter(known),
      true,
    );
  return edges;
}

type Hop = {
  to: string;
  ratio: Ratio;
  cost: number;
  edge: Omit<ConversionStep, "factor" | "ratio" | "from" | "to">;
};

const describe = (from: string, to: string, ratio: Ratio, edge: Hop["edge"]): ConversionStep => ({
  from,
  to,
  ratio: ratio.toString(),
  factor: ratio.toDecimal(12).value,
  ...edge,
});

/**
 * The exact factor from one unit to another (1 `from` = ratio × `to`) and the steps used, or why
 * there is none.
 */
export function resolveConversion(
  from: string,
  to: string,
  context: ConversionContext,
): ConversionPath {
  const units = context.customUnits ?? [];
  const fromUnit = findUnit(from, units);
  const toUnit = findUnit(to, units);
  if (!fromUnit || !toUnit)
    return {
      ok: false,
      reason: "unknown-unit",
      fromDimension: fromUnit?.dimension ?? null,
      toDimension: toUnit?.dimension ?? null,
    };
  if (from === to) return { ok: true, ratio: Ratio.ONE, steps: [] };

  const edges = applicableEdges(context);
  // A standard hop (cost 1) only helps when it lands on the target or on a unit with a factor:
  // two standard hops in a row cost more than the direct one. Pruning the rest keeps the search
  // linear in the number of factors rather than quadratic in the number of company units.
  const useful = new Set<string>([to]);
  for (const edge of edges) {
    useful.add(edge.from);
    useful.add(edge.to);
  }
  const sized = [...STANDARD_UNITS, ...units].filter(
    (unit) => unit.perBase !== null && useful.has(unit.code),
  );
  const neighbours = (code: string): Hop[] => {
    const unit = findUnit(code, units)!;
    const hops: Hop[] = [];
    if (unit.perBase)
      for (const other of sized)
        if (other.code !== code && other.dimension === unit.dimension)
          hops.push({
            to: other.code,
            ratio: unit.perBase.dividedBy(other.perBase!),
            cost: 1,
            edge: { source: "standard", conversionId: null, rule: null },
          });
    for (const edge of edges) {
      const meta = { source: edge.source, conversionId: edge.conversionId, rule: edge.rule };
      const cost = CROSS_COST + RANK[edge.source] * RANK_COST;
      if (edge.from === code) hops.push({ to: edge.to, ratio: edge.ratio, cost, edge: meta });
      if (edge.to === code)
        hops.push({ to: edge.from, ratio: edge.ratio.inverse(), cost, edge: meta });
    }
    return hops.sort((left, right) => left.cost - right.cost || (left.to < right.to ? -1 : 1));
  };

  // Dijkstra over a small graph; ties keep the first path found (deterministic order above).
  type Best = { cost: number; ratio: Ratio; steps: ConversionStep[] };
  const best = new Map<string, Best>([[from, { cost: 0, ratio: Ratio.ONE, steps: [] }]]);
  const settled = new Set<string>();
  let tooLong = false;
  for (;;) {
    let current: string | null = null;
    for (const [code, entry] of best)
      if (
        !settled.has(code) &&
        (current === null ||
          entry.cost < best.get(current)!.cost ||
          (entry.cost === best.get(current)!.cost && code < current))
      )
        current = code;
    if (current === null) break;
    const here = best.get(current)!;
    if (current === to) return { ok: true, ratio: here.ratio, steps: here.steps };
    settled.add(current);
    for (const hop of neighbours(current)) {
      if (settled.has(hop.to)) continue;
      if (here.steps.length + 1 > PROCUREMENT_LIMITS.maxConversionSteps) {
        tooLong = true;
        continue;
      }
      const cost = here.cost + hop.cost;
      const known = best.get(hop.to);
      if (known && known.cost <= cost) continue;
      best.set(hop.to, {
        cost,
        ratio: here.ratio.times(hop.ratio),
        steps: [...here.steps, describe(current, hop.to, hop.ratio, hop.edge)],
      });
    }
  }
  return {
    ok: false,
    reason: tooLong ? "path-too-long" : "no-conversion",
    fromDimension: fromUnit.dimension,
    toDimension: toUnit.dimension,
  };
}

/** Validates a quantity string: non-negative, at most six decimals, at most 10¹². */
export function checkQuantity(quantity: string): QuantityRefusal | null {
  if (quantity.trim().startsWith("-")) return "negative-quantity";
  const parsed = parseUnsignedDecimal(quantity);
  if (!parsed || parsed.scale > PROCUREMENT_LIMITS.quantityDecimals) return "invalid-quantity";
  if (Ratio.fromDecimal(quantity).compare(MAX_QUANTITY) > 0) return "quantity-too-large";
  return null;
}

/** Converts a quantity (decimal string) between units, rounding once at the end. */
export function convertQuantity(
  quantity: string,
  from: string,
  to: string,
  context: ConversionContext,
): ConvertedQuantity {
  const refusal = checkQuantity(quantity);
  if (refusal) return { ok: false, reason: refusal };
  const path = resolveConversion(from, to, context);
  if (!path.ok) return { ok: false, reason: path.reason };
  const result = Ratio.fromDecimal(quantity)
    .times(path.ratio)
    .toDecimal(CONVERSION_ROUNDING.decimals);
  return {
    ok: true,
    quantity: result.value,
    exact: result.exact,
    ratio: path.ratio,
    steps: path.steps,
  };
}

export type ConversionRuleIssue =
  "unknown-unit" | "same-unit" | "standard-conversion-exists" | "invalid-quantity";

/**
 * Checks an explicit factor before it is stored and returns the unit-class pair it defines (one
 * factor per pair, scope and date). Units of one sized dimension already convert exactly, so a
 * factor between them (for example 1 t = 990 kg) is refused.
 */
export function checkConversionRule(
  input: Pick<ConversionRule, "fromUnit" | "fromQuantity" | "toUnit" | "toQuantity">,
  customUnits: readonly UnitDefinition[] = [],
): { ok: true; pairKey: string; ratio: Ratio } | { ok: false; issue: ConversionRuleIssue } {
  const fromUnit = findUnit(input.fromUnit, customUnits);
  const toUnit = findUnit(input.toUnit, customUnits);
  if (!fromUnit || !toUnit) return { ok: false, issue: "unknown-unit" };
  if (fromUnit.code === toUnit.code) return { ok: false, issue: "same-unit" };
  if (unitClass(fromUnit) === unitClass(toUnit))
    return { ok: false, issue: "standard-conversion-exists" };
  for (const quantity of [input.fromQuantity, input.toQuantity])
    if (checkQuantity(quantity) || Ratio.fromDecimal(quantity).isZero())
      return { ok: false, issue: "invalid-quantity" };
  return {
    ok: true,
    pairKey: classPairKey(fromUnit, toUnit),
    ratio: Ratio.fromQuantities(input.fromQuantity, input.toQuantity),
  };
}
