import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import { invoiceDetailResponseSchema, lpoDetailResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { InvoiceForm } from "@/components/procurement/p2p/invoice-form";
import { P2pEyebrow } from "@/components/procurement/p2p/p2p-subnav";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { isUuid } from "@/lib/p2p";
import { loadOrRedirect, unitOptions } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.invoices");
  return { title: t("title") };
}

/** Correct a draft invoice: a new content version, matched again on submission. */
export default async function EditInvoicePage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  if (!isUuid(invoiceId)) notFound();
  const detailPath = `/procurement/invoices/${invoiceId}`;
  const path = `${detailPath}/edit`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect(detailPath, invoiceDetailResponseSchema, path);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const { invoice, lines, permissions } = result.data;
  if (!permissions.canEdit) redirect(detailPath);
  const [lpo, units] = await Promise.all([
    loadOrRedirect(`/procurement/lpos/${invoice.lpo.id}`, lpoDetailResponseSchema, path),
    unitOptions(),
  ]);
  if (!lpo.ok) return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("p2p.invoices");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<P2pEyebrow trail={{ href: detailPath, label: invoice.invoiceNumber }} />}
        title={t("form.editTitle", { number: invoice.invoiceNumber })}
        description={t("form.description")}
      />
      <InvoiceForm
        lpo={lpo.data}
        units={units}
        today={nairobiDate()}
        initial={{
          id: invoice.id,
          version: invoice.version,
          invoiceNumber: invoice.invoiceNumber,
          invoiceDate: invoice.invoiceDate,
          etims: invoice.etimsInvoiceNumber,
          subtotalMinor: invoice.subtotalMinor,
          vatMinor: invoice.vatMinor,
          totalMinor: invoice.totalMinor,
          notes: invoice.notes,
          lines: lines.map((line) => ({
            lpoLineId: line.lpoLineId,
            quantity: line.quantity,
            unit: line.unit,
            unitPriceMinor: line.unitPriceMinor,
            vatTreatment: line.vatTreatment,
          })),
        }}
      />
    </div>
  );
}
