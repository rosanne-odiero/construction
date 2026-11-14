import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft, Receipt } from "lucide-react";
import type { StandardUnitCode } from "@pm-buddy/types";
import { portalLpoDetailResponseSchema } from "@pm-buddy/validation";
import { AcknowledgeButton } from "@/components/supplier-portal/acknowledge-button";
import { SupplierPageState } from "@/components/supplier-portal/portal-state";
import {
  HeadingBadge,
  PortalHeading,
  SupplierNav,
} from "@/components/supplier-portal/supplier-nav";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCalendarDate, formatDate, formatKES } from "@/lib/format";
import { deliveryTone, formatQuantity, grnTone, isUuid, lpoTone } from "@/lib/p2p";
import { unitLabel } from "@/lib/procurement";
import { supplierInvoiceTone } from "@/lib/supplier-portal";
import { loadSupplierPage } from "@/lib/supplier-portal-server";

export async function generateMetadata() {
  const t = await getTranslations("supplierPortal.lpos");
  return { title: t("title") };
}

/**
 * One approved LPO as the supplier sees it (D7.2): lines with net prices and VAT, the delivery
 * site and date, terms, what was received and invoiced, the acknowledgement and the way to
 * submit an invoice. Laid out as stacked lines so a 360 px phone never scrolls sideways.
 */
