import { getTranslations } from "next-intl/server";
import { advancesResponseSchema } from "@pm-buddy/validation";
import { ADVANCE_DISBURSEMENT_METHODS } from "@pm-buddy/types";
import { PayrollAction } from "@/components/payroll/payroll-action";
import { PayrollShell } from "@/components/payroll/payroll-shell";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { loadLive, requireSession } from "@/lib/server-api";

export default async function PayrollAdvancesPage() {
  const path = "/payroll/advances";
  if (!(await requireSession(path))) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive(path, advancesResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const data = result.data;
  const t = await getTranslations("payrollLive");
  return (
    <PayrollShell title={t("advances")}>
      <p role="note">{t("externalPayment")}</p>
      <div className="flex flex-wrap gap-3">
        {data.requestableProjects.map((project) => (
          <PayrollAction
            key={project.id}
            label={t("requestAdvance", { project: project.name })}
            path={`/payroll/projects/${project.id}/advances`}
            request="createAdvanceRequestSchema"
            response="advanceResponseSchema"
            fields={[
              { name: "labourerId", label: t("worker"), type: "worker", projectId: project.id },
              { name: "amountMinor", label: t("amountKes"), type: "money" },
              { name: "reason", label: t("reason"), type: "textarea" },
              { name: "instalmentMinor", label: t("instalment"), type: "money", nullable: true },
              { name: "maxRecoveryPercent", label: t("recoveryPercent"), nullable: true },
            ]}
          />
        ))}
      </div>
      {!data.advances.length ? <p role="status">{t("none")}</p> : null}
      {data.advances.map((advance) => {
        const base = `/payroll/advances/${advance.id}`;
        const body = { version: advance.version };
        return (
          <section
            key={advance.id}
            aria-label={`${advance.labourer.fullName} ${advance.requestedAt}`}
            className="space-y-3 rounded-xl border p-4"
          >
            <h2 className="font-semibold">
              {advance.labourer.workerNo} · {advance.labourer.fullName} · {advance.project.name}
            </h2>
            <p>
              {t(`values.${advance.displayStatus}`)} · {formatKES(advance.amountMinor)} ·{" "}
              {t("outstanding")}: {formatKES(advance.outstandingMinor)}
            </p>
            <p>
              {advance.reason} · {advance.requestedBy.displayName}
            </p>
            {advance.decisionNote ? (
              <p>
                {advance.decidedBy?.displayName} · {advance.decisionNote}
              </p>
            ) : null}
            {advance.disbursement ? (
              <p>
                {t(`values.${advance.disbursement.method}`)} · {advance.disbursement.reference} ·{" "}
                {formatCalendarDate(advance.disbursement.paidOn)} ·{" "}
                {advance.disbursement.evidenceNote}
              </p>
            ) : null}
            {advance.cancellationReason ? <p>{advance.cancellationReason}</p> : null}
            {advance.recoveries.map((recovery) => (
              <p key={recovery.batchId}>
                {formatCalendarDate(recovery.periodStart)} · {formatKES(recovery.amountMinor)} ·{" "}
                {t(`values.${recovery.batchStatus}`)}
              </p>
            ))}
            <div className="flex flex-wrap gap-3">
              {advance.permissions.canDecide ? (
                <>
                  <PayrollAction
                    label={t("approve")}
                    path={`${base}/approve`}
                    request="approveAdvanceRequestSchema"
                    response="advanceResponseSchema"
                    body={body}
                  />
                  <PayrollAction
                    label={t("reject")}
                    path={`${base}/reject`}
                    request="rejectAdvanceRequestSchema"
                    response="advanceResponseSchema"
                    body={body}
                    fields={[{ name: "note", label: t("reviewNote"), type: "textarea" }]}
                  />
                </>
              ) : null}
              {advance.permissions.canDisburse ? (
                <PayrollAction
                  label={t("recordDisbursement")}
                  path={`${base}/disburse`}
                  request="disburseAdvanceRequestSchema"
                  response="advanceResponseSchema"
                  body={body}
                  fields={[
                    {
                      name: "method",
                      label: t("method"),
                      type: "select",
                      value: ADVANCE_DISBURSEMENT_METHODS[0],
                      options: ADVANCE_DISBURSEMENT_METHODS.map((value) => ({
                        value,
                        label: t(`values.${value}`),
                      })),
                    },
                    { name: "reference", label: t("reference") },
                    { name: "paidOn", label: t("paidOn"), type: "date", value: data.today },
                    { name: "evidenceNote", label: t("evidence"), type: "textarea" },
                  ]}
                />
              ) : null}
              {advance.permissions.canCancel ? (
                <PayrollAction
                  label={t("cancelAdvance")}
                  path={`${base}/cancel`}
                  request="cancelAdvanceRequestSchema"
                  response="advanceResponseSchema"
                  body={body}
                  fields={[{ name: "reason", label: t("reason"), type: "textarea" }]}
                />
              ) : null}
            </div>
          </section>
        );
      })}
    </PayrollShell>
  );
}
