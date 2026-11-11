import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Paperclip } from "lucide-react";
import { instructionsResponseSchema, projectDetailResponseSchema } from "@pm-buddy/validation";
import { BqEyebrow, BqSubnav } from "@/components/bq/bq-subnav";
import { InstructionButton } from "@/components/bq/instruction-dialog";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { formatCalendarDate } from "@/lib/format";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("instructions");
  return { title: t("title") };
}

/** The project's register of Architect's/Engineer's Instructions (D2.3). */
export default async function InstructionsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();
  const path = `/projects/${projectId}/bq/instructions`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [detail, result] = await Promise.all([
    serverApi(`/projects/${projectId}`, projectDetailResponseSchema),
    serverApi(`/projects/${projectId}/bq/instructions`, instructionsResponseSchema),
  ]);
  for (const response of [detail, result]) {
    if (response.ok) continue;
    if (response.status === 401) redirect(signInHref(path));
    if (response.status === 404) notFound();
    if (response.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  if (!detail.ok || !result.ok) return <LiveUnavailable retryHref={path} />;
  const { project } = detail.data;
  const { instructions, permissions } = result.data;
  const t = await getTranslations("instructions");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<BqEyebrow project={project} />}
        title={t("title")}
        description={t("description")}
        actions={permissions.canEdit ? <InstructionButton projectId={project.id} /> : null}
      />
      <BqSubnav projectId={project.id} current="instructions" />
      {instructions.length ? (
        <div className="relative overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[760px] text-sm">
            <caption className="sr-only">{t("title")}</caption>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {t("cols.number")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.issued")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.issuer")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.subject")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.variations")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.status")}
                </th>
                {permissions.canEdit ? (
                  <th scope="col" className="py-2 pr-4 font-medium">
                    <span className="sr-only">{t("cols.actions")}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {instructions.map((instruction) => (
                <tr key={instruction.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-mono font-medium">
                    {instruction.number}
                  </th>
                  <td className="py-2 pr-2 tabular-nums">
                    {formatCalendarDate(instruction.issuedOn)}
                  </td>
                  <td className="py-2 pr-2">
                    {instruction.issuerName}
                    <span className="block text-xs text-muted-foreground">
                      {t(`roles.${instruction.issuerRole}`)}
                    </span>
                  </td>
                  <td className="py-2 pr-2">
                    {instruction.subject}
                    {instruction.description ? (
                      <span className="block text-xs whitespace-pre-line text-muted-foreground">
                        {instruction.description}
                      </span>
                    ) : null}
                    {instruction.attachments.map((attachment) => (
                      <span
                        key={`${attachment.name}-${attachment.reference ?? ""}`}
                        className="mt-1 flex items-center gap-1 text-xs"
                      >
                        <Paperclip className="size-3" aria-hidden />
                        {attachment.name}
                        {attachment.reference ? ` (${attachment.reference})` : ""}
                      </span>
                    ))}
                  </td>
                  <td className="py-2 pr-2 text-xs">
                    {t("variationCounts", {
                      total: instruction.variations.total,
                      approved: instruction.variations.approved,
                      pending: instruction.variations.pending,
                    })}
                  </td>
                  <td className="py-2 pr-2">
                    <StatusBadge tone={instruction.status === "open" ? "info" : "neutral"}>
                      {t(`statuses.${instruction.status}`)}
                    </StatusBadge>
                  </td>
                  {permissions.canEdit ? (
                    <td className="py-2 pr-4">
                      <InstructionButton projectId={project.id} instruction={instruction} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      )}
    </div>
  );
}
