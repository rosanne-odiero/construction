import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import {
  attendanceOverviewResponseSchema,
  periodDetailResponseSchema,
  type TimesheetTotalsWire,
} from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { AttendanceNav } from "@/components/attendance/attendance-nav";
import { PeriodStatusBadge } from "@/components/attendance/attendance-badges";
import { PeriodActions } from "@/components/attendance/period-actions";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { hours, musterHref } from "@/lib/attendance";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { loadLive, requireSession, serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("attendanceLive.period");
  return { title: t("title") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One timesheet period (D3.3 web slice): per-labourer totals (live while open, the immutable
 * snapshot once approved), the blockers before submission, submit/approve/reject/reopen with a
 * distinct approver, and adjustments to approved periods.
 */
export default async function PeriodPage({ params }: { params: Promise<{ periodId: string }> }) {
  const { periodId } = await params;
  const path = `/attendance/periods/${periodId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  if (!UUID.test(periodId)) notFound();
  const result = await loadLive(
    `/attendance/periods/${periodId}`,
    periodDetailResponseSchema,
    path,
  );
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const data = result.data;
  const overview = await serverApi("/attendance/overview", attendanceOverviewResponseSchema);
  const sites = overview.ok
    ? (overview.data.projects.find((entry) => entry.id === data.project.id)?.sites ?? [])
    : [];
  const t = await getTranslations("attendanceLive");
  const locale = await getLocale();
  const { period, blockers } = data;
  const editable = period.status === "open" || period.status === "rejected";
  const blockerItems = [
    blockers.notDue
      ? t("period.blockers.notDue", { cutoff: formatDateTime(period.cutoffAt) })
      : null,
    blockers.openAnomalies
      ? t("period.blockers.openAnomalies", { count: blockers.openAnomalies })
      : null,
    blockers.pendingCorrections
      ? t("period.blockers.pendingCorrections", { count: blockers.pendingCorrections })
      : null,
    blockers.missingRuleDates.length
      ? t("period.blockers.missingRules", {
          dates: blockers.missingRuleDates.map(formatCalendarDate).join(", "),
        })
      : null,
  ].filter((item): item is string => item !== null);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{t("live")}</StatusBadge>}
        title={t("period.heading", {
          start: formatCalendarDate(period.startDate),
          end: formatCalendarDate(period.endDate),
        })}
        description={t("period.description", {
          project: `${data.project.code} ${data.project.name}`,
          cutoff: formatDateTime(period.cutoffAt),
        })}
      />
      <AttendanceNav current="periods" project={data.project.id} />

      <section
        aria-label={t("period.state")}
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-3 text-sm"
      >
        <PeriodStatusBadge status={period.status} />
        <StatusBadge tone={data.source === "snapshot" ? "success" : "neutral"}>
          {t(`period.source.${data.source}`)}
        </StatusBadge>
        {period.submittedBy ? (
          <span className="text-muted-foreground">
            {t("period.submittedBy", {
              name: period.submittedBy.displayName,
              at: formatDateTime(period.submittedAt ?? ""),
            })}
          </span>
        ) : null}
        {period.approvedBy ? (
          <span className="text-muted-foreground">
            {t("period.approvedBy", {
              name: period.approvedBy.displayName,
              at: formatDateTime(period.approvedAt ?? ""),
            })}
          </span>
        ) : null}
      </section>
      {period.status === "rejected" && period.rejectionReason ? (
        <p
          role="note"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          {t("period.rejected", {
            name: period.rejectedBy?.displayName ?? "—",
            reason: period.rejectionReason,
          })}
        </p>
      ) : null}
      {blockers.rulesUnverified ? (
        <p role="note" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          {t("period.rulesUnverified")}
        </p>
      ) : null}

      {editable && (blockerItems.length > 0 || blockers.unconfirmedDays.length > 0) ? (
        <section aria-labelledby="blockers-heading" className="space-y-2 rounded-lg border p-3">
          <h2 id="blockers-heading" className="text-base font-semibold">
            {t("period.blockers.title")}
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {blockerItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
            {blockers.unconfirmedDays.map((day) => (
              <li key={day.dayId}>
                <Link
                  href={musterHref({ project: data.project.id, site: day.siteId, date: day.date })}
                  className="underline underline-offset-4"
                >
                  {t("period.blockers.unconfirmedDay", {
                    site: day.siteName,
                    date: formatCalendarDate(day.date),
                    status: t(`dayStatus.${day.status}`),
                  })}
                </Link>
              </li>
            ))}
          </ul>
          {blockers.openAnomalies ? (
            <Link
              href={`/attendance/anomalies?project=${data.project.id}&from=${period.startDate}&to=${period.endDate}`}
              className="text-sm underline underline-offset-4"
            >
              {t("period.blockers.reviewAnomalies")}
            </Link>
          ) : null}
        </section>
      ) : null}

      <PeriodActions period={data} sites={sites} />

      <section aria-labelledby="lines-heading" className="space-y-2">
        <h2 id="lines-heading" className="text-base font-semibold">
          {t("period.lines.title")}
        </h2>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableCaption className="sr-only">{t("period.lines.caption")}</TableCaption>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>{t("period.lines.worker")}</TableHead>
                <TableHead className="text-right">{t("period.lines.days")}</TableHead>
                <TableHead className="text-right">{t("period.lines.worked")}</TableHead>
                <TableHead className="text-right">{t("period.lines.normal")}</TableHead>
                <TableHead className="text-right">{t("period.lines.otWeekday")}</TableHead>
                <TableHead className="text-right">{t("period.lines.otRestDay")}</TableHead>
                <TableHead className="text-right">{t("period.lines.otHoliday")}</TableHead>
                <TableHead className="text-right">{t("period.lines.late")}</TableHead>
                <TableHead className="text-right">{t("period.lines.absences")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.lines.map((line) => (
                <TableRow key={`${line.labourerId}:${line.adjustmentId ?? "attendance"}`}>
                  <TableCell>
                    <Link
                      href={`/labour?worker=${line.labourerId}`}
                      className="font-medium hover:underline"
                    >
                      {line.fullName}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      <span className="font-mono">{line.workerNo}</span>
                      {line.kind === "adjustment" ? ` · ${t("period.lines.adjustment")}` : null}
                    </span>
                  </TableCell>
                  <TotalsCells totals={line.totals} />
                </TableRow>
              ))}
              {data.lines.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    {t("period.lines.none")}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
            {data.lines.length > 0 ? (
              <TableFooter>
                <TableRow>
                  <TableHead scope="row">{t("period.lines.total")}</TableHead>
                  <TotalsCells totals={data.totals} />
                </TableRow>
              </TableFooter>
            ) : null}
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">{t("period.lines.note")}</p>
      </section>

      {data.rules.length > 0 ? (
        <section aria-labelledby="rules-heading" className="space-y-2">
          <h2 id="rules-heading" className="text-base font-semibold">
            {t("period.rules")}
          </h2>
          <ul className="space-y-1 text-sm">
            {data.rules.map((rule) => (
              <li key={rule.id}>
                {t("period.ruleLine", {
                  scope: rule.projectCode ?? t("settings.rules.company"),
                  from: formatCalendarDate(rule.effectiveFrom),
                  normal: hours(rule.normalMinutes),
                  weekday: rule.otWeekdayMultiplier,
                  rest: rule.otRestDayMultiplier,
                  holiday: rule.otHolidayMultiplier,
                })}{" "}
                <StatusBadge tone={rule.complianceStatus === "approved" ? "success" : "warning"}>
                  {t(`compliance.${rule.complianceStatus}`)}
                </StatusBadge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {data.holidays.length > 0 ? (
        <section aria-labelledby="holidays-heading" className="space-y-2">
          <h2 id="holidays-heading" className="text-base font-semibold">
            {t("period.holidays")}
          </h2>
          <ul className="space-y-1 text-sm">
            {data.holidays.map((holiday) => (
              <li key={holiday.date}>
                <span className="tabular-nums">{formatCalendarDate(holiday.date)}</span> —{" "}
                {locale === "sw" ? holiday.nameSw : holiday.nameEn}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function TotalsCells({ totals }: { totals: TimesheetTotalsWire }) {
  const absences =
    totals.statusCounts.absent + totals.statusCounts.leave + totals.statusCounts.sick;
  return (
    <>
      <TableCell className="text-right tabular-nums">{totals.days}</TableCell>
      <TableCell className="text-right tabular-nums">{hours(totals.workedMinutes)}</TableCell>
      <TableCell className="text-right tabular-nums">{hours(totals.normalMinutes)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {hours(totals.overtimeMinutes.weekday)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {hours(totals.overtimeMinutes.rest_day)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {hours(totals.overtimeMinutes.public_holiday)}
      </TableCell>
      <TableCell className="text-right tabular-nums">{hours(totals.lateMinutes)}</TableCell>
      <TableCell className="text-right tabular-nums">{absences}</TableCell>
    </>
  );
}
