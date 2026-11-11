import { readFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { BQ_IMPORT_LIMITS } from "@pm-buddy/types";
import { inspectZip } from "./file-inspection.js";
import { parseWorkbook } from "./workbook-parser.js";

type ZipEntry = {
  name: string;
  data: Buffer;
  /** Overrides what the central directory declares (the local header gets the real values). */
  declaredSize?: number;
  /** Sets the data-descriptor flag and zero sizes in the local header, as streaming writers do. */
  descriptor?: boolean;
};

/** A small deflated zip, optionally lying about sizes the way a zip bomb does. */
function zip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const packed = deflateRawSync(entry.data);
    const crc = crc32(entry.data) >>> 0;
    const flags = entry.descriptor ? 0x08 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(entry.descriptor ? 0 : crc, 14);
    local.writeUInt32LE(entry.descriptor ? 0 : packed.length, 18);
    local.writeUInt32LE(entry.descriptor ? 0 : entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const trailer = entry.descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (entry.descriptor) {
      trailer.writeUInt32LE(0x08074b50, 0);
      trailer.writeUInt32LE(crc, 4);
      trailer.writeUInt32LE(packed.length, 8);
      trailer.writeUInt32LE(entry.data.length, 12);
    }
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(entry.declaredSize ?? entry.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    parts.push(local, name, packed, trailer);
    central.push(record, name);
    offset += 30 + name.length + packed.length + trailer.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** The parts of a valid one-sheet workbook, re-packed by `zip`. */
function workbookParts(): ZipEntry[] {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["Description", "Qty"],
      ["Cement", 5],
    ]),
    "Bill 1",
  );
  const stored = XLSX.write(book, {
    type: "buffer",
    bookType: "xlsx",
    compression: false,
  }) as Buffer;
  const end = stored.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = stored.readUInt16LE(end + 10);
  let at = stored.readUInt32LE(end + 16);
  const parts: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const size = stored.readUInt32LE(at + 24);
    const nameLength = stored.readUInt16LE(at + 28);
    const name = stored.toString("utf8", at + 46, at + 46 + nameLength);
    const local = stored.readUInt32LE(at + 42);
    const start = local + 30 + stored.readUInt16LE(local + 26) + stored.readUInt16LE(local + 28);
    parts.push({ name, data: Buffer.from(stored.subarray(start, start + size)) });
    at += 46 + nameLength + stored.readUInt16LE(at + 30) + stored.readUInt16LE(at + 32);
  }
  return parts;
}

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../test/fixtures/bq/${name}`, import.meta.url));

describe("parseWorkbook (sandboxed worker)", () => {
  it("reads values from .xlsx and .xls into the same grid", async () => {
    const xlsx = await parseWorkbook(fixture("kenyan-multi-bill.xlsx"), "xlsx");
    const xls = await parseWorkbook(fixture("kenyan-multi-bill.xls"), "xls");
    expect(xlsx.ok && xls.ok).toBe(true);
    if (!xlsx.ok || !xls.ok) return;
    expect(xlsx.grid.sheets.map((sheet) => sheet.name)).toEqual([
      "BILL 1 - PRELIMS",
      "BILL 2 - SUBSTRUCTURE",
      "BILL 3 - SUPERSTRUCTURE",
      "BILL 4 - PC & PROV SUMS",
      "GRAND SUMMARY",
    ]);
    expect(xls.grid.sheets.map((sheet) => sheet.rows.length)).toEqual(
      xlsx.grid.sheets.map((sheet) => sheet.rows.length),
    );
    expect(xlsx.grid.sheets[1]!.rows[5]![1]).toEqual({ t: "s", v: "DESCRIPTION" });
  });

  it("never evaluates formulas: it keeps the cached value and flags the cell", async () => {
    const parsed = await parseWorkbook(fixture("messy.xlsx"), "xlsx");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.grid.sheets[0]!.rows[11]![5]).toEqual({ t: "n", v: 621_000, f: 1 });
  });

  it("enforces sheet, row and cell limits and the time limit", async () => {
    const content = fixture("kenyan-multi-bill.xlsx");
    expect(await parseWorkbook(content, "xlsx", { ...BQ_IMPORT_LIMITS, maxSheets: 2 })).toEqual({
      ok: false,
      failure: "too-many-sheets",
    });
    expect(
      await parseWorkbook(content, "xlsx", { ...BQ_IMPORT_LIMITS, maxRowsPerSheet: 10 }),
    ).toEqual({
      ok: false,
      failure: "too-many-rows",
    });
    expect(await parseWorkbook(content, "xlsx", { ...BQ_IMPORT_LIMITS, maxCells: 50 })).toEqual({
      ok: false,
      failure: "too-many-cells",
    });
    expect(
      await parseWorkbook(content, "xlsx", { ...BQ_IMPORT_LIMITS, parseTimeoutMs: 1 }),
    ).toEqual({
      ok: false,
      failure: "parse-timeout",
    });
  });

  it("stops a worker that runs out of its heap without affecting the API process", async () => {
    const content = fixture("kenyan-multi-bill.xlsx");
    expect(await parseWorkbook(content, "xlsx", { ...BQ_IMPORT_LIMITS, parseHeapMb: 8 })).toEqual({
      ok: false,
      failure: "parse-memory",
    });
    expect((await parseWorkbook(content, "xlsx")).ok).toBe(true);
  });

  it("reads archives written with data descriptors, as streaming zip writers produce", async () => {
    const parsed = await parseWorkbook(
      zip(workbookParts().map((part) => ({ ...part, descriptor: true }))),
      "xlsx",
    );
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (parsed.ok)
      expect(parsed.grid.sheets[0]!.rows[1]).toEqual([
        { t: "s", v: "Cement" },
        { t: "n", v: 5 },
      ]);
  });

  it("refuses a part that inflates beyond what the central directory declares (zip bomb)", async () => {
    for (const descriptor of [false, true]) {
      const bomb = zip([
        ...workbookParts(),
        {
          name: "xl/media/pad.bin",
          data: Buffer.alloc(50_000_000),
          declaredSize: 1_000,
          descriptor,
        },
      ]);
      // The central directory looks harmless, which is what the upload check reads…
      expect(inspectZip(bomb).uncompressedBytes).toBeLessThan(100_000);
      // …but the worker inflates against the declared sizes and stops at the first extra byte.
      expect(await parseWorkbook(bomb, "xlsx"), `descriptor: ${descriptor}`).toEqual({
        ok: false,
        failure: "unsafe-archive",
      });
    }
  });

  it("caps the total cell text, so one shared string repeated in many cells can't flood memory", async () => {
    const text = "x".repeat(8_000);
    const rows = Array.from({ length: 3_000 }, () => [text]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Bill 1");
    const content = XLSX.write(book, { type: "buffer", bookType: "xlsx", bookSST: true }) as Buffer;
    expect(content.length).toBeLessThan(200_000);
    expect(await parseWorkbook(content, "xlsx")).toEqual({ ok: false, failure: "too-much-text" });
  });

  it("turns unreadable input into a failure code, never a crash", async () => {
    const result = await parseWorkbook(Buffer.from("PK\u0003\u0004garbage"), "xlsx");
    expect(result.ok).toBe(false);
  });
});
