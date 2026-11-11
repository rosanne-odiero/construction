import Link from "next/link";
import { useTranslations } from "next-intl";
import type { LabourerAttendanceResponse } from "@pm-buddy/validation";
import { hours } from "@/lib/attendance";
import { formatCalendarDate } from "@/lib/format";

/**
 * A labourer's attendance in the worker panel (D3.3): per project, days and hours from approved
 * timesheets and from periods not approved yet, overtime and the last day worked.
 */
export function WorkerAttendance({ summary }: { summary: LabourerAttendanceResponse }) {
  const t = useTranslations("attendanceLive.worker");
  const overtime = (totals: LabourerAttendanceResponse["projects"][number]["approved"]) =>
    totals.overtimeMinutes.weekday +
    totals.overtimeMinutes.rest_day +
    totals.overtimeMinutes.public_holiday;
  return (
    <section aria-labelledby="panel-attendance" className="space-y-2">
      <h3 id="panel-attendance" className="font-semibold">
        {t("title")}
      </h3>
      <p className="text-xs text-muted-foreground">
        {t("range", { from: formatCalendarDate(summary.from), to: formatCalendarDate(summary.to) })}
      </p>
      {summary.projects.length === 0 ? (
        <p className="text-muted-foreground">{t("none")}</p>
      ) : (
        <ul className="space-y-2">
          {summary.projects.map((project) => (
            <li key={project.projectId} className="rounded-md border p-2">
              <span className="font-mono text-xs">{project.code}</span> {project.name}
              <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-muted-foreground">{t("approved")}</dt>
                <dd className="tabular-nums">
                  {t("totals", {
                    days: project.approved.days,
                    hours: hours(project.approved.workedMinutes),
                    overtime: hours(overtime(project.approved)),
                  })}
                </dd>
                <dt className="text-muted-foreground">{t("pending")}</dt>
                <dd className="tabular-nums">
                  {t("totals", {
                    days: project.pending.days,
                    hours: hours(project.pending.workedMinutes),
                    overtime: hours(overtime(project.pending)),
                  })}
                </dd>
                <dt className="text-muted-foreground">{t("lastWorked")}</dt>
                <dd className="tabular-nums">
                  {project.lastWorkedOn ? formatCalendarDate(project.lastWorkedOn) : "—"}
                </dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
      {summary.openAnomalies > 0 ? (
        <Link href="/attendance/anomalies" className="text-xs underline underline-offset-4">
          {t("anomalies", { count: summary.openAnomalies })}
        </Link>
      ) : null}
    </section>
  );
}
