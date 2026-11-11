import {
  BQ_AMOUNT_TOLERANCE_MINOR,
  BQ_ISSUES,
  type BqAmountSource,
  type BqBillKind,
  type BqField,
  type BqIssueCode,
  type BqIssueSeverity,
  type BqItemKind,
  type BqRowAction,
  type BqUnit,
} from "@pm-buddy/types";
import { decimalToMinor, lineAmountFromRate } from "../money.js";
import type { BqSheetMapping } from "./analyse.js";
import { billKind, isUpperCaseHeading, itemKind, rowMarker } from "./classify.js";
import { columnLetter, hasFormula, type GridCell, type GridSheet } from "./grid.js";
import {
  cellText,
  isNegativeDecimal,
  minorToDecimal,
  percentageOfMinor,
  readNumeric,
  type NumericCell,
} from "./numbers.js";
import { sanitiseCellText } from "./text.js";
import { normaliseUnit } from "./units.js";

/** One finding in the validation report. Rows are 1-based Excel rows. */
export interface BqIssue {
  code: BqIssueCode;
  severity: BqIssueSeverity;
  sheetIndex: number | null;
  sheet: string | null;
  row: number | null;
  column: string | null;
  billNumber: string | null;
  ref: string | null;
  /** Decimal strings and short texts that explain the finding (never trusted as input). */
  values: Record<string, string>;
  /** Per-row resolutions offered for this finding. */
  actions: BqRowAction[];
  /** The resolution applied to the row, if any. */
  resolution: BqRowAction | null;
}

export interface BuiltItem {
  ref: string | null;
  description: string;
  unit: BqUnit | null;
  unitRaw: string | null;
  quantity: string | null;
  rate: string | null;
  amountMinor: number;
  sheetAmountMinor: number | null;
  amountSource: BqAmountSource;
  overrideReason: string | null;
  kind: BqItemKind;
  notes: string | null;
  sheetRow: number;
  hasFormula: boolean;
}

export interface BuiltSection {
  code: string | null;
  title: string | null;
  notes: string | null;
  sheetRow: number | null;
  items: BuiltItem[];
  totalMinor: number;
}

export interface BuiltBill {
  number: string;
  title: string;
  kind: BqBillKind;
  sheetIndex: number;
  sheetName: string;
  sections: BuiltSection[];
  totalMinor: number;
  /** The bill total written on the sheet (to collection/summary), if any. */
  sheetTotalMinor: number | null;
  itemCount: number;
}

/** VAT and grand-total rows found at the foot of a bill sheet (single-sheet BQs). */
export interface InlineSummaryLine {
  row: number;
  kind: "vat" | "grand";
  amountMinor: number;
  ratePercent: string | null;
}

export type RowResolution = { action: BqRowAction; reason?: string | null };

export interface BillContext {
  sheetIndex: number;
  /** Keyed by 1-based row. */
  resolutions: ReadonlyMap<number, RowResolution>;
  toleranceMinor?: number;
}

/** Adds minor units, refusing totals beyond the safe integer range. */
export function addMinor(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new RangeError("BQ total out of range");
  return total;
}

const MAX_LINE_MINOR = 100_000_000_000_000;

type RowCells = {
  ref: string;
  description: string;
  unitText: string;
  quantity: NumericCell;
  rate: NumericCell;
  amount: NumericCell;
  notes: string;
  raw: Partial<Record<BqField, GridCell | null>>;
};

function readRow(sheet: GridSheet, row: number, columns: BqSheetMapping["columns"]): RowCells {
  const cells = sheet.rows[row - 1] ?? [];
  const get = (field: BqField) => {
    const column = columns[field];
    return column === undefined ? null : (cells[column] ?? null);
  };
  const raw: RowCells["raw"] = {};
  for (const field of [
    "ref",
    "description",
    "unit",
    "quantity",
    "rate",
    "amount",
    "notes",
  ] as const)
    raw[field] = get(field);
  return {
    ref: cellText(raw.ref ?? null, 30).replace(/[.:]$/, ""),
    description: cellText(raw.description ?? null),
    unitText: cellText(raw.unit ?? null, 30),
    quantity: readNumeric(raw.quantity ?? null),
    rate: readNumeric(raw.rate ?? null),
    amount: readNumeric(raw.amount ?? null),
    notes: cellText(raw.notes ?? null, 1_000),
    raw,
  };
}

