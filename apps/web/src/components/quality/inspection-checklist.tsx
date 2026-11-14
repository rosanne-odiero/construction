"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { inspectionOutcome, nairobiDate } from "@pm-buddy/domain";
import { INSPECTION_ITEM_RESULTS, SNAG_RESPONSIBLE_KINDS, SNAG_SEVERITIES } from "@pm-buddy/types";
import {
  createSnagRequestSchema,
  inspectionActionRequestSchema,
  inspectionDetailResponseSchema,
  snagResponseSchema,
  updateInspectionRequestSchema,
  type InspectionDetailResponse,
  type InspectionItem,
  type QualityPhoto,
} from "@pm-buddy/validation";
import {
  FormError,
  selectClass,
  useScheduleMutation,
} from "@/components/schedule/use-schedule-mutation";
import { Button } from "@/components/ui/button";
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
import { liveRequest } from "@/lib/live-api";
import { calendarInput, parseCalendarInput } from "@/lib/project-input";
import { cn } from "@/lib/utils";
import { PhotoThumbs, PhotoUpload } from "./photos";
import { SnagCard } from "./snag-card";

type Answer = { result: InspectionItem["result"]; note: string; photos: QualityPhoto[] };
type Review = "sign_off" | "return" | null;

const resultClass: Record<InspectionItem["result"], string> = {
  pending: "",
  pass: "border-success bg-success/10 text-success",
  fail: "border-destructive bg-destructive/10 text-destructive",
  na: "border-foreground/40 bg-muted",
};

/**
 * The checklist of one inspection, built for a phone on site: each item is answered pass / fail /
 * N/A with a note and photos, saved together; the author submits; an independent quality.manage
 * holder signs off (locked) or returns it with a reason; failed items of a submitted inspection
 * can raise snags. Every button follows the record's `permissions` (the API checks again).
 */
