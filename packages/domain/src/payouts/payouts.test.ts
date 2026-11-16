import {
  DEFAULT_PAYOUT_SETTINGS,
  DEMO_B2C_TARIFF_BANDS,
  DEMO_PAYMENT_LIMITS,
  GSM7_BASIC_CHARACTERS,
  PAYROLL_BATCH_ACTIONS,
  PAYROLL_BATCH_STATUSES,
  type PayrollBatchStatus,
} from "@pm-buddy/types";
import { describe, expect, it } from "vitest";
import {
  approvalLimitFor,
  approvalNoticeParams,
  approvalReadiness,
  approvalSeparation,
  approvalSnapshot,
  approvalSnapshotText,
  batchCommand,
  canTransitionBatch,
  changeHoldUntil,
  checkApprovalLimit,
  checkCashCap,
  decisionActionText,
  destinationApprovalConflict,
  evaluateApprovalFlags,
  flagClearConflict,
  formatSmsAmount,
  formatSmsDate,
  formatSmsDateTime,
  gsm7Septets,
  isWithinBusinessHours,
  manualPaymentProblem,
  notificationRetryAt,
  numberChangeNoticeParams,
  obligationChannel,
  obligationProgress,
  payoutBlockReasons,
  payoutDisplayStatus,
  payslipSmsParams,
  planObligations,
  planPayoutStart,
  recipientBlockReasons,
  recomputeBatchStatus,
  reviewConflict,
  settlementStatusOf,
  smsSegments,
  tariffBandIssues,
  tariffCharge,
  tariffVersionOn,
  toGsm7,
  utilityBalanceMinor,
  verificationConflict,
  type EligibilityFacts,
  type StartInput,
} from "../index.js";

const limits = { b2cMinMinor: DEMO_PAYMENT_LIMITS.b2cMinMinor, b2cMaxMinor: 25_000_000 };

