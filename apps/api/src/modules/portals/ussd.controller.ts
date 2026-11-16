import { timingSafeEqual } from "node:crypto";
import {
  Body,
  Controller,
  ForbiddenException,
  Header,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { AppConfig } from "../../config/app-config.js";
import { UssdService } from "./ussd.service.js";

@ApiTags("portals")
@Controller({ version: "1", path: "ussd" })
export class UssdController {
  constructor(
    private readonly config: AppConfig,
    private readonly ussd: UssdService,
  ) {}

  @Post()
  @HttpCode(200)
  @Header("Content-Type", "text/plain; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    operationId: "labourerUssd",
    summary: "Trusted Africa's Talking gateway: EN/SW labourer self-service",
    description:
      "Requires X-USSD-Token from the controlled gateway; disabled by default. Accepts form-urlencoded callbacks. Never expose the gateway token to a browser.",
  })
  handle(@Body() body: unknown, @Req() req: Request) {
    const expected = this.config.get("USSD_CALLBACK_TOKEN");
    if (!expected || !this.config.get("USSD_SERVICE_CODE"))
      throw new ServiceUnavailableException("USSD is not configured");
    const supplied = req.headers["x-ussd-token"];
    if (
      typeof supplied !== "string" ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      throw new ForbiddenException("Trusted USSD gateway required");
    }
    return this.ussd.handle(body, req);
  }
}
