import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import { approvalResponseSchema, documentListResponseSchema } from "@pm-buddy/validation";
import { RaiseApprovalForm } from "@/components/documents/approval-forms";
import { DocumentsEyebrow, loadDocumentsPage, UUID } from "@/components/documents/page-shell";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden } from "@/components/projects/live-state";
import { documentsAccess } from "@/lib/documents";
import { serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("documents");
  return { title: t("approvals.form.title") };
}

/** Ask a consultant for approval of a document's current version (D8.4). */
export default async function RaiseApprovalPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();
  const { documentId, resubmissionOf } = await searchParams;
  const path = `/projects/${projectId}/approvals/new`;
  const page = await loadDocumentsPage(
    path,
    projectId,
    `/projects/${projectId}/documents?limit=100`,
    documentListResponseSchema,
  );
  if (!page.ok) return page.element;
  if (!documentsAccess(page.project.permissions).manage) return <LiveForbidden />;
  const original =
    typeof resubmissionOf === "string" && UUID.test(resubmissionOf)
      ? await serverApi(
          `/projects/${projectId}/approvals/${resubmissionOf}`,
          approvalResponseSchema,
        )
      : null;
  const t = await getTranslations("documents");
  const today = nairobiDate();
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <DocumentsEyebrow
            projectId={projectId}
            code={page.project.project.code}
            tab="instructions"
            view="approvals"
          />
        }
        title={t("approvals.form.title")}
        description={t("approvals.form.description")}
      />
      <RaiseApprovalForm
        projectId={projectId}
        documents={page.data.documents.map((document) => ({
          documentId: document.id,
          versionId: document.current.id,
          label: `${document.drawingNumber ? `${document.drawingNumber} · ` : ""}${document.title} · ${t(
            "common.revision",
            { revision: document.current.revision },
          )}`,
        }))}
        documentId={typeof documentId === "string" ? documentId : undefined}
        resubmissionOf={
          original?.ok && original.data.approval.permissions.canResubmit
            ? {
                id: original.data.approval.id,
                code: original.data.approval.code,
                title: original.data.approval.title,
                addressedTo: original.data.approval.addressedTo,
              }
            : null
        }
        today={today}
        dueDefault={addCalendarDays(today, 14)}
      />
    </div>
  );
}
