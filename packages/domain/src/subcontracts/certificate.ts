import type {
  RetentionStage,
  SubcontractLineBasis,
  SubcontractVatTreatment,
} from "@pm-buddy/types";
import { divideHalfUp, percentageOf, safeMinor, scaled } from "../valuations/arithmetic.js";

/**
 * Subcontract payment certificates, rule KE-SUB-1 (D6.3 part B, brief §5.14 and §15 C/G;
 * COMPLIANCE-REVIEW CR-SCN-01–05). Every figure is CUMULATIVE to the certificate date, in KES
 * minor units, at the SUBCONTRACT's own rates (never the client BQ rates), net of VAT:
 *
 *   work done (W)          = Σ line values to date
 *                            quantity line: round(quantity to date × rate)
 *                            percent line:  round(line amount × percent to date ÷ line percent)
 *   retention limit (L)    = round(original subcontract value × limit % ÷ 100)   (none if unset)
 *   retention computed     = min(round(W × retention % ÷ 100), L)
 *   retention held (R)     = computed (before practical completion)
 *                          = computed − round(computed × practical release % ÷ 100) (after it)
 *                          = 0 (after final completion)
 *   advances paid (A)      = Σ advances paid on or before the certificate date
 *   recovered to date (V)  = min(round(W × recovery % ÷ 100), A)        (never more than paid)
 *   net to date (N)        = W − R − V
 *   amount due (D)         = N − Σ amounts due of the certificates already certified
 *   VAT (T)                = round(D × VAT % × VATable W ÷ (W × 100))     (0 when W is 0)
 *   withholding tax (H)    = round(D × WHT % ÷ 100)                        (shown separately)
 *   payable (P)            = D + T − H
 *
 * Rounding is half away from zero, once per figure (PostgreSQL `round()`), computed exactly with
 * BigInt. The database repeats every formula on submission and certification. Because figures
 * are cumulative, a mistake on a certified certificate is corrected by the next one (which may be
 * negative); advances outstanding (A − V) are never negative because V never exceeds A.
 */

export type SubcontractTerms = {
  retentionPercent: string;
  /** Limit of retention as a percentage of the original subcontract value; null for no limit. */
  retentionLimitPercent: string | null;
  practicalReleasePercent: string;
  vatPercent: string;
  whtPercent: string;
  advanceRecoveryPercent: string;
};

export type SubcontractLineTerms = {
  basis: SubcontractLineBasis;
  /** Quantity in force (BQ unit) or, for a percent line, the share of the item (percent). */
  quantity: string;
  /** KES minor units per unit (quantity lines); null on a percent line. */
  rateMinor: number | null;
  /** The line's value in force: quantity × rate, or the agreed lump sum of a percent line. */
  amountMinor: number;
  vatTreatment: SubcontractVatTreatment;
};

/** Line value of a quantity or line amount, rounded once (quantity × rate for quantity lines). */
export function subcontractLineAmountMinor(
  basis: SubcontractLineBasis,
  quantity: string,
  rateMinor: number | null,
  lumpSumMinor: number | null,
): number {
  if (basis === "quantity") {
    if (rateMinor === null) throw new RangeError("A quantity line has a rate");
    return safeMinor(divideHalfUp(scaled(quantity, 4) * BigInt(rateMinor), 10_000n));
  }
  if (lumpSumMinor === null) throw new RangeError("A percent line has a lump sum");
  return lumpSumMinor;
}

/**
 * The value of work done to date on a line: quantity × rate, or the lump sum pro rata to the
 * percent done of the line's share. 0 for nothing done.
 */
export function subcontractLineValueMinor(line: SubcontractLineTerms, toDate: string): number {
  const done = scaled(toDate, 4);
  if (done === 0n) return 0;
  if (line.basis === "quantity") {
    if (line.rateMinor === null) throw new RangeError("A quantity line has a rate");
    return safeMinor(divideHalfUp(done * BigInt(line.rateMinor), 10_000n));
  }
  const share = scaled(line.quantity, 4);
  if (share <= 0n) return 0;
  return safeMinor(divideHalfUp(BigInt(line.amountMinor) * done, share));
}

/** A change of a line's quantity by a variation, valued at the line's rate (or pro rata). */
export function subcontractChangeMinor(line: SubcontractLineTerms, change: string): number {
  const delta = scaled(change, 4);
  if (line.basis === "quantity") {
    if (line.rateMinor === null) throw new RangeError("A quantity line has a rate");
    return safeMinor(divideHalfUp(delta * BigInt(line.rateMinor), 10_000n));
  }
  const share = scaled(line.quantity, 4);
  if (share <= 0n) throw new RangeError("A percent line has a share");
  return safeMinor(divideHalfUp(BigInt(line.amountMinor) * delta, share));
}

