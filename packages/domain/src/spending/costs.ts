/**
 * Cost arithmetic for the spending ledger (D5.4, brief §5.8 and §15 C; FINANCIAL_MODEL). All
 * amounts are integer KES minor units; intermediate products use BigInt, so nothing passes
 * through floating point.
 */

const halfUp = (numerator: bigint, denominator: bigint): bigint =>
  (2n * numerator + denominator) / (2n * denominator);

const safe = (value: bigint): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError("Amount out of safe integer range");
  return Number(value);
};

/**
 * The cost part (net of recoverable VAT) of one supplier settlement. Supplier invoices are
 * accrued net of VAT (their subtotal) while settlements pay the total including VAT, so a
 * settlement's cost is its share of the subtotal, computed CUMULATIVELY:
 * `round(settledAfter × subtotal ÷ total) − round(settledBefore × subtotal ÷ total)` (half up).
 * The pieces are never negative, and once an invoice is fully settled they add up to exactly its
 * subtotal, so paid cost can never exceed accrued cost through rounding. The database repeats the
 * same formula (`app.check_cost_entry`). COMPLIANCE-REVIEW CR-SPD-01 (VAT treatment).
 */
export function settlementCostMinor(input: {
  subtotalMinor: number;
  totalMinor: number;
  settledBeforeMinor: number;
  amountMinor: number;
}): number {
  const { subtotalMinor, totalMinor, settledBeforeMinor, amountMinor } = input;
  if (
    ![subtotalMinor, totalMinor, settledBeforeMinor, amountMinor].every(Number.isSafeInteger) ||
    subtotalMinor < 0 ||
    totalMinor < subtotalMinor ||
    settledBeforeMinor < 0 ||
    amountMinor < 0 ||
    settledBeforeMinor + amountMinor > totalMinor
  )
    throw new RangeError("settlementCostMinor needs 0 ≤ settled ≤ total and subtotal ≤ total");
  if (totalMinor === 0) return 0;
  const share = (settled: number) =>
    halfUp(BigInt(settled) * BigInt(subtotalMinor), BigInt(totalMinor));
  return safe(share(settledBeforeMinor + amountMinor) - share(settledBeforeMinor));
}

/**
 * A percentage TRUNCATED to one decimal ("79.9"), or null when the base is not positive (an
 * undefined ratio is shown as unavailable, never 0 %). Truncating instead of rounding means a
 * figure below a whole-number threshold (80 %, 100 %) never displays as that threshold: 79.96 %
 * shows as 79.9 %, so the label always agrees with the alert check.
 */
export function percentOf(partMinor: number, baseMinor: number | null): string | null {
  if (baseMinor === null || baseMinor <= 0) return null;
  const tenths = (BigInt(partMinor) * 1000n) / BigInt(baseMinor);
  // BigInt division truncates toward zero; floor negative figures so they never look larger.
  const floored =
    partMinor < 0 && (BigInt(partMinor) * 1000n) % BigInt(baseMinor) !== 0n ? tenths - 1n : tenths;
  const negative = floored < 0n;
  const magnitude = negative ? -floored : floored;
  return `${negative ? "-" : ""}${magnitude / 10n}.${magnitude % 10n}`;
}

/** Whether `used` has reached `percent` % of `budget` (exact integer comparison). */
export function reachesPercent(usedMinor: number, budgetMinor: number, percent: number): boolean {
  if (budgetMinor <= 0) return false;
  return BigInt(usedMinor) * 100n >= BigInt(budgetMinor) * BigInt(percent);
}

export type BudgetLevel = "unavailable" | "within" | "threshold" | "over";

/**
 * Where a budget figure stands: `unavailable` without a positive budget, `over` when actual +
 * committed exceeds the budget, `threshold` from the alert percentage, otherwise `within`.
 */
export function budgetLevel(
  usedMinor: number,
  budgetMinor: number | null,
  thresholdPercent: number,
): BudgetLevel {
  if (budgetMinor === null || budgetMinor <= 0) return "unavailable";
  if (usedMinor > budgetMinor) return "over";
  return reachesPercent(usedMinor, budgetMinor, thresholdPercent) ? "threshold" : "within";
}

export type BudgetFigures = {
  /** The approved budget for the row; null when the row has no budget (not zero). */
  budgetMinor: number | null;
  /** Approved LPOs not yet invoiced (net of VAT). */
  committedMinor: number;
  /** Accrued cost (approved invoices and expenses, journals, issues reallocated to BQ items). */
  actualMinor: number;
  /** The cost part of cash paid (net of VAT). */
  paidMinor: number;
};

export type BudgetRow = BudgetFigures & {
  /** Actual + committed: what the row will cost if nothing else is ordered. */
  forecastMinor: number;
  /** Budget − forecast (negative when over); null without a budget. */
  remainingMinor: number | null;
  /** Forecast ÷ budget, truncated to one decimal; null without a positive budget. */
  usedPercent: string | null;
  level: BudgetLevel;
};

/** Budget against actual and committed for one row (project, category, bill or BQ item). */
export function budgetRow(figures: BudgetFigures, thresholdPercent: number): BudgetRow {
  const forecastMinor = figures.actualMinor + figures.committedMinor;
  return {
    ...figures,
    forecastMinor,
    remainingMinor: figures.budgetMinor === null ? null : figures.budgetMinor - forecastMinor,
    usedPercent: percentOf(forecastMinor, figures.budgetMinor),
    level: budgetLevel(forecastMinor, figures.budgetMinor, thresholdPercent),
  };
}

/** Sums figures; a total has a budget when any part has one. */
export function sumFigures(rows: readonly BudgetFigures[]): BudgetFigures {
  let budget: number | null = null;
  let committed = 0;
  let actual = 0;
  let paid = 0;
  for (const row of rows) {
    if (row.budgetMinor !== null) budget = (budget ?? 0) + row.budgetMinor;
    committed += row.committedMinor;
    actual += row.actualMinor;
    paid += row.paidMinor;
  }
  return { budgetMinor: budget, committedMinor: committed, actualMinor: actual, paidMinor: paid };
}

/**
 * Stock value moved by issues and returns (six-decimal minor units, as the stock ledger stores
 * it) rounded half away from zero to whole cents, once per total. Material issues REALLOCATE cost
 * already accrued from supplier invoices to BQ items; they never add cost (decision D-53).
 */
export function stockValueToMinor(valueMicroMinor: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(valueMicroMinor.trim());
  if (!match) throw new TypeError(`Not a decimal value: ${valueMicroMinor}`);
  const micro = BigInt(match[2]!) * 1_000_000n + BigInt((match[3] ?? "").padEnd(6, "0"));
  const cents = halfUp(micro, 1_000_000n);
  return safe(match[1] ? -cents : cents);
}
