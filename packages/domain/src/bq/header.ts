import type { BqField } from "@pm-buddy/types";
import { cellText } from "./numbers.js";
import type { GridSheet } from "./grid.js";

/** How many rows from the top are searched for the header row. */
export const HEADER_SEARCH_ROWS = 60;
/** Below this confidence a row is not treated as a header. */
export const HEADER_MIN_CONFIDENCE = 0.45;

export type ColumnMap = Partial<Record<BqField, number>>;

export interface HeaderDetection {
  /** 1-based Excel row of the header. */
  row: number;
  columns: ColumnMap;
  /** 0–1: how many key columns were found and how closely their titles matched. */
  confidence: number;
  /** Normalised header texts in column order, used to match saved mapping templates. */
  signature: string;
}

/** Lower case, accents removed, punctuation to spaces, single spaces. */
export function normaliseHeader(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .trim();
}

const CURRENCY_WORDS = new Set(["kshs", "ksh", "kes", "shs", "sh", "cts", "cents"]);

/**
 * Header keywords in English with common Kenyan and Kiswahili variants. Matching is tolerant: an
 * exact title, a title starting with a keyword, or a near-miss spelling (one edit in five
 * letters, two in nine) all count, with decreasing scores.
 */
const KEYWORDS: Record<BqField, readonly string[]> = {
  ref: [
    "item",
    "item no",
    "items",
    "ref",
    "ref no",
    "reference",
    "no",
    "nr",
    "s no",
    "sno",
    "serial",
    "code",
    "kipengele",
    "namba",
  ],
  description: [
    "description",
    "descriptions",
    "description of work",
    "description of works",
    "item description",
    "particulars",
    "details",
    "work description",
    "maelezo",
  ],
  unit: ["unit", "units", "uom", "u m", "unit of measure", "kipimo"],
  quantity: ["qty", "qnty", "qtys", "quantity", "quantities", "quant", "idadi", "kiasi"],
  rate: ["rate", "rates", "unit rate", "unit price", "price", "bei", "kiwango"],
  amount: [
    "amount",
    "amounts",
    "amt",
    "total",
    "totals",
    "total amount",
    "sum",
    "extension",
    "jumla",
    "gharama",
  ],
  notes: ["remarks", "remark", "notes", "note", "comments", "comment", "maoni"],
};

/** Optimal-string-alignment distance, bounded (returns limit + 1 when larger). */
export function editDistance(left: string, right: string, limit = 2): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  const rows = left.length + 1;
  const columns = right.length + 1;
  const table: number[][] = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => (row === 0 ? column : column === 0 ? row : 0)),
  );
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      let best = Math.min(
        table[row - 1]![column]! + 1,
        table[row]![column - 1]! + 1,
        table[row - 1]![column - 1]! + cost,
      );
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      )
        best = Math.min(best, table[row - 2]![column - 2]! + 1);
      table[row]![column] = best;
    }
  }
  return table[rows - 1]![columns - 1]!;
}

const allowedEdits = (length: number) => (length >= 9 ? 2 : length >= 5 ? 1 : 0);

/** The best field for a header title and its score (0 when nothing matches). */
export function matchHeaderField(
  text: string,
): { field: BqField | "currency"; score: number } | null {
  const normalised = normaliseHeader(text);
  if (!normalised) return null;
  const words = normalised.split(" ");
  const core = words.filter((word) => !CURRENCY_WORDS.has(word)).join(" ");
  if (!core) return { field: "currency", score: 0.5 };
  let best: { field: BqField; score: number } | null = null;
  const consider = (field: BqField, score: number) => {
    if (!best || score > best.score) best = { field, score };
  };
  for (const [field, keywords] of Object.entries(KEYWORDS) as [BqField, readonly string[]][]) {
    for (const keyword of keywords) {
      if (core === keyword) consider(field, 1);
      else if (core.startsWith(`${keyword} `) && keyword.length >= 3) consider(field, 0.85);
      else {
        const limit = allowedEdits(keyword.length);
        if (limit && editDistance(core, keyword, limit) <= limit) consider(field, 0.7);
        else if (limit) {
          const first = core.split(" ")[0] ?? "";
          if (first !== core && editDistance(first, keyword, limit) <= limit) consider(field, 0.6);
        }
      }
    }
  }
  return best;
}

