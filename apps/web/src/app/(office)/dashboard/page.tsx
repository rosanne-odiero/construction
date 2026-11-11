import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  HardHat,
  Hourglass,
  Landmark,
  Receipt,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CashFlowChart } from "@/components/charts/cash-flow-chart";
import { SpendByCategoryChart } from "@/components/charts/spend-by-category-chart";
import { KpiCard } from "@/components/kpi-card";
import { SitesMap } from "@/components/maps/sites-map";
import { PageHeader } from "@/components/page-header";
import { StatusBadge, severityTone, type Tone } from "@/components/status-badge";
import {
  formatDate,
  formatKES,
  formatKESCompact,
  formatPercent,
  formatWeekdayDate,
} from "@/lib/format";
import { NOW, currentUser } from "@/mocks/company";
import {
  alerts,
  cashFlowForecast,
  kpis,
  spendByCategory,
  upcomingPayments,
} from "@/mocks/dashboard";
import { projects, type ProjectHealth } from "@/mocks/projects";

export async function generateMetadata() {
  const t = await getTranslations("nav.items");
  return { title: t("dashboard") };
}

const healthTone: Record<ProjectHealth, Tone> = {
  on_track: "success",
  at_risk: "warning",
  behind: "danger",
};
const paymentTone: Record<(typeof upcomingPayments)[number]["state"], Tone> = {
  awaitingApproval: "warning",
  prepared: "neutral",
  matched: "success",
  blocked: "danger",
  due: "info",
};

export default async function DashboardPage() {
  const locale = await getLocale();
  const t = await getTranslations("dashboard");
  const tAlerts = await getTranslations("alerts");
  const tSeverity = await getTranslations("severity");
  const tHealth = await getTranslations("health");
  const tCat = await getTranslations("categories");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={formatWeekdayDate(NOW, locale)}
        title={t("greeting", { name: currentUser.name.split(" ")[0] })}
        description={t("subtitle")}
        actions={
          <Button asChild>
            <Link href="/prototype/payroll">
              {t("reviewApprovals", { count: kpis.awaitingApproval })} <ArrowRight aria-hidden />
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label={t("kpi.cash")}
          value={formatKESCompact(kpis.cashMinor)}
          hint={t("kpi.cashHint", {
            change: formatPercent(kpis.cashChange),
            float: formatKESCompact(kpis.mpesaFloatMinor),
          })}
          icon={<Landmark />}
          tone="success"
        />
        <KpiCard
          label={t("kpi.spend")}
          value={formatKESCompact(kpis.spendMonthMinor)}
          hint={t("kpi.spendHint", {
            pct: formatPercent(kpis.spendMonthMinor / kpis.spendPlanMinor),
            plan: formatKESCompact(kpis.spendPlanMinor),
          })}
          icon={<Receipt />}
        />
        <KpiCard
          label={t("kpi.workers")}
          value={`${kpis.workersToday}/${kpis.workersRostered}`}
          hint={t("kpi.workersHint", { sites: projects.length })}
          icon={<HardHat />}
        />
        <KpiCard
          label={t("kpi.approvals")}
          value={kpis.awaitingApproval}
          hint={t("kpi.approvalsHint", { amount: formatKES(kpis.awaitingApprovalMinor) })}
          icon={<Hourglass />}
          tone="warning"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>{t("projectsTitle")}</CardTitle>
            <CardDescription>{t("projectsDescription")}</CardDescription>
            <CardAction>
              <Button asChild variant="ghost" size="sm">
                <Link href="/prototype/projects">{t("viewAll")}</Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">{t("table.project")}</TableHead>
                  <TableHead className="w-40">{t("table.progress")}</TableHead>
                  <TableHead className="text-right">{t("table.burn")}</TableHead>
                  <TableHead className="text-right">CPI</TableHead>
                  <TableHead className="text-right">SPI</TableHead>
                  <TableHead className="text-right">{t("table.workers")}</TableHead>
                  <TableHead className="pr-6">{t("table.health")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="pl-6">
                      <Link
                        href={`/prototype/projects/${p.id}`}
                        className="font-medium hover:underline"
                      >
                        {p.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {p.town}, {p.county}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Progress
                          value={p.progress * 100}
                          className="h-2"
                          aria-label={t("table.progress")}
                        />
                        <span className="w-9 text-right text-xs tabular-nums">
                          {formatPercent(p.progress)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPercent(p.budgetBurn)}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${p.cpi < 1 ? "text-destructive" : ""}`}
                    >
                      {p.cpi.toFixed(2)}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${p.spi < 0.95 ? "text-destructive" : ""}`}
                    >
                      {p.spi.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {p.workersToday}/{p.workersRostered}
                    </TableCell>
                    <TableCell className="pr-6">
                      <StatusBadge tone={healthTone[p.health]}>{tHealth(p.health)}</StatusBadge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("alertsTitle")}</CardTitle>
            <CardDescription>{t("alertsDescription", { count: alerts.length })}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {alerts.slice(0, 5).map((alert) => (
                <li key={alert.key}>
                  <Link
                    href={alert.href}
                    className="block rounded-lg border p-3 text-sm transition-colors hover:bg-muted"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <StatusBadge tone={severityTone[alert.severity]}>
                        {tSeverity(alert.severity)}
                      </StatusBadge>
                      <span className="truncate text-xs text-muted-foreground">
                        {alert.project}
                      </span>
                    </div>
                    <p className="leading-snug">{tAlerts(alert.key, alert.params)}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("spendTitle")}</CardTitle>
            <CardDescription>{t("spendDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <SpendByCategoryChart
              data={spendByCategory.map((c) => ({
                key: c.key,
                label: tCat(c.key),
                amount: c.amount,
              }))}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("cashFlowTitle")}</CardTitle>
            <CardDescription>{t("cashFlowDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <CashFlowChart
              data={cashFlowForecast}
              labels={{ inflow: t("inflow"), outflow: t("outflow"), weekOf: t("weekOf") }}
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>{t("mapTitle")}</CardTitle>
            <CardDescription>{t("mapDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <SitesMap
              label={t("mapTitle")}
              className="h-80"
              sites={projects.map((p) => ({
                id: p.id,
                name: p.name,
                center: p.center,
                radiusM: p.radiusM,
              }))}
            />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("upcomingTitle")}</CardTitle>
            <CardDescription>{t("upcomingDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {upcomingPayments.map((p) => (
                <li key={p.key}>
                  <Link href={p.href} className="flex items-center gap-3 py-3 hover:bg-muted/50">
                    <span
                      className={`flex size-8 shrink-0 items-center justify-center rounded-full ${p.direction === "in" ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}
                    >
                      {p.direction === "in" ? (
                        <ArrowDownLeft className="size-4" aria-hidden />
                      ) : (
                        <ArrowUpRight className="size-4" aria-hidden />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{t(`payments.${p.key}`)}</p>
                      <p className="text-xs text-muted-foreground">{formatDate(p.date)}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium tabular-nums">{formatKES(p.amountMinor)}</p>
                      <StatusBadge tone={paymentTone[p.state]} className="mt-1">
                        {t(`paymentStates.${p.state}`)}
                      </StatusBadge>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
