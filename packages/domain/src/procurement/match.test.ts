import { describe, expect, it } from "vitest";
import { Ratio, threeWayMatch, type ThreeWayMatchInput } from "../index.js";

/**
 * Three-way match golden cases, worked by hand. LPO-0001: line 1 river sand, 21 t ordered at KES
 * 2,000.00 per tonne net (200,000 minor); line 2 ballast, 20 t at KES 2,200.00 (220,000 minor).
 * Order subtotal = 21 × 200,000 + 20 × 220,000 = 4,200,000 + 4,400,000 = 8,600,000 minor.
 * Two GRNs accepted 14 t of sand (two 7 t trips) and 20 t of ballast. VAT 16 % on both lines.
 */
const SAND = "lpo-line-sand";
const BALLAST = "lpo-line-ballast";
const sandPrice = Ratio.of(200_000);
const ballastPrice = Ratio.of(220_000);

type InvoiceLine = { line: string; qty: string; price?: Ratio; amount: number; vatable?: boolean };

function input(
  lines: InvoiceLine[],
  overrides: Partial<Omit<ThreeWayMatchInput, "invoice">> & {
    stated?: { subtotal?: number; vat?: number; total?: number };
  } = {},
): ThreeWayMatchInput {
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  const vatable = lines.filter((line) => line.vatable !== false).reduce((s, l) => s + l.amount, 0);
  const vat = Math.round((vatable * 16) / 100);
  const stated = {
    subtotal: overrides.stated?.subtotal ?? subtotal,
    vat: overrides.stated?.vat ?? vat,
  };
  return {
    quantityTolerancePercent: "0",
    priceTolerancePercent: "0",
    blockWithoutEtims: true,
    etims: { number: "KRACU0400000078/2231", format: "etims" },
    vatRatePercent: "16",
    order: {
      lines: [
        { lpoLineId: SAND, lineNo: 1, orderedBaseQuantity: "21", netPerBase: sandPrice },
        { lpoLineId: BALLAST, lineNo: 2, orderedBaseQuantity: "20", netPerBase: ballastPrice },
      ],
      subtotalMinor: 8_600_000,
    },
    received: new Map([
      [SAND, "14"],
      [BALLAST, "20"],
    ]),
    previouslyInvoiced: new Map(),
    previouslyInvoicedSubtotalMinor: 0,
    ...overrides,
    invoice: {
      lines: lines.map((line) => ({
        lpoLineId: line.line,
        baseQuantity: line.qty,
        netPerBase: line.price ?? (line.line === BALLAST ? ballastPrice : sandPrice),
        netAmountMinor: line.amount,
        vatable: line.vatable !== false,
      })),
      subtotalMinor: stated.subtotal,
      vatMinor: stated.vat,
      totalMinor: overrides.stated?.total ?? stated.subtotal + stated.vat,
    },
  };
}

// Billing what was received: 14 × 200,000 + 20 × 220,000 = 2,800,000 + 4,400,000 = 7,200,000;
// VAT 1,152,000; total 8,352,000.
const received: InvoiceLine[] = [
  { line: SAND, qty: "14", amount: 2_800_000 },
  { line: BALLAST, qty: "20", amount: 4_400_000 },
];

