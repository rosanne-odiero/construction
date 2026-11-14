import type { Request } from "express";
import type { Messages } from "@pm-buddy/i18n";
import type { Locale, ReportDefinition, ReportId } from "@pm-buddy/types";
import type { ReportCell, ReportColumn } from "@pm-buddy/validation";
import type { ReportPeriod } from "@pm-buddy/domain";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import type { SpendingReportService } from "../finance/spending-report.service.js";
import {
  reportProblem,
  type ReportCaller,
  type ReportProject,
  type ReportRule,
} from "./reports-access.js";

export type Tx = Prisma.TransactionClient;

/** The parameters after validation: IDs checked against the caller's company, period resolved. */
export type ResolvedParams = {
  projectId?: string;
  siteId?: string;
  storeId?: string;
  batchId?: string;
  actorId?: string;
  action?: string;
  period?: ReportPeriod;
  asAt?: string;
};

/** Everything a builder may use. Builders read in the caller's tenant transaction only. */
export type BuildContext = {
  id: ReportId;
  scope: Scope;
  caller: ReportCaller;
  definition: ReportDefinition;
  rule: ReportRule;
  params: ResolvedParams;
  /** The projects in scope: the one chosen, or every project the caller may run the report for. */
  projects: ReportProject[];
  locale: Locale;
  m: Messages;
  t: Messages["reportExport"];
  today: string;
  maxRows: number;
  principal: Principal;
  req: Request;
  spending: SpendingReportService;
};

export type SectionDraft = {
  key: string;
  title: string;
  columns: ReportColumn[];
  rows: ReportCell[][];
  totals: ReportCell[] | null;
  notes: string[];
};
export type BuildResult = { sections: SectionDraft[]; notes: string[] };
export type ReportBuilder = (ctx: BuildContext) => Promise<BuildResult>;

export const column = (key: string, label: string, type: ReportColumn["type"]): ReportColumn => ({
  key,
  label,
  type,
});

/** `{name}` placeholders (export strings never use ICU plurals). */
export const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

export const dayOf = (value: Date) => value.toISOString().slice(0, 10);
export const dayOrNull = (value: Date | null) => (value ? dayOf(value) : null);
export const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);
export const money = (value: bigint | number | null) => (value === null ? null : Number(value));
/** A Prisma Decimal or integer as an exact decimal string without trailing zeros. */
export const quantity = (value: { toFixed(): string } | number | null): string | null => {
  if (value === null) return null;
  const text = typeof value === "number" ? String(value) : value.toFixed();
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
};
export const fromDay = (value: string) => new Date(`${value}T00:00:00.000Z`);

/** 422 report-too-large: a builder found more rows than any report may hold. */
export const tooLarge = (maxRows: number) =>
  reportProblem(
    422,
    "report-too-large",
    `This report has more than ${maxRows.toLocaleString("en")} rows; narrow the project, store or period`,
  );

/** Refuses more than `maxRows` rows (builders fetch `maxRows + 1`). */
export function bounded<T>(rows: T[], maxRows: number): T[] {
  if (rows.length > maxRows) throw tooLarge(maxRows);
  return rows;
}

export const projectIds = (ctx: BuildContext) => ctx.projects.map((project) => project.id);
export const projectCode = (ctx: BuildContext, projectId: string) =>
  ctx.projects.find((project) => project.id === projectId)?.code ?? "";

/** The sum of a money column (null cells skipped). */
export const sum = (rows: ReportCell[][], index: number): number =>
  rows.reduce(
    (total, row) => total + (typeof row[index] === "number" ? (row[index] as number) : 0),
    0,
  );

/** Names of company members, for "who" columns. */
export async function displayNames(tx: Tx, ids: Iterable<string>): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const users = await tx.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, displayName: true },
  });
  return new Map(users.map((user) => [user.id, user.displayName]));
}

export const supplierName = (row: { legalName: string; tradingName: string | null }) =>
  row.tradingName ?? row.legalName;
