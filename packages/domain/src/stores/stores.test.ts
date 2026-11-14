import { describe, expect, it } from "vitest";
import { checkProcurementTransition, statusChanges } from "../procurement/lifecycle.js";
import { Ratio } from "../materials/ratio.js";
import {
  applyEntry,
  averageUnitCost,
  consumptionVariance,
  countVariance,
  divideRound,
  EMPTY_POSITION,
  fromMicro,
  isLowStock,
  microToMinor,
  receiveIntoStock,
  returnableQuantity,
  roundDecimal,
  STOCK_TAKE_TRANSITIONS,
  sumDecimals,
  reverseInflow,
  takeFromStock,
  theoreticalConsumption,
  toMicro,
  TRANSFER_TRANSITIONS,
} from "./index.js";

describe("six-decimal fixed point", () => {
  it("parses and formats signed decimals exactly", () => {
    expect(toMicro("12")).toBe(12_000_000n);
    expect(toMicro("-0.5")).toBe(-500_000n);
    expect(toMicro(" 1234.123456 ")).toBe(1_234_123_456n);
    expect(toMicro("-0")).toBe(0n);
    expect(fromMicro(-1_500_000n)).toBe("-1.5");
    expect(fromMicro(0n)).toBe("0");
    expect(() => toMicro("1.1234567")).toThrow(TypeError);
    expect(() => toMicro("1e3")).toThrow(TypeError);
    expect(() => toMicro("")).toThrow(TypeError);
  });

  it("rounds half away from zero, like PostgreSQL round(numeric)", () => {
    expect(divideRound(5n, 2n)).toBe(3n);
    expect(divideRound(-5n, 2n)).toBe(-3n);
    expect(divideRound(4n, 3n)).toBe(1n);
    expect(divideRound(-4n, 3n)).toBe(-1n);
    expect(roundDecimal("1234.56789", 2)).toBe("1234.57");
    expect(roundDecimal("-0.005", 2)).toBe("-0.01");
    expect(roundDecimal("7", 1)).toBe("7.0");
    expect(microToMinor(toMicro("9241379.5"))).toBe(9_241_380);
    expect(microToMinor(toMicro("-0.5"))).toBe(-1);
  });
});

