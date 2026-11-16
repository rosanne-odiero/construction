import type { Locale } from "@pm-buddy/types";
import { uuidv7 } from "../../common/uuid.js";
import type { PayrollPayout, Prisma } from "../../generated/prisma/client.js";
import type { LabourCrypto } from "../labour/labour-support.js";
import { enqueueNotification } from "./notification-queue.js";
import { postPayoutCosts, postPayoutReversal } from "./payout-postings.js";
import { refreshBatchStatus } from "./payout-facts.js";

type Tx = Prisma.TransactionClient;

/**
 * A confirmed payout settles its obligation (§4, §8, §10, §15), in the caller's transaction after
 * the payout row moved to `confirmed`: one allocation of its amount (unique per payout, so a
 * duplicate outcome cannot allocate twice; the database refuses more than the obligation), the
 * paid labour and charge cost entries, the batch's derived status and, once the obligation is
 * settled, the worker's payslip SMS. Returns whether the obligation is now settled.
 */
export async function settlePayout(
  tx: Tx,
  crypto: LabourCrypto,
  payout: PayrollPayout,
  actorId: string,
): Promise<boolean> {
  await tx.payrollAllocation.create({
    data: {
      id: uuidv7(),
      tenantId: payout.tenantId,
      obligationId: payout.obligationId,
      payoutId: payout.id,
      kind: "payment",
      amountMinor: payout.amountMinor,
      reference: payout.receipt ?? payout.reference,
    },
  });
  const line = await lineOf(tx, payout);
  await postPayoutCosts(tx, payout, line.fullName, actorId);
  await refreshBatchStatus(tx, payout.tenantId, payout.batchId);
  const obligation = await tx.payrollObligation.findUniqueOrThrow({
    where: { tenantId_id: { tenantId: payout.tenantId, id: payout.obligationId } },
  });
  if (obligation.status !== "settled") return false;
  await queuePayslip(tx, crypto, {
    tenantId: payout.tenantId,
    batchId: payout.batchId,
    obligationId: payout.obligationId,
    labourerId: payout.labourerId,
  });
  return true;
}

/**
 * A reversed payout (§8): the reversal allocation takes its amount back (the obligation reopens),
 * its paid labour entry is reversed (the charge stays: it was incurred) and the batch status is
 * recomputed. Idempotent.
 */
export async function reversePayout(
  tx: Tx,
  payout: PayrollPayout,
  actorId: string,
): Promise<void> {
  const allocation = await tx.payrollAllocation.findFirst({
    where: { tenantId: payout.tenantId, payoutId: payout.id, kind: "payment" },
  });
  if (allocation) {
    const reversed = await tx.payrollAllocation.findFirst({
      where: { tenantId: payout.tenantId, reversesAllocationId: allocation.id },
    });
    if (!reversed)
      await tx.payrollAllocation.create({
        data: {
          id: uuidv7(),
          tenantId: payout.tenantId,
          obligationId: payout.obligationId,
          payoutId: payout.id,
          kind: "reversal",
          amountMinor: -allocation.amountMinor,
          reference: allocation.reference,
          reversesAllocationId: allocation.id,
        },
      });
  }
  await postPayoutReversal(tx, payout, actorId);
  await refreshBatchStatus(tx, payout.tenantId, payout.batchId);
}

/** The payslip SMS of a settled obligation to the worker's current number (none without one). */
export async function queuePayslip(
  tx: Tx,
  crypto: LabourCrypto,
  input: { tenantId: string; batchId: string; obligationId: string; labourerId: string },
): Promise<boolean> {
  const labourer = await tx.labourer.findUniqueOrThrow({
    where: { tenantId_id: { tenantId: input.tenantId, id: input.labourerId } },
    select: { id: true, phoneEnc: true, preferredLanguage: true },
  });
  if (!labourer.phoneEnc) return false;
  await enqueueNotification(tx, crypto.cipher, {
    tenantId: input.tenantId,
    kind: "payslip",
    subjectKey: `obligation:${input.obligationId}`,
    channel: "sms",
    recipient: crypto.open(input.tenantId, labourer.id, "phone_enc", labourer.phoneEnc),
    language: labourer.preferredLanguage as Locale,
    batchId: input.batchId,
    obligationId: input.obligationId,
    labourerId: input.labourerId,
  });
  return true;
}

async function lineOf(tx: Tx, payout: PayrollPayout) {
  const obligation = await tx.payrollObligation.findUniqueOrThrow({
    where: { tenantId_id: { tenantId: payout.tenantId, id: payout.obligationId } },
    select: { lineId: true },
  });
  return tx.payrollLine.findUniqueOrThrow({
    where: { tenantId_id: { tenantId: payout.tenantId, id: obligation.lineId } },
    select: { fullName: true },
  });
}
