import { getLocale, getTranslations } from "next-intl/server";
import { formatClock } from "@pm-buddy/domain";
import { attendanceSettingsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { AttendanceNav } from "@/components/attendance/attendance-nav";
import {
  AddHolidayButton,
  AddRuleButton,
  DeleteHolidayButton,
  DeleteRuleButton,
  InstallButton,
  PeriodSettingsForm,
} from "@/components/attendance/settings-actions";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { hours } from "@/lib/attendance";
import { formatCalendarDate } from "@/lib/format";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("attendanceLive.settings");
  return { title: t("title") };
}

/**
 * Timesheet rules, period cut-off and the public holiday calendar (D3.3 web slice). Rule versions
 * are effective-dated (company default plus project overrides) and never change approved
 * timesheets; the seeded values are demonstration values awaiting compliance review.
 */
export default async function AttendanceSettingsPage() {
  const path = "/attendance/settings";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive("/attendance/settings", attendanceSettingsResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const settings = result.data;
  const { rules, holidays, periodSettings, canConfigure, today } = settings;
  const t = await getTranslations("attendanceLive");
  const locale = await getLocale();
  const canAddRules = canConfigure || settings.ruleProjects.length > 0;
  const hasCompanyRule = rules.some((rule) => rule.projectId === null);
  const years = [...new Set(holidays.map((holiday) => holiday.date.slice(0, 4)))].sort();

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{t("live")}</StatusBadge>}
        title={t("settings.title")}
        description={t("settings.description")}
      />
      <AttendanceNav current="settings" />

      <section aria-labelledby="period-settings" className="space-y-3">
        <h2 id="period-settings" className="text-lg font-semibold">
          {t("settings.periods.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("settings.periods.description", {
            weekEnd: t(`weekdays.d${periodSettings.weekEndsOn}`),
            cutoff: periodSettings.cutoffTime,
            payday: t(`weekdays.d${periodSettings.paydayWeekday}`),
          })}
        </p>
        {canConfigure ? <PeriodSettingsForm settings={periodSettings} /> : null}
      </section>

      <section aria-labelledby="rules-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="space-y-1">
            <h2 id="rules-title" className="text-lg font-semibold">
              {t("settings.rules.title")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("settings.rules.description")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canConfigure && !hasCompanyRule ? <InstallButton kind="rule" /> : null}
            {canAddRules ? <AddRuleButton settings={settings} today={today} /> : null}
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableCaption className="sr-only">{t("settings.rules.title")}</TableCaption>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>{t("settings.rules.columns.scope")}</TableHead>
                <TableHead>{t("settings.rules.columns.effective")}</TableHead>
                <TableHead>{t("settings.rules.columns.day")}</TableHead>
                <TableHead>{t("settings.rules.columns.overtime")}</TableHead>
                <TableHead>{t("settings.rules.columns.compliance")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("settings.rules.columns.actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell className="font-medium">
                    {rule.projectCode ?? t("settings.rules.company")}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {formatCalendarDate(rule.effectiveFrom)}
                    {rule.effectiveTo ? ` – ${formatCalendarDate(rule.effectiveTo)}` : null}
                    <span className="mt-1 block">
                      {rule.inForce ? (
                        <StatusBadge tone="success">{t("settings.rules.inForce")}</StatusBadge>
                      ) : rule.scheduled ? (
                        <StatusBadge tone="info">{t("settings.rules.scheduled")}</StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">{t("settings.rules.superseded")}</StatusBadge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="min-w-56 text-sm whitespace-normal">
                    {t("settings.rules.dayText", {
                      normal: hours(rule.normalMinutes),
                      start: formatClock(rule.dayStartMinutes),
                      grace: rule.lateGraceMinutes,
                      breakMinutes: rule.defaultBreakMinutes,
                      breakAfter: hours(rule.breakAfterMinutes),
                      halfDay: hours(rule.halfDayThresholdMinutes),
                      max: hours(rule.maxPlausibleMinutes),
                    })}
                    <span className="block text-xs text-muted-foreground">
                      {t("settings.rules.restDays", {
                        days: rule.restDays.map((day) => t(`weekdays.d${day}`)).join(", ") || "—",
                      })}
                    </span>
                  </TableCell>
                  <TableCell className="min-w-36 text-sm whitespace-normal tabular-nums">
                    {t("settings.rules.overtimeText", {
                      weekday: rule.otWeekdayMultiplier,
                      rest: rule.otRestDayMultiplier,
                      holiday: rule.otHolidayMultiplier,
                    })}
                  </TableCell>
                  <TableCell className="min-w-48 text-sm whitespace-normal">
                    <StatusBadge
                      tone={rule.complianceStatus === "approved" ? "success" : "warning"}
                    >
                      {t(`compliance.${rule.complianceStatus}`)}
                    </StatusBadge>
                    <span className="mt-1 block max-w-xs text-xs text-muted-foreground">
                      {rule.sourceReference}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    {rule.scheduled && canAddRules ? <DeleteRuleButton rule={rule} /> : null}
                  </TableCell>
                </TableRow>
              ))}
              {rules.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    {t("settings.rules.none")}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </section>

      <section aria-labelledby="holidays-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="space-y-1">
            <h2 id="holidays-title" className="text-lg font-semibold">
              {t("settings.holidays.title")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("settings.holidays.description")}</p>
          </div>
          {canConfigure ? (
            <div className="flex flex-wrap gap-2">
              <InstallButton kind="holidays" />
              <AddHolidayButton />
            </div>
          ) : null}
        </div>
        {years.length === 0 ? (
          <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
            {t("settings.holidays.none")}
          </p>
        ) : null}
        {years.map((year) => (
          <div key={year} className="overflow-x-auto rounded-lg border">
            <Table>
              <TableCaption className="caption-top px-3 py-2 text-left font-medium text-foreground">
                {t("settings.holidays.year", { year })}
              </TableCaption>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead>{t("common.date")}</TableHead>
                  <TableHead>{t("settings.holidays.name")}</TableHead>
                  <TableHead>{t("settings.holidays.kind")}</TableHead>
                  <TableHead>{t("settings.holidays.source")}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t("settings.rules.columns.actions")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {holidays
                  .filter((holiday) => holiday.date.startsWith(year))
                  .map((holiday) => (
                    <TableRow key={holiday.id}>
                      <TableCell className="tabular-nums">
                        {formatCalendarDate(holiday.date)}
                      </TableCell>
                      <TableCell className="font-medium">
                        {locale === "sw" ? holiday.nameSw : holiday.nameEn}
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={holiday.kind === "company" ? "neutral" : "info"}>
                          {t(`settings.holidays.kinds.${holiday.kind}`)}
                        </StatusBadge>
                        {holiday.complianceStatus !== "approved" ? (
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {t(`compliance.${holiday.complianceStatus}`)}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="min-w-48 text-xs whitespace-normal text-muted-foreground">
                        {holiday.source}
                      </TableCell>
                      <TableCell className="text-right">
                        {canConfigure && !holiday.locked ? (
                          <DeleteHolidayButton holiday={holiday} />
                        ) : holiday.locked ? (
                          <span className="text-xs text-muted-foreground">
                            {t("settings.holidays.locked")}
                          </span>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        ))}
      </section>
    </div>
  );
}
