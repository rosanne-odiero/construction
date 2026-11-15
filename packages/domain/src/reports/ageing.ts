import { calendarDaysBetween } from "../labour.js";

/**
 * Supplier invoice ageing by days past the due date (D-123): `current` is not yet overdue (due on
 * or after the as-at date), then 1–30, 31–60, 61–90 and more than 90 days overdue. An invoice due
 * yesterday is 1 day overdue; one due 30 days ago is still in 1–30.
 */
export const AGEING_BUCKETS = ["current", "1-30", "31-60", "61-90", "over-90"] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export function daysOverdue(dueDate: string, asAt: string): number {
  return Math.max(0, calendarDaysBetween(dueDate, asAt));
}

export function ageingBucket(dueDate: string, asAt: string): AgeingBucket {
  const days = daysOverdue(dueDate, asAt);
  if (days === 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "over-90";
}

export type AgeingInput = { dueDate: string; totalMinor: number; paidMinor: number };
export type AgedInvoice<T> = T & {
  outstandingMinor: number;
  daysOverdue: number;
  bucket: AgeingBucket | "paid";
};

/**
 * Ages invoices at a date: outstanding = total − paid by then (never below zero); a fully paid
 * invoice is `paid`. Totals per bucket cover every invoice passed in.
 */
export function ageInvoices<T extends AgeingInput>(
  invoices: readonly T[],
  asAt: string,
): { rows: AgedInvoice<T>[]; totals: Record<AgeingBucket, number>; outstandingMinor: number } {
  const totals = Object.fromEntries(AGEING_BUCKETS.map((bucket) => [bucket, 0])) as Record<
    AgeingBucket,
    number
  >;
  let outstandingMinor = 0;
  const rows = invoices.map((invoice): AgedInvoice<T> => {
    const outstanding = Math.max(0, invoice.totalMinor - invoice.paidMinor);
    if (outstanding === 0)
      return { ...invoice, outstandingMinor: 0, daysOverdue: 0, bucket: "paid" };
    const bucket = ageingBucket(invoice.dueDate, asAt);
    totals[bucket] += outstanding;
    outstandingMinor += outstanding;
    return {
      ...invoice,
      outstandingMinor: outstanding,
      daysOverdue: daysOverdue(invoice.dueDate, asAt),
      bucket,
    };
  });
  return { rows, totals, outstandingMinor };
}

/**
 * Settlements recorded against what was approved: `unpaid`, `part-paid`, `paid`, or `over-paid`
 * (the database refuses settlements beyond the authorised amount, so this flags a breach of that
 * rule rather than a normal state).
 */
export type PaymentState = "unpaid" | "part-paid" | "paid" | "over-paid";
export function paymentState(approvedMinor: number, settledMinor: number): PaymentState {
  if (settledMinor > approvedMinor) return "over-paid";
  if (settledMinor === 0) return "unpaid";
  return settledMinor === approvedMinor ? "paid" : "part-paid";
}
