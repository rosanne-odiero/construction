"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Camera, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { PHOTO_LIMITS } from "@pm-buddy/domain";
import { sitePhotoResponseSchema, type QualityPhoto } from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { liveUpload } from "@/lib/live-api";
import { photoThumbnail } from "@/lib/quality";

/** Thumbnails of linked site photos (private, served by the authenticated photos endpoint). */
export function PhotoThumbs({
  projectId,
  photos,
  label,
  onRemove,
  disabled,
}: {
  projectId: string;
  photos: readonly QualityPhoto[];
  label: string;
  onRemove?: (photoId: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("quality.photos");
  if (!photos.length) return null;
  return (
    <ul aria-label={label} className="flex flex-wrap gap-2">
      {photos.map((photo, index) => (
        <li key={photo.id} className="relative">
          <a
            href={`/api/v1/projects/${projectId}/photos/${photo.id}/original`}
            target="_blank"
            rel="noreferrer"
            className="block overflow-hidden rounded-md border"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- private, authenticated API image */}
            <img
              src={photoThumbnail(projectId, photo.id)}
              alt={t("alt", { index: index + 1 })}
              loading="lazy"
              className="size-20 bg-muted object-cover"
            />
            <span className="sr-only">{photo.verified ? t("verified") : t("unverified")}</span>
          </a>
          {photo.verified ? (
            <ShieldCheck
              className="absolute bottom-1 left-1 size-4 rounded-full bg-background text-success"
              aria-hidden
            />
          ) : null}
          {onRemove ? (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className="absolute -top-2 -right-2 size-7 rounded-full"
              disabled={disabled}
              aria-label={t("remove", { index: index + 1 })}
              onClick={() => onRemove(photo.id)}
            >
              <X className="size-4" aria-hidden />
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Takes a photo with the phone camera (or picks a JPEG) and uploads it as a site photo of the
 * site; the server reads its own EXIF to verify it (D6.1 photos). The caller links the returned
 * photo to a checklist item or a snag.
 */
export function PhotoUpload({
  projectId,
  siteId,
  caption,
  label,
  disabled,
  purpose,
  onUploaded,
}: {
  projectId: string;
  siteId: string;
  caption: string;
  label: string;
  disabled?: boolean;
  /** `safety_incident`: kept out of the project's photo list, for safety readers only. */
  purpose?: "safety_incident";
  onUploaded: (photo: QualityPhoto) => void;
}) {
  const t = useTranslations("quality.photos");
  const problem = useProblemMessage();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    if (file.size > PHOTO_LIMITS.maxFileBytes) {
      setError(t("tooLarge"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { photo } = await liveUpload(
        `/projects/${projectId}/photos`,
        file,
        sitePhotoResponseSchema,
        {
          siteId,
          caption: Array.from(caption).slice(0, 200).join(""),
          ...(purpose ? { purpose } : {}),
        },
      );
      onUploaded({ id: photo.id, verified: photo.verified, caption: photo.caption });
    } catch (caught) {
      setError(problem(caught));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="space-y-1">
      <input
        ref={input}
        type="file"
        accept="image/jpeg"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => void upload(event.currentTarget.files?.[0])}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || busy}
        onClick={() => input.current?.click()}
      >
        {busy ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
        ) : (
          <Camera className="size-4" aria-hidden />
        )}
        {busy ? t("uploading") : label}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
