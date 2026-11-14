import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  createMeasurementRequestSchema,
  measurementListQuerySchema,
  measurementResponseSchema,
  measurementsResponseSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../../common/openapi.js";
import { AuthService } from "../../identity/auth.service.js";
import { BrowserGuard } from "../../identity/identity.controller.js";
import { uuidSchema } from "../../identity/identity.schemas.js";
import { MeasurementsService } from "./measurements.service.js";

@ApiTags("progress")
@UseGuards(BrowserGuard)
@Controller({ path: "projects/:projectId/measurements", version: "1" })
export class MeasurementsController {
  constructor(
    private readonly auth: AuthService,
    private readonly measurements: MeasurementsService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: "listProgressMeasurements",
    summary:
      "Progress measurements (quantity completed to date per BQ item), newest first; bq.view, bq.edit or a stores reader on the project",
  })
  @ApiQuery({ name: "bqItemLineageId", required: false })
  @ApiOkResponse({ schema: openApi(measurementsResponseSchema) })
  async list(@Param("projectId") projectId: string, @Query() query: unknown, @Req() req: Request) {
    return this.measurements.list(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      measurementListQuerySchema.parse(query).bqItemLineageId,
      req,
    );
  }

  @Post()
  @ApiOperation({
    operationId: "recordProgressMeasurement",
    summary:
      "Record the quantity completed to date of a BQ item (or correct an earlier measurement with a reason); bq.edit on the project. Append-only; D6.3 adds approval.",
  })
  @ApiBody({ schema: openApi(createMeasurementRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(measurementResponseSchema) })
  async record(@Param("projectId") projectId: string, @Body() body: unknown, @Req() req: Request) {
    return this.measurements.record(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      createMeasurementRequestSchema.parse(body),
      req,
    );
  }
}
