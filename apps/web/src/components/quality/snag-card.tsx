"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { SNAG_RESPONSIBLE_KINDS, SNAG_SEVERITIES } from "@pm-buddy/types";
import {
  snagActionRequestSchema,
  snagResponseSchema,
  updateSnagRequestSchema,
  type QualityPhoto,
  type Snag,
} from "@pm-buddy/validation";
import Link from "next/link";
import {
  FormError,
  selectClass,
  useScheduleMutation,
} from "@/components/schedule/use-schedule-mutation";
import { StatusBadge } from "@/components/status-badge";
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
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { calendarInput, parseCalendarInput } from "@/lib/project-input";
import { severityTone, snagStatusTone } from "@/lib/quality";
import { PhotoThumbs, PhotoUpload } from "./photos";

type Mode = "edit" | "fix" | "close" | "reopen";

/** One snag with its state, evidence and the actions its `permissions` allow. */
export function SnagCard({
  projectId,
  snag,
  compact = false,
}: {
  projectId: string;
  snag: Snag;
  compact?: boolean;
}) {
  const t = useTranslations("quality");
  const { busy, error, setError, run } = useScheduleMutation();
  const [mode, setMode] = useState<Mode | null>(null);
  const [fixPhotos, setFixPhotos] = useState<QualityPhoto[]>([]);
  const open = (next: Mode) => {
    setError(null);
    setFixPhotos([]);
    setMode(next);
  };

  function submit(form: FormData) {
    if (!mode) return;
    const text = (name: string) => String(form.get(name) ?? "");
    let request: { path: string; method: "PATCH" | "POST"; body: Record<string, unknown> } | null =
      null;
    if (mode === "edit") {
      const dueOn = parseCalendarInput(text("dueOn"));
      const parsed = updateSnagRequestSchema.safeParse({
        version: snag.version,
        location: text("location"),
        description: text("description"),
        severity: form.get("severity"),
        responsibleKind: form.get("responsibleKind"),
        responsibleName: text("responsibleName"),
        dueOn,
      });
      if (parsed.success && dueOn !== undefined)
        request = {
          path: `/projects/${projectId}/quality/snags/${snag.id}`,
          method: "PATCH",
          body: parsed.data,
        };
    } else {
      const note = text("note").trim();
      const parsed = snagActionRequestSchema.safeParse({
        version: snag.version,
        action: mode,
        ...(mode === "fix"
          ? {
              ...(note ? { note } : {}),
              ...(fixPhotos.length ? { photoIds: fixPhotos.map((photo) => photo.id) } : {}),
            }
          : {}),
        ...(mode === "reopen" ? { reason: text("reason") } : {}),
      });
      if (parsed.success)
        request = {
          path: `/projects/${projectId}/quality/snags/${snag.id}/actions`,
          method: "POST",
          body: parsed.data,
        };
    }
    if (!request) {
      setError(t(mode === "reopen" ? "checklist.reasonInvalid" : "snags.invalid"));
      return;
    }
    const { path, method, body } = request;
    void run(
      () => liveRequest(path, snagResponseSchema, { method, body }),
      () => setMode(null),
    );
  }

  const { permissions } = snag;
  const actions = (
    [
      ["fix", permissions.canFix],
      ["close", permissions.canClose],
      ["reopen", permissions.canReopen],
      ["edit", permissions.canEdit],
    ] as const
  ).filter(([, allowed]) => allowed);

  return (
    <article
      className="space-y-3 rounded-md border p-4"
      aria-label={t("snags.cardLabel", { code: snag.code, location: snag.location })}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="min-w-0 font-semibold break-words">
          <span className="font-mono text-sm">{snag.code}</span> · {snag.location}
        </h4>
        <div className="flex flex-wrap gap-1">
          <StatusBadge
            tone={severityTone[snag.severity]}
            className="h-auto whitespace-normal text-left"
          >
            {t(`severity.${snag.severity}`)}
          </StatusBadge>
          <StatusBadge
            tone={snagStatusTone[snag.status]}
            className="h-auto whitespace-normal text-left"
          >
            {t(`snagStatus.${snag.status}`)}
          </StatusBadge>
          {snag.phase === "dlp" ? (
            <StatusBadge tone="info" className="h-auto whitespace-normal text-left">
              {t("snags.dlp")}
            </StatusBadge>
          ) : null}
          {snag.overdue ? (
            <StatusBadge tone="danger" className="h-auto whitespace-normal text-left">
              {t("snags.overdue")}
            </StatusBadge>
          ) : null}
        </div>
      </div>
      <p className="text-sm break-words whitespace-pre-wrap">{snag.description}</p>
      <dl className="grid gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">{t("fields.responsible")}</dt>
          <dd className="break-words">
            {t(`responsible.${snag.responsibleKind}`)}: {snag.responsibleName}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("fields.dueOn")}</dt>
          <dd>{snag.dueOn ? formatCalendarDate(snag.dueOn) : t("snags.noDue")}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("fields.site")}</dt>
          <dd className="break-words">{snag.siteName}</dd>
        </div>
      </dl>
      {snag.inspection && !compact ? (
        <p className="text-sm break-words">
          {t("snags.fromInspection")}{" "}
          <Link
            className="underline"
            href={`/projects/${projectId}/quality/inspections/${snag.inspection.id}`}
          >
            {snag.inspection.code}
          </Link>
          : {snag.inspection.itemText}
        </p>
      ) : null}
      <PhotoThumbs
        projectId={projectId}
        photos={snag.photos.raised}
        label={t("snags.photosRaised", { code: snag.code })}
      />
      {snag.fixedBy && snag.fixedAt ? (
        <p className="text-sm break-words">
          {t("snags.fixedBy", { name: snag.fixedBy.displayName, at: formatDateTime(snag.fixedAt) })}
          {snag.fixNote ? `: ${snag.fixNote}` : ""}
        </p>
      ) : null}
      <PhotoThumbs
        projectId={projectId}
        photos={snag.photos.fixed}
        label={t("snags.photosFixed", { code: snag.code })}
      />
      {snag.photos.earlierFixes.length ? (
        <PhotoThumbs
          projectId={projectId}
          photos={snag.photos.earlierFixes}
          label={t("snags.photosEarlierFixes", { code: snag.code })}
        />
      ) : null}
      {snag.closedBy && snag.closedAt ? (
        <p className="text-sm">
          {t("snags.closedBy", {
            name: snag.closedBy.displayName,
            at: formatDateTime(snag.closedAt),
          })}
        </p>
      ) : null}
      {snag.reopenCount && snag.lastReopenReason ? (
        <p className="text-sm break-words">
          {t("snags.reopened", { count: snag.reopenCount, reason: snag.lastReopenReason })}
        </p>
      ) : null}
      {snag.status === "fixed" && !permissions.canClose && permissions.canReopen === false ? (
        <p className="text-sm text-muted-foreground">{t("snags.awaitingVerification")}</p>
      ) : null}
      {actions.length ? (
        <div className="flex flex-wrap gap-2">
          {actions.map(([action]) => (
            <Button
              key={action}
              variant={action === "close" ? "default" : "outline"}
              size="sm"
              disabled={busy}
              onClick={() => open(action)}
              aria-label={t(`snagActions.${action}Named`, { code: snag.code })}
            >
              {t(`snagActions.${action}`)}
            </Button>
          ))}
        </div>
      ) : null}
      <Dialog
        open={mode !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setMode(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {mode ? t(`snagActions.${mode}Named`, { code: snag.code }) : snag.code}
            </DialogTitle>
            <DialogDescription>{mode ? t(`snagActions.${mode}Hint`) : null}</DialogDescription>
          </DialogHeader>
          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit(new FormData(event.currentTarget));
            }}
          >
            <FormError message={error} />
            {mode === "edit" ? (
              <>
                <Field>
                  <FieldLabel htmlFor={`edit-location-${snag.id}`}>
                    {t("fields.location")}
                  </FieldLabel>
                  <Input
                    id={`edit-location-${snag.id}`}
                    name="location"
                    defaultValue={snag.location}
                    maxLength={200}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`edit-description-${snag.id}`}>
                    {t("fields.description")}
                  </FieldLabel>
                  <Textarea
                    id={`edit-description-${snag.id}`}
                    name="description"
                    defaultValue={snag.description}
                    maxLength={2000}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor={`edit-severity-${snag.id}`}>
                      {t("fields.severity")}
                    </FieldLabel>
                    <select
                      id={`edit-severity-${snag.id}`}
                      name="severity"
                      defaultValue={snag.severity}
                      className={selectClass}
                    >
                      {SNAG_SEVERITIES.map((severity) => (
                        <option key={severity} value={severity}>
                          {t(`severity.${severity}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`edit-due-${snag.id}`}>{t("fields.dueOn")}</FieldLabel>
                    <Input
                      id={`edit-due-${snag.id}`}
                      name="dueOn"
                      placeholder="DD/MM/YYYY"
                      defaultValue={calendarInput(snag.dueOn)}
                    />
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor={`edit-kind-${snag.id}`}>
                      {t("fields.responsibleKind")}
                    </FieldLabel>
                    <select
                      id={`edit-kind-${snag.id}`}
                      name="responsibleKind"
                      defaultValue={snag.responsibleKind}
                      className={selectClass}
                    >
                      {SNAG_RESPONSIBLE_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {t(`responsible.${kind}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`edit-name-${snag.id}`}>
                      {t("fields.responsibleName")}
                    </FieldLabel>
                    <Input
                      id={`edit-name-${snag.id}`}
                      name="responsibleName"
                      defaultValue={snag.responsibleName}
                      maxLength={150}
                    />
                  </Field>
                </div>
              </>
            ) : null}
            {mode === "fix" ? (
              <>
                <Field>
                  <FieldLabel htmlFor={`fix-note-${snag.id}`}>{t("snags.fixNote")}</FieldLabel>
                  <Textarea id={`fix-note-${snag.id}`} name="note" maxLength={1000} />
                </Field>
                <PhotoThumbs
                  projectId={projectId}
                  photos={fixPhotos}
                  label={t("snags.photosFixed", { code: snag.code })}
                  onRemove={(photoId) =>
                    setFixPhotos((photos) => photos.filter((photo) => photo.id !== photoId))
                  }
                />
                {fixPhotos.length < 6 ? (
                  <PhotoUpload
                    projectId={projectId}
                    siteId={snag.siteId}
                    caption={`${snag.code} ${snag.location}`}
                    label={t("snags.addFixPhoto")}
                    disabled={busy}
                    onUploaded={(photo) => setFixPhotos((photos) => [...photos, photo])}
                  />
                ) : null}
              </>
            ) : null}
            {mode === "reopen" ? (
              <Field>
                <FieldLabel htmlFor={`reopen-reason-${snag.id}`}>{t("fields.reason")}</FieldLabel>
                <Textarea
                  id={`reopen-reason-${snag.id}`}
                  name="reason"
                  minLength={3}
                  maxLength={500}
                  required
                />
              </Field>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setMode(null)}>
                {t("actions.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {t("actions.confirm")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </article>
  );
}
