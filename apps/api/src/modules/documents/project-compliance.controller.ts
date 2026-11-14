import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  StreamableFile,
  UseGuards,
  UseInterceptors,
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
  complianceExportQuerySchema,
  complianceHistoryResponseSchema,
  complianceRegisterResponseSchema,
  recordComplianceRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { ComplianceExportService } from "./compliance-export.service.js";
import { ComplianceService } from "./compliance.service.js";
import { DocumentsDatabaseErrors } from "./documents-errors.js";
import { READ_NOTE } from "./project-documents.controller.js";

const STATUS_NOTE =
  "Statuses are derived on read in Africa/Nairobi business dates: missing (no record), valid, expiring (from the type's reminder days before the expiry date, both ends included), expired (from the day after) or not applicable (recorded with a reason). Company items (contractor registration, WIBA) are the company's single record, shown on every project.";

/** A project's compliance register (D8.4, ARCHITECTURE §4.13): items, history, records, exports. */
@ApiTags("documents")
@UseGuards(BrowserGuard)
@Controller({ path: "projects/:projectId/compliance", version: "1" })
@UseInterceptors(DocumentsDatabaseErrors)
export class ProjectComplianceController {
  constructor(
    private readonly auth: AuthService,
    private readonly compliance: ComplianceService,
    private readonly exports: ComplianceExportService,
  ) {}

  private async args(req: Request, ...ids: string[]) {
    return [await this.auth.principal(req), ...ids.map((id) => uuidSchema.parse(id))] as const;
  }

  @Get()
  @ApiOperation({
    operationId: "getComplianceRegister",
    summary: "The project's compliance register with derived statuses and reminders",
    description: `${READ_NOTE} ${STATUS_NOTE} Evidence in a confidential category is shown as restricted.`,
  })
  @ApiOkResponse({ schema: openApi(complianceRegisterResponseSchema) })
  async register(@Param("projectId") projectId: string, @Req() req: Request) {
    const [principal, project] = await this.args(req, projectId);
    return this.compliance.register(principal, project, req);
  }

  @Post()
  @ApiOperation({
    operationId: "recordComplianceItem",
    summary: "Record a project item, renew it, or state that it does not apply (append-only)",
    description:
      "Requires documents.manage on the project (closed and cancelled projects: 409 project-read-only); company items are recorded on /documents/compliance (409 invalid-transition here). Send the current record you saw as supersedesId (null when none): a renewal supersedes exactly it (409 compliance-stale). A record that expires needs its expiry date (422 compliance-expiry-required); no issue date in the future (422 compliance-issued-future); expiry not before issue (422 compliance-expiry-before-issue); evidence is a version of this project you can see (422 evidence-not-found). Not applicable needs a reason and nothing else; retired types take no records (409 compliance-type-retired).",
  })
  @ApiBody({ schema: openApi(recordComplianceRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(complianceHistoryResponseSchema) })
  async record(@Param("projectId") projectId: string, @Body() body: unknown, @Req() req: Request) {
    const [principal, project] = await this.args(req, projectId);
    return this.compliance.record(
      principal,
      project,
      recordComplianceRequestSchema.parse(body),
      req,
    );
  }

  @Get("export/pdf")
  @ApiOperation({
    operationId: "exportComplianceRegisterPdf",
    summary: "The compliance register as an A4 PDF (EN or SW)",
    description: `${READ_NOTE} Generated on demand, audited, 30 per 10 minutes per user.`,
  })
  @ApiQuery({ name: "locale", required: false, enum: ["en", "sw"] })
  @ApiProduces("application/pdf")
  async pdf(@Param("projectId") projectId: string, @Query() query: unknown, @Req() req: Request) {
    const [principal, project] = await this.args(req, projectId);
    const file = await this.exports.pdf(
      principal,
      project,
      complianceExportQuerySchema.parse(query).locale,
      req,
    );
    return new StreamableFile(file.content, {
      type: file.contentType,
      disposition: file.disposition,
      length: file.content.length,
    });
  }

  @Get("export/xlsx")
  @ApiOperation({
    operationId: "exportComplianceRegisterExcel",
    summary: "The compliance register as Excel (EN or SW)",
    description: `${READ_NOTE} Text cells are neutralised against formula injection; audited and rate-limited like the PDF.`,
  })
  @ApiQuery({ name: "locale", required: false, enum: ["en", "sw"] })
  @ApiProduces("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  async xlsx(@Param("projectId") projectId: string, @Query() query: unknown, @Req() req: Request) {
    const [principal, project] = await this.args(req, projectId);
    const file = await this.exports.xlsx(
      principal,
      project,
      complianceExportQuerySchema.parse(query).locale,
      req,
    );
    return new StreamableFile(file.content, {
      type: file.contentType,
      disposition: file.disposition,
      length: file.content.length,
    });
  }

  @Get("items/:typeId")
  @ApiOperation({
    operationId: "getComplianceItem",
    summary: "One item with its records, newest first (renewals and not-applicable statements)",
    description: `${READ_NOTE} ${STATUS_NOTE}`,
  })
  @ApiOkResponse({ schema: openApi(complianceHistoryResponseSchema) })
  async history(
    @Param("projectId") projectId: string,
    @Param("typeId") typeId: string,
    @Req() req: Request,
  ) {
    const [principal, project, type] = await this.args(req, projectId, typeId);
    return this.compliance.history(principal, project, type, req);
  }
}
