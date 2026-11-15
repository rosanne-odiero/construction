import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { TriangleAlert } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import {
  correctiveActionsQuerySchema,
  correctiveActionsResponseSchema,
  firstAidQuerySchema,
  firstAidResponseSchema,
  incidentsQuerySchema,
  incidentsResponseSchema,
  inductionsResponseSchema,
  inductionStatusQuerySchema,
  inductionStatusResponseSchema,
  ppeIssuesResponseSchema,
  ppeQuerySchema,
  safetyOptionsResponseSchema,
  safetySummaryResponseSchema,
  sitesResponseSchema,
  toolboxTalksQuerySchema,
  toolboxTalksResponseSchema,
  type Project,
} from "@pm-buddy/validation";
import { LiveUnavailable } from "@/components/projects/live-state";
import { ActionsPanel } from "@/components/safety/actions-panel";
import { FirstAidPanel } from "@/components/safety/first-aid-panel";
import { IncidentsPanel } from "@/components/safety/incidents-panel";
import { InductionsPanel } from "@/components/safety/inductions-panel";
import { PpePanel } from "@/components/safety/ppe-panel";
import { TalksPanel } from "@/components/safety/talks";
import { formatTime } from "@/lib/format";
import { calendarInput } from "@/lib/project-input";
import { loadLive } from "@/lib/server-api";
import { SAFETY_VIEWS, safetyHref, type SafetyView } from "@/lib/safety";
import { cn } from "@/lib/utils";

type Params = Record<string, string | string[] | undefined>;
/** One query value; empty form fields (status=&search=) mean "no filter". */
const one = (value: string | string[] | undefined) =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;
/** Only the filters a view understands go to the API (unknown values are dropped, never 400). */
const query = (values: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== "") params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
};

/**
 * The project's health and safety area (D8.2): incidents, corrective actions (overdue first),
 * inductions with attendance flags, toolbox talks, the PPE register and first aid. Lists are
 * searched and paged on the server; record `permissions` decide which actions are offered.
 */
