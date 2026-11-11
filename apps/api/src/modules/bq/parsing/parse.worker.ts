/**
 * Sandboxed BQ workbook reader (D2.2, ARCHITECTURE §17). Runs in a worker thread with a heap cap
 * and a time limit set by the parent (workbook-parser.ts). It only reads values: formulas are
 * never evaluated (their cached value is kept and the cell is flagged), styles and HTML are not
 * read, macros are ignored. It hands back a plain grid; all interpretation happens in the parent.
 *
 * Keep this file self-contained (no relative imports) and limited to erasable TypeScript syntax:
 * the e2e tests run it directly from source with Node's type stripping.
 */
import { parentPort, workerData } from "node:worker_threads";
import { crc32, inflateRawSync } from "node:zlib";
import type { CellObject, WorkBook } from "xlsx";
import * as XLSX from "xlsx";
import * as cptable from "xlsx/dist/cpexcel.full.mjs";

type Limits = {
  maxSheets: number;
  maxRowsPerSheet: number;
  maxColumnsPerSheet: number;
  maxCells: number;
  rawTextLength: number;
  maxUncompressedBytes: number;
  maxTextCharacters: number;
};
type Input = { data: Uint8Array; fileType: "xlsx" | "xls"; limits: Limits };
type Cell =
  | { t: "n"; v: number; f?: 1 }
  | { t: "s"; v: string; f?: 1 }
  | { t: "b"; v: boolean; f?: 1 }
  | { t: "e"; v: string; f?: 1 }
  | { t: "f" };
type Sheet = { name: string; hidden: boolean; rows: (Cell | null)[][] };
type Result =
  | { ok: true; grid: { fileType: "xlsx" | "xls"; sheets: Sheet[] } }
  | { ok: false; failure: string };

class Refusal extends Error {
  readonly failure: string;
  constructor(failure: string) {
    super(failure);
    this.failure = failure;
  }
}

XLSX.set_cptable(cptable);

const unsafe = () => new Refusal("unsafe-archive");

/**
 * Re-packs an OOXML zip so SheetJS never trusts the upload's own headers. SheetJS sizes each entry
 * from its local header (or a data descriptor) and inflates without a bound, while the parent only
 * checked the central directory. Here every entry is inflated with a hard output cap equal to the
 * size the central directory declares, its length and CRC-32 must match, entries may not overlap,
 * and the total stays within the uncompressed limit. The result is a plain stored (uncompressed)
 * archive with consistent headers.
 */
function canonicalZip(content: Buffer, limits: Limits): Buffer {
  let end = -1;
  for (let at = content.length - 22; at >= Math.max(0, content.length - 22 - 0xffff); at -= 1)
    if (content.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  if (end < 0) throw unsafe();
  const count = content.readUInt16LE(end + 10);
  let at = content.readUInt32LE(end + 16);
  const entries: { name: Buffer; data: Buffer; crc: number }[] = [];
  const spans: [number, number][] = [];
  const names = new Set<string>();
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > end || content.readUInt32LE(at) !== 0x02014b50) throw unsafe();
    const flags = content.readUInt16LE(at + 8);
    const method = content.readUInt16LE(at + 10);
    const crc = content.readUInt32LE(at + 16);
    const compressed = content.readUInt32LE(at + 20);
    const size = content.readUInt32LE(at + 24);
    const nameLength = content.readUInt16LE(at + 28);
    const extraLength = content.readUInt16LE(at + 30);
    const commentLength = content.readUInt16LE(at + 32);
    const local = content.readUInt32LE(at + 42);
    const name = content.subarray(at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x1 || (method !== 0 && method !== 8)) throw unsafe();
    if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw unsafe();
    const key = name.toString("utf8").toLowerCase();
    if (names.has(key)) throw unsafe();
    names.add(key);
    if (local + 30 > end || content.readUInt32LE(local) !== 0x04034b50) throw unsafe();
    const start = local + 30 + content.readUInt16LE(local + 26) + content.readUInt16LE(local + 28);
    if (start + compressed > end) throw unsafe();
    spans.push([local, start + compressed]);
    total += size;
    if (total > limits.maxUncompressedBytes) throw unsafe();
    const raw = content.subarray(start, start + compressed);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else {
      try {
        // One byte of headroom: inflating more than the declared size fails here, not in memory.
        data = inflateRawSync(raw, { maxOutputLength: size + 1 });
      } catch {
        throw unsafe();
      }
    }
    if (data.length !== size || crc32(data) >>> 0 !== crc >>> 0) throw unsafe();
    entries.push({ name, data, crc: crc >>> 0 });
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < spans.length; index += 1)
    if (spans[index]![0] < spans[index - 1]![1]) throw unsafe();

  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(0x21, 12); // 1980-01-01
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(entry.name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0x21, 14);
    record.writeUInt32LE(entry.crc, 16);
    record.writeUInt32LE(entry.data.length, 20);
    record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(entry.name.length, 28);
    record.writeUInt32LE(offset, 42);
    parts.push(header, entry.name, entry.data);
    central.push(record, entry.name);
    offset += 30 + entry.name.length + entry.data.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, eocd]);
}

