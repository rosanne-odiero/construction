/**
 * Bill of Quantities vocabulary shared by web, API and database (D2.2). The database CHECK
 * constraints list the same keys, so adding a value needs a migration as well as a change here.
 */

/** Import lifecycle (brief §15 C/G). Transitions live in packages/domain `bq-import-lifecycle`. */
export const BQ_IMPORT_STATUSES = [
  "uploaded",
  "parsed",
  "mapped",
  "validated",
  "committed",
  "failed",
  "abandoned",
  "superseded",
] as const;
export type BqImportStatus = (typeof BQ_IMPORT_STATUSES)[number];

/** Accepted spreadsheet formats, identified by content signature (never by extension alone). */
export const BQ_FILE_TYPES = ["xlsx", "xls"] as const;
export type BqFileType = (typeof BQ_FILE_TYPES)[number];

/**
 * Upload and parsing limits (ARCHITECTURE §17, brief §15 F). The file size limit is also
 * enforced by the HTTP layer; the archive limits are checked on the zip central directory before
 * any decompression; the workbook limits are checked by the sandboxed parser.
 */
export const BQ_IMPORT_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxUncompressedBytes: 100 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxArchiveEntries: 10_000,
  maxSheets: 50,
  maxRowsPerSheet: 20_000,
  maxColumnsPerSheet: 100,
  maxCells: 200_000,
  maxCellTextLength: 4_000,
  parseTimeoutMs: 30_000,
  parseHeapMb: 384,
  previewRows: 200,
} as const;
export type BqImportLimits = { readonly [K in keyof typeof BQ_IMPORT_LIMITS]: number };

/** Why a stored upload could not be parsed (import status `failed`). */
export const BQ_IMPORT_FAILURES = [
  "workbook-encrypted",
  "workbook-unreadable",
  "too-many-sheets",
  "too-many-rows",
  "too-many-columns",
  "too-many-cells",
  "parse-timeout",
  "parse-memory",
  "no-sheets",
  "unsafe-archive",
  "too-much-text",
] as const;
export type BqImportFailure = (typeof BQ_IMPORT_FAILURES)[number];

/** How the scanner hook judged an upload (ARCHITECTURE §17 MalwareScanner). */
export const BQ_SCAN_STATUSES = ["clean", "not_scanned"] as const;
export type BqScanStatus = (typeof BQ_SCAN_STATUSES)[number];

/** What a worksheet looks like: a priced bill, a collection/summary page, or something else. */
export const BQ_SHEET_KINDS = ["bill", "summary", "other"] as const;
export type BqSheetKind = (typeof BQ_SHEET_KINDS)[number];

/** Item fields a column can be mapped to (brief §5.2). */
export const BQ_FIELDS = [
  "ref",
  "description",
  "unit",
  "quantity",
  "rate",
  "amount",
  "notes",
] as const;
export type BqField = (typeof BQ_FIELDS)[number];

/** Bill classes (ERD §4 BqBill.kind). */
export const BQ_BILL_KINDS = [
  "preliminaries",
  "measured",
  "provisional",
  "dayworks",
  "contingency",
] as const;
export type BqBillKind = (typeof BQ_BILL_KINDS)[number];

/**
 * Item classes. PC sums carry their attendance and profit lines; a lump sum is an amount with no
 * quantity or rate (see `BQ_AMOUNT_SOURCES`).
 */
export const BQ_ITEM_KINDS = [
  "measured",
  "preliminary",
  "provisional_sum",
  "pc_sum",
  "pc_attendance",
  "pc_profit",
  "contingency",
  "daywork",
] as const;
export type BqItemKind = (typeof BQ_ITEM_KINDS)[number];

/**
 * Where an item's amount comes from. `computed` is quantity × rate rounded per line; `percentage`
 * is a percentage of the PC sum above it; `lump_sum` is an amount-only line; `sheet_override` is
 * the spreadsheet's amount chosen by the user with a reason; `unpriced` and `included` are zero.
 * Approved variations (D2.3) add `fixed` (an amount set by the variation, with no rate: a lump
 * sum or a daywork allowance) and `omitted` (quantity 0 and amount 0; the item stays for history).
 */
