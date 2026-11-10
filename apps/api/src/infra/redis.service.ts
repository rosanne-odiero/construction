import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";
import { describeError } from "../common/errors.js";
import { AppConfig } from "../config/app-config.js";

/** Valkey/Redis client for queues, rate limits, USSD sessions and caching (ARCHITECTURE §3). */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private lastErrorLoggedAt = 0;
  readonly client: Redis;

  constructor(config: AppConfig) {
    this.client = new Redis(config.get("REDIS_URL"), {
      lazyConnect: true,
      connectTimeout: 2_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
    });
    // Without a listener, connection errors would crash the process. Log at most once a minute.
    this.client.on("error", (error: Error) => {
      if (Date.now() - this.lastErrorLoggedAt > 60_000) {
        this.lastErrorLoggedAt = Date.now();
        this.logger.warn(`Redis unavailable: ${describeError(error)}`);
      }
    });
  }

  async ping(): Promise<void> {
    if (this.client.status === "wait") await this.client.connect();
    // While ioredis is reconnecting, commands fail with a cryptic offline-queue error; say what is wrong.
    if (this.client.status !== "ready") throw new Error(`not connected (${this.client.status})`);
    await this.client.ping();
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
