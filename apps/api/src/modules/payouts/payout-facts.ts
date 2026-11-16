import { recomputeBatchStatus, type EligibilityFacts } from "@pm-buddy/domain";
import {
  DEMO_PAYMENT_LIMITS,
  type Locale,
  type PaymentAttemptStatus,
  type PaymentLimits,
  type PayrollBatchStatus,
} from "@pm-buddy/types";
import type {
  LabourerChangeHoldOverride,
  LabourerPayoutHold,
  LabourerPayoutVerification,
  PaymentAttempt,
  PaymentRequest,
  PayrollObligation,
  PayrollPayout,
  PayrollPayoutFlag,
  Prisma,
} from "../../generated/prisma/client.js";
import type { LabourCrypto } from "../labour/labour-support.js";
import { minor, payoutVersionConflict } from "./payouts-support.js";

type Tx = Prisma.TransactionClient;
type B2cLimits = Pick<PaymentLimits, "b2cMinMinor" | "b2cMaxMinor">;

/** A worker as the payout rules see them: current number, its verification, holds, change hold. */
export type RecipientState = {
  labourerId: string;
  workerNo: string;
  fullName: string;
  status: string;
  preferredLanguage: Locale;
  version: number;
  createdBy: string;
  phoneBidx: string | null;
  phoneEnc: Uint8Array | null;
  phoneChangedAt: Date | null;
  phoneChangedBy: string | null;
  /** Newest first. */
  verifications: LabourerPayoutVerification[];
  /** The newest verification of the current number (the valid one), if any. */
  currentVerification: LabourerPayoutVerification | null;
  holds: LabourerPayoutHold[];
  activeHolds: LabourerPayoutHold[];
  /** The owner's override of the current change hold, if any. */
  override: LabourerChangeHoldOverride | null;
};

