import { dateParts } from "../attendance/time.js";

/**
 * Spreadsheet values for report exports (D-122). Excel stores dates as serial days since
 * 30 December 1899 (the 1900 date system); a date-time adds the fraction of the day. Date-times are
 * converted to Africa/Nairobi (UTC+3, no daylight saving) before they are written, so the cell shows
 * the same wall-clock time as the screen.
 */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;
const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000;

export function excelSerialDate(date: string): number {
  const [y, m, d] = dateParts(date);
  return (Date.UTC(y, m - 1, d) - EXCEL_EPOCH) / DAY_MS;
}

export function excelSerialNairobi(instant: Date): number {
  return (instant.getTime() + NAIROBI_OFFSET_MS - EXCEL_EPOCH) / DAY_MS;
}

/** Minor units as a number of shillings for a spreadsheet cell (always two decimals shown). */
export function minorToShillings(minor: number): number {
  return Math.round(minor) / 100;
}
