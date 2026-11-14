import type { FloatEntryKind } from "@pm-buddy/types";

/**
 * A petty-cash float over a period (D-125), from its append-only entries (signed amounts, business
 * dates): the book balance before the period, the movements in it by kind and the book balance at
 * its end. Opening + movements = closing, whatever order the entries were recorded in.
 */
export type FloatEntry = { kind: FloatEntryKind; amountMinor: number; businessDate: string };
export type FloatPeriod = {
  openingMinor: number;
  topUpsMinor: number;
  expensesMinor: number;
  rejectedMinor: number;
  countAdjustmentsMinor: number;
  closingMinor: number;
};

export function floatPeriod(entries: readonly FloatEntry[], from: string, to: string): FloatPeriod {
  const result: FloatPeriod = {
    openingMinor: 0,
    topUpsMinor: 0,
    expensesMinor: 0,
    rejectedMinor: 0,
    countAdjustmentsMinor: 0,
    closingMinor: 0,
  };
  for (const entry of entries) {
    if (entry.businessDate < from) {
      result.openingMinor += entry.amountMinor;
      continue;
    }
    if (entry.businessDate > to) continue;
    if (entry.kind === "top_up") result.topUpsMinor += entry.amountMinor;
    else if (entry.kind === "expense") result.expensesMinor += entry.amountMinor;
    else if (entry.kind === "expense_rejected") result.rejectedMinor += entry.amountMinor;
    else result.countAdjustmentsMinor += entry.amountMinor;
  }
  result.closingMinor =
    result.openingMinor +
    result.topUpsMinor +
    result.expensesMinor +
    result.rejectedMinor +
    result.countAdjustmentsMinor;
  return result;
}

const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_PAIRS = 12;

/**
 * Audit metadata for a report, shown safely (ARCHITECTURE §4.14): `key=value` pairs for scalar
 * values that look like IDs, codes, dates, statuses or numbers; other text is shown as `[text]`,
 * nested values as `[…]`, at most twelve pairs. Audit events already hold redacted summaries only
 * (brief §7); this keeps an unexpected value from being printed in full.
 */
export function safeAuditMetadata(metadata: unknown): string {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return "";
  const pairs: string[] = [];
  const entries = Object.entries(metadata as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [key, value] of entries) {
    if (pairs.length === MAX_PAIRS) {
      pairs.push("…");
      break;
    }
    if (!SAFE_KEY.test(key)) continue;
    let shown: string;
    if (value === null) shown = "null";
    else if (typeof value === "number" || typeof value === "boolean") shown = String(value);
    else if (typeof value === "string") shown = SAFE_VALUE.test(value) ? value : "[text]";
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      const items = value as string[];
      shown = items.every((item) => SAFE_VALUE.test(item))
        ? items.length > 3
          ? `${items.slice(0, 3).join(",")},…(${items.length})`
          : items.join(",")
        : "[text]";
    } else shown = "[…]";
    pairs.push(`${key}=${shown}`);
  }
  return pairs.join("; ");
}
