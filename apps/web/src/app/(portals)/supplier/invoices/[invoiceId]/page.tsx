import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft, FileText } from "lucide-react";
import type { StandardUnitCode } from "@pm-buddy/types";
import { portalInvoiceDetailResponseSchema } from "@pm-buddy/validation";
import { DocumentUpload } from "@/components/procurement/p2p/document-upload";
import { SupplierPageState } from "@/components/supplier-portal/portal-state";
import {
  HeadingBadge,
  PortalHeading,
  SupplierNav,
} from "@/components/supplier-portal/supplier-nav";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCalendarDate, formatDate, formatKES } from "@/lib/format";
import { formatQuantity, isUuid, pickParam } from "@/lib/p2p";
import { unitLabel } from "@/lib/procurement";
import { supplierInvoiceTone } from "@/lib/supplier-portal";
import { loadSupplierPage } from "@/lib/supplier-portal-server";

export async function generateMetadata() {
  const t = await getTranslations("supplierPortal.invoices");
  return { title: t("title") };
}

/**
 * One invoice as the supplier sees it (D7.2): its status, why it is disputed (match reason
 * codes, never the company's notes), the lines, the payments the company recorded and the
 * documents, with an upload while it is open.
 */
export default async function SupplierInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ invoiceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { invoiceId } = await params;
  if (!isUuid(invoiceId)) notFound();
  const raw = await searchParams;
  const path = `/supplier/invoices/${invoiceId}`;
  const page = await loadSupplierPage(
    path,
    `/portal/supplier/invoices/${invoiceId}`,
    portalInvoiceDetailResponseSchema,
  );
  if (page.kind !== "ok") return <SupplierPageState kind={page.kind} retryHref={path} />;
  const t = await getTranslations("supplierPortal.invoice");
  const tInvoices = await getTranslations("supplierPortal.invoices");
  const tMethods = await getTranslations("supplierPortal.methods");
  const tReasons = await getTranslations("p2p.match.reasons");
  const tPortal = await getTranslations("supplierPortal");
  const tVat = await getTranslations("catalogue.detail.vat");
  const tUnits = await getTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit));
  const { invoice, lines, dispute, payments, documents, permissions } = page.data;
  const company = page.company;
  const uploadFailed = pickParam(raw, "upload") === "failed";
  const replayed = pickParam(raw, "replayed") === "1";
  return (
    <div className="space-y-6">
      <Link
        href="/supplier/invoices"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> {t("back")}
      </Link>
      <PortalHeading
        title={invoice.invoiceNumber}
        description={`${t("lpo", {
          number: invoice.lpo.number,
          project: `${invoice.project.code} · ${invoice.project.name}`,
        })} · ${t("dates", {
          date: formatCalendarDate(invoice.invoiceDate),
          due: formatCalendarDate(invoice.dueDate),
        })}`}
        actions={
          <>
            <HeadingBadge>
              <StatusBadge tone={supplierInvoiceTone[invoice.status]}>
                {tInvoices(`statuses.${invoice.status}`)}
              </StatusBadge>
            </HeadingBadge>
            {invoice.overdue ? (
              <HeadingBadge>
                <StatusBadge tone="danger">{tInvoices("overdue")}</StatusBadge>
              </HeadingBadge>
            ) : null}
          </>
        }
      />
      <SupplierNav current="invoices" />
      {replayed ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-sm">
          {t("replayed")}
        </p>
      ) : null}
      {uploadFailed ? (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning/15 p-3 text-sm">
          {t("uploadFailed")}
        </p>
      ) : null}
      {invoice.status === "cancelled" ? (
        <p role="note" className="rounded-md border bg-muted p-3 text-sm">
          {t("cancelled", { company })}
        </p>
      ) : null}
      {dispute ? (
        <Card className="border-destructive/40" data-testid="dispute">
          <CardHeader>
            <CardTitle>
              <h2>{t("disputeTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="list-disc space-y-1 pl-5">
              {dispute.reasons.map((reason) => (
                <li key={reason}>{tReasons(reason)}</li>
              ))}
            </ul>
            {dispute.lines.map((line) => (
              <p key={line.lineNo} className="text-muted-foreground">
                {t("lineReasons", {
                  line: line.lineNo,
                  reasons: line.reasons.map((reason) => tReasons(reason)).join(" "),
                })}
              </p>
            ))}
            <p>{t("disputeHint", { company })}</p>
          </CardContent>
        </Card>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("linesTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ol className="space-y-2">
              {lines.map((line) => (
                <li key={line.lineNo} className="rounded-lg border p-3 text-sm">
                  <h3 className="font-medium">{line.material.name}</h3>
                  <p className="text-muted-foreground">
                    {formatQuantity(line.quantity)} {label(line.unit)} ×{" "}
                    {formatKES(line.unitPriceMinor)} · {tVat(line.vatTreatment)}
                  </p>
                  <p className="tabular-nums">
                    {t("cols.net")}: {formatKES(line.netAmountMinor)}
                  </p>
                </li>
              ))}
            </ol>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t pt-3 text-sm">
              <dt>{t("totals.subtotal")}</dt>
              <dd className="text-right tabular-nums">{formatKES(invoice.subtotalMinor)}</dd>
              <dt>{t("totals.vat")}</dt>
              <dd className="text-right tabular-nums">{formatKES(invoice.vatMinor)}</dd>
              <dt className="font-semibold">{t("totals.total")}</dt>
              <dd className="text-right font-semibold tabular-nums">
                {formatKES(invoice.totalMinor)}
              </dd>
              <dt>{t("totals.paid")}</dt>
              <dd className="text-right tabular-nums">{formatKES(invoice.paidMinor)}</dd>
              <dt>{t("totals.outstanding")}</dt>
              <dd className="text-right tabular-nums" data-testid="invoice-outstanding">
                {formatKES(invoice.outstandingMinor)}
              </dd>
            </dl>
            <p className="text-sm">
              <span className="text-muted-foreground">{t("etims")}:</span>{" "}
              <span className="font-mono break-all">{invoice.etimsInvoiceNumber ?? "—"}</span>
            </p>
            {invoice.etimsFormat === "unrecognised" ? (
              <p className="text-xs text-muted-foreground">{t("etimsUnrecognised", { company })}</p>
            ) : null}
            {invoice.submittedAt ? (
              <p className="text-xs text-muted-foreground">
                {t("submitted", { date: formatDate(invoice.submittedAt) })}
              </p>
            ) : null}
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>{t("paymentsTitle", { company })}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {payments.length ? (
                <ul className="space-y-1">
                  {payments.map((payment) => (
                    <li key={payment.id} className="break-words">
                      {t("paymentLine", {
                        amount: formatKES(payment.amountMinor),
                        date: formatCalendarDate(payment.paidOn),
                        method: tMethods(payment.method),
                        reference: payment.reference,
                      })}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">{t("noPayments")}</p>
              )}
              <p className="text-xs text-muted-foreground">{tPortal("paymentNote", { company })}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>{t("documentsTitle")}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {documents.length ? (
                <ul className="space-y-1">
                  {documents.map((document, index) => (
                    <li key={document.id} className="flex flex-wrap items-center gap-2">
                      <FileText className="size-4 text-muted-foreground" aria-hidden />
                      <a
                        href={`/api/v1/portal/supplier/documents/${document.id}`}
                        className="underline"
                        target="_blank"
                        rel="noopener"
                      >
                        {t("open", { number: index + 1 })}
                      </a>
                      <span className="text-xs text-muted-foreground">
                        {document.uploadedBySupplier ? t("byYou") : t("byCompany", { company })}
                        {document.scanStatus === "not_scanned" ? ` · ${t("notScanned")}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">
                  {permissions.canAttach ? t("documentMissing", { company }) : t("noDocuments")}
                </p>
              )}
              {permissions.canAttach ? (
                <DocumentUpload
                  id="portal-invoice-document"
                  path={`/portal/supplier/invoices/${invoice.id}/document`}
                  label={tPortal("upload.label")}
                  hint={tPortal("upload.hint")}
                  contract="supplier-portal"
                />
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
