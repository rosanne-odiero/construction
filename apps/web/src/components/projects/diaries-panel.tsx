"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { nairobiDate, type DiaryAction } from "@pm-buddy/domain";
import {
  createDiaryRequestSchema,
  diaryActionRequestSchema,
  diaryResponseSchema,
  updateDiaryRequestSchema,
  type Site,
  type SiteDiary,
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
import { formatCalendarDate } from "@/lib/format";
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
  const problem = useProblemMessage();
  const router = useRouter();
  const [editor, setEditor] = useState<{ diary: SiteDiary | null } | null>(null);
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
    const content = {
      workPerformed: form.get("workPerformed"),
      weather: String(form.get("weather") ?? "").trim() || null,
      delays: String(form.get("delays") ?? "").trim() || null,
      workforceCount: workforce === "" ? null : Number(workforce),
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
          <Button
            onClick={() => {
              setMessage(null);
              setEditor({ diary: null });
            }}
          >
            {t("add")}
          </Button>
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
                    <dd>{diary.workforceCount ?? t("unknown")}</dd>
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
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setMessage(null);
                        setEditor({ diary });
                      }}
                    >
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
        <DialogContent>
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
            <Field>
              <FieldLabel htmlFor="diary-workforce">{t("workforce")}</FieldLabel>
              <Input
                id="diary-workforce"
                name="workforceCount"
                type="number"
                min={0}
                max={100000}
                step={1}
                defaultValue={editor?.diary?.workforceCount ?? ""}
                disabled={busy}
                aria-describedby="diary-workforce-hint"
              />
              <p id="diary-workforce-hint" className="text-sm text-muted-foreground">
                {t("workforceHint")}
              </p>
            </Field>
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
