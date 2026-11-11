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
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import {
  adjustmentListQuerySchema,
  adjustmentResponseSchema,
  adjustmentsResponseSchema,
  anomaliesResponseSchema,
  anomalyListQuerySchema,
  anomalyResponseSchema,
  approveDecisionRequestSchema,
  attendanceOverviewResponseSchema,
  attendanceSettingsResponseSchema,
  correctionListQuerySchema,
  correctionResponseSchema,
  correctionsResponseSchema,
  createAdjustmentRequestSchema,
  createCorrectionRequestSchema,
  createHolidayRequestSchema,
  createTimesheetRuleRequestSchema,
  dayActionRequestSchema,
  holidayResponseSchema,
  labourerAttendanceQuerySchema,
  labourerAttendanceResponseSchema,
  messageResponseSchema,
  musterQuerySchema,
  musterResponseSchema,
  periodActionRequestSchema,
  periodDetailResponseSchema,
  periodsResponseSchema,
  rejectDecisionRequestSchema,
  rejectPeriodRequestSchema,
  returnDayRequestSchema,
  reviewAnomalyRequestSchema,
  saveMusterRequestSchema,
  timesheetLinesResponseSchema,
  timesheetRuleResponseSchema,
  updatePeriodSettingsRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { AdjustmentsService } from "./adjustments.service.js";
import { AnomaliesService } from "./anomalies.service.js";
import { CorrectionsService } from "./corrections.service.js";
import { MusterService } from "./muster.service.js";
import { PeriodsService } from "./periods.service.js";
import { AttendanceSettingsService } from "./settings.service.js";

const idempotency = {
  name: "Idempotency-Key",
  required: false,
  description:
    "Optional, 8–128 letters, digits, '-' or '_'. A retry with the same key and payload returns the original response; another payload is 409 idempotency-key-reused.",
};
const versioned = "Send the version you read (409 version-conflict otherwise).";

@ApiTags("attendance")
@UseGuards(BrowserGuard)
@Controller({ path: "attendance", version: "1" })
export class AttendanceController {
  constructor(
    private readonly auth: AuthService,
    private readonly settings: AttendanceSettingsService,
    private readonly muster: MusterService,
    private readonly corrections: CorrectionsService,
    private readonly anomalies: AnomaliesService,
    private readonly periods: PeriodsService,
    private readonly adjustments: AdjustmentsService,
  ) {}

  // Overview and settings -------------------------------------------------------------------------

  @Get("overview")
  @ApiOperation({
    summary: "Projects with today's muster status, review queues and the current period",
    description: "Projects where the caller holds attendance.view.",
    operationId: "getAttendanceOverview",
  })
  @ApiOkResponse({ schema: openApi(attendanceOverviewResponseSchema) })
  async overview(@Req() req: Request) {
    return this.muster.overview(await this.auth.principal(req), req);
  }

  @Get("settings")
  @ApiOperation({
    summary: "Timesheet rule versions, the period cut-off and the public holiday calendar",
    description: "attendance.view somewhere, timesheets.manage_rules somewhere or config.manage.",
    operationId: "getAttendanceSettings",
  })
  @ApiOkResponse({ schema: openApi(attendanceSettingsResponseSchema) })
  async getSettings(@Req() req: Request) {
    return this.settings.get(await this.auth.principal(req), req);
  }

  @Put("settings/periods")
  @ApiOperation({
    summary: "Change the weekly period end, cut-off time and pay day",
    description: `Requires config.manage. ${versioned} Existing periods keep their dates.`,
    operationId: "updatePeriodSettings",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(updatePeriodSettingsRequestSchema) })
  @ApiOkResponse({ schema: openApi(attendanceSettingsResponseSchema) })
  async updatePeriods(@Body() body: unknown, @Req() req: Request) {
    return this.settings.updatePeriods(
      await this.auth.principal(req),
      updatePeriodSettingsRequestSchema.parse(body),
      req,
    );
  }

  @Post("rules")
  @ApiOperation({
    summary: "Add a timesheet rule version (company default or project override)",
    description:
      "Company default: config.manage; project override: timesheets.manage_rules on the project. May start in the past but never inside a submitted or approved period (409 period-locked); never edited afterwards (COMPLIANCE-REVIEW CR-PAY-08).",
    operationId: "createTimesheetRule",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(createTimesheetRuleRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(timesheetRuleResponseSchema) })
  @ApiConflictResponse({ description: "rule-exists, attendance-rule" })
  async createRule(@Body() body: unknown, @Req() req: Request) {
    return this.settings.createRule(
      await this.auth.principal(req),
      createTimesheetRuleRequestSchema.parse(body),
      req,
    );
  }

  @Post("rules/defaults")
  @HttpCode(200)
  @ApiOperation({
    summary: "Install the demonstration rule (Q-C3) as the company default when none exists",
    description: "Requires config.manage. Seeded as unverified (COMPLIANCE-REVIEW CR-PAY-08).",
    operationId: "installDefaultTimesheetRule",
  })
  @ApiHeader(idempotency)
  @ApiOkResponse({ schema: openApi(attendanceSettingsResponseSchema) })
  async installRule(@Req() req: Request) {
    return this.settings.installDefaultRule(await this.auth.principal(req), req);
  }

  @Delete("rules/:id")
  @ApiOperation({
    summary: "Cancel a rule version that has not started",
    description: "Same permission as adding it; 409 rule-in-force once it has started.",
    operationId: "deleteTimesheetRule",
  })
  @ApiHeader(idempotency)
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  async deleteRule(@Param("id") id: string, @Req() req: Request) {
    return this.settings.deleteRule(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Post("holidays")
  @ApiOperation({
    summary: "Add a public holiday (for example a gazetted Idd holiday)",
    description:
      "Requires config.manage; refused inside a submitted or approved period (COMPLIANCE-REVIEW CR-PAY-14).",
    operationId: "createPublicHoliday",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(createHolidayRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(holidayResponseSchema) })
  async createHoliday(@Body() body: unknown, @Req() req: Request) {
    return this.settings.createHoliday(
      await this.auth.principal(req),
      createHolidayRequestSchema.parse(body),
      req,
    );
  }

  @Post("holidays/defaults")
  @HttpCode(200)
  @ApiOperation({
    summary: "Add the 2026–2027 Kenyan public holidays that are missing",
    description:
      "Requires config.manage. Sources: Public Holidays Act Cap. 110 and Gazette notices.",
    operationId: "installPublicHolidays",
  })
  @ApiHeader(idempotency)
  @ApiOkResponse({ schema: openApi(attendanceSettingsResponseSchema) })
  async installHolidays(@Req() req: Request) {
    return this.settings.installHolidays(await this.auth.principal(req), req);
  }

  @Delete("holidays/:id")
  @ApiOperation({
    summary: "Remove a public holiday",
    description: "Requires config.manage; refused inside a submitted or approved period.",
    operationId: "deletePublicHoliday",
  })
  @ApiHeader(idempotency)
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  async deleteHoliday(@Param("id") id: string, @Req() req: Request) {
    return this.settings.deleteHoliday(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  // Muster roll ------------------------------------------------------------------------------------

  @Get("projects/:projectId/muster")
  @ApiOperation({
    summary: "The muster roll of a project site on a date",
    description: "Requires attendance.view on the project. Lists labourers engaged that day.",
    operationId: "getMuster",
  })
  @ApiOkResponse({ schema: openApi(musterResponseSchema) })
  async getMuster(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.muster.get(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      musterQuerySchema.parse(query),
      req,
    );
  }

  @Put("projects/:projectId/muster")
  @ApiOperation({
    summary: "Record or change entries of a draft muster day (web_manual capture)",
    description: `Requires attendance.record on the project. ${versioned} 409 not-engaged, period-locked, day-not-draft.`,
    operationId: "saveMuster",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(saveMusterRequestSchema) })
  @ApiOkResponse({ schema: openApi(musterResponseSchema) })
  async saveMuster(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.muster.save(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      saveMusterRequestSchema.parse(body),
      req,
    );
  }

  @Post("days/:dayId/submit")
  @HttpCode(200)
  @ApiOperation({
    summary: "Submit a draft muster day for confirmation",
    description: `Requires attendance.record. ${versioned}`,
    operationId: "submitAttendanceDay",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(dayActionRequestSchema) })
  @ApiOkResponse({ schema: openApi(musterResponseSchema) })
  async submitDay(@Param("dayId") dayId: string, @Body() body: unknown, @Req() req: Request) {
    return this.muster.submit(
      await this.auth.principal(req),
      uuidSchema.parse(dayId),
      dayActionRequestSchema.parse(body),
      req,
    );
  }

  @Post("days/:dayId/confirm")
  @HttpCode(200)
  @ApiOperation({
    summary: "Confirm a submitted muster day",
    description: `Requires attendance.confirm and someone who neither submitted nor recorded the day (409 same-person). ${versioned}`,
    operationId: "confirmAttendanceDay",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(dayActionRequestSchema) })
  @ApiOkResponse({ schema: openApi(musterResponseSchema) })
  async confirmDay(@Param("dayId") dayId: string, @Body() body: unknown, @Req() req: Request) {
    return this.muster.confirm(
      await this.auth.principal(req),
      uuidSchema.parse(dayId),
      dayActionRequestSchema.parse(body),
      req,
    );
  }

  @Post("days/:dayId/return")
  @HttpCode(200)
  @ApiOperation({
    summary: "Return a submitted muster day to its recorder with a reason",
    description: `Requires attendance.confirm and someone other than the submitter. ${versioned}`,
    operationId: "returnAttendanceDay",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(returnDayRequestSchema) })
  @ApiOkResponse({ schema: openApi(musterResponseSchema) })
  async returnDay(@Param("dayId") dayId: string, @Body() body: unknown, @Req() req: Request) {
    return this.muster.returnDay(
      await this.auth.principal(req),
      uuidSchema.parse(dayId),
      returnDayRequestSchema.parse(body),
      req,
    );
  }

  // Corrections ------------------------------------------------------------------------------------

  @Post("days/:dayId/corrections")
  @ApiOperation({
    summary: "Request a correction of a submitted or confirmed day (manual override)",
    description:
      "Requires attendance.override and step-up MFA; a reason of 10–500 characters. Flagged for review; applied only when someone else approves it.",
    operationId: "createAttendanceCorrection",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(createCorrectionRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(correctionResponseSchema) })
  async createCorrection(
    @Param("dayId") dayId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.corrections.create(
      await this.auth.principal(req),
      uuidSchema.parse(dayId),
      createCorrectionRequestSchema.parse(body),
      req,
    );
  }

  @Get("projects/:projectId/corrections")
  @ApiOperation({ summary: "Corrections of a project", operationId: "listAttendanceCorrections" })
  @ApiOkResponse({ schema: openApi(correctionsResponseSchema) })
  async listCorrections(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.corrections.list(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      correctionListQuerySchema.parse(query),
      req,
    );
  }

  @Post("corrections/:id/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve a correction (applies it to the record)",
    description: `Requires attendance.confirm and someone other than the requester. ${versioned}`,
    operationId: "approveAttendanceCorrection",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(approveDecisionRequestSchema) })
  @ApiOkResponse({ schema: openApi(correctionResponseSchema) })
  async approveCorrection(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.corrections.approve(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      approveDecisionRequestSchema.parse(body),
      req,
    );
  }

  @Post("corrections/:id/reject")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reject a correction with a reason",
    description: `Requires attendance.confirm and someone other than the requester. ${versioned}`,
    operationId: "rejectAttendanceCorrection",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(rejectDecisionRequestSchema) })
  @ApiOkResponse({ schema: openApi(correctionResponseSchema) })
  async rejectCorrection(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.corrections.reject(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      rejectDecisionRequestSchema.parse(body),
      req,
    );
  }

  // Anomalies --------------------------------------------------------------------------------------

  @Get("anomalies")
  @ApiOperation({
    summary: "Attendance anomalies on projects where the caller holds attendance.view",
    operationId: "listAttendanceAnomalies",
  })
  @ApiOkResponse({ schema: openApi(anomaliesResponseSchema) })
  async listAnomalies(@Query() query: unknown, @Req() req: Request) {
    return this.anomalies.list(
      await this.auth.principal(req),
      anomalyListQuerySchema.parse(query),
      req,
    );
  }

  @Post("anomalies/:id/review")
  @HttpCode(200)
  @ApiOperation({
    summary: "Resolve or dismiss an open anomaly with a reason",
    description: `Requires attendance.review_anomalies and someone who did not record the attendance. ${versioned}`,
    operationId: "reviewAttendanceAnomaly",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(reviewAnomalyRequestSchema) })
  @ApiOkResponse({ schema: openApi(anomalyResponseSchema) })
  async reviewAnomaly(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.anomalies.review(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      reviewAnomalyRequestSchema.parse(body),
      req,
    );
  }

  // Periods ----------------------------------------------------------------------------------------

  @Get("projects/:projectId/periods")
  @ApiOperation({ summary: "Timesheet periods of a project", operationId: "listTimesheetPeriods" })
  @ApiOkResponse({ schema: openApi(periodsResponseSchema) })
  async listPeriods(@Param("projectId") projectId: string, @Req() req: Request) {
    return this.periods.list(await this.auth.principal(req), uuidSchema.parse(projectId), req);
  }

  @Get("periods/:id")
  @ApiOperation({
    summary: "A period's timesheet: live for open periods, the snapshot once approved",
    operationId: "getTimesheetPeriod",
  })
  @ApiOkResponse({ schema: openApi(periodDetailResponseSchema) })
  async getPeriod(@Param("id") id: string, @Req() req: Request) {
    return this.periods.detail(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Get("periods/:id/lines")
  @ApiOperation({
    summary: "Payroll-facing timesheet lines of an approved period (immutable snapshot)",
    description:
      "attendance.view, payroll.prepare or finance.view on the project; 409 period-not-approved.",
    operationId: "getTimesheetLines",
  })
  @ApiOkResponse({ schema: openApi(timesheetLinesResponseSchema) })
  async lines(@Param("id") id: string, @Req() req: Request) {
    return this.periods.lines(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Post("periods/:id/submit")
  @HttpCode(200)
  @ApiOperation({
    summary: "Submit a period after its cut-off",
    description: `Requires timesheets.submit; every day confirmed, no pending correction, rules configured. ${versioned}`,
    operationId: "submitTimesheetPeriod",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(periodActionRequestSchema) })
  @ApiOkResponse({ schema: openApi(periodDetailResponseSchema) })
  async submitPeriod(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.periods.submit(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      periodActionRequestSchema.parse(body),
      req,
    );
  }

  @Post("periods/:id/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve a submitted period: lock it and snapshot its timesheet lines",
    description: `Requires timesheets.approve and someone other than the submitter; no open anomaly; the content must equal what was submitted (409 period-changed). ${versioned}`,
    operationId: "approveTimesheetPeriod",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(periodActionRequestSchema) })
  @ApiOkResponse({ schema: openApi(periodDetailResponseSchema) })
  async approvePeriod(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.periods.approve(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      periodActionRequestSchema.parse(body),
      req,
    );
  }

  @Post("periods/:id/reject")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reject a submitted period with a reason",
    description: `Requires timesheets.approve and someone other than the submitter. ${versioned}`,
    operationId: "rejectTimesheetPeriod",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(rejectPeriodRequestSchema) })
  @ApiOkResponse({ schema: openApi(periodDetailResponseSchema) })
  async rejectPeriod(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.periods.reject(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      rejectPeriodRequestSchema.parse(body),
      req,
    );
  }

  @Post("periods/:id/reopen")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reopen a rejected period for changes",
    description: `Requires timesheets.submit. ${versioned}`,
    operationId: "reopenTimesheetPeriod",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(periodActionRequestSchema) })
  @ApiOkResponse({ schema: openApi(periodDetailResponseSchema) })
  async reopenPeriod(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.periods.reopen(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      periodActionRequestSchema.parse(body),
      req,
    );
  }

  // Adjustments ------------------------------------------------------------------------------------

  @Post("periods/:id/adjustments")
  @ApiOperation({
    summary: "Request an adjustment to a date of an approved period",
    description:
      "Requires attendance.override and step-up MFA; a reason. The approved period never changes: the delta lands in a later open period once someone else approves it.",
    operationId: "createTimesheetAdjustment",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(createAdjustmentRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(adjustmentResponseSchema) })
  async createAdjustment(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.adjustments.create(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      createAdjustmentRequestSchema.parse(body),
      req,
    );
  }

  @Get("projects/:projectId/adjustments")
  @ApiOperation({ summary: "Adjustments of a project", operationId: "listTimesheetAdjustments" })
  @ApiOkResponse({ schema: openApi(adjustmentsResponseSchema) })
  async listAdjustments(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.adjustments.list(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      adjustmentListQuerySchema.parse(query),
      req,
    );
  }

  @Post("adjustments/:id/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve an adjustment: fix its delta and land it in a later open period",
    description: `Requires timesheets.approve and someone other than the requester. ${versioned}`,
    operationId: "approveTimesheetAdjustment",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(approveDecisionRequestSchema) })
  @ApiOkResponse({ schema: openApi(adjustmentResponseSchema) })
  async approveAdjustment(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.adjustments.approve(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      approveDecisionRequestSchema.parse(body),
      req,
    );
  }

  @Post("adjustments/:id/reject")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reject an adjustment with a reason",
    description: `Requires timesheets.approve and someone other than the requester. ${versioned}`,
    operationId: "rejectTimesheetAdjustment",
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(rejectDecisionRequestSchema) })
  @ApiOkResponse({ schema: openApi(adjustmentResponseSchema) })
  async rejectAdjustment(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.adjustments.reject(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      rejectDecisionRequestSchema.parse(body),
      req,
    );
  }

  // Labourer summary -------------------------------------------------------------------------------

  @Get("labourers/:labourerId/summary")
  @ApiOperation({
    summary: "A labourer's days, hours and overtime per project (approved and pending)",
    description: "attendance.view on a project the labourer is (or was) engaged on.",
    operationId: "getLabourerAttendance",
  })
  @ApiOkResponse({ schema: openApi(labourerAttendanceResponseSchema) })
  async labourerSummary(
    @Param("labourerId") labourerId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.periods.labourerSummary(
      await this.auth.principal(req),
      uuidSchema.parse(labourerId),
      labourerAttendanceQuerySchema.parse(query),
      req,
    );
  }
}
