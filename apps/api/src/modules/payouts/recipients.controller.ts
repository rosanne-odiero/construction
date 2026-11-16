import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import {
  changeHoldOverrideRequestSchema,
  createPayoutHoldRequestSchema,
  createPayoutVerificationRequestSchema,
  labourerPayoutStatusResponseSchema,
  releasePayoutHoldRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { RecipientsService } from "./recipients.service.js";

const optionalKey = {
  name: "Idempotency-Key",
  required: false,
  description:
    "Optional, 8–128 letters, digits, '-' or '_'. A retry with the same key and payload returns the original response; another payload is 409 idempotency-key-reused.",
};
const stepUp = "MFA verified within five minutes (403 mfa-required, step-up-required).";

/**
 * The payout side of a worker record (D4.3 §5, `/api/v1/labour/...`): in-person verification of
 * the M-Pesa number, holds and the hold after a number change.
 */
@ApiTags("labour")
@UseGuards(BrowserGuard)
@Controller({ path: "labour", version: "1" })
export class LabourPayoutsController {
  constructor(
    private readonly auth: AuthService,
    private readonly recipients: RecipientsService,
  ) {}

  @Get("labourers/:id/payout-status")
  @ApiOperation({
    summary: "A worker's payout status: number verification, holds, change hold, amounts owed",
    description:
      "labour.view or labour.manage on one of the worker's projects, or payments.view or payroll.approve.",
    operationId: "getLabourerPayoutStatus",
  })
  @ApiOkResponse({ schema: openApi(labourerPayoutStatusResponseSchema) })
  async status(@Param("id") id: string, @Req() req: Request) {
    return this.recipients.status(await this.auth.principal(req), req, uuidSchema.parse(id));
  }

  @Post("labourers/:id/payout-verifications")
  @HttpCode(200)
  @ApiOperation({
    summary: "Record an in-person ID check of the worker's current M-Pesa number",
    description: `labour.manage on one of the worker's projects and ${stepUp} Not whoever changed the number, nor the registrar when it came with the registration (403 maker-checker). 409 no-number, version-conflict (the labourer's version).`,
    operationId: "verifyLabourerPayoutNumber",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(createPayoutVerificationRequestSchema) })
  @ApiOkResponse({ schema: openApi(labourerPayoutStatusResponseSchema) })
  async verify(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.recipients.verify(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
      createPayoutVerificationRequestSchema.parse(body),
    );
  }

  @Post("labourers/:id/payout-holds")
  @HttpCode(200)
  @ApiOperation({
    summary: "Place a manual hold on M-Pesa payouts to the worker",
    description: "payments.approve and a reason.",
    operationId: "placeLabourerPayoutHold",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(createPayoutHoldRequestSchema) })
  @ApiOkResponse({ schema: openApi(labourerPayoutStatusResponseSchema) })
  async hold(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.recipients.placeHold(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
      createPayoutHoldRequestSchema.parse(body),
    );
  }

  @Post("payout-holds/:id/release")
  @HttpCode(200)
  @ApiOperation({
    summary: "Release a payout hold with a reason",
    description: `payments.approve and ${stepUp} 409 hold-released.`,
    operationId: "releasePayoutHold",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(releasePayoutHoldRequestSchema) })
  @ApiOkResponse({ schema: openApi(labourerPayoutStatusResponseSchema) })
  async release(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.recipients.releaseHold(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
      releasePayoutHoldRequestSchema.parse(body),
    );
  }

  @Post("labourers/:id/change-hold-override")
  @HttpCode(200)
  @ApiOperation({
    summary: "Override the hold after a number change (OR-05)",
    description: `A member whose system role is owner (403 owner-only), payments.approve and ${stepUp} 409 change-hold-inactive, version-conflict (the labourer's version).`,
    operationId: "overrideLabourerChangeHold",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(changeHoldOverrideRequestSchema) })
  @ApiOkResponse({ schema: openApi(labourerPayoutStatusResponseSchema) })
  async override(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.recipients.overrideChangeHold(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
      changeHoldOverrideRequestSchema.parse(body),
    );
  }
}
