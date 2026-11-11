import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatHalfDays } from "@pm-buddy/domain";
import { ANOMALY_KINDS, ANOMALY_STATUSES } from "@pm-buddy/types";
import {
  anomaliesResponseSchema,
  correctionsResponseSchema,
  type Anomaly,
} from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { AttendanceNav } from "@/components/attendance/attendance-nav";
import { AnomalyBadge, AnomalyStatusBadge } from "@/components/attendance/attendance-badges";
import { AnomalyReview } from "@/components/attendance/anomaly-review";
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
import { dateParam, hours, musterHref, uuidParam } from "@/lib/attendance";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { loadLive, requireSession, serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("attendanceLive.anomalies");
  return { title: t("title") };
}

/**
 * Anomaly review (D3.3 web slice): flags raised when attendance is saved or a period is submitted
 * (two sites the same day, overlapping times, excessive hours, not engaged, inactive or
 * do-not-rehire labourers, expired NCA cards, manual corrections). Reviewers resolve or dismiss
 * each with a note; pending corrections of the selected project are listed too.
 */
export default async function AnomaliesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const project = uuidParam(raw.project);
  const status =
    typeof raw.status === "string" && (ANOMALY_STATUSES as readonly string[]).includes(raw.status)
      ? raw.status
      : raw.status === "all"
        ? undefined
        : "open";
  const kind =
    typeof raw.kind === "string" && (ANOMALY_KINDS as readonly string[]).includes(raw.kind)
      ? raw.kind
      : undefined;
  const from = dateParam(raw.from);
  const to = dateParam(raw.to);
  const query = new URLSearchParams();
  if (project) query.set("projectId", project);
  if (status) query.set("status", status);
  if (kind) query.set("kind", kind);
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  const pageQuery = new URLSearchParams(query);
  pageQuery.delete("projectId");
  if (project) pageQuery.set("project", project);
  if (!status) pageQuery.set("status", "all");
  const path = `/attendance/anomalies${pageQuery.size ? `?${pageQuery.toString()}` : ""}`;

  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive(
    `/attendance/anomalies${query.size ? `?${query.toString()}` : ""}`,
    anomaliesResponseSchema,
    path,
  );
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const { anomalies, counts, reviewableProjectIds, projects } = result.data;
  const corrections = project
    ? await serverApi(
        `/attendance/projects/${project}/corrections?status=pending`,
        correctionsResponseSchema,
      )
    : null;
  const t = await getTranslations("attendanceLive");
  const reviewable = new Set(reviewableProjectIds);
  const detail = (anomaly: Anomaly): string | null => {
    const value = anomaly.details;
    switch (anomaly.kind) {
      case "two_sites":
        return t("anomalies.details.two_sites", { count: Number(value.siteCount ?? 2) });
      case "overlapping_times":
        return t("anomalies.details.overlapping_times", {
          minutes: Number(value.overlapMinutes ?? 0),
        });
      case "excess_hours":
        return t("anomalies.details.excess_hours", {
          worked: hours(Number(value.workedMinutes ?? 0)),
          max: hours(Number(value.maxPlausibleMinutes ?? 0)),
        });
      case "manual_override":
        return t("anomalies.details.manual_override");
      case "locked_share_changed":
        return t("anomalies.details.locked_share_changed", {
          paidDays: formatHalfDays(Number(value.paidHalfDays ?? 0)),
          paidNormal: hours(Number(value.paidNormalMinutes ?? 0)),
          paidOvertime: hours(Number(value.paidOvertimeMinutes ?? 0)),
          idealDays: formatHalfDays(Number(value.idealHalfDays ?? 0)),
          idealNormal: hours(Number(value.idealNormalMinutes ?? 0)),
          idealOvertime: hours(Number(value.idealOvertimeMinutes ?? 0)),
        });
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{t("live")}</StatusBadge>}
        title={t("anomalies.title")}
        description={t("anomalies.description")}
      />
      <AttendanceNav current="anomalies" anomalies={counts.open} project={project} />

      <form
        method="get"
        action="/attendance/anomalies"
        aria-label={t("anomalies.filter")}
        className="flex flex-wrap items-end gap-3 rounded-lg border p-3"
      >
        <div className="space-y-1.5">
          <label htmlFor="anomalies-project" className="block text-sm font-medium">
            {t("common.project")}
          </label>
          <select
            id="anomalies-project"
            name="project"
            defaultValue={project ?? ""}
            className={selectClass}
          >
            <option value="">{t("anomalies.allProjects")}</option>
            {projects.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.code} · {entry.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="anomalies-status" className="block text-sm font-medium">
            {t("anomalies.status")}
          </label>
          <select
            id="anomalies-status"
            name="status"
            defaultValue={status ?? "all"}
            className={selectClass}
          >
            <option value="all">{t("anomalies.allStatuses")}</option>
            {ANOMALY_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`anomalyStatus.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="anomalies-kind" className="block text-sm font-medium">
            {t("anomalies.kind")}
          </label>
          <select id="anomalies-kind" name="kind" defaultValue={kind ?? ""} className={selectClass}>
            <option value="">{t("anomalies.allKinds")}</option>
            {ANOMALY_KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`anomalyKind.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline">
          {t("common.show")}
        </Button>
      </form>

      <p role="status" className="text-sm text-muted-foreground">
        {t("anomalies.count", {
          count: anomalies.length,
          open: counts.open,
          critical: counts.critical,
        })}
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableCaption className="sr-only">{t("anomalies.title")}</TableCaption>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>{t("anomalies.columns.date")}</TableHead>
              <TableHead>{t("anomalies.columns.worker")}</TableHead>
              <TableHead>{t("anomalies.columns.flag")}</TableHead>
              <TableHead>{t("anomalies.columns.where")}</TableHead>
              <TableHead>{t("anomalies.columns.status")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("anomalies.columns.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {anomalies.map((anomaly) => {
              const text = detail(anomaly);
              return (
                <TableRow key={anomaly.id}>
                  <TableCell className="tabular-nums">
                    <Link
                      href={musterHref({
                        project: anomaly.projectId,
                        site: anomaly.siteId,
                        date: anomaly.date,
                      })}
                      className="hover:underline"
                    >
                      {formatCalendarDate(anomaly.date)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span className="block font-medium">{anomaly.fullName}</span>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {anomaly.workerNo}
                    </span>
                  </TableCell>
                  <TableCell>
                    <AnomalyBadge kind={anomaly.kind} status={anomaly.status} />
                    {text ? (
                      <span className="mt-1 block text-xs text-muted-foreground">{text}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm">
                    <span className="font-mono text-xs">{anomaly.projectCode}</span> ·{" "}
                    {anomaly.siteName}
                    <span className="block text-xs text-muted-foreground">
                      {t("anomalies.recordedBy", { name: anomaly.recordedBy.displayName })}
                    </span>
                  </TableCell>
                  <TableCell>
                    <AnomalyStatusBadge status={anomaly.status} />
                    {anomaly.reviewedBy ? (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {t("anomalies.reviewedBy", {
                          name: anomaly.reviewedBy.displayName,
                          at: formatDateTime(anomaly.reviewedAt ?? ""),
                        })}
                        {anomaly.reviewNote ? ` — ${anomaly.reviewNote}` : null}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    {anomaly.status === "open" &&
                    anomaly.kind !== "manual_override" &&
                    reviewable.has(anomaly.projectId) ? (
                      <AnomalyReview anomaly={anomaly} />
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
            {anomalies.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  {t("anomalies.none")}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">{t("anomalies.manualNote")}</p>

      {corrections ? (
        <section id="corrections" aria-labelledby="pending-corrections" className="space-y-2">
          <h2 id="pending-corrections" className="text-base font-semibold">
            {t("anomalies.pendingCorrections")}
          </h2>
          {corrections.ok && corrections.data.corrections.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {corrections.data.corrections.map((correction) => (
                <li key={correction.id}>
                  <Link
                    href={musterHref({
                      project: project!,
                      site: correction.siteId,
                      date: correction.date,
                    })}
                    className="underline underline-offset-4"
                  >
                    {t("anomalies.correctionLine", {
                      name: correction.fullName,
                      date: formatCalendarDate(correction.date),
                      by: correction.requestedBy.displayName,
                    })}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("muster.corrections.none")}</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
