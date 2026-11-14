import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  complianceHistoryResponseSchema,
  complianceTypeResponseSchema,
  complianceTypesResponseSchema,
  createComplianceTypeRequestSchema,
  documentsOverviewResponseSchema,
  recordComplianceRequestSchema,
  updateComplianceTypeRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { ComplianceService } from "./compliance.service.js";
import { DocumentsDatabaseErrors } from "./documents-errors.js";
import { DocumentsOverviewService } from "./documents-overview.service.js";

const ANY_READER =
  "Requires projects.view plus a document read permission (documents.manage, projects.manage, site.diary, quality.manage, safety.manage, bq.edit, finance.view or finance.manage) on at least one project, or config.manage.";
const CONFIGURE = "Requires config.manage (company-level).";

/**
 * The company's documents area (D8.4, ARCHITECTURE §4.13): the "expiring soon" list across
 * projects, company compliance items and the item types.
 */
@ApiTags("documents")
@UseGuards(BrowserGuard)
@Controller({ path: "documents", version: "1" })
@UseInterceptors(DocumentsDatabaseErrors)
export class DocumentsController {
  constructor(
    private readonly auth: AuthService,
    private readonly overview: DocumentsOverviewService,
    private readonly compliance: ComplianceService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: "getDocumentsOverview",
    summary: "Projects with their document summaries, company items and the expiring-soon list",
    description: `${ANY_READER} Only projects the caller can read are included; closed and cancelled projects raise no reminders. Computed on read in Nairobi dates (decision D-116).`,
  })
  @ApiOkResponse({ schema: openApi(documentsOverviewResponseSchema) })
  async overviewPage(@Req() req: Request) {
    return this.overview.overview(await this.auth.principal(req), req);
  }

  @Get("compliance-types")
  @ApiOperation({
    operationId: "listComplianceTypes",
    summary: "The company's compliance item types (starter set flagged COMPLIANCE-REVIEW)",
    description: ANY_READER,
  })
  @ApiOkResponse({ schema: openApi(complianceTypesResponseSchema) })
  async types(@Req() req: Request) {
    return this.compliance.types(await this.auth.principal(req), req);
  }

  @Post("compliance-types")
  @ApiOperation({
    operationId: "createComplianceType",
    summary: "Add a company item type (project or company scope, expiry, reminder days)",
    description: `${CONFIGURE} At most 60 types (409 compliance-type-limit).`,
  })
  @ApiBody({ schema: openApi(createComplianceTypeRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(complianceTypeResponseSchema) })
  async createType(@Body() body: unknown, @Req() req: Request) {
    return this.compliance.createType(
      await this.auth.principal(req),
      createComplianceTypeRequestSchema.parse(body),
      req,
    );
  }

  @Patch("compliance-types/:typeId")
  @ApiOperation({
    operationId: "updateComplianceType",
    summary: "Change an item type's reminder days or expiry, retire or reactivate it",
    description: `${CONFIGURE} Starter types keep their translated names; key and scope never change. Send the version you read (409 version-conflict).`,
  })
  @ApiBody({ schema: openApi(updateComplianceTypeRequestSchema) })
  @ApiOkResponse({ schema: openApi(complianceTypeResponseSchema) })
  async updateType(@Param("typeId") typeId: string, @Body() body: unknown, @Req() req: Request) {
    return this.compliance.updateType(
      await this.auth.principal(req),
      uuidSchema.parse(typeId),
      updateComplianceTypeRequestSchema.parse(body),
      req,
    );
  }

  @Post("compliance")
  @ApiOperation({
    operationId: "recordCompanyComplianceItem",
    summary: "Record, renew or mark not applicable a company item (shown on every project)",
    description: `${CONFIGURE} Same rules as a project item; evidence may be a version of any project you can see.`,
  })
  @ApiBody({ schema: openApi(recordComplianceRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(complianceHistoryResponseSchema) })
  async recordCompany(@Body() body: unknown, @Req() req: Request) {
    return this.compliance.record(
      await this.auth.principal(req),
      null,
      recordComplianceRequestSchema.parse(body),
      req,
    );
  }

  @Get("compliance/:typeId")
  @ApiOperation({
    operationId: "getCompanyComplianceItem",
    summary: "A company item with its records, newest first",
    description: ANY_READER,
  })
  @ApiOkResponse({ schema: openApi(complianceHistoryResponseSchema) })
  async companyHistory(@Param("typeId") typeId: string, @Req() req: Request) {
    return this.compliance.history(
      await this.auth.principal(req),
      null,
      uuidSchema.parse(typeId),
      req,
    );
  }
}
