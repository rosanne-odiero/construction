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
import { PHOTO_LIMITS } from "@pm-buddy/domain";
import {
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
    private readonly photos: PhotosService,
  ) {}

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
        fields: 3,
        parts: 4,
        fieldNameSize: 20,
        fieldSize: 2_000,
        headerPairs: 20,
      },
    }),
  )
  @ApiOperation({
    summary: "Upload a JPEG site photo (at most 15 MB); the server verifies its metadata",
    description:
      "Requires site.photos; closed and cancelled projects are read-only. The position and capture time come only from the photo's EXIF, checked against the site geofence version in force at capture (30 m GPS tolerance) and the upload time (not more than 10 minutes ahead or 72 hours old; the diary's date when attached to a draft diary). The original is stored privately with its SHA-256, plus a metadata-free thumbnail; the malware hook runs. 409 `photo-duplicate` for a file already in the project, `diary-not-draft` for submitted or approved diaries; 415 `unsupported-file-type`; 422 `invalid-image`.",
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
    summary: "A photo's original upload (JPEG, including its metadata)",
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
    const content = await this.photos.content(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      id,
      variant,
      req,
    );
    // Served as an image only: never sniffed, never scriptable.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    return new StreamableFile(content, {
      type: "image/jpeg",
      disposition: `inline; filename="photo-${id}${variant === "thumbnail" ? "-thumbnail" : ""}.jpg"`,
      length: content.length,
    });
  }
}
