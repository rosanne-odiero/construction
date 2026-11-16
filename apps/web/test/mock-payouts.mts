/**
 * D4.3 browser-test fixtures: payroll approval (review, reject, reopen, approve with its approval
 * digest), obligations and payouts with live status, cash and bank records, flags, payslip SMS,
 * payout settings, the waiver and approval limits, the payout side of worker records, and M-Pesa
 * reconciliation with statements and the charges tariff. The approval digest, eligibility, flags,
 * statement parsing and the reconciliation matcher use the shared domain rules, so the screens are
 * exercised against realistic answers. Every response is validated with the shared schemas by
 * mock-api.mts. Synthetic data only; no provider is contacted.
 */
import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  addCalendarDays,
  approvalLimitFor,
  approvalReadiness,
  approvalSeparation,
  approvalSnapshot,
  approvalSnapshotText,
  changeHoldUntil,
  checkApprovalLimit,
  checkCashCap,
  decisionActionText,
  evaluateApprovalFlags,
  flagClearConflict,
  isWithinBusinessHours,
  manualPaymentProblem,
  maskPartyInfo,
  maskPhone,
  nairobiDate,
  obligationProgress,
  parseStatementCsv,
  payoutBlockReasons,
  payoutDisplayStatus,
  planObligations,
  planReconciliationChanges,
  recipientBlockReasons,
  reconcileDay,
  settlementStatusOf,
  tariffCharge,
  tariffVersionOn,
  utilityBalanceMinor,
  verificationConflict,
  type ReconStatementLine,
} from "@pm-buddy/domain";
import {
  DEFAULT_OWNER_APPROVAL_LIMIT_MINOR,
  DEFAULT_PAYOUT_SETTINGS,
  DEMO_B2C_TARIFF,
  DEMO_PAYMENT_LIMITS,
  MANUAL_PAYMENT_LIMITS,
  OBLIGATION_PROGRESS_STATUSES,
  RECONCILIATION_ITEM_CATEGORY,
  RECONCILIATION_ITEM_KINDS,
  RECONCILIATION_OUTCOMES_BY_KIND,
  STATEMENT_LIMITS,
  type PaymentAttemptStatus,
  type PaymentRequestStatus,
  type PayrollBatchStatus,
  type PayrollPayoutStatus,
  type Permission,
  type ReconciliationItemKind,
} from "@pm-buddy/types";
import * as wire from "@pm-buddy/validation";
import { LABOUR_IDS, type LabourState } from "./mock-labour.mts";
import { PAYROLL_BATCH_ID, type PayrollState } from "./mock-payroll.mts";
import { registerPayoutRequest, updatePayoutRequest } from "./mock-payments.mts";

export const PAYOUT_BATCH_ID = "49000000-0000-4000-8000-000000000002";
export const HISTORY_BATCH_ID = "49000000-0000-4000-8000-000000000003";
/** Receipts of the earlier batch's confirmed payouts (the reconciliation tests' statement). */
export const HISTORY_RECEIPTS = { amina: "TKH7AB0001", grace: "TKH7AB0002" } as const;

type Actor = { id: string; displayName: string };
const OWNER: Actor = { id: "21000000-0000-4000-8000-000000000001", displayName: "Wanjiru Kamau" };
const PM: Actor = { id: "21000000-0000-4000-8000-000000000002", displayName: "Brian Otieno" };
const AGENT: Actor = { id: "21000000-0000-4000-8000-000000000003", displayName: "Kevin Kiprono" };
const FINANCE: Actor = { id: "21000000-0000-4000-8000-000000000005", displayName: "Daniel Mwangi" };
const PEOPLE = [OWNER, PM, AGENT, FINANCE];
const PROJECT = {
  id: "30000000-0000-4000-8000-000000000001",
  code: "PRJ-001",
  name: "Ruiru Heights Apartments",
};
const LIMITS = DEMO_PAYMENT_LIMITS;

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
/** A copy without the given keys (internal fields never leave the mock). */
const omit = <T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !(keys as PropertyKey[]).includes(key)),
  ) as Omit<T, K>;
const iso = (at: number = Date.now()) => new Date(at).toISOString();

type Line = {
  id: string;
  labourerId: string;
  days: number;
  grossMinor: number;
  statutoryMinor: number;
  recoveryMinor: number;
  broughtForwardMinor: number;
  employerCostMinor: number;
  /** The line's payee number as calculated (the approved destination). */
  payeePhone: string | null;
};
const netOf = (line: Line) =>
  line.grossMinor - line.statutoryMinor - line.recoveryMinor + line.broughtForwardMinor;

type Batch = {
  batch: wire.PayrollBatch;
  lines: Line[];
  contributors: Actor[];
  reviewer: Actor | null;
  approver: Actor | null;
  underWaiver: boolean;
  approvalDigest: string | null;
};
type Verification = {
  id: string;
  labourerId: string;
  phone: string;
  note: string | null;
  by: Actor;
  at: string;
};
type Hold = Omit<wire.PayoutHold, "phoneMasked"> & { phone: string | null };
type Override = { labourerId: string; changedAt: string; by: Actor; at: string; reason: string };
type Obligation = {
  id: string;
  batchId: string;
  lineId: string;
  labourerId: string;
  amountMinor: number;
  lineNetMinor: number;
  broughtForwardMinor: number;
  carryForwardMinor: number;
  channel: "mpesa" | "manual";
  manualReason: wire.Obligation["manualReason"];
  destination: string | null;
  verificationId: string | null;
  approvedBy: Actor | null;
  approvedAt: string | null;
  version: number;
  createdAt: string;
};
type Scenario = "confirm" | "fail" | "uncertain" | "mismatch";
type Payout = {
  id: string;
  obligationId: string;
  method: "mpesa" | "cash" | "bank";
  amountMinor: number;
  status: PayrollPayoutStatus;
  attempt: PaymentAttemptStatus | null;
  requestStatus: PaymentRequestStatus | null;
  version: number;
  paymentRequestId: string | null;
  receipt: string | null;
  failure: { code: string | null; description: string | null } | null;
  chargeMinor: number | null;
  nameCheck: { result: "match" | "mismatch" | "unavailable"; score: number | null; name: string | null } | null;
  reference: string | null;
  paidOn: string | null;
  reason: string | null;
  evidence: wire.PaymentEvidence[];
  createdBy: Actor | null;
  confirmedBy: Actor | null;
  confirmedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** Polls seen since it was created (queued → pending → outcome). */
  stage: number;
  scenario: Scenario;
  /** Seeded history keeps a fixed business date; live payouts use their confirmation date. */
  businessDate: string | null;
  caseId: string | null;
};
type Carry = {
  id: string;
  labourerId: string;
  amountMinor: number;
  status: "open" | "consumed";
  sourceBatchId: string;
  sourceLineId: string;
  consumedBatchId: string | null;
  consumedLineId: string | null;
  createdAt: string;
  consumedAt: string | null;
};
type Notice = {
  id: string;
  obligationId: string;
  phone: string;
  language: "en" | "sw";
  status: "queued" | "sent" | "failed";
  attempts: number;
  lastErrorCode: wire.PayrollNotification["lastErrorCode"];
  sentAt: string | null;
  createdAt: string;
  failFirst: boolean;
  /** Polls to wait before the next send (a resend shows as queued for one poll). */
  wait: number;
};
type Item = Omit<wire.MpesaReconciliationItem, "category" | "payout" | "worker" | "ageHours"> & {
  payoutId: string | null;
  evidenceKey: string;
};
type Statement = {
  summary: wire.StatementSummary;
  lines: wire.StatementLineWire[];
  issues: wire.StatementIssueWire[];
};
type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };

function line(
  id: string,
  labourerId: string,
  grossMinor: number,
  statutoryMinor: number,
  recoveryMinor: number,
  payeePhone: string | null,
  broughtForwardMinor = 0,
): Line {
  return {
    id,
    labourerId,
    days: 6,
    grossMinor,
    statutoryMinor,
    recoveryMinor,
    broughtForwardMinor,
    employerCostMinor: Math.round(grossMinor * 0.075),
    payeePhone,
  };
}

function batchRecord(
  id: string,
  periodStart: string,
  status: PayrollBatchStatus,
  lines: Line[],
  createdAt: string,
): wire.PayrollBatch {
  const gross = lines.reduce((sum, entry) => sum + entry.grossMinor, 0);
  const net = lines.reduce((sum, entry) => sum + netOf(entry), 0);
  const deductions = lines.reduce(
    (sum, entry) => sum + entry.statutoryMinor + entry.recoveryMinor,
    0,
  );
  return {
    id,
    projectId: PROJECT.id,
    periodStart,
    periodEnd: addCalendarDays(periodStart, 6),
    payDate: addCalendarDays(periodStart, 7),
    statutoryMonth: periodStart.slice(0, 7),
    frequency: "weekly",
    status,
    version: 2,
    unverifiedRules: false,
    lineCount: lines.length,
    grossMinor: gross,
    totalDeductionsMinor: deductions,
    netMinor: net,
    employerCostMinor: lines.reduce((sum, entry) => sum + entry.employerCostMinor, 0),
    digest: sha256(`${id}:${net}:v1`),
    calculatedAt: createdAt,
    createdBy: PM,
    createdAt,
    submittedBy: PM,
    submittedAt: createdAt,
    cancelledBy: null,
    cancelledAt: null,
    cancellationReason: null,
  };
}

