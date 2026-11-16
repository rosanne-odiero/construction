import { DEMO_B2C_TARIFF_BANDS, OBLIGATION_PROGRESS_STATUSES } from "@pm-buddy/types";
import { describe, expect, it } from "vitest";
import {
  approveBatchRequestSchema,
  batchPayoutsResponseSchema,
  carryForwardSchema,
  mpesaReconciliationItemSchema,
  putTariffRequestSchema,
  reconciliationItemsQuerySchema,
  recordManualPaymentRequestSchema,
  registerLabourerRequestSchema,
  rejectBatchRequestSchema,
  resolveReconciliationItemRequestSchema,
  reviewBatchRequestSchema,
  startPayoutsRequestSchema,
  updateApprovalLimitsRequestSchema,
  updateLabourerRequestSchema,
  updatePayoutSettingsRequestSchema,
  updateWaiverRequestSchema,
} from "./index.js";

const id = (n: number) => `0193a4c2-7d1e-7b2a-9c3d-${String(n).padStart(12, "0")}`;
const digest = "a".repeat(64);
const at = "2026-11-16T09:00:00+03:00";
const person = { id: id(90), displayName: "Achieng Otieno" };

describe("batch decision requests (D4.3)", () => {
  it("binds review and approval to the digests that were shown", () => {
    expect(reviewBatchRequestSchema.safeParse({ version: 3, digest }).success).toBe(true);
    expect(reviewBatchRequestSchema.safeParse({ version: 3, digest: "abc" }).success).toBe(false);
    expect(
      approveBatchRequestSchema.safeParse({ version: 3, digest, approvalDigest: digest }).success,
    ).toBe(true);
    expect(approveBatchRequestSchema.safeParse({ version: 3, digest }).success).toBe(false);
    expect(rejectBatchRequestSchema.safeParse({ version: 3, reason: "Wrong" }).success).toBe(false);
    expect(
      rejectBatchRequestSchema.safeParse({ version: 3, reason: "Overtime for 12/11 is missing" })
        .success,
    ).toBe(true);
  });
});

describe("payout requests", () => {
  it("needs a reason for cash and a reference for bank", () => {
    const base = { amountMinor: 250_000, paidOn: "2026-11-16" };
    expect(
      recordManualPaymentRequestSchema.safeParse({
        method: "cash",
        ...base,
        reason: "Worker has no M-Pesa line this week",
      }).success,
    ).toBe(true);
    expect(recordManualPaymentRequestSchema.safeParse({ method: "cash", ...base }).success).toBe(
      false,
    );
    expect(
      recordManualPaymentRequestSchema.safeParse({
        method: "bank",
        ...base,
        reference: "FT26320ABC",
      }).success,
    ).toBe(true);
    expect(recordManualPaymentRequestSchema.safeParse({ method: "bank", ...base }).success).toBe(
      false,
    );
    expect(
      recordManualPaymentRequestSchema.safeParse({
        method: "mpesa",
        ...base,
        reference: "TKG7AB12CD",
      }).success,
    ).toBe(false);
    // Obligations are whole shillings (D-167), and so is every payment towards one.
    expect(
      recordManualPaymentRequestSchema.safeParse({
        method: "bank",
        ...base,
        amountMinor: 250_050,
        reference: "FT26320ABC",
      }).success,
    ).toBe(false);
  });

  it("carries only the cents of a net forward (D-167)", () => {
    const line = {
      batchId: id(30),
      lineId: id(31),
      projectId: id(32),
      periodStart: "2026-11-09",
      periodEnd: "2026-11-15",
    };
    const carry = {
      id: id(33),
      labourer: { id: id(34), workerNo: "WRK-0034", fullName: "Peter Kamau" },
      amountMinor: 60,
      status: "open",
      source: line,
      consumedBy: null,
      createdAt: at,
      consumedAt: null,
    };
    expect(carryForwardSchema.safeParse(carry).success).toBe(true);
    expect(carryForwardSchema.safeParse({ ...carry, amountMinor: 100 }).success).toBe(false);
    expect(carryForwardSchema.safeParse({ ...carry, amountMinor: 0 }).success).toBe(false);
  });

  it("starts payouts for all eligible obligations or a subset without repeats", () => {
    expect(startPayoutsRequestSchema.safeParse({}).success).toBe(true);
    expect(startPayoutsRequestSchema.safeParse({ obligationIds: [id(1), id(2)] }).success).toBe(
      true,
    );
    expect(startPayoutsRequestSchema.safeParse({ obligationIds: [id(1), id(1)] }).success).toBe(
      false,
    );
    expect(startPayoutsRequestSchema.safeParse({ obligationIds: [] }).success).toBe(false);
  });
});

