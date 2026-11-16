import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBody, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from "@nestjs/swagger";
import {
  captureReceiptSchema,
  captureReviewSchema,
  messageResponseSchema,
  pushAttendanceEventSchema,
  registerSiteDeviceSchema,
  siteLeaseRequestSchema,
  siteRosterSchema,
} from "@pm-buddy/validation";
import type { Request, Response } from "express";
import { z } from "zod";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { AttendanceCaptureService } from "./capture.service.js";

@ApiTags("attendance capture")
@UseGuards(BrowserGuard)
@Controller({ path: "attendance/capture", version: "1" })
export class AttendanceCaptureController {
  constructor(
    private readonly auth: AuthService,
    private readonly capture: AttendanceCaptureService,
  ) {}

  @Post("devices")
  @HttpCode(200)
  @ApiOperation({ summary: "Bind an Ed25519 device key to the current user and company" })
  @ApiBody({ schema: openApi(registerSiteDeviceSchema) })
  async register(@Body() body: unknown, @Req() req: Request) {
    return this.capture.register(
      await this.auth.principal(req),
      registerSiteDeviceSchema.parse(body),
      req,
    );
  }

  @Get("devices")
  @ApiOperation({ summary: "Own devices, or company devices for config.manage" })
  async devices(@Req() req: Request) {
    return this.capture.devices(await this.auth.principal(req), req);
  }

  @Post("devices/:id/revoke")
  @HttpCode(200)
  @ApiOperation({
    summary: "Permanently revoke an owned device, or another device with config.manage and step-up",
  })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  async revokeDevice(@Param("id") id: string, @Req() req: Request) {
    return this.capture.revokeDevice(await this.auth.principal(req), z.uuid().parse(id), req);
  }

  @Post("devices/:id/lease")
  @HttpCode(200)
  @ApiOperation({
    summary: "Issue a 72-hour server-clock anchor and authorised full roster snapshot",
  })
  @ApiBody({ schema: openApi(siteLeaseRequestSchema) })
  @ApiOkResponse({ schema: openApi(siteRosterSchema) })
  async lease(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.capture.lease(
      await this.auth.principal(req),
      z.uuid().parse(id),
      siteLeaseRequestSchema.parse(body),
      req,
    );
  }

  @Post("cards")
  @HttpCode(200)
  @ApiOperation({
    summary: "Issue an opaque QR/NDEF text token, revoking the worker's old cards (labour.manage)",
  })
  @ApiBody({ schema: openApi(z.object({ labourerId: z.uuid() }).strict()) })
  async issueCard(@Body() body: unknown, @Req() req: Request) {
    const input = z.object({ labourerId: z.uuid() }).strict().parse(body);
    return this.capture.issueCard(await this.auth.principal(req), input.labourerId, req);
  }

  @Get("cards")
  @ApiOperation({
    summary: "Active card identifiers for a project, without printable tokens (labour.manage)",
  })
  async cards(@Query() raw: unknown, @Req() req: Request) {
    const query = z.object({ projectId: z.uuid() }).strict().parse(raw);
    return this.capture.cards(await this.auth.principal(req), query.projectId, req);
  }

  @Post("cards/:id/revoke")
  @HttpCode(200)
  @ApiOperation({ summary: "Revoke a worker card (labour.manage); retain submitted evidence" })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  async revokeCard(@Param("id") id: string, @Req() req: Request) {
    return this.capture.revokeCard(await this.auth.principal(req), z.uuid().parse(id), req);
  }

  @Post("events")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Durably receive one signed camera/card event; retries reuse the event ID and exact signed bytes",
    description:
      "Current authorisation, device ownership and signature are checked before replay. Quarantined evidence is retained, never silently applied to wages. Check-in and check-out allocate one draft muster record only when both are eligible.",
  })
  @ApiBody({ schema: openApi(pushAttendanceEventSchema) })
  @ApiOkResponse({ schema: openApi(captureReceiptSchema) })
  async push(@Body() body: unknown, @Req() req: Request) {
    return this.capture.push(
      await this.auth.principal(req),
      pushAttendanceEventSchema.parse(body),
      req,
    );
  }

  @Get("events")
  @ApiOperation({ summary: "Project-scoped capture review queue, keyset-paged (attendance.view)" })
  async events(@Query() raw: unknown, @Req() req: Request) {
    const query = z
      .object({ projectId: z.uuid(), before: z.uuid().optional() })
      .strict()
      .parse(raw);
    return this.capture.list(await this.auth.principal(req), query.projectId, query.before, req);
  }

  @Post("events/:id/review")
  @HttpCode(200)
  @ApiOperation({
    summary: "Resolve/dismiss capture evidence with reason, step-up and a different reviewer",
  })
  @ApiBody({ schema: openApi(captureReviewSchema) })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  async review(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.capture.review(
      await this.auth.principal(req),
      z.uuid().parse(id),
      captureReviewSchema.parse(body),
      req,
    );
  }

  @Get("events/:id/photo")
  @ApiOperation({
    summary: "Audited private camera photo (attendance.view on the capture's project)",
  })
  @ApiProduces("image/jpeg")
  async photo(@Param("id") id: string, @Req() req: Request, @Res() res: Response) {
    const photo = await this.capture.photo(await this.auth.principal(req), z.uuid().parse(id), req);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Disposition", 'inline; filename="attendance-camera.jpg"');
    res.send(photo);
  }
}
