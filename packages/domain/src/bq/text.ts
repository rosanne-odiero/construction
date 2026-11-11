/**
 * Text safety for spreadsheet imports and exports (brief §15 F, ARCHITECTURE §17). Every value in
 * an uploaded workbook is untrusted text.
 */

/**
 * C0/C1 control characters (except tab, line feed and carriage return, handled separately),
 * zero-width characters, bidirectional overrides/isolates and the byte-order mark. Bidi controls
 * can make a description display differently from what it contains.
 */
const UNSAFE_CHARACTERS =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

export type SanitisedText = { text: string; removed: number; truncated: boolean };

/**
 * Cleans one cell: unsafe characters removed (and counted), line endings normalised, tabs and
 * runs of spaces collapsed, Unicode NFC, trimmed, then cut to `maxLength` characters.
 */
export function sanitiseCellText(raw: string, maxLength = 4_000): SanitisedText {
  let removed = 0;
  const cleaned = raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_CHARACTERS, () => {
      removed += 1;
      return "";
    })
    .replace(/\t/g, " ")
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const characters = Array.from(cleaned);
  const truncated = characters.length > maxLength;
  return {
    text: truncated ? characters.slice(0, maxLength).join("").trimEnd() : cleaned,
    removed,
    truncated,
  };
}

const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;

/**
 * Neutralises spreadsheet formula injection in exported text (OWASP CSV injection guidance):
 * text that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading apostrophe,
 * so a spreadsheet shows it as text and never evaluates it. Numbers are not passed through here.
 */
export function spreadsheetSafeText(text: string): string {
  return FORMULA_TRIGGERS.test(text) ? `'${text}` : text;
}

export const isFormulaLike = (text: string): boolean => FORMULA_TRIGGERS.test(text);

const FILE_NAME_LIMIT = 120;

/**
 * A display-only file name from a user-supplied one: the last path segment, unsafe and
 * non-portable characters replaced, at most 120 characters with the extension kept. It is never
 * used as a storage key.
 */
export function sanitiseFileName(name: string, fallback = "upload"): string {
  const base = (name.split(/[\\/]/).pop() ?? "").normalize("NFC");
  const cleaned = base
    .replace(UNSAFE_CHARACTERS, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F]/g, "")
    .replace(/[^\p{L}\p{N} ._()-]/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/_{2,}/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (!cleaned) return fallback;
  if (cleaned.length <= FILE_NAME_LIMIT) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned.length - dot <= 6 ? cleaned.slice(dot) : "";
  return `${cleaned.slice(0, FILE_NAME_LIMIT - extension.length).trimEnd()}${extension}`;
}

/**
 * A Content-Disposition header value for a download: an ASCII-only `filename` (quotes,
 * backslashes and control characters removed) plus an RFC 5987 `filename*` for the full name.
 */
export function contentDisposition(fileName: string): string {
  const safe = sanitiseFileName(fileName, "download");
  const ascii = safe
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/["\\]/g, "")
    .trim();
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii || "download"}"; filename*=UTF-8''${encoded}`;
}
