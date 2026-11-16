/** Canonical JSON for device signatures and request fingerprints (object keys sorted recursively). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Compare the wall clock with a server anchor advanced by monotonic elapsed time. Receipt delay
 * is deliberately excluded: several days offline is not itself clock drift.
 */
export function captureClockDrift(input: {
  serverTime: string;
  anchorMonotonicMs: number;
  anchorBootId: string;
  capturedAt: string;
  monotonicMs: number;
  bootId: string;
}): { driftMs: number | null; flagged: boolean; estimatedAt: string | null } {
  const elapsed = input.monotonicMs - input.anchorMonotonicMs;
  if (input.bootId !== input.anchorBootId || elapsed < 0)
    return { driftMs: null, flagged: true, estimatedAt: null };
  const estimated = Date.parse(input.serverTime) + elapsed;
  const claimed = Date.parse(input.capturedAt);
  if (
    !Number.isFinite(estimated) ||
    Math.abs(estimated) > 8_640_000_000_000_000 ||
    !Number.isFinite(claimed)
  )
    return { driftMs: null, flagged: true, estimatedAt: null };
  const driftMs = claimed - estimated;
  return {
    driftMs,
    flagged: Math.abs(driftMs) > 120_000,
    estimatedAt: new Date(estimated).toISOString(),
  };
}
