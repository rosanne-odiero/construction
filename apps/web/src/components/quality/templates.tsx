"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { INSPECTION_CATEGORIES, QUALITY_SETTINGS_LIMITS } from "@pm-buddy/types";
import {
  checklistTemplateResponseSchema,
  createChecklistTemplateRequestSchema,
  loadStarterTemplatesResponseSchema,
  qualitySettingsResponseSchema,
  retireChecklistTemplateRequestSchema,
  reviseChecklistTemplateRequestSchema,
  updateQualitySettingsRequestSchema,
  type ChecklistTemplateResponse,
  type ChecklistTemplatesResponse,
  type QualitySettings,
} from "@pm-buddy/validation";
import {
  FormError,
  selectClass,
  useScheduleMutation,
} from "@/components/schedule/use-schedule-mutation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { formatDateTime } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { parseWhole } from "@/lib/quality";

/** "item one\nitem two" → [{ text: "item one" }, …] (blank lines dropped). */
const itemsOf = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => ({ text: line }));

function TemplateForm({
  initial,
  busy,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: { name: string; category: string; description: string; items: string } | null;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  onSubmit: (form: FormData) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("quality");
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(new FormData(event.currentTarget));
      }}
    >
      <FormError message={error} />
      <Field>
        <FieldLabel htmlFor="template-name">{t("templates.name")}</FieldLabel>
        <Input
          id="template-name"
          name="name"
          maxLength={120}
          defaultValue={initial?.name ?? ""}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="template-category">{t("templates.category")}</FieldLabel>
        <select
          id="template-category"
          name="category"
          defaultValue={initial?.category ?? "other"}
          className={selectClass}
        >
          {INSPECTION_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {t(`category.${category}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="template-description">{t("fields.description")}</FieldLabel>
        <Textarea
          id="template-description"
          name="description"
          maxLength={500}
          defaultValue={initial?.description ?? ""}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="template-items">{t("templates.items")}</FieldLabel>
        <Textarea
          id="template-items"
          name="items"
          rows={8}
          defaultValue={initial?.items ?? ""}
          required
          aria-describedby="template-items-hint"
        />
        <FieldDescription id="template-items-hint">{t("templates.itemsHint")}</FieldDescription>
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          {t("actions.cancel")}
        </Button>
        <Button type="submit" disabled={busy}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Company checklist templates: the current version of each, loading the starter set, creating. */
export function TemplatesPanel({ data }: { data: ChecklistTemplatesResponse }) {
  const t = useTranslations("quality");
  const router = useRouter();
  const { busy, error, setError, run } = useScheduleMutation();
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState<"en" | "sw">("en");
  const [loaded, setLoaded] = useState<string | null>(null);

  function create(form: FormData) {
    const parsed = createChecklistTemplateRequestSchema.safeParse({
      name: String(form.get("name") ?? ""),
      category: form.get("category"),
      description: String(form.get("description") ?? ""),
      items: itemsOf(String(form.get("items") ?? "")),
    });
    if (!parsed.success) {
      setError(t("templates.invalid"));
      return;
    }
    void run(async () => {
      const created = await liveRequest("/quality/templates", checklistTemplateResponseSchema, {
        method: "POST",
        body: parsed.data,
      });
      setOpen(false);
      router.push(`/quality/templates/${created.template.id}`);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("templates.title")}</h2>
        </CardTitle>
        <CardDescription>{t("templates.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!open ? <FormError message={error} /> : null}
        {loaded ? (
          <p role="status" className="text-sm">
            {loaded}
          </p>
        ) : null}
        {data.permissions.canCreate ? (
          <div className="flex flex-wrap items-end gap-3">
            <Button
              onClick={() => {
                setError(null);
                setOpen(true);
              }}
            >
              <Plus className="size-4" aria-hidden />
              {t("templates.new")}
            </Button>
            <Field className="w-auto">
              <FieldLabel htmlFor="starter-language">{t("templates.starterLanguage")}</FieldLabel>
              <select
                id="starter-language"
                value={language}
                onChange={(event) => setLanguage(event.currentTarget.value as "en" | "sw")}
                className={selectClass}
              >
                <option value="en">{t("templates.languages.en")}</option>
                <option value="sw">{t("templates.languages.sw")}</option>
              </select>
            </Field>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await liveRequest(
                    "/quality/templates/starter",
                    loadStarterTemplatesResponseSchema,
                    { method: "POST", body: { language } },
                  );
                  setLoaded(t("templates.loaded", { count: result.created }));
                })
              }
            >
              {t("templates.loadStarter")}
            </Button>
          </div>
        ) : null}
        {data.templates.length ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {data.templates.map((template) => (
              <li key={template.id}>
                <Link
                  href={`/quality/templates/${template.id}`}
                  className="block space-y-1 rounded-md border p-4 hover:bg-muted"
                >
                  <span className="block font-medium break-words">{template.name}</span>
                  <span className="block text-sm text-muted-foreground">
                    {t("templates.summary", {
                      category: t(`category.${template.category}`),
                      version: template.version,
                      items: template.itemCount,
                    })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("templates.empty")}</p>
        )}
      </CardContent>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("templates.new")}</DialogTitle>
            <DialogDescription>{t("templates.newHint")}</DialogDescription>
          </DialogHeader>
          <TemplateForm
            initial={null}
            busy={busy}
            error={error}
            submitLabel={t("templates.create")}
            onSubmit={create}
            onCancel={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** One template version: its items, the lineage's versions, revising and retiring. */
export function TemplateDetail({ data }: { data: ChecklistTemplateResponse }) {
  const t = useTranslations("quality");
  const router = useRouter();
  const { busy, error, setError, run } = useScheduleMutation();
  const [mode, setMode] = useState<"revise" | "retire" | null>(null);
  const { template, history } = data;

  function revise(form: FormData) {
    const parsed = reviseChecklistTemplateRequestSchema.safeParse({
      expectedVersion: template.version,
      name: String(form.get("name") ?? ""),
      category: form.get("category"),
      description: String(form.get("description") ?? ""),
      items: itemsOf(String(form.get("items") ?? "")),
    });
    if (!parsed.success) {
      setError(t("templates.invalid"));
      return;
    }
    void run(async () => {
      const next = await liveRequest(
        `/quality/templates/${template.id}/versions`,
        checklistTemplateResponseSchema,
        { method: "POST", body: parsed.data },
      );
      setMode(null);
      router.push(`/quality/templates/${next.template.id}`);
    });
  }

  function retire() {
    const parsed = retireChecklistTemplateRequestSchema.parse({
      expectedVersion: template.version,
    });
    void run(async () => {
      const next = await liveRequest(
        `/quality/templates/${template.id}/retire`,
        checklistTemplateResponseSchema,
        { method: "POST", body: parsed },
      );
      setMode(null);
      router.push(`/quality/templates/${next.template.id}`);
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge
          tone={template.retired ? "neutral" : template.current ? "success" : "info"}
          className="h-auto whitespace-normal text-left"
        >
          {template.retired
            ? t("templates.retired")
            : template.current
              ? t("templates.current")
              : t("templates.older")}
        </StatusBadge>
        <span className="text-sm text-muted-foreground">
          {t("templates.versionBy", {
            version: template.version,
            name: template.createdBy.displayName,
            at: formatDateTime(template.createdAt),
          })}
        </span>
      </div>
      {template.description ? (
        <p className="text-sm break-words whitespace-pre-wrap">{template.description}</p>
      ) : null}
      <FormError message={mode ? null : error} />
      <ol className="list-decimal space-y-2 rounded-md border p-4 pl-8 text-sm">
        {template.items.map((item) => (
          <li key={item.id} className="break-words">
            {item.text}
          </li>
        ))}
      </ol>
      {template.permissions.canRevise || template.permissions.canRetire ? (
        <div className="flex flex-wrap gap-2">
          {template.permissions.canRevise ? (
            <Button
              disabled={busy}
              onClick={() => {
                setError(null);
                setMode("revise");
              }}
            >
              {t("templates.revise")}
            </Button>
          ) : null}
          {template.permissions.canRetire ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setError(null);
                setMode("retire");
              }}
            >
              {t("templates.retire")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {history.length ? (
        <section aria-labelledby="template-history" className="space-y-2">
          <h2 id="template-history" className="text-base font-semibold">
            {t("templates.history")}
          </h2>
          <ul className="space-y-2 text-sm">
            {history.map((entry) => (
              <li key={entry.id}>
                <Link className="underline" href={`/quality/templates/${entry.id}`}>
                  {t("templates.historyEntry", {
                    version: entry.version,
                    name: entry.name,
                    items: entry.itemCount,
                  })}
                </Link>
                {entry.retired ? ` · ${t("templates.retired")}` : ""}
              </li>
            ))}
          </ul>
        </section>
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
              {mode === "retire" ? t("templates.retire") : t("templates.revise")}
            </DialogTitle>
            <DialogDescription>
              {mode === "retire" ? t("templates.retireHint") : t("templates.reviseHint")}
            </DialogDescription>
          </DialogHeader>
          {mode === "revise" ? (
            <TemplateForm
              initial={{
                name: template.name,
                category: template.category,
                description: template.description ?? "",
                items: template.items.map((item) => item.text).join("\n"),
              }}
              busy={busy}
              error={error}
              submitLabel={t("templates.saveVersion", { version: template.version + 1 })}
              onSubmit={revise}
              onCancel={() => setMode(null)}
            />
          ) : (
            <div className="space-y-4">
              <FormError message={error} />
              <DialogFooter>
                <Button variant="outline" disabled={busy} onClick={() => setMode(null)}>
                  {t("actions.cancel")}
                </Button>
                <Button disabled={busy} onClick={retire}>
                  {t("templates.retire")}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The company's default DLP and cube grace days (config.manage edits). */
export function QualitySettingsCard({ settings }: { settings: QualitySettings }) {
  const t = useTranslations("quality");
  const { busy, error, setError, run } = useScheduleMutation();
  const [saved, setSaved] = useState(false);

  function save(form: FormData) {
    const parsed = updateQualitySettingsRequestSchema.safeParse({
      dlpMonths: parseWhole(
        String(form.get("dlpMonths") ?? ""),
        QUALITY_SETTINGS_LIMITS.dlpMonths.min,
        QUALITY_SETTINGS_LIMITS.dlpMonths.max,
      ),
      cubeOverdueGraceDays: parseWhole(
        String(form.get("grace") ?? ""),
        QUALITY_SETTINGS_LIMITS.cubeOverdueGraceDays.min,
        QUALITY_SETTINGS_LIMITS.cubeOverdueGraceDays.max,
      ),
      version: settings.version,
    });
    if (!parsed.success) {
      setError(t("settings.invalid"));
      return;
    }
    setSaved(false);
    void run(
      () =>
        liveRequest("/quality/settings", qualitySettingsResponseSchema, {
          method: "PUT",
          body: parsed.data,
        }),
      () => setSaved(true),
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("settings.title")}</h2>
        </CardTitle>
        <CardDescription>{t("settings.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            save(new FormData(event.currentTarget));
          }}
        >
          <div className="sm:col-span-3">
            <FormError message={error} />
            {saved ? (
              <p role="status" className="text-sm">
                {t("settings.saved")}
              </p>
            ) : null}
          </div>
          <Field>
            <FieldLabel htmlFor="settings-dlp">{t("settings.dlpMonths")}</FieldLabel>
            <Input
              id="settings-dlp"
              name="dlpMonths"
              inputMode="numeric"
              defaultValue={String(settings.dlpMonths)}
              disabled={!settings.permissions.canEdit}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="settings-grace">{t("settings.grace")}</FieldLabel>
            <Input
              id="settings-grace"
              name="grace"
              inputMode="numeric"
              defaultValue={String(settings.cubeOverdueGraceDays)}
              disabled={!settings.permissions.canEdit}
            />
          </Field>
          {settings.permissions.canEdit ? (
            <Button type="submit" disabled={busy}>
              {t("actions.save")}
            </Button>
          ) : null}
        </form>
        {!settings.permissions.canEdit ? (
          <p className="mt-3 text-sm text-muted-foreground">{t("settings.readOnly")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
