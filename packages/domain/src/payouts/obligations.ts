import type {
  ManualChannelReason,
  ObligationProgressStatus,
  PaymentAttemptStatus,
  PaymentLimits,
  PayoutBlockReason,
  PayoutDisplayStatus,
  PayoutFlagCode,
  PayrollObligationChannel,
  PayrollObligationStatus,
  PayrollPayoutMethod,
  PayrollPayoutStatus,
} from "@pm-buddy/types";
import { splitNetPay } from "../payroll/carry-forward.js";

/**
 * Obligations, carry-forwards, approval snapshot, unusual-payout flags and payout eligibility
 * (D4.3 §2, §4, §5, §7, §15; decision D-167; THREAT_MODEL A-01, A-04, A-05, A-12, OR-05, OR-06).
 * Pure: the API loads the facts in the tenant transaction (holding the company lock where the
 * rule says so) and persists the result; the database guards repeat the key rules.
 */

type B2cLimits = Pick<PaymentLimits, "b2cMinMinor" | "b2cMaxMinor">;

export type ChannelDecision =
  | { channel: Extract<PayrollObligationChannel, "mpesa">; manualReason: null }
  | { channel: Extract<PayrollObligationChannel, "manual">; manualReason: ManualChannelReason };

/** Whether one B2C payment can carry `amountMinor`: whole shillings within the company's limits. */
export const isMpesaPayable = (amountMinor: number, limits: B2cLimits): boolean =>
  Number.isSafeInteger(amountMinor) &&
  amountMinor % 100 === 0 &&
  amountMinor >= limits.b2cMinMinor &&
  amountMinor <= limits.b2cMaxMinor;

/**
 * How an obligation (whole shillings, D-167) is paid: M-Pesa when its line has a payee number and
 * the amount fits one B2C payment, else manually with the reason.
 */
export function obligationChannel(input: {
  payeePhoneBidx: string | null;
  amountMinor: number;
  limits: B2cLimits;
}): ChannelDecision {
  if (!input.payeePhoneBidx) return { channel: "manual", manualReason: "no_number" };
  if (input.amountMinor < input.limits.b2cMinMinor)
    return { channel: "manual", manualReason: "below_b2c_min" };
  if (input.amountMinor > input.limits.b2cMaxMinor)
    return { channel: "manual", manualReason: "above_b2c_max" };
  return { channel: "mpesa", manualReason: null };
}

/** An approved batch line as the approval sees it (`payee_phone_bidx` is the line's snapshot). */
export type ApprovalLine = {
  lineId: string;
  labourerId: string;
  netMinor: number;
  payeePhoneBidx: string | null;
};

/** The labourer's current number and its valid verification (one whose bidx equals it). */
export type RecipientFacts = { currentPhoneBidx: string | null; verificationId: string | null };

export type PlannedObligation = {
  lineId: string;
  labourerId: string;
  /** The line net's whole shillings: `net − (net mod 100)`. */
  amountMinor: number;
  /** The line net's cents (0–99), carried to the worker's next payroll. */
  carryForwardMinor: number;
  channel: PayrollObligationChannel;
  manualReason: ManualChannelReason | null;
  /** The approved recipient: the line's payee number (null without one). */
  destinationBidx: string | null;
  /** The verification of that number, null when it is not (or no longer) verified. */
  verificationId: string | null;
};

/** A carry-forward approval creates: the cents of a line's net (or all of a net below KES 1). */
export type PlannedCarryForward = { lineId: string; labourerId: string; amountMinor: number };

export type ObligationPlan = {
  /**
   * One per line whose net is at least KES 1, for its whole shillings, sorted by line ID (lines
   * netting to zero or to less than KES 1 create none).
   */
  obligations: PlannedObligation[];
  /** One per line whose net has cents (1–99 minor units), sorted by line ID. */
  carryForwards: PlannedCarryForward[];
  /**
   * Labourers whose obligation line has a payee number without a valid verification of it (409
   * `unverified-recipients`): never verified, or their number changed since the batch was
   * calculated (the verification must be of the current number and equal the line's). Lines that
   * only carry cents forward need none.
   */
  unverifiedLabourerIds: string[];
};

/**
 * The obligations and carry-forwards approval would create, exactly as the approval digest binds
 * them (§2, §4, D-167): each line's net splits into whole shillings (the obligation) and cents
 * (the carry-forward).
 */
