import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { PHOTO_LIMITS, PHOTO_VERIFICATION_DEFAULTS } from "@pm-buddy/domain";
import {
  photoCaptureTicketRequestSchema,
  photoCaptureTicketResponseSchema,
  photoUploadFieldsSchema,
  sitePhotoListQuerySchema,
  sitePhotoResponseSchema,
  sitePhotosResponseSchema,
} from "@pm-buddy/validation";
import type { Request, Response } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthSecurity } from "../identity/auth-security.service.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { PhotosService, type UploadedPhoto } from "./photos.service.js";

const readNote =
  "Requires projects.view plus site.photos, site.diary, quality.manage, projects.manage or reports.view on the project.";

/** Refuses oversized bodies before they are read, and limits uploads per user. */
@Injectable()
export class PhotoUploadGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly security: AuthSecurity,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (Number(req.headers["content-length"] ?? 0) > PHOTO_LIMITS.maxFileBytes + 64 * 1024)
      throw new PayloadTooLargeException({
        message: "Photos may be at most 15 MB",
        code: "payload-too-large",
      });
    const principal = await this.auth.principal(req);
    await this.security.limit(`photo-upload:${principal.user.id}`, 240, 3_600);
    return true;
  }
}

@ApiTags("progress")
@UseGuards(BrowserGuard)
@Controller({ path: "projects/:projectId/photos", version: "1" })
export class PhotosController {
  constructor(
    private readonly auth: AuthService,
    private readonly security: AuthSecurity,
    private readonly photos: PhotosService,
  ) {}

  @Post("capture-tickets")
  @ApiOperation({
    summary: "Open an in-app photo capture for a site (when the camera screen opens)",
    description: `Requires site.photos; closed and cancelled projects are read-only. The ticket records the server time; the photo uploaded with it is checked against that time (the shutter time may not be earlier, and the upload must come within ${PHOTO_VERIFICATION_DEFAULTS.captureWindowMinutes} minutes, \`useBy\`). Single use. 404 for a site outside the project.`,
    operationId: "openSitePhotoCapture",
  })
  @ApiBody({ schema: openApi(photoCaptureTicketRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(photoCaptureTicketResponseSchema) })
  async openCapture(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const principal = await this.auth.principal(req);
    await this.security.limit(`photo-capture:${principal.user.id}`, 600, 3_600);
    return this.photos.openCapture(
      principal,
      uuidSchema.parse(projectId),
      photoCaptureTicketRequestSchema.parse(body).siteId,
      req,
    );
  }

  @Get()
  @ApiOperation({
    summary: "Site photos with their verification, newest first",
    description: readNote,
    operationId: "listSitePhotos",
  })
  @ApiQuery({ name: "siteId", required: false })
  @ApiQuery({ name: "diaryId", required: false })
  @ApiQuery({ name: "cursor", required: false, description: "nextCursor from the preceding page" })
  @ApiQuery({ name: "limit", required: false, description: "1–60; defaults to 24" })
  @ApiOkResponse({ schema: openApi(sitePhotosResponseSchema) })
  async list(@Param("projectId") projectId: string, @Query() query: unknown, @Req() req: Request) {
    return this.photos.list(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      sitePhotoListQuerySchema.parse(query),
      req,
    );
  }

  @Post()
  @UseGuards(PhotoUploadGuard)
  @UseInterceptors(
    FileInterceptor("file", {
      limits: {
        fileSize: PHOTO_LIMITS.maxFileBytes,
        files: 1,
        fields: 9,
        parts: 10,
        fieldNameSize: 20,
        fieldSize: 2_000,
        headerPairs: 20,
      },
    }),
  )
  @ApiOperation({
    summary: "Upload a JPEG or HEIC site photo (at most 15 MB); the server checks its evidence",
    description: `Requires site.photos; closed and cancelled projects are read-only. **In-app capture** (PM-Buddy's camera screen): send \`captureTicketId\` from openSitePhotoCapture, \`capturedAt\` (the phone's clock at the shutter) and, when the browser gave a position, \`latitude\`, \`longitude\` and \`accuracyM\` together; the time must fall after the ticket and the upload within ${PHOTO_VERIFICATION_DEFAULTS.captureWindowMinutes} minutes of it, and a position less accurate than ${PHOTO_VERIFICATION_DEFAULTS.maxAccuracyM} m is not used. **Imported files** send none of these: the photo's own EXIF is checked (not more than 10 minutes ahead or 72 hours old) but an imported photo is never verified. Either way the position is checked against the site geofence version in force at capture (${PHOTO_VERIFICATION_DEFAULTS.toleranceM} m tolerance) and the diary's date when attached to a draft diary, and a photo whose difference hash is within ${PHOTO_VERIFICATION_DEFAULTS.similarityMaxDistance} bits of an earlier company photo from another day or project is not verified. The original is stored privately with its SHA-256 (HEIC as uploaded), plus a metadata-free JPEG thumbnail; the malware hook runs. 409 \`photo-duplicate\` for a file already in the project, \`capture-ticket-used\`, \`diary-not-draft\` for submitted or approved diaries; 415 \`unsupported-file-type\`; 422 \`invalid-image\`, \`capture-ticket-invalid\`; 503 \`photo-decoder-busy\`.`,
    operationId: "uploadSitePhoto",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file", "siteId"],
      properties: {
        file: { type: "string", format: "binary" },
        siteId: { type: "string", format: "uuid" },
        diaryId: { type: "string", format: "uuid" },
        caption: { type: "string", maxLength: 500 },
        purpose: { type: "string", enum: ["general", "safety_incident"] },
        captureTicketId: { type: "string", format: "uuid" },
        capturedAt: { type: "string", format: "date-time" },
        latitude: { type: "string", example: "-1.148912" },
        longitude: { type: "string", example: "36.961234" },
        accuracyM: { type: "string", example: "8.5" },
      },
    },
  })
  @ApiCreatedResponse({ schema: openApi(sitePhotoResponseSchema) })
  async upload(
    @Param("projectId") projectId: string,
    @UploadedFile() file: UploadedPhoto | undefined,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.photos.upload(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      file,
      photoUploadFieldsSchema.parse({ ...(body as object) }),
      req,
    );
  }

  @Get(":photoId/thumbnail")
  @ApiOperation({
    summary: "A photo's thumbnail (JPEG, no metadata)",
    description: readNote,
    operationId: "getSitePhotoThumbnail",
  })
  async thumbnail(
    @Param("projectId") projectId: string,
    @Param("photoId") photoId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.image("thumbnail", projectId, photoId, req, res);
  }

  @Get(":photoId/original")
  @ApiOperation({
    summary: "A photo's original upload (JPEG or HEIC, including its metadata)",
    description: readNote,
    operationId: "getSitePhotoOriginal",
  })
  async original(
    @Param("projectId") projectId: string,
    @Param("photoId") photoId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.image("original", projectId, photoId, req, res);
  }

  private async image(
    variant: "original" | "thumbnail",
    projectId: string,
    photoId: string,
    req: Request,
    res: Response,
  ) {
    const id = uuidSchema.parse(photoId);
    const { content, contentType } = await this.photos.content(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      id,
      variant,
      req,
    );
    // Served as an image only: never sniffed, never scriptable.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    const name = `photo-${id}${variant === "thumbnail" ? "-thumbnail" : ""}`;
    return new StreamableFile(content, {
      type: contentType,
      disposition: `inline; filename="${name}.${contentType === "image/heic" ? "heic" : "jpg"}"`,
      length: content.length,
    });
  }
}
