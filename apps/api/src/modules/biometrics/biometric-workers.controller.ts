import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  biometricDeletionsResponseSchema,
  biometricEnrolmentResponseSchema,
  biometricEnrolmentsResponseSchema,
  biometricRetentionRunResponseSchema,
  deleteBiometricEnrolmentRequestSchema,
  enrolBiometricRequestSchema,
  recordBiometricConsentRequestSchema,
  withdrawBiometricConsentRequestSchema,
  workerBiometricsResponseSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthSecurity } from "../identity/auth-security.service.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { BiometricConsentService } from "./biometric-consent.service.js";
import { BiometricEnrolmentService } from "./biometric-enrolment.service.js";
import { BiometricRetentionService } from "./biometric-retention.service.js";
import { BiometricsDatabaseErrors } from "./biometrics-support.js";

const READ = "Requires biometrics.manage or biometrics.approve (company-level).";
/** Enrolments per user per 10 minutes: a kiosk queue, never a bulk import. */
const ENROLMENTS_PER_10_MINUTES = 60;

/**
 * Biometric consent per modality, enrolment and template deletion (D3.4 second slice;
 * DPIA_TEMPLATE §7, §8; ARCHITECTURE §4.19). Templates are accepted, sealed and stored; no endpoint
 * ever returns, exports or decrypts one.
 */
@ApiTags("biometrics")
@UseGuards(BrowserGuard)
@Controller({ path: "biometrics", version: "1" })
@UseInterceptors(BiometricsDatabaseErrors)
export class BiometricWorkersController {
  constructor(
    private readonly auth: AuthService,
    private readonly security: AuthSecurity,
    private readonly consents: BiometricConsentService,
    private readonly enrolments: BiometricEnrolmentService,
    private readonly retention: BiometricRetentionService,
  ) {}

  @Get("labourers/:labourerId")
  @ApiOperation({
    operationId: "getWorkerBiometrics",
    summary: "A worker's biometric consent decisions, enrolment and deletions per modality",
    description:
      "Requires labour.view on one of the worker's projects, or biometrics.manage. Shows the current notice per modality and why consent cannot be recorded now (platform off, no DPIA, lapsed, not in scope). Never shows templates.",
  })
  @ApiOkResponse({ schema: openApi(workerBiometricsResponseSchema) })
  async worker(@Param("labourerId") labourerId: string, @Req() req: Request) {
    return this.consents.worker(await this.auth.principal(req), uuidSchema.parse(labourerId), req);
  }

  @Post("labourers/:labourerId/consents")
  @HttpCode(200)
  @ApiOperation({
    operationId: "recordBiometricConsent",
    summary: "Record the worker's yes or no to the biometric notice of one modality",
    description:
      "Requires biometrics.enrol on one of the worker's projects. Only while the platform allows biometrics and the approved DPIA in force covers the modality (409 biometrics-unavailable, dpia-required, dpia-lapsed, dpia-scope); the current notice only (400 notice-not-current); one decision at a time (409 consent-recorded: a yes already recorded, or a no while a yes stands — record a withdrawal). A refusal is recorded with no reason asked. The worker gets an SMS confirmation after it commits.",
  })
  @ApiBody({ schema: openApi(recordBiometricConsentRequestSchema) })
  @ApiOkResponse({ schema: openApi(workerBiometricsResponseSchema) })
  async record(
    @Param("labourerId") labourerId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.consents.record(
      await this.auth.principal(req),
      uuidSchema.parse(labourerId),
      recordBiometricConsentRequestSchema.parse(body),
      req,
    );
  }

  @Post("labourers/:labourerId/consents/withdraw")
  @HttpCode(200)
  @ApiOperation({
    operationId: "withdrawBiometricConsent",
    summary: "Record the worker's withdrawal: the modality's templates are deleted at once",
    description:
      "Requires biometrics.enrol or labour.consent on one of the worker's projects, or biometrics.manage. Never blocked by the platform switch or the DPIA. 409 consent-not-granted when nothing is granted. The worker gets an SMS confirmation.",
  })
  @ApiBody({ schema: openApi(withdrawBiometricConsentRequestSchema) })
  @ApiOkResponse({ schema: openApi(workerBiometricsResponseSchema) })
  async withdraw(
    @Param("labourerId") labourerId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.consents.withdraw(
      await this.auth.principal(req),
      uuidSchema.parse(labourerId),
      withdrawBiometricConsentRequestSchema.parse(body),
      req,
    );
  }

