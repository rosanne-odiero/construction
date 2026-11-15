import { Module } from "@nestjs/common";
import { AppConfig } from "../../config/app-config.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { AccessPolicy } from "./access-policy.js";
import { AuthSecurity } from "./auth-security.service.js";
import { AuthService } from "./auth.service.js";
import { GoogleAuthController } from "./google-auth.controller.js";
import { GoogleSignIn } from "./google-sign-in.service.js";
import {
  AuthController,
  BrowserGuard,
  PermissionsController,
  TenantsController,
} from "./identity.controller.js";
import { PasskeyService } from "./passkey.service.js";
import { PinAuthController } from "./pin-auth.controller.js";
import { PinHasher } from "./pin-pepper.js";
import { PinService } from "./pin.service.js";
import { breachCheckerFor, PasswordBreachChecker, PasswordPolicy } from "./password-policy.js";
import { RolesService } from "./roles.service.js";
import { TenancyService } from "./tenancy.service.js";
import { TenantDatabase } from "./tenant-database.service.js";
import { TenantScope } from "./tenant-scope.service.js";

@Module({
  imports: [NotificationsModule],
  controllers: [
    AuthController,
    GoogleAuthController,
    PinAuthController,
    TenantsController,
    PermissionsController,
  ],
  providers: [
    AccessPolicy,
    AuthSecurity,
    AuthService,
    BrowserGuard,
    GoogleSignIn,
    PasskeyService,
    PasswordPolicy,
    PinHasher,
    PinService,
    { provide: PasswordBreachChecker, inject: [AppConfig], useFactory: breachCheckerFor },
    RolesService,
    TenancyService,
    TenantDatabase,
    TenantScope,
  ],
  exports: [
    AccessPolicy,
    AuthService,
    AuthSecurity,
    BrowserGuard,
    TenancyService,
    TenantDatabase,
    TenantScope,
  ],
})
export class IdentityModule {}
