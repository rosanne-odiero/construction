import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import {
  reportSubscriptionsResponseSchema,
  type ReportRun,
  type ReportSubscription,
} from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { RunDueButton, SubscriptionActions } from "@/components/reports/subscriptions";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";
import { cn } from "@/lib/utils";

export async function generateMetadata() {
  const t = await getTranslations("reports.subscriptions");
  return { title: t("title") };
}

const outcomeTone: Record<ReportRun["outcome"], Tone> = {
  sent: "success",
  skipped: "warning",
  failed: "danger",
};

/**
 * Scheduled report emails (D8.1): the caller's subscriptions (pause, resume, delete) and their
 * recent runs; config.manage holders also see the company's and may run due ones now.
 */
export default async function SubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const scope = (await searchParams)["scope"] === "company" ? "company" : "mine";
  const path = `/reports/subscriptions${scope === "company" ? "?scope=company" : ""}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const locale = await getLocale();
  const result = await loadOrRedirect(
    `/reports/subscriptions?scope=${scope}&locale=${locale}`,
    reportSubscriptionsResponseSchema,
    path,
  );
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("reports.subscriptions");
  const { subscriptions, runs, canManage, sendHour } = result.data;
  const schedule = (entry: ReportSubscription) =>
    entry.frequency === "weekly"
      ? t("weekly", { day: t(`weekdays.${entry.weekday as 1 | 2 | 3 | 4 | 5 | 6 | 7}`) })
      : t("monthly", { day: entry.dayOfMonth ?? 1 });
  const tab = (value: "mine" | "company", label: string) => (
    <Link
      href={value === "company" ? "/reports/subscriptions?scope=company" : "/reports/subscriptions"}
      aria-current={scope === value ? "page" : undefined}
      className={cn(
        "-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium",
        scope === value
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/reports" className="underline underline-offset-4">
            {t("back")}
          </Link>
        }
        title={t("title")}
        description={t("description", { hour: String(sendHour).padStart(2, "0") })}
        actions={canManage && scope === "company" ? <RunDueButton /> : undefined}
      />
      {canManage ? (
        <nav aria-label={t("tabs")} className="border-b">
          <ul className="flex gap-1">
            <li>{tab("mine", t("mine"))}</li>
            <li>{tab("company", t("company"))}</li>
          </ul>
        </nav>
      ) : null}
      {subscriptions.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <ScrollTable label={t("title")} minWidth={880}>
          <thead className="bg-muted/50 text-left text-xs">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                {t("columns.report")}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t("columns.schedule")}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t("columns.status")}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t("columns.nextRun")}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t("columns.lastRun")}
              </th>
              {scope === "company" ? (
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("columns.subscriber")}
                </th>
              ) : null}
              <th scope="col" className="px-3 py-2 font-medium">
                <span className="sr-only">{t("columns.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {subscriptions.map((entry) => (
              <tr key={entry.id} className="border-t align-top">
                <td className="px-3 py-2">
                  <span className="font-medium">{entry.report.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {entry.parameterText} · {t(`languages.${entry.locale}`)}
                  </span>
                </td>
                <td className="px-3 py-2">{schedule(entry)}</td>
                <td className="px-3 py-2">
                  <StatusBadge tone={entry.status === "active" ? "success" : "neutral"}>
                    {t(`statuses.${entry.status}`)}
                  </StatusBadge>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {entry.nextRunAt ? formatDateTime(entry.nextRunAt) : "—"}
                </td>
                <td className="px-3 py-2">
                  {entry.lastRun ? (
                    <>
                      <StatusBadge tone={outcomeTone[entry.lastRun.outcome]}>
                        {t(`outcomes.${entry.lastRun.outcome}`)}
                      </StatusBadge>
                      <span className="block text-xs text-muted-foreground">
                        {formatDateTime(entry.lastRun.at)}
                        {entry.lastRun.reason ? ` · ${t(`reasons.${entry.lastRun.reason}`)}` : ""}
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                {scope === "company" ? (
                  <td className="px-3 py-2">{entry.subscriber.displayName}</td>
                ) : null}
                <td className="px-3 py-2">
                  {entry.mine && entry.status !== "deleted" ? (
                    <SubscriptionActions
                      id={entry.id}
                      version={entry.version}
                      status={entry.status as "active" | "paused"}
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </ScrollTable>
      )}
      <section aria-labelledby="recent-runs" className="space-y-3">
        <h2 id="recent-runs" className="text-lg font-semibold">
          {t("runsTitle")}
        </h2>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noRuns")}</p>
        ) : (
          <ScrollTable label={t("runsTitle")} minWidth={720}>
            <thead className="bg-muted/50 text-left text-xs">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("columns.due")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("columns.report")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("columns.period")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("columns.outcome")}
                </th>
                {scope === "company" ? (
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t("columns.subscriber")}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-t">
                  <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(run.dueAt)}</td>
                  <td className="px-3 py-2">{run.report.title}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {run.periodFrom && run.periodTo
                      ? `${formatCalendarDate(run.periodFrom)} – ${formatCalendarDate(run.periodTo)}`
                      : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge tone={outcomeTone[run.outcome]}>
                      {t(`outcomes.${run.outcome}`)}
                    </StatusBadge>
                    {run.reason ? (
                      <span className="block text-xs text-muted-foreground">
                        {t(`reasons.${run.reason}`)}
                      </span>
                    ) : null}
                  </td>
                  {scope === "company" ? (
                    <td className="px-3 py-2">{run.subscriber.displayName}</td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </section>
      <p className="text-xs text-muted-foreground">{t("deliveryNote")}</p>
    </div>
  );
}
