"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import {
  SNAG_PHASES,
  SNAG_RESPONSIBLE_KINDS,
  SNAG_SEVERITIES,
  SNAG_STATUSES,
} from "@pm-buddy/types";
import {
  createSnagRequestSchema,
  snagResponseSchema,
  type QualityPhoto,
  type Site,
  type SnagsResponse,
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
import { liveRequest } from "@/lib/live-api";
import { parseCalendarInput } from "@/lib/project-input";
import { qualityHref } from "@/lib/quality";
import { PhotoThumbs, PhotoUpload } from "./photos";
import { SnagCard } from "./snag-card";

export type SnagFilters = {
  status?: string;
  severity?: string;
  phase?: string;
  search?: string;
  cursor?: string;
};

/** The snag list: counts, filters (server search, paged), raising a snag with photos. */
export function SnagsPanel({
  projectId,
  data,
  sites,
  filters,
}: {
  projectId: string;
  data: SnagsResponse;
  sites: Site[];
  filters: SnagFilters;
}) {
  const t = useTranslations("quality");
  const { busy, error, setError, run } = useScheduleMutation();
  const [open, setOpen] = useState(false);
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [photos, setPhotos] = useState<QualityPhoto[]>([]);
  const { counts } = data;

  function raise(form: FormData) {
    const dueOn = parseCalendarInput(String(form.get("dueOn") ?? ""));
    const parsed = createSnagRequestSchema.safeParse({
      siteId,
      location: String(form.get("location") ?? ""),
      description: String(form.get("description") ?? ""),
      severity: form.get("severity"),
      responsibleKind: form.get("responsibleKind"),
      responsibleName: String(form.get("responsibleName") ?? ""),
      dueOn,
      photoIds: photos.map((photo) => photo.id),
    });
    if (!parsed.success || dueOn === undefined) {
      setError(t("snags.invalid"));
      return;
    }
    void run(
      () =>
        liveRequest(`/projects/${projectId}/quality/snags`, snagResponseSchema, {
          method: "POST",
          body: parsed.data,
        }),
      () => {
        setOpen(false);
        setPhotos([]);
      },
    );
  }

  const kept = {
    status: filters.status,
    severity: filters.severity,
    phase: filters.phase,
    search: filters.search,
  };
  return (
    <section aria-labelledby="snags-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="snags-heading" className="text-base font-semibold">
          {t("snags.title")}
        </h3>
        {data.permissions.canCreate ? (
          <Button
            disabled={!sites.length}
            onClick={() => {
              setError(null);
              setPhotos([]);
              setOpen(true);
            }}
          >
            <Plus className="size-4" aria-hidden />
            {t("snags.raise")}
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-wrap gap-2" aria-label={t("snags.countsLabel")}>
        <li>
          <StatusBadge tone="warning" className="h-auto whitespace-normal text-left">
            {t("snags.countOpen", { count: counts.open })}
          </StatusBadge>
        </li>
        <li>
          <StatusBadge tone="info" className="h-auto whitespace-normal text-left">
            {t("snags.countFixed", { count: counts.fixed })}
          </StatusBadge>
        </li>
        <li>
          <StatusBadge
            tone={counts.openCritical ? "danger" : "neutral"}
            className="h-auto whitespace-normal text-left"
          >
            {t("snags.countCritical", { count: counts.openCritical })}
          </StatusBadge>
        </li>
        <li>
          <StatusBadge
            tone={counts.overdue ? "danger" : "neutral"}
            className="h-auto whitespace-normal text-left"
          >
            {t("snags.countOverdue", { count: counts.overdue })}
          </StatusBadge>
        </li>
        <li>
          <StatusBadge tone="neutral" className="h-auto whitespace-normal text-left">
            {t("snags.countDlp", { count: counts.dlpOpen })}
          </StatusBadge>
        </li>
      </ul>
      <form
        method="get"
        action={`/projects/${projectId}`}
        className="grid gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_2fr_auto] lg:items-end"
      >
        <input type="hidden" name="tab" value="quality" />
        <input type="hidden" name="view" value="snags" />
        <Field>
          <FieldLabel htmlFor="snag-status">{t("snags.filterStatus")}</FieldLabel>
          <select
            id="snag-status"
            name="status"
            defaultValue={filters.status ?? ""}
            className={selectClass}
          >
            <option value="">{t("filters.all")}</option>
            <option value="active">{t("snags.active")}</option>
            {SNAG_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`snagStatus.${status}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="snag-severity">{t("fields.severity")}</FieldLabel>
          <select
            id="snag-severity"
            name="severity"
            defaultValue={filters.severity ?? ""}
            className={selectClass}
          >
            <option value="">{t("filters.all")}</option>
            {SNAG_SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {t(`severity.${severity}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="snag-phase">{t("snags.filterPhase")}</FieldLabel>
          <select
            id="snag-phase"
            name="phase"
            defaultValue={filters.phase ?? ""}
            className={selectClass}
          >
            <option value="">{t("filters.all")}</option>
            {SNAG_PHASES.map((phase) => (
              <option key={phase} value={phase}>
                {t(`snagPhase.${phase}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="snag-search">{t("filters.search")}</FieldLabel>
          <Input
            id="snag-search"
            name="search"
            type="search"
            maxLength={100}
            defaultValue={filters.search ?? ""}
            placeholder={t("snags.searchPlaceholder")}
          />
        </Field>
        <Button type="submit" variant="outline">
          {t("filters.apply")}
        </Button>
      </form>
      {data.snags.length ? (
        <ul className="space-y-3">
          {data.snags.map((snag) => (
            <li key={snag.id}>
              <SnagCard projectId={projectId} snag={snag} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("snags.empty")}</p>
      )}
      <nav aria-label={t("snags.pages")} className="flex flex-wrap gap-4 text-sm">
        {filters.cursor ? (
          <Link className="underline" href={qualityHref(projectId, "snags", kept)}>
            {t("filters.newest")}
          </Link>
        ) : null}
        {data.nextCursor ? (
          <Link
            className="underline"
            href={qualityHref(projectId, "snags", { ...kept, cursor: String(data.nextCursor) })}
          >
            {t("filters.older")}
          </Link>
        ) : null}
      </nav>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("snags.raise")}</DialogTitle>
            <DialogDescription>{t("snags.raiseHint")}</DialogDescription>
          </DialogHeader>
          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              raise(new FormData(event.currentTarget));
            }}
          >
            <FormError message={error} />
            <Field>
              <FieldLabel htmlFor="new-snag-site">{t("fields.site")}</FieldLabel>
              <select
                id="new-snag-site"
                value={siteId}
                onChange={(event) => {
                  setSiteId(event.currentTarget.value);
                  setPhotos([]);
                }}
                className={selectClass}
              >
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="new-snag-location">{t("fields.location")}</FieldLabel>
              <Input id="new-snag-location" name="location" maxLength={200} required />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-snag-description">{t("fields.description")}</FieldLabel>
              <Textarea id="new-snag-description" name="description" maxLength={2000} required />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="new-snag-severity">{t("fields.severity")}</FieldLabel>
                <select
                  id="new-snag-severity"
                  name="severity"
                  defaultValue="minor"
                  className={selectClass}
                >
                  {SNAG_SEVERITIES.map((severity) => (
                    <option key={severity} value={severity}>
                      {t(`severity.${severity}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="new-snag-due">{t("fields.dueOn")}</FieldLabel>
                <Input id="new-snag-due" name="dueOn" placeholder="DD/MM/YYYY" />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="new-snag-kind">{t("fields.responsibleKind")}</FieldLabel>
                <select id="new-snag-kind" name="responsibleKind" className={selectClass}>
                  {SNAG_RESPONSIBLE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`responsible.${kind}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="new-snag-name">{t("fields.responsibleName")}</FieldLabel>
                <Input id="new-snag-name" name="responsibleName" maxLength={150} required />
              </Field>
            </div>
            <PhotoThumbs
              projectId={projectId}
              photos={photos}
              label={t("snags.newPhotos")}
              onRemove={(photoId) =>
                setPhotos((current) => current.filter((photo) => photo.id !== photoId))
              }
            />
            {siteId && photos.length < 6 ? (
              <PhotoUpload
                projectId={projectId}
                siteId={siteId}
                caption={t("snags.photoCaption")}
                label={t("snags.addPhoto")}
                disabled={busy}
                onUploaded={(photo) => setPhotos((current) => [...current, photo])}
              />
            ) : null}
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
                {t("snags.raise")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
