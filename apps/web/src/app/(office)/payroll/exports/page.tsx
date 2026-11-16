import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { exportQuerySchema, exportSummaryResponseSchema } from "@pm-buddy/validation";
import { nairobiDate } from "@pm-buddy/domain";
import { PayrollShell } from "@/components/payroll/payroll-shell";
import { ExportDownload } from "@/components/payroll/export-download";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatKES } from "@/lib/format";
import { loadLive, requireSession } from "@/lib/server-api";

export default async function PayrollExportsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const path = "/payroll/exports";
  if (!(await requireSession(path))) return <LiveUnavailable retryHref={path} />;
  const query = await searchParams;
  const parsed = exportQuerySchema.safeParse({ month: query.month ?? nairobiDate().slice(0, 7) });
  const t = await getTranslations("payrollLive");
  if (!parsed.success)
    return (
      <PayrollShell title={t("exports")}>
        <p role="alert">{t("invalidMonth")}</p>
        <Link className="underline" href={path}>
          {t("exports")}
        </Link>
      </PayrollShell>
    );
  const result = await loadLive(
    `${path}?month=${parsed.data.month}`,
    exportSummaryResponseSchema,
    `${path}?month=${parsed.data.month}`,
  );
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const data = result.data;
  return (
    <PayrollShell title={t("exports")}>
      <form className="flex flex-wrap items-end gap-3">
        <label htmlFor="export-month">
          {t("month")}
          <Input id="export-month" type="month" name="month" defaultValue={data.month} required />
        </label>
        <Button>{t("show")}</Button>
      </form>
      <p>{t("exportCounts", { employees: data.employees, batches: data.batches.length })}</p>
      <p>
        {t("grossMinor")}: {formatKES(data.totals.grossMinor)}
      </p>
      <p>{t("missingIdentifiers", data.missingIdentifiers)}</p>
      <p>
        {t("shortfall")}: {formatKES(data.totals.shortfallMinor)}
      </p>
      {data.unverified ? <p role="note">{t("unverified")}</p> : null}
      {data.blocked ? <p role="alert">{t("filingBlocked")}</p> : null}
      <ExportDownload
        month={data.month}
        blocked={!data.canExport || data.blocked || !data.batches.length}
      />
      {data.batches.map((batch) => (
        <p key={batch.id}>
          <Link className="underline" href={`/payroll/batches/${batch.id}`}>
            {batch.project.name} · {batch.periodStart} – {batch.periodEnd}
          </Link>
        </p>
      ))}
    </PayrollShell>
  );
}
