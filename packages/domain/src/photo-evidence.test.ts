import { describe, expect, it } from "vitest";
import type { Geofence } from "./geofence.js";
import {
  differenceHash,
  hammingDistance,
  sniffPhotoType,
  verifyPhotoEvidence,
  type PhotoEvidenceInput,
} from "./photo-evidence.js";

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
const minutes = (offset: number) => new Date(uploadedAt.getTime() + offset * 60_000);
/** Taken with the in-app camera: opened five minutes before the upload, shutter two minutes in. */
const base: PhotoEvidenceInput = {
  location: at(30, 20),
  capturedAt: minutes(-3),
  uploadedAt,
  geofence: plot,
  capture: { method: "in_app", cameraOpenedAt: minutes(-5), accuracyM: 12 },
  similarity: "unique",
};
/** Imported with EXIF from earlier the same day. */
const imported: PhotoEvidenceInput = {
  ...base,
  capturedAt: new Date("2026-11-10T08:00:00Z"),
  capture: { method: "imported" },
};

describe("verifyPhotoEvidence", () => {
  it("verifies an in-app photo taken inside the geofence during the capture", () => {
    expect(verifyPhotoEvidence(base)).toEqual({
      captureMethod: "in_app",
      location: "inside",
      distanceM: null,
      time: "ok",
      similarity: "unique",
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

  it("never verifies an imported file, though its EXIF is still checked for review", () => {
    expect(verifyPhotoEvidence(imported)).toEqual({
      captureMethod: "imported",
      location: "inside",
      distanceM: null,
      time: "ok",
      similarity: "unique",
      verified: false,
    });
  });

  it("does not verify a picture that matches an earlier photo", () => {
    expect(verifyPhotoEvidence({ ...base, similarity: "similar" })).toMatchObject({
      similarity: "similar",
      verified: false,
    });
    expect(verifyPhotoEvidence({ ...base, similarity: "not_checked" }).verified).toBe(false);
  });

  it("does not place an in-app photo with a missing or coarse position accuracy", () => {
    const accuracy = (accuracyM: number | null) =>
      verifyPhotoEvidence({
        ...base,
        capture: { method: "in_app", cameraOpenedAt: minutes(-5), accuracyM },
      });
    expect(accuracy(50)).toMatchObject({ location: "inside", verified: true });
    expect(accuracy(51)).toMatchObject({ location: "low_accuracy", verified: false });
    expect(accuracy(null)).toMatchObject({ location: "low_accuracy", verified: false });
    expect(accuracy(Number.NaN).location).toBe("low_accuracy");
    // Accuracy matters only with a position.
    expect(verifyPhotoEvidence({ ...base, location: null }).location).toBe("missing");
  });

  it("bounds an in-app capture between the camera opening and the upload", () => {
    const check = (capturedAt: Date, opened = minutes(-5), extra = {}) =>
      verifyPhotoEvidence({
        ...base,
        capturedAt,
        capture: { method: "in_app", cameraOpenedAt: opened, accuracyM: 12 },
        ...extra,
      }).time;
    expect(check(minutes(-15))).toBe("ok");
    expect(check(minutes(-16))).toBe("outside_window");
    expect(check(minutes(10))).toBe("ok");
    expect(check(minutes(11))).toBe("future");
    expect(check(minutes(-29), minutes(-30))).toBe("ok");
    expect(check(minutes(-29), minutes(-31))).toBe("stale");
    // 12:00 UTC is 15:00 in Nairobi on the 10th.
    expect(check(minutes(-3), minutes(-5), { diaryDate: "2026-11-10" })).toBe("ok");
    expect(check(minutes(-3), minutes(-5), { diaryDate: "2026-11-09" })).toBe("diary_mismatch");
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

  it("checks an imported photo's EXIF time against the upload time and the diary date", () => {
    const check = (capturedAt: Date | null, extra = {}) =>
      verifyPhotoEvidence({ ...imported, capturedAt, ...extra }).time;
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

describe("differenceHash and hammingDistance", () => {
  const grid = (pixel: (row: number, column: number) => number) =>
    Array.from({ length: 72 }, (_, index) => pixel(Math.floor(index / 9), index % 9));

  it("sets a bit where a pixel is brighter than its right-hand neighbour", () => {
    expect(differenceHash(grid(() => 128))).toBe(0n);
    expect(differenceHash(grid((_, column) => 255 - column))).toBe(2n ** 64n - 1n);
    // Only the first pixel of the first row is brighter: the most significant bit.
    expect(differenceHash(grid((row, column) => (row === 0 && column === 0 ? 9 : 0)))).toBe(
      2n ** 63n,
    );
    expect(() => differenceHash(Array.from({ length: 64 }, () => 0))).toThrow(RangeError);
  });

  it("counts differing bits, including for signed 64-bit values from the database", () => {
    expect(hammingDistance(0n, 0n)).toBe(0);
    expect(hammingDistance(0n, 2n ** 64n - 1n)).toBe(64);
    expect(hammingDistance(0b1011n, 0b0010n)).toBe(2);
    expect(hammingDistance(BigInt.asIntN(64, 2n ** 63n), 2n ** 63n)).toBe(0);
    expect(hammingDistance(-1n, 0n)).toBe(64);
  });
});

describe("sniffPhotoType", () => {
  const ftyp = (major: string, ...compatible: string[]) => {
    const size = 16 + compatible.length * 4;
    const bytes = new Uint8Array(size + 8);
    new DataView(bytes.buffer).setUint32(0, size);
    bytes.set(
      Uint8Array.from(`ftyp${major}\0\0\0\0${compatible.join("")}`, (character) =>
        character.charCodeAt(0),
      ),
      4,
    );
    return bytes;
  };

  it("recognises JPEG and HEVC-coded HEIF by signature", () => {
    expect(sniffPhotoType(new Uint8Array([0xff, 0xd8, 0xff, 0xe1]))).toBe("image/jpeg");
    expect(sniffPhotoType(ftyp("heic", "mif1", "heic"))).toBe("image/heic");
    expect(sniffPhotoType(ftyp("mif1", "mif1", "heic"))).toBe("image/heic");
    expect(sniffPhotoType(ftyp("heix"))).toBe("image/heic");
  });

  it("refuses other formats and malformed boxes", () => {
    expect(sniffPhotoType(ftyp("avif", "mif1", "avif"))).toBeNull();
    expect(
      sniffPhotoType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    ).toBeNull();
    expect(sniffPhotoType(ftyp("heic").subarray(0, 12))).toBeNull();
    const oversized = ftyp("heic");
    new DataView(oversized.buffer).setUint32(0, 9_999);
    expect(sniffPhotoType(oversized)).toBeNull();
    expect(sniffPhotoType(new Uint8Array())).toBeNull();
  });
});
