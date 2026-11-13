import { describe, expect, it } from "vitest";
import type { Geofence } from "./geofence.js";
import { verifyPhotoEvidence } from "./photo-evidence.js";

/** Metres → degrees near Ruiru (latitude −1.15°). */
const ruiru = { lat: -1.1489, lng: 36.9612 };
const at = (east: number, north: number) => ({
  lat: ruiru.lat + north / 111_195,
  lng: ruiru.lng + east / 111_173,
});
const plot: Geofence = {
  kind: "polygon",
  vertices: [at(0, 0), at(60, 0), at(60, 45), at(0, 45)],
};
const yard: Geofence = { kind: "radius", center: at(30, -40), radiusM: 40 };
const uploadedAt = new Date("2026-11-10T12:00:00Z");
const base = {
  location: at(30, 20),
  capturedAt: new Date("2026-11-10T08:00:00Z"),
  uploadedAt,
  geofence: plot,
};

describe("verifyPhotoEvidence", () => {
  it("verifies a recent photo taken inside the geofence", () => {
    expect(verifyPhotoEvidence(base)).toEqual({
      location: "inside",
      distanceM: null,
      time: "ok",
      verified: true,
    });
    expect(verifyPhotoEvidence({ ...base, location: at(30, -40), geofence: yard }).verified).toBe(
      true,
    );
  });

  it("allows GPS tolerance at the boundary, and reports how far outside a photo was", () => {
    expect(verifyPhotoEvidence({ ...base, location: at(80, 20) }).location).toBe("inside");
    const far = verifyPhotoEvidence({ ...base, location: at(160, 20) });
    expect(far).toMatchObject({ location: "outside", verified: false });
    expect(far.distanceM).toBeGreaterThan(99);
    expect(far.distanceM).toBeLessThan(101);
    const yardFar = verifyPhotoEvidence({ ...base, location: at(30, -200), geofence: yard });
    expect(yardFar.distanceM).toBeGreaterThan(119);
    expect(yardFar.distanceM).toBeLessThan(121);
    expect(verifyPhotoEvidence({ ...base, location: at(80, 20), toleranceM: 0 }).location).toBe(
      "outside",
    );
  });

  it("refuses to verify without a position or a geofence", () => {
    expect(verifyPhotoEvidence({ ...base, location: null })).toMatchObject({
      location: "missing",
      verified: false,
    });
    expect(verifyPhotoEvidence({ ...base, geofence: null })).toMatchObject({
      location: "no_geofence",
      verified: false,
    });
  });

  it("checks the capture time against the upload time and the diary date", () => {
    const check = (capturedAt: Date | null, extra = {}) =>
      verifyPhotoEvidence({ ...base, capturedAt, ...extra }).time;
    expect(check(null)).toBe("missing");
    expect(check(new Date("invalid"))).toBe("missing");
    expect(check(new Date("2026-11-10T12:09:00Z"))).toBe("ok");
    expect(check(new Date("2026-11-10T12:11:00Z"))).toBe("future");
    expect(check(new Date("2026-11-07T12:00:00Z"))).toBe("ok");
    expect(check(new Date("2026-11-07T11:59:00Z"))).toBe("stale");
    // 22:30 UTC on the 9th is 01:30 on the 10th in Nairobi.
    expect(check(new Date("2026-11-09T22:30:00Z"), { diaryDate: "2026-11-10" })).toBe("ok");
    expect(check(new Date("2026-11-09T20:30:00Z"), { diaryDate: "2026-11-10" })).toBe(
      "diary_mismatch",
    );
    expect(verifyPhotoEvidence({ ...base, capturedAt: null }).verified).toBe(false);
  });
});
