/**
 * Spend alert rules (D5.4, brief §5.8). Alerts are review signals for people, computed on read
 * from recorded facts; they never block or change a payment. Every rule is exact integer
 * arithmetic, so the same facts always give the same alerts.
 */

const pow10 = (exponent: number) => 10n ** BigInt(exponent);

/** A non-negative decimal string as a scaled integer ("2.5" → 25 / 10). */
function scaled(value: string): { digits: bigint; scale: number } {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new TypeError(`Not a non-negative decimal: ${value}`);
  const fraction = match[2] ?? "";
  return { digits: BigInt(`${match[1]}${fraction}`), scale: fraction.length };
}

export type UnusualSpend = {
  unusual: boolean;
  /** The median of the earlier expenses (half-cent precision as a decimal string), or null. */
  medianMinor: string | null;
  samples: number;
};

/**
 * Unusual spend: an expense is unusual when it is more than `multiplier` × the MEDIAN of the
 * float's earlier expenses (the `window` most recent, not rejected), provided there are at least
 * `minSamples` of them; with fewer there is no typical amount yet and no alert. The median resists
 * one earlier outlier; it is compared exactly (amount × 2 > multiplier × (a + b) for an even
 * count).
 */
export function unusualSpend(
  amountMinor: number,
  earlierMinor: readonly number[],
  multiplier: string,
  minSamples: number,
): UnusualSpend {
  if (earlierMinor.length < minSamples || earlierMinor.length === 0)
    return { unusual: false, medianMinor: null, samples: earlierMinor.length };
  const sorted = [...earlierMinor].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  // Twice the median, so an even count stays an integer.
  const twiceMedian =
    sorted.length % 2 === 1
      ? 2n * BigInt(sorted[middle]!)
      : BigInt(sorted[middle - 1]!) + BigInt(sorted[middle]!);
  const factor = scaled(multiplier);
  const unusual = 2n * BigInt(amountMinor) * pow10(factor.scale) > factor.digits * twiceMedian;
  const median = twiceMedian % 2n === 0n ? `${twiceMedian / 2n}` : `${twiceMedian / 2n}.5`;
  return { unusual, medianMinor: median, samples: sorted.length };
}

/**
 * A comparable counterparty key: a supplier's ID, else the M-Pesa till/paybill/agent number
 * with its account, else the name in capitals with punctuation and extra spaces removed. Phone
 * numbers are never part of a key.
 */
export function counterpartyKey(input: {
  supplierId?: string | null;
  account?: string | null;
  name?: string | null;
}): string | null {
  if (input.supplierId) return `supplier:${input.supplierId}`;
  const name = (input.name ?? "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (input.account?.trim()) return `account:${input.account.trim().toUpperCase()}:${name}`;
  return name ? `name:${name}` : null;
}

export type PaymentFact = {
  id: string;
  source: "expense" | "settlement" | "top_up";
  projectId: string;
  counterparty: string | null;
  amountMinor: number;
  /** The business date the money left. */
  date: string;
  /** An M-Pesa code or other external reference, normalised (uppercase, no spaces). */
  reference: string | null;
  /** When it was recorded (ISO-8601 UTC): orders payments on the same business date. */
  recordedAt?: string;
};

export type DuplicatePair = {
  rule: "same_reference" | "same_counterparty_amount";
  first: PaymentFact;
  second: PaymentFact;
};

const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/**
 * Possible duplicate payments, each pair once (earlier first: by date, then recording time, then ID):
 * - `same_reference`: two payments quote the same M-Pesa code or reference (critical);
 * - `same_counterparty_amount`: the same counterparty and amount within `windowDays` days.
 * Petty-cash top-ups are paid to the custodian, so they are compared by reference only.
 */
export function duplicatePayments(
  facts: readonly PaymentFact[],
  windowDays: number,
): DuplicatePair[] {
  const order = (fact: PaymentFact) => `${fact.date}|${fact.recordedAt ?? ""}|${fact.id}`;
  const sorted = [...facts].sort((a, b) =>
    order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0,
  );
  const pairs: DuplicatePair[] = [];
  const byReference = new Map<string, PaymentFact[]>();
  for (const fact of sorted) {
    if (!fact.reference) continue;
    const list = byReference.get(fact.reference) ?? [];
    for (const earlier of list)
      pairs.push({ rule: "same_reference", first: earlier, second: fact });
    list.push(fact);
    byReference.set(fact.reference, list);
  }
  const seen = new Set(pairs.map((pair) => `${pair.first.id}|${pair.second.id}`));
  const byParty = new Map<string, PaymentFact[]>();
  for (const fact of sorted) {
    if (!fact.counterparty || fact.source === "top_up") continue;
    const key = `${fact.counterparty}|${fact.amountMinor}`;
    const list = byParty.get(key) ?? [];
    for (const earlier of list)
      if (
        dayNumber(fact.date) - dayNumber(earlier.date) <= windowDays &&
        !seen.has(`${earlier.id}|${fact.id}`)
      )
        pairs.push({ rule: "same_counterparty_amount", first: earlier, second: fact });
    list.push(fact);
    byParty.set(key, list);
  }
  return pairs;
}
