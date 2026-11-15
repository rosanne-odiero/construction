import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Download } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import { approvalResponseSchema, documentListResponseSchema } from "@pm-buddy/validation";
import { ApprovalActions } from "@/components/documents/approval-forms";
import { EvidenceLink } from "@/components/documents/evidence-link";
import { DocumentsEyebrow, loadDocumentsPage, UUID } from "@/components/documents/page-shell";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { approvalTone, downloadHref, versionTone } from "@/lib/documents";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("documents");
  return { title: t("approvals.title") };
}

/**
 * One approval request (D8.4): the document version sent with its SHA-256, the due date and
 * overdue flag, the response (in the app or a recorded paper response) and the follow-ups.
 */
export default async function ApprovalPage({
  params,
}: {
  params: Promise<{ projectId: string; approvalId: string }>;
}) {
  const { projectId, approvalId } = await params;
  if (!UUID.test(projectId) || !UUID.test(approvalId)) notFound();
  const path = `/projects/${projectId}/approvals/${approvalId}`;
  const page = await loadDocumentsPage(
    path,
    projectId,
    `/projects/${projectId}/approvals/${approvalId}`,
    approvalResponseSchema,
  );
  if (!page.ok) return page.element;
  const { approval } = page.data;
  const t = await getTranslations("documents");
  const evidence = approval.permissions.canRecordPaper
    ? await serverApi(`/projects/${projectId}/documents?limit=100`, documentListResponseSchema)
    : null;
  const { document, response, cancellation } = approval;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <DocumentsEyebrow
            projectId={projectId}
            code={page.project.project.code}
            tab="instructions"
            view="approvals"
            current={approval.code}
          />
        }
        title={`${approval.code} · ${approval.title}`}
        description={t(`approvalKinds.${approval.kind}`)}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={approvalTone[approval.status]}>
              {t(`approvalStatuses.${approval.status}`)}
            </StatusBadge>
            {approval.overdue ? (
              <StatusBadge tone="danger">
                {t("common.overdueDays", { days: approval.daysOverdue })}
              </StatusBadge>
            ) : null}
          </span>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("approvals.detail.document")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {document.restricted ? (
              <p className="text-muted-foreground">
                {t("common.restricted")} — {t("common.restrictedHint")}
              </p>
            ) : (
              <>
                <p className="flex flex-wrap items-center gap-2">
                  <Link
                    className="underline"
                    href={`/projects/${projectId}/documents/${document.documentId}`}
                  >
                    {document.title} · {t("common.revision", { revision: document.revision })}
                  </Link>
                  <StatusBadge tone={versionTone[document.state]}>
                    {t(`versionStates.${document.state}`)}
                  </StatusBadge>
                </p>
                <p className="text-muted-foreground">
                  {t("common.by", { name: document.uploadedBy.displayName })}
                </p>
                <div>
                  <p className="font-medium">{t("approvals.detail.digest")}</p>
                  <p className="font-mono text-xs break-all" data-testid="approval-digest">
                    {document.sha256}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("approvals.detail.digestHint")}
                  </p>
                </div>
                <a
                  className="inline-flex items-center gap-1 underline"
                  href={downloadHref(projectId, document.documentId, document.versionId)}
                  download
                >
                  <Download className="size-4" aria-hidden />
                  {t("common.downloadRevision", { revision: document.revision })}
                </a>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("approvals.detail.response")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              {t("approvals.detail.sent", {
                date: formatCalendarDate(approval.sentOn),
                to: approval.addressedTo,
              })}
            </p>
            <p>{t("approvals.detail.due", { date: formatCalendarDate(approval.dueOn) })}</p>
            <p className="text-muted-foreground">
              {t("approvals.detail.raisedBy", {
                name: approval.raisedBy.displayName,
                date: formatDateTime(approval.raisedAt),
              })}
            </p>
            {approval.description ? (
              <p className="whitespace-pre-line">{approval.description}</p>
            ) : null}
            {approval.resubmissionOf ? (
              <p>
                <Link
                  className="underline"
                  href={`/projects/${projectId}/approvals/${approval.resubmissionOf.id}`}
                >
                  {t("approvals.detail.resubmissionOf", { code: approval.resubmissionOf.code })}
                </Link>
              </p>
            ) : null}
            {approval.resubmittedAs ? (
              <p>
                <Link
                  className="underline"
                  href={`/projects/${projectId}/approvals/${approval.resubmittedAs.id}`}
                >
                  {t("approvals.detail.resubmittedAs", { code: approval.resubmittedAs.code })}
                </Link>
              </p>
            ) : null}
            <div className="border-t pt-2" data-testid="approval-response">
              {response ? (
                <div className="space-y-1">
                  <p className="font-medium">
                    {t("approvals.detail.respondedOn", {
                      decision: t(`decisions.${response.decision}`),
                      date: formatCalendarDate(response.respondedOn),
                    })}
                  </p>
                  <p>
                    {response.channel === "paper"
                      ? t("approvals.detail.paperResponder", {
                          name: response.responderFirm
                            ? `${response.responderName} (${response.responderFirm})`
                            : response.responderName,
                          recorder: response.recordedBy.displayName,
                        })
                      : t("approvals.detail.responder", { name: response.responderName })}
                  </p>
                  {response.comments ? (
                    <p className="whitespace-pre-line">{response.comments}</p>
                  ) : null}
                  {response.evidence ? (
                    <p>
                      {t("approvals.detail.evidence")}:{" "}
                      <EvidenceLink evidence={response.evidence} />
                    </p>
                  ) : null}
                  <p className="font-mono text-xs break-all text-muted-foreground">
                    {t("detail.sha256")} {response.reviewedSha256}
                  </p>
                </div>
              ) : cancellation ? (
                <p>
                  {t("approvals.detail.cancelled", {
                    date: formatDateTime(cancellation.at),
                    name: cancellation.by.displayName,
                    reason: cancellation.reason,
                  })}
                </p>
              ) : (
                <p className="text-muted-foreground">{t("approvals.detail.noResponse")}</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
      <ApprovalActions
        projectId={projectId}
        approval={approval}
        today={nairobiDate()}
        evidence={
          evidence?.ok
            ? evidence.data.documents
                // A paper response attaches a new scan (D-117): another document, uploaded
                // after the request was raised (the API and the database refuse anything else).
                .filter(
                  (option) =>
                    (document.restricted || option.id !== document.documentId) &&
                    Date.parse(option.current.uploadedAt) >= Date.parse(approval.raisedAt),
                )
                .map((option) => ({
                  versionId: option.current.id,
                  label: `${option.title} · ${t("common.revision", {
                    revision: option.current.revision,
                  })}`,
                }))
            : []
        }
      />
    </div>
  );
}
