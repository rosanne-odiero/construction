import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Camera, FileSignature, Wallet } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import { clientPortalOverviewResponseSchema } from "@pm-buddy/validation";
import { DiaryEntry, MilestoneList } from "@/components/client-portal/client-sections";
import {
  ClientProjectHeader,
  ConversionNote,
  Money,
  ProgressBar,
} from "@/components/client-portal/client-shell";
import { LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { currencySearch, parseCurrency } from "@/lib/client-portal";
import { loadClientPage } from "@/lib/client-portal-server";
import { formatCalendarDate } from "@/lib/format";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A client's view of one project: progress (earned value, with its basis), what is owed and when,
 * site photos, milestones and the latest approved diaries.
 */
export default async function ClientProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();
  const currency = parseCurrency((await searchParams)["currency"]);
  const path = `/portal/projects/${projectId}`;
  const page = await loadClientPage(
    path,
    `/portal/client/projects/${projectId}${currencySearch(currency)}`,
    clientPortalOverviewResponseSchema,
  );
  if (page.kind !== "ok") return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("clientPortal.overview");
  const { project, progress, milestones, diaries, nextDue, photos, display } = page.data;
  const today = nairobiDate();
  const variance =
    progress.variancePoints === null
      ? null
      : progress.variancePoints.startsWith("-")
        ? t("behind", { points: progress.variancePoints.slice(1) })
        : t("ahead", { points: progress.variancePoints });
  return (
    <div className="space-y-6">
      <ClientProjectHeader project={project} current="overview" />
      <ConversionNote display={display} />
      {project.awaitingDecisions ? (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-md border bg-background p-3 text-sm"
        >
          <FileSignature className="size-4" aria-hidden />
          {t("awaiting", { count: project.awaitingDecisions })}
          <Link
            href={`/portal/projects/${project.id}/variations`}
            className="underline underline-offset-4"
          >
            {t("review")}
          </Link>
        </p>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("progressTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ProgressBar label={t("complete")} percent={progress.percentComplete} />
            <ProgressBar label={t("planned")} percent={progress.plannedPercent} tone="muted" />
            {variance ? <p className="text-sm">{variance}</p> : null}
            <p className="text-xs text-muted-foreground">
              {progress.percentComplete === null
                ? t("noProgress")
                : t("basis", {
                    version: progress.bqVersionNo ?? 1,
                    date: formatCalendarDate(progress.dataDate),
                  })}{" "}
              {progress.plannedPercent === null ? t("noBaseline") : ""}
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href={`/portal/projects/${project.id}/progress`}>{t("sCurve")}</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("moneyTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{t("certified")}</dt>
                <dd>
                  <Money minor={project.balance.certifiedMinor} display={display} today={today} />
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("received")}</dt>
                <dd>
                  <Money minor={project.balance.receivedMinor} display={display} today={today} />
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("outstanding")}</dt>
                <dd className="font-semibold">
                  <Money minor={project.balance.outstandingMinor} display={display} today={today} />
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("overdue")}</dt>
                <dd>
                  <Money minor={project.balance.overdueMinor} display={display} today={today} />
                </dd>
              </div>
            </dl>
            {nextDue ? (
              <p className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={nextDue.overdue ? "danger" : "warning"}>
                  {nextDue.overdue ? t("overdueBadge") : t("dueBadge")}
                </StatusBadge>
                {t("nextDue", {
                  number: nextDue.number,
                  date: formatCalendarDate(nextDue.dueDate),
                })}
              </p>
            ) : (
              <p className="text-muted-foreground">{t("nothingDue")}</p>
            )}
            <p className="text-xs text-muted-foreground">{t("paidNote")}</p>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm">
                <Link href={`/portal/projects/${project.id}/pay`}>
                  <Wallet aria-hidden /> {t("pay")}
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={`/portal/projects/${project.id}/statement`}>{t("statement")}</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("photosTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="flex items-center gap-2">
              <Camera className="size-4 text-muted-foreground" aria-hidden />
              {t("photosSummary", photos)}
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href={`/portal/projects/${project.id}/photos`}>{t("viewPhotos")}</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("milestonesTitle")}</h2>
            </CardTitle>
            <p className="text-sm text-muted-foreground">{t("milestones", project.milestones)}</p>
          </CardHeader>
          <CardContent>
            <MilestoneList milestones={milestones} />
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("diariesTitle")}</h2>
          </CardTitle>
          <p className="text-sm text-muted-foreground">{t("diariesDescription")}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {diaries.length ? (
            <ol className="space-y-4">
              {diaries.map((diary) => (
                <li key={diary.id}>
                  <DiaryEntry diary={diary} />
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noDiaries")}</p>
          )}
          <Button asChild variant="outline" size="sm">
            <Link href={`/portal/projects/${project.id}/diaries`}>{t("allDiaries")}</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
