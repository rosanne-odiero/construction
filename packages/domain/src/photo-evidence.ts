import type { LatLng } from "./geo.js";
import { distanceOutsideGeofenceM, isInsideGeofence, type Geofence } from "./geofence.js";
import { nairobiDate } from "./project-lifecycle.js";

/**
 * Site photo evidence (D6.1). The server reads the photo's own metadata (EXIF GPS position and
 * capture time) and checks it against the site's geofence and the upload time. "Verified" means
 * the metadata is consistent with being taken on site recently; EXIF can be edited, so it is
 * evidence for review, not proof.
 */
export const PHOTO_LIMITS = {
  maxFileBytes: 15 * 1024 * 1024,
  /** Decoded pixels; larger images are refused before decoding (decompression bombs). */
  maxPixels: 50_000_000,
  thumbnailEdgePx: 960,
} as const;

/** Proposed defaults (CONFIGURATION: photos.*), pending owner review. */
export const PHOTO_VERIFICATION_DEFAULTS = {
  /** GPS accuracy allowance around the geofence. */
  toleranceM: 30,
  /** Photos may be uploaded up to three days after capture (for example after a day offline). */
  maxAgeHours: 72,
  /** Allowance for phone clocks running slightly fast. */
  futureSkewMinutes: 10,
} as const;

/**
 * What a photo is for. Incident photos (D8.2) can show injured people: they stay out of the
 * project's photo list and only health and safety readers can open them.
 */
export const PHOTO_PURPOSES = ["general", "safety_incident"] as const;
export type PhotoPurpose = (typeof PHOTO_PURPOSES)[number];

export const PHOTO_LOCATION_CHECKS = ["inside", "outside", "missing", "no_geofence"] as const;
export type PhotoLocationCheck = (typeof PHOTO_LOCATION_CHECKS)[number];
export const PHOTO_TIME_CHECKS = ["ok", "future", "stale", "missing", "diary_mismatch"] as const;
export type PhotoTimeCheck = (typeof PHOTO_TIME_CHECKS)[number];
/** Where the capture time came from: GPS (UTC), EXIF with its offset, or EXIF assumed Nairobi. */
export const PHOTO_TIME_SOURCES = ["gps", "offset", "assumed_nairobi"] as const;
export type PhotoTimeSource = (typeof PHOTO_TIME_SOURCES)[number];

export type PhotoEvidenceInput = {
  location: LatLng | null;
  capturedAt: Date | null;
  uploadedAt: Date;
  /** The site's geofence version in force at capture (or the current one without a time). */
  geofence: Geofence | null;
  /** When the photo is attached to a site diary, the diary's calendar date (Africa/Nairobi). */
  diaryDate?: string | null;
  toleranceM?: number;
  maxAgeHours?: number;
  futureSkewMinutes?: number;
};

export type PhotoEvidence = {
  location: PhotoLocationCheck;
  /** Metres outside the geofence (after no tolerance); null unless the location is outside. */
  distanceM: number | null;
  time: PhotoTimeCheck;
  verified: boolean;
};

export function verifyPhotoEvidence(input: PhotoEvidenceInput): PhotoEvidence {
  const toleranceM = input.toleranceM ?? PHOTO_VERIFICATION_DEFAULTS.toleranceM;
  const maxAgeHours = input.maxAgeHours ?? PHOTO_VERIFICATION_DEFAULTS.maxAgeHours;
  const skew = input.futureSkewMinutes ?? PHOTO_VERIFICATION_DEFAULTS.futureSkewMinutes;

  let location: PhotoLocationCheck;
  let distanceM: number | null = null;
  if (!input.location) location = "missing";
  else if (!input.geofence) location = "no_geofence";
  else if (isInsideGeofence(input.location, input.geofence, toleranceM)) location = "inside";
  else {
    location = "outside";
    distanceM = Math.round(distanceOutsideGeofenceM(input.location, input.geofence) * 10) / 10;
  }

  let time: PhotoTimeCheck;
  const captured = input.capturedAt;
  if (!captured || Number.isNaN(captured.getTime())) time = "missing";
  else if (captured.getTime() > input.uploadedAt.getTime() + skew * 60_000) time = "future";
  else if (input.uploadedAt.getTime() - captured.getTime() > maxAgeHours * 3_600_000)
    time = "stale";
  else if (input.diaryDate && nairobiDate(captured) !== input.diaryDate) time = "diary_mismatch";
  else time = "ok";

  return { location, distanceM, time, verified: location === "inside" && time === "ok" };
}
