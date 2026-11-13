"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Pencil, Plus } from "lucide-react";
import { INSTRUCTION_ISSUER_ROLES, type InstructionIssuerRole } from "@pm-buddy/types";
import { instructionResponseSchema, type Instruction } from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
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
import { liveRequest } from "@/lib/live-api";

type Form = {
  number: string;
  issuedOn: string;
  issuerName: string;
  issuerRole: InstructionIssuerRole;
  subject: string;
  description: string;
  attachmentName: string;
  attachmentReference: string;
  status: "open" | "closed";
};

const empty = (): Form => ({
  number: "",
  issuedOn: new Date().toISOString().slice(0, 10),
  issuerName: "",
  issuerRole: "architect",
  subject: "",
  description: "",
  attachmentName: "",
  attachmentReference: "",
  status: "open",
});

/**
 * Registers or edits an Architect's/Engineer's Instruction. Attachments are metadata only (a name
 * and a reference such as a drawing number); no file is uploaded.
 */
export function InstructionButton({
  projectId,
  instruction,
}: {
  projectId: string;
  instruction?: Instruction;
}) {
  const t = useTranslations("instructions.form");
  const tRoles = useTranslations("instructions.roles");
  const problem = useProblemMessage();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(empty);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const editing = instruction !== undefined;

  function show() {
    setFailure(null);
    setForm(
      instruction
        ? {
            number: instruction.number,
            issuedOn: instruction.issuedOn,
            issuerName: instruction.issuerName,
            issuerRole: instruction.issuerRole,
            subject: instruction.subject,
            description: instruction.description ?? "",
            attachmentName: instruction.attachments[0]?.name ?? "",
            attachmentReference: instruction.attachments[0]?.reference ?? "",
            status: instruction.status,
          }
        : empty(),
    );
    setOpen(true);
  }

  async function submit() {
    setBusy(true);
    setFailure(null);
    // The form edits the first attachment; any others are kept as they are.
    const attachments = [
      ...(form.attachmentName.trim()
        ? [{ name: form.attachmentName.trim(), reference: form.attachmentReference.trim() }]
        : []),
      ...(instruction?.attachments.slice(1) ?? []),
    ];
    const body = {
      number: form.number.trim(),
      issuedOn: form.issuedOn,
      issuerName: form.issuerName.trim(),
      issuerRole: form.issuerRole,
      subject: form.subject.trim(),
      description: form.description.trim(),
      attachments,
    };
    try {
      await liveRequest(
        editing
          ? `/projects/${projectId}/bq/instructions/${instruction.id}`
          : `/projects/${projectId}/bq/instructions`,
        instructionResponseSchema,
        editing
          ? {
              method: "PATCH",
              body: { ...body, status: form.status, version: instruction.version },
            }
          : { method: "POST", body },
      );
      setOpen(false);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  const valid =
    /^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,29}$/.test(form.number.trim()) &&
    form.issuerName.trim().length >= 2 &&
    form.subject.trim().length >= 3 &&
    /^\d{4}-\d{2}-\d{2}$/.test(form.issuedOn);
  const id = editing ? `instruction-${instruction.id}` : "instruction-new";

  return (
    <>
      {editing ? (
        <Button
          size="sm"
          variant="outline"
          onClick={show}
          aria-label={t("editLabel", { number: instruction.number })}
        >
          <Pencil aria-hidden /> {t("edit")}
        </Button>
      ) : (
        <Button onClick={show}>
          <Plus aria-hidden /> {t("create")}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? t("editTitle") : t("createTitle")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <form
            id={id}
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) void submit();
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${id}-number`}>{t("number")}</FieldLabel>
              <Input
                id={`${id}-number`}
                value={form.number}
                maxLength={30}
                onChange={(event) => setForm({ ...form, number: event.target.value })}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-date`}>{t("issuedOn")}</FieldLabel>
              <Input
                id={`${id}-date`}
                type="date"
                value={form.issuedOn}
                onChange={(event) => setForm({ ...form, issuedOn: event.target.value })}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-issuer`}>{t("issuerName")}</FieldLabel>
              <Input
                id={`${id}-issuer`}
                value={form.issuerName}
                maxLength={150}
                onChange={(event) => setForm({ ...form, issuerName: event.target.value })}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-role`}>{t("issuerRole")}</FieldLabel>
              <select
                id={`${id}-role`}
                value={form.issuerRole}
                onChange={(event) =>
                  setForm({ ...form, issuerRole: event.target.value as InstructionIssuerRole })
                }
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                {INSTRUCTION_ISSUER_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {tRoles(role)}
                  </option>
                ))}
              </select>
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${id}-subject`}>{t("subject")}</FieldLabel>
              <Input
                id={`${id}-subject`}
                value={form.subject}
                maxLength={200}
                onChange={(event) => setForm({ ...form, subject: event.target.value })}
                required
              />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${id}-description`}>{t("details")}</FieldLabel>
              <Textarea
                id={`${id}-description`}
                value={form.description}
                maxLength={4000}
                rows={3}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-attachment`}>{t("attachmentName")}</FieldLabel>
              <Input
                id={`${id}-attachment`}
                value={form.attachmentName}
                maxLength={150}
                onChange={(event) => setForm({ ...form, attachmentName: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-reference`}>{t("attachmentReference")}</FieldLabel>
              <Input
                id={`${id}-reference`}
                value={form.attachmentReference}
                maxLength={300}
                onChange={(event) => setForm({ ...form, attachmentReference: event.target.value })}
              />
              <FieldDescription>{t("attachmentHint")}</FieldDescription>
            </Field>
            {editing ? (
              <fieldset className="space-y-2 sm:col-span-2">
                <legend className="text-sm font-medium">{t("status")}</legend>
                {(["open", "closed"] as const).map((status) => (
                  <label key={status} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={`${id}-status`}
                      value={status}
                      checked={form.status === status}
                      onChange={() => setForm({ ...form, status })}
                      className="size-4 accent-primary"
                    />
                    {t(`statuses.${status}`)}
                  </label>
                ))}
              </fieldset>
            ) : null}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" form={id} disabled={busy || !valid}>
              {editing ? t("save") : t("submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
