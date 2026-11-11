import type { BqField, BqSheetKind } from "@pm-buddy/types";
import { isUpperCaseHeading, parseBillHeading } from "./classify.js";
import {
  isBlankCell,
  lastUsedRow,
  usedColumns,
  type GridSheet,
  type WorkbookGrid,
} from "./grid.js";
import {
  detectHeader,
  findHeaderRow,
  headerOrigin,
  HEADER_SEARCH_ROWS,
  matchHeaderField,
  type ColumnMap,
  type HeaderDetection,
} from "./header.js";
import { cellText, readNumeric } from "./numbers.js";

/** The confirmed (or proposed) mapping of one worksheet. Rows are 1-based Excel rows. */
export interface BqSheetMapping {
  sheetIndex: number;
  include: boolean;
  /** A bill sheet becomes a bill; a summary sheet is only used for reconciliation. */
  role: "bill" | "summary";
  billNumber: string;
  billTitle: string;
  headerRow: number;
  firstDataRow: number;
  lastDataRow: number;
  columns: ColumnMap;
}

export interface BqMapping {
  sheets: BqSheetMapping[];
  /** The saved template applied, if any (informational). */
  templateId: string | null;
}

/** A saved mapping template: column offsets from the first header cell, by header signature. */
export interface BqTemplateLike {
  id: string;
  signature: string;
  columns: Partial<Record<BqField, number>>;
  /** firstDataRow − headerRow. */
  dataOffset: number;
}

export interface SheetAnalysis {
  index: number;
  name: string;
  hidden: boolean;
  usedRows: number;
  usedColumns: number;
  kind: BqSheetKind;
  /** 0–1 confidence in `kind`. */
  kindConfidence: number;
  header: HeaderDetection | null;
  bill: { number: string | null; title: string | null };
  firstDataRow: number | null;
  lastDataRow: number | null;
  itemRows: number;
}

function rowText(sheet: GridSheet, row: number): string {
  return (
    (sheet.rows[row - 1] ?? [])
      .map((cell) => (cell && cell.t === "s" ? cellText(cell, 200) : ""))
      .filter(Boolean)
      .join(" ")
      // Collapse every Unicode space (NBSP, U+2000–U+200A, U+3000…) so patterns stay linear.
      .replace(/\s+/g, " ")
      .trim()
  );
}

function rowHasNumber(sheet: GridSheet, row: number): boolean {
  return (sheet.rows[row - 1] ?? []).some((cell) => readNumeric(cell).kind === "number");
}

/** Rows that look like priced items below the header: a description and a quantity or amount. */
function countItemRows(sheet: GridSheet, header: HeaderDetection, lastRow: number): number {
  const { description, quantity, amount, rate } = header.columns;
  let count = 0;
  for (let row = header.row + 1; row <= lastRow && count < 50; row += 1) {
    const cells = sheet.rows[row - 1] ?? [];
    const text = cellText(cells[description ?? -1] ?? null, 200);
    if (!text) continue;
    const priced = [quantity, amount, rate].some(
      (column) => column !== undefined && readNumeric(cells[column] ?? null).kind === "number",
    );
    if (priced) count += 1;
  }
  return count;
}

function detectBill(sheet: GridSheet, headerRow: number | null) {
  const fromName = parseBillHeading(sheet.name);
  const limit = Math.min(headerRow ? headerRow - 1 : 15, HEADER_SEARCH_ROWS);
  for (let row = 1; row <= limit; row += 1) {
    const text = rowText(sheet, row);
    const heading = parseBillHeading(text);
    if (!heading) continue;
    let title = heading.title;
    for (let next = row + 1; !title && next <= limit; next += 1) {
      const candidate = rowText(sheet, next);
      if (candidate && isUpperCaseHeading(candidate) && !rowHasNumber(sheet, next))
        title = candidate;
    }
    return { number: heading.number, title: title || fromName?.title || null };
  }
  if (fromName) return { number: fromName.number, title: fromName.title || null };
  return { number: null, title: null };
}

/** A sub-header row of currency/unit words only ("KShs | Cts") is skipped. */
function firstDataRowAfter(sheet: GridSheet, headerRow: number): number {
  const next = sheet.rows[headerRow] ?? [];
  const words = next.filter((cell) => !isBlankCell(cell));
  const currencyOnly =
    words.length > 0 &&
    words.every((cell) => cell?.t === "s" && matchHeaderField(cell.v)?.field === "currency");
  return headerRow + (currencyOnly ? 2 : 1);
}

/**
 * Scores a worksheet as a bill, a collection/summary page or something else, and finds its header
 * row, column mapping, bill number and title and data rows.
 */
