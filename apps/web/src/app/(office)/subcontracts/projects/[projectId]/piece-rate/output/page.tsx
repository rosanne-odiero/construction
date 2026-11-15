import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { pieceRateJobsResponseSchema, projectDetailResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { JobOutputForm } from "@/components/subcontracts/piece-rate-forms";
import {
  ProjectSubnav,
  SubcontractsEyebrow,
  type ProjectSection,
} from "@/components/subcontracts/subcontracts-nav";
import { formatCalendarDate } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession, serverApi } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";
import { subcontractAccess } from "@/lib/subcontracts";

export async function generateMetadata() {
  const t = await getTranslations("subcontracts.pieceRate.output");
  return { title: t("metaTitle") };
}

/**
 * The piece-rate output form (D6.3 part B): output is recorded against an approved job, which
 * fixes the BQ item, the gang or labourer, the unit and the rate; only the day and the quantity
 * are typed. Approval stays D4.1's (someone other than the recorder; equal gang shares).
 */
export default async function PieceRateOutputPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const { job } = await searchParams;
  if (!isUuid(projectId)) notFound();
  const path = `/subcontracts/projects/${projectId}/piece-rate/output`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect(
    `/payroll/projects/${projectId}/piece-rate-jobs`,
    pieceRateJobsResponseSchema,
    path,
  );
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const { project, jobs, permissions } = result.data;
  if (!permissions.canRecord) return <LiveForbidden />;
  const detail = await serverApi(`/projects/${projectId}`, projectDetailResponseSchema);
  const t = await getTranslations("subcontracts.pieceRate.output");
  const sections: ProjectSection[] = [
    ...(detail.ok && subcontractAccess(detail.data.permissions).read
      ? (["subcontracts"] as const)
      : []),
    "piece-rate",
    "output",
  ];
  const open = jobs.filter((row) => row.status === "approved");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <SubcontractsEyebrow
            trail={{ href: `/subcontracts/projects/${project.id}/piece-rate`, label: t("back") }}
          />
        }
        title={t("title", { code: project.code })}
        description={t("description")}
      />
      <ProjectSubnav projectId={project.id} current="output" sections={sections} />
      <div className="max-w-2xl">
        <JobOutputForm
          initialJobId={typeof job === "string" ? job : undefined}
          jobs={open.map((row) => ({
            id: row.id,
            code: row.code,
            label: `${row.bqItem.ref ?? "—"} · ${row.description}`,
            worker: row.gang
              ? row.gang.name
              : `${row.labourer?.workerNo} · ${row.labourer?.fullName}`,
            unit: row.unit,
            rateMinor: row.rateMinor,
            remaining: row.remainingQuantity,
            startDate: row.startDate,
            endDate: row.endDate,
            datesLabel: `${formatCalendarDate(row.startDate)} – ${formatCalendarDate(row.endDate)}`,
          }))}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        {t("approvalNote")}{" "}
        <Link
          href={`/subcontracts/projects/${project.id}/piece-rate`}
          className="underline underline-offset-4"
        >
          {t("jobsLink")}
        </Link>
      </p>
    </div>
  );
}