export function planObligations(
  lines: readonly ApprovalLine[],
  recipients: ReadonlyMap<string, RecipientFacts>,
  limits: B2cLimits,
): ObligationPlan {
  const obligations: PlannedObligation[] = [];
  const carryForwards: PlannedCarryForward[] = [];
  const unverified = new Set<string>();
  for (const line of [...lines].sort((a, b) => compare(a.lineId, b.lineId))) {
    const { payableMinor, carryForwardMinor } = splitNetPay(line.netMinor);
    if (carryForwardMinor > 0)
      carryForwards.push({
        lineId: line.lineId,
        labourerId: line.labourerId,
        amountMinor: carryForwardMinor,
      });
    if (payableMinor === 0) continue;
    const decision = obligationChannel({
      payeePhoneBidx: line.payeePhoneBidx,
      amountMinor: payableMinor,
      limits,
    });
    const recipient = recipients.get(line.labourerId);
    const verified =
      line.payeePhoneBidx !== null &&
      recipient?.currentPhoneBidx === line.payeePhoneBidx &&
      recipient.verificationId !== null;
    if (line.payeePhoneBidx !== null && !verified) unverified.add(line.labourerId);
    obligations.push({
      lineId: line.lineId,
      labourerId: line.labourerId,
      amountMinor: payableMinor,
      carryForwardMinor,
      channel: decision.channel,
      manualReason: decision.manualReason,
      destinationBidx: line.payeePhoneBidx,
      verificationId: verified ? (recipient?.verificationId ?? null) : null,
    });
  }
  return { obligations, carryForwards, unverifiedLabourerIds: [...unverified].sort(compare) };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped, arrays in order. The same
 * algorithm as the API's attendance/payroll digests, so `sha256(canonicalJson(x))` agrees.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export type ApprovalSnapshot = {
  batchId: string;
  version: number;
  digest: string;
  obligations: {
    lineId: string;
    labourerId: string;
    amountMinor: number;
    carryForwardMinor: number;
    channel: PayrollObligationChannel;
    destinationBidx: string | null;
    verificationId: string | null;
  }[];
  /** Lines whose whole net (below KES 1) is carried forward: no obligation. */
  carryForwardOnly: { lineId: string; labourerId: string; carryForwardMinor: number }[];
};

/**
 * What the approver approves (§2, D-167): the batch identity, version and snapshot digest, every
 * obligation with the cents its line carries forward, and the lines that only carry cents forward
 * (each sorted by line ID). `approvalDigest = sha256(approvalSnapshotText(…))`, computed by the
 * readiness endpoint and recomputed by the approve command (409 `snapshot-changed`).
 */
export function approvalSnapshot(input: {
  batchId: string;
  version: number;
  digest: string;
  obligations: readonly PlannedObligation[];
  carryForwards: readonly PlannedCarryForward[];
}): ApprovalSnapshot {
  const withObligation = new Set(input.obligations.map((obligation) => obligation.lineId));
  return {
    batchId: input.batchId,
    version: input.version,
    digest: input.digest,
    obligations: [...input.obligations]
      .sort((a, b) => compare(a.lineId, b.lineId))
      .map((obligation) => ({
        lineId: obligation.lineId,
        labourerId: obligation.labourerId,
        amountMinor: obligation.amountMinor,
        carryForwardMinor: obligation.carryForwardMinor,
        channel: obligation.channel,
        destinationBidx: obligation.destinationBidx,
        verificationId: obligation.verificationId,
      })),
    carryForwardOnly: input.carryForwards
      .filter((carry) => !withObligation.has(carry.lineId))
      .sort((a, b) => compare(a.lineId, b.lineId))
      .map((carry) => ({
        lineId: carry.lineId,
        labourerId: carry.labourerId,
        carryForwardMinor: carry.amountMinor,
      })),
  };
}

/** The canonical text whose SHA-256 (hex) is the approval digest. */
export const approvalSnapshotText = (snapshot: ApprovalSnapshot): string => canonicalJson(snapshot);

/**
 * The action hash of a decision row (non-repudiation, T-12, A-17), hashed with SHA-256 by the API:
 * `batchId|version|digest|approvalDigest|net|action` (empty for a missing approval digest).
 */
export const decisionActionText = (input: {
  batchId: string;
  version: number;
  digest: string;
  approvalDigest: string | null;
  netMinor: number;
  action: string;
}): string =>
  [
    input.batchId,
    input.version,
    input.digest,
    input.approvalDigest ?? "",
    input.netMinor,
    input.action,
  ].join("|");

// Unusual-payout flags ---------------------------------------------------------------------------

export type FlagCandidate = {
  /** The obligation (or, before it exists, its line) the flag will belong to. */
  key: string;
  labourerId: string;
  amountMinor: number;
  destinationBidx: string | null;
};

export type EvaluatedFlag = {
  key: string;
  code: Extract<PayoutFlagCode, "new_recipient_large" | "shared_number">;
  /** Safe details: amounts, thresholds and counts, never numbers or names. */
  details: Record<string, number>;
};

