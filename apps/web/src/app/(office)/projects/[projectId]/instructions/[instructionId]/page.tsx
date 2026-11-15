import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import {
  instructionLogResponseSchema,
  instructionOptionsResponseSchema,
} from "@pm-buddy/validation";
import { InstructionActions } from "@/components/documents/instruction-forms";
import { DocumentsEyebrow, loadDocumentsPage, UUID } from "@/components/documents/page-shell";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { instructionTone, versionTone } from "@/lib/documents";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("documents");
  return { title: t("instructions.title") };
}

/**
 * One consultant instruction (D8.4): details, implications and links, attachments, and the
 * append-only responses that move it received → acknowledged → actioned → closed.
 */
export default async function InstructionPage({
  params,
}: {
  params: Promise<{ projectId: string; instructionId: string }>;
}) {
  const { projectId, instructionId } = await params;
  if (!UUID.test(projectId) || !UUID.test(instructionId)) notFound();
  const path = `/projects/${projectId}/instructions/${instructionId}`;
  const page = await loadDocumentsPage(
    path,
    projectId,
    `/projects/${projectId}/instructions/${instructionId}`,
    instructionLogResponseSchema,
  );
  if (!page.ok) return page.element;
  const { instruction } = page.data;
  const { permissions } = instruction;
  const options =
    permissions.canEdit || permissions.canAttach
      ? await serverApi(
          `/projects/${projectId}/instructions/options`,
          instructionOptionsResponseSchema,
        )
      : null;
  const t = await getTranslations("documents");
  const canViewBq = page.project.permissions.includes("bq.view");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <DocumentsEyebrow
            projectId={projectId}
            code={page.project.project.code}
            tab="instructions"
            current={instruction.number}
          />
        }
        title={`${instruction.number} · ${instruction.subject}`}
        description={t(`instructionKinds.${instruction.kind}`)}
        actions={
          <InstructionActions
            projectId={projectId}
            instruction={instruction}
            options={options?.ok ? options.data : null}
            today={nairobiDate()}
          />
        }
      />
      {instruction.status === "closed" ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-sm">
          {t("instructions.detail.locked")}
        </p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>
              <h2 className="flex flex-wrap items-center gap-2">
                {t("instructions.detail.status")}
                <StatusBadge tone={instructionTone[instruction.status]}>
                  {t(`instructionStatuses.${instruction.status}`)}
                </StatusBadge>
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              {t("instructions.detail.issued", {
                date: formatCalendarDate(instruction.issuedOn),
                name: `${instruction.issuerName} (${t(`issuerRoles.${instruction.issuerRole}`)})`,
              })}
            </p>
            {instruction.issuerFirm ? (
              <p>{t("instructions.detail.firm", { firm: instruction.issuerFirm })}</p>
            ) : null}
            <p>
              {t("instructions.detail.received", {
                date: formatCalendarDate(instruction.receivedOn),
              })}
            </p>
            {instruction.issuedBy ? (
              <p className="text-muted-foreground">
                {t("instructions.detail.issuedBy", { name: instruction.issuedBy.displayName })}
              </p>
            ) : null}
            {instruction.description ? (
              <p className="whitespace-pre-line">{instruction.description}</p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("instructions.detail.implications")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {instruction.costImplication || instruction.timeImplication ? (
              <p className="flex flex-wrap gap-1">
                {instruction.costImplication ? (
                  <StatusBadge tone="warning">{t("instructions.form.cost")}</StatusBadge>
                ) : null}
                {instruction.timeImplication ? (
                  <StatusBadge tone="warning">{t("instructions.form.time")}</StatusBadge>
                ) : null}
              </p>
            ) : (
              <p className="text-muted-foreground">{t("instructions.detail.noImplications")}</p>
            )}
            {instruction.delay ? (
              <p>
                {t("instructions.detail.delay", {
                  number: instruction.delay.number,
                  cause: instruction.delay.cause,
                  status: instruction.delay.status,
                })}
              </p>
            ) : null}
            <div className="space-y-1">
              <h3 className="font-medium">{t("instructions.detail.variations")}</h3>
              {instruction.variationList.length ? (
                <ul className="space-y-1">
                  {instruction.variationList.map((variation) => (
                    <li key={variation.id}>
                      {canViewBq ? (
                        <Link
                          className="underline"
                          href={`/projects/${projectId}/bq/variations/${variation.id}`}
                        >
                          {variation.number} · {variation.title}
                        </Link>
                      ) : (
                        `${variation.number} · ${variation.title}`
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">{t("instructions.detail.noVariations")}</p>
              )}
              {canViewBq && instruction.costImplication ? (
                <Link className="underline" href={`/projects/${projectId}/bq/variations`}>
                  {t("instructions.detail.raiseVariation")}
                </Link>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby="attachments-heading" className="space-y-2">
        <h2 id="attachments-heading" className="text-base font-semibold">
          {t("instructions.detail.attachments")}
        </h2>
        {instruction.attachmentList.length || instruction.legacyAttachments.length ? (
          <ul className="divide-y rounded-md border text-sm">
            {instruction.attachmentList.map((attachment) => (
              <li key={attachment.id} className="flex flex-wrap items-center gap-2 p-3">
                {attachment.restricted ? (
                  <span className="text-muted-foreground">
                    {t("common.restricted")} — {t("common.restrictedHint")}
                  </span>
                ) : attachment.document ? (
                  <>
                    <Link
                      className="underline"
                      href={`/projects/${projectId}/documents/${attachment.document.documentId}`}
                    >
                      {attachment.document.title} ·{" "}
                      {t("common.revision", { revision: attachment.document.revision })}
                    </Link>
                    <StatusBadge tone={versionTone[attachment.document.state]}>
                      {t(`versionStates.${attachment.document.state}`)}
                    </StatusBadge>
                  </>
                ) : attachment.photo ? (
                  <>
                    <span>{attachment.photo.caption ?? t("instructions.detail.attachPhoto")}</span>
                    {attachment.photo.verified ? (
                      <StatusBadge tone="success">{t("instructions.detail.verified")}</StatusBadge>
                    ) : null}
                  </>
                ) : null}
                <span className="text-xs text-muted-foreground">
                  {t("detail.uploadedBy", {
                    name: attachment.addedBy.displayName,
                    date: formatDateTime(attachment.addedAt),
                  })}
                </span>
              </li>
            ))}
            {instruction.legacyAttachments.map((attachment, index) => (
              <li key={`legacy-${index}`} className="p-3 text-muted-foreground">
                {t("instructions.detail.legacy", {
                  name: attachment.reference
                    ? `${attachment.name} (${attachment.reference})`
                    : attachment.name,
                })}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("instructions.detail.noAttachments")}</p>
        )}
      </section>

      <section aria-labelledby="responses-heading" className="space-y-2">
        <h2 id="responses-heading" className="text-base font-semibold">
          {t("instructions.detail.responses")}
        </h2>
        {instruction.responseList.length ? (
          <ol className="space-y-3" data-testid="instruction-responses">
            {instruction.responseList.map((response) => (
              <li key={response.id} className="border-l-2 pl-3 text-sm">
                <p className="font-medium">
                  {t("instructions.detail.responseLine", {
                    kind: t(`responseKinds.${response.kind}`),
                    name: response.recordedBy.displayName,
                    date: formatDateTime(response.recordedAt),
                  })}
                </p>
                {response.fromStatus !== response.toStatus ? (
                  <p className="text-xs text-muted-foreground">
                    {t("instructions.detail.move", {
                      from: t(`instructionStatuses.${response.fromStatus}`),
                      to: t(`instructionStatuses.${response.toStatus}`),
                    })}
                  </p>
                ) : null}
                {response.body ? <p className="mt-1 whitespace-pre-line">{response.body}</p> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">{t("instructions.detail.noResponses")}</p>
        )}
      </section>
    </div>
  );
}
