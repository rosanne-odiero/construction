import { describe, expect, it } from "vitest";
import {
  advanceRecoverable,
  computeSubcontractCertificate,
  releaseWithinHeld,
  subcontractChangeMinor,
  subcontractLineAmountMinor,
  subcontractLineValueMinor,
  type SubcontractTerms,
} from "./certificate.js";
import {
  checkClaim,
  checkJobOutput,
  checkLineAgainstBq,
  jobQuantityInForce,
  reconcileItem,
  suggestedClaim,
  sumQuantities,
  toBqQuantity,
} from "./allocation.js";
import {
  PIECE_RATE_JOB_TRANSITIONS,
  pieceRateJobCode,
  SUBCONTRACT_ADVANCE_TRANSITIONS,
  SUBCONTRACT_CERTIFICATE_TRANSITIONS,
  SUBCONTRACT_TRANSITIONS,
  subcontractCertificateCode,
  subcontractCode,
} from "./lifecycle.js";

/**
 * KE-SUB-1 golden cases, worked by hand (KES minor units). The plastering subcontract of the demo:
 * 450 m² @ KES 280.00 = 126,000.00 (labour-only, exempt); retention 5 % limited to 5 % of
 * 126,000 = 6,300.00; advance 20,000.00 paid, recovered at 20 % of the work; withholding 3 %.
 * SCC-0001 at 200 m²: W 56,000.00; retention 2,800.00; recovery min(11,200, 20,000) = 11,200.00;
 * due 42,000.00; VAT 0; WHT 1,260.00; payable 40,740.00.
 */
const plastering: SubcontractTerms = {
  retentionPercent: "5",
  retentionLimitPercent: "5",
  practicalReleasePercent: "50",
  vatPercent: "16",
  whtPercent: "3",
  advanceRecoveryPercent: "20",
};

