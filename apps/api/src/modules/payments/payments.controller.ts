import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExcludeEndpoint,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import {
  balanceCheckResponseSchema,
  callbackListQuerySchema,
  caseListQuerySchema,
  createTestPaymentRequestSchema,
  paymentCallbackResponseSchema,
  paymentCallbacksResponseSchema,
  paymentRequestDetailResponseSchema,
  paymentRequestListQuerySchema,
  paymentRequestResponseSchema,
  paymentRequestsResponseSchema,
  paymentSettingsResponseSchema,
  paymentsOverviewResponseSchema,
  payoutSwitchRequestSchema,
  reconciliationCaseResponseSchema,
  reconciliationCasesResponseSchema,
  requestReversalRequestSchema,
  resolveCaseRequestSchema,
  reviewCallbackRequestSchema,
  rotateCallbackTokenRequestSchema,
  updatePaymentCredentialsRequestSchema,
  updatePaymentSettingsRequestSchema,
} from "@pm-buddy/validation";
import type { Response } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { CallbackIntake } from "./callback-intake.js";
import type { CallbackRequest } from "./callback-body.js";
import { ReconciliationService } from "./reconciliation.service.js";
import { PaymentRequestsService } from "./requests.service.js";
import { PaymentSettingsService } from "./settings.service.js";

const required = {
  name: "Idempotency-Key",
  required: true,
  description:
    "Required, 8–128 letters, digits, '-' or '_'. A retry with the same key and payload returns the original response (Idempotent-Replayed: true); another payload is 409 idempotency-key-reused.",
};
const optional = { ...required, required: false, description: `Optional. ${required.description.slice(10)}` };
const stepUp = "Needs MFA verified within five minutes (403 step-up-required).";
const versioned = "Send the version you read (409 version-conflict otherwise).";

