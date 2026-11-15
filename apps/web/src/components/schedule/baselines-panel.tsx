"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  createBaselineRequestSchema,
  scheduleBaselineResponseSchema,
  type ScheduleBaselinesResponse,
  type ScheduleResponse,
} from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { itemLabel } from "@/lib/schedule";
import { ScheduleSummary } from "./schedule-workspace";
import { FormError, useScheduleMutation } from "./use-schedule-mutation";
import { VarianceBadge } from "./variance-badge";

/**
 * Baselines (D6.2): freeze the current schedule with a name and a reason, list the frozen
 * baselines (immutable; the newest is current) and compare the schedule with any of them: start
 * and finish variance in working days per item and for the project's finish.
 */
export function BaselinesPanel({
  projectId,
  schedule,
  baselines,
}: {
  projectId: string;
  schedule: ScheduleResponse;
  baselines: ScheduleBaselinesResponse;
}) {
  const t = useTranslations("schedule.baselines");
  const { busy, error, setError, run } = useScheduleMutation();
  const [pending, setPending] = useState<{ name: string; reason: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const first = baselines.baselines.length === 0;
  const compared = schedule.baseline;
  const base = `/projects/${projectId}?tab=schedule&view=baselines`;

  function review(form: FormData) {
    const parsed = createBaselineRequestSchema.safeParse({
      name: form.get("name"),
      reason: form.get("reason"),
    });
    if (!parsed.success) {
      setError(t("invalid"));
      return;
    }
    setError(null);
    setPending(parsed.data);
  }

  function freeze() {
    if (!pending) return;
    void run(
      () =>
        liveRequest(`/projects/${projectId}/schedule/baselines`, scheduleBaselineResponseSchema, {
          method: "POST",
          body: pending,
        }),
      () => {
        setPending(null);
        setNotice(t("frozen"));
      },
    );
  }

  return (
    <div className="space-y-6">
      <ScheduleSummary schedule={schedule} />
      {baselines.permissions.canBaseline ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h3>{first ? t("setTitle") : t("rebaselineTitle")}</h3>
            </CardTitle>
            <p className="text-sm text-muted-foreground">{t("description")}</p>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                review(new FormData(event.currentTarget));
              }}
            >
              <div className="sm:col-span-2">
                <FormError message={pending ? null : error} />
                {notice ? (
                  <p role="status" className="text-sm">
                    {notice}
                  </p>
                ) : null}
              </div>
              <Field>
                <FieldLabel htmlFor="baseline-name">{t("name")}</FieldLabel>
                <Input
                  id="baseline-name"
                  name="name"
                  maxLength={120}
                  required
                  defaultValue={first ? t("defaultName") : ""}
                  disabled={busy}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="baseline-reason">{t("reason")}</FieldLabel>
                <Textarea
                  id="baseline-reason"
                  name="reason"
                  maxLength={500}
                  required
                  disabled={busy}
                  aria-describedby="baseline-reason-hint"
                />
                <FieldDescription id="baseline-reason-hint">{t("reasonHint")}</FieldDescription>
              </Field>
              <div className="sm:col-span-2">
                <Button type="submit" disabled={busy || schedule.items.length === 0}>
                  {first ? t("freeze") : t("refreeze")}
                </Button>
                {schedule.items.length === 0 ? (
                  <p className="pt-2 text-sm text-muted-foreground">{t("emptySchedule")}</p>
                ) : null}
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>
            <h3>{t("listTitle")}</h3>
          </CardTitle>
          <p className="text-sm text-muted-foreground">{t("immutable")}</p>
        </CardHeader>
        <CardContent>
          {baselines.baselines.length ? (
            <div
              role="region"
              aria-label={t("listRegion")}
              tabIndex={0}
              className="relative overflow-x-auto rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <table className="w-full min-w-[44rem] text-sm">
                <caption className="sr-only">{t("listTitle")}</caption>
                <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="p-2 font-medium">
                      {t("baseline")}
                    </th>
                    <th scope="col" className="p-2 font-medium">
                      {t("reason")}
                    </th>
                    <th scope="col" className="p-2 font-medium">
                      {t("frozenBy")}
                    </th>
                    <th scope="col" className="p-2 font-medium">
                      {t("projectFinish")}
                    </th>
                    <th scope="col" className="p-2 font-medium">
                      <span className="sr-only">{t("compare")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {baselines.baselines.map((baseline) => (
                    <tr key={baseline.id} className="align-top">
                      <th scope="row" className="p-2 text-left font-normal">
                        <span className="font-medium">
                          {t("numbered", { number: baseline.number, name: baseline.name })}
                        </span>
                        <span className="mt-1 flex flex-wrap gap-1">
                          {baseline.current ? (
                            <StatusBadge tone="success">{t("current")}</StatusBadge>
                          ) : null}
                          {compared?.id === baseline.id ? (
                            <StatusBadge tone="info">{t("comparing")}</StatusBadge>
                          ) : null}
                        </span>
                      </th>
                      <td className="max-w-80 whitespace-pre-wrap break-words p-2">
                        {baseline.reason}
                      </td>
                      <td className="p-2">
                        {baseline.createdBy.displayName}
                        <span className="block text-xs text-muted-foreground">
                          {formatDateTime(baseline.createdAt)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {t("asOf", { date: formatCalendarDate(baseline.dataDate) })}
                        </span>
                      </td>
                      <td className="p-2 tabular-nums">
                        {baseline.projectFinish ? formatCalendarDate(baseline.projectFinish) : "—"}
                        <span className="block text-xs text-muted-foreground">
                          {t("items", { count: baseline.itemCount })}
                        </span>
                      </td>
                      <td className="p-2">
                        {compared?.id === baseline.id ? null : (
                          <Link
                            href={baseline.current ? base : `${base}&baseline=${baseline.id}`}
                            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                          >
                            {t("compareNamed", { number: baseline.number })}
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("none")}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h3>{t("varianceTitle")}</h3>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {compared
              ? t("varianceAgainst", { number: compared.number, name: compared.name })
              : t("varianceUnavailable")}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {schedule.items.length ? (
            <div
              role="region"
              aria-label={t("varianceRegion")}
              tabIndex={0}
              className="relative overflow-x-auto rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <table className="w-full min-w-[48rem] text-sm">
                <caption className="sr-only">{t("varianceTitle")}</caption>
                <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="p-2 font-medium">
                      {t("item")}
                    </th>
                    <th scope="col" className="p-2 font-medium">
                      {t("baselineDates")}
                    </th>
                    <th scope="col" className="p-2 font-medium">
                      {t("currentDates")}
                    </th>
                    <th scope="col" className="p-2 font-medium">
                      {t("startVariance")}
                    </th>
                    <th scope="col" className="p-2 font-medium">
                      {t("finishVariance")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {schedule.items.map((item) => {
                    const inBaseline = !compared || item.baseline !== null;
                    const dates = (pair: { start: string; finish: string }) =>
                      item.kind === "milestone"
                        ? formatCalendarDate(pair.finish)
                        : t("range", {
                            start: formatCalendarDate(pair.start),
                            finish: formatCalendarDate(pair.finish),
                          });
                    return (
                      <tr key={`${item.kind}:${item.id}`} className="align-top">
                        <th scope="row" className="p-2 text-left font-normal">
                          {itemLabel(item)}
                        </th>
                        <td className="p-2 tabular-nums">
                          {item.baseline ? dates(item.baseline) : "—"}
                        </td>
                        <td className="p-2 tabular-nums">{dates(item.planned)}</td>
                        <td className="p-2">
                          {item.kind === "milestone" ? (
                            "—"
                          ) : (
                            <VarianceBadge days={item.variance.startDays} inBaseline={inBaseline} />
                          )}
                        </td>
                        <td className="p-2">
                          <VarianceBadge days={item.variance.finishDays} inBaseline={inBaseline} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          {schedule.removedSinceBaseline.length ? (
            <div className="space-y-1 text-sm">
              <p className="font-medium">{t("removedTitle")}</p>
              <ul className="list-disc ps-5">
                {schedule.removedSinceBaseline.map((item) => (
                  <li key={`${item.kind}:${item.id}`}>{itemLabel(item)}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("confirmTitle")}</DialogTitle>
            <DialogDescription>{t("confirmText")}</DialogDescription>
          </DialogHeader>
          {pending ? (
            <p className="whitespace-pre-wrap break-words text-sm">
              <span className="font-medium">{pending.name}</span> · {pending.reason}
            </p>
          ) : null}
          <FormError message={error} />
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setPending(null)}>
              {t("cancel")}
            </Button>
            <Button disabled={busy} onClick={freeze}>
              {t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
