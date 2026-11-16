import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
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
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import { contentDisposition } from "@pm-buddy/domain";
import { DOCUMENT_LIMITS } from "@pm-buddy/types";
import {
  approveDpiaRequestSchema,
  biometricCaptureMethodSchema,
  biometricSwitchRequestSchema,
  biometricSwitchResponseSchema,
  biometricsOverviewResponseSchema,
  createDpiaRequestSchema,
  dpiaResponseSchema,
  rejectDpiaRequestSchema,
  updateDpiaRequestSchema,
  withdrawDpiaRequestSchema,
} from "@pm-buddy/validation";
import type { Request, Response } from "express";
import { openApi } from "../../common/openapi.js";
import {
  DOCUMENT_MULTER_LIMITS,
  DocumentUploadGuard,
  type UploadedDocumentFile,
} from "../documents/document-files.js";
import { AuthSecurity } from "../identity/auth-security.service.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { BiometricsDatabaseErrors } from "./biometrics-support.js";
import { BiometricsService } from "./biometrics.service.js";
import { DpiaService } from "./dpia.service.js";

const READ = "Requires biometrics.manage or biometrics.approve (company-level).";
const PREPARE =
  "Requires biometrics.manage (company-level); only a draft changes (409 dpia-not-draft).";
const DECIDE =
  "Requires biometrics.approve (company-level, MFA) and MFA verified within five minutes (403 step-up-required).";

/**
 * Biometric attendance gate (D3.4 first slice; DPIA_TEMPLATE §12.4, ARCHITECTURE §4.19): the
 * company's DPIA versions with the signed document, approval with every go-live condition
 * confirmed, and biometric capture switched on per site and method under the DPIA in force.
 */
