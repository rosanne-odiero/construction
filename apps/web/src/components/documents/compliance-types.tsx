"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { COMPLIANCE_LIMITS, COMPLIANCE_SCOPES } from "@pm-buddy/types";
import { complianceTypeResponseSchema, type ComplianceType } from "@pm-buddy/validation";
import { checkboxClass } from "@/components/safety/common";
import { FormError, selectClass } from "@/components/schedule/use-schedule-mutation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { complianceTypeLabel } from "@/lib/documents";
import { liveRequest } from "@/lib/live-api";
import { useDocumentProblem } from "./use-document-problem";

const reminderDays = (form: FormData) => Number(String(form.get("reminderDays") ?? "").trim());

/** The company's compliance item types (config.manage changes them; decision D-116). */
export function ComplianceTypesEditor({
  types,
  canConfigure,
}: {
  types: ComplianceType[];
  canConfigure: boolean;
}) {
  const t = useTranslations("documents");
  const problem = useDocumentProblem();
  const router = useRouter();
  const [editing, setEditing] = useState<ComplianceType | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const label = (type: ComplianceType) => complianceTypeLabel(type, (key) => t(key as never));

  async function send(operation: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await operation();
      setEditing(null);
      setSaved(true);
      router.refresh();
    } catch (caught) {
      setError(problem(caught));
    } finally {
      setBusy(false);
    }
  }

  function submit(form: FormData) {
    const expires = form.get("expires") === "on";
    if (editing === "new")
      return send(() =>
        liveRequest("/documents/compliance-types", complianceTypeResponseSchema, {
          method: "POST",
          body: {
            label: String(form.get("label") ?? "").trim(),
            scope: String(form.get("scope") ?? "project"),
            expires,
            reminderDays: reminderDays(form),
          },
        }),
      );
    if (!editing) return;
    return send(() =>
      liveRequest(`/documents/compliance-types/${editing.id}`, complianceTypeResponseSchema, {
        method: "PATCH",
        body: {
          ...(editing.starter ? {} : { label: String(form.get("label") ?? "").trim() }),
          expires,
          reminderDays: reminderDays(form),
          version: editing.version,
        },
      }),
    );
  }

  const toggle = (type: ComplianceType) =>
    send(() =>
      liveRequest(`/documents/compliance-types/${type.id}`, complianceTypeResponseSchema, {
        method: "PATCH",
        body: { active: !type.active, version: type.version },
      }),
    );

  return (
    <div className="space-y-4">
      {!canConfigure ? (
        <p role="note" className="rounded-md border bg-muted p-3 text-sm">
          {t("types.readOnly")}
        </p>
      ) : null}
      {editing === null ? <FormError message={error} /> : null}
      {saved ? (
        <p role="status" className="text-sm text-success">
          {t("types.saved")}
        </p>
      ) : null}
      {canConfigure ? (
        <Button
          onClick={() => {
            setError(null);
            setEditing("new");
          }}
        >
          <Plus className="size-4" aria-hidden />
          {t("types.add")}
        </Button>
      ) : null}
      <div className="relative overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="compliance-types">
          <caption className="sr-only">{t("types.title")}</caption>
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className="p-2 font-medium">
                {t("types.cols.item")}
              </th>
              <th scope="col" className="p-2 font-medium">
                {t("types.cols.scope")}
              </th>
              <th scope="col" className="p-2 font-medium">
                {t("types.cols.expires")}
              </th>
              <th scope="col" className="p-2 font-medium">
                {t("types.cols.reminder")}
              </th>
              <th scope="col" className="p-2 font-medium">
                {t("types.cols.active")}
              </th>
              {canConfigure ? (
                <th scope="col" className="p-2 font-medium">
                  {t("types.cols.actions")}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {types.map((type) => (
              <tr key={type.id} className="border-t align-top">
                <th scope="row" className="p-2 text-left font-medium">
                  {label(type)}
                  {type.complianceReview ? (
                    <span className="block text-xs font-normal text-muted-foreground">
                      {t("common.complianceReview")}
                    </span>
                  ) : null}
                </th>
                <td className="p-2">{t(`scopes.${type.scope}`)}</td>
                <td className="p-2">{type.expires ? t("types.yes") : t("types.no")}</td>
                <td className="p-2">
                  {type.expires ? t("types.reminderDays", { days: type.reminderDays }) : "—"}
                </td>
                <td className="p-2">
                  <StatusBadge tone={type.active ? "success" : "neutral"}>
                    {type.active ? t("types.yes") : t("types.retired")}
                  </StatusBadge>
                </td>
                {canConfigure ? (
                  <td className="p-2">
                    <span className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setError(null);
                          setEditing(type);
                        }}
                      >
                        {t("types.edit")}
                        <span className="sr-only"> {label(type)}</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void toggle(type)}
                      >
                        {type.active ? t("types.retire") : t("types.reactivate")}
                        <span className="sr-only"> {label(type)}</span>
                      </Button>
                    </span>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => (busy || open ? undefined : setEditing(null))}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing === "new" ? t("types.add") : editing ? label(editing) : ""}
            </DialogTitle>
          </DialogHeader>
          {editing ? (
            <form
              noValidate
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit(new FormData(event.currentTarget));
              }}
            >
              <FormError message={error} />
              {editing === "new" || !editing.starter ? (
                <Field>
                  <FieldLabel htmlFor="type-label">{t("types.label")}</FieldLabel>
                  <Input
                    id="type-label"
                    name="label"
                    required
                    minLength={3}
                    maxLength={120}
                    defaultValue={editing === "new" ? "" : (editing.label ?? "")}
                  />
                </Field>
              ) : null}
              {editing === "new" ? (
                <Field>
                  <FieldLabel htmlFor="type-scope">{t("types.scope")}</FieldLabel>
                  <select
                    id="type-scope"
                    name="scope"
                    className={selectClass}
                    defaultValue="project"
                  >
                    {COMPLIANCE_SCOPES.map((scope) => (
                      <option key={scope} value={scope}>
                        {t(`scopes.${scope}`)}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="expires"
                  className={checkboxClass}
                  defaultChecked={editing === "new" ? true : editing.expires}
                />
                {t("types.expiresLabel")}
              </label>
              <Field>
                <FieldLabel htmlFor="type-reminder">{t("types.reminderLabel")}</FieldLabel>
                <Input
                  id="type-reminder"
                  name="reminderDays"
                  type="number"
                  inputMode="numeric"
                  min={COMPLIANCE_LIMITS.minReminderDays}
                  max={COMPLIANCE_LIMITS.maxReminderDays}
                  required
                  defaultValue={
                    editing === "new" ? COMPLIANCE_LIMITS.defaultReminderDays : editing.reminderDays
                  }
                />
              </Field>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setEditing(null)}
                >
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? t("common.saving") : t("common.save")}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