/**
 * Flags evaluated at approval (§7): `new_recipient_large` when no earlier confirmed payroll payout
 * went to the destination and the amount is at or above the threshold; `shared_number` when the
 * destination is also the number of another active labourer of the company, or appears on more
 * than one obligation of the batch (A-01).
 */
export function evaluateApprovalFlags(input: {
  candidates: readonly FlagCandidate[];
  /** Destination blind indexes with an earlier confirmed payroll payout in the company. */
  paidDestinations: ReadonlySet<string>;
  /** Phone blind index → active labourers of the company holding it. */
  activeLabourersByBidx: ReadonlyMap<string, readonly string[]>;
  unusualNewRecipientMinor: number;
}): EvaluatedFlag[] {
  const inBatch = new Map<string, number>();
  for (const candidate of input.candidates)
    if (candidate.destinationBidx)
      inBatch.set(candidate.destinationBidx, (inBatch.get(candidate.destinationBidx) ?? 0) + 1);
  const flags: EvaluatedFlag[] = [];
  for (const candidate of [...input.candidates].sort((a, b) => compare(a.key, b.key))) {
    const bidx = candidate.destinationBidx;
    if (!bidx) continue;
    if (
      !input.paidDestinations.has(bidx) &&
      candidate.amountMinor >= input.unusualNewRecipientMinor
    )
      flags.push({
        key: candidate.key,
        code: "new_recipient_large",
        details: {
          amountMinor: candidate.amountMinor,
          thresholdMinor: input.unusualNewRecipientMinor,
        },
      });
    const others = (input.activeLabourersByBidx.get(bidx) ?? []).filter(
      (labourerId) => labourerId !== candidate.labourerId,
    ).length;
    const obligations = inBatch.get(bidx) ?? 0;
    if (others > 0 || obligations > 1)
      flags.push({
        key: candidate.key,
        code: "shared_number",
        details: { otherLabourers: others, obligationsInBatch: obligations },
      });
  }
  return flags;
}

// Eligibility ------------------------------------------------------------------------------------

/** When the change hold after a number change ends (OR-05), or null when none applies. */
export function changeHoldUntil(phoneChangedAt: string | null, holdHours: number): string | null {
  if (!phoneChangedAt || holdHours <= 0) return null;
  const changed = Date.parse(phoneChangedAt);
  if (Number.isNaN(changed)) return null;
  return new Date(changed + holdHours * 3_600_000).toISOString();
}

export type EligibilityFacts = {
  status: PayrollObligationStatus;
  channel: PayrollObligationChannel;
  outstandingMinor: number;
  /** A live payout (M-Pesa `active` or manual `pending_confirmation`). */
  livePayout: boolean;
  /** A payout whose D4.2 request is `uncertain` or `reversal_pending`. */
  uncertainPayout: boolean;
  destinationBidx: string | null;
  currentPhoneBidx: string | null;
  /** A verification exists for the labourer's current phone blind index. */
  currentNumberVerified: boolean;
  activeHolds: number;
  /** `labourers.phone_changed_at` (null for numbers older than D4.3). */
  phoneChangedAt: string | null;
  /** An owner's override exists for the current change hold. */
  changeHoldOverridden: boolean;
  openFlags: number;
  limits: B2cLimits;
  payeeChangeHoldHours: number;
  now: Date;
};

export type RecipientBlockFacts = Pick<
  EligibilityFacts,
  | "currentPhoneBidx"
  | "currentNumberVerified"
  | "activeHolds"
  | "phoneChangedAt"
  | "changeHoldOverridden"
  | "payeeChangeHoldHours"
  | "now"
>;

/**
 * What blocks M-Pesa payouts to a worker whatever the obligation (the worker record's payout
 * status): no verified current number (`unverified`), an active hold, the change hold (§5).
 */
export function recipientBlockReasons(facts: RecipientBlockFacts): PayoutBlockReason[] {
  const reasons: PayoutBlockReason[] = [];
  if (facts.currentPhoneBidx === null || !facts.currentNumberVerified) reasons.push("unverified");
  if (facts.activeHolds > 0) reasons.push("on-hold");
  const until = changeHoldUntil(facts.phoneChangedAt, facts.payeeChangeHoldHours);
  if (until && !facts.changeHoldOverridden && facts.now.getTime() < Date.parse(until))
    reasons.push("change-hold");
  return reasons;
}

/**
 * Why an obligation cannot get a new M-Pesa payout now (§4); empty means eligible. A settled or
 * manual-channel obligation reports only that; otherwise every reason that applies is listed.
 */
