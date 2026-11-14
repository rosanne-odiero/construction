import type { AttendanceStatus } from "@pm-buddy/types";
import { MINUTES_PER_DAY } from "../attendance/time.js";

/**
 * One labourer-day of the muster roll report, from a record on a **confirmed** day (D-124): the
 * status, the half-days it counts as present (present 2, half day 1, otherwise 0) and the minutes
 * recorded between check-in and check-out less breaks (null without both times). Hours are as
 * recorded, before timesheet rules; payroll uses the approved timesheet.
 */
export type MusterRecord = {
  status: AttendanceStatus;
  checkInMinutes: number | null;
  checkOutMinutes: number | null;
  overnight: boolean;
  breakMinutes: number | null;
};
export type MusterCell = { status: AttendanceStatus; halfDays: number; minutes: number | null };

export function recordedMinutes(record: Omit<MusterRecord, "status">): number | null {
  if (record.checkInMinutes === null || record.checkOutMinutes === null) return null;
  const span =
    record.checkOutMinutes - record.checkInMinutes + (record.overnight ? MINUTES_PER_DAY : 0);
  if (span <= 0) return null;
  return Math.max(0, span - (record.breakMinutes ?? 0));
}

export function musterCell(record: MusterRecord): MusterCell {
  const halfDays = record.status === "present" ? 2 : record.status === "half_day" ? 1 : 0;
  const minutes = halfDays > 0 ? recordedMinutes(record) : null;
  return { status: record.status, halfDays, minutes };
}

export type MusterTotals = {
  /** Present days counted in halves (a half day is 1). */
  presentHalfDays: number;
  absent: number;
  leave: number;
  sick: number;
  /** Recorded minutes of worked days with both times. */
  minutes: number;
  /** Worked days without both times (their hours are unknown, not zero). */
  missingTimes: number;
};

export function musterTotals(cells: readonly (MusterCell | null)[]): MusterTotals {
  const totals: MusterTotals = {
    presentHalfDays: 0,
    absent: 0,
    leave: 0,
    sick: 0,
    minutes: 0,
    missingTimes: 0,
  };
  for (const cell of cells) {
    if (!cell) continue;
    totals.presentHalfDays += cell.halfDays;
    if (cell.status === "absent") totals.absent += 1;
    if (cell.status === "leave") totals.leave += 1;
    if (cell.status === "sick") totals.sick += 1;
    if (cell.halfDays > 0) {
      if (cell.minutes === null) totals.missingTimes += 1;
      else totals.minutes += cell.minutes;
    }
  }
  return totals;
}

/** Minutes as decimal hours with two places (485 → "8.08", 90 → "1.50"). */
export function minutesAsHours(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const hundredths = Math.round((Math.abs(minutes) * 100) / 60);
  return `${sign}${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}`;
}

/** Half-days as a day count with at most one decimal (9 → "4.5", 4 → "2"). */
export function halfDaysAsDays(halfDays: number): string {
  return `${Math.floor(halfDays / 2)}${halfDays % 2 ? ".5" : ""}`;
}
