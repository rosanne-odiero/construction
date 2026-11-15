import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SUPPLIER_INVOICE_STATUSES, type SupplierInvoiceStatus } from "@pm-buddy/types";
import { portalInvoicesResponseSchema } from "@pm-buddy/validation";
import { selectClass } from "@/components/procurement/material-form";
import { SupplierPageState } from "@/components/supplier-portal/portal-state";
import { PortalHeading, SupplierNav } from "@/components/supplier-portal/supplier-nav";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { isUuid, pickParam } from "@/lib/p2p";
import { supplierInvoiceTone } from "@/lib/supplier-portal";
import { loadSupplierPage } from "@/lib/supplier-portal-server";

export async function generateMetadata() {
  const t = await getTranslations("supplierPortal.invoices");
  return { title: t("title") };
}

const isStatus = (value: string | undefined): value is SupplierInvoiceStatus =>
  (SUPPLIER_INVOICE_STATUSES as readonly string[]).includes(value ?? "");

/** The supplier's invoices (D7.2) with their status, what was paid and what is outstanding. */
export default async function SupplierInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const status = pickParam(raw, "status");
  const cursor = pickParam(raw, "cursor");
  const query = new URLSearchParams();
  if (isStatus(status)) query.set("status", status);
  if (cursor && isUuid(cursor)) query.set("cursor", cursor);
  const suffix = query.size ? `?${query}` : "";
  const path = `/supplier/invoices${suffix}`;
  const page = await loadSupplierPage(
    path,
    `/portal/supplier/invoices${suffix}`,
    portalInvoicesResponseSchema,
  );
  if (page.kind !== "ok") return <SupplierPageState kind={page.kind} retryHref={path} />;
  const t = await getTranslations("supplierPortal.invoices");
  const { invoices, page: info } = page.data;
  const next = new URLSearchParams(query);
  if (info.nextCursor) next.set("cursor", info.nextCursor);
  const first = new URLSearchParams(query);
  first.delete("cursor");
  return (
    <div className="space-y-6">
      <PortalHeading title={t("title")} description={t("description", { company: page.company })} />
      <SupplierNav current="invoices" />
      <form method="get" className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label htmlFor="invoice-status" className="block text-sm font-medium">
            {t("status")}
          </label>
          <select
            id="invoice-status"
            name="status"
            defaultValue={isStatus(status) ? status : ""}
            className={selectClass}
          >
            <option value="">{t("allStatuses")}</option>
            {SUPPLIER_INVOICE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`statuses.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline">
          {t("apply")}
        </Button>
      </form>
      {invoices.length ? (
        <ul className="space-y-3">
          {invoices.map((invoice) => (
            <li key={invoice.id}>
              <Card>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h2 className="min-w-0 text-base font-semibold break-words">
                      <Link href={`/supplier/invoices/${invoice.id}`} className="hover:underline">
                        {invoice.invoiceNumber}
                      </Link>
                    </h2>
                    <div className="flex flex-wrap gap-1">
                      <StatusBadge tone={supplierInvoiceTone[invoice.status]}>
                        {t(`statuses.${invoice.status}`)}
                      </StatusBadge>
                      {invoice.overdue ? (
                        <StatusBadge tone="danger">{t("overdue")}</StatusBadge>
                      ) : null}
                    </div>
                  </div>
                  <p className="text-muted-foreground">
                    {invoice.lpo.number} · {invoice.project.code} ·{" "}
                    {formatCalendarDate(invoice.invoiceDate)} ·{" "}
                    {t("due", { date: formatCalendarDate(invoice.dueDate) })}
                  </p>
                  <p className="tabular-nums">
                    {t("paidOf", {
                      paid: formatKES(invoice.paidMinor),
                      total: formatKES(invoice.totalMinor),
                    })}
                    {invoice.outstandingMinor > 0
                      ? ` · ${t("outstanding", { amount: formatKES(invoice.outstandingMinor) })}`
                      : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t(`source.${invoice.source}`, { company: page.company })}
                  </p>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed p-6 text-center">{t("empty")}</p>
      )}
      {query.has("cursor") || info.nextCursor ? (
        <nav aria-label={t("title")} className="flex flex-wrap gap-3 text-sm">
          {query.has("cursor") ? (
            <Link href={`/supplier/invoices${first.size ? `?${first}` : ""}`} className="underline">
              {t("firstPage")}
            </Link>
          ) : null}
          {info.nextCursor ? (
            <Link href={`/supplier/invoices?${next}`} className="underline">
              {t("nextPage")}
            </Link>
          ) : null}
        </nav>
      ) : null}
      <p className="text-sm text-muted-foreground">{t("submitHint")}</p>
    </div>
  );
}
