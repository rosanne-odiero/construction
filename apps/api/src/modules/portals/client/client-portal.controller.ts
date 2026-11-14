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
  clientDecisionRequestSchema,
  clientDiariesQuerySchema,
  clientDiariesResponseSchema,
  clientDisplayQuerySchema,
  clientExportQuerySchema,
  clientPayResponseSchema,
  clientPaymentsResponseSchema,
  clientPhotosQuerySchema,
  clientPhotosResponseSchema,
  clientPortalOverviewResponseSchema,
  clientPortalProjectsResponseSchema,
  clientPreferencesResponseSchema,
  clientProgressQuerySchema,
  clientProgressResponseSchema,
  clientStatementResponseSchema,
  clientStkPushRequestSchema,
  clientVariationDetailResponseSchema,
  clientVariationsResponseSchema,
  createFxRateRequestSchema,
  fxRatesResponseSchema,
  idempotencyKeySchema,
  paymentInstructionsResponseSchema,
  recordClientPaymentRequestSchema,
  reverseClientPaymentRequestSchema,
  sendVariationToClientRequestSchema,
  updateClientPreferencesRequestSchema,
  updateClientSettingsRequestSchema,
  updatePaymentInstructionsRequestSchema,
  variationClientResponseSchema,
} from "@pm-buddy/validation";
import type { Request, Response } from "express";
import { openApi } from "../../../common/openapi.js";
import { AuthService } from "../../identity/auth.service.js";
import { BrowserGuard } from "../../identity/identity.controller.js";
import { uuidSchema } from "../../identity/identity.schemas.js";
import { ClientCompanyService } from "./client-company.service.js";
import { ClientExportService } from "./client-export.service.js";
import { ClientPaymentsService } from "./client-payments.service.js";
import { ClientPortalDatabaseErrors, clientPortalProblem } from "./client-portal-access.js";
import { ClientPortalService } from "./client-portal.service.js";
import { ClientVariationsService } from "./client-variations.service.js";

const clientNote =
  "Client portal (D7.1): portal.client with no staff permission (403 client-portal-only otherwise), on a project the client is assigned to; any other project or record ID answers 404.";
const currencyQuery = { name: "currency", required: false, enum: ["KES", "USD", "GBP", "EUR"] };
const id = (value: string) => uuidSchema.parse(value);

/** The Idempotency-Key header (400 idempotency-key-required when missing or malformed). */
function idempotencyKey(req: Request): string {
  const parsed = idempotencyKeySchema.safeParse(req.headers["idempotency-key"]);
  if (!parsed.success)
    throw clientPortalProblem(
      400,
      "idempotency-key-required",
      "Send an Idempotency-Key header (8–100 characters)",
    );
  return parsed.data;
}

const file = (result: { content: Buffer; contentType: string; disposition: string }) =>
  new StreamableFile(result.content, {
    type: result.contentType,
    disposition: result.disposition,
    length: result.content.length,
  });

/** The client's side of the client portal (`/api/v1/portal/client/…`). */
@ApiTags("client portal")
@UseGuards(BrowserGuard)
@UseInterceptors(ClientPortalDatabaseErrors)
@Controller({ path: "portal/client", version: "1" })
export class ClientPortalController {
  constructor(
    private readonly auth: AuthService,
    private readonly portal: ClientPortalService,
    private readonly exports: ClientExportService,
  ) {}

  @Get("projects")
  @ApiOperation({
    operationId: "listClientProjects",
    summary: "The client's assigned projects with what is owed and variations awaiting a decision",
    description: clientNote,
  })
  @ApiQuery(currencyQuery)
  @ApiOkResponse({ schema: openApi(clientPortalProjectsResponseSchema) })
  async projects(@Query() query: unknown, @Req() req: Request) {
    return this.portal.projects(
      await this.auth.principal(req),
      clientDisplayQuerySchema.parse(query).currency,
      req,
    );
  }

  @Get("projects/:projectId")
  @ApiOperation({
    operationId: "getClientProject",
    summary:
      "A project's overview: progress, milestones, latest approved diaries, next payment due",
    description: `${clientNote} Progress is earned value ÷ BAC (null = not available, never 0).`,
  })
  @ApiQuery(currencyQuery)
  @ApiOkResponse({ schema: openApi(clientPortalOverviewResponseSchema) })
  async overview(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.portal.overview(
      await this.auth.principal(req),
      id(projectId),
      clientDisplayQuerySchema.parse(query).currency,
      req,
    );
  }