export function InspectionChecklist({
  projectId,
  detail,
}: {
  projectId: string;
  detail: InspectionDetailResponse;
}) {
  const t = useTranslations("quality");
  const { inspection, items, snags } = detail;
  const editable = inspection.permissions.canEdit;
  const { busy, error, setError, run } = useScheduleMutation();
  const [answers, setAnswers] = useState<Record<string, Answer>>(() =>
    Object.fromEntries(
      items.map((item) => [
        item.id,
        { result: item.result, note: item.note ?? "", photos: item.photos },
      ]),
    ),
  );
  const [dirty, setDirty] = useState(false);
  const [review, setReview] = useState<Review>(null);
  const [snagFor, setSnagFor] = useState<InspectionItem | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const change = (id: string, patch: Partial<Answer>) => {
    setAnswers((current) => ({ ...current, [id]: { ...current[id]!, ...patch } }));
    setDirty(true);
    setStatus(null);
  };
  const results = items.map((item) => answers[item.id]!.result);
  const pending = results.filter((result) => result === "pending").length;
  const outcome = inspectionOutcome(results);

  const body = (version: number) =>
    updateInspectionRequestSchema.safeParse({
      version,
      items: items.map((item) => {
        const answer = answers[item.id]!;
        return {
          id: item.id,
          result: answer.result,
          note: answer.note,
          photoIds: answer.photos.map((photo) => photo.id),
        };
      }),
    });

  const save = (data: NonNullable<ReturnType<typeof body>["data"]>) =>
    liveRequest(
      `/projects/${projectId}/quality/inspections/${inspection.id}`,
      inspectionDetailResponseSchema,
      { method: "PATCH", body: data },
    );

  function saveOnly() {
    const parsed = body(inspection.version);
    if (!parsed.success) {
      setError(t("checklist.invalid"));
      return;
    }
    void run(async () => {
      await save(parsed.data);
      setDirty(false);
      setStatus(t("checklist.saved"));
    });
  }

  function submit() {
    const missingNote = items.some((item) => {
      const answer = answers[item.id]!;
      return answer.result === "fail" && Array.from(answer.note.trim()).length < 3;
    });
    if (pending || missingNote) {
      setError(pending ? t("checklist.pendingItems", { count: pending }) : t("checklist.failNote"));
      return;
    }
    const parsed = body(inspection.version);
    if (!parsed.success) {
      setError(t("checklist.invalid"));
      return;
    }
    void run(async () => {
      const saved = dirty ? await save(parsed.data) : detail;
      await liveRequest(
        `/projects/${projectId}/quality/inspections/${inspection.id}/actions`,
        inspectionDetailResponseSchema,
        { method: "POST", body: { version: saved.inspection.version, action: "submit" } },
      );
      setDirty(false);
    });
  }

  function decide(form: FormData) {
    if (!review) return;
    const parsed = inspectionActionRequestSchema.safeParse({
      version: inspection.version,
      action: review,
      ...(review === "return" ? { reason: String(form.get("reason") ?? "") } : {}),
    });
    if (!parsed.success) {
      setError(t("checklist.reasonInvalid"));
      return;
    }
    void run(
      () =>
        liveRequest(
          `/projects/${projectId}/quality/inspections/${inspection.id}/actions`,
          inspectionDetailResponseSchema,
          { method: "POST", body: parsed.data },
        ),
      () => setReview(null),
    );
  }

  function raise(form: FormData) {
    if (!snagFor) return;
    const parsed = createSnagRequestSchema.safeParse({
      siteId: inspection.siteId,
      inspectionItemId: snagFor.id,
      location: String(form.get("location") ?? ""),
      description: String(form.get("description") ?? ""),
      severity: form.get("severity"),
      responsibleKind: form.get("responsibleKind"),
      responsibleName: String(form.get("responsibleName") ?? ""),
      dueOn: parseCalendarInput(String(form.get("dueOn") ?? "")),
      photoIds: snagFor.photos.map((photo) => photo.id),
    });
    if (!parsed.success) {
      setError(t("snags.invalid"));
      return;
    }
    void run(
      () =>
        liveRequest(`/projects/${projectId}/quality/snags`, snagResponseSchema, {
          method: "POST",
          body: parsed.data,
        }),
      () => setSnagFor(null),
    );
  }

  return (
    <div className="space-y-6 pb-24 sm:pb-0">
      {!review && !snagFor ? <FormError message={error} /> : null}
      {status ? (
        <p role="status" className="text-sm">
          {status}
        </p>
      ) : null}
      {inspection.status === "signed_off" ? (
        <p className="rounded-md border bg-muted p-3 text-sm">{t("checklist.locked")}</p>
      ) : null}
      {inspection.returnReason && inspection.status === "draft" ? (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm break-words">
          {t("checklist.returned", { reason: inspection.returnReason })}
        </p>
      ) : null}
      <ol className="space-y-4" aria-label={t("checklist.items")}>
        {items.map((item) => {
          const answer = answers[item.id]!;
          const legend = `${item.position}. ${item.text}`;
          return (
            <li key={item.id}>
              <fieldset className="space-y-3 rounded-md border p-3" disabled={!editable || busy}>
                <legend className="px-1 text-sm font-medium break-words">{legend}</legend>
                <div className="grid grid-cols-3 gap-2">
                  {INSPECTION_ITEM_RESULTS.filter((result) => result !== "pending").map(
                    (result) => (
                      <label
                        key={result}
                        className={cn(
                          "flex min-h-11 cursor-pointer items-center justify-center rounded-md border px-2 text-center text-sm font-medium has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50",
                          answer.result === result ? resultClass[result] : "bg-background",
                          !editable && "cursor-default",
                        )}
                      >
                        <input
                          type="radio"
                          className="sr-only"
                          name={`result-${item.id}`}
                          value={result}
                          checked={answer.result === result}
                          onChange={() => change(item.id, { result })}
                        />
                        {t(`itemResult.${result}`)}
                      </label>
                    ),
                  )}
                </div>
                {answer.result === "pending" ? (
                  <p className="text-xs text-muted-foreground">{t("itemResult.pending")}</p>
                ) : null}
                {editable ? (
                  <Field>
                    <FieldLabel htmlFor={`note-${item.id}`}>
                      {answer.result === "fail" ? t("checklist.failNoteLabel") : t("fields.note")}
                    </FieldLabel>
                    <Textarea
                      id={`note-${item.id}`}
                      value={answer.note}
                      maxLength={1000}
                      rows={2}
                      onChange={(event) => change(item.id, { note: event.currentTarget.value })}
                    />
                  </Field>
                ) : answer.note ? (
                  <p className="text-sm break-words whitespace-pre-wrap">{answer.note}</p>
                ) : null}
                <PhotoThumbs
                  projectId={projectId}
                  photos={answer.photos}
                  label={t("checklist.photosOf", { item: item.position })}
                  disabled={busy}
                  onRemove={
                    editable
                      ? (photoId) =>
                          change(item.id, {
                            photos: answer.photos.filter((photo) => photo.id !== photoId),
                          })
                      : undefined
                  }
                />
                {editable && answer.photos.length < 6 ? (
                  <PhotoUpload
                    projectId={projectId}
                    siteId={inspection.siteId}
                    caption={`${inspection.code} ${legend}`}
                    label={t("checklist.addPhoto")}
                    disabled={busy}
                    onUploaded={(photo) =>
                      change(item.id, { photos: [...answers[item.id]!.photos, photo] })
                    }
                  />
                ) : null}
              </fieldset>
              {inspection.permissions.canRaiseSnags && item.result === "fail" ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setError(null);
                      setSnagFor(item);
                    }}
                  >
                    {t("checklist.raiseSnag", { item: item.position })}
                  </Button>
                  {item.snagCount ? (
                    <span className="text-sm text-muted-foreground">
                      {t("checklist.snagCount", { count: item.snagCount })}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {editable ? (
        <div className="fixed inset-x-0 bottom-0 z-20 space-y-2 border-t bg-background p-3 sm:static sm:rounded-md sm:border">
          <p className="text-sm" aria-live="polite">
            {pending
              ? t("checklist.pendingItems", { count: pending })
              : t("checklist.outcome", { result: t(`inspectionResult.${outcome ?? "pass"}`) })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy || !dirty} onClick={saveOnly}>
              {t("checklist.save")}
            </Button>
            {inspection.permissions.canSubmit ? (
              <Button disabled={busy} onClick={submit}>
                {t("checklist.submit")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {inspection.permissions.canSignOff || inspection.permissions.canReturn ? (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm">{t("checklist.reviewHint")}</p>
          <div className="flex flex-wrap gap-2">
            {inspection.permissions.canSignOff ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setReview("sign_off");
                }}
              >
                {t("checklist.signOff")}
              </Button>
            ) : null}
            {inspection.permissions.canReturn ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setReview("return");
                }}
              >
                {t("checklist.return")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {snags.length ? (
        <section aria-labelledby="inspection-snags" className="space-y-3">
          <h2 id="inspection-snags" className="text-base font-semibold">
            {t("checklist.snagsRaised")}
          </h2>
          <ul className="space-y-3">
            {snags.map((snag) => (
              <li key={snag.id}>
                <SnagCard projectId={projectId} snag={snag} compact />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Dialog
        open={review !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setReview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {review === "return" ? t("checklist.return") : t("checklist.signOff")}
            </DialogTitle>
            <DialogDescription>
              {review === "return" ? t("checklist.returnHint") : t("checklist.signOffHint")}
            </DialogDescription>
          </DialogHeader>
          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              decide(new FormData(event.currentTarget));
            }}
          >
            <FormError message={error} />
            {review === "return" ? (
              <Field>
                <FieldLabel htmlFor="inspection-return-reason">{t("fields.reason")}</FieldLabel>
                <Textarea
                  id="inspection-return-reason"
                  name="reason"
                  minLength={3}
                  maxLength={500}
                  required
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
                {t("actions.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {t("actions.confirm")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={snagFor !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setSnagFor(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("snags.raise")}</DialogTitle>
            <DialogDescription>
              {snagFor ? t("checklist.raiseHint", { item: snagFor.text }) : null}
            </DialogDescription>
          </DialogHeader>
          {snagFor ? (
            <form
              noValidate
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                raise(new FormData(event.currentTarget));
              }}
            >
              <FormError message={error} />
              <Field>
                <FieldLabel htmlFor="raise-location">{t("fields.location")}</FieldLabel>
                <Input
                  id="raise-location"
                  name="location"
                  defaultValue={inspection.location}
                  maxLength={200}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="raise-description">{t("fields.description")}</FieldLabel>
                <Textarea
                  id="raise-description"
                  name="description"
                  defaultValue={snagFor.note ?? snagFor.text}
                  maxLength={2000}
                  required
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="raise-severity">{t("fields.severity")}</FieldLabel>
                  <select
                    id="raise-severity"
                    name="severity"
                    className={selectClass}
                    defaultValue="major"
                  >
                    {SNAG_SEVERITIES.map((severity) => (
                      <option key={severity} value={severity}>
                        {t(`severity.${severity}`)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="raise-due">{t("fields.dueOn")}</FieldLabel>
                  <Input
                    id="raise-due"
                    name="dueOn"
                    placeholder="DD/MM/YYYY"
                    defaultValue={calendarInput(nairobiDate())}
                  />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="raise-kind">{t("fields.responsibleKind")}</FieldLabel>
                  <select id="raise-kind" name="responsibleKind" className={selectClass}>
                    {SNAG_RESPONSIBLE_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {t(`responsible.${kind}`)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="raise-name">{t("fields.responsibleName")}</FieldLabel>
                  <Input id="raise-name" name="responsibleName" maxLength={150} required />
                </Field>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setSnagFor(null)}
                >
                  {t("actions.cancel")}
                </Button>
                <Button type="submit" disabled={busy}>
                  {t("snags.raise")}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
