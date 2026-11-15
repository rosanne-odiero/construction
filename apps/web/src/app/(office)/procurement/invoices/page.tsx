import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Receipt } from "lucide-react";
import {
  INVOICE_SOURCES,
  INVOICE_STATUSES,
  type InvoiceSource,
  type InvoiceStatus,
} from "@pm-buddy/types";
import { invoicesResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { apiQuery, ListFilters, listHrefs, Pager } from "@/components/procurement/p2p/list-filters";
import { P2pEyebrow, P2pSubnav } from "@/components/procurement/p2p/p2p-subnav";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { invoiceTone, isUuid, pickParam } from "@/lib/p2p";
import { loadOrRedirect, projectOptions } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.invoices");
  return { title: t("title") };
}

const isStatus = (value: string | undefined): value is InvoiceStatus =>
  (INVOICE_STATUSES as readonly string[]).includes(value ?? "");
const isSource = (value: string | undefined): value is InvoiceSource =>
  (INVOICE_SOURCES as readonly string[]).includes(value ?? "");

/**
 * Supplier invoices with their eTIMS flag, match outcome and what is outstanding (D5.2), and who
 * put them in: staff or the supplier through the supplier portal (D7.2).
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const project = isUuid(pickParam(raw, "project")) ? pickParam(raw, "project") : undefined;
  const status = isStatus(pickParam(raw, "status")) ? pickParam(raw, "status") : undefined;
  const source = isSource(pickParam(raw, "source")) ? pickParam(raw, "source") : undefined;
  const cursor = isUuid(pickParam(raw, "cursor")) ? pickParam(raw, "cursor") : undefined;
  const path = `/procurement/invoices${apiQuery({ project, status, source, cursor })}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, projects] = await Promise.all([
    loadOrRedirect(
      `/procurement/invoices${apiQuery({ projectId: project, status, source, cursor })}`,
      invoicesResponseSchema,
      path,
    ),
    projectOptions(),
  ]);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("p2p.invoices");
  const tCommon = await getTranslations("p2p.common");
  const tStatus = await getTranslations("p2p.status.invoice");
  const { invoices, page, permissions } = result.data;
  const hrefs = listHrefs("/procurement/invoices", { project, status, source }, page.nextCursor);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<P2pEyebrow />}
        title={t("title")}
        description={t("description")}
        actions={
          permissions.canRecord ? (
            <Button asChild>
              <Link href="/procurement/invoices/new">
                <Receipt aria-hidden /> {t("new")}
              </Link>
            </Button>
          ) : null
        }
      />
      <P2pSubnav current="invoices" />
      <ListFilters
        action="/procurement/invoices"
        projects={projects}
        statuses={INVOICE_STATUSES.map((value) => ({ value, label: tStatus(value) }))}
        project={project}
        status={status}
        extra={{
          name: "source",
          label: t("sourceFilter"),
          allLabel: t("allSources"),
          options: INVOICE_SOURCES.map((value) => ({ value, label: t(`source.${value}`) })),
          value: source,
        }}
      />
      <p className="text-sm text-muted-foreground" role="status">
        {tCommon("count", { count: invoices.length })}
      </p>
      {invoices.length === 0 ? (
        <p className="rounded-xl border border-dashed p-8 text-center font-medium">
          {project || status || source ? tCommon("noMatches") : tCommon("empty")}
        </p>
      ) : (
        <div
          role="region"
          tabIndex={0}
          aria-label={t("title")}
          className="relative overflow-x-auto rounded-xl border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <table className="w-full min-w-[900px] text-sm">
            <caption className="sr-only">{t("title")}</caption>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {t("cols.number")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.lpo")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.supplier")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.date")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.etims")}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t("cols.total")}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t("cols.outstanding")}
                </th>
                <th scope="col" className="py-2 pr-4 pl-3 font-medium">
                  {t("cols.status")}
                </th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((row) => (
                <tr key={row.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-medium">
                    <Link
                      href={`/procurement/invoices/${row.id}`}
                      className="underline underline-offset-4"
                    >
                      {row.invoiceNumber}
                    </Link>
                  </th>
                  <td className="py-2 pr-2">
                    <Link href={`/procurement/lpos/${row.lpo.id}`} className="hover:underline">
                      {row.lpo.number}
                    </Link>
                  </td>
                  <td className="py-2 pr-2">
                    {row.supplier.name}
                    {row.source === "supplier_portal" ? (
                      <span className="mt-1 block">
                        <StatusBadge tone="info">{t("source.supplier_portal")}</StatusBadge>
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2">
                    {formatCalendarDate(row.invoiceDate)}
                    <span className="block text-xs text-muted-foreground">
                      {t("cols.due")} {formatCalendarDate(row.dueDate)}
                    </span>
                  </td>
                  <td className="py-2 pr-2">
                    {row.etimsInvoiceNumber ? (
                      <span className="font-mono text-xs">{row.etimsInvoiceNumber}</span>
                    ) : (
                      <StatusBadge tone="warning">{t("etimsMissing")}</StatusBadge>
                    )}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">{formatKES(row.totalMinor)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatKES(row.outstandingMinor)}
                  </td>
                  <td className="py-2 pr-4 pl-3">
                    <StatusBadge tone={invoiceTone[row.status]}>{tStatus(row.status)}</StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        label={t("title")}
        firstHref={hrefs.first}
        nextHref={hrefs.next}
        paged={Boolean(cursor)}
      />
    </div>
  );
}
