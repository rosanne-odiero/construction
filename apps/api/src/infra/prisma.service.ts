import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { AppConfig } from "../config/app-config.js";
import { PrismaClient } from "../generated/prisma/client.js";

/**
 * One Prisma client (one connection pool) per process. Connects lazily, so the API starts even
 * when the database is down and /health/ready reports it. Connects as pmb_app, which has no
 * BYPASSRLS and no DDL rights (ARCHITECTURE §6.1).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: AppConfig) {
    // pg waits forever for a connection by default; fail fast instead so requests don't hang.
    super({
      adapter: new PrismaPg({
        connectionString: config.get("DATABASE_URL"),
        connectionTimeoutMillis: 5_000,
      }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
