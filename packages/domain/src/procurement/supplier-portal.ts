import type {
  InvoiceSource,
  InvoiceStatus,
  SettlementMethod,
  StatementEntryKind,
  SupplierInvoiceStatus,
} from "@pm-buddy/types";

/**
 * The status a supplier sees for one of its invoices, or null when the invoice is not shown to
 * the supplier at all: a draft keyed by company staff is their working copy, while a draft that
 * came from the portal can only be one the company is still reviewing.
 */
export function supplierInvoiceStatus(
  status: InvoiceStatus,
  source: InvoiceSource,
): SupplierInvoiceStatus | null {
  switch (status) {
    case "draft":
      return source === "supplier_portal" ? "under_review" : null;
    case "submitted":
      return "submitted";
    case "matched":
      return "under_review";
    case "disputed":
      return "disputed";
    case "approved":
      return "approved";
    case "partly_settled":
      return "partly_paid";
    case "settled":
      return "paid";
    case "cancelled":
      return "cancelled";
  }
}

/** Invoice states the company has accepted as owed: the ones a statement counts (D-105). */
export const STATEMENT_INVOICE_STATUSES = [
  "approved",
  "partly_settled",
  "settled",
] as const satisfies readonly InvoiceStatus[];

export type StatementInvoice = {
  id: string;
  invoiceNumber: string;
  /** The invoice date (a Nairobi business date, YYYY-MM-DD). */
  date: string;
  totalMinor: number;
};

export type StatementPayment = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  /** The date the company recorded as paid. */
  date: string;
  amountMinor: number;
  method: SettlementMethod;
  reference: string;
};

export type StatementEntry = {
  kind: StatementEntryKind;
  id: string;
  date: string;
  invoiceId: string;
  invoiceNumber: string;
  method: SettlementMethod | null;
  reference: string | null;
  /** What the company owes more (an invoice) and less (a payment). */
  debitMinor: number;
  creditMinor: number;
  /** The running balance owed to the supplier after this line. */
  balanceMinor: number;
};

export type SupplierStatement = {
  from: string;
  to: string;
  openingMinor: number;
  invoicedMinor: number;
  paidMinor: number;
  closingMinor: number;
  entries: StatementEntry[];
};

const assertMinor = (value: number, what: string) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${what} must be a whole, non-negative number of minor units`);
};

/**
 * A supplier statement for a period (rule D-105): the balance the company owes the supplier is
 * the accepted invoices (approved, partly paid or paid; dated by their invoice date) less the
 * recorded payments (dated by their paid date). The opening balance is everything dated before
 * `from`; the lines are what falls between `from` and `to` (inclusive), by date, invoices before
 * payments on the same day, then by invoice number and ID; closing = opening + invoiced − paid.
 * Dates after `to` are left out. Exact integer arithmetic on KES minor units.
 */
export function supplierStatement(input: {
  from: string;
  to: string;
  invoices: readonly StatementInvoice[];
  payments: readonly StatementPayment[];
}): SupplierStatement {
  const { from, to } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to)
    throw new RangeError("The statement period must run from a date to the same or a later date");
  let opening = 0;
  const entries: Omit<StatementEntry, "balanceMinor">[] = [];
  for (const invoice of input.invoices) {
    assertMinor(invoice.totalMinor, "An invoice total");
    if (invoice.date < from) opening += invoice.totalMinor;
    else if (invoice.date <= to)
      entries.push({
        kind: "invoice",
        id: invoice.id,
        date: invoice.date,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        method: null,
        reference: null,
        debitMinor: invoice.totalMinor,
        creditMinor: 0,
      });
  }
  for (const payment of input.payments) {
    assertMinor(payment.amountMinor, "A payment");
    if (payment.date < from) opening -= payment.amountMinor;
    else if (payment.date <= to)
      entries.push({
        kind: "payment",
        id: payment.id,
        date: payment.date,
        invoiceId: payment.invoiceId,
        invoiceNumber: payment.invoiceNumber,
        method: payment.method,
        reference: payment.reference,
        debitMinor: 0,
        creditMinor: payment.amountMinor,
      });
  }
  const order = (kind: StatementEntryKind) => (kind === "invoice" ? 0 : 1);
  entries.sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      order(left.kind) - order(right.kind) ||
      left.invoiceNumber.localeCompare(right.invoiceNumber) ||
      left.id.localeCompare(right.id),
  );
  let balance = opening;
  let invoiced = 0;
  let paid = 0;
  const lines = entries.map((entry) => {
    balance += entry.debitMinor - entry.creditMinor;
    invoiced += entry.debitMinor;
    paid += entry.creditMinor;
    return { ...entry, balanceMinor: balance };
  });
  return {
    from,
    to,
    openingMinor: opening,
    invoicedMinor: invoiced,
    paidMinor: paid,
    closingMinor: opening + invoiced - paid,
    entries: lines,
  };
}
