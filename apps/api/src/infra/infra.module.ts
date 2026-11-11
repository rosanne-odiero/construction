import { Global, Module } from "@nestjs/common";
import { AppConfig } from "../config/app-config.js";
import { MalwareScanner, MalwareScannerFactory } from "./malware-scanner.js";
import { PrismaService } from "./prisma.service.js";
import { RedisService } from "./redis.service.js";
import { StorageService } from "./storage.service.js";

@Global()
@Module({
  providers: [
    AppConfig,
    PrismaService,
    RedisService,
    StorageService,
    MalwareScannerFactory,
    {
      provide: MalwareScanner,
      inject: [MalwareScannerFactory],
      useFactory: (factory: MalwareScannerFactory) => factory.create(),
    },
  ],
  exports: [AppConfig, PrismaService, RedisService, StorageService, MalwareScanner],
})
export class InfraModule {}