describe("KE-SUB-1 subcontract certificates", () => {
  it("computes the plastering certificate exactly", () => {
    const figures = computeSubcontractCertificate({
      workDoneMinor: 5_600_000,
      vatableWorkDoneMinor: 0,
      originalValueMinor: 12_600_000,
      stage: "none",
      advancesPaidMinor: 2_000_000,
      previousCertifiedMinor: 0,
      terms: plastering,
    });
    expect(figures).toEqual({
      workDoneMinor: 5_600_000,
      vatableWorkDoneMinor: 0,
      retentionStage: "none",
      retentionLimitMinor: 630_000,
      retentionComputedMinor: 280_000,
      retentionHeldMinor: 280_000,
      advancesPaidMinor: 2_000_000,
      recoveredToDateMinor: 1_120_000,
      advancesOutstandingMinor: 880_000,
      netToDateMinor: 4_200_000,
      previousCertifiedMinor: 0,
      amountDueMinor: 4_200_000,
      vatMinor: 0,
      whtMinor: 126_000,
      payableMinor: 4_074_000,
    });
  });

  it("limits retention at the limit and not a cent beyond", () => {
    const at = (work: number) =>
      computeSubcontractCertificate({
        workDoneMinor: work,
        vatableWorkDoneMinor: 0,
        originalValueMinor: 12_600_000,
        stage: "none",
        advancesPaidMinor: 0,
        previousCertifiedMinor: 0,
        terms: plastering,
      }).retentionHeldMinor;
    // 5 % of 12,600,000 = 630,000 reached exactly at 12,600,000 of work.
    expect(at(12_599_980)).toBe(629_999);
    expect(at(12_600_000)).toBe(630_000);
    expect(at(14_000_000)).toBe(630_000);
    // No limit: 5 % of everything.
    expect(
      computeSubcontractCertificate({
        workDoneMinor: 14_000_000,
        vatableWorkDoneMinor: 0,
        originalValueMinor: 12_600_000,
        stage: "none",
        advancesPaidMinor: 0,
        previousCertifiedMinor: 0,
        terms: { ...plastering, retentionLimitPercent: null },
      }).retentionHeldMinor,
    ).toBe(700_000);
  });

  it("releases half at practical completion and the rest at final completion", () => {
    const at = (stage: "none" | "practical" | "final") =>
      computeSubcontractCertificate({
        workDoneMinor: 12_600_000,
        vatableWorkDoneMinor: 0,
        originalValueMinor: 12_600_000,
        stage,
        advancesPaidMinor: 0,
        previousCertifiedMinor: 12_600_000 - 630_000,
        terms: plastering,
      });
    expect(at("none").amountDueMinor).toBe(0);
    expect(at("practical").retentionHeldMinor).toBe(315_000);
    expect(at("practical").amountDueMinor).toBe(315_000);
    expect(at("final").retentionHeldMinor).toBe(0);
    expect(releaseWithinHeld(at("practical"), 630_000)).toBe("ok");
    expect(releaseWithinHeld(at("practical"), 0)).toBe("nothing-to-release");
    expect(releaseWithinHeld({ amountDueMinor: 630_001 }, 630_000)).toBe("release-exceeds-held");
    expect(releaseWithinHeld({ amountDueMinor: -1 }, 630_000)).toBe("release-exceeds-held");
  });

  it("never recovers more than the advances paid, so outstanding is never negative", () => {
    const recovered = (work: number, paid: number) =>
      computeSubcontractCertificate({
        workDoneMinor: work,
        vatableWorkDoneMinor: 0,
        originalValueMinor: 12_600_000,
        stage: "none",
        advancesPaidMinor: paid,
        previousCertifiedMinor: 0,
        terms: plastering,
      });
    // 20 % of 12,600,000 = 2,520,000 but only 2,000,000 was paid.
    expect(recovered(12_600_000, 2_000_000).recoveredToDateMinor).toBe(2_000_000);
    expect(recovered(12_600_000, 2_000_000).advancesOutstandingMinor).toBe(0);
    // Exactly at the boundary: 20 % of 10,000,000 = 2,000,000 = paid.
    expect(recovered(10_000_000, 2_000_000).recoveredToDateMinor).toBe(2_000_000);
    expect(recovered(9_999_995, 2_000_000).recoveredToDateMinor).toBe(1_999_999);
    // No advance: nothing recovered.
    expect(recovered(5_600_000, 0).recoveredToDateMinor).toBe(0);
    for (const work of [0, 1, 5_600_000, 99_000_000])
      expect(recovered(work, 2_000_000).advancesOutstandingMinor).toBeGreaterThanOrEqual(0);
  });

  it("charges VAT on the standard-rated share of the amount due and withholding on the amount due", () => {
    const windows = computeSubcontractCertificate({
      workDoneMinor: 9_840_000,
      vatableWorkDoneMinor: 9_840_000,
      originalValueMinor: 29_520_000,
      stage: "none",
      advancesPaidMinor: 0,
      previousCertifiedMinor: 0,
      terms: {
        ...plastering,
        retentionPercent: "10",
        whtPercent: "0",
        advanceRecoveryPercent: "0",
      },
    });
    expect(windows).toMatchObject({
      retentionHeldMinor: 984_000,
      amountDueMinor: 8_856_000,
      vatMinor: 1_416_960,
      whtMinor: 0,
      payableMinor: 10_272_960,
    });
    // Half the work standard-rated: VAT on half the amount due (round(1,000 × 16 % × ½) = 80).
    const mixed = computeSubcontractCertificate({
      workDoneMinor: 1_000,
      vatableWorkDoneMinor: 500,
      originalValueMinor: 1_000,
      stage: "none",
      advancesPaidMinor: 0,
      previousCertifiedMinor: 0,
      terms: { ...plastering, retentionPercent: "0", whtPercent: "0", advanceRecoveryPercent: "0" },
    });
    expect(mixed.vatMinor).toBe(80);
    // No work yet: no VAT whatever was certified before (a negative certificate).
    const empty = computeSubcontractCertificate({
      workDoneMinor: 0,
      vatableWorkDoneMinor: 0,
      originalValueMinor: 1_000,
      stage: "none",
      advancesPaidMinor: 0,
      previousCertifiedMinor: 500,
      terms: plastering,
    });
    expect(empty).toMatchObject({ amountDueMinor: -500, vatMinor: 0, whtMinor: -15 });
  });

  it("refuses impossible inputs", () => {
    const base = {
      workDoneMinor: 100,
      vatableWorkDoneMinor: 0,
      originalValueMinor: 100,
      stage: "none" as const,
      advancesPaidMinor: 0,
      previousCertifiedMinor: 0,
      terms: plastering,
    };
    expect(() => computeSubcontractCertificate({ ...base, workDoneMinor: -1 })).toThrow();
    expect(() => computeSubcontractCertificate({ ...base, vatableWorkDoneMinor: 101 })).toThrow();
    expect(() => computeSubcontractCertificate({ ...base, workDoneMinor: 0.5 })).toThrow();
  });

  it("values lines at the subcontract's own rate, quantity or percent", () => {
    expect(subcontractLineAmountMinor("quantity", "450", 28_000, null)).toBe(12_600_000);
    expect(subcontractLineAmountMinor("quantity", "0.0001", 28_005, null)).toBe(3);
    expect(subcontractLineAmountMinor("percent", "40", null, 5_000_000)).toBe(5_000_000);
    const quantityLine = {
      basis: "quantity" as const,
      quantity: "450",
      rateMinor: 28_000,
      amountMinor: 12_600_000,
      vatTreatment: "exempt" as const,
    };
    expect(subcontractLineValueMinor(quantityLine, "200")).toBe(5_600_000);
    expect(subcontractLineValueMinor(quantityLine, "0")).toBe(0);
    // A lump sum let for 40 % of the item at 5,000,000: 10 % of the item done = a quarter.
    const percentLine = {
      ...quantityLine,
      basis: "percent" as const,
      quantity: "40",
      rateMinor: null,
      amountMinor: 5_000_000,
    };
    expect(subcontractLineValueMinor(percentLine, "10")).toBe(1_250_000);
    expect(subcontractLineValueMinor(percentLine, "40")).toBe(5_000_000);
    expect(subcontractChangeMinor(quantityLine, "-50")).toBe(-1_400_000);
    expect(subcontractChangeMinor(percentLine, "4")).toBe(500_000);
  });

  it("only lets an advance the terms can recover", () => {
    expect(advanceRecoverable(2_000_000, 12_600_000, "20")).toBe(true);
    expect(advanceRecoverable(2_520_000, 12_600_000, "20")).toBe(true);
    expect(advanceRecoverable(2_520_001, 12_600_000, "20")).toBe(false);
    expect(advanceRecoverable(1, 12_600_000, "0")).toBe(false);
    expect(advanceRecoverable(0, 12_600_000, "0")).toBe(true);
  });
});

