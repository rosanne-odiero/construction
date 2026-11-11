import { describe, expect, it } from "vitest";
import { correctionApplies, sameEntryValues } from "./attendance-mappers.js";

const stored = {
  id: "record-1",
  status: "present",
  checkInMinutes: 420,
  checkOutMinutes: 960,
  overnight: false,
  breakMinutes: null,
  notes: null,
};
const previous = {
  status: "present" as const,
  checkIn: "07:00",
  checkOut: "16:00",
  overnight: false,
  breakMinutes: null,
  notes: null,
};

describe("correctionApplies (no lost update, review finding 4)", () => {
  it("applies while the day is submitted or confirmed and the record is unchanged", () => {
    for (const dayStatus of ["submitted", "confirmed"])
      expect(correctionApplies({ dayStatus, recordId: "record-1", previous, record: stored })).toBe(
        true,
      );
  });

  it("refuses once the day went back to draft", () => {
    expect(
      correctionApplies({ dayStatus: "draft", recordId: "record-1", previous, record: stored }),
    ).toBe(false);
  });

  it("refuses when the record changed after the correction was asked for", () => {
    for (const record of [
      { ...stored, checkOutMinutes: 1020 },
      { ...stored, status: "half_day" },
      { ...stored, notes: "Changed by the foreman" },
      { ...stored, breakMinutes: 30 },
      { ...stored, id: "record-2" },
    ])
      expect(
        correctionApplies({ dayStatus: "submitted", recordId: "record-1", previous, record }),
      ).toBe(false);
    expect(
      correctionApplies({ dayStatus: "submitted", recordId: "record-1", previous, record: null }),
    ).toBe(false);
  });

  it("refuses a correction for a missing record once a record exists", () => {
    expect(
      correctionApplies({ dayStatus: "confirmed", recordId: null, previous: null, record: null }),
    ).toBe(true);
    expect(
      correctionApplies({ dayStatus: "confirmed", recordId: null, previous: null, record: stored }),
    ).toBe(false);
  });

  it("compares every entry value", () => {
    expect(sameEntryValues(previous, { ...previous })).toBe(true);
    expect(sameEntryValues(previous, { ...previous, overnight: true })).toBe(false);
    expect(sameEntryValues(previous, { ...previous, checkIn: "07:01" })).toBe(false);
  });
});
