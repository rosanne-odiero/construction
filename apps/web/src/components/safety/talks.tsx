"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";
import {
  createToolboxTalkRequestSchema,
  toolboxTalkActionRequestSchema,
  toolboxTalkResponseSchema,
  updateToolboxTalkRequestSchema,
  type QualityPhoto,
  type SafetyLabourer,
  type SafetyOptionsResponse,
  type Site,
  type ToolboxTalk,
  type ToolboxTalksResponse,
} from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { PhotoThumbs, PhotoUpload } from "@/components/quality/photos";
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
import { parseOptionalWhole, safetyHref, talkStatusTone } from "@/lib/safety";
import { RaiseActionDialog } from "./action-card";
import { checkboxClass, field, Pager, ReasonDialog } from "./common";
import { LabourerPicker } from "./labourer-picker";

/** Toolbox talks, newest first, linking to each talk and to recording a new one. */
export function TalksPanel({
  projectId,
  data,
  filters,
}: {
  projectId: string;
  data: ToolboxTalksResponse;
  filters: { search?: string; cursor?: string };
}) {
  const t = useTranslations("safety");
  const kept = { search: filters.search };
  return (
    <section aria-labelledby="talks-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="talks-heading" className="text-base font-semibold">
          {t("talks.title")}
        </h3>
        {data.permissions.canCreate ? (
          <Button asChild>
            <Link href={`/projects/${projectId}/safety/talks/new`}>
              <Plus className="size-4" aria-hidden />
              {t("talks.new")}
            </Link>
          </Button>
        ) : null}
      </div>
      <form
        method="get"
        action={`/projects/${projectId}`}
        className="flex flex-wrap items-end gap-3 rounded-md border p-3"
      >
        <input type="hidden" name="tab" value="safety" />
        <input type="hidden" name="view" value="talks" />
        <Field className="min-w-0 flex-1">
          <FieldLabel htmlFor="talk-search">{t("filters.search")}</FieldLabel>
          <Input
            id="talk-search"
            name="search"
            type="search"
            maxLength={100}
            defaultValue={filters.search ?? ""}
            placeholder={t("talks.searchPlaceholder")}
          />
        </Field>
        <Button type="submit" variant="outline">
          {t("filters.apply")}
        </Button>
      </form>
      {data.talks.length ? (
        <ul className="space-y-3">
          {data.talks.map((talk) => (
            <li key={talk.id}>
              <Link
                href={`/projects/${projectId}/safety/talks/${talk.id}`}
                className="block space-y-1 rounded-md border p-3 hover:bg-muted"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">{talk.code}</span>
                  <StatusBadge
                    tone={talkStatusTone[talk.status]}
                    className="h-auto whitespace-normal"
                  >
                    {t(`talkStatus.${talk.status}`)}
                  </StatusBadge>
                </span>
                <span className="block font-medium break-words">{talk.topic}</span>
                <span className="block text-sm break-words text-muted-foreground">
                  {formatCalendarDate(talk.heldOn)} · {talk.siteName} ·{" "}
                  {t("talks.presentedBy", { name: talk.presenter.displayName })} ·{" "}
                  {t("talks.attendance", {
                    count: talk.attendeeCount,
                    others: talk.otherAttendees,
                  })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("talks.empty")}</p>
      )}
      <Pager
        label={t("talks.pages")}
        firstHref={filters.cursor ? safetyHref(projectId, "talks", kept) : null}
        nextHref={
          data.nextCursor
            ? safetyHref(projectId, "talks", { ...kept, cursor: String(data.nextCursor) })
            : null
        }
      />
    </section>
  );
}

/**
 * Records a toolbox talk on a phone (D8.2): topic, date, presenter, whole gangs and labourers
 * picked by name, others not in the registry, and a photo. A draft can be edited; confirming locks
 * it. Edits a draft talk when `talk` is given.
 */
export function TalkForm({
  projectId,
  sites,
  options,
  today,
  userId,
  talk,
}: {
  projectId: string;
  sites: Site[];
  options: SafetyOptionsResponse;
  today: string;
  userId: string;
  talk?: ToolboxTalk;
}) {
  const t = useTranslations("safety");
  const problem = useProblemMessage();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [siteId, setSiteId] = useState(talk?.siteId ?? sites[0]?.id ?? "");
  const [gangIds, setGangIds] = useState<string[]>(
    talk
      ? [...new Set(talk.attendees.flatMap((entry) => (entry.gang ? [entry.gang.id] : [])))]
      : [],
  );
  const [picked, setPicked] = useState<SafetyLabourer[]>(
    talk ? talk.attendees.filter((entry) => !entry.gang).map((entry) => entry.labourer) : [],
  );
  const [photo, setPhoto] = useState<QualityPhoto | null>(talk?.photo ?? null);
  const [adding, setAdding] = useState<SafetyLabourer | null>(null);
  const [pending, setPending] = useState<NonNullable<ReturnType<typeof validate>> | null>(null);
  const presenters = options.staff.filter((member) => member.canRecord);
  const gangs = options.gangs.filter((gang) => gang.siteId === null || gang.siteId === siteId);

  /** The request for the form's content, or null (and the error shown) when it is invalid. */
  function validate(form: FormData, confirm: boolean) {
    const heldOn = parseCalendarInput(field(form, "heldOn"));
    const duration = parseOptionalWhole(field(form, "durationMinutes"), 5, 240);
    const others = parseOptionalWhole(field(form, "otherAttendees"), 0, 500);
    const content = {
      heldOn,
      topic: field(form, "topic"),
      notes: field(form, "notes"),
      durationMinutes: duration ?? null,
      presenterId: field(form, "presenterId"),
      photoId: photo?.id ?? null,
      otherAttendees: others ?? 0,
      gangIds,
      labourerIds: picked.map((labourer) => labourer.id),
    };
    const parsed = talk
      ? updateToolboxTalkRequestSchema.safeParse({ version: talk.version, ...content })
      : createToolboxTalkRequestSchema.safeParse({ siteId, ...content, confirm });
    if (
      !parsed.success ||
      !heldOn ||
      heldOn > parseCalendarInput(today)! ||
      duration === null ||
      others === null
    ) {
      setError(t("talks.invalid"));
      return null;
    }
    if (confirm && !gangIds.length && !picked.length && !content.otherAttendees) {
      setError(t("talks.noAttendees"));
      return null;
    }
    setError(null);
    return parsed.data;
  }

  async function save(body: NonNullable<ReturnType<typeof validate>>, confirm: boolean) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const base = `/projects/${projectId}/safety/talks`;
      let result = talk
        ? await liveRequest(`${base}/${talk.id}`, toolboxTalkResponseSchema, {
            method: "PUT",
            body,
          })
        : await liveRequest(base, toolboxTalkResponseSchema, { method: "POST", body });
      if (talk && confirm)
        result = await liveRequest(`${base}/${talk.id}/actions`, toolboxTalkResponseSchema, {
          method: "POST",
          body: toolboxTalkActionRequestSchema.parse({
            version: result.talk.version,
            action: "confirm",
          }),
        });
      setPending(null);
      if (talk) {
        setSaved(!confirm);
        router.refresh();
      } else router.push(`${base}/${result.talk.id}`);
    } catch (caught) {
      setPending(null);
      setError(problem(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      className="max-w-2xl space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        const confirm = submitter?.value === "confirm";
        const body = validate(new FormData(event.currentTarget), confirm);
        // Confirming locks the talk: ask first.
        if (body && confirm) setPending(body);
        else if (body) void save(body, false);
      }}
    >
      <FormError message={error} />
      {saved ? (
        <p role="status" className="text-sm text-success">
          {t("talks.saved")}
        </p>
      ) : null}
      {talk ? null : (
        <Field>
          <FieldLabel htmlFor="talk-site">{t("filters.site")}</FieldLabel>
          <select
            id="talk-site"
            value={siteId}
            disabled={busy}
            className={selectClass}
            onChange={(event) => {
              setSiteId(event.currentTarget.value);
              setGangIds([]);
              setPhoto(null);
            }}
          >
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="talk-topic">{t("talks.topic")}</FieldLabel>
        <Input
          id="talk-topic"
          name="topic"
          maxLength={200}
          defaultValue={talk?.topic}
          disabled={busy}
          required
        />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field>
          <FieldLabel htmlFor="talk-date">{t("talks.heldOn")}</FieldLabel>
          <Input
            id="talk-date"
            name="heldOn"
            inputMode="numeric"
            defaultValue={talk ? calendarInput(talk.heldOn) : today}
            disabled={busy}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="talk-duration">{t("talks.duration")}</FieldLabel>
          <Input
            id="talk-duration"
            name="durationMinutes"
            inputMode="numeric"
            defaultValue={talk?.durationMinutes ?? ""}
            disabled={busy}
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="talk-presenter">{t("talks.presenter")}</FieldLabel>
        <select
          id="talk-presenter"
          name="presenterId"
          defaultValue={
            talk?.presenter.id ?? (presenters.some((member) => member.id === userId) ? userId : "")
          }
          disabled={busy}
          className={selectClass}
        >
          <option value="">—</option>
          {presenters.map((member) => (
            <option key={member.id} value={member.id}>
              {member.displayName}
            </option>
          ))}
        </select>
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("talks.gangs")}</legend>
        {gangs.map((gang) => (
          <label key={gang.id} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={gangIds.includes(gang.id)}
              disabled={busy}
              className={`${checkboxClass} mt-0.5`}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setGangIds((current) =>
                  checked ? [...current, gang.id] : current.filter((id) => id !== gang.id),
                );
              }}
            />
            <span className="break-words">
              {t("talks.gangMembers", { name: gang.name, count: gang.members })}
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("talks.labourers")}</legend>
        {picked.length ? (
          <ul className="space-y-1">
            {picked.map((labourer) => (
              <li key={labourer.id} className="flex items-center gap-2 text-sm">
                <span className="font-mono text-xs text-muted-foreground">{labourer.workerNo}</span>
                <span className="min-w-0 flex-1 break-words">{labourer.fullName}</span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={busy}
                  aria-label={t("talks.removeLabourer", { name: labourer.fullName })}
                  onClick={() =>
                    setPicked((current) => current.filter((entry) => entry.id !== labourer.id))
                  }
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {siteId ? (
          <LabourerPicker
            projectId={projectId}
            siteId={siteId}
            value={adding}
            label={t("talks.addLabourer")}
            disabled={busy}
            onChange={(labourer) => {
              if (labourer)
                setPicked((current) =>
                  current.some((entry) => entry.id === labourer.id)
                    ? current
                    : [...current, labourer],
                );
              setAdding(null);
            }}
          />
        ) : null}
      </fieldset>
      <Field>
        <FieldLabel htmlFor="talk-others">{t("talks.otherAttendees")}</FieldLabel>
        <Input
          id="talk-others"
          name="otherAttendees"
          inputMode="numeric"
          defaultValue={talk?.otherAttendees ? String(talk.otherAttendees) : ""}
          disabled={busy}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="talk-notes">{t("talks.notes")}</FieldLabel>
        <Textarea
          id="talk-notes"
          name="notes"
          maxLength={2000}
          defaultValue={talk?.notes ?? ""}
          disabled={busy}
        />
      </Field>
      <div className="space-y-2">
        <p className="text-sm font-medium">{t("talks.photo")}</p>
        <PhotoThumbs
          projectId={projectId}
          photos={photo ? [photo] : []}
          label={t("talks.photo")}
          disabled={busy}
          onRemove={() => setPhoto(null)}
        />
        {siteId && !photo ? (
          <PhotoUpload
            projectId={projectId}
            siteId={siteId}
            caption={t("talks.photoCaption")}
            label={t("talks.addPhoto")}
            disabled={busy}
            onUploaded={setPhoto}
          />
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          name="intent"
          value="draft"
          variant="outline"
          disabled={busy || !siteId}
        >
          {t("talks.saveDraft")}
        </Button>
        <Button type="submit" name="intent" value="confirm" disabled={busy || !siteId}>
          {t("talks.saveConfirm")}
        </Button>
      </div>
      <Dialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!busy && !next) setPending(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("talks.confirmTitle")}</DialogTitle>
            <DialogDescription>{t("talks.confirmHint")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              {t("actions.cancel")}
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                if (pending) void save(pending, true);
              }}
            >
              {t("talks.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}

/** A confirmed or cancelled talk: what was said, who attended, and follow-up actions. */
export function TalkRecord({
  projectId,
  talk,
  staff,
}: {
  projectId: string;
  talk: ToolboxTalk;
  staff: SafetyOptionsResponse["staff"];
}) {
  const t = useTranslations("safety");
  const [raising, setRaising] = useState(false);
  return (
    <div className="space-y-4">
      {talk.confirmedBy && talk.confirmedAt ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-sm">
          {t("talks.locked", {
            name: talk.confirmedBy.displayName,
            at: formatDateTime(talk.confirmedAt),
          })}
        </p>
      ) : null}
      {talk.cancelReason ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-sm break-words">
          {t("talks.cancelled", { reason: talk.cancelReason })}
        </p>
      ) : null}
      {talk.notes ? <p className="text-sm break-words whitespace-pre-wrap">{talk.notes}</p> : null}
      <PhotoThumbs
        projectId={projectId}
        photos={talk.photo ? [talk.photo] : []}
        label={t("talks.photo")}
      />
      <section aria-labelledby="talk-attendees" className="space-y-2">
        <h2 id="talk-attendees" className="text-base font-semibold">
          {t("talks.attendees")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("talks.attendance", { count: talk.attendeeCount, others: talk.otherAttendees })}
        </p>
        <ul className="divide-y rounded-md border text-sm">
          {talk.attendees.map((attendee) => (
            <li key={attendee.labourer.id} className="flex flex-wrap gap-2 p-2">
              <span className="font-mono text-xs text-muted-foreground">
                {attendee.labourer.workerNo}
              </span>
              <span className="break-words">{attendee.labourer.fullName}</span>
              <span className="text-muted-foreground">
                {attendee.gang
                  ? t("talks.viaGang", { gang: attendee.gang.name })
                  : t("talks.picked")}
              </span>
            </li>
          ))}
        </ul>
      </section>
      {talk.permissions.canRaiseAction ? (
        <>
          <Button variant="outline" onClick={() => setRaising(true)}>
            {t("talks.raiseAction")}
          </Button>
          <RaiseActionDialog
            projectId={projectId}
            staff={staff}
            source={{ kind: "toolbox_talk", id: talk.id }}
            open={raising}
            onOpenChange={setRaising}
          />
        </>
      ) : null}
    </div>
  );
}

/** Cancels a draft talk with a reason. */
export function CancelTalkButton({ projectId, talk }: { projectId: string; talk: ToolboxTalk }) {
  const t = useTranslations("safety");
  const { busy, error, setError, run } = useScheduleMutation();
  const [open, setOpen] = useState(false);
  if (!talk.permissions.canCancel) return null;
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {t("talks.cancelTalk")}
      </Button>
      <ReasonDialog
        open={open}
        title={t("talks.cancelTitle")}
        busy={busy}
        error={error}
        onOpenChange={setOpen}
        onSubmit={(reason) => {
          const parsed = toolboxTalkActionRequestSchema.safeParse({
            version: talk.version,
            action: "cancel",
            reason,
          });
          if (!parsed.success) return setError(t("actions.reasonInvalid"));
          void run(
            () =>
              liveRequest(
                `/projects/${projectId}/safety/talks/${talk.id}/actions`,
                toolboxTalkResponseSchema,
                { method: "POST", body: parsed.data },
              ),
            () => setOpen(false),
          );
        }}
      />
    </>
  );
}
