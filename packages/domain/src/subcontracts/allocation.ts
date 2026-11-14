import type { ReconciliationFlag } from "@pm-buddy/types";
import { divideHalfUp, scaled, unscaled } from "../valuations/arithmetic.js";

/**
 * Quantity caps of D6.3 part B. Quantities are decimal strings (subcontract lines four places,
 * piece-rate output three), compared exactly as scaled integers.
 *
 * 1. Subcontract lines against the BQ (decision D-143): the quantities of every live subcontract
 *    line on a BQ item add up to at most the item's quantity in the BQ in force (100 for a lump
 *    sum let by percent), unless the line carries an exception reason.
 * 2. Subcontract claims against measurement (decision D-144): a certificate's quantity to date on
 *    a line never exceeds the line's quantity in force, and the quantities to date claimed on an
 *    item by every subcontract's latest live certificate add up to at most the item's APPROVED
 *    measured quantity (D6.3) on the certificate date — the same measured quantity is never paid
 *    to two subcontracts.
 * 3. Piece-rate jobs (decision D-147): the cumulative approved output on a job never exceeds its
 *    agreed quantity plus approved extensions; recording counts pending output too.
 */

const four = (value: string) => scaled(value, 4);
const three = (value: string) => scaled(value, 3);

export type LineCapCheck =
  | { ok: true; over: boolean }
  | { ok: false; problem: "over-bq-quantity"; availableQuantity: string };

/**
 * Whether a subcontract line's quantity fits the BQ item: `others` is the quantity already let on
 * the item by other live subcontracts. Above the BQ quantity needs an exception reason.
 */
export function checkLineAgainstBq(input: {
  bqQuantity: string;
  others: string;
  quantity: string;
  exceptionReason: string | null | undefined;
}): LineCapCheck {
  const available = four(input.bqQuantity) - four(input.others);
  const over = four(input.quantity) > available;
  if (over && !input.exceptionReason?.trim())
    return {
      ok: false,
      problem: "over-bq-quantity",
      availableQuantity: unscaled(available > 0n ? available : 0n, 4),
    };
  return { ok: true, over };
}

export type ClaimCheck =
  | { ok: true }
  | {
      ok: false;
      problem: "claim-exceeds-line" | "claim-exceeds-measured";
      availableQuantity: string;
    };

/**
 * Whether a quantity to date may be claimed on a line: within the line's quantity in force and
 * within what was measured on the item less what other subcontracts claim on it.
 */
export function checkClaim(input: {
  claim: string;
  lineQuantity: string;
  /** The item's approved measured quantity to date on the certificate date ("0" when none). */
  measured: string;
  /** Quantities to date claimed on the item by the other subcontracts' latest certificates. */
  otherClaims: string;
}): ClaimCheck {
  const claim = four(input.claim);
  if (claim > four(input.lineQuantity))
    return { ok: false, problem: "claim-exceeds-line", availableQuantity: input.lineQuantity };
  const available = four(input.measured) - four(input.otherClaims);
  if (claim > available)
    return {
      ok: false,
      problem: "claim-exceeds-measured",
      availableQuantity: unscaled(available > 0n ? available : 0n, 4),
    };
  return { ok: true };
}

/** What a draft certificate line may claim by default: the measured quantity left, within the line. */
export function suggestedClaim(input: {
  lineQuantity: string;
  measured: string;
  otherClaims: string;
}): string {
  const available = four(input.measured) - four(input.otherClaims);
  const line = four(input.lineQuantity);
  const value = available < 0n ? 0n : available > line ? line : available;
  return unscaled(value, 4);
}

/** Σ of decimal strings at four places (exact). */
export function sumQuantities(values: readonly string[], places = 4): string {
  let total = 0n;
  for (const value of values) total += scaled(value, places);
  return unscaled(total, places);
}

// Piece-rate jobs ---------------------------------------------------------------------------------

/** A job's agreed quantity in force: the agreed quantity plus every approved extension. */
export function jobQuantityInForce(agreed: string, approvedExtensions: readonly string[]): string {
  let total = three(agreed);
  for (const extension of approvedExtensions) total += three(extension);
  return unscaled(total, 3);
}

export type JobOutputCheck =
  | { ok: true; remaining: string }
  | { ok: false; problem: "job-quantity-exceeded"; remaining: string };

/**
 * Whether output may be added to a job. Recording counts approved and pending output (so what is
 * waiting can still be approved); approval counts approved output only. Above the quantity in
 * force needs an approved extension first.
 */
export function checkJobOutput(input: {
  inForce: string;
  approved: string;
  pending: string;
  quantity: string;
  stage: "record" | "approve";
}): JobOutputCheck {
  const used = three(input.approved) + (input.stage === "record" ? three(input.pending) : 0n);
  const left = three(input.inForce) - used;
  const remaining = unscaled(left > 0n ? left : 0n, 3);
  if (three(input.quantity) > left)
    return { ok: false, problem: "job-quantity-exceeded", remaining };
  return { ok: true, remaining };
}

/**
 * A job quantity in the BQ item's unit: quantity × conversion factor (job unit → BQ unit, 1 when
 * the units match), rounded half away from zero to four places.
 */
export function toBqQuantity(quantity: string, factor: string): string {
  const product = scaled(quantity, 3) * scaled(factor, 6);
  return unscaled(divideHalfUp(product, 100_000n), 4);
}

export type ItemReconciliation = {
  /** Approved measured quantity (BQ unit) or null when the item has no approved measurement. */
  measured: string | null;
  pieceRate: string;
  subcontracted: string;
  /** Piece-rate (+ subcontracted) quantity above measured; "0" when within it. */
  excessPieceRate: string;
  excessCombined: string;
  flags: ReconciliationFlag[];
};

/**
 * Piece-rate quantities paid (approved output, in the BQ unit) against the item's approved
 * measured quantity, with subcontract-certified quantities alongside. Paying for work that was
 * not measured is the classic leak: it is flagged, never silently netted (brief §15 G: a review
 * signal, not proof).
 */
export function reconcileItem(input: {
  measured: string | null;
  pieceRate: string;
  subcontracted: string;
  unlinkedApproved: number;
}): ItemReconciliation {
  const measured = input.measured === null ? 0n : four(input.measured);
  const pieceRate = four(input.pieceRate);
  const combined = pieceRate + four(input.subcontracted);
  const flags: ReconciliationFlag[] = [];
  if (input.measured === null && pieceRate > 0n) flags.push("not-measured");
  if (pieceRate > measured) flags.push("piece-rate-above-measured");
  if (combined > measured && combined > pieceRate) flags.push("combined-above-measured");
  if (input.unlinkedApproved > 0) flags.push("unlinked-outputs");
  return {
    measured: input.measured,
    pieceRate: input.pieceRate,
    subcontracted: input.subcontracted,
    excessPieceRate: unscaled(pieceRate > measured ? pieceRate - measured : 0n, 4),
    excessCombined: unscaled(combined > measured ? combined - measured : 0n, 4),
    flags,
  };
}
