import {
  changeHoldUntil,
  maskPhone,
  nairobiDate,
  obligationProgress,
  payoutBlockReasons,
  payoutDisplayStatus,
  utilityBalanceMinor,
} from "@pm-buddy/domain";
import type { PaymentAttemptStatus, PaymentLimits } from "@pm-buddy/types";
import type { CarryForward, FloatStatus, Obligation } from "@pm-buddy/validation";
import type {
  PayrollCarryForward,
  PayrollNotification,
  PayrollObligation,
  PayrollPayoutEvidence,
  PayrollPayoutFlag,
  Prisma,
} from "../../generated/prisma/client.js";
import { displayNames } from "../labour/labour-mappers.js";
import type { LabourCrypto } from "../labour/labour-support.js";
import { balanceToWire } from "../payments/payments-mappers.js";
import { chargeOn, tariffVersions, type TariffVersionFacts } from "../payments/tariffs.service.js";
import type { LineRow } from "../payroll/payroll-mappers.js";
import { toCalendarDate } from "../projects/project-mappers.js";
import {
  b2cLimits,
  currentPhone,
  eligibilityFacts,
  loadPayouts,
  loadRecipients,
  type PayoutWithRequest,
  type RecipientState,
} from "./payout-facts.js";
import { loadPayoutSettings, type LoadedPayoutSettings } from "./payout-settings.service.js";
import {
  payslipState,
  toCarryForward,
  toFlag,
  toObligation,
  toPayout,
  type LineRef,
  type Names,
} from "./payouts-mappers.js";
import { minor } from "./payouts-support.js";

type Tx = Prisma.TransactionClient;
type B2cLimits = Pick<PaymentLimits, "b2cMinMinor" | "b2cMaxMinor">;

/** Everything the per-worker payout rows of some obligations are built from (one transaction). */
export type ObligationContext = {
  tenantId: string;
  obligations: PayrollObligation[];
  lines: Map<string, LineRow>;
  carryForwards: Map<string, PayrollCarryForward>;
  recipients: Map<string, RecipientState>;
  payouts: PayoutWithRequest[];
  flags: PayrollPayoutFlag[];
  evidence: PayrollPayoutEvidence[];
  notifications: PayrollNotification[];
  settings: LoadedPayoutSettings;
  limits: B2cLimits;
  versions: TariffVersionFacts[];
  names: Names;
  now: Date;
};

