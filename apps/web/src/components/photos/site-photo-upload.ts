"use client";

import { useTranslations } from "next-intl";
import { sitePhotoResponseSchema, type SitePhoto } from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { LiveApiError, liveUpload } from "@/lib/live-api";

/**
 * What a photo import accepts: JPEG and iPhone HEIC, also by file name, since some browsers report
 * HEIC files without a type. The server decides by the file's signature.
 */
export const PHOTO_IMPORT_ACCEPT = "image/jpeg,image/heic,image/heif,.jpg,.jpeg,.heic,.heif";

/** Uploads a site photo: an imported file, or a camera capture with its ticket fields. */
export async function uploadSitePhoto(
  projectId: string,
  file: File,
  fields: Record<string, string>,
): Promise<SitePhoto> {
  return (await liveUpload(`/projects/${projectId}/photos`, file, sitePhotoResponseSchema, fields))
    .photo;
}

const photoErrors = {
  "file-required": "fileRequired",
  "photo-duplicate": "duplicate",
  "unsupported-file-type": "unsupported",
  "invalid-image": "invalidImage",
  "payload-too-large": "tooLarge",
  "diary-not-draft": "diaryNotDraft",
  "capture-ticket-used": "ticketUsed",
  "capture-ticket-invalid": "ticketInvalid",
  "photo-decoder-busy": "busy",
} as const;

/** Photo upload problems in words, falling back to the general API messages. */
export function usePhotoProblem() {
  const t = useTranslations("photoCapture.errors");
  const problem = useProblemMessage();
  return (error: unknown): string => {
    const key =
      error instanceof LiveApiError
        ? photoErrors[error.code as keyof typeof photoErrors]
        : undefined;
    return key ? t(key) : problem(error);
  };
}
