import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import {
  differenceHash,
  nairobiDate,
  PHOTO_LIMITS,
  PHOTO_VERIFICATION_DEFAULTS,
  sniffPhotoType,
  verifyPhotoEvidence,
  type PhotoCapture,
  type PhotoContentType,
  type PhotoPurpose,
} from "@pm-buddy/domain";
import {
  SAFETY_READ_PERMISSIONS,
  SAFETY_RECORD_PERMISSIONS,
  type Permission,
} from "@pm-buddy/types";
import {
  photoCaptureTicketResponseSchema,
  sitePhotoResponseSchema,
  sitePhotoSchema,
  sitePhotosResponseSchema,
  type PhotoUploadFields,
  type SitePhoto,
} from "@pm-buddy/validation";
import type { Request } from "express";
import sharp, { type Sharp } from "sharp";
import { isUniqueViolation } from "../../common/database-errors.js";
import { describeError } from "../../common/errors.js";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { MalwareDetected, MalwareScanner } from "../../infra/malware-scanner.js";
import { StorageService } from "../../infra/storage.service.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { ProjectAccess } from "../projects/project-access.js";
import { toCalendarDate, toGeofenceVersion } from "../projects/project-mappers.js";
import { decodeHeic } from "./heic-decoder.js";
import { readPhotoMetadata, type PhotoMetadata } from "./photo-metadata.js";

/** The similar photo's purpose decides whether its ID may be shown (incident photos stay hidden). */
const withSimilar = { similarPhoto: { select: { purpose: true } } } as const;
type PhotoRow = Prisma.SitePhotoGetPayload<{ include: typeof withSimilar }>;
type DecodedPhoto = {
  width: number;
  height: number;
  exif: Buffer | undefined;
  thumbnail: Buffer;
  /** Signed 64-bit, as PostgreSQL stores BIGINT. */
  perceptualHash: bigint;
};
export type UploadedPhoto = { buffer: Buffer; originalname: string; size: number };
/** Photos are staff evidence (site diary readers plus photographers). */
const PHOTO_READERS = [
  "site.photos",
  "site.diary",
  "quality.manage",
  "projects.manage",
  "reports.view",
] as const;
const extension = (type: PhotoContentType) => (type === "image/heic" ? "heic" : "jpg");
const photoKeys = (tenantId: string, projectId: string, id: string, type: PhotoContentType) => {
  const base = `tenants/${tenantId}/projects/${projectId}/photos/${id}`;
  return { original: `${base}/original.${extension(type)}`, thumbnail: `${base}/thumbnail.jpg` };
};
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const decimal = (value: Prisma.Decimal | null) => (value === null ? null : value.toNumber());
const problem = (Exception: new (body: object) => HttpException, code: string, message: string) =>
  new Exception({ code, message });

const toPhoto = (row: PhotoRow, names: ReadonlyMap<string, string>): SitePhoto =>
  sitePhotoSchema.parse({
    id: row.id,
    projectId: row.projectId,
    siteId: row.siteId,
    diaryId: row.diaryId,
    caption: row.caption,
    contentType: row.contentType,
    captureMethod: row.captureMethod,
    capturedAt: row.capturedAt?.toISOString() ?? null,
    timeSource: row.timeSource,
    location:
      row.latitude === null || row.longitude === null
        ? null
        : {
            lat: decimal(row.latitude),
            lng: decimal(row.longitude),
            accuracyM: decimal(row.locationAccuracyM),
          },
    camera: row.camera,
    width: row.width,
    height: row.height,
    sizeBytes: row.sizeBytes,
    sha256: row.fileSha256,
    geofenceVersion: row.geofenceVersion,
    checks: {
      location: row.locationCheck,
      time: row.timeCheck,
      distanceM: decimal(row.distanceM),
      similarity: row.similarityCheck,
      similarTo:
        row.similarPhotoId === null
          ? null
          : {
              photoId:
                row.similarProjectId === row.projectId && row.similarPhoto?.purpose === "general"
                  ? row.similarPhotoId
                  : null,
              otherProject: row.similarProjectId !== row.projectId,
              distance: row.similarityDistance,
            },
    },
    verified: row.verified,
    scanStatus: row.scanStatus,
    uploadedBy: { id: row.uploadedBy, displayName: names.get(row.uploadedBy) ?? "—" },
    uploadedAt: row.uploadedAt.toISOString(),
  });

