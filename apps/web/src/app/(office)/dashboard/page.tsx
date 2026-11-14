import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { AlertTriangle, ChartColumn, FileCheck2, HardHat, Landmark, Wallet } from "lucide-react";
import { dashboardResponseSchema, type DashboardResponse } from "@pm-buddy/validation";
import { KpiCard } from "@/components/kpi-card";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { ForecastChart } from "@/components/spending/forecast-chart";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { formatCalendarDate, formatKES, formatWeekdayDate } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("nav.items");
  return { title: t("dashboard") };
}

type Level = NonNullable<DashboardResponse["spending"]>["projects"][number]["level"];
const levelTone: Record<Level, Tone> = {
  unavailable: "neutral",
  within: "success",
  threshold: "warning",
  over: "danger",
};
const barClass: Record<Level, string> = {
  unavailable: "bg-muted-foreground/40",
  within: "bg-primary",
  threshold: "bg-warning",
  over: "bg-destructive",
};

type Attention = { key: string; href: string; text: string; tone: Tone };

/**
 * The owner dashboard (D8.1): live, curated figures from one API call. Each section is built from
 * its source screen's read with the same permission rule; a section the caller may not see is not
 * shown at all (never as zero) and undefined ratios show as unavailable.
 */
export default async function DashboardPage() {
  const path = "/dashboard";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect("/dashboard", dashboardResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const data = result.data;
  const locale = await getLocale();
  const t = await getTranslations("dashboard");
  const tStatus = await getTranslations("projectStatus");

  const certifiedRows = (data.projects ?? []).filter((row) => row.certified);
  const attention: Attention[] = [];
  const add = (condition: unknown, item: Attention) => {
    if (condition) attention.push(item);
  };
  add(data.invoices?.overdue.count, {
    key: "overdue",
    href: "/procurement/invoices",
    tone: "danger",
    text: t("attention.invoicesOverdue", {
      count: data.invoices?.overdue.count ?? 0,
      amount: formatKES(data.invoices?.overdue.outstandingMinor ?? 0),
    }),
  });
  add(data.invoices?.dueSoon.count, {
    key: "due",
    href: "/procurement/invoices",
    tone: "warning",
    text: t("attention.invoicesDue", {
      count: data.invoices?.dueSoon.count ?? 0,
      days: data.invoices?.windowDays ?? 0,
      amount: formatKES(data.invoices?.dueSoon.outstandingMinor ?? 0),
    }),
  });
  add(data.spendAlerts?.total, {
    key: "spend",
    href: "/spending/alerts",
    tone: "warning",
    text: t("attention.spendAlerts", { count: data.spendAlerts?.total ?? 0 }),
  });
  add(data.stock?.lowStock, {
    key: "stock",
    href: "/stores",
    tone: "warning",
    text: t("attention.lowStock", { count: data.stock?.lowStock ?? 0 }),
  });
  add(data.plant?.total, {
    key: "plant",
    href: "/plant",
    tone: "warning",
    text: t("attention.plant", { count: data.plant?.total ?? 0 }),
  });
  add(data.safety?.openIncidents, {
    key: "incidents",
    href: "/safety",
    tone: "danger",
    text: t("attention.openIncidents", { count: data.safety?.openIncidents ?? 0 }),
  });
  add(data.safety?.overdueActions, {
    key: "actions",
    href: "/safety",
    tone: "danger",
    text: t("attention.overdueActions", { count: data.safety?.overdueActions ?? 0 }),
  });
  add(data.quality?.openSnags, {
    key: "snags",
    href: "/quality",
    tone: "info",
    text: t("attention.openSnags", { count: data.quality?.openSnags ?? 0 }),
  });
  add(data.quality?.inspectionsAwaitingSignOff, {
    key: "inspections",
    href: "/quality",
    tone: "info",
    text: t("attention.inspections", { count: data.quality?.inspectionsAwaitingSignOff ?? 0 }),
  });
  const showsAttention = Boolean(
    data.invoices ?? data.spendAlerts ?? data.stock ?? data.plant ?? data.safety ?? data.quality,
  );
  const nothing = Object.keys(data).every((key) => key === "today" || key === "generatedAt");
  const th = "px-3 py-2 font-medium";
  const num = "px-3 py-2 text-right whitespace-nowrap tabular-nums";

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={formatWeekdayDate(`${data.today}T09:00:00+03:00`, locale)}
        title={t("greeting", { name: session.user.displayName.split(" ")[0] ?? "" })}
        description={t("subtitle")}
        actions={
          <Button asChild variant="outline">
            <Link href="/reports">
              <ChartColumn aria-hidden /> {t("reports")}
            </Link>
          </Button>
        }
      />
      {nothing ? (
        <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
          {t("nothing")}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {data.forecast ? (
          <KpiCard
            label={t("kpi.cash")}
            value={
              data.forecast.openingMinor === null ? "—" : formatKES(data.forecast.openingMinor)
            }
            hint={data.forecast.openingMinor === null ? t("kpi.noOpening") : t("kpi.cashHint")}
            icon={<Landmark />}
          />
        ) : null}
        {certifiedRows.length ? (
          <KpiCard
            label={t("kpi.certified")}
            value={formatKES(
              certifiedRows.reduce((sum, row) => sum + row.certified!.certifiedMinor, 0),
            )}
            hint={t("kpi.certifiedHint", {
              count: certifiedRows.filter((row) => row.certified!.latest).length,
            })}
            icon={<FileCheck2 />}
          />
        ) : null}
        {data.spending ? (
          <KpiCard
            label={t("kpi.actual")}
            value={formatKES(data.spending.totals.actualMinor)}
            hint={t("kpi.actualHint", {
              committed: formatKES(data.spending.totals.committedMinor),
              paid: formatKES(data.spending.totals.paidMinor),
            })}
            icon={<Wallet />}
          />
        ) : null}
        {data.attendance ? (
          <KpiCard
            label={t("kpi.workers")}
            value={String(data.attendance.present)}
            hint={t("kpi.workersHint", {
              halfDay: data.attendance.halfDay,
              absent: data.attendance.absent,
            })}
            icon={<HardHat />}
          />
        ) : null}
        {data.invoices ? (
          <KpiCard
            label={t("kpi.overdue")}
            value={formatKES(data.invoices.overdue.outstandingMinor)}
            hint={t("kpi.overdueHint", {
              count: data.invoices.overdue.count,
              dueSoon: data.invoices.dueSoon.count,
              days: data.invoices.windowDays,
            })}
            icon={<AlertTriangle />}
            tone={data.invoices.overdue.count ? "danger" : "default"}
          />
        ) : null}
      </div>

      {showsAttention ? (
        <section aria-labelledby="attention" className="space-y-3 rounded-xl border p-4">
          <h2 id="attention" className="text-lg font-semibold">
            {t("attention.title")}
          </h2>
          {attention.length ? (
            <ul className="grid gap-2 sm:grid-cols-2">
              {attention.map((item) => (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    className="flex min-h-11 items-center gap-2 rounded-lg border p-3 text-sm hover:bg-muted/50"
                  >
                    <StatusBadge tone={item.tone}>{t(`attention.tones.${item.tone}`)}</StatusBadge>
                    <span>{item.text}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("attention.nothing")}</p>
          )}
        </section>
      ) : null}

      {data.projects ? (
        <section aria-labelledby="dash-projects" className="space-y-3">
          <h2 id="dash-projects" className="text-lg font-semibold">
            {t("projects.title")}
          </h2>
          {data.projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("projects.empty")}</p>
          ) : (
            <ScrollTable label={t("projects.title")} minWidth={certifiedRows.length ? 760 : 480}>
              <thead className="bg-muted/50 text-left text-xs">
                <tr>
                  <th scope="col" className={th}>
                    {t("projects.project")}
                  </th>
                  <th scope="col" className={th}>
                    {t("projects.status")}
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    {t("projects.contract")}
                  </th>
                  {certifiedRows.length ? (
                    <>
                      <th scope="col" className={`${th} text-right`}>
                        {t("projects.certified")}
                      </th>
                      <th scope="col" className={`${th} text-right`}>
                        {t("projects.percent")}
                      </th>
                      <th scope="col" className={th}>
                        {t("projects.latest")}
                      </th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {data.projects.map((row) => (
                  <tr key={row.project.id} className="border-t">
                    <td className="px-3 py-2">
                      <Link
                        href={`/projects/${row.project.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {row.project.code} · {row.project.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{tStatus(row.status)}</td>
                    <td className={num}>
                      {row.contractSumMinor === null ? "—" : formatKES(row.contractSumMinor)}
                    </td>
                    {certifiedRows.length ? (
                      <>
                        <td className={num}>
                          {row.certified ? formatKES(row.certified.certifiedMinor) : "—"}
                        </td>
                        <td className={num}>
                          {row.certified?.percentOfContract
                            ? `${row.certified.percentOfContract} %`
                            : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {row.certified?.latest
                            ? `${row.certified.latest.number} · ${formatCalendarDate(row.certified.latest.date)}`
                            : "—"}
                        </td>
                      </>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </ScrollTable>
          )}
          {certifiedRows.length ? (
            <p className="text-xs text-muted-foreground">{t("projects.note")}</p>
          ) : null}
        </section>
      ) : null}

      {data.spending ? (
        <section aria-labelledby="dash-spending" className="space-y-3">
          <h2 id="dash-spending" className="text-lg font-semibold">
            {t("spending.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("spending.hint", { percent: data.spending.thresholdPercent })}
          </p>
          <ScrollTable label={t("spending.title")} minWidth={760}>
            <thead className="bg-muted/50 text-left text-xs">
              <tr>
                <th scope="col" className={th}>
                  {t("projects.project")}
                </th>
                <th scope="col" className={`${th} text-right`}>
                  {t("spending.budget")}
                </th>
                <th scope="col" className={`${th} text-right`}>
                  {t("spending.committed")}
                </th>
                <th scope="col" className={`${th} text-right`}>
                  {t("spending.actual")}
                </th>
                <th scope="col" className={`${th} text-right`}>
                  {t("spending.paid")}
                </th>
                <th scope="col" className={th}>
                  {t("spending.used")}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.spending.projects.map((row) => (
                <tr key={row.project.id} className="border-t">
                  <td className="px-3 py-2">
                    <Link
                      href={`/spending/projects/${row.project.id}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {row.project.code}
                    </Link>
                  </td>
                  <td className={num}>
                    {row.budgetMinor === null ? t("spending.noBudget") : formatKES(row.budgetMinor)}
                  </td>
                  <td className={num}>{formatKES(row.committedMinor)}</td>
                  <td className={num}>{formatKES(row.actualMinor)}</td>
                  <td className={num}>{formatKES(row.paidMinor)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-24 overflow-hidden rounded-full bg-muted" aria-hidden>
                        <div
                          className={`h-full ${barClass[row.level]}`}
                          style={{
                            width: `${Math.min(100, Math.max(0, Number(row.usedPercent ?? 0)))}%`,
                          }}
                        />
                      </div>
                      <StatusBadge tone={levelTone[row.level]}>
                        {row.usedPercent === null
                          ? t("spending.unavailable")
                          : `${row.usedPercent} %`}
                      </StatusBadge>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        </section>
      ) : null}

      {data.forecast ? (
        <section aria-labelledby="dash-forecast" className="space-y-3">
          <h2 id="dash-forecast" className="text-lg font-semibold">
            {t("forecast.title")}
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            <ForecastChart weeks={data.forecast.weeks} label={t("forecast.chart")} />
            <ScrollTable label={t("forecast.table")} minWidth={420}>
              <thead className="bg-muted/50 text-left text-xs">
                <tr>
                  <th scope="col" className={th}>
                    {t("forecast.week")}
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    {t("forecast.in")}
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    {t("forecast.out")}
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    {t("forecast.closing")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.forecast.weeks.map((week) => (
                  <tr key={week.start} className="border-t">
                    <td className="px-3 py-2 whitespace-nowrap">
                      {formatCalendarDate(week.start)}
                    </td>
                    <td className={num}>{formatKES(week.inMinor)}</td>
                    <td className={num}>{formatKES(week.outMinor)}</td>
                    <td className={num}>
                      {week.closingMinor === null ? "—" : formatKES(week.closingMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </ScrollTable>
          </div>
          <Link href="/spending/forecast" className="text-sm underline underline-offset-4">
            {t("forecast.open")}
          </Link>
        </section>
      ) : null}

      {data.attendance ? (
        <section aria-labelledby="dash-attendance" className="space-y-3">
          <h2 id="dash-attendance" className="text-lg font-semibold">
            {t("attendance.title")}
          </h2>
          <ScrollTable label={t("attendance.title")} minWidth={520}>
            <thead className="bg-muted/50 text-left text-xs">
              <tr>
                <th scope="col" className={th}>
                  {t("projects.project")}
                </th>
                <th scope="col" className={`${th} text-right`}>
                  {t("attendance.present")}
                </th>
                <th scope="col" className={`${th} text-right`}>
                  {t("attendance.halfDay")}
                </th>
                <th scope="col" className={`${th} text-right`}>
                  {t("attendance.absent")}
                </th>
                <th scope="col" className={`${th} text-right`}>
                  {t("attendance.sites")}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.attendance.projects.map((row) => (
                <tr key={row.project.id} className="border-t">
                  <td className="px-3 py-2">
                    {row.project.code} · {row.project.name}
                  </td>
                  <td className={num}>{row.present}</td>
                  <td className={num}>{row.halfDay}</td>
                  <td className={num}>{row.absent}</td>
                  <td className={num}>
                    {t("attendance.sitesValue", { recorded: row.sitesRecorded, sites: row.sites })}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
          <p className="text-xs text-muted-foreground">{t("attendance.note")}</p>
        </section>
      ) : null}
    </div>
  );
}
