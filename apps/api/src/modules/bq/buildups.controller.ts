import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import {
  buildupResponseSchema,
  buildupsResponseSchema,
  buildupVersionResponseSchema,
  createBuildupRequestSchema,
  updateBuildupRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { z } from "zod";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { BuildupsService } from "./buildups.service.js";

const viewNote =
  "Requires bq.view held company-wide or on at least one assigned project (the library is shared by the company).";
const editNote =
  "Requires bq.edit held company-wide or on at least one assigned project. Editing appends a version; links keep their version.";
const versionNoSchema = z.coerce.number().int().min(1).max(2_147_483_647);

/** The company's rate build-up library (D2.3, ARCHITECTURE §4.3). */
@ApiTags("bq")
@UseGuards(BrowserGuard)
@Controller({ path: "rate-buildups", version: "1" })
export class BuildupsController {
  constructor(
    private readonly auth: AuthService,
    private readonly buildups: BuildupsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "The company's rate build-ups with their current rate",
    description: viewNote,
    operationId: "listRateBuildups",
  })
  @ApiOkResponse({ schema: openApi(buildupsResponseSchema) })
  async list(@Req() req: Request) {
    return this.buildups.list(await this.auth.principal(req), req);
  }

  @Post()
  @ApiOperation({
    summary: "Create a build-up (version 1) with its resource lines",
    description: `${editNote} 409 buildup-code-taken.`,
    operationId: "createRateBuildup",
  })
  @ApiBody({ schema: openApi(createBuildupRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(buildupResponseSchema) })
  @ApiConflictResponse({ description: "Code already used in this company" })
  async create(@Body() body: unknown, @Req() req: Request) {
    return this.buildups.create(
      await this.auth.principal(req),
      createBuildupRequestSchema.parse(body),
      req,
    );
  }

  @Get(":buildupId")
  @ApiOperation({
    summary: "A build-up: current version with lines and rate, and its version history",
    description: viewNote,
    operationId: "getRateBuildup",
  })
  @ApiOkResponse({ schema: openApi(buildupResponseSchema) })
  async get(@Param("buildupId") buildupId: string, @Req() req: Request) {
    return this.buildups.get(await this.auth.principal(req), uuidSchema.parse(buildupId), req);
  }

  @Put(":buildupId")
  @ApiOperation({
    summary: "Edit a build-up: appends a new version",
    description: `${editNote} Send the build-up's version; a newer one is a 409 version-conflict.`,
    operationId: "updateRateBuildup",
  })
  @ApiBody({ schema: openApi(updateBuildupRequestSchema) })
  @ApiOkResponse({ schema: openApi(buildupResponseSchema) })
  async update(@Param("buildupId") buildupId: string, @Body() body: unknown, @Req() req: Request) {
    return this.buildups.update(
      await this.auth.principal(req),
      uuidSchema.parse(buildupId),
      updateBuildupRequestSchema.parse(body),
      req,
    );
  }

  @Get(":buildupId/versions/:versionNo")
  @ApiOperation({
    summary: "One version of a build-up (as linked items see it)",
    description: viewNote,
    operationId: "getRateBuildupVersion",
  })
  @ApiOkResponse({ schema: openApi(buildupVersionResponseSchema) })
  async version(
    @Param("buildupId") buildupId: string,
    @Param("versionNo") versionNo: string,
    @Req() req: Request,
  ) {
    return this.buildups.version(
      await this.auth.principal(req),
      uuidSchema.parse(buildupId),
      versionNoSchema.parse(versionNo),
      req,
    );
  }
}
