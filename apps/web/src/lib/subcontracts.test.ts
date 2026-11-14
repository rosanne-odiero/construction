import { describe, expect, it } from "vitest";
import {
  parseChangeInput,
  parseDecimalInput,
  parsePercentInput,
  subcontractAccess,
} from "./subcontracts";

describe("subcontract inputs", () => {
  it("reads quantities as typed, with at most the allowed decimals", () => {
    expect(parseDecimalInput(" 1,250.50 ", 4)).toBe("1250.5");
    expect(parseDecimalInput("12.0000", 4)).toBe("12");
    expect(parseDecimalInput("12.00001", 4)).toBeNull();
    expect(parseDecimalInput("10.001", 3)).toBe("10.001");
    expect(parseDecimalInput("10.0001", 3)).toBeNull();
    expect(parseDecimalInput("0", 4)).toBeNull();
    expect(parseDecimalInput("0", 4, { allowZero: true })).toBe("0");
    for (const bad of ["", "-1", "1e3", "01", "1.", ".5", "1.2.3", "12a"])
      expect(parseDecimalInput(bad, 4), bad).toBeNull();
    // A long run of zeros is trimmed in linear time.
    expect(parseDecimalInput(`1.${"0".repeat(3)}`, 4)).toBe("1");
  });

  it("reads signed variation changes and bounded percentages", () => {
    expect(parseChangeInput("-50")).toBe("-50");
    expect(parseChangeInput("12.5")).toBe("12.5");
    expect(parseChangeInput("-0")).toBeNull();
    expect(parsePercentInput("5")).toBe("5");
    expect(parsePercentInput("100.5")).toBeNull();
    expect(parsePercentInput("2.555")).toBeNull();
    expect(parsePercentInput("0")).toBe("0");
  });

  it("shows subcontracts to commercial and finance roles and piece-rate jobs to payroll and site roles", () => {
    expect(subcontractAccess(["bq.edit"])).toEqual({ read: true, prepare: true, pieceRate: false });
    expect(subcontractAccess(["finance.view"])).toMatchObject({ read: true, prepare: false });
    expect(subcontractAccess(["attendance.record"])).toEqual({
      read: false,
      prepare: false,
      pieceRate: true,
    });
  });
});
