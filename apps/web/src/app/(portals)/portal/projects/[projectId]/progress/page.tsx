import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import { clientProgressResponseSchema } from "@pm-buddy/validation";
import { ClientSCurve } from "@/components/client-portal/client-s-curve";
import { MilestoneList } from "@/components/client-portal/client-sections";
import {
  ClientProjectHeader,
  ConversionNote,
  Money,
  ProgressBar,
} from "@/components/client-portal/client-shell";
import { LiveUnavailable } from "@/components/projects/live-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { currencySearch, parseCurrency } from "@/lib/client-portal";
import { loadClientPage } from "@/lib/client-portal-server";
import { formatCalendarDate, formatKES } from "@/lib/format";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("clientPortal.progress");
  return { title: t("title") };
}

/**
 * Progress and the S-curve: planned against earned value at contract rates, week by week, with
 * the basis stated and undefined figures shown as "not available". No cost data.
 */
export default async function ClientProgressPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();
  const currency = parseCurrency((await searchParams)["currency"]);
  const path = `/portal/projects/${projectId}/progress`;
  const page = await loadClientPage(
    path,
    `/portal/client/projects/${projectId}/progress${currencySearch(currency)}`,
    clientProgressResponseSchema,
  );
  if (page.kind !== "ok") return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("clientPortal.progress");
  const tCommon = await getTranslations("clientPortal");
  const {
    project,
    figures,
    curve,
    curveTruncated,
    baseline,
    bqVersion,
    milestones,
    display,
    dataDate,
  } = page.data;
  const today = nairobiDate();
  const variance =
    figures.variancePoints === null
      ? t("varianceUnavailable")
      : figures.variancePoints.startsWith("-")
        ? t("behind", { points: figures.variancePoints.slice(1) })
        : t("ahead", { points: figures.variancePoints });
  return (
    <div className="space-y-6">
      <ClientProjectHeader project={project} current="progress" title={t("title")} />
      <ConversionNote display={display} />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("figuresTitle", { date: formatCalendarDate(dataDate) })}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ProgressBar label={t("complete")} percent={figures.percentComplete} />
          <ProgressBar label={t("planned")} percent={figures.plannedPercent} tone="muted" />
          <p className="text-sm">{variance}</p>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">{t("earned")}</dt>
              <dd>
                <Money minor={figures.evMinor} display={display} today={today} />
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("plannedValue")}</dt>
              <dd>
                {figures.pvMinor === null ? (
                  tCommon("notAvailable")
                ) : (
                  <Money minor={figures.pvMinor} display={display} today={today} />
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("bac")}</dt>
              <dd>
                <Money minor={figures.bacMinor} display={display} today={today} />
              </dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            {t("basis", { version: bqVersion?.versionNo ?? 1 })}{" "}
            {baseline
              ? t("baseline", {
                  name: baseline.name,
                  start: formatCalendarDate(baseline.startDate),
                })
              : t("noBaseline")}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("curveTitle")}</h2>
          </CardTitle>
          <p className="text-sm text-muted-foreground">{t("curveDescription")}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {curve.length ? (
            <ClientSCurve points={curve} />
          ) : (
            <p className="text-sm">{t("noCurve")}</p>
          )}
          {curveTruncated ? (
            <p className="text-xs text-muted-foreground">{t("truncated")}</p>
          ) : null}
          {curve.length ? (
            <div
              role="region"
              aria-label={t("tableCaption")}
              tabIndex={0}
              className="overflow-x-auto"
            >
              <table className="w-full min-w-[22rem] text-sm">
                <caption className="sr-only">{t("tableCaption")}</caption>
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="py-2 pr-3 font-medium">
                      {t("week")}
                    </th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">
                      {t("plannedShort")}
                    </th>
                    <th scope="col" className="py-2 text-right font-medium">
                      {t("earnedShort")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...curve].reverse().map((point) => (
                    <tr key={point.weekEnd} className="border-b last:border-0">
                      <th scope="row" className="py-2 pr-3 text-left font-normal">
                        {formatCalendarDate(point.weekEnd)}
                      </th>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {point.plannedPercent === null
                          ? tCommon("notAvailable")
                          : `${point.plannedPercent}%`}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {point.evMinor === null
                          ? "—"
                          : `${point.earnedPercent === null ? tCommon("notAvailable") : `${point.earnedPercent}%`} · ${formatKES(point.evMinor)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("milestonesTitle")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <MilestoneList milestones={milestones} />
        </CardContent>
      </Card>
    </div>
  );
}