  @Get("projects/:projectId/progress")
  @ApiOperation({
    operationId: "getClientProgress",
    summary: "Progress and the S-curve: planned against earned value at contract rates (no costs)",
    description: `${clientNote} 400 as-of-future.`,
  })
  @ApiQuery({ name: "asOf", required: false })
  @ApiQuery(currencyQuery)
  @ApiOkResponse({ schema: openApi(clientProgressResponseSchema) })
  async progress(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.portal.progress(
      await this.auth.principal(req),
      id(projectId),
      clientProgressQuerySchema.parse(query).asOf,
      clientDisplayQuerySchema.parse(query).currency,
      req,
    );
  }

  @Get("projects/:projectId/photos")
  @ApiOperation({
    operationId: "listClientPhotos",
    summary:
      "The photo timeline: general site photos, newest first, with their verification checks",
    description: `${clientNote} Never incident photos, coordinates or uploaders.`,
  })
  @ApiOkResponse({ schema: openApi(clientPhotosResponseSchema) })
  async photos(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.portal.photos(
      await this.auth.principal(req),
      id(projectId),
      clientPhotosQuerySchema.parse(query),
      req,
    );
  }

  @Get("projects/:projectId/photos/:photoId/image")
  @ApiOperation({
    operationId: "getClientPhotoImage",
    summary: "A general photo's thumbnail (JPEG without metadata); the original is never served",
    description: clientNote,
  })
  @ApiProduces("image/jpeg")
  async image(
    @Param("projectId") projectId: string,
    @Param("photoId") photoId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const content = await this.portal.photoImage(
      await this.auth.principal(req),
      id(projectId),
      id(photoId),
      req,
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", "private, max-age=300");
    return new StreamableFile(content, {
      type: "image/jpeg",
      disposition: `inline; filename="photo-${photoId}.jpg"`,
      length: content.length,
    });
  }

  @Get("projects/:projectId/diaries")
  @ApiOperation({
    operationId: "listClientDiaries",
    summary: "Approved site diaries, newest first; the workforce as headcounts by trade",
    description: `${clientNote} Never drafts, reviewers or workers' names.`,
  })
  @ApiOkResponse({ schema: openApi(clientDiariesResponseSchema) })
  async diaries(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.portal.diaries(
      await this.auth.principal(req),
      id(projectId),
      clientDiariesQuerySchema.parse(query),
      req,
    );
  }

  @Get("projects/:projectId/statement")
  @ApiOperation({
    operationId: "getClientStatement",
    summary: "Certified certificates, recorded receipts and what is outstanding and overdue",
    description: `${clientNote} Paid = receipts the contractor recorded; nothing else marks a payment.`,
  })
  @ApiQuery(currencyQuery)
  @ApiOkResponse({ schema: openApi(clientStatementResponseSchema) })
  async statement(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.portal.statement(
      await this.auth.principal(req),
      id(projectId),
      clientDisplayQuerySchema.parse(query).currency,
      req,
    );
  }

  @Get("projects/:projectId/statement/export/pdf")
  @ApiOperation({
    operationId: "exportClientStatementPdf",
    summary: "The client statement as an A4 PDF (EN or SW, KES)",
    description: `${clientNote} Rate limited; 422 export-too-large above 5,000 lines.`,
  })
  @ApiQuery({ name: "locale", required: false, enum: ["en", "sw"] })
  @ApiProduces("application/pdf")
  async statementPdf(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return file(
      await this.exports.pdf(
        await this.auth.principal(req),
        id(projectId),
        clientExportQuerySchema.parse(query).locale,
        false,
        req,
      ),
    );
  }

  @Get("projects/:projectId/statement/export/xlsx")
  @ApiOperation({
    operationId: "exportClientStatementExcel",
    summary: "The client statement as Excel (EN or SW, KES)",
    description: `${clientNote} Text cells are neutralised against formula injection.`,
  })
  @ApiQuery({ name: "locale", required: false, enum: ["en", "sw"] })
  @ApiProduces("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  async statementXlsx(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return file(
      await this.exports.xlsx(
        await this.auth.principal(req),
        id(projectId),
        clientExportQuerySchema.parse(query).locale,
        false,
        req,
      ),
    );
  }

