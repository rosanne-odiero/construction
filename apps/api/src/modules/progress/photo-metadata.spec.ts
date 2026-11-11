import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { jpegWithExif, plainJpeg } from "../../../test/photo-fixtures.js";
import { readPhotoMetadata } from "./photo-metadata.js";

const exifOf = async (buffer: Buffer) => (await sharp(buffer).metadata()).exif;
const read = async (spec: Parameters<typeof jpegWithExif>[0]) =>
  readPhotoMetadata(await exifOf(await jpegWithExif(spec)));

describe("readPhotoMetadata", () => {
  it("reads position, camera and the capture time with its own offset", async () => {
    const meta = await read({
      lat: -1.148912,
      lng: 36.961234,
      original: "2026:11:10 09:15:30",
      offset: "+03:00",
      gpsDate: "2026:11:10",
      gpsTime: [6, 0, 0],
      make: "TestCam",
      model: "TestCam Field 1",
    });
    expect(meta.location!.lat).toBeCloseTo(-1.148912, 5);
    expect(meta.location!.lng).toBeCloseTo(36.961234, 5);
    expect(meta.capturedAt?.toISOString()).toBe("2026-11-10T06:15:30.000Z");
    expect(meta.timeSource).toBe("offset");
    expect(meta.camera).toBe("TestCam Field 1");
  });

  it("falls back to the GPS clock, then to the camera time assumed to be Nairobi", async () => {
    const gps = await read({
      original: "2026:11:10 09:15:30",
      gpsDate: "2026:11:10",
      gpsTime: [6, 15, 0],
    });
    expect(gps).toMatchObject({ timeSource: "gps" });
    expect(gps.capturedAt?.toISOString()).toBe("2026-11-10T06:15:00.000Z");
    const assumed = await read({ original: "2026:11:10 09:15:30", make: "A", model: "B" });
    expect(assumed).toMatchObject({ timeSource: "assumed_nairobi", camera: "A B", location: null });
    expect(assumed.capturedAt?.toISOString()).toBe("2026-11-10T06:15:30.000Z");
    const west = await read({ original: "2026:11:10 09:15:30", offset: "-05:30" });
    expect(west.capturedAt?.toISOString()).toBe("2026-11-10T14:45:30.000Z");
  });

  it("treats missing, malformed or implausible metadata as absent", async () => {
    expect(readPhotoMetadata(await exifOf(await plainJpeg()))).toEqual({
      location: null,
      capturedAt: null,
      timeSource: null,
      camera: null,
    });
    expect(readPhotoMetadata(undefined).location).toBeNull();
    expect(readPhotoMetadata(Buffer.from("not exif at all")).capturedAt).toBeNull();
    expect((await read({ lat: 0, lng: 0 })).location).toBeNull();
    expect(
      (await read({ original: "1980:01:01 00:00:00", offset: "+03:00" })).capturedAt,
    ).toBeNull();
    expect((await read({ gpsDate: "2026:11:10", gpsTime: [25, 0, 0] })).capturedAt).toBeNull();
    expect((await read({ lat: 89.9, lng: 179.9 })).location).toEqual({ lat: 89.9, lng: 179.9 });
  });
});
