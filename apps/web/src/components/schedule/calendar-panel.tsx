"use client";

import { useTranslations } from "next-intl";
import {
  scheduleCalendarResponseSchema,
  updateScheduleCalendarRequestSchema,
  type ScheduleCalendar,
} from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { liveRequest } from "@/lib/live-api";
import { FormError, useScheduleMutation } from "./use-schedule-mutation";

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** The project's working week and whether company public holidays are non-working days. */
export function CalendarPanel({
  projectId,
  calendar,
  canEdit,
}: {
  projectId: string;
  calendar: ScheduleCalendar;
  canEdit: boolean;
}) {
  const t = useTranslations("schedule.calendar");
  const { busy, error, setError, run } = useScheduleMutation();

  function save(form: FormData) {
    const parsed = updateScheduleCalendarRequestSchema.safeParse({
      workingWeekdays: form.getAll("weekday").map(Number),
      includePublicHolidays: form.get("holidays") === "on",
      version: calendar.version,
    });
    if (!parsed.success) {
      setError(t("invalid"));
      return;
    }
    void run(() =>
      liveRequest(`/projects/${projectId}/schedule/calendar`, scheduleCalendarResponseSchema, {
        method: "PUT",
        body: parsed.data,
      }),
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>{t("title")}</h3>
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save(new FormData(event.currentTarget));
          }}
        >
          <FormError message={error} />
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("weekdays")}</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {WEEKDAYS.map((day) => (
                <label key={day} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    name="weekday"
                    value={day}
                    defaultChecked={calendar.workingWeekdays.includes(day)}
                    disabled={!canEdit || busy}
                  />
                  {t(`days.${day}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="holidays"
              defaultChecked={calendar.includePublicHolidays}
              disabled={!canEdit || busy}
              className="mt-1"
            />
            <span>
              {t("holidays")}
              <span className="block text-xs text-muted-foreground">
                {t("holidaysApplied", { count: calendar.holidaysApplied })}
              </span>
            </span>
          </label>
          {canEdit ? (
            <Button type="submit" disabled={busy}>
              {t("save")}
            </Button>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
