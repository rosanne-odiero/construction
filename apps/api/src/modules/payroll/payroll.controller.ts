import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import {
  advanceListQuerySchema,
  advanceResponseSchema,
  advancesResponseSchema,
  allowanceResponseSchema,
  allowancesResponseSchema,
  approveAdvanceRequestSchema,
  approveOutputRequestSchema,
  batchActionRequestSchema,
  batchDetailResponseSchema,
  batchSnapshotResponseSchema,
  cancelAdvanceRequestSchema,
  cancelBatchRequestSchema,
  createAdvanceRequestSchema,
  createAllowanceRequestSchema,
  createBatchRequestSchema,
  createMinimumWageRequestSchema,
  createOutputRequestSchema,
  createStatutoryRuleRequestSchema,
  disburseAdvanceRequestSchema,
  endAllowanceRequestSchema,
  exportQuerySchema,
  exportRequestSchema,
  exportSummaryResponseSchema,
  messageResponseSchema,
  minimumWageResponseSchema,
  outputListQuerySchema,
  outputResponseSchema,
  outputsResponseSchema,
  payCalendarResponseSchema,
  payrollOverviewResponseSchema,
  payrollRulesResponseSchema,
  payrollSettingsResponseSchema,
  payslipResponseSchema,
  projectPayrollResponseSchema,
  rejectAdvanceRequestSchema,
  rejectOutputRequestSchema,
  statutoryRuleResponseSchema,
  updatePayCalendarRequestSchema,
  updatePayrollSettingsRequestSchema,
  verifyStatutoryRuleRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { AdvancesService } from "./advances.service.js";
import { PayrollBatchesService } from "./batches.service.js";
import { PayrollExportsService } from "./exports.service.js";
import { PayrollInputsService } from "./inputs.service.js";
import { PayrollRulesService } from "./rules.service.js";

const idempotency = {
  name: "Idempotency-Key",
  required: false,
  description:
    "Optional, 8–128 letters, digits, '-' or '_'. A retry with the same key and payload returns the original response; another payload is 409 idempotency-key-reused.",
};
const versioned = "Send the version you read (409 version-conflict otherwise).";

@ApiTags("payroll")
@UseGuards(BrowserGuard)
@Controller({ path: "payroll", version: "1" })
export class PayrollController {
  constructor(
    private readonly auth: AuthService,
    private readonly rules: PayrollRulesService,
    private readonly inputs: PayrollInputsService,
    private readonly advances: AdvancesService,
    private readonly batches: PayrollBatchesService,
    private readonly exports: PayrollExportsService,
  ) {}

  // Overview, settings and calendars --------------------------------------------------------------

  @Get("overview")
  @ApiOperation({
    summary: "Projects with their pay calendar, current pay period and batch counts",
    description: "Projects where the caller holds payroll.view or payroll.prepare.",
    operationId: "getPayrollOverview",
  })
  @ApiOkResponse({ schema: openApi(payrollOverviewResponseSchema) })
  async overview(@Req() req: Request) {
    return this.batches.overview(await this.auth.principal(req), req);
  }

  @Get("settings")
  @ApiOperation({
    summary: "Advance limits, the recovery cap and the pay calendars",
    description: "payroll.view or payroll.prepare somewhere, or config.manage.",
    operationId: "getPayrollSettings",
  })
  @ApiOkResponse({ schema: openApi(payrollSettingsResponseSchema) })
  async getSettings(@Req() req: Request) {
    return this.rules.getSettings(await this.auth.principal(req), req);
  }

  @Put("settings")
  @ApiOperation({
    summary: "Change the advance limits and the recovery cap",
    description: `Requires config.manage. ${versioned} Version 0 saves over the defaults.`,
    operationId: "updatePayrollSettings",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(updatePayrollSettingsRequestSchema) })
  @ApiOkResponse({ schema: openApi(payrollSettingsResponseSchema) })
  async updateSettings(@Body() body: unknown, @Req() req: Request) {
    return this.rules.updateSettings(
      await this.auth.principal(req),
      updatePayrollSettingsRequestSchema.parse(body),
      req,
    );
  }

  @Put("projects/:projectId/calendar")
  @ApiOperation({
    summary: "Set a project's pay calendar (frequency, first period, pay day, minimum-wage area)",
    description: `Requires payroll.prepare on the project. ${versioned} Existing batches keep their periods; a new period overlapping a live batch is refused when built.`,
    operationId: "updatePayCalendar",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(updatePayCalendarRequestSchema) })
  @ApiOkResponse({ schema: openApi(payCalendarResponseSchema) })
  async updateCalendar(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.rules.updateCalendar(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      updatePayCalendarRequestSchema.parse(body),
      req,
    );
  }

  // Statutory rules and minimum wages -------------------------------------------------------------

  @Get("rules")
  @ApiOperation({
    summary: "Statutory rule versions (effective dates, sources, verification) and minimum wages",
    description:
      "payroll.view or payroll.prepare somewhere, payroll.manage_rules, payroll.verify_rules or config.manage.",
    operationId: "listStatutoryRules",
  })
  @ApiOkResponse({ schema: openApi(payrollRulesResponseSchema) })
  async listRules(@Req() req: Request) {
    return this.rules.rules(await this.auth.principal(req), req);
  }

  @Post("rules")
  @ApiOperation({
    summary: "Add a statutory rule version (never an edit; a new version supersedes)",
    description:
      "Requires payroll.manage_rules. Starts unverified (COMPLIANCE-REVIEW). 409 rule-exists, rule-in-closed-period (on or before the pay date of submitted payroll).",
    operationId: "createStatutoryRule",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(createStatutoryRuleRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(statutoryRuleResponseSchema) })
  @ApiConflictResponse({ description: "rule-exists, rule-in-closed-period, payroll-rule" })
  async createRule(@Body() body: unknown, @Req() req: Request) {
    return this.rules.createRule(
      await this.auth.principal(req),
      createStatutoryRuleRequestSchema.parse(body),
      req,
    );
  }

  @Post("rules/defaults")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Install the researched Kenyan seed versions and the 2026 minimum wages that are missing",
    description:
      "Requires payroll.manage_rules. Everything is installed unverified (COMPLIANCE-REVIEW).",
    operationId: "installStatutoryRules",
  })
  @ApiHeader(idempotency)
  @ApiOkResponse({ schema: openApi(payrollRulesResponseSchema) })
  async installRules(@Req() req: Request) {
    return this.rules.installDefaults(await this.auth.principal(req), req);
  }

  @Post("rules/:id/verify")
  @HttpCode(200)
  @ApiOperation({
    summary: "Verify a statutory rule version (a reviewer's decision with a note)",
    description:
      "Requires payroll.verify_rules and MFA verified within five minutes (403 step-up-required); the author cannot verify (409 same-person); verified versions never change (409 rule-verified).",
    operationId: "verifyStatutoryRule",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(verifyStatutoryRuleRequestSchema) })
  @ApiOkResponse({ schema: openApi(statutoryRuleResponseSchema) })
  async verifyRule(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.rules.verifyRule(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      verifyStatutoryRuleRequestSchema.parse(body),
      req,
    );
  }

  @Delete("rules/:id")
  @ApiOperation({
    summary: "Delete an unverified rule version no batch has used",
    description: "Requires payroll.manage_rules; 409 rule-verified, rule-in-use.",
    operationId: "deleteStatutoryRule",
  })
  @ApiHeader(idempotency)
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  async deleteRule(@Param("id") id: string, @Req() req: Request) {
    return this.rules.deleteRule(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Post("minimum-wages")
  @ApiOperation({
    summary: "Add a minimum wage (area, occupation, effective date) for the below-minimum warning",
    description: "Requires payroll.manage_rules (COMPLIANCE-REVIEW CR-PAY-09); a warning only.",
    operationId: "createMinimumWage",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(createMinimumWageRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(minimumWageResponseSchema) })
  async createMinimumWage(@Body() body: unknown, @Req() req: Request) {
    return this.rules.createMinimumWage(
      await this.auth.principal(req),
      createMinimumWageRequestSchema.parse(body),
      req,
    );
  }

  // Batches ---------------------------------------------------------------------------------------

  @Get("projects/:projectId")
  @ApiOperation({
    summary: "A project's pay calendar, recent pay periods (with their timesheets) and batches",
    description: "payroll.view or payroll.prepare on the project.",
    operationId: "getProjectPayroll",
  })
  @ApiOkResponse({ schema: openApi(projectPayrollResponseSchema) })
  async project(@Param("projectId") projectId: string, @Req() req: Request) {
    return this.batches.project(await this.auth.principal(req), uuidSchema.parse(projectId), req);
  }

  @Post("projects/:projectId/batches")
  @ApiOperation({
    summary: "Build a draft batch for a pay period",
    description:
      "Requires payroll.prepare. Pulls approved timesheet lines (with adjustment lines) and approved output not consumed by another live batch, allowances, advances and the month so far; lists what it leaves out. 400 period-not-in-calendar; 409 batch-exists, period-overlap, period-not-started, rules-not-configured.",
    operationId: "createPayrollBatch",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(createBatchRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(batchDetailResponseSchema) })
  async createBatch(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.batches.create(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      createBatchRequestSchema.parse(body),
      req,
    );
  }

  @Get("batches/:id")
  @ApiOperation({
    summary: "A batch with its lines, totals, warnings, exclusions and the rule versions it used",
    description:
      "payroll.view or payroll.prepare on the project. Submitted batches also report whether their stored snapshot still matches its digest.",
    operationId: "getPayrollBatch",
  })
  @ApiOkResponse({ schema: openApi(batchDetailResponseSchema) })
  async batch(@Param("id") id: string, @Req() req: Request) {
    return this.batches.detail(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Post("batches/:id/recalculate")
  @HttpCode(200)
  @ApiOperation({
    summary: "Recalculate a draft batch from its current inputs",
    description: `Requires payroll.prepare. ${versioned}`,
    operationId: "recalculatePayrollBatch",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(batchActionRequestSchema) })
  @ApiOkResponse({ schema: openApi(batchDetailResponseSchema) })
  async recalculate(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.batches.recalculate(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      batchActionRequestSchema.parse(body),
      req,
    );
  }

  @Post("batches/:id/submit")
  @HttpCode(200)
  @ApiOperation({
    summary: "Submit a draft batch: freeze its snapshot and digest",
    description: `Requires payroll.prepare. ${versioned} 409 batch-stale when inputs changed since the last calculation, batch-empty, rules-unverified (production only).`,
    operationId: "submitPayrollBatch",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(batchActionRequestSchema) })
  @ApiOkResponse({ schema: openApi(batchDetailResponseSchema) })
  async submit(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.batches.submit(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      batchActionRequestSchema.parse(body),
      req,
    );
  }

  @Post("batches/:id/cancel")
  @HttpCode(200)
  @ApiOperation({
    summary: "Cancel a draft or submitted batch (its sources become available again)",
    description: `Requires payroll.prepare and a reason. ${versioned}`,
    operationId: "cancelPayrollBatch",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(cancelBatchRequestSchema) })
  @ApiOkResponse({ schema: openApi(batchDetailResponseSchema) })
  async cancel(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.batches.cancel(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      cancelBatchRequestSchema.parse(body),
      req,
    );
  }

  @Get("batches/:id/lines/:lineId")
  @ApiOperation({
    summary: "A payslip preview: days, rates, earnings, deductions, net, employer costs, advances",
    description: "payroll.view or payroll.prepare on the project.",
    operationId: "getPayslip",
  })
  @ApiOkResponse({ schema: openApi(payslipResponseSchema) })
  async payslip(@Param("id") id: string, @Param("lineId") lineId: string, @Req() req: Request) {
    return this.batches.payslip(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(lineId),
      req,
    );
  }

  @Get("batches/:id/snapshot")
  @ApiOperation({
    summary:
      "The canonical snapshot a batch's digest covers (what D4.3 approves), rebuilt from storage",
    description: "payroll.view or payroll.prepare on the project.",
    operationId: "getPayrollSnapshot",
  })
  @ApiOkResponse({ schema: openApi(batchSnapshotResponseSchema) })
  async snapshot(@Param("id") id: string, @Req() req: Request) {
    return this.batches.snapshot(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  // Allowances and piece-rate output --------------------------------------------------------------

  @Get("projects/:projectId/allowances")
  @ApiOperation({
    summary: "A project's allowances",
    description: "payroll.view or payroll.prepare on the project.",
    operationId: "listAllowances",
  })
  @ApiOkResponse({ schema: openApi(allowancesResponseSchema) })
  async allowances(@Param("projectId") projectId: string, @Req() req: Request) {
    return this.inputs.allowances(await this.auth.principal(req), uuidSchema.parse(projectId), req);
  }

  @Post("projects/:projectId/allowances")
  @ApiOperation({
    summary: "Add an allowance for the project, a trade or a labourer",
    description: "Requires payroll.prepare. Never edited afterwards; end it and add another.",
    operationId: "createAllowance",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(createAllowanceRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(allowanceResponseSchema) })
  async createAllowance(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.inputs.createAllowance(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      createAllowanceRequestSchema.parse(body),
      req,
    );
  }

  @Post("allowances/:id/end")
  @HttpCode(200)
  @ApiOperation({
    summary: "End an allowance on a date",
    description: "Requires payroll.prepare; 409 allowance-ended.",
    operationId: "endAllowance",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(endAllowanceRequestSchema) })
  @ApiOkResponse({ schema: openApi(allowanceResponseSchema) })
  async endAllowance(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.inputs.endAllowance(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      endAllowanceRequestSchema.parse(body),
      req,
    );
  }

  @Get("projects/:projectId/outputs")
  @ApiOperation({
    summary: "Piece-rate output of a project with its shares",
    description:
      "payroll.view, payroll.prepare, attendance.record or timesheets.approve on the project.",
    operationId: "listPieceRateOutputs",
  })
  @ApiOkResponse({ schema: openApi(outputsResponseSchema) })
  async outputs(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.inputs.outputs(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      outputListQuerySchema.parse(query),
      req,
    );
  }

  @Post("projects/:projectId/outputs")
  @ApiOperation({
    summary: "Record piece-rate output for a labourer or a gang on a day",
    description:
      "Requires attendance.record or payroll.prepare. 409 not-engaged, gang-empty, bq-item-not-in-project.",
    operationId: "createPieceRateOutput",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(createOutputRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(outputResponseSchema) })
  async createOutput(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.inputs.createOutput(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      createOutputRequestSchema.parse(body),
      req,
    );
  }

  @Post("outputs/:id/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve piece-rate output (writes the labourers' shares)",
    description: `Requires timesheets.approve; not the recorder (409 same-person). ${versioned}`,
    operationId: "approvePieceRateOutput",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(approveOutputRequestSchema) })
  @ApiOkResponse({ schema: openApi(outputResponseSchema) })
  async approveOutput(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.inputs.approveOutput(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      approveOutputRequestSchema.parse(body),
      req,
    );
  }

  @Post("outputs/:id/reject")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reject piece-rate output with a note",
    description: `Requires timesheets.approve; not the recorder. ${versioned}`,
    operationId: "rejectPieceRateOutput",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(rejectOutputRequestSchema) })
  @ApiOkResponse({ schema: openApi(outputResponseSchema) })
  async rejectOutput(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.inputs.rejectOutput(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      rejectOutputRequestSchema.parse(body),
      req,
    );
  }

  // Advances --------------------------------------------------------------------------------------

  @Get("advances")
  @ApiOperation({
    summary: "Salary advances with balances and recoveries",
    description:
      "Projects where the caller holds advances.request, advances.approve, payroll.view or payroll.prepare.",
    operationId: "listAdvances",
  })
  @ApiOkResponse({ schema: openApi(advancesResponseSchema) })
  async listAdvances(@Query() query: unknown, @Req() req: Request) {
    return this.advances.list(
      await this.auth.principal(req),
      advanceListQuerySchema.parse(query),
      req,
    );
  }

  @Post("projects/:projectId/advances")
  @ApiOperation({
    summary: "Request a salary advance for an engaged labourer",
    description:
      "Requires advances.request. 409 not-engaged, advance-over-limit, advance-outstanding-limit.",
    operationId: "requestAdvance",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(createAdvanceRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(advanceResponseSchema) })
  async requestAdvance(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.advances.create(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      createAdvanceRequestSchema.parse(body),
      req,
    );
  }

  @Post("advances/:id/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve an advance within the company limits",
    description: `Requires advances.approve; not the requester. ${versioned}`,
    operationId: "approveAdvance",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(approveAdvanceRequestSchema) })
  @ApiOkResponse({ schema: openApi(advanceResponseSchema) })
  async approveAdvance(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.advances.approve(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      approveAdvanceRequestSchema.parse(body),
      req,
    );
  }

  @Post("advances/:id/reject")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reject an advance with a note",
    description: `Requires advances.approve; not the requester. ${versioned}`,
    operationId: "rejectAdvance",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(rejectAdvanceRequestSchema) })
  @ApiOkResponse({ schema: openApi(advanceResponseSchema) })
  async rejectAdvance(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.advances.reject(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      rejectAdvanceRequestSchema.parse(body),
      req,
    );
  }

  @Post("advances/:id/disburse")
  @HttpCode(200)
  @ApiOperation({
    summary: "Record that an approved advance was paid outside PM-Buddy",
    description: `Requires payments.record_cash and MFA verified within five minutes; not the requester. A record only: no money moves here (M-Pesa payouts are D4.3). ${versioned}`,
    operationId: "disburseAdvance",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(disburseAdvanceRequestSchema) })
  @ApiOkResponse({ schema: openApi(advanceResponseSchema) })
  async disburseAdvance(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.advances.disburse(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      disburseAdvanceRequestSchema.parse(body),
      req,
    );
  }

  @Post("advances/:id/cancel")
  @HttpCode(200)
  @ApiOperation({
    summary: "Cancel a requested or approved advance",
    description: `The requester or an approver, with a reason. ${versioned}`,
    operationId: "cancelAdvance",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(cancelAdvanceRequestSchema) })
  @ApiOkResponse({ schema: openApi(advanceResponseSchema) })
  async cancelAdvance(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.advances.cancel(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      cancelAdvanceRequestSchema.parse(body),
      req,
    );
  }

  // Statutory exports -----------------------------------------------------------------------------

  @Get("exports")
  @ApiOperation({
    summary: "What a month's statutory exports would contain (no identifiers)",
    description: "Requires payroll.export.",
    operationId: "getPayrollExportSummary",
  })
  @ApiOkResponse({ schema: openApi(exportSummaryResponseSchema) })
  async exportSummary(@Query() query: unknown, @Req() req: Request) {
    return this.exports.summary(
      await this.auth.principal(req),
      exportQuerySchema.parse(query),
      req,
    );
  }

  @Post("exports")
  @HttpCode(200)
  @ApiOperation({
    summary: "Download a month's PAYE, NSSF, SHIF or NITA CSV template",
    description:
      "Requires payroll.export and MFA verified within five minutes; identifiers are decrypted on the server only; audited without values. 409 nothing-to-export, rules-unverified (production). COMPLIANCE-REVIEW CR-PAY-11.",
    operationId: "downloadPayrollExport",
  })
  @ApiBody({ schema: openApi(exportRequestSchema) })
  @ApiProduces("text/csv")
  async downloadExport(@Body() body: unknown, @Req() req: Request) {
    const file = await this.exports.generate(
      await this.auth.principal(req),
      exportRequestSchema.parse(body),
      req,
    );
    return new StreamableFile(file.content, {
      type: "text/csv; charset=utf-8",
      disposition: `attachment; filename="${file.filename}"`,
      length: file.content.length,
    });
  }
}
