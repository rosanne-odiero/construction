import {
  isVerifiedPhoto,
  PHOTO_CAPTURE_METHODS,
  PHOTO_CONTENT_TYPES,
  PHOTO_LOCATION_CHECKS,
  PHOTO_PURPOSES,
  PHOTO_SIMILARITY_CHECKS,
  PHOTO_TIME_CHECKS,
  PHOTO_TIME_SOURCES,
} from "@pm-buddy/domain";
import { z } from "zod";

/**
 * Geotagged site photos (D6.1): capture tickets, upload fields, the stored record and list
 * queries.
 */
const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
/** A multipart decimal field ("−1.148912"), never coerced from blanks or exponents. */
const decimalField = (pattern: RegExp, min: number, max: number) =>
  z.string().regex(pattern).transform(Number).pipe(z.number().min(min).max(max));
const IN_APP_FIELDS = ["capturedAt", "latitude", "longitude", "accuracyM"] as const;

/** Opens an in-app capture: the server records when the camera screen opened. */
export const photoCaptureTicketRequestSchema = z.object({ siteId: uuid }).strict();
export const photoCaptureTicketResponseSchema = z
  .object({
    ticket: z
      .object({
        id: uuid,
        siteId: uuid,
        issuedAt: timestamp,
        /** Uploads after this are kept but not verified (`stale`); open a new capture instead. */
        useBy: timestamp,
      })
      .strict(),
  })
  .strict();

/**
 * Multipart text fields sent with the `file` part. An in-app capture adds its ticket, the phone's
 * clock at the shutter and, when the browser gave one, its position with the accuracy radius;
 * an imported file sends none of these (its EXIF is read instead).
 */
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
    captureTicketId: uuid.optional(),
    capturedAt: timestamp.optional(),
    latitude: decimalField(/^-?\d{1,2}(\.\d{1,8})?$/, -90, 90).optional(),
    longitude: decimalField(/^-?\d{1,3}(\.\d{1,8})?$/, -180, 180).optional(),
    accuracyM: decimalField(/^\d{1,6}(\.\d{1,2})?$/, 0, 100_000).optional(),
  })
  .strict()
  .refine((fields) => fields.purpose !== "safety_incident" || !fields.diaryId, {
    message: "An incident photo is not attached to a diary",
    path: ["diaryId"],
  })
  .refine(
    (fields) =>
      fields.captureTicketId
        ? fields.capturedAt !== undefined
        : IN_APP_FIELDS.every((name) => fields[name] === undefined),
    { message: "Capture details come only with a capture ticket", path: ["captureTicketId"] },
  )
  .refine(
    (fields) =>
      new Set([fields.latitude, fields.longitude, fields.accuracyM].map((v) => v === undefined))
        .size === 1,
    { message: "Send latitude, longitude and accuracyM together", path: ["latitude"] },
  );

export const sitePhotoSchema = z
  .object({
    id: uuid,
    projectId: uuid,
    siteId: uuid,
    diaryId: uuid.nullable(),
    caption: z.string().max(500).nullable(),
    /** Stored original: JPEG or HEIC (the thumbnail is always a JPEG). */
    contentType: z.enum(PHOTO_CONTENT_TYPES),
    /** `in_app`: PM-Buddy's camera screen; `imported`: a file (never verified). */
    captureMethod: z.enum(PHOTO_CAPTURE_METHODS),
    /** The phone's clock (in-app) or the photo's own metadata (imported); null without one. */
    capturedAt: timestamp.nullable(),
    timeSource: z.enum(PHOTO_TIME_SOURCES).nullable(),
    location: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        /** The browser's accuracy radius for an in-app capture; null for EXIF positions. */
        accuracyM: z.number().min(0).nullable(),
      })
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
        similarity: z.enum(PHOTO_SIMILARITY_CHECKS),
        /**
         * The earlier photo this one looks like. Its ID is given only for a general photo of the
         * same project; otherwise just that it is in another project.
         */
        similarTo: z
          .object({
            photoId: uuid.nullable(),
            otherProject: z.boolean(),
            /** Differing bits of the 64-bit difference hash. */
            distance: z.number().int().min(0).max(64),
          })
          .strict()
          .nullable(),
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
      photo.verified === isVerifiedPhoto({ captureMethod: photo.captureMethod, ...photo.checks }),
    "verified_mismatch",
  )
  .refine(
    (photo) => (photo.checks.similarTo !== null) === (photo.checks.similarity === "similar"),
    "similar_to_mismatch",
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
export type PhotoCaptureTicketResponse = z.infer<typeof photoCaptureTicketResponseSchema>;
