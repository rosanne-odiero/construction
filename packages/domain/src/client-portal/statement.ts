import type {
  ClientCertificateState,
  ClientPaymentKind,
  ClientStatementEntryKind,
} from "@pm-buddy/types";
import { addCalendarDays, calendarDaysBetween } from "../labour.js";

/**
 * Client statement arithmetic (D7.1, ARCHITECTURE §4.15, rule D-133). Exact integer arithmetic on
 * KES minor units; dates are Nairobi calendar dates (YYYY-MM-DD). A certificate is owed from the
 * day it is certified: its total (amount due plus VAT) less the receipts the company recorded
 * against it, net of reversals. Nothing is "paid" unless a receipt is recorded.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const assertDate = (value: string, what: string) => {
  if (!DATE.test(value)) throw new RangeError(`${what} must be a calendar date (YYYY-MM-DD)`);
};
const assertMinor = (value: number, what: string) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${what} must be a whole, non-negative number of minor units`);
};

/**
 * The date a certificate falls due: its certification date (Nairobi) plus the payment period in
 * force when it was certified (CONFIGURATION `client_portal.payment_terms_days`). A later change
 * of the period never moves an existing due date.
 */
export function certificateDueDate(certifiedOn: string, paymentTermsDays: number): string {
  assertDate(certifiedOn, "The certification date");
  if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || paymentTermsDays > 3_650)
    throw new RangeError("The payment period must be a whole number of days");
  return addCalendarDays(certifiedOn, paymentTermsDays);
}

/**
 * Whole days a certificate is overdue on `today` (both Nairobi calendar dates): 0 on or before the
 * due date, 1 the day after it.
 */
export function overdueDays(dueDate: string, today: string): number {
  assertDate(dueDate, "The due date");
  assertDate(today, "Today");
  return Math.max(0, calendarDaysBetween(dueDate, today));
}

export type ClientCertificateInput = {
  id: string;
  /** IPC-NNNN. */
  number: string;
  /** The Nairobi date it was certified. */
  certifiedOn: string;
  dueDate: string;
  /**
   * Amount due plus VAT (what the client owes for it). Negative for a certificate that corrects
   * an earlier one downwards: a credit applied to the oldest certificates still owed.
   */
  totalMinor: number;
};

export type ClientPaymentInput = {
  id: string;
  certificateId: string;
  kind: ClientPaymentKind;
  /** For a reversal: the receipt it reverses (in full). */
  reversesId: string | null;
  amountMinor: number;
  /** The date the money was received (or the reversal recorded). */
  receivedOn: string;
};

export type CertificateBalance = ClientCertificateInput & {
  /** Receipts recorded against it less their reversals. */
  receivedMinor: number;
  /** Credit from negative certificates applied to it (oldest certificates first). */
  creditedMinor: number;
  /** Total − received − credited (0 for a credit certificate). */
  outstandingMinor: number;
  state: ClientCertificateState;
  overdue: boolean;
  /** 0 unless overdue. */
  overdueDays: number;
};

/** Receipts net of reversals per certificate; throws if a reversal does not match its receipt. */
function netReceived(payments: readonly ClientPaymentInput[]): Map<string, number> {
  const receipts = new Map<string, ClientPaymentInput>();
  for (const payment of payments) {
    assertMinor(payment.amountMinor, "A receipt");
    assertDate(payment.receivedOn, "A receipt date");
    if (payment.amountMinor === 0) throw new RangeError("A receipt is more than zero");
    if (payment.kind === "receipt") receipts.set(payment.id, payment);
  }
  const reversed = new Set<string>();
  const net = new Map<string, number>();
  for (const payment of payments) {
    let delta = payment.amountMinor;
    if (payment.kind === "reversal") {
      const original = payment.reversesId ? receipts.get(payment.reversesId) : undefined;
      if (
        !original ||
        reversed.has(original.id) ||
        original.certificateId !== payment.certificateId ||
        original.amountMinor !== payment.amountMinor
      )
        throw new RangeError("A reversal undoes one receipt of the same certificate in full");
      reversed.add(original.id);
      delta = -payment.amountMinor;
    }
    net.set(payment.certificateId, (net.get(payment.certificateId) ?? 0) + delta);
  }
  return net;
}

const byCertification = (left: ClientCertificateInput, right: ClientCertificateInput) =>
  left.certifiedOn.localeCompare(right.certifiedOn) ||
  left.number.localeCompare(right.number) ||
  left.id.localeCompare(right.id);

/**
 * Each certified certificate's balance on `today`, in certification order: received (net of
 * reversals), credit applied from negative certificates (oldest certificates first, rule D-133),
 * outstanding, whether anything is recorded and whether the outstanding part is past its due
 * date. Credit left over once every certificate is settled is `unappliedCreditMinor`.
 */
