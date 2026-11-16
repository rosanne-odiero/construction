import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { projectPayrollResponseSchema } from "@pm-buddy/validation";
import { z } from "zod";
import { PayrollAction } from "@/components/payroll/payroll-action";
import { PayrollShell } from "@/components/payroll/payroll-shell";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { loadLive, requireSession } from "@/lib/server-api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default async function ProjectPayrollPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!z.uuid().safeParse(projectId).success) notFound();
  const path = `/payroll/projects/${projectId}`;
  if (!(await requireSession(path))) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive(path, projectPayrollResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const { project, periods, batches, permissions } = result.data;
  const t = await getTranslations("payrollLive");
  return (
    <PayrollShell title={project.name}>
      <Link href={`${path}/inputs`} className="underline">
        {t("inputs")}
      </Link>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("periods")}</h2>
        {permissions.canPrepare ? (
          <PayrollAction
            label={t("build")}
            path={`${path}/batches`}
            request="createBatchRequestSchema"
            response="batchDetailResponseSchema"
            destination="batch"
            fields={[
              {
                name: "periodStart",
                label: t("periodStart"),
                type: "date",
                value: periods[0]?.startDate,
              },
            ]}
          />
        ) : null}
        <div className="overflow-x-auto">
          <Table aria-label={t("periods")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("period")}</TableHead>
                <TableHead>{t("payDate")}</TableHead>
                <TableHead>{t("timesheets")}</TableHead>
                <TableHead>{t("batch")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {periods.map((period) => (
                <TableRow key={period.startDate}>
                  <TableCell>
                    {formatCalendarDate(period.startDate)} – {formatCalendarDate(period.endDate)}
                  </TableCell>
                  <TableCell>{formatCalendarDate(period.payDate)}</TableCell>
                  <TableCell>{t("timesheetCounts", period.timesheetPeriods)}</TableCell>
                  <TableCell>
                    {period.batch ? (
                      <Link className="underline" href={`/payroll/batches/${period.batch.id}`}>
                        {t(`values.${period.batch.status}`)}
                      </Link>
                    ) : permissions.canPrepare ? (
                      <PayrollAction
                        label={t("build")}
                        path={`${path}/batches`}
                        request="createBatchRequestSchema"
                        response="batchDetailResponseSchema"
                        body={{ periodStart: period.startDate }}
                        destination="batch"
                      />
                    ) : (
                      t("none")
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("batches")}</h2>
        {batches.map((batch) => (
          <p key={batch.id}>
            <Link className="underline" href={`/payroll/batches/${batch.id}`}>
              {formatCalendarDate(batch.periodStart)} – {formatCalendarDate(batch.periodEnd)} ·{" "}
              {t(`values.${batch.status}`)} · {formatKES(batch.netMinor)}
            </Link>
          </p>
        ))}
        {!batches.length ? <p>{t("none")}</p> : null}
      </section>
    </PayrollShell>
  );
}
