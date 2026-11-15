/**
 * Sandboxed HEIC decoder (D6.1). The prebuilt libvips in sharp has no HEVC decoder, so iPhone HEIC
 * photos are decoded here with libheif compiled to WebAssembly (libheif-js), in a worker thread
 * with a time limit set by the parent (heic-decoder.ts). The worker's heap cap does not cover
 * WebAssembly memory, and this libheif build has its own size limits switched off, so the sizes
 * are checked here before any pixels are decoded: every image item the file declares (main image,
 * alpha layer, grid tiles, overlays) must be within the pixel limit, and images with an alpha
 * layer are refused (camera photos have none). libheif applies the file's rotation and mirroring,
 * so the RGBA pixels returned are upright.
 *
 * Keep this file self-contained (no relative imports) and limited to erasable TypeScript syntax:
 * the e2e tests run it directly from source with Node's type stripping.
 */
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

type HeifImage = {
  is_primary(): boolean;
  has_alpha_channel(): boolean;
  get_width(): number;
  get_height(): number;
  display(
    target: { data: Uint8ClampedArray; width: number; height: number },
    done: (result: { data: Uint8ClampedArray } | null) => void,
  ): void;
  free(): void;
};
type LibHeif = { HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[] } };
type Input = { data: Uint8Array; maxPixels: number };
type Failure = "heic-unreadable" | "heic-too-large";
type Result =
  { ok: true; width: number; height: number; rgba: Uint8Array } | { ok: false; failure: Failure };

const { data, maxPixels } = workerData as Input;
const libheif = createRequire(import.meta.url)("libheif-js/wasm-bundle.js") as LibHeif;

const MAX_BOXES = 20_000;
const fourcc = (at: number) => String.fromCharCode(...data.subarray(at, at + 4));

/** The boxes in [start, end) of an ISO-BMFF file: type and content range; null when malformed. */
function boxes(start: number, end: number) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const found: { type: string; body: number; end: number }[] = [];
  for (let at = start; at < end;) {
    if (at + 8 > end || found.length >= MAX_BOXES) return null;
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return null;
      const large = view.getBigUint64(at + 8);
      if (large > BigInt(end - at)) return null;
      size = Number(large);
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) return null;
    found.push({ type: fourcc(at + 4), body: at + header, end: at + size });
    at += size;
  }
  return found;
}

/**
 * Every image size (`ispe`) the file declares, from meta → iprp → ipco; null when the structure
 * is malformed. Each image item carries one, including alpha layers, tiles and overlays.
 */
function declaredSizes(): { width: number; height: number }[] | null {
  const top = boxes(0, data.length);
  const meta = top?.find((box) => box.type === "meta");
  // `meta` is a full box: version and flags come first.
  const iprp = meta && boxes(meta.body + 4, meta.end)?.find((box) => box.type === "iprp");
  const ipco = iprp && boxes(iprp.body, iprp.end)?.find((box) => box.type === "ipco");
  const properties = ipco && boxes(ipco.body, ipco.end);
  if (!properties) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sizes = [];
  for (const box of properties.filter((property) => property.type === "ispe")) {
    if (box.body + 12 > box.end) return null;
    sizes.push({ width: view.getUint32(box.body + 4), height: view.getUint32(box.body + 8) });
  }
  return sizes;
}

async function decode(): Promise<Result> {
  const sizes = declaredSizes();
  if (!sizes?.length) return { ok: false, failure: "heic-unreadable" };
  if (sizes.some(({ width, height }) => width * height > maxPixels))
    return { ok: false, failure: "heic-too-large" };
  const images = new libheif.HeifDecoder().decode(data);
  try {
    const image = images.find((candidate) => candidate.is_primary()) ?? images[0];
    if (!image || image.has_alpha_channel()) return { ok: false, failure: "heic-unreadable" };
    const width = image.get_width();
    const height = image.get_height();
    if (!(width > 0 && height > 0)) return { ok: false, failure: "heic-unreadable" };
    if (width * height > maxPixels) return { ok: false, failure: "heic-too-large" };
    const pixels = await new Promise<Uint8ClampedArray | null>((resolve) =>
      image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (result) =>
        resolve(result?.data ?? null),
      ),
    );
    if (!pixels) return { ok: false, failure: "heic-unreadable" };
    return { ok: true, width, height, rgba: new Uint8Array(pixels.buffer) };
  } finally {
    for (const image of images) image.free();
  }
}

const result = await decode().catch((): Result => ({ ok: false, failure: "heic-unreadable" }));
parentPort?.postMessage(result, result.ok ? [result.rgba.buffer as ArrayBuffer] : []);
