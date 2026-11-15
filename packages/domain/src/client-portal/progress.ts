/**
 * Progress for the client portal (D7.1, rule D-131). The basis is earned value: approved
 * measurements valued at contract rates on the BQ in force (D6.3), as a share of the measured
 * work's budget at completion (BAC; provisional sums, PC sums and contingencies are not measured).
 * Planned progress is the current schedule baseline's planned value at the same date. Physical
 * progress, certified value and cash received are reported separately; a share of nothing is
 * "not available" (null), never 0 (brief §15 G).
 */

/** `part` as a percentage of `whole` with one decimal place (half up), or null when whole ≤ 0. */
export function progressPercent(part: number | null, whole: number | null): string | null {
  if (part === null || whole === null || whole <= 0) return null;
  if (!Number.isSafeInteger(part) || !Number.isSafeInteger(whole))
    throw new RangeError("Progress is computed on whole minor units");
  const negative = part < 0;
  const scaled = BigInt(Math.abs(part)) * 1_000n;
  const total = BigInt(whole);
  let tenths = scaled / total;
  if ((scaled % total) * 2n >= total) tenths += 1n;
  const text = `${tenths / 10n}.${tenths % 10n}`;
  return negative && tenths > 0n ? `-${text}` : text;
}

export type ClientProgress = {
  /** Earned value ÷ BAC (null without measured work in the BQ). */
  percentComplete: string | null;
  /** Planned value ÷ BAC at the same date (null without a baseline). */
  plannedPercent: string | null;
  /** Percentage points ahead (+) or behind (−) plan; null when either is unavailable. */
  variancePoints: string | null;
};

/** Progress figures from the earned-value inputs (KES minor units at contract rates). */
export function clientProgress(input: {
  bacMinor: number;
  evMinor: number;
  pvMinor: number | null;
}): ClientProgress {
  const percentComplete = progressPercent(input.evMinor, input.bacMinor);
  const plannedPercent = progressPercent(input.pvMinor, input.bacMinor);
  let variancePoints: string | null = null;
  if (percentComplete !== null && plannedPercent !== null) {
    const tenths =
      Math.round(Number(percentComplete) * 10) - Math.round(Number(plannedPercent) * 10);
    const magnitude = Math.abs(tenths);
    variancePoints = `${tenths < 0 ? "-" : ""}${Math.floor(magnitude / 10)}.${magnitude % 10}`;
  }
  return { percentComplete, plannedPercent, variancePoints };
}