describe("payroll batch workflow (WORKFLOWS: Payroll, D4.3)", () => {
  const EDGES: ReadonlyArray<[PayrollBatchStatus, PayrollBatchStatus]> = [
    ["draft", "submitted"],
    ["draft", "cancelled"],
    ["submitted", "reviewed"],
    ["submitted", "rejected"],
    ["submitted", "cancelled"],
    ["reviewed", "approved"],
    ["reviewed", "rejected"],
    ["reviewed", "cancelled"],
    ["rejected", "draft"],
    ["approved", "disbursing"],
    ["approved", "partially_settled"],
    ["approved", "settled"],
    ["disbursing", "partially_settled"],
    ["disbursing", "settled"],
    ["partially_settled", "disbursing"],
    ["partially_settled", "settled"],
    ["settled", "partially_settled"],
    ["settled", "disbursing"],
  ];

  it("allows exactly the documented edges, never back before approval", () => {
    const allowed = new Set(EDGES.map(([from, to]) => `${from}->${to}`));
    for (const from of PAYROLL_BATCH_STATUSES)
      for (const to of PAYROLL_BATCH_STATUSES)
        expect(canTransitionBatch(from, to), `${from}->${to}`).toBe(allowed.has(`${from}->${to}`));
    for (const from of ["approved", "disbursing", "partially_settled", "settled"] as const)
      for (const to of ["draft", "submitted", "reviewed", "rejected", "cancelled"] as const)
        expect(canTransitionBatch(from, to)).toBe(false);
  });

  it("maps every command to its edge and refuses it from any other state", () => {
    expect(batchCommand("submitted", "review")).toEqual({ ok: true, to: "reviewed" });
    expect(batchCommand("reviewed", "reject")).toEqual({ ok: true, to: "rejected" });
    expect(batchCommand("rejected", "reopen")).toEqual({ ok: true, to: "draft" });
    expect(batchCommand("reviewed", "approve")).toEqual({ ok: true, to: "approved" });
    expect(batchCommand("reviewed", "cancel")).toEqual({ ok: true, to: "cancelled" });
    expect(batchCommand("submitted", "approve")).toEqual({
      ok: false,
      error: "invalid-transition",
    });
    expect(batchCommand("approved", "cancel")).toEqual({ ok: false, error: "invalid-transition" });
    expect(batchCommand("rejected", "review")).toEqual({ ok: false, error: "invalid-transition" });
    for (const status of PAYROLL_BATCH_STATUSES)
      for (const action of PAYROLL_BATCH_ACTIONS) {
        const result = batchCommand(status, action);
        if (result.ok)
          expect(canTransitionBatch(status, result.to), `${status}:${action}`).toBe(true);
      }
  });

  it("derives the settlement status from obligations and payouts", () => {
    const open = { amountMinor: 500_000, paidMinor: 0 };
    const paid = { amountMinor: 300_000, paidMinor: 300_000 };
    expect(settlementStatusOf({ obligations: [open, paid], payoutCount: 0 })).toBe(
      "partially_settled",
    );
    expect(settlementStatusOf({ obligations: [open], payoutCount: 0 })).toBe("approved");
    expect(settlementStatusOf({ obligations: [open], payoutCount: 1 })).toBe("disbursing");
    expect(settlementStatusOf({ obligations: [paid, paid], payoutCount: 2 })).toBe("settled");
    // Every line netted to zero: nothing to pay, settled at approval.
    expect(settlementStatusOf({ obligations: [], payoutCount: 0 })).toBe("settled");
    // A reversal reopens the only obligation: back to disbursing, never before approval.
    expect(recomputeBatchStatus("settled", { obligations: [open], payoutCount: 1 })).toBe(
      "disbursing",
    );
    expect(recomputeBatchStatus("reviewed", { obligations: [paid], payoutCount: 1 })).toBe(
      "reviewed",
    );
    expect(recomputeBatchStatus("cancelled", { obligations: [], payoutCount: 0 })).toBe(
      "cancelled",
    );
  });

  it("keeps preparer, reviewer and approver apart unless the waiver lets the reviewer approve", () => {
    const contributors = ["preparer", "recalculator"];
    expect(reviewConflict("preparer", contributors)).toBe("contributor");
    expect(reviewConflict("reviewer", contributors)).toBeNull();
    const base = { contributors, reviewerId: "reviewer" };
    expect(approvalSeparation({ ...base, actorId: "owner", waiverEnabled: false })).toEqual({
      ok: true,
      underWaiver: false,
    });
    expect(approvalSeparation({ ...base, actorId: "reviewer", waiverEnabled: false })).toEqual({
      ok: false,
      role: "reviewer",
    });
    expect(approvalSeparation({ ...base, actorId: "reviewer", waiverEnabled: true })).toEqual({
      ok: true,
      underWaiver: true,
    });
    // The waiver never lets a contributor approve.
    expect(approvalSeparation({ ...base, actorId: "preparer", waiverEnabled: true })).toEqual({
      ok: false,
      role: "contributor",
    });
  });

  it("separates verifiers, destination approvers and flag clearers from the people they check", () => {
    const changed = { phoneChangedBy: "clerk", registeredBy: "registrar" };
    expect(verificationConflict("clerk", { ...changed, numberFromRegistration: false })).toBe(
      "number_changer",
    );
    expect(
      verificationConflict("registrar", { ...changed, numberFromRegistration: false }),
    ).toBeNull();
    expect(
      verificationConflict("registrar", {
        phoneChangedBy: null,
        registeredBy: "registrar",
        numberFromRegistration: true,
      }),
    ).toBe("registrar");
    expect(
      destinationApprovalConflict("clerk", { contributors: ["pm"], phoneChangedBy: "clerk" }),
    ).toBe("number_changer");
    expect(
      flagClearConflict("owner", { contributors: ["pm"], approverId: "owner", startedBy: null }),
    ).toBe("approver");
    expect(
      flagClearConflict("finance", {
        contributors: ["pm"],
        approverId: "owner",
        startedBy: "finance",
      }),
    ).toBe("starter");
    expect(
      flagClearConflict("finance", { contributors: ["pm"], approverId: "owner", startedBy: null }),
    ).toBeNull();
  });

  it("applies approval limits: configured rows, the owner default and the waiver minimum", () => {
    const rows = [
      { systemRole: "finance", customRoleId: null, maxBatchNetMinor: 100_000_000 },
      { systemRole: null, customRoleId: "role-1", maxBatchNetMinor: 10_000_000 },
    ];
    expect(approvalLimitFor({ role: "owner", customRoleId: null }, rows)).toEqual({
      source: "owner_default",
      maxBatchNetMinor: 200_000_000,
    });
    expect(approvalLimitFor({ role: "finance", customRoleId: null }, rows)).toEqual({
      source: "configured",
      maxBatchNetMinor: 100_000_000,
    });
    expect(
      approvalLimitFor({ role: "custom", customRoleId: "role-1" }, rows).maxBatchNetMinor,
    ).toBe(10_000_000);
    expect(approvalLimitFor({ role: "project_manager", customRoleId: null }, rows)).toEqual({
      source: "none",
      maxBatchNetMinor: null,
    });
    const owner = approvalLimitFor({ role: "owner", customRoleId: null }, rows);
    expect(
      checkApprovalLimit({
        netMinor: 200_000_000,
        limit: owner,
        underWaiver: false,
        waiverLimitMinor: 50_000_000,
      }),
    ).toEqual({ ok: true, appliedLimitMinor: 200_000_000 });
    expect(
      checkApprovalLimit({
        netMinor: 60_000_000,
        limit: owner,
        underWaiver: true,
        waiverLimitMinor: 50_000_000,
      }),
    ).toEqual({
      ok: false,
      code: "approval-limit-exceeded",
      limitMinor: 50_000_000,
      netMinor: 60_000_000,
    });
    expect(
      checkApprovalLimit({
        netMinor: 1,
        limit: { source: "none", maxBatchNetMinor: null },
        underWaiver: false,
        waiverLimitMinor: 50_000_000,
      }),
    ).toEqual({ ok: false, code: "no-approval-limit" });
  });

  it("lists every approval blocker in precedence order", () => {
    const readiness = approvalReadiness({
      status: "submitted",
      actorId: "reviewer",
      contributors: ["pm"],
      reviewerId: "reviewer",
      waiverEnabled: false,
      waiverLimitMinor: 50_000_000,
      netMinor: 300_000_000,
      limit: { source: "owner_default", maxBatchNetMinor: 200_000_000 },
      unverifiedLabourerIds: ["w1"],
    });
    expect(readiness.blockers).toEqual([
      "not-reviewed",
      "maker-checker",
      "approval-limit-exceeded",
      "unverified-recipients",
    ]);
    const waived = approvalReadiness({
      status: "reviewed",
      actorId: "reviewer",
      contributors: ["pm"],
      reviewerId: "reviewer",
      waiverEnabled: true,
      waiverLimitMinor: 50_000_000,
      netMinor: 40_000_000,
      limit: { source: "owner_default", maxBatchNetMinor: 200_000_000 },
      unverifiedLabourerIds: [],
    });
    expect(waived).toEqual({ blockers: [], underWaiver: true, appliedLimitMinor: 50_000_000 });
  });
});

