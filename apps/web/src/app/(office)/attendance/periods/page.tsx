import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { attendanceOverviewResponseSchema, periodsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { AttendanceNav } from "@/components/attendance/attendance-nav";
import { PeriodStatusBadge } from "@/components/attendance/attendance-badges";
import { selectClass } from "@/components/labour/action-dialog";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { uuidParam } from "@/lib/attendance";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("attendanceLive.periods");
  return { title: t("title") };
}

/** Weekly timesheet periods of one project (D3.3 web slice), newest first. */
export default async function PeriodsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const projectParam = uuidParam(raw.project);
  const path = projectParam ? `/attendance/periods?project=${projectParam}` : "/attendance/periods";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("attendanceLive");
  const overview = await loadLive("/attendance/overview", attendanceOverviewResponseSchema, path);
  if (!overview.ok)
    return overview.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const projects = overview.data.projects;
  if (!projectParam) {
    const first = projects[0];
    if (first) redirect(`/attendance/periods?project=${first.id}`);
    return (
      <div className="space-y-6">
        <PageHeader title={t("periods.title")} />
        <AttendanceNav current="periods" />
        <p
          role="status"
          className="rounded-lg border p-6 text-center text-sm text-muted-foreground"
        >
          {t("overview.none")}
        </p>
      </div>
    );
  }
  const result = await loadLive(
    `/attendance/projects/${projectParam}/periods`,
    periodsResponseSchema,
    path,
  );
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const { project, periods, settings, pendingAdjustments } = result.data;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{t("live")}</StatusBadge>}
        title={t("periods.title")}
        description={t("periods.description", {
          project: `${project.code} ${project.name}`,
          weekEnd: t(`weekdays.d${settings.weekEndsOn}`),
          cutoff: settings.cutoffTime,
          payday: t(`weekdays.d${settings.paydayWeekday}`),
        })}
      />
      <AttendanceNav current="periods" project={project.id} />

      <form
        method="get"
        action="/attendance/periods"
        aria-label={t("periods.filter")}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="space-y-1.5">
          <label htmlFor="periods-project" className="block text-sm font-medium">
            {t("common.project")}
          </label>
          <select
            id="periods-project"
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
        <Button type="submit" variant="outline">
          {t("common.show")}
        </Button>
      </form>

      {pendingAdjustments > 0 ? (
        <p role="note" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          {t("periods.pendingAdjustments", { count: pendingAdjustments })}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableCaption className="sr-only">
            {t("periods.caption", { project: project.name })}
          </TableCaption>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>{t("periods.columns.period")}</TableHead>
              <TableHead>{t("periods.columns.status")}</TableHead>
              <TableHead className="text-right">{t("periods.columns.days")}</TableHead>
              <TableHead className="text-right">{t("periods.columns.unconfirmed")}</TableHead>
              <TableHead className="text-right">{t("periods.columns.anomalies")}</TableHead>
              <TableHead className="text-right">{t("periods.columns.labourers")}</TableHead>
              <TableHead>{t("periods.columns.cutoff")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {periods.map(({ period, days, unconfirmedDays, openAnomalies, labourers }) => (
              <TableRow key={period.id}>
                <TableCell>
                  <Link
                    href={`/attendance/periods/${period.id}`}
                    className="font-medium tabular-nums hover:underline"
                  >
                    {formatCalendarDate(period.startDate)} – {formatCalendarDate(period.endDate)}
                  </Link>
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-1">
                    <PeriodStatusBadge status={period.status} />
                    {period.status === "open" && period.due ? (
                      <StatusBadge tone="warning">{t("periods.due")}</StatusBadge>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{days}</TableCell>
                <TableCell className="text-right tabular-nums">{unconfirmedDays}</TableCell>
                <TableCell className="text-right tabular-nums">{openAnomalies}</TableCell>
                <TableCell className="text-right tabular-nums">{labourers}</TableCell>
                <TableCell className="text-sm tabular-nums">
                  {formatDateTime(period.cutoffAt)}
                </TableCell>
              </TableRow>
            ))}
            {periods.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  {t("periods.none")}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
