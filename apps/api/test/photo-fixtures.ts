import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { photoCaptureTicketResponseSchema } from "@pm-buddy/validation";
import type { Browser } from "./support.js";

/**
 * A random picture: 8×6 coloured blocks. Each has its own difference hash, so test photos never
 * look like reused pictures of each other; pass the same pattern to make a near-duplicate.
 */
export const pattern = () => randomBytes(8 * 6 * 3);
const patterned = (width: number, height: number, seed: Buffer = pattern()) =>
  sharp(seed, { raw: { width: 8, height: 6, channels: 3 } }).resize(width, height, {
    kernel: "nearest",
  });

/**
 * A small HEIC (HEVC-coded HEIF, as an iPhone saves) made on macOS with `sips` from a patterned
 * 160×120 JPEG whose EXIF says Apple iPhone 15, taken 2026-01-15 09:15:00 +03:00 at
 * −1.148719, 36.961469 (inside the photo tests' plot).
 */
export const heicPhoto = () =>
  readFileSync(new URL("./fixtures/photos/iphone.heic", import.meta.url));

/** Builds synthetic JPEGs with chosen EXIF (sharp writes it; tests read it back as the API does). */
export type PhotoSpec = {
  lat?: number;
  lng?: number;
  /** Camera wall-clock time, "YYYY:MM:DD HH:MM:SS". */
  original?: string;
  /** e.g. "+03:00". */
  offset?: string;
  gpsDate?: string;
  gpsTime?: [number, number, number];
  make?: string;
  model?: string;
  width?: number;
  height?: number;
  /** The picture's blocks (see `pattern`); random by default. */
  pattern?: Buffer;
  quality?: number;
};

const dms = (value: number) => {
  const magnitude = Math.abs(value);
  const degrees = Math.floor(magnitude);
  const minutesFull = (magnitude - degrees) * 60;
  const minutes = Math.floor(minutesFull);
  const hundredths = Math.round((minutesFull - minutes) * 60 * 100);
  return `${degrees}/1 ${minutes}/1 ${hundredths}/100`;
};

export async function jpegWithExif(spec: PhotoSpec = {}): Promise<Buffer> {
  const gps: Record<string, string> = {};
  if (spec.lat !== undefined && spec.lng !== undefined) {
    gps["GPSLatitudeRef"] = spec.lat < 0 ? "S" : "N";
    gps["GPSLatitude"] = dms(spec.lat);
    gps["GPSLongitudeRef"] = spec.lng < 0 ? "W" : "E";
    gps["GPSLongitude"] = dms(spec.lng);
  }
  if (spec.gpsDate) gps["GPSDateStamp"] = spec.gpsDate;
  if (spec.gpsTime) gps["GPSTimeStamp"] = spec.gpsTime.map((part) => `${part}/1`).join(" ");
  const photo: Record<string, string> = {};
  if (spec.original) photo["DateTimeOriginal"] = spec.original;
  if (spec.offset) photo["OffsetTimeOriginal"] = spec.offset;
  return patterned(spec.width ?? 64, spec.height ?? 48, spec.pattern)
    .jpeg({ quality: spec.quality ?? 80 })
    .withExif({
      // A unique description keeps every generated file's SHA-256 distinct.
      IFD0: {
        ImageDescription: randomUUID(),
        ...(spec.make ? { Make: spec.make } : {}),
        ...(spec.model ? { Model: spec.model } : {}),
      },
      ...(Object.keys(photo).length ? { IFD2: photo } : {}),
      ...(Object.keys(gps).length ? { IFD3: gps } : {}),
    })
    .toBuffer();
}

/** A JPEG with no EXIF at all (as the camera screen's canvas makes); a random picture by default. */
export const plainJpeg = (seed?: Buffer, quality = 80, width = 32, height = 32) =>
  patterned(width, height, seed).jpeg({ quality }).toBuffer();

/**
 * The fields PM-Buddy's camera screen sends: it opens a capture for the site first, then sends
 * the phone's clock at the shutter and the browser's position with its accuracy.
 */
export async function inAppCapture(
  browser: Browser,
  projectId: string,
  siteId: string,
  place: { lat: number; lng: number } | null,
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  const res = await browser.call("post", `projects/${projectId}/photos/capture-tickets`, {
    siteId,
  });
  if (res.status !== 201) throw new Error(`Capture not opened: ${JSON.stringify(res.body)}`);
  const { ticket } = photoCaptureTicketResponseSchema.parse(res.body);
  return {
    siteId,
    captureTicketId: ticket.id,
    capturedAt: new Date().toISOString(),
    ...(place
      ? { latitude: place.lat.toFixed(6), longitude: place.lng.toFixed(6), accuracyM: "8" }
      : {}),
    ...extra,
  };
}
