"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { CorrectiveActionSource } from "@pm-buddy/types";
import {
  correctiveActionActionRequestSchema,
  correctiveActionResponseSchema,
  createCorrectiveActionRequestSchema,
  updateCorrectiveActionRequestSchema,
  type CorrectiveAction,
  type SafetyOptionsResponse,
} from "@pm-buddy/validation";
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
import { actionStatusTone } from "@/lib/safety";
import { field, ReasonDialog } from "./common";

type Mode = "done" | "verify" | "reject" | "cancel" | "edit";

/** One corrective action with its state and the transitions its `permissions` allow. */
export function ActionCard({
  projectId,
  action,
  staff,
  showSource = true,
}: {
  projectId: string;
  action: CorrectiveAction;
  staff: SafetyOptionsResponse["staff"];
  showSource?: boolean;
}) {
  const t = useTranslations("safety");
  const { busy, error, setError, run } = useScheduleMutation();
  const [mode, setMode] = useState<Mode | null>(null);
  const open = (next: Mode) => {
    setError(null);
    setMode(next);
  };
  const path = `/projects/${projectId}/safety/corrective-actions/${action.id}`;

  function transition(verb: "done" | "verify" | "reject" | "cancel", extra: object) {
    const parsed = correctiveActionActionRequestSchema.safeParse({
      version: action.version,
      action: verb,
      ...extra,
    });
    if (!parsed.success) {
      setError(t(verb === "done" ? "actionsList.invalid" : "actions.reasonInvalid"));
      return;
    }
    void run(
      () =>
        liveRequest(`${path}/actions`, correctiveActionResponseSchema, {
          method: "POST",
          body: parsed.data,
        }),
      () => setMode(null),
    );
  }

  function edit(form: FormData) {
    const dueOn = parseCalendarInput(field(form, "dueOn"));
    const parsed = updateCorrectiveActionRequestSchema.safeParse({
      version: action.version,
      description: field(form, "description"),
      ownerId: field(form, "ownerId"),
      dueOn: dueOn ?? undefined,
    });
    if (!parsed.success || !dueOn) {
      setError(t("actionsList.invalid"));
      return;
    }
    void run(
      () =>
        liveRequest(path, correctiveActionResponseSchema, { method: "PATCH", body: parsed.data }),
      () => setMode(null),
    );
  }

  const source = action.incident ?? action.inspection ?? action.toolboxTalk;
  const { permissions } = action;
  const buttons = (
    [
      ["done", permissions.canMarkDone, t("actionsList.markDone", { code: action.code })],
      ["verify", permissions.canVerify, t("actionsList.verify", { code: action.code })],
      ["reject", permissions.canReject, t("actionsList.reject", { code: action.code })],
      ["edit", permissions.canEdit, t("actionsList.edit", { code: action.code })],
      ["cancel", permissions.canCancel, t("actionsList.cancel", { code: action.code })],
    ] as const
  ).filter(([, allowed]) => allowed);

  return (
    <article
      aria-label={t("actionsList.cardLabel", { code: action.code })}
      className="space-y-2 rounded-md border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{action.code}</span>
        <StatusBadge
          tone={actionStatusTone[action.status]}
          className="h-auto max-w-full whitespace-normal text-left"
        >
          {t(`actionStatus.${action.status}`)}
        </StatusBadge>
        {action.overdue && action.daysOverdue ? (
          <StatusBadge tone="danger" className="h-auto max-w-full whitespace-normal text-left">
            {t("actionsList.daysOverdue", { days: action.daysOverdue })}
          </StatusBadge>
        ) : null}
      </div>
      <p className="text-sm break-words whitespace-pre-wrap">{action.description}</p>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>{t("actionsList.owner", { name: action.owner.displayName })}</span>
        <span>{t("actionsList.due", { date: formatCalendarDate(action.dueOn) })}</span>
        {showSource ? (
          source ? (
            <span>
              {action.incident ? (
                <Link
                  className="underline"
                  href={`/projects/${projectId}/safety/incidents/${action.incident.id}`}
                >
                  {t("actionsList.from", {
                    source: t(`actionSource.${action.source}`),
                    code: source.code,
                  })}
                </Link>
              ) : (
                t("actionsList.from", {
                  source: t(`actionSource.${action.source}`),
                  code: source.code,
                })
              )}
            </span>
          ) : (
            <span>{t("actionsList.fromOther")}</span>
          )
        ) : null}
      </p>
      {action.doneBy && action.doneAt ? (
        <p className="text-sm break-words">
          {t("actionsList.doneBy", {
            name: action.doneBy.displayName,
            at: formatDateTime(action.doneAt),
          })}
          {action.doneNote ? `: ${action.doneNote}` : ""}
        </p>
      ) : null}
      {action.status === "done" ? (
        <p className="text-sm text-muted-foreground">{t("actionsList.awaiting")}</p>
      ) : null}
      {action.verifiedBy && action.verifiedAt ? (
        <p className="text-sm">
          {t("actionsList.verifiedBy", {
            name: action.verifiedBy.displayName,
            at: formatDateTime(action.verifiedAt),
          })}
        </p>
      ) : null}
      {action.rejectCount && action.lastRejectReason ? (
        <p className="text-sm break-words">
          {t("actionsList.rejected", {
            count: action.rejectCount,
            reason: action.lastRejectReason,
          })}
        </p>
      ) : null}
      {action.cancelReason ? (
        <p className="text-sm break-words">
          {t("actionsList.cancelled", { reason: action.cancelReason })}
        </p>
      ) : null}
      {buttons.length ? (
        <div className="flex flex-wrap gap-2">
          {buttons.map(([key, , label]) => (
            <Button
              key={key}
              size="sm"
              variant={key === "done" || key === "verify" ? "default" : "outline"}
              className="h-auto min-h-8 max-w-full whitespace-normal"
              onClick={() => open(key)}
            >
              {label}
            </Button>
          ))}
        </div>
      ) : null}
      <ReasonDialog
        open={mode === "reject" || mode === "cancel"}
        title={mode ? t(`actionsList.dialogTitle.${mode}`) : ""}
        busy={busy}
        error={error}
        onOpenChange={(next) => setMode(next ? mode : null)}
        onSubmit={(reason) => transition(mode === "reject" ? "reject" : "cancel", { reason })}
      />
      <Dialog
        open={mode === "done" || mode === "verify" || mode === "edit"}
        onOpenChange={(next) => {
          if (!busy && !next) setMode(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{mode ? t(`actionsList.dialogTitle.${mode}`) : ""}</DialogTitle>
            <DialogDescription className="break-words">{action.description}</DialogDescription>
          </DialogHeader>
          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              if (mode === "edit") edit(form);
              else if (mode === "done") {
                const note = field(form, "note");
                transition("done", note ? { note } : {});
              } else transition("verify", {});
            }}
          >
            <FormError message={error} />
            {mode === "done" ? (
              <Field>
                <FieldLabel htmlFor={`action-note-${action.id}`}>
                  {t("actionsList.doneNote")}
                </FieldLabel>
                <Textarea id={`action-note-${action.id}`} name="note" maxLength={1000} />
              </Field>
            ) : null}
            {mode === "edit" ? (
              <ActionFields
                idPrefix={`edit-${action.id}`}
                staff={staff}
                defaults={{
                  description: action.description,
                  ownerId: action.owner.id,
                  dueOn: calendarInput(action.dueOn),
                }}
              />
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setMode(null)}>
                {t("actions.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {mode === "edit" ? t("actions.save") : t("actions.confirm")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </article>
  );
}

/** Description, owner (someone who can read safety records) and due date. */
export function ActionFields({
  idPrefix,
  staff,
  defaults,
}: {
  idPrefix: string;
  staff: SafetyOptionsResponse["staff"];
  defaults?: { description: string; ownerId: string; dueOn: string };
}) {
  const t = useTranslations("safety.actionsList");
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-description`}>{t("description")}</FieldLabel>
        <Textarea
          id={`${idPrefix}-description`}
          name="description"
          maxLength={1000}
          defaultValue={defaults?.description}
          required
        />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-owner`}>{t("ownerLabel")}</FieldLabel>
          <select
            id={`${idPrefix}-owner`}
            name="ownerId"
            defaultValue={defaults?.ownerId ?? ""}
            className={selectClass}
          >
            <option value="" disabled>
              —
            </option>
            {staff.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-due`}>{t("dueOn")}</FieldLabel>
          <Input
            id={`${idPrefix}-due`}
            name="dueOn"
            placeholder="DD/MM/YYYY"
            inputMode="numeric"
            defaultValue={defaults?.dueOn}
          />
        </Field>
      </div>
    </>
  );
}

/**
 * Raises a corrective action from a given source (an incident, an inspection, a toolbox talk) or,
 * without one, as "other".
 */
export function RaiseActionDialog({
  projectId,
  staff,
  source,
  open,
  onOpenChange,
}: {
  projectId: string;
  staff: SafetyOptionsResponse["staff"];
  source: { kind: Exclude<CorrectiveActionSource, "other">; id: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("safety");
  const { busy, error, setError, run } = useScheduleMutation();

  function submit(form: FormData) {
    const dueOn = parseCalendarInput(field(form, "dueOn"));
    const reference =
      source?.kind === "incident"
        ? { incidentId: source.id }
        : source?.kind === "inspection"
          ? { inspectionId: source.id }
          : source?.kind === "toolbox_talk"
            ? { toolboxTalkId: source.id }
            : {};
    const parsed = createCorrectiveActionRequestSchema.safeParse({
      source: source?.kind ?? "other",
      ...reference,
      description: field(form, "description"),
      ownerId: field(form, "ownerId"),
      dueOn,
    });
    if (!parsed.success || !dueOn) {
      setError(t("actionsList.invalid"));
      return;
    }
    void run(
      () =>
        liveRequest(
          `/projects/${projectId}/safety/corrective-actions`,
          correctiveActionResponseSchema,
          {
            method: "POST",
            body: parsed.data,
          },
        ),
      () => onOpenChange(false),
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setError(null);
          onOpenChange(next);
        }
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("actionsList.raise")}</DialogTitle>
          <DialogDescription>{t("actionsList.raiseHint")}</DialogDescription>
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
          <p className="text-sm">
            {t("actionsList.source")}: {t(`actionSource.${source?.kind ?? "other"}`)}
          </p>
          <ActionFields idPrefix="raise-action" staff={staff} />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t("actions.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {t("actionsList.raise")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
