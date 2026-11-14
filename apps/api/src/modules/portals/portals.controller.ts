import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { invitationResponseSchema, workerPortalResponseSchema } from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { labourerInvitationSchema, uuidSchema } from "../identity/identity.schemas.js";
import { TenancyService } from "../identity/tenancy.service.js";
import { PortalsService } from "./portals.service.js";

@ApiTags("portals")
@UseGuards(BrowserGuard)
@Controller({ version: "1" })
export class PortalsController {
  constructor(
    private readonly auth: AuthService,
    private readonly portals: PortalsService,
    private readonly tenancy: TenancyService,
  ) {}

  @Get("portal/worker")
  @ApiOperation({
    summary: "Labourer portal: company, assigned projects and sites",
    description:
      "Requires portal.worker. Attendance and pay are null until those modules exist. PIN sessions may use this portal only.",
    operationId: "getWorkerPortal",
  })
  @ApiOkResponse({ schema: openApi(workerPortalResponseSchema) })
  async worker(@Req() req: Request) {
    return this.portals.worker(await this.auth.principal(req), req);
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
