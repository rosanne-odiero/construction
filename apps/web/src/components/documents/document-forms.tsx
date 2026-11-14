"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Archive, FilePlus2, Pencil, Stamp } from "lucide-react";
import {
  CONFIDENTIAL_DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORIES,
  DOCUMENT_FILE_EXTENSIONS,
  DRAWING_DISCIPLINES,
  ISSUE_PURPOSES,
  type DocumentCategory,
} from "@pm-buddy/types";
import { documentResponseSchema, type DocumentDetail } from "@pm-buddy/validation";
import { ReasonDialog } from "@/components/safety/common";
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
import { fileTooLarge } from "@/lib/documents";
import { liveRequest, liveUpload } from "@/lib/live-api";
import { optional, useDocumentProblem } from "./use-document-problem";

const ACCEPT = [
  ...Object.keys(DOCUMENT_FILE_EXTENSIONS),
  ...Object.values(DOCUMENT_FILE_EXTENSIONS).map((extension) => `.${extension}`),
  ".jpeg",
].join(",");
const CONFIDENTIAL = new Set<string>(CONFIDENTIAL_DOCUMENT_CATEGORIES);

/** Shared state of a document form: busy flag, the error shown and the file chosen. */
function useDocumentForm() {
  const problem = useDocumentProblem();
  const t = useTranslations("documents");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(operation: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      return await operation();
    } catch (caught) {
      setError(problem(caught));
      return null;
    } finally {
      setBusy(false);
    }
  }
  /** The chosen file, or null with the error shown (missing or over 25 MB). */
  function file(form: FormData): File | null {
    const value = form.get("file");
    if (!(value instanceof File) || value.size === 0) {
      setError(t("upload.chooseFile"));
      return null;
    }
    if (fileTooLarge(value.size)) {
      setError(t("upload.tooLarge"));
      return null;
    }
    return value;
  }
  return { busy, error, setError, run, file };
}

