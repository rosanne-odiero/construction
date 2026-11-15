"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import { DELAY_CAUSES, DELAY_CLAIM_FLAGS } from "@pm-buddy/types";
import {
  amendDelayRequestSchema,
  createDelayRequestSchema,
  scheduleDelayResponseSchema,
  withdrawDelayRequestSchema,
  type ScheduleDelay,
  type ScheduleDelaysResponse,
  type ScheduleDelayVersion,
  type ScheduleItem,
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
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { calendarInput, parseCalendarInput } from "@/lib/project-input";
import { parseDaysLost, type DiaryChoice } from "@/lib/schedule";
import { FormError, selectClass, useScheduleMutation } from "./use-schedule-mutation";

export type { DiaryChoice };
const delayNumber = (number: number) => `DLY-${String(number).padStart(3, "0")}`;
const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/**
 * The delay log (D6.2): delays with a cause from a fixed list, the period, working days lost,
 * affected activities, an optional site diary and the company's claim-support position. Every
 * change appends a version with a reason; withdrawn delays stay in the log.
 */
export function DelaysPanel({
  projectId,
  log,
  tasks,
  diaries,
}: {
  projectId: string;
  log: ScheduleDelaysResponse;
  tasks: ScheduleItem[];
  diaries: DiaryChoice[];
}) {
  const t = useTranslations("schedule.delays");
  const [editor, setEditor] = useState<{ delay: ScheduleDelay | null } | null>(null);
  const [withdrawing, setWithdrawing] = useState<ScheduleDelay | null>(null);
  const [history, setHistory] = useState<ScheduleDelay | null>(null);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>{t("title")}</h3>
          </CardTitle>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border p-3">
              <dt className="text-xs text-muted-foreground">{t("totalCount")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{log.totals.count}</dd>
            </div>
            <div className="rounded-md border p-3">
              <dt className="text-xs text-muted-foreground">{t("totalDays")}</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {t("days", { days: log.totals.workingDaysLost })}
              </dd>
            </div>
            <div className="rounded-md border p-3">
              <dt className="text-xs text-muted-foreground">{t("byCause")}</dt>
              <dd className="flex flex-wrap gap-1 pt-1">
                {log.totals.byCause.length
                  ? log.totals.byCause.map((entry) => (
                      <StatusBadge
                        key={entry.cause}
                        tone="neutral"
                        className="h-auto whitespace-normal"
                      >
                        {t("causeTotal", {
                          cause: t(`causes.${entry.cause}`),
                          days: entry.workingDaysLost,
                        })}
                      </StatusBadge>
                    ))
                  : "—"}
              </dd>
            </div>
          </dl>
          {log.permissions.canRecord ? (
            <Button onClick={() => setEditor({ delay: null })}>
              <Plus aria-hidden className="size-4" />
              {t("record")}
            </Button>
          ) : null}
          {log.delays.length ? (
            <div className="space-y-3">
              {log.delays.map((delay) => (
                <article
                  key={delay.id}
                  aria-label={`${delayNumber(delay.number)} ${t(`causes.${delay.cause}`)}`}
                  className="space-y-2 rounded-md border p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="font-semibold">
                      {delayNumber(delay.number)} · {t(`causes.${delay.cause}`)}
                    </h4>
                    <span className="flex flex-wrap gap-1">
                      <StatusBadge tone={delay.status === "withdrawn" ? "neutral" : "warning"}>
                        {t(`status.${delay.status}`)}
                      </StatusBadge>
                      <StatusBadge tone="info" className="h-auto whitespace-normal">
                        {t(`claimFlags.${delay.claimFlag}`)}
                      </StatusBadge>
                    </span>
                  </div>
                  <p
                    className={
                      delay.status === "withdrawn"
                        ? "whitespace-pre-wrap break-words text-sm text-muted-foreground line-through"
                        : "whitespace-pre-wrap break-words text-sm"
                    }
                  >
                    {delay.description}
                  </p>
                  <dl className="grid gap-2 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-muted-foreground">{t("period")}</dt>
                      <dd>
                        {formatCalendarDate(delay.startDate)} –{" "}
                        {delay.endDate ? formatCalendarDate(delay.endDate) : t("ongoing")}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t("daysLost")}</dt>
                      <dd>
                        {t("daysOf", {
                          lost: delay.workingDaysLost,
                          days: delay.workingDaysInPeriod,
                        })}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t("activities")}</dt>
                      <dd className="break-words">
                        {delay.activities.length
                          ? delay.activities.map((activity) => activity.code).join(", ")
                          : t("noActivities")}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t("diary")}</dt>
                      <dd>
                        {delay.siteDiary
                          ? t("diaryOn", { date: formatCalendarDate(delay.siteDiary.date) })
                          : t("noDiary")}
                      </dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="text-muted-foreground">{t("recorded")}</dt>
                      <dd>
                        {t("recordedBy", {
                          name: delay.recordedBy.displayName,
                          at: formatDateTime(delay.recordedAt),
                          version: delay.version,
                        })}
                      </dd>
                    </div>
                  </dl>
                  {delay.changeReason ? (
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {t("changeReason", { reason: delay.changeReason })}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {delay.permissions.canAmend ? (
                      <Button size="sm" variant="outline" onClick={() => setEditor({ delay })}>
                        {t("amend")}
                      </Button>
                    ) : null}
                    {delay.permissions.canWithdraw ? (
                      <Button size="sm" variant="outline" onClick={() => setWithdrawing(delay)}>
                        {t("withdraw")}
                      </Button>
                    ) : null}
                    {delay.version > 1 ? (
                      <Button size="sm" variant="ghost" onClick={() => setHistory(delay)}>
                        {t("history")}
                      </Button>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          )}
        </CardContent>
      </Card>
      {editor ? (
        <DelayDialog
          key={editor.delay?.id ?? "new"}
          projectId={projectId}
          delay={editor.delay}
          tasks={tasks}
          diaries={diaries}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {withdrawing ? (
        <WithdrawDialog
          key={withdrawing.id}
          projectId={projectId}
          delay={withdrawing}
          onClose={() => setWithdrawing(null)}
        />
      ) : null}
      {history ? (
        <HistoryDialog
          key={history.id}
          projectId={projectId}
          delay={history}
          onClose={() => setHistory(null)}
        />
      ) : null}
    </div>
  );
}

function DelayDialog({
  projectId,
  delay,
  tasks,
  diaries,
  onClose,
}: {
  projectId: string;
  delay: ScheduleDelay | null;
  tasks: ScheduleItem[];
  diaries: DiaryChoice[];
  onClose: () => void;
}) {
  const t = useTranslations("schedule.delays");
  const { busy, error, setError, run } = useScheduleMutation();
  const chosen = new Set(delay?.activities.map((activity) => activity.id) ?? []);

  function save(form: FormData) {
    const startDate = parseCalendarInput(text(form, "startDate"));
    const endDate = parseCalendarInput(text(form, "endDate"));
    const daysLost = parseDaysLost(text(form, "workingDaysLost"));
    const content = {
      cause: form.get("cause"),
      startDate,
      endDate,
      workingDaysLost: daysLost,
      description: text(form, "description"),
      siteDiaryId: text(form, "siteDiaryId") || null,
      claimFlag: form.get("claimFlag"),
      activityIds: form.getAll("activityIds").map(String),
    };
    const parsed = delay
      ? amendDelayRequestSchema.safeParse({
          ...content,
          version: delay.version,
          reason: text(form, "reason"),
        })
      : createDelayRequestSchema.safeParse(content);
    if (!parsed.success || endDate === undefined) {
      setError(t("invalid"));
      return;
    }
    void run(
      () =>
        liveRequest(
          delay
            ? `/projects/${projectId}/schedule/delays/${delay.id}/amend`
            : `/projects/${projectId}/schedule/delays`,
          scheduleDelayResponseSchema,
          { method: "POST", body: parsed.data },
        ),
      onClose,
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {delay ? t("amendTitle", { number: delayNumber(delay.number) }) : t("recordTitle")}
          </DialogTitle>
          <DialogDescription>{t("formDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save(new FormData(event.currentTarget));
          }}
        >
          <FormError message={error} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="delay-cause">{t("cause")}</FieldLabel>
              <select
                id="delay-cause"
                name="cause"
                defaultValue={delay?.cause ?? "weather"}
                className={selectClass}
                disabled={busy}
              >
                {DELAY_CAUSES.map((cause) => (
                  <option key={cause} value={cause}>
                    {t(`causes.${cause}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="delay-days">{t("daysLost")}</FieldLabel>
              <Input
                id="delay-days"
                name="workingDaysLost"
                inputMode="decimal"
                defaultValue={delay?.workingDaysLost ?? ""}
                required
                disabled={busy}
                aria-describedby="delay-days-hint"
              />
              <FieldDescription id="delay-days-hint">{t("daysLostHint")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="delay-start">{t("startDate")}</FieldLabel>
              <Input
                id="delay-start"
                name="startDate"
                placeholder="DD/MM/YYYY"
                defaultValue={calendarInput(delay?.startDate ?? nairobiDate())}
                required
                disabled={busy}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="delay-end">{t("endDate")}</FieldLabel>
              <Input
                id="delay-end"
                name="endDate"
                placeholder="DD/MM/YYYY"
                defaultValue={calendarInput(delay?.endDate ?? null)}
                disabled={busy}
                aria-describedby="delay-end-hint"
              />
              <FieldDescription id="delay-end-hint">{t("endHint")}</FieldDescription>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="delay-description">{t("descriptionLabel")}</FieldLabel>
            <Textarea
              id="delay-description"
              name="description"
              defaultValue={delay?.description ?? ""}
              maxLength={2000}
              required
              disabled={busy}
            />
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("activities")}</legend>
            {tasks.length ? (
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                {tasks.map((task) => (
                  <label key={task.id} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="activityIds"
                      value={task.id}
                      defaultChecked={chosen.has(task.id)}
                      disabled={busy}
                      className="mt-1"
                    />
                    <span className="break-words">
                      <span className="font-mono text-xs">{task.code}</span> {task.name}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("noActivities")}</p>
            )}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="delay-diary">{t("diary")}</FieldLabel>
              <select
                id="delay-diary"
                name="siteDiaryId"
                defaultValue={delay?.siteDiary?.id ?? ""}
                className={selectClass}
                disabled={busy}
              >
                <option value="">{t("noDiary")}</option>
                {diaries.map((diary) => (
                  <option key={diary.id} value={diary.id}>
                    {formatCalendarDate(diary.date)} · {diary.site}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="delay-claim">{t("claimFlag")}</FieldLabel>
              <select
                id="delay-claim"
                name="claimFlag"
                defaultValue={delay?.claimFlag ?? "not_assessed"}
                className={selectClass}
                disabled={busy}
                aria-describedby="delay-claim-hint"
              >
                {DELAY_CLAIM_FLAGS.map((flag) => (
                  <option key={flag} value={flag}>
                    {t(`claimFlags.${flag}`)}
                  </option>
                ))}
              </select>
              <FieldDescription id="delay-claim-hint">{t("claimHint")}</FieldDescription>
            </Field>
          </div>
          {delay ? (
            <Field>
              <FieldLabel htmlFor="delay-reason">{t("reason")}</FieldLabel>
              <Textarea id="delay-reason" name="reason" maxLength={500} required disabled={busy} />
            </Field>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function WithdrawDialog({
  projectId,
  delay,
  onClose,
}: {
  projectId: string;
  delay: ScheduleDelay;
  onClose: () => void;
}) {
  const t = useTranslations("schedule.delays");
  const { busy, error, setError, run } = useScheduleMutation();
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("withdrawTitle", { number: delayNumber(delay.number) })}</DialogTitle>
          <DialogDescription>{t("withdrawDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = withdrawDelayRequestSchema.safeParse({
              version: delay.version,
              reason: text(new FormData(event.currentTarget), "reason"),
            });
            if (!parsed.success) {
              setError(t("invalid"));
              return;
            }
            void run(
              () =>
                liveRequest(
                  `/projects/${projectId}/schedule/delays/${delay.id}/withdraw`,
                  scheduleDelayResponseSchema,
                  { method: "POST", body: parsed.data },
                ),
              onClose,
            );
          }}
        >
          <FormError message={error} />
          <Field>
            <FieldLabel htmlFor="withdraw-reason">{t("reason")}</FieldLabel>
            <Textarea
              id="withdraw-reason"
              name="reason"
              maxLength={500}
              required
              autoFocus
              disabled={busy}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" variant="destructive" disabled={busy}>
              {t("withdraw")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({
  projectId,
  delay,
  onClose,
}: {
  projectId: string;
  delay: ScheduleDelay;
  onClose: () => void;
}) {
  const t = useTranslations("schedule.delays");
  const problem = useProblemMessage();
  const [versions, setVersions] = useState<ScheduleDelayVersion[] | null>(null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    let active = true;
    liveRequest(`/projects/${projectId}/schedule/delays/${delay.id}`, scheduleDelayResponseSchema)
      .then((detail) => {
        if (active) setVersions(detail.history);
      })
      .catch((error: unknown) => {
        if (active) setFailure({ error });
      });
    return () => {
      active = false;
    };
  }, [projectId, delay.id]);
  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("historyTitle", { number: delayNumber(delay.number) })}</DialogTitle>
          <DialogDescription>{t("historyDescription")}</DialogDescription>
        </DialogHeader>
        <FormError message={failure ? problem(failure.error) : null} />
        {versions ? (
          <ol className="space-y-3">
            {versions.map((version) => (
              <li key={version.version} className="space-y-1 rounded-md border p-3 text-sm">
                <p className="font-medium">
                  {t("versionLine", {
                    version: version.version,
                    status: t(`status.${version.status}`),
                    name: version.recordedBy.displayName,
                    at: formatDateTime(version.recordedAt),
                  })}
                </p>
                <p>
                  {t(`causes.${version.cause}`)} · {formatCalendarDate(version.startDate)} –{" "}
                  {version.endDate ? formatCalendarDate(version.endDate) : t("ongoing")} ·{" "}
                  {t("days", { days: version.workingDaysLost })} ·{" "}
                  {t(`claimFlags.${version.claimFlag}`)}
                </p>
                {version.changeReason ? (
                  <p className="whitespace-pre-wrap break-words text-muted-foreground">
                    {t("changeReason", { reason: version.changeReason })}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        ) : failure ? null : (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
