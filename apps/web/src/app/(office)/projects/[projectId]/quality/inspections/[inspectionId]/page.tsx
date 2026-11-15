import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { inspectionDetailResponseSchema, projectDetailResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { InspectionChecklist } from "@/components/quality/inspection-checklist";
import { StatusBadge } from "@/components/status-badge";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { inspectionTone, qualityHref } from "@/lib/quality";
import { signInHref } from "@/lib/safe-next";
import { requireSession, serverApi } from "@/lib/server-api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string; inspectionId: string }>;
}) {
  const { projectId, inspectionId } = await params;
  const t = await getTranslations("quality");
  if (!UUID.test(projectId) || !UUID.test(inspectionId)) return { title: t("title") };
  const detail = await serverApi(
    `/projects/${projectId}/quality/inspections/${inspectionId}`,
    inspectionDetailResponseSchema,
  );
  return {
    title: detail.ok
      ? `${detail.data.inspection.code} ${detail.data.inspection.template.name}`
      : t("title"),
  };
}

/** One inspection's checklist (D6.1), built for a phone on site. */
export default async function InspectionPage({
  params,
}: {
  params: Promise<{ projectId: string; inspectionId: string }>;
}) {
  const { projectId, inspectionId } = await params;
  if (!UUID.test(projectId) || !UUID.test(inspectionId)) notFound();
  const path = `/projects/${projectId}/quality/inspections/${inspectionId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [project, result] = await Promise.all([
    serverApi(`/projects/${projectId}`, projectDetailResponseSchema),
    serverApi(path, inspectionDetailResponseSchema),
  ]);
  if (!result.ok || !project.ok) {
    const status = result.ok ? (project.ok ? 200 : project.status) : result.status;
    if (status === 401) redirect(signInHref(path));
    if (status === 404 || status === 400) notFound();
    if (status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("quality");
  const { inspection } = result.data;
  const { links } = inspection;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <Link href={`/projects/${projectId}`} className="hover:underline">
              <span className="font-mono">{project.data.project.code}</span>
            </Link>
            <span aria-hidden>/</span>
            <Link href={qualityHref(projectId, "inspections")} className="hover:underline">
              {t("title")}
            </Link>
            <span aria-hidden>/</span>
            <span className="font-mono">{inspection.code}</span>
          </span>
        }
        title={inspection.template.name}
        description={`${inspection.location} · ${inspection.siteName}`}
        actions={
          <span className="flex flex-wrap gap-1">
            <StatusBadge
              tone={inspectionTone[inspection.status]}
              className="h-auto whitespace-normal text-left"
            >
              {t(`inspectionStatus.${inspection.status}`)}
            </StatusBadge>
            {inspection.result ? (
              <StatusBadge
                tone={inspection.result === "pass" ? "success" : "danger"}
                className="h-auto whitespace-normal text-left"
              >
                {t(`inspectionResult.${inspection.result}`)}
              </StatusBadge>
            ) : null}
          </span>
        }
      />
      <dl className="grid gap-3 rounded-md border p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">{t("inspections.inspector")}</dt>
          <dd className="break-words">
            {t(`inspectorType.${inspection.inspectorType}`)}
            {inspection.inspectorName ? `: ${inspection.inspectorName}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("inspections.date")}</dt>
          <dd>{formatCalendarDate(inspection.inspectedOn)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("inspections.template")}</dt>
          <dd className="break-words">
            {t("inspections.templateVersion", {
              name: inspection.template.name,
              version: inspection.template.version,
            })}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("inspections.recordedBy")}</dt>
          <dd>
            {inspection.createdBy.displayName}, {formatDateTime(inspection.createdAt)}
          </dd>
        </div>
        {inspection.signedOffBy && inspection.signedOffAt ? (
          <div>
            <dt className="text-muted-foreground">{t("inspections.signedOffBy")}</dt>
            <dd>
              {inspection.signedOffBy.displayName}, {formatDateTime(inspection.signedOffAt)}
            </dd>
          </div>
        ) : inspection.submittedBy && inspection.submittedAt ? (
          <div>
            <dt className="text-muted-foreground">{t("inspections.submittedBy")}</dt>
            <dd>
              {inspection.submittedBy.displayName}, {formatDateTime(inspection.submittedAt)}
            </dd>
          </div>
        ) : null}
        {links.wbsNode || links.scheduleActivity || links.bqItem ? (
          <div>
            <dt className="text-muted-foreground">{t("inspections.linkedTo")}</dt>
            <dd className="space-y-1 break-words">
              {links.wbsNode ? (
                <span className="block">
                  {t("inspections.wbsLink", { code: links.wbsNode.code, name: links.wbsNode.name })}
                </span>
              ) : null}
              {links.scheduleActivity ? (
                <span className="block">
                  {t("inspections.activityLink", {
                    code: links.scheduleActivity.code ?? "",
                    name: links.scheduleActivity.name,
                  })}
                </span>
              ) : null}
              {links.bqItem ? (
                <span className="block">
                  {t("inspections.bqLink", {
                    reference: links.bqItem.reference ?? "—",
                    description: links.bqItem.description,
                  })}
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}
      </dl>
      {inspection.notes ? (
        <p className="text-sm break-words whitespace-pre-wrap">{inspection.notes}</p>
      ) : null}
      <InspectionChecklist key={inspection.version} projectId={projectId} detail={result.data} />
    </div>
  );
}
