import {
  Body,
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import {
  authResponseSchema,
  createRoleRequestSchema,
  memberRoleRequestSchema,
  messageResponseSchema,
  passkeyAuthenticationOptionsResponseSchema,
  passkeyAuthenticationRequestSchema,
  passkeyRegistrationOptionsResponseSchema,
  passkeyRegistrationRequestSchema,
  passkeyRegistrationResponseSchema,
  passkeysResponseSchema,
  permissionCatalogueResponseSchema,
  roleReferenceSchema,
  roleResponseSchema,
  rolesResponseSchema,
  updateRoleRequestSchema,
} from "@pm-buddy/validation";
import type { Request, Response } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthSecurity } from "./auth-security.service.js";
import { AuthService } from "./auth.service.js";
import { PasskeyService } from "./passkey.service.js";
import { RolesService } from "./roles.service.js";
import { TenancyService } from "./tenancy.service.js";
import {
  acceptSchema,
  codeSchema,
  identifierBody,
  inviteSchema,
  loginSchema,
  nameSchema,
  recoverySchema,
  registerSchema,
  resetSchema,
  uuidSchema,
  verifySchema,
} from "./identity.schemas.js";

const stepUpNote = "Requires roles.manage and MFA verified within the last five minutes.";
const enrolmentNote =
  "Requires a sign-in within the last five minutes or, once the account has an MFA factor, MFA verified within the last five minutes.";

@Injectable()
export class BrowserGuard implements CanActivate {
  constructor(private readonly security: AuthSecurity) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    context.switchToHttp().getResponse<Response>().setHeader("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) await this.security.assertCsrf(req);
    return true;
  }
}