  @Get("projects/:projectId/certificates/:valuationId/pdf")
  @ApiOperation({
    operationId: "getClientCertificatePdf",
    summary: "A certified payment certificate as the D6.3 PDF (EN or SW)",
    description: `${clientNote} Certified certificates only (a draft or submitted valuation is 404).`,
  })
  @ApiQuery({ name: "locale", required: false, enum: ["en", "sw"] })
  @ApiProduces("application/pdf")
  async certificatePdf(
    @Param("projectId") projectId: string,
    @Param("valuationId") valuationId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return file(
      await this.exports.certificatePdf(
        await this.auth.principal(req),
        id(projectId),
        id(valuationId),
        clientExportQuerySchema.parse(query).locale,
        req,
      ),
    );
  }

  @Get("projects/:projectId/pay")
  @ApiOperation({
    operationId: "getClientPayInstructions",
    summary: "How to pay: the contractor's Paybill, account references and what is outstanding",
    description: `${clientNote} Pay with M-Pesa (STK Push) is not available until the Daraja integration (D4.2).`,
  })
  @ApiQuery(currencyQuery)
  @ApiOkResponse({ schema: openApi(clientPayResponseSchema) })
  async pay(@Param("projectId") projectId: string, @Query() query: unknown, @Req() req: Request) {
    return this.portal.pay(
      await this.auth.principal(req),
      id(projectId),
      clientDisplayQuerySchema.parse(query).currency,
      req,
    );
  }

  @Post("projects/:projectId/certificates/:valuationId/stk-push")
  @HttpCode(202)
  @ApiOperation({
    operationId: "requestClientStkPush",
    summary: "Pay a certificate with M-Pesa (STK Push) — refused until D4.2",
    description: `${clientNote} Checked first (404, 409 nothing-outstanding, 422 amount-exceeds-outstanding), then 503 stk-push-unavailable: the payment provider is not connected yet. Use the Paybill instructions.`,
  })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ schema: openApi(clientStkPushRequestSchema) })
  async stkPush(
    @Param("projectId") projectId: string,
    @Param("valuationId") valuationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.portal.requestStkPush(
      await this.auth.principal(req),
      id(projectId),
      id(valuationId),
      clientStkPushRequestSchema.parse(body),
      idempotencyKey(req),
      req,
    );
  }

  @Get("projects/:projectId/variations")
  @ApiOperation({
    operationId: "listClientVariations",
    summary: "Variations the contractor sent to the client, with their decision state",
    description: clientNote,
  })
  @ApiQuery(currencyQuery)
  @ApiOkResponse({ schema: openApi(clientVariationsResponseSchema) })
  async variations(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.portal.variations(
      await this.auth.principal(req),
      id(projectId),
      clientDisplayQuerySchema.parse(query).currency,
      req,
    );
  }

  @Get("projects/:projectId/variations/:requestId")
  @ApiOperation({
    operationId: "getClientVariation",
    summary: "A variation as it was sent to the client (lines, rates, amounts) and its digest",
    description: clientNote,
  })
  @ApiQuery(currencyQuery)
  @ApiOkResponse({ schema: openApi(clientVariationDetailResponseSchema) })
  async variation(
    @Param("projectId") projectId: string,
    @Param("requestId") requestId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.portal.variation(
      await this.auth.principal(req),
      id(projectId),
      id(requestId),
      clientDisplayQuerySchema.parse(query).currency,
      req,
    );
  }

  @Post("projects/:projectId/variations/:requestId/decision")
  @HttpCode(200)
  @ApiOperation({
    operationId: "decideClientVariation",
    summary: "Approve or reject a variation sent to you, once, on the figures you saw",
    description: `${clientNote} Quotes clientDigest (409 variation-stale); a rejection needs a comment; 409 already-decided, request-closed.`,
  })
  @ApiBody({ schema: openApi(clientDecisionRequestSchema) })
  @ApiOkResponse({ schema: openApi(clientVariationDetailResponseSchema) })
  async decide(
    @Param("projectId") projectId: string,
    @Param("requestId") requestId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.portal.decide(
      await this.auth.principal(req),
      id(projectId),
      id(requestId),
      clientDecisionRequestSchema.parse(body),
      req,
    );
  }

  @Get("preferences")
  @ApiOperation({
    operationId: "getClientPreferences",
    summary: "The client's display currency and the newest indicative rates",
    description: clientNote,
  })
  @ApiOkResponse({ schema: openApi(clientPreferencesResponseSchema) })
  async preferences(@Req() req: Request) {
    return this.portal.preferences(await this.auth.principal(req), req);
  }

  @Put("preferences")
  @ApiOperation({
    operationId: "updateClientPreferences",
    summary: "Choose the display currency (KES, USD, GBP or EUR; indicative only)",
    description: clientNote,
  })
  @ApiBody({ schema: openApi(updateClientPreferencesRequestSchema) })
  @ApiOkResponse({ schema: openApi(clientPreferencesResponseSchema) })
  async updatePreferences(@Body() body: unknown, @Req() req: Request) {
    return this.portal.updatePreferences(
      await this.auth.principal(req),
      updateClientPreferencesRequestSchema.parse(body).displayCurrency,
      req,
    );
  }
}

