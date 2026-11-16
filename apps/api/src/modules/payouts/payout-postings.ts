import { uuidv7 } from "../../common/uuid.js";
import type { PayrollPayout, Prisma } from "../../generated/prisma/client.js";

type Tx = Prisma.TransactionClient;

/** Who an M-Pesa charge is paid to, on the fee entries (app.check_cost_entry checks it). */
export const MPESA_CHARGE_COUNTERPARTY = "Safaricom M-Pesa";

const name = (fullName: string) => fullName.slice(0, 200);

/**
 * Payroll cost at approval (D4.3 §10, owner decision 1, CR-SPD-05 proposed policy): for each line
 * of the batch, its gross as accrued labour per BQ item its earnings reach
 * (app.payroll_line_cost_groups: piece-rate output on a job or BQ item; everything else without
 * one) and its employer statutory cost (employer_accrual) when there is any; the worker is the
 * counterparty and the pay date the date. Posted once (unique index), in the approval transaction
 * by the approver. Returns the number of entries.
 */
export async function postApprovalAccruals(
  tx: Tx,
  input: { tenantId: string; projectId: string; batchId: string; payDate: Date; actorId: string },
): Promise<number> {
  const groups = await tx.$queryRaw<
    {
      line_id: string;
      full_name: string;
      employer_cost_minor: bigint;
      bq_version_id: string | null;
      bq_item_lineage_id: string | null;
      amount_minor: bigint | null;
    }[]
  >`SELECT l.id AS line_id, l.full_name, l.employer_cost_minor, g.bq_version_id,
           g.bq_item_lineage_id, g.amount_minor
      FROM payroll_lines l
      LEFT JOIN LATERAL app.payroll_line_cost_groups(l.tenant_id, l.id) g ON true
     WHERE l.tenant_id = ${input.tenantId}::uuid AND l.batch_id = ${input.batchId}::uuid
     ORDER BY l.id, g.bq_item_lineage_id NULLS FIRST`;
  const common = {
    tenantId: input.tenantId,
    projectId: input.projectId,
    measure: "accrued",
    category: "labour",
    counterpartyKind: "worker",
    occurredOn: input.payDate,
    source: "payroll_line",
    recordedBy: input.actorId,
    businessDate: new Date(),
  };
  const data: Prisma.CostEntryCreateManyInput[] = [];
  const employer = new Set<string>();
  for (const group of groups) {
    if (group.amount_minor !== null && group.amount_minor !== 0n)
      data.push({
        ...common,
        id: uuidv7(),
        purpose: "accrual",
        counterpartyName: name(group.full_name),
        bqVersionId: group.bq_version_id,
        bqItemLineageId: group.bq_item_lineage_id,
        amountMinor: group.amount_minor,
        payrollLineId: group.line_id,
      });
    if (!employer.has(group.line_id) && group.employer_cost_minor > 0n) {
      employer.add(group.line_id);
      data.push({
        ...common,
        id: uuidv7(),
        purpose: "employer_accrual",
        counterpartyName: name(group.full_name),
        amountMinor: group.employer_cost_minor,
        payrollLineId: group.line_id,
      });
    }
  }
  if (data.length) await tx.costEntry.createMany({ data });
  return data.length;
}

/**
 * A confirmed payout (D4.3 §10): its amount paid as labour to the worker (reference: the M-Pesa
 * receipt, or the bank or cash reference) on its paid date and, for M-Pesa, the tariff charge
 * booked on it as fees, accrued and paid (owner decision 6). Posted once per purpose.
 */
export async function postPayoutCosts(
  tx: Tx,
  payout: PayrollPayout,
  workerName: string,
  actorId: string,
): Promise<void> {
  const common = {
    tenantId: payout.tenantId,
    projectId: payout.projectId,
    occurredOn: payout.paidOn!,
    source: "payroll_payout",
    payrollPayoutId: payout.id,
    recordedBy: actorId,
    businessDate: new Date(),
  };
  const data: Prisma.CostEntryCreateManyInput[] = [
    {
      ...common,
      id: uuidv7(),
      purpose: "payment",
      measure: "paid",
      category: "labour",
      counterpartyKind: "worker",
      counterpartyName: name(workerName),
      paymentReference: payout.receipt ?? payout.reference,
      amountMinor: payout.amountMinor,
    },
  ];
  if (payout.method === "mpesa" && payout.chargeMinor !== null && payout.chargeMinor > 0n)
    for (const [purpose, measure] of [
      ["charge_accrual", "accrued"],
      ["charge_payment", "paid"],
    ] as const)
      data.push({
        ...common,
        id: uuidv7(),
        purpose,
        measure,
        category: "fees",
        counterpartyKind: "other",
        counterpartyName: MPESA_CHARGE_COUNTERPARTY,
        paymentReference: payout.receipt,
        amountMinor: payout.chargeMinor,
      });
  await tx.costEntry.createMany({ data });
}

/**
 * A reversed payout: a reversal entry mirroring its payment entry. The charge entries stay (the
 * charge was incurred; corrections go through a D5.4 journal). No-op when nothing was posted.
 */
export async function postPayoutReversal(
  tx: Tx,
  payout: PayrollPayout,
  actorId: string,
): Promise<boolean> {
  const payment = await tx.costEntry.findFirst({
    where: {
      tenantId: payout.tenantId,
      payrollPayoutId: payout.id,
      source: "payroll_payout",
      purpose: "payment",
    },
  });
  if (!payment) return false;
  const reversed = await tx.costEntry.findFirst({
    where: { tenantId: payout.tenantId, reversesEntryId: payment.id },
  });
  if (reversed) return false;
  await tx.costEntry.create({
    data: {
      id: uuidv7(),
      tenantId: payment.tenantId,
      projectId: payment.projectId,
      measure: payment.measure,
      category: payment.category,
      counterpartyKind: payment.counterpartyKind,
      counterpartyName: payment.counterpartyName,
      paymentReference: payment.paymentReference,
      amountMinor: -payment.amountMinor,
      occurredOn: payment.occurredOn,
      source: "payroll_payout",
      purpose: "reversal",
      payrollPayoutId: payout.id,
      reversesEntryId: payment.id,
      recordedBy: actorId,
      businessDate: new Date(),
    },
  });
  return true;
}