@ApiTags("authentication")
@UseGuards(BrowserGuard)
@Controller({ path: "auth", version: "1" })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly passkeyService: PasskeyService,
  ) {}

  @Get("csrf")
  csrf(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.security.csrf(req, res);
  }
  @Post("register")
  register(@Body() body: unknown, @Req() req: Request) {
    return this.auth.register(registerSchema.parse(body), req);
  }
  @Post("verify")
  @HttpCode(200)
  verify(@Body() body: unknown, @Req() req: Request) {
    const input = verifySchema.parse(body);
    return this.auth.verifyIdentifier(input.identifier, input.code, input.password, req);
  }
  @Post("verification/resend")
  @HttpCode(200)
  resend(@Body() body: unknown, @Req() req: Request) {
    return this.auth.resend(identifierBody.parse(body).identifier, req);
  }
  @Post("login")
  @HttpCode(200)
  login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = loginSchema.parse(body);
    return this.auth.login(input.identifier, input.password, req, res);
  }
  @Get("me")
  async me(@Req() req: Request) {
    return this.auth.response(await this.auth.principal(req));
  }
  @Post("refresh")
  @HttpCode(200)
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.refresh(req, res);
  }
  @Post("logout")
  @HttpCode(200)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(req, res);
  }
  @Post("mfa/enroll")
  @HttpCode(200)
  async enroll(@Req() req: Request) {
    return this.auth.enroll(await this.auth.principal(req));
  }
  @Post("mfa/verify")
  @HttpCode(200)
  async verifyMfa(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.verifyMfa(
      await this.auth.principal(req),
      codeSchema.parse(body).code,
      req,
      res,
      true,
    );
  }
  @Post("mfa/step-up")
  @HttpCode(200)
  async stepUp(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.verifyMfa(
      await this.auth.principal(req),
      codeSchema.parse(body).code,
      req,
      res,
      false,
    );
  }
  @Post("mfa/recover")
  @HttpCode(200)
  async recover(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.recover(
      await this.auth.principal(req),
      recoverySchema.parse(body).code,
      req,
      res,
    );
  }
  @Post("password/forgot")
  @HttpCode(200)
  forgot(@Body() body: unknown, @Req() req: Request) {
    return this.auth.forgot(identifierBody.parse(body).identifier, req);
  }
  @Post("password/reset")
  @HttpCode(200)
  reset(@Body() body: unknown, @Req() req: Request) {
    const input = resetSchema.parse(body);
    return this.auth.reset(input.token, input.password, req);
  }
  @Get("passkeys")
  @ApiOperation({
    summary: "The caller's passkeys (names and dates; never credential IDs or keys)",
    operationId: "listPasskeys",
  })
  @ApiOkResponse({ schema: openApi(passkeysResponseSchema) })
  async listPasskeys(@Req() req: Request) {
    return this.passkeyService.list(await this.auth.principal(req));
  }
  @Post("passkeys/registration/options")
  @HttpCode(200)
  @ApiOperation({
    summary: "WebAuthn creation options for a new passkey (single-use challenge, 5 minutes)",
    description: enrolmentNote,
    operationId: "getPasskeyRegistrationOptions",
  })
  @ApiOkResponse({ schema: openApi(passkeyRegistrationOptionsResponseSchema) })
  @ApiForbiddenResponse({ description: "Sign-in or MFA verification is not fresh" })
  @ApiConflictResponse({ description: "The account already has the maximum number of passkeys" })
  async passkeyRegistrationOptions(@Req() req: Request) {
    return this.passkeyService.registrationOptions(await this.auth.principal(req), req);
  }
  @Post("passkeys/registration")
  @ApiOperation({
    summary: "Register a passkey from the authenticator's attestation response",
    description: `${enrolmentNote} The first MFA factor also returns ten one-time recovery codes when the account has no unused ones.`,
    operationId: "registerPasskey",
  })
  @ApiBody({ schema: openApi(passkeyRegistrationRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(passkeyRegistrationResponseSchema) })
  @ApiConflictResponse({
    description: "Credential already registered, name in use or limit reached",
  })
  async registerPasskey(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.passkeyService.register(
      await this.auth.principal(req),
      passkeyRegistrationRequestSchema.parse(body),
      req,
      res,
    );
  }
  @Delete("passkeys/:id")
  @ApiOperation({
    summary: "Remove a passkey",
    description:
      "Requires MFA verified within the last five minutes. Refused (409) for the last MFA factor of someone holding an MFA-required permission.",
    operationId: "removePasskey",
  })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  @ApiNotFoundResponse({ description: "No such passkey on this account" })
  @ApiConflictResponse({ description: "It is the last MFA factor and a role requires MFA" })
  async removePasskey(@Param("id") id: string, @Req() req: Request) {
    return this.passkeyService.remove(await this.auth.principal(req), uuidSchema.parse(id));
  }
  @Post("passkeys/step-up/options")
  @HttpCode(200)
  @ApiOperation({
    summary: "WebAuthn request options to verify MFA with a passkey (single-use, 5 minutes)",
    operationId: "getPasskeyStepUpOptions",
  })
  @ApiOkResponse({ schema: openApi(passkeyAuthenticationOptionsResponseSchema) })
  @ApiNotFoundResponse({ description: "The account has no passkey" })
  async passkeyStepUpOptions(@Req() req: Request) {
    return this.passkeyService.stepUpOptions(await this.auth.principal(req), req);
  }
  @Post("passkeys/step-up")
  @HttpCode(200)
  @ApiOperation({
    summary: "Verify MFA (sign-in second factor or step-up) with a passkey assertion",
    description:
      "Sets the session's MFA time like a TOTP step-up. Failures count toward the MFA lockout (five in a row lock MFA for 15 minutes and sign the session out).",
    operationId: "stepUpWithPasskey",
  })
  @ApiBody({ schema: openApi(passkeyAuthenticationRequestSchema) })
  @ApiOkResponse({ schema: openApi(authResponseSchema) })
  async passkeyStepUp(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.passkeyService.stepUp(
      await this.auth.principal(req),
      passkeyAuthenticationRequestSchema.parse(body),
      req,
      res,
    );
  }
  @Get("sessions")
  async sessions(@Req() req: Request) {
    return this.auth.sessions(await this.auth.principal(req));
  }
  @Delete("sessions/:id")
  async revoke(
    @Param("id") id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.revoke(await this.auth.principal(req), uuidSchema.parse(id), res);
  }
}

@ApiTags("permissions")
@UseGuards(BrowserGuard)
@Controller({ path: "permissions", version: "1" })
export class PermissionsController {
  constructor(
    private readonly auth: AuthService,
    private readonly roles: RolesService,
  ) {}
  @Get()
  @ApiOperation({ summary: "Permission catalogue grouped by area", operationId: "listPermissions" })
  @ApiOkResponse({ schema: openApi(permissionCatalogueResponseSchema) })
  async catalogue(@Req() req: Request) {
    return this.roles.catalogue(await this.auth.principal(req));
  }
}

