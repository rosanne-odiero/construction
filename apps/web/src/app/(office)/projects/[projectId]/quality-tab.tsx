import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { TriangleAlert } from "lucide-react";
import {
  checklistTemplatesResponseSchema,
  completionResponseSchema,
  cubeSetsQuerySchema,
  cubeSetsResponseSchema,
  inspectionsQuerySchema,
  inspectionsResponseSchema,
  qualitySummaryResponseSchema,
  scheduleResponseSchema,
  sitesResponseSchema,
  slumpTestsResponseSchema,
  snagsQuerySchema,
  snagsResponseSchema,
  wbsResponseSchema,
  type Project,
} from "@pm-buddy/validation";
import { LiveUnavailable } from "@/components/projects/live-state";
import { CompletionPanel } from "@/components/quality/completion-panel";
import { ConcretePanel } from "@/components/quality/concrete-panel";
import { InspectionsPanel } from "@/components/quality/inspections-panel";
import { SnagsPanel } from "@/components/quality/snags-panel";
import { loadLive, serverApi } from "@/lib/server-api";
import { QUALITY_VIEWS, qualityHref, type QualityView } from "@/lib/quality";
import { cn } from "@/lib/utils";

type Params = Record<string, string | string[] | undefined>;
/** One query value; empty form fields (status=&search=) mean "no filter". */
const one = (value: string | string[] | undefined) =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;
/** Only the filters a view understands go to the API (unknown values are dropped, never 400). */
const query = (values: Record<string, string | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  const text = params.toString();
  return text ? `?${text}` : "";
};

/**
 * The project's quality area (D6.1): inspections, concrete tests, snags, and completion with the
 * defects liability period. Lists are searched and paged on the server; record `permissions`
 * decide which actions are offered (the API checks again).
 */