export function payoutBlockReasons(facts: EligibilityFacts): PayoutBlockReason[] {
  if (facts.status === "settled" || facts.outstandingMinor <= 0) return ["settled"];
  if (facts.channel === "manual") return ["manual-channel"];
  const reasons: PayoutBlockReason[] = [];
  if (facts.livePayout) reasons.push("in-flight");
  if (facts.uncertainPayout) reasons.push("uncertain");
  if (!isMpesaPayable(facts.outstandingMinor, facts.limits)) reasons.push("not-payable-by-mpesa");
  if (facts.currentPhoneBidx === null || facts.currentPhoneBidx !== facts.destinationBidx)
    reasons.push("destination-changed");
  reasons.push(...recipientBlockReasons(facts));
  if (facts.openFlags > 0) reasons.push("flagged");
  return reasons;
}

// Status for display -----------------------------------------------------------------------------

/**
 * One payout's status as shown: an M-Pesa payout mirrors its D4.2 attempt while active (and shows
 * a pending reversal of a confirmed one); a manual payout shows its own state.
 */
export function payoutDisplayStatus(
  payout: { method: PayrollPayoutMethod; status: PayrollPayoutStatus },
  attemptStatus: PaymentAttemptStatus | null,
): PayoutDisplayStatus {
  switch (payout.status) {
    case "pending_confirmation":
    case "rejected":
    case "failed":
    case "reversed":
      return payout.status;
    case "confirmed":
      return payout.method === "mpesa" && attemptStatus === "reversal_pending"
        ? "reversal_pending"
        : "confirmed";
    case "active":
      switch (attemptStatus) {
        case "submitting":
        case "pending":
        case "confirmed":
        case "failed":
        case "reversal_pending":
        case "reversed":
          return attemptStatus;
        case "unknown":
          return "uncertain";
        default:
          return "queued";
      }
  }
}

const IN_FLIGHT: readonly PayoutDisplayStatus[] = [
  "queued",
  "submitting",
  "pending",
  "pending_confirmation",
];

/** The worker row's status on the payouts screen (latest payout first, then money, then blocks). */
export function obligationProgress(input: {
  status: PayrollObligationStatus;
  paidMinor: number;
  blockReasons: readonly PayoutBlockReason[];
  latestPayout: PayoutDisplayStatus | null;
}): ObligationProgressStatus {
  if (input.status === "settled") return "settled";
  const latest = input.latestPayout;
  if (latest && IN_FLIGHT.includes(latest)) return "in_flight";
  if (latest === "uncertain" || latest === "reversal_pending") return "uncertain";
  if (latest === "reversed") return "reversed";
  if (latest === "failed" || latest === "rejected") return "failed";
  if (input.paidMinor > 0) return "partially_paid";
  return input.blockReasons.length > 0 ? "blocked" : "ready";
}

// Cash and bank ----------------------------------------------------------------------------------

export type ManualPaymentProblem =
  "obligation-settled" | "payout-in-flight" | "amount-above-outstanding";

/**
 * Whether a cash or bank payment may be recorded against an obligation (§15): something is
 * outstanding, no live or uncertain payout exists, and the amount is at most the outstanding.
 */
export function manualPaymentProblem(input: {
  status: PayrollObligationStatus;
  outstandingMinor: number;
  livePayout: boolean;
  uncertainPayout: boolean;
  amountMinor: number;
}): ManualPaymentProblem | null {
  if (input.status === "settled" || input.outstandingMinor <= 0) return "obligation-settled";
  if (input.livePayout || input.uncertainPayout) return "payout-in-flight";
  if (input.amountMinor > input.outstandingMinor) return "amount-above-outstanding";
  return null;
}

export type CashCapCheck =
  | { ok: true; capMinor: number; usedMinor: number; remainingMinor: number }
  | { ok: false; code: "cash-disabled" }
  | {
      ok: false;
      code: "cash-cap-exceeded";
      capMinor: number;
      usedMinor: number;
      remainingMinor: number;
    };

/**
 * The cash cap per worker per pay period (owner decision 2, OR-06): cash already recorded to the
 * worker (pending and confirmed) for batches of the same pay period plus this payment must stay
 * within the cap; a cap of 0 disables cash (409 `cash-disabled`, `cash-cap-exceeded`).
 */
export function checkCashCap(input: {
  capMinor: number;
  usedMinor: number;
  amountMinor: number;
}): CashCapCheck {
  if (input.capMinor <= 0) return { ok: false, code: "cash-disabled" };
  const remainingMinor = Math.max(0, input.capMinor - input.usedMinor);
  if (input.amountMinor > remainingMinor)
    return {
      ok: false,
      code: "cash-cap-exceeded",
      capMinor: input.capMinor,
      usedMinor: input.usedMinor,
      remainingMinor,
    };
  return {
    ok: true,
    capMinor: input.capMinor,
    usedMinor: input.usedMinor,
    remainingMinor: remainingMinor - input.amountMinor,
  };
}
