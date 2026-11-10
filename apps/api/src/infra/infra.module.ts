import { Global, Module } from "@nestjs/common";
import { AppConfig } from "../config/app-config.js";
import { PrismaService } from "./prisma.service.js";
import { RedisService } from "./redis.service.js";
import { StorageService } from "./storage.service.js";

@Global()
@Module({
  providers: [AppConfig, PrismaService, RedisService, StorageService],
  exports: [AppConfig, PrismaService, RedisService, StorageService],
})
export class InfraModule {}
