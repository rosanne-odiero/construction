import { describe, expect, it } from "vitest";
import {
  collectPages,
  formatChange,
  formatComparedPrices,
  formatFactor,
  formatMinorDecimal,
  unitLabel,
} from "./procurement";

describe("procurement display helpers", () => {
  it("formats decimal minor units exactly", () => {
    expect(formatMinorDecimal("10102.40625")).toBe("KES 101.02");
    expect(formatMinorDecimal("400000")).toBe("KES 4,000.00");
    expect(formatMinorDecimal("428571.428571")).toBe("KES 4,285.71");
    expect(formatMinorDecimal("0.001")).toBe("KES 0.00");
  });

  it("shows compared prices precisely enough that different ones never look equal", () => {
    // KES 100 incl. 16% VAT is 8620.689655 minor net; an invoice at KES 86.21 net is above it.
    expect(formatComparedPrices(["8620.689655", "8620.689655", "8621"])).toEqual([
      "KES 86.207",
      "KES 86.207",
      "KES 86.210",
    ]);
    expect(formatComparedPrices(["8620.689655", "8620.689656"])).toEqual([
      "KES 86.20689655",
      "KES 86.20689656",
    ]);
    // Equal prices keep the usual two places.
    expect(formatComparedPrices(["400000", "400000.000000"])).toEqual([
      "KES 4,000.00",
      "KES 4,000.00",
    ]);
  });

  it("formats changes, factors and unit labels", () => {
    expect(formatChange("12.4989")).toBe("+12.4989%");
    expect(formatChange("-2.7273")).toBe("\u22122.7273%");
    expect(formatChange("0")).toBe("0%");
    expect(formatFactor("0.888888888889")).toBe("0.888889");
    expect(formatFactor("1000")).toBe("1,000");
    const translate = (code: string) => `[${code}]`;
    expect(unitLabel("t", translate)).toBe("[t]");
    expect(unitLabel("debe", translate, [{ code: "debe", name: "Debe (20 l)" }])).toBe(
      "Debe (20 l)",
    );
    expect(unitLabel("karai", translate)).toBe("karai");
  });
});

describe("picker paging", () => {
  const pages = (count: number, failAt?: number) => {
    const calls: (string | null)[] = [];
    const fetchPage = async (cursor: string | null) => {
      calls.push(cursor);
      const index = calls.length - 1;
      if (index === failAt) return null;
      return {
        items: [index * 2, index * 2 + 1],
        nextCursor: index + 1 < count ? `c${index + 1}` : null,
      };
    };
    return { calls, fetchPage };
  };

  it("follows the cursor past the first 200 records to the last page", async () => {
    const { calls, fetchPage } = pages(3);
    expect(await collectPages(fetchPage)).toEqual({ items: [0, 1, 2, 3, 4, 5], complete: true });
    expect(calls).toEqual([null, "c1", "c2"]);
  });

  it("stops at the page limit and on failures", async () => {
    const capped = pages(50);
    expect(await collectPages(capped.fetchPage, 2)).toEqual({
      items: [0, 1, 2, 3],
      complete: false,
    });
    expect(capped.calls).toHaveLength(2);
    expect(await collectPages(pages(3, 0).fetchPage)).toBeNull();
    expect(await collectPages(pages(3, 1).fetchPage)).toEqual({ items: [0, 1], complete: false });
  });
});
