import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { STATEMENT_LINE_CLASSES } from "@pm-buddy/types";
import * as wire from "@pm-buddy/validation";
import { PaymentsFrame } from "@/components/payments/payments-frame";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { selectClass } from "@/components/labour/action-dialog";
import { formatCalendarDate, formatDateTime, formatKES } from "@/lib/format";
import { paymentsAllowed } from "@/lib/payments";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("reconciliation");
  return { title: t("statementTitle") };
}

const PAGE = 50;

/** One uploaded statement: what was read, the rows that could not be, and its lines. */
export default async function StatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ statementId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { statementId } = await params;
  if (!z.uuid().safeParse(statementId).success) notFound();
  const raw = await searchParams;
  const lineClass = wire.statementLineClassSchema.safeParse(raw.lineClass);
  const offset = Math.min(100_000, Math.max(0, Math.trunc(Number(raw.offset) || 0)));
  const base = `/payments/statements/${statementId}`;
  const query = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (lineClass.success) query.set("lineClass", lineClass.data);
  const href = `${base}${lineClass.success ? `?lineClass=${lineClass.data}` : ""}`;
  const session = await requireSession(href);
  if (!session) return <LiveUnavailable retryHref={href} />;
  if (!paymentsAllowed(session.company, ["payments.view", "payments.review"]))
    return <LiveForbidden />;
  const result = await loadLive(`${base}?${query}`, wire.statementDetailResponseSchema, href);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={href} />;
  const t = await getTranslations("reconciliation");
  const tPayments = await getTranslations("payments");
  const tIssues = await getTranslations("reconciliation.issues");
  const { statement, lines, total, issues } = result.data;
  const pageHref = (next: number) => {
    const params = new URLSearchParams();
    if (lineClass.success) params.set("lineClass", lineClass.data);
    if (next > 0) params.set("offset", String(next));
    return `${base}${params.size ? `?${params}` : ""}`;
  };
  return (
    <PaymentsFrame
      current="statements"
      title={t("statementTitle")}
      description={t("layoutNote")}
      canTest={session.company.permissions.includes("payments.initiate_test")}
    >
      <section aria-labelledby="statement-heading" className="min-w-0 space-y-2 rounded-xl border p-4">
        <h2 id="statement-heading" className="break-all text-lg font-semibold">
          {statement.fileName}
        </h2>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted-foreground">{t("statementColumns.period")}</dt>
          <dd>
            {statement.periodFrom && statement.periodTo
              ? `${formatCalendarDate(statement.periodFrom)} – ${formatCalendarDate(statement.periodTo)}`
              : "—"}
          </dd>
          <dt className="text-muted-foreground">{t("statementColumns.lines")}</dt>
          <dd>
            {statement.lines} ·{" "}
            {t("byClass", {
              payout: statement.byClass.payout,
              charge: statement.byClass.charge,
              deposit: statement.byClass.deposit,
              other: statement.byClass.other,
            })}
          </dd>
          <dt className="text-muted-foreground">{t("statementColumns.uploaded")}</dt>
          <dd>
            {statement.uploadedBy.displayName} · {formatDateTime(statement.uploadedAt)}
          </dd>
          <dt className="text-muted-foreground">SHA-256</dt>
          <dd className="break-all font-mono text-xs">{statement.sha256}</dd>
          {statement.note ? (
            <>
              <dt className="text-muted-foreground">{t("statementNote")}</dt>
              <dd className="break-words">{statement.note}</dd>
            </>
          ) : null}
        </dl>
      </section>
      <section aria-labelledby="issues-heading" className="space-y-2">
        <h2 id="issues-heading" className="text-lg font-semibold">
          {t("issuesTitle", { count: issues.length })}
        </h2>
        {issues.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {issues.map((issue) => (
              <li key={`${issue.row}-${issue.issue}-${issue.column ?? ""}`}>
                {t("issueRow", { row: issue.row })}: {tIssues(issue.issue)}
                {issue.column ? ` (${t(`columns.${issue.column}`)})` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">{t("noIssues")}</p>
        )}
      </section>
      <section aria-labelledby="lines-heading" className="space-y-2">
        <h2 id="lines-heading" className="text-lg font-semibold">
          {t("linesTitle")}
        </h2>
        <form action={base} className="flex flex-wrap items-end gap-2">
          <label className="space-y-1 text-sm">
            <span className="block">{t("lineClass")}</span>
            <select
              name="lineClass"
              defaultValue={lineClass.success ? lineClass.data : ""}
              className={`${selectClass} w-auto`}
            >
              <option value="">{tPayments("all")}</option>
              {STATEMENT_LINE_CLASSES.map((value) => (
                <option key={value} value={value}>
                  {t(`lineClasses.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline">
            {tPayments("filter")}
          </Button>
        </form>
        <Table aria-label={t("linesTitle")}>
          <TableHeader>
            <TableRow>
              {(["row", "receipt", "completed", "class", "amount", "party", "details"] as const).map(
                (key) => (
                  <TableHead key={key}>{t(`lineColumns.${key}`)}</TableHead>
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((line) => (
              <TableRow key={line.id}>
                <TableCell>{line.row}</TableCell>
                <TableCell className="font-mono text-xs">
                  {line.receipt}
                  {line.chargeFor ? (
                    <span className="block">{t("chargeFor", { receipt: line.chargeFor })}</span>
                  ) : null}
                </TableCell>
                <TableCell>{formatDateTime(line.completedAt)}</TableCell>
                <TableCell>{t(`lineClasses.${line.lineClass}`)}</TableCell>
                <TableCell>
                  {line.withdrawnMinor
                    ? t("withdrawn", { amount: formatKES(line.withdrawnMinor) })
                    : t("paidIn", { amount: formatKES(line.paidInMinor) })}
                </TableCell>
                <TableCell className="text-xs">{line.otherPartyMasked ?? "—"}</TableCell>
                <TableCell className="min-w-48 text-xs">{line.details ?? "—"}</TableCell>
              </TableRow>
            ))}
            {!lines.length ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  {tPayments("empty")}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
        <nav aria-label={t("pages")} className="flex gap-4 text-sm">
          {offset > 0 ? (
            <Link className="underline" href={pageHref(Math.max(0, offset - PAGE))}>
              {tPayments("previous")}
            </Link>
          ) : null}
          {offset + PAGE < total ? (
            <Link className="underline" href={pageHref(offset + PAGE)}>
              {tPayments("next")}
            </Link>
          ) : null}
        </nav>
      </section>
      <Link className="text-sm underline" href="/payments/statements">
        {t("allStatements")}
      </Link>
    </PaymentsFrame>
  );
}
