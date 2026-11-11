import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { clientProjectResponseSchema } from "@pm-buddy/validation";
import { LiveUnavailable } from "@/components/projects/live-state";
import { ProjectStatusBadge } from "@/components/projects/project-status-badge";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCalendarDate } from "@/lib/format";
import { loadLive, requirePortal } from "@/lib/server-api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tones: Record<string, Tone> = {
  planned: "neutral",
  in_progress: "info",
  achieved: "success",
  cancelled: "danger",
};

/** A client's view of one project: milestones and approved site diaries. */
export default async function ClientProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();
  const path = `/portal/projects/${projectId}`;
  const session = await requirePortal("client", path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive(
    `/portal/client/projects/${projectId}`,
    clientProjectResponseSchema,
    path,
  );
  // A project the client is not assigned to looks the same as one that does not exist.
  if (!result.ok && result.status === 403) notFound();
  if (!result.ok) return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("portals.client");
  const tStatus = await getTranslations("milestoneStatus");
  const { project, milestones, diaries } = result.data;
  return (
    <div className="space-y-6">
      <Link
        href="/portal"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> {t("back")}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
          <p className="font-mono text-xs text-muted-foreground">{project.code}</p>
        </div>
        <ProjectStatusBadge status={project.status} />
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("milestonesTitle")}</h2>
            </CardTitle>
            <p className="text-sm text-muted-foreground">{t("milestones", project.milestones)}</p>
          </CardHeader>
          <CardContent>
            {milestones.length ? (
              <ol className="space-y-3">
                {milestones.map((milestone) => (
                  <li key={milestone.id} className="flex items-start justify-between gap-3 text-sm">
                    <span>
                      <span className="block font-medium">{milestone.name}</span>
                      <span className="text-muted-foreground">
                        {milestone.actualDate
                          ? t("achievedOn", { date: formatCalendarDate(milestone.actualDate) })
                          : t("dueOn", { date: formatCalendarDate(milestone.dueDate) })}
                      </span>
                    </span>
                    <StatusBadge tone={tones[milestone.status] ?? "neutral"}>
                      {tStatus(milestone.status)}
                    </StatusBadge>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">{t("noMilestones")}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("diariesTitle")}</h2>
            </CardTitle>
            <p className="text-sm text-muted-foreground">{t("diariesDescription")}</p>
          </CardHeader>
          <CardContent>
            {diaries.length ? (
              <ol className="space-y-4">
                {diaries.map((diary) => (
                  <li key={diary.id}>
                    <article
                      aria-label={`${diary.siteName} ${formatCalendarDate(diary.date)}`}
                      className="space-y-2 rounded-md border p-3"
                    >
                      <h3 className="text-sm font-semibold">
                        {formatCalendarDate(diary.date)} · {diary.siteName}
                      </h3>
                      <p className="text-sm break-words whitespace-pre-wrap">
                        {diary.workPerformed}
                      </p>
                      <dl className="grid gap-2 text-xs sm:grid-cols-3">
                        <div>
                          <dt className="text-muted-foreground">{t("workforce")}</dt>
                          <dd>{diary.workforceCount ?? t("notRecorded")}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">{t("weather")}</dt>
                          <dd className="break-words">{diary.weather || t("notRecorded")}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">{t("delays")}</dt>
                          <dd className="break-words whitespace-pre-wrap">
                            {diary.delays || t("notRecorded")}
                          </dd>
                        </div>
                      </dl>
                    </article>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">{t("noDiaries")}</p>
            )}
          </CardContent>
        </Card>
      </div>
      <p className="rounded-md border bg-muted p-3 text-sm">{t("coming")}</p>
    </div>
  );
}
