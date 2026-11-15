"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ClipboardCheck, Plus } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import { INSPECTION_CATEGORIES, INSPECTOR_TYPES } from "@pm-buddy/types";
import {
  createInspectionRequestSchema,
  inspectionDetailResponseSchema,
  type ChecklistTemplateSummary,
  type InspectionsResponse,
  type Site,
  type WbsNode,
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCalendarDate } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { calendarInput, parseCalendarInput } from "@/lib/project-input";
import { inspectionTone } from "@/lib/quality";

export type TaskChoice = { id: string; code: string | null; name: string };

/** A project's inspections: filters (server search), the list, and a new inspection. */
export function InspectionsPanel({
  projectId,
  data,
  templates,
  sites,
  nodes,
  tasks,
  filters,
}: {
  projectId: string;
  data: InspectionsResponse;
  templates: ChecklistTemplateSummary[];
  sites: Site[];
  nodes: WbsNode[];
  tasks: TaskChoice[];
  filters: { status?: string; result?: string; search?: string };
}) {
  const t = useTranslations("quality");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { busy, error, setError, run } = useScheduleMutation();

  function create(form: FormData) {
    const inspectedOn = parseCalendarInput(String(form.get("inspectedOn") ?? ""));
    const optional = (name: string) => String(form.get(name) ?? "") || null;
    const parsed = createInspectionRequestSchema.safeParse({
      siteId: form.get("siteId"),
      templateId: form.get("templateId"),
      location: String(form.get("location") ?? ""),
      inspectorType: form.get("inspectorType"),
      inspectorName: String(form.get("inspectorName") ?? ""),
      inspectedOn,
      notes: String(form.get("notes") ?? ""),
      wbsNodeId: optional("wbsNodeId"),
      scheduleActivityId: optional("scheduleActivityId"),
    });
    if (!parsed.success) {
      setError(t("inspections.invalid"));
      return;
    }
    void run(async () => {
      const created = await liveRequest(
        `/projects/${projectId}/quality/inspections`,
        inspectionDetailResponseSchema,
        { method: "POST", body: parsed.data },
      );
      setOpen(false);
      router.push(`/projects/${projectId}/quality/inspections/${created.inspection.id}`);
    });
  }

  const categories = INSPECTION_CATEGORIES.filter((category) =>
    templates.some((template) => template.category === category),
  );

  return (
    <section aria-labelledby="inspections-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="inspections-heading" className="text-base font-semibold">
          {t("inspections.title")}
        </h3>
        {data.permissions.canCreate ? (
          <Button
            onClick={() => {
              setError(null);
              setOpen(true);
            }}
            disabled={!sites.length || !templates.length}
          >
            <Plus className="size-4" aria-hidden />
            {t("inspections.new")}
          </Button>
        ) : null}
      </div>
      {data.permissions.canCreate && !templates.length ? (
        <p className="rounded-md border bg-muted p-3 text-sm">
          {t.rich("inspections.noTemplates", {
            link: (chunks) => (
              <Link className="underline" href="/quality/templates">
                {chunks}
              </Link>
            ),
          })}
        </p>
      ) : null}
      <form
        method="get"
        action={`/projects/${projectId}`}
        className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end"
      >
        <input type="hidden" name="tab" value="quality" />
        <Field>
          <FieldLabel htmlFor="inspection-status">{t("inspections.filterStatus")}</FieldLabel>
          <select
            id="inspection-status"
            name="status"
            defaultValue={filters.status ?? ""}
            className={selectClass}
          >
            <option value="">{t("filters.all")}</option>
            {(["draft", "submitted", "signed_off"] as const).map((status) => (
              <option key={status} value={status}>
                {t(`inspectionStatus.${status}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="inspection-result">{t("inspections.filterResult")}</FieldLabel>
          <select
            id="inspection-result"
            name="result"
            defaultValue={filters.result ?? ""}
            className={selectClass}
          >
            <option value="">{t("filters.all")}</option>
            <option value="pass">{t("inspectionResult.pass")}</option>
            <option value="fail">{t("inspectionResult.fail")}</option>
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="inspection-search">{t("filters.search")}</FieldLabel>
          <Input
            id="inspection-search"
            name="search"
            type="search"
            defaultValue={filters.search ?? ""}
            maxLength={100}
            placeholder={t("inspections.searchPlaceholder")}
          />
        </Field>
        <Button type="submit" variant="outline">
          {t("filters.apply")}
        </Button>
      </form>
      {data.inspections.length ? (
        <ul className="space-y-3">
          {data.inspections.map((inspection) => (
            <li key={inspection.id}>
              <Link
                href={`/projects/${projectId}/quality/inspections/${inspection.id}`}
                className="block space-y-2 rounded-md border p-4 hover:bg-muted"
              >
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 font-semibold">
                    <ClipboardCheck className="size-4 shrink-0" aria-hidden />
                    <span className="font-mono text-sm">{inspection.code}</span>
                    <span className="break-words">{inspection.template.name}</span>
                  </span>
                  <span className="flex flex-wrap gap-1">
                    <StatusBadge
                      tone={inspectionTone[inspection.status]}
                      className="h-auto whitespace-normal text-left"
                    >
                      {t(`inspectionStatus.${inspection.status}`)}
                    </StatusBadge>
                    {inspection.result ? (
                      <StatusBadge
                        tone={inspection.result === "pass" ? "success" : "danger"}
                        className="h-auto whitespace-normal text-left"
                      >
                        {t(`inspectionResult.${inspection.result}`)}
                      </StatusBadge>
                    ) : null}
                  </span>
                </span>
                <span className="block text-sm break-words">
                  {inspection.location} · {inspection.siteName}
                </span>
                <span className="block text-sm text-muted-foreground">
                  {t("inspections.meta", {
                    date: formatCalendarDate(inspection.inspectedOn),
                    inspector: t(`inspectorType.${inspection.inspectorType}`),
                    pass: inspection.itemCounts.pass,
                    fail: inspection.itemCounts.fail,
                    na: inspection.itemCounts.na,
                    pending: inspection.itemCounts.pending,
                  })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("inspections.empty")}</p>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("inspections.new")}</DialogTitle>
            <DialogDescription>{t("inspections.newHint")}</DialogDescription>
          </DialogHeader>
          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              create(new FormData(event.currentTarget));
            }}
          >
            <FormError message={error} />
            <Field>
              <FieldLabel htmlFor="new-inspection-template">{t("inspections.template")}</FieldLabel>
              <select
                id="new-inspection-template"
                name="templateId"
                required
                className={selectClass}
              >
                {categories.map((category) => (
                  <optgroup key={category} label={t(`category.${category}`)}>
                    {templates
                      .filter((template) => template.category === category)
                      .map((template) => (
                        <option key={template.id} value={template.id}>
                          {t("inspections.templateOption", {
                            name: template.name,
                            version: template.version,
                            items: template.itemCount,
                          })}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="new-inspection-site">{t("fields.site")}</FieldLabel>
              <select id="new-inspection-site" name="siteId" required className={selectClass}>
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="new-inspection-location">{t("fields.location")}</FieldLabel>
              <Input
                id="new-inspection-location"
                name="location"
                required
                maxLength={200}
                placeholder={t("inspections.locationPlaceholder")}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="new-inspection-type">
                  {t("inspections.inspectorType")}
                </FieldLabel>
                <select
                  id="new-inspection-type"
                  name="inspectorType"
                  className={selectClass}
                  defaultValue="internal"
                >
                  {INSPECTOR_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`inspectorType.${type}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="new-inspection-date">{t("inspections.date")}</FieldLabel>
                <Input
                  id="new-inspection-date"
                  name="inspectedOn"
                  defaultValue={calendarInput(nairobiDate())}
                  placeholder="DD/MM/YYYY"
                  required
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="new-inspection-name">
                {t("inspections.inspectorName")}
              </FieldLabel>
              <Input id="new-inspection-name" name="inspectorName" maxLength={150} />
              <FieldDescription>{t("inspections.inspectorNameHint")}</FieldDescription>
            </Field>
            {nodes.length ? (
              <Field>
                <FieldLabel htmlFor="new-inspection-wbs">{t("inspections.wbs")}</FieldLabel>
                <select id="new-inspection-wbs" name="wbsNodeId" className={selectClass}>
                  <option value="">{t("inspections.noLink")}</option>
                  {nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.code} {node.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            {tasks.length ? (
              <Field>
                <FieldLabel htmlFor="new-inspection-activity">
                  {t("inspections.activity")}
                </FieldLabel>
                <select
                  id="new-inspection-activity"
                  name="scheduleActivityId"
                  className={selectClass}
                >
                  <option value="">{t("inspections.noLink")}</option>
                  {tasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.code ? `${task.code} ` : ""}
                      {task.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="new-inspection-notes">{t("fields.notes")}</FieldLabel>
              <Textarea id="new-inspection-notes" name="notes" maxLength={2000} />
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                {t("actions.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {t("inspections.start")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
