import { Decimal } from "decimal.js";
import {
  BUILDUP_OUTPUT_UNITS,
  type BqUnit,
  type BuildupOutputUnit,
  type BuildupResourceKind,
} from "@pm-buddy/types";
import { normaliseUnit } from "./units.js";

/**
 * Rate build-ups (brief §5.2): a named composite rate per unit of work, e.g. "Concrete class 25
 * (1:2:4), per m³", made of material, labour and plant resource lines.
 *
 * Rounding (`bq.buildup.rounding`, FINANCIAL_MODEL): each line's amount is
 * quantity × (1 + waste % / 100) × unit cost, computed exactly with decimals and rounded
 * half-up to the cent once per line; the rate is the sum of the rounded lines. A line without a
 * unit cost leaves the rate undefined ("unavailable"), never a partial figure.
 *
 * Conversions are assumptions, not facts (brief §15 G): a bag of cement is taken as 50 kg only
 * where the build-up says so, sand and ballast are measured in tonnes, and a lorry trip is not a
 * universal mass or volume, so it is never used as a unit here.
 */
export interface BuildupLineInput {
  kind: BuildupResourceKind;
  resourceName: string;
  /** The resource's unit as written (e.g. "bag (50 kg)", "t", "hr"). */
  unit: string;
  /** Quantity of the resource per unit of output (decimal string, up to six places). */
  quantity: string;
  /** Waste allowance in percent (decimal string, 0–100) or null for none. */
  wastePercent: string | null;
  /** Cost per resource unit in KES minor units, or null when not priced yet. */
  unitCostMinor: number | null;
}

export interface BuildupRate {
  /** The rate per unit of output, or null while any line has no unit cost. */
  rateMinor: number | null;
  /** Each line's rounded amount (null for an unpriced line). */
  lineAmountsMinor: (number | null)[];
  /** The sum of the priced lines (shown as a partial figure, never as the rate). */
  pricedMinor: number;
  unpricedLines: number;
  byKind: Record<BuildupResourceKind, number>;
}

/** One line: quantity × (1 + waste/100) × unit cost, rounded half-up to the cent. */
export function buildupLineAmountMinor(
  quantity: string,
  wastePercent: string | null,
  unitCostMinor: number,
): number {
  const factor = new Decimal(1).plus(new Decimal(wastePercent ?? "0").dividedBy(100));
  const result = new Decimal(quantity)
    .times(factor)
    .times(unitCostMinor)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
  if (!Number.isSafeInteger(result)) throw new RangeError("Build-up line amount out of range");
  return result;
}

export function buildupRate(lines: readonly BuildupLineInput[]): BuildupRate {
  const byKind: Record<BuildupResourceKind, number> = { material: 0, labour: 0, plant: 0 };
  let priced = new Decimal(0);
  let unpriced = 0;
  const lineAmountsMinor = lines.map((line) => {
    if (line.unitCostMinor === null) {
      unpriced += 1;
      return null;
    }
    const amount = buildupLineAmountMinor(line.quantity, line.wastePercent, line.unitCostMinor);
    priced = priced.plus(amount);
    byKind[line.kind] += amount;
    return amount;
  });
  const pricedMinor = priced.toNumber();
  if (!Number.isSafeInteger(pricedMinor)) throw new RangeError("Build-up rate out of range");
  return {
    rateMinor: unpriced === 0 && lines.length > 0 ? pricedMinor : null,
    lineAmountsMinor,
    pricedMinor,
    unpricedLines: unpriced,
    byKind,
  };
}

export const isBuildupOutputUnit = (value: string): value is BuildupOutputUnit =>
  (BUILDUP_OUTPUT_UNITS as readonly string[]).includes(value);

export type UnitCompatibility =
  | { ok: true; unit: BuildupOutputUnit }
  | { ok: false; error: "item-unit-missing" | "item-unit-unknown" | "unit-mismatch" };

/**
 * Whether a BQ item can be priced by a build-up: the item's unit, normalised (an unrecognised
 * spelling is normalised again from its original text), must equal the build-up's output unit.
 * Percentages and unknown units are never compatible; nothing is converted.
 */
export function unitsCompatible(
  item: { unit: BqUnit | null; unitRaw: string | null },
  buildupUnit: BuildupOutputUnit,
): UnitCompatibility {
  let unit: BqUnit | null = item.unit;
  if (unit === "other") unit = normaliseUnit(item.unitRaw)?.code ?? "other";
  if (unit === null) return { ok: false, error: "item-unit-missing" };
  if (unit === "other") return { ok: false, error: "item-unit-unknown" };
  if (unit !== buildupUnit) return { ok: false, error: "unit-mismatch" };
  return { ok: true, unit: buildupUnit };
}
