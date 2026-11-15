import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { DOCUMENT_CATEGORIES } from "@pm-buddy/types";
import { documentListResponseSchema } from "@pm-buddy/validation";
import { UploadDocumentForm } from "@/components/documents/document-forms";
import { DocumentsEyebrow, loadDocumentsPage, UUID } from "@/components/documents/page-shell";
import { LiveForbidden } from "@/components/projects/live-state";
import { PageHeader } from "@/components/page-header";

export async function generateMetadata() {
  const t = await getTranslations("documents");
  return { title: t("upload.title") };
}

/** Upload a new document with its first version (D8.4). */
export default async function UploadDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();
  const { category } = await searchParams;
  const path = `/projects/${projectId}/documents/new`;
  const page = await loadDocumentsPage(
    path,
    projectId,
    `/projects/${projectId}/documents?limit=1`,
    documentListResponseSchema,
  );
  if (!page.ok) return page.element;
  if (!page.data.permissions.canUpload) return <LiveForbidden />;
  const t = await getTranslations("documents");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <DocumentsEyebrow
            projectId={projectId}
            code={page.project.project.code}
            tab="documents"
          />
        }
        title={t("upload.title")}
        description={t("upload.description")}
      />
      <UploadDocumentForm
        projectId={projectId}
        canSeeConfidential={page.data.permissions.canSeeConfidential}
        initialCategory={DOCUMENT_CATEGORIES.find((value) => value === category)}
      />
    </div>
  );
}