/** Loads the context of the given obligations (all of one company). */
export async function loadObligationContext(
  tx: Tx,
  tenantId: string,
  obligations: PayrollObligation[],
): Promise<ObligationContext> {
  const ids = obligations.map((row) => row.id);
  const lineIds = obligations.map((row) => row.lineId);
  const lines = lineIds.length
    ? await tx.payrollLine.findMany({ where: { tenantId, id: { in: lineIds } } })
    : [];
  const carryForwards = lineIds.length
    ? await tx.payrollCarryForward.findMany({ where: { tenantId, lineId: { in: lineIds } } })
    : [];
  const recipients = await loadRecipients(
    tx,
    tenantId,
    obligations.map((row) => row.labourerId),
  );
  const payouts = await loadPayouts(tx, tenantId, ids);
  const flags = ids.length
    ? await tx.payrollPayoutFlag.findMany({
        where: { tenantId, obligationId: { in: ids } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    : [];
  const payoutIds = payouts.map((entry) => entry.payout.id);
  const evidence = payoutIds.length
    ? await tx.payrollPayoutEvidence.findMany({
        where: { tenantId, payoutId: { in: payoutIds } },
        orderBy: [{ uploadedAt: "asc" }, { id: "asc" }],
      })
    : [];
  const notifications = ids.length
    ? await tx.payrollNotification.findMany({
        where: { tenantId, kind: "payslip", obligationId: { in: ids } },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const names = await displayNames(tx, [
    ...obligations.map((row) => row.destinationApprovedBy),
    ...payouts.flatMap((entry) => [entry.payout.createdBy, entry.payout.confirmedBy]),
    ...flags.flatMap((row) => [row.createdBy, row.clearedBy]),
    ...evidence.map((row) => row.uploadedBy),
  ]);
  return {
    tenantId,
    obligations,
    lines: new Map(lines.map((line) => [line.id, line])),
    carryForwards: new Map(carryForwards.map((row) => [row.lineId, row])),
    recipients,
    payouts,
    flags,
    evidence,
    notifications,
    settings: await loadPayoutSettings(tx, tenantId),
    limits: await b2cLimits(tx, tenantId),
    versions: await tariffVersions(tx, tenantId),
    names,
    now: new Date(),
  };
}

/** The masked form of one of the labourer's numbers: the current one, or a verified one it was. */
export function maskedNumber(
  crypto: LabourCrypto,
  tenantId: string,
  recipient: RecipientState | undefined,
  bidx: string | null,
): string | null {
  if (!bidx || !recipient) return null;
  if (recipient.phoneBidx === bidx) {
    const phone = currentPhone(crypto, tenantId, recipient);
    return phone ? maskPhone(phone) : null;
  }
  return recipient.verifications.find((row) => row.phoneBidx === bidx)?.phoneMasked ?? null;
}

/** The receiver name of a mismatched name check, for payments.approve / payments.review holders. */
export function receiverNameOf(
  crypto: LabourCrypto,
  entry: PayoutWithRequest,
  allowed: boolean,
): string | null {
  const { payout } = entry;
  if (!allowed || payout.nameCheck !== "mismatch" || !payout.receiverNameEnc) return null;
  return crypto.cipher.decrypt(
    {
      tenantId: payout.tenantId,
      table: "payroll_payouts",
      column: "receiver_name_enc",
      rowId: payout.id,
    },
    payout.receiverNameEnc,
  );
}

/** One worker row of the payouts screen (live status joined from D4.2, block reasons, payslip). */
export function obligationView(
  ctx: ObligationContext,
  obligation: PayrollObligation,
  crypto: LabourCrypto,
  canViewReceiverNames: boolean,
): Obligation {
  const line = ctx.lines.get(obligation.lineId);
  const recipient = ctx.recipients.get(obligation.labourerId);
  const own = ctx.payouts.filter((entry) => entry.payout.obligationId === obligation.id);
  const reasons = payoutBlockReasons(
    eligibilityFacts({
      obligation,
      recipient,
      payouts: own,
      flags: ctx.flags,
      limits: ctx.limits,
      payeeChangeHoldHours: ctx.settings.payeeChangeHoldHours,
      now: ctx.now,
    }),
  );
  const payouts = own.map((entry) =>
    toPayout(entry, ctx.evidence, ctx.names, receiverNameOf(crypto, entry, canViewReceiverNames)),
  );
  const latest = own.at(-1);
  const progress = obligationProgress({
    status: obligation.status as Obligation["status"],
    paidMinor: minor(obligation.paidMinor),
    blockReasons: reasons,
    latestPayout: latest
      ? payoutDisplayStatus(
          {
            method: latest.payout.method as "mpesa" | "cash" | "bank",
            status: latest.payout.status as Obligation["payouts"][number]["status"],
          },
          (latest.attempt?.status as PaymentAttemptStatus | undefined) ?? null,
        )
      : null,
  });
  const holdUntil =
    recipient?.phoneChangedAt && !recipient.override
      ? changeHoldUntil(recipient.phoneChangedAt.toISOString(), ctx.settings.payeeChangeHoldHours)
      : null;
  const notification =
    ctx.notifications.filter((row) => row.obligationId === obligation.id).at(-1) ?? null;
  const phone = recipient ? currentPhone(crypto, ctx.tenantId, recipient) : null;
  return toObligation(
    obligation,
    {
      lineNetMinor: line ? minor(line.netMinor) : minor(obligation.amountMinor),
      broughtForwardMinor: line ? minor(line.broughtForwardMinor) : 0,
      carryForwardMinor: minor(ctx.carryForwards.get(obligation.lineId)?.amountMinor ?? 0n),
      labourer: {
        id: obligation.labourerId,
        workerNo: line?.workerNo ?? recipient?.workerNo ?? "—",
        fullName: line?.fullName ?? recipient?.fullName ?? "—",
      },
      destinationMasked: maskedNumber(crypto, ctx.tenantId, recipient, obligation.destinationBidx),
      currentPhoneMasked: phone ? maskPhone(phone) : null,
      progress,
      blockReasons: reasons,
      changeHoldUntil: holdUntil,
      flags: ctx.flags
        .filter((flag) => flag.obligationId === obligation.id)
        .map((flag) => toFlag(flag, ctx.names)),
      payouts,
      payslip: payslipState(obligation.status === "settled", Boolean(phone), notification),
    },
    ctx.names,
  );
}

/**
 * Carry-forwards with their source line and, once consumed, the line that brought them forward
 * (an active consumption of a later D4.1 batch).
 */
export async function carryForwardViews(
  tx: Tx,
  tenantId: string,
  rows: PayrollCarryForward[],
): Promise<CarryForward[]> {
  if (!rows.length) return [];
  const consumptions = await tx.payrollConsumption.findMany({
    where: {
      tenantId,
      carryForwardId: { in: rows.map((row) => row.id) },
      activeMarker: "active",
    },
  });
  const batchIds = [
    ...new Set([...rows.map((row) => row.batchId), ...consumptions.map((row) => row.batchId)]),
  ];
  const batches = await tx.payrollBatch.findMany({
    where: { tenantId, id: { in: batchIds } },
    select: { id: true, projectId: true, periodStart: true, periodEnd: true },
  });
  const consumingLines = consumptions.length
    ? await tx.payrollLine.findMany({
        where: {
          tenantId,
          batchId: { in: [...new Set(consumptions.map((row) => row.batchId))] },
          labourerId: { in: [...new Set(rows.map((row) => row.labourerId))] },
        },
        select: { id: true, batchId: true, labourerId: true },
      })
    : [];
  const sourceLines = await tx.payrollLine.findMany({
    where: { tenantId, id: { in: rows.map((row) => row.lineId) } },
    select: { id: true, labourerId: true, workerNo: true, fullName: true },
  });
  const ref = (batchId: string, lineId: string): LineRef | null => {
    const batch = batches.find((row) => row.id === batchId);
    return batch
      ? {
          batchId,
          lineId,
          projectId: batch.projectId,
          periodStart: toCalendarDate(batch.periodStart),
          periodEnd: toCalendarDate(batch.periodEnd),
        }
      : null;
  };
  return rows.map((row) => {
    const consumption = consumptions.find((entry) => entry.carryForwardId === row.id);
    const consumingLine = consumption
      ? consumingLines.find(
          (line) => line.batchId === consumption.batchId && line.labourerId === row.labourerId,
        )
      : undefined;
    const by = consumption && consumingLine ? ref(consumption.batchId, consumingLine.id) : null;
    const source = sourceLines.find((line) => line.id === row.lineId);
    return toCarryForward(
      row,
      {
        id: row.labourerId,
        workerNo: source?.workerNo ?? "—",
        fullName: source?.fullName ?? "—",
      },
      ref(row.batchId, row.lineId)!,
      by && consumption ? { by, at: consumption.createdAt } : null,
    );
  });
}

/**
 * Payroll M-Pesa payouts of the company created after `since` that have not failed: their amounts
 * and charges (booked, else the tariff estimate) are committed against the float answered then.
 */
export async function inFlightMinor(
  tx: Tx,
  tenantId: string,
  since: Date | null,
  versions: readonly TariffVersionFacts[],
): Promise<number> {
  if (!since) return 0;
  const rows = await tx.payrollPayout.findMany({
    where: { tenantId, method: "mpesa", status: { not: "failed" }, createdAt: { gt: since } },
    select: { amountMinor: true, chargeMinor: true, createdAt: true },
  });
  return rows.reduce((total, row) => {
    const amount = minor(row.amountMinor);
    const charge =
      row.chargeMinor !== null
        ? minor(row.chargeMinor)
        : (chargeOn(versions, nairobiDate(row.createdAt), amount)?.chargeMinor ?? 0);
    return total + amount + charge;
  }, 0);
}

/** The latest answered float (Account Balance) check and how fresh it is (§6). */
export async function floatStatus(
  tx: Tx,
  tenantId: string,
  settings: LoadedPayoutSettings,
  versions: readonly TariffVersionFacts[],
  now = new Date(),
): Promise<FloatStatus> {
  const latest = await tx.providerQuery.findFirst({
    where: { tenantId, kind: "account_balance", status: "answered", answeredAt: { not: null } },
    orderBy: [{ answeredAt: "desc" }, { id: "desc" }],
  });
  const check = latest ? balanceToWire(latest) : null;
  const available = check ? utilityBalanceMinor(check.balances) : null;
  const ageMinutes = latest?.answeredAt
    ? Math.max(0, Math.floor((now.getTime() - latest.answeredAt.getTime()) / 60_000))
    : null;
  return {
    latest: check,
    utilityAvailableMinor: available,
    ageMinutes,
    maxAgeMinutes: settings.floatCheckMaxAgeMinutes,
    fresh:
      available !== null &&
      latest?.answeredAt !== null &&
      latest !== null &&
      now.getTime() - latest.answeredAt!.getTime() <= settings.floatCheckMaxAgeMinutes * 60_000,
    inFlightMinor: await inFlightMinor(tx, tenantId, latest?.answeredAt ?? null, versions),
  };
}
