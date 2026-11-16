import { changeHoldUntil, maskPhone, payoutDisplayStatus } from "@pm-buddy/domain";
import type {
  ManualChannelReason,
  NameCheckResult,
  PayoutBlockReason,
  PayoutFlagCode,
  PayrollNotificationKind,
  PayslipNoticeState,
} from "@pm-buddy/types";
import type {
  BatchDecision,
  CarryForward,
  ChangeHold,
  Obligation,
  PaymentEvidence,
  PayoutFlag,
  PayoutHold,
  PayrollNotification,
  PayrollPayout,
  RecipientVerification,
} from "@pm-buddy/validation";
import type {
  LabourerPayoutHold,
  LabourerPayoutVerification,
  PayrollBatchDecision,
  PayrollCarryForward,
  PayrollNotification as NotificationRow,
  PayrollPayoutEvidence,
  PayrollPayoutFlag,
} from "../../generated/prisma/client.js";
import { toCalendarDate } from "../projects/project-mappers.js";
import { attemptStatusOf, type PayoutWithRequest, type RecipientState } from "./payout-facts.js";
import { minor } from "./payouts-support.js";

export type Names = ReadonlyMap<string, string>;
export const actorOf = (names: Names, id: string) => ({
  id,
  displayName: names.get(id) ?? "—",
});
export const optionalActor = (names: Names, id: string | null | undefined) =>
  id ? actorOf(names, id) : null;
const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

