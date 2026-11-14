import { describe, expect, it } from "vitest";
import {
  canonicalFxRate,
  certificateBalances,
  certificateDueDate,
  clientApprovalSatisfied,
  clientProgress,
  clientRequestOpen,
  clientRequestState,
  clientStatement,
  clientVariationText,
  fxRateUsable,
  indicativeAmount,
  isPaybillNumber,
  kesToForeignMinor,
  nextPaymentRequestState,
  overdueDays,
  parseFxRate,
  paybillAccountReference,
  paymentRequestPaid,
  progressPercent,
  receiptFits,
  type ClientPaymentInput,
  type ClientVariationView,
} from "../index.js";

/**
 * D7.1 golden cases, worked by hand (KES minor units; Nairobi calendar dates).
 *
 * IPC-0001 certified 2026-09-01, 14 days' terms → due 2026-09-15, total KES 582,511.40.
 * IPC-0002 certified 2026-10-01, 14 days → due 2026-10-15, total KES 477,235.60.
 * Receipts: 2026-09-10 KES 300,000.00 and 2026-09-20 KES 282,511.40 against IPC-0001 (paid in
 * full); 2026-10-12 KES 100,000.00 against IPC-0002, reversed on 2026-10-13 (a duplicate entry);
 * 2026-10-14 KES 100,000.00 against IPC-0002. On 2026-10-20: certified 1,059,747.00, received
 * 682,511.40, outstanding 377,235.60 (IPC-0002), overdue 5 days → overdue 377,235.60.
 */
const IPC1 = {
  id: "c1",
  number: "IPC-0001",
  certifiedOn: "2026-09-01",
  dueDate: "2026-09-15",
  totalMinor: 58_251_140,
};
const IPC2 = {
  id: "c2",
  number: "IPC-0002",
  certifiedOn: "2026-10-01",
  dueDate: "2026-10-15",
  totalMinor: 47_723_560,
};
const receipt = (
  id: string,
  certificateId: string,
  amountMinor: number,
  receivedOn: string,
): ClientPaymentInput => ({
  id,
  certificateId,
  kind: "receipt",
  reversesId: null,
  amountMinor,
  receivedOn,
});
const PAYMENTS: ClientPaymentInput[] = [
  receipt("r1", "c1", 30_000_000, "2026-09-10"),
  receipt("r2", "c1", 28_251_140, "2026-09-20"),
  receipt("r3", "c2", 10_000_000, "2026-10-12"),
  {
    id: "v3",
    certificateId: "c2",
    kind: "reversal",
    reversesId: "r3",
    amountMinor: 10_000_000,
    receivedOn: "2026-10-13",
  },
  receipt("r4", "c2", 10_000_000, "2026-10-14"),
];

describe("certificate due dates and overdue days (Nairobi calendar dates)", () => {
  it("adds the payment period to the certification date across months and leap days", () => {
    expect(certificateDueDate("2026-09-01", 14)).toBe("2026-09-15");
    expect(certificateDueDate("2028-02-20", 14)).toBe("2028-03-05");
    expect(certificateDueDate("2027-02-20", 14)).toBe("2027-03-06");
    expect(certificateDueDate("2026-12-25", 0)).toBe("2026-12-25");
    expect(() => certificateDueDate("2026-09-01", -1)).toThrow(RangeError);
    expect(() => certificateDueDate("01/09/2026", 14)).toThrow(RangeError);
  });

  it("counts a certificate overdue from the day after its due date", () => {
    expect(overdueDays("2026-10-15", "2026-10-14")).toBe(0);
    expect(overdueDays("2026-10-15", "2026-10-15")).toBe(0);
    expect(overdueDays("2026-10-15", "2026-10-16")).toBe(1);
    expect(overdueDays("2026-12-31", "2027-01-30")).toBe(30);
  });
});

