import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { authResponseSchema, messageResponseSchema } from "@pm-buddy/validation";
import type { Request, Response } from "express";
import { openApi } from "../../common/openapi.js";
import { BrowserGuard } from "./identity.controller.js";
import { pinJoinSchema, pinLoginSchema, pinResetSchema } from "./identity.schemas.js";
import { PinService } from "./pin.service.js";

const limited =
  "PIN sessions can use only the labourer portal (403 `pin-session-limited` elsewhere).";

@ApiTags("authentication")
@UseGuards(BrowserGuard)
@Controller({ path: "auth/pin", version: "1" })
export class PinAuthController {
  constructor(private readonly pins: PinService) {}

  @Post("login")
  @HttpCode(200)
  @ApiOperation({
    summary: "Labourer sign-in with a Kenyan phone number and six-digit PIN",
    description: `Five wrong PINs lock the account for 15 minutes; numbers are also rate limited. ${limited}`,
    operationId: "signInWithPin",
  })
  @ApiBody({ schema: openApi(pinLoginSchema) })
  @ApiOkResponse({ schema: openApi(authResponseSchema) })
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = pinLoginSchema.parse(body);
    return this.pins.login(input.identifier, input.pin, req, res);
  }

  @Post("join")
  @HttpCode(200)
  @ApiOperation({
    summary: "Create a labourer account from an invitation link, set a PIN and join",
    description: `The phone number must be the invited one. 400 \`pin-too-weak\` for repeated, sequential or phone-number PINs; 409 \`account-exists\` when the number already has an account (sign in, then accept). Signs in with the company selected. ${limited}`,
    operationId: "joinWithPin",
  })
  @ApiBody({ schema: openApi(pinJoinSchema) })
  @ApiOkResponse({ schema: openApi(authResponseSchema) })
  async join(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.pins.join(pinJoinSchema.parse(body), req, res);
  }

  @Post("reset")
  @HttpCode(200)
  @ApiOperation({
    summary: "Set a new PIN with the token from POST auth/password/forgot",
    description: "Only for accounts that have a PIN. Signs out every session.",
    operationId: "resetPin",
  })
  @ApiBody({ schema: openApi(pinResetSchema) })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  async reset(@Body() body: unknown, @Req() req: Request) {
    const input = pinResetSchema.parse(body);
    return this.pins.reset(input.token, input.pin, req);
  }
}
