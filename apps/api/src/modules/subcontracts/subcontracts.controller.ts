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
  UseInterceptors,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  addSubcontractLineRequestSchema,
  createSubcontractAdvanceRequestSchema,
  createSubcontractCertificateRequestSchema,
  createSubcontractRequestSchema,
  createSubcontractVariationRequestSchema,
  idempotencyKeySchema,
  matchSubcontractInvoiceRequestSchema,
  paySubcontractAdvanceRequestSchema,
  projectSubcontractsResponseSchema,
  recordSubcontractPaymentRequestSchema,
  setSubcontractClaimsRequestSchema,
  subcontractCertificateResponseSchema,
  subcontractDigestRequestSchema,
  subcontractItemsQuerySchema,
  subcontractItemsResponseSchema,
  subcontractReasonRequestSchema,
  subcontractResponseSchema,
  subcontractsOverviewResponseSchema,
  subcontractVersionQuerySchema,
  subcontractVersionRequestSchema,
  updateSubcontractCertificateRequestSchema,
  updateSubcontractRequestSchema,
  valuationExportQuerySchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { SubcontractCertificatesService } from "./subcontract-certificates.service.js";
import { SubcontractExportService } from "./subcontract-export.service.js";
import { SubcontractsService } from "./subcontracts.service.js";
import { SubcontractDatabaseErrors, subcontractProblem } from "./subcontracts-common.js";

const id = (value: string) => uuidSchema.parse(value);

const readNote =
  "Requires one of bq.edit, procurement.approve, finance.view or finance.manage on the subcontract's project (role ∩ assignment); clients, consultants, site agents and supplier portal users are refused (403).";
const prepareNote =
  "Requires bq.edit on the project, which must not be closed or cancelled (409 project-read-only); only a draft (409 invalid-transition). Send the version you read (409 version-conflict).";
const approveNote =
  "Requires procurement.approve with a recent MFA check (step-up); never someone who prepared it (403 maker-checker); quote the digest you saw (409 subcontract-stale or subcontract-variation-stale otherwise).";
const certifyNote =
  "Requires finance.manage with step-up; never a contributor (anyone who created, edited, claimed quantities on or submitted it, 403 maker-checker); quote the digest you saw (409 certificate-stale).";
const idempotency = {
  name: "Idempotency-Key",
  required: true,
  description:
    "8–100 characters, generated once per payment. A replay with the same key and payload returns the certificate (replayed: true); a changed payload is 409 idempotency-key-reused.",
};

function idempotencyKey(req: Request): string {
  const parsed = idempotencyKeySchema.safeParse(req.headers["idempotency-key"]);
  if (!parsed.success)
    throw subcontractProblem(
      400,
      "idempotency-key-required",
      "Send an Idempotency-Key header (8–100 characters)",
    );
  return parsed.data;
}

/**
 * Subcontracts (D6.3 part B, ARCHITECTURE §4.16): the overview, a project's subcontracts and the BQ
 * items they can let, each subcontract with its lines, lifecycle, variations, advances and
 * certificates, and the subcontractor statement export.
 */
