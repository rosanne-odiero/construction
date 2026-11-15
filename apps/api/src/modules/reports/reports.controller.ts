import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
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
import { isReportId, LOCALES, REPORT_IDS, type ReportId } from "@pm-buddy/types";
import {
  createSubscriptionRequestSchema,
  dashboardResponseSchema,
  deleteSubscriptionRequestSchema,
  reportModelSchema,
  reportOptionsQuerySchema,
  reportOptionsResponseSchema,
  reportQuerySchema,
  reportsResponseSchema,
  reportSubscriptionResponseSchema,
  reportSubscriptionsQuerySchema,
  reportSubscriptionsResponseSchema,
  runDueResponseSchema,
  updateSubscriptionRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { z } from "zod";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { DashboardService } from "./dashboard.service.js";
import { reportProblem, ReportsDatabaseErrors } from "./reports-access.js";
import { ReportSchedulerService } from "./report-scheduler.service.js";
import { ReportSubscriptionsService } from "./report-subscriptions.service.js";
import { ReportsService } from "./reports.service.js";

const localeQuery = z.strictObject({ locale: z.enum(LOCALES).default("en") });
const ruleNote =
  'Requires reports.view and the permission of the report\'s source screen on the same project (role ∩ assignment); company reports their company-level permission (D8.1, INVARIANTS "Reports").';

function reportIdOf(value: string): ReportId {
  if (!isReportId(value)) throw new NotFoundException("Report not found");
  return value;
}

/** The owner dashboard (`/api/v1/dashboard`). */
@ApiTags("reports")
@UseGuards(BrowserGuard)
@UseInterceptors(ReportsDatabaseErrors)
@Controller({ path: "dashboard", version: "1" })
export class DashboardController {
  constructor(
    private readonly auth: AuthService,
    private readonly dashboard: DashboardService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "The owner dashboard: a curated summary of what the caller may see",
    description:
      "One call. Each section comes from its source screen's read with the same permission rule; a section the caller may not see is absent (never zero); undefined ratios are null.",
    operationId: "getDashboard",
  })
  @ApiOkResponse({ schema: openApi(dashboardResponseSchema) })
  async get(@Req() req: Request) {
    return this.dashboard.get(await this.auth.principal(req), req);
  }
}

