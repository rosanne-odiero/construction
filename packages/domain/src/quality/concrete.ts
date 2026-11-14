import {
  CUBE_RULE,
  SLUMP_RULE,
  type ConcreteClass,
  type CubeAgeState,
  type CubeOutcome,
  type CubeTestAge,
  type SlumpOutcome,
} from "@pm-buddy/types";
import { addCalendarDays } from "../labour.js";

/**
 * Concrete tests (D6.1, brief §5.9): cube strengths and slump. Strengths are decimal strings in
 * N/mm² with at most one decimal place and are compared in whole tenths, so no binary rounding
 * ever decides a pass or fail. The rules are `CUBE_RULE` and `SLUMP_RULE` in packages/types
 * (COMPLIANCE-REVIEW CR-QA-01/02); migration `20261122100000_quality` re-checks the stored
 * mean and outcome with the same arithmetic.
 */

const STRENGTH = /^(\d{1,3})(?:\.(\d))?$/;

/** "27.5" → 275 tenths of N/mm²; null when the text is not a strength with ≤ 1 decimal. */
export function strengthTenths(value: string): number | null {
  const match = STRENGTH.exec(value);
  if (!match) return null;
  return Number(match[1]) * 10 + Number(match[2] ?? "0");
}

const formatHundredths = (hundredths: number) =>
  `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}`;
const formatTenths = (tenths: number) => `${Math.floor(tenths / 10)}.${tenths % 10}`;

/** The characteristic 28-day cube strength f_cu (N/mm²) a class names: "C25" → 25. */
export const classStrength = (concreteClass: ConcreteClass): number =>
  Number(concreteClass.slice(1));

export type CubeAssessment = {
  /** Mean of the cubes, rounded half up to 0.01 N/mm². */
  meanStrength: string;
  minStrength: string;
  /** Mean as a percentage of f_cu, to 0.1 % (display only). */
  percentOfClass: string;
  outcome: CubeOutcome;
  ruleVersion: typeof CUBE_RULE.version;
};

/**
 * Judges one age's cubes against the class with rule KE-CUBE-1: at 28 days a set passes when the
 * mean is at least f_cu and no cube is below f_cu − 3 N/mm²; at 7 days the result is indicative
 * only (`indicative_low` below 65 % of f_cu). Throws on an empty set or a malformed strength.
 */
export function assessCubes(
  concreteClass: ConcreteClass,
  ageDays: CubeTestAge,
  strengths: readonly string[],
): CubeAssessment {
  const tenths = strengths.map((value) => {
    const parsed = strengthTenths(value);
    if (parsed === null) throw new Error(`Invalid cube strength: ${value}`);
    return parsed;
  });
  if (!tenths.length) throw new Error("A cube result needs at least one cube");
  const count = tenths.length;
  const sum = tenths.reduce((total, value) => total + value, 0);
  const min = Math.min(...tenths);
  const fcu = classStrength(concreteClass);
  // Half up: floor((2·10·sum + n) / 2n) hundredths.
  const meanHundredths = Math.floor((20 * sum + count) / (2 * count));
  // (sum / n / 10) / fcu × 100, in tenths of a percent, half up.
  const percentTenths = Math.floor((2 * 100 * sum + fcu * count) / (2 * fcu * count));
  let outcome: CubeOutcome;
  if (ageDays === 28)
    outcome =
      sum >= fcu * 10 * count && min >= (fcu - CUBE_RULE.individualMarginNmm2) * 10
        ? "pass"
        : "fail";
  else
    outcome =
      sum * 10 < CUBE_RULE.sevenDayIndicativePercent * fcu * count
        ? "indicative_low"
        : "indicative_ok";
  return {
    meanStrength: formatHundredths(meanHundredths),
    minStrength: formatTenths(min),
    percentOfClass: formatTenths(percentTenths),
    outcome,
    ruleVersion: CUBE_RULE.version,
  };
}

/** The day a set's cubes are due to be crushed at `ageDays` (calendar days after casting). */
export const cubeDueDate = (castOn: string, ageDays: CubeTestAge): string =>
  addCalendarDays(castOn, ageDays);

/**
 * Where one age's result stands on `today` (Africa/Nairobi): recorded, not yet due, due (within
 * the grace days after the due date) or overdue.
 */
export function cubeAgeState(input: {
  castOn: string;
  ageDays: CubeTestAge;
  today: string;
  graceDays: number;
  recorded: boolean;
}): CubeAgeState {
  if (input.recorded) return "recorded";
  const due = cubeDueDate(input.castOn, input.ageDays);
  if (input.today < due) return "not_due";
  return input.today <= addCalendarDays(due, input.graceDays) ? "due" : "overdue";
}

/** The tolerance KE-SLUMP-1 suggests for a target slump (BS EN 206 bands). */
export function suggestedSlumpTolerance(targetMm: number): number {
  for (const band of SLUMP_RULE.bands) if (targetMm < band.belowMm) return band.toleranceMm;
  return SLUMP_RULE.otherwiseToleranceMm;
}

/** KE-SLUMP-1: passes when |measured − target| ≤ tolerance (all whole mm). */
export function assessSlump(
  targetMm: number,
  toleranceMm: number,
  measuredMm: number,
): { outcome: SlumpOutcome; deviationMm: number; ruleVersion: typeof SLUMP_RULE.version } {
  const deviationMm = measuredMm - targetMm;
  return {
    outcome: Math.abs(deviationMm) <= toleranceMm ? "pass" : "fail",
    deviationMm,
    ruleVersion: SLUMP_RULE.version,
  };
}
