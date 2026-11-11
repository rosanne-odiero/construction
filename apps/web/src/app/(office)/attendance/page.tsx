import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { attendanceOverviewResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { AttendanceNav } from "@/components/attendance/attendance-nav";
import { DayStatusBadge, PeriodStatusBadge } from "@/components/attendance/attendance-badges";
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
import { musterHref } from "@/lib/attendance";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("attendanceLive");
  return { title: t("title") };
}

/**
 * Attendance overview (D3.3 web slice): each project the caller may view with today's muster roll
 * per site, the current timesheet period and the review queues (anomalies, corrections,
 * adjustments, periods awaiting approval).
 */
export default async function AttendanceOverviewPage() {
  const path = "/attendance";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive("/attendance/overview", attendanceOverviewResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const { projects, today } = result.data;
  const t = await getTranslations("attendanceLive");
  const openAnomalies = projects.reduce((sum, project) => sum + project.openAnomalies, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{t("live")}</StatusBadge>}
        title={t("title")}
        description={t("description", {
          company: session.company.name,
          today: formatCalendarDate(today),
        })}
      />
      <AttendanceNav current="overview" anomalies={openAnomalies} />

      {projects.length === 0 ? (
        <p
          role="status"
          className="rounded-lg border p-6 text-center text-sm text-muted-foreground"
        >
          {t("overview.none")}
        </p>
      ) : null}

      {projects.map((project) => {
        const queues = [
          {
            key: "anomalies",
            count: project.openAnomalies,
            href: `/attendance/anomalies?project=${project.id}`,
          },
          {
            key: "corrections",
            count: project.pendingCorrections,
            href: `/attendance/anomalies?project=${project.id}#corrections`,
          },
          {
            key: "adjustments",
            count: project.pendingAdjustments,
            href: `/attendance/periods?project=${project.id}`,
          },
          {
            key: "awaiting",
            count: project.periodsAwaitingApproval,
            href: `/attendance/periods?project=${project.id}`,
          },
        ] as const;
        const period = project.currentPeriod;
        return (
          <section
            key={project.id}
            aria-labelledby={`project-${project.id}`}
            className="space-y-4 rounded-xl border p-4"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id={`project-${project.id}`} className="text-lg font-semibold">
                <span className="font-mono text-sm text-muted-foreground">{project.code}</span>{" "}
                {project.name}
              </h2>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link href={`/attendance/periods?project=${project.id}`}>
                    {t("overview.timesheets")}
                  </Link>
                </Button>
              </div>
            </div>

            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              {queues.map((queue) => (
                <div key={queue.key} className="rounded-lg border p-3">
                  <dt className="text-muted-foreground">{t(`overview.queues.${queue.key}`)}</dt>
                  <dd className="text-xl font-semibold tabular-nums">
                    {queue.count > 0 ? (
                      <Link href={queue.href} className="hover:underline">
                        {queue.count}
                      </Link>
                    ) : (
                      0
                    )}
                  </dd>
                </div>
              ))}
            </dl>

            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t("overview.currentPeriod")}</span>
              <span className="tabular-nums">
                {formatCalendarDate(period.startDate)} – {formatCalendarDate(period.endDate)}
              </span>
              <PeriodStatusBadge status={period.status} />
              <span className="text-muted-foreground">
                {t("overview.cutoff", { cutoff: formatDateTime(period.cutoffAt) })}
              </span>
            </p>

            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableCaption className="sr-only">
                  {t("overview.sitesCaption", { project: project.name })}
                </TableCaption>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead>{t("overview.columns.site")}</TableHead>
                    <TableHead>{t("overview.columns.today")}</TableHead>
                    <TableHead className="text-right">{t("overview.columns.records")}</TableHead>
                    <TableHead>
                      <span className="sr-only">{t("overview.columns.actions")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {project.sites.map((site) => (
                    <TableRow key={site.id}>
                      <TableCell className="font-medium">{site.name}</TableCell>
                      <TableCell>
                        <DayStatusBadge status={site.today.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {site.today.records}
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          href={musterHref({ project: project.id, site: site.id, date: today })}
                          className="text-sm font-medium underline-offset-4 hover:underline"
                        >
                          {project.canRecord && site.today.status !== "confirmed"
                            ? t("overview.record", { site: site.name })
                            : t("overview.open", { site: site.name })}
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                  {project.sites.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="py-6 text-center text-sm text-muted-foreground"
                      >
                        {t("overview.noSites")}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
          </section>
        );
      })}

      <p className="text-sm text-muted-foreground">
        <Link href="/prototype/attendance" className="underline underline-offset-4">
          {t("prototypeLink")}
        </Link>
      </p>
    </div>
  );
}
