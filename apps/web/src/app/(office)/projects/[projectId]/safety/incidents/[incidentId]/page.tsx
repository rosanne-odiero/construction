import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { incidentDetailResponseSchema, safetyOptionsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveUnavailable } from "@/components/projects/live-state";
import { IncidentDetail } from "@/components/safety/incident-detail";
import { StatusBadge } from "@/components/status-badge";
import { incidentSeverityTone, incidentStatusTone } from "@/lib/safety";
import { serverApi } from "@/lib/server-api";
import { loadSafetyPage, SafetyEyebrow, UUID } from "../../page-shell";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string; incidentId: string }>;
}) {
  const { projectId, incidentId } = await params;
  const t = await getTranslations("safety");
  if (!UUID.test(projectId) || !UUID.test(incidentId)) return { title: t("incidents.title") };
  const detail = await serverApi(
    `/projects/${projectId}/safety/incidents/${incidentId}`,
    incidentDetailResponseSchema,
  );
  return {
    title: detail.ok
      ? `${detail.data.incident.code} ${t(`kind.${detail.data.incident.kind}`)}`
      : t("incidents.title"),
  };
}

/** One incident: investigation, regulator decision, corrective actions and closing (D8.2). */
export default async function IncidentPage({
  params,
}: {
  params: Promise<{ projectId: string; incidentId: string }>;
}) {
  const { projectId, incidentId } = await params;
  if (!UUID.test(projectId) || !UUID.test(incidentId)) notFound();
  const path = `/projects/${projectId}/safety/incidents/${incidentId}`;
  const page = await loadSafetyPage(path, projectId, path, incidentDetailResponseSchema);
  if (!page.ok) return page.element;
  const options = await serverApi(
    `/projects/${projectId}/safety/options`,
    safetyOptionsResponseSchema,
  );
  if (!options.ok) return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("safety");
  const { incident } = page.data;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <SafetyEyebrow
            projectId={projectId}
            code={page.project.project.code}
            view="incidents"
            current={incident.code}
          />
        }
        title={`${t(`kind.${incident.kind}`)}: ${incident.location}`}
        description={incident.siteName}
        actions={
          <span className="flex flex-wrap gap-1">
            <StatusBadge
              tone={incidentSeverityTone[incident.severity]}
              className="h-auto whitespace-normal"
            >
              {t(`severity.${incident.severity}`)}
            </StatusBadge>
            <StatusBadge
              tone={incidentStatusTone[incident.status]}
              className="h-auto whitespace-normal"
            >
              {t(`incidentStatus.${incident.status}`)}
            </StatusBadge>
          </span>
        }
      />
      <IncidentDetail
        key={incident.version}
        projectId={projectId}
        detail={page.data}
        staff={options.data.staff}
      />
    </div>
  );
}