export async function SafetyTab({
  project,
  view,
  params,
  userId,
  returnTo,
}: {
  project: Project;
  view: SafetyView;
  params: Params;
  userId: string;
  returnTo: string;
}) {
  const t = await getTranslations("safety");
  const base = `/projects/${project.id}/safety`;
  const [summary, sites] = await Promise.all([
    loadLive(`${base}/summary`, safetySummaryResponseSchema, returnTo),
    loadLive(`/projects/${project.id}/sites`, sitesResponseSchema, returnTo),
  ]);
  if (!summary.ok || !sites.ok) return <LiveUnavailable retryHref={returnTo} />;
  const counts = summary.data;
  const today = calendarInput(nairobiDate());
  const now = formatTime(new Date());

  let body: React.ReactNode;
  if (view === "incidents") {
    const filters = incidentsQuerySchema.safeParse({
      status: one(params["status"]),
      kind: one(params["kind"]),
      siteId: one(params["siteId"]),
      search: one(params["search"]),
      cursor: one(params["cursor"]),
    });
    const values = filters.success ? filters.data : { limit: 30 };
    const list = await loadLive(
      `${base}/incidents${query({
        status: values.status,
        kind: values.kind,
        siteId: values.siteId,
        search: values.search,
        cursor: values.cursor,
      })}`,
      incidentsResponseSchema,
      returnTo,
    );
    if (!list.ok) return <LiveUnavailable retryHref={returnTo} />;
    body = (
      <IncidentsPanel
        projectId={project.id}
        data={list.data}
        sites={sites.data.sites}
        filters={{
          status: values.status,
          kind: values.kind,
          siteId: values.siteId,
          search: values.search,
          cursor: values.cursor ? String(values.cursor) : undefined,
        }}
      />
    );
  } else if (view === "actions") {
    const filters = correctiveActionsQuerySchema.safeParse({
      status: one(params["status"]),
      mine: one(params["mine"]),
      search: one(params["search"]),
      cursor: one(params["cursor"]),
    });
    const values = filters.success ? filters.data : { limit: 30 };
    const [list, options] = await Promise.all([
      loadLive(
        `${base}/corrective-actions${query({
          status: values.status,
          mine: values.mine,
          search: values.search,
          cursor: values.cursor,
        })}`,
        correctiveActionsResponseSchema,
        returnTo,
      ),
      loadLive(`${base}/options`, safetyOptionsResponseSchema, returnTo),
    ]);
    if (!list.ok || !options.ok) return <LiveUnavailable retryHref={returnTo} />;
    body = (
      <ActionsPanel
        projectId={project.id}
        data={list.data}
        staff={options.data.staff}
        filters={{
          status: values.status,
          mine: values.mine,
          search: values.search,
          cursor: values.cursor !== undefined ? String(values.cursor) : undefined,
        }}
      />
    );
  } else if (view === "inductions") {
    const siteId = one(params["siteId"]) ?? sites.data.sites[0]?.id;
    if (!siteId) body = <p className="text-sm text-muted-foreground">{t("inductions.noRows")}</p>;
    else {
      const filters = inductionStatusQuerySchema.safeParse({
        siteId,
        filter: one(params["filter"]),
        search: one(params["search"]),
        cursor: one(params["cursor"]),
      });
      const values = filters.success ? filters.data : { siteId, filter: "all" as const, limit: 50 };
      const recent = Number(one(params["recent"]) ?? "0");
      const [status, inductions, options] = await Promise.all([
        loadLive(
          `${base}/induction-status${query({
            siteId: values.siteId,
            filter: values.filter === "all" ? undefined : values.filter,
            search: values.search,
            cursor: values.cursor,
          })}`,
          inductionStatusResponseSchema,
          returnTo,
        ),
        loadLive(
          `${base}/inductions${query({
            siteId: values.siteId,
            limit: 20,
            cursor: Number.isInteger(recent) && recent > 0 ? recent : undefined,
          })}`,
          inductionsResponseSchema,
          returnTo,
        ),
        loadLive(`${base}/options`, safetyOptionsResponseSchema, returnTo),
      ]);
      if (!status.ok || !inductions.ok || !options.ok)
        return <LiveUnavailable retryHref={returnTo} />;
      body = (
        <InductionsPanel
          projectId={project.id}
          sites={sites.data.sites}
          status={status.data}
          inductions={inductions.data}
          options={options.data}
          filters={{
            siteId: values.siteId,
            filter: values.filter,
            search: values.search,
            cursor: values.cursor !== undefined ? String(values.cursor) : undefined,
            recent: recent > 0 ? String(recent) : undefined,
          }}
          today={today}
          userId={userId}
        />
      );
    }
  } else if (view === "talks") {
    const filters = toolboxTalksQuerySchema.safeParse({
      search: one(params["search"]),
      cursor: one(params["cursor"]),
    });
    const values = filters.success ? filters.data : { limit: 30 };
    const list = await loadLive(
      `${base}/talks${query({ search: values.search, cursor: values.cursor })}`,
      toolboxTalksResponseSchema,
      returnTo,
    );
    if (!list.ok) return <LiveUnavailable retryHref={returnTo} />;
    body = (
      <TalksPanel
        projectId={project.id}
        data={list.data}
        filters={{
          search: values.search,
          cursor: values.cursor ? String(values.cursor) : undefined,
        }}
      />
    );
  } else if (view === "ppe") {
    const filters = ppeQuerySchema.safeParse({
      siteId: one(params["siteId"]),
      item: one(params["item"]),
      status: one(params["status"]),
      search: one(params["search"]),
      cursor: one(params["cursor"]),
    });
    const values = filters.success ? filters.data : { limit: 30 };
    const list = await loadLive(
      `${base}/ppe${query({
        siteId: values.siteId,
        item: values.item,
        status: values.status,
        search: values.search,
        cursor: values.cursor,
      })}`,
      ppeIssuesResponseSchema,
      returnTo,
    );
    if (!list.ok) return <LiveUnavailable retryHref={returnTo} />;
    body = (
      <PpePanel
        projectId={project.id}
        data={list.data}
        sites={sites.data.sites}
        filters={{
          siteId: values.siteId,
          item: values.item,
          status: values.status,
          search: values.search,
          cursor: values.cursor !== undefined ? String(values.cursor) : undefined,
        }}
        today={today}
      />
    );
  } else {
    const filters = firstAidQuerySchema.safeParse({ cursor: one(params["cursor"]) });
    const values = filters.success ? filters.data : { limit: 30 };
    const [data, options, open] = await Promise.all([
      loadLive(
        `${base}/first-aid${query({ cursor: values.cursor })}`,
        firstAidResponseSchema,
        returnTo,
      ),
      loadLive(`${base}/options`, safetyOptionsResponseSchema, returnTo),
      loadLive(`${base}/incidents?status=open&limit=100`, incidentsResponseSchema, returnTo),
    ]);
    if (!data.ok || !options.ok || !open.ok) return <LiveUnavailable retryHref={returnTo} />;
    body = (
      <FirstAidPanel
        projectId={project.id}
        data={data.data}
        sites={sites.data.sites}
        staff={options.data.staff}
        openIncidents={open.data.incidents.map((incident) => ({
          id: incident.id,
          code: incident.code,
          siteId: incident.siteId,
        }))}
        today={today}
        now={now}
        cursor={values.cursor ? String(values.cursor) : undefined}
      />
    );
  }

  const open = counts.incidents.reported + counts.incidents.investigated;
  const badge: Record<SafetyView, { text: string; alert: boolean } | null> = {
    incidents: open ? { text: t("subnav.open", { count: open }), alert: false } : null,
    actions: counts.actions.overdue
      ? { text: t("subnav.overdue", { count: counts.actions.overdue }), alert: true }
      : null,
    inductions: counts.inductions.flagged
      ? { text: t("subnav.flagged", { count: counts.inductions.flagged }), alert: true }
      : null,
    talks: counts.talks.draft
      ? { text: t("subnav.drafts", { count: counts.talks.draft }), alert: false }
      : null,
    ppe: counts.ppe.due ? { text: t("subnav.due", { count: counts.ppe.due }), alert: true } : null,
    "first-aid": counts.firstAid.kitsAttention
      ? { text: t("subnav.attention", { count: counts.firstAid.kitsAttention }), alert: true }
      : null,
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <nav aria-label={t("subnav.label")}>
        <ul className="flex flex-wrap gap-2">
          {SAFETY_VIEWS.map((key) => (
            <li key={key}>
              <Link
                href={safetyHref(project.id, key)}
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
      <p className="text-xs text-muted-foreground">{t("complianceNote")}</p>
    </div>
  );
}