@ApiTags("tenants")
@UseGuards(BrowserGuard)
@Controller({ path: "tenants", version: "1" })
export class TenantsController {
  constructor(
    private readonly auth: AuthService,
    private readonly tenancy: TenancyService,
    private readonly roles: RolesService,
  ) {}
  @Get()
  async list(@Req() req: Request) {
    return this.tenancy.list(await this.auth.principal(req), req);
  }
  @Post()
  async create(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.tenancy.create(
      await this.auth.principal(req),
      nameSchema.parse(body).name,
      req,
      res,
    );
  }
  @Post(":id/select")
  @HttpCode(200)
  async select(
    @Param("id") id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.tenancy.select(await this.auth.principal(req), uuidSchema.parse(id), req, res);
  }
  @Get("current/members")
  async members(@Req() req: Request) {
    return this.tenancy.members(await this.auth.principal(req), req);
  }
  @Post("current/invitations")
  async invite(@Body() body: unknown, @Req() req: Request) {
    return this.tenancy.invite(await this.auth.principal(req), inviteSchema.parse(body), req);
  }
  @Post("invitations/accept")
  @HttpCode(200)
  async accept(@Body() body: unknown, @Req() req: Request) {
    return this.tenancy.accept(await this.auth.principal(req), acceptSchema.parse(body).token, req);
  }
  @Delete("current/members/:userId")
  async remove(@Param("userId") id: string, @Req() req: Request) {
    return this.tenancy.remove(await this.auth.principal(req), uuidSchema.parse(id), req);
  }
  @Get("current/audit")
  async audit(@Req() req: Request) {
    return this.tenancy.auditLog(await this.auth.principal(req), req);
  }
  @Get("current/roles")
  @ApiOperation({
    summary: "System and custom roles of the selected company",
    description: "Requires roles.manage or users.invite.",
    operationId: "listRoles",
  })
  @ApiOkResponse({ schema: openApi(rolesResponseSchema) })
  async listRoles(@Req() req: Request) {
    return this.roles.list(await this.auth.principal(req), req);
  }
  @Post("current/roles")
  @ApiOperation({
    summary: "Create a custom role",
    description: stepUpNote,
    operationId: "createRole",
  })
  @ApiBody({ schema: openApi(createRoleRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(roleResponseSchema) })
  @ApiForbiddenResponse({ description: "Missing permission, stale MFA or privilege escalation" })
  @ApiConflictResponse({ description: "A role with this name exists" })
  async createRole(@Body() body: unknown, @Req() req: Request) {
    return this.roles.create(
      await this.auth.principal(req),
      createRoleRequestSchema.parse(body),
      req,
    );
  }
  @Patch("current/roles/:id")
  @ApiOperation({
    summary: "Rename or change a custom role (system roles are immutable)",
    description: stepUpNote,
    operationId: "updateRole",
  })
  @ApiBody({ schema: openApi(updateRoleRequestSchema) })
  @ApiOkResponse({ schema: openApi(roleResponseSchema) })
  @ApiForbiddenResponse({ description: "System role, missing permission or privilege escalation" })
  @ApiNotFoundResponse({ description: "No such role in the selected company" })
  @ApiConflictResponse({
    description: "Duplicate name, or a holder lacks MFA for privileged permissions",
  })
  async updateRole(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.roles.update(
      await this.auth.principal(req),
      roleReferenceSchema.parse(id),
      updateRoleRequestSchema.parse(body),
      req,
    );
  }
  @Delete("current/roles/:id")
  @ApiOperation({
    summary: "Delete an unused custom role",
    description: stepUpNote,
    operationId: "deleteRole",
  })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  @ApiConflictResponse({
    description: "The role is held by members or named in pending invitations",
  })
  async deleteRole(@Param("id") id: string, @Req() req: Request) {
    return this.roles.remove(await this.auth.principal(req), roleReferenceSchema.parse(id), req);
  }
  @Put("current/members/:userId/role")
  @ApiOperation({
    summary: "Change a member's role; revokes their active sessions in this company",
    description: stepUpNote,
    operationId: "changeMemberRole",
  })
  @ApiBody({ schema: openApi(memberRoleRequestSchema) })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  @ApiConflictResponse({
    description: "Last owner, unchanged role, or the member lacks required MFA",
  })
  async changeMemberRole(
    @Param("userId") userId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.roles.changeMemberRole(
      await this.auth.principal(req),
      uuidSchema.parse(userId),
      memberRoleRequestSchema.parse(body).role,
      req,
    );
  }
}
