import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  createDiaryRequestSchema,
  diariesResponseSchema,
  diaryAttendanceQuerySchema,
  diaryAttendanceResponseSchema,
  diaryActionRequestSchema,
  diaryListQuerySchema,
  diaryResponseSchema,
  updateDiaryRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { DiariesService } from "./diaries.service.js";

@ApiTags("progress")
@UseGuards(BrowserGuard)
@Controller({ path: "projects/:projectId/diaries", version: "1" })
export class DiariesController {
  constructor(
    private readonly auth: AuthService,
    private readonly diaries: DiariesService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: "listSiteDiaries",
    summary:
      "Site diaries, newest created first; projects.view plus site.diary, quality.manage, projects.manage or reports.view (clients see approved diaries in their portal)",
  })
  @ApiOkResponse({ schema: openApi(diariesResponseSchema) })
  @ApiQuery({ name: "siteId", required: false, description: "Filter to one site" })
  @ApiQuery({ name: "cursor", required: false, description: "nextCursor from the preceding page" })
  @ApiQuery({ name: "limit", required: false, description: "1–100 records; defaults to 30" })
  async list(@Param("projectId") projectId: string, @Query() query: unknown, @Req() req: Request) {
    return this.diaries.list(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      diaryListQuerySchema.parse(query),
      req,
    );
  }

  @Get("attendance")
  @ApiOperation({
    operationId: "getDiaryAttendance",
    summary:
      "Attendance on a site and date by trade (present or half day), with the muster sheet's state: what a diary's attendance snapshot would store",
    description:
      "Requires projects.view plus site.diary, quality.manage, projects.manage or reports.view on the project.",
  })
  @ApiQuery({ name: "siteId", required: true })
  @ApiQuery({ name: "date", required: true, description: "YYYY-MM-DD (Africa/Nairobi)" })
  @ApiOkResponse({ schema: openApi(diaryAttendanceResponseSchema) })
  async attendance(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.diaries.attendance(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      diaryAttendanceQuerySchema.parse(query),
      req,
    );
  }

  @Post()
  @ApiOperation({
    operationId: "createSiteDiary",
    summary:
      "Create a daily site draft; site.diary required. Workforce is a manual count (workforceSource manual) or a server snapshot of attendance by trade (workforceSource attendance; the count is not sent).",
  })
  @ApiBody({ schema: openApi(createDiaryRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(diaryResponseSchema) })
  async create(@Param("projectId") projectId: string, @Body() body: unknown, @Req() req: Request) {
    return this.diaries.create(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      createDiaryRequestSchema.parse(body),
      req,
    );
  }

  @Patch(":id")
  @ApiOperation({
    operationId: "updateSiteDiary",
    summary:
      "Replace draft content with an expected version; author and site.diary required. workforceSource attendance takes a fresh attendance snapshot.",
  })
  @ApiBody({ schema: openApi(updateDiaryRequestSchema) })
  @ApiOkResponse({ schema: openApi(diaryResponseSchema) })
  async update(
    @Param("projectId") projectId: string,
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.diaries.update(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      uuidSchema.parse(id),
      updateDiaryRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/actions")
  @HttpCode(200)
  @ApiOperation({
    operationId: "transitionSiteDiary",
    summary:
      "Submit/reopen as author (site.diary), or independently approve/reject (quality.manage). Submitting an attendance-sourced diary refreshes its snapshot first (the version advances by two). Approval locks the diary and its workforce snapshot.",
  })
  @ApiBody({ schema: openApi(diaryActionRequestSchema) })
  @ApiOkResponse({ schema: openApi(diaryResponseSchema) })
  async action(
    @Param("projectId") projectId: string,
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.diaries.action(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      uuidSchema.parse(id),
      diaryActionRequestSchema.parse(body),
      req,
    );
  }
}
