import {
  certificateDueDate,
  clientStatement,
  nairobiDate,
  paybillAccountReference,
  valuationCode,
  type CertificateBalance,
  type ClientStatement,
} from "@pm-buddy/domain";
import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientPaymentKind,
  type ClientPaymentMethod,
  type PaybillAccountFormat,
  type ReleaseStage,
  type ValuationKind,
} from "@pm-buddy/types";
import type { Prisma } from "../../generated/prisma/client.js";
import { toCalendarDate } from "../procurement/procurement-mappers.js";
import { minorOf, type Tx } from "./spending-common.js";

/**
 * The client ledger of a project (D7.1, rule D-133): certified certificates (interim and retention
 * releases) as amounts owed by the client from their certification date, due after the payment
 * period in force when each was certified, less the receipts the company recorded against them
 * (net of reversals). Shared by the client portal, the staff client-payments view, the statement
 * exports, the cash-flow forecast and earned value's "cash received", so they never disagree.
 */

export type ClientTerms = {
  /** 0 = the defaults (nothing saved). */
  version: number;
  clientApprovalRequired: boolean;
  paymentTermsDays: number;
  createdBy: string | null;
  createdAt: Date | null;
};

const DEFAULT_TERMS: ClientTerms = {
  version: 0,
  clientApprovalRequired: DEFAULT_CLIENT_SETTINGS.clientApprovalRequired,
  paymentTermsDays: DEFAULT_CLIENT_SETTINGS.paymentTermsDays,
  createdBy: null,
  createdAt: null,
};

/** Every saved version of a project's client terms, newest first. */
export async function clientTermsHistory(
  tx: Tx,
  tenantId: string,
  projectId: string,
): Promise<ClientTerms[]> {
  const rows = await tx.projectClientSettings.findMany({
    where: { tenantId, projectId },
    orderBy: { version: "desc" },
  });
  return rows.map((row) => ({
    version: row.version,
    clientApprovalRequired: row.clientApprovalRequired,
    paymentTermsDays: row.paymentTermsDays,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }));
}

/** The terms in force at `at` (the newest version saved by then), or the defaults. */
export function termsAt(history: readonly ClientTerms[], at: Date): ClientTerms {
  return (
    history.find((row) => row.createdAt !== null && row.createdAt.getTime() <= at.getTime()) ??
    DEFAULT_TERMS
  );
}

export const currentTerms = (history: readonly ClientTerms[]): ClientTerms =>
  history[0] ?? DEFAULT_TERMS;

export type PaymentInstructionsRow = Prisma.ClientPaymentInstructionsGetPayload<object>;

/** The company's newest Paybill instructions, or null when none were saved. */
export function latestInstructions(tx: Tx, tenantId: string) {
  return tx.clientPaymentInstructions.findFirst({
    where: { tenantId },
    orderBy: { version: "desc" },
  });
}

export type LedgerCertificate = CertificateBalance & {
  certificateNumber: number;
  kind: ValuationKind;
  releaseStage: ReleaseStage | null;
  valuationDate: string;
  amountDueMinor: number;
  vatPercent: string;
  vatMinor: number;
  accountReference: string | null;
};

export type LedgerPayment = {
  id: string;
  kind: ClientPaymentKind;
  certificateId: string;
  certificateNumber: string;
  receivedOn: string;
  amountMinor: number;
  method: ClientPaymentMethod | null;
  reference: string | null;
  note: string | null;
  reason: string | null;
  reversesId: string | null;
  reversedBy: string | null;
  recordedBy: string;
  recordedAt: string;
};

export type ClientLedger = {
  today: string;
  terms: ClientTerms;
  instructions: PaymentInstructionsRow | null;
  certificates: LedgerCertificate[];
  payments: LedgerPayment[];
  statement: ClientStatement;
};

