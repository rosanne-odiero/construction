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
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  addValuationAdjustmentRequestSchema,
  addValuationMaterialRequestSchema,
  certifyValuationRequestSchema,
  contractSettingsResponseSchema,
  costToCompleteQuerySchema,
  costToCompleteResponseSchema,
  createValuationRequestSchema,
  earnedValueQuerySchema,
  earnedValueResponseSchema,
  projectValuationsResponseSchema,
  updateContractSettingsRequestSchema,
  updateValuationRequestSchema,
  valuationExportQuerySchema,
  valuationReasonRequestSchema,
  valuationResponseSchema,
  valuationsOverviewResponseSchema,
  valuationVersionQuerySchema,
  valuationVersionRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../../common/openapi.js";
import { AuthService } from "../../identity/auth.service.js";
import { BrowserGuard } from "../../identity/identity.controller.js";
import { uuidSchema } from "../../identity/identity.schemas.js";
import { CertificateExportService } from "./certificate-export.service.js";
import { EarnedValueService } from "./earned-value.service.js";
import { ValuationsService } from "./valuations.service.js";

const readNote =
  "bq.edit, finance.view or finance.manage on the project (role ∩ assignment); clients, suppliers, consultants and site agents are refused.";
const prepareNote =
  "bq.edit on the project; only a draft (409 invalid-transition) on the version read.";
const evmNote =
  "finance.view or finance.manage on the project (the figures include the cost ledger).";
const id = (value: string) => uuidSchema.parse(value);

@ApiTags("valuations")
@UseGuards(BrowserGuard)
@Controller({ path: "projects/:projectId", version: "1" })
export class ProjectValuationsController {
  constructor(
    private readonly auth: AuthService,
    private readonly valuations: ValuationsService,
    private readonly earned: EarnedValueService,
  ) {}

  @Get("valuations")
  @ApiOperation({
    operationId: "listProjectValuations",
    summary:
      "A project's valuations and certificates, the retention ledger, contract settings and completions",
    description: readNote,
  })
  @ApiOkResponse({ schema: openApi(projectValuationsResponseSchema) })
  async list(@Param("projectId") projectId: string, @Req() req: Request) {
    return this.valuations.projectView(await this.auth.principal(req), id(projectId), req);
  }

  @Post("valuations")
  @ApiOperation({
    operationId: "createValuation",
    summary: "Start an interim valuation or a retention release (VAL-NNNN draft)",
    description:
      "bq.edit on the project. One valuation in preparation per project (409 valuation-open); dated on or after the last certificate, never in the future (409 valuation-date-invalid). A release needs the certified practical or final completion (409 completion-not-certified), retention held (409 nothing-to-release) and no earlier release of that stage (409 release-exists).",
  })
  @ApiBody({ schema: openApi(createValuationRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(valuationResponseSchema) })
  async create(@Param("projectId") projectId: string, @Body() body: unknown, @Req() req: Request) {
    return this.valuations.create(
      await this.auth.principal(req),
      id(projectId),
      createValuationRequestSchema.parse(body),
      req,
    );
  }

  @Put("contract-settings")
  @ApiOperation({
    operationId: "updateContractSettings",
    summary: "New version of the retention, limit, VAT, materials-on-site and release terms",
    description:
      "finance.manage on the project, on the settings version read (0 = defaults; 409 version-conflict). Certificates keep the version they used.",
  })
  @ApiBody({ schema: openApi(updateContractSettingsRequestSchema) })
  @ApiOkResponse({ schema: openApi(contractSettingsResponseSchema) })
  async settings(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.valuations.updateSettings(
      await this.auth.principal(req),
      id(projectId),
      updateContractSettingsRequestSchema.parse(body),
      req,
    );
  }

  @Get("earned-value")
  @ApiOperation({
    operationId: "getEarnedValue",
    summary:
      "Earned value (BAC, PV, EV, AC, CV, SV, CPI, SPI, EAC, ETC, VAC) and the weekly S-curve at a data date",
    description: `${evmNote} Undefined ratios are null (unavailable).`,
  })
  @ApiQuery({ name: "asOf", required: false })
  @ApiOkResponse({ schema: openApi(earnedValueResponseSchema) })
  async earnedValue(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.earned.earnedValue(
      await this.auth.principal(req),
      id(projectId),
      earnedValueQuerySchema.parse(query).asOf,
      req,
    );
  }

  @Get("cost-to-complete")
  @ApiOperation({
    operationId: "getCostToComplete",
    summary:
      "Budget, actual, earned value and estimate to complete per bill, and per BQ item of one bill",
    description: `${evmNote} Items are listed for billLineageId (searched and paged).`,
  })
  @ApiOkResponse({ schema: openApi(costToCompleteResponseSchema) })
  async costToComplete(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.earned.costToComplete(
      await this.auth.principal(req),
      id(projectId),
      costToCompleteQuerySchema.parse(query),
      req,
    );
  }
}

@ApiTags("valuations")
@UseGuards(BrowserGuard)
@Controller({ path: "valuations", version: "1" })
export class ValuationsController {
  constructor(
    private readonly auth: AuthService,
    private readonly valuations: ValuationsService,
    private readonly exports: CertificateExportService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: "listValuationProjects",
    summary:
      "Projects where you measure or read valuations: certificates to date, retention held and pending measurements",
    description:
      "Measurement readers see their projects' measurement counts; valuation readers (bq.edit, finance.view, finance.manage) also see certificate figures.",
  })
  @ApiOkResponse({ schema: openApi(valuationsOverviewResponseSchema) })
  async overview(@Req() req: Request) {
    return this.valuations.overview(await this.auth.principal(req), req);
  }

