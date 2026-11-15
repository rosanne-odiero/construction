import { Ratio } from "@pm-buddy/domain";
import { describe, expect, it } from "vitest";
import { invoiceTotals } from "./p2p";

const line = (quantity: string, price = "1000") => ({
  quantity,
  price,
  vat: "exclusive" as const,
  perBase: Ratio.ONE,
});

describe("invoice totals while typing", () => {
  it("reads a quantity with spaces around it as the API will (trimmed)", () => {
    expect(invoiceTotals([line("14 ")], "16")).toEqual(invoiceTotals([line("14")], "16"));
    expect(invoiceTotals([line(" 14")], "16")).toMatchObject({ subtotalMinor: 1_400_000 });
  });

  it("gives no totals, rather than throwing, for incomplete or out-of-range lines", () => {
    expect(invoiceTotals([line("")], "16")).toBeNull();
    expect(invoiceTotals([line("1.2.3")], "16")).toBeNull();
    expect(invoiceTotals([line("14", "abc")], "16")).toBeNull();
    // 10⁸ × KES 10⁶ is 10¹⁶ minor units, beyond what an exact integer amount can hold.
    expect(invoiceTotals([line("100000000", "1000000")], "16")).toBeNull();
  });
});
