import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  CircleCheck,
  Clock,
  FileSpreadsheet,
  HardHat,
  ScanFace,
  TriangleAlert,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BudgetByBillChart } from "@/components/charts/budget-by-bill-chart";
import { SCurveChart } from "@/components/charts/s-curve-chart";
import { KpiCard } from "@/components/kpi-card";
import { SitesMap } from "@/components/maps/sites-map";
import { PageHeader } from "@/components/page-header";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { formatDate, formatDateTime, formatKES, formatPercent } from "@/lib/format";
import { ruiruSummary } from "@/mocks/bq";
import {
  getProject,
  ruiruActivity,
  ruiruBudgetByBill,
  sCurveFor,
  type Milestone,
  type ProjectHealth,
} from "@/mocks/projects";

const healthTone: Record<ProjectHealth, Tone> = {
  on_track: "success",
  at_risk: "warning",
  behind: "danger",
};
const milestoneTone: Record<Milestone["state"], Tone> = {
  done: "success",
  at_risk: "warning",
  upcoming: "neutral",
  in_progress: "info",
};

export async function generateMetadata({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return { title: getProject(projectId)?.name ?? "Project" };
}

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const project = getProject(projectId);
  if (!project) notFound();

  const t = await getTranslations("project");
  const tHealth = await getTranslations("health");
  const tMilestones = await getTranslations("milestones");
  const isRuiru = project.id === "ruiru-heights";
  const valueDoneMinor = isRuiru
    ? ruiruSummary.doneMinor
    : Math.round(project.revisedSumMinor * project.progress);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/prototype/projects" className="hover:underline">
            {t("breadcrumb")}
          </Link>
        }
        title={project.name}
        description={`${project.description} · ${project.town}, ${project.county} · ${t("client")}: ${project.client}`}
        actions={
          <>
            <StatusBadge tone={healthTone[project.health]}>{tHealth(project.health)}</StatusBadge>
            <StatusBadge tone="neutral">{project.contractType}</StatusBadge>
          </>
        }
      />

      <nav aria-label={t("sectionsLabel")} className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="secondary">
          <Link href={`/prototype/projects/${project.id}`}>{t("tabs.overview")}</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={isRuiru ? `/prototype/projects/${project.id}/bq` : "/soon/valuations"}>
            <FileSpreadsheet aria-hidden /> {t("tabs.bq")}
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href="/prototype/labour">
            <HardHat aria-hidden /> {t("tabs.labour")}
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href="/prototype/attendance">
            <ScanFace aria-hidden /> {t("tabs.attendance")}
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href="/payroll">
            <Wallet aria-hidden /> {t("tabs.payroll")}
          </Link>
        </Button>
      </nav>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label={t("kpi.progress")}
          value={formatPercent(project.progress)}
          hint={t("kpi.progressHint", {
            planned: formatPercent(project.plannedProgress),
            spi: project.spi.toFixed(2),
          })}
          tone={project.spi < 0.95 ? "warning" : "success"}
        />
        <KpiCard
          label={t("kpi.valueDone")}
          value={formatKES(valueDoneMinor)}
          hint={t("kpi.valueDoneHint", { cpi: project.cpi.toFixed(2) })}
          tone={project.cpi < 1 ? "warning" : "success"}
        />
        <KpiCard
          label={t("kpi.contractSum")}
          value={formatKES(project.revisedSumMinor)}
          hint={t("kpi.contractSumHint", { original: formatKES(project.originalSumMinor) })}
        />
        <KpiCard
          label={t("kpi.workers")}
          value={`${project.workersToday}/${project.workersRostered}`}
          hint={t("kpi.workersHint", { issues: project.openIssues })}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("sCurveTitle")}</CardTitle>
            <CardDescription>{t("sCurveDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <SCurveChart
              data={sCurveFor(project.id)}
              labels={{ planned: t("planned"), actual: t("actual") }}
            />
          </CardContent>
        </Card>
        {isRuiru ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("budgetTitle")}</CardTitle>
              <CardDescription>{t("budgetDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <BudgetByBillChart
                data={ruiruBudgetByBill}
                labels={{
                  budget: t("budget"),
                  earned: t("earned"),
                  actual: t("actualCost"),
                  bill: t("bill"),
                }}
              />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{t("budgetTitle")}</CardTitle>
              <CardDescription>{t("budgetKitengela")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline">
                <Link href="/prototype/portal">{t("openPortal")}</Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{t("milestonesTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="relative space-y-4 border-l pl-5">
              {project.milestones.map((m) => (
                <li key={m.key} className="relative">
                  <span
                    className={`absolute top-1 -left-[27px] flex size-3.5 items-center justify-center rounded-full ring-4 ring-background ${m.state === "done" ? "bg-success" : m.state === "at_risk" ? "bg-warning" : m.state === "in_progress" ? "bg-info" : "bg-muted-foreground/40"}`}
                    aria-hidden
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{tMilestones(m.key)}</span>
                    <StatusBadge tone={milestoneTone[m.state]}>
                      {t(`milestoneStates.${m.state}`)}
                    </StatusBadge>
                  </div>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {t("plannedDate", { date: formatDate(m.planned) })}
                    {m.actual ? ` · ${t("actualDate", { date: formatDate(m.actual) })}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("siteTitle")}</CardTitle>
            <CardDescription>{t("siteDescription", { radius: project.radiusM })}</CardDescription>
          </CardHeader>
          <CardContent>
            <SitesMap
              label={t("siteTitle")}
              sites={[
                {
                  id: project.id,
                  name: project.name,
                  center: project.center,
                  radiusM: project.radiusM,
                },
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("activityTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            {isRuiru ? (
              <ul className="space-y-4">
                {ruiruActivity.map((item) => (
                  <li key={item.key} className="flex gap-3 text-sm">
                    {item.key === "inspectionPassed" || item.key === "voApproved" ? (
                      <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                    ) : item.key === "payrollReviewed" ? (
                      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                    ) : (
                      <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <div>
                      <p className="leading-snug">{t(`activity.${item.key}`, item.params)}</p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {formatDateTime(item.at)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t("activityEmpty")}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
