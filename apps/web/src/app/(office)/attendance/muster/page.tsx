import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addCalendarDays } from "@pm-buddy/domain";
import { attendanceOverviewResponseSchema, musterResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { AttendanceNav } from "@/components/attendance/attendance-nav";
import { MusterRoll } from "@/components/attendance/muster-roll";
import { selectClass } from "@/components/labour/action-dialog";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dateParam, musterHref, uuidParam } from "@/lib/attendance";
import { formatCalendarDate } from "@/lib/format";
import { calendarInput } from "@/lib/project-input";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("attendanceLive.muster");
  return { title: t("title") };
}

/**
 * Daily muster roll (D3.3 web slice): one project, site and date, optionally one gang. The filter
 * is a plain GET form (works without JavaScript); the roll itself is edited in MusterRoll.
 */
export default async function MusterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const projectParam = uuidParam(raw.project);
  const siteParam = uuidParam(raw.site);
  const gang = uuidParam(raw.gang);
  const typedDate = dateParam(raw.date);
  const path = projectParam
    ? musterHref({ project: projectParam, site: siteParam, date: typedDate, gang })
    : "/attendance/muster";

  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const overview = await loadLive("/attendance/overview", attendanceOverviewResponseSchema, path);
  if (!overview.ok)
    return overview.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("attendanceLive");
  const { projects, today } = overview.data;
  const project = projectParam
    ? projects.find((entry) => entry.id === projectParam)
    : (projects.find((entry) => entry.canRecord) ?? projects[0]);
  if (!project) {
    if (projectParam) return <LiveForbidden />;
    return (
      <div className="space-y-6">
        <PageHeader title={t("muster.title")} />
        <AttendanceNav current="muster" />
        <p
          role="status"
          className="rounded-lg border p-6 text-center text-sm text-muted-foreground"
        >
          {t("overview.none")}
        </p>
      </div>
    );
  }
  const site = project.sites.find((entry) => entry.id === siteParam) ?? project.sites[0];
  if (!site)
    return (
      <div className="space-y-6">
        <PageHeader title={t("muster.title")} />
        <AttendanceNav current="muster" project={project.id} />
        <p
          role="status"
          className="rounded-lg border p-6 text-center text-sm text-muted-foreground"
        >
          {t("overview.noSites")}
        </p>
      </div>
    );
  const date = typedDate ?? today;
  // A DD/MM/YYYY date typed into the form, an invalid date or a missing site becomes the
  // canonical address (ISO date, explicit site).
  if (!projectParam || siteParam !== site.id || (raw.date !== undefined && raw.date !== date))
    redirect(musterHref({ project: project.id, site: site.id, date, gang }));

  const query = new URLSearchParams({ siteId: site.id, date });
  if (gang) query.set("gangId", gang);
  const muster = await loadLive(
    `/attendance/projects/${project.id}/muster?${query.toString()}`,
    musterResponseSchema,
    path,
  );
  if (!muster.ok)
    return muster.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const data = muster.data;
  const previous = addCalendarDays(date, -1);
  const next = addCalendarDays(date, 1);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{t("live")}</StatusBadge>}
        title={t("muster.title")}
        description={t("muster.description", {
          project: `${data.project.code} ${data.project.name}`,
          site: data.site.name,
          date: formatCalendarDate(data.date),
        })}
      />
      <AttendanceNav current="muster" project={project.id} />

      <form
        method="get"
        action="/attendance/muster"
        aria-label={t("muster.filters")}
        className="flex flex-wrap items-end gap-3 rounded-lg border p-3"
      >
        <div className="space-y-1.5">
          <label htmlFor="muster-project" className="block text-sm font-medium">
            {t("common.project")}
          </label>
          <select
            id="muster-project"
            name="project"
            defaultValue={project.id}
            className={selectClass}
          >
            {projects.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.code} · {entry.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="muster-site" className="block text-sm font-medium">
            {t("common.site")}
          </label>
          <select id="muster-site" name="site" defaultValue={site.id} className={selectClass}>
            {data.sites.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="muster-date" className="block text-sm font-medium">
            {t("common.date")}
          </label>
          <Input
            id="muster-date"
            name="date"
            defaultValue={calendarInput(date)}
            placeholder="DD/MM/YYYY"
            inputMode="numeric"
            className="w-36 tabular-nums"
            aria-describedby="muster-date-hint"
          />
          <span id="muster-date-hint" className="sr-only">
            {t("common.dateHint")}
          </span>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="muster-gang" className="block text-sm font-medium">
            {t("common.gang")}
          </label>
          <select id="muster-gang" name="gang" defaultValue={gang ?? ""} className={selectClass}>
            <option value="">{t("common.allGangs")}</option>
            {data.gangs.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline">
          {t("common.show")}
        </Button>
        <div className="flex gap-1 sm:ml-auto">
          <Button asChild variant="ghost" size="sm">
            <Link href={musterHref({ project: project.id, site: site.id, date: previous, gang })}>
              <ChevronLeft aria-hidden /> {t("muster.previousDay")}
            </Link>
          </Button>
          {next <= today ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={musterHref({ project: project.id, site: site.id, date: next, gang })}>
                {t("muster.nextDay")} <ChevronRight aria-hidden />
              </Link>
            </Button>
          ) : null}
        </div>
      </form>

      <MusterRoll key={`${data.site.id}:${data.date}:${data.gangId ?? ""}`} muster={data} />
    </div>
  );
}
