/**
 * Site photos for the mock API (owner persona): an in-memory timeline per test session. Uploads
 * are read from the raw multipart body; a file name containing "duplicate" is refused and one
 * containing "outside" is recorded as taken outside the site. Synthetic data only.
 */
import { randomUUID } from "node:crypto";
import {
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
  capturedAt: "2026-11-10T06:15:30.000Z",
  timeSource: "offset",
  location: { lat: -1.14881, lng: 36.96137 },
  camera: "TestCam Field 1",
  width: 4032,
  height: 3024,
  sizeBytes: 2_400_000,
  sha256: randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64),
  geofenceVersion: 1,
  checks: { location: "inside", time: "ok", distanceM: null },
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
    location: { lat: -1.15069, lng: 36.96142 },
    checks: { location: "outside", time: "ok", distanceM: 176.4 },
    verified: false,
    timeSource: "assumed_nairobi",
  }),
];

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
  const outside = fileName.includes("outside");
  const created = photo(projectId, siteId, {
    caption: field(text, "caption") ?? null,
    diaryId: field(text, "diaryId") ?? null,
    uploadedAt: new Date().toISOString(),
    ...(outside
      ? { verified: false, checks: { location: "outside", time: "ok", distanceM: 210 } }
      : {}),
  });
  photos.unshift(created);
  if (field(text, "purpose") === "safety_incident") restricted.add(created.id);
  return { status: 201, body: { photo: created }, schema: sitePhotoResponseSchema };
}