export async function QualityTab({
  project,
  view,
  params,
  canReadSchedule,
  returnTo,
}: {
  project: Project;
  view: QualityView;
  params: Params;
  canReadSchedule: boolean;
  returnTo: string;
}) {
  const t = await getTranslations("quality");
  const base = `/projects/${project.id}/quality`;
  const summary = await loadLive(`${base}/summary`, qualitySummaryResponseSchema, returnTo);
  if (!summary.ok) return <LiveUnavailable retryHref={returnTo} />;
  const counts = summary.data;

  let body: React.ReactNode;
  if (view === "inspections") {
    const filters = inspectionsQuerySchema.safeParse({
      status: one(params["status"]),
      result: one(params["result"]),
      search: one(params["search"]),
      cursor: one(params["cursor"]),
    });
    const values = filters.success ? filters.data : { limit: 30 };
    const [list, sites, wbs] = await Promise.all([
      loadLive(
        `${base}/inspections${query({
          status: values.status,
          result: values.result,
          search: values.search,
          cursor: values.cursor ? String(values.cursor) : undefined,
        })}`,
        inspectionsResponseSchema,
        returnTo,
      ),
      loadLive(`/projects/${project.id}/sites`, sitesResponseSchema, returnTo),
      loadLive(`/projects/${project.id}/wbs`, wbsResponseSchema, returnTo),
    ]);
    if (!list.ok || !sites.ok || !wbs.ok) return <LiveUnavailable retryHref={returnTo} />;
    const canCreate = list.data.permissions.canCreate;
    // Templates and schedule tasks are only needed to start an inspection.
    const [templates, schedule] = canCreate
      ? await Promise.all([
          serverApi("/quality/templates", checklistTemplatesResponseSchema),
          canReadSchedule
            ? serverApi(`/projects/${project.id}/schedule`, scheduleResponseSchema)
            : Promise.resolve(null),
        ])
      : [null, null];
    body = (
      <>
        <InspectionsPanel
          projectId={project.id}
          data={list.data}
          templates={templates?.ok ? templates.data.templates : []}
          sites={sites.data.sites}
          nodes={wbs.data.nodes}
          tasks={
            schedule?.ok
              ? schedule.data.items
                  .filter((item) => item.kind === "task")
                  .map((item) => ({ id: item.id, code: item.code, name: item.name }))
              : []
          }
          filters={{ status: values.status, result: values.result, search: values.search }}
        />
        {list.data.nextCursor || values.cursor ? (
          <nav aria-label={t("inspections.pages")} className="flex flex-wrap gap-4 text-sm">
            {values.cursor ? (
              <Link
                className="underline"
                href={qualityHref(project.id, "inspections", {
                  status: values.status,
                  result: values.result,
                  search: values.search,
                })}
              >
                {t("filters.newest")}
              </Link>
            ) : null}
            {list.data.nextCursor ? (
              <Link
                className="underline"
                href={qualityHref(project.id, "inspections", {
                  status: values.status,
                  result: values.result,
                  search: values.search,
                  cursor: String(list.data.nextCursor),
                })}
              >
                {t("filters.older")}
              </Link>
            ) : null}
          </nav>
        ) : null}
      </>
    );
  } else if (view === "tests") {
    const filters = cubeSetsQuerySchema.safeParse({
      filter: one(params["filter"]),
      cursor: one(params["cursor"]),
    });
    const values = filters.success ? filters.data : { filter: "all" as const, limit: 30 };
    const [cubes, slump, sites] = await Promise.all([
      loadLive(
        `${base}/cubes${query({
          filter: values.filter === "all" ? undefined : values.filter,
          cursor: values.cursor ? String(values.cursor) : undefined,
        })}`,
        cubeSetsResponseSchema,
        returnTo,
      ),
      loadLive(`${base}/slump-tests`, slumpTestsResponseSchema, returnTo),
      loadLive(`/projects/${project.id}/sites`, sitesResponseSchema, returnTo),
    ]);
    if (!cubes.ok || !slump.ok || !sites.ok) return <LiveUnavailable retryHref={returnTo} />;
    body = (
      <ConcretePanel
        projectId={project.id}
        cubes={cubes.data}
        slump={slump.data}
        sites={sites.data.sites}
        filter={values.filter}
      />
    );
  } else if (view === "snags") {
    const filters = snagsQuerySchema.safeParse({
      status: one(params["status"]),
      severity: one(params["severity"]),
      phase: one(params["phase"]),
      search: one(params["search"]),
      cursor: one(params["cursor"]),
    });
    const values = filters.success ? filters.data : { limit: 30 };
    const [list, sites] = await Promise.all([
      loadLive(
        `${base}/snags${query({
          status: values.status,
          severity: values.severity,
          phase: values.phase,
          search: values.search,
          cursor: values.cursor ? String(values.cursor) : undefined,
        })}`,
        snagsResponseSchema,
        returnTo,
      ),
      loadLive(`/projects/${project.id}/sites`, sitesResponseSchema, returnTo),
    ]);
    if (!list.ok || !sites.ok) return <LiveUnavailable retryHref={returnTo} />;
    body = (
      <SnagsPanel
        projectId={project.id}
        data={list.data}
        sites={sites.data.sites}
        filters={{
          status: values.status,
          severity: values.severity,
          phase: values.phase,
          search: values.search,
          cursor: values.cursor ? String(values.cursor) : undefined,
        }}
      />
    );
  } else {
    const completion = await loadLive(`${base}/completion`, completionResponseSchema, returnTo);
    if (!completion.ok) return <LiveUnavailable retryHref={returnTo} />;
    body = <CompletionPanel projectId={project.id} data={completion.data} />;
  }

  const badge: Record<QualityView, { text: string; alert: boolean } | null> = {
    inspections: counts.inspections.submitted
      ? { text: t("subnav.awaiting", { count: counts.inspections.submitted }), alert: false }
      : null,
    tests:
      counts.cubes.overdue + counts.cubes.failed
        ? {
            text: t("subnav.testsAlert", {
              overdue: counts.cubes.overdue,
              failed: counts.cubes.failed,
            }),
            alert: true,
          }
        : null,
    snags:
      counts.snags.open + counts.snags.fixed
        ? {
            text: t("subnav.snagsOpen", { count: counts.snags.open + counts.snags.fixed }),
            alert: counts.snags.openCritical > 0,
          }
        : null,
    completion: counts.completion.dlpEndsOn ? { text: t("subnav.dlpRunning"), alert: false } : null,
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <nav aria-label={t("subnav.label")}>
        <ul className="flex flex-wrap gap-2">
          {QUALITY_VIEWS.map((key) => (
            <li key={key}>
              <Link
                href={qualityHref(project.id, key)}
                aria-current={key === view ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-8 flex-wrap items-center gap-2 rounded-md border px-3 py-1 text-sm font-medium",
                  key === view
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-background hover:bg-accent",
                )}
              >
                {t(`subnav.${key}`)}
                {badge[key] ? (
                  <span className="inline-flex items-center gap-1 text-xs font-normal">
                    {badge[key].alert ? <TriangleAlert className="size-3.5" aria-hidden /> : null}
                    {badge[key].text}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {body}
    </div>
  );
}