  @Post("enrolments")
  @ApiOperation({
    operationId: "enrolBiometric",
    summary: "Enrol a worker from a capture device: templates only, sealed on arrival",
    description:
      "Requires biometrics.enrol on the site's project. The client chooses the enrolment ID: a retry returns the same enrolment (409 enrolment-conflict if the ID was used for another). Needs biometric capture on for the site and method today (409 biometrics-unavailable, project-read-only, dpia-required, dpia-lapsed, dpia-scope), a template key on this installation (409 template-key-missing), an active worker (409 labourer-inactive) engaged on the site's project today (409 not-engaged) with consent to the current notice for the modality (409 consent-required). Images are refused (422 raw-image-refused). Replaces the worker's previous enrolment of the modality. Bodies up to 256 KB; rate-limited per user.",
  })
  @ApiBody({ schema: openApi(enrolBiometricRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(biometricEnrolmentResponseSchema) })
  async enrol(@Body() body: unknown, @Req() req: Request) {
    const principal = await this.auth.principal(req);
    await this.security.limit(
      `biometric-enrol:${principal.user.id}`,
      ENROLMENTS_PER_10_MINUTES,
      600,
    );
    return this.enrolments.enrol(principal, enrolBiometricRequestSchema.parse(body), req);
  }

  @Get("enrolments")
  @ApiOperation({
    operationId: "listBiometricEnrolments",
    summary: "Every enrolment still holding templates, with its state and deletion date",
    description: `${READ} States: active, held (the DPIA has lapsed: kept, unused) or deletion_due (waiting for the retention job).`,
  })
  @ApiOkResponse({ schema: openApi(biometricEnrolmentsResponseSchema) })
  async list(@Req() req: Request) {
    return this.enrolments.list(await this.auth.principal(req), req);
  }

  @Post("enrolments/:enrolmentId/delete")
  @HttpCode(200)
  @ApiOperation({
    operationId: "deleteBiometricEnrolment",
    summary: "Delete an enrolment's templates on the worker's request",
    description:
      "Requires biometrics.manage (company-level). The enrolment's metadata and a deletion log entry are kept. 409 enrolment-deleted when already deleted.",
  })
  @ApiBody({ schema: openApi(deleteBiometricEnrolmentRequestSchema) })
  @ApiOkResponse({ schema: openApi(biometricEnrolmentResponseSchema) })
  async remove(
    @Param("enrolmentId") enrolmentId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    deleteBiometricEnrolmentRequestSchema.parse(body);
    return this.enrolments.deleteOnRequest(
      await this.auth.principal(req),
      uuidSchema.parse(enrolmentId),
      req,
    );
  }

  @Get("deletions")
  @ApiOperation({
    operationId: "listBiometricDeletions",
    summary: "The deletion log: who deleted which worker's templates, when and why",
    description: `${READ} The latest 200 entries; never template content.`,
  })
  @ApiOkResponse({ schema: openApi(biometricDeletionsResponseSchema) })
  async deletions(@Req() req: Request) {
    return this.enrolments.deletions(await this.auth.principal(req), req);
  }

  @Post("retention/run")
  @HttpCode(200)
  @ApiOperation({
    operationId: "runBiometricRetention",
    summary: "Delete the company's templates whose retention period has passed, now",
    description:
      "Requires biometrics.manage (company-level). The same deletions the hourly retention job makes, for this company only.",
  })
  @ApiOkResponse({ schema: openApi(biometricRetentionRunResponseSchema) })
  async runRetention(@Req() req: Request) {
    return this.retention.runForCompany(await this.auth.principal(req), req);
  }
}