describe("three-way match", () => {
  it("matches an invoice for exactly what was ordered and received", () => {
    const result = threeWayMatch(input(received));
    expect(result.outcome).toBe("matched");
    expect(result.reasons).toEqual([]);
    expect(result.exceptable).toBe(false);
    expect(result.totals).toMatchObject({
      computedSubtotalMinor: 7_200_000,
      computedVatMinor: 1_152_000,
      computedTotalMinor: 8_352_000,
      roundingAllowanceMinor: 2,
      allowedSubtotalMinor: 8_600_002,
    });
    expect(result.lines[0]).toMatchObject({
      lpoLineId: SAND,
      orderedQuantity: "21",
      receivedQuantity: "14",
      invoicedQuantity: "14",
      cumulativeQuantity: "14",
      allowedQuantity: "14",
      orderNetUnitPriceMinor: "200000",
      invoiceNetUnitPriceMinor: "200000",
      reasons: [],
    });
  });

  it("blocks billing for goods not yet received (the acceptance case)", () => {
    // 21 t billed, 14 t accepted: 21 > 14 × 1.00.
    const result = threeWayMatch(
      input([
        { line: SAND, qty: "21", amount: 4_200_000 },
        { line: BALLAST, qty: "20", amount: 4_400_000 },
      ]),
    );
    expect(result.outcome).toBe("mismatch");
    expect(result.reasons).toEqual(["qty-exceeds-received"]);
    expect(result.lines[0]!.reasons).toEqual(["qty-exceeds-received"]);
    expect(result.lines[1]!.reasons).toEqual([]);
    expect(result.exceptable).toBe(true);
  });

  it("refuses lines with nothing accepted and quantities above the order", () => {
    const nothing = threeWayMatch(
      input([{ line: SAND, qty: "7", amount: 1_400_000 }], { received: new Map() }),
    );
    expect(nothing.reasons).toEqual(["not-received"]);
    // 25 t accepted (over-delivery) but only 21 ordered: billing 25 exceeds the order.
    const over = threeWayMatch(
      input([{ line: SAND, qty: "25", amount: 5_000_000 }], {
        received: new Map([[SAND, "25"]]),
      }),
    );
    expect(over.reasons).toEqual(["qty-exceeds-ordered"]);
  });

  it("applies the quantity tolerance inclusively", () => {
    // 5 %: allowed = 14 × 1.05 = 14.7 t.
    const at = threeWayMatch(
      input([{ line: SAND, qty: "14.7", amount: 2_940_000 }], { quantityTolerancePercent: "5" }),
    );
    expect(at.outcome).toBe("matched");
    expect(at.lines[0]!.allowedQuantity).toBe("14.7");
    const above = threeWayMatch(
      input([{ line: SAND, qty: "14.700001", amount: 2_940_000 }], {
        quantityTolerancePercent: "5",
      }),
    );
    expect(above.reasons).toEqual(["qty-exceeds-received"]);
  });

  it("compares net prices per base unit with the price tolerance", () => {
    // One cent per tonne above the LPO at 0 % fails.
    const dearer = threeWayMatch(
      input([{ line: SAND, qty: "14", price: Ratio.of(200_001), amount: 2_800_014 }]),
    );
    expect(dearer.reasons).toEqual(["price-above-order"]);
    expect(dearer.lines[0]!.invoiceNetUnitPriceMinor).toBe("200001");
    // 0.0005 % of 200,000 = 1 minor unit: exactly at the limit passes.
    const tolerated = threeWayMatch(
      input([{ line: SAND, qty: "14", price: Ratio.of(200_001), amount: 2_800_014 }], {
        priceTolerancePercent: "0.0005",
      }),
    );
    expect(tolerated.outcome).toBe("matched");
    expect(tolerated.lines[0]!.allowedNetUnitPriceMinor).toBe("200001");
    // A lower price passes with a warning.
    const cheaper = threeWayMatch(
      input([{ line: SAND, qty: "14", price: Ratio.of(190_000), amount: 2_660_000 }]),
    );
    expect(cheaper.outcome).toBe("matched");
    expect(cheaper.warnings).toEqual(["price-below-order"]);
    // VAT-inclusive invoice prices are compared net: 232,000 incl. 16 % = 200,000 net exactly.
    const inclusive = threeWayMatch(
      input([
        {
          line: SAND,
          qty: "14",
          price: Ratio.of(232_000).times(Ratio.of(100, 116)),
          amount: 2_800_000,
        },
      ]),
    );
    expect(inclusive.outcome).toBe("matched");
  });

  it("prevents double billing across invoices", () => {
    // An approved invoice already billed 14 t of sand; billing 7 t more exceeds the 14 t accepted.
    const second = threeWayMatch(
      input([{ line: SAND, qty: "7", amount: 1_400_000 }], {
        previouslyInvoiced: new Map([[SAND, "14"]]),
        previouslyInvoicedSubtotalMinor: 2_800_000,
      }),
    );
    expect(second.reasons).toEqual(["qty-exceeds-received"]);
    expect(second.lines[0]).toMatchObject({
      previouslyInvoicedQuantity: "14",
      cumulativeQuantity: "21",
      allowedQuantity: "14",
    });
    // Once the third trip is received the same invoice matches (21 = 21 ordered = 21 accepted).
    const afterGrn = threeWayMatch(
      input([{ line: SAND, qty: "7", amount: 1_400_000 }], {
        received: new Map([
          [SAND, "21"],
          [BALLAST, "20"],
        ]),
        previouslyInvoiced: new Map([[SAND, "14"]]),
        previouslyInvoicedSubtotalMinor: 2_800_000,
      }),
    );
    expect(afterGrn.outcome).toBe("matched");
    // The whole order is then billed: any further sand exceeds both the order and receipts.
    const third = threeWayMatch(
      input([{ line: SAND, qty: "1", amount: 200_000 }], {
        received: new Map([[SAND, "21"]]),
        previouslyInvoiced: new Map([[SAND, "21"]]),
        previouslyInvoicedSubtotalMinor: 8_600_000,
      }),
    );
    expect(third.reasons).toEqual([
      "total-exceeds-order",
      "qty-exceeds-received",
      "qty-exceeds-ordered",
    ]);
  });

  it("recomputes the subtotal and VAT within one minor unit per line", () => {
    const within = threeWayMatch(input(received, { stated: { subtotal: 7_200_002 } }));
    // Total follows the stated figures (subtotal + VAT), so only the rounding allowance applies.
    expect(within.reasons).toEqual([]);
    const off = threeWayMatch(input(received, { stated: { subtotal: 7_200_003 } }));
    expect(off.reasons).toEqual(["subtotal-mismatch"]);
    const vat = threeWayMatch(input(received, { stated: { vat: 1_152_100 } }));
    expect(vat.reasons).toEqual(["vat-mismatch"]);
    const arithmetic = threeWayMatch(input(received, { stated: { total: 8_352_001 } }));
    expect(arithmetic.reasons).toEqual(["total-arithmetic"]);
    expect(arithmetic.exceptable).toBe(false);
    // VAT applies only to VAT-able lines.
    const exempt = threeWayMatch(
      input([{ line: SAND, qty: "14", amount: 2_800_000, vatable: false }], {
        stated: { vat: 0 },
      }),
    );
    expect(exempt.outcome).toBe("matched");
    expect(exempt.totals.computedVatMinor).toBe(0);
  });

  it("blocks a missing eTIMS number when configured, and never lets an exception override it", () => {
    const blocked = threeWayMatch(input(received, { etims: { number: null, format: null } }));
    expect(blocked.reasons).toEqual(["etims-missing"]);
    expect(blocked.exceptable).toBe(false);
    const mixed = threeWayMatch(
      input([{ line: SAND, qty: "21", amount: 4_200_000 }], {
        etims: { number: "  ", format: null },
      }),
    );
    expect(mixed.reasons).toEqual(["etims-missing", "qty-exceeds-received"]);
    expect(mixed.exceptable).toBe(false);
    const warned = threeWayMatch(
      input(received, { blockWithoutEtims: false, etims: { number: null, format: null } }),
    );
    expect(warned.outcome).toBe("matched");
    expect(warned.warnings).toEqual(["etims-missing"]);
    const unrecognised = threeWayMatch(
      input(received, { etims: { number: "0040799720000000123", format: "unrecognised" } }),
    );
    expect(unrecognised.outcome).toBe("matched");
    expect(unrecognised.warnings).toEqual(["etims-format-unrecognised"]);
  });

  it("refuses empty invoices and lines that are not on the order", () => {
    const empty = threeWayMatch(input([]));
    expect(empty.reasons).toEqual(["invoice-empty"]);
    const stranger = threeWayMatch(input([{ line: "elsewhere", qty: "1", amount: 200_000 }]));
    expect(stranger.reasons).toEqual(["line-not-on-order"]);
    expect(stranger.lines.at(-1)).toMatchObject({ lpoLineId: "elsewhere", lineNo: 0 });
    expect(stranger.exceptable).toBe(false);
  });
});
