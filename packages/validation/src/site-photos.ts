import {
  PHOTO_LOCATION_CHECKS,
  PHOTO_PURPOSES,
  PHOTO_TIME_CHECKS,
  PHOTO_TIME_SOURCES,
} from "@pm-buddy/domain";
import { z } from "zod";

/** Geotagged site photos (D6.1): upload fields, the stored record and list queries. */
const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });

/** Multipart text fields sent with the `file` part. */
export const photoUploadFieldsSchema = z
  .object({
    siteId: uuid,
    diaryId: uuid.optional(),
    caption: z
      .string()
      .trim()
      .max(500)
      .optional()
      .transform((value) => (value ? value : undefined)),
    /** `safety_incident`: restricted to health and safety readers; never on a diary. */
    purpose: z.enum(PHOTO_PURPOSES).optional(),
  })
  .strict()
  .refine((fields) => fields.purpose !== "safety_incident" || !fields.diaryId, {
    message: "An incident photo is not attached to a diary",
    path: ["diaryId"],
  });

export const sitePhotoSchema = z
  .object({
    id: uuid,
    projectId: uuid,
    siteId: uuid,
    diaryId: uuid.nullable(),
    caption: z.string().max(500).nullable(),
    /** From the photo's own metadata; null when it has none. */
    capturedAt: timestamp.nullable(),
    timeSource: z.enum(PHOTO_TIME_SOURCES).nullable(),
    location: z
      .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
      .strict()
      .nullable(),
    camera: z.string().max(120).nullable(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** The site's geofence version the location was checked against. */
    geofenceVersion: z.number().int().positive().nullable(),
    checks: z
      .object({
        location: z.enum(PHOTO_LOCATION_CHECKS),
        time: z.enum(PHOTO_TIME_CHECKS),
        distanceM: z.number().min(0).nullable(),
      })
      .strict(),
    verified: z.boolean(),
    scanStatus: z.enum(["clean", "not_scanned"]),
    uploadedBy: z.object({ id: uuid, displayName: z.string().min(1).max(100) }).strict(),
    uploadedAt: timestamp,
  })
  .strict()
  .refine(
    (photo) =>
      photo.verified === (photo.checks.location === "inside" && photo.checks.time === "ok"),
    "verified_mismatch",
  );

export const sitePhotoResponseSchema = z.object({ photo: sitePhotoSchema }).strict();
export const sitePhotosResponseSchema = z
  .object({ photos: z.array(sitePhotoSchema), nextCursor: uuid.nullable() })
  .strict();
export const sitePhotoListQuerySchema = z
  .object({
    siteId: uuid.optional(),
    diaryId: uuid.optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(60).default(24),
  })
  .strict();

export type SitePhoto = z.infer<typeof sitePhotoSchema>;
export type SitePhotosResponse = z.infer<typeof sitePhotosResponseSchema>;
export type PhotoUploadFields = z.infer<typeof photoUploadFieldsSchema>;