/** The project's client ledger on `today` (a Nairobi date). */
export async function loadClientLedger(
  tx: Tx,
  tenantId: string,
  projectId: string,
  projectCode: string,
  today: string = nairobiDate(),
): Promise<ClientLedger> {
  const [rows, payments, history, instructions] = await Promise.all([
    tx.valuation.findMany({
      where: { tenantId, projectId, status: "certified" },
      orderBy: { certificateNumber: "asc" },
    }),
    tx.clientPayment.findMany({
      where: { tenantId, projectId },
      orderBy: [{ receivedOn: "asc" }, { recordedAt: "asc" }, { id: "asc" }],
    }),
    clientTermsHistory(tx, tenantId, projectId),
    latestInstructions(tx, tenantId),
  ]);
  const meta = new Map(
    rows.map((row) => {
      const certifiedOn = nairobiDate(row.certifiedAt!);
      return [
        row.id,
        {
          row,
          number: valuationCode("IPC", row.certificateNumber!),
          certifiedOn,
          dueDate: certificateDueDate(
            certifiedOn,
            termsAt(history, row.certifiedAt!).paymentTermsDays,
          ),
        },
      ];
    }),
  );
  const statement = clientStatement({
    certificates: [...meta.values()].map(({ row, number, certifiedOn, dueDate }) => ({
      id: row.id,
      number,
      certifiedOn,
      dueDate,
      totalMinor: minorOf(row.totalMinor!),
    })),
    payments: payments.map((payment) => ({
      id: payment.id,
      certificateId: payment.valuationId,
      kind: payment.kind as ClientPaymentKind,
      reversesId: payment.reversesId,
      amountMinor: minorOf(payment.amountMinor),
      receivedOn: toCalendarDate(payment.receivedOn),
    })),
    today,
  });
  const routed = instructions && (instructions.paybillNumber || instructions.tillNumber);
  const reversedBy = new Map(
    payments.flatMap((payment) => (payment.reversesId ? [[payment.reversesId, payment.id]] : [])),
  );
  return {
    today,
    terms: currentTerms(history),
    instructions,
    certificates: statement.certificates.map((balance) => {
      const { row } = meta.get(balance.id)!;
      return {
        ...balance,
        certificateNumber: row.certificateNumber!,
        kind: row.kind as ValuationKind,
        releaseStage: row.releaseStage as ReleaseStage | null,
        valuationDate: toCalendarDate(row.valuationDate),
        amountDueMinor: minorOf(row.amountDueMinor!),
        vatPercent: row.vatPercent!.toFixed(),
        vatMinor: minorOf(row.vatMinor!),
        accountReference: routed
          ? paybillAccountReference(
              instructions.accountFormat as PaybillAccountFormat,
              projectCode,
              row.certificateNumber,
            )
          : null,
      };
    }),
    payments: payments.map((payment) => ({
      id: payment.id,
      kind: payment.kind as ClientPaymentKind,
      certificateId: payment.valuationId,
      certificateNumber: meta.get(payment.valuationId)?.number ?? "",
      receivedOn: toCalendarDate(payment.receivedOn),
      amountMinor: minorOf(payment.amountMinor),
      method: payment.method as ClientPaymentMethod | null,
      reference: payment.reference,
      note: payment.note,
      reason: payment.reason,
      reversesId: payment.reversesId,
      reversedBy: reversedBy.get(payment.id) ?? null,
      recordedBy: payment.recordedBy,
      recordedAt: payment.recordedAt.toISOString(),
    })),
    statement,
  };
}

/**
 * Net client receipts (receipts − reversals) recorded on projects, optionally within received
 * dates (inclusive), or null when none is recorded there. Used for "cash received" (earned value)
 * and the forecast's opening cash.
 */
export async function clientReceiptsMinor(
  tx: Tx,
  tenantId: string,
  projectIds: readonly string[],
  range: { from?: string; to?: string } = {},
): Promise<number | null> {
  if (!projectIds.length) return null;
  const rows = await tx.clientPayment.groupBy({
    by: ["kind"],
    where: {
      tenantId,
      projectId: { in: [...projectIds] },
      ...(range.from || range.to
        ? {
            receivedOn: {
              ...(range.from ? { gte: new Date(`${range.from}T00:00:00.000Z`) } : {}),
              ...(range.to ? { lte: new Date(`${range.to}T00:00:00.000Z`) } : {}),
            },
          }
        : {}),
    },
    _sum: { amountMinor: true },
  });
  if (!rows.length) return null;
  return rows.reduce(
    (total, row) =>
      total + (row.kind === "reversal" ? -1 : 1) * minorOf(row._sum.amountMinor ?? 0n),
    0,
  );
}
