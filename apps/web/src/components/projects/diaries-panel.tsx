"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { nairobiDate, type DiaryAction } from "@pm-buddy/domain";
import type { WorkforceSource } from "@pm-buddy/types";
import {
  createDiaryRequestSchema,
  diaryActionRequestSchema,
  diaryAttendanceResponseSchema,
  diaryResponseSchema,
  updateDiaryRequestSchema,
  type DiaryAttendanceResponse,
  type Site,
  type SiteDiary,
  type WorkforceTradeWire,
} from "@pm-buddy/validation";
import { StatusBadge, type Tone } from "@/components/status-badge";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { liveRequest, LiveApiError } from "@/lib/live-api";
import { calendarInput, parseCalendarInput } from "@/lib/project-input";
import { useProblemMessage } from "./use-problem-message";

const tones: Record<SiteDiary["status"], Tone> = {
  draft: "neutral",
  submitted: "info",
  rejected: "danger",
  approved: "success",
};
const errors = {
  "diary-date-taken": "duplicate",
  "diary-future-date": "future",
  "diary-not-draft": "notDraft",
  "diary-invalid-transition": "transition",
  "diary-independent-review": "independent",
  "diary-author-required": "author",
} as const;

/** "Mason 5 (1 half day) · Helper 3" in the reader's language. */
function TradeList({ trades, locale }: { trades: WorkforceTradeWire[]; locale: string }) {
  const t = useTranslations("liveDiary");
  if (!trades.length) return <span>{t("workforceNobody")}</span>;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1">
      {trades.map((trade) => (
        <li key={trade.tradeId}>
          {t("workforceTrade", {
            name: locale === "sw" ? trade.nameSw : trade.nameEn,
            count: trade.headcount,
            half: trade.halfDays,
          })}
        </li>
      ))}
    </ul>
  );
}

