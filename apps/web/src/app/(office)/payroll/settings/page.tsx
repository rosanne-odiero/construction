import { getTranslations } from "next-intl/server";
import { payrollSettingsResponseSchema } from "@pm-buddy/validation";
import { MINIMUM_WAGE_AREAS, PAY_FREQUENCIES } from "@pm-buddy/types";
import { PayrollAction } from "@/components/payroll/payroll-action";
import { PayrollShell } from "@/components/payroll/payroll-shell";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { loadLive, requireSession } from "@/lib/server-api";

export default async function PayrollSettingsPage() {
  const path = "/payroll/settings";
  if (!(await requireSession(path))) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive(path, payrollSettingsResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const { settings, calendars, canConfigure } = result.data;
  const t = await getTranslations("payrollLive");
  return (
    <PayrollShell title={t("settings")}>
      <p>
        {t("advanceMax")}: {formatKES(settings.advanceMaxMinor)} · {t("outstandingMax")}:{" "}
        {formatKES(settings.advanceMaxOutstandingMinor)} · {t("recoveryPercent")}:{" "}
        {settings.recoveryMaxPercent}%
      </p>
      {canConfigure ? (
        <PayrollAction
          label={t("editLimits")}
          path="/payroll/settings"
          method="PUT"
          request="updatePayrollSettingsRequestSchema"
          response="payrollSettingsResponseSchema"
          body={{ version: settings.version }}
          fields={[
            {
              name: "advanceMaxMinor",
              label: t("advanceMax"),
              type: "money",
              value: String(settings.advanceMaxMinor / 100),
            },
            {
              name: "advanceMaxOutstandingMinor",
              label: t("outstandingMax"),
              type: "money",
              value: String(settings.advanceMaxOutstandingMinor / 100),
            },
            {
              name: "recoveryMaxPercent",
              label: t("recoveryPercent"),
              value: settings.recoveryMaxPercent,
            },
          ]}
        />
      ) : null}
      {calendars.map(({ project, calendar, canEdit }) => (
        <section
          key={project.id}
          aria-label={project.name}
          className="space-y-3 rounded-xl border p-4"
        >
          <h2 className="font-semibold">
            {project.code} · {project.name}
          </h2>
          <p>
            {t(`values.${calendar.frequency}`)} · {formatCalendarDate(calendar.anchorDate)} ·{" "}
            {t("paydayOffset")}: {calendar.paydayOffsetDays}
          </p>
          {canEdit ? (
            <PayrollAction
              label={t("editCalendar")}
              path={`/payroll/projects/${project.id}/calendar`}
              method="PUT"
              request="updatePayCalendarRequestSchema"
              response="payCalendarResponseSchema"
              body={{ version: calendar.version }}
              fields={[
                {
                  name: "frequency",
                  label: t("frequency"),
                  type: "select",
                  value: calendar.frequency,
                  options: PAY_FREQUENCIES.map((value) => ({ value, label: t(`values.${value}`) })),
                },
                {
                  name: "anchorDate",
                  label: t("anchorDate"),
                  type: "date",
                  value: calendar.anchorDate,
                },
                {
                  name: "paydayOffsetDays",
                  label: t("paydayOffset"),
                  type: "number",
                  value: String(calendar.paydayOffsetDays),
                },
                {
                  name: "minimumWageArea",
                  label: t("area"),
                  type: "select",
                  nullable: true,
                  value: calendar.minimumWageArea ?? "",
                  options: [
                    { value: "", label: t("none") },
                    ...MINIMUM_WAGE_AREAS.map((value) => ({ value, label: t(`values.${value}`) })),
                  ],
                },
              ]}
            />
          ) : null}
        </section>
      ))}
    </PayrollShell>
  );
}
