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

  @Post()
  @ApiOperation({
    operationId: "createSiteDiary",
    summary:
      "Create a daily site draft; site.diary required. Workforce is manually recorded, not attendance-verified.",
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
    summary: "Replace draft content with an expected version; author and site.diary required",
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
      "Submit/reopen as author (site.diary), or independently approve/reject (quality.manage). Approval locks the diary.",
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
