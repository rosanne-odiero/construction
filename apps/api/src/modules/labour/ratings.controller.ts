import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  createRatingRequestSchema,
  labourerRatingsQuerySchema,
  labourerRatingsResponseSchema,
  ratingProjectsResponseSchema,
  ratingResponseSchema,
  ratingSheetQuerySchema,
  ratingSheetResponseSchema,
  updateRatingRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { LabourRatingsService } from "./ratings.service.js";

const ratingResponse = { schema: openApi(ratingResponseSchema) };

/** Worker ratings (D3.5): rate a project day's workers, correct a rating, read a worker's ratings. */
@ApiTags("labour")
@UseGuards(BrowserGuard)
@Controller({ path: "labour", version: "1" })
export class LabourRatingsController {
  constructor(
    private readonly auth: AuthService,
    private readonly ratings: LabourRatingsService,
  ) {}

  @Get("ratings/projects")
  @ApiOperation({
    summary: "Projects where the caller may rate workers",
    description:
      "Requires labour.rate somewhere. Closed and cancelled projects are left out. `window` is the range of days that can be rated today: today and the six days before (Africa/Nairobi).",
    operationId: "listRatingProjects",
  })
  @ApiOkResponse({ schema: openApi(ratingProjectsResponseSchema) })
  async projects(@Req() req: Request) {
    return this.ratings.projects(await this.auth.principal(req), req);
  }

  @Get("projects/:projectId/ratings")
  @ApiOperation({
    summary: "A project day's rating sheet: the workers who worked and their ratings",
    description:
      "Requires labour.rate on the project. `date` defaults to today (Africa/Nairobi); a future day is 400 date-in-future. Lists the workers that attendance records as present or half day on any of the project's sites that day.",
    operationId: "getRatingSheet",
  })
  @ApiQuery({ name: "date", required: false })
  @ApiOkResponse({ schema: openApi(ratingSheetResponseSchema) })
  async sheet(@Param("projectId") projectId: string, @Query() query: unknown, @Req() req: Request) {
    return this.ratings.sheet(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      ratingSheetQuerySchema.parse(query),
      req,
    );
  }

  @Post("projects/:projectId/ratings")
  @ApiOperation({
    summary: "Rate a worker's day on the project (1–5 for punctuality, quality, safety, teamwork)",
    description:
      "Requires labour.rate on the project, which must not be closed or cancelled (409 project-read-only). 400 date-in-future. 409 rating-window (only today and the six days before), not-worked (attendance does not record the worker as present or half day on the project that day), already-rated (one rating per worker, project and day) or self-rating (the caller signs in with the worker's registered phone number). The worker sees the scores and comment in their portal, not who rated them.",
    operationId: "createRating",
  })
  @ApiBody({ schema: openApi(createRatingRequestSchema) })
  @ApiCreatedResponse(ratingResponse)
  @ApiConflictResponse({
    description: "project-read-only, rating-window, not-worked, already-rated, self-rating",
  })
  async create(@Param("projectId") projectId: string, @Body() body: unknown, @Req() req: Request) {
    return this.ratings.create(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      createRatingRequestSchema.parse(body),
      req,
    );
  }

  @Patch("ratings/:id")
  @ApiOperation({
    summary: "Correct a rating's scores or comment",
    description:
      "Requires labour.rate on the rating's project. Only the person who gave the rating, on the Nairobi day they gave it (409 rating-locked). Send the version you read (409 version-conflict).",
    operationId: "updateRating",
  })
  @ApiBody({ schema: openApi(updateRatingRequestSchema) })
  @ApiOkResponse(ratingResponse)
  @ApiConflictResponse({ description: "rating-locked, version-conflict, project-read-only" })
  async update(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.ratings.update(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      updateRatingRequestSchema.parse(body),
      req,
    );
  }

  @Get("labourers/:id/ratings")
  @ApiOperation({
    summary: "A worker's ratings and averages",
    description:
      "Requires labour.view on a project the labourer is (or was) engaged on, or a company-wide role; labourers the caller cannot view are 404. Only ratings on projects where the caller holds labour.view count. The summary covers every matching rating; the list holds the newest `limit` (default 20, at most 100).",
    operationId: "listLabourerRatings",
  })
  @ApiQuery({ name: "projectId", required: false })
  @ApiQuery({ name: "from", required: false })
  @ApiQuery({ name: "to", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiOkResponse({ schema: openApi(labourerRatingsResponseSchema) })
  async history(@Param("id") id: string, @Query() query: unknown, @Req() req: Request) {
    return this.ratings.history(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      labourerRatingsQuerySchema.parse(query),
      req,
    );
  }
}
