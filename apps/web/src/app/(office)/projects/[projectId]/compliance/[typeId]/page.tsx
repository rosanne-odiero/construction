import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import { complianceHistoryResponseSchema, documentListResponseSchema } from "@pm-buddy/validation";
import { ComplianceRecordForm } from "@/components/documents/compliance-form";
import { ComplianceHistory } from "@/components/documents/compliance-history";
import { DocumentsEyebrow, loadDocumentsPage, UUID } from "@/components/documents/page-shell";
import { PageHeader } from "@/components/page-header";
import { complianceTypeLabel } from "@/lib/documents";
import { serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("documents");
  return { title: t("compliance.title") };
}

/** One compliance item of a project (D8.4): status, history and the record/renew form. */
export default async function ComplianceItemPage({
  params,
}: {
  params: Promise<{ projectId: string; typeId: string }>;
}) {
  const { projectId, typeId } = await params;
  if (!UUID.test(projectId) || !UUID.test(typeId)) notFound();
  const path = `/projects/${projectId}/compliance/${typeId}`;
  const page = await loadDocumentsPage(
    path,
    projectId,
    `/projects/${projectId}/compliance/items/${typeId}`,
    complianceHistoryResponseSchema,
  );
  if (!page.ok) return page.element;
  const { item } = page.data;
  const t = await getTranslations("documents");
  const label = complianceTypeLabel(item.type, (key) => t(key as never));
  const company = item.type.scope === "company";
  const canRecord = item.canRecord && !company;
  const documents = canRecord
    ? await serverApi(`/projects/${projectId}/documents?limit=100`, documentListResponseSchema)
    : null;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <DocumentsEyebrow
            projectId={projectId}
            code={page.project.project.code}
            tab="compliance"
          />
        }
        title={label}
      />
      <ComplianceHistory data={page.data} />
      {company ? (
        <p className="text-sm">
          <Link className="underline" href={`/documents/company/${item.type.id}`}>
            {t("companyItem.title")}
          </Link>
        </p>
      ) : null}
      {canRecord ? (
        <section aria-labelledby="compliance-record" className="space-y-3">
          <h2 id="compliance-record" className="text-base font-semibold">
            {item.current ? t("compliance.renewTitle") : t("compliance.recordTitle")}
          </h2>
          <ComplianceRecordForm
            key={item.current?.id ?? "none"}
            endpoint={`/projects/${projectId}/compliance`}
            typeId={item.type.id}
            expires={item.type.expires}
            currentId={item.current?.id ?? null}
            today={nairobiDate()}
            evidence={{
              mode: "project",
              options: documents?.ok
                ? documents.data.documents.map((document) => ({
                    versionId: document.current.id,
                    label: `${document.title} · ${t("common.revision", {
                      revision: document.current.revision,
                    })}`,
                  }))
                : [],
            }}
          />
        </section>
      ) : company ? null : (
        <p className="text-sm text-muted-foreground">{t("common.noPermission")}</p>
      )}
    </div>
  );
}