describe("weighted average valuation", () => {
  it("values receipts at their cost and issues at the moving average (worked by hand)", () => {
    // 100 bags at KES 750.00 net per bag.
    const first = receiveIntoStock(EMPTY_POSITION, "100", "75000");
    expect(first).toEqual({
      valueMinor: "7500000",
      after: { quantity: "100", valueMinor: "7500000" },
    });
    // 50 bags at KES 940 incl. 16 % VAT: net 81,034.482759 cents per bag → 4,051,724.13795.
    const second = receiveIntoStock(first.after, "50", "81034.482759");
    expect(second.valueMinor).toBe("4051724.13795");
    expect(second.after).toEqual({ quantity: "150", valueMinor: "11551724.13795" });
    // 11,551,724.13795 ÷ 150 = 77,011.494253 exactly.
    expect(averageUnitCost(second.after)).toBe("77011.494253");
    // 30 bags out: 30 ÷ 150 of the value = 2,310,344.82759.
    const issued = takeFromStock(second.after, "30");
    expect(issued).toEqual({
      ok: true,
      valueMinor: "2310344.82759",
      unitCostMinor: "77011.494253",
      after: { quantity: "120", valueMinor: "9241379.31036" },
    });
  });

  it("refuses to go below zero and empties a position with all of its value", () => {
    const position = { quantity: "120", valueMinor: "9241379.31036" };
    expect(takeFromStock(position, "120.000001")).toEqual({
      ok: false,
      reason: "insufficient-stock",
      available: "120",
    });
    const all = takeFromStock(position, "120");
    expect(all.ok && all.valueMinor).toBe("9241379.31036");
    expect(all.ok && all.after).toEqual({ quantity: "0", valueMinor: "0" });
  });

  it("never leaves a rounding residue on zero stock", () => {
    // KES 1.00 over three units: 33.333333 then 66.666667 (the rest), summing to exactly 100.
    const one = takeFromStock({ quantity: "3", valueMinor: "100" }, "1");
    expect(one.ok && one.valueMinor).toBe("33.333333");
    const rest = takeFromStock(one.ok ? one.after : EMPTY_POSITION, "2");
    expect(rest.ok && rest.valueMinor).toBe("66.666667");
    expect(sumDecimals(["33.333333", "66.666667"])).toBe("100");
    expect(averageUnitCost({ quantity: "0", valueMinor: "0" })).toBeNull();
  });

  it("applies signed entries and rejects negative or valued-empty positions", () => {
    expect(
      applyEntry({ quantity: "5", valueMinor: "500" }, { quantity: "-2", valueMinor: "-200" }),
    ).toEqual({
      quantity: "3",
      valueMinor: "300",
    });
    expect(() =>
      applyEntry({ quantity: "1", valueMinor: "100" }, { quantity: "-2", valueMinor: "-100" }),
    ).toThrow(RangeError);
    expect(() =>
      applyEntry({ quantity: "1", valueMinor: "100" }, { quantity: "-1", valueMinor: "-99" }),
    ).toThrow(RangeError);
    expect(() => receiveIntoStock(EMPTY_POSITION, "0", "1")).toThrow(RangeError);
    expect(() => takeFromStock(EMPTY_POSITION, "-1")).toThrow(RangeError);
  });

  it("reverses a mistaken receipt at its own value, so the position is as it was", () => {
    // 50 bags worth KES 100,000; 100 bags received at KES 1,000 by mistake, then voided.
    const before = { quantity: "50", valueMinor: "10000000" };
    const received = receiveIntoStock(before, "100", "100000");
    const voided = reverseInflow(received.after, {
      quantity: "100",
      valueMinor: received.valueMinor,
      unitCostMinor: "100000",
    });
    expect(voided).toMatchObject({ ok: true, valueMinor: "10000000", unitCostMinor: "100000" });
    expect(voided.ok && voided.after).toEqual(before);
    // Emptying takes all that is left; a value no longer there falls back to the average.
    expect(
      reverseInflow(
        { quantity: "10", valueMinor: "900" },
        {
          quantity: "10",
          valueMinor: "1000",
          unitCostMinor: "100",
        },
      ),
    ).toMatchObject({ ok: true, valueMinor: "900", after: { quantity: "0", valueMinor: "0" } });
    expect(
      reverseInflow(
        { quantity: "20", valueMinor: "900" },
        {
          quantity: "10",
          valueMinor: "1000",
          unitCostMinor: "100",
        },
      ),
    ).toMatchObject({ ok: true, valueMinor: "450", unitCostMinor: "45" });
    expect(
      reverseInflow(
        { quantity: "5", valueMinor: "500" },
        {
          quantity: "10",
          valueMinor: "1000",
          unitCostMinor: "100",
        },
      ),
    ).toEqual({ ok: false, reason: "insufficient-stock", available: "5" });
  });

  it("flags low stock at or below a positive reorder level", () => {
    expect(isLowStock("5", "5")).toBe(true);
    expect(isLowStock("5.000001", "5")).toBe(false);
    expect(isLowStock("0", "0")).toBe(false);
    expect(isLowStock("0", null)).toBe(false);
  });
});

