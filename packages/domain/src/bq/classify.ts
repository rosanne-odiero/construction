import type { BqBillKind, BqField, BqItemKind, BqUnit } from "@pm-buddy/types";

/**
 * Classification of bills and items from their wording (brief §5.2). Patterns run on lower-cased
 * text; Kiswahili variants are included where QS documents use them.
 */

const PRELIMINARIES = /\bprelim|preliminar|general (items|conditions)|mambo ya awali/;
const PROVISIONAL_BILL =
  /provisional|prime cost|\bp\.?\s?c\.?\s+sums?\b|\bpc sums?\b|\bpc\s*&|nominated/;
const DAYWORKS_BILL = /day\s?works?/;
const CONTINGENCY_BILL = /contingenc/;

/** A bill's class from its title; Bill 1 with mostly lump sums counts as preliminaries. */
export function billKind(title: string, number: string, lumpSumShare = 0): BqBillKind {
  const text = title.toLowerCase();
  if (PRELIMINARIES.test(text)) return "preliminaries";
  if (DAYWORKS_BILL.test(text)) return "dayworks";
  if (CONTINGENCY_BILL.test(text) && !PROVISIONAL_BILL.test(text)) return "contingency";
  if (PROVISIONAL_BILL.test(text)) return "provisional";
  if (number === "1" && lumpSumShare >= 0.6) return "preliminaries";
  return "measured";
}

const PROVISIONAL_SUM = /provisional sum|prov\.?\s*sum|provide (the )?(provisional )?sum/;
const PC_SUM =
  /prime cost|\bp\.?\s?c\.?\s*sum|\bpc\b|\bp\.c\.|nominated (sub-?contractor|supplier)/;
const ATTENDANCE = /attendance/;
const PROFIT = /profit|overheads?/;
const CONTINGENCY = /contingenc/;
const DAYWORK = /day\s?works?/;

export interface ItemContext {
  billKind: BqBillKind;
  unit: BqUnit | null;
  /** The item follows a PC sum in the same bill (attendance/profit lines refer to it). */
  afterPcSum: boolean;
}

/** An item's class: PC sums with their attendance and profit lines, provisional sums, etc. */
export function itemKind(description: string, context: ItemContext): BqItemKind {
  const text = description.toLowerCase();
  const pcContext = context.afterPcSum || context.billKind === "provisional";
  if (ATTENDANCE.test(text) && (pcContext || PC_SUM.test(text))) return "pc_attendance";
  if (PROFIT.test(text) && (context.unit === "pct" || PC_SUM.test(text)) && pcContext)
    return "pc_profit";
  if (CONTINGENCY.test(text)) return "contingency";
  if (DAYWORK.test(text) || context.billKind === "dayworks") return "daywork";
  if (PC_SUM.test(text)) return "pc_sum";
  if (PROVISIONAL_SUM.test(text)) return "provisional_sum";
  if (context.billKind === "preliminaries") return "preliminary";
  if (context.billKind === "contingency") return "contingency";
  return "measured";
}

export type RowMarker =
  | "brought_forward"
  | "page_total"
  | "bill_total"
  | "collection"
  | "bill_heading"
  | "vat"
  | "grand_total";

/** Recognises carried/brought forward, page and bill totals and collection headings. */
export function rowMarker(description: string): RowMarker | null {
  const text = description.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (/^(total )?(brought|b\/f\b|b\.f\.?)|brought forward|brought from/.test(text))
    return "brought_forward";
  if (/grand total|contract sum|tender sum|form of tender/.test(text)) return "grand_total";
  if (/\bv\.?\s?a\.?\s?t\b|value added tax/.test(text)) return "vat";
  if (
    /carried to (the )?(general |grand |main )?summary|to summary|total (for|of) bill|bill (no\.? ?\d+ )?total|total carried to (the )?(general |grand )?summary|carried to bill summary/.test(
      text,
    )
  )
    return "bill_total";
  if (
    /carried (forward|to collection|over|to page)|^c\/f\b|\bc\.f\.|to collection|page total/.test(
      text,
    )
  )
    return "page_total";
  if (/^collections?\b|^(page )?collection$/.test(text)) return "collection";
  if (/^bill\s*(no\.?|nr\.?|number)?\s*[:.]?\s*(\d+|[ivxlc]+)\b/.test(text)) return "bill_heading";
  if (/^(sub-?)?total\b/.test(text)) return "page_total";
  return null;
}

/** Text that is mostly upper-case letters (a typical section heading). */
export function isUpperCaseHeading(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (letters.length < 3) return false;
  const upper = letters.replace(/[^\p{Lu}]/gu, "").length;
  return upper / letters.length >= 0.8;
}

/** Roman numerals (I, IV, XII…) as Arabic numbers, for bill numbers; other text unchanged. */
export function normaliseBillNumber(raw: string): string {
  const text = raw.trim().replace(/\.$/, "");
  if (/^[ivxlc]+$/i.test(text)) {
    const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };
    let total = 0;
    const letters = text.toLowerCase().split("");
    letters.forEach((letter, index) => {
      const value = values[letter]!;
      const next = values[letters[index + 1] ?? ""] ?? 0;
      total += value < next ? -value : value;
    });
    if (total > 0) return String(total);
  }
  return text.replace(/^0+(?=\d)/, "");
}

// Matched against text whose whitespace is collapsed to single spaces, so each gap is " ?" and the
// pattern cannot backtrack quadratically on long runs of spaces.
const BILL_HEADING = /\bbill ?(?:(?:no|nr|number)\.? ?)?[:.]? ?(\d+|[ivxlc]+)\b ?[-–—:.]? ?(.*)$/i;

/** "BILL NO. 2 – SUBSTRUCTURE" → { number: "2", title: "SUBSTRUCTURE" }. */
export function parseBillHeading(text: string): { number: string; title: string } | null {
  const match = BILL_HEADING.exec(text.replace(/\s+/g, " ").trim());
  if (!match) return null;
  return { number: normaliseBillNumber(match[1]!), title: (match[2] ?? "").trim() };
}

/** Field order used when presenting a mapping (and the default export column order). */
export const FIELD_ORDER: readonly BqField[] = [
  "ref",
  "description",
  "unit",
  "quantity",
  "rate",
  "amount",
  "notes",
];
