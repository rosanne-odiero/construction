import { Decimal } from "decimal.js";

/**
 * Salary advance recovery (brief §5.6, D4.1; COMPLIANCE-REVIEW CR-PAY-15, CR-PAY-16). Only
 * disbursed advances are recovered, oldest first, after statutory deductions:
 * - each advance gives at most its instalment (when set) and never more than its outstanding
 *   balance (never over-recovers);
 * - the batch recovers at most `maxPercent` % of the pay left after statutory deductions (rounded
 *   down to the cent), and an advance's own lower percentage caps that advance;
 * - whatever is not recovered stays outstanding for the next batch (carried forward).
 * Net pay therefore never goes negative.
 */
export type AdvanceBalance = {
  id: string;
  outstandingMinor: number;
  instalmentMinor: number | null;
  maxRecoveryPercent: string | null;
  disbursedOn: string;
};

export type Recovery = { advanceId: string; amountMinor: number; outstandingAfterMinor: number };

const capOf = (availableMinor: number, percent: string) =>
  new Decimal(availableMinor).times(percent).dividedBy(100).floor().toNumber();

export function planRecoveries(
  availableMinor: number,
  advances: readonly AdvanceBalance[],
  maxPercent: string,
): { recoveries: Recovery[]; capMinor: number; capped: boolean } {
  const available = Math.max(0, availableMinor);
  const capMinor = Math.min(available, capOf(available, maxPercent));
  let room = capMinor;
  let capped = false;
  const recoveries: Recovery[] = [];
  const ordered = [...advances].sort(
    (a, b) => a.disbursedOn.localeCompare(b.disbursedOn) || a.id.localeCompare(b.id),
  );
  for (const advance of ordered) {
    if (advance.outstandingMinor <= 0) continue;
    const wanted = Math.min(advance.outstandingMinor, advance.instalmentMinor ?? Infinity);
    const ownCap =
      advance.maxRecoveryPercent === null ? Infinity : capOf(available, advance.maxRecoveryPercent);
    const take = Math.max(0, Math.min(wanted, room, ownCap));
    if (take < wanted) capped = true;
    if (take === 0) continue;
    room -= take;
    recoveries.push({
      advanceId: advance.id,
      amountMinor: take,
      outstandingAfterMinor: advance.outstandingMinor - take,
    });
  }
  return { recoveries, capMinor, capped };
}
