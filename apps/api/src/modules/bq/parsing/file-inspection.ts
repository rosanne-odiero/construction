import { BQ_IMPORT_LIMITS, type BqFileType, type BqImportLimits } from "@pm-buddy/types";

/** Why an upload is refused before anything is stored (stable problem codes). */
export type UploadRefusal =
  "unsupported-file-type" | "unsafe-archive" | "macro-workbook" | "empty-file";

export class UploadRefused extends Error {
  constructor(
    readonly code: UploadRefusal,
    message: string,
  ) {
    super(message);
  }
}

const ZIP_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const extensionOf = (name: string): string => {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return match ? match[1]!.toLowerCase() : "";
};

/**
 * The upload's type from its content signature, which must agree with the file name's extension:
 * `.xlsx` must be a zip (OOXML) package and `.xls` an OLE2 compound file (BIFF). The declared
 * MIME type is ignored. HTML or XML saved with an Excel extension, password-protected OOXML
 * (an OLE2 container named .xlsx) and anything else is refused.
 */
export function sniffWorkbook(content: Buffer, fileName: string): BqFileType {
  if (!content.length) throw new UploadRefused("empty-file", "The file is empty");
  const extension = extensionOf(fileName);
  const isZip = content.subarray(0, 4).equals(ZIP_LOCAL);
  const isCfb = content.subarray(0, 8).equals(CFB);
  if (extension === "xlsx" && isZip) return "xlsx";
  if (extension === "xls" && isCfb) return "xls";
  if (extension === "xlsx" && isCfb)
    throw new UploadRefused(
      "unsupported-file-type",
      "This .xlsx file is password-protected or not a real Excel workbook",
    );
  throw new UploadRefused(
    "unsupported-file-type",
    "Only Excel workbooks (.xlsx or .xls) are accepted, and the content must match the extension",
  );
}

export type ZipSummary = {
  entries: number;
  compressedBytes: number;
  uncompressedBytes: number;
  names: string[];
};

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

/**
 * Reads the zip central directory (no decompression) and refuses archives that could exhaust
 * memory: more than 100 MB uncompressed in total, a compression ratio above 100:1, too many
 * entries, ZIP64 or encrypted entries, or a directory that does not fit the file. An OOXML
 * workbook must contain `[Content_Types].xml` and `xl/workbook.xml`; macro projects are refused.
 */
export function inspectZip(content: Buffer, limits: BqImportLimits = BQ_IMPORT_LIMITS): ZipSummary {
  const unsafe = (message: string) => new UploadRefused("unsafe-archive", message);
  const searchFrom = Math.max(0, content.length - 22 - 0xffff);
  let end = -1;
  for (let position = content.length - 22; position >= searchFrom; position -= 1) {
    if (content.readUInt32LE(position) === EOCD) {
      end = position;
      break;
    }
  }
  if (end < 0) throw unsafe("The workbook is not a valid zip package");
  const entries = content.readUInt16LE(end + 10);
  const directorySize = content.readUInt32LE(end + 12);
  const directoryOffset = content.readUInt32LE(end + 16);
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff)
    throw unsafe("ZIP64 workbooks are not accepted");
  if (entries > limits.maxArchiveEntries) throw unsafe("The workbook has too many parts");
  if (directoryOffset + directorySize > end) throw unsafe("The zip directory is inconsistent");

  let position = directoryOffset;
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  const names: string[] = [];
  for (let index = 0; index < entries; index += 1) {
    if (position + 46 > end || content.readUInt32LE(position) !== CENTRAL)
      throw unsafe("The zip directory is inconsistent");
    const flags = content.readUInt16LE(position + 8);
    const compressed = content.readUInt32LE(position + 20);
    const uncompressed = content.readUInt32LE(position + 24);
    const nameLength = content.readUInt16LE(position + 28);
    const extraLength = content.readUInt16LE(position + 30);
    const commentLength = content.readUInt16LE(position + 32);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff)
      throw unsafe("ZIP64 workbooks are not accepted");
    if (flags & 0x1) throw unsafe("Encrypted workbook parts are not accepted");
    const nameEnd = position + 46 + nameLength;
    if (nameEnd > end) throw unsafe("The zip directory is inconsistent");
    names.push(content.toString("utf8", position + 46, nameEnd));
    compressedBytes += compressed;
    uncompressedBytes += uncompressed;
    if (uncompressedBytes > limits.maxUncompressedBytes)
      throw unsafe("The workbook expands to more than 100 MB");
    position = nameEnd + extraLength + commentLength;
  }
  if (uncompressedBytes / Math.max(content.length, 1) > limits.maxCompressionRatio)
    throw unsafe("The workbook is compressed more than 100:1");
  const lower = names.map((name) => name.toLowerCase());
  if (!lower.includes("[content_types].xml") || !lower.includes("xl/workbook.xml"))
    throw new UploadRefused("unsupported-file-type", "This is not an Excel workbook (.xlsx)");
  if (lower.some((name) => name.endsWith("vbaproject.bin")))
    throw new UploadRefused("macro-workbook", "Macro-enabled workbooks are not accepted");
  return { entries, compressedBytes, uncompressedBytes, names };
}
