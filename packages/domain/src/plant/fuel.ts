import type { FuelWindowState } from "@pm-buddy/types";
import { meterAdvance, type MeterReset } from "./meter.js";
import { roundRatio, truncateRatio } from "./quantities.js";

/**
 * Fuel consumption against the standard (decision D-94; the D8.3 done-when "fuel variance
 * flagged"). Uses the full-tank method: fuel put in at a full-tank filling replaces what the
 * machine burned since the previous full-tank filling, so a window runs from one full filling to
 * the next and its actual litres are every issue after the first up to and including the last
 * (part fillings in between are added in). The meter advance over the window (across any meter
 * resets) times the standard consumption gives the expected litres.
 *
 * A window is judged only once it covers the minimum sample (default 10 hours or 100 km): a
 * shorter one is extended to the next full filling, so measuring error on a few litres never
 * raises an alert. A window is **over standard** when actual > expected × (1 + tolerance ÷ 100)
 * (default 15 %). This is an **estimate for review, never proof of theft** (brief §15 G): tank
 * levels, idling, attachments, ground and operator differences all move consumption.
 *
 * Integers throughout: litres, readings and advances in tenths; the standard in hundredths of a
 * litre per hour or km. expected (thousandths of a litre) = advance × standard; the variance
 * percentage is truncated to one decimal place.
 */

export type FuelPoint = {
  id: string;
  at: number;
  litresTenths: number;
  /** Null for plant without a meter (its fuel is logged but cannot be compared). */
  meterTenths: number | null;
  tankFilled: boolean;
  /** The standard consumption in force when the issue was recorded (hundredths of a litre). */
  standardHundredths: number | null;
};

export type FuelWindow = {
  fromId: string;
  toId: string;
  fromAt: number;
  toAt: number;
  /** The issues whose litres count (after the opening full filling, up to the closing one). */
  issueIds: string[];
  litresTenths: number;
  advanceTenths: number;
  /** The closing issue's standard (hundredths of a litre per hour or km). */
  standardHundredths: number | null;
  /** advance × standard, rounded half up to tenths of a litre. */
  expectedTenths: number | null;
  /** Actual litres per hour or km, rounded half up to hundredths. */
  actualRateHundredths: number | null;
  /** (actual − expected) ÷ expected, in tenths of a percent, truncated toward zero. */
  variancePercentTenths: number | null;
  state: FuelWindowState;
};

export type FuelAnalysis = {
  windows: FuelWindow[];
  /** Issues after the last judged window (not yet a full window, or short of the sample). */
  pending: {
    fromId: string | null;
    issueIds: string[];
    litresTenths: number;
    advanceTenths: number;
  };
  /** Fuel issued while the meter had not moved since the previous fuelling. */
  staticIssueIds: string[];
};

export type FuelRules = {
  /** Flag above this percentage over the standard (company setting, default 15). */
  tolerancePercent: number;
  /** The smallest meter advance a window must cover, in tenths (10 h → 100, 100 km → 1000). */
  minSampleTenths: number;
};

const byTime = (a: FuelPoint, b: FuelPoint) =>
  a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Compares one window's litres with the standard. */
export function judgeFuel(
  litresTenths: number,
  advanceTenths: number,
  standardHundredths: number | null,
  rules: FuelRules,
): Pick<FuelWindow, "expectedTenths" | "actualRateHundredths" | "variancePercentTenths" | "state"> {
  if (advanceTenths < rules.minSampleTenths || advanceTenths <= 0)
    return {
      expectedTenths: null,
      actualRateHundredths: null,
      variancePercentTenths: null,
      state: "short_sample",
    };
  const actualRateHundredths = roundRatio(BigInt(litresTenths) * 100n, BigInt(advanceTenths));
  if (!standardHundredths || standardHundredths <= 0)
    return {
      expectedTenths: null,
      actualRateHundredths,
      variancePercentTenths: null,
      state: "within_standard",
    };
  const expectedMilli = BigInt(advanceTenths) * BigInt(standardHundredths);
  const actualMilli = BigInt(litresTenths) * 100n;
  const over = actualMilli * 100n > expectedMilli * BigInt(100 + rules.tolerancePercent);
  return {
    expectedTenths: roundRatio(expectedMilli, 100n),
    actualRateHundredths,
    variancePercentTenths: truncateRatio((actualMilli - expectedMilli) * 1000n, expectedMilli),
    state: over ? "over_standard" : "within_standard",
  };
}

/** Splits a plant item's fuel issues into full-tank windows and finds fuel issued on a static meter. */
export function fuelWindows(
  points: readonly FuelPoint[],
  resets: readonly MeterReset[],
  rules: FuelRules,
): FuelAnalysis {
  const metered = points
    .filter((point): point is FuelPoint & { meterTenths: number } => point.meterTenths !== null)
    .sort(byTime);
  const staticIssueIds: string[] = [];
  for (let index = 1; index < metered.length; index += 1) {
    const previous = metered[index - 1]!;
    const current = metered[index]!;
    const advance = meterAdvance(
      { at: previous.at, tenths: previous.meterTenths },
      { at: current.at, tenths: current.meterTenths },
      resets,
    );
    if (advance <= 0 && current.litresTenths > 0) staticIssueIds.push(current.id);
  }

  const windows: FuelWindow[] = [];
  let boundary: (FuelPoint & { meterTenths: number }) | null = null;
  let pending: (FuelPoint & { meterTenths: number })[] = [];
  const advanceTo = (point: { at: number; meterTenths: number }) =>
    boundary
      ? meterAdvance(
          { at: boundary.at, tenths: boundary.meterTenths },
          { at: point.at, tenths: point.meterTenths },
          resets,
        )
      : 0;
  const litres = (issues: readonly FuelPoint[]) =>
    issues.reduce((total, issue) => total + issue.litresTenths, 0);

  for (const point of metered) {
    if (!boundary) {
      // Fuel before the first full filling cannot be measured: the tank level is unknown.
      if (point.tankFilled) boundary = point;
      continue;
    }
    pending.push(point);
    if (!point.tankFilled) continue;
    const advanceTenths = advanceTo(point);
    if (advanceTenths < rules.minSampleTenths) continue;
    const litresTenths = litres(pending);
    windows.push({
      fromId: boundary.id,
      toId: point.id,
      fromAt: boundary.at,
      toAt: point.at,
      issueIds: pending.map((issue) => issue.id),
      litresTenths,
      advanceTenths,
      standardHundredths: point.standardHundredths,
      ...judgeFuel(litresTenths, advanceTenths, point.standardHundredths, rules),
    });
    boundary = point;
    pending = [];
  }
  const last = pending.at(-1);
  return {
    windows,
    pending: {
      fromId: boundary?.id ?? null,
      issueIds: pending.map((issue) => issue.id),
      litresTenths: litres(pending),
      advanceTenths: last ? advanceTo(last) : 0,
    },
    staticIssueIds,
  };
}
