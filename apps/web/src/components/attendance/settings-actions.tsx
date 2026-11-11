"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { formatClock, parseClock, RULE_ISSUES, type RuleIssue } from "@pm-buddy/domain";
import {
  DEMO_TIMESHEET_RULE,
  HOLIDAY_KINDS,
  ISO_WEEKDAYS,
  type HolidayKind,
  type IsoWeekday,
} from "@pm-buddy/types";
import {
  attendanceSettingsResponseSchema,
  createTimesheetRuleRequestSchema,
  holidayResponseSchema,
  messageResponseSchema,
  timesheetRuleResponseSchema,
  type AttendanceSettingsResponse,
  type PublicHoliday,
  type TimesheetRule,
} from "@pm-buddy/validation";
import { ActionDialog, selectClass } from "@/components/labour/action-dialog";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { attendanceCommand } from "@/lib/attendance";
import { calendarInput, parseCalendarInput } from "@/lib/project-input";

const MINUTE_FIELDS = [
  "normalMinutes",
  "defaultBreakMinutes",
  "breakAfterMinutes",
  "lateGraceMinutes",
  "halfDayThresholdMinutes",
  "maxPlausibleMinutes",
] as const;
const MULTIPLIERS = ["otWeekdayMultiplier", "otRestDayMultiplier", "otHolidayMultiplier"] as const;