/**
 * Geotagged site photos (D6.1, THREAT_MODEL A-13). An in-app capture opens a server ticket when
 * the camera screen opens, so its time is bounded by the server clock; its position is the
 * browser's, with an accuracy radius. An imported file (JPEG or HEIC) is checked on its own EXIF
 * but never verified. Every photo gets a difference hash, and one that looks like an earlier photo
 * of the company from another day or project is not verified (packages/domain
 * verifyPhotoEvidence). Rows are append-only evidence; originals and metadata-free JPEG thumbnails
 * are private objects.
 */
@Injectable()
export class PhotosService {
  private readonly logger = new Logger(PhotosService.name);

  constructor(
    private readonly scope: TenantScope,
    private readonly access: ProjectAccess,
    private readonly policy: AccessPolicy,
    private readonly storage: StorageService,
    private readonly scanner: MalwareScanner,
  ) {}

  /** Opens an in-app capture for a site: the ticket records the server time the camera opened. */
  openCapture(principal: Principal, projectId: string, siteId: string, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.writable(scope, projectId, "general");
        const { tenantId, userId } = scope.access;
        const site = await scope.tx.site.findFirst({
          where: { tenantId, projectId, id: siteId },
          select: { id: true },
        });
        if (!site) throw new NotFoundException("Site not found in this project");
        // The trigger sets issued_at to the database's time, whatever is sent.
        const ticket = await scope.tx.photoCaptureTicket.create({
          data: { id: uuidv7(), tenantId, projectId, siteId: site.id, issuedTo: userId },
        });
        const window = PHOTO_VERIFICATION_DEFAULTS.captureWindowMinutes * 60_000;
        return photoCaptureTicketResponseSchema.parse({
          ticket: {
            id: ticket.id,
            siteId: ticket.siteId,
            issuedAt: ticket.issuedAt.toISOString(),
            useBy: new Date(ticket.issuedAt.getTime() + window).toISOString(),
          },
        });
      },
      true,
    );
  }

  async upload(
    principal: Principal,
    projectId: string,
    file: UploadedPhoto | undefined,
    fields: PhotoUploadFields,
    req: Request,
  ) {
    if (!file?.buffer?.length)
      throw problem(BadRequestException, "file-required", "Attach a JPEG or HEIC photo as `file`");
    const purpose: PhotoPurpose = fields.purpose ?? "general";
    await this.scope.run(principal, req, (scope) => this.writable(scope, projectId, purpose));
    const { buffer } = file;
    const contentType = sniffPhotoType(buffer);
    if (!contentType)
      throw problem(
        UnsupportedMediaTypeException,
        "unsupported-file-type",
        "Photos must be JPEG or HEIC images",
      );
    const { width, height, exif, thumbnail, perceptualHash } = await this.decode(
      buffer,
      contentType,
    );
    const inApp = fields.captureTicketId !== undefined;
    const metadata: PhotoMetadata = inApp
      ? {
          // The browser's position and the phone's clock at the shutter; a 0,0 fix is no fix.
          location:
            fields.latitude !== undefined &&
            fields.longitude !== undefined &&
            !(fields.latitude === 0 && fields.longitude === 0)
              ? { lat: round6(fields.latitude), lng: round6(fields.longitude) }
              : null,
          capturedAt: fields.capturedAt ? new Date(fields.capturedAt) : null,
          timeSource: fields.capturedAt ? "device" : null,
          camera: null,
        }
      : readPhotoMetadata(exif);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    let scan;
    try {
      scan = await this.scanner.scan(buffer, { sha256 });
    } catch (error) {
      if (error instanceof MalwareDetected)
        throw problem(
          UnprocessableEntityException,
          "malware-detected",
          "The photo was refused by the malware scanner",
        );
      throw error;
    }

    const id = uuidv7();
    const keys = photoKeys(principal.session.activeTenantId!, projectId, id, contentType);
    await this.storage.put(keys.original, buffer, contentType, sha256);
    await this.storage.put(keys.thumbnail, thumbnail, "image/jpeg");
    try {
      return await this.scope.run(
        principal,
        req,
        async (scope) => {
          await this.writable(scope, projectId, purpose);
          const { tenantId, userId } = scope.access;
          const site = await scope.tx.site.findFirst({
            where: { tenantId, projectId, id: fields.siteId },
            select: { id: true },
          });
          if (!site) throw new NotFoundException("Site not found in this project");
          let diaryDate: string | null = null;
          if (fields.diaryId) {
            const diary = await scope.tx.siteDiary.findFirst({
              where: { tenantId, projectId, siteId: site.id, id: fields.diaryId },
              select: { status: true, date: true },
            });
            if (!diary) throw new NotFoundException("Diary not found for this site");
            if (diary.status !== "draft")
              throw problem(
                ConflictException,
                "diary-not-draft",
                "Photos can be attached only to a draft diary",
              );
            diaryDate = toCalendarDate(diary.date);
          }
          // The geofence in force when the photo was taken (or the current one, without a time).
          const fence =
            (await scope.tx.siteGeofence.findFirst({
              where: {
                tenantId,
                siteId: site.id,
                ...(metadata.capturedAt ? { effectiveFrom: { lte: metadata.capturedAt } } : {}),
              },
              orderBy: { effectiveFrom: "desc" },
            })) ??
            (await scope.tx.siteGeofence.findFirst({
              where: { tenantId, siteId: site.id },
              orderBy: { effectiveFrom: "asc" },
            }));
          let capture: PhotoCapture = { method: "imported" };
          if (fields.captureTicketId) {
            const ticket = await scope.tx.photoCaptureTicket.findFirst({
              where: {
                tenantId,
                projectId,
                siteId: site.id,
                id: fields.captureTicketId,
                issuedTo: userId,
              },
              select: { id: true, issuedAt: true },
            });
            if (!ticket)
              throw problem(
                UnprocessableEntityException,
                "capture-ticket-invalid",
                "This capture was not opened by you for this site",
              );
            // Writes are serialised per company (the tenant row lock), so this check is exact.
            const used = await scope.tx.sitePhoto.findFirst({
              where: { tenantId, captureTicketId: ticket.id },
              select: { id: true },
            });
            if (used)
              throw problem(
                ConflictException,
                "capture-ticket-used",
                "This capture has already been uploaded; open the camera again",
              );
            capture = {
              method: "in_app",
              cameraOpenedAt: ticket.issuedAt,
              accuracyM: fields.accuracyM ?? null,
            };
          }
          const uploadedAt = new Date();
          const similar = await this.similarPhoto(
            scope,
            projectId,
            perceptualHash,
            nairobiDate(uploadedAt),
          );
          const evidence = verifyPhotoEvidence({
            location: metadata.location,
            capturedAt: metadata.capturedAt,
            uploadedAt,
            geofence: fence ? toGeofenceVersion(fence).geofence : null,
            diaryDate,
            capture,
            similarity: similar ? "similar" : "unique",
          });
          const checkedAgainst =
            evidence.location === "inside" || evidence.location === "outside"
              ? fence!.version
              : null;
          const row = await scope.tx.sitePhoto.create({
            data: {
              id,
              tenantId,
              projectId,
              siteId: site.id,
              diaryId: fields.diaryId ?? null,
              caption: fields.caption ?? null,
              purpose,
              contentType,
              captureMethod: evidence.captureMethod,
              captureTicketId: fields.captureTicketId ?? null,
              objectKey: keys.original,
              thumbnailKey: keys.thumbnail,
              fileSha256: sha256,
              sizeBytes: buffer.length,
              width,
              height,
              scanStatus: scan.status,
              scanEngine: scan.engine,
              scannedAt: scan.scannedAt,
              capturedAt: metadata.capturedAt,
              timeSource: metadata.timeSource,
              latitude: metadata.location?.lat ?? null,
              longitude: metadata.location?.lng ?? null,
              locationAccuracyM:
                capture.method === "in_app" && metadata.location ? capture.accuracyM : null,
              camera: metadata.camera,
              geofenceVersion: checkedAgainst,
              locationCheck: evidence.location,
              timeCheck: evidence.time,
              distanceM: evidence.distanceM,
              perceptualHash,
              similarityCheck: evidence.similarity,
              similarPhotoId: similar?.id ?? null,
              similarProjectId: similar?.projectId ?? null,
              similarityDistance: similar?.distance ?? null,
              verified: evidence.verified,
              uploadedBy: userId,
              uploadedAt,
            },
            include: withSimilar,
          });
          // Safe summary only: no coordinates, file names or captions.
          await this.scope.audit(scope.tx, "photo.uploaded", id, {
            projectId,
            siteId: site.id,
            diaryId: fields.diaryId ?? null,
            verified: evidence.verified,
            captureMethod: evidence.captureMethod,
            location: evidence.location,
            time: evidence.time,
            similarity: evidence.similarity,
          });
          const names = await this.names(scope, [userId]);
          return sitePhotoResponseSchema.parse({ photo: toPhoto(row, names) });
        },
        true,
      );
    } catch (error) {
      await Promise.allSettled([
        this.storage.delete(keys.original),
        this.storage.delete(keys.thumbnail),
      ]);
      if (isUniqueViolation(error))
        throw problem(
          ConflictException,
          "photo-duplicate",
          "This photo has already been uploaded to the project",
        );
      throw error;
    }
  }

  list(
    principal: Principal,
    projectId: string,
    query: { siteId?: string; diaryId?: string; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      await this.readable(scope, projectId);
      const rows = await scope.tx.sitePhoto.findMany({
        where: {
          tenantId: scope.access.tenantId,
          projectId,
          // Incident photos are shown with their incident only.
          purpose: "general",
          ...(query.siteId ? { siteId: query.siteId } : {}),
          ...(query.diaryId ? { diaryId: query.diaryId } : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        include: withSimilar,
        orderBy: { id: "desc" },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const names = await this.names(
        scope,
        page.map((row) => row.uploadedBy),
      );
      return sitePhotosResponseSchema.parse({
        photos: page.map((row) => toPhoto(row, names)),
        nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      });
    });
  }

  /**
   * The original upload or its thumbnail, after the same access check as the list; an incident
   * photo needs health and safety read access instead (D-74).
   */
  async content(
    principal: Principal,
    projectId: string,
    photoId: string,
    variant: "original" | "thumbnail",
    req: Request,
  ): Promise<{ content: Buffer; contentType: PhotoContentType }> {
    const stored = await this.scope.run(principal, req, async (scope) => {
      const { effective } = await this.access.load(scope, projectId, "projects.view");
      const row = await scope.tx.sitePhoto.findFirst({
        where: { tenantId: scope.access.tenantId, projectId, id: photoId },
        select: { objectKey: true, thumbnailKey: true, purpose: true, contentType: true },
      });
      const readers: readonly Permission[] =
        row?.purpose === "safety_incident" ? SAFETY_READ_PERMISSIONS : PHOTO_READERS;
      if (!readers.some((permission) => effective.has(permission)))
        throw new ForbiddenException(`One of these permissions is required: ${readers.join(", ")}`);
      if (!row) throw new NotFoundException("Photo not found");
      return variant === "original"
        ? { key: row.objectKey, contentType: row.contentType as PhotoContentType }
        : { key: row.thumbnailKey, contentType: "image/jpeg" as const };
    });
    return {
      content: await this.storage.get(stored.key, PHOTO_LIMITS.maxFileBytes),
      contentType: stored.contentType,
    };
  }

  /**
   * Reads the image (JPEG with sharp; HEIC through the WebAssembly decoder, since sharp's libvips
   * has no HEVC decoder), makes an upright metadata-free JPEG thumbnail and the difference hash.
   */
  private async decode(buffer: Buffer, contentType: PhotoContentType): Promise<DecodedPhoto> {
    const options = { limitInputPixels: PHOTO_LIMITS.maxPixels, failOn: "error" } as const;
    let refusal = "The photo could not be read as a JPEG or HEIC image (or is too large to decode)";
    try {
      const meta = await sharp(buffer, options).metadata();
      if (!meta.width || !meta.height) throw new Error("No image dimensions");
      if (meta.width * meta.height > PHOTO_LIMITS.maxPixels) throw new Error("Too many pixels");
      let width = meta.width;
      let height = meta.height;
      let upright: Sharp;
      if (contentType === "image/jpeg") {
        if (meta.format !== "jpeg") throw new Error("Not a JPEG image");
        upright = sharp(buffer, options).rotate();
      } else {
        if (meta.format !== "heif" || meta.compression !== "hevc")
          throw new Error("Not an HEVC-coded HEIF image");
        const decoded = await decodeHeic(buffer);
        if (!decoded.ok) {
          if (decoded.failure === "heic-busy")
            throw problem(
              ServiceUnavailableException,
              "photo-decoder-busy",
              "Too many HEIC photos are being processed; try again shortly",
            );
          throw new Error(decoded.failure);
        }
        ({ width, height } = decoded);
        upright = sharp(decoded.rgba, { raw: { width, height, channels: 4 } }).flatten({
          background: "#ffffff",
        });
      }
      // A fresh, small JPEG without metadata; the original is kept as uploaded.
      const thumbnail = await upright
        .resize({
          width: PHOTO_LIMITS.thumbnailEdgePx,
          height: PHOTO_LIMITS.thumbnailEdgePx,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 78, mozjpeg: true })
        .toBuffer();
      refusal = "The photo's preview could not be fingerprinted";
      const grey = await sharp(thumbnail)
        .greyscale()
        .resize(9, 8, { fit: "fill" })
        .raw()
        .toBuffer();
      return {
        width,
        height,
        exif: meta.exif,
        thumbnail,
        perceptualHash: BigInt.asIntN(64, differenceHash(grey)),
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.warn(`Photo refused: ${describeError(error)}`);
      throw problem(UnprocessableEntityException, "invalid-image", refusal);
    }
  }

  /**
   * The closest earlier photo of the company (row-level security limits the scan to it) whose
   * difference hash is within the threshold and that was uploaded to another project or on
   * another day (Africa/Nairobi): bursts of the same view on one day are normal on site.
   */
  private async similarPhoto(scope: Scope, projectId: string, hash: bigint, today: string) {
    const [match] = await scope.tx.$queryRaw<
      { id: string; project_id: string; distance: number }[]
    >`SELECT id, project_id, bit_count((perceptual_hash # ${hash}::bigint)::bit(64))::int AS distance
      FROM site_photos
      WHERE tenant_id = ${scope.access.tenantId}::uuid
        AND perceptual_hash IS NOT NULL
        AND (project_id <> ${projectId}::uuid
          OR (uploaded_at AT TIME ZONE 'Africa/Nairobi')::date <> ${today}::date)
        AND bit_count((perceptual_hash # ${hash}::bigint)::bit(64))
          <= ${PHOTO_VERIFICATION_DEFAULTS.similarityMaxDistance}
      ORDER BY distance, id
      LIMIT 1`;
    return match ? { id: match.id, projectId: match.project_id, distance: match.distance } : null;
  }

  private async writable(scope: Scope, projectId: string, purpose: PhotoPurpose) {
    const { project, effective } = await this.access.load(scope, projectId, "site.photos");
    if (
      purpose === "safety_incident" &&
      !SAFETY_RECORD_PERMISSIONS.some((permission) => effective.has(permission))
    )
      throw new ForbiddenException(
        `Incident photos need one of: ${SAFETY_RECORD_PERMISSIONS.join(", ")}`,
      );
    if (project.status === "closed" || project.status === "cancelled")
      throw problem(
        ConflictException,
        "project-read-only",
        "Closed and cancelled projects are read-only",
      );
  }

  private async readable(scope: Scope, projectId: string) {
    await this.access.load(scope, projectId, "projects.view");
    await this.policy.requireAny(scope, PHOTO_READERS, { projectId });
  }

  private async names(scope: Scope, ids: string[]) {
    const users = await scope.tx.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
