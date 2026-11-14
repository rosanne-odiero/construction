import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { FileSpreadsheet, FileText } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import { isReportId, REPORT_DEFINITIONS } from "@pm-buddy/types";
import { reportModelSchema, reportsResponseSchema, type ReportParams } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { ReportForm } from "@/components/reports/report-form";
import { ReportStepUp } from "@/components/reports/report-step-up";
import { ReportView } from "@/components/reports/report-view";
import { SubscribeDialog } from "@/components/reports/subscriptions";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { loadOrRedirect } from "@/lib/p2p-server";
import {
  defaultDates,
  exportHref,
  parseReportParams,
  pdfFits,
  reportQuery,
  wantsReport,
} from "@/lib/reports";
import { signInHref } from "@/lib/safe-next";
import { requireSession, serverApi } from "@/lib/server-api";

type Params = { reportId: string };
type Search = Record<string, string | string[] | undefined>;

/** Report problem codes with their own message; anything else is a generic failure. */
const PROBLEMS = [
  "report-forbidden",
  "report-not-available",
  "report-parameter-invalid",
  "project-required",
  "site-required",
  "batch-required",
  "period-required",
  "period-invalid",
  "period-too-long",
  "report-too-large",
  "step-up-required",
  "rate-limited",
] as const;
type ProblemCode = (typeof PROBLEMS)[number];

export async function generateMetadata({ params }: { params: Promise<Params> }) {
  const { reportId } = await params;
  const t = await getTranslations("reports.home");
  return { title: isReportId(reportId) ? `${t("title")} · ${reportId}` : t("title") };
}

/**
 * One report (D8.1): its parameter form, the report on screen (at most 200 rows per section; the
 * totals and the downloads cover every row), PDF and Excel downloads in the page's language, and
 * "Email me this report". The API checks the caller's permission on every request, so a link from
 * a scheduled email shows only what the person may see when they open it.
 */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { reportId } = await params;
  if (!isReportId(reportId)) notFound();
  const search = await searchParams;
  const parameters = parseReportParams(reportId, search);
  const path = `/reports/${reportId}${reportQuery(parameters) ? `?${reportQuery(parameters)}` : ""}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const locale = await getLocale();
  const list = await loadOrRedirect(`/reports?locale=${locale}`, reportsResponseSchema, path);
  if (!list.ok)
    return list.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("reports.report");
  const summary = list.data.reports.find((report) => report.id === reportId)!;
  const definition = REPORT_DEFINITIONS[reportId];
  const header = (
    <PageHeader
      eyebrow={
        <Link href="/reports" className="underline underline-offset-4">
          {t("back")}
        </Link>
      }
      title={summary.title}
      description={summary.description}
    />
  );
  if (!summary.available)
    return (
      <div className="space-y-6">
        {header}
        <div role="status" className="space-y-2 rounded-xl border border-dashed p-6 text-sm">
          <StatusBadge tone="neutral">
            {t("notAvailable", { deliverable: summary.availableWith ?? "" })}
          </StatusBadge>
          <p className="text-muted-foreground">{t("notAvailableHint")}</p>
        </div>
      </div>
    );
  if (!summary.canRun)
    return (
      <div className="space-y-6">
        {header}
        <div role="alert" className="space-y-2 rounded-xl border p-6 text-sm">
          <p className="font-medium">{t("cannotRun")}</p>
          <p className="text-muted-foreground">{summary.rule}</p>
        </div>
      </div>
    );

  const initial = { ...defaultDates(definition, nairobiDate()), ...parameters };
  let model = null;
  let problem: ProblemCode | "failed" | null = null;
  if (wantsReport(search)) {
    const result = await serverApi(
      `/reports/${reportId}?${reportQuery(parameters, { locale })}`,
      reportModelSchema,
    );
    if (result.ok) model = result.data;
    else if (result.status === 401) redirect(signInHref(path));
    else
      problem = (PROBLEMS as readonly string[]).includes(result.code)
        ? (result.code as ProblemCode)
        : result.status === 429
          ? "rate-limited"
          : "failed";
  }
  const rows = model ? model.sections.reduce((total, section) => total + section.rowCount, 0) : 0;
  const fixed: ReportParams = { ...(model?.query ?? parameters) };
  delete fixed.from;
  delete fixed.to;
  delete fixed.asAt;

  return (
    <div className="space-y-6">
      {header}
      <ReportForm
        key={reportQuery(parameters)}
        id={reportId}
        projects={summary.projects}
        acrossProjects={summary.acrossProjects}
        initial={initial}
      />
      {problem ? (
        <div className="space-y-3 rounded-xl border border-destructive/40 p-4 text-sm">
          <p role="alert">{t(`problems.${problem}`)}</p>
          {problem === "step-up-required" ? (
            <ReportStepUp path={`/reports/${reportId}?${reportQuery(parameters, { locale })}`} />
          ) : null}
        </div>
      ) : null}
      {model ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {pdfFits(rows) ? (
              <Button asChild variant="outline">
                <a href={exportHref(reportId, model.query, "pdf", locale)} download>
                  <FileText aria-hidden /> {t("downloadPdf")}
                </a>
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">{t("pdfTooLarge", { rows })}</p>
            )}
            <Button asChild variant="outline">
              <a href={exportHref(reportId, model.query, "xlsx", locale)} download>
                <FileSpreadsheet aria-hidden /> {t("downloadExcel")}
              </a>
            </Button>
            {list.data.canSubscribe ? <SubscribeDialog id={reportId} parameters={fixed} /> : null}
          </div>
          <ReportView model={model} />
        </>
      ) : null}
    </div>
  );
}
