import { describe, expect, it } from "vitest";
import { INVOICE_STATUSES } from "@pm-buddy/types";
import { supplierInvoiceStatus, supplierStatement } from "../index.js";

/**
 * Supplier statement golden case, worked by hand (KES minor units). Period 1–30 November 2026.
 * Before the period: INV-A (12 Oct) 1,160,000.00 and a payment of 500,000.00 (20 Oct) →
 * opening 116,000,000 − 50,000,000 = 66,000,000 minor.
 * In the period: INV-B (5 Nov) 232,000.00; payments 300,000.00 on 5 Nov (against INV-A) and
 * 100,000.00 on 28 Nov (against INV-B); INV-C (30 Nov) 58,000.00.
 * Running: 66,000,000 + 23,200,000 = 89,200,000 (INV-B before the same-day payment)
 *          − 30,000,000 = 59,200,000; − 10,000,000 = 49,200,000; + 5,800,000 = 55,000,000.
 * Invoiced 29,000,000; paid 40,000,000; closing 66,000,000 + 29,000,000 − 40,000,000 = 55,000,000.
 * After the period: INV-D (1 Dec) and a payment on 2 Dec are left out.
 */
const invoices = [
  { id: "i-a", invoiceNumber: "INV-A", date: "2026-10-12", totalMinor: 116_000_000 },
  { id: "i-b", invoiceNumber: "INV-B", date: "2026-11-05", totalMinor: 23_200_000 },
  { id: "i-c", invoiceNumber: "INV-C", date: "2026-11-30", totalMinor: 5_800_000 },
  { id: "i-d", invoiceNumber: "INV-D", date: "2026-12-01", totalMinor: 1_000 },
];
const payment = (id: string, invoiceId: string, number: string, date: string, amount: number) => ({
  id,
  invoiceId,
  invoiceNumber: number,
  date,
  amountMinor: amount,
  method: "bank_transfer" as const,
  reference: `FT-${id}`,
});
const payments = [
  payment("p-1", "i-a", "INV-A", "2026-10-20", 50_000_000),
  payment("p-2", "i-a", "INV-A", "2026-11-05", 30_000_000),
  payment("p-3", "i-b", "INV-B", "2026-11-28", 10_000_000),
  payment("p-4", "i-b", "INV-B", "2026-12-02", 500),
];

describe("supplierStatement", () => {
  it("carries the opening balance, orders the period and closes the arithmetic", () => {
    const statement = supplierStatement({
      from: "2026-11-01",
      to: "2026-11-30",
      invoices,
      payments,
    });
    expect(statement).toMatchObject({
      openingMinor: 66_000_000,
      invoicedMinor: 29_000_000,
      paidMinor: 40_000_000,
      closingMinor: 55_000_000,
    });
    expect(
      statement.entries.map((entry) => [
        entry.date,
        entry.kind,
        entry.invoiceNumber,
        entry.debitMinor,
        entry.creditMinor,
        entry.balanceMinor,
      ]),
    ).toEqual([
      ["2026-11-05", "invoice", "INV-B", 23_200_000, 0, 89_200_000],
      ["2026-11-05", "payment", "INV-A", 0, 30_000_000, 59_200_000],
      ["2026-11-28", "payment", "INV-B", 0, 10_000_000, 49_200_000],
      ["2026-11-30", "invoice", "INV-C", 5_800_000, 0, 55_000_000],
    ]);
    expect(statement.entries[1]).toMatchObject({ method: "bank_transfer", reference: "FT-p-2" });
    expect(statement.entries[0]).toMatchObject({ method: null, reference: null });
  });

  it("counts a whole history from its first day, and an empty period keeps the balance", () => {
    expect(
      supplierStatement({ from: "2026-01-01", to: "2026-12-31", invoices, payments }),
    ).toMatchObject({
      openingMinor: 0,
      invoicedMinor: 145_001_000,
      paidMinor: 90_000_500,
      closingMinor: 55_000_500,
    });
    const quiet = supplierStatement({ from: "2026-11-10", to: "2026-11-20", invoices, payments });
    expect(quiet.entries).toEqual([]);
    // 116,000,000 + 23,200,000 − 50,000,000 − 30,000,000
    expect(quiet.openingMinor).toBe(59_200_000);
    expect(quiet.closingMinor).toBe(59_200_000);
  });

  it("refuses an inverted period and amounts that are not whole minor units", () => {
    expect(() =>
      supplierStatement({ from: "2026-11-30", to: "2026-11-01", invoices: [], payments: [] }),
    ).toThrow(RangeError);
    expect(() =>
      supplierStatement({
        from: "2026-11-01",
        to: "2026-11-30",
        invoices: [{ id: "x", invoiceNumber: "X", date: "2026-11-02", totalMinor: 10.5 }],
        payments: [],
      }),
    ).toThrow(RangeError);
  });
});

describe("supplierInvoiceStatus", () => {
  it("says each internal state the way a supplier needs it", () => {
    expect(
      INVOICE_STATUSES.map((status) => [status, supplierInvoiceStatus(status, "supplier_portal")]),
    ).toEqual([
      ["draft", "under_review"],
      ["submitted", "submitted"],
      ["matched", "under_review"],
      ["disputed", "disputed"],
      ["approved", "approved"],
      ["partly_settled", "partly_paid"],
      ["settled", "paid"],
      ["cancelled", "cancelled"],
    ]);
    // A draft keyed by the company's staff is their working copy: never shown to the supplier.
    expect(supplierInvoiceStatus("draft", "company")).toBeNull();
    expect(supplierInvoiceStatus("settled", "company")).toBe("paid");
  });
});