describe("obligations and the approval snapshot", () => {
  it("pays by M-Pesa only what one B2C payment can carry", () => {
    const channel = (payeePhoneBidx: string | null, amountMinor: number) =>
      obligationChannel({ payeePhoneBidx, amountMinor, limits });
    expect(channel("bidx", 500_000)).toEqual({ channel: "mpesa", manualReason: null });
    expect(channel(null, 500_000)).toEqual({ channel: "manual", manualReason: "no_number" });
    expect(channel("bidx", 900)).toEqual({ channel: "manual", manualReason: "below_b2c_min" });
    expect(channel("bidx", 25_000_100)).toEqual({
      channel: "manual",
      manualReason: "above_b2c_max",
    });
  });

  it("plans whole-shilling obligations, carries the cents forward and reports unverified recipients", () => {
    const plan = planObligations(
      [
        { lineId: "l3", labourerId: "w3", netMinor: 0, payeePhoneBidx: "b3" },
        { lineId: "l2", labourerId: "w2", netMinor: 300_000, payeePhoneBidx: "b2" },
        { lineId: "l1", labourerId: "w1", netMinor: 408_312, payeePhoneBidx: "b1" },
        { lineId: "l4", labourerId: "w4", netMinor: 200_000, payeePhoneBidx: null },
        { lineId: "l5", labourerId: "w5", netMinor: 200_000, payeePhoneBidx: "b5-old" },
        { lineId: "l6", labourerId: "w6", netMinor: 60, payeePhoneBidx: "b6" },
      ],
      new Map([
        ["w1", { currentPhoneBidx: "b1", verificationId: "v1" }],
        ["w2", { currentPhoneBidx: "b2", verificationId: null }],
        ["w3", { currentPhoneBidx: "b3", verificationId: null }],
        ["w5", { currentPhoneBidx: "b5-new", verificationId: "v5" }],
        ["w6", { currentPhoneBidx: "b6", verificationId: null }],
      ]),
      limits,
    );
    expect(plan.obligations.map((obligation) => obligation.lineId)).toEqual([
      "l1",
      "l2",
      "l4",
      "l5",
    ]);
    expect(plan.obligations[0]).toEqual({
      lineId: "l1",
      labourerId: "w1",
      amountMinor: 408_300,
      carryForwardMinor: 12,
      channel: "mpesa",
      manualReason: null,
      destinationBidx: "b1",
      verificationId: "v1",
    });
    expect(plan.obligations[2]).toMatchObject({ channel: "manual", manualReason: "no_number" });
    // A net below KES 1 is only carried forward; neither it nor net 0 needs a verification.
    expect(plan.carryForwards).toEqual([
      { lineId: "l1", labourerId: "w1", amountMinor: 12 },
      { lineId: "l6", labourerId: "w6", amountMinor: 60 },
    ]);
    // A number changed after calculation is no longer verified.
    expect(plan.unverifiedLabourerIds).toEqual(["w2", "w5"]);
    expect(plan.obligations[3]?.verificationId).toBeNull();
  });

  it("binds the approval digest to the obligations and carry-forwards whatever their order", () => {
    const { obligations, carryForwards } = planObligations(
      [
        { lineId: "c", labourerId: "w3", netMinor: 45, payeePhoneBidx: "z" },
        { lineId: "b", labourerId: "w2", netMinor: 300_000, payeePhoneBidx: "x" },
        { lineId: "a", labourerId: "w1", netMinor: 500_060, payeePhoneBidx: "y" },
      ],
      new Map([
        ["w1", { currentPhoneBidx: "y", verificationId: "v1" }],
        ["w2", { currentPhoneBidx: "x", verificationId: "v2" }],
      ]),
      limits,
    );
    const snapshot = (list = obligations, carries = carryForwards) =>
      approvalSnapshotText(
        approvalSnapshot({
          batchId: "batch",
          version: 2,
          digest: "d".repeat(64),
          obligations: list,
          carryForwards: carries,
        }),
      );
    expect(snapshot()).toBe(snapshot([...obligations].reverse(), [...carryForwards].reverse()));
    expect(snapshot()).toBe(
      '{"batchId":"batch","carryForwardOnly":[{"carryForwardMinor":45,"labourerId":"w3","lineId":"c"}],"digest":"' +
        "d".repeat(64) +
        '","obligations":[{"amountMinor":500000,"carryForwardMinor":60,"channel":"mpesa","destinationBidx":"y","labourerId":"w1","lineId":"a","verificationId":"v1"},{"amountMinor":300000,"carryForwardMinor":0,"channel":"mpesa","destinationBidx":"x","labourerId":"w2","lineId":"b","verificationId":"v2"}],"version":2}',
    );
    const changed = obligations.map((obligation) =>
      obligation.lineId === "a" ? { ...obligation, verificationId: "v9" } : obligation,
    );
    expect(snapshot(changed)).not.toBe(snapshot());
    expect(snapshot(obligations, [])).not.toBe(snapshot());
    expect(
      decisionActionText({
        batchId: "batch",
        version: 2,
        digest: "abc",
        approvalDigest: null,
        netMinor: 800_000,
        action: "review",
      }),
    ).toBe("batch|2|abc||800000|review");
  });

  it("flags large first payouts and shared numbers without revealing them", () => {
    const flags = evaluateApprovalFlags({
      candidates: [
        { key: "o1", labourerId: "w1", amountMinor: 6_000_000, destinationBidx: "new" },
        { key: "o2", labourerId: "w2", amountMinor: 6_000_000, destinationBidx: "known" },
        { key: "o3", labourerId: "w3", amountMinor: 100_000, destinationBidx: "twice" },
        { key: "o4", labourerId: "w4", amountMinor: 100_000, destinationBidx: "twice" },
        { key: "o5", labourerId: "w5", amountMinor: 100_000, destinationBidx: "other-worker" },
        { key: "o6", labourerId: "w6", amountMinor: 9_000_000, destinationBidx: null },
      ],
      paidDestinations: new Set(["known", "twice", "other-worker"]),
      activeLabourersByBidx: new Map([
        ["other-worker", ["w5", "w9"]],
        ["known", ["w2"]],
      ]),
      unusualNewRecipientMinor: DEFAULT_PAYOUT_SETTINGS.unusualNewRecipientMinor,
    });
    expect(flags).toEqual([
      {
        key: "o1",
        code: "new_recipient_large",
        details: { amountMinor: 6_000_000, thresholdMinor: 5_000_000 },
      },
      { key: "o3", code: "shared_number", details: { otherLabourers: 0, obligationsInBatch: 2 } },
      { key: "o4", code: "shared_number", details: { otherLabourers: 0, obligationsInBatch: 2 } },
      { key: "o5", code: "shared_number", details: { otherLabourers: 1, obligationsInBatch: 1 } },
    ]);
  });
});