export function DiariesPanel({
  projectId,
  userId,
  diaries,
  sites,
  canWrite,
  canReview,
}: {
  projectId: string;
  userId: string;
  diaries: SiteDiary[];
  sites: Site[];
  canWrite: boolean;
  canReview: boolean;
}) {
  const t = useTranslations("liveDiary");
  const locale = useLocale();
  const problem = useProblemMessage();
  const router = useRouter();
  const [editor, setEditor] = useState<{ diary: SiteDiary | null } | null>(null);
  const [source, setSource] = useState<WorkforceSource>("attendance");
  const [offer, setOffer] = useState<DiaryAttendanceResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const openEditor = (diary: SiteDiary | null) => {
    setMessage(null);
    setOffer(null);
    setSource(diary?.workforceSource ?? "attendance");
    setEditor({ diary });
  };

  async function checkAttendance(form: HTMLFormElement | null) {
    if (!form || !editor) return;
    const data = new FormData(form);
    const siteId = editor.diary?.siteId ?? String(data.get("siteId") ?? "");
    const date = editor.diary?.date ?? parseCalendarInput(String(data.get("date") ?? ""));
    if (!siteId || !date) {
      setMessage({ error: true, text: t("invalid") });
      return;
    }
    setChecking(true);
    setMessage(null);
    try {
      setOffer(
        await liveRequest(
          `/projects/${projectId}/diaries/attendance?siteId=${siteId}&date=${date}`,
          diaryAttendanceResponseSchema,
        ),
      );
    } catch (error) {
      setMessage({ error: true, text: problem(error) });
    } finally {
      setChecking(false);
    }
  }
  const [review, setReview] = useState<{ diary: SiteDiary; action: DiaryAction } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const siteName = (id: string) => sites.find((site) => site.id === id)?.name ?? id;

  async function mutate(path: string, method: "POST" | "PATCH", body: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await liveRequest(path, diaryResponseSchema, { method, body });
      setEditor(null);
      setReview(null);
      setMessage({ error: false, text: t("saved") });
      router.refresh();
    } catch (error) {
      const key =
        error instanceof LiveApiError ? errors[error.code as keyof typeof errors] : undefined;
      setMessage({ error: true, text: key ? t(`errors.${key}`) : problem(error) });
    } finally {
      setBusy(false);
    }
  }

  function save(form: FormData) {
    if (!editor) return;
    const workforce = String(form.get("workforceCount") ?? "").trim();
    const count = /^\d{1,6}$/.test(workforce) ? Number(workforce) : Number.NaN;
    const content = {
      workPerformed: form.get("workPerformed"),
      weather: String(form.get("weather") ?? "").trim() || null,
      delays: String(form.get("delays") ?? "").trim() || null,
      workforceSource: source,
      workforceCount: source === "attendance" || workforce === "" ? null : count,
    };
    const parsed = editor.diary
      ? updateDiaryRequestSchema.safeParse({ ...content, version: editor.diary.version })
      : createDiaryRequestSchema.safeParse({
          ...content,
          siteId: form.get("siteId"),
          date: parseCalendarInput(String(form.get("date") ?? "")),
        });
    if (!parsed.success) {
      setMessage({ error: true, text: t("invalid") });
      return;
    }
    void mutate(
      editor.diary
        ? `/projects/${projectId}/diaries/${editor.diary.id}`
        : `/projects/${projectId}/diaries`,
      editor.diary ? "PATCH" : "POST",
      parsed.data,
    );
  }

  function change(form: FormData) {
    if (!review) return;
    const parsed = diaryActionRequestSchema.safeParse({
      version: review.diary.version,
      action: review.action,
      ...(review.action === "reject" ? { reason: form.get("reason") } : {}),
    });
    if (!parsed.success) {
      setMessage({ error: true, text: t("reasonInvalid") });
      return;
    }
    void mutate(`/projects/${projectId}/diaries/${review.diary.id}/actions`, "POST", parsed.data);
  }

  function notice() {
    return message ? (
      <p
        role={message.error ? "alert" : "status"}
        className={message.error ? "text-sm text-destructive" : "text-sm"}
      >
        {message.text}
      </p>
    ) : null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
        <p className="rounded-md border bg-muted p-3 text-sm">{t("limitations")}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {!editor && !review ? notice() : null}
        {canWrite && sites.length ? (
          <Button onClick={() => openEditor(null)}>{t("add")}</Button>
        ) : null}
        {!sites.length ? <p>{t("noSites")}</p> : null}
        {!diaries.length ? <p className="text-sm text-muted-foreground">{t("empty")}</p> : null}
        <div className="space-y-4">
          {diaries.map((diary) => {
            const author = diary.createdBy === userId;
            const actions: DiaryAction[] = [];
            if (canWrite && author && diary.status === "draft") actions.push("submit");
            if (canWrite && author && diary.status === "rejected") actions.push("reopen");
            if (
              canReview &&
              !author &&
              diary.submittedBy !== userId &&
              diary.status === "submitted"
            )
              actions.push("approve", "reject");
            return (
              <article
                key={diary.id}
                className="space-y-3 rounded-md border p-4"
                aria-label={`${siteName(diary.siteId)} ${formatCalendarDate(diary.date)}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">
                    {siteName(diary.siteId)} · {formatCalendarDate(diary.date)}
                  </h3>
                  <StatusBadge tone={tones[diary.status]}>
                    {t(`status.${diary.status}`)}
                  </StatusBadge>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">{diary.workPerformed}</p>
                <dl className="grid gap-3 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-muted-foreground">{t("workforce")}</dt>
                    <dd className="space-y-1">
                      {diary.workforceSource === "attendance" && diary.workforce ? (
                        <>
                          <span className="block">
                            {t("workforceFromAttendance", { count: diary.workforceCount ?? 0 })}
                          </span>
                          <TradeList trades={diary.workforce.trades} locale={locale} />
                          <span className="block text-xs text-muted-foreground">
                            {t("workforceProvenance", {
                              muster: t(`muster.${diary.workforce.musterStatus}`),
                              at: formatDateTime(diary.workforce.snapshotAt),
                            })}
                          </span>
                        </>
                      ) : diary.workforceCount === null ? (
                        t("unknown")
                      ) : (
                        t("workforceManualValue", { count: diary.workforceCount })
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("weather")}</dt>
                    <dd className="whitespace-pre-wrap break-words">
                      {diary.weather || t("unknown")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("delays")}</dt>
                    <dd className="whitespace-pre-wrap break-words">
                      {diary.delays || t("unknown")}
                    </dd>
                  </div>
                </dl>
                {diary.reviewReason ? (
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {t("reviewReason", { reason: diary.reviewReason })}
                  </p>
                ) : null}
                {diary.status === "approved" ? (
                  <p className="text-sm text-muted-foreground">{t("locked")}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {canWrite && author && diary.status === "draft" ? (
                    <Button variant="outline" disabled={busy} onClick={() => openEditor(diary)}>
                      {t("edit")}
                    </Button>
                  ) : null}
                  {actions.map((action) => (
                    <Button
                      key={action}
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setMessage(null);
                        setReview({ diary, action });
                      }}
                    >
                      {t(`actions.${action}`)}
                    </Button>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      </CardContent>
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setEditor(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editor?.diary ? t("edit") : t("add")}</DialogTitle>
            <DialogDescription>{t("manual")}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              save(new FormData(event.currentTarget));
            }}
            className="space-y-4"
          >
            {notice()}
            {!editor?.diary ? (
              <>
                <Field>
                  <FieldLabel htmlFor="diary-site">{t("site")}</FieldLabel>
                  <select
                    id="diary-site"
                    name="siteId"
                    required
                    disabled={busy}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    {sites.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="diary-date">{t("date")}</FieldLabel>
                  <Input
                    id="diary-date"
                    name="date"
                    defaultValue={calendarInput(nairobiDate())}
                    placeholder="DD/MM/YYYY"
                    required
                    disabled={busy}
                  />
                </Field>
              </>
            ) : (
              <p className="text-sm">
                {siteName(editor.diary.siteId)} · {formatCalendarDate(editor.diary.date)}
              </p>
            )}
            <Field>
              <FieldLabel htmlFor="diary-work">{t("work")}</FieldLabel>
              <Textarea
                id="diary-work"
                name="workPerformed"
                defaultValue={editor?.diary?.workPerformed ?? ""}
                maxLength={6000}
                required
                disabled={busy}
              />
            </Field>
            <fieldset className="space-y-3 rounded-md border p-3" disabled={busy}>
              <legend className="px-1 text-sm font-medium">{t("workforce")}</legend>
              <div className="flex flex-wrap gap-4">
                {(["attendance", "manual"] as const).map((value) => (
                  <label key={value} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="workforceSource"
                      value={value}
                      checked={source === value}
                      onChange={() => setSource(value)}
                    />
                    {t(`workforceSource.${value}`)}
                  </label>
                ))}
              </div>
              {source === "attendance" ? (
                <div className="space-y-2 text-sm">
                  <p className="text-muted-foreground">{t("workforceAttendanceHint")}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={checking}
                    onClick={(event) => void checkAttendance(event.currentTarget.form)}
                  >
                    {t("workforceCheck")}
                  </Button>
                  {offer ? (
                    <div role="status" className="space-y-1 rounded-md bg-muted p-2">
                      <p>
                        {t("workforceOffer", {
                          count: offer.total,
                          muster: t(`muster.${offer.musterStatus}`),
                        })}
                      </p>
                      <TradeList trades={offer.trades} locale={locale} />
                    </div>
                  ) : null}
                </div>
              ) : (
                <Field>
                  <FieldLabel htmlFor="diary-workforce">{t("workforceManual")}</FieldLabel>
                  <Input
                    id="diary-workforce"
                    name="workforceCount"
                    inputMode="numeric"
                    defaultValue={
                      editor?.diary?.workforceSource === "manual"
                        ? (editor.diary.workforceCount ?? "")
                        : ""
                    }
                    aria-describedby="diary-workforce-hint"
                  />
                  <p id="diary-workforce-hint" className="text-sm text-muted-foreground">
                    {t("workforceHint")}
                  </p>
                </Field>
              )}
            </fieldset>
            <Field>
              <FieldLabel htmlFor="diary-weather">{t("weather")}</FieldLabel>
              <Input
                id="diary-weather"
                name="weather"
                defaultValue={editor?.diary?.weather ?? ""}
                maxLength={250}
                disabled={busy}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="diary-delays">{t("delays")}</FieldLabel>
              <Textarea
                id="diary-delays"
                name="delays"
                defaultValue={editor?.diary?.delays ?? ""}
                maxLength={2000}
                disabled={busy}
              />
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setEditor(null)}
              >
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {t("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setReview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{review ? t(`actions.${review.action}`) : t("title")}</DialogTitle>
            <DialogDescription>{t("signOffHint")}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              change(new FormData(event.currentTarget));
            }}
            className="space-y-4"
          >
            {notice()}
            {review?.action === "reject" ? (
              <Field>
                <FieldLabel htmlFor="diary-reason">{t("reason")}</FieldLabel>
                <Textarea
                  id="diary-reason"
                  name="reason"
                  minLength={3}
                  maxLength={500}
                  required
                  disabled={busy}
                />
              </Field>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setReview(null)}
              >
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {t("confirm")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
