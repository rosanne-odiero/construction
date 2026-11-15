"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ComplianceRecordKind } from "@pm-buddy/types";
import { complianceHistoryResponseSchema, documentListResponseSchema } from "@pm-buddy/validation";
import { checkboxClass } from "@/components/safety/common";
import { FormError, selectClass } from "@/components/schedule/use-schedule-mutation";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";
import { dateValue, optional, useDocumentProblem } from "./use-document-problem";

export type EvidenceOption = { versionId: string; label: string };
export type EvidenceSource =
  | { mode: "project"; options: EvidenceOption[] }
  | { mode: "company"; projects: { id: string; code: string; name: string }[] };

/**
 * Record a compliance item, renew it, or state that it does not apply (documents.manage; company
 * items need config.manage). A renewal supersedes exactly the current record shown (D-116).
 */
export function ComplianceRecordForm({
  endpoint,
  typeId,
  expires,
  currentId,
  evidence,
  today,
}: {
  endpoint: string;
  typeId: string;
  expires: boolean;
  currentId: string | null;
  evidence: EvidenceSource;
  today: string;
}) {
  const t = useTranslations("documents");
  const problem = useDocumentProblem();
  const router = useRouter();
  const [kind, setKind] = useState<ComplianceRecordKind>("record");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [projectOptions, setProjectOptions] = useState<EvidenceOption[]>([]);
  const options = evidence.mode === "project" ? evidence.options : projectOptions;

  async function chooseProject(id: string) {
    setProjectId(id);
    setProjectOptions([]);
    if (!id) return;
    try {
      const list = await liveRequest(
        `/projects/${id}/documents?limit=100`,
        documentListResponseSchema,
      );
      setProjectOptions(
        list.documents.map((document) => ({
          versionId: document.current.id,
          label: `${document.title} · ${t("common.revision", { revision: document.current.revision })}`,
        })),
      );
    } catch (caught) {
      setError(problem(caught));
    }
  }

  async function submit(form: FormData) {
    setBusy(true);
    setError(null);
    setSaved(false);
    const body: Record<string, unknown> =
      kind === "not_applicable"
        ? { typeId, kind, reason: optional(form, "reason"), supersedesId: currentId }
        : {
            typeId,
            kind,
            referenceNo: optional(form, "referenceNo") ?? null,
            issuer: optional(form, "issuer") ?? null,
            issuedOn: dateValue(form, "issuedOn"),
            expiresOn: expires ? dateValue(form, "expiresOn") : null,
            evidenceVersionId: optional(form, "evidenceVersionId") ?? null,
            notes: optional(form, "notes") ?? null,
            supersedesId: currentId,
          };
    try {
      await liveRequest(endpoint, complianceHistoryResponseSchema, { method: "POST", body });
      setSaved(true);
      router.refresh();
    } catch (caught) {
      setError(problem(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      className="max-w-xl space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(new FormData(event.currentTarget));
      }}
    >
      <FormError message={error} />
      {saved ? (
        <p role="status" className="text-sm text-success">
          {t("compliance.saved")}
        </p>
      ) : null}
      <FieldSet className="gap-2">
        <FieldLegend variant="label">{t("compliance.kind")}</FieldLegend>
        {(["record", "not_applicable"] as const).map((value) => (
          <label key={value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="kind"
              value={value}
              checked={kind === value}
              onChange={() => setKind(value)}
              className={`${checkboxClass} mt-0.5`}
            />
            {t(`compliance.kinds.${value}`)}
          </label>
        ))}
      </FieldSet>
      {kind === "not_applicable" ? (
        <Field>
          <FieldLabel htmlFor="compliance-reason">{t("compliance.reason")}</FieldLabel>
          <Textarea id="compliance-reason" name="reason" required minLength={3} maxLength={500} />
        </Field>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="compliance-reference">{t("compliance.referenceNo")}</FieldLabel>
              <Input id="compliance-reference" name="referenceNo" maxLength={80} />
            </Field>
            <Field>
              <FieldLabel htmlFor="compliance-issuer">{t("compliance.issuer")}</FieldLabel>
              <Input id="compliance-issuer" name="issuer" maxLength={150} />
            </Field>
            <Field>
              <FieldLabel htmlFor="compliance-issued">{t("compliance.issuedOn")}</FieldLabel>
              <Input id="compliance-issued" name="issuedOn" type="date" max={today} />
            </Field>
            {expires ? (
              <Field>
                <FieldLabel htmlFor="compliance-expires">{t("compliance.expiresOn")}</FieldLabel>
                <Input id="compliance-expires" name="expiresOn" type="date" required />
              </Field>
            ) : null}
          </div>
          {evidence.mode === "company" ? (
            <Field>
              <FieldLabel htmlFor="compliance-project">{t("overview.cols.project")}</FieldLabel>
              <select
                id="compliance-project"
                className={selectClass}
                value={projectId}
                onChange={(event) => void chooseProject(event.target.value)}
              >
                <option value="">{t("compliance.noEvidence")}</option>
                {evidence.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.code} · {project.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field>
            <FieldLabel htmlFor="compliance-evidence">{t("compliance.evidence")}</FieldLabel>
            <select id="compliance-evidence" name="evidenceVersionId" className={selectClass}>
              <option value="">{t("compliance.noEvidence")}</option>
              {options.map((option) => (
                <option key={option.versionId} value={option.versionId}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="compliance-notes">
              {t("compliance.notes")} {t("common.optional")}
            </FieldLabel>
            <Textarea id="compliance-notes" name="notes" maxLength={1000} />
          </Field>
        </>
      )}
      {currentId ? <FieldDescription>{t("compliance.historyHint")}</FieldDescription> : null}
      <Button type="submit" disabled={busy}>
        {busy ? t("common.saving") : t("compliance.submit")}
      </Button>
    </form>
  );
}