export const BQ_AMOUNT_SOURCES = [
  "computed",
  "percentage",
  "lump_sum",
  "sheet_override",
  "unpriced",
  "included",
  "fixed",
  "omitted",
] as const;
export type BqAmountSource = (typeof BQ_AMOUNT_SOURCES)[number];

/**
 * Normalised units (brief §5.2). The original spelling is kept next to the code. `other` keeps an
 * unrecognised unit as written.
 */
export const BQ_UNITS = [
  "m3",
  "m2",
  "m",
  "kg",
  "t",
  "nr",
  "item",
  "ls",
  "pct",
  "hr",
  "day",
  "week",
  "month",
  "l",
  "set",
  "pair",
  "other",
] as const;
export type BqUnit = (typeof BQ_UNITS)[number];

/**
 * BQ version states (ERD §4). Version 1 is imported as a draft and approved as the contract
 * baseline; every later version is created by an approved variation and is approved from birth.
 * An approved version never changes. `superseded` is reserved: the current version is derived
 * (the newest approved one) instead of rewriting older versions.
 */
export const BQ_VERSION_STATUSES = ["draft", "approved", "superseded"] as const;
export type BqVersionStatus = (typeof BQ_VERSION_STATUSES)[number];

/** How a version came about: the original import or an approved variation (manual is reserved). */
export const BQ_VERSION_SOURCES = ["import", "variation", "manual"] as const;
export type BqVersionSource = (typeof BQ_VERSION_SOURCES)[number];

export const BQ_ISSUE_SEVERITIES = ["error", "warning", "info"] as const;
export type BqIssueSeverity = (typeof BQ_ISSUE_SEVERITIES)[number];

/**
 * Validation report codes, with their severity. Errors block the commit until the row is
 * resolved (or the mapping changed); warnings need an explicit acceptance with a reason, or a
 * per-row resolution; information needs no action.
 */
export const BQ_ISSUES = {
  "duplicate-ref": "error",
  "negative-quantity": "error",
  "non-numeric": "error",
  "formula-without-value": "error",
  "amount-mismatch": "error",
  "no-items": "error",
  "duplicate-bill-number": "error",
  "no-bills": "error",
  "missing-unit": "warning",
  "quantity-without-rate": "warning",
  "rate-without-quantity": "warning",
  "unpriced-item": "warning",
  "formula-cell": "warning",
  "precision-rounded": "warning",
  "page-total-mismatch": "warning",
  "brought-forward-mismatch": "warning",
  "collection-total-mismatch": "warning",
  "bill-total-mismatch": "warning",
  "summary-bill-mismatch": "warning",
  "summary-bill-missing": "warning",
  "summary-unmatched-line": "warning",
  "subtotal-mismatch": "warning",
  "vat-mismatch": "warning",
  "grand-total-mismatch": "warning",
  "contract-sum-mismatch": "warning",
  "text-truncated": "warning",
  "lump-sum": "info",
  "included-item": "info",
  "unknown-unit": "info",
  "percentage-line": "info",
  "control-characters-removed": "info",
  "contract-sum-unset": "info",
  "no-summary": "info",
} as const satisfies Record<string, BqIssueSeverity>;
export type BqIssueCode = keyof typeof BQ_ISSUES;
export const BQ_ISSUE_CODES = Object.keys(BQ_ISSUES) as BqIssueCode[];

/** Per-row resolutions offered in the validation report. */
export const BQ_ROW_ACTIONS = ["computed", "sheet", "exclude"] as const;
export type BqRowAction = (typeof BQ_ROW_ACTIONS)[number];

/**
 * VAT on the BQ grand summary (configuration key `bq.vat.rate`, docs/CONFIGURATION.md). The rate
 * is a legal value awaiting compliance review (CR-TAX-01); each BQ version stores the rate and
 * its review status it was built with.
 */
export const BQ_VAT_RULE = {
  key: "bq.vat.rate",
  defaultRatePercent: "16",
  status: "compliance_review",
} as const;

/** Line rounding policy (`bq.rounding`, FINANCIAL_MODEL.md): half-up to the cent per line. */
export const BQ_ROUNDING = "half_up_line" as const;

/**
 * Largest difference between a spreadsheet amount and quantity × rate that is treated as a
 * rounding difference (KES 1.00, `bq.import.amount_tolerance_minor`).
 */
export const BQ_AMOUNT_TOLERANCE_MINOR = 100;