const receiptNote =
  "finance.manage on the project; certified certificates only (409 certificate-not-certified); never more than is outstanding (409 receipt-exceeds-outstanding); dated today or earlier (422 receipt-date-invalid). Offline-ready: client ID + Idempotency-Key (a replay returns the view; another payload is 409 idempotency-key-reused).";

/** Company staff's side of the client portal: receipts, client terms, Paybill, FX, variations. */
@ApiTags("client portal")
@UseGuards(BrowserGuard)
@UseInterceptors(ClientPortalDatabaseErrors)
@Controller({ version: "1" })
export class ClientPortalStaffController {
  constructor(
    private readonly auth: AuthService,
    private readonly payments: ClientPaymentsService,
    private readonly company: ClientCompanyService,
    private readonly variations: ClientVariationsService,
    private readonly exports: ClientExportService,
  ) {}

  @Get("projects/:projectId/client-payments")
  @ApiOperation({
    operationId: "listClientPayments",
    summary: "The project's client ledger: certificates, receipts and reversals, terms",
    description: "bq.edit, finance.view or finance.manage on the project.",
  })
  @ApiOkResponse({ schema: openApi(clientPaymentsResponseSchema) })
  async view(@Param("projectId") projectId: string, @Req() req: Request) {
    return this.payments.view(await this.auth.principal(req), id(projectId), req);
  }

