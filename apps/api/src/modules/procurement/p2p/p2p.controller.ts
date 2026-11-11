import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { P2P_LIMITS } from "@pm-buddy/types";
import {
  approveInvoiceRequestSchema,
  awardRfqRequestSchema,
  commitmentsQuerySchema,
  commitmentsResponseSchema,
  createGrnRequestSchema,
  createInvoiceRequestSchema,
  createRequisitionRequestSchema,
  createRfqRequestSchema,
  grnListQuerySchema,
  grnPhotoQuerySchema,
  grnResponseSchema,
  grnsResponseSchema,
  idempotencyKeySchema,
  inboxResponseSchema,
  invoiceDetailResponseSchema,
  invoiceListQuerySchema,
  invoicesResponseSchema,
  lpoDetailResponseSchema,
  lpoListQuerySchema,
  lposResponseSchema,
  matchExceptionRequestSchema,
  procurementDocumentResponseSchema,
  reasonRequestSchema,
  receivableLposResponseSchema,
  recordQuotationRequestSchema,
  recordSettlementRequestSchema,
  requisitionDetailResponseSchema,
  requisitionListQuerySchema,
  requisitionsResponseSchema,
  rfqDetailResponseSchema,
  rfqExceptionRequestSchema,
  rfqListQuerySchema,
  rfqsResponseSchema,
  updateInvoiceRequestSchema,
  updateLpoRequestSchema,
  updateRequisitionRequestSchema,
  updateRfqRequestSchema,
  versionRequestSchema,
  voidGrnRequestSchema,
  withdrawQuotationRequestSchema,
} from "@pm-buddy/validation";
import type { Request, Response } from "express";
import { z } from "zod";
import { openApi } from "../../../common/openapi.js";
import { AuthService } from "../../identity/auth.service.js";
import { BrowserGuard } from "../../identity/identity.controller.js";
import { uuidSchema } from "../../identity/identity.schemas.js";
import { GrnsService } from "./grns.service.js";
import { InvoicesService } from "./invoices.service.js";
import { LposService } from "./lpos.service.js";
import { p2pBadRequest } from "./p2p-common.js";
import {
  P2pDocumentsService,
  P2pUploadGuard,
  type UploadedDocument,
} from "./p2p-documents.service.js";
import { P2pOverviewService } from "./p2p-overview.service.js";
import { RequisitionsService } from "./requisitions.service.js";
import { RfqsService } from "./rfqs.service.js";

