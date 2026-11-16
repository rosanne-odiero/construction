"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import {
  messageResponseSchema,
  workerNotificationHistorySchema,
  workerNotificationPreferencesSchema,
} from "@pm-buddy/validation";
import type { z } from "zod";
import { csrfResponseSchema } from "@pm-buddy/validation";
import { foundationRequest } from "@/lib/foundation-api";
import { postWithCsrf } from "@/lib/csrf-post";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Preferences = z.infer<typeof workerNotificationPreferencesSchema>;
const eventKeys = {
  "worker.reminder": "worker_reminder",
  "attendance.day_confirmed": "attendance_day_confirmed",
  "payroll.batch_submitted": "payroll_batch_submitted",
  "payroll.batch_cancelled": "payroll_batch_cancelled",
  "advance.disbursed": "advance_disbursed",
} as const;

export function WorkerNotifications({
  initial,
  initialHistory,
}: {
  initial: Preferences;
  initialHistory: z.infer<typeof workerNotificationHistorySchema> | null;
}) {
  const t = useTranslations("portals.worker.notifications");
  const format = useFormatter();
  const [history, setHistory] = useState(initialHistory);
  const [historyFailed, setHistoryFailed] = useState(initialHistory === null);
  const [values, setValues] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"saved" | "accepted" | "failed" | null>(null);
  const dirty =
    values.sms !== saved.sms ||
    values.whatsapp !== saved.whatsapp ||
    values.locale !== saved.locale;
  async function refreshHistory() {
    try {
      setHistory(
        await foundationRequest(
          "/portal/worker/notifications/history",
          workerNotificationHistorySchema,
        ),
      );
      setHistoryFailed(false);
    } catch {
      setHistoryFailed(true);
    }
  }
  async function run(action: "save" | "sms" | "whatsapp") {
    setBusy(true);
    setStatus(null);
    try {
      if (action === "save") {
        const { csrfToken } = await foundationRequest("/auth/csrf", csrfResponseSchema);
        const result = await foundationRequest(
          "/portal/worker/notifications",
          workerNotificationPreferencesSchema,
          {
            method: "PUT",
            headers: { "X-CSRF-Token": csrfToken },
            body: values,
          },
        );
        setSaved(result);
        setStatus("saved");
      } else {
        await postWithCsrf("/portal/worker/notifications/send", messageResponseSchema, {
          channel: action,
        });
        setStatus("accepted");
      }
    } catch {
      setStatus("failed");
    } finally {
      if (action !== "save") await refreshHistory();
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void run("save");
          }}
        >
          <p className="text-muted-foreground">{t("description")}</p>
          <fieldset disabled={busy} className="space-y-4">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={values.sms}
                onChange={(event) => setValues({ ...values, sms: event.target.checked })}
              />
              {t("sms")}
            </label>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={values.whatsapp}
                onChange={(event) => setValues({ ...values, whatsapp: event.target.checked })}
              />
              {t("whatsapp")}
            </label>
            <label className="flex flex-wrap items-center gap-2">
              {t("language")}
              <select
                className="rounded border bg-background p-2"
                value={values.locale}
                onChange={(event) =>
                  setValues({ ...values, locale: event.target.value === "sw" ? "sw" : "en" })
                }
              >
                <option value="en">English</option>
                <option value="sw">Kiswahili</option>
              </select>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={!dirty}>
                {busy ? t("busy") : t("save")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!saved.sms || dirty}
                onClick={() => void run("sms")}
              >
                {t("sendSms")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!saved.whatsapp || dirty}
                onClick={() => void run("whatsapp")}
              >
                {t("sendWhatsapp")}
              </Button>
            </div>
          </fieldset>
          {status ? <p role={status === "failed" ? "alert" : "status"}>{t(status)}</p> : null}
        </form>
        <section className="mt-6 space-y-3" aria-labelledby="worker-notification-history">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="worker-notification-history" className="font-medium">
              {t("historyTitle")}
            </h3>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void refreshHistory()}
            >
              {t("refresh")}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">{t("historyNotice")}</p>
          {historyFailed ? <p role="alert">{t("historyFailed")}</p> : null}
          {history?.items.length ? (
            <ul className="space-y-3 text-sm">
              {history.items.map((item) => (
                <li key={item.id} className="space-y-1 border-t pt-2">
                  <p>
                    {t(`events.${eventKeys[item.topic]}`)} ·{" "}
                    {item.channel === "sms" ? "SMS" : "WhatsApp"}
                  </p>
                  <p>
                    {t(`states.${item.status}`)}
                    {item.reason ? ` · ${t(`reasons.${item.reason}`)}` : ""}
                  </p>
                  <time dateTime={item.createdAt}>
                    {format.dateTime(new Date(item.createdAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: "Africa/Nairobi",
                    })}
                  </time>
                </li>
              ))}
            </ul>
          ) : !historyFailed ? (
            <p className="text-sm">{t("noHistory")}</p>
          ) : null}
        </section>
      </CardContent>
    </Card>
  );
}
