import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowRight, CalendarClock } from "lucide-react";
import { REPORT_GROUPS } from "@pm-buddy/types";
import { reportsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("reports.home");
  return { title: t("title") };
}

/**
 * The reports centre (D8.1): the reports the caller may run, grouped, with the others listed with
 * the permission they need, and reports not built yet shown as "not available yet".
 */
export default async function ReportsPage() {
  const path = "/reports";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const locale = await getLocale();
  const result = await loadOrRedirect(`/reports?locale=${locale}`, reportsResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("reports.home");
  const { reports } = result.data;
  const runnable = reports.filter((report) => report.canRun);
  const others = reports.filter((report) => !report.canRun);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{t("live")}</StatusBadge>}
        title={t("title")}
        description={t("description")}
        actions={
          <Button asChild variant="outline">
            <Link href="/reports/subscriptions">
              <CalendarClock aria-hidden /> {t("subscriptions")}
            </Link>
          </Button>
        }
      />
      {REPORT_GROUPS.map((group) => {
        const items = runnable.filter((report) => report.group === group);
        if (!items.length) return null;
        return (
          <section key={group} aria-labelledby={`group-${group}`} className="space-y-3">
            <h2 id={`group-${group}`} className="text-lg font-semibold">
              {t(`groups.${group}`)}
            </h2>
            <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {items.map((report) => (
                <li key={report.id}>
                  <Link
                    href={`/reports/${report.id}`}
                    className="flex h-full flex-col gap-2 rounded-xl border p-4 transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="font-medium">{report.title}</span>
                      <ArrowRight className="mt-0.5 size-4 shrink-0" aria-hidden />
                    </span>
                    <span className="text-sm text-muted-foreground">{report.description}</span>
                    <span className="mt-auto text-xs text-muted-foreground">
                      {report.projects.length
                        ? t("projectCount", { count: report.projects.length })
                        : t("company")}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {runnable.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
          {t("noneRunnable")}
        </p>
      ) : null}
      {others.length ? (
        <section aria-labelledby="other-reports" className="space-y-3">
          <h2 id="other-reports" className="text-lg font-semibold">
            {t("othersTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("othersHint")}</p>
          <ul className="divide-y rounded-xl border">
            {others.map((report) => (
              <li key={report.id} className="space-y-1 p-4 text-sm">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {report.title}
                  {!report.available ? (
                    <StatusBadge tone="neutral">
                      {t("notAvailable", { deliverable: report.availableWith ?? "" })}
                    </StatusBadge>
                  ) : null}
                </p>
                <p className="text-muted-foreground">{report.description}</p>
                {report.available ? (
                  <p className="text-xs text-muted-foreground">{report.rule}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("ruleNote")}</p>
    </div>
  );
}
