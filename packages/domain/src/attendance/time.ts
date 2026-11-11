import { BUSINESS_TIME_ZONE, type IsoWeekday } from "@pm-buddy/types";

/** Minutes in a calendar day; times of day are integer minutes after midnight (0–1439). */
export const MINUTES_PER_DAY = 1440;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function dateParts(isoDate: string): [number, number, number] {
  const match = ISO_DATE.exec(isoDate);
  if (!match) throw new TypeError(`Expected a YYYY-MM-DD date, got "${isoDate}"`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const pad = (value: number) => String(value).padStart(2, "0");

/** "07:30" → 450; null for anything that is not a 24-hour HH:MM time. */
export function parseClock(text: string): number | null {
  const match = CLOCK.exec(text.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** 450 → "07:30" (values past midnight wrap: 1500 → "01:00"). */
export function formatClock(minutes: number): string {
  const value = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): IsoWeekday {
  const [y, m, d] = dateParts(date);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (day === 0 ? 7 : day) as IsoWeekday;
}

function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return (
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) -
    instant
  );
}

/**
 * The instant at which the wall clock in `timeZone` (Africa/Nairobi by default) shows `minutes`
 * after midnight on `date`. The offset comes from the time-zone database, not a constant.
 */
export function zonedDateTime(
  date: string,
  minutes: number,
  timeZone: string = BUSINESS_TIME_ZONE,
): Date {
  const [y, m, d] = dateParts(date);
  const local = Date.UTC(y, m - 1, d, 0, minutes);
  const first = local - offsetMs(local, timeZone);
  return new Date(local - offsetMs(first, timeZone));
}

/** Minutes as hours and minutes for display and exports: 485 → "8:05". */
export function formatDuration(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const value = Math.abs(minutes);
  return `${sign}${Math.floor(value / 60)}:${pad(value % 60)}`;
}

/** Half-day units as a decimal day count without floating point: 9 → "4.5". */
export function formatHalfDays(halfDays: number): string {
  const sign = halfDays < 0 ? "-" : "";
  const value = Math.abs(halfDays);
  return `${sign}${Math.floor(value / 2)}${value % 2 ? ".5" : ""}`;
}
