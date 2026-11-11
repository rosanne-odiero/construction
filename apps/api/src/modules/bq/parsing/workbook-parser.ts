import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  BQ_IMPORT_LIMITS,
  type BqFileType,
  type BqImportFailure,
  type BqImportLimits,
} from "@pm-buddy/types";
import type { WorkbookGrid } from "@pm-buddy/domain";

export type ParseOutcome =
  { ok: true; grid: WorkbookGrid } | { ok: false; failure: BqImportFailure };

/** Raw text kept per cell by the worker; the parent trims to the stored limit (4,000). */
const RAW_TEXT_LENGTH = 8_000;
/** All cell text returned by the worker (see parse.worker.ts); about 40 MB as UTF-16. */
const MAX_TEXT_CHARACTERS = 20_000_000;

/**
 * The worker module next to this one: compiled `.js` in production, the `.ts` source when the
 * tests run from source (Node strips the types).
 */
const workerUrl = new URL(
  `./parse.worker${extname(fileURLToPath(import.meta.url)) === ".ts" ? ".ts" : ".js"}`,
  import.meta.url,
);

/** At most this many workbooks are parsed at once per process; a few more may wait. */
const MAX_CONCURRENT = 2;
const MAX_WAITING = 8;
let running = 0;
const waiting: (() => void)[] = [];

export class ParserBusy extends Error {}

async function slot(): Promise<() => void> {
  if (running >= MAX_CONCURRENT) {
    if (waiting.length >= MAX_WAITING) throw new ParserBusy("Too many workbooks are being read");
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running += 1;
  return () => {
    running -= 1;
    waiting.shift()?.();
  };
}

/**
 * Reads a workbook in a worker thread with a heap cap (resourceLimits) and a time limit. The
 * worker is terminated on timeout; running out of memory or any read error becomes a failure code,
 * never a crash of the API process.
 */
export async function parseWorkbook(
  content: Buffer,
  fileType: BqFileType,
  limits: BqImportLimits = BQ_IMPORT_LIMITS,
): Promise<ParseOutcome> {
  const release = await slot();
  try {
    return await new Promise<ParseOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: ParseOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        resolve(outcome);
      };
      const worker = new Worker(workerUrl, {
        workerData: {
          data: new Uint8Array(content),
          fileType,
          limits: {
            maxSheets: limits.maxSheets,
            maxRowsPerSheet: limits.maxRowsPerSheet,
            maxColumnsPerSheet: limits.maxColumnsPerSheet,
            maxCells: limits.maxCells,
            rawTextLength: RAW_TEXT_LENGTH,
            maxUncompressedBytes: limits.maxUncompressedBytes,
            maxTextCharacters: MAX_TEXT_CHARACTERS,
          },
        },
        resourceLimits: {
          maxOldGenerationSizeMb: limits.parseHeapMb,
          maxYoungGenerationSizeMb: 48,
          codeRangeSizeMb: 64,
          stackSizeMb: 4,
        },
        stdout: true,
        stderr: true,
      });
      // SheetJS diagnostics are discarded rather than mixed into the API's structured logs.
      worker.stdout.resume();
      worker.stderr.resume();
      const timer = setTimeout(
        () => finish({ ok: false, failure: "parse-timeout" }),
        limits.parseTimeoutMs,
      );
      worker.once("message", (message: ParseOutcome) => finish(message));
      worker.once("error", (error: Error & { code?: string }) =>
        finish({
          ok: false,
          failure:
            error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "parse-memory" : "workbook-unreadable",
        }),
      );
      worker.once("exit", () => finish({ ok: false, failure: "workbook-unreadable" }));
    });
  } finally {
    release();
  }
}
