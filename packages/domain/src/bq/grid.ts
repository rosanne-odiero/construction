/**
 * A parsed workbook as the sandboxed parser hands it over (D2.2). Values only: formulas are never
 * evaluated, styles are not read. Row and column indices are zero-based and absolute, so
 * `rows[r][c]` is Excel cell (column c + 1, row r + 1).
 */
export type GridCell =
  /** A number (the cached value when `f` is set). */
  | { t: "n"; v: number; f?: 1 }
  /** Text (the cached value when `f` is set). */
  | { t: "s"; v: string; f?: 1 }
  | { t: "b"; v: boolean; f?: 1 }
  /** An Excel error value such as `#REF!`. */
  | { t: "e"; v: string; f?: 1 }
  /** A formula without a cached value. */
  | { t: "f" };

export type GridRow = (GridCell | null)[];

export interface GridSheet {
  name: string;
  hidden: boolean;
  rows: GridRow[];
}

export interface WorkbookGrid {
  fileType: "xlsx" | "xls";
  sheets: GridSheet[];
}

/** Zero-based column index → Excel letters (0 → A, 27 → AB). */
export function columnLetter(index: number): string {
  let value = index + 1;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

/** The cell at a 1-based Excel row and a zero-based column, or null. */
export function cellAt(sheet: GridSheet, row: number, column: number | undefined): GridCell | null {
  if (column === undefined || row < 1) return null;
  return sheet.rows[row - 1]?.[column] ?? null;
}

export const hasFormula = (cell: GridCell | null): boolean =>
  cell !== null && (cell.t === "f" || cell.f === 1);

export function isBlankCell(cell: GridCell | null): boolean {
  if (cell === null) return true;
  return cell.t === "s" && cell.v.trim() === "";
}

/** Number of the last row (1-based) that holds any value; 0 for an empty sheet. */
export function lastUsedRow(sheet: GridSheet): number {
  for (let index = sheet.rows.length - 1; index >= 0; index -= 1) {
    if (sheet.rows[index]?.some((cell) => !isBlankCell(cell))) return index + 1;
  }
  return 0;
}

/** Number of columns in use (the widest row). */
export function usedColumns(sheet: GridSheet): number {
  let width = 0;
  for (const row of sheet.rows) {
    if (!row) continue;
    for (let column = row.length - 1; column >= width; column -= 1) {
      if (!isBlankCell(row[column] ?? null)) {
        width = column + 1;
        break;
      }
    }
  }
  return width;
}
