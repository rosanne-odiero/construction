import type { BqSheetMapping } from "./analyse.js";
import { parseBillHeading } from "./classify.js";
import { lastUsedRow, type GridSheet } from "./grid.js";
import { cellText, readNumeric } from "./numbers.js";
import { decimalToMinor } from "../money.js";

export type SummaryLineKind = "bill" | "subtotal" | "vat" | "grand" | "other";

export interface SummaryLine {
  row: number;
  kind: SummaryLineKind;
  billNumber: string | null;
  text: string;
  amountMinor: number;
  /** For a VAT line, the rate written on it ("16"), if any. */
  ratePercent: string | null;
}

const GRAND =
  /grand total|contract sum|tender sum|form of tender|total (contract|tender)|total (amount )?(inclusive|including|incl\.?) (of )?v\.?a\.?t/;
const VAT = /\bv\.?\s?a\.?\s?t\b|value added tax/;
const SUBTOTAL =
  /sub-?\s?total|total (of )?bills|total (excluding|excl\.?|exclusive of|before) v\.?a\.?t|^total\b/;

/**
 * Reads a grand summary or collection page: bill lines ("Bill No. 2 Substructure … 1,234,567"),
 * subtotal, VAT and grand total. The amount is the mapped amount column, else the right-most
 * number on the row. These figures are only compared with computed totals, never imported.
 */
export function parseSummary(sheet: GridSheet, mapping: BqSheetMapping): SummaryLine[] {
  const lines: SummaryLine[] = [];
  const first = Math.max(1, mapping.firstDataRow);
  const last = Math.min(mapping.lastDataRow, lastUsedRow(sheet));
  for (let row = first; row <= last; row += 1) {
    const cells = sheet.rows[row - 1] ?? [];
    const text = cells
      .map((cell) => (cell && cell.t === "s" ? cellText(cell, 200) : ""))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ");
    let amount: number | null = null;
    const mapped = mapping.columns.amount;
    if (mapped !== undefined) {
      const value = readNumeric(cells[mapped] ?? null);
      if (value.kind === "number") amount = decimalToMinor(value.value);
    }
    if (amount === null) {
      for (let column = cells.length - 1; column >= 0; column -= 1) {
        const value = readNumeric(cells[column] ?? null);
        if (value.kind === "number") {
          amount = decimalToMinor(value.value);
          break;
        }
      }
    }
    if (amount === null || !text) continue;
    const lower = text.toLowerCase();
    const rate = /(\d+(?:\.\d+)?)\s*%/.exec(lower)?.[1] ?? null;
    const heading = parseBillHeading(text);
    let kind: SummaryLineKind = "other";
    if (GRAND.test(lower)) kind = "grand";
    else if (VAT.test(lower)) kind = "vat";
    else if (heading) kind = "bill";
    else if (SUBTOTAL.test(lower)) kind = "subtotal";
    lines.push({
      row,
      kind,
      billNumber: kind === "bill" ? heading!.number : null,
      text: text.slice(0, 200),
      amountMinor: amount,
      ratePercent: kind === "vat" ? rate : null,
    });
  }
  return lines;
}
