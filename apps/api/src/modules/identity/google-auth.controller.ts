import { Controller, Get, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { authProvidersResponseSchema } from "@pm-buddy/validation";
import type { Request, Response } from "express";
import { openApi } from "../../common/openapi.js";
import { GoogleSignIn } from "./google-sign-in.service.js";
import { BrowserGuard } from "./identity.controller.js";

const backToSignIn =
  "Redirects (303) to the web sign-in page. On failure `?google=` names the outcome (cancelled, unavailable, rate-limited, email-unsupported, account-conflict or failed); `next` is passed through for the web app to sanitise.";

@ApiTags("authentication")
@UseGuards(BrowserGuard)
@Controller({ path: "auth", version: "1" })
export class GoogleAuthController {
  constructor(private readonly google: GoogleSignIn) {}

  @Get("providers")
  @ApiOperation({
    summary: "Sign-in methods available besides email/phone and password",
    operationId: "listAuthProviders",
  })
  @ApiOkResponse({ schema: openApi(authProvidersResponseSchema) })
  providers() {
    return authProvidersResponseSchema.parse({ google: this.google.enabled });
  }

  @Get("google/start")
  @ApiOperation({
    summary: "Start Google sign-in (top-level browser navigation)",
    description: `Sets a 10-minute encrypted cookie holding state, nonce and the PKCE verifier, then redirects (303) to Google. ${backToSignIn}`,
    operationId: "startGoogleSignIn",
  })
  @ApiQuery({ name: "next", required: false, description: "Web path to open after sign-in" })
  @ApiResponse({ status: 303, description: "To Google, or back to /sign-in?google=…" })
  async start(@Query("next") next: unknown, @Req() req: Request, @Res() res: Response) {
    const target = await this.google.start(typeof next === "string" ? next : undefined, req, res);
    res.redirect(303, target);
  }

  @Get("google/callback")
  @ApiOperation({
    summary: "Google's redirect back: validates the response and opens a session",
    description: `Checks state, PKCE and the ID token (issuer, audience, expiry, nonce). Only verified Gmail or matching Google Workspace addresses are accepted. Finds the linked account, links an existing account with the same email (emailing a notice), or creates a verified account. PM-Buddy MFA still applies. ${backToSignIn}`,
    operationId: "completeGoogleSignIn",
  })
  @ApiResponse({
    status: 303,
    description: "To /sign-in (session cookies set) or /sign-in?google=…",
  })
  async callback(@Req() req: Request, @Res() res: Response) {
    res.redirect(303, await this.google.callback(req, res));
  }
}
