import {
  REPORT_DEFINITIONS,
  REPORT_LIMITS,
  type ReportColumnType,
  type ReportDefinition,
  type ReportId,
} from "@pm-buddy/types";
import { reportParamsSchema, type ReportCell, type ReportParams } from "@pm-buddy/validation";
import { formatCalendarDate, formatDateTime, formatDecimalString, formatKES } from "./format";

/**
 * Reports centre helpers (D8.1). Relative imports only: web vitest does not resolve `@/`.
 */

/** The parameters a report takes, in form order. */
export const PARAM_KEYS = [
  "projectId",
  "siteId",
  "storeId",
  "batchId",
  "actorId",
  "action",
  "from",
  "to",
  "asAt",
] as const satisfies readonly (keyof ReportParams)[];

/** The parameters in a URL that this report takes and that are well formed; others are dropped. */
export function parseReportParams(
  id: ReportId,
  search: Record<string, string | string[] | undefined>,
): ReportParams {
  const definition = REPORT_DEFINITIONS[id];
  const allowed = allowedParams(definition);
  const picked: Record<string, string> = {};
  for (const key of allowed) {
    const value = search[key];
    if (typeof value === "string" && value.trim()) picked[key] = value.trim();
  }
  const parsed = reportParamsSchema.safeParse(picked);
  if (parsed.success) return parsed.data;
  // Keep the well-formed ones.
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(picked))
    if (reportParamsSchema.safeParse({ [key]: value }).success) kept[key] = value;
  return reportParamsSchema.parse(kept);
}

export function allowedParams(definition: ReportDefinition): (keyof ReportParams)[] {
  return [
    ...(definition.project === "none" ? [] : (["projectId"] as const)),
    ...(definition.site ? (["siteId"] as const) : []),
    ...(definition.store ? (["storeId"] as const) : []),
    ...(definition.batch ? (["batchId"] as const) : []),
    ...(definition.actor ? (["actorId", "action"] as const) : []),
    ...(definition.period === "range" ? (["from", "to"] as const) : []),
    ...(definition.period === "as-at" ? (["asAt"] as const) : []),
  ];
}

/** Whether the URL asked for the report to be shown (a parameter, or `run`). */
export const wantsReport = (search: Record<string, string | string[] | undefined>) =>
  search["run"] === "1" || PARAM_KEYS.some((key) => typeof search[key] === "string");

/** A stable query string (parameter order) with an optional locale. */
export function reportQuery(params: ReportParams, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams();
  for (const key of PARAM_KEYS) {
    const value = params[key];
    if (value) query.set(key, value);
  }
  for (const [key, value] of Object.entries(extra)) query.set(key, value);
  return query.toString();
}

export const exportHref = (
  id: ReportId,
  params: ReportParams,
  format: "pdf" | "xlsx",
  locale: string,
) => `/api/v1/reports/${id}/export/${format}?${reportQuery(params, { locale })}`;

/** The PDF is offered up to REPORT_LIMITS.pdfMaxRows rows (the API answers use-excel above). */
export const pdfFits = (rows: number) => rows <= REPORT_LIMITS.pdfMaxRows;

export const isNumeric = (type: ReportColumnType) =>
  type === "money" || type === "quantity" || type === "percent";

/** One cell as on-screen text: KES, DD/MM/YYYY, Nairobi time, grouped decimals; null is "—". */
export function cellText(type: ReportColumnType, cell: ReportCell): string {
  if (cell === null) return "—";
  if (type === "money") return formatKES(cell as number);
  const text = String(cell);
  if (type === "date") return formatCalendarDate(text);
  if (type === "datetime") return formatDateTime(text);
  if (type === "quantity") return formatDecimalString(text);
  if (type === "percent") return `${text} %`;
  return text;
}

/** Default form dates: the report's default period ending today, or today for as-at reports. */
export function defaultDates(
  definition: ReportDefinition,
  today: string,
): { from?: string; to?: string; asAt?: string } {
  if (definition.period === "as-at") return { asAt: today };
  if (definition.period !== "range") return {};
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const start = new Date(Date.UTC(y, m - 1, d - (definition.defaultPeriodDays - 1)));
  return { from: start.toISOString().slice(0, 10), to: today };
}
