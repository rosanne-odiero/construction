import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  approvalQueueQuerySchema,
  approvalQueueResponseSchema,
  approveMeasurementRequestSchema,
  createMeasurementRequestSchema,
  idempotencyKeySchema,
  measurementDetailResponseSchema,
  measurementItemsQuerySchema,
  measurementItemsResponseSchema,
  measurementListQuerySchema,
  measurementPhotosRequestSchema,
  measurementResponseSchema,
  measurementsResponseSchema,
  rejectMeasurementRequestSchema,
} from "@pm-buddy/validation";
import type { Request, Response } from "express";
import { openApi } from "../../../common/openapi.js";
import { AuthService } from "../../identity/auth.service.js";
import { BrowserGuard } from "../../identity/identity.controller.js";
import { uuidSchema } from "../../identity/identity.schemas.js";
import { valuationProblem } from "../valuations/valuation-common.js";
import { MeasurementsService } from "./measurements.service.js";

const readNote =
  "One of bq.edit, site.diary, projects.manage, stores.manage, procurement.requisition, procurement.approve, finance.view or finance.manage on the project (role ∩ assignment). bq.view alone (client, consultant) is refused.";
const id = (value: string) => uuidSchema.parse(value);

/** An optional Idempotency-Key (the site app sends one per record; the web may omit it). */
function optionalKey(req: Request): string | undefined {
  const raw = req.headers["idempotency-key"];
  if (raw === undefined) return undefined;
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success)
    throw valuationProblem(
      400,
      "idempotency-key-required",
      "An Idempotency-Key has 8–100 letters, digits or ._:-",
    );
  return parsed.data;
}

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
    summary: "Progress measurements of the project (newest first) with state, value and evidence",
    description: readNote,
  })
  @ApiQuery({ name: "bqItemLineageId", required: false })
  @ApiQuery({ name: "state", required: false })
  @ApiOkResponse({ schema: openApi(measurementsResponseSchema) })
  async list(@Param("projectId") projectId: string, @Query() query: unknown, @Req() req: Request) {
    return this.measurements.list(
      await this.auth.principal(req),
      id(projectId),
      measurementListQuerySchema.parse(query),
      req,
    );
  }

  @Get("items")
  @ApiOperation({
    operationId: "listMeasurementItems",
    summary:
      "The measurement sheet: items of the BQ in force with the approved quantity, % complete and value to date",
    description: `${readNote} Searched and paged on the server.`,
  })
  @ApiOkResponse({ schema: openApi(measurementItemsResponseSchema) })
  async items(@Param("projectId") projectId: string, @Query() query: unknown, @Req() req: Request) {
    return this.measurements.items(
      await this.auth.principal(req),
      id(projectId),
      measurementItemsQuerySchema.parse(query),
      req,
    );
  }

  @Post()
  @ApiOperation({
    operationId: "recordProgressMeasurement",
    summary:
      "Record the quantity done to date of a BQ item (percent complete for a lump sum), with site photos; recording submits it for review",
    description:
      "site.diary or bq.edit on the project. Provisional sums, PC sums and contingencies are refused (422 item-not-measurable); above the BQ quantity needs overMeasureReason (422 over-measure-reason-required); a lump sum is at most 100 % (422 percent-over-100). A correction names the measurement it corrects (same item and date) with a reason. Offline-ready: optional client id + Idempotency-Key (replay returns the original with Idempotency-Replayed: true; a changed payload is 409 idempotency-key-reused).",
  })
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiBody({ schema: openApi(createMeasurementRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(measurementResponseSchema) })
  async record(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = optionalKey(req);
    const result = await this.measurements.record(
      await this.auth.principal(req),
      id(projectId),
      createMeasurementRequestSchema.parse(body),
      req,
      key,
    );
    if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
    return result;
  }

  @Get(":measurementId")
  @ApiOperation({
    operationId: "getProgressMeasurement",
    summary: "A measurement with its evidence, review and the item's measurement history",
    description: readNote,
  })
  @ApiOkResponse({ schema: openApi(measurementDetailResponseSchema) })
  async get(
    @Param("projectId") projectId: string,
    @Param("measurementId") measurementId: string,
    @Req() req: Request,
  ) {
    return this.measurements.get(
      await this.auth.principal(req),
      id(projectId),
      id(measurementId),
      req,
    );
  }

  @Post(":measurementId/photos")
  @HttpCode(200)
  @ApiOperation({
    operationId: "addMeasurementPhotos",
    summary: "Add site photos of the project as evidence while the measurement waits for review",
    description:
      "site.diary or bq.edit; at most six photos (409 too-many-photos); 409 measurement-not-pending once reviewed or corrected.",
  })
  @ApiBody({ schema: openApi(measurementPhotosRequestSchema) })
  @ApiOkResponse({ schema: openApi(measurementResponseSchema) })
  async addPhotos(
    @Param("projectId") projectId: string,
    @Param("measurementId") measurementId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.measurements.addPhotos(
      await this.auth.principal(req),
      id(projectId),
      id(measurementId),
      measurementPhotosRequestSchema.parse(body).photoIds,
      req,
    );
  }

  @Post(":measurementId/approve")
  @HttpCode(200)
  @ApiOperation({
    operationId: "approveProgressMeasurement",
    summary: "Approve a pending measurement: it then counts towards value of work done",
    description:
      "bq.edit on the project; never the measurer (403 maker-checker); needs at least one photo (409 measurement-evidence-required).",
  })
  @ApiBody({ schema: openApi(approveMeasurementRequestSchema) })
  @ApiOkResponse({ schema: openApi(measurementResponseSchema) })
  async approve(
    @Param("projectId") projectId: string,
    @Param("measurementId") measurementId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    approveMeasurementRequestSchema.parse(body ?? {});
    return this.measurements.decide(
      await this.auth.principal(req),
      id(projectId),
      id(measurementId),
      "approved",
      null,
      req,
    );
  }

  @Post(":measurementId/reject")
  @HttpCode(200)
  @ApiOperation({
    operationId: "rejectProgressMeasurement",
    summary: "Reject a pending measurement with a reason (it never counts)",
    description: "bq.edit on the project; never the measurer (403 maker-checker).",
  })
  @ApiBody({ schema: openApi(rejectMeasurementRequestSchema) })
  @ApiOkResponse({ schema: openApi(measurementResponseSchema) })
  async reject(
    @Param("projectId") projectId: string,
    @Param("measurementId") measurementId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.measurements.decide(
      await this.auth.principal(req),
      id(projectId),
      id(measurementId),
      "rejected",
      rejectMeasurementRequestSchema.parse(body).reason,
      req,
    );
  }
}

@ApiTags("progress")
@UseGuards(BrowserGuard)
@Controller({ path: "measurements", version: "1" })
export class MeasurementQueueController {
  constructor(
    private readonly auth: AuthService,
    private readonly measurements: MeasurementsService,
  ) {}

  @Get("pending")
  @ApiOperation({
    operationId: "listPendingMeasurements",
    summary: "The approval queue: pending measurements on projects where you review measurements",
    description:
      "bq.edit on the project. Your own measurements are listed but cannot be approved by you.",
  })
  @ApiQuery({ name: "projectId", required: false })
  @ApiOkResponse({ schema: openApi(approvalQueueResponseSchema) })
  async pending(@Query() query: unknown, @Req() req: Request) {
    return this.measurements.queue(
      await this.auth.principal(req),
      approvalQueueQuerySchema.parse(query).projectId,
      req,
    );
  }
}
