/**
 * Document revisions (D8.4, decision D-111). Versions are ordered by upload (version 1, 2, 3 …),
 * which is the truth; the revision label ("P1", "A", "C1", "02", "1.1") is what the drawing says.
 * A new revision must be new to the document and must not sort before the current one, unless it
 * starts a new series (for example preliminary "P3" → construction "A"). Labels are compared
 * token by token: numbers numerically ("P2" < "P10", "01" = "1"), letters by length then
 * alphabetically ("Z" < "AA"), and a longer label extends a shorter one ("C" < "C1").
 */

/** 1–10 characters: letters, digits, "." and "-", starting with a letter or digit. */
export const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,9}$/;

export const normaliseRevision = (label: string) => label.trim().toUpperCase();

type Token = { kind: "alpha"; text: string } | { kind: "number"; value: bigint };

function tokens(label: string): Token[] {
  const result: Token[] = [];
  for (const match of normaliseRevision(label).matchAll(/[A-Z]+|[0-9]+/g)) {
    const text = match[0];
    result.push(
      /^[0-9]/.test(text) ? { kind: "number", value: BigInt(text) } : { kind: "alpha", text },
    );
  }
  return result;
}

/** How `next` relates to `previous`. */
export type RevisionOrder = "after" | "before" | "same" | "new_series";

export function compareRevisions(previous: string, next: string): RevisionOrder {
  const a = tokens(previous);
  const b = tokens(next);
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (left.kind === "number" && right.kind === "number") {
      if (left.value !== right.value) return right.value > left.value ? "after" : "before";
      continue;
    }
    if (left.kind === "alpha" && right.kind === "alpha") {
      if (left.text === right.text) continue;
      // A letter followed by a number is a series ("P" preliminary, "C" construction).
      if (a.length > index + 1 || b.length > index + 1) return "new_series";
      if (left.text.length !== right.text.length)
        return right.text.length > left.text.length ? "after" : "before";
      return right.text > left.text ? "after" : "before";
    }
    return "new_series";
  }
  if (a.length === b.length) return "same";
  return b.length > a.length ? "after" : "before";
}

export type RevisionProblem = "revision-invalid" | "revision-exists" | "revision-not-after";

/**
 * Whether `next` may follow the document's revisions: valid, not used before on the document
 * (case-insensitive), and not before or equal to the current revision unless it starts a series.
 */
export function checkNextRevision(
  earlier: readonly string[],
  current: string | null,
  next: string,
): { ok: true; order: RevisionOrder | null } | { ok: false; problem: RevisionProblem } {
  const label = next.trim();
  if (!REVISION_PATTERN.test(label)) return { ok: false, problem: "revision-invalid" };
  const key = normaliseRevision(label);
  if (earlier.some((existing) => normaliseRevision(existing) === key))
    return { ok: false, problem: "revision-exists" };
  if (current === null) return { ok: true, order: null };
  const order = compareRevisions(current, label);
  if (order === "before" || order === "same") return { ok: false, problem: "revision-not-after" };
  return { ok: true, order };
}

const nextLetters = (text: string): string => {
  const chars = text.split("");
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    if (chars[index] !== "Z") {
      chars[index] = String.fromCharCode(chars[index]!.charCodeAt(0) + 1);
      return chars.join("");
    }
    chars[index] = "A";
  }
  return `A${chars.join("")}`;
};

/**
 * A suggestion for the next revision: the last number plus one (keeping zero padding: "P09" →
 * "P10", "02" → "03"), or the next letter sequence ("A" → "B", "Z" → "AA"); "A" for a first
 * version. The uploader can type anything that passes `checkNextRevision`.
 */
export function suggestNextRevision(current: string | null): string {
  if (current === null || !REVISION_PATTERN.test(current.trim())) return "A";
  const label = normaliseRevision(current);
  const number = /([0-9]+)$/.exec(label);
  if (number) {
    const digits = number[1]!;
    const incremented = (BigInt(digits) + 1n).toString().padStart(digits.length, "0");
    const candidate = `${label.slice(0, label.length - digits.length)}${incremented}`;
    return candidate.length <= 10 ? candidate : "A";
  }
  const letters = /([A-Z]+)$/.exec(label);
  if (letters) {
    const run = letters[1]!;
    const candidate = `${label.slice(0, label.length - run.length)}${nextLetters(run)}`;
    return candidate.length <= 10 ? candidate : "A";
  }
  return "A";
}
