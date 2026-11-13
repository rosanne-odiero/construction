import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Download, FileSpreadsheet, FileUp } from "lucide-react";
import {
  bqContractSumResponseSchema,
  bqResponseSchema,
  projectDetailResponseSchema,
} from "@pm-buddy/validation";
import { BaselineApproveButton } from "@/components/bq/baseline-approve";
import { BqSourceCard, BqSummaryCard } from "@/components/bq/bq-cards";
import { BqEyebrow, BqSubnav } from "@/components/bq/bq-subnav";
import { BqTree } from "@/components/bq/bq-tree";
import { ContractSumCard } from "@/components/bq/contract-sum-card";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

const PROTOTYPE_IDS = new Set(["ruiru-heights", "kitengela-bungalow"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("liveBq");
  return { title: t("title") };
}

/**
 * The live BQ viewer: the current version's summary, contract sums, source and validation, the
 * bill/section/item tree, and approval of the imported draft as the contract baseline (D2.3).
 */
export default async function BqPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  // The D0 prototype BQ moved to /prototype/projects/…; keep its old links working.
  if (PROTOTYPE_IDS.has(projectId)) redirect(`/prototype/projects/${projectId}/bq`);
  if (!UUID.test(projectId)) notFound();
  const path = `/projects/${projectId}/bq`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [detail, result, sums] = await Promise.all([
    serverApi(`/projects/${projectId}`, projectDetailResponseSchema),
    serverApi(`/projects/${projectId}/bq`, bqResponseSchema),
    serverApi(`/projects/${projectId}/bq/contract-sum`, bqContractSumResponseSchema),
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
  const tBaseline = await getTranslations("baseline");
  const locale = await getLocale();
  const exportBase = `/api/v1/projects/${project.id}/bq/export`;
  const version = data.bq?.version;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<BqEyebrow project={project} withBq={false} />}
        title={t("title")}
        description={
          version
            ? t("versionLine", {
                version: version.versionNo,
                status: t(`status.${version.status}`),
                items: version.itemCount,
              })
            : undefined
        }
        actions={
          <>
            {version ? (
              <StatusBadge tone={version.status === "draft" ? "warning" : "success"}>
                {t(`status.${version.status}`)}
              </StatusBadge>
            ) : null}
            {version && data.baselineApproval.allowed ? (
              <BaselineApproveButton
                projectId={project.id}
                versionId={version.id}
                version={version.version}
                grandTotalMinor={version.grandTotalMinor}
              />
            ) : null}
            {data.permissions.canImport && version?.status !== "approved" ? (
              <Button asChild variant={version ? "outline" : "default"}>
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
      <BqSubnav projectId={project.id} current="bq" />
      {version ? (
        <p role="status" className="rounded-md border bg-muted/40 p-3 text-sm">
          {version.status === "approved" && version.approvedBy && version.approvedAt
            ? tBaseline(version.source === "import" ? "approvedLine" : "variationLine", {
                version: version.versionNo,
                date: formatDateTime(version.approvedAt),
                name: version.approvedBy.displayName,
                number: version.variation?.number ?? "",
              })
            : data.baselineApproval.refusal === "maker"
              ? tBaseline("refusal.maker")
              : data.baselineApproval.refusal === "permission"
                ? tBaseline("refusal.permission")
                : data.baselineApproval.refusal === "read-only"
                  ? tBaseline("refusal.read-only")
                  : tBaseline("pending")}
        </p>
      ) : null}
      {data.bq ? (
        <>
          <div className="grid gap-4 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <BqSummaryCard bq={data.bq} />
            </div>
            <div className="space-y-4">
              <ContractSumCard sums={sums.ok ? sums.data : null} projectId={project.id} />
              <BqSourceCard bq={data.bq} />
            </div>
          </div>
          <BqTree
            projectId={project.id}
            bills={data.bq.bills}
            canLink={data.permissions.canEdit && data.bq.version.status === "approved"}
          />
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