export function certificateBalances(input: {
  certificates: readonly ClientCertificateInput[];
  payments: readonly ClientPaymentInput[];
  today: string;
}): { certificates: CertificateBalance[]; unappliedCreditMinor: number } {
  assertDate(input.today, "Today");
  const net = netReceived(input.payments);
  const known = new Map(input.certificates.map((certificate) => [certificate.id, certificate]));
  for (const [certificateId, received] of net) {
    const certificate = known.get(certificateId);
    if (!certificate) throw new RangeError("A receipt names an unknown certificate");
    if (received < 0 || received > Math.max(certificate.totalMinor, 0))
      throw new RangeError("Receipts never exceed the certificate total");
  }
  const ordered = [...input.certificates].sort(byCertification);
  let credit = 0;
  for (const certificate of ordered) {
    if (!Number.isSafeInteger(certificate.totalMinor))
      throw new RangeError("A certificate total must be a whole number of minor units");
    assertDate(certificate.certifiedOn, "A certification date");
    assertDate(certificate.dueDate, "A due date");
    if (certificate.totalMinor < 0) credit -= certificate.totalMinor;
  }
  const balances = ordered.map((certificate): CertificateBalance => {
    const receivedMinor = net.get(certificate.id) ?? 0;
    if (certificate.totalMinor <= 0)
      return {
        ...certificate,
        receivedMinor,
        creditedMinor: 0,
        outstandingMinor: 0,
        state: certificate.totalMinor < 0 ? "credit" : "paid",
        overdue: false,
        overdueDays: 0,
      };
    const creditedMinor = Math.min(credit, certificate.totalMinor - receivedMinor);
    credit -= creditedMinor;
    const outstandingMinor = certificate.totalMinor - receivedMinor - creditedMinor;
    const late = outstandingMinor > 0 ? overdueDays(certificate.dueDate, input.today) : 0;
    const state: ClientCertificateState =
      outstandingMinor === 0 ? "paid" : receivedMinor === 0 ? "unpaid" : "part_paid";
    return {
      ...certificate,
      receivedMinor,
      creditedMinor,
      outstandingMinor,
      state,
      overdue: late > 0,
      overdueDays: late,
    };
  });
  return { certificates: balances, unappliedCreditMinor: credit };
}

export type ClientStatementEntry = {
  kind: ClientStatementEntryKind;
  id: string;
  date: string;
  certificateId: string;
  certificateNumber: string;
  /** What the client owes more (a certificate, a reversal) and less (a receipt). */
  debitMinor: number;
  creditMinor: number;
  /** The running balance the client owes after this line. */
  balanceMinor: number;
};

export type ClientStatement = {
  /** Certificates' totals (credits negative). */
  certifiedMinor: number;
  receivedMinor: number;
  /** Certified − received: what the client owes (negative when the client is in credit). */
  outstandingMinor: number;
  overdueMinor: number;
  certificates: CertificateBalance[];
  entries: ClientStatementEntry[];
};

const ENTRY_ORDER: Record<ClientStatementEntryKind, number> = {
  certificate: 0,
  receipt: 1,
  reversal: 2,
};

/**
 * A client's statement for one project (rule D-133): certified certificates by certification
 * date, receipts by received date and reversals by the date recorded, in date order
 * (certificates before receipts before reversals on the same day, then by certificate number and
 * ID), with the running balance; totals certified, received (net), outstanding (certified −
 * received; negative when the client is in credit) and overdue (outstanding past its due date on
 * `today`, after credits).
 */
export function clientStatement(input: {
  certificates: readonly ClientCertificateInput[];
  payments: readonly ClientPaymentInput[];
  today: string;
}): ClientStatement {
  const { certificates, unappliedCreditMinor } = certificateBalances(input);
  const numberOf = new Map(input.certificates.map((row) => [row.id, row.number]));
  const entries: Omit<ClientStatementEntry, "balanceMinor">[] = [
    ...input.certificates.map((row) => ({
      kind: "certificate" as const,
      id: row.id,
      date: row.certifiedOn,
      certificateId: row.id,
      certificateNumber: row.number,
      debitMinor: Math.max(row.totalMinor, 0),
      creditMinor: Math.max(-row.totalMinor, 0),
    })),
    ...input.payments.map((payment) => ({
      kind: payment.kind,
      id: payment.id,
      date: payment.receivedOn,
      certificateId: payment.certificateId,
      certificateNumber: numberOf.get(payment.certificateId)!,
      debitMinor: payment.kind === "reversal" ? payment.amountMinor : 0,
      creditMinor: payment.kind === "receipt" ? payment.amountMinor : 0,
    })),
  ];
  entries.sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      ENTRY_ORDER[left.kind] - ENTRY_ORDER[right.kind] ||
      left.certificateNumber.localeCompare(right.certificateNumber) ||
      left.id.localeCompare(right.id),
  );
  let balance = 0;
  const lines = entries.map((entry) => {
    balance += entry.debitMinor - entry.creditMinor;
    return { ...entry, balanceMinor: balance };
  });
  const sum = (pick: (row: CertificateBalance) => number) =>
    certificates.reduce((total, row) => total + pick(row), 0);
  return {
    certifiedMinor: sum((row) => row.totalMinor),
    receivedMinor: sum((row) => row.receivedMinor),
    outstandingMinor: sum((row) => row.outstandingMinor) - unappliedCreditMinor,
    overdueMinor: sum((row) => (row.overdue ? row.outstandingMinor : 0)),
    certificates,
    entries: lines,
  };
}

/**
 * Whether a new receipt fits the certificate: more than zero and no more than what is still
 * outstanding (an overpayment is recorded against the next certificate once it is certified).
 */
export function receiptFits(amountMinor: number, outstandingMinor: number): boolean {
  return Number.isSafeInteger(amountMinor) && amountMinor > 0 && amountMinor <= outstandingMinor;
}
