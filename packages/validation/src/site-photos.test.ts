import { describe, expect, it } from "vitest";
import {
  photoUploadFieldsSchema,
  sitePhotoListQuerySchema,
  sitePhotoSchema,
} from "./site-photos.js";

const id = "31000000-0000-4000-8000-000000000001";
const photo = {
  id,
  projectId: id,
  siteId: id,
  diaryId: null,
  caption: null,
  capturedAt: "2026-11-10T06:15:30.000Z",
  timeSource: "gps",
  location: { lat: -1.1489, lng: 36.9612 },
  camera: "TestCam Field 1",
  width: 4032,
  height: 3024,
  sizeBytes: 2_400_000,
  sha256: "a".repeat(64),
  geofenceVersion: 1,
  checks: { location: "inside", time: "ok", distanceM: null },
  verified: true,
  scanStatus: "not_scanned",
  uploadedBy: { id, displayName: "Kevin Kiprono" },
  uploadedAt: "2026-11-10T06:20:00.000Z",
};

describe("site photo contracts", () => {
  it("accepts upload fields, trimming captions and dropping empty ones", () => {
    expect(photoUploadFieldsSchema.parse({ siteId: id, caption: "  Columns  " })).toEqual({
      siteId: id,
      caption: "Columns",
    });
    expect(photoUploadFieldsSchema.parse({ siteId: id, caption: " " }).caption).toBeUndefined();
    for (const fields of [
      {},
      { siteId: "x" },
      { siteId: id, caption: "a".repeat(501) },
      { siteId: id, verified: "true" },
      { siteId: id, latitude: "-1.1" },
    ])
      expect(photoUploadFieldsSchema.safeParse(fields).success, JSON.stringify(fields)).toBe(false);
  });

  it("refuses a record whose verified flag disagrees with its checks", () => {
    expect(sitePhotoSchema.safeParse(photo).success).toBe(true);
    for (const checks of [
      { location: "outside", time: "ok", distanceM: 120 },
      { location: "inside", time: "stale", distanceM: null },
      { location: "missing", time: "missing", distanceM: null },
    ])
      expect(sitePhotoSchema.safeParse({ ...photo, checks }).success).toBe(false);
    expect(
      sitePhotoSchema.safeParse({
        ...photo,
        verified: false,
        checks: { location: "outside", time: "ok", distanceM: 120 },
      }).success,
    ).toBe(true);
  });

  it("bounds list queries", () => {
    expect(sitePhotoListQuerySchema.parse({}).limit).toBe(24);
    for (const limit of ["0", "61", "x"])
      expect(sitePhotoListQuerySchema.safeParse({ limit }).success).toBe(false);
  });
});
