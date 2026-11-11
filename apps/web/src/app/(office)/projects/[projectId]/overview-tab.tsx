import { getTranslations } from "next-intl/server";
import { Banknote, ChartPie, HardHat, TriangleAlert, Wallet } from "lucide-react";
import { countyName, type County } from "@pm-buddy/types";
import type { BqContractSumResponse, ProjectDetailResponse } from "@pm-buddy/validation";
import { ContractSumCard } from "@/components/bq/contract-sum-card";
import { KpiCard } from "@/components/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCalendarDate, formatDateTime, formatKES } from "@/lib/format";

/**
 * The project dashboard shell. Every ratio and figure that needs data from a later module shows
 * "Unavailable" with the deliverable that provides it, never 0 or an estimate (brief §15 G).
 */
export async function OverviewTab({
  detail,
  contractSums,
}: {
  detail: ProjectDetailResponse;
  /** Undefined without bq.view (the card is hidden); null when the sums could not be loaded. */
  contractSums?: BqContractSumResponse | null;
}) {
  const t = await getTranslations("projectDetail");
  const tStatus = await getTranslations("projectStatus");
  const tTypes = await getTranslations("contractTypes");
  const { project } = detail;
  const kpis = [
    { key: "progress", icon: <ChartPie aria-hidden /> },
    { key: "budget", icon: <Wallet aria-hidden /> },
    { key: "cash", icon: <Banknote aria-hidden /> },
    { key: "labour", icon: <HardHat aria-hidden /> },
    { key: "issues", icon: <TriangleAlert aria-hidden /> },
  ] as const;
  const notSet = <span className="text-muted-foreground">{t("notSet")}</span>;
  const contact = [project.clientEmail, project.clientPhone].filter(Boolean).join(" · ");

  return (
    <div className="space-y-6">
      <section aria-labelledby="kpi-heading" className="space-y-3">
        <h2 id="kpi-heading" className="sr-only">
          {t("kpiHeading")}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {kpis.map((kpi) => (
            <KpiCard
              key={kpi.key}
              label={t(`kpi.${kpi.key}`)}
              value={<span className="text-lg text-muted-foreground">{t("kpi.unavailable")}</span>}
              hint={t(`kpi.${kpi.key}Hint`)}
              icon={kpi.icon}
            />
          ))}
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>
              <h2>{t("detailsTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{t("code")}</dt>
                <dd className="font-mono">{project.code}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("status")}</dt>
                <dd>{tStatus(project.status)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("client")}</dt>
                <dd>{project.clientName ?? notSet}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("clientContact")}</dt>
                <dd className="break-all">{contact || notSet}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("contractSum")}</dt>
                <dd className="tabular-nums">
                  {project.contractSumMinor === null ? notSet : formatKES(project.contractSumMinor)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("contractType")}</dt>
                <dd>{project.contractType ? tTypes(project.contractType) : notSet}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("period")}</dt>
                <dd className="tabular-nums">
                  {project.startDate ? formatCalendarDate(project.startDate) : "—"} –{" "}
                  {project.endDate ? formatCalendarDate(project.endDate) : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("location")}</dt>
                <dd>
                  {[project.town, project.county ? countyName(project.county as County) : null]
                    .filter(Boolean)
                    .join(", ") || notSet}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("coordinates")}</dt>
                <dd className="tabular-nums">
                  {project.latitude !== null && project.longitude !== null
                    ? `${project.latitude.toFixed(6)}, ${project.longitude.toFixed(6)}`
                    : notSet}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("sites")}</dt>
                <dd>{t("siteCount", { count: detail.siteCount })}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <div className="space-y-4">
          {contractSums !== undefined ? (
            <ContractSumCard sums={contractSums} projectId={project.id} />
          ) : null}
          {project.status === "planning" ? (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>{t("activationTitle")}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {detail.activationGaps.length ? (
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {detail.activationGaps.map((gap) => (
                      <li key={gap}>{t(`gaps.${gap}`)}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm">{t("activationReady")}</p>
                )}
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>{t("historyTitle")}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {detail.history.length ? (
                <ol className="space-y-3 text-sm">
                  {detail.history.map((change) => (
                    <li key={`${change.changedAt}-${change.to}`} className="border-l-2 pl-3">
                      <p className="font-medium">
                        {t("historyEntry", { from: tStatus(change.from), to: tStatus(change.to) })}
                      </p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {t("historyBy", {
                          name: change.changedBy.displayName,
                          date: formatDateTime(change.changedAt),
                        })}
                      </p>
                      {change.reason ? <p className="mt-1">{change.reason}</p> : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">{t("historyEmpty")}</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
