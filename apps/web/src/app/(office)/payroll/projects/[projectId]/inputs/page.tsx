import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { z } from "zod";
import { allowancesResponseSchema, outputsResponseSchema } from "@pm-buddy/validation";
import { ALLOWANCE_BASES } from "@pm-buddy/types";
import { PayrollAction } from "@/components/payroll/payroll-action";
import { PayrollShell } from "@/components/payroll/payroll-shell";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { loadLive, requireSession } from "@/lib/server-api";

export default async function PayrollInputsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!z.uuid().safeParse(projectId).success) notFound();
  const base = `/payroll/projects/${projectId}`;
  const path = `${base}/inputs`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [allowances, outputs] = await Promise.all([
    loadLive(`${base}/allowances`, allowancesResponseSchema, path),
    loadLive(`${base}/outputs`, outputsResponseSchema, path),
  ]);
  if (!outputs.ok)
    return outputs.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("payrollLive");
  const locale = await getLocale();
  const a = allowances.ok ? allowances.data : null;
  const o = outputs.data;
  return (
    <PayrollShell title={t("inputs")}>
      <Link href={`/projects/${projectId}`} className="underline">
        {o.project.name}
      </Link>
      <section className="space-y-3">
        <h2 className="font-semibold">{t("allowances")}</h2>
        {!allowances.ok ? (
          allowances.status === 403 ? (
            <LiveForbidden />
          ) : (
            <LiveUnavailable retryHref={path} />
          )
        ) : null}
        {a?.canManage ? (
          <PayrollAction
            label={t("addAllowance")}
            path={`${base}/allowances`}
            request="createAllowanceRequestSchema"
            response="allowanceResponseSchema"
            body={{ taxable: true, tradeId: null, labourerId: null }}
            fields={[
              { name: "code", label: t("code") },
              { name: "nameEn", label: t("nameEn") },
              { name: "nameSw", label: t("nameSw") },
              {
                name: "basis",
                label: t("basis"),
                type: "select",
                value: ALLOWANCE_BASES[0],
                options: ALLOWANCE_BASES.map((value) => ({ value, label: t(`values.${value}`) })),
              },
              { name: "amountMinor", label: t("amountKes"), type: "money" },
              { name: "taxable", label: t("taxable"), type: "boolean", value: "true" },
              {
                name: "tradeId",
                label: t("trade"),
                type: "select",
                nullable: true,
                options: [
                  { value: "", label: t("allTrades") },
                  ...a.trades.map((trade) => ({
                    value: trade.id,
                    label: locale === "sw" ? trade.nameSw : trade.nameEn,
                  })),
                ],
              },
              {
                name: "labourerId",
                label: t("workerOptional"),
                type: "worker",
                projectId,
                nullable: true,
              },
              { name: "effectiveFrom", label: t("effectiveFrom"), type: "date", value: a.today },
            ]}
          />
        ) : null}
        {a?.allowances.map((allowance) => (
          <div key={allowance.id} className="space-y-2 rounded-lg border p-3">
            <p>
              {locale === "sw" ? allowance.nameSw : allowance.nameEn} ·{" "}
              {formatKES(allowance.amountMinor)} · {t(`values.${allowance.basis}`)} ·{" "}
              {t(allowance.taxable ? "taxable" : "nonTaxable")}
            </p>
            <p>
              {allowance.labourer?.fullName ??
                (allowance.trade
                  ? locale === "sw"
                    ? allowance.trade.nameSw
                    : allowance.trade.nameEn
                  : t("allWorkers"))}{" "}
              · {formatCalendarDate(allowance.effectiveFrom)} –{" "}
              {allowance.endedOn ? formatCalendarDate(allowance.endedOn) : t("ongoing")}
            </p>
            {a.canManage && !allowance.endedOn ? (
              <PayrollAction
                label={t("endAllowance")}
                path={`/payroll/allowances/${allowance.id}/end`}
                request="endAllowanceRequestSchema"
                response="allowanceResponseSchema"
                fields={[{ name: "endedOn", label: t("endedOn"), type: "date", value: a.today }]}
              />
            ) : null}
          </div>
        ))}
        {a && !a.allowances.length ? <p>{t("none")}</p> : null}
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">{t("outputs")}</h2>
        {o.permissions.canRecord ? (
          <PayrollAction
            label={t("addOutput")}
            path={`${base}/outputs`}
            request="createOutputRequestSchema"
            response="outputResponseSchema"
            body={{ bqItemId: null }}
            fields={[
              { name: "workDate", label: t("date"), type: "date", value: o.today },
              {
                name: "labourerId",
                label: t("workerOptional"),
                type: "worker",
                projectId,
                nullable: true,
              },
              {
                name: "gangId",
                label: t("gang"),
                type: "select",
                nullable: true,
                options: [
                  { value: "", label: t("none") },
                  ...o.gangs.map((gang) => ({
                    value: gang.id,
                    label: `${gang.name} (${gang.members})`,
                  })),
                ],
              },
              { name: "description", label: t("outputDescription") },
              { name: "unit", label: t("unit") },
              { name: "quantity", label: t("quantity") },
              { name: "rateMinor", label: t("rateKes"), type: "money" },
            ]}
          />
        ) : null}
        {o.outputs.map((output) => (
          <div key={output.id} className="space-y-2 rounded-lg border p-3">
            <p>
              {formatCalendarDate(output.workDate)} · {output.description} ·{" "}
              {output.labourer?.fullName ?? output.gang?.name}
              {output.job ? ` · ${t("job", { code: output.job.code })}` : null}
            </p>
            <p>
              {output.quantity} {output.unit} × {formatKES(output.rateMinor)} ={" "}
              {formatKES(output.amountMinor)} · {t(`values.${output.status}`)}
            </p>
            {output.decisionNote ? <p>{output.decisionNote}</p> : null}
            {output.shares.map((share) => (
              <p key={share.id}>
                {share.labourer.fullName} · {formatKES(share.amountMinor)}
              </p>
            ))}
            {o.permissions.canDecide &&
            output.status === "pending" &&
            output.recordedBy.id !== session.user.id ? (
              <div className="flex flex-wrap gap-3">
                <PayrollAction
                  label={t("approve")}
                  path={`/payroll/outputs/${output.id}/approve`}
                  request="approveOutputRequestSchema"
                  response="outputResponseSchema"
                  body={{ version: output.version }}
                />
                <PayrollAction
                  label={t("reject")}
                  path={`/payroll/outputs/${output.id}/reject`}
                  request="rejectOutputRequestSchema"
                  response="outputResponseSchema"
                  body={{ version: output.version }}
                  fields={[{ name: "note", label: t("reviewNote"), type: "textarea" }]}
                />
              </div>
            ) : null}
          </div>
        ))}
        {!o.outputs.length ? <p>{t("none")}</p> : null}
      </section>
    </PayrollShell>
  );
}
