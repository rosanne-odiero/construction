import {
  BQ_AMOUNT_TOLERANCE_MINOR,
  BQ_ISSUES,
  type BqIssueCode,
  type BqItemKind,
  type BqRowAction,
} from "@pm-buddy/types";
import { Decimal } from "decimal.js";
import type { BqMapping, BqSheetMapping } from "./analyse.js";
import {
  addMinor,
  buildBill,
  type BqIssue,
  type BuiltBill,
  type InlineSummaryLine,
  type RowResolution,
} from "./bill.js";
import type { WorkbookGrid } from "./grid.js";
import { minorToDecimal } from "./numbers.js";
import { parseSummary, type SummaryLine } from "./summary.js";

export interface BqResolutions {
  rows: { sheetIndex: number; row: number; action: BqRowAction; reason?: string | null }[];
  /** Warning codes accepted as a group, each with a reason. */
  accepted: { code: BqIssueCode; reason: string }[];
}

export const EMPTY_RESOLUTIONS: BqResolutions = { rows: [], accepted: [] };

export interface BqBuildOptions {
  /** VAT rate in percent as a decimal string ("16"). */
  vatRatePercent: string;
  /** The project's contract sum (minor units), compared with the grand total. */
  contractSumMinor: number | null;
  toleranceMinor?: number;
  /** Issues kept per code in the report (counts are always complete). */
  maxIssuesPerCode?: number;
}

/** Totals by class (brief §5.2 summary), all in minor units. */
export interface BqKindTotals {
  measured: number;
  preliminaries: number;
  provisionalSums: number;
  pcSums: number;
  pcAttendanceProfit: number;
  contingencies: number;
  dayworks: number;
}

export interface BqTotals {
  billCount: number;
  sectionCount: number;
  itemCount: number;
  subtotalMinor: number;
  vatRatePercent: string;
  vatMinor: number;
  grandTotalMinor: number;
  byKind: BqKindTotals;
  /** What the summary sheet says (null when it has no such line). */
  sheet: { subtotalMinor: number | null; vatMinor: number | null; grandTotalMinor: number | null };
  contractSumMinor: number | null;
}

export interface BqReadiness {
  /** Unresolved errors. */
  blocking: number;
  /** Warning codes with unresolved findings and no acceptance. */
  unacceptedWarnings: BqIssueCode[];
  canCommit: boolean;
}

export interface BqBuildResult {
  bills: BuiltBill[];
  totals: BqTotals;
  issues: BqIssue[];
  /** Complete counts per code (the issue list may be capped). */
  counts: Partial<Record<BqIssueCode, number>>;
  unresolvedCounts: Partial<Record<BqIssueCode, number>>;
  readiness: BqReadiness;
  summaryLines: SummaryLine[];
}

const KIND_BUCKET: Record<BqItemKind, keyof BqKindTotals> = {
  measured: "measured",
  preliminary: "preliminaries",
  provisional_sum: "provisionalSums",
  pc_sum: "pcSums",
  pc_attendance: "pcAttendanceProfit",
  pc_profit: "pcAttendanceProfit",
  contingency: "contingencies",
  daywork: "dayworks",
};

/** VAT on the subtotal, rounded half-up to the cent once (document rounding order). */
export function vatMinor(subtotalMinor: number, ratePercent: string): number {
  const value = new Decimal(subtotalMinor)
    .times(ratePercent)
    .dividedBy(100)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
  if (!Number.isSafeInteger(value)) throw new RangeError("VAT out of range");
  return value;
}

function globalIssue(
  code: BqIssueCode,
  extra: Partial<Omit<BqIssue, "code" | "severity">> = {},
): BqIssue {
  return {
    code,
    severity: BQ_ISSUES[code],
    sheetIndex: null,
    sheet: null,
    row: null,
    column: null,
    billNumber: null,
    ref: null,
    values: {},
    actions: [],
    resolution: null,
    ...extra,
  };
}

/** Whether a finding still needs attention (not resolved by a row action). */
export const isOpen = (issue: BqIssue) => issue.resolution === null;

/**
 * Builds the whole BQ from a parsed workbook and its confirmed mapping, then validates it: per-row
 * findings from each bill, duplicate bill numbers, reconciliation against the summary sheet
 * (bill lines, subtotal, VAT recomputed at the configured rate, grand total) and the project's
 * contract sum. Pure and deterministic: the same inputs always give the same report.
 */
