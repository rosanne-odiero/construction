import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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
  ApiProduces,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { P2P_LIMITS } from "@pm-buddy/types";
import {
  idempotencyKeySchema,
  invitePortalUserRequestSchema,
  portalDeliveriesQuerySchema,
  portalDeliveriesResponseSchema,
  portalDocumentResponseSchema,
  portalInvoiceDetailResponseSchema,
  portalInvoicesQuerySchema,
  portalInvoicesResponseSchema,
  portalLpoDetailResponseSchema,
  portalLposQuerySchema,
  portalLposResponseSchema,
  revokePortalUserRequestSchema,
  submitSupplierInvoiceRequestSchema,
  supplierPortalOverviewResponseSchema,
  supplierPortalUserResponseSchema,
  supplierPortalUsersResponseSchema,
  supplierStatementExportQuerySchema,
  supplierStatementQuerySchema,
  supplierStatementResponseSchema,
} from "@pm-buddy/validation";
import type { Request, Response } from "express";
import { openApi } from "../../../common/openapi.js";
import { AuthService } from "../../identity/auth.service.js";
import { BrowserGuard } from "../../identity/identity.controller.js";
import { uuidSchema } from "../../identity/identity.schemas.js";
import {
  P2pUploadGuard,
  type UploadedDocument,
} from "../../procurement/p2p/p2p-documents.service.js";
import { SupplierPortalDatabaseErrors, supplierPortalProblem } from "./supplier-portal-access.js";
import { SupplierPortalUsersService } from "./supplier-portal-users.service.js";
import { SupplierPortalService } from "./supplier-portal.service.js";
import { SupplierStatementExportService } from "./supplier-statement-export.service.js";

const portalNote =
  "Supplier portal (D7.2): a `supplier`-role member with an active binding to one supplier (403 supplier-portal-not-linked otherwise); only that supplier's records, other IDs answer 404.";
const manageNote = "Requires procurement.manage_suppliers or company-wide finance.manage (D7.2).";

/** The Idempotency-Key header (400 idempotency-key-required when missing or malformed). */
function idempotencyKey(req: Request): string {
  const parsed = idempotencyKeySchema.safeParse(req.headers["idempotency-key"]);
  if (!parsed.success)
    throw supplierPortalProblem(
      400,
      "idempotency-key-required",
      "Send an Idempotency-Key header (8–100 characters)",
    );
  return parsed.data;
}

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

