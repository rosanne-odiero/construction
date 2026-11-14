"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { MessageSquarePlus, Paperclip, Pencil } from "lucide-react";
import {
  INSTRUCTION_ISSUER_ROLES,
  INSTRUCTION_KINDS,
  type InstructionKind,
  type InstructionResponseKind,
} from "@pm-buddy/types";
import {
  instructionLogResponseSchema,
  type InstructionLogDetail,
  type InstructionOptionsResponse,
} from "@pm-buddy/validation";
import { checkboxClass } from "@/components/safety/common";
import { FormError, selectClass } from "@/components/schedule/use-schedule-mutation";
import { Button } from "@/components/ui/button";
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
import { instructionRetryPlan, newClientId } from "@/lib/documents";
import { formatDate } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { dateValue, optional, useDocumentProblem } from "./use-document-problem";

type Values = {
  kind?: InstructionKind;
  number?: string;
  issuerName?: string;
  issuerRole?: string;
  issuerFirm?: string | null;
  issuedOn?: string;
  receivedOn?: string;
  subject?: string;
  description?: string | null;
  costImplication?: boolean;
  timeImplication?: boolean;
  delayId?: string | null;
};

/** The instruction fields shared by the record and change forms. */
function InstructionFields({
  values,
  options,
  today,
  onKind,
  suggested,
}: {
  values: Values;
  options: InstructionOptionsResponse;
  today: string;
  onKind?: (kind: InstructionKind) => void;
  suggested?: string;
}) {
  const t = useTranslations("documents");
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="instruction-kind">{t("instructions.form.kind")}</FieldLabel>
          <select
            id="instruction-kind"
            name="kind"
            className={selectClass}
            defaultValue={values.kind ?? "architect_instruction"}
            onChange={(event) => onKind?.(event.target.value as InstructionKind)}
          >
            {INSTRUCTION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`instructionKinds.${kind}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="instruction-number">{t("instructions.form.number")}</FieldLabel>
          <Input
            id="instruction-number"
            name="number"
            required
            maxLength={30}
            className="font-mono"
            defaultValue={values.number ?? suggested ?? ""}
            key={suggested}
          />
          {suggested ? (
            <FieldDescription>
              {t("instructions.form.numberHint", { number: suggested })}
            </FieldDescription>
          ) : null}
        </Field>
        <Field>
          <FieldLabel htmlFor="instruction-issuer">{t("instructions.form.issuerName")}</FieldLabel>
          <Input
            id="instruction-issuer"
            name="issuerName"
            required
            maxLength={150}
            defaultValue={values.issuerName ?? ""}
            autoComplete="off"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="instruction-role">{t("instructions.form.issuerRole")}</FieldLabel>
          <select
            id="instruction-role"
            name="issuerRole"
            className={selectClass}
            defaultValue={values.issuerRole ?? "architect"}
          >
            {INSTRUCTION_ISSUER_ROLES.map((role) => (
              <option key={role} value={role}>
                {t(`issuerRoles.${role}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="instruction-firm">
            {t("instructions.form.issuerFirm")} {t("common.optional")}
          </FieldLabel>
          <Input
            id="instruction-firm"
            name="issuerFirm"
            maxLength={150}
            defaultValue={values.issuerFirm ?? ""}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="instruction-issued">{t("instructions.form.issuedOn")}</FieldLabel>
          <Input
            id="instruction-issued"
            name="issuedOn"
            type="date"
            required
            max={today}
            defaultValue={values.issuedOn ?? today}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="instruction-received">
            {t("instructions.form.receivedOn")}
          </FieldLabel>
          <Input
            id="instruction-received"
            name="receivedOn"
            type="date"
            required
            max={today}
            defaultValue={values.receivedOn ?? today}
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="instruction-subject">{t("instructions.form.subject")}</FieldLabel>
        <Input
          id="instruction-subject"
          name="subject"
          required
          minLength={3}
          maxLength={200}
          defaultValue={values.subject ?? ""}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="instruction-description">
          {t("instructions.form.description")} {t("common.optional")}
        </FieldLabel>
        <Textarea
          id="instruction-description"
          name="description"
          maxLength={4000}
          rows={4}
          defaultValue={values.description ?? ""}
        />
      </Field>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">
          {t("instructions.detail.implications")}
        </legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="costImplication"
            className={checkboxClass}
            defaultChecked={values.costImplication ?? false}
          />
          {t("instructions.form.cost")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="timeImplication"
            className={checkboxClass}
            defaultChecked={values.timeImplication ?? false}
          />
          {t("instructions.form.time")}
        </label>
      </fieldset>
      {options.delays.length ? (
        <Field>
          <FieldLabel htmlFor="instruction-delay">{t("instructions.form.delay")}</FieldLabel>
          <select
            id="instruction-delay"
            name="delayId"
            className={selectClass}
            defaultValue={values.delayId ?? ""}
          >
            <option value="">{t("instructions.form.noDelay")}</option>
            {options.delays.map((delay) => (
              <option key={delay.id} value={delay.id}>
                DLY-{delay.number} · {delay.cause}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
    </>
  );
}

const instructionBody = (form: FormData) => ({
  number: String(form.get("number") ?? "").trim(),
  kind: String(form.get("kind") ?? ""),
  issuerName: String(form.get("issuerName") ?? "").trim(),
  issuerRole: String(form.get("issuerRole") ?? ""),
  issuerFirm: optional(form, "issuerFirm") ?? null,
  issuedOn: dateValue(form, "issuedOn"),
  receivedOn: dateValue(form, "receivedOn"),
  subject: String(form.get("subject") ?? "").trim(),
  description: optional(form, "description") ?? null,
  costImplication: form.get("costImplication") === "on",
  timeImplication: form.get("timeImplication") === "on",
  delayId: optional(form, "delayId") ?? null,
});

/**
 * Record an instruction received (or, for a consultant, one they issue). Offline-ready: the record
 * ID and Idempotency-Key are made once per form, so a retry cannot record it twice (D-119).
 */
export function RecordInstructionForm({
  projectId,
  options,
  today,
}: {
  projectId: string;
  options: InstructionOptionsResponse;
  today: string;
}) {
  const t = useTranslations("documents");
  const problem = useDocumentProblem();
  const router = useRouter();
  const [ids, setIds] = useState(() => ({
    id: newClientId(),
    key: newClientId(),
    capturedAt: new Date().toISOString(),
  }));
  const [kind, setKind] = useState<InstructionKind>("architect_instruction");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(form: FormData) {
    setBusy(true);
    setError(null);
    try {
      await liveRequest(`/projects/${projectId}/instructions`, instructionLogResponseSchema, {
        method: "POST",
        body: {
          id: ids.id,
          capturedAt: ids.capturedAt,
          ...instructionBody(form),
          issuedByMe: form.get("issuedByMe") === "on",
        },
        headers: { "Idempotency-Key": ids.key },
      });
      router.push(`/projects/${projectId}/instructions/${ids.id}`);
    } catch (caught) {
      const plan = instructionRetryPlan(caught);
      if (plan === "recorded") {
        router.push(`/projects/${projectId}/instructions/${ids.id}`);
        return;
      }
      if (plan === "renew")
        setIds({ id: newClientId(), key: newClientId(), capturedAt: new Date().toISOString() });
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
        void submit(new FormData(event.currentTarget));
      }}
    >
      <FormError message={error} />
      <InstructionFields
        values={{ kind }}
        options={options}
        today={today}
        onKind={setKind}
        suggested={options.nextNumbers[kind]}
      />
      {options.isConsultant ? (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="issuedByMe" className={`${checkboxClass} mt-0.5`} />
          <span>
            {t("instructions.form.issuedByMe")}
            <span className="block text-xs text-muted-foreground">
              {t("instructions.form.issuedByMeHint")}
            </span>
          </span>
        </label>
      ) : null}
      <Button type="submit" disabled={busy}>
        {busy ? t("common.saving") : t("instructions.form.submit")}
      </Button>
    </form>
  );
}

type Move = InstructionLogDetail["permissions"]["moves"][number];
const MOVE_KIND: Record<Move, InstructionResponseKind> = {
  acknowledge: "acknowledge",
  action: "action",
  close: "close",
  reopen: "reopen",
};

/** Responses (append-only), attachments and changes on an instruction. */
export function InstructionActions({
  projectId,
  instruction,
  options,
  today,
}: {
  projectId: string;
  instruction: InstructionLogDetail;
  options: InstructionOptionsResponse | null;
  today: string;
}) {
  const t = useTranslations("documents");
  const problem = useDocumentProblem();
  const router = useRouter();
  const [dialog, setDialog] = useState<InstructionResponseKind | "edit" | "attach" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachKind, setAttachKind] = useState<"document" | "photo">("document");
  const base = `/projects/${projectId}/instructions/${instruction.id}`;
  const { permissions } = instruction;

  async function send(operation: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await operation();
      setDialog(null);
      router.refresh();
    } catch (caught) {
      setError(problem(caught));
    } finally {
      setBusy(false);
    }
  }

  function submit(form: FormData) {
    if (dialog === "edit")
      return send(() =>
        liveRequest(base, instructionLogResponseSchema, {
          method: "PATCH",
          body: { ...instructionBody(form), version: instruction.version },
        }),
      );
    if (dialog === "attach") {
      const id = optional(form, "attachment");
      return send(() =>
        liveRequest(`${base}/attachments`, instructionLogResponseSchema, {
          method: "POST",
          body: attachKind === "document" ? { documentVersionId: id } : { photoId: id },
        }),
      );
    }
    if (!dialog) return;
    return send(() =>
      liveRequest(`${base}/responses`, instructionLogResponseSchema, {
        method: "POST",
        body: { kind: dialog, body: optional(form, "body") ?? null, version: instruction.version },
      }),
    );
  }

  const open = (next: typeof dialog) => {
    setError(null);
    setDialog(next);
  };
  const moveLabel: Record<Move, string> = {
    acknowledge: t("instructions.detail.acknowledge"),
    action: t("instructions.detail.action"),
    close: t("instructions.detail.close"),
    reopen: t("instructions.detail.reopen"),
  };
  const responseKind = dialog && dialog !== "edit" && dialog !== "attach" ? dialog : null;
  const photos = options?.photos.filter((photo) => photo.verified) ?? [];

  return (
    <div className="flex flex-wrap gap-2">
      {permissions.moves.map((move) => (
        <Button
          key={move}
          variant={move === "reopen" ? "outline" : "default"}
          onClick={() => open(MOVE_KIND[move])}
        >
          {moveLabel[move]}
        </Button>
      ))}
      {permissions.canNote ? (
        <Button variant="secondary" onClick={() => open("note")}>
          <MessageSquarePlus className="size-4" aria-hidden />
          {t("instructions.detail.addNote")}
        </Button>
      ) : null}
      {permissions.canAttach && options ? (
        <Button variant="outline" onClick={() => open("attach")}>
          <Paperclip className="size-4" aria-hidden />
          {t("instructions.detail.attach")}
        </Button>
      ) : null}
      {permissions.canEdit && options ? (
        <Button variant="outline" onClick={() => open("edit")}>
          <Pencil className="size-4" aria-hidden />
          {t("instructions.detail.edit")}
        </Button>
      ) : null}

      <Dialog
        open={dialog !== null}
        onOpenChange={(next) => (busy || next ? undefined : setDialog(null))}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {dialog === "edit"
                ? t("instructions.detail.edit")
                : dialog === "attach"
                  ? t("instructions.detail.attach")
                  : responseKind === "note"
                    ? t("instructions.detail.addNote")
                    : responseKind
                      ? moveLabel[responseKind as Move]
                      : ""}
            </DialogTitle>
            <DialogDescription>
              {instruction.number} · {instruction.subject}
            </DialogDescription>
          </DialogHeader>
          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(new FormData(event.currentTarget));
            }}
          >
            <FormError message={error} />
            {dialog === "edit" && options ? (
              <InstructionFields
                values={{ ...instruction, delayId: instruction.delay?.id ?? null }}
                options={options}
                today={today}
              />
            ) : null}
            {dialog === "attach" && options ? (
              <>
                <fieldset className="flex flex-wrap gap-4">
                  <legend className="sr-only">{t("instructions.detail.attach")}</legend>
                  {(["document", "photo"] as const).map((kind) => (
                    <label key={kind} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="attachKind"
                        className={checkboxClass}
                        checked={attachKind === kind}
                        onChange={() => setAttachKind(kind)}
                      />
                      {kind === "document"
                        ? t("instructions.detail.attachDocument")
                        : t("instructions.detail.attachPhoto")}
                    </label>
                  ))}
                </fieldset>
                <Field>
                  <FieldLabel htmlFor="instruction-attachment">
                    {attachKind === "document"
                      ? t("instructions.detail.chooseDocument")
                      : t("instructions.detail.choosePhoto")}
                  </FieldLabel>
                  <select
                    id="instruction-attachment"
                    name="attachment"
                    className={selectClass}
                    required
                    key={attachKind}
                  >
                    {attachKind === "document"
                      ? options.versions.map((version) => (
                          <option key={version.versionId} value={version.versionId}>
                            {version.title} · {t("common.revision", { revision: version.revision })}
                            {version.state === "superseded"
                              ? ` (${t("versionStates.superseded")})`
                              : ""}
                          </option>
                        ))
                      : photos.map((photo) => (
                          <option key={photo.id} value={photo.id}>
                            {photo.caption ?? photo.id.slice(0, 8)}
                            {photo.capturedAt ? ` · ${formatDate(photo.capturedAt)}` : ""}
                          </option>
                        ))}
                  </select>
                </Field>
              </>
            ) : null}
            {responseKind ? (
              <Field>
                <FieldLabel htmlFor="instruction-body">
                  {t(
                    `instructions.detail.noteFor.${responseKind === "note" ? "note" : (responseKind as Move)}`,
                  )}
                </FieldLabel>
                <Textarea id="instruction-body" name="body" maxLength={2000} rows={4} />
              </Field>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? t("common.saving") : t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
