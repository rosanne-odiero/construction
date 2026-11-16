import { Body, Controller, Get, HttpCode, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  invitationResponseSchema,
  messageResponseSchema,
  workerPortalResponseSchema,
  workerNotificationPreferencesSchema,
  workerNotificationRequestSchema,
  workerNotificationHistorySchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { labourerInvitationSchema, uuidSchema } from "../identity/identity.schemas.js";
import { TenancyService } from "../identity/tenancy.service.js";
import { PortalsService } from "./portals.service.js";
import { WorkerNotificationsService } from "./worker-notifications.service.js";

@ApiTags("portals")
@UseGuards(BrowserGuard)
@Controller({ version: "1" })
export class PortalsController {
  constructor(
    private readonly auth: AuthService,
    private readonly portals: PortalsService,
    private readonly tenancy: TenancyService,
    private readonly notifications: WorkerNotificationsService,
  ) {}

  @Get("portal/worker")
  @ApiOperation({
    summary: "Labourer portal: assigned sites, own attendance and submitted pay",
    description:
      "Requires portal.worker. Own records require a unique registry match to the verified account phone. Only assigned projects are included; draft and cancelled payroll are excluded. Submitted pay is not proof of payment. PIN sessions may use this portal only.",
    operationId: "getWorkerPortal",
  })
  @ApiOkResponse({ schema: openApi(workerPortalResponseSchema) })
  async worker(@Req() req: Request) {
    return this.portals.worker(await this.auth.principal(req), req);
  }

  @Get("portal/worker/notifications")
  @ApiOperation({
    operationId: "getWorkerNotifications",
    summary: "Own account-level SMS/WhatsApp preferences",
  })
  @ApiOkResponse({ schema: openApi(workerNotificationPreferencesSchema) })
  async preferences(@Req() req: Request) {
    return this.notifications.preferences(await this.auth.principal(req), req);
  }

  @Get("portal/worker/notifications/history")
  @ApiOperation({
    operationId: "getWorkerNotificationHistory",
    summary: "Own latest 50 notification attempts; accepted is not delivered",
  })
  @ApiOkResponse({ schema: openApi(workerNotificationHistorySchema) })
  async notificationHistory(@Req() req: Request) {
    return this.notifications.history(await this.auth.principal(req), req);
  }

  @Put("portal/worker/notifications")
  @ApiOperation({
    operationId: "setWorkerNotifications",
    summary: "Opt in or out of non-security worker notifications",
  })
  @ApiBody({ schema: openApi(workerNotificationPreferencesSchema) })
  @ApiOkResponse({ schema: openApi(workerNotificationPreferencesSchema) })
  async savePreferences(@Body() body: unknown, @Req() req: Request) {
    return this.notifications.preferences(
      await this.auth.principal(req),
      req,
      workerNotificationPreferencesSchema.parse(body),
    );
  }

  @Post("portal/worker/notifications/send")
  @HttpCode(200)
  @ApiOperation({
    operationId: "sendWorkerReminder",
    summary: "Request a wage-free reminder on an opted-in channel",
  })
  @ApiBody({ schema: openApi(workerNotificationRequestSchema) })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  async sendNotification(@Body() body: unknown, @Req() req: Request) {
    return this.notifications.send(
      await this.auth.principal(req),
      req,
      workerNotificationRequestSchema.parse(body).channel,
    );
  }

  @Post("projects/:id/labourers/invitations")
  @ApiOperation({
    summary: "Invite a labourer to the project by Kenyan phone number",
    description:
      "Requires labour.manage on the project. The labourer role grants only portal.worker on this project; the SMS links to the PIN set-up page (48 hours). 409 `already-member` if the number is already in the company.",
    operationId: "inviteLabourer",
  })
  @ApiBody({ schema: openApi(labourerInvitationSchema) })
  @ApiCreatedResponse({ schema: openApi(invitationResponseSchema) })
  async inviteLabourer(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.tenancy.inviteLabourer(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      labourerInvitationSchema.parse(body).identifier,
      req,
    );
  }
}
