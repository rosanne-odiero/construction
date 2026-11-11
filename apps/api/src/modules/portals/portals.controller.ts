import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  clientProjectResponseSchema,
  clientProjectsResponseSchema,
  invitationResponseSchema,
  workerPortalResponseSchema,
} from "@pm-buddy/validation";
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

  @Get("portal/client/projects")
  @ApiOperation({
    summary: "Client portal: the projects the client is assigned to",
    description: "Requires portal.client (role ∩ project assignment).",
    operationId: "listClientProjects",
  })
  @ApiOkResponse({ schema: openApi(clientProjectsResponseSchema) })
  async clientProjects(@Req() req: Request) {
    return this.portals.clientProjects(await this.auth.principal(req), req);
  }

  @Get("portal/client/projects/:id")
  @ApiOperation({
    summary: "Client portal: a project's milestones and approved site diaries",
    description:
      "Requires portal.client on the project. Drafts, rejections and reviewers are never included.",
    operationId: "getClientProject",
  })
  @ApiOkResponse({ schema: openApi(clientProjectResponseSchema) })
  async clientProject(@Param("id") id: string, @Req() req: Request) {
    return this.portals.clientProjectDetail(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      req,
    );
  }

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