describe("quantity caps", () => {
  it("keeps subcontract lines on an item within the BQ quantity unless excepted", () => {
    expect(
      checkLineAgainstBq({
        bqQuantity: "450",
        others: "250",
        quantity: "200",
        exceptionReason: null,
      }),
    ).toEqual({ ok: true, over: false });
    expect(
      checkLineAgainstBq({
        bqQuantity: "450",
        others: "250",
        quantity: "200.0001",
        exceptionReason: null,
      }),
    ).toEqual({ ok: false, problem: "over-bq-quantity", availableQuantity: "200" });
    expect(
      checkLineAgainstBq({
        bqQuantity: "450",
        others: "250",
        quantity: "210",
        exceptionReason: "Remeasured on site",
      }),
    ).toEqual({ ok: true, over: true });
    expect(
      checkLineAgainstBq({ bqQuantity: "100", others: "120", quantity: "1", exceptionReason: " " }),
    ).toEqual({ ok: false, problem: "over-bq-quantity", availableQuantity: "0" });
  });

  it("never claims more than the line or than measured less other subcontracts' claims", () => {
    expect(
      checkClaim({ claim: "200", lineQuantity: "450", measured: "200", otherClaims: "0" }),
    ).toEqual({ ok: true });
    expect(
      checkClaim({ claim: "200.0001", lineQuantity: "450", measured: "200", otherClaims: "0" }),
    ).toEqual({
      ok: false,
      problem: "claim-exceeds-measured",
      availableQuantity: "200",
    });
    expect(
      checkClaim({ claim: "150", lineQuantity: "450", measured: "200", otherClaims: "60" }),
    ).toEqual({
      ok: false,
      problem: "claim-exceeds-measured",
      availableQuantity: "140",
    });
    expect(
      checkClaim({ claim: "451", lineQuantity: "450", measured: "500", otherClaims: "0" }),
    ).toEqual({
      ok: false,
      problem: "claim-exceeds-line",
      availableQuantity: "450",
    });
    expect(suggestedClaim({ lineQuantity: "450", measured: "200", otherClaims: "60" })).toBe("140");
    expect(suggestedClaim({ lineQuantity: "100", measured: "200", otherClaims: "0" })).toBe("100");
    expect(suggestedClaim({ lineQuantity: "100", measured: "50", otherClaims: "80" })).toBe("0");
    expect(sumQuantities(["0.1", "0.2", "12.3456"])).toBe("12.6456");
  });

  it("keeps approved piece-rate output within the job's agreed quantity and approved extensions", () => {
    expect(jobQuantityInForce("120", ["10.5", "4"])).toBe("134.5");
    const inForce = jobQuantityInForce("100", []);
    expect(
      checkJobOutput({ inForce, approved: "60", pending: "30", quantity: "10", stage: "record" }),
    ).toEqual({ ok: true, remaining: "10" });
    expect(
      checkJobOutput({
        inForce,
        approved: "60",
        pending: "30",
        quantity: "10.001",
        stage: "record",
      }),
    ).toEqual({
      ok: false,
      problem: "job-quantity-exceeded",
      remaining: "10",
    });
    // Approval counts approved output only (the pending output was counted when recorded).
    expect(
      checkJobOutput({ inForce, approved: "60", pending: "30", quantity: "40", stage: "approve" })
        .ok,
    ).toBe(true);
    expect(
      checkJobOutput({
        inForce,
        approved: "60.001",
        pending: "0",
        quantity: "40",
        stage: "approve",
      }).ok,
    ).toBe(false);
    expect(
      checkJobOutput({
        inForce: "100",
        approved: "110",
        pending: "0",
        quantity: "1",
        stage: "record",
      }),
    ).toEqual({
      ok: false,
      problem: "job-quantity-exceeded",
      remaining: "0",
    });
  });

  it("converts job quantities to the BQ unit and flags pay above measured work", () => {
    expect(toBqQuantity("12.5", "1")).toBe("12.5");
    expect(toBqQuantity("10", "0.04")).toBe("0.4");
    expect(toBqQuantity("1", "0.33333")).toBe("0.3333");
    expect(toBqQuantity("1", "0.33335")).toBe("0.3334");
    expect(
      reconcileItem({ measured: "90", pieceRate: "96", subcontracted: "0", unlinkedApproved: 0 }),
    ).toEqual({
      measured: "90",
      pieceRate: "96",
      subcontracted: "0",
      excessPieceRate: "6",
      excessCombined: "6",
      flags: ["piece-rate-above-measured"],
    });
    expect(
      reconcileItem({ measured: "90", pieceRate: "90", subcontracted: "0", unlinkedApproved: 0 })
        .flags,
    ).toEqual([]);
    expect(
      reconcileItem({ measured: "90", pieceRate: "60", subcontracted: "40", unlinkedApproved: 1 })
        .flags,
    ).toEqual(["combined-above-measured", "unlinked-outputs"]);
    expect(
      reconcileItem({ measured: null, pieceRate: "5", subcontracted: "0", unlinkedApproved: 0 })
        .flags,
    ).toEqual(["not-measured", "piece-rate-above-measured"]);
  });
});

describe("subcontract lifecycles", () => {
  it("defines who may move where", () => {
    expect(SUBCONTRACT_TRANSITIONS.approve.from).toEqual(["submitted"]);
    expect(SUBCONTRACT_TRANSITIONS.terminate).toEqual({
      from: ["approved", "active"],
      to: "terminated",
      reason: true,
    });
    expect(SUBCONTRACT_CERTIFICATE_TRANSITIONS.certify.from).toEqual(["submitted"]);
    expect(SUBCONTRACT_ADVANCE_TRANSITIONS.pay.from).toEqual(["approved"]);
    expect(PIECE_RATE_JOB_TRANSITIONS.close.from).toEqual(["approved"]);
    expect(subcontractCode(3)).toBe("SC-0003");
    expect(subcontractCertificateCode(2, true)).toBe("SCC-0002");
    expect(subcontractCertificateCode(2, false)).toBe("SCV-0002");
    expect(pieceRateJobCode(12)).toBe("PRJ-0012");
  });
});
