import type { LatLng } from "./geo.js";
import { distanceOutsideGeofenceM, isInsideGeofence, type Geofence } from "./geofence.js";
import { nairobiDate } from "./project-lifecycle.js";

/**
 * Site photo evidence (D6.1, THREAT_MODEL A-13). Only a photo taken with PM-Buddy's own camera
 * screen can be verified: the server issued a capture ticket when the camera opened, so the
 * capture time is bounded by the server clock, and the phone's position comes from the browser at
 * that moment. Imported files (gallery, desktop, HEIC) keep their EXIF checks for review but are
 * never verified. A photo that looks like one from another day or project is not verified either.
 * A browser cannot attest the device, so "verified" is strong evidence for review, not proof.
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
  /** Imported photos: EXIF capture time up to three days before the upload (a day offline). */
  maxAgeHours: 72,
  /** Allowance for phone clocks running slightly fast. */
  futureSkewMinutes: 10,
  /** In-app capture: the upload must arrive within this long of the camera opening. */
  captureWindowMinutes: 30,
  /** In-app capture: a position less accurate than this is not used to place the photo. */
  maxAccuracyM: 50,
  /** Difference-hash bits (of 64) that may differ for two photos to count as the same picture. */
  similarityMaxDistance: 6,
} as const;

/**
 * What a photo is for. Incident photos (D8.2) can show injured people: they stay out of the
 * project's photo list and only health and safety readers can open them.
 */
export const PHOTO_PURPOSES = ["general", "safety_incident"] as const;
export type PhotoPurpose = (typeof PHOTO_PURPOSES)[number];

/** Taken with PM-Buddy's camera screen (with a capture ticket), or imported as a file. */
export const PHOTO_CAPTURE_METHODS = ["in_app", "imported"] as const;
export type PhotoCaptureMethod = (typeof PHOTO_CAPTURE_METHODS)[number];
export const PHOTO_LOCATION_CHECKS = [
  "inside",
  "outside",
  "missing",
  "no_geofence",
  "low_accuracy",
] as const;
export type PhotoLocationCheck = (typeof PHOTO_LOCATION_CHECKS)[number];
export const PHOTO_TIME_CHECKS = [
  "ok",
  "future",
  "stale",
  "missing",
  "diary_mismatch",
  "outside_window",
] as const;
export type PhotoTimeCheck = (typeof PHOTO_TIME_CHECKS)[number];
/**
 * Where the capture time came from: GPS (UTC), EXIF with its offset, EXIF assumed Nairobi, or the
 * phone's clock at the shutter of an in-app capture.
 */
export const PHOTO_TIME_SOURCES = ["gps", "offset", "assumed_nairobi", "device"] as const;
export type PhotoTimeSource = (typeof PHOTO_TIME_SOURCES)[number];
/**
 * `similar`: the picture matches an earlier photo of the company from another day or another
 * project; `not_checked`: recorded before the check existed.
 */
export const PHOTO_SIMILARITY_CHECKS = ["unique", "similar", "not_checked"] as const;
export type PhotoSimilarityCheck = (typeof PHOTO_SIMILARITY_CHECKS)[number];
/** Stored originals: JPEG, or HEIC (HEVC-coded HEIF, as iPhones save by default). */
export const PHOTO_CONTENT_TYPES = ["image/jpeg", "image/heic"] as const;
export type PhotoContentType = (typeof PHOTO_CONTENT_TYPES)[number];

export type PhotoCapture =
  | { method: "imported" }
  | {
      method: "in_app";
      /** When the server issued the capture ticket, as the camera screen opened. */
      cameraOpenedAt: Date;
      /** The browser's accuracy radius for the position, in metres. */
      accuracyM: number | null;
    };

export type PhotoEvidenceInput = {
  location: LatLng | null;
  capturedAt: Date | null;
  uploadedAt: Date;
  /** The site's geofence version in force at capture (or the current one without a time). */
  geofence: Geofence | null;
  /** When the photo is attached to a site diary, the diary's calendar date (Africa/Nairobi). */
  diaryDate?: string | null;
  capture: PhotoCapture;
  similarity: PhotoSimilarityCheck;
  toleranceM?: number;
  maxAgeHours?: number;
  futureSkewMinutes?: number;
  captureWindowMinutes?: number;
  maxAccuracyM?: number;
};

export type PhotoEvidence = {
  captureMethod: PhotoCaptureMethod;
  location: PhotoLocationCheck;
  /** Metres outside the geofence (after no tolerance); null unless the location is outside. */
  distanceM: number | null;
  time: PhotoTimeCheck;
  similarity: PhotoSimilarityCheck;
  verified: boolean;
};