describe("payout eligibility (§4, §5)", () => {
  const now = new Date("2026-11-16T09:00:00+03:00");
  const eligible: EligibilityFacts = {
    status: "open",
    channel: "mpesa",
    outstandingMinor: 500_000,
    livePayout: false,
    uncertainPayout: false,
    destinationBidx: "b1",
    currentPhoneBidx: "b1",
    currentNumberVerified: true,
    activeHolds: 0,
    phoneChangedAt: null,
    changeHoldOverridden: false,
    openFlags: 0,
    limits,
    payeeChangeHoldHours: 24,
    now,
  };

  it("is eligible only when nothing blocks it, and names every block", () => {
    expect(payoutBlockReasons(eligible)).toEqual([]);
    expect(payoutBlockReasons({ ...eligible, status: "settled" })).toEqual(["settled"]);
    expect(payoutBlockReasons({ ...eligible, channel: "manual" })).toEqual(["manual-channel"]);
    expect(
      payoutBlockReasons({
        ...eligible,
        livePayout: true,
        uncertainPayout: true,
        outstandingMinor: 450,
        currentPhoneBidx: "b2",
        currentNumberVerified: false,
        activeHolds: 1,
        phoneChangedAt: "2026-11-15T12:00:00+03:00",
        openFlags: 2,
      }),
    ).toEqual([
      "in-flight",
      "uncertain",
      "not-payable-by-mpesa",
      "destination-changed",
      "unverified",
      "on-hold",
      "change-hold",
      "flagged",
    ]);
  });

  it("holds a changed number for the configured hours unless an owner overrode it", () => {
    const changed = { ...eligible, phoneChangedAt: "2026-11-15T10:00:00+03:00" };
    expect(changeHoldUntil(changed.phoneChangedAt, 24)).toBe("2026-11-16T07:00:00.000Z");
    expect(payoutBlockReasons(changed)).toEqual(["change-hold"]);
    expect(payoutBlockReasons({ ...changed, changeHoldOverridden: true })).toEqual([]);
    expect(payoutBlockReasons({ ...changed, now: new Date("2026-11-16T10:00:00+03:00") })).toEqual(
      [],
    );
    expect(recipientBlockReasons({ ...changed, currentPhoneBidx: null, activeHolds: 1 })).toEqual([
      "unverified",
      "on-hold",
      "change-hold",
    ]);
    expect(changeHoldUntil(null, 24)).toBeNull();
    expect(changeHoldUntil("2026-11-15T10:00:00+03:00", 0)).toBeNull();
  });

  it("shows live D4.2 states per payout and one status per worker", () => {
    const mpesa = { method: "mpesa" as const, status: "active" as const };
    expect(payoutDisplayStatus(mpesa, "queued")).toBe("queued");
    expect(payoutDisplayStatus(mpesa, "created")).toBe("queued");
    expect(payoutDisplayStatus(mpesa, "unknown")).toBe("uncertain");
    expect(payoutDisplayStatus(mpesa, "pending")).toBe("pending");
    expect(payoutDisplayStatus({ method: "mpesa", status: "confirmed" }, "reversal_pending")).toBe(
      "reversal_pending",
    );
    expect(payoutDisplayStatus({ method: "cash", status: "pending_confirmation" }, null)).toBe(
      "pending_confirmation",
    );
    const progress = (latestPayout: Parameters<typeof obligationProgress>[0]["latestPayout"]) =>
      obligationProgress({ status: "open", paidMinor: 0, blockReasons: [], latestPayout });
    expect(progress(null)).toBe("ready");
    expect(progress("pending")).toBe("in_flight");
    expect(progress("uncertain")).toBe("uncertain");
    expect(progress("failed")).toBe("failed");
    expect(progress("reversed")).toBe("reversed");
    expect(
      obligationProgress({
        status: "open",
        paidMinor: 0,
        blockReasons: ["on-hold"],
        latestPayout: null,
      }),
    ).toBe("blocked");
    expect(
      obligationProgress({
        status: "open",
        paidMinor: 100,
        blockReasons: [],
        latestPayout: "confirmed",
      }),
    ).toBe("partially_paid");
    expect(
      obligationProgress({
        status: "settled",
        paidMinor: 9,
        blockReasons: [],
        latestPayout: "confirmed",
      }),
    ).toBe("settled");
  });

  it("records cash and bank only for what is outstanding, within the cash cap", () => {
    const base = {
      status: "open" as const,
      outstandingMinor: 500_000,
      livePayout: false,
      uncertainPayout: false,
    };
    expect(manualPaymentProblem({ ...base, amountMinor: 500_000 })).toBeNull();
    expect(manualPaymentProblem({ ...base, amountMinor: 500_100 })).toBe(
      "amount-above-outstanding",
    );
    expect(manualPaymentProblem({ ...base, livePayout: true, amountMinor: 1 })).toBe(
      "payout-in-flight",
    );
    expect(manualPaymentProblem({ ...base, uncertainPayout: true, amountMinor: 1 })).toBe(
      "payout-in-flight",
    );
    expect(manualPaymentProblem({ ...base, status: "settled", amountMinor: 1 })).toBe(
      "obligation-settled",
    );
    const cap = DEFAULT_PAYOUT_SETTINGS.cashMaxPerWorkerPeriodMinor;
    expect(checkCashCap({ capMinor: cap, usedMinor: 1_500_000, amountMinor: 500_000 })).toEqual({
      ok: true,
      capMinor: cap,
      usedMinor: 1_500_000,
      remainingMinor: 0,
    });
    expect(checkCashCap({ capMinor: cap, usedMinor: 1_500_000, amountMinor: 500_100 })).toEqual({
      ok: false,
      code: "cash-cap-exceeded",
      capMinor: cap,
      usedMinor: 1_500_000,
      remainingMinor: 500_000,
    });
    expect(checkCashCap({ capMinor: 0, usedMinor: 0, amountMinor: 1 })).toEqual({
      ok: false,
      code: "cash-disabled",
    });
  });
});

