"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Camera, ExternalLink, LoaderCircle, MapPin, ShieldAlert, ShieldCheck } from "lucide-react";
import { PHOTO_LIMITS, PHOTO_VERIFICATION_DEFAULTS } from "@pm-buddy/domain";
import {
  sitePhotoResponseSchema,
  type Site,
  type SiteDiary,
  type SitePhoto,
} from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { LiveApiError, liveUpload } from "@/lib/live-api";
import { useProblemMessage } from "./use-problem-message";

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none";
const photoErrors = {
  "photo-duplicate": "duplicate",
  "unsupported-file-type": "notJpeg",
  "invalid-image": "invalidImage",
  "payload-too-large": "tooLarge",
  "diary-not-draft": "diaryNotDraft",
  "file-required": "fileRequired",
} as const;

/** Geotagged site photos: upload (site.photos) and a timeline with each photo's verification. */
export function PhotosPanel({
  projectId,
  photos,
  sites,
  drafts,
  canUpload,
}: {
  projectId: string;
  photos: SitePhoto[];
  sites: Site[];
  drafts: SiteDiary[];
  canUpload: boolean;
}) {
  const t = useTranslations("livePhotos");
  const problem = useProblemMessage();
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [diaryId, setDiaryId] = useState("");
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const siteName = (id: string) => sites.find((site) => site.id === id)?.name ?? "—";
  const siteDrafts = drafts.filter((diary) => diary.siteId === siteId);

  async function upload() {
    const file = fileInput.current?.files?.[0];
    if (!file) return setMessage({ error: true, text: t("errors.fileRequired") });
    if (file.size > PHOTO_LIMITS.maxFileBytes)
      return setMessage({ error: true, text: t("errors.tooLarge") });
    setBusy(true);
    setMessage(null);
    try {
      const { photo } = await liveUpload(
        `/projects/${projectId}/photos`,
        file,
        sitePhotoResponseSchema,
        {
          siteId,
          ...(diaryId ? { diaryId } : {}),
          ...(caption.trim() ? { caption: caption.trim() } : {}),
        },
      );
      setMessage({
        error: false,
        text: photo.verified ? t("uploadedVerified") : t("uploadedUnverified"),
      });
      setCaption("");
      if (fileInput.current) fileInput.current.value = "";
      router.refresh();
    } catch (error) {
      const key =
        error instanceof LiveApiError
          ? photoErrors[error.code as keyof typeof photoErrors]
          : undefined;
      setMessage({ error: true, text: key ? t(`errors.${key}`) : problem(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("title")}</h2>
          </CardTitle>
          <CardDescription>{t("description")}</CardDescription>
          <p className="rounded-md border bg-muted p-3 text-sm">
            {t("evidenceNote", {
              tolerance: PHOTO_VERIFICATION_DEFAULTS.toleranceM,
              hours: PHOTO_VERIFICATION_DEFAULTS.maxAgeHours,
            })}
          </p>
        </CardHeader>
        {canUpload && sites.length ? (
          <CardContent>
            <form
              noValidate
              className="grid gap-4 md:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                void upload();
              }}
            >
              <Field>
                <FieldLabel htmlFor="photo-file">{t("file")}</FieldLabel>
                <Input
                  id="photo-file"
                  ref={fileInput}
                  type="file"
                  accept="image/jpeg"
                  capture="environment"
                  disabled={busy}
                  aria-describedby="photo-file-hint"
                />
                <FieldDescription id="photo-file-hint">{t("fileHint")}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="photo-site">{t("site")}</FieldLabel>
                <select
                  id="photo-site"
                  className={selectClass}
                  value={siteId}
                  disabled={busy}
                  onChange={(event) => {
                    setSiteId(event.target.value);
                    setDiaryId("");
                  }}
                >
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="photo-diary">{t("diary")}</FieldLabel>
                <select
                  id="photo-diary"
                  className={selectClass}
                  value={diaryId}
                  disabled={busy || !siteDrafts.length}
                  onChange={(event) => setDiaryId(event.target.value)}
                  aria-describedby="photo-diary-hint"
                >
                  <option value="">{t("noDiary")}</option>
                  {siteDrafts.map((diary) => (
                    <option key={diary.id} value={diary.id}>
                      {formatCalendarDate(diary.date)}
                    </option>
                  ))}
                </select>
                <FieldDescription id="photo-diary-hint">{t("diaryHint")}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="photo-caption">{t("caption")}</FieldLabel>
                <Input
                  id="photo-caption"
                  value={caption}
                  maxLength={500}
                  disabled={busy}
                  onChange={(event) => setCaption(event.target.value)}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-3 md:col-span-2">
                <Button type="submit" disabled={busy}>
                  {busy ? (
                    <LoaderCircle className="animate-spin" aria-hidden />
                  ) : (
                    <Camera aria-hidden />
                  )}
                  {busy ? t("uploading") : t("upload")}
                </Button>
                <p
                  aria-live="polite"
                  role={message?.error ? "alert" : "status"}
                  className={`text-sm ${message?.error ? "text-destructive" : ""}`}
                >
                  {message?.text}
                </p>
              </div>
            </form>
          </CardContent>
        ) : canUpload ? (
          <CardContent>
            <p className="text-sm">{t("noSites")}</p>
          </CardContent>
        ) : null}
      </Card>

      {photos.length ? (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {photos.map((photo) => {
            const label = photo.caption ?? t("photoOf", { site: siteName(photo.siteId) });
            return (
              <li key={photo.id}>
                <article aria-label={label} className="overflow-hidden rounded-xl border bg-card">
                  {/* eslint-disable-next-line @next/next/no-img-element -- private, authenticated API image */}
                  <img
                    src={`/api/v1/projects/${projectId}/photos/${photo.id}/thumbnail`}
                    alt={label}
                    loading="lazy"
                    className="aspect-[4/3] w-full bg-muted object-cover"
                  />
                  <div className="space-y-2 p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-medium break-words">{label}</h3>
                      {photo.verified ? (
                        <StatusBadge tone="success">
                          <ShieldCheck className="size-3.5" aria-hidden /> {t("verified")}
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="warning">
                          <ShieldAlert className="size-3.5" aria-hidden /> {t("unverified")}
                        </StatusBadge>
                      )}
                    </div>
                    <ul className="space-y-1 text-muted-foreground">
                      <li className="flex gap-1.5">
                        <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        <span>
                          {photo.checks.location === "outside"
                            ? t("location.outside", {
                                distance: Math.round(photo.checks.distanceM ?? 0),
                                site: siteName(photo.siteId),
                              })
                            : t(`location.${photo.checks.location}`, {
                                site: siteName(photo.siteId),
                                version: photo.geofenceVersion ?? 0,
                              })}
                        </span>
                      </li>
                      <li>
                        {photo.capturedAt
                          ? t(`time.${photo.checks.time}`, {
                              date: formatDateTime(photo.capturedAt),
                            })
                          : t("time.missing")}
                        {photo.timeSource === "assumed_nairobi" ? ` ${t("assumedZone")}` : ""}
                      </li>
                      <li>
                        {t("uploadedBy", {
                          name: photo.uploadedBy.displayName,
                          date: formatDateTime(photo.uploadedAt),
                        })}
                      </li>
                      {photo.camera ? <li>{t("camera", { camera: photo.camera })}</li> : null}
                      {photo.diaryId ? <li>{t("inDiary")}</li> : null}
                    </ul>
                    <a
                      href={`/api/v1/projects/${projectId}/photos/${photo.id}/original`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                    >
                      {t("original")} <ExternalLink className="size-3.5" aria-hidden />
                      <span className="sr-only">{t("newTab")}</span>
                    </a>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm">{t("empty")}</p>
      )}
    </div>
  );
}