export function analyseSheet(sheet: GridSheet, index: number): SheetAnalysis {
  const usedRows = lastUsedRow(sheet);
  const header = detectHeader(sheet);
  const itemRows = header ? countItemRows(sheet, header, usedRows) : 0;
  const name = sheet.name.toLowerCase();
  const top = Array.from({ length: Math.min(usedRows, 15) }, (_, row) => rowText(sheet, row + 1))
    .join(" ")
    .toLowerCase();

  let summary = 0;
  if (/summary|muhtasari/.test(name)) summary += 0.6;
  if (/collection/.test(name)) summary += 0.5;
  if (/(grand|general|main|final) summary|summary of bills|bills? summary/.test(top))
    summary += 0.4;
  let billLines = 0;
  let totals = 0;
  for (let row = 1; row <= usedRows; row += 1) {
    const text = rowText(sheet, row).toLowerCase();
    if (!text || !rowHasNumber(sheet, row)) continue;
    if (/\bbill ?(?:(?:no|nr)\.? ?)?[:.]? ?(?:\d+|[ivxlc]+)\b/.test(text)) billLines += 1;
    if (/grand total|form of tender|contract sum|\bv\.?a\.?t\b/.test(text)) totals += 1;
  }
  if (billLines >= 2) summary += 0.3;
  if (totals > 0) summary += 0.2;

  const bill = detectBill(sheet, header?.row ?? null);
  let billScore = header ? header.confidence * (itemRows >= 3 ? 1 : 0.5) : 0;
  if (bill.number || /\bbill\b/.test(name)) billScore += 0.15;

  let kind: BqSheetKind = "other";
  let kindConfidence = Math.max(0, 1 - Math.max(summary, billScore));
  if (summary >= 0.5 && (summary > billScore || itemRows < 3)) {
    kind = "summary";
    kindConfidence = Math.min(1, summary);
  } else if (billScore >= 0.4 && header) {
    kind = "bill";
    kindConfidence = Math.min(1, billScore);
  }

  return {
    index,
    name: sheet.name,
    hidden: sheet.hidden,
    usedRows,
    usedColumns: usedColumns(sheet),
    kind,
    kindConfidence: Math.round(kindConfidence * 100) / 100,
    header,
    bill,
    firstDataRow: header ? firstDataRowAfter(sheet, header.row) : usedRows ? 1 : null,
    lastDataRow: usedRows || null,
    itemRows,
  };
}

/** Applies a template whose signature matches a header row of the sheet. */
export function templateColumns(
  sheet: GridSheet,
  template: BqTemplateLike,
): { headerRow: number; firstDataRow: number; columns: ColumnMap } | null {
  const headerRow = findHeaderRow(sheet, template.signature);
  if (!headerRow) return null;
  const origin = headerOrigin(sheet, headerRow);
  const columns: ColumnMap = {};
  for (const [field, offset] of Object.entries(template.columns) as [BqField, number][]) {
    const column = origin + offset;
    // The template doesn't fit this sheet (a column would fall left of column A).
    if (column < 0) return null;
    columns[field] = column;
  }
  return { headerRow, firstDataRow: headerRow + Math.max(1, template.dataOffset), columns };
}

/** Converts a sheet mapping into a template body (column offsets from the first header cell). */
export function templateFromMapping(
  sheet: GridSheet,
  mapping: BqSheetMapping,
): Omit<BqTemplateLike, "id" | "signature"> {
  const origin = headerOrigin(sheet, mapping.headerRow);
  const columns: Partial<Record<BqField, number>> = {};
  for (const [field, column] of Object.entries(mapping.columns) as [BqField, number][])
    if (column !== undefined) columns[field] = column - origin;
  return { columns, dataOffset: Math.max(1, mapping.firstDataRow - mapping.headerRow) };
}

/**
 * The proposed mapping for a parsed workbook: bill and summary sheets included, other sheets
 * left out, bill numbers taken from the sheet (or numbered in order) and, where a saved template's
 * header signature matches, the template's columns.
 */
export function proposeMapping(
  grid: WorkbookGrid,
  analyses: readonly SheetAnalysis[],
  templates: readonly BqTemplateLike[] = [],
): { mapping: BqMapping; templateMatches: Record<number, string> } {
  const used = new Set(analyses.map((analysis) => analysis.bill.number).filter(Boolean));
  let next = 1;
  const nextNumber = () => {
    while (used.has(String(next))) next += 1;
    used.add(String(next));
    return String(next);
  };
  const templateMatches: Record<number, string> = {};
  let templateId: string | null = null;
  const sheets = analyses.map((analysis): BqSheetMapping => {
    const sheet = grid.sheets[analysis.index]!;
    const role = analysis.kind === "summary" ? "summary" : "bill";
    let headerRow = analysis.header?.row ?? 1;
    let firstDataRow = analysis.firstDataRow ?? 1;
    let columns: ColumnMap = { ...analysis.header?.columns };
    if (role === "bill") {
      for (const template of templates) {
        const applied = templateColumns(sheet, template);
        if (!applied) continue;
        ({ headerRow, firstDataRow, columns } = applied);
        templateMatches[analysis.index] = template.id;
        templateId ??= template.id;
        break;
      }
    }
    const include = analysis.kind !== "other";
    return {
      sheetIndex: analysis.index,
      include,
      role,
      billNumber: role === "bill" ? (analysis.bill.number ?? (include ? nextNumber() : "")) : "",
      billTitle: role === "bill" ? (analysis.bill.title ?? analysis.name) : analysis.name,
      headerRow,
      firstDataRow,
      lastDataRow: Math.max(firstDataRow, analysis.lastDataRow ?? firstDataRow),
      columns,
    };
  });
  return { mapping: { sheets, templateId }, templateMatches };
}