const uploadLimits = {
  limits: {
    fileSize: P2P_LIMITS.documentMaxBytes,
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
const idempotencyHeader = {
  name: "Idempotency-Key",
  required: true,
  description:
    "8–100 characters. A replay with the same key and payload returns the original result; a changed payload is 409 idempotency-key-reused.",
};

/** The Idempotency-Key header (400 idempotency-key-required when missing or malformed). */
function idempotencyKey(req: Request): string {
  const parsed = idempotencyKeySchema.safeParse(req.headers["idempotency-key"]);
  if (!parsed.success)
    throw p2pBadRequest("idempotency-key-required", "Send an Idempotency-Key header (8–100 characters)");
  return parsed.data;
}

const reqNote = "Project-scoped: procurement.requisition to raise and edit, procurement.approve to decide (not a contributor).";

@ApiTags("procurement")
@UseGuards(BrowserGuard)
@Controller({ path: "procurement/requisitions", version: "1" })
export class RequisitionsController {
  constructor(
    private readonly auth: AuthService,
    private readonly requisitions: RequisitionsService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Requisitions on projects the caller can see", operationId: "listRequisitions" })
  @ApiQuery({ name: "projectId", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: openApi(requisitionsResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.requisitions.list(
      await this.auth.principal(req),
      requisitionListQuerySchema.parse(query),
      req,
    );
  }

  @Post()
  @ApiOperation({
    summary: "Raise a requisition (REQ-NNNN) with lines in any convertible unit",
    description: reqNote,
    operationId: "createRequisition",
  })
  @ApiBody({ schema: openApi(createRequisitionRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(requisitionDetailResponseSchema) })
  async create(@Body() body: unknown, @Req() req: Request) {
    return this.requisitions.create(
      await this.auth.principal(req),
      createRequisitionRequestSchema.parse(body),
      req,
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "A requisition with its lines", operationId: "getRequisition" })
  @ApiOkResponse({ schema: openApi(requisitionDetailResponseSchema) })
  async get(@Param("id") id: string, @Req() req: Request) {
    return this.requisitions.get(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Edit a draft requisition", description: reqNote, operationId: "updateRequisition" })
  @ApiBody({ schema: openApi(updateRequisitionRequestSchema) })
  @ApiOkResponse({ schema: openApi(requisitionDetailResponseSchema) })
  async update(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.requisitions.update(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      updateRequisitionRequestSchema.parse(body),
      req,
    );
  }

  private plain(action: "submit" | "approve" | "reopen") {
    return async (id: string, body: unknown, req: Request) =>
      this.requisitions.transition(
        await this.auth.principal(req),
        uuidSchema.parse(id),
        action,
        versionRequestSchema.parse(body),
        req,
      );
  }

  private withReason(action: "reject" | "cancel") {
    return async (id: string, body: unknown, req: Request) =>
      this.requisitions.transition(
        await this.auth.principal(req),
        uuidSchema.parse(id),
        action,
        reasonRequestSchema.parse(body),
        req,
      );
  }

  @Post(":id/submit")
  @HttpCode(200)
  @ApiOperation({ summary: "Submit a draft requisition", description: reqNote, operationId: "submitRequisition" })
  @ApiBody({ schema: openApi(versionRequestSchema) })
  @ApiOkResponse({ schema: openApi(requisitionDetailResponseSchema) })
  submit(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.plain("submit")(id, body, req);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @ApiOperation({ summary: "Approve a submitted requisition", description: reqNote, operationId: "approveRequisition" })
  @ApiBody({ schema: openApi(versionRequestSchema) })
  @ApiOkResponse({ schema: openApi(requisitionDetailResponseSchema) })
  approve(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.plain("approve")(id, body, req);
  }

  @Post(":id/reopen")
  @HttpCode(200)
  @ApiOperation({
    summary: "Return a requisition to draft for material edits (clears the decision)",
    description: `${reqNote} Not after it went to an RFQ (409 requisition-on-rfq).`,
    operationId: "reopenRequisition",
  })
  @ApiBody({ schema: openApi(versionRequestSchema) })
  @ApiOkResponse({ schema: openApi(requisitionDetailResponseSchema) })
  reopen(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.plain("reopen")(id, body, req);
  }

  @Post(":id/reject")
  @HttpCode(200)
  @ApiOperation({ summary: "Reject a submitted requisition with a reason", description: reqNote, operationId: "rejectRequisition" })
  @ApiBody({ schema: openApi(reasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(requisitionDetailResponseSchema) })
  reject(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.withReason("reject")(id, body, req);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({ summary: "Cancel a draft or submitted requisition with a reason", description: reqNote, operationId: "cancelRequisition" })
  @ApiBody({ schema: openApi(reasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(requisitionDetailResponseSchema) })
  cancel(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.withReason("cancel")(id, body, req);
  }
}

const rfqNote = "Requires procurement.manage_suppliers (company-level).";

@ApiTags("procurement")
@UseGuards(BrowserGuard)
@Controller({ path: "procurement/rfqs", version: "1" })
export class RfqsController {
  constructor(
    private readonly auth: AuthService,
    private readonly rfqs: RfqsService,
    private readonly documents: P2pDocumentsService,
  ) {}

  @Get()
  @ApiOperation({ summary: "RFQs on projects the caller can see", operationId: "listRfqs" })
  @ApiQuery({ name: "projectId", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiOkResponse({ schema: openApi(rfqsResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.rfqs.list(await this.auth.principal(req), rfqListQuerySchema.parse(query), req);
  }

  @Post()
  @ApiOperation({
    summary: "Ask suppliers to quote for approved requisitions of one project (RFQ-NNNN)",
    description: rfqNote,
    operationId: "createRfq",
  })
  @ApiBody({ schema: openApi(createRfqRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(rfqDetailResponseSchema) })
  async create(@Body() body: unknown, @Req() req: Request) {
    return this.rfqs.create(await this.auth.principal(req), createRfqRequestSchema.parse(body), req);
  }

  @Get(":id")
  @ApiOperation({
    summary: "An RFQ with quotations and the comparison matrix (net of VAT per base unit)",
    operationId: "getRfq",
  })
  @ApiOkResponse({ schema: openApi(rfqDetailResponseSchema) })
  async get(@Param("id") id: string, @Req() req: Request) {
    return this.rfqs.get(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Change an open RFQ's suppliers, reply date or notes", description: rfqNote, operationId: "updateRfq" })
  @ApiBody({ schema: openApi(updateRfqRequestSchema) })
  @ApiOkResponse({ schema: openApi(rfqDetailResponseSchema) })
  async update(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.rfqs.update(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      updateRfqRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/quotations")
  @ApiOperation({
    summary: "Record a supplier's quotation (prices also go to the price history as quotation)",
    description: `${rfqNote} Every RFQ line once, priced or no-bid.`,
    operationId: "recordQuotation",
  })
  @ApiBody({ schema: openApi(recordQuotationRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(rfqDetailResponseSchema) })
  async quote(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.rfqs.recordQuotation(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      recordQuotationRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/quotations/:quotationId/withdraw")
  @HttpCode(200)
  @ApiOperation({ summary: "Withdraw a quotation with a reason", description: rfqNote, operationId: "withdrawQuotation" })
  @ApiBody({ schema: openApi(withdrawQuotationRequestSchema) })
  @ApiOkResponse({ schema: openApi(rfqDetailResponseSchema) })
  async withdraw(
    @Param("id") id: string,
    @Param("quotationId") quotationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.rfqs.withdrawQuotation(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(quotationId),
      withdrawQuotationRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/quotations/:quotationId/document")
  @UseGuards(P2pUploadGuard)
  @UseInterceptors(FileInterceptor("file", uploadLimits))
  @ApiOperation({
    summary: "Attach the quotation document (PDF or photo, at most 10 MB; malware hook)",
    description: rfqNote,
    operationId: "uploadQuotationDocument",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody(fileBody)
  @ApiCreatedResponse({ schema: openApi(procurementDocumentResponseSchema) })
  async document(
    @Param("id") id: string,
    @Param("quotationId") quotationId: string,
    @UploadedFile() file: UploadedDocument | undefined,
    @Req() req: Request,
  ) {
    return this.documents.upload(
      await this.auth.principal(req),
      { kind: "quotation", rfqId: uuidSchema.parse(id), quotationId: uuidSchema.parse(quotationId) },
      file,
      req,
    );
  }

  @Post(":id/exception")
  @HttpCode(200)
  @ApiOperation({
    summary: "Request a single-source exception (fewer quotations than the minimum) with a reason",
    description: rfqNote,
    operationId: "requestRfqException",
  })
  @ApiBody({ schema: openApi(rfqExceptionRequestSchema) })
  @ApiOkResponse({ schema: openApi(rfqDetailResponseSchema) })
  async requestException(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.rfqs.requestException(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      rfqExceptionRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/exception/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve the single-source exception",
    description: "procurement.approve on the project; not a contributor to the RFQ (403 maker-checker).",
    operationId: "approveRfqException",
  })
  @ApiBody({ schema: openApi(versionRequestSchema) })
  @ApiOkResponse({ schema: openApi(rfqDetailResponseSchema) })
  async approveException(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.rfqs.approveException(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      versionRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/award")
  @ApiOperation({
    summary: "Award a complete, valid quotation: a draft LPO (LPO-NNNN)",
    description: `${rfqNote} Needs procurement.min_quotes complete, valid quotations or an approved exception (409 not-enough-quotes).`,
    operationId: "awardRfq",
  })
  @ApiBody({ schema: openApi(awardRfqRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(lpoDetailResponseSchema) })
  async award(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.rfqs.award(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      awardRfqRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({ summary: "Cancel an open RFQ (its requisitions are released)", description: rfqNote, operationId: "cancelRfq" })
  @ApiBody({ schema: openApi(reasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(rfqDetailResponseSchema) })
  async cancel(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.rfqs.cancel(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      reasonRequestSchema.parse(body),
      req,
    );
  }
}

const lpoNote =
  "procurement.manage_suppliers to edit, submit and cancel; procurement.approve on the project + step-up to approve or return (not a contributor).";

@ApiTags("procurement")
@UseGuards(BrowserGuard)
@Controller({ path: "procurement/lpos", version: "1" })
export class LposController {
  constructor(
    private readonly auth: AuthService,
    private readonly lpos: LposService,
  ) {}

  @Get()
  @ApiOperation({ summary: "LPOs on projects the caller can see", operationId: "listLpos" })
  @ApiQuery({ name: "projectId", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "supplierId", required: false })
  @ApiOkResponse({ schema: openApi(lposResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.lpos.list(await this.auth.principal(req), lpoListQuerySchema.parse(query), req);
  }

  @Get(":id")
  @ApiOperation({
    summary: "An LPO: lines, deliveries, invoices and its commitment",
    operationId: "getLpo",
  })
  @ApiOkResponse({ schema: openApi(lpoDetailResponseSchema) })
  async get(@Param("id") id: string, @Req() req: Request) {
    return this.lpos.get(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Edit a draft LPO's delivery site, date and terms", description: lpoNote, operationId: "updateLpo" })
  @ApiBody({ schema: openApi(updateLpoRequestSchema) })
  @ApiOkResponse({ schema: openApi(lpoDetailResponseSchema) })
  async update(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.lpos.update(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      updateLpoRequestSchema.parse(body),
      req,
    );
  }

  private act(action: "submit" | "approve" | "return" | "cancel", withReason: boolean) {
    return async (id: string, body: unknown, req: Request) =>
      this.lpos.transition(
        await this.auth.principal(req),
        uuidSchema.parse(id),
        action,
        withReason ? reasonRequestSchema.parse(body) : versionRequestSchema.parse(body),
        req,
      );
  }

  @Post(":id/submit")
  @HttpCode(200)
  @ApiOperation({ summary: "Submit a draft LPO for approval", description: lpoNote, operationId: "submitLpo" })
  @ApiBody({ schema: openApi(versionRequestSchema) })
  @ApiOkResponse({ schema: openApi(lpoDetailResponseSchema) })
  submit(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.act("submit", false)(id, body, req);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve an LPO (a commitment; immutable afterwards)",
    description: lpoNote,
    operationId: "approveLpo",
  })
  @ApiBody({ schema: openApi(versionRequestSchema) })
  @ApiOkResponse({ schema: openApi(lpoDetailResponseSchema) })
  approve(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.act("approve", false)(id, body, req);
  }

  @Post(":id/return")
  @HttpCode(200)
  @ApiOperation({ summary: "Return a submitted LPO to draft with a reason", description: lpoNote, operationId: "returnLpo" })
  @ApiBody({ schema: openApi(reasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(lpoDetailResponseSchema) })
  returnToDraft(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.act("return", true)(id, body, req);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({
    summary: "Cancel an LPO (approved: only before deliveries and invoices; the RFQ reopens for a reissue)",
    description: lpoNote,
    operationId: "cancelLpo",
  })
  @ApiBody({ schema: openApi(reasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(lpoDetailResponseSchema) })
  cancel(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.act("cancel", true)(id, body, req);
  }
}

const grnNote = "stores.manage or procurement.requisition on the LPO's project.";

@ApiTags("procurement")
@UseGuards(BrowserGuard)
@Controller({ path: "procurement/grns", version: "1" })
export class GrnsController {
  constructor(
    private readonly auth: AuthService,
    private readonly grns: GrnsService,
    private readonly documents: P2pDocumentsService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Goods Received Notes on projects the caller can see", operationId: "listGrns" })
  @ApiQuery({ name: "projectId", required: false })
  @ApiQuery({ name: "lpoId", required: false })
  @ApiOkResponse({ schema: openApi(grnsResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.grns.list(await this.auth.principal(req), grnListQuerySchema.parse(query), req);
  }

  @Get("receivable")
  @ApiOperation({
    summary: "Approved LPOs the caller may receive goods against, with quantities accepted so far",
    description: grnNote,
    operationId: "listReceivableLpos",
  })
  @ApiQuery({ name: "projectId", required: false })
  @ApiOkResponse({ schema: openApi(receivableLposResponseSchema) })
  async receivable(@Query() query: unknown, @Req() req: Request) {
    const { projectId } = z.object({ projectId: z.uuid().optional() }).parse(query);
    return this.grns.receivable(await this.auth.principal(req), projectId, req);
  }

  @Post()
  @ApiOperation({
    summary: "Record a GRN (offline-ready: client ID and Idempotency-Key)",
    description: `${grnNote} The device capture time and position are claims; the server receipt time is authoritative; outside the site geofence is flagged, not refused. Photos are uploaded separately.`,
    operationId: "createGrn",
  })
  @ApiHeader(idempotencyHeader)
  @ApiBody({ schema: openApi(createGrnRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(grnResponseSchema) })
  async create(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey(req);
    const result = await this.grns.create(
      await this.auth.principal(req),
      createGrnRequestSchema.parse(body),
      key,
      req,
    );
    if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
    return result;
  }

  @Get(":id")
  @ApiOperation({ summary: "A GRN with its lines and photos", operationId: "getGrn" })
  @ApiOkResponse({ schema: openApi(grnResponseSchema) })
  async get(@Param("id") id: string, @Req() req: Request) {
    return this.grns.get(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Post(":id/photos")
  @UseGuards(P2pUploadGuard)
  @UseInterceptors(FileInterceptor("file", uploadLimits))
  @ApiOperation({
    summary: "Add a photo of the delivery note or the goods (JPEG, PNG or WebP, at most 5 MB)",
    description: `${grnNote} At most 10 photos; EXIF positions are never used.`,
    operationId: "uploadGrnPhoto",
  })
  @ApiQuery({ name: "kind", required: true, enum: ["delivery_note", "goods"] })
  @ApiConsumes("multipart/form-data")
  @ApiBody(fileBody)
  @ApiCreatedResponse({ schema: openApi(procurementDocumentResponseSchema) })
  async photo(
    @Param("id") id: string,
    @Query() query: unknown,
    @UploadedFile() file: UploadedDocument | undefined,
    @Req() req: Request,
  ) {
    return this.documents.upload(
      await this.auth.principal(req),
      { kind: grnPhotoQuerySchema.parse(query).kind, grnId: uuidSchema.parse(id) },
      file,
      req,
    );
  }

  @Post(":id/void")
  @HttpCode(200)
  @ApiOperation({
    summary: "Void a GRN with a reason (not while an approved invoice relies on it)",
    description: "stores.manage on the project.",
    operationId: "voidGrn",
  })
  @ApiBody({ schema: openApi(voidGrnRequestSchema) })
  @ApiOkResponse({ schema: openApi(grnResponseSchema) })
  async void(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.grns.void(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      voidGrnRequestSchema.parse(body),
      req,
    );
  }
}

const invoiceNote = "finance.manage or procurement.manage_suppliers on the project.";

@ApiTags("procurement")
@UseGuards(BrowserGuard)
@Controller({ path: "procurement/invoices", version: "1" })
export class InvoicesController {
  constructor(
    private readonly auth: AuthService,
    private readonly invoices: InvoicesService,
    private readonly documents: P2pDocumentsService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Supplier invoices on projects the caller can see", operationId: "listInvoices" })
  @ApiQuery({ name: "projectId", required: false })
  @ApiQuery({ name: "lpoId", required: false })
  @ApiQuery({ name: "supplierId", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiOkResponse({ schema: openApi(invoicesResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.invoices.list(await this.auth.principal(req), invoiceListQuerySchema.parse(query), req);
  }

  @Post()
  @ApiOperation({
    summary: "Record a supplier invoice against an approved LPO, with its KRA eTIMS number",
    description: `${invoiceNote} A supplier's invoice number is used once (409 invoice-number-taken).`,
    operationId: "recordInvoice",
  })
  @ApiBody({ schema: openApi(createInvoiceRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(invoiceDetailResponseSchema) })
  async create(@Body() body: unknown, @Req() req: Request) {
    return this.invoices.create(
      await this.auth.principal(req),
      createInvoiceRequestSchema.parse(body),
      req,
    );
  }

  @Get(":id")
  @ApiOperation({
    summary: "An invoice with its three-way match, payable and settlements",
    operationId: "getInvoice",
  })
  @ApiOkResponse({ schema: openApi(invoiceDetailResponseSchema) })
  async get(@Param("id") id: string, @Req() req: Request) {
    return this.invoices.get(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Edit a draft invoice (a new content version)", description: invoiceNote, operationId: "updateInvoice" })
  @ApiBody({ schema: openApi(updateInvoiceRequestSchema) })
  @ApiOkResponse({ schema: openApi(invoiceDetailResponseSchema) })
  async update(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.invoices.update(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      updateInvoiceRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/submit")
  @HttpCode(200)
  @ApiOperation({
    summary: "Submit a draft invoice: runs the three-way match (matched or disputed)",
    description: invoiceNote,
    operationId: "submitInvoice",
  })
  @ApiBody({ schema: openApi(versionRequestSchema) })
  @ApiOkResponse({ schema: openApi(invoiceDetailResponseSchema) })
  async submit(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.invoices.submit(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      versionRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/rematch")
  @HttpCode(200)
  @ApiOperation({
    summary: "Run the three-way match again (after another delivery or a settings change)",
    description: `${invoiceNote} Also open to payments.approve.`,
    operationId: "rematchInvoice",
  })
  @ApiBody({ schema: openApi(versionRequestSchema) })
  @ApiOkResponse({ schema: openApi(invoiceDetailResponseSchema) })
  async rematch(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.invoices.rematch(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      versionRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/reopen")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reopen a disputed or matched invoice for a corrected version",
    description: invoiceNote,
    operationId: "reopenInvoice",
  })
  @ApiBody({ schema: openApi(versionRequestSchema) })
  @ApiOkResponse({ schema: openApi(invoiceDetailResponseSchema) })
  async reopen(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.invoices.reopen(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      versionRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({ summary: "Cancel an invoice that is not approved (e.g. after a credit note)", description: invoiceNote, operationId: "cancelInvoice" })
  @ApiBody({ schema: openApi(reasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(invoiceDetailResponseSchema) })
  async cancel(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.invoices.cancel(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      reasonRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/exception")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve an exception for a disputed invoice's current mismatch (with a reason)",
    description:
      "payments.approve + step-up; not a contributor. Never for a missing eTIMS number (409 match-not-exceptable).",
    operationId: "exceptInvoiceMatch",
  })
  @ApiBody({ schema: openApi(matchExceptionRequestSchema) })
  @ApiOkResponse({ schema: openApi(invoiceDetailResponseSchema) })
  async except(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.invoices.except(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      matchExceptionRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve a matched invoice for payment (binds the match and the verified payee)",
    description:
      "payments.approve + step-up; not a contributor. Quote the matchId and payoutVersionId you saw (409 match-stale / payee-changed). Also re-approves after the payee's details changed.",
    operationId: "approveInvoice",
  })
  @ApiBody({ schema: openApi(approveInvoiceRequestSchema) })
  @ApiOkResponse({ schema: openApi(invoiceDetailResponseSchema) })
  async approve(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.invoices.approve(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      approveInvoiceRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/settlements")
  @ApiOperation({
    summary: "Record a settlement paid outside PM-Buddy (bank transfer, cheque, M-Pesa B2B)",
    description:
      "payments.disburse + step-up; not the invoice's approver. Idempotent; never above the outstanding balance; the reference is unique per method.",
    operationId: "recordSettlement",
  })
  @ApiHeader(idempotencyHeader)
  @ApiBody({ schema: openApi(recordSettlementRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(invoiceDetailResponseSchema) })
  async settle(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    const key = idempotencyKey(req);
    return this.invoices.settle(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      recordSettlementRequestSchema.parse(body),
      key,
      req,
    );
  }

  @Post(":id/document")
  @UseGuards(P2pUploadGuard)
  @UseInterceptors(FileInterceptor("file", uploadLimits))
  @ApiOperation({
    summary: "Attach the invoice document (PDF or photo, at most 10 MB; malware hook)",
    description: invoiceNote,
    operationId: "uploadInvoiceDocument",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody(fileBody)
  @ApiCreatedResponse({ schema: openApi(procurementDocumentResponseSchema) })
  async document(
    @Param("id") id: string,
    @UploadedFile() file: UploadedDocument | undefined,
    @Req() req: Request,
  ) {
    return this.documents.upload(
      await this.auth.principal(req),
      { kind: "invoice", invoiceId: uuidSchema.parse(id) },
      file,
      req,
    );
  }
}

@ApiTags("procurement")
@UseGuards(BrowserGuard)
@Controller({ path: "procurement", version: "1" })
export class P2pController {
  constructor(
    private readonly auth: AuthService,
    private readonly overview: P2pOverviewService,
    private readonly documents: P2pDocumentsService,
  ) {}

  @Get("inbox")
  @ApiOperation({
    summary: "What is waiting for the caller: approvals, exceptions and settlements",
    operationId: "procurementInbox",
  })
  @ApiOkResponse({ schema: openApi(inboxResponseSchema) })
  async inbox(@Req() req: Request) {
    return this.overview.inbox(await this.auth.principal(req), req);
  }

  @Get("commitments")
  @ApiOperation({
    summary: "Committed (approved LPOs), accrued (approved invoices) and paid amounts of a project",
    operationId: "procurementCommitments",
  })
  @ApiQuery({ name: "projectId", required: true })
  @ApiOkResponse({ schema: openApi(commitmentsResponseSchema) })
  async commitments(@Query() query: unknown, @Req() req: Request) {
    return this.overview.commitments(
      await this.auth.principal(req),
      commitmentsQuerySchema.parse(query).projectId,
      req,
    );
  }

  @Get("documents/:id")
  @ApiOperation({
    summary: "Download a procurement document or GRN photo",
    operationId: "downloadProcurementDocument",
  })
  async document(@Param("id") id: string, @Req() req: Request) {
    const file = await this.documents.download(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      req,
    );
    return new StreamableFile(file.content, {
      type: file.contentType,
      disposition: `inline; filename="${file.fileName}"`,
      length: file.content.length,
    });
  }
}
