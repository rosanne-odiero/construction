import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { describeError } from "../../common/errors.js";
import { AppConfig } from "../../config/app-config.js";
import { PrismaService } from "../../infra/prisma.service.js";
import { ACCESS_LOG_LIMITS } from "./access-entry.js";

const FIRST_PURGE_MS = 5 * 60_000;

/**
 * Deletes access-log entries older than the retention period (365 days) through
 * app.purge_access_events(), which refuses anything younger. Runs five minutes after start and
 * then hourly on every instance (concurrent purges only skip each other's rows); not under
 * NODE_ENV=test, where tests call purge().
 */
@Injectable()
export class AccessLogRetention implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccessLogRetention.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.get("NODE_ENV") === "test") return;
    const run = () => void this.purgeQuietly();
    this.timers = [
      setTimeout(run, FIRST_PURGE_MS),
      setInterval(run, ACCESS_LOG_LIMITS.purgeIntervalMs),
    ];
    for (const timer of this.timers) timer.unref();
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
  }

  /** Deletes expired entries in batches; returns how many. */
  async purge(): Promise<number> {
    let total = 0;
    for (let round = 0; round < ACCESS_LOG_LIMITS.purgeRounds; round += 1) {
      const [row] = await this.prisma.$queryRaw<{ deleted: number }[]>`
        SELECT app.purge_access_events(${ACCESS_LOG_LIMITS.purgeBatch}::integer) AS deleted`;
      const deleted = Number(row?.deleted ?? 0);
      total += deleted;
      if (deleted < ACCESS_LOG_LIMITS.purgeBatch) break;
    }
    return total;
  }

  private async purgeQuietly() {
    try {
      const deleted = await this.purge();
      if (deleted) this.logger.log(`Access log: deleted ${deleted} entries past retention`);
    } catch (error) {
      this.logger.warn(`Access log purge failed: ${describeError(error)}`);
    }
  }
}
