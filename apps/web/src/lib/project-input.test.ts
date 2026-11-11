import { expect, it } from "vitest";
import {
  calendarInput,
  parseCalendarInput,
  parseCoordinate,
  parseShillings,
  shillingsInput,
} from "./project-input";

it("parses shilling amounts into integer minor units, never floats", () => {
  expect(parseShillings("86,400,000")).toBe(8_640_000_000);
  expect(parseShillings("KES 1 250 000.50")).toBe(125_000_050);
  expect(parseShillings("")).toBeNull();
  expect(parseShillings("12.345")).toBeUndefined();
  expect(parseShillings("-5")).toBeUndefined();
  expect(parseShillings("lots")).toBeUndefined();
  expect(shillingsInput(125_000_050)).toBe("1250000.50");
  expect(shillingsInput(8_640_000_000)).toBe("86400000");
  expect(shillingsInput(null)).toBe("");
});

it("parses DD/MM/YYYY dates and rejects impossible ones", () => {
  expect(parseCalendarInput("02/03/2026")).toBe("2026-03-02");
  expect(parseCalendarInput("2/3/2026")).toBe("2026-03-02");
  expect(parseCalendarInput("31/02/2026")).toBeUndefined();
  expect(parseCalendarInput("2026-03-02")).toBeUndefined();
  expect(parseCalendarInput(" ")).toBeNull();
  expect(calendarInput("2026-03-02")).toBe("02/03/2026");
  expect(calendarInput(null)).toBe("");
});

it("parses decimal coordinates", () => {
  expect(parseCoordinate("-1.1489")).toBe(-1.1489);
  expect(parseCoordinate("\u22121.1489")).toBe(-1.1489);
  expect(parseCoordinate("36.9612")).toBe(36.9612);
  expect(parseCoordinate("")).toBeNull();
  expect(parseCoordinate("1,5")).toBeUndefined();
});

it("parses WBS weights in percent into basis points", async () => {
  const { basisPointsInput, parsePercentToBasisPoints } = await import("./project-input");
  expect(parsePercentToBasisPoints("25.5")).toBe(2_550);
  expect(parsePercentToBasisPoints("100 %")).toBe(10_000);
  expect(parsePercentToBasisPoints("0")).toBe(0);
  expect(parsePercentToBasisPoints("100.01")).toBeUndefined();
  expect(parsePercentToBasisPoints("12.345")).toBeUndefined();
  expect(parsePercentToBasisPoints("-1")).toBeUndefined();
  expect(basisPointsInput(2_550)).toBe("25.5");
});
