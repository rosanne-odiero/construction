import {
  STATEMENT_COLUMN_HEADERS,
  STATEMENT_COLUMNS,
  STATEMENT_LIMITS,
  type StatementColumn,
  type StatementError,
  type StatementLineClass,
  type StatementRowIssue,
} from "@pm-buddy/types";
import { toMinor } from "../money.js";

/**
 * M-Pesa organisation-portal statement parser (D4.3 §11; ARCHITECTURE §14.5; THREAT_MODEL A-08).
 * The layout is ASSUMED from Safaricom's published export and must be checked against a real
 * export at the sandbox gate: the header row is found by its column names (title, account and
 * period rows above it are skipped), cells may be quoted (RFC 4180, commas, semicolons or tabs),
 * amounts may carry thousands separators, a currency prefix or a minus sign, and times are
 * Africa/Nairobi wall-clock times. Unreadable rows are listed, never guessed. Lines are classified
 * as payouts (withdrawals with a receipt), their charges (linked to the payout through
 * `Linked Transaction ID`, else the receipt), deposits, or other movements. The other party's
 * details are personal data: the API seals `otherPartyInfo` and shows only `otherPartyMasked`.
 */

export type CsvDelimiter = "," | ";" | "\t";

/** RFC 4180 CSV → rows of raw cells (quoted cells, doubled quotes, line breaks in quotes, BOM). */
export function splitCsv(text: string, delimiter: CsvDelimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = false;
    } else if (char === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\r" || char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (char === "\r" && text[index + 1] === "\n") index += 1;
    } else cell += char;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const normaliseHeader = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const HEADER_INDEX: ReadonlyMap<string, StatementColumn> = new Map(
  STATEMENT_COLUMNS.flatMap((column) =>
    STATEMENT_COLUMN_HEADERS[column].map((name) => [normaliseHeader(name), column] as const),
  ),
);

/** Column positions when `row` is a statement header row (receipt, completion time, an amount). */
function headerColumns(row: readonly string[]): Map<StatementColumn, number> | null {
  const columns = new Map<StatementColumn, number>();
  row.forEach((cell, position) => {
    const column = HEADER_INDEX.get(normaliseHeader(cell));
    if (column && !columns.has(column)) columns.set(column, position);
  });
  return columns.has("receipt") &&
    columns.has("completionTime") &&
    (columns.has("paidIn") || columns.has("withdrawn"))
    ? columns
    : null;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const TIME = String.raw`(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([AaPp][Mm])?)?`;
const YEAR_FIRST = new RegExp(String.raw`^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})${TIME}$`);
const DAY_FIRST = new RegExp(String.raw`^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})${TIME}$`);
const MONTH_NAME = new RegExp(String.raw`^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s,]+(\d{4})${TIME}$`);
const EXCEL_SERIAL = /^(\d{5})(\.\d+)?$/;
const pad = (value: number) => String(value).padStart(2, "0");

/**
 * A statement time → the instant (ISO 8601 with +03:00) and its Nairobi business date. Accepts
 * "2026-11-16 14:03:22", "16/11/2026 14:03" (day first, as exported in Kenya), "16-Nov-2026
 * 2:03 PM" and Excel date serials; null for anything else or an impossible date.
 */
export function parseStatementTime(raw: string): { at: string; date: string } | null {
  const text = raw.trim();
  let year: number;
  let month: number;
  let day: number;
  let rest: (string | undefined)[];
  const serial = EXCEL_SERIAL.exec(text);
  if (serial) {
    const value = Number(text);
    const seconds = Math.round((value - Math.floor(value)) * 86_400);
    const base = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000 + seconds * 1000);
    return {
      at: `${base.toISOString().slice(0, 19)}+03:00`,
      date: base.toISOString().slice(0, 10),
    };
  }
  let match = YEAR_FIRST.exec(text);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
    rest = match.slice(4);
  } else if ((match = DAY_FIRST.exec(text))) {
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
    rest = match.slice(4);
  } else if ((match = MONTH_NAME.exec(text))) {
    day = Number(match[1]);
    month = MONTHS[match[2]!.slice(0, 3).toLowerCase()] ?? 0;
    year = Number(match[3]);
    rest = match.slice(4);
  } else return null;
  let hour = rest[0] === undefined ? 0 : Number(rest[0]);
  const minute = rest[1] === undefined ? 0 : Number(rest[1]);
  const second = rest[2] === undefined ? 0 : Number(rest[2]);
  const meridiem = rest[3]?.toUpperCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "AM" && hour === 12) hour = 0;
    if (meridiem === "PM" && hour !== 12) hour += 12;
  }
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const date = `${year}-${pad(month)}-${pad(day)}`;
  return { at: `${date}T${pad(hour)}:${pad(minute)}:${pad(second)}+03:00`, date };
}

