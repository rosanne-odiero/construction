import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { supplierDetailResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { SupplierForm } from "@/components/procurement/supplier-form";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("suppliers.profile");
  return { title: t("edit") };
}

/** Edits a supplier's details, status, terms and contacts (payout details live on the profile). */
export default async function EditSupplierPage({
  params,
}: {
  params: Promise<{ supplierId: string }>;
}) {
  const { supplierId } = await params;
  if (!UUID.test(supplierId)) notFound();
  const path = `/suppliers/${supplierId}/edit`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await serverApi(`/suppliers/${supplierId}`, supplierDetailResponseSchema);
  if (!result.ok) {
    if (result.status === 401) redirect(signInHref(path));
    if (result.status === 404) notFound();
    if (result.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  if (!result.data.permissions.canManage) return <LiveForbidden />;
  const t = await getTranslations("suppliers");
  const tProfile = await getTranslations("suppliers.profile");
  const { supplier } = result.data;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <Link href="/suppliers" className="hover:underline">
              {t("title")}
            </Link>
            <span aria-hidden>/</span>
            <Link href={`/suppliers/${supplier.id}`} className="hover:underline">
              {supplier.code}
            </Link>
          </span>
        }
        title={tProfile("edit")}
      />
      <SupplierForm existing={result.data} />
    </div>
  );
}
