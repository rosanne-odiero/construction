import { getTranslations } from "next-intl/server";
import { Banknote, CalendarCheck, MapPin } from "lucide-react";
import { countyName } from "@pm-buddy/types";
import {
  workerPortalResponseSchema,
  workerNotificationPreferencesSchema,
  workerNotificationHistorySchema,
} from "@pm-buddy/validation";
import { LiveUnavailable } from "@/components/projects/live-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadLive, requirePortal } from "@/lib/server-api";
import { formatCalendarDate } from "@/lib/format";
import { formatMinorDecimal } from "@/lib/procurement";
import { WorkerNotifications } from "@/components/worker-notifications";

export async function generateMetadata() {
  const t = await getTranslations("portals");
  return { title: t("workerName") };
}

/** Curated own-worker records; submitted pay must never be labelled as money received. */
export default async function WorkerPortalPage() {
  const session = await requirePortal("worker", "/worker");
  if (!session) return <LiveUnavailable retryHref="/worker" />;
  const result = await loadLive("/portal/worker", workerPortalResponseSchema, "/worker");
  if (!result.ok) return <LiveUnavailable retryHref="/worker" />;
  const t = await getTranslations("portals.worker");
  const preferences = await loadLive(
    "/portal/worker/notifications",
    workerNotificationPreferencesSchema,
    "/worker",
  );
  const history = await loadLive(
    "/portal/worker/notifications/history",
    workerNotificationHistorySchema,
    "/worker",
  );
  const { displayName, company, assignments, attendance, pay } = result.data;
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("greeting", { name: displayName })}
        </h1>
        <p className="text-muted-foreground">{t("company", { company: company.name })}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("sitesTitle")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {assignments.length ? (
            <ul className="space-y-4">
              {assignments.map(({ project, sites }) => (
                <li key={project.id} className="space-y-2">
                  <h3 className="font-medium">
                    {project.name}{" "}
                    <span className="font-mono text-xs text-muted-foreground">{project.code}</span>
                  </h3>
                  {sites.length ? (
                    <ul className="space-y-2">
                      {sites.map((site) => (
                        <li key={site.id} className="flex items-start gap-2 text-sm">
                          <MapPin
                            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span>
                            <span className="block font-medium">{site.name}</span>
                            <span className="text-muted-foreground">
                              {site.address ??
                                [project.town, project.county ? countyName(project.county) : null]
                                  .filter(Boolean)
                                  .join(", ")}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("noSitesYet")}</p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm">{t("noAssignments")}</p>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarCheck className="size-5 text-muted-foreground" aria-hidden />
              <h2>{t("attendanceTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {attendance ? (
              <div className="space-y-4 text-sm">
                <p>
                  {t("range", {
                    from: formatCalendarDate(attendance.from),
                    to: formatCalendarDate(attendance.to),
                  })}
                </p>
                <p className="font-medium">{t("daysWorked", { days: attendance.daysWorked })}</p>
                <p className="text-muted-foreground">{t("confirmedOnly")}</p>
                {attendance.records.length ? (
                  <ul className="space-y-3">
                    {attendance.records.map((record) => (
                      <li key={record.id} className="border-t pt-2">
                        <p>
                          {formatCalendarDate(record.date)} · {t(`statuses.${record.status}`)}
                        </p>
                        <p className="break-words text-muted-foreground">
                          {record.project} · {record.site}
                        </p>
                        <p>{record.confirmed ? t("confirmed") : t("pending")}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{t("noAttendance")}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("recordUnavailable")}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Banknote className="size-5 text-muted-foreground" aria-hidden />
              <h2>{t("payTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pay ? (
              <div className="space-y-4 text-sm">
                <p className="text-muted-foreground">{t("submittedNotPaid")}</p>
                {pay.lines.length ? (
                  <ul className="space-y-4">
                    {pay.lines.map((line) => (
                      <li key={line.id} className="space-y-2 border-t pt-2">
                        <h3 className="break-words font-medium">{line.project}</h3>
                        <p>
                          {t("range", {
                            from: formatCalendarDate(line.from),
                            to: formatCalendarDate(line.to),
                          })}
                        </p>
                        <dl className="space-y-1">
                          <div className="flex flex-wrap justify-between gap-2">
                            <dt>{t("gross")}</dt>
                            <dd>{formatMinorDecimal(line.grossMinor)}</dd>
                          </div>
                          <div className="flex flex-wrap justify-between gap-2">
                            <dt>{t("deductions")}</dt>
                            <dd>{formatMinorDecimal(line.deductionsMinor)}</dd>
                          </div>
                          <div className="flex flex-wrap justify-between gap-2 font-medium">
                            <dt>{t("net")}</dt>
                            <dd>{formatMinorDecimal(line.netMinor)}</dd>
                          </div>
                        </dl>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{t("noPay")}</p>
                )}
                <p>
                  {t("advances")}:{" "}
                  <strong>{formatMinorDecimal(pay.advancesOutstandingMinor)}</strong>
                </p>
                <p className="text-muted-foreground">{t("paymentsUnavailable")}</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("recordUnavailable")}</p>
            )}
            <p className="mt-4 text-sm text-muted-foreground">{t("ussd")}</p>
          </CardContent>
        </Card>
      </div>
      {preferences.ok ? (
        <WorkerNotifications
          initial={preferences.data}
          initialHistory={history.ok ? history.data : null}
        />
      ) : (
        <LiveUnavailable retryHref="/worker" />
      )}
    </div>
  );
}