export default async function SupplierLpoPage({ params }: { params: Promise<{ lpoId: string }> }) {
  const { lpoId } = await params;
  if (!isUuid(lpoId)) notFound();
  const path = `/supplier/lpos/${lpoId}`;
  const page = await loadSupplierPage(
    path,
    `/portal/supplier/lpos/${lpoId}`,
    portalLpoDetailResponseSchema,
  );
  if (page.kind !== "ok") return <SupplierPageState kind={page.kind} retryHref={path} />;
  const t = await getTranslations("supplierPortal.lpo");
  const tList = await getTranslations("supplierPortal.lpos");
  const tInvoices = await getTranslations("supplierPortal.invoices");
  const tStatus = await getTranslations("p2p.status");
  const tVat = await getTranslations("catalogue.detail.vat");
  const tUnits = await getTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit));
  const { lpo, lines, deliveries, invoices, permissions, terms } = page.data;
  const company = page.company;
  const baseUnits = [...new Set(lines.map((line) => line.material.baseUnit))].map(label);
  return (
    <div className="space-y-6">
      <Link
        href="/supplier/lpos"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> {t("back")}
      </Link>
      <PortalHeading
        title={lpo.number}
        description={`${lpo.project.code} · ${lpo.project.name} · ${t("approvedOn", {
          date: formatDate(lpo.approvedAt),
        })}`}
        actions={
          <>
            <HeadingBadge>
              <StatusBadge tone={lpoTone[lpo.status]}>
                {tList(`statuses.${lpo.status}`)}
              </StatusBadge>
            </HeadingBadge>
            {lpo.status === "approved" ? (
              <HeadingBadge>
                <StatusBadge tone={deliveryTone[lpo.deliveryState]}>
                  {tStatus(`delivery.${lpo.deliveryState}`)}
                </StatusBadge>
              </HeadingBadge>
            ) : null}
          </>
        }
      />
      <SupplierNav current="lpos" />
      {lpo.status === "cancelled" && lpo.cancelledAt ? (
        <p role="note" className="rounded-md border border-warning/40 bg-warning/15 p-3 text-sm">
          {t("cancelledNote", { company, date: formatDate(lpo.cancelledAt) })}
        </p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("deliveryTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("site")}</dt>
              <dd>{lpo.deliverySite?.name ?? t("notSet")}</dd>
              {lpo.deliverySite?.address ? (
                <>
                  <dt className="text-muted-foreground">{t("address")}</dt>
                  <dd className="break-words">{lpo.deliverySite.address}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">{t("date")}</dt>
              <dd>{lpo.deliveryDate ? formatCalendarDate(lpo.deliveryDate) : t("notSet")}</dd>
              <dt className="text-muted-foreground">{t("terms")}</dt>
              <dd className="break-words whitespace-pre-line">{terms ?? t("noTerms")}</dd>
            </dl>
            <p className="mt-2 text-sm">{t("credit", { days: lpo.creditDays })}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-3">
            {lpo.acknowledgement ? (
              <p className="text-sm" data-testid="acknowledged">
                <StatusBadge tone="success">{tList("acknowledged")}</StatusBadge>{" "}
                {t("acknowledgedBy", {
                  name: lpo.acknowledgement.acknowledgedBy.displayName,
                  date: formatDate(lpo.acknowledgement.acknowledgedAt),
                })}
              </p>
            ) : permissions.canAcknowledge ? (
              <AcknowledgeButton lpoId={lpo.id} company={company} />
            ) : null}
            {permissions.canInvoice ? (
              <Button asChild variant={lpo.acknowledgement ? "default" : "outline"}>
                <Link href={`/supplier/lpos/${lpo.id}/invoice`}>
                  <Receipt aria-hidden /> {t("submitInvoice")}
                </Link>
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("linesTitle")}</h2>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {t("quantitiesNote", { unit: baseUnits.join(", ") })}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <ol className="space-y-3">
            {lines.map((line) => (
              <li key={line.id} className="rounded-lg border p-3">
                <h3 className="text-sm font-medium">
                  {line.lineNo}. {line.material.name}
                </h3>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("cols.ordered")}</dt>
                    <dd>
                      {formatQuantity(line.quantity)} {label(line.unit)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("cols.price")}</dt>
                    <dd>
                      {formatKES(line.unitPriceMinor)} / {label(line.priceUnit)} ·{" "}
                      {tVat(line.vatTreatment)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("cols.net")}</dt>
                    <dd className="tabular-nums">{formatKES(line.netAmountMinor)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("cols.received")}</dt>
                    <dd>{formatQuantity(line.receivedBaseQuantity)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("cols.invoiced")}</dt>
                    <dd>{formatQuantity(line.invoicedBaseQuantity)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("cols.pending")}</dt>
                    <dd>{formatQuantity(line.pendingBaseQuantity)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("cols.invoiceable")}</dt>
                    <dd className="font-medium">{formatQuantity(line.invoiceableBaseQuantity)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t pt-3 text-sm">
            <dt>{t("subtotal")}</dt>
            <dd className="text-right tabular-nums">{formatKES(lpo.subtotalMinor)}</dd>
            <dt>{t("vat", { rate: lpo.vatRatePercent })}</dt>
            <dd className="text-right tabular-nums">{formatKES(lpo.vatMinor)}</dd>
            <dt className="font-semibold">{t("total")}</dt>
            <dd className="text-right font-semibold tabular-nums">{formatKES(lpo.totalMinor)}</dd>
          </dl>
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("deliveriesTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {deliveries.length ? (
              <ul className="space-y-2 text-sm">
                {deliveries.map((delivery) => (
                  <li key={delivery.id} className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/supplier/deliveries?lpoId=${lpo.id}`}
                      className="font-medium underline"
                    >
                      {delivery.number}
                    </Link>
                    <span className="text-muted-foreground">{formatDate(delivery.receivedAt)}</span>
                    <StatusBadge tone={grnTone[delivery.status]}>
                      {tStatus(`grn.${delivery.status}`)}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t("noDeliveries")}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("invoicesTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {invoices.length ? (
              <ul className="space-y-2 text-sm">
                {invoices.map((invoice) => (
                  <li key={invoice.id} className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/supplier/invoices/${invoice.id}`}
                      className="font-medium underline"
                    >
                      {invoice.invoiceNumber}
                    </Link>
                    <span className="tabular-nums">{formatKES(invoice.totalMinor)}</span>
                    <StatusBadge tone={supplierInvoiceTone[invoice.status]}>
                      {tInvoices(`statuses.${invoice.status}`)}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t("noInvoices")}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
