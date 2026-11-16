import { Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import {
  ApiBody,
  ApiConflictResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { putTariffRequestSchema, tariffsResponseSchema } from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { PaymentTariffsService } from "./tariffs.service.js";

/** The M-Pesa charges tariff (D4.3 §12, CR-PMT-02): DEMO bands until the company's own. */
@ApiTags("payments")
@UseGuards(BrowserGuard)
@Controller({ path: "payments", version: "1" })
export class PaymentTariffsController {
  constructor(
    private readonly auth: AuthService,
    private readonly tariffs: PaymentTariffsService,
  ) {}

  @Get("tariffs")
  @ApiOperation({
    summary: "The M-Pesa charges tariff: versions, the one in force today",
    description:
      "payments.view or config.manage. The seeded DEMO bands are placeholders until the company confirms its Safaricom tariff (CR-PMT-02).",
    operationId: "getPaymentTariffs",
  })
  @ApiOkResponse({ schema: openApi(tariffsResponseSchema) })
  async list(@Req() req: Request) {
    return this.tariffs.list(await this.auth.principal(req), req);
  }

  @Put("tariffs")
  @ApiOperation({
    summary: "Add an effective-dated tariff version (versions are never edited)",
    description:
      "config.manage and MFA verified within five minutes (403 step-up-required). 409 tariff-invalid when a version already starts on that date.",
    operationId: "addPaymentTariff",
  })
  @ApiHeader({
    name: "Idempotency-Key",
    required: false,
    description: "Optional, 8–128 letters, digits, '-' or '_' (shared idempotency rules).",
  })
  @ApiBody({ schema: openApi(putTariffRequestSchema) })
  @ApiOkResponse({ schema: openApi(tariffsResponseSchema) })
  @ApiConflictResponse({ description: "tariff-invalid, idempotency-key-reused" })
  async put(@Body() body: unknown, @Req() req: Request) {
    return this.tariffs.put(await this.auth.principal(req), req, putTariffRequestSchema.parse(body));
  }
}