describe("client statement (rule D-133)", () => {
  it("nets reversals, totals what is outstanding and overdue, and runs the balance", () => {
    const statement = clientStatement({
      certificates: [IPC1, IPC2],
      payments: PAYMENTS,
      today: "2026-10-20",
    });
    expect(statement).toMatchObject({
      certifiedMinor: 105_974_700,
      receivedMinor: 68_251_140,
      outstandingMinor: 37_723_560,
      overdueMinor: 37_723_560,
    });
    expect(statement.certificates.map((row) => [row.state, row.overdueDays])).toEqual([
      ["paid", 0],
      ["part_paid", 5],
    ]);
    expect(statement.entries.map((entry) => [entry.kind, entry.date, entry.balanceMinor])).toEqual([
      ["certificate", "2026-09-01", 58_251_140],
      ["receipt", "2026-09-10", 28_251_140],
      ["receipt", "2026-09-20", 0],
      ["certificate", "2026-10-01", 47_723_560],
      ["receipt", "2026-10-12", 37_723_560],
      ["reversal", "2026-10-13", 47_723_560],
      ["receipt", "2026-10-14", 37_723_560],
    ]);
  });

  it("is not overdue on the due date, and a fully received certificate is never overdue", () => {
    const onDue = certificateBalances({ certificates: [IPC2], payments: [], today: "2026-10-15" });
    expect(onDue.certificates[0]).toMatchObject({
      state: "unpaid",
      overdue: false,
      overdueDays: 0,
    });
    const later = clientStatement({
      certificates: [IPC1],
      payments: PAYMENTS.slice(0, 2),
      today: "2027-06-01",
    });
    expect(later.overdueMinor).toBe(0);
    expect(later.certificates[0]).toMatchObject({ state: "paid", overdue: false });
  });

  it("orders certificates before receipts before reversals on the same day", () => {
    const sameDay = clientStatement({
      certificates: [{ ...IPC1, certifiedOn: "2026-09-10" }],
      payments: [
        {
          id: "v1",
          certificateId: "c1",
          kind: "reversal",
          reversesId: "r1",
          amountMinor: 30_000_000,
          receivedOn: "2026-09-10",
        },
        receipt("r1", "c1", 30_000_000, "2026-09-10"),
      ],
      today: "2026-09-10",
    });
    expect(sameDay.entries.map((entry) => entry.kind)).toEqual([
      "certificate",
      "receipt",
      "reversal",
    ]);
    expect(sameDay.certificates[0]!.state).toBe("unpaid");
  });

  it("refuses receipts above the total, mismatched or repeated reversals and unknown certificates", () => {
    expect(() =>
      certificateBalances({
        certificates: [IPC1],
        payments: [receipt("r1", "c1", IPC1.totalMinor + 1, "2026-09-10")],
        today: "2026-09-10",
      }),
    ).toThrow(RangeError);
    const reversal = (id: string, reversesId: string, amountMinor: number) => ({
      id,
      certificateId: "c1",
      kind: "reversal" as const,
      reversesId,
      amountMinor,
      receivedOn: "2026-09-11",
    });
    for (const payments of [
      [receipt("r1", "c1", 100, "2026-09-10"), reversal("v1", "r1", 99)],
      [
        receipt("r1", "c1", 100, "2026-09-10"),
        reversal("v1", "r1", 100),
        reversal("v2", "r1", 100),
      ],
      [reversal("v1", "missing", 100)],
    ])
      expect(() =>
        certificateBalances({ certificates: [IPC1], payments, today: "2026-09-12" }),
      ).toThrow(RangeError);
    expect(() =>
      certificateBalances({
        certificates: [IPC1],
        payments: [receipt("r1", "other", 100, "2026-09-10")],
        today: "2026-09-12",
      }),
    ).toThrow(RangeError);
  });

  it("applies a negative certificate as credit to the oldest certificates still owed", () => {
    // IPC-0003 corrects downwards by KES 50,000.00: IPC-0002's 377,235.60 falls to 327,235.60.
    const IPC3 = {
      id: "c3",
      number: "IPC-0003",
      certifiedOn: "2026-10-18",
      dueDate: "2026-11-01",
      totalMinor: -5_000_000,
    };
    const statement = clientStatement({
      certificates: [IPC3, IPC2, IPC1],
      payments: PAYMENTS,
      today: "2026-10-20",
    });
    expect(statement.certificates.map((row) => [row.number, row.state, row.creditedMinor])).toEqual(
      [
        ["IPC-0001", "paid", 0],
        ["IPC-0002", "part_paid", 5_000_000],
        ["IPC-0003", "credit", 0],
      ],
    );
    expect(statement).toMatchObject({
      certifiedMinor: 100_974_700,
      outstandingMinor: 32_723_560,
      overdueMinor: 32_723_560,
    });
    expect(statement.entries.at(-1)).toMatchObject({ kind: "certificate", creditMinor: 5_000_000 });
    expect(statement.entries.at(-1)!.balanceMinor).toBe(32_723_560);
    // Credit that covers a certificate with no receipt is "nothing due", never "paid".
    const covered = clientStatement({
      certificates: [IPC2, { ...IPC3, totalMinor: -50_000_000 }],
      payments: [],
      today: "2026-10-20",
    });
    expect(covered.certificates.map((row) => [row.number, row.state, row.receivedMinor])).toEqual([
      ["IPC-0002", "nothing_due", 0],
      ["IPC-0003", "credit", 0],
    ]);
    // With nothing left to apply it to, the client is in credit.
    const inCredit = clientStatement({
      certificates: [IPC1, IPC3],
      payments: PAYMENTS.slice(0, 2),
      today: "2026-10-20",
    });
    expect(inCredit.outstandingMinor).toBe(-5_000_000);
    expect(inCredit.overdueMinor).toBe(0);
  });

  it("lets a receipt take exactly what is outstanding and nothing more", () => {
    expect(receiptFits(37_723_560, 37_723_560)).toBe(true);
    expect(receiptFits(37_723_561, 37_723_560)).toBe(false);
    expect(receiptFits(0, 100)).toBe(false);
    expect(receiptFits(-1, 100)).toBe(false);
    expect(receiptFits(1.5, 100)).toBe(false);
  });
});