describe("starting payouts (§6)", () => {
  const morning = new Date("2026-11-16T09:00:00+03:00");
  const base: StartInput = {
    payoutsEnabled: true,
    now: morning,
    candidates: [
      { obligationId: "o2", outstandingMinor: 2_500_000, reasons: [] },
      { obligationId: "o1", outstandingMinor: 500_000, reasons: [] },
      { obligationId: "o3", outstandingMinor: 500_000, reasons: ["unverified"] },
    ],
    balance: { answeredAt: "2026-11-16T08:50:00+03:00", availableMinor: 10_000_000 },
    floatCheckMaxAgeMinutes: 15,
    inFlightMinor: 0,
    bands: DEMO_B2C_TARIFF_BANDS,
    dailyLimitMinor: DEMO_PAYMENT_LIMITS.dailyPayoutMaxMinor,
    usedTodayMinor: 0,
    businessHoursStart: "06:00",
    businessHoursEnd: "20:00",
  };

  it("submits every eligible obligation in full with its tariff charge", () => {
    const plan = planPayoutStart(base);
    expect(plan).toEqual({
      ok: true,
      outcome: "submit",
      payouts: [
        { obligationId: "o1", amountMinor: 500_000, chargeMinor: 900 },
        { obligationId: "o2", amountMinor: 2_500_000, chargeMinor: 1_300 },
      ],
      ineligible: [{ obligationId: "o3", reasons: ["unverified"] }],
      figures: {
        availableMinor: 10_000_000,
        inFlightMinor: 0,
        amountsMinor: 3_000_000,
        chargesMinor: 2_200,
        requiredMinor: 3_002_200,
        shortfallMinor: 0,
        answeredAt: "2026-11-16T08:50:00+03:00",
      },
    });
  });

  it("refuses in order: paused, nothing eligible, stale float, insufficient float, daily limit", () => {
    expect(planPayoutStart({ ...base, payoutsEnabled: false })).toEqual({
      ok: false,
      code: "payouts-paused",
    });
    expect(
      planPayoutStart({
        ...base,
        candidates: [{ obligationId: "o3", outstandingMinor: 1, reasons: ["in-flight"] }],
      }),
    ).toMatchObject({ ok: false, code: "nothing-eligible" });
    expect(planPayoutStart({ ...base, balance: null })).toMatchObject({
      ok: false,
      code: "float-check-required",
      answeredAt: null,
    });
    expect(
      planPayoutStart({
        ...base,
        balance: { answeredAt: "2026-11-16T08:40:00+03:00", availableMinor: 9 },
      }),
    ).toEqual({
      ok: false,
      code: "float-check-required",
      answeredAt: "2026-11-16T08:40:00+03:00",
      ageMinutes: 20,
      maxAgeMinutes: 15,
    });
    const short = planPayoutStart({ ...base, inFlightMinor: 7_000_000 });
    expect(short).toMatchObject({
      ok: false,
      code: "insufficient-float",
      figures: { requiredMinor: 3_002_200, shortfallMinor: 2_200 },
    });
    expect(planPayoutStart({ ...base, usedTodayMinor: 48_000_000 })).toEqual({
      ok: false,
      code: "daily-limit-exceeded",
      dailyLimitMinor: 50_000_000,
      usedTodayMinor: 48_000_000,
      amountsMinor: 3_000_000,
    });
    expect(planPayoutStart({ ...base, bands: [] })).toEqual({
      ok: false,
      code: "tariff-missing",
      obligationIds: ["o1", "o2"],
    });
  });

  it("flags instead of paying outside business hours (Africa/Nairobi)", () => {
    expect(
      planPayoutStart({
        ...base,
        now: new Date("2026-11-16T20:00:00+03:00"),
        balance: { answeredAt: "2026-11-16T19:55:00+03:00", availableMinor: 10_000_000 },
      }),
    ).toEqual({
      ok: true,
      outcome: "outside_business_hours",
      flagObligationIds: ["o1", "o2"],
      ineligible: [{ obligationId: "o3", reasons: ["unverified"] }],
    });
    expect(isWithinBusinessHours(new Date("2026-11-16T03:00:00Z"), "06:00", "20:00")).toBe(true);
    expect(isWithinBusinessHours(new Date("2026-11-16T02:59:00Z"), "06:00", "20:00")).toBe(false);
    expect(isWithinBusinessHours(new Date("2026-11-16T16:59:00Z"), "06:00", "20:00")).toBe(true);
    expect(isWithinBusinessHours(new Date("2026-11-16T17:00:00Z"), "06:00", "20:00")).toBe(false);
    expect(isWithinBusinessHours(morning, "20:00", "06:00")).toBe(false);
    expect(isWithinBusinessHours(morning, "6am", "20:00")).toBe(false);
  });

  it("reads the B2C float from the utility account", () => {
    expect(
      utilityBalanceMinor([
        { account: "Working Account", currency: "KES", availableMinor: 70_000_000 },
        { account: "Utility Account", currency: "KES", availableMinor: 22_803_700 },
      ]),
    ).toBe(22_803_700);
    expect(utilityBalanceMinor(null)).toBeNull();
  });
});

