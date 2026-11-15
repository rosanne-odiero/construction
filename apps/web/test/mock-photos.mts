/**
 * Site photos for the mock API (owner persona): an in-memory timeline per test session. Uploads
 * are read from the raw multipart body. With a capture ticket (the camera screen) a photo is
 * in-app and verified when its position is near the main plot; without one it is imported and
 * never verified. A file name containing "duplicate" is refused, one containing "outside" is
 * recorded as taken outside the site, and a `.heic` name is stored as HEIC. Synthetic data only.
 */
import { randomUUID } from "node:crypto";
import {
  photoCaptureTicketResponseSchema,
  sitePhotoResponseSchema,
  sitePhotosResponseSchema,
  type SitePhoto,
} from "@pm-buddy/validation";

const OWNER = { id: "21000000-0000-4000-8000-000000000001", displayName: "Wanjiru Kamau" };

const photo = (projectId: string, siteId: string, fields: Partial<SitePhoto>): SitePhoto => ({
  id: randomUUID(),
  projectId,
  siteId,
  diaryId: null,
  caption: null,
  contentType: "image/jpeg",
  captureMethod: "in_app",
  capturedAt: "2026-11-10T06:15:30.000Z",
  timeSource: "device",
  location: { lat: -1.14881, lng: 36.96137, accuracyM: 6 },
  camera: null,
  width: 4032,
  height: 3024,
  sizeBytes: 2_400_000,
  sha256: randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64),
  geofenceVersion: 1,
  checks: {
    location: "inside",
    time: "ok",
    distanceM: null,
    similarity: "unique",
    similarTo: null,
  },
  verified: true,
  scanStatus: "not_scanned",
  uploadedBy: OWNER,
  uploadedAt: "2026-11-10T06:20:00.000Z",
  ...fields,
});

export const initialPhotos = (projectId: string, siteId: string): SitePhoto[] => [
  photo(projectId, siteId, { caption: "Synthetic: first-floor columns" }),
  photo(projectId, siteId, {
    caption: "Synthetic: delivery at the gate",
    captureMethod: "imported",
    camera: "TestCam Field 1",
    location: { lat: -1.15069, lng: 36.96142, accuracyM: null },
    checks: {
      location: "outside",
      time: "ok",
      distanceM: 176.4,
      similarity: "unique",
      similarTo: null,
    },
    verified: false,
    timeSource: "assumed_nairobi",
  }),
  photo(projectId, siteId, {
    caption: "Synthetic: slab formwork",
    checks: {
      location: "inside",
      time: "ok",
      distanceM: null,
      similarity: "similar",
      similarTo: { photoId: null, otherProject: true, distance: 2 },
    },
    verified: false,
  }),
];

/** Capture tickets opened by the camera screen, and those already used by an upload. */
const tickets = new Set<string>();
const usedTickets = new Set<string>();

export function handleCaptureTicket(
  siteIds: string[],
  raw: Buffer,
  fail: (status: number, code: string) => Error,
) {
  const { siteId } = JSON.parse(raw.toString("utf8") || "{}") as { siteId?: string };
  if (!siteId || !siteIds.includes(siteId)) throw fail(404, "not-found");
  const id = randomUUID();
  tickets.add(id);
  const issuedAt = new Date();
  return {
    status: 201,
    body: {
      ticket: {
        id,
        siteId,
        issuedAt: issuedAt.toISOString(),
        useBy: new Date(issuedAt.getTime() + 30 * 60_000).toISOString(),
      },
    },
    schema: photoCaptureTicketResponseSchema,
  };
}

/** Incident photos (purpose `safety_incident`) stay out of the project's photo list. */
const restricted = new Set<string>();

const field = (raw: string, name: string) =>
  new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(raw)?.[1];

export function handlePhotos(
  photos: SitePhoto[],
  projectId: string,
  siteIds: string[],
  method: string,
  raw: Buffer,
  fail: (status: number, code: string) => Error,
) {
  if (method === "GET")
    return {
      body: {
        photos: photos.filter(
          (value) => value.projectId === projectId && !restricted.has(value.id),
        ),
        nextCursor: null,
      },
      schema: sitePhotosResponseSchema,
    };
  const text = raw.toString("latin1");
  const siteId = field(text, "siteId");
  const fileName = /filename="([^"]+)"/.exec(text)?.[1] ?? "";
  if (!fileName) throw fail(400, "file-required");
  if (!siteId || !siteIds.includes(siteId)) throw fail(404, "not-found");
  if (fileName.includes("duplicate")) throw fail(409, "photo-duplicate");
  const ticket = field(text, "captureTicketId");
  if (ticket && !tickets.has(ticket)) throw fail(422, "capture-ticket-invalid");
  if (ticket && usedTickets.has(ticket)) throw fail(409, "capture-ticket-used");
  if (ticket) usedTickets.add(ticket);
  const latitude = field(text, "latitude");
  const longitude = field(text, "longitude");
  const accuracy = field(text, "accuracyM");
  const position =
    ticket && latitude && longitude
      ? { lat: Number(latitude), lng: Number(longitude), accuracyM: Number(accuracy) }
      : null;
  const outside =
    fileName.includes("outside") ||
    (position !== null &&
      (Math.abs(position.lat + 1.1489) > 0.002 || Math.abs(position.lng - 36.9613) > 0.002));
  const location = ticket
    ? !position
      ? "missing"
      : position.accuracyM > 50
        ? "low_accuracy"
        : outside
          ? "outside"
          : "inside"
    : outside
      ? "outside"
      : "inside";
  const checks = {
    location,
    time: "ok",
    distanceM: location === "outside" ? 210 : null,
    similarity: "unique",
    similarTo: null,
  } as const;
  const created = photo(projectId, siteId, {
    caption: field(text, "caption") ?? null,
    diaryId: field(text, "diaryId") ?? null,
    uploadedAt: new Date().toISOString(),
    contentType: fileName.toLowerCase().endsWith(".heic") ? "image/heic" : "image/jpeg",
    ...(ticket
      ? {
          captureMethod: "in_app",
          capturedAt: field(text, "capturedAt") ?? null,
          timeSource: "device",
          location: position,
          geofenceVersion: location === "inside" || location === "outside" ? 1 : null,
        }
      : {
          captureMethod: "imported",
          camera: "TestCam Field 1",
          timeSource: "offset",
          location: { lat: -1.14881, lng: 36.96137, accuracyM: null },
        }),
    checks,
    verified: Boolean(ticket) && location === "inside",
  });
  photos.unshift(created);
  if (field(text, "purpose") === "safety_incident") restricted.add(created.id);
  return { status: 201, body: { photo: created }, schema: sitePhotoResponseSchema };
}