export function toDecision(row: PayrollBatchDecision, names: Names): BatchDecision {
  return {
    id: row.id,
    action: row.action as BatchDecision["action"],
    actor: actorOf(names, row.actorId),
    batchVersion: row.batchVersion,
    digest: row.digest,
    approvalDigest: row.approvalDigest,
    netMinor: minor(row.netMinor),
    appliedLimitMinor: row.appliedLimitMinor === null ? null : minor(row.appliedLimitMinor),
    underWaiver: row.underWaiver,
    stepUpAt: iso(row.stepUpAt),
    actionHash: row.actionHash,
    note: row.note,
    obligationId: row.obligationId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toVerification(
  row: LabourerPayoutVerification,
  currentBidx: string | null,
  names: Names,
): RecipientVerification {
  return {
    id: row.id,
    method: row.method as RecipientVerification["method"],
    note: row.note,
    phoneMasked: row.phoneMasked,
    current: currentBidx !== null && row.phoneBidx === currentBidx,
    verifiedBy: actorOf(names, row.verifiedBy),
    verifiedAt: row.verifiedAt.toISOString(),
  };
}

export function toHold(row: LabourerPayoutHold, names: Names): PayoutHold {
  return {
    id: row.id,
    labourerId: row.labourerId,
    kind: row.kind as PayoutHold["kind"],
    state: row.releasedAt ? "released" : "active",
    phoneMasked: row.phoneMasked,
    reason: row.reason,
    payoutId: row.payoutId,
    createdBy: optionalActor(names, row.createdBy),
    createdAt: row.createdAt.toISOString(),
    releasedBy: optionalActor(names, row.releasedBy),
    releasedAt: iso(row.releasedAt),
    releaseReason: row.releaseReason,
  };
}

/** The change hold after the current number change (OR-05), null when there was none. */
export function toChangeHold(
  recipient: RecipientState,
  holdHours: number,
  now: Date,
  names: Names,
): ChangeHold | null {
  if (!recipient.phoneChangedAt) return null;
  const until = changeHoldUntil(recipient.phoneChangedAt.toISOString(), holdHours);
  const end = until ?? recipient.phoneChangedAt.toISOString();
  return {
    changedAt: recipient.phoneChangedAt.toISOString(),
    changedBy: optionalActor(names, recipient.phoneChangedBy),
    until: end,
    active: !recipient.override && now.getTime() < Date.parse(end),
    override: recipient.override
      ? {
          by: actorOf(names, recipient.override.createdBy),
          at: recipient.override.createdAt.toISOString(),
          reason: recipient.override.reason,
        }
      : null,
  };
}

export function toFlag(row: PayrollPayoutFlag, names: Names): PayoutFlag {
  return {
    id: row.id,
    obligationId: row.obligationId,
    code: row.code as PayoutFlagCode,
    status: row.status as PayoutFlag["status"],
    details: (row.details ?? {}) as PayoutFlag["details"],
    createdAt: row.createdAt.toISOString(),
    createdBy: optionalActor(names, row.createdBy),
    clearedBy: optionalActor(names, row.clearedBy),
    clearedAt: iso(row.clearedAt),
    clearReason: row.clearReason,
  };
}

export function toEvidence(row: PayrollPayoutEvidence, names: Names): PaymentEvidence {
  return {
    id: row.id,
    contentType: row.contentType as PaymentEvidence["contentType"],
    sizeBytes: row.sizeBytes,
    scanStatus: row.scanStatus as PaymentEvidence["scanStatus"],
    uploadedAt: row.uploadedAt.toISOString(),
    uploadedBy: actorOf(names, row.uploadedBy),
  };
}

export function toPayout(
  entry: PayoutWithRequest,
  evidence: readonly PayrollPayoutEvidence[],
  names: Names,
  receiverName: string | null,
): PayrollPayout {
  const { payout, request } = entry;
  const method = payout.method as PayrollPayout["method"];
  const status = payout.status as PayrollPayout["status"];
  return {
    id: payout.id,
    obligationId: payout.obligationId,
    method,
    amountMinor: minor(payout.amountMinor),
    status,
    displayStatus: payoutDisplayStatus({ method, status }, attemptStatusOf(entry)),
    version: payout.version,
    paymentRequestId: payout.paymentRequestId,
    requestStatus: (request?.status ?? null) as PayrollPayout["requestStatus"],
    receipt: payout.receipt,
    failure:
      status === "failed"
        ? { code: payout.resultCode, description: payout.resultDesc }
        : null,
    chargeMinor: payout.chargeMinor === null ? null : minor(payout.chargeMinor),
    nameCheck: payout.nameCheck
      ? {
          result: payout.nameCheck as NameCheckResult,
          score: payout.nameScore === null ? null : Number(payout.nameScore.toString()),
          receiverName,
        }
      : null,
    reference: payout.reference,
    paidOn: payout.paidOn ? toCalendarDate(payout.paidOn) : null,
    reason: payout.reason,
    evidence: evidence
      .filter((row) => row.payoutId === payout.id)
      .map((row) => toEvidence(row, names)),
    createdBy: optionalActor(names, payout.createdBy),
    confirmedBy: optionalActor(names, payout.confirmedBy),
    confirmedAt: iso(payout.confirmedAt),
    rejectionReason: payout.rejectionReason,
    createdAt: payout.createdAt.toISOString(),
    finishedAt: iso(payout.finishedAt),
  };
}

export function toNotification(row: NotificationRow): PayrollNotification {
  return {
    id: row.id,
    kind: row.kind as PayrollNotificationKind,
    channel: row.channel as PayrollNotification["channel"],
    recipientMasked: row.recipientMasked,
    language: row.language as PayrollNotification["language"],
    status: row.status as PayrollNotification["status"],
    attempts: row.attempts,
    nextAttemptAt: iso(row.nextAttemptAt),
    lastErrorCode: row.lastErrorCode as PayrollNotification["lastErrorCode"],
    sentAt: iso(row.sentAt),
    createdAt: row.createdAt.toISOString(),
  };
}

/** A carry-forward line reference (the batch line that created or consumed it). */
export type LineRef = {
  batchId: string;
  lineId: string;
  projectId: string;
  periodStart: string;
  periodEnd: string;
};

export function toCarryForward(
  row: PayrollCarryForward,
  labourer: { id: string; workerNo: string; fullName: string },
  source: LineRef,
  consumed: { by: LineRef; at: Date } | null,
): CarryForward {
  return {
    id: row.id,
    labourer,
    amountMinor: minor(row.amountMinor),
    status: consumed ? "consumed" : "open",
    source,
    consumedBy: consumed?.by ?? null,
    createdAt: row.createdAt.toISOString(),
    consumedAt: consumed ? consumed.at.toISOString() : null,
  };
}

/** The payslip column: not due until settled; no number; else the notification's state. */
export function payslipState(
  settled: boolean,
  hasNumber: boolean,
  notification: NotificationRow | null,
): { state: PayslipNoticeState; notification: PayrollNotification | null } {
  if (notification)
    return {
      state: notification.status as PayslipNoticeState,
      notification: toNotification(notification),
    };
  if (!settled) return { state: "not_due", notification: null };
  return { state: hasNumber ? "queued" : "no_number", notification: null };
}

export type ObligationExtras = {
  lineNetMinor: number;
  broughtForwardMinor: number;
  carryForwardMinor: number;
  labourer: { id: string; workerNo: string; fullName: string };
  destinationMasked: string | null;
  currentPhoneMasked: string | null;
  progress: Obligation["progress"];
  blockReasons: PayoutBlockReason[];
  changeHoldUntil: string | null;
  flags: PayoutFlag[];
  payouts: PayrollPayout[];
  payslip: Obligation["payslip"];
};

export function toObligation(
  row: {
    id: string;
    batchId: string;
    projectId: string;
    lineId: string;
    amountMinor: bigint;
    paidMinor: bigint;
    status: string;
    channel: string;
    manualReason: string | null;
    verificationId: string | null;
    destinationApprovedBy: string;
    destinationApprovedAt: Date;
    version: number;
    createdAt: Date;
  },
  extras: ObligationExtras,
  names: Names,
): Obligation {
  return {
    id: row.id,
    batchId: row.batchId,
    projectId: row.projectId,
    lineId: row.lineId,
    labourer: extras.labourer,
    amountMinor: minor(row.amountMinor),
    paidMinor: minor(row.paidMinor),
    outstandingMinor: minor(row.amountMinor) - minor(row.paidMinor),
    lineNetMinor: extras.lineNetMinor,
    broughtForwardMinor: extras.broughtForwardMinor,
    carryForwardMinor: extras.carryForwardMinor,
    status: row.status as Obligation["status"],
    channel: row.channel as Obligation["channel"],
    manualReason: row.manualReason as ManualChannelReason | null,
    destinationMasked: extras.destinationMasked,
    currentPhoneMasked: extras.currentPhoneMasked,
    verificationId: row.verificationId,
    destinationApprovedBy: optionalActor(names, row.destinationApprovedBy),
    destinationApprovedAt: row.destinationApprovedAt.toISOString(),
    progress: extras.progress,
    blockReasons: extras.blockReasons,
    changeHoldUntil: extras.changeHoldUntil,
    flags: extras.flags,
    payouts: extras.payouts,
    payslip: extras.payslip,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}

export { maskPhone };