describe("charges tariff (§12)", () => {
  it("prices each amount by its band and refuses what no band covers", () => {
    expect(tariffBandIssues(DEMO_B2C_TARIFF_BANDS)).toEqual([]);
    expect(tariffCharge(DEMO_B2C_TARIFF_BANDS, 1_000)).toBe(0);
    expect(tariffCharge(DEMO_B2C_TARIFF_BANDS, 10_000)).toBe(0);
    expect(tariffCharge(DEMO_B2C_TARIFF_BANDS, 10_100)).toBe(500);
    expect(tariffCharge(DEMO_B2C_TARIFF_BANDS, 2_000_000)).toBe(1_100);
    expect(tariffCharge(DEMO_B2C_TARIFF_BANDS, 25_000_000)).toBe(1_300);
    expect(tariffCharge(DEMO_B2C_TARIFF_BANDS, 25_000_100)).toBeNull();
    expect(tariffCharge(DEMO_B2C_TARIFF_BANDS, 0)).toBeNull();
    expect(
      tariffBandIssues([
        { upToMinor: 500_000, chargeMinor: 1_000 },
        { upToMinor: 100_000, chargeMinor: 550 },
      ]),
    ).toEqual(["not_ascending", "not_whole_shillings"]);
    expect(tariffBandIssues([])).toEqual(["empty"]);
  });

  it("selects the version in force on the payout date", () => {
    const versions = [
      { id: "v1", effectiveFrom: "2024-01-01" },
      { id: "v3", effectiveFrom: "2026-12-01" },
      { id: "v2", effectiveFrom: "2026-06-01" },
    ];
    expect(tariffVersionOn(versions, "2026-11-16")?.id).toBe("v2");
    expect(tariffVersionOn(versions, "2026-12-01")?.id).toBe("v3");
    expect(tariffVersionOn(versions, "2023-12-31")).toBeNull();
  });
});

