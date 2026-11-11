import { describe, expect, it } from "vitest";
import { DEMO_TIMESHEET_RULE } from "@pm-buddy/types";
import {
  dateParam,
  defaultShift,
  draftOf,
  entryOf,
  hours,
  musterHref,
  sameEntry,
  uuidParam,
} from "./attendance";

describe("attendance page helpers", () => {
  it("reads dates typed as DD/MM/YYYY or ISO and refuses impossible dates", () => {
    expect(dateParam("2026-11-10")).toBe("2026-11-10");
    expect(dateParam("10/11/2026")).toBe("2026-11-10");
    expect(dateParam("2026-02-30")).toBeUndefined();
    expect(dateParam("31/04/2026")).toBeUndefined();
    expect(dateParam(["2026-11-10"])).toBeUndefined();
    expect(dateParam(undefined)).toBeUndefined();
  });

  it("accepts only UUID identifiers from the address bar", () => {
    expect(uuidParam("30000000-0000-4000-8000-000000000001")).toBe(
      "30000000-0000-4000-8000-000000000001",
    );
    expect(uuidParam("../settings")).toBeUndefined();
  });

  it("builds muster links without empty parameters", () => {
    expect(musterHref({ project: "p", site: "s", date: "2026-11-10", gang: null })).toBe(
      "/attendance/muster?project=p&site=s&date=2026-11-10",
    );
  });

  it("formats integer minutes as h:mm", () => {
    expect(hours(0)).toBe("0:00");
    expect(hours(485)).toBe("8:05");
    expect(hours(-30)).toBe("-0:30");
  });

  it("derives the default shift from the rule (demo: 07:00 to 16:00 with the 1 h break)", () => {
    expect(defaultShift(DEMO_TIMESHEET_RULE)).toEqual({ checkIn: "07:00", checkOut: "16:00" });
    expect(
      defaultShift({
        dayStartMinutes: 360,
        normalMinutes: 240,
        defaultBreakMinutes: 30,
        breakAfterMinutes: 300,
      }),
    ).toEqual({ checkIn: "06:00", checkOut: "10:00" });
    expect(defaultShift(null)).toEqual({ checkIn: "07:00", checkOut: "16:00" });
  });

  it("turns drafts into request values: times only for worked statuses", () => {
    const draft = {
      status: "absent" as const,
      checkIn: "07:00",
      checkOut: "16:00",
      overnight: true,
      breakMinutes: "30",
      notes: "  ",
    };
    expect(entryOf(draft)).toEqual({
      status: "absent",
      checkIn: null,
      checkOut: null,
      overnight: false,
      breakMinutes: null,
      notes: null,
    });
    expect(entryOf({ ...draft, status: "present" })).toEqual({
      status: "present",
      checkIn: "07:00",
      checkOut: "16:00",
      overnight: true,
      breakMinutes: 30,
      notes: null,
    });
    expect(entryOf({ ...draft, status: "" })).toBeNull();
    const stored = draftOf({
      status: "present",
      checkIn: "07:00",
      checkOut: "16:00",
      overnight: false,
      breakMinutes: null,
      notes: null,
    });
    expect(sameEntry(stored, { ...stored, notes: " " })).toBe(true);
    expect(sameEntry(stored, { ...stored, checkOut: "17:00" })).toBe(false);
  });
});