const WEIGHTS: Record<BqField, number> = {
  description: 0.3,
  quantity: 0.2,
  amount: 0.2,
  rate: 0.15,
  unit: 0.1,
  ref: 0.05,
  notes: 0,
};

function analyseRow(sheet: GridSheet, rowIndex: number) {
  const row = sheet.rows[rowIndex] ?? [];
  const candidates: { column: number; field: BqField | "currency"; score: number }[] = [];
  row.forEach((cell, column) => {
    if (!cell || cell.t !== "s") return;
    const title = cellText(cell, 80);
    if (title.length > 60) return;
    const match = matchHeaderField(title);
    if (match) candidates.push({ column, ...match });
  });
  return candidates;
}

function assign(
  candidates: ReturnType<typeof analyseRow>,
  below: ReturnType<typeof analyseRow>,
): { columns: ColumnMap; scores: Partial<Record<BqField, number>> } {
  const columns: ColumnMap = {};
  const scores: Partial<Record<BqField, number>> = {};
  const taken = new Set<number>();
  const ordered = [...candidates]
    .filter((candidate) => candidate.field !== "currency")
    .sort((left, right) => right.score - left.score || left.column - right.column);
  for (const candidate of ordered) {
    const field = candidate.field as BqField;
    if (columns[field] !== undefined || taken.has(candidate.column)) continue;
    columns[field] = candidate.column;
    scores[field] = candidate.score;
    taken.add(candidate.column);
  }
  // Currency-only titles ("KShs") on the header row or the row below it are the money columns:
  // the right-most is the amount, the one before it the rate.
  const currency = [...candidates, ...below]
    .filter((candidate) => candidate.field === "currency" && !taken.has(candidate.column))
    .map((candidate) => candidate.column)
    .sort((left, right) => left - right);
  const unique = [...new Set(currency)];
  if (columns.amount === undefined && unique.length) {
    const column = unique.pop()!;
    columns.amount = column;
    scores.amount = 0.6;
    taken.add(column);
  }
  if (columns.rate === undefined && unique.length) {
    const column = unique.pop()!;
    columns.rate = column;
    scores.rate = 0.6;
  }
  return { columns, scores };
}

/**
 * Finds the header row of a bill sheet by keyword matching and proposes a column mapping with a
 * confidence score. Returns null when no row looks like a BQ header.
 */
export function detectHeader(sheet: GridSheet): HeaderDetection | null {
  let best: HeaderDetection | null = null;
  const limit = Math.min(sheet.rows.length, HEADER_SEARCH_ROWS);
  for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
    const candidates = analyseRow(sheet, rowIndex);
    if (candidates.length < 2) continue;
    const { columns, scores } = assign(candidates, analyseRow(sheet, rowIndex + 1));
    if (columns.description === undefined) continue;
    let weight = 0;
    let quality = 0;
    for (const [field, score] of Object.entries(scores) as [BqField, number][]) {
      weight += WEIGHTS[field];
      quality += WEIGHTS[field] * score;
    }
    const found = Object.keys(columns).length;
    if (found < 3) continue;
    const confidence = Math.round(Math.min(1, quality) * 100) / 100;
    if (confidence < HEADER_MIN_CONFIDENCE || weight === 0) continue;
    if (!best || confidence > best.confidence) {
      best = {
        row: rowIndex + 1,
        columns,
        confidence,
        signature: headerSignature(sheet, rowIndex + 1),
      };
    }
  }
  return best;
}

/** Normalised non-empty header texts of a row, joined in column order. */
export function headerSignature(sheet: GridSheet, row: number): string {
  return (sheet.rows[row - 1] ?? [])
    .map((cell) => (cell && cell.t === "s" ? normaliseHeader(cellText(cell, 80)) : ""))
    .filter(Boolean)
    .join("|")
    .slice(0, 500);
}

/** Column of the first non-empty header cell (the origin of template column offsets). */
export function headerOrigin(sheet: GridSheet, row: number): number {
  const cells = sheet.rows[row - 1] ?? [];
  const index = cells.findIndex((cell) => cell !== null && cell.t === "s" && cell.v.trim() !== "");
  return Math.max(0, index);
}

/** Finds the first row in the search window whose header signature equals `signature`. */
export function findHeaderRow(sheet: GridSheet, signature: string): number | null {
  const limit = Math.min(sheet.rows.length, HEADER_SEARCH_ROWS);
  for (let row = 1; row <= limit; row += 1) {
    if (headerSignature(sheet, row) === signature) return row;
  }
  return null;
}
