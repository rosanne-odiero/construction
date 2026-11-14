import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  checklistTemplateResponseSchema,
  checklistTemplatesQuerySchema,
  checklistTemplatesResponseSchema,
  createChecklistTemplateRequestSchema,
  loadStarterTemplatesRequestSchema,
  loadStarterTemplatesResponseSchema,
  qualitySettingsResponseSchema,
  retireChecklistTemplateRequestSchema,
  reviseChecklistTemplateRequestSchema,
  updateQualitySettingsRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { QualitySettingsService } from "./quality-settings.service.js";
import { TemplatesService } from "./templates.service.js";

const readNote =
  "Requires one of quality.manage, site.diary, site.photos, projects.manage, reports.view or safety.manage on at least one project (or company-wide).";
const writeNote =
  "Requires quality.manage on at least one project (or company-wide). Versions are append-only: inspections keep the version they used.";

/** Company checklist templates and quality settings (D6.1). */
@ApiTags("quality")
@UseGuards(BrowserGuard)
@Controller({ path: "quality", version: "1" })
export class QualityTemplatesController {
  constructor(
    private readonly auth: AuthService,
    private readonly templates: TemplatesService,
    private readonly settings: QualitySettingsService,
  ) {}

  @Get("templates")
  @ApiOperation({
    operationId: "listChecklistTemplates",
    summary: "The company's checklist templates (current version of each)",
    description: readNote,
  })
  @ApiQuery({ name: "includeRetired", required: false, enum: ["true", "false"] })
  @ApiOkResponse({ schema: openApi(checklistTemplatesResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.templates.list(
      await this.auth.principal(req),
      checklistTemplatesQuerySchema.parse(query).includeRetired === "true",
      req,
    );
  }

  @Post("templates")
  @ApiOperation({
    operationId: "createChecklistTemplate",
    summary: "Create a checklist template (version 1)",
    description: `${writeNote} 1–60 items of 3–300 characters.`,
  })
  @ApiBody({ schema: openApi(createChecklistTemplateRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(checklistTemplateResponseSchema) })
  async create(@Body() body: unknown, @Req() req: Request) {
    return this.templates.create(
      await this.auth.principal(req),
      createChecklistTemplateRequestSchema.parse(body),
      req,
    );
  }

  @Post("templates/starter")
  @ApiOperation({
    operationId: "loadStarterChecklistTemplates",
    summary: "Load the starter templates (setting out, foundations, slab, walling, roofing…)",
    description: `${writeNote} In English or Kiswahili; templates whose name already exists are skipped. Synthetic defaults to be revised to the company's specification.`,
  })
  @ApiBody({ schema: openApi(loadStarterTemplatesRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(loadStarterTemplatesResponseSchema) })
  async starter(@Body() body: unknown, @Req() req: Request) {
    const { language } = loadStarterTemplatesRequestSchema.parse(body);
    return loadStarterTemplatesResponseSchema.parse({
      created: await this.templates.loadStarter(await this.auth.principal(req), language, req),
    });
  }

  @Get("templates/:templateId")
  @ApiOperation({
    operationId: "getChecklistTemplate",
    summary: "A template version with its items and the lineage's other versions",
    description: readNote,
  })
  @ApiOkResponse({ schema: openApi(checklistTemplateResponseSchema) })
  async get(@Param("templateId") templateId: string, @Req() req: Request) {
    return this.templates.get(await this.auth.principal(req), uuidSchema.parse(templateId), req);
  }

  @Post("templates/:templateId/versions")
  @ApiOperation({
    operationId: "reviseChecklistTemplate",
    summary: "Append the next version of a template",
    description: `${writeNote} expectedVersion must be the newest version (409 version-conflict); retired templates cannot be revised (409 template-retired).`,
  })
  @ApiBody({ schema: openApi(reviseChecklistTemplateRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(checklistTemplateResponseSchema) })
  async revise(
    @Param("templateId") templateId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.templates.revise(
      await this.auth.principal(req),
      uuidSchema.parse(templateId),
      reviseChecklistTemplateRequestSchema.parse(body),
      req,
    );
  }

  @Post("templates/:templateId/retire")
  @ApiOperation({
    operationId: "retireChecklistTemplate",
    summary: "Retire a template (appends a retired version; no new inspections from it)",
    description: `${writeNote} Existing inspections are unaffected.`,
  })
  @ApiBody({ schema: openApi(retireChecklistTemplateRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(checklistTemplateResponseSchema) })
  async retire(
    @Param("templateId") templateId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.templates.retire(
      await this.auth.principal(req),
      uuidSchema.parse(templateId),
      retireChecklistTemplateRequestSchema.parse(body).expectedVersion,
      req,
    );
  }

  @Get("settings")
  @ApiOperation({
    operationId: "getQualitySettings",
    summary: "Default defects liability period and cube grace days",
    description: `${readNote} Or config.manage. Version 0 means the defaults (DLP 6 months, 2 grace days).`,
  })
  @ApiOkResponse({ schema: openApi(qualitySettingsResponseSchema) })
  async getSettings(@Req() req: Request) {
    return this.settings.getSettings(await this.auth.principal(req), req);
  }

  @Put("settings")
  @ApiOperation({
    operationId: "updateQualitySettings",
    summary: "Change the default DLP (1–24 months) and cube grace days (0–14)",
    description:
      "Requires config.manage. Send the version you read (0 for the defaults); 409 version-conflict otherwise. Existing certificates keep their DLP.",
  })
  @ApiBody({ schema: openApi(updateQualitySettingsRequestSchema) })
  @ApiOkResponse({ schema: openApi(qualitySettingsResponseSchema) })
  async updateSettings(@Body() body: unknown, @Req() req: Request) {
    return this.settings.updateSettings(
      await this.auth.principal(req),
      updateQualitySettingsRequestSchema.parse(body),
      req,
    );
  }
}
