import { describe, expect, it } from "vitest";
import {
  barWidth,
  certificateTone,
  conversionUnavailable,
  formatForeignMinor,
  formatRate,
  indicative,
  parseCurrency,
  sectionHref,
} from "./client-portal";

const today = "2026-11-14";
const usd = {
  currency: "USD" as const,
  rate: { currency: "USD" as const, kesPerUnit: "129.4500", rateDate: today, source: "Synthetic" },
};

describe("indicative amounts", () => {
  it("converts at the dated rate and trims the rate's zeros", () => {
    // KES 123,456.00 ÷ 129.45 = 953.6964… → USD 953.70.
    expect(indicative(12_345_600, usd, today)).toEqual({
      amount: "USD 953.70",
      rate: "129.45",
      currency: "USD",
      rateDate: today,
    });
    expect(formatForeignMinor(-123_456_789, "GBP")).toBe("\u2212GBP 1,234,567.89");
  });

  it("shows nothing for KES, a missing rate, a missing amount or a rate older than 31 days", () => {
    expect(indicative(100, { currency: "KES", rate: null }, today)).toBeNull();
    expect(indicative(100, { currency: "EUR", rate: null }, today)).toBeNull();
    expect(indicative(null, usd, today)).toBeNull();
    expect(indicative(100, usd, "2026-12-16")).toBeNull();
    expect(conversionUnavailable({ currency: "EUR", rate: null })).toBe(true);
    expect(conversionUnavailable({ currency: "KES", rate: null })).toBe(false);
  });

  it("trims trailing zeros in linear time without touching other digits", () => {
    expect(formatRate("170.1000")).toBe("170.1");
    expect(formatRate("150.0000")).toBe("150");
    expect(formatRate("100")).toBe("100");
    expect(formatRate("1000.0500")).toBe("1000.05");
    expect(formatRate(`1.${"0".repeat(50_000)}`)).toBe("1");
  });
});

describe("portal helpers", () => {
  it("never turns a missing percentage into 0", () => {
    expect(barWidth(null)).toBeNull();
    expect(barWidth("40.7")).toBe(40.7);
    expect(barWidth("120.0")).toBe(100);
    expect(barWidth("-3.0")).toBe(0);
  });

  it("marks overdue before anything else and paid only when settled", () => {
    expect(certificateTone("part_paid", true)).toBe("danger");
    expect(certificateTone("paid", false)).toBe("success");
    expect(certificateTone("unpaid", false)).toBe("neutral");
  });

  it("accepts only the offered display currencies and builds section links", () => {
    expect(parseCurrency("GBP")).toBe("GBP");
    expect(parseCurrency("JPY")).toBeUndefined();
    expect(parseCurrency(["USD"])).toBeUndefined();
    expect(sectionHref("p1", "overview")).toBe("/portal/projects/p1");
    expect(sectionHref("p1", "pay")).toBe("/portal/projects/p1/pay");
  });
});