@ApiTags("biometrics")
@UseGuards(BrowserGuard)
@Controller({ path: "biometrics", version: "1" })
@UseInterceptors(BiometricsDatabaseErrors)
export class BiometricsController {
  constructor(
    private readonly auth: AuthService,
    private readonly security: AuthSecurity,
    private readonly dpias: DpiaService,
    private readonly biometrics: BiometricsService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: "getBiometricsOverview",
    summary: "DPIA versions, the platform switch and every site's biometric gate per method",
    description: `${READ} States are computed on read in Nairobi dates: an approved DPIA lapses after its review date and biometric capture stops (fail closed).`,
  })
  @ApiOkResponse({ schema: openApi(biometricsOverviewResponseSchema) })
  async overview(@Req() req: Request) {
    return this.biometrics.overview(await this.auth.principal(req), req);
  }

  @Post("dpias")
  @ApiOperation({
    operationId: "createDpia",
    summary: "Start a DPIA version (a draft; one at a time)",
    description: `Requires biometrics.manage (company-level). 409 dpia-draft-exists while a draft is open; 422 unknown-site for a site of another company.`,
  })
  @ApiBody({ schema: openApi(createDpiaRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(dpiaResponseSchema) })
  async create(@Body() body: unknown, @Req() req: Request) {
    return this.dpias.create(
      await this.auth.principal(req),
      createDpiaRequestSchema.parse(body),
      req,
    );
  }

  @Get("dpias/:dpiaId")
  @ApiOperation({
    operationId: "getDpia",
    summary:
      "A DPIA version with its scope, sign-offs, document, approval and what still blocks it",
    description: READ,
  })
  @ApiOkResponse({ schema: openApi(dpiaResponseSchema) })
  async get(@Param("dpiaId") dpiaId: string, @Req() req: Request) {
    return this.dpias.get(await this.auth.principal(req), uuidSchema.parse(dpiaId), req);
  }

  @Put("dpias/:dpiaId")
  @ApiOperation({
    operationId: "updateDpia",
    summary: "Save a draft (replaces every field and the sites in scope)",
    description: `${PREPARE} Send the version you read (409 version-conflict).`,
  })
  @ApiBody({ schema: openApi(updateDpiaRequestSchema) })
  @ApiOkResponse({ schema: openApi(dpiaResponseSchema) })
  async update(@Param("dpiaId") dpiaId: string, @Body() body: unknown, @Req() req: Request) {
    return this.dpias.update(
      await this.auth.principal(req),
      uuidSchema.parse(dpiaId),
      updateDpiaRequestSchema.parse(body),
      req,
    );
  }

  @Post("dpias/:dpiaId/document")
  @HttpCode(200)
  @UseGuards(DocumentUploadGuard)
  @UseInterceptors(FileInterceptor("file", { limits: DOCUMENT_MULTER_LIMITS }))
  @ApiOperation({
    operationId: "uploadDpiaDocument",
    summary: "Upload the signed DPIA (PDF) to a draft; it replaces an earlier upload",
    description: `${PREPARE} One PDF of at most 25 MB, identified by its content: anything else is 415 pdf-required or unsupported-file-type; 422 pdf-active-content, malware-detected. Stored privately under a key the API generates, with its SHA-256; uploads are rate-limited.`,
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file"],
      properties: { file: { type: "string", format: "binary" } },
    },
  })
  @ApiOkResponse({ schema: openApi(dpiaResponseSchema) })
  async upload(
    @Param("dpiaId") dpiaId: string,
    @UploadedFile() file: UploadedDocumentFile | undefined,
    @Req() req: Request,
  ) {
    return this.dpias.upload(await this.auth.principal(req), uuidSchema.parse(dpiaId), file, req);
  }

  @Get("dpias/:dpiaId/document")
  @ApiOperation({
    operationId: "downloadDpiaDocument",
    summary: "Download the signed DPIA",
    description: `${READ} Streamed through the API, never from a public URL; the stored SHA-256 is verified (409 file-integrity); every download is audited.`,
  })
  @ApiProduces("application/pdf")
  async download(
    @Param("dpiaId") dpiaId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const principal = await this.auth.principal(req);
    await this.security.limit(
      `dpia-download:${principal.user.id}`,
      DOCUMENT_LIMITS.downloadsPer10Minutes,
      600,
    );
    const file = await this.dpias.download(principal, uuidSchema.parse(dpiaId), req);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", "private, no-store");
    return new StreamableFile(file.content, {
      type: "application/pdf",
      disposition: contentDisposition(file.fileName),
      length: file.content.length,
    });
  }

  @Post("dpias/:dpiaId/approve")
  @HttpCode(200)
  @ApiOperation({
    operationId: "approveDpia",
    summary: "Approve a draft: the DPIA in force until its review date",
    description: `${DECIDE} Bound to the version and the signed document's SHA-256 the approver reviewed (409 version-conflict, document-changed); every go-live condition confirmed (422 conditions-unconfirmed); review date after today and at most 12 months ahead (422 review-date-invalid); nothing missing (422 dpia-incomplete). Supersedes the approved version and keeps its switches on where the new scope still covers them.`,
  })
  @ApiBody({ schema: openApi(approveDpiaRequestSchema) })
  @ApiOkResponse({ schema: openApi(dpiaResponseSchema) })
  async approve(@Param("dpiaId") dpiaId: string, @Body() body: unknown, @Req() req: Request) {
    return this.dpias.approve(
      await this.auth.principal(req),
      uuidSchema.parse(dpiaId),
      approveDpiaRequestSchema.parse(body),
      req,
    );
  }

  @Post("dpias/:dpiaId/reject")
  @HttpCode(200)
  @ApiOperation({
    operationId: "rejectDpia",
    summary: "Close a draft as not approved, with a reason (final)",
    description: DECIDE,
  })
  @ApiBody({ schema: openApi(rejectDpiaRequestSchema) })
  @ApiOkResponse({ schema: openApi(dpiaResponseSchema) })
  async reject(@Param("dpiaId") dpiaId: string, @Body() body: unknown, @Req() req: Request) {
    return this.dpias.reject(
      await this.auth.principal(req),
      uuidSchema.parse(dpiaId),
      rejectDpiaRequestSchema.parse(body),
      req,
    );
  }

  @Post("dpias/:dpiaId/withdraw")
  @HttpCode(200)
  @ApiOperation({
    operationId: "withdrawDpia",
    summary:
      "Withdraw the approved DPIA, with a reason: biometric capture stops everywhere at once",
    description: `${DECIDE} 409 dpia-not-approved for any other version. Final; a new version must be approved and sites switched on again.`,
  })
  @ApiBody({ schema: openApi(withdrawDpiaRequestSchema) })
  @ApiOkResponse({ schema: openApi(dpiaResponseSchema) })
  async withdraw(@Param("dpiaId") dpiaId: string, @Body() body: unknown, @Req() req: Request) {
    return this.dpias.withdraw(
      await this.auth.principal(req),
      uuidSchema.parse(dpiaId),
      withdrawDpiaRequestSchema.parse(body),
      req,
    );
  }

  @Put("sites/:siteId/methods/:method")
  @ApiOperation({
    operationId: "setBiometricSwitch",
    summary: "Switch biometric capture on or off for one site and method",
    description:
      "On: requires biometrics.approve and MFA verified within five minutes; only where the platform allows biometrics (409 biometrics-unavailable), the project is open (409 project-read-only) and the approved DPIA is in force (409 dpia-required, dpia-lapsed) and covers the site and method (409 dpia-scope). Off: biometrics.manage or biometrics.approve, always allowed. Asking for the current position records nothing.",
  })
  @ApiBody({ schema: openApi(biometricSwitchRequestSchema) })
  @ApiOkResponse({ schema: openApi(biometricSwitchResponseSchema) })
  async setSwitch(
    @Param("siteId") siteId: string,
    @Param("method") method: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.biometrics.setSwitch(
      await this.auth.principal(req),
      uuidSchema.parse(siteId),
      biometricCaptureMethodSchema.parse(method),
      biometricSwitchRequestSchema.parse(body),
      req,
    );
  }
}
