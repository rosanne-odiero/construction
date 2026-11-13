import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";
import { AppConfig, envFilePaths, validateEnv } from "./config/app-config.js";
import { loggerOptions } from "./common/logging.js";
import { InfraModule } from "./infra/infra.module.js";
import { AttendanceModule } from "./modules/attendance/attendance.module.js";
import { BqModule } from "./modules/bq/bq.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { IdentityModule } from "./modules/identity/identity.module.js";
import { LabourModule } from "./modules/labour/labour.module.js";
import { PaymentsModule } from "./modules/payments/payments.module.js";
import { ProjectsModule } from "./modules/projects/projects.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: envFilePaths(),
      validate: validateEnv,
    }),
    InfraModule,
    LoggerModule.forRootAsync({ inject: [AppConfig], useFactory: loggerOptions }),
    HealthModule,
    IdentityModule,
    ProjectsModule,
    BqModule,
    LabourModule,
    AttendanceModule,
    PaymentsModule,
  ],
})
export class AppModule {}