function VersionFields({
  idPrefix,
  revision,
  noteRequired,
}: {
  idPrefix: string;
  revision?: string;
  noteRequired: boolean;
}) {
  const t = useTranslations("documents");
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-revision`}>{t("upload.revision")}</FieldLabel>
        <Input
          id={`${idPrefix}-revision`}
          name="revision"
          required
          maxLength={10}
          defaultValue={revision}
          autoCapitalize="characters"
          className="font-mono"
        />
        <FieldDescription>{t("upload.revisionHint")}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-purpose`}>{t("upload.purpose")}</FieldLabel>
        <select id={`${idPrefix}-purpose`} name="issuePurpose" className={selectClass}>
          <option value="">{t("upload.noPurpose")}</option>
          {ISSUE_PURPOSES.map((purpose) => (
            <option key={purpose} value={purpose}>
              {t(`purposes.${purpose}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-note`}>
          {t("upload.changeNote")} {noteRequired ? null : t("common.optional")}
        </FieldLabel>
        <Textarea
          id={`${idPrefix}-note`}
          name="changeNote"
          maxLength={1000}
          required={noteRequired}
        />
        {noteRequired ? <FieldDescription>{t("upload.changeNoteHint")}</FieldDescription> : null}
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-file`}>{t("upload.file")}</FieldLabel>
        <Input id={`${idPrefix}-file`} name="file" type="file" accept={ACCEPT} required />
        <FieldDescription>{t("upload.description")}</FieldDescription>
      </Field>
    </>
  );
}

/** Upload a new document with its first version (documents.manage; decision D-114). */
export function UploadDocumentForm({
  projectId,
  canSeeConfidential,
  initialCategory,
}: {
  projectId: string;
  canSeeConfidential: boolean;
  initialCategory?: DocumentCategory;
}) {
  const t = useTranslations("documents");
  const router = useRouter();
  const { busy, error, run, file } = useDocumentForm();
  const categories = DOCUMENT_CATEGORIES.filter(
    (category) => canSeeConfidential || !CONFIDENTIAL.has(category),
  );
  const [category, setCategory] = useState<DocumentCategory>(
    initialCategory && categories.includes(initialCategory) ? initialCategory : "drawing",
  );
  const drawing = category === "drawing";

  async function submit(form: FormData) {
    const chosen = file(form);
    if (!chosen) return;
    const fields: Record<string, string> = {
      category,
      title: String(form.get("title") ?? "").trim(),
      revision: String(form.get("revision") ?? "").trim(),
    };
    for (const name of drawing
      ? ["drawingNumber", "discipline", "issuePurpose", "changeNote"]
      : ["reference", "issuePurpose", "changeNote"]) {
      const value = optional(form, name);
      if (value) fields[name] = value;
    }
    const result = await run(() =>
      liveUpload(`/projects/${projectId}/documents`, chosen, documentResponseSchema, fields),
    );
    if (result) router.push(`/projects/${projectId}/documents/${result.document.id}`);
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
      <Field>
        <FieldLabel htmlFor="doc-category">{t("upload.category")}</FieldLabel>
        <select
          id="doc-category"
          name="category"
          className={selectClass}
          value={category}
          onChange={(event) => setCategory(event.target.value as DocumentCategory)}
        >
          {categories.map((value) => (
            <option key={value} value={value}>
              {t(`categories.${value}`)}
            </option>
          ))}
        </select>
        {CONFIDENTIAL.has(category) ? (
          <FieldDescription>{t("upload.confidentialNote")}</FieldDescription>
        ) : null}
      </Field>
      <Field>
        <FieldLabel htmlFor="doc-title">{t("upload.titleLabel")}</FieldLabel>
        <Input id="doc-title" name="title" required minLength={3} maxLength={200} />
      </Field>
      {drawing ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="doc-number">{t("upload.drawingNumber")}</FieldLabel>
            <Input
              id="doc-number"
              name="drawingNumber"
              required
              maxLength={40}
              className="font-mono"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="doc-discipline">{t("upload.discipline")}</FieldLabel>
            <select id="doc-discipline" name="discipline" className={selectClass} required>
              {DRAWING_DISCIPLINES.map((discipline) => (
                <option key={discipline} value={discipline}>
                  {t(`disciplines.${discipline}`)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : (
        <Field>
          <FieldLabel htmlFor="doc-reference">
            {t("upload.reference")} {t("common.optional")}
          </FieldLabel>
          <Input id="doc-reference" name="reference" maxLength={80} />
        </Field>
      )}
      <VersionFields idPrefix="doc" noteRequired={false} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? t("upload.submitting") : t("upload.submit")}
        </Button>
        <Button asChild variant="outline">
          <Link href={`/projects/${projectId}?tab=documents`}>{t("common.cancel")}</Link>
        </Button>
      </div>
    </form>
  );
}

function DocumentDialog({
  open,
  onOpenChange,
  title,
  hint,
  busy,
  error,
  submitLabel,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  hint?: string;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  onSubmit: (form: FormData) => void;
  children: React.ReactNode;
}) {
  const t = useTranslations("documents");
  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {hint ? <DialogDescription>{hint}</DialogDescription> : null}
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(new FormData(event.currentTarget));
          }}
        >
          <FormError message={error} />
          {children}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t("common.saving") : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The actions on a document: new version, change details, withdraw, ask for approval. */
export function DocumentActions({
  projectId,
  document,
}: {
  projectId: string;
  document: DocumentDetail;
}) {
  const t = useTranslations("documents");
  const router = useRouter();
  const [dialog, setDialog] = useState<"version" | "edit" | "withdraw" | null>(null);
  const { busy, error, setError, run, file } = useDocumentForm();
  const base = `/projects/${projectId}/documents/${document.id}`;
  const { permissions } = document;
  const openDialog = (next: typeof dialog) => {
    setError(null);
    setDialog(next);
  };

  async function addVersion(form: FormData) {
    const chosen = file(form);
    if (!chosen) return;
    const fields: Record<string, string> = {
      revision: String(form.get("revision") ?? "").trim(),
      changeNote: String(form.get("changeNote") ?? "").trim(),
      basedOnVersionId: document.current.id,
    };
    const purpose = optional(form, "issuePurpose");
    if (purpose) fields.issuePurpose = purpose;
    const result = await run(() =>
      liveUpload(`${base}/versions`, chosen, documentResponseSchema, fields),
    );
    if (result) {
      setDialog(null);
      router.refresh();
    }
  }

  async function edit(form: FormData) {
    const body: Record<string, unknown> = {
      title: String(form.get("title") ?? "").trim(),
      version: document.version,
    };
    if (document.category === "drawing") {
      body.drawingNumber = String(form.get("drawingNumber") ?? "").trim();
      body.discipline = String(form.get("discipline") ?? "");
    } else {
      body.reference = optional(form, "reference") ?? null;
    }
    const result = await run(() =>
      liveRequest(base, documentResponseSchema, { method: "PATCH", body }),
    );
    if (result) {
      setDialog(null);
      router.refresh();
    }
  }

  async function withdraw(reason: string) {
    const result = await run(() =>
      liveRequest(`${base}/withdraw`, documentResponseSchema, {
        method: "POST",
        body: { reason, version: document.version },
      }),
    );
    if (result) {
      setDialog(null);
      router.refresh();
    }
  }

  if (
    !permissions.canUpload &&
    !permissions.canEdit &&
    !permissions.canWithdraw &&
    !permissions.canRaiseApproval
  )
    return null;
  return (
    <div className="flex flex-wrap gap-2">
      {permissions.canUpload ? (
        <Button onClick={() => openDialog("version")}>
          <FilePlus2 className="size-4" aria-hidden />
          {t("detail.newVersion")}
        </Button>
      ) : null}
      {permissions.canRaiseApproval ? (
        <Button asChild variant="secondary">
          <Link href={`/projects/${projectId}/approvals/new?documentId=${document.id}`}>
            <Stamp className="size-4" aria-hidden />
            {t("detail.askApproval")}
          </Link>
        </Button>
      ) : null}
      {permissions.canEdit ? (
        <Button variant="outline" onClick={() => openDialog("edit")}>
          <Pencil className="size-4" aria-hidden />
          {t("detail.edit")}
        </Button>
      ) : null}
      {permissions.canWithdraw ? (
        <Button variant="outline" onClick={() => openDialog("withdraw")}>
          <Archive className="size-4" aria-hidden />
          {t("detail.withdraw")}
        </Button>
      ) : null}

      <DocumentDialog
        open={dialog === "version"}
        onOpenChange={(open) => setDialog(open ? "version" : null)}
        title={t("detail.newVersion")}
        hint={t("detail.newVersionHint")}
        busy={busy}
        error={error}
        submitLabel={t("upload.submit")}
        onSubmit={(form) => void addVersion(form)}
      >
        <p className="text-sm text-muted-foreground">
          {t("detail.suggested", { revision: document.nextRevision })}
        </p>
        <VersionFields idPrefix="version" revision={document.nextRevision} noteRequired />
      </DocumentDialog>

      <DocumentDialog
        open={dialog === "edit"}
        onOpenChange={(open) => setDialog(open ? "edit" : null)}
        title={t("detail.edit")}
        busy={busy}
        error={error}
        submitLabel={t("common.save")}
        onSubmit={(form) => void edit(form)}
      >
        <Field>
          <FieldLabel htmlFor="edit-title">{t("upload.titleLabel")}</FieldLabel>
          <Input
            id="edit-title"
            name="title"
            required
            minLength={3}
            maxLength={200}
            defaultValue={document.title}
          />
        </Field>
        {document.category === "drawing" ? (
          <>
            <Field>
              <FieldLabel htmlFor="edit-number">{t("upload.drawingNumber")}</FieldLabel>
              <Input
                id="edit-number"
                name="drawingNumber"
                required
                maxLength={40}
                className="font-mono"
                defaultValue={document.drawingNumber ?? ""}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="edit-discipline">{t("upload.discipline")}</FieldLabel>
              <select
                id="edit-discipline"
                name="discipline"
                className={selectClass}
                defaultValue={document.discipline ?? "other"}
              >
                {DRAWING_DISCIPLINES.map((discipline) => (
                  <option key={discipline} value={discipline}>
                    {t(`disciplines.${discipline}`)}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : (
          <Field>
            <FieldLabel htmlFor="edit-reference">
              {t("upload.reference")} {t("common.optional")}
            </FieldLabel>
            <Input
              id="edit-reference"
              name="reference"
              maxLength={80}
              defaultValue={document.reference ?? ""}
            />
          </Field>
        )}
      </DocumentDialog>

      <ReasonDialog
        open={dialog === "withdraw"}
        title={t("detail.withdraw")}
        hint={t("detail.withdrawHint")}
        busy={busy}
        error={error}
        onOpenChange={(open) => setDialog(open ? "withdraw" : null)}
        onSubmit={(reason) => void withdraw(reason)}
        confirmLabel={t("detail.withdraw")}
      />
    </div>
  );
}