/**
 * Total text handed back to the API. SheetJS gives every use of a shared string the same JS
 * string, but posting the grid copies each one, so 200,000 cells of one long string would expand
 * to gigabytes in the API thread. Every cell's text counts towards this budget.
 */
let textCharacters = 0;

function convert(cell: CellObject, limits: Limits): Cell | null {
  const formula = cell.f ? 1 : undefined;
  const withFormula = <T extends object>(value: T): T => (formula ? { ...value, f: 1 } : value);
  switch (cell.t) {
    case "n":
      if (typeof cell.v !== "number") return formula ? { t: "f" } : null;
      if (!Number.isFinite(cell.v)) return withFormula({ t: "e" as const, v: "#NUM!" });
      return withFormula({ t: "n" as const, v: cell.v });
    case "s": {
      if (cell.v === undefined || cell.v === null) return formula ? { t: "f" } : null;
      const text = String(cell.v);
      if (!text && !formula) return null;
      const kept = text.slice(0, limits.rawTextLength);
      textCharacters += kept.length;
      if (textCharacters > limits.maxTextCharacters) throw new Refusal("too-much-text");
      return withFormula({ t: "s" as const, v: kept });
    }
    case "b":
      return withFormula({ t: "b" as const, v: Boolean(cell.v) });
    case "e":
      return withFormula({ t: "e" as const, v: String(cell.w ?? "#ERROR!").slice(0, 20) });
    case "d":
      return withFormula({ t: "s" as const, v: String(cell.w ?? cell.v).slice(0, 40) });
    default:
      return formula ? { t: "f" } : null;
  }
}

function read(input: Input): Result {
  const { limits } = input;
  let book: WorkBook;
  let source = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
  if (input.fileType === "xlsx") {
    try {
      source = canonicalZip(source, limits);
    } catch (error) {
      return { ok: false, failure: error instanceof Refusal ? error.failure : "unsafe-archive" };
    }
  }
  try {
    book = XLSX.read(source, {
      type: "buffer",
      dense: true,
      cellFormula: true,
      cellHTML: false,
      cellStyles: false,
      cellText: false,
      cellDates: false,
      cellNF: false,
      bookVBA: false,
      bookDeps: false,
      bookFiles: false,
      sheetRows: limits.maxRowsPerSheet + 1,
      WTF: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      failure: /password|encrypt|protected/i.test(message)
        ? "workbook-encrypted"
        : "workbook-unreadable",
    };
  }
  const names = book.SheetNames ?? [];
  if (!names.length) return { ok: false, failure: "no-sheets" };
  if (names.length > limits.maxSheets) return { ok: false, failure: "too-many-sheets" };
  let cells = 0;
  const sheets: Sheet[] = [];
  try {
    names.forEach((name, index) => {
      const sheet = book.Sheets[name];
      const hidden = Boolean(book.Workbook?.Sheets?.[index]?.Hidden);
      const fullRange = sheet?.["!fullref"] ?? sheet?.["!ref"];
      const data = (sheet?.["!data"] ?? []) as (CellObject[] | undefined)[];
      if (fullRange) {
        const range = XLSX.utils.decode_range(fullRange);
        if (range.e.r + 1 > limits.maxRowsPerSheet) {
          // A huge declared range is common (formatting); only rows that hold values count.
          if (data.length > limits.maxRowsPerSheet) throw new Refusal("too-many-rows");
        }
      }
      if (data.length > limits.maxRowsPerSheet) throw new Refusal("too-many-rows");
      const rows: (Cell | null)[][] = [];
      data.forEach((row, rowIndex) => {
        if (!row) return;
        const converted: (Cell | null)[] = [];
        row.forEach((cell, column) => {
          if (!cell) return;
          const value = convert(cell, limits);
          if (!value) return;
          if (column >= limits.maxColumnsPerSheet) throw new Refusal("too-many-columns");
          cells += 1;
          if (cells > limits.maxCells) throw new Refusal("too-many-cells");
          converted[column] = value;
        });
        if (converted.length) rows[rowIndex] = converted;
      });
      for (let index = 0; index < rows.length; index += 1) rows[index] ??= [];
      sheets.push({ name: String(name).slice(0, 100), hidden, rows });
    });
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, failure: error.failure };
    return { ok: false, failure: "workbook-unreadable" };
  }
  return { ok: true, grid: { fileType: input.fileType, sheets } };
}

parentPort?.postMessage(read(workerData as Input));
