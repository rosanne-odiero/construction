import { Ratio } from "../materials/ratio.js";
import { divideRound, fromMicro, toMicro } from "./decimal6.js";

/**
 * Theoretical versus actual material consumption (D5.3, brief §5.2, §5.3 and §15 G). The result is
 * an ESTIMATE for review, never proof of theft: it depends on the measured quantity (incomplete
 * measurement understates it), the build-up's allowances and the recorded issues and returns.
 *
 * theoretical (base unit) = measured quantity × build-up quantity per output unit
 *                           × (1 + waste % ÷ 100) × base units per build-up unit,
 * computed exactly and rounded half-up once to six places.
 * actual = issued to the BQ item − returned from those issues (reversed issues never count).
 * An alert fires when actual is strictly above theoretical × (1 + threshold % ÷ 100).
 */

export type TheoreticalInput = {
  /** Quantity measured to date, in the BQ item's unit (= the build-up's output unit). */
  measuredQuantity: string;
  /** The build-up line's quantity per output unit, in the line's unit. */
  quantityPerUnit: string;
  /** The build-up line's waste allowance (0–100), or null for none. */
  wastePercent: string | null;
  /** How many of the material's base unit make one of the line's unit (exact). */
  basePerUnit: Ratio;
};

/** The theoretical quantity in the material's base unit, six places, half-up. */
export function theoreticalConsumption(input: TheoreticalInput): string {
  const waste = Ratio.fromDecimal(input.wastePercent ?? "0");
  const factor = Ratio.of(100).plus(waste).dividedBy(Ratio.of(100));
  return Ratio.fromDecimal(input.measuredQuantity)
    .times(Ratio.fromDecimal(input.quantityPerUnit))
    .times(factor)
    .times(input.basePerUnit)
    .toDecimal(6).value;
}

export type VarianceInput = {
  theoretical: string;
  issued: string;
  returned: string;
  thresholdPercent: string;
};

export type VarianceResult = {
  /** issued − returned. */
  actual: string;
  /** actual − theoretical (signed). */
  variance: string;
  /** variance ÷ theoretical × 100, one decimal, half away from zero; null when theoretical is 0. */
  variancePercent: string | null;
  /** theoretical × (1 + threshold ÷ 100), six places: the most that can be issued without an alert. */
  limit: string;
  state: "alert" | "within" | "no_progress";
};

const HUNDRED = 100_000_000n;

/** Compares actual consumption with the theoretical quantity and the company threshold. */
export function consumptionVariance(input: VarianceInput): VarianceResult {
  const theoretical = toMicro(input.theoretical);
  const actual = toMicro(input.issued) - toMicro(input.returned);
  const threshold = toMicro(input.thresholdPercent);
  const variance = actual - theoretical;
  const limit = divideRound(theoretical * (HUNDRED + threshold), HUNDRED);
  const base = {
    actual: fromMicro(actual),
    variance: fromMicro(variance),
    limit: fromMicro(limit),
  };
  if (theoretical === 0n)
    return { ...base, variancePercent: null, state: actual > 0n ? "no_progress" : "within" };
  const tenths = divideRound(variance * 1000n, theoretical);
  const negative = tenths < 0n;
  const magnitude = negative ? -tenths : tenths;
  const percent = `${negative ? "-" : ""}${magnitude / 10n}.${magnitude % 10n}`;
  return {
    ...base,
    variancePercent: percent,
    state: actual * HUNDRED > theoretical * (HUNDRED + threshold) ? "alert" : "within",
  };
}

/** What can still be returned from an issued quantity (never below zero). */
export function returnableQuantity(issued: string, returnedSoFar: string): string {
  const left = toMicro(issued) - toMicro(returnedSoFar);
  return fromMicro(left > 0n ? left : 0n);
}

/** A stock-take line's variance: counted − expected (signed). */
export const countVariance = (expected: string, counted: string): string =>
  fromMicro(toMicro(counted) - toMicro(expected));
