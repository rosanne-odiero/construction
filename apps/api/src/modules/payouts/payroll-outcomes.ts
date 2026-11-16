import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { checkRecipientName, maskPhone, nairobiDate } from "@pm-buddy/domain";
import { uuidv7 } from "../../common/uuid.js";
import type { PayrollPayout, Prisma } from "../../generated/prisma/client.js";
import { LabourCrypto } from "../labour/labour-support.js";
import {
  PaymentOutcomeHandlers,
  type PaymentOutcome,
  type PaymentOutcomeHandler,
} from "../payments/outcome-handlers.js";
import { PaymentLedger } from "../payments/payment-ledger.js";
import { PAYMENTS_SYSTEM_ACTOR } from "../payments/payments-support.js";
import { chargeOn, tariffVersions } from "../payments/tariffs.service.js";
import { refreshBatchStatus } from "./payout-facts.js";
import { loadPayoutSettings } from "./payout-settings.service.js";
import { lockBatch, minor } from "./payouts-support.js";
import { reversePayout, settlePayout } from "./settlement.js";

type Tx = Prisma.TransactionClient;

/** Why an outcome could not be applied to its payout (reconciliation case reasons). */
type Discrepancy =
  | "payroll_unknown_payout"
  | "payroll_amount_mismatch"
  | "payroll_outcome_state"
  | "payroll_outcome_refused";

/**
 * What a final D4.2 outcome of a `payroll_obligation` request means for its payout (§8), in the
 * transaction that records the outcome. Never throws for business reasons: anything that cannot
 * be applied (an unknown payout, a different amount, an impossible state, a refused write) is
 * rolled back to a savepoint, opened as a reconciliation case and alerted, while D4.2 keeps the
 * outcome. Duplicates are no-ops (state checks; one allocation per payout).
 */
@Injectable()
export class PayrollOutcomeHandler implements PaymentOutcomeHandler, OnModuleInit {
  readonly purpose = "payroll_obligation" as const;
  private readonly logger = new Logger(PayrollOutcomeHandler.name);

  constructor(
    private readonly handlers: PaymentOutcomeHandlers,
    private readonly ledger: PaymentLedger,
    private readonly labourCrypto: LabourCrypto,
  ) {}

  onModuleInit() {
    this.handlers.register(this);
  }

  async handle(tx: Tx, outcome: PaymentOutcome): Promise<void> {
    await tx.$executeRawUnsafe("SAVEPOINT payroll_outcome");
    let problem: Discrepancy | null;
    try {
      problem = await this.apply(tx, outcome);
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT payroll_outcome");
    } catch (error) {
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT payroll_outcome");
      this.logger.warn(
        `Payroll outcome for request ${outcome.requestId} was refused: ${(error as Error).name}`,
      );
      problem = "payroll_outcome_refused";
    }
    if (problem) await this.discrepancy(tx, outcome, problem);
  }