  @Post("projects/:projectId/client-payments")
  @HttpCode(200)
  @ApiOperation({
    operationId: "recordClientPayment",
    summary: "Record money received from the client against a certified certificate",
    description: receiptNote,
  })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ schema: openApi(recordClientPaymentRequestSchema) })
  @ApiOkResponse({ schema: openApi(clientPaymentsResponseSchema) })
  async record(@Param("projectId") projectId: string, @Body() body: unknown, @Req() req: Request) {
    return this.payments.record(
      await this.auth.principal(req),
      id(projectId),
      recordClientPaymentRequestSchema.parse(body),
      idempotencyKey(req),
      req,
    );
  }

  @Post("projects/:projectId/client-payments/:paymentId/reverse")
  @HttpCode(200)
  @ApiOperation({
    operationId: "reverseClientPayment",
    summary: "Reverse a receipt in full with a reason (shown to the client); never edited",
    description:
      "finance.manage on the project; once per receipt (409 receipt-already-reversed). Idempotency-Key required.",
  })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ schema: openApi(reverseClientPaymentRequestSchema) })
  @ApiOkResponse({ schema: openApi(clientPaymentsResponseSchema) })
  async reverse(
    @Param("projectId") projectId: string,
    @Param("paymentId") paymentId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.payments.reverse(
      await this.auth.principal(req),
      id(projectId),
      id(paymentId),
      reverseClientPaymentRequestSchema.parse(body),
      idempotencyKey(req),
      req,
    );
  }

  @Get("projects/:projectId/client-payments/statement/pdf")
  @ApiOperation({
    operationId: "exportStaffClientStatementPdf",
    summary: "The client statement as an A4 PDF, for staff (EN or SW)",
    description: "bq.edit, finance.view or finance.manage on the project. Rate limited.",
  })
  @ApiQuery({ name: "locale", required: false, enum: ["en", "sw"] })
  @ApiProduces("application/pdf")
  async statementPdf(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return file(
      await this.exports.pdf(
        await this.auth.principal(req),
        id(projectId),
        clientExportQuerySchema.parse(query).locale,
        true,
        req,
      ),
    );
  }

  @Get("projects/:projectId/client-payments/statement/xlsx")
  @ApiOperation({
    operationId: "exportStaffClientStatementExcel",
    summary: "The client statement as Excel, for staff (EN or SW)",
    description: "bq.edit, finance.view or finance.manage on the project. Rate limited.",
  })
  @ApiQuery({ name: "locale", required: false, enum: ["en", "sw"] })
  @ApiProduces("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  async statementXlsx(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return file(
      await this.exports.xlsx(
        await this.auth.principal(req),
        id(projectId),
        clientExportQuerySchema.parse(query).locale,
        true,
        req,
      ),
    );
  }

  @Put("projects/:projectId/client-settings")
  @ApiOperation({
    operationId: "updateClientSettings",
    summary: "New version of the project's client terms (variation approval, payment period)",
    description:
      "projects.manage on the project, on the version read (0 = defaults; 409 version-conflict). Certificates keep the payment period in force when they were certified.",
  })
  @ApiBody({ schema: openApi(updateClientSettingsRequestSchema) })
  @ApiOkResponse({ schema: openApi(clientPaymentsResponseSchema) })
  async settings(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.payments.updateSettings(
      await this.auth.principal(req),
      id(projectId),
      updateClientSettingsRequestSchema.parse(body),
      req,
    );
  }

  @Get("projects/:projectId/bq/variations/:variationId/client")
  @ApiOperation({
    operationId: "getVariationClientRequests",
    summary: "A variation's sendings to the client and the client's decisions",
    description: "bq.view on the project (clients use the portal instead: 403 client-portal-only).",
  })
  @ApiOkResponse({ schema: openApi(variationClientResponseSchema) })
  async variationClient(
    @Param("projectId") projectId: string,
    @Param("variationId") variationId: string,
    @Req() req: Request,
  ) {
    return this.variations.view(
      await this.auth.principal(req),
      id(projectId),
      id(variationId),
      req,
    );
  }

  @Post("projects/:projectId/bq/variations/:variationId/client")
  @HttpCode(200)
  @ApiOperation({
    operationId: "sendVariationToClient",
    summary: "Send the submitted variation to the client for a decision (frozen client view)",
    description:
      "bq.edit on the project; the current submission only (409 invalid-transition, variation-stale, version-conflict, already-sent, no-client-assigned).",
  })
  @ApiBody({ schema: openApi(sendVariationToClientRequestSchema) })
  @ApiOkResponse({ schema: openApi(variationClientResponseSchema) })
  async sendVariation(
    @Param("projectId") projectId: string,
    @Param("variationId") variationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.variations.send(
      await this.auth.principal(req),
      id(projectId),
      id(variationId),
      sendVariationToClientRequestSchema.parse(body),
      req,
    );
  }

  @Get("client-portal/payment-instructions")
  @ApiOperation({
    operationId: "getPaymentInstructions",
    summary: "The company's Paybill instructions shown to clients",
    description: "config.manage, finance.view or finance.manage.",
  })
  @ApiOkResponse({ schema: openApi(paymentInstructionsResponseSchema) })
  async instructions(@Req() req: Request) {
    return this.company.instructions(await this.auth.principal(req), req);
  }

  @Put("client-portal/payment-instructions")
  @ApiOperation({
    operationId: "updatePaymentInstructions",
    summary: "New version of the Paybill instructions (Paybill/till, account format, bank text)",
    description:
      "config.manage with step-up (403 step-up-required); on the version read (409 version-conflict). Audited.",
  })
  @ApiBody({ schema: openApi(updatePaymentInstructionsRequestSchema) })
  @ApiOkResponse({ schema: openApi(paymentInstructionsResponseSchema) })
  async updateInstructions(@Body() body: unknown, @Req() req: Request) {
    return this.company.updateInstructions(
      await this.auth.principal(req),
      updatePaymentInstructionsRequestSchema.parse(body),
      req,
    );
  }

  @Get("client-portal/fx-rates")
  @ApiOperation({
    operationId: "listFxRates",
    summary: "Indicative FX rates (KES per USD, GBP, EUR) entered by finance",
    description: "config.manage, finance.view or finance.manage.",
  })
  @ApiOkResponse({ schema: openApi(fxRatesResponseSchema) })
  async rates(@Req() req: Request) {
    return this.company.rates(await this.auth.principal(req), req);
  }

  @Post("client-portal/fx-rates")
  @ApiOperation({
    operationId: "createFxRate",
    summary: "Enter an indicative rate: KES per unit, its date and source (append-only)",
    description:
      "Company-wide finance.manage or config.manage; dated today or earlier. No external FX service is called.",
  })
  @ApiBody({ schema: openApi(createFxRateRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(fxRatesResponseSchema) })
  async createRate(@Body() body: unknown, @Req() req: Request) {
    return this.company.createRate(
      await this.auth.principal(req),
      createFxRateRequestSchema.parse(body),
      req,
    );
  }
}