export function buildBqImport(
  grid: WorkbookGrid,
  mapping: BqMapping,
  options: BqBuildOptions,
  resolutions: BqResolutions = EMPTY_RESOLUTIONS,
): BqBuildResult {
  const tolerance = options.toleranceMinor ?? BQ_AMOUNT_TOLERANCE_MINOR;
  const issues: BqIssue[] = [];
  const bills: BuiltBill[] = [];
  const byRow = new Map<number, Map<number, RowResolution>>();
  for (const resolution of resolutions.rows) {
    const sheetMap = byRow.get(resolution.sheetIndex) ?? new Map<number, RowResolution>();
    sheetMap.set(resolution.row, { action: resolution.action, reason: resolution.reason ?? null });
    byRow.set(resolution.sheetIndex, sheetMap);
  }

  const included = mapping.sheets.filter(
    (sheet) => sheet.include && grid.sheets[sheet.sheetIndex] !== undefined,
  );
  const billSheets = included.filter((sheet) => sheet.role === "bill");
  const summarySheets = included.filter((sheet) => sheet.role === "summary");

  const numbers = new Map<string, BqSheetMapping>();
  const inline: { sheetIndex: number; sheet: string; line: InlineSummaryLine }[] = [];
  for (const sheetMapping of billSheets) {
    const sheet = grid.sheets[sheetMapping.sheetIndex]!;
    const key = sheetMapping.billNumber.trim().toLowerCase();
    if (numbers.has(key))
      issues.push(
        globalIssue("duplicate-bill-number", {
          sheetIndex: sheetMapping.sheetIndex,
          sheet: sheet.name,
          billNumber: sheetMapping.billNumber,
        }),
      );
    numbers.set(key, sheetMapping);
    const built = buildBill(sheet, sheetMapping, {
      sheetIndex: sheetMapping.sheetIndex,
      resolutions: byRow.get(sheetMapping.sheetIndex) ?? new Map(),
      toleranceMinor: tolerance,
    });
    issues.push(...built.issues);
    for (const line of built.inlineSummary)
      inline.push({ sheetIndex: sheetMapping.sheetIndex, sheet: sheet.name, line });
    if (built.bill.itemCount === 0)
      issues.push(
        globalIssue("no-items", {
          sheetIndex: sheetMapping.sheetIndex,
          sheet: sheet.name,
          billNumber: sheetMapping.billNumber,
        }),
      );
    bills.push(built.bill);
  }
  if (!billSheets.length) issues.push(globalIssue("no-bills"));

  const byKind: BqKindTotals = {
    measured: 0,
    preliminaries: 0,
    provisionalSums: 0,
    pcSums: 0,
    pcAttendanceProfit: 0,
    contingencies: 0,
    dayworks: 0,
  };
  let subtotal = 0;
  let sectionCount = 0;
  let itemCount = 0;
  for (const bill of bills) {
    subtotal = addMinor(subtotal, bill.totalMinor);
    sectionCount += bill.sections.length;
    for (const section of bill.sections) {
      itemCount += section.items.length;
      for (const item of section.items) {
        const bucket = KIND_BUCKET[item.kind];
        byKind[bucket] = addMinor(byKind[bucket], item.amountMinor);
      }
    }
  }
  const vat = vatMinor(subtotal, options.vatRatePercent);
  const grand = addMinor(subtotal, vat);

  const summaryLines: SummaryLine[] = [];
  const sheetTotals: BqTotals["sheet"] = {
    subtotalMinor: null,
    vatMinor: null,
    grandTotalMinor: null,
  };
  for (const sheetMapping of summarySheets) {
    const sheet = grid.sheets[sheetMapping.sheetIndex]!;
    const lines = parseSummary(sheet, sheetMapping);
    summaryLines.push(...lines);
    const at = (line: SummaryLine) => ({
      sheetIndex: sheetMapping.sheetIndex,
      sheet: sheet.name,
      row: line.row,
    });
    for (const line of lines) {
      const values = (computed: number) => ({
        sheet: minorToDecimal(line.amountMinor),
        computed: minorToDecimal(computed),
      });
      if (line.kind === "bill") {
        const bill = bills.find(
          (candidate) => candidate.number.trim().toLowerCase() === line.billNumber?.toLowerCase(),
        );
        if (!bill)
          issues.push(
            globalIssue("summary-bill-missing", {
              ...at(line),
              billNumber: line.billNumber,
              values: { sheet: minorToDecimal(line.amountMinor) },
            }),
          );
        else if (Math.abs(bill.totalMinor - line.amountMinor) > tolerance)
          issues.push(
            globalIssue("summary-bill-mismatch", {
              ...at(line),
              billNumber: bill.number,
              values: values(bill.totalMinor),
            }),
          );
      } else if (line.kind === "subtotal") {
        sheetTotals.subtotalMinor = line.amountMinor;
        if (Math.abs(line.amountMinor - subtotal) > tolerance)
          issues.push(globalIssue("subtotal-mismatch", { ...at(line), values: values(subtotal) }));
      } else if (line.kind === "vat") {
        sheetTotals.vatMinor = line.amountMinor;
        if (Math.abs(line.amountMinor - vat) > tolerance)
          issues.push(
            globalIssue("vat-mismatch", {
              ...at(line),
              values: {
                ...values(vat),
                rate: options.vatRatePercent,
                ...(line.ratePercent ? { sheetRate: line.ratePercent } : {}),
              },
            }),
          );
      } else if (line.kind === "grand") {
        sheetTotals.grandTotalMinor = line.amountMinor;
        if (Math.abs(line.amountMinor - grand) > tolerance)
          issues.push(globalIssue("grand-total-mismatch", { ...at(line), values: values(grand) }));
      } else {
        issues.push(
          globalIssue("summary-unmatched-line", {
            ...at(line),
            values: { sheet: minorToDecimal(line.amountMinor), text: line.text.slice(0, 80) },
          }),
        );
      }
    }
  }
  for (const { sheetIndex, sheet, line } of inline) {
    const at = { sheetIndex, sheet, row: line.row };
    if (line.kind === "vat") {
      sheetTotals.vatMinor ??= line.amountMinor;
      if (Math.abs(line.amountMinor - vat) > tolerance)
        issues.push(
          globalIssue("vat-mismatch", {
            ...at,
            values: {
              sheet: minorToDecimal(line.amountMinor),
              computed: minorToDecimal(vat),
              rate: options.vatRatePercent,
              ...(line.ratePercent ? { sheetRate: line.ratePercent } : {}),
            },
          }),
        );
    } else {
      sheetTotals.grandTotalMinor ??= line.amountMinor;
      if (Math.abs(line.amountMinor - grand) > tolerance)
        issues.push(
          globalIssue("grand-total-mismatch", {
            ...at,
            values: { sheet: minorToDecimal(line.amountMinor), computed: minorToDecimal(grand) },
          }),
        );
    }
  }
  if (!summarySheets.length && !inline.length && billSheets.length)
    issues.push(globalIssue("no-summary"));
  if (options.contractSumMinor === null) issues.push(globalIssue("contract-sum-unset"));
  else if (Math.abs(options.contractSumMinor - grand) > tolerance)
    issues.push(
      globalIssue("contract-sum-mismatch", {
        values: {
          contractSum: minorToDecimal(options.contractSumMinor),
          computed: minorToDecimal(grand),
        },
      }),
    );

  const accepted = new Set(resolutions.accepted.map((entry) => entry.code));
  const counts: Partial<Record<BqIssueCode, number>> = {};
  const unresolvedCounts: Partial<Record<BqIssueCode, number>> = {};
  let blocking = 0;
  const unaccepted = new Set<BqIssueCode>();
  for (const found of issues) {
    counts[found.code] = (counts[found.code] ?? 0) + 1;
    if (!isOpen(found)) continue;
    unresolvedCounts[found.code] = (unresolvedCounts[found.code] ?? 0) + 1;
    if (found.severity === "error") blocking += 1;
    else if (found.severity === "warning" && !accepted.has(found.code)) unaccepted.add(found.code);
  }
  const cap = options.maxIssuesPerCode ?? Number.POSITIVE_INFINITY;
  const kept = new Map<BqIssueCode, number>();
  const capped = issues.filter((found) => {
    const seen = kept.get(found.code) ?? 0;
    kept.set(found.code, seen + 1);
    return seen < cap;
  });
  const unacceptedWarnings = [...unaccepted].sort();
  return {
    bills,
    totals: {
      billCount: bills.length,
      sectionCount,
      itemCount,
      subtotalMinor: subtotal,
      vatRatePercent: options.vatRatePercent,
      vatMinor: vat,
      grandTotalMinor: grand,
      byKind,
      sheet: sheetTotals,
      contractSumMinor: options.contractSumMinor,
    },
    issues: capped,
    counts,
    unresolvedCounts,
    readiness: {
      blocking,
      unacceptedWarnings,
      canCommit: blocking === 0 && unacceptedWarnings.length === 0 && bills.length > 0,
    },
    summaryLines,
  };
}

/**
 * Checks requested row resolutions against the report: the row must have a finding that offers
 * the action, and using the sheet amount needs a reason. Returns the rejected entries.
 */
export function invalidResolutions(
  result: BqBuildResult,
  rows: BqResolutions["rows"],
): BqResolutions["rows"] {
  return rows.filter((entry) => {
    const offered = result.issues.some(
      (found) =>
        found.sheetIndex === entry.sheetIndex &&
        found.row === entry.row &&
        (entry.action === "exclude"
          ? found.actions.length > 0
          : found.actions.includes(entry.action)),
    );
    const reasonOk = entry.action !== "sheet" || (entry.reason?.trim().length ?? 0) >= 3;
    return !offered || !reasonOk;
  });
}
