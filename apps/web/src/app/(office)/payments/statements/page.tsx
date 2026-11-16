import Link from "next/link";
import { getTranslations } from "next-intl/server";
import * as wire from "@pm-buddy/validation";
import { PaymentsFrame } from "@/components/payments/payments-frame";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { paymentsAllowed } from "@/lib/payments";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("reconciliation");
  return { title: t("statementsTitle") };
}

const PAGE = 25;

/** Uploaded M-Pesa organisation-portal statements (newest first). */
export default async function StatementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const offset = Math.min(100_000, Math.max(0, Math.trunc(Number(raw.offset) || 0)));
  const href = `/payments/statements${offset ? `?offset=${offset}` : ""}`;
  const session = await requireSession(href);
  if (!session) return <LiveUnavailable retryHref={href} />;
  if (!paymentsAllowed(session.company, ["payments.view", "payments.review"]))
    return <LiveForbidden />;
  const result = await loadLive(
    `/payments/statements?limit=${PAGE}&offset=${offset}`,
    wire.statementsResponseSchema,
    href,
  );
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={href} />;
  const t = await getTranslations("reconciliation");
  const tPayments = await getTranslations("payments");
  const { statements, total } = result.data;
  return (
    <PaymentsFrame
      current="statements"
      title={t("statementsTitle")}
      description={t("layoutNote")}
      canTest={session.company.permissions.includes("payments.initiate_test")}
    >
      <p className="text-sm">{tPayments("total", { count: total })}</p>
      <Table aria-label={t("statementsTitle")}>
        <TableHeader>
          <TableRow>
            {(["file", "period", "lines", "issues", "uploaded"] as const).map((key) => (
              <TableHead key={key}>{t(`statementColumns.${key}`)}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {statements.map((statement) => (
            <TableRow key={statement.id}>
              <TableCell className="break-all">
                <Link className="underline" href={`/payments/statements/${statement.id}`}>
                  {statement.fileName}
                </Link>
                <span className="block text-xs text-muted-foreground">
                  {statement.format.toUpperCase()}
                </span>
              </TableCell>
              <TableCell>
                {statement.periodFrom && statement.periodTo
                  ? `${formatCalendarDate(statement.periodFrom)} – ${formatCalendarDate(statement.periodTo)}`
                  : "—"}
              </TableCell>
              <TableCell>
                {statement.lines}
                <span className="block text-xs text-muted-foreground">
                  {t("byClass", {
                    payout: statement.byClass.payout,
                    charge: statement.byClass.charge,
                    deposit: statement.byClass.deposit,
                    other: statement.byClass.other,
                  })}
                </span>
              </TableCell>
              <TableCell>{statement.issues}</TableCell>
              <TableCell>
                {statement.uploadedBy.displayName}
                <span className="block text-xs">{formatDateTime(statement.uploadedAt)}</span>
              </TableCell>
            </TableRow>
          ))}
          {!statements.length ? (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                {t("noStatements")}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      <nav aria-label={t("pages")} className="flex gap-4 text-sm">
        {offset > 0 ? (
          <Link
            className="underline"
            href={`/payments/statements?offset=${Math.max(0, offset - PAGE)}`}
          >
            {tPayments("previous")}
          </Link>
        ) : null}
        {offset + PAGE < total ? (
          <Link className="underline" href={`/payments/statements?offset=${offset + PAGE}`}>
            {tPayments("next")}
          </Link>
        ) : null}
      </nav>
      <Link className="text-sm underline" href="/payments/reconciliation">
        {t("backToReconciliation")}
      </Link>
    </PaymentsFrame>
  );
}
