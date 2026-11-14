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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  activityProgressRequestSchema,
  amendDelayRequestSchema,
  createActivityRequestSchema,
  createBaselineRequestSchema,
  createDelayRequestSchema,
  createDependencyRequestSchema,
  messageResponseSchema,
  scheduleActivityResponseSchema,
  scheduleBaselineResponseSchema,
  scheduleBaselinesResponseSchema,
  scheduleCalendarResponseSchema,
  scheduleDelayResponseSchema,
  scheduleDelaysResponseSchema,
  scheduleDependencyResponseSchema,
  scheduleListQuerySchema,
  scheduleResponseSchema,
  updateActivityRequestSchema,
  updateDependencyRequestSchema,
  updateScheduleCalendarRequestSchema,
  versionQuerySchema,
  withdrawDelayRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { BaselinesService } from "./baselines.service.js";
import { DelaysService } from "./delays.service.js";
import { ScheduleService } from "./schedule.service.js";

const viewNote = "Requires projects.view on the project (role ∩ assignment).";
const manageNote =
  "Requires projects.manage on the project (role ∩ assignment); closed and cancelled projects are read-only (409 project-read-only).";
const versionNote = "Send the version you read; a newer one is a 409 version-conflict.";

@ApiTags("schedule")
@UseGuards(BrowserGuard)
@Controller({ path: "projects/:projectId/schedule", version: "1" })
export class ScheduleController {
  constructor(
    private readonly auth: AuthService,
    private readonly schedule: ScheduleService,
    private readonly baselines: BaselinesService,
    private readonly delays: DelaysService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: "getSchedule",
    summary: "The computed schedule: CPM dates, float, critical path, baseline variance",
    description: `${viewNote} Planned dates are computed on every read from durations, dependencies, "start no earlier than" dates, actual dates, the working calendar and today's data date (Africa/Nairobi). Variance is in working days against the current baseline, or the one named by baselineId; null means unavailable.`,
  })
  @ApiQuery({ name: "baselineId", required: false, description: "Compare with this baseline" })
  @ApiOkResponse({ schema: openApi(scheduleResponseSchema) })
  async get(@Param("projectId") projectId: string, @Query() query: unknown, @Req() req: Request) {
    return this.schedule.get(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      scheduleListQuerySchema.parse(query).baselineId,
      req,
    );
  }

  @Put("calendar")
  @ApiOperation({
    operationId: "updateScheduleCalendar",
    summary: "Set the working weekdays and whether company public holidays are non-working",
    description: `${manageNote} Version 0 saves the defaults for the first time. ${versionNote}`,
  })
  @ApiBody({ schema: openApi(updateScheduleCalendarRequestSchema) })
  @ApiOkResponse({ schema: openApi(scheduleCalendarResponseSchema) })
  @ApiConflictResponse({ description: "Version conflict or read-only project" })
  async updateCalendar(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.schedule.updateCalendar(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      updateScheduleCalendarRequestSchema.parse(body),
      req,
    );
  }

  @Post("activities")
  @ApiOperation({
    operationId: "createScheduleActivity",
    summary: "Add an activity (task) with a duration in working days",
    description: `${manageNote} The optional BQ item must be in the newest approved BQ version (422 bq-item-not-found). Codes are unique per project (409 activity-code-taken).`,
  })
  @ApiBody({ schema: openApi(createActivityRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(scheduleActivityResponseSchema) })
  async createActivity(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.schedule.createActivity(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      createActivityRequestSchema.parse(body),
      req,
    );
  }

  @Patch("activities/:activityId")
  @ApiOperation({
    operationId: "updateScheduleActivity",
    summary: "Change an activity's code, name, WBS node, BQ item, duration or start constraint",
    description: `${manageNote} ${versionNote}`,
  })
  @ApiBody({ schema: openApi(updateActivityRequestSchema) })
  @ApiOkResponse({ schema: openApi(scheduleActivityResponseSchema) })
  async updateActivity(
    @Param("projectId") projectId: string,
    @Param("activityId") activityId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.schedule.updateActivity(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      uuidSchema.parse(activityId),
      updateActivityRequestSchema.parse(body),
      req,
    );
  }

  @Put("activities/:activityId/progress")
  @ApiOperation({
    operationId: "recordScheduleProgress",
    summary: "Record actual dates and physical progress with its basis",
    description: `${manageNote} Physical progress is a whole percent estimated on site, or quantity done of a total in a unit; it is never earned or certified value. 100 % exactly when an actual finish is recorded; no future dates. ${versionNote}`,
  })
  @ApiBody({ schema: openApi(activityProgressRequestSchema) })
  @ApiOkResponse({ schema: openApi(scheduleActivityResponseSchema) })
  async recordProgress(
    @Param("projectId") projectId: string,
    @Param("activityId") activityId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.schedule.recordProgress(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      uuidSchema.parse(activityId),
      activityProgressRequestSchema.parse(body),
      req,
    );
  }

  @Delete("activities/:activityId")
  @ApiOperation({
    operationId: "deleteScheduleActivity",
    summary: "Delete an unstarted activity that no delay names (its dependencies go with it)",
    description: `${manageNote} 409 activity-started or activity-in-use otherwise. ${versionNote}`,
  })
  @ApiQuery({ name: "version", required: true })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  async removeActivity(
    @Param("projectId") projectId: string,
    @Param("activityId") activityId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.schedule.removeActivity(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      uuidSchema.parse(activityId),
      versionQuerySchema.parse(query).version,
      req,
    );
  }

  @Post("dependencies")
  @ApiOperation({
    operationId: "createScheduleDependency",
    summary: "Link two items (tasks or milestones): FS, SS, FF or SF with a lag in working days",
    description: `${manageNote} A link that would close a loop is refused (409 schedule-cycle; the database refuses it too). Negative lag (a lead) down to −60 working days.`,
  })
  @ApiBody({ schema: openApi(createDependencyRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(scheduleDependencyResponseSchema) })
  @ApiConflictResponse({ description: "Cycle, existing link, cancelled milestone" })
  async createDependency(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.schedule.createDependency(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      createDependencyRequestSchema.parse(body),
      req,
    );
  }

  @Patch("dependencies/:dependencyId")
  @ApiOperation({
    operationId: "updateScheduleDependency",
    summary: "Change a dependency's type or lag",
    description: `${manageNote} ${versionNote}`,
  })
  @ApiBody({ schema: openApi(updateDependencyRequestSchema) })
  @ApiOkResponse({ schema: openApi(scheduleDependencyResponseSchema) })
  async updateDependency(
    @Param("projectId") projectId: string,
    @Param("dependencyId") dependencyId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.schedule.updateDependency(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      uuidSchema.parse(dependencyId),
      updateDependencyRequestSchema.parse(body),
      req,
    );
  }

  @Delete("dependencies/:dependencyId")
  @ApiOperation({
    operationId: "deleteScheduleDependency",
    summary: "Remove a dependency",
    description: `${manageNote} ${versionNote}`,
  })
  @ApiQuery({ name: "version", required: true })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  async removeDependency(
    @Param("projectId") projectId: string,
    @Param("dependencyId") dependencyId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.schedule.removeDependency(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      uuidSchema.parse(dependencyId),
      versionQuerySchema.parse(query).version,
      req,
    );
  }

  @Get("baselines")
  @ApiOperation({
    operationId: "listScheduleBaselines",
    summary: "Frozen baselines, newest (current) first",
    description: viewNote,
  })
  @ApiOkResponse({ schema: openApi(scheduleBaselinesResponseSchema) })
  async listBaselines(@Param("projectId") projectId: string, @Req() req: Request) {
    return this.baselines.list(await this.auth.principal(req), uuidSchema.parse(projectId), req);
  }

  @Post("baselines")
  @ApiOperation({
    operationId: "createScheduleBaseline",
    summary: "Freeze the current schedule as a new baseline (re-baselining keeps the old ones)",
    description: `${manageNote} Needs a name and a reason (3–500 characters). Baselines can never be changed or deleted; the newest is current. 409 schedule-empty without activities or milestones.`,
  })
  @ApiBody({ schema: openApi(createBaselineRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(scheduleBaselineResponseSchema) })
  async createBaseline(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.baselines.create(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      createBaselineRequestSchema.parse(body),
      req,
    );
  }

  @Get("baselines/:baselineId")
  @ApiOperation({
    operationId: "getScheduleBaseline",
    summary: "A baseline with its frozen items",
    description: viewNote,
  })
  @ApiOkResponse({ schema: openApi(scheduleBaselineResponseSchema) })
  @ApiNotFoundResponse({ description: "No such baseline in this project" })
  async getBaseline(
    @Param("projectId") projectId: string,
    @Param("baselineId") baselineId: string,
    @Req() req: Request,
  ) {
    return this.baselines.get(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      uuidSchema.parse(baselineId),
      req,
    );
  }

  @Get("delays")
  @ApiOperation({
    operationId: "listScheduleDelays",
    summary: "The delay log: current version of each delay, with totals by cause",
    description: viewNote,
  })
  @ApiOkResponse({ schema: openApi(scheduleDelaysResponseSchema) })
  async listDelays(@Param("projectId") projectId: string, @Req() req: Request) {
    return this.delays.list(await this.auth.principal(req), uuidSchema.parse(projectId), req);
  }

  @Post("delays")
  @ApiOperation({
    operationId: "recordScheduleDelay",
    summary: "Record a delay: cause, period, working days lost, affected activities",
    description: `${manageNote} The claim flag records the company's position for claim support; PM-Buddy makes no legal determination. Days lost (half days allowed) cannot exceed the working days in the period.`,
  })
  @ApiBody({ schema: openApi(createDelayRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(scheduleDelayResponseSchema) })
  async createDelay(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.delays.create(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      createDelayRequestSchema.parse(body),
      req,
    );
  }

  @Get("delays/:delayId")
  @ApiOperation({
    operationId: "getScheduleDelay",
    summary: "A delay with its full version history",
    description: viewNote,
  })
  @ApiOkResponse({ schema: openApi(scheduleDelayResponseSchema) })
  async getDelay(
    @Param("projectId") projectId: string,
    @Param("delayId") delayId: string,
    @Req() req: Request,
  ) {
    return this.delays.get(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      uuidSchema.parse(delayId),
      req,
    );
  }

  @Post("delays/:delayId/amend")
  @HttpCode(200)
  @ApiOperation({
    operationId: "amendScheduleDelay",
    summary: "Amend a delay: appends a new version with a reason",
    description: `${manageNote} ${versionNote} A withdrawn delay cannot change (409 delay-withdrawn).`,
  })
  @ApiBody({ schema: openApi(amendDelayRequestSchema) })
  @ApiOkResponse({ schema: openApi(scheduleDelayResponseSchema) })
  async amendDelay(
    @Param("projectId") projectId: string,
    @Param("delayId") delayId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.delays.amend(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      uuidSchema.parse(delayId),
      amendDelayRequestSchema.parse(body),
      req,
    );
  }

  @Post("delays/:delayId/withdraw")
  @HttpCode(200)
  @ApiOperation({
    operationId: "withdrawScheduleDelay",
    summary: "Withdraw a delay recorded in error: appends a final version with a reason",
    description: `${manageNote} ${versionNote}`,
  })
  @ApiBody({ schema: openApi(withdrawDelayRequestSchema) })
  @ApiOkResponse({ schema: openApi(scheduleDelayResponseSchema) })
  async withdrawDelay(
    @Param("projectId") projectId: string,
    @Param("delayId") delayId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.delays.withdraw(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      uuidSchema.parse(delayId),
      withdrawDelayRequestSchema.parse(body),
      req,
    );
  }
}
