import { calendarInput, parseCalendarInput } from "./project-input";

/**
 * Helpers for the shared date picker (components/date-input.tsx). A business date is an ISO
 * `YYYY-MM-DD` calendar date in Africa/Nairobi, shown and typed as DD/MM/YYYY. The calendar works
 * on local `Date`s at midnight, so converting never shifts the day, whatever the browser's zone.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A typed date as ISO: DD/MM/YYYY (or D/M/YYYY), or an ISO date pasted in. Null when empty,
 * undefined when it is not a real date (31/02/2026).
 */
export function parseDateText(text: string): string | null | undefined {
  const iso = ISO_DATE.exec(text.trim());
  return parseCalendarInput(iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : text);
}

/** ISO → DD/MM/YYYY; "" when empty. */
export const displayDate = (iso: string | null | undefined): string => calendarInput(iso || null);

/** ISO → the calendar's local Date at midnight. */
export function isoToDate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

/** A calendar Date (local fields) → ISO. */
export function dateToIso(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Whether an ISO date falls before `min` or after `max` (ISO bounds, either optional). */
export function outOfRange(iso: string, min?: string, max?: string): "early" | "late" | null {
  if (min && iso < min) return "early";
  if (max && iso > max) return "late";
  return null;
}

/**
 * The months the calendar can show: from `min` (else 100 years back, for dates of birth) to `max`
 * (else 10 years ahead), always including the selected date.
 */
export function calendarSpan(
  today: string,
  selected: string | null,
  min?: string,
  max?: string,
): { start: string; end: string } {
  const year = Number(today.slice(0, 4));
  let start = min ?? `${year - 100}-01-01`;
  let end = max ?? `${year + 10}-12-31`;
  if (selected && selected < start) start = selected;
  if (selected && selected > end) end = selected;
  return { start, end };
}

/** The date the calendar opens on: the selected one, else today kept within min/max. */
export function openingDate(
  today: string,
  selected: string | null,
  min?: string,
  max?: string,
): string {
  if (selected) return selected;
  const range = outOfRange(today, min, max);
  return range === "early" ? min! : range === "late" ? max! : today;
}
