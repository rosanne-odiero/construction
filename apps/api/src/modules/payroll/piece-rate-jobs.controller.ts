import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import {
  createPieceRateExtensionRequestSchema,
  createPieceRateJobRequestSchema,
  pieceRateJobOptionsResponseSchema,
  pieceRateJobReasonRequestSchema,
  pieceRateJobResponseSchema,
  pieceRateJobsResponseSchema,
  pieceRateJobVersionRequestSchema,
  pieceRateReconciliationResponseSchema,
  recordJobOutputRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { PieceRateJobsService } from "./piece-rate-jobs.service.js";

const id = (value: string) => uuidSchema.parse(value);
const read =
  "Requires payroll.view, payroll.prepare, attendance.record or timesheets.approve on the project (role ∩ assignment).";
const optionalKey = {
  name: "Idempotency-Key",
  required: false,
  description:
    "Optional (8–128 letters, digits, '-' or '_'): a replay with the same payload returns the stored response; another payload under the key is 409 idempotency-key-reused.",
};

/**
 * Piece-rate jobs (D6.3 part B, decision D-147): the agreed rate and scope against a BQ item for a
 * gang or labourer, approval, extensions, output recorded against a job at its rate, and the
 * reconciliation of piece-rate pay against measured quantities.
 */
@ApiTags("payroll")
@UseGuards(BrowserGuard)
@Controller({ path: "payroll", version: "1" })
export class PieceRateJobsController {
  constructor(
    private readonly auth: AuthService,
    private readonly jobs: PieceRateJobsService,
  ) {}

  @Get("projects/:projectId/piece-rate-jobs")
  @ApiOperation({
    operationId: "listPieceRateJobs",
    summary: "A project's piece-rate jobs",
    description: read,
  })
  @ApiOkResponse({ schema: openApi(pieceRateJobsResponseSchema) })
  async list(@Param("projectId") projectId: string, @Req() req: Request) {
    return this.jobs.jobs(await this.auth.principal(req), id(projectId), req);
  }

  @Get("projects/:projectId/piece-rate-jobs/options")
  @ApiOperation({
    operationId: "pieceRateJobOptions",
    summary: "BQ items measured by quantity (with the units a job may use), gangs and labourers",
    description: "Requires payroll.prepare or labour.manage on the project.",
  })
  @ApiOkResponse({ schema: openApi(pieceRateJobOptionsResponseSchema) })
  async options(@Param("projectId") projectId: string, @Req() req: Request) {
    return this.jobs.options(await this.auth.principal(req), id(projectId), req);
  }

  @Post("projects/:projectId/piece-rate-jobs")
  @ApiOperation({
    operationId: "createPieceRateJob",
    summary: "Create a piece-rate job (pending until someone else approves it)",
    description:
      "Requires payroll.prepare or labour.manage. The unit is the BQ item's or one D5.1 converts to it exactly (400 unit-not-convertible).",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(createPieceRateJobRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(pieceRateJobResponseSchema) })
  async create(@Param("projectId") projectId: string, @Body() body: unknown, @Req() req: Request) {
    return this.jobs.create(
      await this.auth.principal(req),
      id(projectId),
      createPieceRateJobRequestSchema.parse(body),
      req,
    );
  }

  @Get("projects/:projectId/piece-rate-reconciliation")
  @ApiOperation({
    operationId: "getPieceRateReconciliation",
    summary: "Piece-rate quantities paid against approved measured quantities per BQ item",
    description:
      "Requires a piece-rate reader permission, bq.edit, finance.view or finance.manage. Items where piece-rate pay is above measured work are flagged (a review signal, never an automatic pay decision).",
  })
  @ApiOkResponse({ schema: openApi(pieceRateReconciliationResponseSchema) })
  async reconciliation(@Param("projectId") projectId: string, @Req() req: Request) {
    return this.jobs.reconciliation(await this.auth.principal(req), id(projectId), req);
  }

  @Get("piece-rate-jobs/:id")
  @ApiOperation({
    operationId: "getPieceRateJob",
    summary: "A job with its extensions and outputs",
    description: read,
  })
  @ApiOkResponse({ schema: openApi(pieceRateJobResponseSchema) })
  async get(@Param("id") jobId: string, @Req() req: Request) {
    return this.jobs.get(await this.auth.principal(req), id(jobId), req);
  }

  @Post("piece-rate-jobs/:id/approve")
  @HttpCode(200)
  @ApiOperation({
    operationId: "approvePieceRateJob",
    summary: "Approve a job",
    description: "Requires timesheets.approve; never its creator (409 same-person).",
  })
  @ApiBody({ schema: openApi(pieceRateJobVersionRequestSchema) })
  @ApiOkResponse({ schema: openApi(pieceRateJobResponseSchema) })
  async approve(@Param("id") jobId: string, @Body() body: unknown, @Req() req: Request) {
    return this.jobs.decide(
      await this.auth.principal(req),
      id(jobId),
      "approve",
      pieceRateJobVersionRequestSchema.parse(body),
      req,
    );
  }

  @Post("piece-rate-jobs/:id/reject")
  @HttpCode(200)
  @ApiOperation({
    operationId: "rejectPieceRateJob",
    summary: "Reject a job (reason)",
    description: "Requires timesheets.approve; never its creator.",
  })
  @ApiBody({ schema: openApi(pieceRateJobReasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(pieceRateJobResponseSchema) })
  async reject(@Param("id") jobId: string, @Body() body: unknown, @Req() req: Request) {
    return this.jobs.decide(
      await this.auth.principal(req),
      id(jobId),
      "reject",
      pieceRateJobReasonRequestSchema.parse(body),
      req,
    );
  }

  @Post("piece-rate-jobs/:id/close")
  @HttpCode(200)
  @ApiOperation({
    operationId: "closePieceRateJob",
    summary: "Close an approved job (no more output)",
    description: "Requires payroll.prepare or labour.manage.",
  })
  @ApiBody({ schema: openApi(pieceRateJobVersionRequestSchema) })
  @ApiOkResponse({ schema: openApi(pieceRateJobResponseSchema) })
  async close(@Param("id") jobId: string, @Body() body: unknown, @Req() req: Request) {
    return this.jobs.decide(
      await this.auth.principal(req),
      id(jobId),
      "close",
      pieceRateJobVersionRequestSchema.parse(body),
      req,
    );
  }

  @Post("piece-rate-jobs/:id/extensions")
  @ApiOperation({
    operationId: "requestPieceRateExtension",
    summary: "Ask to extend an approved job's agreed quantity (reason)",
    description: "Requires payroll.prepare or labour.manage.",
  })
  @ApiBody({ schema: openApi(createPieceRateExtensionRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(pieceRateJobResponseSchema) })
  async extend(@Param("id") jobId: string, @Body() body: unknown, @Req() req: Request) {
    return this.jobs.requestExtension(
      await this.auth.principal(req),
      id(jobId),
      createPieceRateExtensionRequestSchema.parse(body),
      req,
    );
  }

  @Post("piece-rate-jobs/:id/extensions/:extensionId/approve")
  @HttpCode(200)
  @ApiOperation({
    operationId: "approvePieceRateExtension",
    summary: "Approve an extension",
    description: "Requires timesheets.approve; never the person who asked.",
  })
  @ApiBody({ schema: openApi(pieceRateJobVersionRequestSchema) })
  @ApiOkResponse({ schema: openApi(pieceRateJobResponseSchema) })
  async approveExtension(
    @Param("id") jobId: string,
    @Param("extensionId") extensionId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.jobs.decideExtension(
      await this.auth.principal(req),
      id(jobId),
      id(extensionId),
      "approve",
      pieceRateJobVersionRequestSchema.parse(body),
      req,
    );
  }

  @Post("piece-rate-jobs/:id/extensions/:extensionId/reject")
  @HttpCode(200)
  @ApiOperation({
    operationId: "rejectPieceRateExtension",
    summary: "Reject an extension (reason)",
    description: "Requires timesheets.approve; never the person who asked.",
  })
  @ApiBody({ schema: openApi(pieceRateJobReasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(pieceRateJobResponseSchema) })
  async rejectExtension(
    @Param("id") jobId: string,
    @Param("extensionId") extensionId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.jobs.decideExtension(
      await this.auth.principal(req),
      id(jobId),
      id(extensionId),
      "reject",
      pieceRateJobReasonRequestSchema.parse(body),
      req,
    );
  }

  @Post("piece-rate-jobs/:id/outputs")
  @ApiOperation({
    operationId: "recordPieceRateJobOutput",
    summary: "Record output against an approved job at the job's rate",
    description:
      "Requires attendance.record or payroll.prepare. Only the day and quantity are sent: the rate, unit, worker and BQ item are the job's. Recorded output never takes the job above its agreed quantity plus approved extensions (409 job-quantity-exceeded). Approval stays the D4.1 output approval (POST payroll/outputs/:id/approve), which checks the approved quantity again.",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(recordJobOutputRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(pieceRateJobResponseSchema) })
  async output(@Param("id") jobId: string, @Body() body: unknown, @Req() req: Request) {
    return this.jobs.recordOutput(
      await this.auth.principal(req),
      id(jobId),
      recordJobOutputRequestSchema.parse(body),
      req,
    );
  }
}