/** The right-most number on a row (totals are sometimes outside the amount column). */
function rightmostNumber(sheet: GridSheet, row: number): number | null {
  const cells = sheet.rows[row - 1] ?? [];
  for (let column = cells.length - 1; column >= 0; column -= 1) {
    const value = readNumeric(cells[column] ?? null);
    if (value.kind === "number") return decimalToMinor(value.value);
  }
  return null;
}

const isBlankRow = (cells: RowCells) =>
  !cells.ref &&
  !cells.description &&
  !cells.unitText &&
  !cells.notes &&
  cells.quantity.kind === "blank" &&
  cells.rate.kind === "blank" &&
  cells.amount.kind === "blank" &&
  !Object.values(cells.raw).some((cell) => hasFormula(cell ?? null));

/**
 * Builds one bill from a mapped worksheet: Section/Element headings, items (with multi-line
 * descriptions joined), page/carried-forward/collection rows recognised and reconciled but never
 * imported as items. Amounts are computed (quantity × rate, rounded per line); the sheet's own
 * amount is kept separately and compared.
 */
export function buildBill(
  sheet: GridSheet,
  mapping: BqSheetMapping,
  context: BillContext,
): { bill: BuiltBill; issues: BqIssue[]; inlineSummary: InlineSummaryLine[] } {
  const tolerance = context.toleranceMinor ?? BQ_AMOUNT_TOLERANCE_MINOR;
  const issues: BqIssue[] = [];
  const kindOfBill = billKind(mapping.billTitle, mapping.billNumber);
  const sections: BuiltSection[] = [];
  let current: BuiltSection | null = null;
  let pending: { ref: string | null; lines: string[]; row: number } | null = null;
  let pageIndex = 0;
  let pageSum = 0;
  let billSum = 0;
  let lastCarried: number | null = null;
  let collection = false;
  const pages: { row: number; sheet: number; computed: number }[] = [];
  const collectionEntries: { row: number; sheet: number }[] = [];
  let billTotal: { row: number; sheet: number } | null = null;
  const inlineSummary: InlineSummaryLine[] = [];
  const seenRefs = new Set<string>();
  let lastPcSumMinor: number | null = null;
  let afterPcSum = false;
  const last = Math.min(mapping.lastDataRow, sheet.rows.length);

  const issue = (
    code: BqIssueCode,
    row: number | null,
    extra: Partial<Pick<BqIssue, "column" | "ref" | "values" | "actions">> = {},
  ): BqIssue => {
    const created: BqIssue = {
      code,
      severity: BQ_ISSUES[code],
      sheetIndex: context.sheetIndex,
      sheet: sheet.name,
      row,
      column: extra.column ?? null,
      billNumber: mapping.billNumber,
      ref: extra.ref ?? null,
      values: extra.values ?? {},
      actions: extra.actions ?? [],
      resolution: null,
    };
    issues.push(created);
    return created;
  };

  const section = (): BuiltSection => {
    if (!current) {
      current = { code: null, title: null, notes: null, sheetRow: null, items: [], totalMinor: 0 };
      sections.push(current);
    }
    return current;
  };

  const appendNote = (text: string) => {
    const target = section();
    const combined = target.notes ? `${target.notes}\n${text}` : text;
    target.notes = sanitiseCellText(combined, 4_000).text;
  };

  const flushPending = () => {
    if (!pending) return;
    const text = pending.lines.join("\n");
    if (pending.ref) {
      addItem(pending.row, pending.ref, text, null, {
        ref: pending.ref,
        description: text,
        unitText: "",
        quantity: { kind: "blank" },
        rate: { kind: "blank" },
        amount: { kind: "blank" },
        notes: "",
        raw: {},
      });
    } else if (text) {
      appendNote(text);
    }
    pending = null;
  };

  const markerValue = (cells: RowCells, row: number): number | null =>
    cells.amount.kind === "number"
      ? decimalToMinor(cells.amount.value)
      : rightmostNumber(sheet, row);

  const nextRowHasRef = (from: number): boolean => {
    for (let row = from + 1; row <= last; row += 1) {
      const cells = readRow(sheet, row, mapping.columns);
      if (isBlankRow(cells)) continue;
      return Boolean(cells.ref);
    }
    return false;
  };

  function addItem(
    row: number,
    ref: string | null,
    description: string,
    unitText: string | null,
    cells: RowCells,
  ) {
    const resolution = context.resolutions.get(row) ?? null;
    const rowIssues: BqIssue[] = [];
    const flag = (
      code: BqIssueCode,
      extra: Partial<Pick<BqIssue, "column" | "values" | "actions">> = {},
    ) => rowIssues.push(issue(code, row, { ref, ...extra }));
    const column = (field: BqField) =>
      mapping.columns[field] === undefined ? null : columnLetter(mapping.columns[field]);

    const unit = normaliseUnit(unitText);
    const formula = Object.values(cells.raw).some((cell) => hasFormula(cell ?? null));
    let blocked = false;
    for (const field of ["quantity", "rate", "amount"] as const) {
      const raw = cells.raw[field] ?? null;
      const value = cells[field];
      if (raw?.t === "f") {
        flag("formula-without-value", { column: column(field), actions: ["exclude"] });
        blocked = true;
      } else if (value.kind === "invalid") {
        flag("non-numeric", {
          column: column(field),
          values: { field, text: value.raw.slice(0, 60) },
          actions: ["exclude"],
        });
        blocked = true;
      } else if (value.kind === "number" && value.rounded) {
        flag("precision-rounded", { column: column(field), values: { field, value: value.value } });
      }
    }
    if (formula) flag("formula-cell");

    const quantity = cells.quantity.kind === "number" ? cells.quantity.value : null;
    const rate = cells.rate.kind === "number" ? cells.rate.value : null;
    const sheetAmountMinor =
      cells.amount.kind === "number" ? decimalToMinor(cells.amount.value) : null;
    const tokens = [cells.quantity, cells.rate, cells.amount]
      .filter((value) => value.kind === "token")
      .map((value) => (value as { token: string }).token);
    if (quantity !== null && isNegativeDecimal(quantity)) {
      flag("negative-quantity", {
        column: column("quantity"),
        values: { quantity },
        actions: ["exclude"],
      });
      blocked = true;
    }

    const kind = itemKind(description, {
      billKind: kindOfBill,
      unit: unit?.code ?? null,
      afterPcSum,
    });
    let amountMinor = 0;
    let amountSource: BqAmountSource = "unpriced";
    let computedMinor: number | null = null;
    const mismatch = (computed: number) => {
      if (sheetAmountMinor !== null && Math.abs(sheetAmountMinor - computed) > tolerance)
        flag("amount-mismatch", {
          column: column("amount"),
          values: { sheet: minorToDecimal(sheetAmountMinor), computed: minorToDecimal(computed) },
          actions: ["computed", "sheet", "exclude"],
        });
    };
    const sheetActions = (): BqRowAction[] =>
      sheetAmountMinor !== null ? ["sheet", "exclude"] : ["exclude"];

    if (!blocked) {
      try {
        if (unit?.code === "pct" && quantity !== null) {
          const base = rate !== null ? decimalToMinor(rate) : lastPcSumMinor;
          if (base !== null) {
            computedMinor = percentageOfMinor(quantity, base);
            amountSource = "percentage";
            flag("percentage-line", { values: { percent: quantity, base: minorToDecimal(base) } });
            mismatch(computedMinor);
          } else if (sheetAmountMinor !== null) {
            amountSource = "lump_sum";
            computedMinor = sheetAmountMinor;
            flag("lump-sum");
          } else {
            flag("unpriced-item", { actions: ["exclude"] });
          }
        } else if (quantity !== null && rate !== null) {
          computedMinor = lineAmountFromRate(quantity, rate);
          amountSource = "computed";
          mismatch(computedMinor);
        } else if (quantity === null && rate === null) {
          if (sheetAmountMinor !== null) {
            amountSource = "lump_sum";
            computedMinor = sheetAmountMinor;
            flag("lump-sum");
          } else if (tokens.includes("included")) {
            amountSource = "included";
            flag("included-item");
          } else {
            flag("unpriced-item", { actions: ["exclude"] });
          }
        } else if (quantity !== null) {
          if (tokens.includes("included")) {
            amountSource = "included";
            flag("included-item");
          } else {
            flag("quantity-without-rate", { values: { quantity }, actions: sheetActions() });
          }
        } else {
          flag("rate-without-quantity", { values: { rate: rate ?? "" }, actions: sheetActions() });
        }
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        flag("non-numeric", {
          values: { field: "amount", text: "out_of_range" },
          actions: ["exclude"],
        });
        blocked = true;
        amountSource = "unpriced";
        computedMinor = null;
      }
      if (computedMinor !== null && Math.abs(computedMinor) > MAX_LINE_MINOR) {
        flag("non-numeric", {
          values: { field: "amount", text: "out_of_range" },
          actions: ["exclude"],
        });
        blocked = true;
        computedMinor = null;
        amountSource = "unpriced";
      }
      if (computedMinor !== null) amountMinor = computedMinor;
    }
    if (quantity !== null && !unit && (amountSource === "computed" || amountSource === "unpriced"))
      flag("missing-unit", { column: column("unit"), actions: ["exclude"] });
    if (unit?.code === "other") flag("unknown-unit", { values: { unit: unit.raw } });

    // Duplicate references within a bill: QS letters restart on each page (A, B, C…), so the scope
    // is the section and the page. A repeated reference is flagged (excluding the row resolves
    // it); an excluded row is not remembered as the first use.
    const target = section();
    const refKey = ref ? `${sections.indexOf(target)}|${pageIndex}|${ref.toLowerCase()}` : null;
    const excluded = resolution?.action === "exclude";
    if (refKey) {
      if (seenRefs.has(refKey))
        flag("duplicate-ref", { column: column("ref"), actions: ["exclude"] });
      else if (!excluded) seenRefs.add(refKey);
    }

    let overrideReason: string | null = null;
    if (resolution) {
      for (const found of rowIssues) {
        if (resolution.action === "exclude" || found.actions.includes(resolution.action))
          found.resolution = resolution.action;
      }
      if (
        resolution.action === "sheet" &&
        sheetAmountMinor !== null &&
        rowIssues.some((found) => found.actions.includes("sheet"))
      ) {
        amountMinor = sheetAmountMinor;
        amountSource = "sheet_override";
        overrideReason = resolution.reason?.trim() || null;
      }
    }
    if (excluded) return;

    target.items.push({
      ref,
      description: description || (ref ? `Item ${ref}` : `Row ${row}`),
      unit: unit?.code ?? null,
      unitRaw: unit?.raw ?? null,
      quantity,
      rate,
      amountMinor,
      sheetAmountMinor,
      amountSource,
      overrideReason,
      kind,
      notes: cells.notes || null,
      sheetRow: row,
      hasFormula: formula,
    });
    target.totalMinor = addMinor(target.totalMinor, amountMinor);
    pageSum = addMinor(pageSum, amountMinor);
    billSum = addMinor(billSum, amountMinor);
    if (kind === "pc_sum") {
      lastPcSumMinor = amountMinor;
      afterPcSum = true;
    } else if (kind !== "pc_attendance" && kind !== "pc_profit") {
      afterPcSum = false;
    }
  }

  for (let row = Math.max(1, mapping.firstDataRow); row <= last; row += 1) {
    const cells = readRow(sheet, row, mapping.columns);
    if (isBlankRow(cells)) continue;
    const text = cells.description;
    if (text) {
      const raw = cells.raw.description;
      if (raw?.t === "s") {
        const check = sanitiseCellText(raw.v);
        if (check.removed > 0)
          issue("control-characters-removed", row, { values: { count: String(check.removed) } });
        if (check.truncated)
          issue("text-truncated", row, { column: columnLetter(mapping.columns.description ?? 0) });
      }
    }
    const measured =
      cells.quantity.kind !== "blank" ||
      cells.rate.kind !== "blank" ||
      cells.raw.quantity?.t === "f" ||
      cells.raw.rate?.t === "f";
    const marker = measured ? null : rowMarker(text || cells.ref);

    if (marker) {
      flushPending();
      const value = markerValue(cells, row);
      if (marker === "bill_heading") continue;
      if (marker === "vat" || marker === "grand_total") {
        if (value !== null)
          inlineSummary.push({
            row,
            kind: marker === "vat" ? "vat" : "grand",
            amountMinor: value,
            ratePercent: /(\d+(?:\.\d+)?)\s*%/.exec(text)?.[1] ?? null,
          });
        continue;
      }
      if (marker === "collection") {
        collection = true;
        continue;
      }
      if (marker === "brought_forward") {
        if (
          value !== null &&
          lastCarried !== null &&
          Math.abs(value - lastCarried) > tolerance &&
          Math.abs(value - billSum) > tolerance
        )
          issue("brought-forward-mismatch", row, {
            values: { sheet: minorToDecimal(value), expected: minorToDecimal(lastCarried) },
          });
        continue;
      }
      if (marker === "bill_total" || (marker === "page_total" && collection)) {
        if (value !== null) billTotal = { row, sheet: value };
        collection = false;
        continue;
      }
      // A page total: "Carried to collection", "C/F", "Page total", "Total".
      if (value !== null) {
        const matchesPage = Math.abs(value - pageSum) <= tolerance;
        const matchesBill = Math.abs(value - billSum) <= tolerance;
        if (!matchesPage && !matchesBill)
          issue("page-total-mismatch", row, {
            values: { sheet: minorToDecimal(value), computed: minorToDecimal(pageSum) },
          });
        pages.push({ row, sheet: value, computed: pageSum });
        lastCarried = value;
      }
      pageSum = 0;
      pageIndex += 1;
      continue;
    }

    if (collection) {
      if (measured) {
        collection = false;
      } else {
        const value = markerValue(cells, row);
        if (value !== null) collectionEntries.push({ row, sheet: value });
        continue;
      }
    }

    const priced =
      measured ||
      cells.amount.kind !== "blank" ||
      Boolean(cells.unitText) ||
      cells.raw.amount?.t === "f";
    if (!priced) {
      if (!text) continue;
      const heading =
        (isUpperCaseHeading(text) && text.length <= 200) ||
        (!cells.ref && text.length <= 100 && !/[.:;,]$/.test(text) && nextRowHasRef(row));
      if (heading) {
        flushPending();
        current = {
          code: cells.ref || null,
          title: text.slice(0, 300),
          notes: null,
          sheetRow: row,
          items: [],
          totalMinor: 0,
        };
        sections.push(current);
        continue;
      }
      if (cells.ref) {
        flushPending();
        pending = { ref: cells.ref, lines: [text], row };
      } else if (pending) {
        pending.lines.push(text);
      } else {
        pending = { ref: null, lines: [text], row };
      }
      continue;
    }

    let ref: string | null = cells.ref || null;
    let lines: string[] = [];
    if (pending) {
      if (ref && pending.ref) {
        flushPending();
      } else {
        ref ??= pending.ref;
        lines = pending.lines;
        pending = null;
      }
    }
    const description = sanitiseCellText([...lines, text].filter(Boolean).join("\n")).text;
    addItem(row, ref, description, cells.unitText || null, cells);
  }
  flushPending();

  if (billTotal && Math.abs(billTotal.sheet - billSum) > tolerance)
    issue("bill-total-mismatch", billTotal.row, {
      values: { sheet: minorToDecimal(billTotal.sheet), computed: minorToDecimal(billSum) },
    });
  if (collectionEntries.length) {
    if (collectionEntries.length === pages.length) {
      collectionEntries.forEach((entry, index) => {
        const page = pages[index]!;
        if (Math.abs(entry.sheet - page.computed) > tolerance)
          issue("collection-total-mismatch", entry.row, {
            values: { sheet: minorToDecimal(entry.sheet), computed: minorToDecimal(page.computed) },
          });
      });
    } else {
      const total = collectionEntries.reduce((sum, entry) => addMinor(sum, entry.sheet), 0);
      if (Math.abs(total - billSum) > tolerance)
        issue("collection-total-mismatch", collectionEntries.at(-1)!.row, {
          values: { sheet: minorToDecimal(total), computed: minorToDecimal(billSum) },
        });
    }
  }

  const nonEmpty = sections.filter((built) => built.items.length || built.notes || built.title);
  const items = nonEmpty.flatMap((built) => built.items);
  const lumpShare = items.length
    ? items.filter((item) => item.amountSource === "lump_sum").length / items.length
    : 0;
  const kind = billKind(mapping.billTitle, mapping.billNumber, lumpShare);
  if (kind === "preliminaries" && kindOfBill !== "preliminaries") {
    for (const item of items) if (item.kind === "measured") item.kind = "preliminary";
  }
  return {
    bill: {
      number: mapping.billNumber,
      title: mapping.billTitle,
      kind,
      sheetIndex: context.sheetIndex,
      sheetName: sheet.name,
      sections: nonEmpty,
      totalMinor: billSum,
      sheetTotalMinor: billTotal?.sheet ?? null,
      itemCount: items.length,
    },
    issues,
    inlineSummary,
  };
}
