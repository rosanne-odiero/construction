import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { PHOTO_LIMITS } from "@pm-buddy/domain";

export type HeicDecoded =
  | { ok: true; width: number; height: number; rgba: Buffer }
  | { ok: false; failure: "heic-unreadable" | "heic-too-large" | "heic-timeout" | "heic-busy" };

/** The worker next to this module: compiled `.js` in production, the `.ts` source in tests. */
const workerUrl = new URL(
  `./heic.worker${extname(fileURLToPath(import.meta.url)) === ".ts" ? ".ts" : ".js"}`,
  import.meta.url,
);
const TIMEOUT_MS = 30_000;
/** At most this many photos are decoded at once per process; a few more may wait. */
const MAX_CONCURRENT = 2;
const MAX_WAITING = 8;
let running = 0;
const waiting: (() => void)[] = [];

/**
 * Decodes a HEIC photo to upright RGBA pixels in a worker thread (heic.worker.ts) with a time
 * limit. The heap cap covers JavaScript only; WebAssembly memory is bounded by the worker checking
 * every declared image size against the pixel limit (and refusing alpha layers) before decoding,
 * and by at most two decodes at once. Any failure is an outcome, never a crash of the API process.
 */
export async function decodeHeic(
  content: Buffer,
  maxPixels: number = PHOTO_LIMITS.maxPixels,
): Promise<HeicDecoded> {
  if (running >= MAX_CONCURRENT) {
    if (waiting.length >= MAX_WAITING) return { ok: false, failure: "heic-busy" };
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running += 1;
  try {
    return await new Promise<HeicDecoded>((resolve) => {
      let settled = false;
      const finish = (outcome: HeicDecoded) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        resolve(outcome);
      };
      const worker = new Worker(workerUrl, {
        workerData: { data: new Uint8Array(content), maxPixels },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 48 },
        stdout: true,
        stderr: true,
      });
      // libheif reports parse errors on the console; they are discarded, not logged.
      worker.stdout.resume();
      worker.stderr.resume();
      const timer = setTimeout(() => finish({ ok: false, failure: "heic-timeout" }), TIMEOUT_MS);
      worker.once(
        "message",
        (
          message:
            | { ok: true; width: number; height: number; rgba: Uint8Array }
            | { ok: false; failure: "heic-unreadable" | "heic-too-large" },
        ) =>
          finish(
            message.ok
              ? {
                  ok: true,
                  width: message.width,
                  height: message.height,
                  rgba: Buffer.from(
                    message.rgba.buffer,
                    message.rgba.byteOffset,
                    message.rgba.byteLength,
                  ),
                }
              : message,
          ),
      );
      worker.once("error", () => finish({ ok: false, failure: "heic-unreadable" }));
      worker.once("exit", () => finish({ ok: false, failure: "heic-unreadable" }));
    });
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}
