import type { AdjustmentKind, RetentionStage } from "@pm-buddy/types";
import { percentageOf } from "./arithmetic.js";

/**
 * Interim valuations and payment certificates, rule KE-VAL-1 (D6.3, brief §5.2 and §15 C/G;
 * COMPLIANCE-REVIEW CR-VAL-01–04). Every figure is CUMULATIVE to the valuation date and in KES
 * minor units, net of VAT:
 *
 *   materials on site (certified) = round(materials at cost × materials % ÷ 100)
 *   gross valuation               = work done to date + materials on site
 *   retention (computed)          = min(round(gross × retention % ÷ 100), limit)
 *   limit of retention            = round(original contract sum × limit % ÷ 100) (none if unset)
 *   retention held                = computed (before practical completion)
 *                                 = computed − round(computed × practical release % ÷ 100)
 *                                   (after the practical-completion release)
 *                                 = 0 (after the final release)
 *   net to date                   = gross − retention held + adjustments to date
 *   amount due                    = net to date − previous certificates (their amounts due)
 *   VAT                           = round(amount due × VAT % ÷ 100)
 *   total payable                 = amount due + VAT
 *
 * Rounding is half away from zero, once per figure, as PostgreSQL `round()` does; the database
 * recomputes the same figures when a certificate is submitted and certified. Because the figures
 * are cumulative, materials incorporated into measured work leave "materials on site" in the next
 * valuation, and a mistake on a certified certificate is corrected by the next one (which may be
 * negative), never by editing the certified one.
 */

export type ContractTerms = {
  retentionPercent: string;
  /** Limit of retention as a percentage of the original contract sum; null for no limit. */
  retentionCapPercent: string | null;
  vatPercent: string;
  materialsPercent: string;
  practicalReleasePercent: string;
};

export type RetentionFigures = {
  capMinor: number | null;
  computedMinor: number;
  heldMinor: number;
};

/** Retention on a gross valuation at a retention stage. */
export function retentionFigures(input: {
  grossMinor: number;
  originalContractSumMinor: number;
  stage: RetentionStage;
  terms: ContractTerms;
}): RetentionFigures {
  const { grossMinor, originalContractSumMinor, stage, terms } = input;
  const capMinor =
    terms.retentionCapPercent === null
      ? null
      : percentageOf(originalContractSumMinor, terms.retentionCapPercent);
  const uncapped = Math.max(0, percentageOf(grossMinor, terms.retentionPercent));
  const computedMinor = capMinor === null ? uncapped : Math.min(uncapped, capMinor);
  const heldMinor =
    stage === "none"
      ? computedMinor
      : stage === "practical"
        ? computedMinor - percentageOf(computedMinor, terms.practicalReleasePercent)
        : 0;
  return { capMinor, computedMinor, heldMinor };
}

export type CertificateInput = {
  workDoneMinor: number;
  /** Materials on site at cost (stores at weighted average cost + entered lines), before the %. */
  materialsGrossMinor: number;
  /** This certificate's agreed adjustments (signed). */
  adjustmentsMinor: number;
  /** Adjustments on the certificates already certified. */
  adjustmentsBeforeMinor: number;
  /** The sum of the amounts due of every certificate already certified. */
  previousCertifiedMinor: number;
  stage: RetentionStage;
  originalContractSumMinor: number;
  terms: ContractTerms;
};

export type CertificateFigures = {
  workDoneMinor: number;
  materialsGrossMinor: number;
  materialsMinor: number;
  grossMinor: number;
  retentionStage: RetentionStage;
  retentionCapMinor: number | null;
  retentionComputedMinor: number;
  retentionHeldMinor: number;
  adjustmentsMinor: number;
  adjustmentsToDateMinor: number;
  netToDateMinor: number;
  previousCertifiedMinor: number;
  amountDueMinor: number;
  vatMinor: number;
  totalMinor: number;
};