/** The rule the database backstops: in-app, inside the site, on time and not a reused picture. */
export const isVerifiedPhoto = (evidence: Omit<PhotoEvidence, "verified" | "distanceM">) =>
  evidence.captureMethod === "in_app" &&
  evidence.location === "inside" &&
  evidence.time === "ok" &&
  evidence.similarity === "unique";

export function verifyPhotoEvidence(input: PhotoEvidenceInput): PhotoEvidence {
  const toleranceM = input.toleranceM ?? PHOTO_VERIFICATION_DEFAULTS.toleranceM;
  const maxAgeHours = input.maxAgeHours ?? PHOTO_VERIFICATION_DEFAULTS.maxAgeHours;
  const skewMs =
    (input.futureSkewMinutes ?? PHOTO_VERIFICATION_DEFAULTS.futureSkewMinutes) * 60_000;
  const windowMs =
    (input.captureWindowMinutes ?? PHOTO_VERIFICATION_DEFAULTS.captureWindowMinutes) * 60_000;
  const maxAccuracyM = input.maxAccuracyM ?? PHOTO_VERIFICATION_DEFAULTS.maxAccuracyM;
  const { capture } = input;

  let location: PhotoLocationCheck;
  let distanceM: number | null = null;
  if (!input.location) location = "missing";
  else if (
    capture.method === "in_app" &&
    (capture.accuracyM === null || !(capture.accuracyM <= maxAccuracyM))
  )
    location = "low_accuracy";
  else if (!input.geofence) location = "no_geofence";
  else if (isInsideGeofence(input.location, input.geofence, toleranceM)) location = "inside";
  else {
    location = "outside";
    distanceM = Math.round(distanceOutsideGeofenceM(input.location, input.geofence) * 10) / 10;
  }

  let time: PhotoTimeCheck;
  const captured = input.capturedAt;
  const uploaded = input.uploadedAt.getTime();
  if (!captured || Number.isNaN(captured.getTime())) time = "missing";
  else if (captured.getTime() > uploaded + skewMs) time = "future";
  else if (capture.method === "in_app") {
    const opened = capture.cameraOpenedAt.getTime();
    // The shutter time must fall after the server opened the capture, and the upload follow soon.
    if (captured.getTime() < opened - skewMs) time = "outside_window";
    else if (uploaded - opened > windowMs) time = "stale";
    else time = "ok";
  } else if (uploaded - captured.getTime() > maxAgeHours * 3_600_000) time = "stale";
  else time = "ok";
  if (time === "ok" && captured && input.diaryDate && nairobiDate(captured) !== input.diaryDate)
    time = "diary_mismatch";

  const evidence = {
    captureMethod: capture.method,
    location,
    distanceM,
    time,
    similarity: input.similarity,
  };
  return { ...evidence, verified: isVerifiedPhoto(evidence) };
}

/**
 * A 64-bit difference hash (dHash) of a 9×8 greyscale thumbnail, row by row: each bit says whether
 * a pixel is brighter than its right-hand neighbour. Re-encoding, resizing or light edits change
 * few bits, so a small Hamming distance means the same picture.
 */
export function differenceHash(grey: ArrayLike<number>): bigint {
  if (grey.length !== 72) throw new RangeError("differenceHash needs 9×8 greyscale pixels");
  let hash = 0n;
  for (let row = 0; row < 8; row += 1)
    for (let column = 0; column < 8; column += 1)
      hash = (hash << 1n) | (grey[row * 9 + column]! > grey[row * 9 + column + 1]! ? 1n : 0n);
  return hash;
}

/** Bits that differ between two 64-bit hashes. */
export function hammingDistance(a: bigint, b: bigint): number {
  let rest = BigInt.asUintN(64, a ^ b);
  let count = 0;
  while (rest) {
    rest &= rest - 1n;
    count += 1;
  }
  return count;
}

const HEVC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx"]);

/**
 * The stored type of an upload by its signature, never its name or declared type: JPEG (SOI
 * marker) or HEIC (an ISO-BMFF `ftyp` box listing an HEVC brand). Anything else is null.
 */
export function sniffPhotoType(bytes: Uint8Array): PhotoContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (bytes.length < 16) return null;
  const ascii = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  const size = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  if (ascii(4) !== "ftyp" || size < 16 || size > Math.min(bytes.length, 4096) || size % 4)
    return null;
  const brands = [ascii(8)];
  for (let at = 16; at + 4 <= size; at += 4) brands.push(ascii(at));
  return brands.some((brand) => HEVC_BRANDS.has(brand)) ? "image/heic" : null;
}
