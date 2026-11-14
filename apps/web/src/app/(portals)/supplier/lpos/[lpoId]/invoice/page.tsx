import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import { portalLpoDetailResponseSchema } from "@pm-buddy/validation";
import { SupplierPageState } from "@/components/supplier-portal/portal-state";
import { SupplierInvoiceForm } from "@/components/supplier-portal/supplier-invoice-form";
import { PortalHeading } from "@/components/supplier-portal/supplier-nav";
import { isUuid } from "@/lib/p2p";
import { loadSupplierPage } from "@/lib/supplier-portal-server";

export async function generateMetadata() {
  const t = await getTranslations("supplierPortal.form");
  return { title: t("title") };
}

/** Submit an invoice against one of the supplier's approved LPOs (D7.2). */
export default async function SupplierInvoiceNewPage({
  params,
}: {
  params: Promise<{ lpoId: string }>;
}) {
  const { lpoId } = await params;
  if (!isUuid(lpoId)) notFound();
  const path = `/supplier/lpos/${lpoId}/invoice`;
  const page = await loadSupplierPage(
    path,
    `/portal/supplier/lpos/${lpoId}`,
    portalLpoDetailResponseSchema,
  );
  if (page.kind !== "ok") return <SupplierPageState kind={page.kind} retryHref={path} />;
  const lpo = page.data;
  if (!lpo.permissions.canInvoice) notFound();
  const t = await getTranslations("supplierPortal.form");
  return (
    <div className="space-y-6">
      <Link
        href={`/supplier/lpos/${lpoId}`}
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> {t("back", { lpo: lpo.lpo.number })}
      </Link>
      <PortalHeading
        title={t("title")}
        description={t("description", {
          lpo: lpo.lpo.number,
          project: `${lpo.lpo.project.code} · ${lpo.lpo.project.name}`,
          company: page.company,
        })}
      />
      <SupplierInvoiceForm lpo={lpo} today={nairobiDate()} company={page.company} />
    </div>
  );
}