export function payoutsFixture() {
  const now = Date.now();
  const today = nairobiDate();
  const phones = {
    amina: "254700000101",
    joseph: "254700000102",
    grace: "254700000103",
    mercy: "254700000105",
  };
  const verified = (labourerId: string, phone: string): Verification => ({
    id: randomUUID(),
    labourerId,
    phone,
    note: "Original national ID checked at the site office",
    by: PM,
    at: "2026-11-02T07:30:00.000Z",
  });
  const current: Line[] = [
    line(
      "49100000-0000-4000-8000-000000000011",
      LABOUR_IDS.amina,
      600_000,
      74_975,
      20_000,
      phones.amina,
      25,
    ),
    line(
      "49100000-0000-4000-8000-000000000012",
      LABOUR_IDS.joseph,
      6_000_000,
      780_000,
      20_000,
      phones.joseph,
    ),
    line("49100000-0000-4000-8000-000000000013", LABOUR_IDS.grace, 450_000, 50_925, 19_000, phones.grace),
    line("49100000-0000-4000-8000-000000000014", LABOUR_IDS.peter, 300_000, 50_000, 0, null),
    line("49100000-0000-4000-8000-000000000015", LABOUR_IDS.mercy, 180_000, 30_000, 0, phones.mercy),
    line("49100000-0000-4000-8000-000000000016", LABOUR_IDS.oscar, 10_000, 9_960, 0, null),
  ];
  const history: Line[] = [
    line("49100000-0000-4000-8000-000000000021", LABOUR_IDS.amina, 500_025, 60_000, 20_000, phones.amina),
    line("49100000-0000-4000-8000-000000000022", LABOUR_IDS.grace, 420_000, 70_000, 0, phones.grace),
    line("49100000-0000-4000-8000-000000000023", LABOUR_IDS.mercy, 150_000, 30_000, 0, phones.mercy),
    line("49100000-0000-4000-8000-000000000024", LABOUR_IDS.peter, 240_000, 40_000, 0, null),
  ];
  const historyCreated = "2026-10-30T05:00:00.000Z";
  const batches: Batch[] = [
    {
      batch: batchRecord(PAYOUT_BATCH_ID, "2026-10-30", "submitted", current, "2026-11-06T05:00:00.000Z"),
      lines: current,
      contributors: [PM],
      reviewer: null,
      approver: null,
      underWaiver: false,
      approvalDigest: null,
    },
    {
      batch: {
        ...batchRecord(HISTORY_BATCH_ID, "2026-10-23", "partially_settled", history, historyCreated),
        version: 4,
      },
      lines: history,
      contributors: [PM],
      reviewer: FINANCE,
      approver: OWNER,
      underWaiver: false,
      approvalDigest: sha256("history-approval"),
    },
  ];
  const decisions: (wire.BatchDecision & { batchId: string })[] = [];
  const decide = (
    batch: wire.PayrollBatch,
    action: wire.BatchDecision["action"],
    actor: Actor,
    createdAt: string,
    extra: Partial<wire.BatchDecision> = {},
  ) =>
    decisions.push({
      id: randomUUID(),
      batchId: batch.id,
      action,
      actor,
      batchVersion: batch.version,
      digest: batch.digest,
      approvalDigest: null,
      netMinor: batch.netMinor,
      appliedLimitMinor: null,
      underWaiver: false,
      stepUpAt: null,
      actionHash: sha256(`${batch.id}|${action}|${createdAt}`),
      note: null,
      obligationId: null,
      createdAt,
      ...extra,
    });
  decide(batches[0]!.batch, "submit", PM, "2026-11-06T05:00:00.000Z");
  const old = batches[1]!.batch;
  decide(old, "submit", PM, "2026-10-30T05:00:00.000Z");
  decide(old, "review", FINANCE, "2026-10-30T06:00:00.000Z");
  decide(old, "approve", OWNER, "2026-10-30T07:00:00.000Z", {
    approvalDigest: batches[1]!.approvalDigest,
    appliedLimitMinor: DEFAULT_OWNER_APPROVAL_LIMIT_MINOR,
    stepUpAt: "2026-10-30T06:59:00.000Z",
  });
  const obligation = (
    batchId: string,
    entry: Line,
    amountMinor: number,
    carry: number,
  ): Obligation => ({
    id: randomUUID(),
    batchId,
    lineId: entry.id,
    labourerId: entry.labourerId,
    amountMinor,
    lineNetMinor: netOf(entry),
    broughtForwardMinor: entry.broughtForwardMinor,
    carryForwardMinor: carry,
    channel: entry.payeePhone ? "mpesa" : "manual",
    manualReason: entry.payeePhone ? null : "no_number",
    destination: entry.payeePhone,
    verificationId: null,
    approvedBy: OWNER,
    approvedAt: "2026-10-30T07:00:00.000Z",
    version: 1,
    createdAt: "2026-10-30T07:00:00.000Z",
  });
  const verifications = [
    verified(LABOUR_IDS.amina, phones.amina),
    verified(LABOUR_IDS.grace, phones.grace),
    verified(LABOUR_IDS.mercy, phones.mercy),
  ];
  const obligations = [
    obligation(HISTORY_BATCH_ID, history[0]!, 420_000, 25),
    obligation(HISTORY_BATCH_ID, history[1]!, 350_000, 0),
    obligation(HISTORY_BATCH_ID, history[2]!, 120_000, 0),
    obligation(HISTORY_BATCH_ID, history[3]!, 200_000, 0),
  ];
  for (const entry of obligations)
    entry.verificationId =
      verifications.find((verification) => verification.labourerId === entry.labourerId)?.id ??
      null;
  const historyPayout = (
    entry: Obligation,
    fields: Partial<Payout> & Pick<Payout, "method" | "status">,
  ): Payout => ({
    id: randomUUID(),
    obligationId: entry.id,
    amountMinor: entry.amountMinor,
    attempt: null,
    requestStatus: null,
    version: 1,
    paymentRequestId: null,
    receipt: null,
    failure: null,
    chargeMinor: null,
    nameCheck: null,
    reference: null,
    paidOn: null,
    reason: null,
    evidence: [],
    createdBy: FINANCE,
    confirmedBy: null,
    confirmedAt: null,
    rejectionReason: null,
    createdAt: iso(now - 40 * 60_000),
    finishedAt: null,
    stage: 9,
    scenario: "confirm",
    businessDate: today,
    caseId: null,
    ...fields,
  });
  const payouts: Payout[] = [
    historyPayout(obligations[0]!, {
      method: "mpesa",
      status: "confirmed",
      attempt: "confirmed",
      requestStatus: "confirmed",
      paymentRequestId: randomUUID(),
      receipt: HISTORY_RECEIPTS.amina,
      chargeMinor: 900,
      nameCheck: { result: "match", score: 1, name: null },
      finishedAt: iso(now - 35 * 60_000),
    }),
    historyPayout(obligations[1]!, {
      method: "mpesa",
      status: "confirmed",
      attempt: "confirmed",
      requestStatus: "confirmed",
      paymentRequestId: randomUUID(),
      receipt: HISTORY_RECEIPTS.grace,
      chargeMinor: 900,
      nameCheck: { result: "match", score: 0.93, name: null },
      finishedAt: iso(now - 35 * 60_000),
    }),
    historyPayout(obligations[2]!, {
      method: "mpesa",
      status: "active",
      attempt: "unknown",
      requestStatus: "uncertain",
      paymentRequestId: randomUUID(),
      createdAt: iso(now - 2 * 60 * 60_000),
      scenario: "uncertain",
    }),
    historyPayout(obligations[3]!, {
      method: "cash",
      status: "confirmed",
      paidOn: "2026-10-30",
      reason: "Worker has no M-Pesa number; paid in cash at the site office",
      confirmedBy: OWNER,
      confirmedAt: "2026-10-30T12:00:00.000Z",
      createdAt: "2026-10-30T10:00:00.000Z",
      finishedAt: "2026-10-30T12:00:00.000Z",
      evidence: [
        {
          id: randomUUID(),
          contentType: "image/jpeg",
          sizeBytes: 48_213,
          scanStatus: "clean",
          uploadedAt: "2026-10-30T10:05:00.000Z",
          uploadedBy: FINANCE,
        },
      ],
      businessDate: null,
    }),
  ];
  const carries: Carry[] = [
    {
      id: randomUUID(),
      labourerId: LABOUR_IDS.amina,
      amountMinor: 25,
      status: "consumed",
      sourceBatchId: HISTORY_BATCH_ID,
      sourceLineId: history[0]!.id,
      consumedBatchId: PAYOUT_BATCH_ID,
      consumedLineId: current[0]!.id,
      createdAt: "2026-10-30T07:00:00.000Z",
      consumedAt: "2026-11-06T05:00:00.000Z",
    },
  ];
  const notices: Notice[] = [obligations[0]!, obligations[1]!].map((entry, index) => ({
    id: randomUUID(),
    obligationId: entry.id,
    phone: index === 0 ? phones.amina : phones.grace,
    language: "sw",
    status: "sent",
    attempts: 1,
    lastErrorCode: null,
    sentAt: iso(now - 30 * 60_000),
    createdAt: iso(now - 35 * 60_000),
    failFirst: false,
    wait: 0,
  }));
  const settings: wire.PayoutSettings = {
    ...omit(DEFAULT_PAYOUT_SETTINGS, "waiverEnabled", "waiverReason", "waiverLimitMinor"),
    // Tests must not depend on the time of day they run at.
    businessHoursStart: "00:00",
    businessHoursEnd: "23:59",
    waiver: {
      enabled: false,
      reason: null,
      limitMinor: DEFAULT_PAYOUT_SETTINGS.waiverLimitMinor,
      changedBy: null,
      changedAt: null,
    },
    version: 0,
    updatedBy: null,
    updatedAt: null,
  };
  const tariffs: wire.TariffVersion[] = [
    {
      id: randomUUID(),
      kind: "b2c",
      effectiveFrom: DEMO_B2C_TARIFF.effectiveFrom,
      effectiveTo: null,
      inForce: true,
      status: "demo",
      bands: [...DEMO_B2C_TARIFF.bands],
      source: DEMO_B2C_TARIFF.source,
      createdBy: null,
      createdAt: "2026-11-01T00:00:00.000Z",
    },
  ];
  return {
    batches,
    decisions,
    verifications,
    holds: [] as Hold[],
    overrides: [] as Override[],
    obligations,
    payouts,
    flags: [] as wire.PayoutFlag[],
    carries,
    notices,
    settings,
    limits: { rows: [] as wire.ApprovalLimitEntry[], version: 0 },
    checks: [
      {
        id: randomUUID(),
        status: "answered" as const,
        requestedAt: iso(now - 60 * 60_000),
        answeredAt: iso(now - 60 * 60_000),
        balances: [
          { account: "Utility Account", currency: "KES", availableMinor: 9_000_000 },
          { account: "Working Account", currency: "KES", availableMinor: 120_000 },
        ],
      },
    ] as wire.FloatCheckResponse["check"][],
    utilityMinor: 10_000_000,
    payoutsEnabled: true,
    tariffs,
    items: [] as Item[],
    events: new Map<string, wire.ReconciliationItemEvent[]>(),
    runs: [] as wire.ReconciliationRun[],
    statements: [] as Statement[],
    replies: new Map<string, Reply>(),
    /** History requests are registered with the payments console on first use. */
    registered: false,
    reconciledToday: false,
  };
}
export type PayoutsState = ReturnType<typeof payoutsFixture>;

export type PayoutDeps = {
  user: Actor;
  /** The member's system role (owner, finance, project_manager, …). */
  role: string;
  permissions: readonly Permission[];
  tenantWide: boolean;
  stepUpFresh: () => boolean;
  key: string | undefined;
  contentType: string | undefined;
  raw: Buffer;
  fail: (status: number, code: string, facts?: Record<string, unknown>) => never;
  parse: <T>(schema: z.ZodType<T>, body: unknown) => T;
  labour: LabourState;
  payroll: PayrollState;
  /** The payments console fixture key (mock-payments.mts). */
  paymentsKey: object;
};

const ROUTES = [
  /^\/payroll\/batches\/[^/]+\/(approval|review|reject|reopen|approve|payouts|float-check)$/,
  /^\/payroll\/(obligations|manual-payments|flags|notifications)\/[^/]+\/[a-z-]+$/,
  /^\/payroll\/(payout-settings(\/waiver)?|approval-limits)$/,
  /^\/labour\/labourers\/[^/]+\/(payout-status|payout-verifications|payout-holds|change-hold-override)$/,
  /^\/labour\/payout-holds\/[^/]+\/release$/,
  /^\/payments\/(reconciliation(\/.*)?|statements(\/[^/]+)?|tariffs)$/,
];

