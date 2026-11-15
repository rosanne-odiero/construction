"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  APPROVAL_DECISIONS,
  APPROVAL_REQUEST_KINDS,
  type ApprovalChannel,
  type ApprovalDecision,
} from "@pm-buddy/types";
import { approvalResponseSchema, type ApprovalDetail } from "@pm-buddy/validation";
import { checkboxClass, ReasonDialog } from "@/components/safety/common";
import { FormError, selectClass } from "@/components/schedule/use-schedule-mutation";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";
import type { EvidenceOption } from "./compliance-form";
import { dateValue, optional, useDocumentProblem } from "./use-document-problem";

export type ApprovalDocumentOption = { documentId: string; versionId: string; label: string };

/** Ask a consultant to approve the current version of a document (D8.4, decision D-117). */
export function RaiseApprovalForm({
  projectId,
  documents,
  documentId,
  resubmissionOf,
  today,
  dueDefault,
}: {
  projectId: string;
  documents: ApprovalDocumentOption[];
  documentId?: string;
  resubmissionOf: { id: string; code: string; title: string; addressedTo: string } | null;
  today: string;
  dueDefault: string;
}) {
  const t = useTranslations("documents");
  const problem = useDocumentProblem();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preselected = documents.find((option) => option.documentId === documentId)?.versionId;

  async function submit(form: FormData) {
    setBusy(true);
    setError(null);
    try {
      const result = await liveRequest(`/projects/${projectId}/approvals`, approvalResponseSchema, {
        method: "POST",
        body: {
          kind: String(form.get("kind") ?? ""),
          title: String(form.get("title") ?? "").trim(),
          description: optional(form, "description") ?? null,
          documentVersionId: String(form.get("documentVersionId") ?? ""),
          addressedTo: String(form.get("addressedTo") ?? "").trim(),
          sentOn: dateValue(form, "sentOn"),
          dueOn: dateValue(form, "dueOn"),
          resubmissionOfId: resubmissionOf?.id ?? null,
        },
      });
      router.push(`/projects/${projectId}/approvals/${result.approval.id}`);
    } catch (caught) {
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
      {resubmissionOf ? (
        <p role="note" className="rounded-md border bg-muted p-3 text-sm">
          {t("approvals.form.resubmissionOf", { code: resubmissionOf.code })}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="approval-kind">{t("approvals.form.kind")}</FieldLabel>
          <select
            id="approval-kind"
            name="kind"
            className={selectClass}
            defaultValue="shop_drawing"
          >
            {APPROVAL_REQUEST_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`approvalKinds.${kind}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="approval-document">{t("approvals.form.document")}</FieldLabel>
          <select
            id="approval-document"
            name="documentVersionId"
            className={selectClass}
            required
            defaultValue={preselected ?? ""}
          >
            <option value="" disabled>
              {t("approvals.form.chooseDocument")}
            </option>
            {documents.map((option) => (
              <option key={option.versionId} value={option.versionId}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="approval-title">{t("approvals.form.titleLabel")}</FieldLabel>
        <Input
          id="approval-title"
          name="title"
          required
          minLength={3}
          maxLength={200}
          defaultValue={resubmissionOf?.title ?? ""}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="approval-description">
          {t("approvals.form.description2")} {t("common.optional")}
        </FieldLabel>
        <Textarea id="approval-description" name="description" maxLength={2000} rows={3} />
      </Field>
      <Field>
        <FieldLabel htmlFor="approval-to">{t("approvals.form.addressedTo")}</FieldLabel>
        <Input
          id="approval-to"
          name="addressedTo"
          required
          minLength={2}
          maxLength={150}
          defaultValue={resubmissionOf?.addressedTo ?? ""}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="approval-sent">{t("approvals.form.sentOn")}</FieldLabel>
          <Input
            id="approval-sent"
            name="sentOn"
            type="date"
            required
            max={today}
            defaultValue={today}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="approval-due">{t("approvals.form.dueOn")}</FieldLabel>
          <Input id="approval-due" name="dueOn" type="date" required defaultValue={dueDefault} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? t("common.saving") : t("approvals.form.submit")}
        </Button>
        <Button asChild variant="outline">
          <Link href={`/projects/${projectId}?tab=instructions&view=approvals`}>
            {t("common.cancel")}
          </Link>
        </Button>
      </div>
    </form>
  );
}

/**
 * Answer a request in the app (never its raiser or the file's uploader), or record a consultant's
 * signed paper response with its scan; both are bound to the file's SHA-256 (decision D-117).
 */
export function ApprovalActions({
  projectId,
  approval,
  evidence,
  today,
}: {
  projectId: string;
  approval: ApprovalDetail;
  evidence: EvidenceOption[];
  today: string;
}) {
  const t = useTranslations("documents");
  const problem = useDocumentProblem();
  const router = useRouter();
  const { permissions } = approval;
  const channels: ApprovalChannel[] = [
    ...(permissions.canRespond ? (["in_app"] as const) : []),
    ...(permissions.canRecordPaper ? (["paper"] as const) : []),
  ];
  const [channel, setChannel] = useState<ApprovalChannel | null>(channels[0] ?? null);
  const [decision, setDecision] = useState<ApprovalDecision>("approved");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const base = `/projects/${projectId}/approvals/${approval.id}`;
  const sha256 = approval.document.restricted ? null : approval.document.sha256;

  async function respond(form: FormData) {
    if (!channel || !sha256) return;
    if (form.get("confirmDigest") !== "on") {
      setError(t("approvals.detail.confirmDigest"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await liveRequest(`${base}/response`, approvalResponseSchema, {
        method: "POST",
        body: {
          decision,
          comments: optional(form, "comments") ?? null,
          respondedOn: dateValue(form, "respondedOn"),
          channel,
          ...(channel === "paper"
            ? {
                responderName: optional(form, "responderName") ?? null,
                responderFirm: optional(form, "responderFirm") ?? null,
                evidenceVersionId: optional(form, "evidenceVersionId") ?? null,
              }
            : {}),
          documentSha256: sha256,
          version: approval.version,
        },
      });
      router.refresh();
    } catch (caught) {
      setError(problem(caught));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(reason: string) {
    setBusy(true);
    setError(null);
    try {
      await liveRequest(`${base}/cancel`, approvalResponseSchema, {
        method: "POST",
        body: { reason, version: approval.version },
      });
      setCancelling(false);
      router.refresh();
    } catch (caught) {
      setError(problem(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {permissions.respondBlockedBy ? (
        <p role="note" className="rounded-md border bg-muted p-3 text-sm">
          {t(`approvals.detail.blocked.${permissions.respondBlockedBy}`)}
        </p>
      ) : null}
      {channel && sha256 ? (
        <section aria-labelledby="approval-respond" className="space-y-3">
          <h2 id="approval-respond" className="text-base font-semibold">
            {channel === "paper"
              ? t("approvals.detail.recordPaper")
              : t("approvals.detail.respond")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {channel === "paper"
              ? t("approvals.detail.recordPaperHint")
              : t("approvals.detail.respondHint")}
          </p>
          <form
            noValidate
            className="max-w-2xl space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void respond(new FormData(event.currentTarget));
            }}
          >
            <FormError message={cancelling ? null : error} />
            {channels.length > 1 ? (
              <FieldSet className="gap-2">
                <FieldLegend variant="label">{t("approvals.detail.channel")}</FieldLegend>
                {channels.map((value) => (
                  <label key={value} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="channel"
                      className={checkboxClass}
                      checked={channel === value}
                      onChange={() => setChannel(value)}
                    />
                    {t(`channels.${value}`)}
                  </label>
                ))}
              </FieldSet>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="approval-decision">
                  {t("approvals.detail.decision")}
                </FieldLabel>
                <select
                  id="approval-decision"
                  className={selectClass}
                  value={decision}
                  onChange={(event) => setDecision(event.target.value as ApprovalDecision)}
                >
                  {APPROVAL_DECISIONS.map((value) => (
                    <option key={value} value={value}>
                      {t(`decisions.${value}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="approval-responded">
                  {t("approvals.detail.respondedOnLabel")}
                </FieldLabel>
                <Input
                  id="approval-responded"
                  name="respondedOn"
                  type="date"
                  required
                  min={approval.sentOn}
                  max={today}
                  defaultValue={today}
                />
              </Field>
            </div>
            {channel === "paper" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="approval-responder">
                    {t("approvals.detail.responderName")}
                  </FieldLabel>
                  <Input id="approval-responder" name="responderName" required maxLength={150} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="approval-firm">
                    {t("approvals.detail.responderFirm")} {t("common.optional")}
                  </FieldLabel>
                  <Input id="approval-firm" name="responderFirm" maxLength={150} />
                </Field>
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="approval-evidence">
                    {t("approvals.detail.evidenceLabel")}
                  </FieldLabel>
                  <select
                    id="approval-evidence"
                    name="evidenceVersionId"
                    className={selectClass}
                    required
                    defaultValue=""
                  >
                    <option value="" disabled>
                      {t("approvals.form.chooseDocument")}
                    </option>
                    {evidence.map((option) => (
                      <option key={option.versionId} value={option.versionId}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            ) : null}
            <Field>
              <FieldLabel htmlFor="approval-comments">{t("approvals.detail.comments")}</FieldLabel>
              <Textarea
                id="approval-comments"
                name="comments"
                maxLength={2000}
                rows={3}
                required={decision !== "approved"}
              />
              <FieldDescription>{t("approvals.detail.commentsHint")}</FieldDescription>
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="confirmDigest"
                className={`${checkboxClass} mt-0.5`}
                required
              />
              <span>
                {t("approvals.detail.confirmDigest")}
                <span className="block font-mono text-xs break-all text-muted-foreground">
                  {sha256}
                </span>
              </span>
            </label>
            <Button type="submit" disabled={busy}>
              {busy ? t("common.saving") : t("approvals.detail.submit")}
            </Button>
          </form>
        </section>
      ) : null}
      {permissions.canCancel || permissions.canResubmit ? (
        <div className="flex flex-wrap gap-2">
          {permissions.canResubmit && !approval.document.restricted ? (
            <Button asChild>
              <Link
                href={`/projects/${projectId}/approvals/new?resubmissionOf=${approval.id}&documentId=${approval.document.documentId}`}
              >
                {t("approvals.detail.resubmit")}
              </Link>
            </Button>
          ) : null}
          {permissions.canCancel ? (
            <Button
              variant="outline"
              onClick={() => {
                setError(null);
                setCancelling(true);
              }}
            >
              {t("approvals.detail.cancel")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ReasonDialog
        open={cancelling}
        title={t("approvals.detail.cancel")}
        busy={busy}
        error={cancelling ? error : null}
        onOpenChange={setCancelling}
        onSubmit={(reason) => void cancel(reason)}
        confirmLabel={t("approvals.detail.cancel")}
      />
    </div>
  );
}
