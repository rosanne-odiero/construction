import { BQ_IMPORT_LIMITS, type BqFileType, type BqImportLimits } from "@pm-buddy/types";
import { readZipDirectory, UnsafeArchive, type ZipSummary } from "../../../common/zip-directory.js";

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

export type { ZipSummary };

/**
 * Reads the zip central directory (no decompression) and refuses archives that could exhaust
 * memory: more than 100 MB uncompressed in total, a compression ratio above 100:1, too many
 * entries, ZIP64 or encrypted entries, or a directory that does not fit the file. An OOXML
 * workbook must contain `[Content_Types].xml` and `xl/workbook.xml`; macro projects are refused.
 */
export function inspectZip(content: Buffer, limits: BqImportLimits = BQ_IMPORT_LIMITS): ZipSummary {
  let summary: ZipSummary;
  try {
    summary = readZipDirectory(content, limits);
  } catch (error) {
    if (error instanceof UnsafeArchive)
      throw new UploadRefused(
        "unsafe-archive",
        error.message
          .replace("The file is not a valid zip package", "The workbook is not a valid zip package")
          .replace("ZIP64 packages", "ZIP64 workbooks")
          .replace("The package has too many parts", "The workbook has too many parts")
          .replace("Encrypted parts", "Encrypted workbook parts")
          .replace("The package expands", "The workbook expands")
          .replace("The package is compressed", "The workbook is compressed"),
      );
    throw error;
  }
  const lower = summary.names.map((name) => name.toLowerCase());
  if (!lower.includes("[content_types].xml") || !lower.includes("xl/workbook.xml"))
    throw new UploadRefused("unsupported-file-type", "This is not an Excel workbook (.xlsx)");
  if (lower.some((name) => name.endsWith("vbaproject.bin")))
    throw new UploadRefused("macro-workbook", "Macro-enabled workbooks are not accepted");
  return summary;
}
