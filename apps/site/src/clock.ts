import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Clock } from "./core.ts";

export type BootClockSource = { elapsedRealtimeMs(): number; bootCount(): number | null };

/** A stable RFC 9562 version-8 UUID for one Android boot; a lease and its events share it. */
export function androidBootId(bootCount: number): string {
  if (!Number.isSafeInteger(bootCount) || bootCount < 0)
    throw new Error("Invalid Android boot count.");
  const bytes = sha256(utf8ToBytes(`pmb-site-android-boot:${bootCount}`)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/**
 * The offline-lease clock (THREAT_MODEL T-37). On Android, performance.now() is CLOCK_MONOTONIC,
 * which stops in deep sleep: an honest wall clock then looked "changed" after a night's sleep
 * while a wound-back one matched. Android therefore needs elapsedRealtime (CLOCK_BOOTTIME) and
 * fails closed without it. iOS performance.now() (CLOCK_MONOTONIC_RAW) already counts sleep but
 * has no boot identifier, so a new iOS process still needs an online lease renewal.
 */
export function leaseClock(options: {
  platform: string;
  native: BootClockSource | null;
  processBootId: string;
  now?: () => number;
  monotonic?: () => number;
}): () => Clock {
  const now = options.now ?? (() => Date.now());
  if (options.platform === "android") {
    const native = options.native;
    if (!native)
      return () => {
        throw new Error("Native boot clock missing. Install the current native build.");
      };
    return () => {
      const bootCount = native.bootCount();
      return {
        bootId: bootCount === null ? options.processBootId : androidBootId(bootCount),
        monotonicMs: native.elapsedRealtimeMs(),
        wallMs: now(),
      };
    };
  }
  const monotonic = options.monotonic ?? (() => performance.now());
  return () => ({ bootId: options.processBootId, monotonicMs: monotonic(), wallMs: now() });
}