@ApiTags("payments")
@UseGuards(BrowserGuard)
@Controller({ path: "payments", version: "1" })
export class PaymentsController {
  constructor(
    private readonly auth: AuthService,
    private readonly settings: PaymentSettingsService,
    private readonly requests: PaymentRequestsService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Get("overview")
  @ApiOperation({
    summary: "Payments console overview: counts, alerts, the latest float check and receipts",
    description: "Requires payments.view from a company-wide role.",
    operationId: "getPaymentsOverview",
  })
  @ApiOkResponse({ schema: openApi(paymentsOverviewResponseSchema) })
  async overview(@Req() req: CallbackRequest) {
    return this.reconciliation.overview(await this.auth.principal(req), req);
  }

  // Settings ---------------------------------------------------------------------------------------

  @Get("settings")
  @ApiOperation({
    summary: "Daraja settings: environment, shortcodes, limits, secret status, callback URLs",
    description:
      "payments.view or payments.manage_credentials. Secrets are never returned, only whether each is set and when.",
    operationId: "getPaymentSettings",
  })
  @ApiOkResponse({ schema: openApi(paymentSettingsResponseSchema) })
  async getSettings(@Req() req: CallbackRequest) {
    return this.settings.get(await this.auth.principal(req), req);
  }

  @Post("settings")
  @ApiOperation({
    summary: "Configure payments: mock environment, DEMO limits, payouts off, a callback token",
    description: `Requires payments.manage_credentials. ${stepUp}`,
    operationId: "initialisePaymentSettings",
  })
  @ApiHeader(optional)
  @ApiCreatedResponse({ schema: openApi(paymentSettingsResponseSchema) })
  async initialise(@Req() req: CallbackRequest) {
    return this.settings.initialise(await this.auth.principal(req), req);
  }

  @Put("settings")
  @ApiOperation({
    summary: "Change the environment, shortcodes and limits",
    description: `Requires payments.manage_credentials. ${stepUp} ${versioned} production is refused (409 production-not-enabled, CR-PMT-04).`,
    operationId: "updatePaymentSettings",
  })
  @ApiHeader(optional)
  @ApiBody({ schema: openApi(updatePaymentSettingsRequestSchema) })
  @ApiOkResponse({ schema: openApi(paymentSettingsResponseSchema) })
  @ApiConflictResponse({ description: "production-not-enabled, environment-unavailable, version-conflict" })
  async updateSettings(@Body() body: unknown, @Req() req: CallbackRequest) {
    return this.settings.update(await this.auth.principal(req), req, updatePaymentSettingsRequestSchema.parse(body));
  }

  @Put("settings/credentials")
  @ApiOperation({
    summary: "Replace Daraja secrets (write-only)",
    description: `Requires payments.manage_credentials. ${stepUp} ${versioned} Send only the secrets to replace; they are sealed with field encryption and never returned, logged or audited (the audit names the fields).`,
    operationId: "updatePaymentCredentials",
  })
  @ApiHeader(optional)
  @ApiBody({ schema: openApi(updatePaymentCredentialsRequestSchema) })
  @ApiOkResponse({ schema: openApi(paymentSettingsResponseSchema) })
  async updateCredentials(@Body() body: unknown, @Req() req: CallbackRequest) {
    return this.settings.updateCredentials(
      await this.auth.principal(req),
      req,
      updatePaymentCredentialsRequestSchema.parse(body),
    );
  }

  @Put("settings/payouts")
  @ApiOperation({
    summary: "Payout master switch (off by default)",
    description: `Enabling needs payments.manage_credentials and a step-up; pausing needs payments.manage_credentials or payments.review. ${versioned} Off blocks every new outbound provider call without touching queued work.`,
    operationId: "setPayoutSwitch",
  })
  @ApiHeader(optional)
  @ApiBody({ schema: openApi(payoutSwitchRequestSchema) })
  @ApiOkResponse({ schema: openApi(paymentSettingsResponseSchema) })
  async payouts(@Body() body: unknown, @Req() req: CallbackRequest) {
    return this.settings.setPayouts(await this.auth.principal(req), req, payoutSwitchRequestSchema.parse(body));
  }

  @Post("settings/callback-token")
  @HttpCode(200)
  @ApiOperation({
    summary: "Rotate the callback path token",
    description: `Requires payments.manage_credentials. ${stepUp} ${versioned} The old token keeps working for 72 hours.`,
    operationId: "rotatePaymentCallbackToken",
  })
  @ApiHeader(optional)
  @ApiBody({ schema: openApi(rotateCallbackTokenRequestSchema) })
  @ApiOkResponse({ schema: openApi(paymentSettingsResponseSchema) })
  async rotate(@Body() body: unknown, @Req() req: CallbackRequest) {
    return this.settings.rotateToken(await this.auth.principal(req), req, rotateCallbackTokenRequestSchema.parse(body));
  }

  @Post("settings/c2b-registration")
  @HttpCode(200)
  @ApiOperation({
    summary: "Register the C2B confirmation and validation URLs with Daraja",
    description: `Requires payments.manage_credentials. ${stepUp} Registers ResponseType "Completed" (M-Pesa completes payments when validation is unreachable). The worker makes the call; the answer appears as a provider query.`,
    operationId: "registerC2bUrls",
  })
  @ApiHeader(optional)
  @ApiOkResponse({ schema: openApi(paymentSettingsResponseSchema) })
  async registerC2b(@Req() req: CallbackRequest) {
    return this.settings.registerC2b(await this.auth.principal(req), req);
  }

  @Post("balance-checks")
  @HttpCode(200)
  @ApiOperation({
    summary: "Request an Account Balance check (advisory float check)",
    description:
      "payments.review, payments.manage_credentials or payments.initiate_test. Answered asynchronously; a balance races with other payouts and reserves nothing.",
    operationId: "requestBalanceCheck",
  })
  @ApiHeader(optional)
  @ApiOkResponse({ schema: openApi(balanceCheckResponseSchema) })
  async balance(@Req() req: CallbackRequest) {
    return this.requests.requestBalance(await this.auth.principal(req), req, (scope) =>
      this.settings.assertBalanceAccess(scope),
    );
  }

  // Requests and attempts -----------------------------------------------------------------------

  @Get("requests")
  @ApiOperation({ summary: "Payment requests with their latest attempt", operationId: "listPaymentRequests" })
  @ApiOkResponse({ schema: openApi(paymentRequestsResponseSchema) })
  async list(@Query() query: unknown, @Req() req: CallbackRequest) {
    return this.requests.list(await this.auth.principal(req), req, paymentRequestListQuerySchema.parse(query));
  }

  @Post("requests")
  @ApiOperation({
    summary: "Create a test transaction (mock or sandbox)",
    description:
      "Requires payments.initiate_test and an Idempotency-Key. Purpose `test` only; checks the configured limits. The attempt is queued for the worker; outbound kinds wait while payouts are off. Never reports a payment as paid: watch the attempt's state.",
    operationId: "createTestPaymentRequest",
  })
  @ApiHeader(required)
  @ApiBody({ schema: openApi(createTestPaymentRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(paymentRequestResponseSchema) })
  @ApiConflictResponse({ description: "amount-above-limit, daily-limit-exceeded, payments-not-configured, idempotency-key-reused" })
  async create(@Body() body: unknown, @Req() req: CallbackRequest) {
    return this.requests.createTest(await this.auth.principal(req), req, createTestPaymentRequestSchema.parse(body));
  }

  @Get("requests/:id")
  @ApiOperation({
    summary: "A payment request with attempts, state timeline, callbacks (redacted), cases and receipts",
    operationId: "getPaymentRequest",
  })
  @ApiOkResponse({ schema: openApi(paymentRequestDetailResponseSchema) })
  async detail(@Param("id") id: string, @Req() req: CallbackRequest) {
    return this.requests.detail(await this.auth.principal(req), req, uuidSchema.parse(id));
  }

  @Post("attempts/:id/reversal")
  @HttpCode(200)
  @ApiOperation({
    summary: "Request a reversal of a confirmed attempt",
    description: `Requires payments.reverse and an Idempotency-Key; ${stepUp} Someone other than the request's creator (409 same-person). ${versioned}`,
    operationId: "requestPaymentReversal",
  })
  @ApiHeader(required)
  @ApiBody({ schema: openApi(requestReversalRequestSchema) })
  @ApiOkResponse({ schema: openApi(paymentRequestDetailResponseSchema) })
  async reverse(@Param("id") id: string, @Body() body: unknown, @Req() req: CallbackRequest) {
    return this.requests.requestReversal(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
      requestReversalRequestSchema.parse(body),
    );
  }

  @Post("attempts/:id/status-query")
  @HttpCode(200)
  @ApiOperation({
    summary: "Ask the provider for the status of a pending or unknown attempt",
    description: "Requires payments.review. Read-only reconciliation; never resubmits.",
    operationId: "queryPaymentStatus",
  })
  @ApiHeader(optional)
  @ApiOkResponse({ schema: openApi(paymentRequestDetailResponseSchema) })
  async statusQuery(@Param("id") id: string, @Req() req: CallbackRequest) {
    return this.requests.queryStatus(await this.auth.principal(req), req, uuidSchema.parse(id));
  }

  // Callbacks and reconciliation -------------------------------------------------------------

  @Get("callbacks")
  @ApiOperation({ summary: "Callback inbox (redacted bodies) and open alerts", operationId: "listPaymentCallbacks" })
  @ApiOkResponse({ schema: openApi(paymentCallbacksResponseSchema) })
  async callbacks(@Query() query: unknown, @Req() req: CallbackRequest) {
    return this.reconciliation.listCallbacks(await this.auth.principal(req), req, callbackListQuerySchema.parse(query));
  }

  @Get("callbacks/:id")
  @ApiOperation({ summary: "One callback (redacted)", operationId: "getPaymentCallback" })
  @ApiOkResponse({ schema: openApi(paymentCallbackResponseSchema) })
  async callback(@Param("id") id: string, @Req() req: CallbackRequest) {
    return this.reconciliation.getCallback(await this.auth.principal(req), req, uuidSchema.parse(id));
  }

  @Post("callbacks/:id/review")
  @HttpCode(200)
  @ApiOperation({
    summary: "Resolve or dismiss a quarantined callback with a reason",
    description: `Requires payments.review; ${stepUp} Not the creator of a linked payment. ${versioned}`,
    operationId: "reviewPaymentCallback",
  })
  @ApiHeader(optional)
  @ApiBody({ schema: openApi(reviewCallbackRequestSchema) })
  @ApiOkResponse({ schema: openApi(paymentCallbackResponseSchema) })
  async reviewCallback(@Param("id") id: string, @Body() body: unknown, @Req() req: CallbackRequest) {
    return this.reconciliation.reviewCallback(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
      reviewCallbackRequestSchema.parse(body),
    );
  }

  @Get("cases")
  @ApiOperation({ summary: "Reconciliation cases", operationId: "listReconciliationCases" })
  @ApiOkResponse({ schema: openApi(reconciliationCasesResponseSchema) })
  async cases(@Query() query: unknown, @Req() req: CallbackRequest) {
    return this.reconciliation.listCases(await this.auth.principal(req), req, caseListQuerySchema.parse(query));
  }

  @Get("cases/:id")
  @ApiOperation({ summary: "A reconciliation case with its history", operationId: "getReconciliationCase" })
  @ApiOkResponse({ schema: openApi(reconciliationCaseResponseSchema) })
  async getCase(@Param("id") id: string, @Req() req: CallbackRequest) {
    return this.reconciliation.getCase(await this.auth.principal(req), req, uuidSchema.parse(id));
  }

  @Post("cases/:id/resolve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Resolve a reconciliation case",
    description: `Requires payments.review; ${stepUp} Not the payment's creator (409 same-person). ${versioned} Confirming needs the M-Pesa receipt and exact amount (409 evidence-mismatch); an uncertain payment cannot be dismissed.`,
    operationId: "resolveReconciliationCase",
  })
  @ApiHeader(optional)
  @ApiBody({ schema: openApi(resolveCaseRequestSchema) })
  @ApiOkResponse({ schema: openApi(reconciliationCaseResponseSchema) })
  async resolve(@Param("id") id: string, @Body() body: unknown, @Req() req: CallbackRequest) {
    return this.reconciliation.resolveCase(
      await this.auth.principal(req),
      req,
      uuidSchema.parse(id),
      resolveCaseRequestSchema.parse(body),
    );
  }
}

/**
 * Provider callbacks: server to server, so no cookie, CSRF or Origin check applies here (the
 * BrowserGuard is on the console controller only). The body was read raw by callbackBodyReader.
 */
@Controller({ path: "payments/hooks", version: "1" })
export class PaymentCallbacksController {
  constructor(private readonly intake: CallbackIntake) {}

  @Post(":token/:kind")
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async receive(
    @Param("token") token: string,
    @Param("kind") kind: string,
    @Req() req: CallbackRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "no-store");
    return this.intake.receive(token, kind, req.rawCallbackBody ?? Buffer.alloc(0), req.ip);
  }
}
