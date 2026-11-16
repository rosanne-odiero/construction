import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { payslipResponseSchema } from "@pm-buddy/validation";
import { PayrollShell } from "@/components/payroll/payroll-shell";
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
import { loadLive, requireSession } from "@/lib/server-api";

export default async function PayslipPage({
  params,
}: {
  params: Promise<{ batchId: string; lineId: string }>;
}) {
  const { batchId, lineId } = await params;
  if (![batchId, lineId].every((id) => z.uuid().safeParse(id).success)) notFound();
  const path = `/payroll/batches/${batchId}/lines/${lineId}`;
  if (!(await requireSession(path))) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive(path, payslipResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const { company, project, batch, line } = result.data;
  const t = await getTranslations("payrollLive");
  return (
    <PayrollShell title={t("payslip")}>
      <Link className="underline" href={`/payroll/batches/${batchId}`}>
        {t("batch")}
      </Link>
      <p>
        {company} · {project.name}
      </p>
      <h2 className="text-lg font-semibold">
        {line.labourer.workerNo} · {line.labourer.fullName}
      </h2>
      <p>
        {formatCalendarDate(batch.periodStart)} – {formatCalendarDate(batch.periodEnd)} ·{" "}
        {t(`values.${batch.status}`)}
      </p>
      <p role="note">{t("notPaid")}</p>
      {batch.unverifiedRules ? <p role="note">{t("unverified")}</p> : null}
      <div className="overflow-x-auto">
        <Table aria-label={t("earnings")}>
          <TableHeader>
            <TableRow>
              {(
                ["earnings", "date", "quantity", "rate", "multiplier", "amount", "taxable"] as const
              ).map((key) => (
                <TableHead key={key}>{t(key)}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {line.earnings.map((earning, index) => (
              <TableRow key={index}>
                <TableCell>{earning.description}</TableCell>
                <TableCell>{earning.date ? formatCalendarDate(earning.date) : "—"}</TableCell>
                <TableCell>
                  {earning.quantity} {earning.unit}
                </TableCell>
                <TableCell>
                  {earning.rateMinor === null ? "—" : formatKES(earning.rateMinor)}
                </TableCell>
                <TableCell>{earning.multiplier ?? "—"}</TableCell>
                <TableCell>{formatKES(earning.amountMinor)}</TableCell>
                <TableCell>{t(earning.taxable ? "yes" : "no")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <section className="space-y-2">
        <h2 className="font-semibold">{t("statutory")}</h2>
        <div className="overflow-x-auto">
          <Table aria-label={t("statutory")}>
            <TableHeader>
              <TableRow>
                {(["statutory", "due", "withheld", "shortfall"] as const).map((key) => (
                  <TableHead key={key}>{t(key)}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {line.deductions.map((item) => (
                <TableRow key={item.kind}>
                  <TableCell>{item.kind.toUpperCase()}</TableCell>
                  <TableCell>{formatKES(item.dueMinor)}</TableCell>
                  <TableCell>{formatKES(item.withheldMinor)}</TableCell>
                  <TableCell>{formatKES(item.shortfallMinor)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
      <section className="space-y-2">
        <h2 className="font-semibold">{t("advances")}</h2>
        {line.recoveries.map((item) => (
          <p key={item.advanceId}>
            {formatKES(item.amountMinor)} · {t("outstanding")}:{" "}
            {formatKES(item.outstandingAfterMinor)}
          </p>
        ))}
        <p>
          {t("outstanding")}: {formatKES(line.advanceBalanceMinor)}
        </p>
      </section>
      <p className="text-xl font-semibold">
        {t("netMinor")}: {formatKES(line.netMinor)}
      </p>
      <section className="space-y-2">
        <h2 className="font-semibold">{t("employerCostMinor")}</h2>
        {line.employerCosts.map((item) => (
          <p key={item.kind}>
            {t(`values.${item.kind}`)}: {formatKES(item.amountMinor)}
          </p>
        ))}
      </section>
      <section className="space-y-2">
        <h2 className="font-semibold">
          {t("monthToDate")}: {line.monthToDate.statutoryMonth}
        </h2>
        {(
          [
            "priorBaseMinor",
            "cumulativeBaseMinor",
            "taxablePayMinor",
            "payeBeforeReliefMinor",
            "personalReliefMinor",
          ] as const
        ).map((key) => (
          <p key={key}>
            {t(key)}: {formatKES(line.monthToDate[key])}
          </p>
        ))}
      </section>
    </PayrollShell>
  );
}
