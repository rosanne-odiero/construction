import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SupplierForm } from "@/components/procurement/supplier-form";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("suppliers.form");
  return { title: t("createTitle") };
}

/** Adds a supplier (procurement.manage_suppliers; the API checks it again). */
export default async function NewSupplierPage() {
  const path = "/suppliers/new";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  if (!session.company.permissions.includes("procurement.manage_suppliers"))
    return <LiveForbidden />;
  const t = await getTranslations("suppliers");
  const tForm = await getTranslations("suppliers.form");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/suppliers" className="hover:underline">
            {t("title")}
          </Link>
        }
        title={tForm("createTitle")}
      />
      <SupplierForm />
    </div>
  );
}
