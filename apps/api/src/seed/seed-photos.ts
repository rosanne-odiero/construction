import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { photoUploadFieldsSchema } from "@pm-buddy/validation";
import sharp from "sharp";
import type { Principal } from "../modules/identity/auth.service.js";
import type { PhotosService } from "../modules/progress/photos.service.js";

/**
 * A small synthetic JPEG of random coloured blocks: every one has its own difference hash, so demo
 * photos never look like reused pictures of each other (D6.1 near-duplicate check).
 */
export const patternedJpeg = (width = 96, height = 72) =>
  sharp(randomBytes(8 * 6 * 3), { raw: { width: 8, height: 6, channels: 3 } })
    .resize(width, height, { kernel: "nearest" })
    .jpeg()
    .toBuffer();

/**
 * Takes a demo photo the way PM-Buddy's camera screen does: opens a capture for the site, then
 * uploads with the phone's clock and a GPS position (8 m accuracy), so the server can verify it.
 */
export async function captureInApp(
  photos: PhotosService,
  principal: Principal,
  req: Request,
  photo: { projectId: string; siteId: string; at: readonly [number, number]; caption: string },
) {
  const { ticket } = await photos.openCapture(principal, photo.projectId, photo.siteId, req);
  return photos.upload(
    principal,
    photo.projectId,
    { buffer: await patternedJpeg(), originalname: "capture.jpg", size: 1 },
    photoUploadFieldsSchema.parse({
      siteId: photo.siteId,
      caption: photo.caption,
      captureTicketId: ticket.id,
      capturedAt: new Date().toISOString(),
      latitude: photo.at[0].toFixed(6),
      longitude: photo.at[1].toFixed(6),
      accuracyM: "8",
    }),
    req,
  );
}
