import {
  Injectable,
  PayloadTooLargeException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import {
  DOCUMENT_FILE_EXTENSIONS,
  DOCUMENT_LIMITS,
  type DocumentContentType,
} from "@pm-buddy/types";
import type { Request } from "express";
import { readZipDirectory, UnsafeArchive } from "../../common/zip-directory.js";
import { AuthSecurity } from "../identity/auth-security.service.js";
import { AuthService } from "../identity/auth.service.js";

export type UploadedDocumentFile = { buffer: Buffer; originalname: string; size: number };

export type DocumentRefusal =
  | "file-required"
  | "unsupported-file-type"
  | "unsafe-archive"
  | "macro-document"
  | "pdf-active-content";

export class DocumentRefused extends Error {
  constructor(
    readonly code: DocumentRefusal,
    message: string,
  ) {
    super(message);
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZIP_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * PDF names that run something when the file is opened: JavaScript, launch actions, embedded
 * files and rich media. A best-effort check of the raw bytes (names inside compressed object
 * streams are not seen); the malware scanner is the control, this only refuses the obvious.
 * Names may spell characters as `#xx` hex escapes (`/J#61vaScript` is `/JavaScript`), so each name
 * is decoded before it is compared.
 */
const PDF_ACTIVE_NAMES = new Set([
  "JavaScript",
  "JS",
  "Launch",
  "EmbeddedFile",
  "EmbeddedFiles",
  "RichMedia",
]);
const PDF_NAME = /\/([^\s/<>[\](){}%]*)/g;

/** Whether a PDF's raw bytes name an active-content key (see PDF_ACTIVE_NAMES). */
export function pdfHasActiveContent(text: string): boolean {
  for (const match of text.matchAll(PDF_NAME)) {
    const name = match[1]!;
    if (name.length > 40) continue;
    const decoded = name.includes("#")
      ? name.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
          String.fromCharCode(parseInt(hex, 16)),
        )
      : name;
    if (PDF_ACTIVE_NAMES.has(decoded)) return true;
  }
  return false;
}

/**
 * Parts an Office file may embed (decision D-114): images and the plain workbooks and documents
 * Word and Excel embed for charts and objects. Anything else under `embeddings/` (OLE binaries,
 * macro-enabled or binary workbooks and documents such as .xlsm, .xlsb, .docm, .pptm) is refused.
 */
const OFFICE_EMBEDDINGS = /\.(xlsx|docx|pptx|png|jpe?g|gif|emf|wmf)$/;

/**
 * The type of an uploaded document from its content (decision D-114): PDF, JPEG, PNG, WebP, and
 * Office Open XML documents and workbooks (a zip with `[Content_Types].xml` and
 * `word/document.xml` or `xl/workbook.xml`, within the archive limits, without macros, ActiveX or
 * embedded OLE binaries). The name and declared type are never trusted. DWG and DXF drawings,
 * legacy Office (OLE2) files and everything else are refused.
 */
export function inspectDocument(content: Buffer): {
  contentType: DocumentContentType;
  extension: string;
} {
  if (!content.length) throw new DocumentRefused("file-required", "The file is empty");
  const found = (contentType: DocumentContentType) => ({
    contentType,
    extension: DOCUMENT_FILE_EXTENSIONS[contentType],
  });
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff)
    return found("image/jpeg");
  if (content.subarray(0, 8).equals(PNG)) return found("image/png");
  if (
    content.length >= 12 &&
    content.subarray(0, 4).toString("latin1") === "RIFF" &&
    content.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return found("image/webp");
  if (content.subarray(0, 5).toString("latin1") === "%PDF-") {
    const tail = content.subarray(Math.max(0, content.length - 1024)).toString("latin1");
    if (!tail.includes("%%EOF"))
      throw new DocumentRefused("unsupported-file-type", "The PDF is incomplete (no end marker)");
    if (pdfHasActiveContent(content.toString("latin1")))
      throw new DocumentRefused(
        "pdf-active-content",
        "PDFs with scripts, launch actions or embedded files are not accepted",
      );
    return found("application/pdf");
  }
  if (content.subarray(0, 4).equals(ZIP_LOCAL)) {
    let names: string[];
    try {
      names = readZipDirectory(content, DOCUMENT_LIMITS).names.map((name) => name.toLowerCase());
    } catch (error) {
      if (error instanceof UnsafeArchive)
        throw new DocumentRefused("unsafe-archive", error.message);
      throw error;
    }
    if (
      names.some(
        (name) =>
          name.endsWith("vbaproject.bin") ||
          name.includes("/activex/") ||
          (name.includes("/embeddings/") && !OFFICE_EMBEDDINGS.test(name)),
      )
    )
      throw new DocumentRefused(
        "macro-document",
        "Office files with macros, ActiveX controls or embedded programs are not accepted",
      );
    const types = names.includes("[content_types].xml");
    const word = names.includes("word/document.xml");
    const excel = names.includes("xl/workbook.xml");
    if (types && word !== excel) return found(word ? DOCX : XLSX);
    throw new DocumentRefused(
      "unsupported-file-type",
      "Only Word (.docx) and Excel (.xlsx) Office files are accepted",
    );
  }
  if (content.subarray(0, 8).equals(CFB))
    throw new DocumentRefused(
      "unsupported-file-type",
      "Old Office files (.doc, .xls) are not accepted: save as .docx, .xlsx or PDF",
    );
  const head = content.subarray(0, 32).toString("latin1");
  if (/^AC10\d\d/.test(head) || /^\s*0\s*\r?\n\s*SECTION/.test(head))
    throw new DocumentRefused(
      "unsupported-file-type",
      "CAD files (DWG, DXF) are not accepted: upload the issued drawing as a PDF",
    );
  throw new DocumentRefused(
    "unsupported-file-type",
    "Files must be PDF, JPEG, PNG, WebP, Word (.docx) or Excel (.xlsx)",
  );
}

/**
 * Before the multipart body is read: refuse a declared size over the limit (413), require a
 * session (401) and rate-limit uploads per user (429), so abusive uploads are never buffered.
 */
@Injectable()
export class DocumentUploadGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly security: AuthSecurity,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (Number(req.headers["content-length"] ?? 0) > DOCUMENT_LIMITS.maxFileBytes + 64 * 1024)
      throw new PayloadTooLargeException({
        message: "Files may be at most 25 MB",
        code: "payload-too-large",
      });
    const principal = await this.auth.principal(req);
    await this.security.limit(
      `document-upload:${principal.user.id}`,
      DOCUMENT_LIMITS.uploadsPerHour,
      3_600,
    );
    return true;
  }
}

/** Multer limits for one document upload: one file and a handful of short text fields. */
export const DOCUMENT_MULTER_LIMITS = {
  fileSize: DOCUMENT_LIMITS.maxFileBytes,
  files: 1,
  fields: 10,
  parts: 11,
  fieldNameSize: 40,
  fieldSize: 4_000,
  headerPairs: 20,
};