/** The supplier's side of the supplier portal (`/api/v1/portal/supplier/…`). */
@ApiTags("supplier portal")
@UseGuards(BrowserGuard)
@UseInterceptors(SupplierPortalDatabaseErrors)
@Controller({ path: "portal/supplier", version: "1" })
export class SupplierPortalController {
  constructor(
    private readonly auth: AuthService,
    private readonly portal: SupplierPortalService,
    private readonly exports: SupplierStatementExportService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Supplier portal home: the supplier, counts, projects and the amount outstanding",
    description: portalNote,
    operationId: "getSupplierPortal",
  })
  @ApiOkResponse({ schema: openApi(supplierPortalOverviewResponseSchema) })
  async overview(@Req() req: Request) {
    return this.portal.overview(await this.auth.principal(req), req);
  }

  @Get("lpos")
  @ApiOperation({
    summary: "The supplier's approved LPOs (and later cancellations), newest first",
    description: portalNote,
    operationId: "listSupplierPortalLpos",
  })
  @ApiQuery({ name: "projectId", required: false })
  @ApiQuery({ name: "status", required: false, enum: ["approved", "cancelled"] })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: openApi(portalLposResponseSchema) })
  async lpos(@Query() query: unknown, @Req() req: Request) {
    return this.portal.listLpos(
      await this.auth.principal(req),
      portalLposQuerySchema.parse(query),
      req,
    );
  }

  @Get("lpos/:id")
  @ApiOperation({
    summary: "An LPO: lines, net prices, VAT, delivery site and date, terms, deliveries, invoices",
    description: `${portalNote} Quantities received, invoiced, under review and still invoiceable are in the material's base unit.`,
    operationId: "getSupplierPortalLpo",
  })
  @ApiOkResponse({ schema: openApi(portalLpoDetailResponseSchema) })
  async lpo(@Param("id") id: string, @Req() req: Request) {
    return this.portal.getLpo(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Post("lpos/:id/acknowledge")
  @HttpCode(200)
  @ApiOperation({
    summary: "Acknowledge an approved LPO (once; recorded with time and user)",
    description: `${portalNote} Never changes the LPO or its approval. 409 lpo-already-acknowledged, lpo-not-approved.`,
    operationId: "acknowledgeSupplierPortalLpo",
  })
  @ApiOkResponse({ schema: openApi(portalLpoDetailResponseSchema) })
  async acknowledge(@Param("id") id: string, @Req() req: Request) {
    return this.portal.acknowledge(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Get("deliveries")
  @ApiOperation({
    summary: "Deliveries (GRNs) against the supplier's LPOs: received, rejected and why",
    description: `${portalNote} Internal notes, photos, positions and staff names are never included.`,
    operationId: "listSupplierPortalDeliveries",
  })
  @ApiQuery({ name: "projectId", required: false })
  @ApiQuery({ name: "lpoId", required: false })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: openApi(portalDeliveriesResponseSchema) })
  async deliveries(@Query() query: unknown, @Req() req: Request) {
    return this.portal.listDeliveries(
      await this.auth.principal(req),
      portalDeliveriesQuerySchema.parse(query),
      req,
    );
  }

  @Get("invoices")
  @ApiOperation({
    summary: "The supplier's invoices with their status and the payments the company recorded",
    description: portalNote,
    operationId: "listSupplierPortalInvoices",
  })
  @ApiQuery({ name: "projectId", required: false })
  @ApiQuery({ name: "lpoId", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: openApi(portalInvoicesResponseSchema) })
  async invoices(@Query() query: unknown, @Req() req: Request) {
    return this.portal.listInvoices(
      await this.auth.principal(req),
      portalInvoicesQuerySchema.parse(query),
      req,
    );
  }

  @Post("invoices")
  @ApiOperation({
    summary:
      "Submit an invoice against an approved LPO (offline-ready: client ID + Idempotency-Key)",
    description: `${portalNote} Enters the company's procure-to-pay workflow: the three-way match runs at once (under review or disputed); company staff approve and record payments, never the supplier. eTIMS number required (format checked, never verified with KRA). 409 invoice-number-taken, idempotency-key-reused, invoice-id-conflict, lpo-not-approved; 422 invoice-date-invalid; 429 when submitting too often.`,
    operationId: "submitSupplierPortalInvoice",
  })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description:
      "8–100 characters. A replay with the same key and payload returns the original invoice (Idempotency-Replayed: true); a changed payload is 409 idempotency-key-reused.",
  })
  @ApiBody({ schema: openApi(submitSupplierInvoiceRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(portalInvoiceDetailResponseSchema) })
  async submit(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey(req);
    const result = await this.portal.submitInvoice(
      await this.auth.principal(req),
      submitSupplierInvoiceRequestSchema.parse(body),
      key,
      req,
    );
    if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
    return result;
  }

  @Get("invoices/:id")
  @ApiOperation({
    summary: "An invoice: lines, status, dispute reasons, recorded payments and documents",
    description: `${portalNote} "Paid" is what the company recorded; the portal never confirms a payment.`,
    operationId: "getSupplierPortalInvoice",
  })
  @ApiOkResponse({ schema: openApi(portalInvoiceDetailResponseSchema) })
  async invoice(@Param("id") id: string, @Req() req: Request) {
    return this.portal.getInvoice(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Post("invoices/:id/document")
  @UseGuards(P2pUploadGuard)
  @UseInterceptors(FileInterceptor("file", uploadLimits))
  @ApiOperation({
    summary: "Attach the invoice document (PDF or photo, at most 10 MB; malware scan)",
    description: `${portalNote} Only to the supplier's own submitted, open invoice; at most 3. 409 invoice-not-attachable, too-many-documents.`,
    operationId: "uploadSupplierPortalInvoiceDocument",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file"],
      properties: { file: { type: "string", format: "binary" } },
    },
  })
  @ApiCreatedResponse({ schema: openApi(portalDocumentResponseSchema) })
  async document(
    @Param("id") id: string,
    @UploadedFile() file: UploadedDocument | undefined,
    @Req() req: Request,
  ) {
    return this.portal.uploadDocument(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      file,
      req,
    );
  }

  @Get("documents/:id")
  @ApiOperation({
    summary: "Download a document kept with one of the supplier's invoices",
    description: portalNote,
    operationId: "downloadSupplierPortalDocument",
  })
  async download(@Param("id") id: string, @Req() req: Request) {
    const file = await this.portal.downloadDocument(
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

  @Get("statement")
  @ApiOperation({
    summary: "The supplier statement: opening balance, invoices, payments, closing balance",
    description: `${portalNote} Accepted invoices (approved, partly paid, paid) by invoice date less recorded payments by paid date; one project or the whole company; default the last 90 days, at most 1,096 days (422 statement-period-invalid).`,
    operationId: "getSupplierPortalStatement",
  })
  @ApiQuery({ name: "projectId", required: false })
  @ApiQuery({ name: "from", required: false })
  @ApiQuery({ name: "to", required: false })
  @ApiOkResponse({ schema: openApi(supplierStatementResponseSchema) })
  async statement(@Query() query: unknown, @Req() req: Request) {
    return this.portal.statement(
      await this.auth.principal(req),
      supplierStatementQuerySchema.parse(query),
      req,
    );
  }

  @Get("statement/export/pdf")
  @ApiOperation({
    summary: "The supplier statement as an A4 PDF (EN or SW)",
    description: `${portalNote} Generated on demand; rate limited; audited.`,
    operationId: "exportSupplierPortalStatementPdf",
  })
  @ApiQuery({ name: "locale", required: false, enum: ["en", "sw"] })
  @ApiProduces("application/pdf")
  async pdf(@Query() query: unknown, @Req() req: Request) {
    const { locale, ...filters } = supplierStatementExportQuerySchema.parse(query);
    const file = await this.exports.pdf(await this.auth.principal(req), filters, locale, req);
    return new StreamableFile(file.content, {
      type: file.contentType,
      disposition: file.disposition,
      length: file.content.length,
    });
  }

  @Get("statement/export/xlsx")
  @ApiOperation({
    summary: "The supplier statement as Excel (EN or SW)",
    description: `${portalNote} Text cells are neutralised against formula injection.`,
    operationId: "exportSupplierPortalStatementExcel",
  })
  @ApiQuery({ name: "locale", required: false, enum: ["en", "sw"] })
  @ApiProduces("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  async xlsx(@Query() query: unknown, @Req() req: Request) {
    const { locale, ...filters } = supplierStatementExportQuerySchema.parse(query);
    const file = await this.exports.xlsx(await this.auth.principal(req), filters, locale, req);
    return new StreamableFile(file.content, {
      type: file.contentType,
      disposition: file.disposition,
      length: file.content.length,
    });
  }
}

/** Company staff and a supplier's portal users (`/api/v1/suppliers/:supplierId/portal-users`). */
@ApiTags("supplier portal")
@UseGuards(BrowserGuard)
@UseInterceptors(SupplierPortalDatabaseErrors)
@Controller({ path: "suppliers/:supplierId/portal-users", version: "1" })
export class SupplierPortalUsersController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: SupplierPortalUsersService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "A supplier's portal users: invited, active and revoked (history kept)",
    description: manageNote,
    operationId: "listSupplierPortalUsers",
  })
  @ApiOkResponse({ schema: openApi(supplierPortalUsersResponseSchema) })
  async list(@Param("supplierId") supplierId: string, @Req() req: Request) {
    return this.users.list(await this.auth.principal(req), uuidSchema.parse(supplierId), req);
  }

  @Post()
  @ApiOperation({
    summary: "Invite a supplier contact to the supplier portal (email or Kenyan phone)",
    description: `${manageNote} Plus step-up. The contact gets the supplier role with no project and is bound to this supplier when they accept (48 hours). 409 portal-user-exists, already-member, supplier-blocked.`,
    operationId: "inviteSupplierPortalUser",
  })
  @ApiBody({ schema: openApi(invitePortalUserRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(supplierPortalUserResponseSchema) })
  async invite(
    @Param("supplierId") supplierId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.users.invite(
      await this.auth.principal(req),
      uuidSchema.parse(supplierId),
      invitePortalUserRequestSchema.parse(body),
      req,
    );
  }

  @Post(":portalUserId/revoke")
  @HttpCode(200)
  @ApiOperation({
    summary: "Revoke a supplier contact's portal access at once (reason required)",
    description: `${manageNote} A pending invitation stops working; an active user's supplier membership and sessions in this company end immediately. The record is kept.`,
    operationId: "revokeSupplierPortalUser",
  })
  @ApiBody({ schema: openApi(revokePortalUserRequestSchema) })
  @ApiOkResponse({ schema: openApi(supplierPortalUserResponseSchema) })
  async revoke(
    @Param("supplierId") supplierId: string,
    @Param("portalUserId") portalUserId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.users.revoke(
      await this.auth.principal(req),
      uuidSchema.parse(supplierId),
      uuidSchema.parse(portalUserId),
      revokePortalUserRequestSchema.parse(body),
      req,
    );
  }
}
