import { describe, expect, it } from "vitest";
import { canonicalJson, captureClockDrift } from "./capture.js";

describe("signed attendance clocks", () => {
  const anchor = {
    serverTime: "2026-11-15T04:00:00Z",
    anchorMonotonicMs: 2000,
    anchorBootId: "boot",
    bootId: "boot",
    monotonicMs: 2000 + 48 * 3_600_000,
    capturedAt: "2026-11-17T04:00:00Z",
  };
  it("does not mistake offline time for clock drift, including the exact tolerance", () => {
    expect(captureClockDrift(anchor)).toMatchObject({ driftMs: 0, flagged: false });
    expect(captureClockDrift({ ...anchor, capturedAt: "2026-11-17T04:02:00Z" }).flagged).toBe(
      false,
    );
    expect(captureClockDrift({ ...anchor, capturedAt: "2026-11-17T04:02:00.001Z" }).flagged).toBe(
      true,
    );
    expect(captureClockDrift({ ...anchor, capturedAt: "2026-11-17T03:57:59Z" }).flagged).toBe(true);
  });
  it("refuses monotonic resets and a different process boot instead of trusting a wall clock", () => {
    expect(captureClockDrift({ ...anchor, monotonicMs: 1999 })).toEqual({
      driftMs: null,
      flagged: true,
      estimatedAt: null,
    });
    expect(captureClockDrift({ ...anchor, bootId: "reboot" }).flagged).toBe(true);
    expect(captureClockDrift({ ...anchor, monotonicMs: Number.MAX_SAFE_INTEGER }).flagged).toBe(
      true,
    );
  });
  it("signs the same bytes across nested object key order without changing arrays", () => {
    expect(canonicalJson({ b: [{ z: true, a: "é" }], a: null })).toBe(
      canonicalJson({ a: null, b: [{ a: "é", z: true }] }),
    );
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });
});