/** The reports centre and report subscriptions (`/api/v1/reports`). */
@ApiTags("reports")
@UseGuards(BrowserGuard)
@UseInterceptors(ReportsDatabaseErrors)
@Controller({ path: "reports", version: "1" })
export class ReportsController {
  constructor(
    private readonly auth: AuthService,
    private readonly reports: ReportsService,
    private readonly subscriptions: ReportSubscriptionsService,
    private readonly scheduler: ReportSchedulerService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Every report, with whether the caller may run it and for which projects",
    operationId: "listReports",
  })
  @ApiQuery({ name: "locale", required: false, enum: LOCALES })
  @ApiOkResponse({ schema: openApi(reportsResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.reports.list(await this.auth.principal(req), localeQuery.parse(query).locale, req);
  }

  @Get("subscriptions")
  @ApiOperation({
    summary: "The caller's report subscriptions (scope=company: the company's, config.manage)",
    operationId: "listReportSubscriptions",
  })
  @ApiQuery({ name: "scope", required: false, enum: ["mine", "company"] })
  @ApiQuery({ name: "locale", required: false, enum: LOCALES })
  @ApiOkResponse({ schema: openApi(reportSubscriptionsResponseSchema) })
  async listSubscriptions(@Query() query: Record<string, unknown>, @Req() req: Request) {
    const { locale, ...rest } = query;
    const parsed = reportSubscriptionsQuerySchema.parse(rest);
    return this.subscriptions.list(
      await this.auth.principal(req),
      parsed.scope,
      localeQuery.parse({ locale }).locale,
      req,
    );
  }

  @Post("subscriptions")
  @ApiOperation({
    summary: "Subscribe yourself to a report by email (weekly or monthly, Nairobi time)",
    description: `${ruleNote} The subscriber must be able to run the report with these parameters now. The email holds a sign-in link, never report data. 409 subscription-exists, subscription-limit; 422 email-required.`,
    operationId: "createReportSubscription",
  })
  @ApiBody({ schema: openApi(createSubscriptionRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(reportSubscriptionResponseSchema) })
  async create(@Body() body: unknown, @Req() req: Request) {
    return this.subscriptions.create(
      await this.auth.principal(req),
      createSubscriptionRequestSchema.parse(body),
      req,
    );
  }

  @Post("subscriptions/run-due")
  @HttpCode(200)
  @ApiOperation({
    summary: "Run the company's due subscriptions now (config.manage)",
    description:
      "The same cycle as the scheduler, for the caller's company only. 409 scheduler-busy while another run holds the lock.",
    operationId: "runDueReportSubscriptions",
  })
  @ApiOkResponse({ schema: openApi(runDueResponseSchema) })
  async runDue(@Req() req: Request) {
    const principal = await this.auth.principal(req);
    const tenantId = await this.subscriptions.authoriseRunDue(principal, req);
    const result = await this.scheduler.runDue({ tenantId });
    if (!result)
      throw reportProblem(
        409,
        "scheduler-busy",
        "Scheduled reports are running; try again shortly",
      );
    return runDueResponseSchema.parse(result);
  }

  @Patch("subscriptions/:id")
  @ApiOperation({
    summary: "Pause or resume your subscription (version check)",
    operationId: "updateReportSubscription",
  })
  @ApiBody({ schema: openApi(updateSubscriptionRequestSchema) })
  @ApiOkResponse({ schema: openApi(reportSubscriptionResponseSchema) })
  async update(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.subscriptions.update(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      updateSubscriptionRequestSchema.parse(body),
      req,
    );
  }

  @Post("subscriptions/:id/delete")
  @HttpCode(200)
  @ApiOperation({
    summary: "Delete your subscription (kept with its runs, never sent again)",
    operationId: "deleteReportSubscription",
  })
  @ApiBody({ schema: openApi(deleteSubscriptionRequestSchema) })
  @ApiOkResponse({ schema: openApi(reportSubscriptionResponseSchema) })
  async remove(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.subscriptions.remove(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      deleteSubscriptionRequestSchema.parse(body).version,
      req,
    );
  }

  @Get(":reportId/options")
  @ApiOperation({
    summary: "Choices for a report's parameters: sites, stores, payroll batches or people",
    description: ruleNote,
    operationId: "getReportOptions",
  })
  @ApiQuery({ name: "projectId", required: false })
  @ApiOkResponse({ schema: openApi(reportOptionsResponseSchema) })
  async options(@Param("reportId") reportId: string, @Query() query: unknown, @Req() req: Request) {
    return this.reports.options(
      await this.auth.principal(req),
      reportIdOf(reportId),
      reportOptionsQuerySchema.parse(query).projectId,
      req,
    );
  }

  @Get(":reportId")
  @ApiOperation({
    summary: "A report on screen: the typed model with at most 200 rows per section",
    description: `${ruleNote} Totals cover every row. Rate limited; audited (report.viewed, IDs only). Reports: ${REPORT_IDS.join(", ")}.`,
    operationId: "getReport",
  })
  @ApiOkResponse({ schema: openApi(reportModelSchema) })
  async preview(@Param("reportId") reportId: string, @Query() query: unknown, @Req() req: Request) {
    return this.reports.model(
      await this.auth.principal(req),
      reportIdOf(reportId),
      reportQuerySchema.parse(query),
      "preview",
      req,
    );
  }

  @Get(":reportId/export/pdf")
  @ApiOperation({
    summary: "A report as an A4 PDF (EN or SW)",
    description: `${ruleNote} At most 5,000 rows (422 use-excel). Rate limited; audited (report.exported).`,
    operationId: "exportReportPdf",
  })
  @ApiProduces("application/pdf")
  async pdf(@Param("reportId") reportId: string, @Query() query: unknown, @Req() req: Request) {
    const file = await this.reports.pdf(
      await this.auth.principal(req),
      reportIdOf(reportId),
      reportQuerySchema.parse(query),
      req,
    );
    return new StreamableFile(file.content, {
      type: file.contentType,
      disposition: file.disposition,
      length: file.content.length,
    });
  }

  @Get(":reportId/export/xlsx")
  @ApiOperation({
    summary: "A report as Excel (EN or SW): typed cells, text neutralised against formulas",
    description: `${ruleNote} At most 20,000 rows (422 report-too-large). Rate limited; audited (report.exported).`,
    operationId: "exportReportExcel",
  })
  @ApiProduces("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  async xlsx(@Param("reportId") reportId: string, @Query() query: unknown, @Req() req: Request) {
    const file = await this.reports.xlsx(
      await this.auth.principal(req),
      reportIdOf(reportId),
      reportQuerySchema.parse(query),
      req,
    );
    return new StreamableFile(file.content, {
      type: file.contentType,
      disposition: file.disposition,
      length: file.content.length,
    });
  }
}