/** The figures of a certificate (rule KE-VAL-1, see above). */
export function computeCertificate(input: CertificateInput): CertificateFigures {
  for (const value of [
    input.workDoneMinor,
    input.materialsGrossMinor,
    input.adjustmentsMinor,
    input.adjustmentsBeforeMinor,
    input.previousCertifiedMinor,
    input.originalContractSumMinor,
  ])
    if (!Number.isSafeInteger(value)) throw new RangeError("Amounts are integer minor units");
  if (input.workDoneMinor < 0 || input.materialsGrossMinor < 0)
    throw new RangeError("Work done and materials on site are never negative");
  const materialsMinor = percentageOf(input.materialsGrossMinor, input.terms.materialsPercent);
  const grossMinor = input.workDoneMinor + materialsMinor;
  const retention = retentionFigures({
    grossMinor,
    originalContractSumMinor: input.originalContractSumMinor,
    stage: input.stage,
    terms: input.terms,
  });
  const adjustmentsToDateMinor = input.adjustmentsBeforeMinor + input.adjustmentsMinor;
  const netToDateMinor = grossMinor - retention.heldMinor + adjustmentsToDateMinor;
  const amountDueMinor = netToDateMinor - input.previousCertifiedMinor;
  const vatMinor = percentageOf(amountDueMinor, input.terms.vatPercent);
  return {
    workDoneMinor: input.workDoneMinor,
    materialsGrossMinor: input.materialsGrossMinor,
    materialsMinor,
    grossMinor,
    retentionStage: input.stage,
    retentionCapMinor: retention.capMinor,
    retentionComputedMinor: retention.computedMinor,
    retentionHeldMinor: retention.heldMinor,
    adjustmentsMinor: input.adjustmentsMinor,
    adjustmentsToDateMinor,
    netToDateMinor,
    previousCertifiedMinor: input.previousCertifiedMinor,
    amountDueMinor,
    vatMinor,
    totalMinor: amountDueMinor + vatMinor,
  };
}

export type ReleaseCheck =
  | { ok: true; figures: CertificateFigures; releasedMinor: number }
  | { ok: false; problem: "nothing-to-release" | "release-exceeds-held" };

/**
 * A retention release certificate (practical or final completion): the last certified
 * certificate's work done, materials and adjustments carried forward unchanged, with the
 * retention stage advanced, so the amount due is exactly the retention released. It may never
 * release more than is held (nor a negative amount, which a raised retention % could produce).
 */
export function releaseCertificate(input: {
  previous: Pick<
    CertificateFigures,
    "workDoneMinor" | "materialsGrossMinor" | "adjustmentsToDateMinor" | "retentionHeldMinor"
  >;
  previousCertifiedMinor: number;
  stage: Exclude<RetentionStage, "none">;
  originalContractSumMinor: number;
  terms: ContractTerms;
}): ReleaseCheck {
  if (input.previous.retentionHeldMinor <= 0) return { ok: false, problem: "nothing-to-release" };
  const figures = computeCertificate({
    workDoneMinor: input.previous.workDoneMinor,
    materialsGrossMinor: input.previous.materialsGrossMinor,
    adjustmentsMinor: 0,
    adjustmentsBeforeMinor: input.previous.adjustmentsToDateMinor,
    previousCertifiedMinor: input.previousCertifiedMinor,
    stage: input.stage,
    originalContractSumMinor: input.originalContractSumMinor,
    terms: input.terms,
  });
  if (figures.amountDueMinor < 0 || figures.amountDueMinor > input.previous.retentionHeldMinor)
    return { ok: false, problem: "release-exceeds-held" };
  return { ok: true, figures, releasedMinor: figures.amountDueMinor };
}

/** The sign each adjustment kind must carry (an `other` adjustment may be either, never 0). */
export function adjustmentSignOk(kind: AdjustmentKind, amountMinor: number): boolean {
  if (!Number.isSafeInteger(amountMinor) || amountMinor === 0) return false;
  if (kind === "advance") return amountMinor > 0;
  if (kind === "advance_recovery" || kind === "contra_charge") return amountMinor < 0;
  return true;
}

/**
 * Advance recovery never exceeds the advances: over every certified certificate plus this one,
 * the recoveries (negative) never outweigh the advances paid.
 */
export function recoveryWithinAdvances(
  adjustments: readonly { kind: AdjustmentKind; amountMinor: number }[],
): boolean {
  let advances = 0;
  let recoveries = 0;
  for (const adjustment of adjustments)
    if (adjustment.kind === "advance") advances += adjustment.amountMinor;
    else if (adjustment.kind === "advance_recovery") recoveries -= adjustment.amountMinor;
  return recoveries <= advances;
}

/**
 * The retention stage a new interim certificate uses: the furthest certified release so far
 * (an interim after the practical-completion release keeps holding only the remaining part).
 */
export function retentionStageAfter(
  certifiedReleases: readonly ("practical" | "final")[],
): RetentionStage {
  if (certifiedReleases.includes("final")) return "final";
  if (certifiedReleases.includes("practical")) return "practical";
  return "none";
}
