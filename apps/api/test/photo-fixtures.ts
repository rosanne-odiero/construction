import { randomUUID } from "node:crypto";
import sharp from "sharp";

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
  return sharp({
    create: {
      width: spec.width ?? 64,
      height: spec.height ?? 48,
      channels: 3,
      background: { r: 90, g: 130, b: 110 },
    },
  })
    .jpeg()
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

/** A JPEG with no EXIF at all. */
export const plainJpeg = () =>
  sharp({ create: { width: 32, height: 32, channels: 3, background: "#456" } })
    .jpeg({ quality: Math.floor(Math.random() * 40) + 50 })
    .toBuffer();
