import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  diariesResponseSchema,
  scheduleBaselinesResponseSchema,
  scheduleDelaysResponseSchema,
  scheduleResponseSchema,
  sitesResponseSchema,
  wbsResponseSchema,
  type Project,
} from "@pm-buddy/validation";
import { LiveUnavailable } from "@/components/projects/live-state";
import { BaselinesPanel } from "@/components/schedule/baselines-panel";
import { DelaysPanel, type DiaryChoice } from "@/components/schedule/delays-panel";
import { ScheduleWorkspace } from "@/components/schedule/schedule-workspace";
import { loadLive, serverApi } from "@/lib/server-api";
import { cn } from "@/lib/utils";

export const SCHEDULE_VIEWS = ["gantt", "baselines", "delays"] as const;
export type ScheduleView = (typeof SCHEDULE_VIEWS)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The project's schedule tab (D6.2): the Gantt view with the activity editor, baselines with
 * variance, and the delay log. Every figure comes from the API (CPM runs there); the record
 * `permissions` decide which actions are offered (the API still checks).
 */
export async function ScheduleTab({
  project,
  view,
  baselineId,
  canPickBq,
  returnTo,
}: {
  project: Project;
  view: ScheduleView;
  baselineId: string | undefined;
  canPickBq: boolean;
  returnTo: string;
}) {
  const t = await getTranslations("schedule");
  const compare = view === "baselines" && baselineId && UUID.test(baselineId) ? baselineId : null;
  const [schedule, wbs] = await Promise.all([
    loadLive(
      `/projects/${project.id}/schedule${compare ? `?baselineId=${compare}` : ""}`,
      scheduleResponseSchema,
      returnTo,
    ),
    loadLive(`/projects/${project.id}/wbs`, wbsResponseSchema, returnTo),
  ]);
  if (!schedule.ok || !wbs.ok) return <LiveUnavailable retryHref={returnTo} />;
  const base = `/projects/${project.id}?tab=schedule`;

  let body: React.ReactNode;
  if (view === "baselines") {
    const baselines = await loadLive(
      `/projects/${project.id}/schedule/baselines`,
      scheduleBaselinesResponseSchema,
      returnTo,
    );
    if (!baselines.ok) return <LiveUnavailable retryHref={returnTo} />;
    body = (
      <BaselinesPanel projectId={project.id} schedule={schedule.data} baselines={baselines.data} />
    );
  } else if (view === "delays") {
    const log = await loadLive(
      `/projects/${project.id}/schedule/delays`,
      scheduleDelaysResponseSchema,
      returnTo,
    );
    if (!log.ok) return <LiveUnavailable retryHref={returnTo} />;
    // Only someone who may record delays needs the diaries to cite; a failure leaves the list empty.
    let diaries: DiaryChoice[] = [];
    if (log.data.permissions.canRecord) {
      const [list, sites] = await Promise.all([
        serverApi(`/projects/${project.id}/diaries?limit=100`, diariesResponseSchema),
        serverApi(`/projects/${project.id}/sites`, sitesResponseSchema),
      ]);
      const names = new Map(sites.ok ? sites.data.sites.map((site) => [site.id, site.name]) : []);
      diaries = list.ok
        ? list.data.diaries.map((diary) => ({
            id: diary.id,
            date: diary.date,
            site: names.get(diary.siteId) ?? "—",
          }))
        : [];
    }
    body = (
      <DelaysPanel
        projectId={project.id}
        log={log.data}
        tasks={schedule.data.items.filter((item) => item.kind === "task")}
        diaries={diaries}
      />
    );
  } else {
    body = (
      <ScheduleWorkspace
        projectId={project.id}
        schedule={schedule.data}
        nodes={wbs.data.nodes}
        canPickBq={canPickBq && schedule.data.permissions.canEdit}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <nav aria-label={t("subnav.label")}>
        <ul className="flex flex-wrap gap-2">
          {SCHEDULE_VIEWS.map((key) => (
            <li key={key}>
              <Link
                href={key === "gantt" ? base : `${base}&view=${key}`}
                aria-current={key === view ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium",
                  key === view
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-background hover:bg-accent",
                )}
              >
                {t(`subnav.${key}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {body}
    </div>
  );
}
