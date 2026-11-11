import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { PHOTO_LIMITS, verifyPhotoEvidence } from "@pm-buddy/domain";
import {
  sitePhotoResponseSchema,
  sitePhotoSchema,
  sitePhotosResponseSchema,
  type PhotoUploadFields,
  type SitePhoto,
} from "@pm-buddy/validation";
import type { Request } from "express";
import sharp from "sharp";
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
import { readPhotoMetadata } from "./photo-metadata.js";

type PhotoRow = Prisma.SitePhotoGetPayload<object>;
export type UploadedPhoto = { buffer: Buffer; originalname: string; size: number };
/** Photos are staff evidence (site diary readers plus photographers). */
const PHOTO_READERS = [
  "site.photos",
  "site.diary",
  "quality.manage",
  "projects.manage",
  "reports.view",
] as const;
const photoKeys = (tenantId: string, projectId: string, id: string) => {
  const base = `tenants/${tenantId}/projects/${projectId}/photos/${id}`;
  return { original: `${base}/original.jpg`, thumbnail: `${base}/thumbnail.jpg` };
};
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
    capturedAt: row.capturedAt?.toISOString() ?? null,
    timeSource: row.timeSource,
    location:
      row.latitude === null || row.longitude === null
        ? null
        : { lat: decimal(row.latitude), lng: decimal(row.longitude) },
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
    },
    verified: row.verified,
    scanStatus: row.scanStatus,
    uploadedBy: { id: row.uploadedBy, displayName: names.get(row.uploadedBy) ?? "—" },
    uploadedAt: row.uploadedAt.toISOString(),
  });

/**
 * Geotagged site photos (D6.1). The server never trusts a client-supplied position or time: it
 * reads the photo's own EXIF and checks it against the site geofence version in force at capture
 * (packages/domain verifyPhotoEvidence). Rows are append-only evidence; originals and
 * metadata-free thumbnails are private objects.
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

  async upload(
    principal: Principal,
    projectId: string,
    file: UploadedPhoto | undefined,
    fields: PhotoUploadFields,
    req: Request,
  ) {
    if (!file?.buffer?.length)
      throw problem(BadRequestException, "file-required", "Attach a JPEG photo as `file`");
    await this.scope.run(principal, req, (scope) => this.writable(scope, projectId));
    const { buffer } = file;
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff)
      throw problem(
        UnsupportedMediaTypeException,
        "unsupported-file-type",
        "Photos must be JPEG images",
      );
    const decoder = () =>
      sharp(buffer, { limitInputPixels: PHOTO_LIMITS.maxPixels, failOn: "error" });
    let width: number;
    let height: number;
    let thumbnail: Buffer;
    let exif: Buffer | undefined;
    try {
      const meta = await decoder().metadata();
      if (meta.format !== "jpeg" || !meta.width || !meta.height)
        throw new Error("Not a JPEG image");
      ({ width, height, exif } = meta);
      // A fresh, small JPEG without metadata (rotated upright); the original is kept as uploaded.
      thumbnail = await decoder()
        .rotate()
        .resize({
          width: PHOTO_LIMITS.thumbnailEdgePx,
          height: PHOTO_LIMITS.thumbnailEdgePx,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 78, mozjpeg: true })
        .toBuffer();
    } catch (error) {
      this.logger.warn(`Photo refused: ${describeError(error)}`);
      throw problem(
        UnprocessableEntityException,
        "invalid-image",
        "The photo could not be read as a JPEG image (or is too large to decode)",
      );
    }
    const metadata = readPhotoMetadata(exif);
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
    const keys = photoKeys(principal.session.activeTenantId!, projectId, id);
    await this.storage.put(keys.original, buffer, "image/jpeg", sha256);
    await this.storage.put(keys.thumbnail, thumbnail, "image/jpeg");
    try {
      return await this.scope.run(
        principal,
        req,
        async (scope) => {
          await this.writable(scope, projectId);
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
          const uploadedAt = new Date();
          const evidence = verifyPhotoEvidence({
            location: metadata.location,
            capturedAt: metadata.capturedAt,
            uploadedAt,
            geofence: fence ? toGeofenceVersion(fence).geofence : null,
            diaryDate,
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
              camera: metadata.camera,
              geofenceVersion: checkedAgainst,
              locationCheck: evidence.location,
              timeCheck: evidence.time,
              distanceM: evidence.distanceM,
              verified: evidence.verified,
              uploadedBy: userId,
              uploadedAt,
            },
          });
          // Safe summary only: no coordinates, file names or captions.
          await this.scope.audit(scope.tx, "photo.uploaded", id, {
            projectId,
            siteId: site.id,
            diaryId: fields.diaryId ?? null,
            verified: evidence.verified,
            location: evidence.location,
            time: evidence.time,
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
          ...(query.siteId ? { siteId: query.siteId } : {}),
          ...(query.diaryId ? { diaryId: query.diaryId } : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
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

  /** The original upload or its thumbnail, after the same access check as the list. */
  async content(
    principal: Principal,
    projectId: string,
    photoId: string,
    variant: "original" | "thumbnail",
    req: Request,
  ): Promise<Buffer> {
    const key = await this.scope.run(principal, req, async (scope) => {
      await this.readable(scope, projectId);
      const row = await scope.tx.sitePhoto.findFirst({
        where: { tenantId: scope.access.tenantId, projectId, id: photoId },
        select: { objectKey: true, thumbnailKey: true },
      });
      if (!row) throw new NotFoundException("Photo not found");
      return variant === "original" ? row.objectKey : row.thumbnailKey;
    });
    return this.storage.get(key, PHOTO_LIMITS.maxFileBytes);
  }

  private async writable(scope: Scope, projectId: string) {
    const { project } = await this.access.load(scope, projectId, "site.photos");
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
