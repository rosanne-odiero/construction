import { Body, Controller, Get, Put, Req, UseGuards, UseInterceptors } from "@nestjs/common";
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  safetyOverviewResponseSchema,
  safetySettingsResponseSchema,
  updateSafetySettingsRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { SafetySettingsService } from "./safety-settings.service.js";
import { SafetyDatabaseErrors } from "./safety-errors.js";

/** Company health and safety settings and the overview across projects (D8.2). */
@ApiTags("safety")
@UseGuards(BrowserGuard)
@Controller({ path: "safety", version: "1" })
@UseInterceptors(SafetyDatabaseErrors)
export class SafetyCompanyController {
  constructor(
    private readonly auth: AuthService,
    private readonly settings: SafetySettingsService,
  ) {}

  @Get("settings")
  @ApiOperation({
    operationId: "getSafetySettings",
    summary: "The company's induction checklist, validity, look-back, kit and PPE periods",
    description:
      "Readable with config.manage, or with safety.manage, site.diary or projects.manage on at least one project (or company-wide). Version 0 means the defaults are in use.",
  })
  @ApiOkResponse({ schema: openApi(safetySettingsResponseSchema) })
  async getSettings(@Req() req: Request) {
    return this.settings.getSettings(await this.auth.principal(req), req);
  }

  @Put("settings")
  @ApiOperation({
    operationId: "updateSafetySettings",
    summary: "Change the company's safety settings",
    description:
      "Requires config.manage. Send the version you read (0 for the defaults); a newer one is a 409 version-conflict. Starter topics keep a null label (translated on screen); topics the company adds need one. Existing inductions keep the topics they recorded and PPE issues keep their replacement date.",
  })
  @ApiBody({ schema: openApi(updateSafetySettingsRequestSchema) })
  @ApiOkResponse({ schema: openApi(safetySettingsResponseSchema) })
  async updateSettings(@Body() body: unknown, @Req() req: Request) {
    return this.settings.updateSettings(
      await this.auth.principal(req),
      updateSafetySettingsRequestSchema.parse(body),
      req,
    );
  }

  @Get("overview")
  @ApiOperation({
    operationId: "getSafetyOverview",
    summary: "Projects whose safety records the caller can read, with headline counts",
    description:
      "Projects where the caller holds projects.view and one of safety.manage, site.diary or projects.manage (role ∩ assignment): open incidents, overdue corrective actions, labourers flagged for working without an induction, PPE due for replacement and first-aid kits needing attention.",
  })
  @ApiOkResponse({ schema: openApi(safetyOverviewResponseSchema) })
  async overview(@Req() req: Request) {
    return this.settings.overview(await this.auth.principal(req), req);
  }
}
