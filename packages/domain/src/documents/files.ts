/**
 * File names for documents (D8.4, decision D-114). The uploaded name is only a label: it is
 * reduced to letters, digits, spaces and `._()-` (anything else becomes `_`), path parts and the
 * extension are dropped, and the extension of the type found in the content is added. Downloads
 * add the revision and, for a superseded version, `SUPERSEDED`, so a printed or forwarded copy is
 * never mistaken for the current one.
 */

const MAX_STEM = 100;

const TRIMMED = new Set([" ", "\t", "\n", "\r", "\f", "\v", ".", "_", "-"]);

/** Drops leading and trailing whitespace, dots, underscores and hyphens (a linear scan). */
function trimEdges(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && TRIMMED.has(value[start]!)) start += 1;
  while (end > start && TRIMMED.has(value[end - 1]!)) end -= 1;
  return value.slice(start, end);
}

/** The stem of a name: no folders, no extension, a safe character set, at most 100 characters. */
export function documentFileStem(original: string): string {
  const base = original.split(/[\\/]/).pop() ?? "";
  const withoutExtension = base.replace(/\.[A-Za-z0-9]{1,8}$/, "");
  const safe = trimEdges(
    withoutExtension
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9 ._()-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/\s+/g, " "),
  );
  return Array.from(safe).slice(0, MAX_STEM).join("").trim() || "document";
}

/** The stored name: the safe stem plus the extension of the detected content type. */
export const documentFileName = (original: string, extension: string) =>
  `${documentFileStem(original)}.${extension}`;

/**
 * The name a download is saved under: `<stem>_rev-<revision>[_SUPERSEDED].<ext>`. The revision is
 * already restricted to letters, digits, "." and "-".
 */
export function documentDownloadName(input: {
  storedName: string;
  revision: string;
  superseded: boolean;
  extension: string;
}): string {
  const revision = input.revision.replace(/[^A-Za-z0-9.-]/g, "_");
  return `${documentFileStem(input.storedName)}_rev-${revision}${input.superseded ? "_SUPERSEDED" : ""}.${input.extension}`;
}
