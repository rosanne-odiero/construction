import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { MANUAL_PAYMENT_LIMITS } from "@pm-buddy/types";
import {
  approvalLimitsResponseSchema,
  approveBatchRequestSchema,
  approveBatchResponseSchema,
  batchApprovalResponseSchema,
  batchDecisionResponseSchema,
  batchPayoutsResponseSchema,
  clearFlagRequestSchema,
  confirmManualPaymentRequestSchema,
  destinationApprovalRequestSchema,
  floatCheckRequestSchema,
  floatCheckResponseSchema,
  manualPaymentResponseSchema,
  obligationResponseSchema,
  paymentEvidenceResponseSchema,
  payoutFlagResponseSchema,
  payoutSettingsResponseSchema,
  payrollNotificationResponseSchema,
  recordManualPaymentRequestSchema,
  rejectBatchRequestSchema,
  rejectManualPaymentRequestSchema,
  reopenBatchRequestSchema,
  resendNotificationRequestSchema,
  reviewBatchRequestSchema,
  startPayoutsRequestSchema,
  startPayoutsResponseSchema,
  updateApprovalLimitsRequestSchema,
  updatePayoutSettingsRequestSchema,
  updateWaiverRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { PayrollApprovalsService } from "./approvals.service.js";
import {
  EvidenceUploadGuard,
  ManualPaymentsService,
  type UploadedEvidence,
} from "./manual-payments.service.js";
import { PayoutSettingsService } from "./payout-settings.service.js";
import { PayrollPayoutsService } from "./payouts.service.js";

const optionalKey = {
  name: "Idempotency-Key",
  required: false,
  description:
    "Optional, 8–128 letters, digits, '-' or '_'. A retry with the same key and payload returns the original response; another payload is 409 idempotency-key-reused.",
};
const requiredKey = {
  name: "Idempotency-Key",
  required: true,
  description:
    "Required for money movements (400 idempotency-key-required): 8–128 letters, digits, '-' or '_'. A retry with the same key and payload returns the original response (Idempotent-Replayed: true).",
};
const versioned = "Send the version you read (409 version-conflict otherwise).";
const stepUp = "MFA verified within five minutes (403 mfa-required, step-up-required).";
const uploadLimits = {
  limits: {
    fileSize: MANUAL_PAYMENT_LIMITS.evidenceMaxBytes,
    files: 1,
    fields: 0,
    parts: 1,
    fieldNameSize: 50,
    headerPairs: 20,
  },
};
const fileBody = {
  schema: {
    type: "object",
    required: ["file"],
    properties: { file: { type: "string", format: "binary" } },
  },
};

/**
 * Payroll approvals and payouts (D4.3, `/api/v1/payroll/...`): the approval chain, the payouts of
 * an approved batch, cash and bank payments, destination re-approval, flags, notifications,
 * payout settings and approval limits. Problem codes are packages/types PAYOUT_PROBLEMS.
 */
@ApiTags("payroll")
@UseGuards(BrowserGuard)
@Controller({ path: "payroll", version: "1" })
export class PayrollPayoutsController {
  constructor(
    private readonly auth: AuthService,
    private readonly approvals: PayrollApprovalsService,
    private readonly payouts: PayrollPayoutsService,
    private readonly manual: ManualPaymentsService,
    private readonly settings: PayoutSettingsService,
  ) {}

  // Approval chain ---------------------------------------------------------------------------------

  @Get("batches/:id/approval")
  @ApiOperation({
    summary: "Approval readiness: recipients, verification, flags preview, limit and digest",
    description:
      "payroll.view, payroll.prepare, payroll.review or payroll.approve on the batch's project. `approvalDigest` binds the obligations and carry-forwards approval would create (D-167).",
    operationId: "getBatchApproval",
  })
  @ApiOkResponse({ schema: openApi(batchApprovalResponseSchema) })
  async approval(@Param("id") id: string, @Req() req: Request) {
    return this.approvals.readiness(await this.auth.principal(req), req, uuidSchema.parse(id));
  }

  @Post("batches/:id/review")
  @HttpCode(200)
  @ApiOperation({
    summary: "Review a submitted batch",
    description: `payroll.review on the project, not a contributor (403 maker-checker). ${versioned} 409 snapshot-changed when the digest differs, invalid-transition.`,
    operationId: "reviewPayrollBatch",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(reviewBatchRequestSchema) })
  @ApiOkResponse({ schema: openApi(batchDecisionResponseSchema) })
  async review(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.approvals.review(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
      reviewBatchRequestSchema.parse(body),
    );
  }

  @Post("batches/:id/reject")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reject a submitted or reviewed batch with a reason",
    description: `Submitted: payroll.review or payroll.approve; reviewed: payroll.approve. ${versioned} 409 invalid-transition.`,
    operationId: "rejectPayrollBatch",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(rejectBatchRequestSchema) })
  @ApiOkResponse({ schema: openApi(batchDecisionResponseSchema) })
  async reject(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.approvals.reject(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
      rejectBatchRequestSchema.parse(body),
    );
  }

  @Post("batches/:id/reopen")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reopen a rejected batch as a draft (version + 1)",
    description: `payroll.prepare on the project. ${versioned} 409 invalid-transition, project-read-only.`,
    operationId: "reopenPayrollBatch",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(reopenBatchRequestSchema) })
  @ApiOkResponse({ schema: openApi(batchDecisionResponseSchema) })
  async reopen(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.approvals.reopen(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
      reopenBatchRequestSchema.parse(body),
    );
  }

  @Post("batches/:id/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve a reviewed batch: obligations, carry-forwards, flags, accrued cost, notices",
    description: `payroll.approve and ${stepUp} Not a contributor nor (unless the owner's segregation waiver is on) the reviewer: 403 maker-checker; 403 no-approval-limit, approval-limit-exceeded (facts.limitMinor, facts.netMinor); 409 unverified-recipients (facts.labourerIds), snapshot-changed, invalid-transition. ${versioned}`,
    operationId: "approvePayrollBatch",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(approveBatchRequestSchema) })
  @ApiOkResponse({ schema: openApi(approveBatchResponseSchema) })
  @ApiForbiddenResponse({
    description: "maker-checker, no-approval-limit, approval-limit-exceeded, step-up-required",
  })
  @ApiConflictResponse({
    description: "unverified-recipients, snapshot-changed, invalid-transition, version-conflict",
  })
  async approve(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.approvals.approve(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
      approveBatchRequestSchema.parse(body),
    );
  }

  // Payouts --------------------------------------------------------------------------------------

  @Get("batches/:id/payouts")
  @ApiOperation({
    summary: "Obligations with live per-worker payout status, totals and the latest float",
    description:
      "payments.view, payments.disburse, payments.approve, payments.review or payroll.approve. Receiver names of name mismatches only for payments.approve / payments.review.",
    operationId: "getBatchPayouts",
  })
  @ApiOkResponse({ schema: openApi(batchPayoutsResponseSchema) })
  async batchPayouts(@Param("id") id: string, @Req() req: Request) {
    return this.payouts.view(await this.auth.principal(req), req, uuidSchema.parse(id));
  }

  @Post("batches/:id/float-check")
  @HttpCode(200)
  @ApiOperation({
    summary: "Ask M-Pesa for the account balance (D4.2 Account Balance)",
    description:
      "payments.disburse. Advisory: a payout start needs an answer at most floatCheckMaxAgeMinutes old.",
    operationId: "checkPayrollFloat",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(floatCheckRequestSchema) })
  @ApiOkResponse({ schema: openApi(floatCheckResponseSchema) })
  async floatCheck(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    floatCheckRequestSchema.parse(body ?? {});
    return this.payouts.floatCheck(await this.auth.principal(req), req, uuidSchema.parse(id));
  }

  @Post("batches/:id/payouts")
  @HttpCode(200)
  @ApiOperation({
    summary: "Start M-Pesa payouts for the eligible obligations (all or the listed ones)",
    description: `payments.disburse and ${stepUp} All or nothing. 409 payouts-paused, nothing-eligible, float-check-required, tariff-missing, insufficient-float (facts with the figures), daily-limit-exceeded; outside business hours the obligations are flagged instead (outcome outside_business_hours).`,
    operationId: "startPayrollPayouts",
  })
  @ApiHeader(requiredKey)
  @ApiBody({ schema: openApi(startPayoutsRequestSchema) })
  @ApiOkResponse({ schema: openApi(startPayoutsResponseSchema) })
  @ApiConflictResponse({
    description:
      "payouts-paused, nothing-eligible, float-check-required, tariff-missing, insufficient-float, daily-limit-exceeded, payout-in-flight",
  })
  async start(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.payouts.start(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
      startPayoutsRequestSchema.parse(body ?? {}),
    );
  }

  @Post("obligations/:id/destination-approval")
  @HttpCode(200)
  @ApiOperation({
    summary: "Re-approve an obligation's destination after the worker's number changed",
    description: `payroll.approve and ${stepUp} Not a batch contributor nor whoever changed the number (403 maker-checker). 409 destination-unchanged, destination-unverified, no-number, payout-in-flight, obligation-settled. ${versioned}`,
    operationId: "approveObligationDestination",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(destinationApprovalRequestSchema) })
  @ApiOkResponse({ schema: openApi(obligationResponseSchema) })
  async destination(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.payouts.approveDestination(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
      destinationApprovalRequestSchema.parse(body),
    );
  }

  @Post("flags/:id/clear")
  @HttpCode(200)
  @ApiOperation({
    summary: "Clear an unusual-payout flag with a reason",
    description: `payments.approve and ${stepUp} Not a batch contributor, its approver or (outside business hours) whoever tried to start the payout (403 maker-checker). 409 flag-cleared.`,
    operationId: "clearPayoutFlag",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(clearFlagRequestSchema) })
  @ApiOkResponse({ schema: openApi(payoutFlagResponseSchema) })
  async clearFlag(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.payouts.clearFlag(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
      clearFlagRequestSchema.parse(body),
    );
  }

  @Post("notifications/:id/resend")
  @HttpCode(200)
  @ApiOperation({
    summary: "Queue a failed payroll notification again (only that notification)",
    description: "payments.disburse. 409 notification-not-failed.",
    operationId: "resendPayrollNotification",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(resendNotificationRequestSchema) })
  @ApiOkResponse({ schema: openApi(payrollNotificationResponseSchema) })
  async resend(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    resendNotificationRequestSchema.parse(body ?? {});
    return this.payouts.resend(await this.auth.principal(req), req, uuidSchema.parse(id));
  }

  // Cash and bank --------------------------------------------------------------------------------

  @Post("obligations/:id/manual-payments")
  @HttpCode(201)
  @ApiOperation({
    summary: "Record a cash or bank payment towards an obligation (awaits confirmation)",
    description: `payments.record_cash and ${stepUp} 409 obligation-settled, payout-in-flight, amount-above-outstanding, cash-disabled, cash-cap-exceeded (facts.capMinor, facts.usedMinor).`,
    operationId: "recordManualPayment",
  })
  @ApiHeader(requiredKey)
  @ApiBody({ schema: openApi(recordManualPaymentRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(manualPaymentResponseSchema) })
  async recordManual(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.manual.record(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
      recordManualPaymentRequestSchema.parse(body),
    );
  }

  @Post("manual-payments/:id/evidence")
  @UseGuards(EvidenceUploadGuard)
  @UseInterceptors(FileInterceptor("file", uploadLimits))
  @ApiOperation({
    summary: "Add a photo or signature image to a cash or bank payment (at most three, 5 MB)",
    description:
      "payments.record_cash. JPEG, PNG or WebP (content sniffed, malware scan). 409 evidence-limit, invalid-transition.",
    operationId: "uploadPaymentEvidence",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody(fileBody)
  @ApiCreatedResponse({ schema: openApi(paymentEvidenceResponseSchema) })
  async evidence(
    @Param("id") id: string,
    @UploadedFile() file: UploadedEvidence | undefined,
    @Req() req: Request,
  ) {
    return this.manual.addEvidence(await this.auth.principal(req), req, uuidSchema.parse(id), file);
  }

  @Get("payout-evidence/:id")
  @ApiOperation({
    summary: "Download a payment evidence image",
    description: "Whoever may view the batch's payouts.",
    operationId: "downloadPaymentEvidence",
  })
  async downloadEvidence(@Param("id") id: string, @Req() req: Request) {
    const file = await this.manual.evidence(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
    );
    return new StreamableFile(file.content, {
      type: file.contentType,
      disposition: `inline; filename="${file.fileName}"`,
      length: file.content.length,
    });
  }

  @Post("manual-payments/:id/confirm")
  @HttpCode(200)
  @ApiOperation({
    summary: "Confirm a cash or bank payment (allocates it; may settle the obligation)",
    description: `payments.approve and ${stepUp} Not the recorder (403 maker-checker). 409 evidence-required (cash), invalid-transition. ${versioned}`,
    operationId: "confirmManualPayment",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(confirmManualPaymentRequestSchema) })
  @ApiOkResponse({ schema: openApi(manualPaymentResponseSchema) })
  async confirm(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.manual.confirm(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
      confirmManualPaymentRequestSchema.parse(body),
    );
  }

  @Post("manual-payments/:id/reject")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reject a cash or bank payment with a reason",
    description: `payments.approve and ${stepUp} Not the recorder (403 maker-checker). ${versioned}`,
    operationId: "rejectManualPayment",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(rejectManualPaymentRequestSchema) })
  @ApiOkResponse({ schema: openApi(manualPaymentResponseSchema) })
  async rejectManual(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.manual.reject(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
      rejectManualPaymentRequestSchema.parse(body),
    );
  }

  // Settings -------------------------------------------------------------------------------------

  @Get("payout-settings")
  @ApiOperation({
    summary: "Payout settings and the segregation waiver (the defaults until saved)",
    description: "payments.view, payroll.approve or config.manage.",
    operationId: "getPayoutSettings",
  })
  @ApiOkResponse({ schema: openApi(payoutSettingsResponseSchema) })
  async getSettings(@Req() req: Request) {
    return this.settings.get(await this.auth.principal(req), req);
  }

  @Put("payout-settings")
  @ApiOperation({
    summary: "Change the payout settings",
    description: `config.manage and ${stepUp} ${versioned} Version 0 saves over the defaults.`,
    operationId: "updatePayoutSettings",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(updatePayoutSettingsRequestSchema) })
  @ApiOkResponse({ schema: openApi(payoutSettingsResponseSchema) })
  async updateSettings(@Body() body: unknown, @Req() req: Request) {
    return this.settings.update(
      await this.auth.principal(req),
      req,
      updatePayoutSettingsRequestSchema.parse(body),
    );
  }

  @Put("payout-settings/waiver")
  @ApiOperation({
    summary: "Turn the segregation waiver on or off (OR-04)",
    description: `A member whose system role is owner (403 owner-only), config.manage and ${stepUp} A reason is required. ${versioned}`,
    operationId: "updateSegregationWaiver",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(updateWaiverRequestSchema) })
  @ApiOkResponse({ schema: openApi(payoutSettingsResponseSchema) })
  async updateWaiver(@Body() body: unknown, @Req() req: Request) {
    return this.settings.updateWaiver(
      await this.auth.principal(req),
      req,
      updateWaiverRequestSchema.parse(body),
    );
  }

  @Get("approval-limits")
  @ApiOperation({
    summary: "Batch approval limits per role (owner default KES 2,000,000)",
    description: "config.manage or payroll.approve.",
    operationId: "getApprovalLimits",
  })
  @ApiOkResponse({ schema: openApi(approvalLimitsResponseSchema) })
  async limits(@Req() req: Request) {
    return this.settings.limits(await this.auth.principal(req), req);
  }

  @Put("approval-limits")
  @ApiOperation({
    summary: "Replace the batch approval limits",
    description: `config.manage and ${stepUp} ${versioned}`,
    operationId: "updateApprovalLimits",
  })
  @ApiHeader(optionalKey)
  @ApiBody({ schema: openApi(updateApprovalLimitsRequestSchema) })
  @ApiOkResponse({ schema: openApi(approvalLimitsResponseSchema) })
  async updateLimits(@Body() body: unknown, @Req() req: Request) {
    return this.settings.updateLimits(
      await this.auth.principal(req),
      req,
      updateApprovalLimitsRequestSchema.parse(body),
    );
  }
}
