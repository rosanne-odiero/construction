import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeHeic } from "./heic-decoder.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../../../test/fixtures/photos/${name}`, import.meta.url));

/** Offsets of the boxes on the path meta → iprp → ipco, by scanning for their type codes. */
const offsetOf = (file: Buffer, type: string) => file.indexOf(type) - 4;

/** The file with one more image-size property (`ispe`) appended to `ipco`, sizes fixed up. */
function withExtraSize(file: Buffer, width: number, height: number) {
  const ispe = Buffer.alloc(20);
  ispe.writeUInt32BE(20, 0);
  ispe.write("ispe", 4, "latin1");
  ispe.writeUInt32BE(width, 12);
  ispe.writeUInt32BE(height, 16);
  const ipco = offsetOf(file, "ipco");
  const end = ipco + file.readUInt32BE(ipco);
  const grown = Buffer.concat([file.subarray(0, end), ispe, file.subarray(end)]);
  for (const type of ["meta", "iprp", "ipco"]) {
    const at = offsetOf(grown, type);
    grown.writeUInt32BE(grown.readUInt32BE(at) + ispe.length, at);
  }
  return grown;
}

describe("decodeHeic", () => {
  it("decodes an iPhone HEIC to upright RGBA pixels", async () => {
    const decoded = await decodeHeic(fixture("iphone.heic"));
    expect(decoded.ok && [decoded.width, decoded.height, decoded.rgba.length]).toEqual([
      160,
      120,
      160 * 120 * 4,
    ]);
  });

  it("checks every declared image size before decoding, not only the main image's", async () => {
    // A small main image with a huge hidden item (an alpha layer, tile or overlay) declared.
    expect(await decodeHeic(withExtraSize(fixture("iphone.heic"), 16_000, 16_000))).toEqual({
      ok: false,
      failure: "heic-too-large",
    });
    // A small extra size passes the check (the insertion shifts the image data, so libheif
    // then cannot read it).
    expect(await decodeHeic(withExtraSize(fixture("iphone.heic"), 100, 100))).toEqual({
      ok: false,
      failure: "heic-unreadable",
    });
    expect(await decodeHeic(fixture("iphone.heic"), 160 * 120 - 1)).toEqual({
      ok: false,
      failure: "heic-too-large",
    });
  });

  it("refuses images with an alpha layer and malformed files", async () => {
    const unreadable = { ok: false, failure: "heic-unreadable" };
    expect(await decodeHeic(fixture("alpha.heic"))).toEqual(unreadable);
    const heic = fixture("iphone.heic");
    expect(await decodeHeic(heic.subarray(0, 600))).toEqual(unreadable);
    const broken = Buffer.from(heic);
    broken.writeUInt32BE(0xffff_fff0, offsetOf(broken, "ipco"));
    expect(await decodeHeic(broken)).toEqual(unreadable);
    expect(await decodeHeic(Buffer.from("not a heic file at all"))).toEqual(unreadable);
  });
});
