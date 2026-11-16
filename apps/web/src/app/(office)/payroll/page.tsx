import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { payrollOverviewResponseSchema } from "@pm-buddy/validation";
import { PayrollShell } from "@/components/payroll/payroll-shell";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { formatCalendarDate } from "@/lib/format";
import { loadLive, requireSession } from "@/lib/server-api";

export default async function PayrollPage() {
  const path = "/payroll";
  if (!(await requireSession(path))) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive("/payroll/overview", payrollOverviewResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("payrollLive");
  return (
    <PayrollShell title={t("title")}>
      {!result.data.projects.length ? <p role="status">{t("noProjects")}</p> : null}
      <div className="grid gap-4 md:grid-cols-2">
        {result.data.projects.map(({ project, calendar, current, drafts, submitted }) => (
          <section
            key={project.id}
            aria-label={project.name}
            className="space-y-3 rounded-xl border p-4"
          >
            <h2 className="text-lg font-semibold">
              <Link className="underline" href={`/payroll/projects/${project.id}`}>
                {project.code} · {project.name}
              </Link>
            </h2>
            <p>
              {t(`values.${calendar.frequency}`)} · {formatCalendarDate(current.startDate)} –{" "}
              {formatCalendarDate(current.endDate)}
            </p>
            <p>{t("batchCounts", { drafts, submitted })}</p>
          </section>
        ))}
      </div>
    </PayrollShell>
  );
}