describe("indicative FX display (rule D-136)", () => {
  it("parses KES per unit with at most four places between 1 and 10,000", () => {
    expect(parseFxRate("129.45")).toBe(1_294_500n);
    expect(canonicalFxRate("129.45")).toBe("129.4500");
    expect(canonicalFxRate("1")).toBe("1.0000");
    expect(parseFxRate("10000")).toBe(100_000_000n);
    for (const bad of ["0.9999", "10000.0001", "129.45678", "1e3", "-1", " 129", "129.", ".5", ""])
      expect(parseFxRate(bad), bad).toBeNull();
    expect(() => canonicalFxRate("0")).toThrow(RangeError);
  });

  it("converts exactly and rounds half away from zero to the cent", () => {
    // KES 123,456.00 ÷ 129.45 = 953.6964… → USD 953.70.
    expect(kesToForeignMinor(12_345_600, "129.45")).toBe(95_370);
    // KES 0.03 ÷ 2 = 0.015 → 0.02; KES 0.01 ÷ 2 = 0.005 → 0.01; −0.03 → −0.02.
    expect(kesToForeignMinor(3, "2")).toBe(2);
    expect(kesToForeignMinor(1, "2")).toBe(1);
    expect(kesToForeignMinor(-3, "2")).toBe(-2);
    expect(kesToForeignMinor(0, "170.1")).toBe(0);
    // Large amounts stay exact: KES 90 trillion cents at 1.0001.
    expect(kesToForeignMinor(9_000_000_000_000_000, "1.0001")).toBe(8_999_100_089_991_001);
    expect(() => kesToForeignMinor(1.5, "129.45")).toThrow(RangeError);
  });

  it("shows a rate only from its date until it is 31 days old", () => {
    expect(fxRateUsable("2026-11-14", "2026-11-14")).toBe(true);
    expect(fxRateUsable("2026-10-14", "2026-11-14")).toBe(true);
    expect(fxRateUsable("2026-10-13", "2026-11-14")).toBe(false);
    expect(fxRateUsable("2026-11-15", "2026-11-14")).toBe(false);
    const rate = { currency: "USD" as const, kesPerUnit: "129.45", rateDate: "2026-11-14" };
    expect(indicativeAmount(12_345_600, rate, "2026-11-14")).toEqual({
      currency: "USD",
      minor: 95_370,
      kesPerUnit: "129.4500",
      rateDate: "2026-11-14",
    });
    expect(indicativeAmount(null, rate, "2026-11-14")).toBeNull();
    expect(indicativeAmount(12_345_600, null, "2026-11-14")).toBeNull();
    expect(indicativeAmount(12_345_600, rate, "2026-12-16")).toBeNull();
  });
});

describe("client progress (rule D-131)", () => {
  it("is earned value over BAC to one place, and not available without measured work", () => {
    expect(progressPercent(0, 141_500_000)).toBe("0.0");
    expect(progressPercent(1, 8)).toBe("12.5");
    expect(progressPercent(1, 3)).toBe("33.3");
    expect(progressPercent(2, 3)).toBe("66.7");
    expect(progressPercent(141_500_000, 141_500_000)).toBe("100.0");
    expect(progressPercent(9_007_199_254_740_991, 9_007_199_254_740_991)).toBe("100.0");
    expect(progressPercent(5, 0)).toBeNull();
    expect(progressPercent(null, 100)).toBeNull();
    expect(progressPercent(5, null)).toBeNull();
  });

  it("reports points ahead or behind plan only when both figures exist", () => {
    expect(clientProgress({ bacMinor: 1_000, evMinor: 455, pvMinor: 500 })).toEqual({
      percentComplete: "45.5",
      plannedPercent: "50.0",
      variancePoints: "-4.5",
    });
    expect(clientProgress({ bacMinor: 1_000, evMinor: 600, pvMinor: 500 }).variancePoints).toBe(
      "10.0",
    );
    expect(clientProgress({ bacMinor: 1_000, evMinor: 455, pvMinor: null })).toEqual({
      percentComplete: "45.5",
      plannedPercent: null,
      variancePoints: null,
    });
    expect(clientProgress({ bacMinor: 0, evMinor: 0, pvMinor: 0 }).percentComplete).toBeNull();
  });
});

