import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  changeGeofenceRequestSchema,
  createMilestoneRequestSchema,
  createProjectRequestSchema,
  createSiteRequestSchema,
  createWbsNodeRequestSchema,
  geofenceHistoryResponseSchema,
  messageResponseSchema,
  milestoneResponseSchema,
  milestonesResponseSchema,
  milestoneStatusRequestSchema,
  projectAssignmentRequestSchema,
  projectDetailResponseSchema,
  projectListQuerySchema,
  projectResponseSchema,
  projectsResponseSchema,
  projectStatusRequestSchema,
  projectTeamResponseSchema,
  reorderWbsRequestSchema,
  siteResponseSchema,
  sitesResponseSchema,
  updateMilestoneRequestSchema,
  updateProjectRequestSchema,
  updateSiteRequestSchema,
  updateWbsNodeRequestSchema,
  wbsNodeResponseSchema,
  wbsResponseSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { z } from "zod";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { ProjectsService } from "./projects.service.js";
import { SitesService } from "./sites.service.js";
import { TeamService } from "./team.service.js";
import { WbsService } from "./wbs.service.js";

const viewNote = "Requires projects.view on the project (role ∩ assignment).";
const manageNote =
  "Requires projects.manage on the project; closed and cancelled projects are read-only (409).";
const atSchema = z.iso.datetime({ offset: true }).optional();