/** Weekly period end, cut-off time and pay day (config.manage). Existing periods keep dates. */
export function PeriodSettingsForm({
  settings,
}: {
  settings: AttendanceSettingsResponse["periodSettings"];
}) {
  const t = useTranslations("attendanceLive");
  const router = useRouter();
  const problem = useProblemMessage();
  const [weekEndsOn, setWeekEndsOn] = useState(String(settings.weekEndsOn));
  const [cutoffTime, setCutoffTime] = useState(settings.cutoffTime);
  const [paydayWeekday, setPayday] = useState(String(settings.paydayWeekday));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const weekdaySelect = (id: string, value: string, set: (value: string) => void) => (
    <select id={id} value={value} onChange={(e) => set(e.target.value)} className={selectClass}>
      {ISO_WEEKDAYS.map((day) => (
        <option key={day} value={day}>
          {t(`weekdays.d${day}`)}
        </option>
      ))}
    </select>
  );
  return (
    <form
      className="grid gap-3 sm:grid-cols-4 sm:items-end"
      aria-label={t("settings.periods.title")}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setNotice(null);
        try {
          await attendanceCommand(
            "/attendance/settings/periods",
            attendanceSettingsResponseSchema,
            {
              weekEndsOn: Number(weekEndsOn),
              cutoffTime,
              paydayWeekday: Number(paydayWeekday),
              version: settings.version,
            },
            "PUT",
          );
          setNotice({ error: false, text: t("settings.periods.saved") });
          router.refresh();
        } catch (error) {
          setNotice({ error: true, text: problem(error) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field>
        <FieldLabel htmlFor="period-week-end">{t("settings.periods.weekEndsOn")}</FieldLabel>
        {weekdaySelect("period-week-end", weekEndsOn, setWeekEndsOn)}
      </Field>
      <Field>
        <FieldLabel htmlFor="period-cutoff">{t("settings.periods.cutoff")}</FieldLabel>
        <Input
          id="period-cutoff"
          type="time"
          value={cutoffTime}
          onChange={(event) => setCutoffTime(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="period-payday">{t("settings.periods.payday")}</FieldLabel>
        {weekdaySelect("period-payday", paydayWeekday, setPayday)}
      </Field>
      <Button type="submit" disabled={busy || !cutoffTime}>
        {t("settings.periods.save")}
      </Button>
      <p
        role={notice?.error ? "alert" : "status"}
        className={`sm:col-span-4 ${notice?.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}`}
      >
        {notice?.text ?? ""}
      </p>
    </form>
  );
}

/** Adds a rule version for the company or one project, prefilled from the rule in force. */
export function AddRuleButton({
  settings,
  today,
}: {
  settings: AttendanceSettingsResponse;
  today: string;
}) {
  const t = useTranslations("attendanceLive.settings.rules");
  const tl = useTranslations("attendanceLive");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const scopes = [
    ...(settings.canConfigure ? [{ id: "", label: t("company") }] : []),
    ...settings.ruleProjects.map((project) => ({
      id: project.id,
      label: `${project.code} · ${project.name}`,
    })),
  ];
  const base: Omit<TimesheetRule, "id"> | typeof DEMO_TIMESHEET_RULE =
    settings.rules.find((rule) => rule.projectId === null && rule.inForce) ?? DEMO_TIMESHEET_RULE;
  const initial = () => ({
    scope: scopes[0]?.id ?? "",
    effectiveFrom: calendarInput(today),
    dayStart: formatClock(base.dayStartMinutes),
    minutes: Object.fromEntries(MINUTE_FIELDS.map((key) => [key, String(base[key])])) as Record<
      (typeof MINUTE_FIELDS)[number],
      string
    >,
    multipliers: Object.fromEntries(MULTIPLIERS.map((key) => [key, base[key]])) as Record<
      (typeof MULTIPLIERS)[number],
      string
    >,
    restDays: new Set<number>(base.restDays),
    source: "",
  });
  const [form, setForm] = useState(initial);
  if (scopes.length === 0) return null;
  const effectiveFrom = parseCalendarInput(form.effectiveFrom);
  const request = {
    projectId: form.scope || null,
    effectiveFrom: effectiveFrom ?? "",
    dayStartMinutes: parseClock(form.dayStart) ?? -1,
    ...Object.fromEntries(MINUTE_FIELDS.map((key) => [key, Number(form.minutes[key])])),
    restDays: [...form.restDays].sort() as IsoWeekday[],
    ...form.multipliers,
    sourceReference: form.source.trim(),
  };
  const parsed = createTimesheetRuleRequestSchema.safeParse(request);
  const issues = parsed.success
    ? []
    : [...new Set(parsed.error.issues.map((issue) => issue.message))];
  return (
    <>
      <Button
        onClick={() => {
          setForm(initial());
          setOpen(true);
        }}
      >
        <Plus aria-hidden /> {t("add")}
      </Button>
      <ActionDialog
        id="add-rule"
        open={open}
        onOpenChange={setOpen}
        title={t("addTitle")}
        description={t("addDescription")}
        submitLabel={t("addSubmit")}
        submitDisabled={!parsed.success}
        onSubmit={async () => {
          await attendanceCommand("/attendance/rules", timesheetRuleResponseSchema, request);
          router.refresh();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="rule-scope">{t("scope")}</FieldLabel>
            <select
              id="rule-scope"
              value={form.scope}
              onChange={(event) => setForm({ ...form, scope: event.target.value })}
              className={selectClass}
            >
              {scopes.map((scope) => (
                <option key={scope.id} value={scope.id}>
                  {scope.label}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="rule-from">{t("effectiveFrom")}</FieldLabel>
            <Input
              id="rule-from"
              value={form.effectiveFrom}
              placeholder="DD/MM/YYYY"
              inputMode="numeric"
              aria-invalid={effectiveFrom ? undefined : true}
              onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="rule-start">{t("fields.dayStart")}</FieldLabel>
            <Input
              id="rule-start"
              type="time"
              value={form.dayStart}
              onChange={(event) => setForm({ ...form, dayStart: event.target.value })}
            />
          </Field>
          {MINUTE_FIELDS.map((key) => (
            <Field key={key}>
              <FieldLabel htmlFor={`rule-${key}`}>{t(`fields.${key}`)}</FieldLabel>
              <Input
                id={`rule-${key}`}
                inputMode="numeric"
                value={form.minutes[key]}
                onChange={(event) =>
                  setForm({ ...form, minutes: { ...form.minutes, [key]: event.target.value } })
                }
              />
            </Field>
          ))}
          {MULTIPLIERS.map((key) => (
            <Field key={key}>
              <FieldLabel htmlFor={`rule-${key}`}>{t(`fields.${key}`)}</FieldLabel>
              <Input
                id={`rule-${key}`}
                inputMode="decimal"
                value={form.multipliers[key]}
                onChange={(event) =>
                  setForm({
                    ...form,
                    multipliers: { ...form.multipliers, [key]: event.target.value },
                  })
                }
              />
            </Field>
          ))}
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("fields.restDays")}</legend>
          <div className="flex flex-wrap gap-3">
            {ISO_WEEKDAYS.map((day) => (
              <label key={day} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  checked={form.restDays.has(day)}
                  onCheckedChange={(checked) => {
                    const next = new Set(form.restDays);
                    if (checked === true) next.add(day);
                    else next.delete(day);
                    setForm({ ...form, restDays: next });
                  }}
                />
                {tl(`weekdays.d${day}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <Field>
          <FieldLabel htmlFor="rule-source">{t("fields.source")}</FieldLabel>
          <Input
            id="rule-source"
            value={form.source}
            maxLength={300}
            onChange={(event) => setForm({ ...form, source: event.target.value })}
            aria-describedby="rule-source-hint"
          />
          <FieldDescription id="rule-source-hint">{t("sourceHint")}</FieldDescription>
        </Field>
        {issues.length > 0 && form.source.trim().length >= 3 ? (
          <ul className="list-disc pl-5 text-sm text-destructive">
            {issues.map((issue) => (
              <li key={issue}>{ruleIssueText(issue, t)}</li>
            ))}
          </ul>
        ) : null}
      </ActionDialog>
    </>
  );
}

type RulesT = ReturnType<typeof useTranslations<"attendanceLive.settings.rules">>;
function ruleIssueText(issue: string, t: RulesT): string {
  return (RULE_ISSUES as readonly string[]).includes(issue)
    ? t(`issues.${issue as RuleIssue}`)
    : t("issues.invalid");
}

/** Cancels a rule version that has not started (`scheduled`). */
export function DeleteRuleButton({ rule }: { rule: TimesheetRule }) {
  const t = useTranslations("attendanceLive.settings.rules");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Trash2 aria-hidden /> {t("cancel")}
      </Button>
      <ActionDialog
        id={`delete-rule-${rule.id}`}
        open={open}
        onOpenChange={setOpen}
        title={t("cancelTitle")}
        description={t("cancelDescription")}
        submitLabel={t("cancel")}
        destructive
        onSubmit={async () => {
          await attendanceCommand(
            `/attendance/rules/${rule.id}`,
            messageResponseSchema,
            {},
            "DELETE",
          );
          router.refresh();
        }}
      >
        {null}
      </ActionDialog>
    </>
  );
}

/** A one-click command (install the demo rule or the Kenyan holidays) with its outcome. */
export function InstallButton({ kind }: { kind: "rule" | "holidays" }) {
  const t = useTranslations("attendanceLive.settings");
  const router = useRouter();
  const problem = useProblemMessage();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setFailure(null);
          try {
            await attendanceCommand(
              kind === "rule" ? "/attendance/rules/defaults" : "/attendance/holidays/defaults",
              attendanceSettingsResponseSchema,
              {},
            );
            router.refresh();
          } catch (error) {
            setFailure(problem(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        {kind === "rule" ? t("rules.installDemo") : t("holidays.install")}
      </Button>
      {failure ? (
        <span role="alert" className="text-sm text-destructive">
          {failure}
        </span>
      ) : null}
    </span>
  );
}

export function AddHolidayButton() {
  const t = useTranslations("attendanceLive.settings.holidays");
  const tl = useTranslations("attendanceLive");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const empty = { date: "", nameEn: "", nameSw: "", kind: "gazetted" as HolidayKind, source: "" };
  const [form, setForm] = useState(empty);
  const date = parseCalendarInput(form.date);
  const ready =
    Boolean(date) &&
    form.nameEn.trim().length >= 3 &&
    form.nameSw.trim().length >= 3 &&
    form.source.trim().length >= 3;
  return (
    <>
      <Button
        onClick={() => {
          setForm(empty);
          setOpen(true);
        }}
      >
        <Plus aria-hidden /> {t("add")}
      </Button>
      <ActionDialog
        id="add-holiday"
        open={open}
        onOpenChange={setOpen}
        title={t("addTitle")}
        description={t("addDescription")}
        submitLabel={t("addSubmit")}
        submitDisabled={!ready}
        onSubmit={async () => {
          await attendanceCommand("/attendance/holidays", holidayResponseSchema, {
            date: date!,
            nameEn: form.nameEn.trim(),
            nameSw: form.nameSw.trim(),
            kind: form.kind,
            source: form.source.trim(),
          });
          router.refresh();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="holiday-date">{tl("common.date")}</FieldLabel>
            <Input
              id="holiday-date"
              value={form.date}
              placeholder="DD/MM/YYYY"
              inputMode="numeric"
              onChange={(event) => setForm({ ...form, date: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="holiday-kind">{t("kind")}</FieldLabel>
            <select
              id="holiday-kind"
              value={form.kind}
              onChange={(event) => setForm({ ...form, kind: event.target.value as HolidayKind })}
              className={selectClass}
            >
              {HOLIDAY_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kinds.${kind}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="holiday-en">{t("nameEn")}</FieldLabel>
            <Input
              id="holiday-en"
              lang="en"
              value={form.nameEn}
              maxLength={120}
              onChange={(event) => setForm({ ...form, nameEn: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="holiday-sw">{t("nameSw")}</FieldLabel>
            <Input
              id="holiday-sw"
              lang="sw"
              value={form.nameSw}
              maxLength={120}
              onChange={(event) => setForm({ ...form, nameSw: event.target.value })}
            />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="holiday-source">{t("source")}</FieldLabel>
          <Input
            id="holiday-source"
            value={form.source}
            maxLength={400}
            onChange={(event) => setForm({ ...form, source: event.target.value })}
            aria-describedby="holiday-source-hint"
          />
          <FieldDescription id="holiday-source-hint">{t("sourceHint")}</FieldDescription>
        </Field>
      </ActionDialog>
    </>
  );
}

export function DeleteHolidayButton({ holiday }: { holiday: PublicHoliday }) {
  const t = useTranslations("attendanceLive.settings.holidays");
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const name = locale === "sw" ? holiday.nameSw : holiday.nameEn;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        aria-label={t("removeFor", { name })}
      >
        <Trash2 aria-hidden /> {t("remove")}
      </Button>
      <ActionDialog
        id={`delete-holiday-${holiday.id}`}
        open={open}
        onOpenChange={setOpen}
        title={t("removeTitle", { name })}
        description={t("removeDescription")}
        submitLabel={t("remove")}
        destructive
        onSubmit={async () => {
          await attendanceCommand(
            `/attendance/holidays/${holiday.id}`,
            messageResponseSchema,
            {},
            "DELETE",
          );
          router.refresh();
        }}
      >
        {null}
      </ActionDialog>
    </>
  );
}