const AMOUNT = /^(?:\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.\d{1,2})?$/;

/**
 * A statement amount → absolute KES minor units: "1,250.00", "-1 250.5", "(300.00)", "KES 300";
 * null when empty; "invalid" otherwise. The column, not the sign, gives the direction.
 */
export function parseStatementAmount(raw: string): number | null | "invalid" {
  let text = raw.replace(/\u00a0/g, " ").trim();
  if (text === "" || text === "-") return null;
  if (text.startsWith("(") && text.endsWith(")")) text = text.slice(1, -1).trim();
  text = text
    .replace(/^[-+]\s*/, "")
    .replace(/^(?:KES|KSHS?)\.?\s*/i, "")
    .replace(/^[-+]\s*/, "");
  if (!AMOUNT.test(text)) return "invalid";
  try {
    return toMinor(text.replace(/[, ]/g, ""));
  } catch {
    return "invalid";
  }
}

/**
 * "254712345678 - JOHN DOE" → "2547•••••678 - J. D.": numbers masked, names reduced to initials.
 */
export function maskPartyInfo(text: string): string {
  return text
    .replace(/\d{9,15}/g, (digits) => `${digits.slice(0, 4)}•••••${digits.slice(-3)}`)
    .replace(/\p{L}[\p{L}'’.-]*/gu, (word) => `${Array.from(word)[0]!.toUpperCase()}.`)
    .slice(0, STATEMENT_LIMITS.maxCellLength);
}

export type StatementLine = {
  /** 1-based row number in the file (or sheet), for the issue list and evidence. */
  row: number;
  receipt: string;
  /** ISO 8601 with +03:00, and its Africa/Nairobi business date. */
  completedAt: string;
  completedOn: string;
  initiatedAt: string | null;
  details: string | null;
  transactionStatus: string | null;
  paidInMinor: number;
  withdrawnMinor: number;
  balanceMinor: number | null;
  reasonType: string | null;
  /** Raw counterparty details: personal data, sealed by the API before storing. */
  otherPartyInfo: string | null;
  otherPartyMasked: string | null;
  linkedTransactionId: string | null;
  accountNumber: string | null;
  lineClass: StatementLineClass;
  /** For a charge: the receipt of the payout it belongs to. */
  chargeFor: string | null;
};

export type StatementIssue = {
  row: number;
  issue: StatementRowIssue;
  column: StatementColumn | null;
};

export type StatementParse =
  | {
      ok: true;
      lines: StatementLine[];
      issues: StatementIssue[];
      /** 1-based row of the header line and the columns it named. */
      headerRow: number;
      columns: StatementColumn[];
      /** First and last completion dates of the readable lines (null without lines). */
      period: { from: string; to: string } | null;
    }
  | { ok: false; error: StatementError };

const RECEIPT = /^[A-Z0-9]{6,20}$/;
const CHARGE = /\bcharges?\b|\bfees?\b|\btransaction cost\b/i;
/** Movements between the organisation's own accounts are not payouts (check at the sandbox gate). */
const INTERNAL = new RegExp(
  [
    String.raw`\btransfer (?:from|to) (?:the )?(?:utility|working|float|mmf|charges paid|organi[sz]ation settlement) account\b`,
    String.raw`\b(?:organi[sz]ation|revenue) settlement\b`,
    String.raw`\bfunds? movement\b`,
  ].join("|"),
  "i",
);

function classify(input: {
  receipt: string;
  details: string | null;
  reasonType: string | null;
  status: string | null;
  paidInMinor: number;
  withdrawnMinor: number;
  linked: string | null;
}): { lineClass: StatementLineClass; chargeFor: string | null } {
  if (input.status && !/^complete/i.test(input.status))
    return { lineClass: "other", chargeFor: null };
  const text = `${input.details ?? ""} ${input.reasonType ?? ""}`;
  if (input.withdrawnMinor > 0 && input.paidInMinor === 0) {
    if (CHARGE.test(text)) return { lineClass: "charge", chargeFor: input.linked ?? input.receipt };
    return { lineClass: INTERNAL.test(text) ? "other" : "payout", chargeFor: null };
  }
  if (input.paidInMinor > 0 && input.withdrawnMinor === 0)
    return { lineClass: "deposit", chargeFor: null };
  return { lineClass: "other", chargeFor: null };
}

/** Parses statement rows (CSV cells, or an XLSX sheet's formatted cells) after its header row. */
export function parseStatementRows(rows: readonly (readonly string[])[]): StatementParse {
  if (!rows.some((row) => row.some((cell) => cell.trim() !== "")))
    return { ok: false, error: "empty" };
  let headerAt = -1;
  let columns: Map<StatementColumn, number> | null = null;
  for (let index = 0; index < Math.min(rows.length, STATEMENT_LIMITS.maxPreambleRows); index += 1) {
    columns = headerColumns(rows[index]!);
    if (columns) {
      headerAt = index;
      break;
    }
  }
  if (!columns) return { ok: false, error: "no_header" };
  const found = columns;
  if (rows.length - headerAt - 1 > STATEMENT_LIMITS.maxRows)
    return { ok: false, error: "too_many_rows" };
  const lines: StatementLine[] = [];
  const issues: StatementIssue[] = [];
  for (let index = headerAt + 1; index < rows.length; index += 1) {
    const cells = rows[index]!;
    const row = index + 1;
    if (cells.every((cell) => cell.trim() === "")) continue;
    const get = (column: StatementColumn) => {
      const position = found.get(column);
      return position === undefined ? "" : (cells[position] ?? "").trim();
    };
    const optional = (column: StatementColumn) => get(column) || null;
    const tooLong = [...found].find(
      ([, position]) => (cells[position] ?? "").length > STATEMENT_LIMITS.maxCellLength,
    );
    if (tooLong) {
      issues.push({ row, issue: "cell_too_long", column: tooLong[0] });
      continue;
    }
    const receipt = get("receipt").toUpperCase();
    const paidInText = get("paidIn");
    const withdrawnText = get("withdrawn");
    // Notes, disclaimers and totals below the table carry neither a time nor an amount.
    if (!get("completionTime") && !paidInText && !withdrawnText) continue;
    if (!RECEIPT.test(receipt)) {
      issues.push({ row, issue: "missing_receipt", column: "receipt" });
      continue;
    }
    const completed = parseStatementTime(get("completionTime"));
    if (!completed) {
      issues.push({ row, issue: "invalid_time", column: "completionTime" });
      continue;
    }
    const paidIn = parseStatementAmount(paidInText);
    const withdrawn = parseStatementAmount(withdrawnText);
    if (paidIn === "invalid" || withdrawn === "invalid") {
      issues.push({
        row,
        issue: "invalid_amount",
        column: paidIn === "invalid" ? "paidIn" : "withdrawn",
      });
      continue;
    }
    if (paidIn === null && withdrawn === null) {
      issues.push({ row, issue: "no_amount", column: null });
      continue;
    }
    if ((paidIn ?? 0) > 0 && (withdrawn ?? 0) > 0) {
      issues.push({ row, issue: "both_amounts", column: null });
      continue;
    }
    const balance = parseStatementAmount(get("balance"));
    const balanceNegative = /^\s*(?:\(|-)/.test(get("balance"));
    const linkedText = get("linkedTransactionId").toUpperCase();
    const linked = RECEIPT.test(linkedText) && linkedText !== receipt ? linkedText : null;
    const otherPartyInfo = optional("otherPartyInfo");
    const details = optional("details");
    const reasonType = optional("reasonType");
    const transactionStatus = optional("transactionStatus");
    const classified = classify({
      receipt,
      details,
      reasonType,
      status: transactionStatus,
      paidInMinor: paidIn ?? 0,
      withdrawnMinor: withdrawn ?? 0,
      linked,
    });
    lines.push({
      row,
      receipt,
      completedAt: completed.at,
      completedOn: completed.date,
      initiatedAt: parseStatementTime(get("initiationTime"))?.at ?? null,
      details,
      transactionStatus,
      paidInMinor: paidIn ?? 0,
      withdrawnMinor: withdrawn ?? 0,
      balanceMinor: typeof balance === "number" ? (balanceNegative ? -balance : balance) : null,
      reasonType,
      otherPartyInfo,
      otherPartyMasked: otherPartyInfo ? maskPartyInfo(otherPartyInfo) : null,
      linkedTransactionId: linked,
      accountNumber: optional("accountNumber"),
      ...classified,
    });
  }
  const dates = lines.map((line) => line.completedOn).sort();
  return {
    ok: true,
    lines,
    issues,
    headerRow: headerAt + 1,
    columns: STATEMENT_COLUMNS.filter((column) => found.has(column)),
    period: dates.length ? { from: dates[0]!, to: dates[dates.length - 1]! } : null,
  };
}

/**
 * Parses a statement CSV export: tries comma, semicolon and tab delimiters and keeps the first
 * that yields a header row (a file without one is `no_header`).
 */
export function parseStatementCsv(text: string): StatementParse {
  let last: StatementParse = { ok: false, error: "empty" };
  for (const delimiter of [",", ";", "\t"] as const) {
    last = parseStatementRows(splitCsv(text, delimiter));
    if (last.ok || last.error !== "no_header") return last;
  }
  return last;
}
