import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import {
  incidentDetailResponseSchema,
  safetyOptionsResponseSchema,
  sitesResponseSchema,
} from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveUnavailable } from "@/components/projects/live-state";
import { IncidentReportForm } from "@/components/safety/incident-report-form";
import { formatTime } from "@/lib/format";
import { calendarInput } from "@/lib/project-input";
import { serverApi } from "@/lib/server-api";
import { loadSafetyPage, SafetyEyebrow, UUID } from "../../page-shell";

export async function generateMetadata() {
  const t = await getTranslations("safety");
  return { title: t("report.title") };
}

/** Report an incident or near miss (D8.2), laid out for a phone on site. */
export default async function ReportIncidentPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();
  const { followUp } = await searchParams;
  const path = `/projects/${projectId}/safety/incidents/new`;
  const page = await loadSafetyPage(
    path,
    projectId,
    `/projects/${projectId}/safety/options`,
    safetyOptionsResponseSchema,
  );
  if (!page.ok) return page.element;
  const [sites, original] = await Promise.all([
    serverApi(`/projects/${projectId}/sites`, sitesResponseSchema),
    typeof followUp === "string" && UUID.test(followUp)
      ? serverApi(
          `/projects/${projectId}/safety/incidents/${followUp}`,
          incidentDetailResponseSchema,
        )
      : Promise.resolve(null),
  ]);
  if (!sites.ok) return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("safety");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <SafetyEyebrow projectId={projectId} code={page.project.project.code} view="incidents" />
        }
        title={t("report.title")}
        description={t("report.hint")}
      />
      <IncidentReportForm
        projectId={projectId}
        sites={sites.data.sites}
        staff={page.data.staff}
        today={calendarInput(nairobiDate())}
        now={formatTime(new Date())}
        followUp={
          original?.ok && original.data.incident.status === "closed"
            ? { id: original.data.incident.id, code: original.data.incident.code }
            : null
        }
      />
    </div>
  );
}