describe("payout settings, waiver and approval limits", () => {
  const settings = {
    version: 0,
    cashMaxPerWorkerPeriodMinor: 0,
    nameMatchThreshold: 0.8,
    nameMismatchHold: true,
    payeeChangeHoldHours: 24,
    unusualNewRecipientMinor: 5_000_000,
    businessHoursStart: "06:00",
    businessHoursEnd: "20:00",
    floatCheckMaxAgeMinutes: 15,
  };

  it("accepts the defaults (cash disabled with 0) and refuses inconsistent values", () => {
    expect(updatePayoutSettingsRequestSchema.safeParse(settings).success).toBe(true);
    for (const change of [
      { businessHoursStart: "20:00", businessHoursEnd: "06:00" },
      { businessHoursEnd: "24:00" },
      { nameMatchThreshold: 0.805 },
      { nameMatchThreshold: 0.4 },
      { cashMaxPerWorkerPeriodMinor: 2_000_050 },
      { floatCheckMaxAgeMinutes: 0 },
    ])
      expect(updatePayoutSettingsRequestSchema.safeParse({ ...settings, ...change }).success).toBe(
        false,
      );
    expect(
      updateWaiverRequestSchema.safeParse({
        version: 1,
        enabled: true,
        reason: "Second director on leave",
      }).success,
    ).toBe(true);
    expect(updateWaiverRequestSchema.safeParse({ version: 1, enabled: false }).success).toBe(false);
  });

  it("sets each limit for exactly one role, once", () => {
    const owner = { systemRole: "owner", customRoleId: null, maxBatchNetMinor: 300_000_000 };
    const custom = { systemRole: null, customRoleId: id(5), maxBatchNetMinor: 10_000_000 };
    expect(
      updateApprovalLimitsRequestSchema.safeParse({ version: 0, limits: [owner, custom] }).success,
    ).toBe(true);
    expect(
      updateApprovalLimitsRequestSchema.safeParse({ version: 0, limits: [owner, owner] }).success,
    ).toBe(false);
    expect(
      updateApprovalLimitsRequestSchema.safeParse({
        version: 0,
        limits: [{ ...owner, customRoleId: id(5) }],
      }).success,
    ).toBe(false);
    expect(
      updateApprovalLimitsRequestSchema.safeParse({
        version: 0,
        limits: [{ ...owner, systemRole: "platform_admin" }],
      }).success,
    ).toBe(false);
  });
});

describe("labourer payslip language", () => {
  it("defaults to Kiswahili at registration and can be changed on its own", () => {
    const parsed = registerLabourerRequestSchema.safeParse({
      fullName: "John Kamau Doe",
      gender: "male",
      tradeId: id(1),
      skillLevelId: id(2),
      engagementType: "casual",
      rateBasis: "daily",
      dateOfBirth: "1990-01-01",
      idType: "national_id",
      idNumber: "12345678",
      consent: {
        noticeVersion: "registration-2026-11-v1",
        language: "sw",
        method: "signed",
        granted: true,
      },
    });
    expect(parsed.success && parsed.data.preferredLanguage).toBe("sw");
    expect(
      updateLabourerRequestSchema.safeParse({ version: 2, preferredLanguage: "en" }).success,
    ).toBe(true);
    expect(
      updateLabourerRequestSchema.safeParse({ version: 2, preferredLanguage: "fr" }).success,
    ).toBe(false);
  });
});

