import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PenLine } from "lucide-react";
import { pieceRateJobResponseSchema, pieceRateJobsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { ExtensionForm } from "@/components/subcontracts/piece-rate-forms";
import { SubcontractAction } from "@/components/subcontracts/subcontract-action";
import { SubcontractsEyebrow } from "@/components/subcontracts/subcontracts-nav";
import { formatCalendarDate, formatDecimalString, formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession, serverApi } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";
import { jobStatusTone, variationStatusTone } from "@/lib/subcontracts";

export async function generateMetadata() {
  const t = await getTranslations("subcontracts.job");
  return { title: t("metaTitle") };
}

/**
 * A piece-rate job (D6.3 part B): its agreed terms, the decision (never by its creator), the
 * extensions of its quantity, and the output recorded against it at its rate, approved through
 * D4.1 (never by the recorder) into equal gang shares that payroll batches consume.
 */
export default async function PieceRateJobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!isUuid(jobId)) notFound();
  const path = `/subcontracts/piece-rate-jobs/${jobId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect(
    `/payroll/piece-rate-jobs/${jobId}`,
    pieceRateJobResponseSchema,
    path,
  );
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const { job, outputs } = result.data;
  // Output decisions are D4.1's (timesheets.approve, never the recorder): the project's job list
  // says whether the caller may decide.
  const list = await serverApi(
    `/payroll/projects/${job.projectId}/piece-rate-jobs`,
    pieceRateJobsResponseSchema,
  );
  const canDecideOutputs = list.ok && list.data.permissions.canDecide;
  const t = await getTranslations("subcontracts.job");
  const tStatus = await getTranslations("subcontracts.jobStatus");
  const tExtension = await getTranslations("subcontracts.variationStatus");
  const tOutput = await getTranslations("subcontracts.outputStatus");
  const p = job.permissions;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <SubcontractsEyebrow
            trail={{ href: `/subcontracts/projects/${job.projectId}/piece-rate`, label: t("back") }}
          />
        }
        title={`${job.code} · ${job.description}`}
        description={`${job.bqItem.ref ?? "—"} · ${job.bqItem.description}`}
        actions={
          <>
            <StatusBadge tone={jobStatusTone[job.status]}>{tStatus(job.status)}</StatusBadge>
            {p.canApprove ? (
              <SubcontractAction
                path={`/payroll/piece-rate-jobs/${job.id}/approve`}
                entity="job"
                body={{ version: job.version }}
                primary
                text={{
                  button: t("actions.approve"),
                  title: t("actions.approveTitle"),
                  description: t("actions.approveDescription", {
                    rate: formatKES(job.rateMinor),
                    unit: job.unit,
                    quantity: job.agreedQuantity,
                  }),
                  confirm: t("actions.approve"),
                }}
              />
            ) : null}
            {p.canReject ? (
              <SubcontractAction
                path={`/payroll/piece-rate-jobs/${job.id}/reject`}
                entity="job"
                body={{ version: job.version }}
                reason
                destructive
                text={{
                  button: t("actions.reject"),
                  title: t("actions.rejectTitle"),
                  description: t("actions.rejectDescription"),
                  confirm: t("actions.reject"),
                }}
              />
            ) : null}
            {p.canClose ? (
              <SubcontractAction
                path={`/payroll/piece-rate-jobs/${job.id}/close`}
                entity="job"
                body={{ version: job.version }}
                text={{
                  button: t("actions.close"),
                  title: t("actions.closeTitle"),
                  description: t("actions.closeDescription"),
                  confirm: t("actions.close"),
                }}
              />
            ) : null}
            {p.canRecord ? (
              <Button asChild size="sm">
                <Link
                  href={`/subcontracts/projects/${job.projectId}/piece-rate/output?job=${job.id}`}
                >
                  <PenLine aria-hidden /> {t("record")}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />
      <dl className="grid grid-cols-2 gap-3 rounded-xl border p-4 text-sm sm:grid-cols-4">
        {(
          [
            [
              "worker",
              job.gang ? job.gang.name : `${job.labourer?.workerNo} · ${job.labourer?.fullName}`,
            ],
            ["rate", t("perUnit", { amount: formatKES(job.rateMinor), unit: job.unit })],
            [
              "unit",
              job.unit === job.bqUnit
                ? job.unit
                : t("converted", {
                    unit: job.unit,
                    bqUnit: job.bqUnit,
                    factor: job.conversionFactor,
                  }),
            ],
            ["dates", `${formatCalendarDate(job.startDate)} – ${formatCalendarDate(job.endDate)}`],
            ["agreed", formatDecimalString(job.agreedQuantity)],
            ["inForce", formatDecimalString(job.quantityInForce)],
            [
              "approved",
              `${formatDecimalString(job.approvedQuantity)} · ${formatKES(job.approvedAmountMinor)}`,
            ],
            ["remaining", formatDecimalString(job.remainingQuantity)],
          ] as const
        ).map(([key, value]) => (
          <div key={key}>
            <dt className="text-muted-foreground">{t(`facts.${key}`)}</dt>
            <dd className="tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {job.decidedBy ? (
        <p className="text-sm text-muted-foreground">
          {t("decided", { name: job.decidedBy.displayName, by: job.createdBy.displayName })}
          {job.decisionNote ? ` · ${job.decisionNote}` : ""}
        </p>
      ) : null}

      <section aria-labelledby="job-extensions" className="space-y-2">
        <h2 id="job-extensions" className="text-lg font-semibold">
          {t("extensionsTitle")}
        </h2>
        {job.extensions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noExtensions")}</p>
        ) : (
          <ul className="space-y-2">
            {job.extensions.map((extension) => (
              <li key={extension.id} className="space-y-2 rounded-xl border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium tabular-nums">
                    +{formatDecimalString(extension.quantity)} {job.unit}
                  </span>
                  <StatusBadge tone={variationStatusTone[extension.status]}>
                    {tExtension(extension.status)}
                  </StatusBadge>
                </div>
                <p>{extension.reason}</p>
                <div className="flex flex-wrap gap-2">
                  {extension.permissions.canApprove ? (
                    <SubcontractAction
                      path={`/payroll/piece-rate-jobs/${job.id}/extensions/${extension.id}/approve`}
                      entity="job"
                      body={{ version: extension.version }}
                      primary
                      text={{
                        button: t("actions.approveExtension"),
                        title: t("actions.approveExtensionTitle", {
                          quantity: extension.quantity,
                          unit: job.unit,
                        }),
                        description: t("actions.approveExtensionDescription"),
                        confirm: t("actions.approveExtension"),
                      }}
                    />
                  ) : null}
                  {extension.permissions.canReject ? (
                    <SubcontractAction
                      path={`/payroll/piece-rate-jobs/${job.id}/extensions/${extension.id}/reject`}
                      entity="job"
                      body={{ version: extension.version }}
                      reason
                      destructive
                      text={{
                        button: t("actions.rejectExtension"),
                        title: t("actions.rejectExtensionTitle"),
                        description: t("actions.rejectExtensionDescription"),
                        confirm: t("actions.rejectExtension"),
                      }}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {p.canExtend ? <ExtensionForm jobId={job.id} unit={job.unit} /> : null}
      </section>

      <section aria-labelledby="job-outputs" className="space-y-2">
        <h2 id="job-outputs" className="text-lg font-semibold">
          {t("outputsTitle")}
        </h2>
        {outputs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noOutputs")}</p>
        ) : (
          <ScrollTable label={t("outputsTitle")} minWidth={720}>
            <thead className="bg-muted/50 text-left">
              <tr>
                {(["date", "quantity", "amount", "status", "recordedBy", "shares"] as const).map(
                  (key) => (
                    <th
                      key={key}
                      scope="col"
                      className={`px-3 py-2 font-medium ${["quantity", "amount", "shares"].includes(key) ? "text-right" : ""}`}
                    >
                      {t(`outputs.${key}`)}
                    </th>
                  ),
                )}
                {canDecideOutputs ? (
                  <th scope="col" className="px-3 py-2 font-medium">
                    <span className="sr-only">{t("outputs.decide")}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {outputs.map((output) => (
                <tr key={output.id} className="border-t align-top">
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    {formatCalendarDate(output.workDate)}
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDecimalString(output.quantity)} {output.unit}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatKES(output.amountMinor)}
                  </td>
                  <td className="px-3 py-2">{tOutput(output.status)}</td>
                  <td className="px-3 py-2">{output.recordedBy.displayName}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{output.shares.length}</td>
                  {canDecideOutputs ? (
                    <td className="px-3 py-2">
                      {output.status === "pending" ? (
                        <span className="flex flex-wrap gap-1">
                          <SubcontractAction
                            path={`/payroll/outputs/${output.id}/approve`}
                            entity="output"
                            body={{ version: output.version }}
                            primary
                            text={{
                              button: t("actions.approveOutput"),
                              title: t("actions.approveOutputTitle", {
                                quantity: output.quantity,
                                unit: output.unit,
                              }),
                              description: t("actions.approveOutputDescription", {
                                amount: formatKES(output.amountMinor),
                              }),
                              confirm: t("actions.approveOutput"),
                            }}
                          />
                          <SubcontractAction
                            path={`/payroll/outputs/${output.id}/reject`}
                            entity="output"
                            body={{ version: output.version }}
                            reason
                            reasonKey="note"
                            destructive
                            text={{
                              button: t("actions.rejectOutput"),
                              title: t("actions.rejectOutputTitle"),
                              description: t("actions.rejectOutputDescription"),
                              confirm: t("actions.rejectOutput"),
                            }}
                          />
                        </span>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </section>
    </div>
  );
}
