import { isoWeekday } from "../attendance/time.js";
import { addCalendarDays, calendarDaysBetween } from "../labour.js";

/**
 * Working calendars for the schedule (D6.2). Dates are business calendar dates (YYYY-MM-DD in
 * Africa/Nairobi, as `nairobiDate()`), never instants, so the arithmetic is time-zone free. A
 * project works on chosen ISO weekdays (Monday to Saturday by default on Kenyan sites) minus the
 * company's public holidays.
 */

export type WorkingCalendar = {
  /** ISO weekdays that are worked: 1 = Monday … 7 = Sunday. Never empty. */
  readonly workingWeekdays: ReadonlySet<number>;
  /** Non-working dates (public holidays). */
  readonly holidays: ReadonlySet<string>;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Longest run of non-working days the search tolerates before refusing (a broken calendar). */
const MAX_GAP_DAYS = 4_000;

/** Builds a calendar; throws RangeError for an empty or invalid working week. */
export function workingCalendar(
  workingWeekdays: Iterable<number>,
  holidays: Iterable<string> = [],
): WorkingCalendar {
  const weekdays = new Set(workingWeekdays);
  if (weekdays.size === 0) throw new RangeError("A working calendar needs at least one weekday");
  for (const day of weekdays)
    if (!Number.isInteger(day) || day < 1 || day > 7)
      throw new RangeError(`Invalid ISO weekday ${day}`);
  const dates = new Set<string>();
  for (const date of holidays) {
    if (!ISO_DATE.test(date)) throw new RangeError(`Invalid holiday date ${date}`);
    dates.add(date);
  }
  return { workingWeekdays: weekdays, holidays: dates };
}

export const isWorkingDay = (calendar: WorkingCalendar, date: string): boolean =>
  calendar.workingWeekdays.has(isoWeekday(date)) && !calendar.holidays.has(date);

function step(calendar: WorkingCalendar, date: string, direction: 1 | -1): string {
  let current = date;
  for (let guard = 0; guard < MAX_GAP_DAYS; guard += 1) {
    if (isWorkingDay(calendar, current)) return current;
    current = addCalendarDays(current, direction);
  }
  throw new RangeError("No working day within reach: check the working calendar");
}

/** The first working day on or after `date`. */
export const nextWorkingDay = (calendar: WorkingCalendar, date: string): string =>
  step(calendar, date, 1);

/** The last working day on or before `date`. */
export const previousWorkingDay = (calendar: WorkingCalendar, date: string): string =>
  step(calendar, date, -1);

/**
 * Moves `days` working days from `date` (negative moves back). Zero returns `date` itself when it
 * is a working day, otherwise the next working day; `addWorkingDays(cal, monday, 1)` is the next
 * working day after Monday.
 */
export function addWorkingDays(calendar: WorkingCalendar, date: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError("Working days must be a whole number");
  const direction = days >= 0 ? 1 : -1;
  let current = days >= 0 ? nextWorkingDay(calendar, date) : previousWorkingDay(calendar, date);
  for (let moved = 0; moved < Math.abs(days); moved += 1)
    current = step(calendar, addCalendarDays(current, direction), direction);
  return current;
}

/** Working days in the inclusive range `from`–`to` (0 when `to` is before `from`). */
export function countWorkingDays(calendar: WorkingCalendar, from: string, to: string): number {
  const span = calendarDaysBetween(from, to);
  let count = 0;
  for (let offset = 0; offset <= span; offset += 1)
    if (isWorkingDay(calendar, addCalendarDays(from, offset))) count += 1;
  return count;
}

/**
 * Signed working days from `from` to `to`: the working days after `from` up to and including
 * `to` (positive when `to` is later, negative when earlier, 0 on the same day). With a Monday to
 * Saturday week, Friday → Monday is +2 (Saturday and Monday).
 */
export function workingDaysBetween(calendar: WorkingCalendar, from: string, to: string): number {
  if (to === from) return 0;
  return to > from
    ? countWorkingDays(calendar, addCalendarDays(from, 1), to)
    : -countWorkingDays(calendar, addCalendarDays(to, 1), from);
}

/**
 * Numbers the working days of a calendar from an anchor: index 0 is the first working day on or
 * after the anchor, 1 the next one, −1 the last one before it. The CPM engine works on these
 * indices so lags, durations and holidays are plain integer arithmetic.
 */
export class WorkdayIndex {
  /** forward[i] is the date of index i; backward[k] the date of index −(k + 1). */
  private readonly forward: string[] = [];
  private readonly backward: string[] = [];

  constructor(
    readonly calendar: WorkingCalendar,
    anchor: string,
    /**
     * Refuses indices further than this from the anchor: enough for any two planning dates
     * (PLANNING_DATE_RANGE, 100 years) even with a seven-day working week.
     */
    private readonly limit = 40_000,
  ) {
    this.forward.push(nextWorkingDay(calendar, anchor));
  }

  /** The first working day on or after the anchor (index 0). */
  get origin(): string {
    return this.forward[0]!;
  }

  /** The working date with this index. */
  dateOf(index: number): string {
    if (!Number.isInteger(index) || Math.abs(index) > this.limit)
      throw new RangeError("The schedule reaches too far from the project start");
    if (index >= 0) {
      while (this.forward.length <= index)
        this.forward.push(nextWorkingDay(this.calendar, addCalendarDays(this.forward.at(-1)!, 1)));
      return this.forward[index]!;
    }
    const position = -index - 1;
    while (this.backward.length <= position)
      this.backward.push(
        previousWorkingDay(this.calendar, addCalendarDays(this.backward.at(-1) ?? this.origin, -1)),
      );
    return this.backward[position]!;
  }

  /** The index of the first working day on or after `date`. */
  onOrAfter(date: string): number {
    return this.find(nextWorkingDay(this.calendar, date));
  }

  /** The index of the last working day on or before `date`. */
  onOrBefore(date: string): number {
    return this.find(previousWorkingDay(this.calendar, date));
  }

  /** Binary search over the (lazily extended) list of working dates. */
  private find(workingDate: string): number {
    const ahead = workingDate >= this.origin;
    const toIndex = (position: number) => (ahead ? position : -position - 1);
    const before = (position: number) => {
      const date = this.dateOf(toIndex(position));
      return ahead ? date < workingDate : date > workingDate;
    };
    const maxPosition = ahead ? this.limit : this.limit - 1;
    let high = Math.max((ahead ? this.forward : this.backward).length - 1, 0);
    while (before(high)) {
      if (high >= maxPosition)
        throw new RangeError("The schedule reaches too far from the project start");
      high = Math.min(high * 2 + 1, maxPosition);
    }
    let low = 0;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (before(middle)) low = middle + 1;
      else high = middle;
    }
    return toIndex(low);
  }
}
