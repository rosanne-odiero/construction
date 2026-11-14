import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AlertTriangle, Banknote, PiggyBank, Wallet } from "lucide-react";
import { spendAlertsResponseSchema, spendingSummaryResponseSchema } from "@pm-buddy/validation";
import { KpiCard } from "@/components/kpi-card";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import {
  FiguresTable,
  SpendingEyebrow,
  SpendingSubnav,
} from "@/components/spending/spending-subnav";
import { formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession, serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("spending.home");
  return { title: t("title") };
}

/** Budget against committed, actual and paid for every project the caller may see (D5.4). */
export default async function SpendingPage() {
  const path = "/spending";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, alerts] = await Promise.all([
    loadOrRedirect("/spending/summary", spendingSummaryResponseSchema, path),
    serverApi("/spending/alerts?limit=1", spendAlertsResponseSchema),
  ]);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("spending.home");
  const { projects, thresholdPercent } = result.data;
  const sum = (pick: (row: (typeof projects)[number]) => number) =>
    projects.reduce((total, row) => total + pick(row), 0);
  const alertTotal = alerts.ok
    ? Object.values(alerts.data.counts).reduce((total, count) => total + count, 0)
    : null;

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<SpendingEyebrow />} title={t("title")} description={t("description")} />
      <SpendingSubnav current="home" />
      {projects.length === 0 ? (
        <div className="space-y-2 rounded-xl border border-dashed p-6 text-sm">
          <p className="font-medium">{t("noProjects")}</p>
          <p className="text-muted-foreground">{t("noProjectsHint")}</p>
          <Link href="/spending/petty-cash" className="font-medium underline underline-offset-4">
            {t("openPettyCash")}
          </Link>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label={t("committed")}
              value={formatKES(sum((row) => row.figures.committedMinor))}
              icon={<PiggyBank aria-hidden />}
              hint={t("committedHint")}
            />
            <KpiCard
              label={t("actual")}
              value={formatKES(sum((row) => row.figures.actualMinor))}
              icon={<Wallet aria-hidden />}
              hint={t("actualHint")}
            />
            <KpiCard
              label={t("cashPaid")}
              value={formatKES(sum((row) => row.cashPaidMinor))}
              icon={<Banknote aria-hidden />}
              hint={t("cashPaidHint")}
            />
            <KpiCard
              label={t("alerts")}
              value={alertTotal === null ? "—" : String(alertTotal)}
              icon={<AlertTriangle aria-hidden />}
              tone={alertTotal ? "warning" : "default"}
              hint={
                alertTotal ? (
                  <Link href="/spending/alerts" className="underline underline-offset-4">
                    {t("reviewAlerts")}
                  </Link>
                ) : undefined
              }
            />
          </div>
          <section aria-labelledby="spending-projects" className="space-y-3">
            <h2 id="spending-projects" className="text-lg font-semibold">
              {t("projectsTitle")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("projectsHint", { percent: thresholdPercent })}
            </p>
            <FiguresTable
              label={t("projectsTitle")}
              firstColumn={t("project")}
              rows={projects.map((row) => ({
                key: row.project.id,
                label: (
                  <>
                    <Link
                      href={`/spending/projects/${row.project.id}`}
                      className="underline underline-offset-4"
                    >
                      {row.project.code} · {row.project.name}
                    </Link>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {row.budget
                        ? t("budgetVersion", { version: row.budget.versionNo })
                        : t("noApprovedBudget")}
                    </span>
                  </>
                ),
                figures: row.figures,
              }))}
            />
          </section>
        </>
      )}
      <section className="space-y-2 rounded-xl border p-4 text-sm">
        <h2 className="font-semibold">{t("measuresTitle")}</h2>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>{t("measureCommitted")}</li>
          <li>{t("measureActual")}</li>
          <li>{t("measurePaid")}</li>
          <li>{t("measureMaterials")}</li>
        </ul>
      </section>
    </div>
  );
}
