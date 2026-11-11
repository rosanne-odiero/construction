import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatForeign,
  formatKES,
  formatKESCompact,
  formatPercent,
  formatTime,
  maskId,
  maskPhone,
  normalizeKenyanPhone,
} from "./format";

describe("Kenyan display conventions", () => {
  it("formats integer cents without losing the settlement precision", () => {
    expect(formatKES(125_000_000)).toBe("KES 1,250,000");
    expect(formatKES(125_050)).toBe("KES 1,250.50");
    expect(formatKES(-125_050)).toBe("\u2212KES 1,250.50");
    expect(formatKES(0)).toBe("KES 0");
    expect(formatKESCompact(125_000_000)).toBe("KES 1.3M");
  });

  it("uses Nairobi time and DD/MM/YYYY across UTC date boundaries", () => {
    expect(formatDate("2026-11-10T22:15:00Z")).toBe("11/11/2026");
    expect(formatTime("2026-11-10T22:15:00Z")).toBe("01:15");
    expect(formatDateTime("2026-11-10T22:15:00Z")).toBe("11/11/2026 01:15");
  });

  it("normalises and masks Kenyan phone numbers", () => {
    expect(normalizeKenyanPhone("0712 000 001")).toBe("254712000001");
    expect(normalizeKenyanPhone("+254 112 000 001")).toBe("254112000001");
    expect(normalizeKenyanPhone("not a phone")).toBeNull();
    expect(maskPhone("254712000001")).not.toContain("712000001");
    expect(maskId("SYNTHETIC-1234")).toBe("••••1234");
  });

  it("does not mutate the KES amount when displaying foreign currency", () => {
    const minor = 1_300_000;
    expect(formatForeign(minor, "USD", 130)).toBe("US$100");
    expect(minor).toBe(1_300_000);
    expect(formatPercent(0.125, 1)).toBe("12.5%");
  });
});

describe("project and geofence formats", () => {
  it("shows calendar dates as DD/MM/YYYY without a time-zone shift", async () => {
    const { formatCalendarDate } = await import("./format");
    expect(formatCalendarDate("2026-03-02")).toBe("02/03/2026");
    expect(formatCalendarDate("2027-12-31")).toBe("31/12/2027");
  });

  it("shows areas, lengths and weights in readable units", async () => {
    const { formatArea, formatBasisPoints, formatLength } = await import("./format");
    expect(formatArea(2_925.4)).toBe("2,925 m²");
    expect(formatArea(31_415.9)).toBe("3.14 ha");
    expect(formatLength(234.2)).toBe("234 m");
    expect(formatLength(1_256.6)).toBe("1.26 km");
    expect(formatBasisPoints(2_550)).toBe("25.5%");
    expect(formatBasisPoints(10_000)).toBe("100%");
  });
});
