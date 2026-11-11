import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BQ_IMPORT_LIMITS } from "@pm-buddy/types";
import { inspectZip, sniffWorkbook, UploadRefused } from "./file-inspection.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../test/fixtures/bq/${name}`, import.meta.url));

/** A zip with the given entries (deflated), optionally with flags on every central record. */
function zip(entries: { name: string; data: Buffer }[], flags = 0): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const body = deflateRawSync(entry.data);
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(flags, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(entry.data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const part = (name: string, data = "<x/>") => ({ name, data: Buffer.from(data) });
const workbookParts = [part("[Content_Types].xml"), part("xl/workbook.xml")];
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof UploadRefused) return error.code;
    throw error;
  }
  return null;
};

describe("sniffWorkbook", () => {
  it("accepts .xlsx zip packages and .xls OLE2 compound files by content", () => {
    expect(sniffWorkbook(fixture("kenyan-multi-bill.xlsx"), "BQ.XLSX")).toBe("xlsx");
    expect(sniffWorkbook(fixture("kenyan-multi-bill.xls"), "bq.xls")).toBe("xls");
  });

  it("refuses content that does not match the extension, other types and empty files", () => {
    expect(refusal(() => sniffWorkbook(fixture("kenyan-multi-bill.xls"), "bq.xlsx"))).toBe(
      "unsupported-file-type",
    );
    expect(refusal(() => sniffWorkbook(fixture("kenyan-multi-bill.xlsx"), "bq.xls"))).toBe(
      "unsupported-file-type",
    );
    expect(refusal(() => sniffWorkbook(fixture("not-excel.xlsx"), "not-excel.xlsx"))).toBe(
      "unsupported-file-type",
    );
    expect(refusal(() => sniffWorkbook(Buffer.from("<html><table>"), "export.xls"))).toBe(
      "unsupported-file-type",
    );
    expect(refusal(() => sniffWorkbook(fixture("kenyan-multi-bill.xlsx"), "bq.xlsm"))).toBe(
      "unsupported-file-type",
    );
    expect(refusal(() => sniffWorkbook(Buffer.alloc(0), "bq.xlsx"))).toBe("empty-file");
  });
});

describe("inspectZip", () => {
  it("summarises a real workbook package without decompressing it", () => {
    const summary = inspectZip(fixture("kenyan-multi-bill.xlsx"));
    expect(summary.names).toEqual(
      expect.arrayContaining(["[Content_Types].xml", "xl/workbook.xml"]),
    );
    expect(summary.uncompressedBytes).toBeGreaterThan(summary.compressedBytes);
  });

  it("refuses a zip bomb (over 100 MB uncompressed)", () => {
    expect(refusal(() => inspectZip(fixture("zip-bomb.xlsx")))).toBe("unsafe-archive");
  });

  it("refuses a compression ratio above 100:1 even when small", () => {
    const dense = zip([
      ...workbookParts,
      { name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(5_000_000, 0x41) },
    ]);
    expect(dense.length).toBeLessThan(50_000);
    expect(refusal(() => inspectZip(dense))).toBe("unsafe-archive");
  });

  it("refuses encrypted entries, ZIP64, broken directories and too many parts", () => {
    expect(refusal(() => inspectZip(zip(workbookParts, 0x1)))).toBe("unsafe-archive");
    const zip64 = zip(workbookParts);
    zip64.writeUInt16LE(0xffff, zip64.length - 22 + 10);
    expect(refusal(() => inspectZip(zip64))).toBe("unsafe-archive");
    expect(refusal(() => inspectZip(Buffer.from("PK\u0003\u0004 not really a zip")))).toBe(
      "unsafe-archive",
    );
    const many = zip([...workbookParts, part("a"), part("b")]);
    expect(refusal(() => inspectZip(many, { ...BQ_IMPORT_LIMITS, maxArchiveEntries: 3 }))).toBe(
      "unsafe-archive",
    );
  });

  it("requires an Excel workbook part and refuses macro projects", () => {
    expect(
      refusal(() => inspectZip(zip([part("word/document.xml"), part("[Content_Types].xml")]))),
    ).toBe("unsupported-file-type");
    expect(refusal(() => inspectZip(zip([...workbookParts, part("xl/vbaProject.bin")])))).toBe(
      "macro-workbook",
    );
    expect(inspectZip(zip(workbookParts)).entries).toBe(2);
  });
});