describe("theoretical consumption and variance", () => {
  it("multiplies measured work by the build-up, waste and the unit conversion exactly", () => {
    // 12.5 m³ of class 25 concrete × 6.5 bags/m³ × 1.05 = 85.3125 bags.
    const bags = {
      measuredQuantity: "12.5",
      quantityPerUnit: "6.5",
      wastePercent: "5",
      basePerUnit: Ratio.ONE,
    };
    expect(theoreticalConsumption(bags)).toBe("85.3125");
    // The same in kilograms (a 50 kg bag): 4,265.625 kg.
    expect(theoreticalConsumption({ ...bags, basePerUnit: Ratio.of(50) })).toBe("4265.625");
    // Sand: 12.5 × 0.7 t × 1.10 = 9.625 t = 9,625 kg; no waste stated means none.
    expect(
      theoreticalConsumption({
        measuredQuantity: "12.5",
        quantityPerUnit: "0.7",
        wastePercent: "10",
        basePerUnit: Ratio.of(1000),
      }),
    ).toBe("9625");
    expect(theoreticalConsumption({ ...bags, wastePercent: null, measuredQuantity: "2" })).toBe(
      "13",
    );
    // Rounded once, half-up: 0.000001 × 1.5 = 0.0000015 → 0.000002.
    expect(
      theoreticalConsumption({
        measuredQuantity: "1",
        quantityPerUnit: "0.000001",
        wastePercent: "50",
        basePerUnit: Ratio.ONE,
      }),
    ).toBe("0.000002");
  });

  it("fires an alert only when actual is strictly above theoretical plus the threshold", () => {
    const alert = consumptionVariance({
      theoretical: "85.3125",
      issued: "110",
      returned: "5",
      thresholdPercent: "10",
    });
    // actual 105; limit 85.3125 × 1.1 = 93.84375; variance 19.6875 = 23.08 % → 23.1.
    expect(alert).toEqual({
      actual: "105",
      variance: "19.6875",
      variancePercent: "23.1",
      limit: "93.84375",
      state: "alert",
    });
    const atLimit = consumptionVariance({
      theoretical: "85.3125",
      issued: "93.84375",
      returned: "0",
      thresholdPercent: "10",
    });
    expect(atLimit.state).toBe("within");
    expect(atLimit.variancePercent).toBe("10.0");
    const under = consumptionVariance({
      theoretical: "85.3125",
      issued: "80",
      returned: "0",
      thresholdPercent: "10",
    });
    expect([under.state, under.variance, under.variancePercent]).toEqual([
      "within",
      "-5.3125",
      "-6.2",
    ]);
    const zeroThreshold = consumptionVariance({
      theoretical: "10",
      issued: "10.000001",
      returned: "0",
      thresholdPercent: "0",
    });
    expect(zeroThreshold.state).toBe("alert");
  });

  it("reports no progress instead of a percentage when nothing was measured as built", () => {
    expect(
      consumptionVariance({ theoretical: "0", issued: "3", returned: "0", thresholdPercent: "10" }),
    ).toMatchObject({ state: "no_progress", variancePercent: null, actual: "3" });
    expect(
      consumptionVariance({ theoretical: "0", issued: "3", returned: "3", thresholdPercent: "10" }),
    ).toMatchObject({ state: "within", variancePercent: null, actual: "0" });
  });

  it("computes returnable quantities and stock-take variances", () => {
    expect(returnableQuantity("10", "3.5")).toBe("6.5");
    expect(returnableQuantity("10", "12")).toBe("0");
    expect(countVariance("40", "38.5")).toBe("-1.5");
    expect(countVariance("40", "41")).toBe("1");
  });
});

describe("stores state machines", () => {
  it("lets a stock take be approved only after submission and returned only with a reason", () => {
    expect(checkProcurementTransition(STOCK_TAKE_TRANSITIONS, "draft", "approve")).toEqual({
      ok: false,
      error: "invalid_transition",
    });
    expect(checkProcurementTransition(STOCK_TAKE_TRANSITIONS, "submitted", "return", " ")).toEqual({
      ok: false,
      error: "reason_required",
    });
    expect(checkProcurementTransition(STOCK_TAKE_TRANSITIONS, "submitted", "approve")).toEqual({
      ok: true,
      to: "approved",
    });
    expect(statusChanges(STOCK_TAKE_TRANSITIONS)).toEqual([
      ["draft", "submitted"],
      ["submitted", "approved"],
      ["submitted", "draft"],
      ["draft", "cancelled"],
      ["submitted", "cancelled"],
    ]);
  });

  it("moves transfers from dispatched only, and resolves disputes with a reason", () => {
    expect(checkProcurementTransition(TRANSFER_TRANSITIONS, "received", "cancel", "x y z")).toEqual(
      { ok: false, error: "invalid_transition" },
    );
    expect(checkProcurementTransition(TRANSFER_TRANSITIONS, "disputed", "resolve", "")).toEqual({
      ok: false,
      error: "reason_required",
    });
    expect(statusChanges(TRANSFER_TRANSITIONS)).toEqual([
      ["dispatched", "received"],
      ["dispatched", "disputed"],
      ["disputed", "resolved"],
      ["dispatched", "cancelled"],
    ]);
  });
});
