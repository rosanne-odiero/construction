import { expect, it } from "vitest";
import {
  calendarSpan,
  dateToIso,
  isoToDate,
  openingDate,
  outOfRange,
  parseDateText,
} from "./date-input";

it("reads typed DD/MM/YYYY or pasted ISO dates and refuses impossible ones", () => {
  expect(parseDateText("16/11/2026")).toBe("2026-11-16");
  expect(parseDateText(" 2/3/2026 ")).toBe("2026-03-02");
  expect(parseDateText("2026-11-16")).toBe("2026-11-16");
  expect(parseDateText("2026-02-31")).toBeUndefined();
  expect(parseDateText("31/02/2026")).toBeUndefined();
  expect(parseDateText("16-11-2026")).toBeUndefined();
  expect(parseDateText("")).toBeNull();
});

it("keeps the calendar day when converting to and from the calendar's dates", () => {
  for (const iso of ["2026-01-01", "2026-03-29", "2026-10-25", "2028-02-29"])
    expect(dateToIso(isoToDate(iso))).toBe(iso);
});

it("checks min and max and opens on a date the user may pick", () => {
  expect(outOfRange("2026-11-15", "2026-11-16")).toBe("early");
  expect(outOfRange("2026-11-17", undefined, "2026-11-16")).toBe("late");
  expect(outOfRange("2026-11-16", "2026-11-16", "2026-11-16")).toBeNull();
  expect(openingDate("2026-11-16", null, "2026-12-01")).toBe("2026-12-01");
  expect(openingDate("2026-11-16", null, undefined, "2026-10-31")).toBe("2026-10-31");
  expect(openingDate("2026-11-16", "1990-05-04")).toBe("1990-05-04");
  expect(calendarSpan("2026-11-16", null)).toEqual({ start: "1926-01-01", end: "2036-12-31" });
  expect(calendarSpan("2026-11-16", "2040-01-01", "2026-11-16")).toEqual({
    start: "2026-11-16",
    end: "2040-01-01",
  });
});
