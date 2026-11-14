import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Download } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import {
  supplierPortalOverviewResponseSchema,
  supplierStatementResponseSchema,
} from "@pm-buddy/validation";
import { selectClass } from "@/components/procurement/material-form";
import { SupplierPageState } from "@/components/supplier-portal/portal-state";
import { PortalHeading, SupplierNav } from "@/components/supplier-portal/supplier-nav";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { isUuid, pickParam } from "@/lib/p2p";
import { statementPeriod, statementSearch, supplierInvoiceTone } from "@/lib/supplier-portal";
import { loadSupplierPage } from "@/lib/supplier-portal-server";
import { serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("supplierPortal.statement");
  return { title: t("title") };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The supplier statement (D7.2): opening balance, invoices the company approved, payments it
 * recorded and the closing balance for a period and one project or all, with PDF and Excel in
 * the page's language. Each line is a block on a phone; the balance stays readable at 360 px.
 */
export default async function SupplierStatementPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const today = nairobiDate();
  const from = pickParam(raw, "from");
  const to = pickParam(raw, "to");
  const projectId = pickParam(raw, "projectId");
  const filters = {
    from: from && DATE.test(from) ? from : undefined,
    to: to && DATE.test(to) ? to : undefined,
    projectId: projectId && isUuid(projectId) ? projectId : undefined,
  };
  const period = statementPeriod(filters, today);
  const t = await getTranslations("supplierPortal.statement");
  const path = `/supplier/statement${statementSearch(filters)}`;
  if (!period) {
    return (
      <div className="space-y-6">
        <PortalHeading title={t("title")} />
        <SupplierNav current="statement" />
        <p role="alert" className="text-sm text-destructive">
          {t("periodInvalid")}
        </p>
        <Link href="/supplier/statement" className="underline">
          {t("title")}
        </Link>
      </div>
    );
  }
  const page = await loadSupplierPage(
    path,
    `/portal/supplier/statement${statementSearch({ ...filters, ...period })}`,
    supplierStatementResponseSchema,
  );
  if (page.kind !== "ok") return <SupplierPageState kind={page.kind} retryHref={path} />;
  const overview = await serverApi("/portal/supplier", supplierPortalOverviewResponseSchema);
  const projects = overview.ok ? overview.data.projects : [];
  const locale = await getLocale();
  const tMethods = await getTranslations("supplierPortal.methods");
  const tInvoices = await getTranslations("supplierPortal.invoices");
  const tPortal = await getTranslations("supplierPortal");
  const statement = page.data;
  const exportQuery = statementSearch({
    from: statement.from,
    to: statement.to,
    projectId: statement.project?.id,
    locale,
  });
  return (
    <div className="space-y-6">
      <PortalHeading
        title={t("title")}
        description={t("description", { company: statement.company.name })}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <a href={`/api/v1/portal/supplier/statement/export/pdf${exportQuery}`} download>
                <Download aria-hidden /> {t("exportPdf")}
              </a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={`/api/v1/portal/supplier/statement/export/xlsx${exportQuery}`} download>
                <Download aria-hidden /> {t("exportExcel")}
              </a>
            </Button>
          </>
        }
      />
      <SupplierNav current="statement" />
      <form method="get" className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
        <div className="space-y-1">
          <label htmlFor="statement-from" className="block text-sm font-medium">
            {t("from")}
          </label>
          <Input id="statement-from" type="date" name="from" defaultValue={statement.from} />
        </div>
        <div className="space-y-1">
          <label htmlFor="statement-to" className="block text-sm font-medium">
            {t("to")}
          </label>
          <Input id="statement-to" type="date" name="to" defaultValue={statement.to} />
        </div>
        <div className="space-y-1">
          <label htmlFor="statement-project" className="block text-sm font-medium">
            {t("project")}
          </label>
          <select
            id="statement-project"
            name="projectId"
            defaultValue={statement.project?.id ?? ""}
            className={`${selectClass} w-full`}
          >
            <option value="">{t("allProjects")}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.code} · {project.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline">
          {t("show")}
        </Button>
      </form>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>
              {t("period", {
                from: formatCalendarDate(statement.from),
                to: formatCalendarDate(statement.to),
              })}
              {statement.project ? ` · ${statement.project.code}` : ""}
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl
            className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4"
            data-testid="statement-totals"
          >
            <div>
              <dt className="text-muted-foreground">{t("opening")}</dt>
              <dd className="font-medium tabular-nums">{formatKES(statement.openingMinor)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("invoiced")}</dt>
              <dd className="font-medium tabular-nums">{formatKES(statement.invoicedMinor)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("paid")}</dt>
              <dd className="font-medium tabular-nums">{formatKES(statement.paidMinor)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("closing")}</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {formatKES(statement.closingMinor)}
              </dd>
            </div>
          </dl>
          {statement.entries.length ? (
            <ol className="divide-y rounded-lg border" aria-label={t("title")}>
              {statement.entries.map((entry, index) => (
                <li
                  key={`${entry.kind}-${entry.invoiceId}-${index}`}
                  className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 p-3 text-sm"
                >
                  <span className="min-w-0 break-words">
                    <span className="block text-xs text-muted-foreground">
                      {formatCalendarDate(entry.date)}
                    </span>
                    {entry.kind === "invoice"
                      ? t("invoiceLine", { number: entry.invoiceNumber })
                      : t("paymentLine", {
                          number: entry.invoiceNumber,
                          method: entry.method ? tMethods(entry.method) : "",
                          reference: entry.reference ?? "",
                        })}
                  </span>
                  <span className="text-right tabular-nums">
                    <span className="block">
                      {entry.debitMinor
                        ? `+${formatKES(entry.debitMinor)}`
                        : `−${formatKES(entry.creditMinor)}`}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t("cols.balance")} {formatKES(entry.balanceMinor)}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noEntries")}</p>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("outstandingTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statement.outstanding.length ? (
              <ul className="space-y-2 text-sm">
                {statement.outstanding.map((row) => (
                  <li key={row.invoiceId} className="flex flex-wrap items-center gap-2">
                    <Link href={`/supplier/invoices/${row.invoiceId}`} className="underline">
                      {row.invoiceNumber}
                    </Link>
                    <span className="tabular-nums">{formatKES(row.outstandingMinor)}</span>
                    <span className="text-muted-foreground">
                      {t("due", { date: formatCalendarDate(row.dueDate) })}
                    </span>
                    {row.overdue ? <StatusBadge tone="danger">{t("overdue")}</StatusBadge> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t("noOutstanding")}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("notAcceptedTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statement.notAccepted.length ? (
              <ul className="space-y-2 text-sm">
                {statement.notAccepted.map((row) => (
                  <li key={row.invoiceId} className="flex flex-wrap items-center gap-2">
                    <Link href={`/supplier/invoices/${row.invoiceId}`} className="underline">
                      {row.invoiceNumber}
                    </Link>
                    <span className="tabular-nums">{formatKES(row.totalMinor)}</span>
                    <StatusBadge tone={supplierInvoiceTone[row.status]}>
                      {tInvoices(`statuses.${row.status}`)}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t("noNotAccepted")}</p>
            )}
          </CardContent>
        </Card>
      </div>
      <p className="rounded-md border bg-muted p-3 text-sm">
        {tPortal("paymentNote", { company: statement.company.name })}
      </p>
    </div>
  );
}