describe("payout SMS values (§9, CR-PAY-12)", () => {
  it("counts GSM-7 septets and segments, and reduces any text to GSM-7", () => {
    expect(Array.from(GSM7_BASIC_CHARACTERS)).toHaveLength(127);
    expect(gsm7Septets("Habari {jina}")).toBe(15);
    expect(gsm7Septets("Café ✓")).toBeNull();
    expect(smsSegments(160)).toBe(1);
    expect(smsSegments(161)).toBe(2);
    expect(smsSegments(459)).toBe(3);
    expect(smsSegments(460)).toBe(4);
    expect(toGsm7("“Wanjiku’s” Builders — Ltd ✓ {Nairobi} Šola", 40)).toBe(
      '"Wanjiku\'s" Builders - Ltd Nairobi Sola',
    );
    expect(toGsm7("Mjenzi\nBora   Ltd", 9)).toBe("Mjenzi Bo");
  });

  it("formats money and dates the same way in English and Kiswahili", () => {
    expect(formatSmsAmount(123_456)).toBe("1,234.56");
    expect(formatSmsAmount(150_000)).toBe("1,500");
    expect(formatSmsAmount(-1_005)).toBe("-10.05");
    expect(formatSmsAmount(99_999_999_999)).toBe("999,999,999.99");
    expect(formatSmsAmount(100_000_000_000)).toBeNull();
    expect(formatSmsDate("2026-11-09")).toBe("09/11/2026");
    expect(formatSmsDate("2026-02-30")).toBeNull();
    expect(formatSmsDateTime(new Date("2026-11-16T11:05:00Z"))).toBe("16/11/2026 14:05");
  });

  it("builds the payslip values from the line and its confirmed payments", () => {
    const input = {
      companyName: "Mjenzi Bora Construction Ltd",
      periodStart: "2026-11-09",
      periodEnd: "2026-11-15",
      days: "5.5",
      rateBasis: "daily" as const,
      rateMinor: 80_000,
      grossMinor: 440_000,
      totalDeductionsMinor: 31_250,
      netMinor: 408_790,
      broughtForwardMinor: 40,
      paidMinor: 408_700,
      carryForwardMinor: 90,
      payments: [
        {
          method: "cash" as const,
          reference: "CASH-1",
          amountMinor: 8_700,
          confirmedAt: "2026-11-16T08:00:00Z",
        },
        {
          method: "mpesa" as const,
          reference: "TKG7AB12CD",
          amountMinor: 400_000,
          confirmedAt: "2026-11-16T07:00:00Z",
        },
      ],
    };
    expect(payslipSmsParams(input)).toEqual({
      ok: true,
      params: {
        company: "Mjenzi Bora Construction Ltd",
        periodStart: "09/11/2026",
        periodEnd: "15/11/2026",
        days: "5.5",
        rateBasis: "daily",
        rate: "800",
        gross: "4,400",
        deductions: "312.50",
        net: "4,087.90",
        withBroughtForward: "yes",
        broughtForward: "0.40",
        paid: "4,087",
        method: "mpesa",
        reference: "TKG7AB12CD",
        others: 1,
        withCarryForward: "yes",
        carryForward: "0.90",
      },
    });
    const cash = payslipSmsParams({
      ...input,
      rateBasis: null,
      rateMinor: null,
      netMinor: 408_700,
      broughtForwardMinor: 0,
      carryForwardMinor: 0,
      payments: [input.payments[0]!],
    });
    expect(cash.ok && cash.params).toMatchObject({
      rateBasis: "none",
      rate: "",
      net: "4,087",
      withBroughtForward: "no",
      broughtForward: "",
      method: "cash",
      reference: "",
      others: 0,
      withCarryForward: "no",
      carryForward: "",
    });
    expect(payslipSmsParams({ ...input, carryForwardMinor: 60 })).toEqual({
      ok: false,
      error: "amounts_mismatch",
    });
    expect(payslipSmsParams({ ...input, payments: [] })).toEqual({
      ok: false,
      error: "no_payment",
    });
    expect(payslipSmsParams({ ...input, days: "4.25" })).toEqual({
      ok: false,
      error: "invalid_days",
    });
    expect(payslipSmsParams({ ...input, grossMinor: 10 ** 12 })).toEqual({
      ok: false,
      error: "amount_out_of_range",
    });
  });

  it("builds the approval and number-change notices without personal data beyond names", () => {
    expect(
      approvalNoticeParams({
        companyName: "Mjenzi Bora",
        batchReference: "PR-001/2026-11-09",
        projectName: "Kilimani Heights — Block B",
        periodStart: "2026-11-09",
        periodEnd: "2026-11-15",
        netMinor: 16_350_000,
        approverName: "Achieng’ Otieno",
        approvedAt: new Date("2026-11-16T07:30:00Z"),
        underWaiver: true,
      }),
    ).toEqual({
      company: "Mjenzi Bora",
      batchReference: "PR-001/2026-11-09",
      project: "Kilimani Heights - Block B",
      periodStart: "09/11/2026",
      periodEnd: "15/11/2026",
      net: "163,500",
      approver: "Achieng' Otieno",
      approvedAt: "16/11/2026 10:30",
      waiver: "yes",
    });
    expect(
      numberChangeNoticeParams({
        companyName: "Mjenzi Bora",
        changedAt: new Date("2026-11-15T22:30:00Z"),
      }),
    ).toEqual({ company: "Mjenzi Bora", date: "16/11/2026" });
  });

  it("retries a failed notification after 1, 5, 30, 120 and 360 minutes, then gives up", () => {
    const failedAt = new Date("2026-11-16T09:00:00Z");
    const delays = [1, 2, 3, 4, 5].map(
      (failures) =>
        (notificationRetryAt(failures, failedAt)!.getTime() - failedAt.getTime()) / 60_000,
    );
    expect(delays).toEqual([1, 5, 30, 120, 360]);
    expect(notificationRetryAt(6, failedAt)).toBeNull();
    expect(notificationRetryAt(0, failedAt)).toBeNull();
  });
});
