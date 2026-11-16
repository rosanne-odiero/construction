import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { batchApprovalResponseSchema, batchDetailResponseSchema } from "@pm-buddy/validation";
import { PayrollShell } from "@/components/payroll/payroll-shell";
import { BatchActions } from "@/components/payroll/batch-actions";
import {
  BatchApproval,
  BatchTimeline,
  DecisionHistory,
} from "@/components/payroll/batch-approval";
import { WaiverBanner } from "@/components/payroll/waiver-banner";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { loadLive, requireSession, serverApi } from "@/lib/server-api";
import { hours } from "@/lib/payroll";
import { isSettlementStatus } from "@/lib/payouts";

export default async function BatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  if (!z.uuid().safeParse(batchId).success) notFound();
  const path = `/payroll/batches/${batchId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive(path, batchDetailResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const data = result.data;
  const { batch, totals } = data;
  // D4.3: who decided what, and what approval would bind (absent for callers who cannot see it).
  const approval = await serverApi(`${path}/approval`, batchApprovalResponseSchema);
  const t = await getTranslations("payrollLive");
  const tPayouts = await getTranslations("payouts.approval");
  return (
    <PayrollShell title={t("batch")}>
      <Link className="underline" href={`/payroll/projects/${data.project.id}`}>
        {data.project.name}
      </Link>
      {approval.ok ? (
        <WaiverBanner
          waiver={approval.data.waiver}
          approvedUnderWaiver={approval.data.approvedUnderWaiver}
        />
      ) : null}
      <p>
        {formatCalendarDate(batch.periodStart)} – {formatCalendarDate(batch.periodEnd)} ·{" "}
        {t(`values.${batch.status}`)} · {t("payDate")}: {formatCalendarDate(batch.payDate)}
      </p>
      {batch.unverifiedRules ? <p role="note">{t("unverified")}</p> : null}
      {batch.cancellationReason ? (
        <p>
          {t("reason")}: {batch.cancellationReason}
        </p>
      ) : null}
      {data.snapshot.verified !== null ? (
        <p role={data.snapshot.verified ? "status" : "alert"}>
          {t(data.snapshot.verified ? "snapshotValid" : "snapshotInvalid")}
        </p>
      ) : null}
      <p className="break-all font-mono text-xs">
        {t("digest")}: {batch.digest}
      </p>
      {approval.ok ? (
        <BatchTimeline batch={approval.data.batch} decisions={approval.data.decisions} />
      ) : null}
      {isSettlementStatus(batch.status) ? (
        <p>
          <Link
            className="font-medium underline underline-offset-4"
            href={`${path}/payouts`}
          >
            {tPayouts("openPayouts")}
          </Link>
        </p>
      ) : null}
      <BatchActions data={data} />
      {approval.ok ? <BatchApproval approval={approval.data} userId={session.user.id} /> : null}
      <dl className="grid gap-3 sm:grid-cols-4">
        {(["grossMinor", "totalDeductionsMinor", "netMinor", "employerCostMinor"] as const).map(
          (key) => (
            <div className="rounded-lg border p-3" key={key}>
              <dt>{t(key)}</dt>
              <dd className="font-semibold">{formatKES(totals[key])}</dd>
            </div>
          ),
        )}
        {totals.broughtForwardMinor ? (
          <div className="rounded-lg border p-3">
            <dt>{t("broughtForward")}</dt>
            <dd className="font-semibold">{formatKES(totals.broughtForwardMinor)}</dd>
          </div>
        ) : null}
      </dl>
      {totals.shortfallMinor > 0 ? (
        <p role="alert">
          {t("shortfall")}: {formatKES(totals.shortfallMinor)}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <Table aria-label={t("register")}>
          <TableHeader>
            <TableRow>
              {(
                [
                  "worker",
                  "days",
                  "normalHours",
                  "overtime",
                  "grossMinor",
                  "statutory",
                  "advances",
                  "netMinor",
                  "warnings",
                ] as const
              ).map((key) => (
                <TableHead key={key}>{t(key)}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.lines.map((line) => (
              <TableRow key={line.id}>
                <TableCell>
                  <Link className="underline" href={`${path}/lines/${line.id}`}>
                    {line.labourer.workerNo} · {line.labourer.fullName}
                  </Link>
                </TableCell>
                <TableCell>{line.days}</TableCell>
                <TableCell>{hours(line.normalMinutes)}</TableCell>
                <TableCell>
                  {hours(Object.values(line.overtimeMinutes).reduce((a, b) => a + b, 0))}
                </TableCell>
                <TableCell>{formatKES(line.grossMinor)}</TableCell>
                <TableCell>{formatKES(line.statutoryWithheldMinor)}</TableCell>
                <TableCell>{formatKES(line.advanceRecoveryMinor)}</TableCell>
                <TableCell>
                  {formatKES(line.netMinor)}
                  {line.broughtForwardMinor ? (
                    <span className="block text-xs text-muted-foreground">
                      {t("includesBroughtForward", {
                        amount: formatKES(line.broughtForwardMinor),
                      })}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  {line.warnings.map((warning, index) => (
                    <p key={`${warning.code}-${index}`}>{t(`warningsList.${warning.code}`)}</p>
                  ))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {!data.lines.length ? <p role="status">{t("emptyBatch")}</p> : null}
      <section className="space-y-2">
        <h2 className="font-semibold">{t("excluded")}</h2>
        {data.exclusions.map((item) => (
          <p key={`${item.sourceKind}-${item.sourceId}`}>
            {item.labourer?.fullName ?? item.sourceId} ·{" "}
            {item.date ? formatCalendarDate(item.date) : ""} · {t(`exclusions.${item.reason}`)}
          </p>
        ))}
        {data.unapprovedPeriods.map((period) => (
          <p key={period.id}>
            <Link className="underline" href={`/attendance/periods/${period.id}`}>
              {t("unapproved")}: {formatCalendarDate(period.startDate)} –{" "}
              {formatCalendarDate(period.endDate)}
            </Link>
          </p>
        ))}
        <p>{t("pendingOutputs", { count: data.pendingOutputs })}</p>
      </section>
      {approval.ok ? <DecisionHistory decisions={approval.data.decisions} /> : null}
      <section className="space-y-2">
        <h2 className="font-semibold">{t("rules")}</h2>
        {data.rules.map((rule) => (
          <p key={rule.id}>
            <Link className="underline" href="/payroll/rules">
              {rule.kind.toUpperCase()} · {formatCalendarDate(rule.effectiveFrom)} ·{" "}
              {t(`values.${rule.status}`)}
            </Link>
          </p>
        ))}
      </section>
    </PayrollShell>
  );
}
