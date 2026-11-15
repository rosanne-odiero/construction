import { describe, expect, it } from "vitest";
import {
  photoCaptureTicketResponseSchema,
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
  contentType: "image/jpeg",
  captureMethod: "in_app",
  capturedAt: "2026-11-10T06:15:30.000Z",
  timeSource: "device",
  location: { lat: -1.1489, lng: 36.9612, accuracyM: 8.5 },
  camera: "TestCam Field 1",
  width: 4032,
  height: 3024,
  sizeBytes: 2_400_000,
  sha256: "a".repeat(64),
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

  it("takes capture details only with a capture ticket, and positions only whole", () => {
    const inApp = {
      siteId: id,
      captureTicketId: id,
      capturedAt: "2026-11-10T06:15:30.000Z",
      latitude: "-1.148912",
      longitude: "36.961234",
      accuracyM: "8.5",
    };
    expect(photoUploadFieldsSchema.parse(inApp)).toMatchObject({
      latitude: -1.148912,
      longitude: 36.961234,
      accuracyM: 8.5,
    });
    const { latitude: _lat, longitude: _lng, accuracyM: _acc, ...noPosition } = inApp;
    expect(photoUploadFieldsSchema.safeParse(noPosition).success).toBe(true);
    for (const fields of [
      { ...inApp, capturedAt: undefined },
      { ...inApp, accuracyM: undefined },
      { ...noPosition, latitude: "-1.1" },
      { ...inApp, latitude: "" },
      { ...inApp, latitude: "1e1" },
      { ...inApp, latitude: "-91" },
      { ...inApp, longitude: "181.5" },
      { ...inApp, accuracyM: "-1" },
      { siteId: id, capturedAt: inApp.capturedAt },
    ])
      expect(photoUploadFieldsSchema.safeParse(fields).success, JSON.stringify(fields)).toBe(false);
    expect(
      photoCaptureTicketResponseSchema.safeParse({
        ticket: { id, siteId: id, issuedAt: inApp.capturedAt, useBy: inApp.capturedAt },
      }).success,
    ).toBe(true);
  });

  it("refuses a record whose verified flag disagrees with its checks", () => {
    expect(sitePhotoSchema.safeParse(photo).success).toBe(true);
    const unique = { similarity: "unique", similarTo: null };
    for (const checks of [
      { location: "outside", time: "ok", distanceM: 120, ...unique },
      { location: "inside", time: "stale", distanceM: null, ...unique },
      { location: "missing", time: "missing", distanceM: null, ...unique },
      { location: "low_accuracy", time: "ok", distanceM: null, ...unique },
      {
        location: "inside",
        time: "ok",
        distanceM: null,
        similarity: "similar",
        similarTo: { photoId: null, otherProject: true, distance: 2 },
      },
    ])
      expect(sitePhotoSchema.safeParse({ ...photo, checks }).success).toBe(false);
    expect(sitePhotoSchema.safeParse({ ...photo, captureMethod: "imported" }).success).toBe(false);
    expect(
      sitePhotoSchema.safeParse({ ...photo, captureMethod: "imported", verified: false }).success,
    ).toBe(true);
    expect(
      sitePhotoSchema.safeParse({
        ...photo,
        verified: false,
        checks: { location: "outside", time: "ok", distanceM: 120, ...unique },
      }).success,
    ).toBe(true);
  });

  it("names the similar photo exactly when the picture is similar", () => {
    const similar = (similarTo: unknown) =>
      sitePhotoSchema.safeParse({
        ...photo,
        verified: false,
        checks: { ...photo.checks, similarity: "similar", similarTo },
      }).success;
    expect(similar({ photoId: id, otherProject: false, distance: 0 })).toBe(true);
    expect(similar(null)).toBe(false);
    expect(similar({ photoId: id, otherProject: false, distance: 65 })).toBe(false);
    expect(
      sitePhotoSchema.safeParse({
        ...photo,
        checks: { ...photo.checks, similarTo: { photoId: id, otherProject: false, distance: 0 } },
      }).success,
    ).toBe(false);
  });

  it("bounds list queries", () => {
    expect(sitePhotoListQuerySchema.parse({}).limit).toBe(24);
    for (const limit of ["0", "61", "x"])
      expect(sitePhotoListQuerySchema.safeParse({ limit }).success).toBe(false);
  });
});