describe("paying the contractor (rule D-135)", () => {
  it("builds the Paybill account reference and checks Paybill numbers", () => {
    expect(paybillAccountReference("project_certificate", "rui-hts", 2)).toBe("RUI-HTS-0002");
    expect(paybillAccountReference("project_certificate", "RUI-HTS", 12_345)).toBe("RUI-HTS-12345");
    expect(paybillAccountReference("project", "RUI-HTS", 2)).toBe("RUI-HTS");
    expect(() => paybillAccountReference("project_certificate", "RUI-HTS", 0)).toThrow(RangeError);
    expect(isPaybillNumber("174379")).toBe(true);
    for (const bad of ["1234", "12345678", "17437a", " 174379"])
      expect(isPaybillNumber(bad), bad).toBe(false);
  });

  it("never makes an STK request paid without a reconciled provider callback", () => {
    expect(nextPaymentRequestState("created", "confirm")).toBeNull();
    expect(nextPaymentRequestState("submitting", "confirm")).toBeNull();
    expect(nextPaymentRequestState("submitting", "timeout")).toBe("unknown");
    expect(nextPaymentRequestState("unknown", "submit")).toBeNull();
    expect(nextPaymentRequestState("unknown", "confirm")).toBe("confirmed");
    expect(nextPaymentRequestState("confirmed", "fail")).toBeNull();
    expect(nextPaymentRequestState("pending", "cancel")).toBeNull();
    expect(paymentRequestPaid("confirmed", false)).toBe(false);
    expect(paymentRequestPaid("pending", true)).toBe(false);
    expect(paymentRequestPaid("confirmed", true)).toBe(true);
  });
});

describe("variation decisions by the client (rule D-134)", () => {
  const view: ClientVariationView = {
    number: "VO-001",
    title: "Extra parking slab",
    description: null,
    instruction: { number: "AI-003", subject: "Parking" },
    lines: [
      {
        lineNo: 1,
        action: "add",
        ref: "V1",
        description: "Slab",
        unit: "m2",
        quantity: "40",
        rate: "2500",
        baseAmountMinor: 0,
        newAmountMinor: 10_000_000,
        deltaMinor: 10_000_000,
      },
    ],
    totals: { additionsMinor: 10_000_000, omissionsMinor: 0, netMinor: 10_000_000 },
    vatRatePercent: "16",
    baseGrandTotalMinor: 164_140_000,
    projectedGrandTotalMinor: 175_740_000,
    grandTotalEffectMinor: 11_600_000,
  };

  it("binds the digest text to every figure the client sees", () => {
    const text = clientVariationText(view);
    expect(clientVariationText({ ...view })).toBe(text);
    expect(
      clientVariationText({
        ...view,
        lines: [{ ...view.lines[0]!, rate: "2501" }],
      }),
    ).not.toBe(text);
    expect(clientVariationText({ ...view, grandTotalEffectMinor: 11_600_001 })).not.toBe(text);
  });

  it("keeps a sending open only for the same submitted proposal, until decided", () => {
    const variation = {
      status: "submitted" as const,
      snapshotDigest: "a".repeat(64),
      submittedAt: "2026-11-14T08:00:00.000Z",
    };
    const request = { snapshotDigest: "a".repeat(64), submittedAt: "2026-11-14T08:00:00.000Z" };
    expect(clientRequestOpen({ decided: false, variation, request })).toBe(true);
    expect(clientRequestOpen({ decided: true, variation, request })).toBe(false);
    expect(
      clientRequestOpen({
        decided: false,
        variation: { ...variation, status: "approved" },
        request,
      }),
    ).toBe(false);
    expect(
      clientRequestOpen({
        decided: false,
        variation: { ...variation, submittedAt: "2026-11-14T09:00:00.000Z" },
        request,
      }),
    ).toBe(false);
    expect(
      clientRequestOpen({
        decided: false,
        variation: { ...variation, snapshotDigest: "b".repeat(64) },
        request,
      }),
    ).toBe(false);
    expect(clientRequestState(null, true)).toBe("awaiting_decision");
    expect(clientRequestState(null, false)).toBe("withdrawn");
    expect(clientRequestState("rejected", false)).toBe("rejected");
  });

  it("holds internal approval for the client's approval only when the project requires it", () => {
    expect(clientApprovalSatisfied({ required: false, currentDecision: null })).toBe(true);
    expect(clientApprovalSatisfied({ required: true, currentDecision: null })).toBe(false);
    expect(clientApprovalSatisfied({ required: true, currentDecision: "rejected" })).toBe(false);
    expect(clientApprovalSatisfied({ required: true, currentDecision: "approved" })).toBe(true);
  });
});
