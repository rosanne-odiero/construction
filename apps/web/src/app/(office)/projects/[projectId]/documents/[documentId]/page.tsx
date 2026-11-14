import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Download, TriangleAlert } from "lucide-react";
import { documentResponseSchema } from "@pm-buddy/validation";
import { DocumentActions } from "@/components/documents/document-forms";
import { DocumentsEyebrow, loadDocumentsPage, UUID } from "@/components/documents/page-shell";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { approvalTone, downloadHref, formatBytes, versionTone } from "@/lib/documents";
import { formatDate, formatDateTime } from "@/lib/format";

export async function generateMetadata() {
  const t = await getTranslations("documents");
  return { title: t("tab.title") };
}

/**
 * One document (D8.4): its current version, every earlier version labelled superseded (never
 * presented as current; decision D-111), and the actions the caller may take.
 */
export default async function DocumentPage({
  params,
}: {
  params: Promise<{ projectId: string; documentId: string }>;
}) {
  const { projectId, documentId } = await params;
  if (!UUID.test(projectId) || !UUID.test(documentId)) notFound();
  const path = `/projects/${projectId}/documents/${documentId}`;
  const page = await loadDocumentsPage(
    path,
    projectId,
    `/projects/${projectId}/documents/${documentId}`,
    documentResponseSchema,
  );
  if (!page.ok) return page.element;
  const { document } = page.data;
  const t = await getTranslations("documents");
  const current = document.current;
  const facts = [
    t(`categories.${document.category}`),
    document.discipline ? t(`disciplines.${document.discipline}`) : null,
    document.reference,
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <DocumentsEyebrow
            projectId={projectId}
            code={page.project.project.code}
            tab="documents"
            current={document.drawingNumber ?? undefined}
          />
        }
        title={
          document.drawingNumber ? `${document.drawingNumber} · ${document.title}` : document.title
        }
        description={facts.join(" · ")}
        actions={<DocumentActions projectId={projectId} document={document} />}
      />
      {document.withdrawal ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-sm">
          {t("detail.withdrawn", {
            date: formatDate(document.withdrawal.at),
            name: document.withdrawal.by.displayName,
            reason: document.withdrawal.reason,
          })}
        </p>
      ) : null}

      <Card data-testid="current-version">
        <CardHeader>
          <CardTitle>
            <h2 className="flex flex-wrap items-center gap-2">
              {t("detail.currentTitle")}
              <span className="font-mono">
                {t("common.revision", { revision: current.revision })}
              </span>
              <StatusBadge tone="success">{t("versionStates.current")}</StatusBadge>
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{t("detail.cols.purpose")}</dt>
              <dd>{current.issuePurpose ? t(`purposes.${current.issuePurpose}`) : "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("detail.cols.uploaded")}</dt>
              <dd>
                {t("detail.uploadedBy", {
                  name: current.uploadedBy.displayName,
                  date: formatDateTime(current.uploadedAt),
                })}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("detail.cols.file")}</dt>
              <dd className="break-all">
                {current.fileName} · {formatBytes(current.sizeBytes)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("detail.cols.approval")}</dt>
              <dd>
                {current.approval ? (
                  <Link href={`/projects/${projectId}/approvals/${current.approval.id}`}>
                    <StatusBadge tone={approvalTone[current.approval.status]}>
                      {t("detail.approval", {
                        code: current.approval.code,
                        status: t(`approvalStatuses.${current.approval.status}`),
                      })}
                    </StatusBadge>
                  </Link>
                ) : (
                  "—"
                )}
              </dd>
            </div>
          </dl>
          <Button asChild>
            <a href={downloadHref(projectId, document.id, current.id)} download>
              <Download className="size-4" aria-hidden />
              {t("common.downloadRevision", { revision: current.revision })}
            </a>
          </Button>
        </CardContent>
      </Card>

      <section aria-labelledby="versions-heading" className="space-y-2">
        <h2 id="versions-heading" className="text-base font-semibold">
          {t("detail.versionsTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("detail.versionsHint")}</p>
        <div className="relative overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="version-list">
            <caption className="sr-only">{t("detail.versionsTitle")}</caption>
            <thead className="bg-muted/50 text-left">
              <tr>
                <th scope="col" className="p-2 font-medium">
                  {t("detail.cols.revision")}
                </th>
                <th scope="col" className="p-2 font-medium">
                  {t("detail.cols.state")}
                </th>
                <th scope="col" className="p-2 font-medium">
                  {t("detail.cols.note")}
                </th>
                <th scope="col" className="p-2 font-medium">
                  {t("detail.cols.uploaded")}
                </th>
                <th scope="col" className="p-2 font-medium">
                  {t("detail.cols.file")}
                </th>
              </tr>
            </thead>
            <tbody>
              {document.versions.map((version) => (
                <tr key={version.id} className="border-t align-top" data-state={version.state}>
                  <th scope="row" className="p-2 text-left font-normal">
                    <span className="font-mono font-medium">{version.revision}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t("common.version", { number: version.versionNo })}
                    </span>
                  </th>
                  <td className="p-2">
                    <StatusBadge tone={versionTone[version.state]}>
                      {t(`versionStates.${version.state}`)}
                    </StatusBadge>
                    {version.state === "superseded" &&
                    version.supersededBy &&
                    version.supersededAt ? (
                      <span className="mt-1 flex items-start gap-1 text-xs text-warning-foreground dark:text-warning">
                        <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                        {t("detail.supersededBanner", {
                          revision: version.supersededBy.revision,
                          date: formatDate(version.supersededAt),
                        })}
                      </span>
                    ) : null}
                    {version.approval ? (
                      <StatusBadge tone={approvalTone[version.approval.status]} className="mt-1">
                        {t("detail.approval", {
                          code: version.approval.code,
                          status: t(`approvalStatuses.${version.approval.status}`),
                        })}
                      </StatusBadge>
                    ) : null}
                  </td>
                  <td className="p-2">
                    {version.issuePurpose ? (
                      <span className="block">{t(`purposes.${version.issuePurpose}`)}</span>
                    ) : null}
                    <span className="text-muted-foreground">{version.changeNote ?? "—"}</span>
                  </td>
                  <td className="p-2">
                    {version.uploadedBy.displayName}
                    <span className="block text-xs text-muted-foreground tabular-nums">
                      {formatDateTime(version.uploadedAt)}
                    </span>
                  </td>
                  <td className="p-2">
                    <a
                      className="inline-flex items-center gap-1 underline"
                      href={downloadHref(projectId, document.id, version.id)}
                      download
                    >
                      <Download className="size-4" aria-hidden />
                      {t("common.downloadRevision", { revision: version.revision })}
                    </a>
                    <span className="block text-xs text-muted-foreground">
                      {formatBytes(version.sizeBytes)} · {t(`detail.scan.${version.scanStatus}`)}
                    </span>
                    <span className="block font-mono text-[11px] break-all text-muted-foreground">
                      {t("detail.sha256")} {version.sha256}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
