/**
 * Carry-forwards of sub-shilling net pay (decision D-167, D4.3): M-Pesa pays whole shillings, so
 * an approved line pays `net − (net mod 100)` and the remaining cents (or the whole net when it is
 * below KES 1) are owed to the worker as a carry-forward. The worker's next D4.1 batch calculation
 * (any project of the company) adds their open carry-forwards to that line's net as "brought
 * forward": after statutory deductions, advance recovery and other deductions, never part of gross
 * pay, a statutory base or the recovery cap, so statutory figures are unchanged.
 */

/** An open carry-forward of one labourer, as the batch calculation receives it. */
export type CarryForwardSource = {
  id: string;
  /** 1–99 minor units. */
  amountMinor: number;
};

/** The whole shillings paid now (the obligation) and the cents carried to the next payroll. */
export function splitNetPay(netMinor: number): { payableMinor: number; carryForwardMinor: number } {
  if (!Number.isSafeInteger(netMinor) || netMinor <= 0)
    return { payableMinor: 0, carryForwardMinor: 0 };
  const carryForwardMinor = netMinor % 100;
  return { payableMinor: netMinor - carryForwardMinor, carryForwardMinor };
}

/**
 * A line's net pay: gross − statutory withheld − advance recovery − other deductions + brought
 * forward. The brought-forward amount is added last, outside every statutory computation.
 */
export function lineNetMinor(line: {
  grossMinor: number;
  statutoryWithheldMinor: number;
  advanceRecoveryMinor: number;
  otherDeductionsMinor: number;
  broughtForwardMinor: number;
}): number {
  return (
    line.grossMinor -
    line.statutoryWithheldMinor -
    line.advanceRecoveryMinor -
    line.otherDeductionsMinor +
    line.broughtForwardMinor
  );
}

/** The brought-forward amount and consumed IDs (sorted) for a labourer's open carry-forwards. */
export function broughtForward(sources: readonly CarryForwardSource[]): {
  broughtForwardMinor: number;
  carryForwardIds: string[];
} {
  return {
    broughtForwardMinor: sources.reduce((total, source) => total + source.amountMinor, 0),
    carryForwardIds: sources.map((source) => source.id).sort(),
  };
}
