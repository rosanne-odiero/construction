import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import {
  complianceHistoryResponseSchema,
  documentsOverviewResponseSchema,
} from "@pm-buddy/validation";
import { ComplianceRecordForm } from "@/components/documents/compliance-form";
import { ComplianceHistory } from "@/components/documents/compliance-history";
import { UUID } from "@/components/documents/page-shell";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { complianceTypeLabel } from "@/lib/documents";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("documents");
  return { title: t("companyItem.title") };
}

/**
 * A company-level compliance item (D8.4): contractor NCA registration or WIBA cover, recorded once
 * and shown on every project. Recording needs config.manage (decision D-116).
 */
export default async function CompanyItemPage({ params }: { params: Promise<{ typeId: string }> }) {
  const { typeId } = await params;
  if (!UUID.test(typeId)) notFound();
  const path = `/documents/company/${typeId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [history, overview] = await Promise.all([
    loadLive(`/documents/compliance/${typeId}`, complianceHistoryResponseSchema, path),
    loadLive("/documents", documentsOverviewResponseSchema, path),
  ]);
  if (!history.ok || !overview.ok)
    return (!history.ok && history.status === 403) || (!overview.ok && overview.status === 403) ? (
      <LiveForbidden />
    ) : (
      <LiveUnavailable retryHref={path} />
    );
  const t = await getTranslations("documents");
  const { item } = history.data;
  if (item.type.scope !== "company") notFound();
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/documents" className="hover:underline">
            {t("companyItem.back")}
          </Link>
        }
        title={complianceTypeLabel(item.type, (key) => t(key as never))}
        description={t("overview.companyHint")}
      />
      <ComplianceHistory data={history.data} />
      {item.canRecord ? (
        <section aria-labelledby="company-record" className="space-y-3">
          <h2 id="company-record" className="text-base font-semibold">
            {item.current ? t("compliance.renewTitle") : t("compliance.recordTitle")}
          </h2>
          <ComplianceRecordForm
            key={item.current?.id ?? "none"}
            endpoint="/documents/compliance"
            typeId={item.type.id}
            expires={item.type.expires}
            currentId={item.current?.id ?? null}
            today={nairobiDate()}
            evidence={{
              mode: "company",
              projects: overview.data.projects.map((project) => ({
                id: project.id,
                code: project.code,
                name: project.name,
              })),
            }}
          />
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">{t("compliance.readOnlyCompany")}</p>
      )}
    </div>
  );
}
