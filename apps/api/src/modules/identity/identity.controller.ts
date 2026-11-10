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
import { ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { AuthSecurity } from "./auth-security.service.js";
import { AuthService } from "./auth.service.js";
import { TenancyService } from "./tenancy.service.js";
import {
  acceptSchema,
  assignmentSchema,
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
  constructor(private readonly auth: AuthService) {}

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

@ApiTags("tenants")
@UseGuards(BrowserGuard)
@Controller({ path: "tenants", version: "1" })
export class TenantsController {
  constructor(
    private readonly auth: AuthService,
    private readonly tenancy: TenancyService,
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
}

@ApiTags("projects")
@UseGuards(BrowserGuard)
@Controller({ path: "projects", version: "1" })
export class ProjectsController {
  constructor(
    private readonly auth: AuthService,
    private readonly tenancy: TenancyService,
  ) {}
  @Get()
  async list(@Req() req: Request) {
    return this.tenancy.projects(await this.auth.principal(req), req);
  }
  @Post()
  async create(@Body() body: unknown, @Req() req: Request) {
    return this.tenancy.createProject(
      await this.auth.principal(req),
      nameSchema.parse(body).name,
      req,
    );
  }
  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.tenancy.updateProject(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      nameSchema.parse(body).name,
      req,
    );
  }
  @Put(":id/members/:userId")
  async assign(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.tenancy.assign(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(userId),
      assignmentSchema.parse(body).permissions,
      req,
    );
  }
}
