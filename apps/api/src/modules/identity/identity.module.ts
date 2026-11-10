import { Module } from "@nestjs/common";
import { AuthSecurity } from "./auth-security.service.js";
import { AuthService } from "./auth.service.js";
import {
  AuthController,
  BrowserGuard,
  ProjectsController,
  TenantsController,
} from "./identity.controller.js";
import { TenancyService } from "./tenancy.service.js";
import { TenantDatabase } from "./tenant-database.service.js";

@Module({
  controllers: [AuthController, TenantsController, ProjectsController],
  providers: [AuthSecurity, AuthService, BrowserGuard, TenantDatabase, TenancyService],
  exports: [AuthService, AuthSecurity, TenantDatabase],
})
export class IdentityModule {}
