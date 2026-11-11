import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Download, FileSpreadsheet, FileUp } from "lucide-react";
import { bqResponseSchema, projectDetailResponseSchema } from "@pm-buddy/validation";
import { BqSourceCard, BqSummaryCard } from "@/components/bq/bq-cards";
import { BqTree } from "@/components/bq/bq-tree";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

const PROTOTYPE_IDS = new Set(["ruiru-heights", "kitengela-bungalow"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("liveBq");
  return { title: t("title") };
}

/** The live BQ viewer (D2.2): summary, source and validation, and the bill/section/item tree. */
export default async function BqPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  // The D0 prototype BQ moved to /prototype/projects/…; keep its old links working.
  if (PROTOTYPE_IDS.has(projectId)) redirect(`/prototype/projects/${projectId}/bq`);
  if (!UUID.test(projectId)) notFound();
  const path = `/projects/${projectId}/bq`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [detail, result] = await Promise.all([
    serverApi(`/projects/${projectId}`, projectDetailResponseSchema),
    serverApi(`/projects/${projectId}/bq`, bqResponseSchema),
  ]);
  for (const response of [detail, result]) {
    if (response.ok) continue;
    if (response.status === 401) redirect(signInHref(path));
    if (response.status === 404) notFound();
    if (response.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  if (!detail.ok || !result.ok) return <LiveUnavailable retryHref={path} />;
  const { project } = detail.data;
  const data = result.data;
  const t = await getTranslations("liveBq");
  const locale = await getLocale();
  const exportBase = `/api/v1/projects/${project.id}/bq/export`;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <Link href="/projects" className="hover:underline">
              {t("breadcrumb")}
            </Link>
            <span aria-hidden>/</span>
            <Link href={`/projects/${project.id}`} className="hover:underline">
              <span className="font-mono">{project.code}</span> · {project.name}
            </Link>
          </span>
        }
        title={t("title")}
        description={
          data.bq
            ? t("versionLine", {
                version: data.bq.version.versionNo,
                status: t(`status.${data.bq.version.status}`),
                items: data.bq.version.itemCount,
              })
            : undefined
        }
        actions={
          <>
            {data.bq ? (
              <StatusBadge tone={data.bq.version.status === "draft" ? "warning" : "success"}>
                {t(`status.${data.bq.version.status}`)}
              </StatusBadge>
            ) : null}
            {data.permissions.canImport ? (
              <Button asChild>
                <Link href={`/projects/${project.id}/bq/import`}>
                  <FileUp aria-hidden />
                  {data.openImports
                    ? t("continueImport", { count: data.openImports })
                    : t("import")}
                </Link>
              </Button>
            ) : null}
            {data.bq && data.permissions.canExport ? (
              <>
                <Button asChild variant="outline">
                  <a href={`${exportBase}/xlsx?locale=${locale}`} download>
                    <Download aria-hidden /> {t("exportExcel")}
                  </a>
                </Button>
                <Button asChild variant="outline">
                  <a href={`${exportBase}/pdf?locale=${locale}`} download>
                    <Download aria-hidden /> {t("exportPdf")}
                  </a>
                </Button>
              </>
            ) : null}
          </>
        }
      />
      {data.bq ? (
        <>
          <div className="grid gap-4 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <BqSummaryCard bq={data.bq} />
            </div>
            <BqSourceCard bq={data.bq} />
          </div>
          <BqTree projectId={project.id} bills={data.bq.bills} />
        </>
      ) : (
        <div className="mx-auto max-w-lg space-y-4 rounded-xl border p-8 text-center">
          <FileSpreadsheet className="mx-auto size-10 text-muted-foreground" aria-hidden />
          <h2 className="text-lg font-semibold">{t("empty.title")}</h2>
          <p className="text-sm text-muted-foreground">
            {data.permissions.canImport ? t("empty.description") : t("empty.noPermission")}
          </p>
          {data.permissions.canImport ? (
            <Button asChild>
              <Link href={`/projects/${project.id}/bq/import`}>
                <FileUp aria-hidden />
                {data.openImports ? t("continueImport", { count: data.openImports }) : t("import")}
              </Link>
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
