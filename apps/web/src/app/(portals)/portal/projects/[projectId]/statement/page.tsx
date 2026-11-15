import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Download, FileText } from "lucide-react";
import { clientStatementResponseSchema } from "@pm-buddy/validation";
import {
  ClientProjectHeader,
  ConversionNote,
  Money,
} from "@/components/client-portal/client-shell";
import { LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { certificateTone, currencySearch, parseCurrency } from "@/lib/client-portal";
import { loadClientPage } from "@/lib/client-portal-server";
import { formatCalendarDate, formatKES } from "@/lib/format";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("clientPortal.statement");
  return { title: t("title") };
}

/**
 * Certificates and the client statement: certified certificates (never drafts) with amount due,
 * VAT, total and due date, what the contractor recorded as received, outstanding and overdue, the
 * running statement, and downloads (certificate PDF; statement PDF and Excel in KES).
 */
export default async function ClientStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();
  const currency = parseCurrency((await searchParams)["currency"]);
  const path = `/portal/projects/${projectId}/statement`;
  const page = await loadClientPage(
    path,
    `/portal/client/projects/${projectId}/statement${currencySearch(currency)}`,
    clientStatementResponseSchema,
  );
  if (page.kind !== "ok") return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("clientPortal.statement");
  const tMethods = await getTranslations("clientPortal.methods");
  const locale = await getLocale();
  const statement = page.data;
  const { project, display, today } = statement;
  const base = `/api/v1/portal/client/projects/${project.id}`;
  const stateLabel = (row: (typeof statement.certificates)[number]) =>
    row.overdue ? t("overdueDays", { days: row.overdueDays }) : t(`states.${row.state}`);
  return (
    <div className="space-y-6">
      <ClientProjectHeader
        project={project}
        current="statement"
        title={t("title")}
        description={t("description")}
      />
      <ConversionNote display={display} />
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(
          [
            ["certified", statement.totals.certifiedMinor],
            ["received", statement.totals.receivedMinor],
            ["outstanding", statement.totals.outstandingMinor],
            ["overdue", statement.totals.overdueMinor],
          ] as const
        ).map(([key, minor]) => (
          <div key={key} className="rounded-xl border bg-card p-4">
            <dt className="text-sm text-muted-foreground">{t(`totals.${key}`)}</dt>
            <dd className="text-lg font-semibold">
              <Money minor={minor} display={display} today={today} />
            </dd>
          </div>
        ))}
      </dl>
      {statement.totals.outstandingMinor < 0 ? (
        <p role="status" className="rounded-md border bg-background p-3 text-sm">
          {t("inCredit")}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("paidNote")}</p>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={`${base}/statement/export/pdf?locale=${locale}`} download>
            <Download aria-hidden /> {t("exportPdf")}
          </a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={`${base}/statement/export/xlsx?locale=${locale}`} download>
            <Download aria-hidden /> {t("exportExcel")}
          </a>
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("certificatesTitle")}</h2>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t("termsNote", { days: statement.paymentTermsDays })}
          </p>
        </CardHeader>
        <CardContent>
          {statement.certificates.length ? (
            <ul className="space-y-3">
              {statement.certificates.map((row) => (
                <li key={row.id} className="space-y-2 rounded-md border bg-background p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-semibold">
                      {row.number}
                      <span className="ml-2 font-normal text-muted-foreground">
                        {row.kind === "interim"
                          ? t("interim")
                          : t(`release.${row.releaseStage ?? "practical"}`)}
                      </span>
                    </h3>
                    <StatusBadge tone={certificateTone(row.state, row.overdue)}>
                      {stateLabel(row)}
                    </StatusBadge>
                  </div>
                  <dl className="grid gap-2 sm:grid-cols-3">
                    <div>
                      <dt className="text-muted-foreground">{t("amountDue")}</dt>
                      <dd className="tabular-nums">{formatKES(row.amountDueMinor)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">
                        {t("vat", { percent: row.vatPercent })}
                      </dt>
                      <dd className="tabular-nums">{formatKES(row.vatMinor)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t("total")}</dt>
                      <dd className="font-medium">
                        <Money minor={row.totalMinor} display={display} today={today} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t("certifiedOn")}</dt>
                      <dd>{formatCalendarDate(row.certifiedOn)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t("dueDate")}</dt>
                      <dd>{formatCalendarDate(row.dueDate)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t("outstanding")}</dt>
                      <dd className="font-semibold">
                        <Money minor={row.outstandingMinor} display={display} today={today} />
                      </dd>
                    </div>
                  </dl>
                  {row.receivedMinor || row.creditedMinor ? (
                    <p className="text-xs text-muted-foreground">
                      {t("receivedLine", { amount: formatKES(row.receivedMinor) })}
                      {row.creditedMinor
                        ? ` ${t("creditedLine", { amount: formatKES(row.creditedMinor) })}`
                        : ""}
                    </p>
                  ) : null}
                  <Button asChild variant="link" size="sm" className="h-auto px-0">
                    <a href={`${base}/certificates/${row.id}/pdf?locale=${locale}`} download>
                      <FileText aria-hidden /> {t("certificatePdf", { number: row.number })}
                    </a>
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noCertificates")}</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("receiptsTitle")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {statement.receipts.length ? (
            <ul className="space-y-2 text-sm">
              {statement.receipts.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-start justify-between gap-2 border-b pb-2 last:border-0"
                >
                  <span>
                    <span className="block font-medium">
                      {row.kind === "receipt"
                        ? t("receipt", {
                            number: row.certificateNumber,
                            method: row.method ? tMethods(row.method) : "",
                          })
                        : t("reversal", { number: row.certificateNumber })}
                    </span>
                    <span className="text-muted-foreground">
                      {formatCalendarDate(row.receivedOn)}
                      {row.reference ? ` · ${t("reference", { reference: row.reference })}` : ""}
                    </span>
                    {row.reason ? (
                      <span className="block text-xs text-muted-foreground">
                        {t("reason", { reason: row.reason })}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-right">
                    <span className={row.reversed ? "tabular-nums line-through" : "tabular-nums"}>
                      {formatKES(row.kind === "reversal" ? -row.amountMinor : row.amountMinor)}
                    </span>
                    {row.reversed ? (
                      <StatusBadge tone="neutral" className="ml-2">
                        {t("reversed")}
                      </StatusBadge>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noReceipts")}</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("entriesTitle")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent
          role="region"
          aria-label={t("entriesTitle")}
          tabIndex={0}
          className="overflow-x-auto"
        >
          <table className="w-full min-w-[22rem] text-sm">
            <caption className="sr-only">{t("entriesTitle")}</caption>
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t("date")}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t("details")}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t("balance")}
                </th>
              </tr>
            </thead>
            <tbody>
              {statement.entries.map((entry) => (
                <tr key={`${entry.kind}-${entry.id}`} className="border-b last:border-0">
                  <td className="py-2 pr-3 align-top whitespace-nowrap">
                    {formatCalendarDate(entry.date)}
                  </td>
                  <td className="py-2 pr-3 align-top">
                    {t(`entry.${entry.kind}`, { number: entry.certificateNumber })}
                    <span className="block text-xs text-muted-foreground tabular-nums">
                      {entry.debitMinor
                        ? `+${formatKES(entry.debitMinor)}`
                        : `−${formatKES(entry.creditMinor)}`}
                    </span>
                  </td>
                  <td className="py-2 text-right align-top tabular-nums">
                    {formatKES(entry.balanceMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
