import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { complianceTypesResponseSchema } from "@pm-buddy/validation";
import { ComplianceTypesEditor } from "@/components/documents/compliance-types";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { loadLive, requireSession } from "@/lib/server-api";

const PATH = "/documents/compliance-types";

export async function generateMetadata() {
  const t = await getTranslations("documents");
  return { title: t("types.title") };
}

/** The compliance item types every project's register tracks (D8.4). */
export default async function ComplianceTypesPage() {
  const session = await requireSession(PATH);
  if (!session) return <LiveUnavailable retryHref={PATH} />;
  const result = await loadLive("/documents/compliance-types", complianceTypesResponseSchema, PATH);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={PATH} />;
  const t = await getTranslations("documents");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/documents" className="hover:underline">
            {t("companyItem.back")}
          </Link>
        }
        title={t("types.title")}
        description={t("types.description")}
      />
      <ComplianceTypesEditor
        types={result.data.types}
        canConfigure={result.data.permissions.canConfigure}
      />
    </div>
  );
}