/** Loads the payout side of the given labourers (all in one company transaction). */
export async function loadRecipients(
  tx: Tx,
  tenantId: string,
  labourerIds: readonly string[],
): Promise<Map<string, RecipientState>> {
  const ids = [...new Set(labourerIds)];
  const result = new Map<string, RecipientState>();
  if (!ids.length) return result;
  const labourers = await tx.labourer.findMany({ where: { tenantId, id: { in: ids } } });
  const verifications = await tx.labourerPayoutVerification.findMany({
    where: { tenantId, labourerId: { in: ids } },
    orderBy: [{ verifiedAt: "desc" }, { id: "desc" }],
  });
  const holds = await tx.labourerPayoutHold.findMany({
    where: { tenantId, labourerId: { in: ids } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const overrides = await tx.labourerChangeHoldOverride.findMany({
    where: { tenantId, labourerId: { in: ids } },
  });
  for (const row of labourers) {
    const own = verifications.filter((entry) => entry.labourerId === row.id);
    const mine = holds.filter((entry) => entry.labourerId === row.id);
    result.set(row.id, {
      labourerId: row.id,
      workerNo: row.workerNo,
      fullName: row.fullName,
      status: row.status,
      preferredLanguage: row.preferredLanguage as Locale,
      version: row.version,
      createdBy: row.createdBy,
      phoneBidx: row.phoneBidx,
      phoneEnc: row.phoneEnc,
      phoneChangedAt: row.phoneChangedAt,
      phoneChangedBy: row.phoneChangedBy,
      verifications: own,
      currentVerification: row.phoneBidx
        ? (own.find((entry) => entry.phoneBidx === row.phoneBidx) ?? null)
        : null,
      holds: mine,
      activeHolds: mine.filter((entry) => entry.releasedAt === null),
      override:
        row.phoneChangedAt === null
          ? null
          : (overrides.find(
              (entry) =>
                entry.labourerId === row.id &&
                entry.phoneChangedAt.getTime() === row.phoneChangedAt!.getTime(),
            ) ?? null),
    });
  }
  return result;
}

/** The labourer's current number, decrypted (null without one). */
export function currentPhone(
  crypto: LabourCrypto,
  tenantId: string,
  recipient: Pick<RecipientState, "labourerId" | "phoneEnc">,
): string | null {
  return recipient.phoneEnc
    ? crypto.open(tenantId, recipient.labourerId, "phone_enc", recipient.phoneEnc)
    : null;
}

/** The company's B2C minimum and maximum (DEMO limits while payments are not configured). */
export async function b2cLimits(tx: Tx, tenantId: string): Promise<B2cLimits> {
  const settings = await tx.paymentSettings.findUnique({ where: { tenantId } });
  return settings
    ? { b2cMinMinor: minor(settings.b2cMinMinor), b2cMaxMinor: minor(settings.b2cMaxMinor) }
    : { b2cMinMinor: DEMO_PAYMENT_LIMITS.b2cMinMinor, b2cMaxMinor: DEMO_PAYMENT_LIMITS.b2cMaxMinor };
}

/** A payout with its D4.2 request and the request's latest (non-reversal) attempt. */
export type PayoutWithRequest = {
  payout: PayrollPayout;
  request: PaymentRequest | null;
  attempt: PaymentAttempt | null;
};

/** The payouts of the given obligations, oldest first, with their D4.2 request and attempt. */
export async function loadPayouts(
  tx: Tx,
  tenantId: string,
  obligationIds: readonly string[],
): Promise<PayoutWithRequest[]> {
  if (!obligationIds.length) return [];
  const payouts = await tx.payrollPayout.findMany({
    where: { tenantId, obligationId: { in: [...obligationIds] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const requestIds = payouts.flatMap((row) => (row.paymentRequestId ? [row.paymentRequestId] : []));
  const requests = requestIds.length
    ? await tx.paymentRequest.findMany({ where: { tenantId, id: { in: requestIds } } })
    : [];
  const attempts = requestIds.length
    ? await tx.paymentAttempt.findMany({
        where: { tenantId, requestId: { in: requestIds }, kind: { not: "reversal" } },
        orderBy: { sequence: "desc" },
      })
    : [];
  return payouts.map((payout) => ({
    payout,
    request: requests.find((row) => row.id === payout.paymentRequestId) ?? null,
    attempt: attempts.find((row) => row.requestId === payout.paymentRequestId) ?? null,
  }));
}

const LIVE = new Set(["active", "pending_confirmation"]);
const UNCERTAIN_REQUESTS = new Set(["uncertain", "reversal_pending"]);

/** The facts of the §4 eligibility rule for one obligation. */
export function eligibilityFacts(input: {
  obligation: PayrollObligation;
  recipient: RecipientState | undefined;
  payouts: readonly PayoutWithRequest[];
  flags: readonly PayrollPayoutFlag[];
  limits: B2cLimits;
  payeeChangeHoldHours: number;
  now: Date;
}): EligibilityFacts {
  const { obligation, recipient } = input;
  const own = input.payouts.filter((entry) => entry.payout.obligationId === obligation.id);
  return {
    status: obligation.status as EligibilityFacts["status"],
    channel: obligation.channel as EligibilityFacts["channel"],
    outstandingMinor: minor(obligation.amountMinor) - minor(obligation.paidMinor),
    livePayout: own.some((entry) => LIVE.has(entry.payout.status)),
    uncertainPayout: own.some(
      (entry) => entry.request !== null && UNCERTAIN_REQUESTS.has(entry.request.status),
    ),
    destinationBidx: obligation.destinationBidx,
    currentPhoneBidx: recipient?.phoneBidx ?? null,
    currentNumberVerified: Boolean(recipient?.currentVerification),
    activeHolds: recipient?.activeHolds.length ?? 0,
    phoneChangedAt: recipient?.phoneChangedAt?.toISOString() ?? null,
    changeHoldOverridden: Boolean(recipient?.override),
    openFlags: input.flags.filter(
      (flag) => flag.obligationId === obligation.id && flag.status === "open",
    ).length,
    limits: input.limits,
    payeeChangeHoldHours: input.payeeChangeHoldHours,
    now: input.now,
  };
}

/** The latest attempt status of a payout's request (for the display status). */
export const attemptStatusOf = (entry: PayoutWithRequest): PaymentAttemptStatus | null =>
  (entry.attempt?.status as PaymentAttemptStatus | undefined) ?? null;

/**
 * Recomputes an approved batch's derived status from its obligations and payouts (packages/domain
 * recomputeBatchStatus) and stores it when it moved. The caller holds the batch row lock.
 */
export async function refreshBatchStatus(
  tx: Tx,
  tenantId: string,
  batchId: string,
): Promise<PayrollBatchStatus> {
  const batch = await tx.payrollBatch.findUniqueOrThrow({
    where: { tenantId_id: { tenantId, id: batchId } },
    select: { status: true, version: true },
  });
  const obligations = await tx.payrollObligation.findMany({
    where: { tenantId, batchId },
    select: { amountMinor: true, paidMinor: true },
  });
  const payoutCount = await tx.payrollPayout.count({ where: { tenantId, batchId } });
  const current = batch.status as PayrollBatchStatus;
  const next = recomputeBatchStatus(current, {
    obligations: obligations.map((row) => ({
      amountMinor: minor(row.amountMinor),
      paidMinor: minor(row.paidMinor),
    })),
    payoutCount,
  });
  if (next !== current) {
    const updated = await tx.payrollBatch.updateMany({
      where: { tenantId, id: batchId, version: batch.version },
      data: { status: next, version: { increment: 1 } },
    });
    if (!updated.count) throw payoutVersionConflict();
  }
  return next;
}