describe("reconciliation and tariff requests", () => {
  it("names the cost journal exactly when a charge is corrected by one", () => {
    const base = { version: 1, reason: "Statement shows the KES 13 band for this payout" };
    expect(
      resolveReconciliationItemRequestSchema.safeParse({
        ...base,
        outcome: "charge_journal",
        journalId: id(7),
      }).success,
    ).toBe(true);
    expect(
      resolveReconciliationItemRequestSchema.safeParse({ ...base, outcome: "charge_journal" })
        .success,
    ).toBe(false);
    expect(
      resolveReconciliationItemRequestSchema.safeParse({
        ...base,
        outcome: "explained",
        journalId: id(7),
      }).success,
    ).toBe(false);
    expect(
      resolveReconciliationItemRequestSchema.safeParse({ ...base, outcome: "auto_matched" })
        .success,
    ).toBe(false);
  });

  it("lists items for one date or a bounded range", () => {
    expect(reconciliationItemsQuerySchema.safeParse({ date: "2026-11-16" }).success).toBe(true);
    expect(
      reconciliationItemsQuerySchema.safeParse({ from: "2026-09-01", to: "2026-11-30" }).success,
    ).toBe(true);
    expect(
      reconciliationItemsQuerySchema.safeParse({ date: "2026-11-16", from: "2026-11-01" }).success,
    ).toBe(false);
    expect(
      reconciliationItemsQuerySchema.safeParse({ from: "2026-11-16", to: "2026-11-01" }).success,
    ).toBe(false);
    expect(
      reconciliationItemsQuerySchema.safeParse({ from: "2026-08-01", to: "2026-11-30" }).success,
    ).toBe(false);
  });

  it("accepts the DEMO bands and refuses bands that do not ascend in whole shillings", () => {
    const base = {
      effectiveFrom: "2026-12-01",
      status: "demo",
      source: "Company tariff letter, November 2026",
    };
    const parsed = putTariffRequestSchema.safeParse({ ...base, bands: DEMO_B2C_TARIFF_BANDS });
    expect(parsed.success && parsed.data.kind).toBe("b2c");
    const refused = putTariffRequestSchema.safeParse({
      ...base,
      bands: [
        { upToMinor: 500_000, chargeMinor: 900 },
        { upToMinor: 150_000, chargeMinor: 550 },
      ],
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.message)).toEqual([
      "bands_not_ascending",
      "bands_not_whole_shillings",
    ]);
  });
});

describe("response shapes", () => {
  it("describes a batch's live payouts with a count for every worker status", () => {
    const batch = {
      id: id(10),
      projectId: id(11),
      periodStart: "2026-11-09",
      periodEnd: "2026-11-15",
      payDate: "2026-11-16",
      statutoryMonth: "2026-11",
      frequency: "weekly",
      status: "disbursing",
      version: 4,
      unverifiedRules: false,
      lineCount: 1,
      grossMinor: 440_000,
      totalDeductionsMinor: 40_000,
      netMinor: 400_000,
      employerCostMinor: 12_000,
      digest,
      calculatedAt: at,
      createdBy: person,
      createdAt: at,
      submittedBy: person,
      submittedAt: at,
      cancelledBy: null,
      cancelledAt: null,
      cancellationReason: null,
    };
    const response = {
      project: { id: id(11), code: "PR-001", name: "Kilimani Heights" },
      batch,
      approvedUnderWaiver: false,
      obligations: [],
      totals: {
        obligations: 0,
        amountMinor: 0,
        paidMinor: 0,
        outstandingMinor: 0,
        settled: 0,
        eligible: 0,
        eligibleMinor: 0,
        eligibleChargesMinor: 0,
        chargesMinor: 0,
        carryForwardMinor: 0,
        broughtForwardMinor: 0,
        byProgress: Object.fromEntries(OBLIGATION_PROGRESS_STATUSES.map((status) => [status, 0])),
      },
      carryForwards: [],
      float: {
        latest: null,
        utilityAvailableMinor: null,
        ageMinutes: null,
        maxAgeMinutes: 15,
        fresh: false,
        inFlightMinor: 0,
      },
      payoutsEnabled: true,
      businessHours: { start: "06:00", end: "20:00", open: true },
      permissions: {
        canFloatCheck: true,
        canStart: true,
        canRecordManual: false,
        canConfirmManual: false,
        canApproveDestination: false,
        canClearFlags: false,
        canResend: true,
        canViewReceiverNames: false,
      },
    };
    expect(batchPayoutsResponseSchema.safeParse(response).success).toBe(true);
    const { ready: _ready, ...missing } = response.totals.byProgress;
    expect(
      batchPayoutsResponseSchema.safeParse({
        ...response,
        totals: { ...response.totals, byProgress: missing },
      }).success,
    ).toBe(false);
  });

  it("keeps M-Pesa reconciliation items apart from piece-rate reconciliation", () => {
    const item = mpesaReconciliationItemSchema.safeParse({
      id: id(20),
      businessDate: "2026-11-16",
      kind: "unmatched_statement",
      category: "unmatched",
      severity: "critical",
      status: "open",
      awaitingStatement: false,
      subjectType: "statement_line",
      subjectId: id(21),
      payout: null,
      worker: null,
      paymentRequestId: null,
      caseId: null,
      receipt: "TKG7AB12CZ",
      statementLineId: id(21),
      relatedLineIds: [],
      chargeLineIds: [],
      amountMinor: null,
      statementAmountMinor: 7_000_000,
      bookedChargeMinor: null,
      statementChargeMinor: null,
      owner: null,
      openedAt: at,
      ageHours: 0,
      outcome: null,
      resolutionReason: null,
      journalId: null,
      resolvedBy: null,
      resolvedAt: null,
      version: 1,
    });
    expect(item.success).toBe(true);
  });
});
