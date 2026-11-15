"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Mail } from "lucide-react";
import { REPORT_LIMITS, type ReportId } from "@pm-buddy/types";
import {
  reportSubscriptionResponseSchema,
  runDueResponseSchema,
  type ReportParams,
} from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { spendingSelectClass } from "@/components/spending/spending-action";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * "Email me this report" (D8.1): a weekly or monthly subscription with the report's fixed
 * parameters (the period follows each run). The email holds a sign-in link, never report data.
 */
export function SubscribeDialog({
  id,
  parameters,
}: {
  id: ReportId;
  parameters: Omit<ReportParams, "from" | "to" | "asAt">;
}) {
  const t = useTranslations("reports.subscribe");
  const locale = useLocale();
  const problem = useProblemMessage();
  const [open, setOpen] = useState(false);
  const [frequency, setFrequency] = useState<"weekly" | "monthly">("weekly");
  const [weekday, setWeekday] = useState("1");
  const [dayOfMonth, setDayOfMonth] = useState("1");
  const [language, setLanguage] = useState(locale === "sw" ? "sw" : "en");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      await liveRequest("/reports/subscriptions", reportSubscriptionResponseSchema, {
        method: "POST",
        body: {
          reportId: id,
          parameters,
          frequency,
          ...(frequency === "weekly"
            ? { weekday: Number(weekday) }
            : { dayOfMonth: Number(dayOfMonth) }),
          locale: language,
        },
      });
      setDone(true);
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setDone(false);
          setFailure(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Mail aria-hidden /> {t("button")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="space-y-3 text-sm" role="status">
            <p>{t("done")}</p>
            <Button asChild variant="outline">
              <Link href="/reports/subscriptions">{t("manage")}</Link>
            </Button>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("frequency")}</legend>
              {(["weekly", "monthly"] as const).map((value) => (
                <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="frequency"
                    value={value}
                    checked={frequency === value}
                    onChange={() => setFrequency(value)}
                  />
                  {t(value)}
                </label>
              ))}
            </fieldset>
            {frequency === "weekly" ? (
              <Field>
                <FieldLabel htmlFor="subscribe-weekday">{t("weekday")}</FieldLabel>
                <select
                  id="subscribe-weekday"
                  className={spendingSelectClass}
                  value={weekday}
                  onChange={(event) => setWeekday(event.target.value)}
                >
                  {WEEKDAYS.map((day) => (
                    <option key={day} value={day}>
                      {t(`weekdays.${day}`)}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field>
                <FieldLabel htmlFor="subscribe-day">{t("dayOfMonth")}</FieldLabel>
                <Input
                  id="subscribe-day"
                  type="number"
                  min={1}
                  max={31}
                  required
                  value={dayOfMonth}
                  onChange={(event) => setDayOfMonth(event.target.value)}
                />
                <FieldDescription>{t("dayHint")}</FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="subscribe-language">{t("language")}</FieldLabel>
              <select
                id="subscribe-language"
                className={spendingSelectClass}
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
              >
                <option value="en">{t("english")}</option>
                <option value="sw">{t("kiswahili")}</option>
              </select>
            </Field>
            <p className="text-xs text-muted-foreground">
              {t("sendTime", { hour: String(REPORT_LIMITS.sendHourNairobi).padStart(2, "0") })}
            </p>
            {failure ? (
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {t("submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Pause, resume or delete one's own subscription (the API checks the owner and version). */
export function SubscriptionActions({
  id,
  version,
  status,
}: {
  id: string;
  version: number;
  status: "active" | "paused";
}) {
  const t = useTranslations("reports.subscriptions");
  const problem = useProblemMessage();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function act(action: "toggle" | "delete") {
    if (action === "delete" && !window.confirm(t("deleteConfirm"))) return;
    setBusy(true);
    setFailure(null);
    try {
      await liveRequest(
        action === "delete"
          ? `/reports/subscriptions/${id}/delete`
          : `/reports/subscriptions/${id}`,
        reportSubscriptionResponseSchema,
        action === "delete"
          ? { method: "POST", body: { version } }
          : {
              method: "PATCH",
              body: { version, status: status === "active" ? "paused" : "active" },
            },
      );
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("toggle")}>
        {status === "active" ? t("pause") : t("resume")}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("delete")}>
        {t("delete")}
      </Button>
      {failure ? (
        <p role="alert" className="w-full text-xs text-destructive">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

/** config.manage: run the company's due subscriptions now (the same cycle as the scheduler). */
export function RunDueButton() {
  const t = useTranslations("reports.subscriptions");
  const problem = useProblemMessage();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    try {
      const result = await liveRequest("/reports/subscriptions/run-due", runDueResponseSchema, {
        method: "POST",
        body: {},
      });
      setMessage(t("runDueDone", result));
      router.refresh();
    } catch (error) {
      setMessage(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <Button variant="outline" disabled={busy} onClick={() => void run()}>
        {t("runDue")}
      </Button>
      {message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </div>
  );
}