  @Get(":id")
  @ApiOperation({
    operationId: "getValuation",
    summary:
      "A valuation with its certificate breakdown: frozen figures once submitted, a live preview while a draft",
    description: readNote,
  })
  @ApiOkResponse({ schema: openApi(valuationResponseSchema) })
  async get(@Param("id") valuationId: string, @Req() req: Request) {
    return this.valuations.get(await this.auth.principal(req), id(valuationId), req);
  }

  @Patch(":id")
  @ApiOperation({
    operationId: "updateValuation",
    summary: "Change a draft's valuation date, notes or materials-from-stores choice",
    description: prepareNote,
  })
  @ApiBody({ schema: openApi(updateValuationRequestSchema) })
  @ApiOkResponse({ schema: openApi(valuationResponseSchema) })
  async update(@Param("id") valuationId: string, @Body() body: unknown, @Req() req: Request) {
    return this.valuations.update(
      await this.auth.principal(req),
      id(valuationId),
      updateValuationRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/materials")
  @HttpCode(200)
  @ApiOperation({
    operationId: "addValuationMaterial",
    summary: "Enter materials on site (at cost) against a measured BQ item of an interim draft",
    description: `${prepareNote} At most 100 lines. At submission an item's materials plus its measured value may not exceed its amount (409 materials-exceed-remaining).`,
  })
  @ApiBody({ schema: openApi(addValuationMaterialRequestSchema) })
  @ApiOkResponse({ schema: openApi(valuationResponseSchema) })
  async addMaterial(@Param("id") valuationId: string, @Body() body: unknown, @Req() req: Request) {
    return this.valuations.addMaterial(
      await this.auth.principal(req),
      id(valuationId),
      addValuationMaterialRequestSchema.parse(body),
      req,
    );
  }

  @Delete(":id/materials/:lineId")
  @ApiOperation({
    operationId: "removeValuationMaterial",
    summary: "Remove an entered materials line from a draft",
    description: prepareNote,
  })
  @ApiQuery({ name: "version", required: true })
  @ApiOkResponse({ schema: openApi(valuationResponseSchema) })
  async removeMaterial(
    @Param("id") valuationId: string,
    @Param("lineId") lineId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.valuations.removeMaterial(
      await this.auth.principal(req),
      id(valuationId),
      id(lineId),
      valuationVersionQuerySchema.parse(query).version,
      req,
    );
  }

  @Post(":id/adjustments")
  @HttpCode(200)
  @ApiOperation({
    operationId: "addValuationAdjustment",
    summary: "Add an agreed adjustment (advance, advance recovery, contra charge, other)",
    description: `${prepareNote} Signs: advance positive, recovery and contra charge negative. At most 50. Recoveries never exceed the advances certified (409 recovery-exceeds-advance at submission).`,
  })
  @ApiBody({ schema: openApi(addValuationAdjustmentRequestSchema) })
  @ApiOkResponse({ schema: openApi(valuationResponseSchema) })
  async addAdjustment(
    @Param("id") valuationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.valuations.addAdjustment(
      await this.auth.principal(req),
      id(valuationId),
      addValuationAdjustmentRequestSchema.parse(body),
      req,
    );
  }

  @Delete(":id/adjustments/:adjustmentId")
  @ApiOperation({
    operationId: "removeValuationAdjustment",
    summary: "Remove an adjustment from a draft",
    description: prepareNote,
  })
  @ApiQuery({ name: "version", required: true })
  @ApiOkResponse({ schema: openApi(valuationResponseSchema) })
  async removeAdjustment(
    @Param("id") valuationId: string,
    @Param("adjustmentId") adjustmentId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.valuations.removeAdjustment(
      await this.auth.principal(req),
      id(valuationId),
      id(adjustmentId),
      valuationVersionQuerySchema.parse(query).version,
      req,
    );
  }

  @Post(":id/submit")
  @HttpCode(200)
  @ApiOperation({
    operationId: "submitValuation",
    summary: "Submit: freeze the lines and figures (next revision) with the digest to certify",
    description: `${prepareNote} 409 bq-not-approved, materials-exceed-remaining, recovery-exceeds-advance, release-exceeds-held, valuation-date-invalid.`,
  })
  @ApiBody({ schema: openApi(valuationVersionRequestSchema) })
  @ApiOkResponse({ schema: openApi(valuationResponseSchema) })
  async submit(@Param("id") valuationId: string, @Body() body: unknown, @Req() req: Request) {
    return this.valuations.submit(
      await this.auth.principal(req),
      id(valuationId),
      valuationVersionRequestSchema.parse(body).version,
      req,
    );
  }

  @Post(":id/certify")
  @HttpCode(200)
  @ApiOperation({
    operationId: "certifyValuation",
    summary: "Certify a submitted valuation: numbered IPC-NNNN, never changed again",
    description:
      "finance.manage + step-up; never anyone who prepared it (403 maker-checker); quotes the digest seen; 409 valuation-stale when the measurements, BQ, settings or earlier certificates changed since submission.",
  })
  @ApiBody({ schema: openApi(certifyValuationRequestSchema) })
  @ApiOkResponse({ schema: openApi(valuationResponseSchema) })
  async certify(@Param("id") valuationId: string, @Body() body: unknown, @Req() req: Request) {
    return this.valuations.certify(
      await this.auth.principal(req),
      id(valuationId),
      certifyValuationRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/return")
  @HttpCode(200)
  @ApiOperation({
    operationId: "returnValuation",
    summary: "Return a submitted valuation to draft with a reason (its figures are cleared)",
    description: "finance.manage on the project.",
  })
  @ApiBody({ schema: openApi(valuationReasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(valuationResponseSchema) })
  async returnValuation(
    @Param("id") valuationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.valuations.decide(
      await this.auth.principal(req),
      id(valuationId),
      "return",
      valuationReasonRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({
    operationId: "cancelValuation",
    summary: "Cancel a draft or submitted valuation with a reason (a certified one never)",
    description: "bq.edit or finance.manage on the project.",
  })
  @ApiBody({ schema: openApi(valuationReasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(valuationResponseSchema) })
  async cancel(@Param("id") valuationId: string, @Body() body: unknown, @Req() req: Request) {
    return this.valuations.decide(
      await this.auth.principal(req),
      id(valuationId),
      "cancel",
      valuationReasonRequestSchema.parse(body),
      req,
    );
  }

  @Get(":id/export/pdf")
  @ApiOperation({
    operationId: "exportValuationPdf",
    summary: "The payment certificate as an A4 PDF (EN or SW); not certified = watermarked",
    description: `${readNote} Generated on demand; rate limited.`,
  })
  @ApiQuery({ name: "locale", required: false, enum: ["en", "sw"] })
  @ApiProduces("application/pdf")
  async pdf(@Param("id") valuationId: string, @Query() query: unknown, @Req() req: Request) {
    const file = await this.exports.pdf(
      await this.auth.principal(req),
      id(valuationId),
      valuationExportQuerySchema.parse(query).locale,
      req,
    );
    return new StreamableFile(file.content, {
      type: file.contentType,
      disposition: file.disposition,
      length: file.content.length,
    });
  }

  @Get(":id/export/xlsx")
  @ApiOperation({
    operationId: "exportValuationExcel",
    summary: "The payment certificate and its lines as Excel (EN or SW)",
    description: `${readNote} Text cells are neutralised against formula injection.`,
  })
  @ApiQuery({ name: "locale", required: false, enum: ["en", "sw"] })
  @ApiProduces("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  async xlsx(@Param("id") valuationId: string, @Query() query: unknown, @Req() req: Request) {
    const file = await this.exports.xlsx(
      await this.auth.principal(req),
      id(valuationId),
      valuationExportQuerySchema.parse(query).locale,
      req,
    );
    return new StreamableFile(file.content, {
      type: file.contentType,
      disposition: file.disposition,
      length: file.content.length,
    });
  }
}
