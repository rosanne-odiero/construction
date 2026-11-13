import exif from "exif-reader";
import type { PhotoTimeSource } from "@pm-buddy/domain";

export type PhotoMetadata = {
  location: { lat: number; lng: number } | null;
  capturedAt: Date | null;
  timeSource: PhotoTimeSource | null;
  camera: string | null;
};

const EMPTY: PhotoMetadata = { location: null, capturedAt: null, timeSource: null, camera: null };
const NAIROBI_OFFSET_MINUTES = 180;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const triple = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every((part) => finite(part) && part >= 0);
const printable = (value: unknown) =>
  typeof value === "string"
    ? Array.from(value)
        .filter((character) => character >= " " && character !== "\u007f")
        .join("")
        .replace(/\0/g, "")
        .trim()
    : "";
const plausible = (date: Date) =>
  !Number.isNaN(date.getTime()) && date.getUTCFullYear() >= 2000 && date.getUTCFullYear() <= 2100;

/** Degrees/minutes/seconds plus N/S or E/W reference → signed decimal degrees, or null. */
function decimalDegrees(
  value: unknown,
  ref: unknown,
  positive: string,
  negative: string,
  max: number,
) {
  if (!triple(value)) return null;
  const [degrees, minutes, seconds] = value;
  if (minutes >= 60 || seconds >= 60) return null;
  const magnitude = degrees + minutes / 60 + seconds / 3600;
  if (magnitude > max) return null;
  if (ref === positive) return round6(magnitude);
  if (ref === negative) return round6(-magnitude);
  return null;
}

/**
 * Reads position, capture time and camera from a photo's raw EXIF block (as returned by sharp).
 * Anything malformed is treated as absent, never guessed. Capture time preference: the camera's
 * time with its own offset, then the GPS clock (UTC), then the camera time assumed to be Nairobi
 * time (flagged by `timeSource`). A 0,0 position (no GPS fix) counts as no position.
 */
export function readPhotoMetadata(raw: Buffer | undefined): PhotoMetadata {
  if (!raw?.length) return EMPTY;
  let tags: ReturnType<typeof exif>;
  try {
    tags = exif(raw);
  } catch {
    return EMPTY;
  }
  const gps = (tags.GPSInfo ?? {}) as Record<string, unknown>;
  const photo = (tags.Photo ?? {}) as Record<string, unknown>;
  const image = (tags.Image ?? {}) as Record<string, unknown>;

  const lat = decimalDegrees(gps["GPSLatitude"], gps["GPSLatitudeRef"], "N", "S", 90);
  const lng = decimalDegrees(gps["GPSLongitude"], gps["GPSLongitudeRef"], "E", "W", 180);
  const location = lat !== null && lng !== null && !(lat === 0 && lng === 0) ? { lat, lng } : null;

  let capturedAt: Date | null = null;
  let timeSource: PhotoTimeSource | null = null;
  const original = photo["DateTimeOriginal"];
  // exif-reader returns the camera's wall-clock time as if it were UTC.
  const wallClock = original instanceof Date && plausible(original) ? original : null;
  const offset = /^([+-])(\d{2}):(\d{2})$/.exec(printable(photo["OffsetTimeOriginal"]));
  const gpsDate = /^(\d{4}):(\d{2}):(\d{2})$/.exec(printable(gps["GPSDateStamp"]));
  const gpsTime = gps["GPSTimeStamp"];
  if (wallClock && offset) {
    const minutes = (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]));
    capturedAt = new Date(wallClock.getTime() - minutes * 60_000);
    timeSource = "offset";
  } else if (gpsDate && triple(gpsTime) && gpsTime[0] < 24 && gpsTime[1] < 60 && gpsTime[2] < 61) {
    const [hours, minutes, seconds] = gpsTime;
    const date = new Date(
      Date.UTC(
        Number(gpsDate[1]),
        Number(gpsDate[2]) - 1,
        Number(gpsDate[3]),
        hours,
        minutes,
        Math.floor(seconds),
        Math.round((seconds % 1) * 1000),
      ),
    );
    if (plausible(date)) {
      capturedAt = date;
      timeSource = "gps";
    }
  }
  if (!capturedAt && wallClock) {
    capturedAt = new Date(wallClock.getTime() - NAIROBI_OFFSET_MINUTES * 60_000);
    timeSource = "assumed_nairobi";
  }
  if (capturedAt && !plausible(capturedAt)) {
    capturedAt = null;
    timeSource = null;
  }

  const make = printable(image["Make"]);
  const model = printable(image["Model"]);
  const camera =
    (model.toLowerCase().startsWith(make.toLowerCase())
      ? model
      : [make, model].filter(Boolean).join(" ")
    )
      .slice(0, 120)
      .trim() || null;
  return { location, capturedAt, timeSource, camera };
}