export type SubcontractCertificateInput = {
  workDoneMinor: number;
  /** Work done to date on standard-rated lines (VAT applies to that share). */
  vatableWorkDoneMinor: number;
  originalValueMinor: number;
  stage: RetentionStage;
  /** Advances paid on or before the certificate date. */
  advancesPaidMinor: number;
  /** The sum of the amounts due of every certificate of the subcontract already certified. */
  previousCertifiedMinor: number;
  terms: SubcontractTerms;
};

export type SubcontractCertificateFigures = {
  workDoneMinor: number;
  vatableWorkDoneMinor: number;
  retentionStage: RetentionStage;
  retentionLimitMinor: number | null;
  retentionComputedMinor: number;
  retentionHeldMinor: number;
  advancesPaidMinor: number;
  recoveredToDateMinor: number;
  advancesOutstandingMinor: number;
  netToDateMinor: number;
  previousCertifiedMinor: number;
  amountDueMinor: number;
  vatMinor: number;
  whtMinor: number;
  payableMinor: number;
};

/** The figures of a subcontract certificate (rule KE-SUB-1, see above). */
export function computeSubcontractCertificate(
  input: SubcontractCertificateInput,
): SubcontractCertificateFigures {
  for (const value of [
    input.workDoneMinor,
    input.vatableWorkDoneMinor,
    input.originalValueMinor,
    input.advancesPaidMinor,
    input.previousCertifiedMinor,
  ])
    if (!Number.isSafeInteger(value)) throw new RangeError("Amounts are integer minor units");
  if (input.workDoneMinor < 0 || input.vatableWorkDoneMinor < 0 || input.advancesPaidMinor < 0)
    throw new RangeError("Work done and advances are never negative");
  if (input.vatableWorkDoneMinor > input.workDoneMinor)
    throw new RangeError("VATable work is part of the work done");
  const { terms } = input;
  const W = input.workDoneMinor;
  const retentionLimitMinor =
    terms.retentionLimitPercent === null
      ? null
      : percentageOf(input.originalValueMinor, terms.retentionLimitPercent);
  const uncapped = Math.max(0, percentageOf(W, terms.retentionPercent));
  const retentionComputedMinor =
    retentionLimitMinor === null ? uncapped : Math.min(uncapped, retentionLimitMinor);
  const retentionHeldMinor =
    input.stage === "none"
      ? retentionComputedMinor
      : input.stage === "practical"
        ? retentionComputedMinor -
          percentageOf(retentionComputedMinor, terms.practicalReleasePercent)
        : 0;
  const recoveredToDateMinor = Math.min(
    Math.max(0, percentageOf(W, terms.advanceRecoveryPercent)),
    input.advancesPaidMinor,
  );
  const netToDateMinor = W - retentionHeldMinor - recoveredToDateMinor;
  const amountDueMinor = netToDateMinor - input.previousCertifiedMinor;
  const vatMinor =
    W > 0
      ? safeMinor(
          divideHalfUp(
            BigInt(amountDueMinor) *
              scaled(terms.vatPercent, 2) *
              BigInt(input.vatableWorkDoneMinor),
            BigInt(W) * 10_000n,
          ),
        )
      : 0;
  const whtMinor = percentageOf(amountDueMinor, terms.whtPercent);
  return {
    workDoneMinor: W,
    vatableWorkDoneMinor: input.vatableWorkDoneMinor,
    retentionStage: input.stage,
    retentionLimitMinor,
    retentionComputedMinor,
    retentionHeldMinor,
    advancesPaidMinor: input.advancesPaidMinor,
    recoveredToDateMinor,
    advancesOutstandingMinor: input.advancesPaidMinor - recoveredToDateMinor,
    netToDateMinor,
    previousCertifiedMinor: input.previousCertifiedMinor,
    amountDueMinor,
    vatMinor,
    whtMinor,
    payableMinor: amountDueMinor + vatMinor - whtMinor,
  };
}

/**
 * Whether the agreed advance can be recovered in full by the time the work reaches the original
 * subcontract value: advance ≤ round(original value × recovery % ÷ 100). An advance the terms
 * could never recover would leave money outstanding forever.
 */
export function advanceRecoverable(
  advanceLimitMinor: number,
  originalValueMinor: number,
  recoveryPercent: string,
): boolean {
  if (advanceLimitMinor === 0) return true;
  return advanceLimitMinor <= percentageOf(originalValueMinor, recoveryPercent);
}

/**
 * A retention release (practical or final completion) carries the last certificate's lines and
 * advances forward and only advances the retention stage: the amount due must be the retention
 * released, never more than is held and never negative.
 */
export function releaseWithinHeld(
  figures: Pick<SubcontractCertificateFigures, "amountDueMinor">,
  heldBeforeMinor: number,
): "ok" | "nothing-to-release" | "release-exceeds-held" {
  if (heldBeforeMinor <= 0) return "nothing-to-release";
  if (figures.amountDueMinor < 0 || figures.amountDueMinor > heldBeforeMinor)
    return "release-exceeds-held";
  return "ok";
}