@ApiTags("subcontracts")
@UseGuards(BrowserGuard)
@Controller({ path: "subcontracts", version: "1" })
@UseInterceptors(SubcontractDatabaseErrors)
export class SubcontractsController {
  constructor(
    private readonly auth: AuthService,
    private readonly subcontracts: SubcontractsService,
    private readonly certificates: SubcontractCertificatesService,
    private readonly exports: SubcontractExportService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: "listSubcontractProjects",
    summary: "Projects with their subcontracts' position, and the company's subcontractors",
    description: readNote,
  })
  @ApiOkResponse({ schema: openApi(subcontractsOverviewResponseSchema) })
  async overview(@Req() req: Request) {
    return this.subcontracts.overview(await this.auth.principal(req), req);
  }

  @Get("projects/:projectId")
  @ApiOperation({
    operationId: "listProjectSubcontracts",
    summary: "A project's subcontracts (newest first) with totals and subcontractors",
    description: readNote,
  })
  @ApiOkResponse({ schema: openApi(projectSubcontractsResponseSchema) })
  async project(@Param("projectId") projectId: string, @Req() req: Request) {
    return this.subcontracts.projectList(await this.auth.principal(req), id(projectId), req);
  }

  @Get("projects/:projectId/items")
  @ApiOperation({
    operationId: "listSubcontractItems",
    summary: "BQ items of the BQ in force that can be let, with what is already let",
    description: readNote,
  })
  @ApiQuery({ name: "search", required: false })
  @ApiQuery({ name: "cursor", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiOkResponse({ schema: openApi(subcontractItemsResponseSchema) })
  async items(@Param("projectId") projectId: string, @Query() query: unknown, @Req() req: Request) {
    return this.subcontracts.items(
      await this.auth.principal(req),
      id(projectId),
      subcontractItemsQuerySchema.parse(query),
      req,
    );
  }

  @Post("projects/:projectId")
  @ApiOperation({
    operationId: "createSubcontract",
    summary: "Start a draft subcontract with a subcontractor (a supplier flagged as one)",
    description: `${prepareNote} The supplier must be active and flagged as a subcontractor (409 subcontractor-not-eligible).`,
  })
  @ApiBody({ schema: openApi(createSubcontractRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(subcontractResponseSchema) })
  async create(@Param("projectId") projectId: string, @Body() body: unknown, @Req() req: Request) {
    return this.subcontracts.create(
      await this.auth.principal(req),
      id(projectId),
      createSubcontractRequestSchema.parse(body),
      req,
    );
  }

  @Get(":id")
  @ApiOperation({
    operationId: "getSubcontract",
    summary:
      "A subcontract with its lines in force, variations, advances, certificates and position",
    description: readNote,
  })
  @ApiOkResponse({ schema: openApi(subcontractResponseSchema) })
  async get(@Param("id") subcontractId: string, @Req() req: Request) {
    return this.subcontracts.get(await this.auth.principal(req), id(subcontractId), req);
  }

  @Patch(":id")
  @ApiOperation({
    operationId: "updateSubcontract",
    summary: "Edit a draft's terms",
    description: prepareNote,
  })
  @ApiBody({ schema: openApi(updateSubcontractRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractResponseSchema) })
  async update(@Param("id") subcontractId: string, @Body() body: unknown, @Req() req: Request) {
    return this.subcontracts.update(
      await this.auth.principal(req),
      id(subcontractId),
      updateSubcontractRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/lines")
  @HttpCode(200)
  @ApiOperation({
    operationId: "addSubcontractLine",
    summary: "Add a line on a BQ item of the BQ in force at the subcontract's own rate",
    description: `${prepareNote} The quantities let on an item never exceed its BQ quantity without a reason (409 over-bq-quantity).`,
  })
  @ApiBody({ schema: openApi(addSubcontractLineRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractResponseSchema) })
  async addLine(@Param("id") subcontractId: string, @Body() body: unknown, @Req() req: Request) {
    return this.subcontracts.addLine(
      await this.auth.principal(req),
      id(subcontractId),
      addSubcontractLineRequestSchema.parse(body),
      req,
    );
  }

  @Delete(":id/lines/:lineId")
  @ApiOperation({
    operationId: "removeSubcontractLine",
    summary: "Remove a draft's line",
    description: prepareNote,
  })
  @ApiQuery({ name: "version", required: true })
  @ApiOkResponse({ schema: openApi(subcontractResponseSchema) })
  async removeLine(
    @Param("id") subcontractId: string,
    @Param("lineId") lineId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.subcontracts.removeLine(
      await this.auth.principal(req),
      id(subcontractId),
      id(lineId),
      subcontractVersionQuerySchema.parse(query).version,
      req,
    );
  }

  @Post(":id/submit")
  @HttpCode(200)
  @ApiOperation({
    operationId: "submitSubcontract",
    summary: "Freeze the terms and lines with the digest an approver will quote",
    description: prepareNote,
  })
  @ApiBody({ schema: openApi(subcontractVersionRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractResponseSchema) })
  async submit(@Param("id") subcontractId: string, @Body() body: unknown, @Req() req: Request) {
    return this.subcontracts.transition(
      await this.auth.principal(req),
      id(subcontractId),
      "submit",
      subcontractVersionRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/approve")
  @HttpCode(200)
  @ApiOperation({
    operationId: "approveSubcontract",
    summary: "Approve a submitted subcontract",
    description: approveNote,
  })
  @ApiBody({ schema: openApi(subcontractDigestRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractResponseSchema) })
  async approve(@Param("id") subcontractId: string, @Body() body: unknown, @Req() req: Request) {
    return this.subcontracts.transition(
      await this.auth.principal(req),
      id(subcontractId),
      "approve",
      subcontractDigestRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/return")
  @HttpCode(200)
  @ApiOperation({
    operationId: "returnSubcontract",
    summary: "Return a submitted subcontract to draft (reason)",
    description: "Requires procurement.approve on the project.",
  })
  @ApiBody({ schema: openApi(subcontractReasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractResponseSchema) })
  async return(@Param("id") subcontractId: string, @Body() body: unknown, @Req() req: Request) {
    return this.subcontracts.transition(
      await this.auth.principal(req),
      id(subcontractId),
      "return",
      subcontractReasonRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/activate")
  @HttpCode(200)
  @ApiOperation({
    operationId: "activateSubcontract",
    summary: "Record that work started on an approved subcontract",
    description: "Requires bq.edit or procurement.approve on the project.",
  })
  @ApiBody({ schema: openApi(subcontractVersionRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractResponseSchema) })
  async activate(@Param("id") subcontractId: string, @Body() body: unknown, @Req() req: Request) {
    return this.subcontracts.transition(
      await this.auth.principal(req),
      id(subcontractId),
      "activate",
      subcontractVersionRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/complete")
  @HttpCode(200)
  @ApiOperation({
    operationId: "completeSubcontract",
    summary: "Complete an active subcontract (no open certificate or variation)",
    description:
      "Requires bq.edit or procurement.approve on the project (409 subcontract-has-open-items).",
  })
  @ApiBody({ schema: openApi(subcontractVersionRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractResponseSchema) })
  async complete(@Param("id") subcontractId: string, @Body() body: unknown, @Req() req: Request) {
    return this.subcontracts.transition(
      await this.auth.principal(req),
      id(subcontractId),
      "complete",
      subcontractVersionRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/terminate")
  @HttpCode(200)
  @ApiOperation({
    operationId: "terminateSubcontract",
    summary: "Terminate an approved or active subcontract (reason)",
    description: "Requires procurement.approve with step-up on the project.",
  })
  @ApiBody({ schema: openApi(subcontractReasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractResponseSchema) })
  async terminate(@Param("id") subcontractId: string, @Body() body: unknown, @Req() req: Request) {
    return this.subcontracts.transition(
      await this.auth.principal(req),
      id(subcontractId),
      "terminate",
      subcontractReasonRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({
    operationId: "cancelSubcontract",
    summary: "Cancel a draft or submitted subcontract (reason)",
    description: "Requires bq.edit or procurement.approve on the project.",
  })
  @ApiBody({ schema: openApi(subcontractReasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractResponseSchema) })
  async cancel(@Param("id") subcontractId: string, @Body() body: unknown, @Req() req: Request) {
    return this.subcontracts.transition(
      await this.auth.principal(req),
      id(subcontractId),
      "cancel",
      subcontractReasonRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/variations")
  @ApiOperation({
    operationId: "createSubcontractVariation",
    summary: "Raise a variation (add lines, change quantities) with a reason",
    description:
      "Requires bq.edit on an approved or active subcontract; one variation waits at a time (409 subcontract-variation-open); a line never goes below what was claimed (409 line-below-certified).",
  })
  @ApiBody({ schema: openApi(createSubcontractVariationRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(subcontractResponseSchema) })
  async vary(@Param("id") subcontractId: string, @Body() body: unknown, @Req() req: Request) {
    return this.subcontracts.vary(
      await this.auth.principal(req),
      id(subcontractId),
      createSubcontractVariationRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/variations/:variationId/approve")
  @HttpCode(200)
  @ApiOperation({
    operationId: "approveSubcontractVariation",
    summary: "Approve a variation (next contract version)",
    description: approveNote,
  })
  @ApiBody({ schema: openApi(subcontractDigestRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractResponseSchema) })
  async approveVariation(
    @Param("id") subcontractId: string,
    @Param("variationId") variationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.subcontracts.decideVariation(
      await this.auth.principal(req),
      id(subcontractId),
      id(variationId),
      "approve",
      subcontractDigestRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/variations/:variationId/reject")
  @HttpCode(200)
  @ApiOperation({
    operationId: "rejectSubcontractVariation",
    summary: "Reject a variation (reason)",
    description: "Requires procurement.approve; never its maker (403 maker-checker).",
  })
  @ApiBody({ schema: openApi(subcontractReasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractResponseSchema) })
  async rejectVariation(
    @Param("id") subcontractId: string,
    @Param("variationId") variationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.subcontracts.decideVariation(
      await this.auth.principal(req),
      id(subcontractId),
      id(variationId),
      "reject",
      subcontractReasonRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/advances")
  @ApiOperation({
    operationId: "requestSubcontractAdvance",
    summary: "Ask for an advance to the subcontractor (within the advance agreed)",
    description:
      "Requires bq.edit or finance.manage on an approved or active subcontract (409 advance-exceeds-limit).",
  })
  @ApiBody({ schema: openApi(createSubcontractAdvanceRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(subcontractResponseSchema) })
  async requestAdvance(
    @Param("id") subcontractId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.subcontracts.requestAdvance(
      await this.auth.principal(req),
      id(subcontractId),
      createSubcontractAdvanceRequestSchema.parse(body),
      req,
    );
  }

  @Post("advances/:advanceId/approve")
  @HttpCode(200)
  @ApiOperation({
    operationId: "approveSubcontractAdvance",
    summary: "Approve an advance",
    description: "Requires payments.approve with step-up; never the requester (403 maker-checker).",
  })
  @ApiBody({ schema: openApi(subcontractVersionRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractResponseSchema) })
  async approveAdvance(
    @Param("advanceId") advanceId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.subcontracts.decideAdvance(
      await this.auth.principal(req),
      id(advanceId),
      "approve",
      subcontractVersionRequestSchema.parse(body),
      req,
    );
  }

  @Post("advances/:advanceId/reject")
  @HttpCode(200)
  @ApiOperation({
    operationId: "rejectSubcontractAdvance",
    summary: "Reject an advance (reason)",
    description: "Requires payments.approve; never the requester.",
  })
  @ApiBody({ schema: openApi(subcontractReasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractResponseSchema) })
  async rejectAdvance(
    @Param("advanceId") advanceId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.subcontracts.decideAdvance(
      await this.auth.principal(req),
      id(advanceId),
      "reject",
      subcontractReasonRequestSchema.parse(body),
      req,
    );
  }

  @Post("advances/:advanceId/cancel")
  @HttpCode(200)
  @ApiOperation({
    operationId: "cancelSubcontractAdvance",
    summary: "Cancel a requested or approved advance (reason)",
    description: "The requester (bq.edit or finance.manage) or a payments.approve holder.",
  })
  @ApiBody({ schema: openApi(subcontractReasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractResponseSchema) })
  async cancelAdvance(
    @Param("advanceId") advanceId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.subcontracts.decideAdvance(
      await this.auth.principal(req),
      id(advanceId),
      "cancel",
      subcontractReasonRequestSchema.parse(body),
      req,
    );
  }

  @Post("advances/:advanceId/pay")
  @HttpCode(200)
  @ApiOperation({
    operationId: "paySubcontractAdvance",
    summary: "Record an approved advance as paid outside PM-Buddy",
    description:
      "Requires payments.disburse with step-up; never the requester or the approver (403 maker-checker). Posts the advance to the cost ledger (paid). M-Pesa B2B payouts are D4.3.",
  })
  @ApiBody({ schema: openApi(paySubcontractAdvanceRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractResponseSchema) })
  async payAdvance(
    @Param("advanceId") advanceId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.subcontracts.payAdvance(
      await this.auth.principal(req),
      id(advanceId),
      paySubcontractAdvanceRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/certificates")
  @ApiOperation({
    operationId: "createSubcontractCertificate",
    summary: "Start a certificate (interim, or a retention release after a certified completion)",
    description:
      "Requires bq.edit; one certificate in preparation per subcontract (409 certificate-open); interim certificates need an active subcontract.",
  })
  @ApiBody({ schema: openApi(createSubcontractCertificateRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(subcontractCertificateResponseSchema) })
  async createCertificate(
    @Param("id") subcontractId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.certificates.create(
      await this.auth.principal(req),
      id(subcontractId),
      createSubcontractCertificateRequestSchema.parse(body),
      req,
    );
  }

  @Get(":id/statement/pdf")
  @ApiOperation({
    operationId: "exportSubcontractStatementPdf",
    summary: "The subcontractor statement as an A4 PDF (EN or SW)",
    description: `${readNote} Rate limited; audited.`,
  })
  @ApiQuery({ name: "locale", required: false, enum: ["en", "sw"] })
  @ApiProduces("application/pdf")
  async statementPdf(
    @Param("id") subcontractId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    const file = await this.exports.statementPdf(
      await this.auth.principal(req),
      id(subcontractId),
      valuationExportQuerySchema.parse(query).locale,
      req,
    );
    return new StreamableFile(file.content, {
      type: file.contentType,
      disposition: file.disposition,
      length: file.content.length,
    });
  }

  @Get(":id/statement/xlsx")
  @ApiOperation({
    operationId: "exportSubcontractStatementExcel",
    summary: "The subcontractor statement as Excel (EN or SW)",
    description: `${readNote} Text cells are neutralised against formula injection.`,
  })
  @ApiQuery({ name: "locale", required: false, enum: ["en", "sw"] })
  @ApiProduces("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  async statementXlsx(
    @Param("id") subcontractId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    const file = await this.exports.statementXlsx(
      await this.auth.principal(req),
      id(subcontractId),
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

/** Subcontract payment certificates (D6.3 part B): claims, lifecycle, payments, invoice, exports. */
@ApiTags("subcontracts")
@UseGuards(BrowserGuard)
@Controller({ path: "subcontract-certificates", version: "1" })
@UseInterceptors(SubcontractDatabaseErrors)
export class SubcontractCertificatesController {
  constructor(
    private readonly auth: AuthService,
    private readonly certificates: SubcontractCertificatesService,
    private readonly exports: SubcontractExportService,
  ) {}

  @Get(":id")
  @ApiOperation({
    operationId: "getSubcontractCertificate",
    summary: "A certificate: frozen figures once submitted, a preview while a draft (KE-SUB-1)",
    description: readNote,
  })
  @ApiOkResponse({ schema: openApi(subcontractCertificateResponseSchema) })
  async get(@Param("id") certificateId: string, @Req() req: Request) {
    return this.certificates.get(await this.auth.principal(req), id(certificateId), req);
  }

  @Patch(":id")
  @ApiOperation({
    operationId: "updateSubcontractCertificate",
    summary: "Change a draft's date or notes",
    description: prepareNote,
  })
  @ApiBody({ schema: openApi(updateSubcontractCertificateRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractCertificateResponseSchema) })
  async update(@Param("id") certificateId: string, @Body() body: unknown, @Req() req: Request) {
    return this.certificates.update(
      await this.auth.principal(req),
      id(certificateId),
      updateSubcontractCertificateRequestSchema.parse(body),
      req,
    );
  }

  @Put(":id/claims")
  @ApiOperation({
    operationId: "setSubcontractClaims",
    summary: "Set quantities to date on lines of a draft interim",
    description: `${prepareNote} A quantity never exceeds its line (409 claim-exceeds-line); submission also checks it against approved measurement (409 claim-exceeds-measured).`,
  })
  @ApiBody({ schema: openApi(setSubcontractClaimsRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractCertificateResponseSchema) })
  async claims(@Param("id") certificateId: string, @Body() body: unknown, @Req() req: Request) {
    return this.certificates.setClaims(
      await this.auth.principal(req),
      id(certificateId),
      setSubcontractClaimsRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/submit")
  @HttpCode(200)
  @ApiOperation({
    operationId: "submitSubcontractCertificate",
    summary: "Freeze the lines and figures with the digest a certifier will quote",
    description: prepareNote,
  })
  @ApiBody({ schema: openApi(subcontractVersionRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractCertificateResponseSchema) })
  async submit(@Param("id") certificateId: string, @Body() body: unknown, @Req() req: Request) {
    return this.certificates.submit(
      await this.auth.principal(req),
      id(certificateId),
      subcontractVersionRequestSchema.parse(body).version,
      req,
    );
  }

  @Post(":id/certify")
  @HttpCode(200)
  @ApiOperation({
    operationId: "certifySubcontractCertificate",
    summary: "Certify a submitted certificate",
    description: certifyNote,
  })
  @ApiBody({ schema: openApi(subcontractDigestRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractCertificateResponseSchema) })
  async certify(@Param("id") certificateId: string, @Body() body: unknown, @Req() req: Request) {
    return this.certificates.certify(
      await this.auth.principal(req),
      id(certificateId),
      subcontractDigestRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/return")
  @HttpCode(200)
  @ApiOperation({
    operationId: "returnSubcontractCertificate",
    summary: "Return a submitted certificate to draft (reason)",
    description: "Requires finance.manage on the project.",
  })
  @ApiBody({ schema: openApi(subcontractReasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractCertificateResponseSchema) })
  async return(@Param("id") certificateId: string, @Body() body: unknown, @Req() req: Request) {
    return this.certificates.decide(
      await this.auth.principal(req),
      id(certificateId),
      "return",
      subcontractReasonRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({
    operationId: "cancelSubcontractCertificate",
    summary: "Cancel a draft or submitted certificate (reason)",
    description: "Requires bq.edit or finance.manage on the project.",
  })
  @ApiBody({ schema: openApi(subcontractReasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractCertificateResponseSchema) })
  async cancel(@Param("id") certificateId: string, @Body() body: unknown, @Req() req: Request) {
    return this.certificates.decide(
      await this.auth.principal(req),
      id(certificateId),
      "cancel",
      subcontractReasonRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/payments")
  @HttpCode(200)
  @ApiOperation({
    operationId: "recordSubcontractPayment",
    summary: "Record a payment made outside PM-Buddy against a certified certificate",
    description:
      "Requires payments.disburse with step-up; never the certifier (403 maker-checker); never above what is still payable (409 payment-exceeds-payable). Posts the cost part of the cash to the cost ledger (paid). M-Pesa B2B payouts are D4.3.",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(recordSubcontractPaymentRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractCertificateResponseSchema) })
  async pay(@Param("id") certificateId: string, @Body() body: unknown, @Req() req: Request) {
    const key = idempotencyKey(req);
    const result = await this.certificates.pay(
      await this.auth.principal(req),
      id(certificateId),
      recordSubcontractPaymentRequestSchema.parse(body),
      key,
      req,
    );
    if (result.replayed) req.res?.setHeader("Idempotency-Replayed", "true");
    return result;
  }

  @Post(":id/invoice")
  @HttpCode(200)
  @ApiOperation({
    operationId: "matchSubcontractInvoice",
    summary: "Match the subcontractor's tax invoice to a certified certificate (posts nothing)",
    description:
      "Requires finance.manage. The invoice is for the amount due plus VAT; its number is never also a supplier invoice of the same supplier (409 invoice-number-taken).",
  })
  @ApiBody({ schema: openApi(matchSubcontractInvoiceRequestSchema) })
  @ApiOkResponse({ schema: openApi(subcontractCertificateResponseSchema) })
  async invoice(@Param("id") certificateId: string, @Body() body: unknown, @Req() req: Request) {
    return this.certificates.matchInvoice(
      await this.auth.principal(req),
      id(certificateId),
      matchSubcontractInvoiceRequestSchema.parse(body),
      req,
    );
  }

  @Get(":id/export/pdf")
  @ApiOperation({
    operationId: "exportSubcontractCertificatePdf",
    summary: "The subcontract certificate as an A4 PDF (EN or SW); not certified = watermarked",
    description: `${readNote} Rate limited; audited.`,
  })
  @ApiQuery({ name: "locale", required: false, enum: ["en", "sw"] })
  @ApiProduces("application/pdf")
  async pdf(@Param("id") certificateId: string, @Query() query: unknown, @Req() req: Request) {
    const file = await this.exports.certificatePdf(
      await this.auth.principal(req),
      id(certificateId),
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
    operationId: "exportSubcontractCertificateExcel",
    summary: "The subcontract certificate and its lines as Excel (EN or SW)",
    description: `${readNote} Text cells are neutralised against formula injection.`,
  })
  @ApiQuery({ name: "locale", required: false, enum: ["en", "sw"] })
  @ApiProduces("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  async xlsx(@Param("id") certificateId: string, @Query() query: unknown, @Req() req: Request) {
    const file = await this.exports.certificateXlsx(
      await this.auth.principal(req),
      id(certificateId),
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
