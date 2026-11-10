import { Injectable } from "@nestjs/common";
import type { DependencyCheck, LiveResponse, ReadyResponse } from "@pm-buddy/validation";
import { describeError } from "../../common/errors.js";
import { AppConfig } from "../../config/app-config.js";
import { PrismaService } from "../../infra/prisma.service.js";
import { RedisService } from "../../infra/redis.service.js";
import { StorageService } from "../../infra/storage.service.js";

type Probe = (signal: AbortSignal) => Promise<unknown>;

/** Hide credentials that some drivers include in error messages (scheme://user:pass@host). */
const scrub = (message: string) => message.replace(/\/\/[^/@\s]+@/g, "//***@").slice(0, 160);

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
  ) {}

  live(): LiveResponse {
    return {
      ...this.identity(),
      status: "ok",
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }

  async ready(): Promise<ReadyResponse> {
    const [database, redis, storage] = await Promise.all([
      this.check(() => this.prisma.$queryRaw`SELECT 1`),
      this.check(() => this.redis.ping()),
      this.check((signal) => this.storage.ping(signal)),
    ]);
    const allUp = [database, redis, storage].every((c) => c.status === "up");
    return {
      ...this.identity(),
      status: allUp ? "ok" : "degraded",
      checks: { database, redis, storage },
    };
  }

  /** Runs one dependency probe with a timeout. Errors are reported (outside production), never thrown. */
  async check(probe: Probe): Promise<DependencyCheck> {
    const timeoutMs = this.config.get("HEALTH_CHECK_TIMEOUT_MS");
    const controller = new AbortController();
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        probe(controller.signal),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            // Reject before aborting so a probe that settles on abort cannot win the race.
            reject(new Error(`timed out after ${timeoutMs} ms`));
            controller.abort();
          }, timeoutMs);
        }),
      ]);
      return { status: "up", latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      return {
        status: "down",
        latencyMs: Math.round(performance.now() - started),
        ...(this.config.isProduction ? {} : { error: scrub(describeError(error)) }),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private identity() {
    const commit = this.config.get("GIT_SHA");
    return {
      service: this.config.get("OTEL_SERVICE_NAME"),
      version: this.config.get("APP_VERSION"),
      ...(commit ? { commit } : {}),
      time: new Date().toISOString(),
    };
  }
}
