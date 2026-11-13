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
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiTooManyRequestsResponse,
} from "@nestjs/swagger";
import {
  createSupplierRequestSchema,
  proposePayoutRequestSchema,
  rejectPayoutRequestSchema,
  supplierDetailResponseSchema,
  supplierListQuerySchema,
  supplierRevealRequestSchema,
  supplierRevealResponseSchema,
  suppliersResponseSchema,
  updateSupplierRequestSchema,
  verifyPayoutRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { PayoutsService } from "./payouts.service.js";
import { SuppliersService } from "./suppliers.service.js";

const viewNote =
  "Requires one of procurement.manage_suppliers, procurement.requisition, procurement.approve, stores.manage or finance.view. Identifiers are masked.";
const manageNote = "Requires procurement.manage_suppliers.";
const decideNote =
  "Requires company-wide payments.approve; the caller must not have made or contributed to the details (403 maker-checker).";

/** Suppliers, masked identifiers and reveal, and maker-checker payout details (D5.1). */
@ApiTags("procurement")
@UseGuards(BrowserGuard)
@Controller({ path: "suppliers", version: "1" })
export class SuppliersController {
  constructor(
    private readonly auth: AuthService,
    private readonly suppliers: SuppliersService,
    private readonly payouts: PayoutsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Suppliers with masked identifiers (cursor pagination); exact KRA PIN or phone lookup",
    description: `${viewNote} kraPin and phone lookups use blind indexes and need permission to reveal identifiers (rate-limited, audited).`,
    operationId: "listSuppliers",
  })
  @ApiQuery({ name: "search", required: false, description: "Code, legal or trading name" })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "etims", required: false })
  @ApiQuery({ name: "kraPin", required: false })
  @ApiQuery({ name: "phone", required: false })
  @ApiQuery({ name: "cursor", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiOkResponse({ schema: openApi(suppliersResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.suppliers.list(
      await this.auth.principal(req),
      supplierListQuerySchema.parse(query),
      req,
    );
  }

  @Post()
  @ApiOperation({
    summary: "Add a supplier (code SUP-NNNN); the KRA PIN and phones are stored encrypted",
    description: `${manageNote} 409 kra-pin-taken when another supplier of the company has the PIN.`,
    operationId: "createSupplier",
  })
  @ApiBody({ schema: openApi(createSupplierRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(supplierDetailResponseSchema) })
  @ApiConflictResponse({ description: "KRA PIN already used in this company" })
  async create(@Body() body: unknown, @Req() req: Request) {
    return this.suppliers.create(
      await this.auth.principal(req),
      createSupplierRequestSchema.parse(body),
      req,
    );
  }

  @Get(":id")
  @ApiOperation({
    summary: "A supplier profile: masked identifiers, contacts, payout details and recent prices",
    description: viewNote,
    operationId: "getSupplier",
  })
  @ApiOkResponse({ schema: openApi(supplierDetailResponseSchema) })
  async get(@Param("id") id: string, @Req() req: Request) {
    return this.suppliers.get(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Change supplier details, status, terms or contacts",
    description: `${manageNote} Send the version you read (409 version-conflict). A contact's phone is kept unless sent; every phone change is logged and makes the writer a contributor to a pending payout proposal.`,
    operationId: "updateSupplier",
  })
  @ApiBody({ schema: openApi(updateSupplierRequestSchema) })
  @ApiOkResponse({ schema: openApi(supplierDetailResponseSchema) })
  async update(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.suppliers.update(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      updateSupplierRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/reveal")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reveal one sensitive value (KRA PIN, contact phone or bank account number)",
    description:
      "KRA PIN and phones: procurement.manage_suppliers or company-wide finance.view_sensitive. Bank account numbers: company-wide finance.view_sensitive. 20 reveals per user per 10 minutes; audited without the value.",
    operationId: "revealSupplierValue",
  })
  @ApiBody({ schema: openApi(supplierRevealRequestSchema) })
  @ApiOkResponse({ schema: openApi(supplierRevealResponseSchema) })
  @ApiForbiddenResponse({ description: "No permission to reveal this value" })
  @ApiTooManyRequestsResponse({ description: "Too many reveals" })
  async reveal(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.suppliers.reveal(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      supplierRevealRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/payout-details")
  @ApiOperation({
    summary: "Propose new payout details (M-Pesa Paybill/Till and/or bank): pending until verified",
    description: `${manageNote} MFA verified within five minutes. Send \`replaces\` (the current version you saw, or null; 409 payout-stale). The current version is superseded at once, so changed details are never usable until another person verifies them.`,
    operationId: "proposePayoutDetails",
  })
  @ApiBody({ schema: openApi(proposePayoutRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(supplierDetailResponseSchema) })
  async propose(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.payouts.propose(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      proposePayoutRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/payout-details/:payoutId/verify")
  @HttpCode(200)
  @ApiOperation({
    summary: "Verify pending payout details independently (method and note recorded)",
    description: `${decideNote} MFA verified within five minutes.`,
    operationId: "verifyPayoutDetails",
  })
  @ApiBody({ schema: openApi(verifyPayoutRequestSchema) })
  @ApiOkResponse({ schema: openApi(supplierDetailResponseSchema) })
  async verify(
    @Param("id") id: string,
    @Param("payoutId") payoutId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.payouts.verify(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(payoutId),
      verifyPayoutRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/payout-details/:payoutId/reject")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reject pending payout details with a reason",
    description: decideNote,
    operationId: "rejectPayoutDetails",
  })
  @ApiBody({ schema: openApi(rejectPayoutRequestSchema) })
  @ApiOkResponse({ schema: openApi(supplierDetailResponseSchema) })
  async reject(
    @Param("id") id: string,
    @Param("payoutId") payoutId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.payouts.reject(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(payoutId),
      rejectPayoutRequestSchema.parse(body),
      req,
    );
  }
}
