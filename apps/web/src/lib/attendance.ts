import type { z } from "zod";
import { formatClock, formatDuration } from "@pm-buddy/domain";
import type { AttendanceEntryValues, TimesheetRule } from "@pm-buddy/validation";
import { liveRequest } from "./live-api";
import { parseCalendarInput } from "./project-input";

/**
 * Attendance and timesheet helpers for the live pages (D3.3 web slice). Durations are integer
 * minutes shown as h:mm; day counts are decimal strings from the API ("4.5"), never floats.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A state-changing attendance command: every call carries a fresh Idempotency-Key, so the one
 * automatic retry after a session refresh (or a double click that reaches the API twice) is
 * answered with the stored response instead of being applied twice.
 */
export function attendanceCommand<T>(
  path: string,
  schema: z.ZodType<T>,
  body: Record<string, unknown>,
  method: "POST" | "PUT" | "DELETE" = "POST",
): Promise<T> {
  return liveRequest(path, schema, {
    method,
    body,
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
}

/** Minutes as h:mm (485 → "8:05"); zero shows as "0:00". */
export const hours = (minutes: number) => formatDuration(minutes);

/** A UUID search parameter, or undefined. */
export function uuidParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value : undefined;
}

/** A date search parameter as YYYY-MM-DD: ISO or DD/MM/YYYY (typed into the filter form). */
export function dateParam(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (ISO_DATE.test(trimmed)) return parseCalendarInput(isoToInput(trimmed)) ?? undefined;
  return parseCalendarInput(trimmed) ?? undefined;
}

const isoToInput = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export function musterHref(params: {
  project: string;
  site?: string | null;
  date?: string | null;
  gang?: string | null;
}): string {
  const query = new URLSearchParams({ project: params.project });
  if (params.site) query.set("site", params.site);
  if (params.date) query.set("date", params.date);
  if (params.gang) query.set("gang", params.gang);
  return `/attendance/muster?${query.toString()}`;
}

/**
 * The default shift of a rule for "mark all present": the expected start, then the normal hours
 * plus the default break when the shift is long enough to carry one (07:00 → 16:00 for the demo).
 */
export function defaultShift(
  rule: Pick<
    TimesheetRule,
    "dayStartMinutes" | "normalMinutes" | "defaultBreakMinutes" | "breakAfterMinutes"
  > | null,
): { checkIn: string; checkOut: string } {
  if (!rule) return { checkIn: "07:00", checkOut: "16:00" };
  const span =
    rule.normalMinutes +
    (rule.normalMinutes + rule.defaultBreakMinutes > rule.breakAfterMinutes
      ? rule.defaultBreakMinutes
      : 0);
  const end = Math.min(rule.dayStartMinutes + span, 23 * 60 + 59);
  return { checkIn: formatClock(rule.dayStartMinutes), checkOut: formatClock(end) };
}

export type EntryDraft = {
  status: AttendanceEntryValues["status"] | "";
  checkIn: string;
  checkOut: string;
  overnight: boolean;
  breakMinutes: string;
  notes: string;
};

export const WORKED = new Set(["present", "half_day"]);

/** The editable form of stored values ("" for empty fields). */
export function draftOf(values: AttendanceEntryValues | null): EntryDraft {
  if (!values)
    return { status: "", checkIn: "", checkOut: "", overnight: false, breakMinutes: "", notes: "" };
  return {
    status: values.status,
    checkIn: values.checkIn ?? "",
    checkOut: values.checkOut ?? "",
    overnight: values.overnight,
    breakMinutes: values.breakMinutes === null ? "" : String(values.breakMinutes),
    notes: values.notes ?? "",
  };
}

/**
 * The request values of a draft: times only for worked statuses; an empty break applies the rule
 * default. Returns null when the status is not chosen yet.
 */
export function entryOf(draft: EntryDraft):
  | (Omit<AttendanceEntryValues, "status"> & {
      status: AttendanceEntryValues["status"];
    })
  | null {
  if (!draft.status) return null;
  const worked = WORKED.has(draft.status);
  const breakText = draft.breakMinutes.trim();
  return {
    status: draft.status,
    checkIn: worked && draft.checkIn ? draft.checkIn : null,
    checkOut: worked && draft.checkOut ? draft.checkOut : null,
    overnight: worked ? draft.overnight : false,
    breakMinutes: worked && breakText !== "" && /^\d+$/.test(breakText) ? Number(breakText) : null,
    notes: draft.notes.trim() || null,
  };
}

/** Whether two drafts would save the same values. */
export function sameEntry(a: EntryDraft, b: EntryDraft): boolean {
  return JSON.stringify(entryOf(a)) === JSON.stringify(entryOf(b));
}