@ApiTags("projects")
@UseGuards(BrowserGuard)
@Controller({ path: "projects", version: "1" })
export class ProjectsController {
  constructor(
    private readonly auth: AuthService,
    private readonly projects: ProjectsService,
    private readonly sites: SitesService,
    private readonly wbs: WbsService,
    private readonly team: TeamService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Projects the caller can view, optionally filtered by status or a search term",
    description:
      "Lists projects where the caller holds projects.view (all, for company-wide roles).",
    operationId: "listProjects",
  })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "search", required: false, description: "Code, name, client or town" })
  @ApiOkResponse({ schema: openApi(projectsResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.projects.list(
      await this.auth.principal(req),
      projectListQuerySchema.parse(query),
      req,
    );
  }

  @Post()
  @ApiOperation({
    summary: "Create a project (planning)",
    description:
      "Requires projects.create and MFA verified within five minutes. Without a code the next PRJ-NNN is assigned.",
    operationId: "createProject",
  })
  @ApiBody({ schema: openApi(createProjectRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(projectResponseSchema) })
  @ApiConflictResponse({ description: "The code is already used in this company" })
  async create(@Body() body: unknown, @Req() req: Request) {
    return this.projects.create(
      await this.auth.principal(req),
      createProjectRequestSchema.parse(body),
      req,
    );
  }

  @Get(":id")
  @ApiOperation({
    summary: "A project with the caller's permissions, activation gaps and status history",
    description: viewNote,
    operationId: "getProject",
  })
  @ApiOkResponse({ schema: openApi(projectDetailResponseSchema) })
  @ApiNotFoundResponse({ description: "No such project in the selected company" })
  async get(@Param("id") id: string, @Req() req: Request) {
    return this.projects.get(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Change project details",
    description: `${manageNote} Send the version you read; a newer one is a 409 version-conflict.`,
    operationId: "updateProject",
  })
  @ApiBody({ schema: openApi(updateProjectRequestSchema) })
  @ApiOkResponse({ schema: openApi(projectResponseSchema) })
  @ApiConflictResponse({ description: "Version conflict, code taken or fixed, read-only project" })
  async update(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.projects.update(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      updateProjectRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/status")
  @HttpCode(200)
  @ApiOperation({
    summary: "Move a project along its lifecycle",
    description:
      "Requires projects.manage. planning→active (needs contract details and a geofenced site), planning→cancelled, active→on_hold, on_hold→active, on_hold→cancelled, active→completed, completed→closed. Holding and cancelling need a reason.",
    operationId: "changeProjectStatus",
  })
  @ApiBody({ schema: openApi(projectStatusRequestSchema) })
  @ApiOkResponse({ schema: openApi(projectResponseSchema) })
  @ApiConflictResponse({
    description: "Invalid transition, activation incomplete or stale version",
  })
  async changeStatus(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.projects.changeStatus(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      projectStatusRequestSchema.parse(body),
      req,
    );
  }

  @Get(":id/sites")
  @ApiOperation({
    summary: "Sites with their current geofence",
    description: viewNote,
    operationId: "listSites",
  })
  @ApiOkResponse({ schema: openApi(sitesResponseSchema) })
  async listSites(@Param("id") id: string, @Req() req: Request) {
    return this.sites.list(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Post(":id/sites")
  @ApiOperation({
    summary: "Add a site with its first geofence (radius or polygon)",
    description: manageNote,
    operationId: "createSite",
  })
  @ApiBody({ schema: openApi(createSiteRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(siteResponseSchema) })
  @ApiConflictResponse({ description: "A site with this name exists, or the project is read-only" })
  async createSite(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.sites.create(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      createSiteRequestSchema.parse(body),
      req,
    );
  }

  @Patch(":id/sites/:siteId")
  @ApiOperation({
    summary: "Rename a site or change its address/landmark",
    description: manageNote,
    operationId: "updateSite",
  })
  @ApiBody({ schema: openApi(updateSiteRequestSchema) })
  @ApiOkResponse({ schema: openApi(siteResponseSchema) })
  async updateSite(
    @Param("id") id: string,
    @Param("siteId") siteId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.sites.update(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(siteId),
      updateSiteRequestSchema.parse(body),
      req,
    );
  }

  @Put(":id/sites/:siteId/geofence")
  @ApiOperation({
    summary: "Change a site's geofence (appends a new version; earlier versions never change)",
    description: `${manageNote} currentVersion must be the newest version (else 409).`,
    operationId: "changeGeofence",
  })
  @ApiBody({ schema: openApi(changeGeofenceRequestSchema) })
  @ApiOkResponse({ schema: openApi(siteResponseSchema) })
  async changeGeofence(
    @Param("id") id: string,
    @Param("siteId") siteId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.sites.changeGeofence(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(siteId),
      changeGeofenceRequestSchema.parse(body),
      req,
    );
  }

  @Get(":id/sites/:siteId/geofences")
  @ApiOperation({
    summary: "A site's geofence versions, newest first",
    description: `${viewNote} With ?at=<timestamp>, only the version in force at that moment.`,
    operationId: "listGeofenceVersions",
  })
  @ApiQuery({ name: "at", required: false })
  @ApiOkResponse({ schema: openApi(geofenceHistoryResponseSchema) })
  async geofences(
    @Param("id") id: string,
    @Param("siteId") siteId: string,
    @Query("at") at: unknown,
    @Req() req: Request,
  ) {
    const moment = atSchema.parse(at);
    return this.sites.history(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(siteId),
      moment ? new Date(moment) : null,
      req,
    );
  }

  @Get(":id/wbs")
  @ApiOperation({
    summary: "The work breakdown structure with weight checks",
    description: `${viewNote} Sibling weights must sum to 100 % (10,000 basis points); progress is null (unavailable) until they do and measurements exist.`,
    operationId: "getWbs",
  })
  @ApiOkResponse({ schema: openApi(wbsResponseSchema) })
  async getWbs(@Param("id") id: string, @Req() req: Request) {
    return this.wbs.tree(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Post(":id/wbs")
  @ApiOperation({
    summary: "Add a WBS node",
    description: manageNote,
    operationId: "createWbsNode",
  })
  @ApiBody({ schema: openApi(createWbsNodeRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(wbsNodeResponseSchema) })
  async createWbsNode(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.wbs.createNode(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      createWbsNodeRequestSchema.parse(body),
      req,
    );
  }

  @Put(":id/wbs/order")
  @ApiOperation({
    summary: "Reorder the children of one parent (null for the top level)",
    description: manageNote,
    operationId: "reorderWbs",
  })
  @ApiBody({ schema: openApi(reorderWbsRequestSchema) })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  async reorderWbs(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.wbs.reorder(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      reorderWbsRequestSchema.parse(body),
      req,
    );
  }

  @Patch(":id/wbs/:nodeId")
  @ApiOperation({
    summary: "Change a WBS node (code, name, weight or parent)",
    description: manageNote,
    operationId: "updateWbsNode",
  })
  @ApiBody({ schema: openApi(updateWbsNodeRequestSchema) })
  @ApiOkResponse({ schema: openApi(wbsNodeResponseSchema) })
  async updateWbsNode(
    @Param("id") id: string,
    @Param("nodeId") nodeId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.wbs.updateNode(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(nodeId),
      updateWbsNodeRequestSchema.parse(body),
      req,
    );
  }

  @Delete(":id/wbs/:nodeId")
  @ApiOperation({
    summary: "Remove a WBS node without children or milestones",
    description: manageNote,
    operationId: "deleteWbsNode",
  })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  async deleteWbsNode(
    @Param("id") id: string,
    @Param("nodeId") nodeId: string,
    @Req() req: Request,
  ) {
    return this.wbs.removeNode(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(nodeId),
      req,
    );
  }

  @Get(":id/milestones")
  @ApiOperation({
    summary: "Milestones by due date",
    description: viewNote,
    operationId: "listMilestones",
  })
  @ApiOkResponse({ schema: openApi(milestonesResponseSchema) })
  async milestones(@Param("id") id: string, @Req() req: Request) {
    return this.wbs.milestones(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Post(":id/milestones")
  @ApiOperation({
    summary: "Add a milestone",
    description: manageNote,
    operationId: "createMilestone",
  })
  @ApiBody({ schema: openApi(createMilestoneRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(milestoneResponseSchema) })
  async createMilestone(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.wbs.createMilestone(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      createMilestoneRequestSchema.parse(body),
      req,
    );
  }

  @Patch(":id/milestones/:milestoneId")
  @ApiOperation({
    summary: "Change a milestone",
    description: manageNote,
    operationId: "updateMilestone",
  })
  @ApiBody({ schema: openApi(updateMilestoneRequestSchema) })
  @ApiOkResponse({ schema: openApi(milestoneResponseSchema) })
  async updateMilestone(
    @Param("id") id: string,
    @Param("milestoneId") milestoneId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.wbs.updateMilestone(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(milestoneId),
      updateMilestoneRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/milestones/:milestoneId/status")
  @HttpCode(200)
  @ApiOperation({
    summary: "Move a milestone along its lifecycle",
    description:
      "Requires projects.manage. planned→in_progress, planned/in_progress→achieved (actual date, not in the future), planned/in_progress→cancelled (reason), achieved→in_progress (reason).",
    operationId: "changeMilestoneStatus",
  })
  @ApiBody({ schema: openApi(milestoneStatusRequestSchema) })
  @ApiOkResponse({ schema: openApi(milestoneResponseSchema) })
  async changeMilestoneStatus(
    @Param("id") id: string,
    @Param("milestoneId") milestoneId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.wbs.changeMilestoneStatus(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(milestoneId),
      milestoneStatusRequestSchema.parse(body),
      req,
    );
  }

  @Delete(":id/milestones/:milestoneId")
  @ApiOperation({
    summary: "Delete a planned milestone",
    description: manageNote,
    operationId: "deleteMilestone",
  })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  async deleteMilestone(
    @Param("id") id: string,
    @Param("milestoneId") milestoneId: string,
    @Req() req: Request,
  ) {
    return this.wbs.removeMilestone(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(milestoneId),
      req,
    );
  }

  @Get(":id/team")
  @ApiOperation({
    summary: "Project members with company role and effective project permissions",
    description: `${viewNote} Candidates are listed for callers who may assign (users.invite and projects.manage).`,
    operationId: "getProjectTeam",
  })
  @ApiOkResponse({ schema: openApi(projectTeamResponseSchema) })
  async getTeam(@Param("id") id: string, @Req() req: Request) {
    return this.team.team(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Put(":id/members/:userId")
  @ApiOperation({
    summary: "Assign a company member to the project with project-scoped permissions",
    description:
      "Requires users.invite (MFA verified within five minutes) and projects.manage on the project. Every permission granted or removed must be one the caller holds there. Effective permissions are role ∩ assignment.",
    operationId: "assignProjectMember",
  })
  @ApiBody({ schema: openApi(projectAssignmentRequestSchema) })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  @ApiForbiddenResponse({ description: "Missing permission, stale MFA or privilege escalation" })
  async assign(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.team.assign(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(userId),
      projectAssignmentRequestSchema.parse(body).permissions,
      req,
    );
  }

  @Delete(":id/members/:userId")
  @ApiOperation({
    summary: "Remove a member's project assignment",
    description:
      "Same requirements as assigning; the caller must hold every permission the assignment carries.",
    operationId: "removeProjectMember",
  })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  @ApiForbiddenResponse({ description: "Missing permission, stale MFA or privilege escalation" })
  async removeMember(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Req() req: Request,
  ) {
    return this.team.remove(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(userId),
      req,
    );
  }
}