  private async apply(tx: Tx, outcome: PaymentOutcome): Promise<Discrepancy | null> {
    const payoutId = outcome.purposeRef;
    if (!payoutId) return "payroll_unknown_payout";
    const head = await tx.payrollPayout.findUnique({
      where: { tenantId_id: { tenantId: outcome.tenantId, id: payoutId } },
    });
    if (!head || head.paymentRequestId !== outcome.requestId || head.method !== "mpesa")
      return "payroll_unknown_payout";
    await lockBatch(tx, outcome.tenantId, head.batchId);
    const payout = await tx.payrollPayout.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: outcome.tenantId, id: payoutId } },
    });
    switch (outcome.outcome) {
      case "confirmed":
        return this.confirmed(tx, payout, outcome);
      case "failed":
        return this.failed(tx, payout, outcome);
      case "reversed":
        return this.reversed(tx, payout);
    }
  }

  private async confirmed(
    tx: Tx,
    payout: PayrollPayout,
    outcome: PaymentOutcome,
  ): Promise<Discrepancy | null> {
    if (payout.status === "confirmed" || payout.status === "reversed") return null;
    if (payout.status !== "active") return "payroll_outcome_state";
    // D4.2 quarantines amount mismatches already; never allocate a different amount.
    if (outcome.amountMinor !== minor(payout.amountMinor)) return "payroll_amount_mismatch";
    const { tenantId } = payout;
    const settings = await loadPayoutSettings(tx, tenantId);
    const labourer = await tx.labourer.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: payout.labourerId } },
      select: { fullName: true, phoneEnc: true, phoneBidx: true },
    });
    const check = checkRecipientName({
      receiverName: outcome.receiverName ?? null,
      registeredName: labourer.fullName,
      threshold: settings.nameMatchThreshold,
    });
    const paidOn = nairobiDate();
    const charge = chargeOn(await tariffVersions(tx, tenantId), paidOn, minor(payout.amountMinor));
    const updated = await tx.payrollPayout.updateMany({
      where: { tenantId, id: payout.id, version: payout.version, status: "active" },
      data: {
        status: "confirmed",
        receipt: outcome.receipt,
        paidOn: new Date(`${paidOn}T00:00:00.000Z`),
        chargeMinor: charge ? BigInt(charge.chargeMinor) : null,
        tariffVersionId: charge?.versionId ?? null,
        nameCheck: check.result,
        nameScore: check.score,
        receiverNameEnc:
          check.result === "mismatch" && outcome.receiverName
            ? this.labourCrypto.cipher.encrypt(
                {
                  tenantId,
                  table: "payroll_payouts",
                  column: "receiver_name_enc",
                  rowId: payout.id,
                },
                outcome.receiverName,
              )
            : null,
        version: { increment: 1 },
      },
    });
    if (!updated.count) return "payroll_outcome_state";
    const confirmed = await tx.payrollPayout.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: payout.id } },
    });
    const settled = await settlePayout(tx, this.labourCrypto, confirmed, PAYMENTS_SYSTEM_ACTOR);
    if (check.result === "mismatch") {
      if (settings.nameMismatchHold) {
        const destination =
          labourer.phoneBidx === payout.destinationBidx && labourer.phoneEnc
            ? maskPhone(
                this.labourCrypto.open(tenantId, payout.labourerId, "phone_enc", labourer.phoneEnc),
              )
            : null;
        await tx.labourerPayoutHold.create({
          data: {
            id: uuidv7(),
            tenantId,
            labourerId: payout.labourerId,
            kind: "name_mismatch",
            phoneBidx: payout.destinationBidx,
            phoneMasked: destination,
            reason: "The M-Pesa receiver name did not match the worker's registered name.",
            payoutId: payout.id,
          },
        });
      }
      this.logger.warn(
        `ALERT payroll payout ${payout.id}: the M-Pesa receiver name did not match (score ${check.score ?? "n/a"})`,
      );
    }
    await this.ledger.audit(tx, "payroll.payout_confirmed", payout.id, {
      batchId: payout.batchId,
      obligationId: payout.obligationId,
      nameCheck: check.result,
      settled,
    });
    return null;
  }

  private async failed(
    tx: Tx,
    payout: PayrollPayout,
    outcome: PaymentOutcome,
  ): Promise<Discrepancy | null> {
    if (payout.status === "failed") return null;
    if (payout.status !== "active") return "payroll_outcome_state";
    const attempt = await tx.paymentAttempt.findUnique({
      where: { tenantId_id: { tenantId: payout.tenantId, id: outcome.attemptId } },
      select: { resultCode: true, resultDesc: true },
    });
    const updated = await tx.payrollPayout.updateMany({
      where: { tenantId: payout.tenantId, id: payout.id, version: payout.version, status: "active" },
      data: {
        status: "failed",
        resultCode: attempt?.resultCode?.slice(0, 20) ?? null,
        resultDesc: attempt?.resultDesc?.slice(0, 300) ?? null,
        version: { increment: 1 },
      },
    });
    if (!updated.count) return "payroll_outcome_state";
    await refreshBatchStatus(tx, payout.tenantId, payout.batchId);
    await this.ledger.audit(tx, "payroll.payout_failed", payout.id, {
      batchId: payout.batchId,
      obligationId: payout.obligationId,
      resultCode: attempt?.resultCode ?? null,
    });
    return null;
  }

  private async reversed(tx: Tx, payout: PayrollPayout): Promise<Discrepancy | null> {
    if (payout.status === "reversed") return null;
    if (payout.status !== "confirmed") return "payroll_outcome_state";
    const updated = await tx.payrollPayout.updateMany({
      where: {
        tenantId: payout.tenantId,
        id: payout.id,
        version: payout.version,
        status: "confirmed",
      },
      data: { status: "reversed", version: { increment: 1 } },
    });
    if (!updated.count) return "payroll_outcome_state";
    const reversed = await tx.payrollPayout.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: payout.tenantId, id: payout.id } },
    });
    await reversePayout(tx, reversed, PAYMENTS_SYSTEM_ACTOR);
    await this.ledger.audit(tx, "payroll.payout_reversed", payout.id, {
      batchId: payout.batchId,
      obligationId: payout.obligationId,
    });
    this.logger.warn(
      `ALERT payroll payout ${payout.id} was reversed; its obligation is open again`,
    );
    return null;
  }

  /** Records what could not be applied for reconciliation and alerts (never throws). */
  private async discrepancy(tx: Tx, outcome: PaymentOutcome, reason: Discrepancy) {
    await this.ledger.openCase(
      tx,
      outcome.tenantId,
      "conflicting_evidence",
      reason,
      { requestId: outcome.requestId, attemptId: outcome.attemptId },
      null,
    );
    await this.ledger.audit(tx, "payroll.payout_outcome_discrepancy", outcome.requestId, {
      attemptId: outcome.attemptId,
      outcome: outcome.outcome,
      reason,
    });
    this.logger.warn(
      `ALERT payroll outcome ${outcome.outcome} of request ${outcome.requestId} not applied: ${reason}`,
    );
  }
}
