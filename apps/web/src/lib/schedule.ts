import { addCalendarDays, calendarDaysBetween, isoWeekday } from "@pm-buddy/domain";
import type { DependencyType } from "@pm-buddy/types";
import type { ScheduleItem, ScheduleResponse } from "@pm-buddy/validation";

/**
 * Gantt geometry and display helpers for the schedule screens (D6.2). Pure functions on business
 * dates (YYYY-MM-DD, Africa/Nairobi) so the chart is identical on the server and in the browser.
 */

export const ZOOMS = { week: 22, month: 5 } as const;
export type Zoom = keyof typeof ZOOMS;

export const ROW_HEIGHT = 36;
export const HEADER_HEIGHT = 44;

export type GanttRange = { start: string; end: string; days: number };

/** Every date the chart must show (plan, baseline, actuals, today), padded by a few days. */
export function ganttRange(
  schedule: Pick<ScheduleResponse, "items" | "dataDate" | "start">,
): GanttRange {
  const dates = [schedule.dataDate, schedule.start.date];
  for (const item of schedule.items) {
    dates.push(item.planned.start, item.planned.finish);
    if (item.baseline) dates.push(item.baseline.start, item.baseline.finish);
    if (item.actualStart) dates.push(item.actualStart);
    if (item.actualFinish) dates.push(item.actualFinish);
  }
  const sorted = dates.sort();
  const start = addCalendarDays(sorted[0]!, -3);
  const end = addCalendarDays(sorted.at(-1)!, 7);
  return { start, end, days: calendarDaysBetween(start, end) + 1 };
}

/** X position of the start of a date's day column. */
export const dayX = (range: GanttRange, date: string, zoom: Zoom): number =>
  calendarDaysBetween(range.start, date) * ZOOMS[zoom];

/** A bar covering whole days from `start` to `finish` inclusive. */
export function barGeometry(range: GanttRange, start: string, finish: string, zoom: Zoom) {
  const x = dayX(range, start, zoom);
  const width = Math.max(dayX(range, finish, zoom) + ZOOMS[zoom] - x, 2);
  return { x, width };
}

/** First days of months inside the range (month labels and grid lines). */
export function monthStarts(range: GanttRange): string[] {
  const result: string[] = [];
  let [year, month] = range.start.split("-").map(Number) as [number, number];
  for (;;) {
    const date = `${year}-${String(month).padStart(2, "0")}-01`;
    if (date > range.end) return result;
    if (date >= range.start) result.push(date);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

/** Mondays inside the range (week grid lines). */
export function weekStarts(range: GanttRange): string[] {
  const result: string[] = [];
  let date = range.start;
  while (isoWeekday(date) !== 1) date = addCalendarDays(date, 1);
  for (; date <= range.end; date = addCalendarDays(date, 7)) result.push(date);
  return result;
}

/** Dates in the range that are not working weekdays (shaded in the week zoom). */
export function restDays(range: GanttRange, workingWeekdays: readonly number[]): string[] {
  const working = new Set(workingWeekdays);
  const result: string[] = [];
  for (let offset = 0; offset < range.days; offset += 1) {
    const date = addCalendarDays(range.start, offset);
    if (!working.has(isoWeekday(date))) result.push(date);
  }
  return result;
}

/** Where a dependency leaves its predecessor and reaches its successor. */
export function dependencyPath(
  type: DependencyType,
  from: { x: number; width: number; y: number },
  to: { x: number; width: number; y: number },
): string {
  const startX = type === "FS" || type === "FF" ? from.x + from.width : from.x;
  const endX = type === "FS" || type === "SS" ? to.x : to.x + to.width;
  const outward = type === "FS" || type === "FF" ? 6 : -6;
  const inward = type === "FS" || type === "SS" ? -6 : 6;
  const midY = from.y + (to.y > from.y ? ROW_HEIGHT / 2 : -ROW_HEIGHT / 2);
  return [
    `M ${startX} ${from.y}`,
    `H ${startX + outward}`,
    `V ${midY}`,
    `H ${endX + inward}`,
    `V ${to.y}`,
    `H ${endX}`,
  ].join(" ");
}

export type VarianceView =
  { kind: "unavailable" } | { kind: "on"; days: 0 } | { kind: "late" | "early"; days: number };

/** How a variance in working days reads: unavailable, on baseline, late (+) or early (−). */
export function varianceView(days: number | null): VarianceView {
  if (days === null) return { kind: "unavailable" };
  if (days === 0) return { kind: "on", days: 0 };
  return days > 0 ? { kind: "late", days } : { kind: "early", days: -days };
}

/** "2.5" → 2.5 (whole or half working days); undefined when it is not one. */
export function parseDaysLost(text: string): number | undefined {
  const trimmed = text.trim().replace(",", ".");
  if (!/^\d{1,4}(\.\d)?$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isInteger(value * 2) ? value : undefined;
}

/** A label for an item: its code and name, or the milestone's name. */
export const itemLabel = (item: Pick<ScheduleItem, "code" | "name">): string =>
  item.code ? `${item.code} ${item.name}` : item.name;
