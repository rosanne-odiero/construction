/**
 * Meter readings (decision D-92). Every reading of a plant item — the opening reading at
 * registration, the start and end of each day's usage, the reading at each fuelling and service —
 * must keep the meter monotonic in time: no reading may be lower than one taken earlier, or higher
 * than one taken later, unless a meter reset (a replaced or reset meter, recorded with a reason)
 * lies between them. Each reset starts a new epoch: its old reading closes the previous epoch and
 * its new reading opens the next. `app.check_plant_reading` in migration `20261126090000_plant`
 * applies the same rule in the database.
 *
 * Times are milliseconds since the epoch. A usage day's start reading is taken at Nairobi midnight
 * and its end reading one millisecond before the next midnight, so a fuelling during the day must
 * lie between them.
 */

export type MeterReading = {
  at: number;
  tenths: number;
  /** The usage log, fuel issue or service the reading belongs to (null for the opening reading). */
  sourceId: string | null;
};
export type MeterReset = { id: string; at: number; oldTenths: number; newTenths: number };
export type MeterBounds = { previous: number | null; next: number | null };

const DAY_MS = 86_400_000;

/** Nairobi midnight (UTC+3; Kenya has no daylight saving) at the start of a business date. */
export const plantDayStart = (date: string): number => Date.parse(`${date}T00:00:00.000+03:00`);
/** One millisecond before the next Nairobi midnight. */
export const plantDayEnd = (date: string): number => plantDayStart(date) + DAY_MS - 1;
/** The Nairobi business date of a moment. */
export const plantBusinessDate = (at: number): string =>
  new Date(at + 3 * 3_600_000).toISOString().slice(0, 10);

/** The readings the resets contribute: the old meter's last value and the new meter's first. */
const resetReadings = (resets: readonly MeterReset[]): MeterReading[] =>
  resets.flatMap((reset) => [
    { at: reset.at - 1, tenths: reset.oldTenths, sourceId: null },
    { at: reset.at, tenths: reset.newTenths, sourceId: null },
  ]);

/**
 * The highest reading at or before `at` and the lowest after it, within the same meter epoch;
 * `excludeId` leaves out the record being corrected.
 */
export function meterBounds(
  readings: readonly MeterReading[],
  resets: readonly MeterReset[],
  at: number,
  excludeId: string | null = null,
): MeterBounds {
  let epochStart = -Infinity;
  let epochEnd = Infinity;
  for (const reset of resets) {
    if (reset.at <= at) epochStart = Math.max(epochStart, reset.at);
    else epochEnd = Math.min(epochEnd, reset.at);
  }
  let previous: number | null = null;
  let next: number | null = null;
  for (const reading of [...readings, ...resetReadings(resets)]) {
    if (excludeId !== null && reading.sourceId === excludeId) continue;
    if (reading.at <= at && reading.at >= epochStart)
      previous = previous === null ? reading.tenths : Math.max(previous, reading.tenths);
    else if (reading.at > at && reading.at < epochEnd)
      next = next === null ? reading.tenths : Math.min(next, reading.tenths);
  }
  return { previous, next };
}

/** Whether `tenths` fits between its neighbours in time (see meterBounds). */
export function readingFits(bounds: MeterBounds, tenths: number): boolean {
  return (
    (bounds.previous === null || tenths >= bounds.previous) &&
    (bounds.next === null || tenths <= bounds.next)
  );
}

export type ReadingCheck = { ok: boolean; previous: number | null; next: number | null };

/** One reading at `at`. */
export function checkMeterReading(
  readings: readonly MeterReading[],
  resets: readonly MeterReset[],
  at: number,
  tenths: number,
  excludeId: string | null = null,
): ReadingCheck {
  const bounds = meterBounds(readings, resets, at, excludeId);
  return { ok: readingFits(bounds, tenths), ...bounds };
}

/**
 * A usage day's start and end readings: the start at the day's start, the end at its end (and
 * end ≥ start). `previous` is the bound for the start and `next` the bound for the end.
 */
export function checkUsageReadings(
  readings: readonly MeterReading[],
  resets: readonly MeterReset[],
  usedOn: string,
  startTenths: number,
  endTenths: number,
  excludeId: string | null = null,
): ReadingCheck {
  const start = meterBounds(readings, resets, plantDayStart(usedOn), excludeId);
  const end = meterBounds(readings, resets, plantDayEnd(usedOn), excludeId);
  return {
    ok: endTenths >= startTenths && readingFits(start, startTenths) && readingFits(end, endTenths),
    previous: start.previous,
    next: end.next,
  };
}

/**
 * How far the meter advanced from one reading to a later one, across any resets between them:
 * (first reset's old − from) + (each next reset's old − the previous reset's new) + (to − last
 * reset's new).
 */
export function meterAdvance(
  from: { at: number; tenths: number },
  to: { at: number; tenths: number },
  resets: readonly MeterReset[],
): number {
  const between = resets
    .filter((reset) => reset.at > from.at && reset.at <= to.at)
    .sort((a, b) => a.at - b.at);
  if (!between.length) return to.tenths - from.tenths;
  let total = between[0]!.oldTenths - from.tenths;
  for (let index = 1; index < between.length; index += 1)
    total += between[index]!.oldTenths - between[index - 1]!.newTenths;
  return total + to.tenths - between.at(-1)!.newTenths;
}

/** The latest reading in time (the highest value at that moment), including reset readings. */
export function latestReading(
  readings: readonly MeterReading[],
  resets: readonly MeterReset[],
): { at: number; tenths: number } | null {
  let latest: { at: number; tenths: number } | null = null;
  for (const reading of [...readings, ...resetReadings(resets)])
    if (
      latest === null ||
      reading.at > latest.at ||
      (reading.at === latest.at && reading.tenths > latest.tenths)
    )
      latest = { at: reading.at, tenths: reading.tenths };
  return latest;
}
