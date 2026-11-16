import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma.service.js";
import { TenantDatabase } from "../identity/tenant-database.service.js";
import { ACCESS_LOG_LIMITS, type AccessEntry } from "./access-entry.js";

/** The writer acts for no user; RLS still checks each row against the company in context. */
const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";
const DROP_REPORT_MS = 60_000;

/** An error's code or name only: driver messages can echo row values such as IP addresses. */
const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,20}$/.test(code)) return code;
  return error instanceof Error ? error.name : "unknown";
};

/**
 * Buffers access-log entries and writes them in batches, one transaction per company (RLS WITH
 * CHECK), so recording adds no database work to the request itself. While the database fails,
 * entries stay queued (up to maxQueued) and writes back off; entries beyond that, or recorded
 * after shutdown, are dropped and counted in an error log line. A crash loses at most the entries
 * of the last flush interval.
 */
@Injectable()
export class AccessLogWriter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccessLogWriter.name);
  private queue: AccessEntry[] = [];
  private draining: Promise<void> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private failures = 0;
  private retryAt = 0;
  private dropped = 0;
  private droppedReportedAt = 0;
  private closed = false;

  constructor(
    private readonly db: TenantDatabase,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (Date.now() >= this.retryAt) void this.flush();
      if (this.dropped && Date.now() - this.droppedReportedAt >= DROP_REPORT_MS)
        this.reportDropped();
    }, ACCESS_LOG_LIMITS.flushIntervalMs);
    this.timer.unref();
    this.prisma.beforeDisconnect(() => this.close());
  }

  onModuleDestroy(): Promise<void> {
    return this.close();
  }

  /** Entries waiting to be written. */
  get pending(): number {
    return this.queue.length;
  }

  record(entry: AccessEntry): void {
    if (this.closed || this.queue.length >= ACCESS_LOG_LIMITS.maxQueued) {
      this.drop(1);
      return;
    }
    this.queue.push(entry);
    if (this.queue.length >= ACCESS_LOG_LIMITS.batchSize && Date.now() >= this.retryAt)
      void this.flush();
  }

  /** Writes everything queued; resolves when the queue is empty or a write failed. Never rejects. */
  flush(): Promise<void> {
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  /** Final flush on shutdown; later entries are dropped (and counted). */
  async close(): Promise<void> {
    if (this.closed) return;
    clearInterval(this.timer);
    await this.flush();
    this.closed = true;
    this.drop(this.queue.splice(0).length);
    if (this.dropped) this.reportDropped();
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const byTenant = new Map<string, AccessEntry[]>();
      for (const entry of this.queue.splice(0, ACCESS_LOG_LIMITS.batchSize))
        byTenant.set(entry.tenantId, [...(byTenant.get(entry.tenantId) ?? []), entry]);
      const groups = [...byTenant];
      for (const [index, [tenantId, entries]] of groups.entries()) {
        try {
          await this.db.run({ userId: SYSTEM_USER, tenantId, requestId: "access-log" }, (tx) =>
            tx.accessEvent.createMany({ data: entries }),
          );
        } catch (error) {
          this.retry(
            groups.slice(index).flatMap(([, unwritten]) => unwritten),
            error,
          );
          return;
        }
      }
      this.failures = 0;
      this.retryAt = 0;
    }
  }

  /** Puts unwritten entries back at the front and pauses writes (doubling, up to maxBackoffMs). */
  private retry(unwritten: AccessEntry[], error: unknown) {
    this.queue.unshift(...unwritten);
    const overflow = this.queue.length - ACCESS_LOG_LIMITS.maxQueued;
    if (overflow > 0) this.drop(this.queue.splice(ACCESS_LOG_LIMITS.maxQueued).length);
    this.failures += 1;
    this.retryAt =
      Date.now() +
      Math.min(
        ACCESS_LOG_LIMITS.maxBackoffMs,
        ACCESS_LOG_LIMITS.flushIntervalMs * 2 ** Math.min(this.failures, 10),
      );
    if (this.failures === 1 || this.failures % 10 === 0)
      this.logger.warn(
        `Access log write failed ${this.failures} time(s) in a row (${errorCode(error)}); ${this.queue.length} entries waiting`,
      );
  }

  private drop(count: number) {
    this.dropped += count;
    if (this.dropped && (this.closed || Date.now() - this.droppedReportedAt >= DROP_REPORT_MS))
      this.reportDropped();
  }

  private reportDropped() {
    this.logger.error(
      `Access log dropped ${this.dropped} entries (queue full, or recorded during shutdown)`,
    );
    this.dropped = 0;
    this.droppedReportedAt = Date.now();
  }
}
