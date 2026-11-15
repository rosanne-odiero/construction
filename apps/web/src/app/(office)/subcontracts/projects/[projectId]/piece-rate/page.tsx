import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PenLine } from "lucide-react";
import {
  pieceRateJobOptionsResponseSchema,
  pieceRateJobsResponseSchema,
  pieceRateReconciliationResponseSchema,
  projectDetailResponseSchema,
} from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { NewJobForm } from "@/components/subcontracts/piece-rate-forms";
import {
  ProjectSubnav,
  SubcontractsEyebrow,
  type ProjectSection,
} from "@/components/subcontracts/subcontracts-nav";
import { formatCalendarDate, formatDecimalString, formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession, serverApi } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";
import { flagTone, jobStatusTone, subcontractAccess } from "@/lib/subcontracts";

export async function generateMetadata() {
  const t = await getTranslations("subcontracts.pieceRate");
  return { title: t("metaTitle") };
}

/**
 * A project's piece-rate jobs (D6.3 part B): the agreed rate and quantity per BQ item for a gang
 * or labourer, approved by someone other than its creator, with what was approved and is still
 * open; and the reconciliation of piece-rate quantities paid against approved measurement, with
 * pay above measured work flagged (never netted silently).
 */
export default async function PieceRatePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const path = `/subcontracts/projects/${projectId}/piece-rate`;
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
  const [detail, reconciliation, options] = await Promise.all([
    serverApi(`/projects/${projectId}`, projectDetailResponseSchema),
    permissions.canReconcile
      ? serverApi(
          `/payroll/projects/${projectId}/piece-rate-reconciliation`,
          pieceRateReconciliationResponseSchema,
        )
      : null,
    permissions.canCreate
      ? serverApi(
          `/payroll/projects/${projectId}/piece-rate-jobs/options`,
          pieceRateJobOptionsResponseSchema,
        )
      : null,
  ]);
  const t = await getTranslations("subcontracts.pieceRate");
  const tStatus = await getTranslations("subcontracts.jobStatus");
  const tFlag = await getTranslations("subcontracts.flags");
  const sections: ProjectSection[] = [
    ...(detail.ok && subcontractAccess(detail.data.permissions).read
      ? (["subcontracts"] as const)
      : []),
    "piece-rate",
    ...(permissions.canRecord ? (["output"] as const) : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<SubcontractsEyebrow trail={{ href: "/subcontracts", label: t("back") }} />}
        title={t("title", { code: project.code })}
        description={t("description")}
        actions={
          permissions.canRecord ? (
            <Button asChild size="sm">
              <Link href={`/subcontracts/projects/${project.id}/piece-rate/output`}>
                <PenLine aria-hidden /> {t("record")}
              </Link>
            </Button>
          ) : null
        }
      />
      <ProjectSubnav projectId={project.id} current="piece-rate" sections={sections} />
      <section aria-labelledby="piece-rate-jobs" className="space-y-2">
        <h2 id="piece-rate-jobs" className="text-lg font-semibold">
          {t("jobsTitle")}
        </h2>
        {jobs.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-sm">{t("noJobs")}</p>
        ) : (
          <ScrollTable label={t("jobsTitle")} minWidth={860}>
            <thead className="bg-muted/50 text-left">
              <tr>
                {(
                  [
                    "job",
                    "worker",
                    "rate",
                    "inForce",
                    "approved",
                    "pending",
                    "remaining",
                    "status",
                  ] as const
                ).map((key) => (
                  <th
                    key={key}
                    scope="col"
                    className={`px-3 py-2 font-medium ${["rate", "inForce", "approved", "pending", "remaining"].includes(key) ? "text-right" : ""}`}
                  >
                    {t(`columns.${key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} className="border-t align-top">
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    <Link
                      href={`/subcontracts/piece-rate-jobs/${job.id}`}
                      className="font-medium underline underline-offset-4"
                    >
                      {job.code}
                    </Link>{" "}
                    {job.description}
                    <span className="block text-xs text-muted-foreground">
                      {job.bqItem.ref ?? "—"} · {job.bqItem.description.slice(0, 60)}
                    </span>
                  </th>
                  <td className="px-3 py-2">
                    {job.gang
                      ? job.gang.name
                      : `${job.labourer?.workerNo} · ${job.labourer?.fullName}`}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {t("perUnit", { amount: formatKES(job.rateMinor), unit: job.unit })}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDecimalString(job.quantityInForce)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDecimalString(job.approvedQuantity)}
                    <span className="block text-xs text-muted-foreground">
                      {formatKES(job.approvedAmountMinor)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDecimalString(job.pendingQuantity)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDecimalString(job.remainingQuantity)}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge tone={jobStatusTone[job.status]}>
                      {tStatus(job.status)}
                    </StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </section>

      {reconciliation?.ok ? (
        <section aria-labelledby="piece-rate-reconciliation" className="space-y-2">
          <h2 id="piece-rate-reconciliation" className="text-lg font-semibold">
            {t("reconciliation.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("reconciliation.description", {
              date: formatCalendarDate(reconciliation.data.asOf),
            })}
          </p>
          {reconciliation.data.flagged ? (
            <p
              role="status"
              className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm"
            >
              {t("reconciliation.flagged", { count: reconciliation.data.flagged })}
            </p>
          ) : null}
          {reconciliation.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("reconciliation.empty")}</p>
          ) : (
            <ScrollTable label={t("reconciliation.title")} minWidth={860}>
              <thead className="bg-muted/50 text-left">
                <tr>
                  {(
                    [
                      "item",
                      "measured",
                      "paid",
                      "pending",
                      "subcontracted",
                      "excess",
                      "flags",
                    ] as const
                  ).map((key) => (
                    <th
                      key={key}
                      scope="col"
                      className={`px-3 py-2 font-medium ${["measured", "paid", "pending", "subcontracted", "excess"].includes(key) ? "text-right" : ""}`}
                    >
                      {t(`reconciliation.columns.${key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {reconciliation.data.items.map((row) => (
                  <tr key={row.bqItem.lineageId} className="border-t align-top">
                    <th scope="row" className="px-3 py-2 text-left font-normal">
                      <span className="font-medium">{row.bqItem.ref ?? "—"}</span>{" "}
                      {row.bqItem.description.slice(0, 70)}
                      <span className="block text-xs text-muted-foreground">
                        {row.jobs.map((job) => job.code).join(", ")}
                      </span>
                    </th>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {row.measured === null
                        ? "—"
                        : `${formatDecimalString(row.measured)} ${row.bqItem.unit ?? ""}`}
                      {row.measuredOn ? (
                        <span className="block text-xs text-muted-foreground">
                          {formatCalendarDate(row.measuredOn)}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatDecimalString(row.pieceRateQuantity)}
                      <span className="block text-xs text-muted-foreground">
                        {formatKES(row.pieceRateAmountMinor)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatDecimalString(row.pendingQuantity)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatDecimalString(row.subcontractedQuantity)}
                    </td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">
                      {formatDecimalString(row.excessPieceRate)}
                    </td>
                    <td className="px-3 py-2">
                      <ul className="flex flex-wrap gap-1">
                        {row.flags.map((flag) => (
                          <li key={flag}>
                            <StatusBadge tone={flagTone[flag]}>{tFlag(flag)}</StatusBadge>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </ScrollTable>
          )}
          <p className="text-xs text-muted-foreground">{t("reconciliation.note")}</p>
        </section>
      ) : null}

      {options?.ok ? (
        <NewJobForm
          projectId={project.id}
          items={options.data.items.map((item) => ({
            lineageId: item.lineageId,
            label: `${item.ref ?? "—"} · ${item.description.slice(0, 70)}`,
            units: item.units,
          }))}
          gangs={options.data.gangs}
          labourers={options.data.labourers}
        />
      ) : null}
    </div>
  );
}