export function handlePayouts(
  d: PayoutDeps,
  s: PayoutsState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): Reply | null {
  const own = /^\/payroll\/batches\/([^/]+)(\/.*)?$/.exec(path);
  const ownBatch =
    own && own[1] !== PAYROLL_BATCH_ID && s.batches.some((entry) => entry.batch.id === own[1]);
  if (!ownBatch && !ROUTES.some((route) => route.test(path))) return null;
  ensureHistory(d, s);
  const has = (...permissions: Permission[]) =>
    permissions.some((permission) => d.permissions.includes(permission));
  const need = (...permissions: Permission[]) => {
    if (!has(...permissions)) d.fail(403, "forbidden");
  };
  const stepUp = () => {
    if (!d.stepUpFresh()) d.fail(403, "step-up-required");
  };
  if (method !== "GET" && d.key) {
    const replay = s.replies.get(`${d.user.id}:${d.key}`);
    if (replay) return replay;
  }
  const done = (reply: Reply): Reply => {
    if (method !== "GET" && d.key) s.replies.set(`${d.user.id}:${d.key}`, reply);
    return reply;
  };
  const labourer = (id: string) => {
    const row = d.labour.labourers.find((entry) => entry.id === id);
    if (!row) d.fail(404, "not-found");
    return row!;
  };
  const now = new Date();
  const today = nairobiDate(now);

  // Views -----------------------------------------------------------------------------------------
  const ref = (labourerId: string) => {
    const row = labourer(labourerId);
    return { id: row.id, workerNo: row.workerNo, fullName: row.fullName };
  };
  const currentVerification = (labourerId: string) => {
    const phone = labourer(labourerId).phone;
    return (
      [...s.verifications]
        .reverse()
        .find((entry) => entry.labourerId === labourerId && entry.phone === phone) ?? null
    );
  };
  const verificationView = (entry: Verification): wire.RecipientVerification => ({
    id: entry.id,
    method: "in_person_id_check",
    note: entry.note,
    phoneMasked: maskPhone(entry.phone),
    current: labourer(entry.labourerId).phone === entry.phone,
    verifiedBy: entry.by,
    verifiedAt: entry.at,
  });
  const holdView = (hold: Hold): wire.PayoutHold => {
    const { phone, ...rest } = hold;
    return { ...rest, phoneMasked: phone ? maskPhone(phone) : null };
  };
  const activeHolds = (labourerId: string) =>
    s.holds.filter((hold) => hold.labourerId === labourerId && hold.state === "active");
  const override = (labourerId: string) => {
    const row = labourer(labourerId);
    return (
      s.overrides.find(
        (entry) => entry.labourerId === labourerId && entry.changedAt === row.phoneChangedAt,
      ) ?? null
    );
  };
  const holdHours = s.settings.payeeChangeHoldHours;
  const recipientBlocks = (labourerId: string) => {
    const row = labourer(labourerId);
    return recipientBlockReasons({
      currentPhoneBidx: row.phone,
      currentNumberVerified: currentVerification(labourerId) !== null,
      activeHolds: activeHolds(labourerId).length,
      phoneChangedAt: row.phoneChangedAt ?? null,
      changeHoldOverridden: override(labourerId) !== null,
      payeeChangeHoldHours: holdHours,
      now,
    });
  };
  const batchOf = (id: string) => {
    const entry = s.batches.find((candidate) => candidate.batch.id === id);
    if (!entry) d.fail(404, "not-found");
    return entry!;
  };
  const paidOf = (obligationId: string) =>
    s.payouts
      .filter((payout) => payout.obligationId === obligationId && payout.status === "confirmed")
      .reduce((sum, payout) => sum + payout.amountMinor, 0);
  const recompute = (entry: Batch) => {
    const mine = s.obligations.filter((candidate) => candidate.batchId === entry.batch.id);
    if (!["approved", "disbursing", "partially_settled", "settled"].includes(entry.batch.status))
      return;
    entry.batch.status = settlementStatusOf({
      obligations: mine.map((candidate) => ({
        amountMinor: candidate.amountMinor,
        paidMinor: paidOf(candidate.id),
      })),
      payoutCount: s.payouts.filter((payout) => mine.some((candidate) => candidate.id === payout.obligationId)).length,
    });
  };
  const openFlags = (obligationId: string) =>
    s.flags.filter((flag) => flag.obligationId === obligationId && flag.status === "open");
  const blockReasons = (entry: Obligation) => {
    const row = labourer(entry.labourerId);
    const mine = s.payouts.filter((payout) => payout.obligationId === entry.id);
    return payoutBlockReasons({
      status: paidOf(entry.id) >= entry.amountMinor ? "settled" : "open",
      channel: entry.channel,
      outstandingMinor: entry.amountMinor - paidOf(entry.id),
      livePayout: mine.some(
        (payout) => payout.status === "active" || payout.status === "pending_confirmation",
      ),
      uncertainPayout: mine.some(
        (payout) =>
          payout.requestStatus === "uncertain" || payout.requestStatus === "reversal_pending",
      ),
      destinationBidx: entry.destination,
      currentPhoneBidx: row.phone,
      currentNumberVerified: currentVerification(entry.labourerId) !== null,
      activeHolds: activeHolds(entry.labourerId).length,
      phoneChangedAt: row.phoneChangedAt ?? null,
      changeHoldOverridden: override(entry.labourerId) !== null,
      openFlags: openFlags(entry.id).length,
      limits: LIMITS,
      payeeChangeHoldHours: holdHours,
      now,
    });
  };
  const canSeeNames = has("payments.approve", "payments.review");
  const payoutView = (payout: Payout): wire.PayrollPayout => ({
    id: payout.id,
    obligationId: payout.obligationId,
    method: payout.method,
    amountMinor: payout.amountMinor,
    status: payout.status,
    displayStatus: payoutDisplayStatus(payout, payout.attempt),
    version: payout.version,
    paymentRequestId: payout.paymentRequestId,
    requestStatus: payout.requestStatus,
    receipt: payout.receipt,
    failure: payout.failure,
    chargeMinor: payout.chargeMinor,
    nameCheck: payout.nameCheck
      ? {
          result: payout.nameCheck.result,
          score: payout.nameCheck.score,
          receiverName:
            payout.nameCheck.result === "mismatch" && canSeeNames ? payout.nameCheck.name : null,
        }
      : null,
    reference: payout.reference,
    paidOn: payout.paidOn,
    reason: payout.reason,
    evidence: payout.evidence,
    createdBy: payout.createdBy,
    confirmedBy: payout.confirmedBy,
    confirmedAt: payout.confirmedAt,
    rejectionReason: payout.rejectionReason,
    createdAt: payout.createdAt,
    finishedAt: payout.finishedAt,
  });
  const noticeView = (notice: Notice): wire.PayrollNotification => ({
    id: notice.id,
    kind: "payslip",
    channel: "sms",
    recipientMasked: maskPhone(notice.phone),
    language: notice.language,
    status: notice.status,
    attempts: notice.attempts,
    nextAttemptAt: notice.status === "queued" ? iso(Date.now() + 60_000) : null,
    lastErrorCode: notice.lastErrorCode,
    sentAt: notice.sentAt,
    createdAt: notice.createdAt,
  });
  const obligationView = (entry: Obligation): wire.Obligation => {
    const paid = paidOf(entry.id);
    const reasons = blockReasons(entry);
    const mine = s.payouts
      .filter((payout) => payout.obligationId === entry.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const latest = mine.at(-1);
    const notice = s.notices.find((candidate) => candidate.obligationId === entry.id) ?? null;
    const row = labourer(entry.labourerId);
    const settled = paid >= entry.amountMinor;
    return {
      id: entry.id,
      batchId: entry.batchId,
      projectId: PROJECT.id,
      lineId: entry.lineId,
      labourer: ref(entry.labourerId),
      amountMinor: entry.amountMinor,
      paidMinor: paid,
      outstandingMinor: entry.amountMinor - paid,
      lineNetMinor: entry.lineNetMinor,
      broughtForwardMinor: entry.broughtForwardMinor,
      carryForwardMinor: entry.carryForwardMinor,
      status: settled ? "settled" : "open",
      channel: entry.channel,
      manualReason: entry.manualReason,
      destinationMasked: entry.destination ? maskPhone(entry.destination) : null,
      currentPhoneMasked: row.phone ? maskPhone(row.phone) : null,
      verificationId: entry.verificationId,
      destinationApprovedBy: entry.approvedBy,
      destinationApprovedAt: entry.approvedAt,
      progress: obligationProgress({
        status: settled ? "settled" : "open",
        paidMinor: paid,
        blockReasons: reasons,
        latestPayout: latest ? payoutDisplayStatus(latest, latest.attempt) : null,
      }),
      blockReasons: reasons,
      changeHoldUntil: changeHoldUntil(row.phoneChangedAt ?? null, holdHours),
      flags: s.flags.filter((flag) => flag.obligationId === entry.id),
      payouts: mine.map(payoutView),
      payslip: {
        state: notice ? notice.status : !row.phone ? "no_number" : "not_due",
        notification: notice ? noticeView(notice) : null,
      },
      version: entry.version,
      createdAt: entry.createdAt,
    };
  };
  const carryView = (carry: Carry): wire.CarryForward => {
    const source = batchOf(carry.sourceBatchId);
    const consumer = carry.consumedBatchId ? batchOf(carry.consumedBatchId) : null;
    const lineRef = (entry: Batch, lineId: string) => ({
      batchId: entry.batch.id,
      lineId,
      projectId: PROJECT.id,
      periodStart: entry.batch.periodStart,
      periodEnd: entry.batch.periodEnd,
    });
    return {
      id: carry.id,
      labourer: ref(carry.labourerId),
      amountMinor: carry.amountMinor,
      status: carry.status,
      source: lineRef(source, carry.sourceLineId),
      consumedBy: consumer && carry.consumedLineId ? lineRef(consumer, carry.consumedLineId) : null,
      createdAt: carry.createdAt,
      consumedAt: carry.consumedAt,
    };
  };

  // Provider simulation: each payouts poll moves payouts queued → pending → their outcome. -----
  const tick = () => {
    for (const notice of s.notices.filter((candidate) => candidate.status === "queued")) {
      if (notice.wait > 0) {
        notice.wait -= 1;
        continue;
      }
      notice.attempts += 1;
      if (notice.failFirst) {
        notice.status = "failed";
        notice.attempts = 6;
        notice.lastErrorCode = "provider_unavailable";
        notice.failFirst = false;
      } else {
        notice.status = "sent";
        notice.sentAt = iso();
        notice.lastErrorCode = null;
      }
    }
    for (const answer of s.checks.filter((check) => check.status === "sent")) {
      answer.status = "answered";
      answer.answeredAt = iso();
      answer.balances = [
        { account: "Utility Account", currency: "KES", availableMinor: s.utilityMinor },
        { account: "Working Account", currency: "KES", availableMinor: 120_000 },
      ];
    }
    for (const payout of s.payouts.filter(
      (candidate) => candidate.method === "mpesa" && candidate.status === "active",
    )) {
      if (payout.attempt === "unknown") continue;
      payout.stage += 1;
      if (payout.stage === 1) {
        payout.attempt = "pending";
        if (payout.paymentRequestId)
          updatePayoutRequest(d.paymentsKey, payout.paymentRequestId, {
            request: "in_progress",
            attempt: "pending",
          });
        continue;
      }
      settle(payout);
    }
  };
  const settle = (payout: Payout) => {
    const entry = s.obligations.find((candidate) => candidate.id === payout.obligationId)!;
    const row = labourer(entry.labourerId);
    payout.finishedAt = iso();
    payout.version += 1;
    if (payout.scenario === "fail") {
      payout.status = "failed";
      payout.attempt = "failed";
      payout.requestStatus = "failed";
      payout.failure = {
        code: "2040",
        description: "Credit party customer type cannot be supported by the service.",
      };
      if (payout.paymentRequestId)
        updatePayoutRequest(d.paymentsKey, payout.paymentRequestId, {
          request: "failed",
          attempt: "failed",
          resultCode: "2040",
          resultDesc: payout.failure.description,
        });
      recompute(batchOf(entry.batchId));
      return;
    }
    if (payout.scenario === "uncertain") {
      payout.attempt = "unknown";
      payout.requestStatus = "uncertain";
      payout.finishedAt = null;
      if (payout.paymentRequestId)
        payout.caseId = updatePayoutRequest(d.paymentsKey, payout.paymentRequestId, {
          request: "uncertain",
          attempt: "unknown",
        });
      return;
    }
    payout.status = "confirmed";
    payout.attempt = "confirmed";
    payout.requestStatus = "confirmed";
    payout.receipt = `TK${payout.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    payout.chargeMinor = tariffCharge(DEMO_B2C_TARIFF.bands, payout.amountMinor) ?? 0;
    payout.confirmedAt = payout.finishedAt;
    if (payout.paymentRequestId)
      updatePayoutRequest(d.paymentsKey, payout.paymentRequestId, {
        request: "confirmed",
        attempt: "confirmed",
        receipt: payout.receipt,
        resultCode: "0",
        resultDesc: "The service request is processed successfully.",
      });
    if (payout.scenario === "mismatch") {
      payout.nameCheck = { result: "mismatch", score: 0.18, name: "PETER OMONDI" };
      if (s.settings.nameMismatchHold)
        s.holds.push({
          id: randomUUID(),
          labourerId: entry.labourerId,
          kind: "name_mismatch",
          state: "active",
          phone: row.phone,
          reason: "The M-Pesa receiver name did not match the worker's name.",
          payoutId: payout.id,
          createdBy: null,
          createdAt: iso(),
          releasedBy: null,
          releasedAt: null,
          releaseReason: null,
        });
    } else payout.nameCheck = { result: "match", score: 1, name: null };
    afterAllocation(entry);
  };
  const afterAllocation = (entry: Obligation) => {
    const row = labourer(entry.labourerId);
    if (
      paidOf(entry.id) >= entry.amountMinor &&
      row.phone &&
      !s.notices.some((notice) => notice.obligationId === entry.id)
    )
      s.notices.push({
        id: randomUUID(),
        obligationId: entry.id,
        phone: row.phone,
        language: row.preferredLanguage ?? "sw",
        status: "queued",
        attempts: 0,
        lastErrorCode: null,
        sentAt: null,
        createdAt: iso(),
        failFirst: entry.labourerId === LABOUR_IDS.amina,
        wait: 0,
      });
    recompute(batchOf(entry.batchId));
  };

  // Approval readiness ----------------------------------------------------------------------------
  const plan = (entry: Batch) =>
    planObligations(
      entry.lines.map((candidate) => ({
        lineId: candidate.id,
        labourerId: candidate.labourerId,
        netMinor: netOf(candidate),
        payeePhoneBidx: candidate.payeePhone,
      })),
      new Map(
        entry.lines.map((candidate) => [
          candidate.labourerId,
          {
            currentPhoneBidx: labourer(candidate.labourerId).phone,
            verificationId: currentVerification(candidate.labourerId)?.id ?? null,
          },
        ]),
      ),
      LIMITS,
    );
  const digestOf = (entry: Batch) => {
    const planned = plan(entry);
    return sha256(
      approvalSnapshotText(
        approvalSnapshot({
          batchId: entry.batch.id,
          version: entry.batch.version,
          digest: entry.batch.digest,
          obligations: planned.obligations,
          carryForwards: planned.carryForwards,
        }),
      ),
    );
  };
  const flagsFor = (planned: ReturnType<typeof plan>) => {
    const paid = new Set(
      s.payouts
        .filter((payout) => payout.status === "confirmed" && payout.method === "mpesa")
        .map((payout) => s.obligations.find((candidate) => candidate.id === payout.obligationId)?.destination)
        .filter((value): value is string => Boolean(value)),
    );
    const byPhone = new Map<string, string[]>();
    for (const row of d.labour.labourers)
      if (row.phone && row.status === "active")
        byPhone.set(row.phone, [...(byPhone.get(row.phone) ?? []), row.id]);
    return evaluateApprovalFlags({
      candidates: planned.obligations
        .filter((candidate) => candidate.channel === "mpesa")
        .map((candidate) => ({
          key: candidate.lineId,
          labourerId: candidate.labourerId,
          amountMinor: candidate.amountMinor,
          destinationBidx: candidate.destinationBidx,
        })),
      paidDestinations: paid,
      activeLabourersByBidx: byPhone,
      unusualNewRecipientMinor: s.settings.unusualNewRecipientMinor,
    });
  };
  const approverRole = { role: d.role, customRoleId: null };
  const readiness = (entry: Batch): wire.BatchApprovalResponse => {
    const planned = plan(entry);
    const flags = flagsFor(planned);
    const pending = entry.batch.status === "submitted" || entry.batch.status === "reviewed";
    const limit = approvalLimitFor(approverRole, s.limits.rows);
    const ready = approvalReadiness({
      status: entry.batch.status,
      actorId: d.user.id,
      contributors: entry.contributors.map((person) => person.id),
      reviewerId: entry.reviewer?.id ?? null,
      waiverEnabled: s.settings.waiver.enabled,
      waiverLimitMinor: s.settings.waiver.limitMinor,
      netMinor: entry.batch.netMinor,
      limit,
      unverifiedLabourerIds: planned.unverifiedLabourerIds,
    });
    const lineOf = (lineId: string) => entry.lines.find((candidate) => candidate.id === lineId)!;
    const recipients = planned.obligations.map((planEntry) => {
      const source = lineOf(planEntry.lineId);
      const row = labourer(planEntry.labourerId);
      const verification = currentVerification(planEntry.labourerId);
      return {
        lineId: planEntry.lineId,
        labourer: ref(planEntry.labourerId),
        lineNetMinor: netOf(source),
        broughtForwardMinor: source.broughtForwardMinor,
        amountMinor: planEntry.amountMinor,
        carryForwardMinor: planEntry.carryForwardMinor,
        channel: planEntry.channel,
        manualReason: planEntry.manualReason,
        phoneMasked: source.payeePhone ? maskPhone(source.payeePhone) : null,
        numberChanged: source.payeePhone !== null && row.phone !== source.payeePhone,
        verificationState: !row.phone
          ? ("no_number" as const)
          : verification
            ? ("verified" as const)
            : ("unverified" as const),
        verification: verification ? verificationView(verification) : null,
        activeHolds: activeHolds(planEntry.labourerId).map(holdView),
        changeHoldUntil: changeHoldUntil(row.phoneChangedAt ?? null, holdHours),
        flags: flags
          .filter((flag) => flag.key === planEntry.lineId)
          .map((flag) => ({ code: flag.code, details: flag.details })),
      };
    });
    const sum = (filter: (value: (typeof recipients)[number]) => boolean) =>
      recipients.filter(filter).reduce((total, value) => total + value.amountMinor, 0);
    const reviewerSeparation = approvalSeparation({
      actorId: d.user.id,
      contributors: entry.contributors.map((person) => person.id),
      reviewerId: entry.reviewer?.id ?? null,
      waiverEnabled: s.settings.waiver.enabled,
    });
    return {
      project: PROJECT,
      batch: entry.batch,
      approvalDigest: pending ? digestOf(entry) : entry.approvalDigest,
      recipients,
      carryForwardOnly: planned.carryForwards
        .filter((carry) => !planned.obligations.some((value) => value.lineId === carry.lineId))
        .map((carry) => ({
          lineId: carry.lineId,
          labourer: ref(carry.labourerId),
          carryForwardMinor: carry.amountMinor,
        })),
      zeroNetLines: entry.lines.filter((candidate) => netOf(candidate) === 0).length,
      totals: {
        obligations: recipients.length,
        netMinor: entry.batch.netMinor,
        mpesaMinor: sum((value) => value.channel === "mpesa"),
        manualMinor: sum((value) => value.channel === "manual"),
        carryForwardMinor: planned.carryForwards.reduce((total, value) => total + value.amountMinor, 0),
        broughtForwardMinor: entry.lines.reduce((total, value) => total + value.broughtForwardMinor, 0),
        unverified: planned.unverifiedLabourerIds.length,
        flagged: flags.length,
      },
      limit: {
        source: limit.source,
        maxBatchNetMinor: limit.maxBatchNetMinor,
        appliedLimitMinor: ready.appliedLimitMinor,
      },
      waiver: {
        ...s.settings.waiver,
        appliesToCaller: reviewerSeparation.ok && reviewerSeparation.underWaiver,
      },
      blockers: ready.blockers,
      unverifiedLabourerIds: planned.unverifiedLabourerIds,
      separation: {
        contributors: entry.contributors,
        reviewer: entry.reviewer,
        approver: entry.approver,
      },
      approvedUnderWaiver: entry.underWaiver,
      decisions: s.decisions
        .filter((decision) => decision.batchId === entry.batch.id)
        .map((decision) => omit(decision, "batchId")),
      permissions: {
        canReview: has("payroll.review") && entry.batch.status === "submitted",
        canReject:
          (entry.batch.status === "submitted" && has("payroll.review", "payroll.approve")) ||
          (entry.batch.status === "reviewed" && has("payroll.approve")),
        canReopen: has("payroll.prepare") && entry.batch.status === "rejected",
        canApprove: has("payroll.approve") && entry.batch.status === "reviewed",
      },
    };
  };
  const record = (
    entry: Batch,
    action: wire.BatchDecision["action"],
    extra: Partial<wire.BatchDecision> = {},
  ): wire.BatchDecision => {
    const decision = {
      id: randomUUID(),
      batchId: entry.batch.id,
      action,
      actor: d.user,
      batchVersion: entry.batch.version,
      digest: entry.batch.digest,
      approvalDigest: null,
      netMinor: entry.batch.netMinor,
      appliedLimitMinor: null,
      underWaiver: false,
      stepUpAt: null,
      note: null,
      obligationId: null,
      createdAt: iso(),
      ...extra,
      actionHash: sha256(
        decisionActionText({
          batchId: entry.batch.id,
          version: entry.batch.version,
          digest: entry.batch.digest,
          approvalDigest: extra.approvalDigest ?? null,
          netMinor: entry.batch.netMinor,
          action,
        }),
      ),
    };
    s.decisions.push(decision);
    return omit(decision, "batchId");
  };
  const contribute = (entry: Batch) => {
    if (!entry.contributors.some((person) => person.id === d.user.id))
      entry.contributors.push(d.user);
  };

  // D4.1 batch detail and payslips for the D4.3 batches -------------------------------------------
  const detail = (entry: Batch): wire.BatchDetailResponse => {
    const lines = entry.lines.map((candidate): wire.PayrollLineSummary => ({
      id: candidate.id,
      labourer: ref(candidate.labourerId),
      engagementType: "casual",
      rateBasis: "daily",
      days: String(candidate.days),
      daysWorked: candidate.days,
      halfDays: candidate.days * 2,
      normalMinutes: candidate.days * 480,
      overtimeMinutes: { weekday: 0, rest_day: 0, public_holiday: 0 },
      grossMinor: candidate.grossMinor,
      statutoryWithheldMinor: candidate.statutoryMinor,
      advanceRecoveryMinor: candidate.recoveryMinor,
      netMinor: netOf(candidate),
      ...(candidate.broughtForwardMinor ? { broughtForwardMinor: candidate.broughtForwardMinor } : {}),
      employerCostMinor: candidate.employerCostMinor,
      warnings: candidate.broughtForwardMinor
        ? [{ code: "brought-forward", details: {} }]
        : [],
    }));
    const statutory = entry.lines.reduce((sum, candidate) => sum + candidate.statutoryMinor, 0);
    const recovery = entry.lines.reduce((sum, candidate) => sum + candidate.recoveryMinor, 0);
    const broughtForward = entry.lines.reduce((sum, candidate) => sum + candidate.broughtForwardMinor, 0);
    const prepare = has("payroll.prepare");
    return {
      project: PROJECT,
      batch: entry.batch,
      totals: {
        lines: entry.lines.length,
        grossMinor: entry.batch.grossMinor,
        statutoryBaseMinor: entry.batch.grossMinor,
        employee: {
          nssf: Math.round(statutory * 0.48),
          shif: Math.round(statutory * 0.4),
          ahl: statutory - Math.round(statutory * 0.48) - Math.round(statutory * 0.4),
          paye: 0,
        },
        advanceRecoveryMinor: recovery,
        otherDeductionsMinor: 0,
        totalDeductionsMinor: statutory + recovery,
        netMinor: entry.batch.netMinor,
        ...(broughtForward ? { broughtForwardMinor: broughtForward } : {}),
        employer: {
          nssf_employer: Math.round(entry.batch.employerCostMinor * 0.6),
          ahl_employer: Math.round(entry.batch.employerCostMinor * 0.2),
          nita:
            entry.batch.employerCostMinor -
            Math.round(entry.batch.employerCostMinor * 0.6) -
            Math.round(entry.batch.employerCostMinor * 0.2),
        },
        employerCostMinor: entry.batch.employerCostMinor,
        shortfallMinor: 0,
      },
      lines,
      exclusions: [],
      unapprovedPeriods: [],
      pendingOutputs: 0,
      rules: [],
      snapshot: {
        digest: entry.batch.status === "draft" ? null : entry.batch.digest,
        verified: entry.batch.status === "draft" ? null : true,
      },
      production: false,
      permissions: {
        canRecalculate: prepare && entry.batch.status === "draft",
        canSubmit: prepare && entry.batch.status === "draft",
        canCancel: prepare && ["draft", "submitted", "reviewed"].includes(entry.batch.status),
      },
    };
  };

  // Batch routes ----------------------------------------------------------------------------------
  const batchMatch = /^\/payroll\/batches\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (batchMatch) {
    const batchId = batchMatch[1]!;
    const rest = batchMatch[2] ?? "";
    if (batchId === PAYROLL_BATCH_ID) {
      if (rest !== "approval") return null;
      // The D4.1 batch: the approval view of a draft or submitted batch (transport fixture only).
      need("payroll.view", "payroll.prepare", "payroll.review", "payroll.approve");
      const data = d.payroll.data;
      return {
        schema: wire.batchApprovalResponseSchema,
        body: {
          project: data.project,
          batch: data.batch,
          approvalDigest: null,
          recipients: [],
          carryForwardOnly: [],
          zeroNetLines: 0,
          totals: {
            obligations: 0,
            netMinor: data.batch.netMinor,
            mpesaMinor: 0,
            manualMinor: 0,
            carryForwardMinor: 0,
            broughtForwardMinor: 0,
            unverified: 0,
            flagged: 0,
          },
          limit: { source: "none", maxBatchNetMinor: null, appliedLimitMinor: null },
          waiver: { ...s.settings.waiver, appliesToCaller: false },
          blockers: [],
          unverifiedLabourerIds: [],
          separation: {
            contributors: [data.batch.createdBy],
            reviewer: null,
            approver: null,
          },
          approvedUnderWaiver: false,
          decisions: [],
          permissions: {
            canReview: false,
            canReject: false,
            canReopen: false,
            canApprove: false,
          },
        },
      };
    }
    const entry = batchOf(batchId);
    if (!has("payroll.view", "payroll.prepare", "payroll.review", "payroll.approve", "payments.view"))
      d.fail(403, "forbidden");
    if (rest === "" && method === "GET") return { schema: wire.batchDetailResponseSchema, body: detail(entry) };
    const lineMatch = /^lines\/([^/]+)$/.exec(rest);
    if (lineMatch && method === "GET") {
      const source = entry.lines.find((candidate) => candidate.id === lineMatch[1]);
      if (!source) d.fail(404, "not-found");
      const summary = detail(entry).lines.find((candidate) => candidate.id === source!.id)!;
      const approved = !["draft", "submitted", "reviewed", "rejected", "cancelled"].includes(
        entry.batch.status,
      );
      return {
        schema: wire.payslipResponseSchema,
        body: {
          company: "Jenga Bora Builders Ltd",
          project: PROJECT,
          batch: entry.batch,
          line: {
            ...summary,
            trade: null,
            earnings: [
              {
                kind: "attendance",
                category: "weekday",
                date: entry.batch.periodStart,
                description: "Approved attendance",
                quantity: String(source!.days),
                unit: "day",
                rateMinor: Math.round(source!.grossMinor / source!.days),
                multiplier: null,
                labourRateId: null,
                amountMinor: source!.grossMinor,
                taxable: true,
              },
            ],
            deductions: [],
            recoveries: [],
            employerCosts: [],
            monthToDate: {
              statutoryMonth: entry.batch.statutoryMonth,
              priorBatches: 0,
              priorBaseMinor: 0,
              cumulativeBaseMinor: source!.grossMinor,
              taxablePayMinor: source!.grossMinor,
              payeBeforeReliefMinor: 0,
              personalReliefMinor: 0,
              monthly: { nssf: 0, shif: 0, ahl: 0, paye: 0 },
            },
            advanceBalanceMinor: 0,
            ...(approved ? { carryForwardMinor: netOf(source!) % 100 } : {}),
          },
        },
      };
    }
    if (["recalculate", "submit", "cancel"].includes(rest) && method === "POST") {
      need("payroll.prepare");
      const input =
        rest === "cancel"
          ? d.parse(wire.cancelBatchRequestSchema, body)
          : d.parse(wire.batchActionRequestSchema, body);
      if (input.version !== entry.batch.version) d.fail(409, "version-conflict");
      if (rest === "cancel") {
        if (!["draft", "submitted", "reviewed"].includes(entry.batch.status))
          d.fail(409, "invalid-transition");
        entry.batch.status = "cancelled";
        entry.batch.cancelledBy = d.user;
        entry.batch.cancelledAt = iso();
        entry.batch.cancellationReason =
          "reason" in input && typeof input.reason === "string" ? input.reason : null;
        record(entry, "cancel", { note: entry.batch.cancellationReason });
      } else {
        if (entry.batch.status !== "draft") d.fail(409, "invalid-transition");
        contribute(entry);
        if (rest === "submit") {
          entry.batch.status = "submitted";
          entry.batch.submittedBy = d.user;
          entry.batch.submittedAt = iso();
          record(entry, "submit");
        } else entry.batch.calculatedAt = iso();
      }
      entry.batch.version += 1;
      return done({ schema: wire.batchDetailResponseSchema, body: detail(entry) });
    }
    if (rest === "approval" && method === "GET")
      return { schema: wire.batchApprovalResponseSchema, body: readiness(entry) };
    if (rest === "review" && method === "POST") {
      need("payroll.review");
      const input = d.parse(wire.reviewBatchRequestSchema, body);
      if (input.version !== entry.batch.version) d.fail(409, "version-conflict");
      if (entry.batch.status !== "submitted") d.fail(409, "invalid-transition");
      if (entry.contributors.some((person) => person.id === d.user.id)) d.fail(403, "maker-checker");
      if (input.digest !== entry.batch.digest) d.fail(409, "snapshot-changed");
      entry.batch.status = "reviewed";
      entry.reviewer = d.user;
      const decision = record(entry, "review", { note: input.note || null });
      entry.batch.version += 1;
      return done({
        schema: wire.batchDecisionResponseSchema,
        body: { batch: entry.batch, decision },
      });
    }
    if (rest === "reject" && method === "POST") {
      const input = d.parse(wire.rejectBatchRequestSchema, body);
      if (input.version !== entry.batch.version) d.fail(409, "version-conflict");
      if (entry.batch.status === "submitted") need("payroll.review", "payroll.approve");
      else if (entry.batch.status === "reviewed") need("payroll.approve");
      else d.fail(409, "invalid-transition");
      entry.batch.status = "rejected";
      const decision = record(entry, "reject", { note: input.reason });
      entry.batch.version += 1;
      return done({
        schema: wire.batchDecisionResponseSchema,
        body: { batch: entry.batch, decision },
      });
    }
    if (rest === "reopen" && method === "POST") {
      need("payroll.prepare");
      const input = d.parse(wire.reopenBatchRequestSchema, body);
      if (input.version !== entry.batch.version) d.fail(409, "version-conflict");
      if (entry.batch.status !== "rejected") d.fail(409, "invalid-transition");
      entry.batch.status = "draft";
      entry.batch.submittedBy = null;
      entry.batch.submittedAt = null;
      entry.reviewer = null;
      contribute(entry);
      const decision = record(entry, "reopen");
      entry.batch.version += 1;
      return done({
        schema: wire.batchDecisionResponseSchema,
        body: { batch: entry.batch, decision },
      });
    }
    if (rest === "approve" && method === "POST") {
      need("payroll.approve");
      stepUp();
      const input = d.parse(wire.approveBatchRequestSchema, body);
      if (input.version !== entry.batch.version) d.fail(409, "version-conflict");
      if (entry.batch.status !== "reviewed") d.fail(409, "invalid-transition");
      if (input.digest !== entry.batch.digest) d.fail(409, "snapshot-changed");
      const separation = approvalSeparation({
        actorId: d.user.id,
        contributors: entry.contributors.map((person) => person.id),
        reviewerId: entry.reviewer?.id ?? null,
        waiverEnabled: s.settings.waiver.enabled,
      });
      if (!separation.ok) d.fail(403, "maker-checker");
      const checked = checkApprovalLimit({
        netMinor: entry.batch.netMinor,
        limit: approvalLimitFor(approverRole, s.limits.rows),
        underWaiver: separation.ok && separation.underWaiver,
        waiverLimitMinor: s.settings.waiver.limitMinor,
      });
      if (!checked.ok)
        d.fail(
          403,
          checked.code,
          checked.code === "approval-limit-exceeded"
            ? { limitMinor: checked.limitMinor, netMinor: checked.netMinor }
            : undefined,
        );
      const planned = plan(entry);
      if (planned.unverifiedLabourerIds.length)
        d.fail(409, "unverified-recipients", { labourerIds: planned.unverifiedLabourerIds });
      const approvalDigest = digestOf(entry);
      if (input.approvalDigest !== approvalDigest) d.fail(409, "snapshot-changed");
      const flags = flagsFor(planned);
      const at = iso();
      const created = planned.obligations.map(
        (planEntry): Obligation => ({
          id: randomUUID(),
          batchId: entry.batch.id,
          lineId: planEntry.lineId,
          labourerId: planEntry.labourerId,
          amountMinor: planEntry.amountMinor,
          lineNetMinor: netOf(entry.lines.find((candidate) => candidate.id === planEntry.lineId)!),
          broughtForwardMinor: entry.lines.find((candidate) => candidate.id === planEntry.lineId)!
            .broughtForwardMinor,
          carryForwardMinor: planEntry.carryForwardMinor,
          channel: planEntry.channel,
          manualReason: planEntry.manualReason,
          destination: planEntry.destinationBidx,
          verificationId: planEntry.verificationId,
          approvedBy: d.user,
          approvedAt: at,
          version: 1,
          createdAt: at,
        }),
      );
      s.obligations.push(...created);
      for (const flag of flags) {
        const target = created.find((candidate) => candidate.lineId === flag.key);
        if (target)
          s.flags.push({
            id: randomUUID(),
            obligationId: target.id,
            code: flag.code,
            status: "open",
            details: flag.details,
            createdAt: at,
            createdBy: null,
            clearedBy: null,
            clearedAt: null,
            clearReason: null,
          });
      }
      for (const carry of planned.carryForwards)
        s.carries.push({
          id: randomUUID(),
          labourerId: carry.labourerId,
          amountMinor: carry.amountMinor,
          status: "open",
          sourceBatchId: entry.batch.id,
          sourceLineId: carry.lineId,
          consumedBatchId: null,
          consumedLineId: null,
          createdAt: at,
          consumedAt: null,
        });
      entry.batch.status = "approved";
      entry.approver = d.user;
      entry.underWaiver = separation.underWaiver;
      entry.approvalDigest = approvalDigest;
      const decision = record(entry, "approve", {
        approvalDigest,
        appliedLimitMinor: checked.appliedLimitMinor,
        underWaiver: separation.underWaiver,
        stepUpAt: at,
        note: input.note || null,
      });
      entry.batch.version += 1;
      recompute(entry);
      return done({
        schema: wire.approveBatchResponseSchema,
        body: {
          batch: entry.batch,
          decision,
          obligations: {
            total: created.length,
            mpesa: created.filter((candidate) => candidate.channel === "mpesa").length,
            manual: created.filter((candidate) => candidate.channel === "manual").length,
            flagged: flags.length,
            amountMinor: created.reduce((sum, candidate) => sum + candidate.amountMinor, 0),
            carryForwards: planned.carryForwards.length,
            carryForwardMinor: planned.carryForwards.reduce((sum, carry) => sum + carry.amountMinor, 0),
          },
        },
      });
    }
    if (rest === "payouts" && method === "GET") {
      need("payments.view", "payments.disburse", "payments.approve", "payments.review", "payroll.approve");
      tick();
      return { schema: wire.batchPayoutsResponseSchema, body: payoutsView(entry) };
    }
    if (rest === "float-check" && method === "POST") {
      need("payments.disburse");
      d.parse(wire.floatCheckRequestSchema, body);
      const check = {
        id: randomUUID(),
        status: "sent" as const,
        requestedAt: iso(),
        answeredAt: null,
        balances: null,
      };
      s.checks.push(check);
      return done({ status: 201, schema: wire.floatCheckResponseSchema, body: { check } });
    }
    if (rest === "payouts" && method === "POST") {
      need("payments.disburse");
      stepUp();
      const input = d.parse(wire.startPayoutsRequestSchema, body);
      return done(start(entry, input.obligationIds));
    }
    d.fail(404, "not-found");
  }

  function payoutsView(entry: Batch): wire.BatchPayoutsResponse {
    const mine = s.obligations.filter((candidate) => candidate.batchId === entry.batch.id);
    const views = mine.map(obligationView);
    const eligible = views.filter(
      (view) => view.blockReasons.length === 0 && view.outstandingMinor > 0,
    );
    const latest = latestAnswer();
    const available = latest ? utilityBalanceMinor(latest.balances) : null;
    const age = latest?.answeredAt
      ? Math.max(0, Math.floor((Date.now() - Date.parse(latest.answeredAt)) / 60_000))
      : null;
    const byProgress = Object.fromEntries(
      OBLIGATION_PROGRESS_STATUSES.map((status) => [
        status,
        views.filter((view) => view.progress === status).length,
      ]),
    ) as wire.BatchPayoutsResponse["totals"]["byProgress"];
    return {
      project: PROJECT,
      batch: entry.batch,
      approvedUnderWaiver: entry.underWaiver,
      obligations: views,
      totals: {
        obligations: views.length,
        amountMinor: views.reduce((sum, view) => sum + view.amountMinor, 0),
        paidMinor: views.reduce((sum, view) => sum + view.paidMinor, 0),
        outstandingMinor: views.reduce((sum, view) => sum + view.outstandingMinor, 0),
        settled: views.filter((view) => view.status === "settled").length,
        eligible: eligible.length,
        eligibleMinor: eligible.reduce((sum, view) => sum + view.outstandingMinor, 0),
        eligibleChargesMinor: eligible.reduce(
          (sum, view) => sum + (tariffCharge(DEMO_B2C_TARIFF.bands, view.outstandingMinor) ?? 0),
          0,
        ),
        chargesMinor: s.payouts
          .filter((payout) => mine.some((candidate) => candidate.id === payout.obligationId))
          .reduce((sum, payout) => sum + (payout.status === "confirmed" ? (payout.chargeMinor ?? 0) : 0), 0),
        carryForwardMinor: mine.reduce((sum, candidate) => sum + candidate.carryForwardMinor, 0) +
          s.carries
            .filter(
              (carry) =>
                carry.sourceBatchId === entry.batch.id &&
                !mine.some((candidate) => candidate.lineId === carry.sourceLineId),
            )
            .reduce((sum, carry) => sum + carry.amountMinor, 0),
        broughtForwardMinor: mine.reduce((sum, candidate) => sum + candidate.broughtForwardMinor, 0),
        byProgress,
      },
      carryForwards: s.carries.filter((carry) => carry.sourceBatchId === entry.batch.id).map(carryView),
      float: {
        latest,
        utilityAvailableMinor: available,
        ageMinutes: age,
        maxAgeMinutes: s.settings.floatCheckMaxAgeMinutes,
        fresh: age !== null && age <= s.settings.floatCheckMaxAgeMinutes,
        inFlightMinor: inFlight(latest),
      },
      payoutsEnabled: s.payoutsEnabled,
      businessHours: {
        start: s.settings.businessHoursStart,
        end: s.settings.businessHoursEnd,
        open: hoursOpen(),
      },
      permissions: {
        canFloatCheck: has("payments.disburse"),
        canStart: has("payments.disburse"),
        canRecordManual: has("payments.record_cash"),
        canConfirmManual: has("payments.approve"),
        canApproveDestination: has("payroll.approve"),
        canClearFlags: has("payments.approve"),
        canResend: has("payments.disburse"),
        canViewReceiverNames: canSeeNames,
      },
    };
  }
  function latestAnswer() {
    return (
      [...s.checks]
        .filter((check) => check.status === "answered" && check.answeredAt)
        .sort((a, b) => (b.answeredAt ?? "").localeCompare(a.answeredAt ?? ""))[0] ?? null
    );
  }
  function inFlight(latest: ReturnType<typeof latestAnswer>) {
    if (!latest?.answeredAt) return 0;
    return s.payouts
      .filter(
        (payout) =>
          payout.method === "mpesa" &&
          payout.status !== "failed" &&
          payout.createdAt > latest.answeredAt!,
      )
      .reduce(
        (sum, payout) =>
          sum + payout.amountMinor + (tariffCharge(DEMO_B2C_TARIFF.bands, payout.amountMinor) ?? 0),
        0,
      );
  }
  function hoursOpen() {
    const { businessHoursStart: open, businessHoursEnd: close } = s.settings;
    return (open === "00:00" && close === "23:59") || isWithinBusinessHours(now, open, close);
  }
  function start(entry: Batch, ids: string[] | undefined): Reply {
    if (!s.payoutsEnabled) d.fail(409, "payouts-paused");
    const candidates = s.obligations.filter(
      (candidate) =>
        candidate.batchId === entry.batch.id && (!ids || ids.includes(candidate.id)),
    );
    const assessed = candidates.map((candidate) => ({
      candidate,
      reasons: blockReasons(candidate),
      outstanding: candidate.amountMinor - paidOf(candidate.id),
    }));
    const eligible = assessed.filter((value) => !value.reasons.length && value.outstanding > 0);
    const ineligible = assessed
      .filter((value) => value.reasons.length)
      .map((value) => ({ obligationId: value.candidate.id, reasons: value.reasons }));
    if (!eligible.length)
      d.fail(409, "nothing-eligible", { obligationIds: ineligible.map((value) => value.obligationId) });
    const latest = latestAnswer();
    const age = latest?.answeredAt
      ? Math.floor((Date.now() - Date.parse(latest.answeredAt)) / 60_000)
      : null;
    if (!latest || age === null || age > s.settings.floatCheckMaxAgeMinutes)
      d.fail(409, "float-check-required", {
        answeredAt: latest?.answeredAt ?? null,
        ageMinutes: age,
        maxAgeMinutes: s.settings.floatCheckMaxAgeMinutes,
      });
    const charges = eligible.map((value) => tariffCharge(DEMO_B2C_TARIFF.bands, value.outstanding));
    if (charges.some((charge) => charge === null))
      d.fail(409, "tariff-missing", {
        obligationIds: eligible.filter((_, index) => charges[index] === null).map((value) => value.candidate.id),
      });
    const amounts = eligible.reduce((sum, value) => sum + value.outstanding, 0);
    const chargesMinor = charges.reduce<number>((sum, charge) => sum + (charge ?? 0), 0);
    const available = utilityBalanceMinor(latest!.balances) ?? 0;
    const flight = inFlight(latest);
    const required = amounts + chargesMinor;
    if (available - flight < required)
      d.fail(409, "insufficient-float", {
        availableMinor: available,
        inFlightMinor: flight,
        amountsMinor: amounts,
        chargesMinor,
        requiredMinor: required,
        shortfallMinor: required - (available - flight),
        answeredAt: latest!.answeredAt,
      });
    const usedToday = s.payouts
      .filter(
        (payout) =>
          payout.method === "mpesa" &&
          payout.status !== "failed" &&
          nairobiDate(new Date(payout.createdAt)) === today,
      )
      .reduce((sum, payout) => sum + payout.amountMinor, 0);
    if (usedToday + amounts > LIMITS.dailyPayoutMaxMinor)
      d.fail(409, "daily-limit-exceeded", {
        dailyLimitMinor: LIMITS.dailyPayoutMaxMinor,
        usedTodayMinor: usedToday,
        amountsMinor: amounts,
      });
    if (!hoursOpen()) {
      const flagged = eligible.map((value) => {
        const flag: wire.PayoutFlag = {
          id: randomUUID(),
          obligationId: value.candidate.id,
          code: "outside_business_hours",
          status: "open",
          details: { startedAt: iso() },
          createdAt: iso(),
          createdBy: d.user,
          clearedBy: null,
          clearedAt: null,
          clearReason: null,
        };
        s.flags.push(flag);
        return { obligationId: value.candidate.id, flagId: flag.id };
      });
      return {
        schema: wire.startPayoutsResponseSchema,
        body: {
          outcome: "outside_business_hours",
          payouts: [],
          flagged,
          ineligible,
          totals: { payouts: 0, amountMinor: 0, chargesMinor: 0 },
          float: null,
          batch: entry.batch,
        },
      };
    }
    const created = eligible.map((value, index) => {
      const earlier = s.payouts.filter(
        (payout) => payout.obligationId === value.candidate.id && payout.method === "mpesa",
      ).length;
      const scenario: Scenario =
        value.candidate.labourerId === LABOUR_IDS.grace && earlier === 0
          ? "fail"
          : value.candidate.labourerId === LABOUR_IDS.mercy
            ? "uncertain"
            : value.candidate.labourerId === LABOUR_IDS.joseph
              ? "mismatch"
              : "confirm";
      const payout: Payout = {
        id: randomUUID(),
        obligationId: value.candidate.id,
        method: "mpesa",
        amountMinor: value.outstanding,
        status: "active",
        attempt: "queued",
        requestStatus: "in_progress",
        version: 1,
        paymentRequestId: randomUUID(),
        receipt: null,
        failure: null,
        chargeMinor: null,
        nameCheck: null,
        reference: null,
        paidOn: null,
        reason: null,
        evidence: [],
        createdBy: d.user,
        confirmedBy: null,
        confirmedAt: null,
        rejectionReason: null,
        createdAt: iso(),
        finishedAt: null,
        stage: 0,
        scenario,
        businessDate: null,
        caseId: null,
      };
      s.payouts.push(payout);
      registerPayoutRequest(d.paymentsKey, {
        id: payout.paymentRequestId!,
        reference: `PAYROLL-${entry.batch.periodStart.replace(/-/g, "")}-${String(index + 1).padStart(2, "0")}`,
        amountMinor: payout.amountMinor,
        counterparty: maskPhone(value.candidate.destination!),
        projectId: PROJECT.id,
        createdBy: d.user,
        createdAt: payout.createdAt,
      });
      return { payout, charge: charges[index] ?? 0 };
    });
    recompute(entry);
    return {
      schema: wire.startPayoutsResponseSchema,
      body: {
        outcome: "submitted",
        payouts: created.map(({ payout, charge }) => ({
          id: payout.id,
          obligationId: payout.obligationId,
          amountMinor: payout.amountMinor,
          chargeMinor: charge,
          paymentRequestId: payout.paymentRequestId!,
        })),
        flagged: [],
        ineligible,
        totals: {
          payouts: created.length,
          amountMinor: amounts,
          chargesMinor,
        },
        float: {
          availableMinor: available,
          inFlightMinor: flight,
          requiredMinor: required,
          answeredAt: latest!.answeredAt!,
        },
        batch: entry.batch,
      },
    };
  }

  // Obligations, manual payments, flags, notifications --------------------------------------------
  const obligationOf = (id: string) => {
    const entry = s.obligations.find((candidate) => candidate.id === id);
    if (!entry) d.fail(404, "not-found");
    return entry!;
  };
  const payoutOf = (id: string) => {
    const payout = s.payouts.find((candidate) => candidate.id === id);
    if (!payout) d.fail(404, "not-found");
    return payout!;
  };
  const manualReply = (payout: Payout, status?: number): Reply => ({
    status,
    schema: wire.manualPaymentResponseSchema,
    body: { payout: payoutView(payout), obligation: obligationView(obligationOf(payout.obligationId)) },
  });
  const obligationRoute = /^\/payroll\/obligations\/([^/]+)\/(manual-payments|destination-approval)$/.exec(path);
  if (obligationRoute && method === "POST") {
    const entry = obligationOf(obligationRoute[1]!);
    if (obligationRoute[2] === "manual-payments") {
      need("payments.record_cash");
      stepUp();
      const input = d.parse(wire.recordManualPaymentRequestSchema, body);
      const mine = s.payouts.filter((payout) => payout.obligationId === entry.id);
      const outstanding = entry.amountMinor - paidOf(entry.id);
      const problem = manualPaymentProblem({
        status: outstanding <= 0 ? "settled" : "open",
        outstandingMinor: outstanding,
        livePayout: mine.some((payout) => payout.status === "active" || payout.status === "pending_confirmation"),
        uncertainPayout: mine.some((payout) => payout.requestStatus === "uncertain"),
        amountMinor: input.amountMinor,
      });
      if (problem)
        d.fail(409, problem, problem === "amount-above-outstanding" ? { outstandingMinor: outstanding } : undefined);
      if (input.method === "cash") {
        const used = s.payouts
          .filter(
            (payout) =>
              payout.method === "cash" &&
              ["pending_confirmation", "confirmed"].includes(payout.status) &&
              s.obligations.find((candidate) => candidate.id === payout.obligationId)?.labourerId ===
                entry.labourerId &&
              s.obligations.find((candidate) => candidate.id === payout.obligationId)?.batchId === entry.batchId,
          )
          .reduce((sum, payout) => sum + payout.amountMinor, 0);
        const cap = checkCashCap({
          capMinor: s.settings.cashMaxPerWorkerPeriodMinor,
          usedMinor: used,
          amountMinor: input.amountMinor,
        });
        if (!cap.ok)
          d.fail(409, cap.code, cap.code === "cash-cap-exceeded" ? { capMinor: cap.capMinor, usedMinor: cap.usedMinor } : undefined);
      }
      const payout: Payout = {
        id: randomUUID(),
        obligationId: entry.id,
        method: input.method,
        amountMinor: input.amountMinor,
        status: "pending_confirmation",
        attempt: null,
        requestStatus: null,
        version: 1,
        paymentRequestId: null,
        receipt: null,
        failure: null,
        chargeMinor: null,
        nameCheck: null,
        reference: input.reference ?? null,
        paidOn: input.paidOn,
        reason: input.reason ?? null,
        evidence: [],
        createdBy: d.user,
        confirmedBy: null,
        confirmedAt: null,
        rejectionReason: null,
        createdAt: iso(),
        finishedAt: null,
        stage: 0,
        scenario: "confirm",
        businessDate: null,
        caseId: null,
      };
      s.payouts.push(payout);
      recompute(batchOf(entry.batchId));
      return done(manualReply(payout, 201));
    }
    need("payroll.approve");
    stepUp();
    const input = d.parse(wire.destinationApprovalRequestSchema, body);
    if (input.version !== entry.version) d.fail(409, "version-conflict");
    const row = labourer(entry.labourerId);
    if (!row.phone) d.fail(409, "no-number");
    if (row.phone === entry.destination) d.fail(409, "destination-unchanged");
    const verification = currentVerification(entry.labourerId);
    if (!verification || verification.id !== input.verificationId) d.fail(409, "destination-unverified");
    const batch = batchOf(entry.batchId);
    if (
      batch.contributors.some((person) => person.id === d.user.id) ||
      row.phoneChangedBy?.id === d.user.id
    )
      d.fail(403, "maker-checker");
    entry.destination = row.phone;
    entry.verificationId = verification!.id;
    entry.approvedBy = d.user;
    entry.approvedAt = iso();
    entry.version += 1;
    const decision = record(batch, "destination_approve", {
      obligationId: entry.id,
      note: input.note || null,
      stepUpAt: iso(),
    });
    return done({
      schema: wire.obligationResponseSchema,
      body: { obligation: obligationView(entry), decision },
    });
  }
  const manualRoute = /^\/payroll\/manual-payments\/([^/]+)\/(evidence|confirm|reject)$/.exec(path);
  if (manualRoute && method === "POST") {
    const payout = payoutOf(manualRoute[1]!);
    if (payout.method === "mpesa") d.fail(409, "invalid-transition");
    if (manualRoute[2] === "evidence") {
      need("payments.record_cash");
      if (payout.status !== "pending_confirmation") d.fail(409, "invalid-transition");
      if (payout.evidence.length >= MANUAL_PAYMENT_LIMITS.evidencePerPayment) d.fail(409, "evidence-limit");
      const file = multipartFile(d.raw, d.contentType);
      if (!file) d.fail(400, "file-required");
      if (file!.content.length > MANUAL_PAYMENT_LIMITS.evidenceMaxBytes) d.fail(413, "payload-too-large");
      const type = sniffImage(file!.content);
      if (!type) d.fail(415, "unsupported-file-type");
      const evidence: wire.PaymentEvidence = {
        id: randomUUID(),
        contentType: type!,
        sizeBytes: file!.content.length,
        scanStatus: "clean",
        uploadedAt: iso(),
        uploadedBy: d.user,
      };
      payout.evidence.push(evidence);
      return done({ status: 201, schema: wire.paymentEvidenceResponseSchema, body: { evidence } });
    }
    need("payments.approve");
    stepUp();
    const confirm = manualRoute[2] === "confirm";
    const input = confirm
      ? d.parse(wire.confirmManualPaymentRequestSchema, body)
      : d.parse(wire.rejectManualPaymentRequestSchema, body);
    if (input.version !== payout.version) d.fail(409, "version-conflict");
    if (payout.status !== "pending_confirmation") d.fail(409, "invalid-transition");
    if (payout.createdBy?.id === d.user.id) d.fail(403, "maker-checker");
    if (confirm && payout.method === "cash" && !payout.evidence.length) d.fail(409, "evidence-required");
    payout.version += 1;
    payout.finishedAt = iso();
    if (confirm) {
      payout.status = "confirmed";
      payout.confirmedBy = d.user;
      payout.confirmedAt = payout.finishedAt;
      afterAllocation(obligationOf(payout.obligationId));
    } else {
      payout.status = "rejected";
      payout.rejectionReason =
        "reason" in input && typeof input.reason === "string" ? input.reason : null;
      recompute(batchOf(obligationOf(payout.obligationId).batchId));
    }
    return done(manualReply(payout));
  }
  const flagRoute = /^\/payroll\/flags\/([^/]+)\/clear$/.exec(path);
  if (flagRoute && method === "POST") {
    need("payments.approve");
    stepUp();
    const input = d.parse(wire.clearFlagRequestSchema, body);
    const flag = s.flags.find((candidate) => candidate.id === flagRoute[1]);
    if (!flag) d.fail(404, "not-found");
    if (flag!.status !== "open") d.fail(409, "flag-cleared");
    const batch = batchOf(obligationOf(flag!.obligationId).batchId);
    if (
      flagClearConflict(d.user.id, {
        contributors: batch.contributors.map((person) => person.id),
        approverId: batch.approver?.id ?? null,
        startedBy: flag!.code === "outside_business_hours" ? (flag!.createdBy?.id ?? null) : null,
      })
    )
      d.fail(403, "maker-checker");
    flag!.status = "cleared";
    flag!.clearedBy = d.user;
    flag!.clearedAt = iso();
    flag!.clearReason = input.reason;
    return done({ schema: wire.payoutFlagResponseSchema, body: { flag: flag! } });
  }
  const noticeRoute = /^\/payroll\/notifications\/([^/]+)\/resend$/.exec(path);
  if (noticeRoute && method === "POST") {
    need("payments.disburse");
    d.parse(wire.resendNotificationRequestSchema, body);
    const notice = s.notices.find((candidate) => candidate.id === noticeRoute[1]);
    if (!notice) d.fail(404, "not-found");
    if (notice!.status !== "failed") d.fail(409, "notification-not-failed");
    notice!.status = "queued";
    notice!.attempts = 0;
    notice!.lastErrorCode = null;
    notice!.wait = 1;
    return done({
      schema: wire.payrollNotificationResponseSchema,
      body: { notification: noticeView(notice!) },
    });
  }

  // Settings, waiver, approval limits -------------------------------------------------------------
  const settingsReply = (): Reply => ({
    schema: wire.payoutSettingsResponseSchema,
    body: {
      settings: s.settings,
      canManage: has("config.manage"),
      canManageWaiver: has("config.manage") && d.role === "owner",
    },
  });
  if (path === "/payroll/payout-settings") {
    need("payments.view", "payroll.approve", "config.manage");
    if (method === "GET") return settingsReply();
    need("config.manage");
    stepUp();
    const input = d.parse(wire.updatePayoutSettingsRequestSchema, body);
    if (input.version !== s.settings.version) d.fail(409, "version-conflict");
    Object.assign(s.settings, input, {
      version: s.settings.version + 1,
      updatedBy: d.user,
      updatedAt: iso(),
    });
    return done(settingsReply());
  }
  if (path === "/payroll/payout-settings/waiver" && method === "PUT") {
    need("config.manage");
    if (d.role !== "owner") d.fail(403, "owner-only");
    stepUp();
    const input = d.parse(wire.updateWaiverRequestSchema, body);
    if (input.version !== s.settings.version) d.fail(409, "version-conflict");
    s.settings.waiver = {
      enabled: input.enabled,
      reason: input.reason,
      limitMinor: input.limitMinor ?? s.settings.waiver.limitMinor,
      changedBy: d.user,
      changedAt: iso(),
    };
    s.settings.version += 1;
    return done(settingsReply());
  }
  if (path === "/payroll/approval-limits") {
    need("config.manage", "payroll.approve");
    const reply = (): Reply => ({
      schema: wire.approvalLimitsResponseSchema,
      body: {
        limits: s.limits.rows,
        ownerDefaultMinor: DEFAULT_OWNER_APPROVAL_LIMIT_MINOR,
        roles: [{ systemRole: "owner", customRoleId: null, name: "Owner" }],
        version: s.limits.version,
        canManage: has("config.manage"),
      },
    });
    if (method === "GET") return reply();
    need("config.manage");
    stepUp();
    const input = d.parse(wire.updateApprovalLimitsRequestSchema, body);
    if (input.version !== s.limits.version) d.fail(409, "version-conflict");
    s.limits.rows = input.limits.map((row) => ({
      ...row,
      roleName: row.systemRole === "owner" ? "Owner" : "Custom role",
      updatedBy: d.user,
      updatedAt: iso(),
    }));
    s.limits.version += 1;
    return done(reply());
  }

  // The payout side of a worker record --------------------------------------------------------------
  const statusReply = (labourerId: string, status?: number): Reply => {
    const row = labourer(labourerId);
    const changedAt = row.phoneChangedAt ?? null;
    const until = changeHoldUntil(changedAt, holdHours);
    const granted = override(labourerId);
    const mine = s.obligations.filter((candidate) => candidate.labourerId === labourerId);
    const open = mine.filter((candidate) => paidOf(candidate.id) < candidate.amountMinor);
    const carries = s.carries.filter(
      (carry) => carry.labourerId === labourerId && carry.status === "open",
    );
    return {
      status,
      schema: wire.labourerPayoutStatusResponseSchema,
      body: {
        labourer: {
          id: row.id,
          workerNo: row.workerNo,
          fullName: row.fullName,
          preferredLanguage: row.preferredLanguage ?? "sw",
          phoneMasked: row.phone ? maskPhone(row.phone) : null,
          version: row.version,
        },
        verificationState: !row.phone
          ? "no_number"
          : currentVerification(labourerId)
            ? "verified"
            : "unverified",
        verifications: s.verifications
          .filter((entry) => entry.labourerId === labourerId)
          .reverse()
          .map(verificationView),
        changeHold:
          changedAt && until
            ? {
                changedAt,
                changedBy: row.phoneChangedBy ?? null,
                until,
                active: Date.now() < Date.parse(until) && !granted,
                override: granted ? { by: granted.by, at: granted.at, reason: granted.reason } : null,
              }
            : null,
        holds: s.holds.filter((hold) => hold.labourerId === labourerId).reverse().map(holdView),
        blockReasons: row.phone ? recipientBlocks(labourerId) : [],
        openObligations: open.length,
        outstandingMinor: open.reduce(
          (sum, candidate) => sum + candidate.amountMinor - paidOf(candidate.id),
          0,
        ),
        openCarryForwardMinor: carries.reduce((sum, carry) => sum + carry.amountMinor, 0),
        carryForwards: carries.map(carryView),
        permissions: {
          canVerify: has("labour.manage"),
          canPlaceHold: has("payments.approve"),
          canReleaseHolds: has("payments.approve"),
          canOverrideChangeHold: has("payments.approve") && d.role === "owner",
          canSetLanguage: has("labour.manage"),
        },
      },
    };
  };
  const labourRoute =
    /^\/labour\/labourers\/([^/]+)\/(payout-status|payout-verifications|payout-holds|change-hold-override)$/.exec(
      path,
    );
  if (labourRoute) {
    const labourerId = labourRoute[1]!;
    const row = labourer(labourerId);
    const action = labourRoute[2];
    if (action === "payout-status" && method === "GET") {
      need("labour.view", "labour.manage", "payments.view", "payroll.approve");
      return statusReply(labourerId);
    }
    if (action === "payout-verifications" && method === "POST") {
      need("labour.manage");
      stepUp();
      const input = d.parse(wire.createPayoutVerificationRequestSchema, body);
      if (input.version !== row.version) d.fail(409, "version-conflict");
      if (!row.phone) d.fail(409, "no-number");
      if (
        verificationConflict(d.user.id, {
          phoneChangedBy: row.phoneChangedBy?.id ?? null,
          registeredBy: AGENT.id,
          numberFromRegistration: !row.phoneChangedAt,
        })
      )
        d.fail(403, "maker-checker");
      s.verifications.push({
        id: randomUUID(),
        labourerId,
        phone: row.phone!,
        note: input.note || null,
        by: d.user,
        at: iso(),
      });
      return done(statusReply(labourerId, 201));
    }
    if (action === "payout-holds" && method === "POST") {
      need("payments.approve");
      const input = d.parse(wire.createPayoutHoldRequestSchema, body);
      s.holds.push({
        id: randomUUID(),
        labourerId,
        kind: "manual",
        state: "active",
        phone: row.phone,
        reason: input.reason,
        payoutId: null,
        createdBy: d.user,
        createdAt: iso(),
        releasedBy: null,
        releasedAt: null,
        releaseReason: null,
      });
      return done(statusReply(labourerId, 201));
    }
    if (action === "change-hold-override" && method === "POST") {
      need("payments.approve");
      if (d.role !== "owner") d.fail(403, "owner-only");
      stepUp();
      const input = d.parse(wire.changeHoldOverrideRequestSchema, body);
      if (input.version !== row.version) d.fail(409, "version-conflict");
      const until = changeHoldUntil(row.phoneChangedAt ?? null, holdHours);
      if (!until || Date.now() >= Date.parse(until) || override(labourerId))
        d.fail(409, "change-hold-inactive");
      s.overrides.push({
        labourerId,
        changedAt: row.phoneChangedAt!,
        by: d.user,
        at: iso(),
        reason: input.reason,
      });
      return done(statusReply(labourerId));
    }
    d.fail(404, "not-found");
  }
  const releaseRoute = /^\/labour\/payout-holds\/([^/]+)\/release$/.exec(path);
  if (releaseRoute && method === "POST") {
    need("payments.approve");
    stepUp();
    const input = d.parse(wire.releasePayoutHoldRequestSchema, body);
    const hold = s.holds.find((candidate) => candidate.id === releaseRoute[1]);
    if (!hold) d.fail(404, "not-found");
    if (hold!.state !== "active") d.fail(409, "hold-released");
    hold!.state = "released";
    hold!.releasedBy = d.user;
    hold!.releasedAt = iso();
    hold!.releaseReason = input.reason;
    return done(statusReply(hold!.labourerId));
  }

  // Reconciliation, statements, tariffs -------------------------------------------------------------
  if (path.startsWith("/payments/")) {
    if (!d.tenantWide) d.fail(403, "forbidden");
    if (path === "/payments/tariffs") {
      need("payments.view", "config.manage");
      const reply = (): Reply => {
        const versions = [...s.tariffs].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
        const inForce = tariffVersionOn(versions, today);
        const shaped = versions.map((version, index) => ({
          ...version,
          effectiveTo: versions[index + 1] ? addCalendarDays(versions[index + 1]!.effectiveFrom, -1) : null,
          inForce: version.id === inForce?.id,
        }));
        return {
          schema: wire.tariffsResponseSchema,
          body: {
            today,
            versions: shaped.reverse(),
            inForce: shaped.find((version) => version.inForce) ?? null,
            canManage: has("config.manage"),
          },
        };
      };
      if (method === "GET") return reply();
      need("config.manage");
      stepUp();
      const input = d.parse(wire.putTariffRequestSchema, body);
      if (s.tariffs.some((version) => version.effectiveFrom === input.effectiveFrom))
        d.fail(409, "tariff-invalid");
      s.tariffs.push({
        id: randomUUID(),
        kind: "b2c",
        effectiveFrom: input.effectiveFrom,
        effectiveTo: null,
        inForce: false,
        status: input.status,
        bands: input.bands,
        source: input.source,
        createdBy: d.user,
        createdAt: iso(),
      });
      return done(reply());
    }
    need("payments.view", "payments.review");
    return reconciliation(d, s, method, path, query, body, {
      has,
      need,
      stepUp,
      done,
      today,
      labourerRef: ref,
      obligationOf,
    });
  }
  return null;
}

/** Registers the earlier batch's payment requests with the console and reconciles today once. */
function ensureHistory(d: PayoutDeps, s: PayoutsState) {
  if (!s.registered) {
    s.registered = true;
    for (const payout of s.payouts.filter((candidate) => candidate.paymentRequestId)) {
      const entry = s.obligations.find((candidate) => candidate.id === payout.obligationId)!;
      registerPayoutRequest(d.paymentsKey, {
        id: payout.paymentRequestId!,
        reference: `PAYROLL-20261023-${payout.receipt ?? "PENDING"}`,
        amountMinor: payout.amountMinor,
        counterparty: entry.destination ? maskPhone(entry.destination) : "—",
        projectId: PROJECT.id,
        createdBy: FINANCE,
        createdAt: payout.createdAt,
      });
      payout.caseId = updatePayoutRequest(d.paymentsKey, payout.paymentRequestId!, {
        request: payout.requestStatus ?? "in_progress",
        attempt: payout.attempt ?? "queued",
        receipt: payout.receipt,
      });
    }
  }
  if (!s.reconciledToday) {
    s.reconciledToday = true;
    runReconciliation(s, nairobiDate(), "schedule", null);
  }
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part[0]!.toUpperCase()}.`)
    .join(" ");

function businessDateOf(payout: PayoutsState["payouts"][number]): string | null {
  if (payout.businessDate) return payout.businessDate;
  const at = payout.confirmedAt ?? payout.finishedAt ?? payout.createdAt;
  return nairobiDate(new Date(at));
}

/** Runs the shared matcher for one business date and applies its changes to the stored items. */
function runReconciliation(
  s: PayoutsState,
  date: string,
  trigger: wire.ReconciliationRun["trigger"],
  runBy: Actor | null,
): wire.ReconciliationRun {
  const startedAt = new Date().toISOString();
  const confirmed = s.payouts.filter(
    (payout) =>
      payout.method === "mpesa" &&
      (payout.status === "confirmed" || payout.status === "reversed") &&
      businessDateOf(payout) === date,
  );
  const obligationOf = (id: string) => s.obligations.find((entry) => entry.id === id)!;
  const payouts = confirmed.map((payout) => ({
    payoutId: payout.id,
    obligationId: payout.obligationId,
    requestId: payout.paymentRequestId,
    receipt: payout.receipt,
    amountMinor: payout.amountMinor,
    bookedChargeMinor: payout.chargeMinor ?? 0,
    obligationAmountMinor: obligationOf(payout.obligationId).amountMinor,
    otherConfirmedMinor: s.payouts
      .filter(
        (other) =>
          other.obligationId === payout.obligationId &&
          other.id !== payout.id &&
          other.status === "confirmed",
      )
      .reduce((sum, other) => sum + other.amountMinor, 0),
    reversed: payout.status === "reversed",
  }));
  const uncertain = s.payouts
    .filter(
      (payout) =>
        payout.method === "mpesa" &&
        payout.requestStatus === "uncertain" &&
        (payout.businessDate ?? nairobiDate(new Date(payout.createdAt))) === date,
    )
    .map((payout) => ({
      payoutId: payout.id,
      requestId: payout.paymentRequestId!,
      uncertainSince: payout.createdAt,
      caseId: payout.caseId,
    }));
  const covering = s.statements.filter(
    (statement) =>
      statement.summary.periodFrom !== null &&
      statement.summary.periodTo !== null &&
      statement.summary.periodFrom <= date &&
      date <= statement.summary.periodTo,
  );
  const receipts = new Set(confirmed.map((payout) => payout.receipt).filter(Boolean));
  const lines: ReconStatementLine[] = s.statements
    .flatMap((statement) => statement.lines)
    .filter(
      (entry) =>
        (entry.completedOn === date &&
          covering.some((statement) => statement.summary.id === entry.statementId)) ||
        receipts.has(entry.receipt) ||
        (entry.chargeFor !== null && receipts.has(entry.chargeFor)),
    )
    .map((entry) => ({
      lineId: entry.id,
      statementId: entry.statementId,
      receipt: entry.receipt,
      completedOn: entry.completedOn,
      completedAt: entry.completedAt,
      lineClass: entry.lineClass,
      withdrawnMinor: entry.withdrawnMinor,
      paidInMinor: entry.paidInMinor,
      chargeFor: entry.chargeFor,
    }));
  const result = reconcileDay({
    businessDate: date,
    now: new Date(),
    payouts,
    uncertain,
    lines,
    statementCovers: covering.length > 0,
    knownReceipts: new Set(
      s.payouts.map((payout) => payout.receipt).filter((value): value is string => Boolean(value)),
    ),
  });
  const existing = s.items.filter((item) => item.businessDate === date);
  const changes = planReconciliationChanges(
    existing.map((item) => ({
      id: item.id,
      kind: item.kind,
      subjectType: item.subjectType,
      subjectId: item.subjectId,
      status: item.status,
      outcome: item.outcome,
      evidenceKey: item.evidenceKey,
    })),
    result,
  );
  const at = new Date().toISOString();
  const event = (itemId: string, kind: wire.ReconciliationItemEvent["event"], extra: Partial<wire.ReconciliationItemEvent> = {}) =>
    s.events.set(itemId, [
      ...(s.events.get(itemId) ?? []),
      { id: randomUUID(), event: kind, actor: null, at, note: null, owner: null, outcome: null, ...extra },
    ]);
  const fromDraft = (draft: (typeof result.drafts)[number]) => ({
    businessDate: draft.businessDate,
    kind: draft.kind,
    severity: draft.severity,
    status: draft.status,
    awaitingStatement: draft.awaitingStatement,
    subjectType: draft.subjectType,
    subjectId: draft.subjectId,
    payoutId: draft.payoutId,
    paymentRequestId: draft.requestId,
    caseId: draft.caseId,
    receipt: draft.receipt,
    statementLineId: draft.statementLineId,
    relatedLineIds: draft.relatedLineIds,
    chargeLineIds: draft.chargeLineIds,
    amountMinor: draft.amountMinor,
    statementAmountMinor: draft.statementAmountMinor,
    bookedChargeMinor: draft.bookedChargeMinor,
    statementChargeMinor: draft.statementChargeMinor,
    outcome: draft.outcome,
    evidenceKey: draft.evidenceKey,
  });
  for (const draft of changes.create) {
    const item: Item = {
      id: randomUUID(),
      ...fromDraft(draft),
      owner: null,
      openedAt: at,
      resolutionReason: null,
      journalId: null,
      resolvedBy: null,
      resolvedAt: draft.status === "resolved" ? at : null,
      version: 1,
    };
    s.items.push(item);
    event(item.id, draft.status === "resolved" ? "auto_resolved" : "opened", {
      outcome: draft.outcome,
    });
  }
  for (const change of changes.update) {
    const item = s.items.find((candidate) => candidate.id === change.id)!;
    Object.assign(item, fromDraft(change.draft), {
      version: item.version + 1,
      resolvedAt: change.draft.status === "resolved" ? at : null,
      resolvedBy: null,
      resolutionReason: change.draft.status === "resolved" ? null : item.resolutionReason,
    });
    event(item.id, change.reopen ? "reopened" : "evidence_updated", { outcome: change.draft.outcome });
  }
  for (const id of changes.supersede) {
    const item = s.items.find((candidate) => candidate.id === id)!;
    Object.assign(item, {
      status: "resolved",
      outcome: "superseded",
      resolvedAt: at,
      resolvedBy: null,
      version: item.version + 1,
    });
    event(item.id, "auto_resolved", { outcome: "superseded" });
  }
  const run: wire.ReconciliationRun = {
    id: randomUUID(),
    businessDate: date,
    trigger,
    startedAt,
    finishedAt: new Date().toISOString(),
    created: changes.create.length,
    updated: changes.update.length,
    superseded: changes.supersede.length,
    runBy,
  };
  s.runs.push(run);
  return run;
}

function reconciliation(
  d: PayoutDeps,
  s: PayoutsState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
  h: {
    has: (...permissions: Permission[]) => boolean;
    need: (...permissions: Permission[]) => void;
    stepUp: () => void;
    done: (reply: Reply) => Reply;
    today: string;
    labourerRef: (id: string) => { id: string; workerNo: string; fullName: string };
    obligationOf: (id: string) => PayoutsState["obligations"][number];
  },
): Reply {
  const review = h.has("payments.review");
  const itemView = (item: Item): wire.MpesaReconciliationItem => {
    const rest = omit(item, "payoutId", "evidenceKey");
    const payout = item.payoutId
      ? s.payouts.find((candidate) => candidate.id === item.payoutId)
      : undefined;
    const obligation = payout ? h.obligationOf(payout.obligationId) : undefined;
    const worker = obligation ? h.labourerRef(obligation.labourerId) : undefined;
    return {
      ...rest,
      category: RECONCILIATION_ITEM_CATEGORY[item.kind],
      payout:
        payout && obligation
          ? {
              id: payout.id,
              obligationId: payout.obligationId,
              batchId: obligation.batchId,
              projectId: PROJECT.id,
              method: payout.method,
              createdBy: payout.createdBy,
            }
          : null,
      worker: worker
        ? { labourerId: worker.id, workerNo: worker.workerNo, nameMasked: initials(worker.fullName) }
        : null,
      ageHours: Math.max(0, Math.floor((Date.now() - Date.parse(item.openedAt)) / 3_600_000)),
    };
  };
  const statementLine = (id: string | null) =>
    id
      ? (s.statements.flatMap((statement) => statement.lines).find((entry) => entry.id === id) ?? null)
      : null;
  const itemReply = (item: Item, status?: number): Reply => ({
    status,
    schema: wire.reconciliationItemResponseSchema,
    body: {
      item: itemView(item),
      events: s.events.get(item.id) ?? [],
      statementLine: statementLine(item.statementLineId),
      chargeLines: item.chargeLineIds
        .map((id) => statementLine(id))
        .filter((value): value is wire.StatementLineWire => value !== null),
      allowedOutcomes: [...RECONCILIATION_OUTCOMES_BY_KIND[item.kind]],
      permissions: {
        canAssign: review,
        canNote: review,
        canResolve: review && item.status === "open",
      },
    },
  });
  const itemOf = (id: string) => {
    const item = s.items.find((candidate) => candidate.id === id);
    if (!item) d.fail(404, "not-found");
    return item!;
  };
  const event = (item: Item, kind: wire.ReconciliationItemEvent["event"], extra: Partial<wire.ReconciliationItemEvent> = {}) =>
    s.events.set(item.id, [
      ...(s.events.get(item.id) ?? []),
      {
        id: randomUUID(),
        event: kind,
        actor: d.user,
        at: new Date().toISOString(),
        note: null,
        owner: null,
        outcome: null,
        ...extra,
      },
    ]);

  if (path === "/payments/reconciliation" && method === "GET") {
    const input = d.parse(wire.reconciliationDayQuerySchema, Object.fromEntries(query));
    const date = input.date ?? h.today;
    const items = s.items.filter((item) => item.businessDate === date);
    const covering = s.statements.filter(
      (statement) =>
        statement.summary.periodFrom !== null &&
        statement.summary.periodTo !== null &&
        statement.summary.periodFrom <= date &&
        date <= statement.summary.periodTo,
    );
    const confirmed = s.payouts.filter(
      (payout) =>
        payout.method === "mpesa" && payout.status === "confirmed" && businessDateOf(payout) === date,
    );
    const byKind = Object.fromEntries(
      RECONCILIATION_ITEM_KINDS.map((kind) => [kind, items.filter((item) => item.kind === kind).length]),
    ) as Record<ReconciliationItemKind, number>;
    return {
      schema: wire.reconciliationDayResponseSchema,
      body: {
        date,
        today: h.today,
        statementCovered: covering.length > 0,
        statements: covering.map((statement) => statement.summary),
        lastRun: [...s.runs].reverse().find((run) => run.businessDate === date) ?? null,
        counts: {
          byKind,
          open: items.filter((item) => item.status === "open").length,
          resolved: items.filter((item) => item.status === "resolved").length,
          critical: items.filter((item) => item.status === "open" && item.severity === "critical").length,
          awaitingStatement: items.filter((item) => item.status === "open" && item.awaitingStatement).length,
        },
        totals: {
          payouts: confirmed.length,
          payoutsMinor: confirmed.reduce((sum, payout) => sum + payout.amountMinor, 0),
          matchedMinor: items
            .filter((item) => item.kind === "matched")
            .reduce((sum, item) => sum + (item.amountMinor ?? 0), 0),
          bookedChargesMinor: confirmed.reduce((sum, payout) => sum + (payout.chargeMinor ?? 0), 0),
          statementChargesMinor: covering
            .flatMap((statement) => statement.lines)
            .filter((entry) => entry.lineClass === "charge" && entry.completedOn === date)
            .reduce((sum, entry) => sum + entry.withdrawnMinor, 0),
        },
        permissions: { canRun: review, canUpload: review, canResolve: review, canDispute: review },
      },
    };
  }
  if (path === "/payments/reconciliation/items" && method === "GET") {
    const input = d.parse(wire.reconciliationItemsQuerySchema, Object.fromEntries(query));
    const filtered = s.items
      .filter((item) =>
        input.date
          ? item.businessDate === input.date
          : (!input.from || item.businessDate >= input.from) && (!input.to || item.businessDate <= input.to),
      )
      .filter((item) => !input.kind || item.kind === input.kind)
      .filter((item) => !input.status || item.status === input.status)
      .filter((item) => !input.severity || item.severity === input.severity)
      .filter((item) => !input.ownerId || item.owner?.id === input.ownerId)
      .sort(
        (a, b) =>
          Number(b.status === "open") - Number(a.status === "open") ||
          ["critical", "warning", "info"].indexOf(a.severity) - ["critical", "warning", "info"].indexOf(b.severity),
      );
    return {
      schema: wire.reconciliationItemsResponseSchema,
      body: {
        items: filtered.slice(input.offset, input.offset + input.limit).map(itemView),
        total: filtered.length,
        open: filtered.filter((item) => item.status === "open").length,
      },
    };
  }
  const itemRoute = /^\/payments\/reconciliation\/items\/([^/]+)(?:\/(assign|notes|resolve))?$/.exec(path);
  if (itemRoute) {
    const item = itemOf(itemRoute[1]!);
    const action = itemRoute[2];
    if (!action && method === "GET") return itemReply(item);
    h.need("payments.review");
    if (action === "assign" && method === "POST") {
      const input = d.parse(wire.assignReconciliationItemRequestSchema, body);
      if (input.version !== item.version) d.fail(409, "version-conflict");
      if (item.status !== "open") d.fail(409, "item-resolved");
      const owner = input.ownerId ? PEOPLE.find((person) => person.id === input.ownerId) : null;
      if (input.ownerId && !owner) d.fail(404, "not-found");
      item.owner = owner ?? null;
      item.version += 1;
      event(item, "assigned", { owner: item.owner });
      return h.done(itemReply(item));
    }
    if (action === "notes" && method === "POST") {
      const input = d.parse(wire.noteReconciliationItemRequestSchema, body);
      event(item, "note", { note: input.note });
      return h.done(itemReply(item));
    }
    if (action === "resolve" && method === "POST") {
      h.stepUp();
      const input = d.parse(wire.resolveReconciliationItemRequestSchema, body);
      if (input.version !== item.version) d.fail(409, "version-conflict");
      if (item.status !== "open") d.fail(409, "item-resolved");
      if (!RECONCILIATION_OUTCOMES_BY_KIND[item.kind].includes(input.outcome))
        d.fail(409, "outcome-not-allowed");
      const payout = item.payoutId ? s.payouts.find((candidate) => candidate.id === item.payoutId) : undefined;
      if (payout?.createdBy?.id === d.user.id) d.fail(403, "maker-checker");
      item.status = "resolved";
      item.outcome = input.outcome;
      item.resolutionReason = input.reason;
      item.journalId = input.journalId ?? null;
      item.resolvedBy = d.user;
      item.resolvedAt = new Date().toISOString();
      item.version += 1;
      event(item, "resolved", { outcome: input.outcome, note: input.reason });
      return h.done(itemReply(item));
    }
    d.fail(404, "not-found");
  }
  if (path === "/payments/reconciliation/runs" && method === "POST") {
    h.need("payments.review");
    const input = d.parse(wire.runReconciliationRequestSchema, body);
    if (input.date > h.today) d.fail(400, "validation-error");
    return h.done({
      status: 201,
      schema: wire.reconciliationRunResponseSchema,
      body: { run: runReconciliation(s, input.date, "manual", d.user) },
    });
  }
  if (path === "/payments/reconciliation/disputes" && method === "POST") {
    h.need("payments.review");
    const input = d.parse(wire.openDisputeRequestSchema, body);
    const payout = s.payouts.find((candidate) => candidate.id === input.payoutId);
    if (!payout) d.fail(404, "not-found");
    const at = new Date().toISOString();
    const item: Item = {
      id: randomUUID(),
      businessDate: h.today,
      kind: "worker_dispute",
      severity: "warning",
      status: "open",
      awaitingStatement: false,
      subjectType: "payout",
      subjectId: payout!.id,
      payoutId: payout!.id,
      paymentRequestId: payout!.paymentRequestId,
      caseId: null,
      receipt: payout!.receipt,
      statementLineId: null,
      relatedLineIds: [],
      chargeLineIds: [],
      amountMinor: payout!.amountMinor,
      statementAmountMinor: null,
      bookedChargeMinor: payout!.chargeMinor,
      statementChargeMinor: null,
      outcome: null,
      evidenceKey: `dispute:${payout!.id}:${at}`,
      owner: null,
      openedAt: at,
      resolutionReason: null,
      journalId: null,
      resolvedBy: null,
      resolvedAt: null,
      version: 1,
    };
    s.items.push(item);
    event(item, "opened", { note: input.reason });
    return h.done(itemReply(item, 201));
  }
  if (path === "/payments/statements" && method === "POST") {
    h.need("payments.review");
    const file = multipartFile(d.raw, d.contentType);
    if (!file) d.fail(400, "file-required");
    if (file!.content.length > STATEMENT_LIMITS.maxBytes) d.fail(413, "statement-too-large");
    const format = /\.csv$/i.test(file!.name) ? "csv" : /\.xlsx$/i.test(file!.name) ? "xlsx" : null;
    if (!format) d.fail(415, "statement-type");
    const digest = sha256(file!.content);
    const duplicate = s.statements.find((statement) => statement.summary.sha256 === digest);
    if (duplicate) d.fail(409, "statement-already-uploaded", { statementId: duplicate.summary.id });
    // The mock reads CSV only; the API also reads XLSX with the xlsx dependency.
    if (format === "xlsx") d.fail(422, "statement-unreadable");
    const parsed = parseStatementCsv(file!.content.toString("utf8"));
    if (!parsed.ok) d.fail(422, "statement-unreadable");
    const ok = parsed as Extract<typeof parsed, { ok: true }>;
    const id = randomUUID();
    const note = d.parse(wire.uploadStatementFieldsSchema, field(d.raw, "note") ? { note: field(d.raw, "note") } : {}).note;
    const lines: wire.StatementLineWire[] = ok.lines.map((entry) => ({
      id: randomUUID(),
      statementId: id,
      row: entry.row,
      receipt: entry.receipt,
      completedAt: entry.completedAt,
      completedOn: entry.completedOn,
      initiatedAt: entry.initiatedAt,
      // Personal data in the description is masked like the other party's details.
      details: entry.details?.replace(/\d{9,15}.*$/, (party) => maskPartyInfo(party)) ?? null,
      transactionStatus: entry.transactionStatus,
      paidInMinor: entry.paidInMinor,
      withdrawnMinor: entry.withdrawnMinor,
      balanceMinor: entry.balanceMinor,
      reasonType: entry.reasonType,
      otherPartyMasked: entry.otherPartyMasked,
      linkedTransactionId: entry.linkedTransactionId,
      lineClass: entry.lineClass,
      chargeFor: entry.chargeFor,
      payoutId:
        entry.lineClass === "payout"
          ? (s.payouts.find((payout) => payout.receipt === entry.receipt)?.id ?? null)
          : null,
    }));
    const summary: wire.StatementSummary = {
      id,
      fileName: file!.name,
      format: format!,
      sizeBytes: file!.content.length,
      sha256: digest,
      periodFrom: ok.period?.from ?? null,
      periodTo: ok.period?.to ?? null,
      lines: lines.length,
      byClass: {
        payout: lines.filter((entry) => entry.lineClass === "payout").length,
        charge: lines.filter((entry) => entry.lineClass === "charge").length,
        deposit: lines.filter((entry) => entry.lineClass === "deposit").length,
        other: lines.filter((entry) => entry.lineClass === "other").length,
      },
      issues: ok.issues.length,
      note: note ?? null,
      uploadedBy: d.user,
      uploadedAt: new Date().toISOString(),
    };
    s.statements.push({ summary, lines, issues: ok.issues });
    const dates: string[] = [];
    if (ok.period)
      for (let date = ok.period.from; date <= ok.period.to; date = addCalendarDays(date, 1)) {
        dates.push(date);
        runReconciliation(s, date, "statement", null);
      }
    return h.done({
      status: 201,
      schema: wire.statementResponseSchema,
      body: { statement: summary, issues: ok.issues, reconciledDates: dates },
    });
  }
  if (path === "/payments/statements" && method === "GET") {
    const input = d.parse(wire.statementsQuerySchema, Object.fromEntries(query));
    const all = [...s.statements].reverse().map((statement) => statement.summary);
    return {
      schema: wire.statementsResponseSchema,
      body: { statements: all.slice(input.offset, input.offset + input.limit), total: all.length },
    };
  }
  const statementRoute = /^\/payments\/statements\/([^/]+)$/.exec(path);
  if (statementRoute && method === "GET") {
    const input = d.parse(wire.statementDetailQuerySchema, Object.fromEntries(query));
    const statement = s.statements.find((candidate) => candidate.summary.id === statementRoute[1]);
    if (!statement) d.fail(404, "not-found");
    const lines = statement!.lines.filter((entry) => !input.lineClass || entry.lineClass === input.lineClass);
    return {
      schema: wire.statementDetailResponseSchema,
      body: {
        statement: statement!.summary,
        lines: lines.slice(input.offset, input.offset + input.limit),
        total: lines.length,
        issues: statement!.issues,
      },
    };
  }
  d.fail(404, "not-found");
}

/** The uploaded `file` part of a multipart body: its name and bytes. */
function multipartFile(
  raw: Buffer,
  contentType: string | undefined,
): { name: string; content: Buffer } | null {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? "");
  const marker = boundary?.[1] ?? boundary?.[2];
  if (!marker) return null;
  const delimiter = Buffer.from(`--${marker}`);
  let start = raw.indexOf(delimiter);
  while (start !== -1) {
    const next = raw.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const part = raw.subarray(start + delimiter.length, next);
    const split = part.indexOf("\r\n\r\n");
    const head = split === -1 ? "" : part.subarray(0, split).toString("latin1");
    if (split !== -1 && /name="file"/.test(head)) {
      const name = /filename="([^"]*)"/.exec(head)?.[1] ?? "upload";
      return { name, content: part.subarray(split + 4, part.length - 2) };
    }
    start = next;
  }
  return null;
}

/** A text field of a multipart body. */
const field = (raw: Buffer, name: string) =>
  new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(raw.toString("utf8"))?.[1];

function sniffImage(content: Buffer): wire.PaymentEvidence["contentType"] | null {
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff)
    return "image/jpeg";
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (
    content.length >= 12 &&
    content.subarray(0, 4).toString("latin1") === "RIFF" &&
    content.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return null;
}
