import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import { instructionOptionsResponseSchema } from "@pm-buddy/validation";
import { RecordInstructionForm } from "@/components/documents/instruction-forms";
import { DocumentsEyebrow, loadDocumentsPage, UUID } from "@/components/documents/page-shell";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden } from "@/components/projects/live-state";
import { documentsAccess } from "@/lib/documents";

export async function generateMetadata() {
  const t = await getTranslations("documents");
  return { title: t("instructions.form.title") };
}

/** Record a consultant's instruction (D8.4), laid out for a phone on site. */
export default async function RecordInstructionPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();
  const path = `/projects/${projectId}/instructions/new`;
  const page = await loadDocumentsPage(
    path,
    projectId,
    `/projects/${projectId}/instructions/options`,
    instructionOptionsResponseSchema,
  );
  if (!page.ok) return page.element;
  if (!documentsAccess(page.project.permissions).recordInstruction) return <LiveForbidden />;
  const t = await getTranslations("documents");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <DocumentsEyebrow
            projectId={projectId}
            code={page.project.project.code}
            tab="instructions"
          />
        }
        title={t("instructions.form.title")}
        description={t("instructions.hint")}
      />
      <RecordInstructionForm projectId={projectId} options={page.data} today={nairobiDate()} />
    </div>
  );
}
